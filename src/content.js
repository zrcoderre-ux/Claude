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
  const OVERAGE_KEY = "cum_show_overage"; // opt-in: show extra-usage spend
  const ESTIMATE_KEY = "cum_estimate_decimals"; // opt-in: estimated tenths
  const POS_KEY = "cum_pos"; // user-dragged position { left, top }
  const LOG_KEY = "cum_log"; // journal of hit-100 / window-reset events
  const HIT100_MARK_KEY = "cum_hit100_marker"; // resetAt already logged for hit100
  const LAST_RESET_KEY = "cum_last_reset"; // resetAt already logged as a reset
  const POLL_MS = 5 * 60 * 1000; // refresh the baseline every 5 minutes

  const EMPTY = {
    percent: null, // 0..1 utilization of the 5-hour session window
    resetAt: null, // ms epoch — session reset
    weeklyPercent: null, // 0..1 utilization of the 7-day window
    weeklyResetAt: null, // ms epoch — weekly reset
    remaining: null, // count-based (rate-limit headers / SSE)
    limit: null,
    used: null,
    overage: null, // { usedMinor, limitMinor, enabled, currency } — extra usage
    context: null, // { tokens, model, window } — current conversation context
    calib: null, // { perPct, accum, baseInt } — tenths-place calibration
    updatedAt: null,
  };
  let state = Object.assign({}, EMPTY);

  let learnedUrl = null;
  let manualUrl = null;
  let showOverage = false; // opt-in toggle (default off)
  let estimateDecimals = false; // opt-in toggle (default off)
  let calib = null; // CUMEstimate calibrator instance
  let pos = null; // { left, top } once the user drags the pill
  let hit100Marker = null; // resetAt for which a "hit100" entry was already logged
  let lastResetMarker = null; // resetAt for which a "reset" entry was already logged
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
          chrome.storage.local.get(
            [
              STORAGE_KEY,
              URL_KEY,
              MANUAL_URL_KEY,
              OVERAGE_KEY,
              ESTIMATE_KEY,
              POS_KEY,
              HIT100_MARK_KEY,
              LAST_RESET_KEY,
            ],
            (res) => {
              if (res && res[STORAGE_KEY]) {
                state = Object.assign(state, res[STORAGE_KEY]);
              }
              if (res && res[URL_KEY]) learnedUrl = res[URL_KEY];
              if (res && res[MANUAL_URL_KEY]) manualUrl = res[MANUAL_URL_KEY];
              showOverage = !!(res && res[OVERAGE_KEY]);
              estimateDecimals = !!(res && res[ESTIMATE_KEY]);
              if (res && res[POS_KEY]) pos = res[POS_KEY];
              if (res && res[HIT100_MARK_KEY]) hit100Marker = res[HIT100_MARK_KEY];
              if (res && res[LAST_RESET_KEY]) lastResetMarker = res[LAST_RESET_KEY];
              resolve();
            }
          );
        } else {
          resolve();
        }
      } catch (e) {
        resolve();
      }
    });
  }

  // ---- Usage log (hit-100 / window-reset history for Options → CSV) ------
  function appendLogEntry(entry) {
    try {
      if (!chrome.storage || !chrome.storage.local || !window.CUMLog) return;
      chrome.storage.local.get(LOG_KEY, (res) => {
        const existing = (res && res[LOG_KEY]) || [];
        const next = window.CUMLog.addEntry(existing, entry);
        chrome.storage.local.set({ [LOG_KEY]: next });
      });
    } catch (e) {
      /* ignore */
    }
  }

  // A stable per-window key: claude's resets_at jitters by ~100–200ms between
  // polls (microsecond precision), so we bucket to the nearest minute to
  // identify "the same window" for dedup.
  function windowKey(resetAt) {
    return resetAt == null ? null : Math.round(resetAt / 60000);
  }

  // Log the moment the 5-hour session reaches 100%, once per window (dedup by
  // the window key, persisted so a reload doesn't re-log a duplicate).
  function maybeLogHit100() {
    if (state.percent == null || state.percent < 1 || state.resetAt == null) return;
    const key = windowKey(state.resetAt);
    if (hit100Marker === key) return;
    hit100Marker = key;
    try {
      chrome.storage?.local.set({ [HIT100_MARK_KEY]: hit100Marker });
    } catch (e) {
      /* ignore */
    }
    appendLogEntry({ at: Date.now(), type: "hit100", percent: 100 });
  }

  // Log a window reset once (deduped by the window's resetAt). `pct01` is the
  // last-seen utilization (0..1); `approx` marks entries reconstructed on load
  // because no tab was open at the actual reset moment.
  function logReset(resetAt, pct01, approx) {
    if (resetAt == null) return;
    const key = windowKey(resetAt);
    if (lastResetMarker === key) return;
    lastResetMarker = key;
    try {
      chrome.storage?.local.set({ [LAST_RESET_KEY]: key });
    } catch (e) {
      /* ignore */
    }
    appendLogEntry({
      at: resetAt,
      type: "reset",
      percent: pct01 != null ? Math.round(pct01 * 1000) / 10 : null,
      approx: !!approx,
    });
  }

  // On load, if the last-observed window's reset time has already elapsed, the
  // window rolled over while no tab was watching. Reconstruct that reset from
  // the last-seen usage % (flagged approximate) so the history stays complete.
  function reconstructMissedReset() {
    if (state.resetAt != null && state.resetAt <= Date.now()) {
      logReset(state.resetAt, state.percent, true);
      state.resetAt = null;
      state.percent = null;
      state.used = null;
      state.remaining = null;
      if (calib) {
        calib.reset();
        state.calib = calib.snapshot();
      }
      save();
    }
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
    if (data.percent != null) {
      // Feed the authoritative integer to the tenths-place calibrator before
      // updating state (it snaps to and recalibrates on each server tick).
      if (calib) {
        calib.observePercent(Math.round(data.percent * 100));
        state.calib = calib.snapshot();
      }
      if (data.percent !== state.percent) {
        state.percent = data.percent;
        changed = true;
      }
      maybeLogHit100();
    }
    if (data.weeklyPercent != null && data.weeklyPercent !== state.weeklyPercent) {
      state.weeklyPercent = data.weeklyPercent;
      changed = true;
    }
    if (
      data.weeklyResetAt != null &&
      data.weeklyResetAt > Date.now() &&
      data.weeklyResetAt !== state.weeklyResetAt
    ) {
      state.weeklyResetAt = data.weeklyResetAt;
      changed = true;
    }
    if (data.overage != null) {
      state.overage = data.overage;
      changed = true;
    }
    if (data.context != null && data.context.tokens != null) {
      const prevMsgs = state.context && state.context.messages;
      state.context = data.context;
      changed = true;
      // Feed the tenths-place calibrator with this turn's consumption proxy.
      // Preferred: real output_tokens (if the API ever exposes them). Otherwise,
      // on a NEW turn (message count grew) each turn reprocesses roughly the
      // whole context, so the estimated context size is the cost proxy.
      if (calib) {
        if (data.context.output != null) {
          calib.addCost((data.context.tokens || 0) + (data.context.output || 0));
          state.calib = calib.snapshot();
        } else if (
          data.context.estimated &&
          data.context.messages != null &&
          (prevMsgs == null || data.context.messages > prevMsgs)
        ) {
          calib.addCost(data.context.tokens || 0);
          state.calib = calib.snapshot();
        }
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

  // ---- Schedule-a-send modal --------------------------------------------
  // Detect whether we're viewing an existing conversation, so the form can
  // offer "This chat" as a target.
  function currentChatContext() {
    const path = location.pathname;
    // Not an existing conversation: a fresh composer, the projects list, or a
    // project overview (those use the New-chat / Project targets instead).
    if (/\/new(\/|$)/.test(path)) return null;
    if (/\/projects?(\/|$)/.test(path)) return null;
    if (/\/project\//.test(path)) return null;
    // Otherwise, if there's a composer AND a conversation id in the URL, treat
    // it as "this chat" — robust to the exact URL shape (claude.ai or Claude
    // Code, /chat/… or /cowork/… or /code/session_…).
    const hasComposer =
      !!document.querySelector('div[data-testid="chat-input"]') ||
      !!document.querySelector(
        '.ProseMirror[contenteditable="true"], .tiptap[contenteditable="true"]'
      );
    const hasUuid =
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(location.href);
    // Claude Code sessions live at /code/<id> (no dashed uuid).
    const isCodeSession = /\/code\/[^/]+/.test(path);
    if (!hasComposer || (!hasUuid && !isCodeSession)) return null;
    const title = document.title.replace(/\s*[-–|]\s*Claude.*$/i, "").trim();
    return { url: location.href, title: title || null };
  }

  let scheduleModal = null;
  function openScheduleModal() {
    if (scheduleModal || !window.CUMJobForm) return;
    const overlay = document.createElement("div");
    overlay.id = "cum-modal-overlay";
    overlay.innerHTML =
      `<div id="cum-modal" role="dialog" aria-label="Schedule a send">` +
      `<div id="cum-modal-head"><b>Schedule a send</b>` +
      `<button id="cum-modal-close" type="button" aria-label="Close">✕</button></div>` +
      `<div id="cum-modal-body"></div>` +
      `<div id="cum-modal-foot"><a id="cum-modal-options" href="#">Manage all scheduled sends →</a></div>` +
      `</div>`;
    document.body.appendChild(overlay);
    scheduleModal = overlay;

    const close = () => {
      if (!scheduleModal) return;
      scheduleModal.remove();
      scheduleModal = null;
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector("#cum-modal-close").addEventListener("click", close);
    overlay.querySelector("#cum-modal-options").addEventListener("click", (e) => {
      e.preventDefault();
      try {
        chrome.runtime?.sendMessage({ type: "cum-open-options" });
      } catch (err) {
        /* ignore */
      }
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", onKey);
      }
    });

    window.CUMJobForm.create(overlay.querySelector("#cum-modal-body"), {
      chatContext: currentChatContext(),
      onSubmitted: () => setTimeout(close, 900),
    });
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
  // The overage endpoint lives beside the usage one:
  //   /api/organizations/{uuid}/usage → …/overage_spend_limit
  function deriveOverageUrl(usageUrl) {
    if (!usageUrl) return null;
    if (/\/usage(\?|$)/.test(usageUrl))
      return usageUrl.replace(/\/usage(\?|$)/, "/overage_spend_limit$1");
    return null;
  }

  function requestBaseline() {
    const url = manualUrl || learnedUrl;
    if (url) {
      sendCommand({ type: "fetchUsage", url });
      // Only reach for the extra-usage endpoint when the user opted in.
      if (showOverage) {
        const ov = deriveOverageUrl(url);
        if (ov) sendCommand({ type: "fetchUsage", url: ov });
      }
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
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }

  // Session utilization as 0..1 — the percent from the Usage endpoint takes
  // precedence; otherwise derive from count-based rate-limit data.
  function usagePercent() {
    if (state.percent != null) return clamp01(state.percent);
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

  // Session utilization for display: the server integer, plus an estimated
  // fractional percent when the experimental toggle is on and we've calibrated
  // within the current (still-open) window.
  function sessionDisplayPercent() {
    const pct = usagePercent();
    if (pct == null) return null;
    if (!estimateDecimals || !calib || !calib.calibrated()) return pct;
    if (state.resetAt == null || state.resetAt <= Date.now()) return pct;
    const baseInt = Math.round(pct * 100);
    return clamp01((baseInt + calib.fraction()) / 100);
  }

  // Render a 0..1 fraction as a percent, showing one decimal only when the
  // value genuinely has sub-integer precision (e.g. the token-derived context
  // meter → "64.1%", while the integer rate-limit values stay "48%").
  function fmtPercent(pct) {
    const p = clamp01(pct) * 100;
    const oneDec = Math.round(p * 10) / 10;
    if (Math.abs(oneDec - Math.round(oneDec)) < 0.05) return `${Math.round(oneDec)}%`;
    return `${oneDec.toFixed(1)}%`;
  }

  function primaryLabel() {
    // The percent signal (from /usage) is authoritative for claude.ai; prefer
    // it so a stray count can never surface as e.g. "0 / 3000" on the button.
    if (state.percent != null) return "5-hour usage";
    if (state.limit != null && state.used != null)
      return `${state.used} / ${state.limit}`;
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
          <span id="cum-primary">—</span>
        </span>
      </button>
      <div id="cum-panel" hidden>
        <div class="cum-panel-row cum-panel-title">Claude usage</div>
        <div class="cum-panel-group">
          <div class="cum-panel-row"><span>Session · 5 hr</span><b id="cum-p-session">—</b></div>
          <div class="cum-panel-bar"><i id="cum-p-session-bar"></i></div>
          <div class="cum-panel-row cum-panel-meta"><span>resets in</span><b id="cum-p-session-reset">—</b></div>
        </div>
        <div class="cum-panel-group" id="cum-weekly-group" hidden>
          <div class="cum-panel-row"><span>Weekly · 7 day</span><b id="cum-p-weekly">—</b></div>
          <div class="cum-panel-bar"><i id="cum-p-weekly-bar"></i></div>
          <div class="cum-panel-row cum-panel-meta"><span>resets in</span><b id="cum-p-weekly-reset">—</b></div>
        </div>
        <div class="cum-panel-group" id="cum-context-group" hidden>
          <div class="cum-panel-row"><span>Context <span class="cum-est">est.</span></span><b id="cum-p-context">—</b></div>
          <div class="cum-panel-bar"><i id="cum-p-context-bar"></i></div>
          <div class="cum-panel-row cum-panel-meta"><span id="cum-p-context-model">tokens</span><b id="cum-p-context-tokens">—</b></div>
        </div>
        <div class="cum-panel-group" id="cum-overage-group" hidden>
          <div class="cum-panel-row"><span>Extra usage</span><b id="cum-p-overage">—</b></div>
          <div class="cum-panel-bar"><i id="cum-p-overage-bar"></i></div>
          <div class="cum-panel-row cum-panel-meta"><span>status</span><b id="cum-p-overage-status">—</b></div>
        </div>
        <div class="cum-panel-row cum-panel-sub" id="cum-p-updated">Not observed yet</div>
        <div class="cum-panel-hint" id="cum-p-hint" hidden>Reading your usage — this updates automatically.</div>
        <button id="cum-schedule-btn" type="button">＋ Schedule a send</button>
      </div>
    `;
    document.body.appendChild(root);

    els = {
      root,
      btn: root.querySelector("#cum-btn"),
      ringFg: root.querySelector(".cum-ring-fg"),
      ringLabel: root.querySelector("#cum-ring-label"),
      primary: root.querySelector("#cum-primary"),
      panel: root.querySelector("#cum-panel"),
      pSession: root.querySelector("#cum-p-session"),
      pSessionBar: root.querySelector("#cum-p-session-bar"),
      pSessionReset: root.querySelector("#cum-p-session-reset"),
      weeklyGroup: root.querySelector("#cum-weekly-group"),
      pWeekly: root.querySelector("#cum-p-weekly"),
      pWeeklyBar: root.querySelector("#cum-p-weekly-bar"),
      pWeeklyReset: root.querySelector("#cum-p-weekly-reset"),
      contextGroup: root.querySelector("#cum-context-group"),
      pContext: root.querySelector("#cum-p-context"),
      pContextBar: root.querySelector("#cum-p-context-bar"),
      pContextModel: root.querySelector("#cum-p-context-model"),
      pContextTokens: root.querySelector("#cum-p-context-tokens"),
      overageGroup: root.querySelector("#cum-overage-group"),
      pOverage: root.querySelector("#cum-p-overage"),
      pOverageBar: root.querySelector("#cum-p-overage-bar"),
      pOverageStatus: root.querySelector("#cum-p-overage-status"),
      pUpdated: root.querySelector("#cum-p-updated"),
      pHint: root.querySelector("#cum-p-hint"),
      scheduleBtn: root.querySelector("#cum-schedule-btn"),
    };

    els.btn.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      els.panel.hidden = !els.panel.hidden;
      if (!els.panel.hidden) placePanel();
    });

    els.scheduleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      els.panel.hidden = true;
      openScheduleModal();
    });

    document.addEventListener("click", (e) => {
      if (!els.root.contains(e.target)) els.panel.hidden = true;
    });

    if (pos) applyPosition(pos, false);
    setupDrag();
    window.addEventListener("resize", () => {
      if (pos) applyPosition(pos, false);
    });

    render();
    startTicking();
  }

  // ---- Drag to reposition ------------------------------------------------
  let suppressClick = false; // set true right after a drag so it doesn't toggle

  function clampPos(left, top) {
    const r = els.root.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - r.width);
    const maxTop = Math.max(0, window.innerHeight - r.height);
    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop),
    };
  }

  // Switch #cum-root from its default right/bottom anchoring to explicit
  // left/top, clamped to the viewport.
  function applyPosition(p, persist) {
    const c = clampPos(p.left, p.top);
    els.root.style.left = `${c.left}px`;
    els.root.style.top = `${c.top}px`;
    els.root.style.right = "auto";
    els.root.style.bottom = "auto";
    pos = c;
    if (persist) {
      try {
        chrome.storage?.local.set({ [POS_KEY]: c });
      } catch (e) {
        /* ignore */
      }
    }
  }

  // Open the panel toward whatever space is available around the pill.
  function placePanel() {
    const r = els.root.getBoundingClientRect();
    els.root.classList.toggle("cum-below", r.top < 300);
    els.root.classList.toggle(
      "cum-align-left",
      r.left + r.width / 2 < window.innerWidth / 2
    );
  }

  function setupDrag() {
    const btn = els.btn;
    let startX = 0, startY = 0, originLeft = 0, originTop = 0, moved = false, dragging = false;

    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const r = els.root.getBoundingClientRect();
      originLeft = r.left;
      originTop = r.top;
      try {
        btn.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });

    btn.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return; // ignore tiny jitters
      moved = true;
      els.root.classList.add("cum-dragging");
      els.panel.hidden = true;
      applyPosition({ left: originLeft + dx, top: originTop + dy }, false);
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      els.root.classList.remove("cum-dragging");
      try {
        btn.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      if (moved) {
        suppressClick = true; // the click that follows this drag is not a tap
        if (pos) applyPosition(pos, true); // persist final position
      }
    }
    btn.addEventListener("pointerup", end);
    btn.addEventListener("pointercancel", end);
  }

  function render() {
    if (!els) return;

    const pct = usagePercent();
    const sdp = sessionDisplayPercent(); // includes estimated tenths when on
    const circumference = 2 * Math.PI * 15.9155;
    if (sdp == null) {
      els.ringFg.style.strokeDasharray = `0 ${circumference}`;
      els.ringLabel.textContent = "–";
      els.root.classList.remove("cum-warn", "cum-danger");
    } else {
      els.ringFg.style.strokeDasharray = `${sdp * circumference} ${circumference}`;
      els.ringLabel.textContent = fmtPercent(sdp);
      els.root.classList.toggle("cum-warn", sdp >= 0.75 && sdp < 0.9);
      els.root.classList.toggle("cum-danger", sdp >= 0.9);
    }

    const remainMs = state.resetAt != null ? state.resetAt - Date.now() : null;
    // The button shows just the reset countdown (the ring conveys what it's
    // for); fall back to a status string when there's no reset time yet.
    els.primary.textContent =
      remainMs != null && remainMs > 0 ? fmtCountdown(remainMs) : primaryLabel();

    // Detail panel — session (5-hour) window
    els.pSession.textContent = sdp != null ? fmtPercent(sdp) : "—";
    els.pSessionBar.style.width = sdp != null ? `${sdp * 100}%` : "0%";
    setBarSeverity(els.pSessionBar, sdp);
    els.pSessionReset.textContent =
      remainMs != null && remainMs > 0 ? fmtCountdown(remainMs) : "—";

    // Detail panel — weekly (7-day) window
    const wpct = state.weeklyPercent;
    if (wpct != null) {
      els.weeklyGroup.hidden = false;
      els.pWeekly.textContent = fmtPercent(wpct);
      els.pWeeklyBar.style.width = `${Math.round(wpct * 100)}%`;
      setBarSeverity(els.pWeeklyBar, wpct);
      const wMs = state.weeklyResetAt != null ? state.weeklyResetAt - Date.now() : null;
      els.pWeeklyReset.textContent =
        wMs != null && wMs > 0 ? fmtCountdown(wMs) : "—";
    } else {
      els.weeklyGroup.hidden = true;
    }

    // Detail panel — context window (per-conversation)
    const ctx = state.context;
    if (ctx && ctx.tokens != null && ctx.window) {
      const cpct = clamp01(ctx.tokens / ctx.window);
      const pre = ctx.estimated ? "~" : "";
      els.contextGroup.hidden = false;
      els.pContext.textContent = pre + fmtPercent(cpct);
      els.pContextBar.style.width = `${Math.round(cpct * 100)}%`;
      setBarSeverity(els.pContextBar, cpct);
      els.pContextTokens.textContent = `${pre}${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}`;
      els.pContextModel.textContent = ctx.model ? shortModel(ctx.model) : "estimated";
    } else {
      els.contextGroup.hidden = true;
    }

    // Detail panel — extra usage (opt-in)
    const ov = state.overage;
    if (showOverage && ov && ov.limitMinor != null) {
      els.overageGroup.hidden = false;
      els.pOverage.textContent = `${money(ov.usedMinor, ov.currency)} / ${money(
        ov.limitMinor,
        ov.currency
      )}`;
      const opct = ov.limitMinor > 0 ? clamp01((ov.usedMinor || 0) / ov.limitMinor) : 0;
      els.pOverageBar.style.width = `${Math.round(opct * 100)}%`;
      setBarSeverity(els.pOverageBar, opct);
      els.pOverageStatus.textContent = ov.enabled ? "on" : "off";
    } else {
      els.overageGroup.hidden = true;
    }

    els.pUpdated.textContent = state.updatedAt
      ? `Updated ${timeAgo(state.updatedAt)}`
      : probing
      ? "Reading usage…"
      : "Not observed yet";
    // Only surface the hint while we genuinely have nothing yet.
    els.pHint.hidden = state.updatedAt != null;
  }

  function fmtTokens(n) {
    if (n == null) return "—";
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`;
    return `${n}`;
  }

  function shortModel(m) {
    // e.g. "claude-opus-4-8-20260101" → "opus-4-8"
    const s = String(m).replace(/^claude-/, "").replace(/-\d{6,}.*$/, "");
    return s.length > 16 ? s.slice(0, 16) : s;
  }

  function money(minor, currency) {
    if (minor == null) return "—";
    const v = (minor / 100).toFixed(2);
    const cur = (currency || "usd").toLowerCase();
    return cur === "usd" ? `$${v}` : `${v} ${cur.toUpperCase()}`;
  }

  function setBarSeverity(bar, pct) {
    bar.classList.remove("cum-bar-warn", "cum-bar-danger");
    if (pct == null) return;
    if (pct >= 0.9) bar.classList.add("cum-bar-danger");
    else if (pct >= 0.75) bar.classList.add("cum-bar-warn");
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
      let dirty = false;
      if (state.resetAt != null && state.resetAt <= Date.now()) {
        // Observed live (a tab was open): log the last-seen % at reset.
        logReset(state.resetAt, state.percent, false);
        state.resetAt = null;
        state.percent = null;
        state.used = null;
        state.remaining = null;
        if (calib) {
          calib.reset(); // new window — drop stale calibration
          state.calib = calib.snapshot();
        }
        dirty = true;
      }
      if (state.weeklyResetAt != null && state.weeklyResetAt <= Date.now()) {
        state.weeklyResetAt = null;
        state.weeklyPercent = null;
        dirty = true;
      }
      if (dirty) {
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
    if (p.projects) mergeProjects(p.projects);
  });

  // Merge harvested projects (from the page's own API) into the cached list the
  // scheduling picker reads. Keyed by uuid so repeat visits just refresh names.
  function mergeProjects(found) {
    if (!Array.isArray(found) || !found.length) return;
    try {
      chrome.storage?.local.get("cum_projects", (res) => {
        const existing = (res && res.cum_projects) || [];
        const byId = new Map(existing.map((p) => [p.uuid, p]));
        let changed = false;
        for (const p of found) {
          if (!p || !p.uuid) continue;
          const prev = byId.get(p.uuid);
          if (!prev || prev.name !== p.name || prev.href !== p.href) changed = true;
          byId.set(p.uuid, p);
        }
        if (changed) chrome.storage.local.set({ cum_projects: Array.from(byId.values()) });
      });
    } catch (e) {
      /* ignore */
    }
  }

  // React to storage changes (manual reset, or a pinned endpoint from the popup).
  try {
    chrome.storage?.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_KEY]) {
        state = Object.assign({}, EMPTY, changes[STORAGE_KEY].newValue || {});
        calib = makeCalibrator(); // rebuild from the (possibly cleared) snapshot
        render();
      }
      if (changes[MANUAL_URL_KEY]) {
        manualUrl = changes[MANUAL_URL_KEY].newValue || null;
        requestBaseline();
      }
      if (changes[OVERAGE_KEY]) {
        showOverage = !!changes[OVERAGE_KEY].newValue;
        if (showOverage) requestBaseline(); // fetch the overage endpoint now
        render();
      }
      if (changes[ESTIMATE_KEY]) {
        estimateDecimals = !!changes[ESTIMATE_KEY].newValue;
        render();
      }
    });
  } catch (e) {
    /* ignore */
  }

  function makeCalibrator() {
    try {
      return window.CUMEstimate.createCalibrator(state.calib || undefined);
    } catch (e) {
      return null;
    }
  }

  function init() {
    if (!document.body) {
      requestAnimationFrame(init);
      return;
    }
    calib = makeCalibrator();
    build();
    // If a window rolled over while no tab was open, backfill it before the
    // fresh baseline overwrites the stale reset time.
    reconstructMissedReset();
    // Kick off a proactive baseline read, then keep it fresh.
    requestBaseline();
    startPolling();
  }

  load().then(init);
})();
