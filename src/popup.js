/* Claude Usage Meter — popup logic */
(function () {
  "use strict";

  const STORAGE_KEY = "cum_state";
  const MANUAL_URL_KEY = "cum_manual_url";

  const el = {
    usage: document.getElementById("usage"),
    remaining: document.getElementById("remaining"),
    reset: document.getElementById("reset"),
    updated: document.getElementById("updated"),
    clear: document.getElementById("clear"),
    endpoint: document.getElementById("endpoint"),
    save: document.getElementById("save"),
    status: document.getElementById("status"),
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
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
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

  function render(state) {
    state = state || {};
    el.usage.textContent =
      state.limit != null && state.used != null
        ? `${state.used} / ${state.limit}`
        : state.used != null
        ? `${state.used}`
        : "—";
    el.remaining.textContent = state.remaining != null ? `${state.remaining}` : "—";
    const remainMs = state.resetAt != null ? state.resetAt - Date.now() : null;
    el.reset.textContent = remainMs != null && remainMs > 0 ? fmtCountdown(remainMs) : "—";
    el.updated.textContent = state.updatedAt
      ? `Updated ${timeAgo(state.updatedAt)}`
      : "No data observed yet";
  }

  chrome.storage.local.get([STORAGE_KEY, MANUAL_URL_KEY], (res) => {
    render(res && res[STORAGE_KEY]);
    if (res && res[MANUAL_URL_KEY]) el.endpoint.value = res[MANUAL_URL_KEY];
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
      resetAt: null,
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
})();
