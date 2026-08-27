/**
 * Claude Usage Meter — background service worker.
 *
 * Three responsibilities:
 *   1. Auto-continue keepalive: nudge claude.ai tabs to click "Continue" even
 *      when backgrounded (content-script timers throttle there).
 *   2. Scheduled sends: fire queued jobs at their set time, or when the usage
 *      window resets, by opening a claude.ai composer tab and driving it.
 *   3. Service status: poll status.claude.com so the pill can warn about an
 *      outage, and HOLD a scheduled send until Claude recovers.
 *   4. Workflow runs: walk a multi-chat workflow one step at a time, opening (or
 *      returning to) each chat's conversation and handing the last reply on to
 *      the next step.
 *
 * MV3 workers are short-lived, so a chrome.alarm keeps things ticking.
 */
// self.CUMJobs / CUMStatus / CUMWorkflow / CUMWfUsage / CUMUsageWarn / CUMPseudo
importScripts(
  "jobstore.js",
  "status.js",
  "workflow.js",
  "wfusage.js",
  "incognito.js",
  "cowork.js",
  "usagewarn.js",
  // The worker names conversations, and a chat's title is the one thing a run
  // SENDS that the pseudonymization never scrubbed — see chatTitleFor.
  "pseudo.js",
  // The master key is kept up to date HERE, from the library's own storage
  // writes, rather than at each of the three places a key can be loaded. One
  // implementation, and it catches the fourth place too.
  "masterkey.js"
);

const CFG_KEY = "cum_autocontinue";
const DL_CFG_KEY = "cum_autodownload"; // { enabled, max } — the file saver
const JOBS_KEY = "cum_jobs";
const WORKFLOWS_KEY = "cum_workflows";
const RUNS_KEY = "cum_wf_runs";
const WF_SEEDED_KEY = "cum_wf_seeded";
const WF_USAGE_KEY = "cum_wf_usage"; // workflow-attributed usage, by date
const STATE_KEY = "cum_state";
const STATUS_KEY = "cum_status"; // last status.claude.com snapshot
const STATUS_CFG_KEY = "cum_status_cfg"; // { warn, holdSends } — both default on
const WARN_KEY = "cum_warn"; // usage-pace warnings already fired (see usagewarn.js)
const WARN_CFG_KEY = "cum_warn_cfg"; // { enabled, dailyShare } — enabled defaults on
const PSEUDO_KEYS_KEY = "cum_pseudo_keys"; // id -> parsed key (see popup.js)
const MASTER_KEY = "cum_pseudo_master"; // { cases: [...] } — see masterkey.js
const PSEUDO_CHATS_KEY = "cum_pseudo_chats"; // conversation key -> key id
const KEEPALIVE = "cum-ac-keepalive";
const TIME_ALARM = "cum-job-time";
const RESET_ALARM = "cum-job-reset";
const STATUS_ALARM = "cum-status";
const BURST_MS = 5000;
const BURST_COUNT = 6;
const STATUS_POLL_MIN = 5; // normal cadence, minutes
const STATUS_POLL_HOT_MIN = 1; // while an outage is live or a job is held
// How long a remembered outage survives a status page we can no longer reach.
// Past that the reading degrades to "unknown", which holds nothing (fail open) —
// the meter must never become a second way for a send to silently not happen.
const STATUS_GRACE_MS = 15 * 60 * 1000;
// At fire time a poll-cadence-old reading isn't good enough; re-read if older.
const STATUS_FIRE_FRESH_MS = 60 * 1000;
// A run's window is maximized: claude.ai's compact layout can't render every
// block type and substitutes "This block is not supported on your current
// device", which the copy box then copies as if it were the reply. These
// bounds are the fallback for a window manager that won't maximize on request
// — deliberately larger than any ordinary display, because Chrome clamps them
// to the screen and that saves having to measure it.
const RUN_WINDOW_W = 4096;
const RUN_WINDOW_H = 2304;

const J = self.CUMJobs;
const S = self.CUMStatus;
const W = self.CUMWorkflow;
const U = self.CUMWfUsage;
const G = self.CUMIncognito;
const UW = self.CUMUsageWarn;

// ---- storage helpers ----------------------------------------------------
function get(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (res) => resolve(res || {}));
    } catch (e) {
      resolve({});
    }
  });
}
function set(obj) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, resolve);
    } catch (e) {
      resolve();
    }
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function updateJob(id, patch) {
  const { [JOBS_KEY]: jobs } = await get(JOBS_KEY);
  const list = (jobs || []).map((j) => (j.id === id ? Object.assign({}, j, patch) : j));
  await set({ [JOBS_KEY]: list });
}

async function deleteJobFiles(job) {
  if (!job.files || !job.files.length) return;
  const keys = job.files.map((f) => J.fileKey(f.id));
  try {
    chrome.storage.local.remove(keys);
  } catch (e) {
    /* ignore */
  }
}

function notify(title, message) {
  try {
    if (!chrome.notifications) return;
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message: String(message || "").slice(0, 200),
    });
  } catch (e) {
    /* ignore */
  }
}

// ==== Usage-pace warnings ================================================
// The pill reports a reading; this decides what it has just earned. Serialized
// through warnQueue so the read-modify-write can't interleave with another
// tab's — see the message handler.
let warnQueue = Promise.resolve();

async function usageWarnFor(reading) {
  if (!UW) return [];
  const r = await get([WARN_KEY, WARN_CFG_KEY]);
  const cfg = r[WARN_CFG_KEY] || {};
  if (cfg.enabled === false) return []; // opted out; don't bank state either
  const out = UW.due(r[WARN_KEY] || UW.EMPTY, reading, cfg);
  await set({ [WARN_KEY]: out.state });
  for (const w of out.fire) notify(w.title, w.message);
  return out.fire;
}

// ==== Auto-continue keepalive ===========================================
// Any of the auto-clickers being on is reason to keep nudging: a backgrounded
// tab's own timers throttle, and each clicker has its own toggle — Allow-once
// independent of Continue's, and the file saver independent of both.
function acEnabled() {
  return new Promise((resolve) => {
    get([CFG_KEY, DL_CFG_KEY]).then((r) => {
      const c = r[CFG_KEY] || {};
      const d = r[DL_CFG_KEY] || {};
      resolve(!!(c.enabled || c.allowOnce || d.enabled));
    });
  });
}
function pollTabs() {
  try {
    chrome.tabs.query({ url: "https://claude.ai/*" }, (tabs) => {
      for (const t of tabs || []) {
        if (t.id == null) continue;
        try {
          chrome.tabs.sendMessage(t.id, "cum-ac-poll", () => void chrome.runtime.lastError);
        } catch (e) {
          /* ignore */
        }
      }
    });
  } catch (e) {
    /* ignore */
  }
}
async function acBurst() {
  if (!(await acEnabled())) return;
  pollTabs();
  let n = 1;
  const id = setInterval(async () => {
    if (n++ >= BURST_COUNT || !(await acEnabled())) return clearInterval(id);
    pollTabs();
  }, BURST_MS);
}

// ==== Claude service status ==============================================
// Polled here rather than in the content script for two reasons: one fetch
// serves every open tab, and a send can fire with no tab open at all — the gate
// below needs a reading it can get on its own.
let statusBusy = null; // in-flight refresh, so concurrent callers coalesce

// What claude.ai answers on when nothing says otherwise. Used to decide whether
// an outage confined to particular models is one of yours: a workflow that names
// no model isn't using "no model", it is using whatever your account is set to.
const DEFAULT_MODEL = "Opus 5";

async function statusCfg() {
  const c = (await get(STATUS_CFG_KEY))[STATUS_CFG_KEY] || {};
  return {
    warn: c.warn !== false,
    holdSends: c.holdSends !== false,
    defaultModel: (typeof c.defaultModel === "string" && c.defaultModel.trim()) || DEFAULT_MODEL,
  };
}

async function readStatus() {
  return (await get(STATUS_KEY))[STATUS_KEY] || null;
}

function statusHeadline(snap) {
  const lines = S.detailLines(snap);
  return lines.length ? lines.slice(0, 2).join(" — ") : S.shortLabel(snap);
}

async function refreshStatus() {
  if (statusBusy) return statusBusy;
  statusBusy = (async () => {
    const prev = await readStatus();
    let snap;
    try {
      const res = await fetch(S.SUMMARY_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      snap = S.parseSummary(await res.json(), Date.now());
    } catch (e) {
      const err = (e && e.message) || String(e || "unreachable");
      // A status page we can't reach must not erase an outage we already know
      // about — a held job would then fire straight into it. Keep the last good
      // reading (its own fetchedAt, so the UI can say how old it is) until the
      // grace window runs out.
      if (prev && prev.ok && Date.now() - prev.fetchedAt < STATUS_GRACE_MS) {
        // fetchedAt stays put (it's the age of the data), checkedAt advances (it's
        // when we last tried) — so the poll cadence holds instead of retrying on
        // every worker start for as long as the status page is down.
        snap = Object.assign({}, prev, { error: err, checkedAt: Date.now() });
      } else {
        snap = S.unknown(err, Date.now());
      }
    }
    await set({ [STATUS_KEY]: snap });

    const wasBlocking = !!(prev && prev.ok && prev.blocking);
    const nowBlocking = !!(snap.ok && snap.blocking);
    const cfg = await statusCfg();
    if (cfg.warn && nowBlocking && !wasBlocking) {
      notify("Claude is having problems", statusHeadline(snap));
    } else if (cfg.warn && wasBlocking && !nowBlocking) {
      notify("Claude is back", S.shortLabel(snap));
    }
    return snap;
  })();
  try {
    return await statusBusy;
  } finally {
    statusBusy = null;
  }
}

// A reading fresh enough to gate a send on, fetched now if need be.
async function statusForGate() {
  const snap = await readStatus();
  if (snap && !S.isStale(snap, Date.now(), STATUS_FIRE_FRESH_MS)) return snap;
  return refreshStatus();
}

// Only refresh when the stored reading has actually aged out. This runs on every
// worker start, and the keepalive restarts the worker every 30 seconds — polling
// unconditionally would hammer status.claude.com.
async function refreshStatusIfStale() {
  const snap = await readStatus();
  const hot = !!(snap && snap.ok && snap.blocking);
  const every = (hot ? STATUS_POLL_HOT_MIN : STATUS_POLL_MIN) * 60 * 1000;
  if (S.isDuePoll(snap, Date.now(), every)) return refreshStatus();
  return snap;
}

function getAlarm(name) {
  return new Promise((resolve) => {
    try {
      chrome.alarms.get(name, (a) => resolve(a || null));
    } catch (e) {
      resolve(null);
    }
  });
}

// Poll faster while an outage is live or a job is stuck behind one, so a held
// send goes out within a minute of Claude recovering instead of up to five.
async function ensureStatusAlarm(hot) {
  let want = !!hot;
  if (hot == null) {
    const snap = await readStatus();
    const jobs = (await get(JOBS_KEY))[JOBS_KEY] || [];
    const runs = await readRuns();
    want =
      !!(snap && snap.ok && snap.blocking) ||
      J.hasHeldJobs(jobs) ||
      W.heldRuns(runs).length > 0;
  }
  const period = want ? STATUS_POLL_HOT_MIN : STATUS_POLL_MIN;
  // Creating an alarm RESETS its countdown, and this is called on every worker
  // start — which the 30-second keepalive triggers over and over. Re-creating it
  // blindly would push the poll out forever and it would never fire, so only
  // touch it when it's missing or on the wrong cadence.
  const existing = await getAlarm(STATUS_ALARM);
  if (existing && existing.periodInMinutes === period) return;
  try {
    chrome.alarms.create(STATUS_ALARM, { periodInMinutes: period });
  } catch (e) {}
}

// ==== Scheduled sends ====================================================
let running = false;

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch (e) {}
      resolve(ok);
    };
    function listener(id, info) {
      if (id === tabId && info.status === "complete") done(true);
    }
    try {
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError) return done(false);
        if (t && t.status === "complete") done(true);
      });
    } catch (e) {
      done(false);
    }
    setTimeout(() => done(true), timeoutMs || 30000);
  });
}

async function sendRun(tabId, jobId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "cum-run-job", jobId });
      if (res) return res;
    } catch (e) {
      /* content script maybe not ready yet */
    }
    await sleep(1500);
  }
  return { ok: false, error: "no response from page (content script not ready?)" };
}

// All open claude.ai tabs, across every window type — normal browser windows
// AND installed-PWA app windows (windowType "app"). Some Chrome versions omit
// app windows from an unfiltered query, so we union a few explicit queries.
async function claudeTabs() {
  const seen = new Map();
  const queries = [
    { url: "https://claude.ai/*" },
    { url: "https://claude.ai/*", windowType: "app" },
    { url: "https://claude.ai/*", windowType: "normal" },
    { url: "https://claude.ai/*", windowType: "popup" },
  ];
  for (const q of queries) {
    const tabs = await new Promise((res) => {
      try {
        chrome.tabs.query(q, (t) => {
          void chrome.runtime.lastError; // invalid windowType combos just no-op
          res(t || []);
        });
      } catch (e) {
        res([]);
      }
    });
    for (const t of tabs) if (t && t.id != null) seen.set(t.id, t);
  }
  return Array.from(seen.values());
}

// Find an already-open tab showing this conversation (browser tab or PWA).
async function findChatTab(chatUrl) {
  if (!chatUrl) return null;
  const want = J.targetUrl({ chatUrl });
  for (const t of await claudeTabs()) {
    if (t.url && J.sameConversationUrl(t.url, want)) return t;
  }
  return null;
}

// Hold this job if Claude is down, rather than driving files and a prompt into a
// composer that can't send them. `opts.force` is an explicit "Run now" — the
// operator overriding the gate — and never holds.
async function outageGate(job, opts) {
  const cfg = await statusCfg();
  if (!cfg.holdSends || (opts && opts.force)) return { hold: false };
  const o = opts || {};
  return S.holdDecision(await statusForGate(), {
    enabled: true,
    heldSince: typeof job.heldSince === "number" ? job.heldSince : null,
    // The model this particular piece of work would answer on. An outage the
    // status page attributes to other models isn't one that stops it. Work
    // that names none is on whatever your account is set to, which is the
    // point of the default — falling back to null here would mean a plain
    // scheduled send waits out every model-specific outage.
    model: S.modelKey(o.model || cfg.defaultModel),
    now: Date.now(),
  });
}

async function executeJob(job, opts) {
  const gate = await outageGate(job, opts);
  if (gate.hold) {
    const firstHold = job.status !== "waiting";
    await updateJob(job.id, {
      status: "waiting",
      heldSince: typeof job.heldSince === "number" ? job.heldSince : Date.now(),
      holdReason: gate.reason,
      error: null,
    });
    if (firstHold) {
      notify(
        "Scheduled send is waiting",
        (job.name ? job.name + " — " : "") +
          "holding until Claude recovers (" + gate.reason + ")."
      );
    }
    ensureStatusAlarm(true); // poll hard so it goes out as soon as this clears
    return;
  }
  // Waited out the ceiling: go anyway, but say so — a queued send that never
  // leaves is its own failure.
  const heldNote = gate.expired
    ? "sent after waiting " + S.fmtWaited(gate.waitedMs) + " for " + gate.reason
    : // Or not held at all, because the outage is confined to models this send
      // isn't using — worth saying, since the pill is showing an outage warning
      // at the same moment.
      gate.spared
      ? "sent during an outage confined to " + gate.spared
      : null;

  await updateJob(job.id, {
    status: "running",
    firedAt: Date.now(),
    error: null,
    heldSince: null,
    holdReason: null,
  });
  const url = J.targetUrl(job);
  let tab = null;
  let createdTab = false;

  // For a "this chat" target, reuse the tab/PWA window already on that
  // conversation rather than opening a duplicate. New-chat and project targets
  // always open fresh (that's the point — a new conversation).
  if (job.chatUrl) {
    try {
      tab = await findChatTab(job.chatUrl);
    } catch (e) {
      tab = null;
    }
  }
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url, active: false });
      createdTab = true;
    } catch (e) {
      await updateJob(job.id, { status: "error", error: "could not open tab" });
      notify("Scheduled send failed", "Could not open a claude.ai tab.");
      return;
    }
  }
  await waitTabComplete(tab.id, 30000);
  await sleep(createdTab ? 2500 : 800); // a fresh tab needs the SPA to render
  let res = await sendRun(tab.id, job.id);
  // If the page never answered, its content script may be stale (the extension
  // was reloaded/updated while this tab stayed open) — reload the tab to inject
  // fresh scripts and try once more before giving up.
  if (res && !res.ok && /no response from page/.test(res.error || "")) {
    try {
      await chrome.tabs.reload(tab.id);
      await waitTabComplete(tab.id, 30000);
      // `complete` is the document, not the app: a Cowork page keeps booting
      // its sandbox well past it, too busy to answer a message.
      await sleep(8000);
      res = await sendRun(tab.id, job.id);
    } catch (e) {
      /* keep the original failure */
    }
  }
  if (res && res.ok) {
    const note = [heldNote, res.note].filter(Boolean).join(" · ") || null;
    await updateJob(job.id, { status: "done", note });
    await deleteJobFiles(job);
    const base = job.name || "Your scheduled message was sent.";
    notify("Sent to Claude", note ? base + " (" + note + ")" : base);
  } else {
    await updateJob(job.id, { status: "error", error: (res && res.error) || "unknown" });
    notify("Scheduled send failed", (res && res.error) || "See the extension options.");
  }
}

// Run any due jobs, one at a time (avoid opening many tabs at once). "hold"
// retries the jobs an outage parked — their trigger already fired, so the status
// poll is the only thing that will wake them.
async function runJobs(kind /* "time" | "reset" | "hold" */) {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const { [JOBS_KEY]: jobs } = await get(JOBS_KEY);
    const list = jobs || [];
    const due =
      kind === "hold"
        ? J.heldJobs(list)
        : kind === "reset"
        ? J.pendingResetJobs(list)
        : J.dueTimeJobs(list, now);
    for (const job of due) {
      // Re-read to respect any cancellation between iterations.
      const fresh = J.getJob((await get(JOBS_KEY))[JOBS_KEY] || [], job.id);
      if (J.isQueued(fresh)) await executeJob(fresh);
    }
  } finally {
    running = false;
  }
  await reschedule();
}

// (Re)create alarms for the next time trigger and the reset trigger. Scheduled
// sends and workflow runs share both alarms — they answer the same two
// questions, "what's the soonest clock trigger" and "is anything waiting for the
// usage window to roll over".
async function reschedule() {
  const { [JOBS_KEY]: jobs, [STATE_KEY]: state } = await get([JOBS_KEY, STATE_KEY]);
  const list = jobs || [];
  const runs = await readRuns();

  const times = [
    J.nextTimeTrigger(list, Date.now()),
    W.nextRunTrigger(runs, Date.now()),
    // A run held by a timed pause step wakes on the same alarm.
    W.nextClockResume(runs, Date.now()),
  ].filter((t) => typeof t === "number");
  const nextTime = times.length ? Math.min.apply(null, times) : null;
  try {
    chrome.alarms.clear(TIME_ALARM);
    if (nextTime != null) {
      chrome.alarms.create(TIME_ALARM, { when: Math.max(Date.now() + 1000, nextTime) });
    }
  } catch (e) {}

  try {
    chrome.alarms.clear(RESET_ALARM);
    const resetAt = state && state.resetAt;
    const wantsReset = J.hasPendingResetJobs(list) || W.pendingResetRuns(runs).length > 0;
    // A run that paused for usage wakes on the same alarm, but not necessarily
    // at the same time: it may be the WEEKLY window it ran out of, which resets
    // long after the 5-hour one. Whichever comes first is when the worker needs
    // to be awake — it decides what is actually due once it is.
    const wakeAt = [
      wantsReset && typeof resetAt === "number" ? resetAt : null,
      W.nextUsageResume(runs),
    ].filter((t) => typeof t === "number" && t > Date.now());
    if (wakeAt.length) {
      // Fire shortly after the window resets so fresh usage is available.
      chrome.alarms.create(RESET_ALARM, { when: Math.min.apply(null, wakeAt) + 5000 });
    } else if (W.usageWaitingRuns(runs).length) {
      // Waiting on a window whose reset time the meter never gave us. Keep a
      // slow heartbeat rather than nothing at all: a run that quietly never
      // resumed would be worse than one that checked every half hour.
      chrome.alarms.create(RESET_ALARM, { when: Date.now() + 30 * 60 * 1000 });
    }
  } catch (e) {}

  // A held job wants the fast status cadence; nothing held drops back to slow.
  await ensureStatusAlarm(null);
}

// ==== Workflow runs ======================================================
// A run walks its workflow's steps: post the composed message into that step's
// chat, wait for Claude to finish, carry the reply into the next step. The tab's
// content script (src/workflow-run.js) owns the step and writes its result to
// storage, so the worker dying mid-step costs nothing — the pickup pass below
// finds the run again and continues from wherever it actually got to.
const drivingRuns = new Set();

// Runs live one per storage key (see workflow.js), so two runs going at once
// can't overwrite each other's progress.
async function readRunIds() {
  return (await get(W.RUN_IDS_KEY))[W.RUN_IDS_KEY] || [];
}
async function readRuns() {
  const ids = await readRunIds();
  if (!ids.length) return [];
  const store = await get(ids.map(W.runKey));
  return ids.map((id) => store[W.runKey(id)]).filter(Boolean);
}
async function readRun(id) {
  const k = W.runKey(id);
  return (await get(k))[k] || null;
}
// What a run's conversation is called, with the matter's real names swapped for
// the key's fakes on the way out. Answers { title, held }: the title to send,
// or null with `held` saying why nothing is being sent.
//
// A run is named for its matter, because that is what makes one run's chats
// findable among a year of them — and claude.ai's sidebar is not this browser.
// Titling a conversation "8.11.26 Rasho MSJ" would hand Claude the real case
// name in the very run whose every uploaded paper was scrubbed of it, and it
// would stay handed over: a title is stored, synced and searchable.
//
// The key is the run's own, or its GROUP's (a group is one matter and a matter
// has one key — W.runPseudoKey settles it), which is the same key the papers
// were scrubbed with. Only the values the key knows are swapped, so the promise
// is exactly the key's own reach.
//
// Where the matter has NO key, the run's name goes as typed: there are no fakes
// to use, and there is nothing here to protect. Where it HAS one and the swap
// can't be made — the key library wouldn't read, the module isn't there — the
// chat is left unnamed and the run SAYS SO. A title that quietly went out with
// the real name in it is the one outcome this must never have.
// The matter's pseudonym key: its own, or its GROUP's (a group is one matter
// and a matter has one key — W.runPseudoKey settles it). `looked` says the key
// library answered at all, which is not the same as "no key": everything that
// reads this treats "couldn't tell" as a reason to stop, never as a clear run.
async function runKeyRecord(run) {
  let keyId = run && run.pseudoKeyId ? run.pseudoKeyId : null;
  try {
    const res = await get(["cum_pseudo_keys", "cum_run_groups"]);
    if (!keyId && run) keyId = W.runPseudoKey(run, await readRuns(), res.cum_run_groups || []);
    return { keyId: keyId, key: keyId ? (res.cum_pseudo_keys || {})[keyId] || null : null, looked: true };
  } catch (e) {
    return { keyId: keyId, key: null, looked: false };
  }
}

// The case-number gate: may this run go out at all?
//
// A party's name reaching claude.ai is a leak; the CASE NUMBER is the whole
// case — unique, public and searchable, so one of them turns a pseudonymized
// draft back into the matter it came from whatever the names were changed to.
// So a run whose name carries one goes nowhere unless the matter's key
// replaces it. P.caseNumberGate owns the decision and the words; this reads the
// key and hands over the names the run could write into a chat title.
//
// A refusal, not a hold: it never waits for anything, and what it answers is
// said out loud where the run is (an error on the run, a notification) with
// both remedies in it — load a key carrying the number, or take the number out
// of the run's name. Nothing here can sit quietly stuck, which is the reason
// the other gates in this file need ceilings and this one does not.
async function caseNumberBlock(run, src) {
  const P = self.CUMPseudo;
  if (!P)
    return (
      "the pseudonym module is not loaded, so this run's name could not be checked for a " +
      "case number — a run whose name carries a real case number does not go out"
    );
  const rec = await runKeyRecord(run);
  const gate = P.caseNumberGate({
    names: W.titleNames(run, src),
    key: rec.key,
    looked: rec.looked,
  });
  return gate.ok ? null : gate.why;
}

async function chatTitleFor(run, chatName) {
  const P = self.CUMPseudo;
  const unnamed = (why) => ({
    title: null,
    held: "left this chat unnamed: " + why + " — the real name is not going into a chat title",
  });
  // Same importScripts as everything else here, so a worker missing it is a
  // worker that is broken — and a broken worker must not be how a real name
  // reaches a chat title.
  if (!P) return unnamed("the pseudonym module is not loaded");
  const rec = await runKeyRecord(run);
  const plan = P.titlePlan({ looked: rec.looked, keyId: rec.keyId, key: !!rec.key });
  if (plan.mode === "hold") return unnamed(plan.why);
  return {
    title: W.chatTitle(run, chatName, plan.mode === "clean" ? P.nameCleaner(rec.key) : null),
    held: null,
  };
}

async function saveRun(run) {
  await set({ [W.runKey(run.id)]: run });
  const ids = await readRunIds();
  if (ids.indexOf(run.id) === -1) await set({ [W.RUN_IDS_KEY]: ids.concat([run.id]) });
  return run;
}
function localDateStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// Book a finished step's usage into the ledger the Usage tab divides by the
// daily totals. Written HERE rather than in the page that ran the step: this is
// one shared key, and two runs finishing a step in the same instant would each
// read it, add their own, and write back over the other. The worker is one
// thread, so its read-modify-write can't lose an increment.
async function recordStepUsage(prev, run) {
  if (!run) return;
  const rows = run.transcript || [];
  // Everything recorded since the last look — one row for an ordinary step,
  // several for a wave, where only the first carries the figure because the
  // meter can't be split between chats that ran at once.
  const had = prev ? (prev.transcript || []).length : Math.max(0, rows.length - 1);
  if (had >= rows.length) return;
  const pct = rows
    .slice(had)
    .reduce((a, t) => a + (typeof t.usedWeekly === "number" ? t.usedWeekly : 0), 0);
  if (!(pct > 0)) return;
  const t = { usedWeekly: pct };
  const wf = W.getWorkflow((await get(WORKFLOWS_KEY))[WORKFLOWS_KEY] || [], run.workflowId);
  const ledger = (await get(WF_USAGE_KEY))[WF_USAGE_KEY] || U.EMPTY;
  await set({
    [WF_USAGE_KEY]: U.observe(ledger, {
      dateStr: localDateStr(Date.now()),
      pct: t.usedWeekly,
      workflowId: run.workflowId || run.id,
      // The template's name, not the run's — a run is named for the matter, and
      // a breakdown by matter would grow a line every time you started one.
      workflowName: (wf && (wf.templateName || wf.name)) || run.templateName || null,
    }),
  });
}

// A finished run's total goes into its workflow's running average, so the next
// time you're about to start one it can say what it usually costs.
async function noteRunUsage(run) {
  if (!run || !run.workflowId) return;
  const list = (await get(WORKFLOWS_KEY))[WORKFLOWS_KEY] || [];
  const wf = W.getWorkflow(list, run.workflowId);
  if (!wf) return; // the template was deleted or replaced — nothing to average
  const next = W.noteRunUsage(wf, run);
  if (next !== wf) await set({ [WORKFLOWS_KEY]: W.upsertWorkflow(list, next) });
}

// ---- combining a run's text documents -----------------------------------
//
// Done HERE — in the worker, before a run touches a tab — rather than in the
// page as each step sends. Building the combined file is ordinary string work
// that can't fail for interesting reasons, and doing it inside the send path put
// it in the worst place for it: mid-run, between opening a conversation and
// uploading to it, where a failure costs an afternoon and has to be recovered
// from by hand. Up front, a document that can't be read is a run that hasn't
// started yet.
//
// It's idempotent, so it can run at the top of every step without doing the work
// twice: once a group is folded, its members no longer name that chat, and
// bundlePlan stops seeing a group at all.
function dataUrlToText(dataUrl) {
  const s = String(dataUrl || "");
  const comma = s.indexOf(",");
  if (comma === -1) return null;
  const meta = s.slice(0, comma);
  const payload = s.slice(comma + 1);
  try {
    if (!/;base64/i.test(meta)) return decodeURIComponent(payload);
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // The bytes are somebody's brief, so decode them strictly: mojibake in a
    // combined file is worse than not combining, because it still gets read.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    return null;
  }
}

function textToDataUrl(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return "data:text/plain;base64," + btoa(bin);
}

async function materialiseBundles(run) {
  if (!run || !run.bundleText) return run;
  const src = W.runSource(run, null);
  const groups = W.bundlePlan(Object.assign({ bundleText: true }, src));
  if (!groups.length) return run;

  let docs = run.docs || [];
  let changed = false;
  for (const g of groups) {
    const byId = new Map(W.allDocs(src).map((d) => [d.id, d]));
    const blobs = await get(g.docIds.map((id) => J.fileKey(id)));
    const parts = [];
    let readable = true;
    for (const id of g.docIds) {
      const text = dataUrlToText(blobs[J.fileKey(id)]);
      if (text == null) {
        readable = false;
        break;
      }
      parts.push({ name: (byId.get(id) || {}).name || "untitled", text: text });
    }
    // Unreadable, or empty once read: leave the group alone and let the papers
    // go up as they are. Combining is an improvement, never a precondition.
    const combined = readable ? W.bundleText(parts) : "";
    if (!combined) continue;
    const id = crypto.randomUUID();
    await set({ [J.fileKey(id)]: textToDataUrl(combined) });
    docs = W.foldBundle(docs, g, {
      id: id,
      name: "combined-documents.txt",
      type: "text/plain",
      size: combined.length,
    });
    changed = true;
  }
  if (!changed) return run;
  return await saveRun(Object.assign({}, run, { docs: docs }));
}

// ---- incognito recovery, swept ------------------------------------------
// An incognito chat is kept against the tab being closed by accident, not kept
// full stop: a permanent copy of a conversation you asked not to be recorded is
// not a recovery feature. Swept here rather than in a page, because the sweep
// has to happen whether or not you go back to claude.ai.
async function sweepGhosts() {
  if (!G) return;
  const ids = (await get(G.INDEX_KEY))[G.INDEX_KEY] || [];
  if (!ids.length) return;
  const store = await get(ids.map(G.recordKey));
  const now = Date.now();
  const dead = [];
  const keep = [];
  for (const id of ids) {
    const rec = store[G.recordKey(id)];
    // A record whose bytes are gone is an id pointing at nothing.
    if (!rec || G.isExpired(rec, now)) dead.push(id);
    else keep.push(id);
  }
  if (!dead.length) return;
  try {
    chrome.storage.local.remove(dead.map(G.recordKey));
  } catch (e) {
    /* ignore */
  }
  await set({ [G.INDEX_KEY]: keep });
}

// Each run's heartbeat, written only by the page that holds its current step.
async function readBeats(ids) {
  if (!ids.length) return {};
  const store = await get(ids.map(W.beatKey));
  const out = {};
  for (const id of ids) out[id] = store[W.beatKey(id)] || 0;
  return out;
}

// One-time move from the old single-array store. Runs in flight survive it.
// Carry stored workflows and runs into the current shape of the settings: the
// ruling marker moved from the chat to the step, two switches changed their
// default, and one went away. A stored record holds what it was given rather
// than what it meant, so this is done once, in storage, rather than guessed at
// by every reader — see CUMWorkflow.migrateSettings for what "once" means.
async function migrateSettings() {
  try {
    const list = (await get(WORKFLOWS_KEY))[WORKFLOWS_KEY] || [];
    const next = list.map((wf) => W.migrateSettings(wf));
    if (next.some((wf, i) => wf !== list[i])) await set({ [WORKFLOWS_KEY]: next });
  } catch (e) {
    /* a migration that throws must not stop the worker starting */
  }
  try {
    for (const run of await readRuns()) {
      const moved = W.migrateRunSettings(run);
      if (moved !== run) await saveRun(moved);
    }
  } catch (e) {
    /* ignore */
  }
}

async function migrateRuns() {
  const store = await get([RUNS_KEY, W.RUN_IDS_KEY]);
  const old = store[RUNS_KEY];
  if (!Array.isArray(old)) return;
  if (old.length) {
    const writes = {};
    const ids = (store[W.RUN_IDS_KEY] || []).slice();
    for (const r of old) {
      if (!r || !r.id) continue;
      writes[W.runKey(r.id)] = r;
      if (ids.indexOf(r.id) === -1) ids.push(r.id);
    }
    writes[W.RUN_IDS_KEY] = ids;
    await set(writes);
  }
  try {
    chrome.storage.local.remove(RUNS_KEY);
  } catch (e) {
    /* ignore */
  }
}

// Put the pre-built workflow in place once. The flag means deleting it makes it
// stay deleted — re-seeding a workflow the user threw away would be rude.
async function seedWorkflows() {
  const store = await get([WORKFLOWS_KEY, WF_SEEDED_KEY]);
  if (store[WF_SEEDED_KEY]) return;
  const list = store[WORKFLOWS_KEY] || [];
  const wf = W.builtinWorkflow(() => crypto.randomUUID(), Date.now());
  await set({ [WORKFLOWS_KEY]: W.upsertWorkflow(list, wf), [WF_SEEDED_KEY]: true });
}

function windowExists(id) {
  return new Promise((resolve) => {
    try {
      chrome.windows.get(id, () => resolve(!chrome.runtime.lastError));
    } catch (e) {
      resolve(false);
    }
  });
}

// Whatever you were doing stays in front.
//
// A run's window is opened behind on purpose — but SIZING a window is a request
// to the window manager, and window managers raise the windows they are asked to
// resize or maximize. That is how a run that must never interrupt you ended up
// taking the screen on every single step: the size check ran before each send,
// the state came back as something other than "maximized" (which platforms
// report inconsistently), and the fix-up raised the window every time.
//
// Two rules now. Size it ONCE, when the run opens it, and afterwards leave it
// alone unless it is actually too narrow to render Claude properly. And bracket
// anything that could still raise it with this: note what had the screen, put it
// back if it moved.
async function keepingFocus(fn) {
  let before = null;
  try {
    before = await chrome.windows.getLastFocused();
  } catch (e) {
    /* ignore */
  }
  try {
    return await fn();
  } finally {
    try {
      // Only when Chrome had the screen to begin with. If you were in another
      // application, "restoring" focus to a Chrome window would be the very
      // theft this exists to prevent.
      if (before && before.id != null && before.focused) {
        const now = await chrome.windows.getLastFocused();
        if (now && now.id !== before.id)
          await chrome.windows.update(before.id, { focused: true });
      }
    } catch (e) {
      /* ignore */
    }
  }
}

// Below this, claude.ai serves its compact client, which cannot render some
// block types — it shows "This block is not supported on your current device"
// where the content should be, and the copy box then copies that notice into
// the next chat as the material to work from. So a window this narrow is worth
// raising to fix. A window already wider than this is left entirely alone.
const RUN_MIN_W = 1100;

// Maximize a run's window if it isn't already — one the operator resized, or one
// from before this mattered.
async function ensureWindowSize(windowId) {
  const win = await new Promise((resolve) => {
    try {
      chrome.windows.get(windowId, (w) => {
        void chrome.runtime.lastError;
        resolve(w || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
  if (!win || win.state === "maximized" || win.state === "fullscreen") return;
  // Wide enough for the full client already. Whatever the window manager calls
  // that state, there is nothing here worth taking the screen for.
  if (typeof win.width === "number" && win.width >= RUN_MIN_W) return;
  // Maximize as a SEPARATE update rather than at creation: `state` can't be
  // combined with bounds at create time, and a create that rejects the
  // combination takes the whole window with it.
  // Twice, with a pause. A window that has only just been created can swallow
  // the first request; the second lands.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await chrome.windows.update(windowId, { state: "maximized" });
      const after = await new Promise((resolve) => {
        try {
          chrome.windows.get(windowId, (w) => {
            void chrome.runtime.lastError;
            resolve(w || null);
          });
        } catch (e) {
          resolve(null);
        }
      });
      if (after && after.state === "maximized") return;
    } catch (e) {
      /* try again, then fall through to bounds */
    }
    await sleep(600);
  }
  // A window manager that won't maximize on request still honours bounds.
  // Asking for more than the screen is fine — Chrome clamps it — and that's
  // the point: fill whatever display this is on without needing to measure it.
  try {
    await chrome.windows.update(windowId, {
      left: 0,
      top: 0,
      width: RUN_WINDOW_W,
      height: RUN_WINDOW_H,
    });
  } catch (e) {
    /* ignore */
  }
}

// Press Stop in every tab of a run's window. Best-effort and fire-and-forget:
// a tab with no content script listening, or none generating, simply says
// nothing. An answer nobody is going to read is still an answer being paid for.
function stopGeneratingIn(run) {
  if (!run || typeof run.windowId !== "number") return;
  // In a window of its own, every tab is the run's. In a window it is only
  // borrowing, most of them are yours — and pressing Stop in a chat you are
  // in the middle of is exactly the kind of surprise a background run must
  // never spring. So there, only the conversations this run actually owns.
  const mine = new Set();
  if (!run.newWindow) {
    for (const id in run.chats || {}) {
      const u = run.chats[id] && run.chats[id].url;
      if (u) mine.add(u);
    }
  }
  tabsInWindow(run.windowId).then((tabs) => {
    for (const t of tabs) {
      if (t.id == null) continue;
      if (!run.newWindow) {
        const known = t.url && Array.from(mine).some((u) => J.sameConversationUrl(t.url, u));
        if (!known) continue;
      }
      try {
        chrome.tabs.sendMessage(t.id, { type: "cum-wf-stop-generating" }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) {
        /* ignore */
      }
    }
  });
}

async function tabsInWindow(windowId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ windowId }, (t) => {
        void chrome.runtime.lastError;
        resolve(t || []);
      });
    } catch (e) {
      resolve([]);
    }
  });
}

// The Options page, pinned at the left edge of a run's own window. A run's
// window is where you watch it happen, and the controls for it — Steps, Pause,
// Fix & continue — were a window away in a tab you had to go and find. Pinned
// so it reads as this window's control panel rather than another chat, opened
// on the Workflows section, and never made active: the chat stays in front.
async function ensureOptionsTab(windowId) {
  if (windowId == null) return;
  const url = chrome.runtime.getURL("src/options.html") + "#workflows";
  try {
    const here = await tabsInWindow(windowId);
    // Any Options tab counts, whatever section it's on — the operator may well
    // have clicked away to Usage, and a second copy would be clutter.
    const base = chrome.runtime.getURL("src/options.html");
    if (here.some((t) => t && t.url && t.url.indexOf(base) === 0)) return;
    await chrome.tabs.create({ url, windowId, active: false, pinned: true, index: 0 });
  } catch (e) {
    /* a window that vanished mid-open, or a tab Chrome declined — not worth
       failing the run over */
  }
}

// A run's chats sit together in a TAB GROUP, named and colored for the case
// (W.tabGroupTitle / tabGroupColor — the color seeds on the run's key, so
// every run of one case wears the same color). Stateless on purpose: the
// group is found by looking at where the run's other chats already sit, so a
// browser restart or a hand-closed group never leaves a stale id behind — the
// next tab simply starts a fresh group. A tab the operator grouped by hand is
// respected, a pinned tab (the Options control panel) is never grouped, and
// any failure is swallowed whole: grouping is a nicety, and a run must never
// fail over furniture.
async function groupRunTab(run, tab) {
  if (!run || !tab || typeof tab.id !== "number" || tab.pinned) return;
  if (!chrome.tabGroups || !chrome.tabs || !chrome.tabs.group) return;
  try {
    if (typeof tab.groupId === "number" && tab.groupId !== -1) return; // already grouped
    const urls = Object.values(run.chats || {})
      .map((c) => c && c.url)
      .filter(Boolean);
    let groupId = null;
    for (const t of await tabsInWindow(tab.windowId)) {
      if (!t || t.id === tab.id || typeof t.groupId !== "number" || t.groupId === -1) continue;
      if (t.url && urls.some((u) => J.sameConversationUrl(t.url, u))) {
        groupId = t.groupId;
        break;
      }
    }
    if (groupId != null) {
      await chrome.tabs.group({ tabIds: tab.id, groupId });
      return;
    }
    groupId = await chrome.tabs.group({ tabIds: tab.id });
    const keysRes = await get("cum_pseudo_keys");
    await chrome.tabGroups.update(groupId, {
      title: W.tabGroupTitle(run, keysRes.cum_pseudo_keys || {}),
      color: W.tabGroupColor(run.pseudoKeyId || run.id),
      collapsed: false,
    });
  } catch (e) {
    /* grouping is a nicety */
  }
}

// Every tab in `windowId` holding one of this run's conversations, gathered
// into the run's group — the catch-up pass Open-chats uses, since it meets
// tabs that were opened long ago as well as ones it just made.
async function groupRunChats(run, windowId) {
  if (!run || windowId == null) return;
  const urls = Object.values(run.chats || {})
    .map((c) => c && c.url)
    .filter(Boolean);
  if (!urls.length) return;
  for (const t of await tabsInWindow(windowId)) {
    if (t && t.url && urls.some((u) => J.sameConversationUrl(t.url, u)))
      await groupRunTab(run, t);
  }
}

// A tab showing `url` inside this run's own window. Deliberately scoped to that
// window: a conversation the operator happens to have open elsewhere is theirs,
// and driving a message into the tab they're reading would be a nasty surprise.
async function runTab(run, url, canReuse) {
  let windowId = typeof run.windowId === "number" ? run.windowId : null;
  if (windowId != null && !(await windowExists(windowId))) windowId = null;

  // Sharing a window rather than opening one. Everything the isolated window
  // gave for free has to be given up deliberately here: nothing is resized (the
  // window is yours), no Options tab is pinned into it (it would be clutter in
  // a window you are using), and a tab is only ever reused when it holds a
  // conversation this run already owns — see the `canReuse` guard below, which
  // is what stops a first step typing into whatever /new tab you had open.
  if (!run.newWindow) {
    if (windowId == null) windowId = await hostWindow();
    if (windowId == null) return { tab: null, windowId: null };
    if (canReuse) {
      for (const t of await tabsInWindow(windowId)) {
        if (t && t.url && J.sameConversationUrl(t.url, url)) {
          await groupRunTab(run, t);
          return { tab: t, windowId, created: false };
        }
      }
    }
    try {
      const tab = await chrome.tabs.create({ url, windowId, active: false });
      if (tab) await groupRunTab(run, tab);
      return tab ? { tab, windowId, created: true } : { tab: null, windowId };
    } catch (e) {
      return { tab: null, windowId };
    }
  }

  if (windowId == null) {
    try {
      // focused:false — a run must never take the screen away from what you're
      // doing. Its window opens behind, holding only this run's chats.
      //
      // Created plainly, then maximized as its own step. Asking for a state at
      // creation is the fragile version — it can't be combined with bounds, and
      // a create that rejects the combination takes the window with it.
      //
      // The size is not cosmetic. claude.ai is responsive, and below its
      // breakpoint it serves a compact client that cannot render some block
      // types — showing "This block is not supported on your current device"
      // where the content should be. The copy box then copies that notice, and
      // the shell travels to the next chat as the material to work from.
      // Filling the screen puts the layout as far from that breakpoint as the
      // display allows.
      // Maximized AT CREATION where Chrome will take it, which is the one way
      // of getting a full-size window that never involves asking the window
      // manager to raise an existing one. `state` can't be combined with bounds
      // — it can perfectly well be combined with `focused: false`.
      let win = null;
      try {
        win = await keepingFocus(() =>
          chrome.windows.create({ url, focused: false, state: "maximized" })
        );
      } catch (e) {
        win = await keepingFocus(() => chrome.windows.create({ url, focused: false }));
      }
      // A beat before maximizing. Asked for immediately the request is ignored
      // — the giveaway being that the same call lands perfectly well later,
      // when the run opens its second tab.
      if (win && win.id != null) {
        if (win.state !== "maximized" && win.state !== "fullscreen") {
          await sleep(300);
          await keepingFocus(() => ensureWindowSize(win.id));
        }
        await ensureOptionsTab(win.id);
      }
      const tab = win && win.tabs && win.tabs[0];
      if (tab) await groupRunTab(run, tab);
      return tab ? { tab, windowId: win.id, created: true } : { tab: null, windowId: null };
    } catch (e) {
      return { tab: null, windowId: null };
    }
  }

  // NOT sized again here. This runs before every step, and re-asserting a
  // window's size on each one is what put the run's window in front of whatever
  // you were doing, over and over, for the length of a run. ensureWindowSize
  // now leaves a window that is already wide enough completely alone, and the
  // request it does make when one isn't goes through keepingFocus.
  await keepingFocus(() => ensureWindowSize(windowId));
  for (const t of await tabsInWindow(windowId)) {
    if (t && t.url && J.sameConversationUrl(t.url, url)) {
      await groupRunTab(run, t);
      return { tab: t, windowId, created: false };
    }
  }
  try {
    const tab = await chrome.tabs.create({ url, windowId, active: false });
    if (tab) await groupRunTab(run, tab);
    return { tab, windowId, created: true };
  } catch (e) {
    return { tab: null, windowId };
  }
}

// The tab a step should run in: the chat's existing conversation if it has one
// (that's the whole point — chat A comes back to its own thread), otherwise a
// fresh composer at the chat's configured destination. Always inside the run's
// own window.
// An ordinary window to put a run's tabs in, when it isn't getting one of its
// own. The last focused normal window, or any normal window, or — if the
// browser somehow has none — nothing, which the caller reports rather than
// papering over.
async function hostWindow() {
  const pick = (opts) =>
    new Promise((resolve) => {
      try {
        chrome.windows.getLastFocused(opts, (w) => {
          void chrome.runtime.lastError;
          resolve(w && w.type === "normal" ? w.id : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  const focused = await pick({});
  if (focused != null) return focused;
  return new Promise((resolve) => {
    try {
      chrome.windows.getAll({ windowTypes: ["normal"] }, (ws) => {
        void chrome.runtime.lastError;
        const w = (ws || [])[0];
        resolve(w && w.id != null ? w.id : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function stepTab(run, savedUrl, chat) {
  const url =
    savedUrl ||
    J.targetUrl({
      projectHref: (chat.target && chat.target.projectHref) || null,
      projectUuid: (chat.target && chat.target.projectUuid) || null,
      codeRepo: (chat.target && chat.target.codeRepo) || null,
      // targetUrl sends a Cowork chat to the composer home rather than to its
      // project, because the toggle and the project menu are both there and
      // nowhere else.
      surface: (chat.target && chat.target.surface) || null,
    });
  // Reuse only where the address is a conversation this run already has. A
  // fresh composer is /new, and matching THAT against a shared window's tabs
  // would hand the step whatever new chat you happened to have open.
  const { tab, windowId, created } = await runTab(run, url, !!savedUrl);
  if (!tab) return { tab: null, windowId: null };
  if (created) {
    await waitTabComplete(tab.id, 30000);
    await sleep(2500); // the SPA needs a moment to render the composer
  }
  return { tab, windowId };
}

// Hand the step to the page. Only the "content script isn't listening yet" case
// retries — once it has the message, it owns the step (which can take the better
// part of an hour), and this waits.
async function sendStep(tabId, payload) {
  // A tab Chrome discarded to save memory has no content script at all until
  // it reloads, and a Cowork page is exactly the heavy, long-idle background
  // tab that gets discarded. Messaging it retries into a void; reloading it
  // first is the only thing that can work.
  try {
    const t = await chrome.tabs.get(tabId);
    if (t && t.discarded) {
      await chrome.tabs.reload(tabId);
      await waitTabComplete(tabId, 30000);
      await sleep(8000);
    }
  } catch (e) {
    /* the retries below still get their chance */
  }
  // Patience grows per attempt. Six seconds total was calibrated for a chat
  // page; a Cowork tab pegs the CPU well past `complete` while its sandbox
  // boots, and a page too busy to answer is not a page with no script in it.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, payload);
      if (res) return res;
    } catch (e) {
      /* content script maybe not ready yet */
    }
    await sleep(1500 + attempt * 1500);
  }
  return { ok: false, error: "no response from page (content script not ready?)" };
}

// Read one chat's latest reply, without sending anything. Used both to re-read
// the hand-off when resuming, and to take the opening hand-off from a chat that
// stands in as step 0.
async function harvestChat(run, source, chatId, chatName) {
  const url = (run.chats && run.chats[chatId] && run.chats[chatId].url) || null;
  if (!url)
    return {
      ok: false,
      error:
        "this run has no conversation recorded for " + chatName +
        " — paste its chat link in, or carry on without re-reading it",
    };
  const { tab, windowId } = await stepTab(run, url, W.getChat(source, chatId) || {});
  if (!tab) return { ok: false, error: "could not open " + chatName };
  if (windowId != null && windowId !== run.windowId) await saveRun(W.withWindow(run, windowId));
  let res = await sendStep(tab.id, { type: "cum-wf-harvest", runId: run.id });
  if (res && !res.ok && /no response from page/.test(res.error || "")) {
    try {
      await chrome.tabs.reload(tab.id);
      await waitTabComplete(tab.id, 30000);
      // `complete` is the document, not the app: a Cowork page keeps booting
      // its sandbox well past it, too busy to answer a message.
      await sleep(8000);
      res = await sendStep(tab.id, { type: "cum-wf-harvest", runId: run.id });
    } catch (e) {
      /* keep the original failure */
    }
  }
  if (!res || !res.ok)
    return { ok: false, error: (res && res.error) || "could not read " + chatName };
  return {
    ok: true,
    text: res.text,
    from: chatName + (res.earlier ? " (an earlier reply — the newest one wouldn't render)" : ""),
    chars: res.chars,
  };
}

// Pick the hand-off back up from the chat that produced it. Resuming a run at
// step N means step N-1's chat is still open with its answer in it; reading
// that is what makes "continue from step N" work without copying anything
// across by hand.
async function refetchCarry(run, wf) {
  const source = W.runSource(run, wf);
  const src = W.carrySource(source, run.stepIndex);
  if (!src.needed) return { ok: true, text: null, skipped: true };
  // One chat for an ordinary step, several where the step before was a wave —
  // and then all of them, folded exactly as the run would have folded them.
  const got = [];
  for (const s of src.sources) {
    const one = await harvestChat(run, source, s.chatId, s.chatName);
    if (!one.ok) return one;
    got.push(Object.assign({}, one, { label: s.label }));
  }
  if (got.length === 1) return got[0];
  return {
    ok: true,
    text: W.foldWave(got.map((g) => ({ label: g.label, text: g.text }))),
    from: got.map((g) => g.from).join(", "),
    chars: got.reduce((a, g) => a + (g.chars || 0), 0),
  };
}

// ---- steps that run at the same time --------------------------------------
//
// A wave is several steps taking the same hand-off, in separate chats, none of
// them reading the others: three devil's-advocate reports written at once
// rather than one after another, and then compared. The step after the wave
// gets all of their replies.
//
// The worker drives it. Each page reports to a key of its OWN (see
// W.memberKey) and never writes the run: three tabs doing read-modify-write on
// one record would lose whichever write landed second, and what gets lost is a
// reply that cost a full Claude turn. This collects them and writes once.
//
// A caveat worth knowing rather than discovering: Chrome throttles timers in
// tabs that aren't in front, so the two members you aren't looking at may
// notice their replies late — a minute or so, on a step that takes many. The
// replies aren't lost, and the run doesn't stall; it just isn't three times
// faster in the way the arithmetic suggests.
async function memberState(runId, stepIndex) {
  const key = W.memberKey(runId, stepIndex);
  return (await get(key))[key] || null;
}

async function clearMembers(runId, indices) {
  try {
    await chrome.storage.local.remove(indices.map((i) => W.memberKey(runId, i)));
  } catch (e) {
    /* a leftover key costs nothing but space */
  }
}

// The run arrives already marked as started and sending, and its clock is
// already running — a wave is one thing the run is doing, so it is timed and
// measured as one.
async function driveWave(runId, run, src, plan, step) {
  const members = step.wave.map((i) => plan[i]);

  // Tabs first, one at a time. Two tab creations racing each other can put the
  // run's window in two places, and then the third member opens in neither.
  const opened = [];
  for (const m of members) {
    const chat = W.getChat(src, m.chatId) || {};
    const saved = (run.chats && run.chats[m.chatId]) || {};
    const { tab, windowId } = await stepTab(run, saved.url, chat);
    if (windowId != null && windowId !== run.windowId)
      run = await saveRun(W.withWindow(run, windowId));
    if (!tab) {
      await saveRun(
        W.markError(await readRun(runId), "could not open a claude.ai tab for step " + m.label, Date.now())
      );
      notify("Workflow stopped", "Could not open a claude.ai tab.");
      return { ok: false };
    }
    // Two members in one tab is two prompts posted into one conversation at
    // once, each taking the other's answer as its own. validate() forbids it
    // when the workflow is written; this is the same rule at the point where
    // getting it wrong would be expensive rather than annoying.
    if (opened.some((o) => o.tab.id === tab.id)) {
      const clash = opened.find((o) => o.tab.id === tab.id);
      await saveRun(
        W.markError(
          await readRun(runId),
          "steps " + clash.m.label + " and " + m.label +
            " run at the same time but landed in the same conversation — give each its own chat",
          Date.now()
        )
      );
      notify("Workflow stopped", "Two parallel steps share a conversation.");
      return { ok: false };
    }
    opened.push({ m: m, tab: tab, saved: saved, chat: chat });
  }

  const startedAt = Date.now();
  const results = await Promise.all(
    opened.map((o) => runMember(runId, run, src, plan, o, startedAt))
  );

  const after = await readRun(runId);
  if (!after || after.status === "canceled") return { ok: false };
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    // One member's page paused or cancelled the run itself — it has already
    // said why, and saying it again over the top would replace the reason with
    // a summary of it.
    if (failed.some((f) => f.canceled || f.paused)) return { ok: false };
    const first = failed[0];
    await saveRun(
      W.markError(after, "step " + first.label + ": " + (first.error || "unknown"), Date.now())
    );
    notify(
      "Workflow stopped",
      W.runLabel(after).title + " failed at step " + first.label + ": " + (first.error || "unknown")
    );
    return { ok: false };
  }

  // Everyone answered. What the meter did while they all ran belongs to the
  // wave — three chats answering at once move one meter, and there's no honest
  // way to split that between them.
  const usageNow = W.usageSample((await get(STATE_KEY))[STATE_KEY]);
  const activity = (await get("cum_activity")).cum_activity || null;
  const mine = Object.keys(after.chats || {})
    .map((cid) => (after.chats[cid] || {}).url)
    .filter(Boolean)
    .map(W.conversationKey);
  const done = W.applyWaveResult(after, {
    members: results.map((r) => r.member),
    now: Date.now(),
    total: plan.length,
    usage: usageNow,
    usageClean: W.soleActor(activity, { from: after.stepStartedAt, to: Date.now(), conv: mine }),
  });
  const saved = await saveRun(done);
  await clearMembers(runId, step.wave);
  await recordStepUsage(after, saved);
  if (saved.status === "done") {
    await noteRunUsage(saved);
    notify("Workflow finished", W.runLabel(saved).title + " — all " + plan.length + " steps done.");
    return { ok: false }; // nothing left to drive
  }
  return { ok: true };
}

// One member of a wave. Returns what the run needs to record it, and never
// writes the run itself.
async function runMember(runId, run, src, plan, opened, waveStartedAt) {
  const { m, tab, saved, chat } = opened;
  const label = m.label;
  // Already answered — a wave that failed half way through is picked back up
  // rather than asked again. Re-sending would post the same message into a
  // conversation that has already replied to it.
  const had = await memberState(runId, m.index);
  if (had && typeof had.reply === "string" && had.reply) {
    return {
      ok: true,
      label: label,
      member: waveMember(m, had, waveStartedAt),
    };
  }

  const docs = W.allDocs(src)
    .filter((d) => m.docIds.indexOf(d.id) !== -1)
    .map((d) => ({ id: d.id, name: d.name, type: d.type, bundled: d.bundled || 0 }));
  const awaitOnly = !!(had && had.sent);
  // Cleaned of the matter's real names before it is sent — see chatTitleFor.
  const naming =
    run.nameChats !== false && m.firstInChat && W.ownsChatName(saved)
      ? await chatTitleFor(run, m.chatName)
      : { title: null, held: null };
  const payload = {
    type: "cum-wf-step",
    runId: runId,
    stepIndex: m.index,
    // Which step the RUN has to be sitting on for this to be current. A member
    // isn't at run.stepIndex — its wave is — so it can't check its own index.
    waveStart: m.waveStart,
    waveKey: W.memberKey(runId, m.index),
    label: label,
    chatId: m.chatId,
    chatName: m.chatName,
    total: plan.length,
    awaitOnly: awaitOnly,
    sentAtKnown: (had && had.sentAt) || null,
    marker: m.marker || null,
    text: W.composeStepText(m, run.lastReply),
    files: awaitOnly ? [] : docs,
    model: m.model && (m.modelOverride || !saved.url) ? m.model : null,
    // Naming is scoped to conversations the run itself opened — and stays
    // theirs on a resume, so a step re-attached after a worker restart can
    // catch up a rename the send-time pass never made. ownsChatName tells a
    // run-opened chat from one the operator pasted in.
    firstInChat: m.firstInChat && W.ownsChatName(saved),
    title: naming.title,
    titleHeld: naming.held,
    codeRepo: m.firstInChat && !saved.url ? (chat.target && chat.target.codeRepo) || null : null,
    // Only on the way in. Once a conversation exists the toggle isn't on the
    // page any more, and the project menu is the composer home's.
    surface: !saved.url ? m.surface || null : null,
    coworkProject:
      m.surface === "cowork" && m.firstInChat && !saved.url
        ? (chat.target && chat.target.projectName) || null
        : null,
  };

  let res;
  try {
    res = await sendStep(tab.id, payload);
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  if (res && !res.ok && /no response from page/.test(res.error || "")) {
    // Same stale-content-script recovery as a lone step, and the same care: if
    // the message got out before the page went quiet, the retry waits instead
    // of posting it twice.
    const mid = await memberState(runId, m.index);
    try {
      await chrome.tabs.reload(tab.id);
      await waitTabComplete(tab.id, 30000);
      // `complete` is the document, not the app: a Cowork page keeps booting
      // its sandbox well past it, too busy to answer a message.
      await sleep(8000);
      res = await sendStep(
        tab.id,
        mid && mid.sent ? Object.assign({}, payload, { awaitOnly: true, files: [] }) : payload
      );
    } catch (e) {
      /* keep the original failure */
    }
  }
  if (!res || !res.ok)
    return {
      ok: false,
      label: label,
      error: (res && res.error) || "unknown",
      canceled: !!(res && res.canceled),
      paused: !!(res && res.paused),
    };

  const state = (await memberState(runId, m.index)) || {};
  const reply = typeof state.reply === "string" && state.reply ? state.reply : res.text || "";
  if (!reply)
    return { ok: false, label: label, error: "the page reported step " + label + " finished but saved no reply" };
  return {
    ok: true,
    label: label,
    member: waveMember(m, Object.assign({}, state, { reply: reply, url: state.url || res.url }), waveStartedAt),
  };
}

function waveMember(m, state, waveStartedAt) {
  const sentAt = typeof state.sentAt === "number" ? state.sentAt : null;
  const at = typeof state.at === "number" ? state.at : Date.now();
  return {
    stepIndex: m.index,
    label: m.chatName + " (" + m.label + ")",
    chatId: m.chatId,
    chatName: m.chatName,
    reply: state.reply,
    url: state.url || null,
    docs: typeof state.docs === "number" ? state.docs : (m.docIds || []).length,
    startedAt: waveStartedAt,
    sentAt: sentAt,
    // Measured per member, because the whole point is that they overlap: the
    // wave takes as long as its slowest, not as long as all of them added up.
    ms: Math.max(0, at - waveStartedAt),
    sendMs: sentAt != null ? Math.max(0, sentAt - waveStartedAt) : null,
    replyMs: sentAt != null ? Math.max(0, at - sentAt) : null,
  };
}

async function driveRun(runId, opts) {
  if (drivingRuns.has(runId)) return;
  drivingRuns.add(runId);
  try {
    // Bounded so a bug can never spin the worker; far above any real workflow.
    for (let guard = 0; guard < 500; guard++) {
      let run = await readRun(runId);
      if (!run || !W.isRunActive(run)) return;
      const wf = W.getWorkflow((await get(WORKFLOWS_KEY))[WORKFLOWS_KEY] || [], run.workflowId);
      if (!wf) {
        await saveRun(W.markError(run, "its workflow was deleted", Date.now()));
        notify("Workflow stopped", W.runLabel(run).title + " — its definition is gone.");
        return;
      }
      // A run executes its OWN snapshot of chats, steps and papers. The
      // template it came from may since have been re-armed for another matter,
      // edited, or deleted; none of that may change what this run does.
      // Fold this run's text documents into one file per upload, before any tab
      // is opened. A no-op once it's been done, so it costs a scan per step.
      run = (await materialiseBundles(run)) || run;
      const src = W.runSource(run, wf);
      // Before anything is planned, sent or even opened: a run whose name
      // carries a real case number does not go out. Checked every step rather
      // than once at the start — a run's name can be edited mid-flight, and the
      // step after the edit is as much of a send as the first one was.
      const blocked = await caseNumberBlock(run, src);
      if (blocked) {
        await saveRun(W.markError(run, blocked, Date.now()));
        notify("Workflow stopped", W.runLabel(run).title + " — " + blocked);
        return;
      }
      const plan = W.planRun(src);
      const step = plan[run.stepIndex];
      if (!step) {
        await saveRun(
          Object.assign({}, run, { status: "done", phase: "idle", finishedAt: Date.now() })
        );
        return;
      }

      // A pause the workflow itself asked for. Handled here rather than in a
      // tab: there is no conversation involved, nothing to send, and nothing to
      // read — it is a gate between two steps.
      //
      // The run steps PAST it first, the way any step is done once it has
      // happened, so Resume — yours or the clock's — carries straight on with
      // the step after it rather than pausing again on the same gate.
      const planned = W.planRun(W.runSource(run, wf))[run.stepIndex];
      if (planned && planned.kind === "pause") {
        const mins = planned.pauseMinutes;
        const at = mins > 0 ? Date.now() + mins * 60000 : null;
        const past = Object.assign({}, run, { stepIndex: run.stepIndex + 1 });
        const label = W.runLabel(run).title;
        await saveRun(
          Object.assign({}, W.markPausedForStep(past, Date.now(), at), {
            note: at
              ? "paused by step " + planned.label + " for " + W.formatMs(mins * 60000) +
                " — carrying on by itself at " + new Date(at).toLocaleTimeString() +
                ", or Resume to go now"
              : "paused by step " + planned.label + " — read the work so far, then Resume",
          })
        );
        notify(
          at ? "Workflow paused for a while" : "Workflow paused for you",
          label + " — " +
            (at
              ? "step " + planned.label + " pauses it for " + W.formatMs(mins * 60000) + "."
              : "step " + planned.label + " pauses it until you resume.")
        );
        await reschedule();
        return;
      }

      // Same gate as a scheduled send: a run driven through the real UI has
      // nothing to fall back on if Claude is down, so it waits — with the same
      // 6-hour ceiling, and Run now still overrides it.
      const gate = await outageGate(
        run,
        Object.assign({}, opts, {
          // Told in advance not to wait one out.
          force: (opts && opts.force) || W.ignoresOutage(run),
          // The step's model, or the chat's. Naming none leaves outageGate to
          // fall back to your default.
          model: W.stepModel(run, wf, null),
        })
      );
      if (gate.hold) {
        const firstHold = run.status !== "waiting";
        await saveRun(W.markHeld(run, gate.reason, Date.now()));
        if (firstHold)
          notify(
            "Workflow is waiting",
            W.runLabel(run).title + " — " +
              "holding at step " + (run.stepIndex + 1) + " until Claude recovers (" + gate.reason + ")."
          );
        ensureStatusAlarm(true);
        return;
      }
      // Nothing left to send into. Pause rather than post a message that will
      // be refused and then wait an hour for a reply that can't come — and
      // pause holding an arrangement to pick itself back up, since the only
      // thing it is waiting for arrives on a schedule.
      const meter = (await get(STATE_KEY))[STATE_KEY];
      if (W.usageBlocked(meter, Date.now())) {
        const back = W.usageBackAt(meter);
        await saveRun(
          Object.assign({}, W.markPausedForUsage(run, Date.now(), back), {
            note:
              "paused before step " + (run.stepIndex + 1) + " — your Claude usage has run out. " +
              (back
                ? "Carrying on by itself when it returns at " + new Date(back).toLocaleTimeString() + "."
                : "Carrying on by itself when it returns."),
          })
        );
        notify(
          "Workflow paused",
          W.runLabel(run).title + " — out of usage before step " + (run.stepIndex + 1) +
            (back ? ". Resumes itself at " + new Date(back).toLocaleTimeString() : ". Resumes itself when usage returns") + "."
        );
        await reschedule();
        return;
      }

      const heldNote = gate.expired
        ? "step " + (run.stepIndex + 1) + " sent after waiting " + S.fmtWaited(gate.waitedMs)
        : // Not held at all, because the outage is somebody else's models. Said
          // out loud: an outage warning on the pill and a run carrying on
          // regardless needs an explanation on the run itself.
          gate.spared
          ? "Claude is down for " + gate.spared + " — this run isn't on it"
          : null;

      // A chat standing in as step 0: take its latest reply as the opening
      // hand-off. Read here rather than at Start, because a scheduled run may
      // have been queued hours ago and what matters is what's in that chat when
      // it actually goes.
      if (run.seedFrom && !(run.lastReply || "").trim()) {
        const from = W.chatName(src, run.seedFrom);
        const got = await harvestChat(run, src, run.seedFrom, from);
        if (!got.ok) {
          await saveRun(
            W.markError(run, "couldn't read " + from + " to start from — " + got.error, Date.now())
          );
          notify("Workflow stopped", W.runLabel(run).title + " — " + got.error);
          return;
        }
        run = await saveRun(
          Object.assign({}, run, {
            lastReply: got.text,
            seedFrom: null,
            note: "started from " + got.from + "'s latest reply (" + got.chars + " chars)",
          })
        );
      }

      // Re-attaching to a step whose message already went out must NOT send it
      // again — it waits for the reply that is already coming.
      const awaitOnly = run.phase === "awaiting-reply";
      const now = Date.now();
      // The meter as it stands before this step. What it reads when the step
      // lands, less this, is what your usage did while the step ran.
      const usageBefore = W.usageSample((await get(STATE_KEY))[STATE_KEY]);
      run = await saveRun(
        W.markSending(
          Object.assign({}, W.markStarted(run, now), heldNote ? { note: heldNote } : {}),
          now,
          usageBefore
        )
      );

      // Steps that run at the same time: sent together, waited on together, and
      // folded into one hand-off when the last of them lands. Everything above
      // — the outage gate, the usage check, the run's own clock — applies to the
      // wave as a whole, which is why this sits here rather than earlier.
      if (step.parallel) {
        const waved = await driveWave(runId, run, src, plan, step);
        if (!waved.ok) return;
        continue;
      }

      const chat = W.getChat(src, step.chatId) || {};
      const saved = (run.chats && run.chats[step.chatId]) || {};
      const { tab, windowId } = await stepTab(run, saved.url, chat);
      if (windowId != null && windowId !== run.windowId)
        run = await saveRun(W.withWindow(run, windowId));
      if (!tab) {
        await saveRun(W.markError(await readRun(runId), "could not open a claude.ai tab", Date.now()));
        notify("Workflow stopped", "Could not open a claude.ai tab.");
        return;
      }

      const docs = W.allDocs(src)
        .filter((d) => step.docIds.indexOf(d.id) !== -1)
        .map((d) => ({ id: d.id, name: d.name, type: d.type, bundled: d.bundled || 0 }));

      // Cleaned of the matter's real names before it is sent — see chatTitleFor.
      const naming =
        run.nameChats !== false && step.firstInChat && W.ownsChatName(saved)
          ? await chatTitleFor(run, step.chatName)
          : { title: null, held: null };
      const payload = {
        type: "cum-wf-step",
        runId: runId,
        stepIndex: run.stepIndex,
        chatId: step.chatId,
        chatName: step.chatName,
        total: plan.length,
        awaitOnly: awaitOnly,
        // The phrase this step's reply must contain before the run moves on.
        // Computed from the plan at dispatch, never stored — which is what
        // makes a change to the rule reach workflows and runs that already
        // exist, including one paused mid-flight.
        marker: step.marker || null,
        text: W.composeStepText(step, run.lastReply),
        files: awaitOnly ? [] : docs,
        // The model this step answers on. A step that names its own switches to
        // it wherever it is — claude.ai's picker works inside an existing
        // conversation, which is what lets one chat draft on one model and
        // revise on another. A chat's own setting stays first-message-only:
        // changing the model of a conversation the run didn't open would reach
        // into work that was already there.
        model: step.model && (step.modelOverride || !saved.url) ? step.model : null,
        // What to call this conversation, when the run is the one opening it.
        // ownsChatName is the test for that: a chat the run was pointed at
        // already had a link, and retitling a conversation you started yourself
        // is not the extension's business — while one the run's own send opened
        // stays the run's to name even on a resume, so a step re-attached after
        // a worker restart can catch up a rename the send-time pass never made.
        firstInChat: step.firstInChat && W.ownsChatName(saved),
        title: naming.title,
        titleHeld: naming.held,
        codeRepo: step.firstInChat && !saved.url ? (chat.target && chat.target.codeRepo) || null : null,
        // Only on the way in — see the wave payload for why.
        surface: !saved.url ? step.surface || null : null,
        coworkProject:
          step.surface === "cowork" && step.firstInChat && !saved.url
            ? (chat.target && chat.target.projectName) || null
            : null,
      };
      let res = await sendStep(tab.id, payload);

      // A page that never answers usually has a stale content script: the
      // extension was reloaded (or updated) while this tab stayed open, which
      // orphans it. Reload the tab to inject fresh scripts and try once more.
      if (res && !res.ok && /no response from page/.test(res.error || "")) {
        // But re-read the run first. If the page managed to send before it went
        // quiet, the retry must WAIT for the reply rather than post the message
        // a second time.
        const mid = await readRun(runId);
        const alreadySent = !!(mid && mid.phase === "awaiting-reply");
        try {
          await chrome.tabs.reload(tab.id);
          await waitTabComplete(tab.id, 30000);
          await sleep(3000);
          res = await sendStep(
            tab.id,
            alreadySent ? Object.assign({}, payload, { awaitOnly: true, files: [] }) : payload
          );
        } catch (e) {
          /* keep the original failure */
        }
      }

      const after = await readRun(runId);
      if (!after || after.status === "canceled") return;
      if (!res || !res.ok) {
        // Cancelled, or paused because the reply came back cut off — the page
        // has already recorded why. Neither is an error to report over the top
        // of it.
        if (res && (res.canceled || res.paused)) {
          if (res.paused)
            notify(
              "Workflow paused",
              W.runLabel(run).title + " — Claude's response was interrupted at step " +
                (run.stepIndex + 1) + ". Read the chat, then Resume."
            );
          return;
        }
        await saveRun(W.markError(after, (res && res.error) || "unknown", Date.now()));
        notify(
          "Workflow stopped",
          W.runLabel(after).title + " failed at step " + (after.stepIndex + 1) + ": " +
            ((res && res.error) || "unknown")
        );
        return;
      }
      await recordStepUsage(run, after);
      if (after.status === "done") {
        await noteRunUsage(after);
        notify(
          "Workflow finished",
          W.runLabel(after).title + " — all " + plan.length + " steps done."
        );
        return;
      }
      if (after.stepIndex === run.stepIndex) {
        // The page said OK but the run hasn't moved here yet. It reports where
        // it left the run, so give the storage write a moment to land before
        // concluding anything went wrong.
        if (res.stepIndex != null && res.stepIndex > run.stepIndex) {
          await sleep(1000);
          const again = await readRun(runId);
          if (again && again.stepIndex > run.stepIndex) continue;
        }
        await saveRun(
          W.markError(
            after,
            "the page reported this step finished but recorded no result for it — " +
              "its reply was not saved, so the next step would have nothing to carry",
            Date.now()
          )
        );
        return;
      }
    }
  } finally {
    drivingRuns.delete(runId);
  }
}

// Start (or continue) whatever the given event makes due. Runs go one at a time
// — each one is already driving a full conversation.
// A run that paused only because the window was empty lifts its own pause.
//
// The METER decides, never the clock: the reset time a run recorded when it
// stopped is what the alarm is set by, but a window can reopen early, late, or
// at a time the meter had wrong, and the reading is the only thing that knows.
// So a wake-up that arrives while usage is still gone does nothing at all and
// leaves the run exactly as it is — the next reading will come along, and the
// storage listener means every meter update is one.
// A timed pause step's time is up. The same act as Resume, and deliberately the
// same code path: what the clock does when you aren't there must be what you
// would have done if you were.
async function resumeClockRuns() {
  const due = W.clockWaitingRuns(await readRuns(), Date.now());
  if (!due.length) return;
  for (const r of due) {
    const run = await readRun(r.id);
    if (!run || run.status !== "paused" || run.resumeOnUsage) continue;
    if (!(typeof run.resumeAt === "number" && run.resumeAt <= Date.now())) continue;
    const resumed = W.reviseRun(
      run,
      {
        stepIndex: run.stepIndex,
        phase: run.phase === "awaiting-reply" ? "awaiting-reply" : "idle",
      },
      Date.now()
    );
    await saveRun(
      Object.assign({}, W.holdPaused(resumed), {
        pausedByStep: false,
        note: "carried on by itself — the pause was up",
      })
    );
    notify(
      "Workflow resumed",
      W.runLabel(run).title + " — the pause is up, carrying on from step " + (run.stepIndex + 1) + "."
    );
    driveRun(run.id);
  }
  await reschedule();
}

let resumeBusy = null; // the alarm and a meter update can arrive together
async function resumeUsageRuns() {
  if (resumeBusy) return resumeBusy;
  resumeBusy = doResumeUsageRuns().finally(() => {
    resumeBusy = null;
  });
  return resumeBusy;
}

async function doResumeUsageRuns() {
  const runs = await readRuns();
  if (!W.usageWaitingRuns(runs).length) return;
  const meter = (await get(STATE_KEY))[STATE_KEY];
  if (W.usageBlocked(meter, Date.now())) return; // early wake-up; nothing to do yet
  let woke = false;
  for (const r of W.usageWaitingRuns(runs)) {
    // Re-read: this can be reached from the alarm and from a meter update at
    // once, and resuming a run twice would drive the same step in two places.
    const run = await readRun(r.id);
    if (!run || run.status !== "paused" || !run.resumeOnUsage) continue;
    const resumed = W.reviseRun(
      run,
      {
        stepIndex: run.stepIndex,
        // A message that already went out is waited for, not sent again — the
        // same distinction Resume makes by hand.
        phase: run.phase === "awaiting-reply" ? "awaiting-reply" : "idle",
      },
      Date.now()
    );
    await saveRun(
      Object.assign({}, W.holdPaused(resumed), {
        note: "carried on by itself — usage is back",
      })
    );
    notify(
      "Workflow resumed",
      W.runLabel(run).title + " — usage is back, carrying on from step " + (run.stepIndex + 1) + "."
    );
    woke = true;
    driveRun(run.id);
  }
  if (woke) await reschedule();
}

async function startRuns(kind /* "time" | "reset" | "hold" | "pickup" */) {
  const runs = await readRuns();
  const now = Date.now();
  const due =
    kind === "hold"
      ? W.heldRuns(runs)
      : kind === "reset"
      ? W.pendingResetRuns(runs)
      : kind === "pickup"
      ? W.pickupRuns(runs, now, W.STALE_MS, await readBeats(runs.map((r) => r.id)))
      : W.dueRuns(runs, now);
  // Concurrently. Runs are independent — their own window, their own
  // conversations, their own storage keys — and a run is hours long, so driving
  // them one after another would mean a second matter queued for the same
  // trigger didn't start until the first had finished. (Pressing Start twice
  // always ran them side by side; this makes the scheduled path agree.)
  await Promise.all(due.map((r) => driveRun(r.id)));
  if (due.length) await reschedule();
}

// Refresh the cached project list. Rather than scrape the (virtualized) grid,
// drive the page's own project API: open/reuse a claude.ai tab, ask its content
// script to trigger an API pull, and wait for the harvested list to land in
// storage. This is hidden-tab friendly — no DOM rendering needed — and returns
// every project, not just the ones that happened to paint.
async function readProjects() {
  return (await get("cum_projects")).cum_projects || [];
}

async function refreshProjects() {
  const before = await readProjects();
  let tab;
  let createdTab = false;
  try {
    const tabs = await new Promise((res) =>
      chrome.tabs.query({ url: "https://claude.ai/*" }, (t) => res(t || []))
    );
    if (tabs.length) {
      tab = tabs[0]; // reuse an already-open claude.ai tab
    } else {
      tab = await chrome.tabs.create({ url: "https://claude.ai/new", active: false });
      createdTab = true;
      await waitTabComplete(tab.id, 30000);
      await sleep(1500); // let the content scripts attach
    }
  } catch (e) {
    return { error: "could not open a claude.ai tab" };
  }

  // Kick off API-based discovery (retry in case the content script isn't ready).
  for (let i = 0; i < 3; i++) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "cum-discover-projects" });
      break;
    } catch (e) {
      await sleep(1200);
    }
  }

  // Wait for the authoritative list to land, up to ~15s. It may grow (new
  // projects) or shrink (deleted ones), so break as soon as the SET changes.
  const key = (list) => list.map((p) => p.uuid).sort().join(",");
  const beforeKey = key(before);
  let projects = before;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const now = await readProjects();
    projects = now;
    if (key(now) !== beforeKey) break; // added or removed
  }

  if (createdTab) {
    try {
      chrome.tabs.remove(tab.id);
    } catch (e) {}
  }
  return { projects };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "cum-refresh-projects") {
    refreshProjects()
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg && msg.type === "cum-open-options") {
    try {
      chrome.runtime.openOptionsPage();
    } catch (e) {}
  }
  if (msg && msg.type === "cum-run-now" && msg.jobId) {
    (async () => {
      if (running) return { ok: false, error: "another job is running" };
      const { [JOBS_KEY]: jobs } = await get(JOBS_KEY);
      const job = J.getJob(jobs || [], msg.jobId);
      if (!job) return { ok: false, error: "job not found" };
      running = true;
      try {
        // An explicit Run now overrides the outage gate — the operator can see
        // the warning on the pill and has decided to try anyway.
        await executeJob(job, { force: true });
      } finally {
        running = false;
      }
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  // Queue a workflow run. The options page hands over the workflow id and a
  // trigger; the run itself is minted here so only one place decides what a
  // fresh run looks like.
  if (msg && msg.type === "cum-wf-run" && msg.workflowId) {
    (async () => {
      const wf = W.getWorkflow((await get(WORKFLOWS_KEY))[WORKFLOWS_KEY] || [], msg.workflowId);
      if (!wf) return { ok: false, error: "workflow not found" };
      const problems = W.validate(wf).filter((p) => !/aren't assigned to a chat/.test(p));
      if (problems.length) return { ok: false, error: problems[0] };
      const now = Date.now();
      // A workflow is a template. The run takes this matter's name and its
      // papers; the template goes straight back to its resting name with no
      // documents, ready to be armed for the next matter — even while this run
      // is still going, which is why the run owns the documents from here.
      const run = W.newRun(wf, crypto.randomUUID(), now, msg.trigger, wf.docs);
      // Told at the door rather than an hour later, for a run going out NOW. A
      // run being QUEUED is left alone deliberately: its key is attached in the
      // run editor, which is a thing you do after making the run — and the
      // gate in driveRun still stops it when its moment comes.
      if (run.trigger.type === "now") {
        const blocked = await caseNumberBlock(run, W.runSource(run, wf));
        if (blocked) return { ok: false, error: blocked };
      }
      await saveRun(run);
      const workflows = (await get(WORKFLOWS_KEY))[WORKFLOWS_KEY] || [];
      await set({ [WORKFLOWS_KEY]: W.upsertWorkflow(workflows, W.resetToTemplate(wf, now)) });
      await reschedule();
      // A draft has no trigger yet — it sits in the runs list until it's given
      // one. Everything that picks runs up gates on "pending", so nothing here
      // has to know about it.
      if (run.trigger.type === "now") driveRun(run.id); // long-running: don't await
      return { ok: true, runId: run.id };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // Change when a queued run goes off — a different time, or across to "when
  // usage resets" or straight away.
  // Run a finished run again: a fresh draft from its own plan, starting where
  // you said, in its conversations or in new ones.
  if (msg && msg.type === "cum-wf-rerun" && msg.runId) {
    (async () => {
      const run = await readRun(msg.runId);
      if (!run) return { ok: false, error: "run not found" };
      if (!W.canRerun(run))
        return { ok: false, error: "this run can't be re-run — tick it on the workflow first" };
      const next = W.rerunOf(run, msg.opts || {}, crypto.randomUUID(), Date.now());
      if (!next) return { ok: false, error: "could not build the re-run" };
      if (next.trigger && next.trigger.type === "now") {
        const blocked = await caseNumberBlock(next, W.runSource(next, null));
        if (blocked) return { ok: false, error: blocked };
      }
      await saveRun(next);
      await reschedule();
      // Armed to go, unless the caller parked it. Not awaited — a run is hours.
      const started = next.trigger && next.trigger.type === "now";
      if (started) driveRun(next.id);
      return { ok: true, runId: next.id, started: started };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg && msg.type === "cum-wf-retrigger" && msg.runId) {
    (async () => {
      const run = await readRun(msg.runId);
      if (!run) return { ok: false, error: "run not found" };
      if (!W.canRetrigger(run))
        return { ok: false, error: "this run has already started — pause it instead" };
      const t = msg.trigger || {};
      if (t.type === "time" && !(typeof t.at === "number" && t.at > Date.now()))
        return { ok: false, error: "pick a time in the future" };
      if (t.type === "now") {
        const blocked = await caseNumberBlock(run, W.runSource(run, null));
        if (blocked) return { ok: false, error: blocked };
      }
      const next = await saveRun(W.retrigger(run, t, Date.now()));
      await reschedule();
      if (next.trigger.type === "now") driveRun(next.id); // long-running: don't await
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // Pause at the next step boundary. The page driving the current step lets go
  // on its next poll, keeping the run's place — so an edit can be made and
  // Resume picks up from exactly there.
  if (msg && msg.type === "cum-wf-pause" && msg.runId) {
    (async () => {
      const run = await readRun(msg.runId);
      if (!run) return { ok: false, error: "run not found" };
      await saveRun(W.markPaused(run, Date.now()));
      // Every chat this run is using, not only the one Pause was pressed in.
      // The pages driving a step see the pause in storage and stop their own
      // answer; this covers the rest of the run's window — a tab whose step has
      // already handed back but whose reply is still being written, and a tab
      // the worker was about to give a step to.
      stopGeneratingIn(run);
      await reschedule();
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // Push on through an outage. Not a resume — the run may be perfectly happy —
  // it is the answer to "this outage doesn't touch what I'm doing". Sticky for
  // the rest of the run, since being asked again every twenty seconds would be
  // its own kind of hold.
  if (msg && msg.type === "cum-wf-ignore-outage" && msg.runId) {
    (async () => {
      const run = await readRun(msg.runId);
      if (!run) return { ok: false, error: "run not found" };
      const going = Object.assign({}, run, {
        ignoreOutage: true,
        note: "carrying on through the outage — you said it doesn't affect this",
      });
      // A run parked BY the outage goes back to running; one that was merely
      // told in advance keeps whatever it was doing.
      await saveRun(
        going.status === "waiting"
          ? Object.assign({}, W.reviseRun(going, { stepIndex: going.stepIndex, phase: going.phase }, Date.now()), {
              note: going.note,
            })
          : going
      );
      await reschedule();
      if (run.status === "waiting") driveRun(run.id);
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // Stop a usage pause lifting itself. Not a cancel and not a resume — the run
  // stays exactly where it is, and waits for you instead of for the meter.
  if (msg && msg.type === "cum-wf-hold-usage" && msg.runId) {
    (async () => {
      const run = await readRun(msg.runId);
      if (!run) return { ok: false, error: "run not found" };
      await saveRun(
        Object.assign({}, W.holdPaused(run), {
          note: "paused at step " + (run.stepIndex + 1) + " — waiting for you, not for usage",
        })
      );
      await reschedule();
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // Edit a run in progress — insert a step, fix a prompt, add this matter's
  // extra papers. It edits the RUN's own copy, never the template it came from.
  // The run editor's Save — and, when it asks for one, the START, in the SAME
  // message. It used to be two: save, then a second message from the page to
  // arm the run. Two messages to a service worker that is allowed to die
  // between them is a run that saves and then silently never goes, which is
  // the exact failure the editor's Run-now default exists to prevent. One
  // message, one handler, and the answer says whether it actually started.
  if (msg && msg.type === "cum-wf-edit-run" && msg.runId) {
    (async () => {
      const run = await readRun(msg.runId);
      if (!run) return { ok: false, error: "run not found" };
      if (run.status === "running")
        return { ok: false, error: "pause the run before editing it" };
      const now = Date.now();
      const saved = await saveRun(W.applyRunEdit(run, msg.patch || {}, now));
      const t = msg.trigger;
      // Saved, and nothing else asked for.
      if (!t || !t.type) return { ok: true, started: false };
      // The edit is already stored either way: everything below can only fail
      // to START it, and says so rather than reporting the save as failed.
      if (!W.canRetrigger(saved))
        return { ok: true, started: false, why: "it has already started — Pause is the tool now" };
      if (t.type === "time" && !(typeof t.at === "number" && t.at > now))
        return { ok: true, started: false, why: "that time has already passed" };
      if (t.type === "now") {
        const blocked = await caseNumberBlock(saved, W.runSource(saved, null));
        if (blocked) return { ok: true, started: false, why: blocked };
      }
      const next = await saveRun(W.retrigger(saved, t, now));
      await reschedule();
      if (next.trigger.type === "now") driveRun(next.id); // long-running: don't await
      return { ok: true, started: next.trigger.type !== "draft", trigger: next.trigger.type };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // Re-key a CASE from wherever the change was made: the run the given
  // conversation belongs to (or the named run), every member of its group —
  // a group is one case, one key — and any chat-level attachment shadowing
  // one of those conversations. Unlike an edit, this is allowed while a run
  // is RUNNING: the key is display-side only, and mid-run is precisely when
  // someone updates it from a chat.
  if (msg && msg.type === "cum-pseudo-rekey") {
    (async () => {
      const [runs, res] = await Promise.all([
        readRuns(),
        get(["cum_run_groups", "cum_pseudo_chats"]),
      ]);
      const plan = W.rekeyPlan(runs, res.cum_run_groups || [], {
        conv: msg.conv,
        runId: msg.runId,
      });
      for (const id of plan.runIds) {
        // Fresh read per run, so a concurrent write from the runner is never
        // clobbered by a stale copy.
        const run = await readRun(id);
        if (run) await saveRun(Object.assign({}, run, { pseudoKeyId: msg.keyId || null }));
      }
      const chats = res.cum_pseudo_chats || {};
      let dirty = false;
      for (const conv of plan.convs) {
        if (!(conv in chats)) continue; // a run-owned chat needs no entry of its own
        if (msg.keyId) {
          if (chats[conv] !== msg.keyId) {
            chats[conv] = msg.keyId;
            dirty = true;
          }
        } else {
          delete chats[conv];
          dirty = true;
        }
      }
      if (dirty) await set({ cum_pseudo_chats: chats });
      return { ok: true, runs: plan.runIds.length };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // Stop a run where it is. The page driving the current step notices on its
  // next poll and lets go; whatever Claude has already been sent stays sent.
  if (msg && msg.type === "cum-wf-cancel" && msg.runId) {
    (async () => {
      const run = await readRun(msg.runId);
      if (!run) return { ok: false, error: "run not found" };
      await saveRun(W.markCanceled(run, Date.now()));
      stopGeneratingIn(run); // the same reasoning as Pause, and more so
      await reschedule();
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // Move to a step of a run, wherever it happened. The workflow index asks;
  // this owns the tabs, so it does the moving: find the conversation that step
  // ran in, bring it forward, and tell it which message to scroll to.
  //
  // This DOES focus a window, unlike everything else a run touches. You clicked
  // a step in order to go and read it; leaving you where you were would be the
  // bug.
  if (msg && msg.type === "cum-wf-goto" && msg.runId) {
    (async () => {
      const run = await readRun(msg.runId);
      if (!run) return { ok: false, error: "that run is gone" };
      const wf = W.getWorkflow((await get(WORKFLOWS_KEY))[WORKFLOWS_KEY] || [], run.workflowId);
      const step = W.runDirectory(run, wf).find((s) => s.index === msg.stepIndex);
      if (!step) return { ok: false, error: "no such step" };
      if (!step.url) return { ok: false, error: "that chat hasn't been opened yet" };

      let tab = null;
      try {
        const all = await chrome.tabs.query({});
        tab = all.find((t) => t && t.url && J.sameConversationUrl(t.url, step.url)) || null;
      } catch (e) {
        /* fall through to opening one */
      }
      if (!tab) {
        // Closed since the run used it. A run still going gets its conversation
        // back in its OWN window, where the rest of them are. A finished one
        // has no window to keep together any more — reading it back is
        // ordinary browsing, so it opens beside whatever you're reading it
        // from.
        if (W.isRunActive(run)) {
          const opened = await runTab(run, step.url, true);
          tab = opened.tab;
        } else {
          try {
            tab = await chrome.tabs.create({
              url: step.url,
              active: true,
              windowId: (sender && sender.tab && sender.tab.windowId) || undefined,
            });
          } catch (e) {
            tab = null;
          }
        }
        if (!tab) return { ok: false, error: "couldn't open that conversation" };
        try {
          await waitTabComplete(tab.id, 20000);
        } catch (e) {
          /* it can still be told where to go */
        }
      }
      try {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      } catch (e) {
        /* a tab that vanished between finding it and moving to it */
      }
      // Where to scroll, once it is looking at the right conversation. Sent a
      // few times: a tab that has only just been opened has no content script
      // listening yet, and the page it will render doesn't exist either.
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const res = await chrome.tabs.sendMessage(tab.id, {
            type: "cum-goto-step",
            runId: msg.runId,
            stepIndex: step.index,
            prompt: step.prompt,
          });
          if (res && res.ok) break;
        } catch (e) {
          /* not ready yet */
        }
        await sleep(700);
      }
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // A page borrowing this worker's clock. Chrome throttles timers in a tab that
  // isn't on screen — about one wake-up a minute — and a run's tabs are behind
  // whatever you're doing by design, so a page that waited on its own clock
  // waited minutes for fractions of a second. The worker is not a page and is
  // not throttled. Capped, and the page races this against its own timer, so
  // the worst case is the throttled wait it would have had anyway.
  if (msg && msg.type === "cum-wait") {
    const ms = Math.max(0, Math.min(25000, Math.floor(msg.ms) || 0));
    setTimeout(() => {
      try {
        sendResponse({ ok: true });
      } catch (e) {
        /* the page went away mid-wait */
      }
    }, ms);
    return true;
  }
  // Carry a stopped run on. With no patch it picks up exactly where it stopped
  // — including waiting for a reply to a message that already went out, rather
  // than posting it twice. With a patch, the operator has said where to resume
  // from, what text to carry in, and which conversation each chat is in.
  if (msg && msg.type === "cum-wf-resume" && msg.runId) {
    (async () => {
      const run = await readRun(msg.runId);
      if (!run) return { ok: false, error: "run not found" };
      const patch = msg.patch || {
        stepIndex: run.stepIndex,
        phase: run.phase === "awaiting-reply" ? "awaiting-reply" : "idle",
      };
      let revised = W.reviseRun(run, patch, Date.now());
      let note = null;
      // Anything a wave had already collected from the step being restarted on
      // is thrown away. Told to do this step again, "again" has to mean the
      // whole of it — otherwise two of the three chats would quietly keep the
      // replies you just decided were worth redoing. Members before the resume
      // point are past and their keys were cleared when their wave landed.
      // …unless you've said the messages already went out, which is the one
      // case where those records are the thing keeping the run from posting the
      // same prompts into three conversations a second time.
      if (patch.phase !== "awaiting-reply")
        await clearMembers(
          msg.runId,
          Array.from({ length: (run.totalSteps || 0) + 1 }, (_, i) => i).filter(
            (i) => i >= revised.stepIndex
          )
        );
      // Re-read the hand-off from the previous chat before starting, so the
      // resumed step carries what's actually in that conversation now — not
      // whatever this run last managed to capture.
      if (patch.refetchCarry) {
        const wf = W.getWorkflow((await get(WORKFLOWS_KEY))[WORKFLOWS_KEY] || [], run.workflowId);
        if (!wf) return { ok: false, error: "its workflow was deleted" };
        await saveRun(revised); // so the harvest can heartbeat against it
        const got = await refetchCarry(revised, wf);
        if (!got.ok) {
          // A harvest the operator canceled mid-way is a decision, not a
          // failure: the cancel has already written the run's own status, and
          // stamping "error: canceled" over it is how a stopped run reads as
          // a broken one.
          if (!/^canceled$/i.test(got.error || ""))
            await saveRun(W.markError(revised, got.error, Date.now()));
          return { ok: false, error: got.error };
        }
        if (!got.skipped) {
          revised = Object.assign({}, revised, { lastReply: got.text });
          note = "carried " + got.chars + " chars re-read from " + got.from;
        }
      }
      await saveRun(note ? Object.assign({}, revised, { note }) : revised);
      driveRun(msg.runId, { force: true }); // long-running: don't await
      return { ok: true, note };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // Bring a run's chats up: focus its window if it still has one, and reopen
  // the conversations if it doesn't. This is the one place a run's window is
  // deliberately given focus — you asked for it.
  if (msg && msg.type === "cum-wf-show-chats" && msg.runId) {
    (async () => {
      const run = await readRun(msg.runId);
      if (!run) return { ok: false, error: "run not found" };
      const wf = W.getWorkflow((await get(WORKFLOWS_KEY))[WORKFLOWS_KEY] || [], run.workflowId);
      const src = W.runSource(run, wf);
      const recorded = run.chats || {};
      // Take the conversations in the run's own order first, then anything else
      // it recorded. That second part matters: a run made before runs carried
      // their own chats falls back to the workflow's, and if the workflow has
      // since been edited those ids no longer match — the conversation is still
      // in the run, and would otherwise be silently skipped.
      const named = (src.chats || []).map((c) => ({
        name: c.name,
        url: (recorded[c.id] || {}).url || null,
      }));
      const seenIds = new Set((src.chats || []).map((c) => c.id));
      const orphaned = Object.keys(recorded)
        .filter((id) => !seenIds.has(id))
        .map((id) => ({ name: "a chat this run recorded", url: (recorded[id] || {}).url || null }));

      const urls = [];
      for (const c of named.concat(orphaned)) {
        if (c.url && urls.indexOf(c.url) === -1) urls.push(c.url);
      }
      // Chats the run never got as far as opening — worth saying, since the
      // alternative is opening one of two and looking like it worked.
      const missing = named.filter((c) => !c.url).map((c) => c.name);
      if (!urls.length)
        return { ok: false, error: "this run hasn't opened any conversations yet" };

      const id = typeof run.windowId === "number" ? run.windowId : null;
      if (id != null && (await windowExists(id))) {
        // Still there — add back any chat whose tab was closed, then raise it.
        const tabs = await tabsInWindow(id);
        for (const u of urls) {
          if (tabs.some((t) => t && t.url && J.sameConversationUrl(t.url, u))) continue;
          try {
            await chrome.tabs.create({ url: u, windowId: id, active: false });
          } catch (e) {
            /* ignore */
          }
        }
        try {
          await chrome.windows.update(id, { focused: true });
        } catch (e) {
          /* ignore */
        }
        await ensureWindowSize(id);
        // Reopened and already-open alike: the run's chats sit in its group.
        await groupRunChats(run, id);
        return { ok: true, focused: true, opened: urls.length, missing };
      }

      // Gone entirely — open all of its conversations in a fresh window, and
      // let the run adopt it so later steps go there too.
      try {
        const win = await chrome.windows.create({ url: urls, focused: true });
        if (win && win.id != null) {
          await saveRun(W.withWindow(await readRun(msg.runId), win.id));
          await sleep(300);
          await ensureWindowSize(win.id);
          await ensureOptionsTab(win.id);
          await groupRunChats(run, win.id);
        }
        return { ok: true, opened: urls.length, missing };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // Close a finished run's window — its chats have been read and the window is
  // just taking up space now.
  if (msg && msg.type === "cum-wf-close-window" && msg.runId) {
    (async () => {
      const run = await readRun(msg.runId);
      if (!run) return { ok: false, error: "run not found" };
      if (typeof run.windowId !== "number") return { ok: false, error: "no window to close" };
      // Only a window the run OPENED. Borrowing one and then closing it would
      // take everything else in it with it — the tabs you were working in are
      // not this run's to tidy away.
      if (!run.newWindow)
        return { ok: false, error: "this run used your own window, so there is nothing of its own to close" };
      try {
        await chrome.windows.remove(run.windowId);
      } catch (e) {
        /* already gone */
      }
      await saveRun(W.withWindow(await readRun(msg.runId), null));
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // What's already in your Downloads folder, by name.
  //
  // Asked for by the auto-downloader's catch-up mode, which saves files from
  // further up a conversation than the live rule allows and so needs a real
  // answer to "do I already have this?". Only the content script can see the
  // cards; only the worker can see the history — chrome.downloads is not
  // exposed to content scripts at all.
  //
  // Names only, and only the recent ones. A path would tell the page where your
  // files live, which is nothing to do with clicking a download button.
  // The newest download, by start time. Not for the ledger — for telling a save
  // that HAPPENED from a click that merely went out. The saver used to announce
  // a file the instant it pressed something, which is a claim it was in no
  // position to make: the control it pressed may have opened a menu it then
  // failed to find a Download in, and the toast said "Saved" all the same.
  if (msg && msg.type === "cum-dl-newest") {
    try {
      // The recent few rather than only the newest. One file's check used to
      // read "is the newest download newer than my press", which cannot tell
      // two files saved seconds apart from each other — each check could see
      // the other's file and claim it. A short list lets the asker match on the
      // NAME it pressed for (src/autodl.js, arrivalOf).
      chrome.downloads.search({ limit: 10, orderBy: ["-startTime"] }, (items) => {
        void chrome.runtime.lastError;
        const list = [];
        for (const it of items || []) {
          const full = (it && it.filename) || "";
          if (!full) continue;
          const at = it.startTime ? Date.parse(it.startTime) : 0;
          const cut = Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\"));
          list.push({ name: full.slice(cut + 1), at: isFinite(at) ? at : 0 });
        }
        const top = list[0] || { name: "", at: 0 };
        sendResponse({ ok: true, at: top.at, name: top.name, items: list });
      });
    } catch (e) {
      // Unknown is not "nothing arrived": the saver treats an unanswered
      // question as unverifiable and says so, rather than as a failure.
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }
  if (msg && msg.type === "cum-dl-history") {
    try {
      chrome.downloads.search(
        { limit: 400, orderBy: ["-startTime"] },
        (items) => {
          void chrome.runtime.lastError;
          const names = [];
          for (const it of items || []) {
            const full = (it && (it.filename || "")) || "";
            if (!full) continue;
            const cut = Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\"));
            names.push(full.slice(cut + 1));
          }
          sendResponse({ ok: true, names: names });
        }
      );
    } catch (e) {
      // No permission, or a browser without the API: say so rather than send an
      // empty list, which would read as "you have none of these".
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }
  // Usage-pace warnings. Every open tab reports its reading; the DECISION is
  // made here, once, because the fired-state has to be shared — three claude.ai
  // tabs crossing 75% together is one notification, not three. The reply tells
  // the asking tab what (if anything) fired, so it can flash its pill.
  //
  // One at a time, through warnQueue. Read-modify-write against storage is what
  // makes this decision, and two tabs reporting at the same moment would both
  // read the state before either wrote it — which is the exact duplicate this
  // handler exists to prevent, arriving by the back door.
  if (msg && msg.type === "cum-usage-warn") {
    warnQueue = warnQueue.then(() => usageWarnFor(msg.reading)).catch(() => []);
    warnQueue.then((fire) => sendResponse({ fire: fire || [] }));
    return true;
  }
  // The pill, popup and options page all read cum_status from storage; this is
  // how they ask for a fresh one (on load, or on demand).
  if (msg && msg.type === "cum-status") {
    (async () => {
      const cached = await readStatus();
      if (msg.force || S.isDuePoll(cached, Date.now(), STATUS_POLL_MIN * 60 * 1000)) {
        return await refreshStatus();
      }
      return cached;
    })()
      .then((snap) => sendResponse({ status: snap }))
      .catch((e) => sendResponse({ status: S.unknown(String(e), Date.now()) }));
    return true;
  }
});

// ==== Wiring =============================================================
function ensureKeepalive() {
  try {
    chrome.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 });
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(() => {
  ensureKeepalive();
  acBurst();
  seedWorkflows();
  migrateRuns().then(migrateSettings).then(reschedule);
  refreshStatus();
  sweepGhosts();
});
chrome.runtime.onStartup.addListener(() => {
  ensureKeepalive();
  acBurst();
  seedWorkflows();
  migrateSettings();
  reschedule();
  runJobs("time"); // catch anything whose time passed while the browser was off
  startRuns("time");
  // ...and a run whose window reopened while the browser was closed, which is
  // the ordinary case for one that ran out overnight.
  resumeUsageRuns();
  resumeClockRuns(); // ...and a pause that expired while the browser was closed
  sweepGhosts(); // a browser left closed for a week must not preserve them
  // ...and anything an outage parked before the browser closed. The stored
  // reading is hours old by now, so this always fetches.
  refreshStatusIfStale().then(() => {
    runJobs("hold");
    startRuns("hold");
  });
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEPALIVE) {
    acBurst();
    // The keepalive is also the workflow watchdog: a run left between steps by a
    // worker that died mid-await gets picked up here, within 30 seconds.
    startRuns("pickup");
    // And the backstop for a usage pause, for the case where no meter reading
    // arrives to prompt one — a tab left on a page that isn't asking.
    resumeUsageRuns();
    // ...and for a timed pause whose alarm was lost to a browser restart.
    resumeClockRuns();
  } else if (a.name === TIME_ALARM) {
    runJobs("time");
    startRuns("time");
    resumeClockRuns();
  } else if (a.name === RESET_ALARM) {
    runJobs("reset");
    startRuns("reset");
    resumeUsageRuns();
  } else if (a.name === STATUS_ALARM) {
    // Always retry held jobs after a refresh — the gate itself decides whether
    // things have recovered, so this needs no separate recovery check.
    // Piggy-backed on the status poll rather than given an alarm of its own:
    // creating an alarm resets its countdown, and this worker restarts every
    // thirty seconds, so an alarm slower than that would never fire at all.
    sweepGhosts();
    refreshStatus().then(() => {
      runJobs("hold");
      startRuns("hold");
    });
  }
});

// ---- the master key ------------------------------------------------------
//
// The last 20 cases, distilled to what a chat TITLE needs, so Recents reads
// back in the real case names without every case's spreadsheet having to be
// sitting in the library. Kept up to date from the library's own storage
// writes: the popup, the run editor and the Folder button all load keys, and
// hanging this off the write they share means there is one copy of it and a
// fourth loader would be covered the day it is written.
//
// Never removes a case. A key leaving the library is the point at which the
// master key starts earning its keep — that is a case whose spreadsheet is
// gone and whose chats would otherwise go back to reading as fakes. Emptying
// it is the popup's own control, and the only way it happens.
let masterBusy = false;
async function refreshMasterKey() {
  const M = self.CUMMasterKey;
  if (!M || masterBusy) return;
  masterBusy = true;
  try {
    const res = await get([PSEUDO_KEYS_KEY, MASTER_KEY]);
    const got = M.rebuild(res[MASTER_KEY], res[PSEUDO_KEYS_KEY] || {});
    // Written only when it CHANGED: this runs off a storage write, and writing
    // back unconditionally would be a storage event answering a storage event.
    if (!got.added && !got.refreshed) return;
    await set({ [MASTER_KEY]: got.master });
  } catch (e) {
    /* the next key load tries again; nothing here is load-bearing for a send */
  } finally {
    masterBusy = false;
  }
}

// ---- attachments that were never a conversation --------------------------
//
// A key is attached per CONVERSATION, and the identity used to be whatever
// conversationKeyFromUrl made of the address — which for a page that is not a
// conversation is its path. So a key attached from "/new", "/cowork" or
// "/recents" was filed under that page, and every page of that shape from then
// on came up wearing it: the last matter's names over the next one's blank
// composer.
//
// Nothing can write one of those any more (P.conversationFromUrl decides it
// now, at both attach controls). This is for the ones already stored, since a
// rule that only stops new mistakes leaves the operator with the old one and
// no idea what to detach.
async function sweepChatKeys() {
  const P = self.CUMPseudo;
  if (!P || !P.isConversationKey) return;
  try {
    const res = await get(PSEUDO_CHATS_KEY);
    const chats = res[PSEUDO_CHATS_KEY];
    if (!chats || typeof chats !== "object") return;
    let dropped = 0;
    const kept = {};
    for (const conv of Object.keys(chats)) {
      if (P.isConversationKey(conv)) kept[conv] = chats[conv];
      else dropped++;
    }
    if (dropped) await set({ [PSEUDO_CHATS_KEY]: kept });
  } catch (e) {
    /* the next start tries again; nothing here is load-bearing for a send */
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[PSEUDO_KEYS_KEY]) refreshMasterKey();
  if (changes[CFG_KEY] || changes[DL_CFG_KEY]) {
    ensureKeepalive();
    acBurst();
  }
  // Heartbeat keys change constantly and change nothing about scheduling, so
  // they're deliberately not a trigger.
  const runChanged = Object.keys(changes).some(
    (k) => k === W.RUN_IDS_KEY || (k.indexOf(W.RUN_PREFIX) === 0 && k.indexOf(W.BEAT_PREFIX) !== 0)
  );
  if (changes[JOBS_KEY] || changes[STATE_KEY] || runChanged) reschedule();
  // The meter is the authority on whether usage is back, so every reading is a
  // chance to lift a usage pause — sooner and more reliably than the alarm,
  // which can only ever fire at the time the meter last predicted.
  if (changes[STATE_KEY]) resumeUsageRuns();
  // Turning the gate off should release anything it is holding right now.
  if (changes[STATUS_CFG_KEY]) {
    statusCfg().then((cfg) => {
      if (!cfg.holdSends) {
        runJobs("hold");
        startRuns("hold");
      }
    });
  }
});

ensureKeepalive();
seedWorkflows();
// A key can be loaded while this worker is asleep — the listener above only
// hears the writes it is awake for — so the library is folded in on every
// start as well. It writes nothing when nothing changed.
refreshMasterKey();
sweepChatKeys();
migrateRuns().then(migrateSettings).then(reschedule);
reschedule();
ensureStatusAlarm(null);
refreshStatusIfStale();
