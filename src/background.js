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

async function executeJob(job) {
  await updateJob(job.id, { status: "running", firedAt: Date.now(), error: null });
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
    await updateJob(job.id, { status: "done", note: res.note || null });
    await deleteJobFiles(job);
    const base = job.name || "Your scheduled message was sent.";
    notify("Sent to Claude", res.note ? base + " (" + res.note + ")" : base);
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

  // Wait for the harvested list to arrive/grow, up to ~15s.
  let projects = before;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const now = await readProjects();
    if (now.length > projects.length) projects = now;
    if (now.length > before.length) break;
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
