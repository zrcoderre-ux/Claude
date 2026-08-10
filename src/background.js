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
// self.CUMJobs / CUMStatus / CUMWorkflow / CUMWfUsage
importScripts("jobstore.js", "status.js", "workflow.js", "wfusage.js", "incognito.js");

const CFG_KEY = "cum_autocontinue";
const JOBS_KEY = "cum_jobs";
const WORKFLOWS_KEY = "cum_workflows";
const RUNS_KEY = "cum_wf_runs";
const WF_SEEDED_KEY = "cum_wf_seeded";
const WF_USAGE_KEY = "cum_wf_usage"; // workflow-attributed usage, by date
const STATE_KEY = "cum_state";
const STATUS_KEY = "cum_status"; // last status.claude.com snapshot
const STATUS_CFG_KEY = "cum_status_cfg"; // { warn, holdSends } — both default on
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

// ==== Auto-continue keepalive ===========================================
// Any of the auto-clickers being on is reason to keep nudging: a backgrounded
// tab's own timers throttle, and the Allow-once clicker has its own toggle
// independent of Continue's.
function acEnabled() {
  return new Promise((resolve) => {
    get(CFG_KEY).then((r) => {
      const c = r[CFG_KEY] || {};
      resolve(!!(c.enabled || c.allowOnce));
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

async function statusCfg() {
  const c = (await get(STATUS_CFG_KEY))[STATUS_CFG_KEY] || {};
  return { warn: c.warn !== false, holdSends: c.holdSends !== false };
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
  return S.holdDecision(await statusForGate(), {
    enabled: true,
    heldSince: typeof job.heldSince === "number" ? job.heldSince : null,
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
      await sleep(3000);
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

  const times = [J.nextTimeTrigger(list, Date.now()), W.nextRunTrigger(runs, Date.now())].filter(
    (t) => typeof t === "number"
  );
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
    if (wantsReset && typeof resetAt === "number" && resetAt > Date.now()) {
      // Fire shortly after the window resets so fresh usage is available.
      chrome.alarms.create(RESET_ALARM, { when: resetAt + 5000 });
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

// A tab showing `url` inside this run's own window. Deliberately scoped to that
// window: a conversation the operator happens to have open elsewhere is theirs,
// and driving a message into the tab they're reading would be a nasty surprise.
async function runTab(run, url) {
  let windowId = typeof run.windowId === "number" ? run.windowId : null;
  if (windowId != null && !(await windowExists(windowId))) windowId = null;

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
    if (t && t.url && J.sameConversationUrl(t.url, url)) return { tab: t, windowId, created: false };
  }
  try {
    const tab = await chrome.tabs.create({ url, windowId, active: false });
    return { tab, windowId, created: true };
  } catch (e) {
    return { tab: null, windowId };
  }
}

// The tab a step should run in: the chat's existing conversation if it has one
// (that's the whole point — chat A comes back to its own thread), otherwise a
// fresh composer at the chat's configured destination. Always inside the run's
// own window.
async function stepTab(run, savedUrl, chat) {
  const url =
    savedUrl ||
    J.targetUrl({
      projectHref: (chat.target && chat.target.projectHref) || null,
      projectUuid: (chat.target && chat.target.projectUuid) || null,
      codeRepo: (chat.target && chat.target.codeRepo) || null,
    });
  const { tab, windowId, created } = await runTab(run, url);
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
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, payload);
      if (res) return res;
    } catch (e) {
      /* content script maybe not ready yet */
    }
    await sleep(1500);
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
      await sleep(3000);
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
    firstInChat: m.firstInChat && !saved.url,
    download: !!run.downloadFiles,
    title:
      run.nameChats !== false && m.firstInChat && !saved.url
        ? W.chatTitle(run, m.chatName)
        : null,
    codeRepo: m.firstInChat && !saved.url ? (chat.target && chat.target.codeRepo) || null : null,
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
      await sleep(3000);
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
      const plan = W.planRun(src);
      const step = plan[run.stepIndex];
      if (!step) {
        await saveRun(
          Object.assign({}, run, { status: "done", phase: "idle", finishedAt: Date.now() })
        );
        return;
      }

      // Same gate as a scheduled send: a run driven through the real UI has
      // nothing to fall back on if Claude is down, so it waits — with the same
      // 6-hour ceiling, and Run now still overrides it.
      const gate = await outageGate(run, opts);
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
      // pause rather than hold, because a run that resumed itself at reset
      // would start a nine-step afternoon while nobody was watching.
      const meter = (await get(STATE_KEY))[STATE_KEY];
      if (W.usageExhausted(meter)) {
        const back = W.usageBackAt(meter);
        await saveRun(
          Object.assign({}, W.markPaused(run, Date.now()), {
            note:
              "paused before step " + (run.stepIndex + 1) + " — your Claude usage has run out" +
              (back ? ", back at " + new Date(back).toLocaleTimeString() : "") +
              ". Resume when it has.",
          })
        );
        notify(
          "Workflow paused",
          W.runLabel(run).title + " — out of usage before step " + (run.stepIndex + 1) +
            (back ? ". Usage returns at " + new Date(back).toLocaleTimeString() : "") + "."
        );
        return;
      }

      const heldNote = gate.expired
        ? "step " + (run.stepIndex + 1) + " sent after waiting " + S.fmtWaited(gate.waitedMs)
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

      const payload = {
        type: "cum-wf-step",
        runId: runId,
        stepIndex: run.stepIndex,
        chatId: step.chatId,
        chatName: step.chatName,
        total: plan.length,
        awaitOnly: awaitOnly,
        // Only set when this step's reply gets pasted into another chat: the
        // phrase that reply must contain before it's allowed to travel.
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
        // `!saved.url` is the test for that: a chat the run was pointed at
        // already had a link, and retitling a conversation you started yourself
        // is not the extension's business.
        firstInChat: step.firstInChat && !saved.url,
        // Save what the reply offers. Off unless the workflow asks: it writes
        // to your disk, which is not a run's decision to make.
        download: !!run.downloadFiles,
        title:
          run.nameChats !== false && step.firstInChat && !saved.url
            ? W.chatTitle(run, step.chatName)
            : null,
        codeRepo: step.firstInChat && !saved.url ? (chat.target && chat.target.codeRepo) || null : null,
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
      await saveRun(next);
      await reschedule();
      return { ok: true, runId: next.id };
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
      await reschedule();
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // Edit a run in progress — insert a step, fix a prompt, add this matter's
  // extra papers. It edits the RUN's own copy, never the template it came from.
  if (msg && msg.type === "cum-wf-edit-run" && msg.runId) {
    (async () => {
      const run = await readRun(msg.runId);
      if (!run) return { ok: false, error: "run not found" };
      if (run.status === "running")
        return { ok: false, error: "pause the run before editing it" };
      await saveRun(W.applyRunEdit(run, msg.patch || {}, Date.now()));
      return { ok: true };
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
          const opened = await runTab(run, step.url);
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
  migrateRuns().then(reschedule);
  refreshStatus();
  sweepGhosts();
});
chrome.runtime.onStartup.addListener(() => {
  ensureKeepalive();
  acBurst();
  seedWorkflows();
  reschedule();
  runJobs("time"); // catch anything whose time passed while the browser was off
  startRuns("time");
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
  } else if (a.name === TIME_ALARM) {
    runJobs("time");
    startRuns("time");
  } else if (a.name === RESET_ALARM) {
    runJobs("reset");
    startRuns("reset");
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[CFG_KEY]) {
    ensureKeepalive();
    acBurst();
  }
  // Heartbeat keys change constantly and change nothing about scheduling, so
  // they're deliberately not a trigger.
  const runChanged = Object.keys(changes).some(
    (k) => k === W.RUN_IDS_KEY || (k.indexOf(W.RUN_PREFIX) === 0 && k.indexOf(W.BEAT_PREFIX) !== 0)
  );
  if (changes[JOBS_KEY] || changes[STATE_KEY] || runChanged) reschedule();
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
migrateRuns().then(reschedule);
reschedule();
ensureStatusAlarm(null);
refreshStatusIfStale();
