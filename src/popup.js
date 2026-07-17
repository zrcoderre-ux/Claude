/* Claude Usage Meter — popup logic */
(function () {
  "use strict";

  const STORAGE_KEY = "cum_state";
  const MANUAL_URL_KEY = "cum_manual_url";
  const OVERAGE_KEY = "cum_show_overage";
  const ESTIMATE_KEY = "cum_estimate_decimals";

  const el = {
    session: document.getElementById("session"),
    sessionReset: document.getElementById("session-reset"),
    weekly: document.getElementById("weekly"),
    weeklyReset: document.getElementById("weekly-reset"),
    updated: document.getElementById("updated"),
    clear: document.getElementById("clear"),
    endpoint: document.getElementById("endpoint"),
    save: document.getElementById("save"),
    status: document.getElementById("status"),
    showOverage: document.getElementById("show-overage"),
    estimateDecimals: document.getElementById("estimate-decimals"),
    openLog: document.getElementById("open-log"),
  };

  function flash(text) {
    el.status.textContent = text;
    el.status.hidden = false;
    setTimeout(() => {
      el.status.hidden = true;
    }, 1800);
  }

  function fmtCountdown(ms) {
    if (ms == null || ms <= 0) return "—";
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  }

  function pctText(p) {
    return p != null ? `${Math.round(p * 100)}%` : "—";
  }

  function resetText(ms) {
    const remain = ms != null ? ms - Date.now() : null;
    return remain != null && remain > 0 ? fmtCountdown(remain) : "—";
  }

  function render(state) {
    state = state || {};
    // Session: prefer the utilization percent; fall back to a count ratio.
    let session = state.percent;
    if (session == null && state.limit && state.used != null)
      session = state.used / state.limit;
    el.session.textContent = pctText(session);
    el.sessionReset.textContent = resetText(state.resetAt);
    el.weekly.textContent = pctText(state.weeklyPercent);
    el.weeklyReset.textContent = resetText(state.weeklyResetAt);
    el.updated.textContent = state.updatedAt
      ? `Updated ${timeAgo(state.updatedAt)}`
      : "No data observed yet";
  }

  chrome.storage.local.get(
    [STORAGE_KEY, MANUAL_URL_KEY, OVERAGE_KEY, ESTIMATE_KEY],
    (res) => {
      render(res && res[STORAGE_KEY]);
      if (res && res[MANUAL_URL_KEY]) el.endpoint.value = res[MANUAL_URL_KEY];
      el.showOverage.checked = !!(res && res[OVERAGE_KEY]);
      el.estimateDecimals.checked = !!(res && res[ESTIMATE_KEY]);
    }
  );

  el.showOverage.addEventListener("change", () => {
    chrome.storage.local.set({ [OVERAGE_KEY]: el.showOverage.checked }, () =>
      flash(el.showOverage.checked ? "Extra usage on" : "Extra usage off")
    );
  });

  el.estimateDecimals.addEventListener("change", () => {
    chrome.storage.local.set({ [ESTIMATE_KEY]: el.estimateDecimals.checked }, () =>
      flash(el.estimateDecimals.checked ? "Estimating decimals" : "Whole numbers")
    );
  });

  el.save.addEventListener("click", () => {
    const raw = el.endpoint.value.trim();
    // Accept a full URL or a same-origin path; normalise to a path.
    let value = raw;
    if (raw) {
      try {
        if (/^https?:\/\//i.test(raw)) value = new URL(raw).pathname + new URL(raw).search;
      } catch (e) {
        flash("Invalid URL");
        return;
      }
      if (!value.includes("/api/")) {
        flash("Must be an /api/ URL");
        return;
      }
    }
    chrome.storage.local.set({ [MANUAL_URL_KEY]: value }, () =>
      flash(value ? "Saved — reload claude.ai" : "Cleared endpoint")
    );
  });

  el.clear.addEventListener("click", () => {
    const cleared = {
      percent: null,
      resetAt: null,
      weeklyPercent: null,
      weeklyResetAt: null,
      remaining: null,
      limit: null,
      used: null,
      updatedAt: null,
    };
    chrome.storage.local.set({ [STORAGE_KEY]: cleared }, () => {
      render(cleared);
      flash("Cleared");
    });
  });

  el.openLog.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
})();
