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
 *
 * MV3 workers are short-lived, so a chrome.alarm keeps things ticking.
 */
importScripts("jobstore.js", "status.js"); // provides self.CUMJobs, self.CUMStatus

const CFG_KEY = "cum_autocontinue";
const JOBS_KEY = "cum_jobs";
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

const J = self.CUMJobs;
const S = self.CUMStatus;

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
    want = !!(snap && snap.ok && snap.blocking) || J.hasHeldJobs(jobs);
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

// (Re)create alarms for the next time trigger and the reset trigger.
async function reschedule() {
  const { [JOBS_KEY]: jobs, [STATE_KEY]: state } = await get([JOBS_KEY, STATE_KEY]);
  const list = jobs || [];

  const nextTime = J.nextTimeTrigger(list, Date.now());
  try {
    chrome.alarms.clear(TIME_ALARM);
    if (nextTime != null) {
      chrome.alarms.create(TIME_ALARM, { when: Math.max(Date.now() + 1000, nextTime) });
    }
  } catch (e) {}

  try {
    chrome.alarms.clear(RESET_ALARM);
    const resetAt = state && state.resetAt;
    if (J.hasPendingResetJobs(list) && typeof resetAt === "number" && resetAt > Date.now()) {
      // Fire shortly after the window resets so fresh usage is available.
      chrome.alarms.create(RESET_ALARM, { when: resetAt + 5000 });
    }
  } catch (e) {}

  // A held job wants the fast status cadence; nothing held drops back to slow.
  await ensureStatusAlarm(null);
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
  reschedule();
  refreshStatus();
});
chrome.runtime.onStartup.addListener(() => {
  ensureKeepalive();
  acBurst();
  reschedule();
  runJobs("time"); // catch anything whose time passed while the browser was off
  // ...and anything an outage parked before the browser closed. The stored
  // reading is hours old by now, so this always fetches.
  refreshStatusIfStale().then(() => runJobs("hold"));
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEPALIVE) acBurst();
  else if (a.name === TIME_ALARM) runJobs("time");
  else if (a.name === RESET_ALARM) runJobs("reset");
  else if (a.name === STATUS_ALARM) {
    // Always retry held jobs after a refresh — the gate itself decides whether
    // things have recovered, so this needs no separate recovery check.
    refreshStatus().then(() => runJobs("hold"));
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[CFG_KEY]) {
    ensureKeepalive();
    acBurst();
  }
  if (changes[JOBS_KEY] || changes[STATE_KEY]) reschedule();
  // Turning the gate off should release anything it is holding right now.
  if (changes[STATUS_CFG_KEY]) {
    statusCfg().then((cfg) => {
      if (!cfg.holdSends) runJobs("hold");
    });
  }
});

ensureKeepalive();
reschedule();
ensureStatusAlarm(null);
refreshStatusIfStale();
