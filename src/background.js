/**
 * Claude Usage Meter — background service worker.
 *
 * Its only job is to keep auto-continue working when a claude.ai tab is in the
 * background or minimized (where the content script's own setInterval gets
 * throttled). It periodically messages every claude.ai tab with "cum-ac-poll",
 * which triggers an immediate Continue-button check in that tab.
 *
 * MV3 service workers are short-lived, so a chrome.alarm wakes us every ~30s;
 * on each wake we "burst" — poll every few seconds for the alarm interval —
 * giving roughly continuous coverage. All of this is gated on the feature being
 * enabled so nothing runs when the user hasn't opted in.
 */
const CFG_KEY = "cum_autocontinue";
const KEEPALIVE = "cum-ac-keepalive";
const BURST_MS = 5000; // poll cadence during a burst
const BURST_COUNT = 6; // ~30s of polling per wake

function isEnabled() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(CFG_KEY, (res) => {
        resolve(!!(res && res[CFG_KEY] && res[CFG_KEY].enabled));
      });
    } catch (e) {
      resolve(false);
    }
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
          /* no receiver in that tab — ignore */
        }
      }
    });
  } catch (e) {
    /* ignore */
  }
}

async function burst() {
  if (!(await isEnabled())) return;
  pollTabs();
  let n = 1;
  const id = setInterval(async () => {
    if (n++ >= BURST_COUNT || !(await isEnabled())) {
      clearInterval(id);
      return;
    }
    pollTabs();
  }, BURST_MS);
}

function ensureAlarm() {
  try {
    chrome.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 });
  } catch (e) {
    /* ignore */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  burst();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  burst();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEPALIVE) burst();
});
// Kick a burst immediately when the user flips the toggle on.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CFG_KEY]) {
    ensureAlarm();
    burst();
  }
});

ensureAlarm();
