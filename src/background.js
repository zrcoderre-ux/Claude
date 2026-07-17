/**
 * Claude Usage Meter — background service worker.
 *
 * Two responsibilities:
 *   1. Auto-continue keepalive: nudge claude.ai tabs to click "Continue" even
 *      when backgrounded (content-script timers throttle there).
 *   2. Scheduled sends: fire queued jobs at their set time, or when the usage
 *      window resets, by opening a claude.ai composer tab and driving it.
 *
 * MV3 workers are short-lived, so a chrome.alarm keeps things ticking.
 */
importScripts("jobstore.js"); // provides self.CUMJobs

const CFG_KEY = "cum_autocontinue";
const JOBS_KEY = "cum_jobs";
const STATE_KEY = "cum_state";
const KEEPALIVE = "cum-ac-keepalive";
const TIME_ALARM = "cum-job-time";
const RESET_ALARM = "cum-job-reset";
const BURST_MS = 5000;
const BURST_COUNT = 6;

const J = self.CUMJobs;

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
function acEnabled() {
  return new Promise((resolve) => {
    get(CFG_KEY).then((r) => resolve(!!(r[CFG_KEY] && r[CFG_KEY].enabled)));
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

async function executeJob(job) {
  await updateJob(job.id, { status: "running", firedAt: Date.now(), error: null });
  const url = J.targetUrl(job);
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    await updateJob(job.id, { status: "error", error: "could not open tab" });
    notify("Scheduled send failed", "Could not open a claude.ai tab.");
    return;
  }
  await waitTabComplete(tab.id, 30000);
  await sleep(2500); // let the SPA composer render
  const res = await sendRun(tab.id, job.id);
  if (res && res.ok) {
    await updateJob(job.id, { status: "done" });
    await deleteJobFiles(job);
    notify("Sent to Claude", job.name || "Your scheduled message was sent.");
  } else {
    await updateJob(job.id, { status: "error", error: (res && res.error) || "unknown" });
    notify("Scheduled send failed", (res && res.error) || "See the extension options.");
  }
}

// Run any due jobs, one at a time (avoid opening many tabs at once).
async function runJobs(kind /* "time" | "reset" */) {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const { [JOBS_KEY]: jobs } = await get(JOBS_KEY);
    const list = jobs || [];
    const due =
      kind === "reset" ? J.pendingResetJobs(list) : J.dueTimeJobs(list, now);
    for (const job of due) {
      // Re-read to respect any cancellation between iterations.
      const fresh = J.getJob((await get(JOBS_KEY))[JOBS_KEY] || [], job.id);
      if (fresh && fresh.status === "pending") await executeJob(fresh);
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
}

// Open the projects page VISIBLY (claude.ai defers rendering in hidden tabs, so
// a background scrape returns nothing), scrape it, close it, and return focus
// to the tab that asked (the options page).
async function refreshProjects(returnTabId) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: "https://claude.ai/cowork/projects", active: true });
  } catch (e) {
    return { error: "could not open a claude.ai tab" };
  }
  await waitTabComplete(tab.id, 30000);
  await sleep(2500);
  let projects = [];
  for (let attempt = 0; attempt < 6 && !projects.length; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "cum-scrape-projects" });
      if (res && res.projects && res.projects.length) projects = res.projects;
    } catch (e) {
      /* content script not ready yet */
    }
    if (!projects.length) await sleep(1500);
  }
  try {
    chrome.tabs.remove(tab.id);
  } catch (e) {}
  if (returnTabId != null) {
    try {
      chrome.tabs.update(returnTabId, { active: true });
    } catch (e) {}
  }
  if (projects.length) await set({ cum_projects: projects });
  return { projects };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "cum-refresh-projects") {
    refreshProjects(sender && sender.tab && sender.tab.id)
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
        await executeJob(job);
      } finally {
        running = false;
      }
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
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
});
chrome.runtime.onStartup.addListener(() => {
  ensureKeepalive();
  acBurst();
  reschedule();
  runJobs("time"); // catch anything whose time passed while the browser was off
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEPALIVE) acBurst();
  else if (a.name === TIME_ALARM) runJobs("time");
  else if (a.name === RESET_ALARM) runJobs("reset");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[CFG_KEY]) {
    ensureKeepalive();
    acBurst();
  }
  if (changes[JOBS_KEY] || changes[STATE_KEY]) reschedule();
});

ensureKeepalive();
reschedule();
