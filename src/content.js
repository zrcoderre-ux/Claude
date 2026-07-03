/**
 * Claude Usage Meter — UI + state (ISOLATED world).
 *
 * Receives usage data harvested by inject.js (via window.postMessage),
 * persists the latest snapshot to chrome.storage.local, and renders a
 * floating button in the bottom-left corner showing:
 *   - current session usage (used / limit, or remaining), and
 *   - a live countdown to the next limit reset.
 */
(function () {
  "use strict";

  const CHANNEL = "CLAUDE_USAGE_METER";
  const STORAGE_KEY = "cum_state";
  const URL_KEY = "cum_usage_url"; // auto-learned URL that yielded usage data
  const MANUAL_URL_KEY = "cum_manual_url"; // user-pinned usage endpoint
  const POLL_MS = 5 * 60 * 1000; // refresh the baseline every 5 minutes

  /** @type {{resetAt:number|null, remaining:number|null, limit:number|null, used:number|null, updatedAt:number|null}} */
  let state = {
    resetAt: null,
    remaining: null,
    limit: null,
    used: null,
    updatedAt: null,
  };

  let learnedUrl = null;
  let manualUrl = null;
  let probing = false; // true while a proactive baseline fetch is in flight
  let els = null;
  let tickTimer = null;
  let pollTimer = null;
  let probeTimeout = null;

  // ---- Persistence -------------------------------------------------------
  function save() {
    try {
      chrome.storage?.local.set({ [STORAGE_KEY]: state });
    } catch (e) {
      /* ignore */
    }
  }

  function load() {
    return new Promise((resolve) => {
      try {
        // Optional chaining short-circuits to undefined when storage is
        // unavailable — guard explicitly so the promise always resolves and
        // the UI still builds (e.g. after an extension-context reload).
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get([STORAGE_KEY, URL_KEY, MANUAL_URL_KEY], (res) => {
            if (res && res[STORAGE_KEY]) {
              state = Object.assign(state, res[STORAGE_KEY]);
            }
            if (res && res[URL_KEY]) learnedUrl = res[URL_KEY];
            if (res && res[MANUAL_URL_KEY]) manualUrl = res[MANUAL_URL_KEY];
            resolve();
          });
        } else {
          resolve();
        }
      } catch (e) {
        resolve();
      }
    });
  }

  // Merge a fresh reading. We keep the most recently observed values; a reset
  // timestamp that has already elapsed is dropped.
  function applyReading(data) {
    let changed = false;
    if (data.resetAt != null && data.resetAt > Date.now()) {
      if (data.resetAt !== state.resetAt) {
        state.resetAt = data.resetAt;
        changed = true;
      }
    }
    if (data.limit != null && data.limit > 0 && data.limit !== state.limit) {
      state.limit = data.limit;
      changed = true;
    }
    if (data.remaining != null && data.remaining !== state.remaining) {
      state.remaining = data.remaining;
      changed = true;
    }
    if (data.used != null && data.used !== state.used) {
      state.used = data.used;
      changed = true;
    }
    // Derive whichever of used/remaining is missing when we know the limit.
    if (state.limit != null) {
      if (state.remaining != null && state.used == null) {
        state.used = Math.max(0, state.limit - state.remaining);
      } else if (state.used != null && state.remaining == null) {
        state.remaining = Math.max(0, state.limit - state.used);
      }
    }
    if (changed) {
      state.updatedAt = Date.now();
      save();
      render();
    }
  }

  // ---- Proactive baseline ------------------------------------------------
  function sendCommand(command) {
    try {
      window.postMessage({ __channel: CHANNEL, command }, window.location.origin);
    } catch (e) {
      /* ignore */
    }
  }

  // Ask the page-context script to re-fetch a known usage URL (or discover one)
  // so the meter shows a baseline without the user sending a message.
  function requestBaseline() {
    const url = manualUrl || learnedUrl;
    if (url) {
      sendCommand({ type: "fetchUsage", url });
    } else {
      sendCommand({ type: "discover" });
    }
    // Show a "checking" state briefly; clear it if nothing arrives.
    if (!state.updatedAt) {
      probing = true;
      render();
      clearTimeout(probeTimeout);
      probeTimeout = setTimeout(() => {
        probing = false;
        render();
      }, 6000);
    }
  }

  // Remember a URL that produced usage data so future loads can re-fetch it.
  function learnUrl(url) {
    if (!url || url === learnedUrl) return;
    // Prefer account/limit-shaped URLs; ignore per-message completion streams.
    if (!/(usage|rate.?limit|limits|bootstrap|subscription|billing)/i.test(url))
      return;
    learnedUrl = url;
    try {
      chrome.storage?.local.set({ [URL_KEY]: url });
    } catch (e) {
      /* ignore */
    }
  }

  // ---- Formatting --------------------------------------------------------
  function fmtCountdown(ms) {
    if (ms == null || ms <= 0) return "—";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }

  function usagePercent() {
    if (state.limit != null && state.limit > 0) {
      if (state.used != null) return clamp01(state.used / state.limit);
      if (state.remaining != null)
        return clamp01(1 - state.remaining / state.limit);
    }
    return null;
  }

  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  function usageLabel() {
    if (state.limit != null && state.used != null)
      return `${state.used} / ${state.limit}`;
    if (state.remaining != null && state.limit != null)
      return `${state.remaining} left`;
    if (state.remaining != null) return `${state.remaining} left`;
    if (state.used != null) return `${state.used} used`;
    if (probing) return "Checking usage…";
    return "Usage unknown";
  }

  // ---- UI ----------------------------------------------------------------
  function build() {
    if (document.getElementById("cum-root")) return;

    const root = document.createElement("div");
    root.id = "cum-root";
    root.innerHTML = `
      <button id="cum-btn" type="button" aria-label="Claude session usage">
        <span id="cum-ring">
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle class="cum-ring-bg" cx="18" cy="18" r="15.9155"></circle>
            <circle class="cum-ring-fg" cx="18" cy="18" r="15.9155"></circle>
          </svg>
          <span id="cum-ring-label">–</span>
        </span>
        <span id="cum-text">
          <span id="cum-primary">Usage</span>
          <span id="cum-secondary">resets in —</span>
        </span>
      </button>
      <div id="cum-panel" hidden>
        <div class="cum-panel-row cum-panel-title">Claude session</div>
        <div class="cum-panel-row"><span>Usage</span><b id="cum-p-usage">—</b></div>
        <div class="cum-panel-row"><span>Remaining</span><b id="cum-p-remaining">—</b></div>
        <div class="cum-panel-row"><span>Resets in</span><b id="cum-p-reset">—</b></div>
        <div class="cum-panel-row cum-panel-sub" id="cum-p-updated">Not observed yet</div>
        <div class="cum-panel-hint" id="cum-p-hint">Open <b>Settings → Usage</b> once so the meter can read your baseline; it refreshes automatically after that.</div>
      </div>
    `;
    document.body.appendChild(root);

    els = {
      root,
      btn: root.querySelector("#cum-btn"),
      ringFg: root.querySelector(".cum-ring-fg"),
      ringLabel: root.querySelector("#cum-ring-label"),
      primary: root.querySelector("#cum-primary"),
      secondary: root.querySelector("#cum-secondary"),
      panel: root.querySelector("#cum-panel"),
      pUsage: root.querySelector("#cum-p-usage"),
      pRemaining: root.querySelector("#cum-p-remaining"),
      pReset: root.querySelector("#cum-p-reset"),
      pUpdated: root.querySelector("#cum-p-updated"),
    };

    els.btn.addEventListener("click", () => {
      els.panel.hidden = !els.panel.hidden;
    });

    document.addEventListener("click", (e) => {
      if (!els.root.contains(e.target)) els.panel.hidden = true;
    });

    render();
    startTicking();
  }

  function render() {
    if (!els) return;

    const pct = usagePercent();
    const circumference = 2 * Math.PI * 15.9155;
    if (pct == null) {
      els.ringFg.style.strokeDasharray = `0 ${circumference}`;
      els.ringLabel.textContent = "–";
      els.root.classList.remove("cum-warn", "cum-danger");
    } else {
      els.ringFg.style.strokeDasharray = `${pct * circumference} ${circumference}`;
      els.ringLabel.textContent = `${Math.round(pct * 100)}%`;
      els.root.classList.toggle("cum-warn", pct >= 0.75 && pct < 0.9);
      els.root.classList.toggle("cum-danger", pct >= 0.9);
    }

    els.primary.textContent = usageLabel();

    const remainMs = state.resetAt != null ? state.resetAt - Date.now() : null;
    els.secondary.textContent =
      remainMs != null && remainMs > 0
        ? `resets in ${fmtCountdown(remainMs)}`
        : "resets in —";

    // Detail panel
    els.pUsage.textContent =
      state.limit != null && state.used != null
        ? `${state.used} / ${state.limit}`
        : state.used != null
        ? `${state.used}`
        : "—";
    els.pRemaining.textContent =
      state.remaining != null ? `${state.remaining}` : "—";
    els.pReset.textContent =
      remainMs != null && remainMs > 0 ? fmtCountdown(remainMs) : "—";
    els.pUpdated.textContent = state.updatedAt
      ? `Updated ${timeAgo(state.updatedAt)}`
      : "Not observed yet";
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }

  function startTicking() {
    if (tickTimer) clearInterval(tickTimer);
    // Re-render once a second so the countdown stays live.
    tickTimer = setInterval(() => {
      // Once the reset time has passed, clear stale usage and re-baseline.
      if (state.resetAt != null && state.resetAt <= Date.now()) {
        state.resetAt = null;
        state.used = null;
        state.remaining = null;
        save();
        requestBaseline();
      }
      render();
    }, 1000);
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    // Periodically refresh the baseline so the meter stays current even if the
    // user isn't actively sending messages.
    pollTimer = setInterval(requestBaseline, POLL_MS);
  }

  // ---- Wiring ------------------------------------------------------------
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__channel !== CHANNEL || !msg.payload) return;
    const p = msg.payload;
    if (p.data) {
      probing = false;
      clearTimeout(probeTimeout);
      if (p.url) learnUrl(p.url);
      applyReading(p.data);
    }
  });

  // React to storage changes (manual reset, or a pinned endpoint from the popup).
  try {
    chrome.storage?.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_KEY]) {
        state = Object.assign(
          { resetAt: null, remaining: null, limit: null, used: null, updatedAt: null },
          changes[STORAGE_KEY].newValue || {}
        );
        render();
      }
      if (changes[MANUAL_URL_KEY]) {
        manualUrl = changes[MANUAL_URL_KEY].newValue || null;
        requestBaseline();
      }
    });
  } catch (e) {
    /* ignore */
  }

  function init() {
    if (!document.body) {
      requestAnimationFrame(init);
      return;
    }
    build();
    // Kick off a proactive baseline read, then keep it fresh.
    requestBaseline();
    startPolling();
  }

  load().then(init);
})();
