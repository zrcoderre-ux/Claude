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
  const PREDICT_KEY = "cum_predict"; // session↔weekly correlation model
  const DAILY_KEY = "cum_daily"; // per-day weekly-usage attribution
  const SPLIT_KEY = "cum_split"; // chat vs Claude Code usage split
  const JOBS_KEY = "cum_jobs"; // scheduled sends (read only, for the held count)
  const STATUS_KEY = "cum_status"; // status.claude.com snapshot (background polls)
  const STATUS_CFG_KEY = "cum_status_cfg"; // { warn, holdSends } — both default on
  const POLL_MS = 5 * 60 * 1000; // refresh the baseline every 5 minutes

  const S = window.CUMStatus || null; // service-status model (pure)
  const STATUS_URL = (S && S.STATUS_PAGE_URL) || "https://status.claude.com/";

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
  let predictModel = null; // CUMPredict correlation model (persisted)
  let probing = false; // true while a proactive baseline fetch is in flight
  let els = null;
  let tickTimer = null;
  let pollTimer = null;
  let probeTimeout = null;
  // The real context figure, read from claude.ai's own context panel when the
  // user expands it (the page tokenizes client-side and exposes no API field or
  // persistent number). Keyed to the conversation it was read in, and timestamped
  // so the panel can show how fresh it is. `ctxPanelEl` is the live panel element
  // while it's open, so we can keep re-reading it as usage streams.
  let nativeCtx = null; // { key, tokens, window, pct, at }
  let ctxPanelEl = null;
  let ctxObserver = null;
  // Claude's own service status, polled by the background worker (one fetch
  // serves every tab, and it still works with no tab open — which is what the
  // scheduled-send gate needs). Here we only read the snapshot it stores.
  let statusSnap = null;
  let statusWarn = true; // opt-out via the popup toggle
  let heldSends = 0; // scheduled sends an outage is currently holding back

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
              PREDICT_KEY,
              STATUS_KEY,
              STATUS_CFG_KEY,
              JOBS_KEY,
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
              if (res && res[PREDICT_KEY]) predictModel = res[PREDICT_KEY];
              if (res && res[STATUS_KEY]) statusSnap = res[STATUS_KEY];
              // Defaults ON, so only an explicit false turns the warning off.
              statusWarn = (((res && res[STATUS_CFG_KEY]) || {}).warn !== false);
              heldSends = countHeld(res && res[JOBS_KEY]);
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
  // Append with content-based dedup, read-modify-write against the SHARED log so
  // multiple open tabs (browser + PWA) and reloads can't each add their own copy.
  function appendLogEntry(entry) {
    try {
      if (!chrome.storage || !chrome.storage.local || !window.CUMLog) return;
      chrome.storage.local.get(LOG_KEY, (res) => {
        const existing = (res && res[LOG_KEY]) || [];
        if (window.CUMLog.isDuplicate(existing, entry)) return;
        chrome.storage.local.set({ [LOG_KEY]: window.CUMLog.addEntry(existing, entry) });
      });
    } catch (e) {
      /* ignore */
    }
  }

  // Log the moment the 5-hour session reaches 100%. Dedup is content-based (a
  // hit100 stands "open" until a reset is logged), so this is safe to call on
  // every reading and across tabs.
  const HIT100_ON = 0.999; // treat >= this as "maxed" (server reports integers)
  function maybeLogHit100() {
    if (state.percent == null || state.percent < HIT100_ON) return;
    appendLogEntry({ at: Date.now(), type: "hit100", percent: 100 });
  }

  // Collapse duplicate entries out of the stored log (once, on load).
  function dedupeStoredLog() {
    try {
      if (!chrome.storage || !chrome.storage.local || !window.CUMLog || !window.CUMLog.dedupe) return;
      chrome.storage.local.get(LOG_KEY, (res) => {
        const existing = (res && res[LOG_KEY]) || [];
        if (!existing.length) return;
        const cleaned = window.CUMLog.dedupe(existing);
        if (cleaned.length !== existing.length) chrome.storage.local.set({ [LOG_KEY]: cleaned });
      });
    } catch (e) {
      /* ignore */
    }
  }

  function localDateStr(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  // Fold the current reading into (a) the session↔weekly correlation model that
  // estimates maxed-sessions-left, and (b) the per-day weekly-usage tally. Both
  // are read-modify-write against storage so multiple open tabs don't
  // double-count the same increment.
  function foldReading() {
    if (state.weeklyPercent == null) return; // both models key off weekly
    const weeklyPct = state.weeklyPercent * 100;
    const dateStr = localDateStr(Date.now());
    const predictReading = {
      sessionPct: state.percent != null ? state.percent * 100 : null,
      weeklyPct,
      sessionResetAt: state.resetAt,
      weeklyResetAt: state.weeklyResetAt,
    };
    try {
      chrome.storage.local.get([PREDICT_KEY, DAILY_KEY], (res) => {
        const writes = {};
        if (window.CUMPredict && state.percent != null) {
          predictModel = window.CUMPredict.observe(
            (res && res[PREDICT_KEY]) || window.CUMPredict.EMPTY,
            predictReading
          );
          writes[PREDICT_KEY] = predictModel;
        }
        if (window.CUMDaily) {
          writes[DAILY_KEY] = window.CUMDaily.observe(
            (res && res[DAILY_KEY]) || window.CUMDaily.EMPTY,
            { weeklyPct, weeklyResetAt: state.weeklyResetAt, dateStr }
          );
        }
        if (Object.keys(writes).length) {
          try {
            chrome.storage.local.set(writes);
          } catch (e) {
            /* ignore */
          }
        }
        render();
      });
    } catch (e) {
      /* ignore */
    }
    // Home vs Code split is handled separately so it can content-attribute a gap.
    updateSplit(weeklyPct);
  }

  // ---- Home (chat) vs Code usage split -----------------------------------
  // Live increments are attributed to the tab you're in. But a weekly jump that
  // follows a gap (reopen, mobile, or a long pause) may have come from anywhere,
  // so we check whether a Home chat was touched during the gap: Home chats all
  // carry an updated_at in chat_conversations_v2, and Code sessions don't — so a
  // gap with no fresh Home activity was Code.
  const SPLIT_GAP_MS = 10 * 60 * 1000; // "gap" = this long since the last reading
  const SPLIT_GAP_PCT = 0.3; // ...and at least this many weekly %-points
  let lastHomeActivityAt = null; // max Home-chat updated_at we've seen (ms)
  let lastHomeWeighted = null; // model-weighted tokens Home added during a gap
  let splitBusy = false; // a gap resolution is in flight
  // For learning the weekly-%-per-token rate live: the last Home conversation
  // and its estimated context size, so we can pair the weekly meter's rise with
  // how much that conversation grew.
  let lastCtxLearn = { key: null, tokens: null };

  function currentSurface() {
    return /^\/code(\/|$)/.test(location.pathname) ? "code" : "chat";
  }

  function convKey() {
    // One definition, shared with the workflow model — a run has to recognise
    // its own turns in the activity ledger below, and two regexes that drifted
    // apart would make every step look contaminated.
    if (window.CUMWorkflow && window.CUMWorkflow.conversationKey)
      return window.CUMWorkflow.conversationKey(location.href);
    const m = location.href.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    );
    return m ? m[0] : location.pathname;
  }

  // ---- Activity ledger ---------------------------------------------------
  // The span of every assistant turn, by conversation, across all your claude.ai
  // tabs. Workflow runs use it to decide whether a step is worth measuring: the
  // usage meter is browser-wide, so a step that ran while you were working in
  // another chat tells you nothing about what the step cost. Read-modify-write
  // like the other shared tallies here; each turn writes twice (start and end),
  // so a lost write rarely loses the whole turn.
  const ACTIVITY_KEY = "cum_activity";
  const ACTIVITY_MAX = 40; // bound it; conversations are transient
  const ACTIVITY_TTL = 6 * 60 * 60 * 1000; // and forget yesterday's entirely

  function noteActivity(kind) {
    const key = convKey();
    if (!key) return;
    try {
      chrome.storage?.local.get(ACTIVITY_KEY, (res) => {
        const now = Date.now();
        const src = (res && res[ACTIVITY_KEY]) || {};
        const out = {};
        for (const k of Object.keys(src)) {
          const t = src[k];
          if (t && typeof t.start === "number" && now - t.start < ACTIVITY_TTL) out[k] = t;
        }
        // A turn in a brand-new chat opens while the URL is still /new and ends
        // once claude.ai has swapped in the conversation's own id. Left alone
        // that leaves a stray "/new" turn behind, which every later run would
        // read as somebody else working. So when a turn ends under an id and an
        // unfinished one is sitting under a path, it's the same turn: move it.
        if (kind === "end" && key.indexOf("/") !== 0) {
          for (const k of Object.keys(out)) {
            if (k.indexOf("/") !== 0) continue;
            const t = out[k];
            if (t && t.end == null && now - t.start < 15 * 60 * 1000) {
              if (!out[key] || out[key].end != null) out[key] = { start: t.start, end: null };
              delete out[k];
            }
          }
        }
        const was = out[key];
        out[key] =
          kind === "start"
            ? { start: now, end: null }
            : // An end with no start we saw still marks the conversation busy;
              // guessing a start of `now` would understate the span, so it takes
              // whatever start we have.
              { start: was && typeof was.start === "number" ? was.start : now, end: now };
        const keys = Object.keys(out).sort((a, b) => (out[a].start || 0) - (out[b].start || 0));
        for (const k of keys.slice(0, Math.max(0, keys.length - ACTIVITY_MAX))) delete out[k];
        chrome.storage?.local.set({ [ACTIVITY_KEY]: out });
      });
    } catch (e) {
      /* ignore */
    }
  }

  // How much (model-weighted tokens) the active Home conversation grew since the
  // last live reading — the content signal we pair with the weekly-% rise to
  // learn the conversion rate. Returns 0 when we can't measure it cleanly (new
  // conversation, no context estimate, or context shrank).
  function liveLearnTokens() {
    if (currentSurface() !== "chat") {
      lastCtxLearn = { key: null, tokens: null };
      return 0;
    }
    const ctx = state.context;
    if (!ctx || ctx.tokens == null) return 0;
    const key = convKey();
    let learn = 0;
    if (lastCtxLearn.key === key && lastCtxLearn.tokens != null && ctx.tokens > lastCtxLearn.tokens) {
      const w = window.CUMWeights ? window.CUMWeights.modelWeight(ctx.model) : 1;
      learn = (ctx.tokens - lastCtxLearn.tokens) * w;
    }
    lastCtxLearn = { key, tokens: ctx.tokens };
    return learn;
  }

  function writeSplit(model, reading) {
    try {
      chrome.storage.local.set(
        { [SPLIT_KEY]: window.CUMSplit.observe(model, reading) },
        () => {
          render();
        }
      );
    } catch (e) {
      /* ignore */
    }
  }

  function updateSplit(currentWeekly) {
    if (!window.CUMSplit || splitBusy) return;
    try {
      chrome.storage.local.get(SPLIT_KEY, (res) => {
        const model = (res && res[SPLIT_KEY]) || window.CUMSplit.EMPTY;
        const wKey = state.weeklyResetAt != null ? Math.round(state.weeklyResetAt / 60000) : null;
        const sameWindow = model.lastW != null && model.wKey === wKey;
        const gapDelta = sameWindow ? currentWeekly - model.lastW : 0;
        const gapMs = model.lastAt != null ? Date.now() - model.lastAt : Infinity;
        const now = Date.now();
        if (gapDelta > SPLIT_GAP_PCT && gapMs > SPLIT_GAP_MS) {
          // Gap — decide Home vs Code from fresh Home-conversation activity, and
          // when both were used, split by how much Home content was added.
          splitBusy = true;
          const boundaryAt = model.lastAt || 0;
          lastHomeWeighted = null;
          sendCommand({ type: "measureHome", sinceMs: boundaryAt });
          let waited = 0;
          const tick = setInterval(() => {
            waited += 500;
            // measureHome always reports homeWeighted (even 0) once it finishes;
            // wait for it so a content split has the measurement in hand.
            if (lastHomeWeighted != null || waited >= 6000) {
              clearInterval(tick);
              chrome.storage.local.get(SPLIT_KEY, (r2) => {
                const m2 = (r2 && r2[SPLIT_KEY]) || window.CUMSplit.EMPTY;
                if (lastHomeActivityAt == null) {
                  // Couldn't check — fall back to the current tab's surface.
                  writeSplit(m2, {
                    weeklyPct: currentWeekly, weeklyResetAt: state.weeklyResetAt,
                    surface: currentSurface(), at: now,
                  });
                } else {
                  const homeTouched = lastHomeActivityAt >= boundaryAt;
                  const parts = window.CUMSplit.splitByContent(
                    m2, gapDelta, homeTouched ? lastHomeWeighted : null, homeTouched
                  );
                  writeSplit(m2, {
                    weeklyPct: currentWeekly, weeklyResetAt: state.weeklyResetAt,
                    chatDelta: parts.chatDelta, codeDelta: parts.codeDelta, at: now,
                  });
                }
                splitBusy = false;
              });
            }
          }, 500);
        } else {
          // Live — attribute to the tab we're in, and (on Home) learn the
          // weekly-%-per-token rate from how much this conversation grew.
          writeSplit(model, {
            weeklyPct: currentWeekly, weeklyResetAt: state.weeklyResetAt,
            surface: currentSurface(), at: now, learnTok: liveLearnTokens(),
          });
        }
      });
    } catch (e) {
      splitBusy = false;
    }
  }

  // Log a window reset. Dedup (resets within ~10 min are the same reset) is
  // handled in appendLogEntry, so this is safe across tabs and reloads. `pct01`
  // is the last-seen utilization (0..1); `approx` marks entries reconstructed on
  // load because no tab was open at the actual reset moment.
  function logReset(resetAt, pct01, approx) {
    if (resetAt == null) return;
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
      // Tag with the conversation it came from so a stale estimate from another
      // chat is never shown against the one you're looking at now.
      state.context = Object.assign({}, data.context, { key: convKey() });
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
      // Learn the session↔weekly relationship and per-day usage on each move.
      foldReading();
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

  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  // Fraction (0..1) of a window that has elapsed, from its reset time and known
  // length: elapsed = 1 − timeLeft/length. Null if we don't know the reset time.
  function windowElapsed(resetAt, lengthMs) {
    if (resetAt == null) return null;
    return clamp01(1 - (resetAt - Date.now()) / lengthMs);
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

  // What the pill's ring should show: normally the 5-hour session usage, but
  // when the weekly limit is the tighter constraint, the weekly budget mapped
  // onto the same 5-hour scale (so a nearly-spent week reads high even at the
  // start of a fresh window). Returns { pct, isWeekly, resetAt }.
  function bindingDisplay() {
    const sdp = sessionDisplayPercent();
    let nw = null;
    if (state.weeklyPercent != null && window.CUMPredict && predictModel) {
      nw = window.CUMPredict.weeklyBindingUsage(predictModel, state.weeklyPercent * 100);
    }
    if (sdp == null) {
      if (nw == null) return { pct: null, isWeekly: false, resetAt: state.resetAt };
      return { pct: nw, isWeekly: true, resetAt: state.weeklyResetAt };
    }
    if (nw != null && nw > sdp)
      return { pct: nw, isWeekly: true, resetAt: state.weeklyResetAt };
    return { pct: sdp, isWeekly: false, resetAt: state.resetAt };
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

  // Format a predicted count of remaining sessions: one decimal below 10 (so a
  // small number stays informative), whole numbers above.
  function fmtSessions(n) {
    if (!(n >= 0)) return "0";
    if (n >= 10) return String(Math.round(n));
    return (Math.round(n * 10) / 10).toFixed(1);
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
          <div class="cum-panel-bar cum-elapsed" title="How much of the 5-hour window has elapsed. If usage (above) stays at or below this, you'll pace out just as the window resets."><i id="cum-p-session-elapsed"></i></div>
          <div class="cum-panel-row cum-panel-meta"><span>resets in</span><b id="cum-p-session-reset">—</b></div>
        </div>
        <div class="cum-panel-group" id="cum-weekly-group" hidden>
          <div class="cum-panel-row"><span>Weekly · 7 day</span><b id="cum-p-weekly">—</b></div>
          <div class="cum-panel-bar"><i id="cum-p-weekly-bar"></i></div>
          <div class="cum-panel-bar cum-elapsed" title="How far through the 7-day week you are."><i id="cum-p-weekly-elapsed"></i></div>
          <div class="cum-panel-row cum-panel-meta"><span>resets in</span><b id="cum-p-weekly-reset">—</b></div>
          <div class="cum-panel-row cum-panel-meta cum-sessions-row" id="cum-sessions-row" hidden>
            <span>maxed 5-hr sessions left <span class="cum-est">est.</span></span>
            <b id="cum-p-sessions">—</b>
          </div>
        </div>
        <div class="cum-panel-group" id="cum-context-group" hidden>
          <div class="cum-panel-row"><span>Context <span class="cum-est">est.</span></span><b id="cum-p-context">—</b></div>
          <div class="cum-panel-bar"><i id="cum-p-context-bar"></i></div>
          <div class="cum-panel-row cum-panel-meta"><span id="cum-p-context-model">tokens</span><b id="cum-p-context-tokens">—</b></div>
        </div>
        <div class="cum-panel-group" id="cum-status-group">
          <div class="cum-panel-row"><span>Claude status</span></div>
          <a class="cum-status-value" id="cum-p-status" target="_blank" rel="noreferrer noopener"
             ><i class="cum-status-dot"></i><span id="cum-p-status-text">Checking…</span></a>
          <div class="cum-panel-row cum-panel-meta cum-status-detail" id="cum-p-status-detail" hidden></div>
        </div>
        <div class="cum-panel-group" id="cum-overage-group" hidden>
          <div class="cum-panel-row"><span>Extra usage</span><b id="cum-p-overage">—</b></div>
          <div class="cum-panel-bar"><i id="cum-p-overage-bar"></i></div>
          <div class="cum-panel-row cum-panel-meta"><span>status</span><b id="cum-p-overage-status">—</b></div>
        </div>
        <div class="cum-panel-row cum-panel-sub" id="cum-p-updated">Not observed yet</div>
        <div class="cum-panel-hint" id="cum-p-hint" hidden>Reading your usage — this updates automatically.</div>
        <button id="cum-dl-now-btn" type="button">Download the newest file</button>
        <div id="cum-dl-now-note" hidden></div>
        <button id="cum-schedule-btn" type="button">＋ Schedule a send</button>
        <button id="cum-options-btn" type="button">Open options →</button>
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
      pSessionElapsed: root.querySelector("#cum-p-session-elapsed"),
      pSessionReset: root.querySelector("#cum-p-session-reset"),
      weeklyGroup: root.querySelector("#cum-weekly-group"),
      pWeekly: root.querySelector("#cum-p-weekly"),
      pWeeklyBar: root.querySelector("#cum-p-weekly-bar"),
      pWeeklyElapsed: root.querySelector("#cum-p-weekly-elapsed"),
      pWeeklyReset: root.querySelector("#cum-p-weekly-reset"),
      sessionsRow: root.querySelector("#cum-sessions-row"),
      pSessions: root.querySelector("#cum-p-sessions"),
      contextGroup: root.querySelector("#cum-context-group"),
      pContextEst: root.querySelector("#cum-context-group .cum-est"),
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
      dlNowBtn: root.querySelector("#cum-dl-now-btn"),
      dlNowNote: root.querySelector("#cum-dl-now-note"),
      scheduleBtn: root.querySelector("#cum-schedule-btn"),
      optionsBtn: root.querySelector("#cum-options-btn"),
      statusGroup: root.querySelector("#cum-status-group"),
      pStatus: root.querySelector("#cum-p-status"),
      pStatusText: root.querySelector("#cum-p-status-text"),
      pStatusDetail: root.querySelector("#cum-p-status-detail"),
    };
    els.pStatus.href = STATUS_URL;

    // Indicator pills, docked to the main pill (children of #cum-root) so they
    // ride along when you drag the meter:
    //   - a SERVICE-STATUS warning (outer), shown only while Claude is degraded
    //     or down — clickable, it opens status.claude.com; and
    //   - the CONTEXT-usage alarm, which flashes each time context crosses
    //     another 5%, appears only briefly on the first 5%, and becomes
    //     permanent once context reaches 10% (then keeps updating).
    const pills = document.createElement("div");
    pills.id = "cum-pills";
    pills.innerHTML =
      `<a id="cum-status-pill" hidden target="_blank" rel="noreferrer noopener">` +
      `<span class="cum-status-dot"></span>` +
      `<b id="cum-status-text">—</b></a>` +
      `<div id="cum-ctx-pill" hidden>` +
      `<span class="cum-ctx-dot"></span>` +
      `<span class="cum-ctx-cap">Context</span>` +
      `<b id="cum-ctx-pct">—</b></div>`;
    root.insertBefore(pills, els.btn); // above the button; panel still paints over
    els.pills = pills;
    els.statusPill = pills.querySelector("#cum-status-pill");
    els.statusText = pills.querySelector("#cum-status-text");
    els.ctxPill = pills.querySelector("#cum-ctx-pill");
    els.ctxPillPct = pills.querySelector("#cum-ctx-pct");
    els.statusPill.href = STATUS_URL;

    els.btn.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      els.panel.hidden = !els.panel.hidden;
      if (!els.panel.hidden) placePanel();
    });

    // Download the newest file, by hand. The same walk the automatic path
    // makes — CUMAutoDownload.tryNow — with every gate off, because you
    // pressing this is not the backlog those gates exist to refuse. It reports
    // which reply it looked at, what it found on it, and what it pressed, which
    // is how the Chat/Cowork toggle and the rename were both settled.
    if (els.dlNowBtn)
      els.dlNowBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const D = window.CUMAutoDownload;
        if (!D || !D.tryNow) return sayDlNow("the auto-download module isn't loaded");
        let text;
        try {
          text = D.tryNow();
        } catch (err) {
          text = "threw: " + String((err && err.message) || err);
        }
        sayDlNow(text || "(it said nothing)");
      });

    function sayDlNow(text) {
      try {
        console.log("[claude-usage-meter] download:\n" + text);
      } catch (err) {
        /* ignore */
      }
      if (!els.dlNowNote) return;
      els.dlNowNote.textContent = text;
      els.dlNowNote.hidden = false;
    }

    els.scheduleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      els.panel.hidden = true;
      openScheduleModal();
    });

    els.optionsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      els.panel.hidden = true;
      try {
        chrome.runtime?.sendMessage({ type: "cum-open-options" });
      } catch (err) {
        /* ignore */
      }
    });

    document.addEventListener("click", (e) => {
      if (!els.root.contains(e.target)) els.panel.hidden = true;
    });

    if (pos) applyPosition(pos, false);
    setupDrag();
    window.addEventListener("resize", () => {
      if (pos) applyPosition(pos, false);
      placePills();
    });
    // The workflow pill docks itself into this stack, and does it long after
    // this runs — it appears and disappears with the run driving the tab. This
    // is how it tells the meter the stack changed height.
    window.CUMPills = { measure: placePills };

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

  // Keep the docked indicator pills on-screen: sit the stack below the button
  // instead of above when the meter is dragged near the top edge. The stack is
  // one or two pills tall depending on what's showing, so measure it rather than
  // assuming a single row's worth of headroom.
  function placePills() {
    if (!els || !els.pills || !els.root) return;
    const r = els.root.getBoundingClientRect();
    els.root.classList.toggle("cum-pills-below", r.top < els.pills.offsetHeight + 12);
    reserveStack();
  }

  // How much room the panel must leave for the indicator stack. Only when the
  // two are on the same side of the button, which they usually but not always
  // are — they flip at different thresholds. Nothing showing, nothing reserved.
  //
  // Without this the stack sits on top of the panel, and one of those pills is a
  // run's, carrying a Pause you may well be reaching for.
  function reserveStack() {
    if (!els || !els.pills || !els.root) return;
    const h = els.pills.offsetHeight;
    const sameSide =
      els.root.classList.contains("cum-pills-below") ===
      els.root.classList.contains("cum-below");
    els.root.style.setProperty("--cum-stack", (h && sameSide ? h + 8 : 0) + "px");
  }

  // Open the panel toward whatever space is available around the pill.
  function placePanel() {
    const r = els.root.getBoundingClientRect();
    els.root.classList.toggle("cum-below", r.top < 300);
    els.root.classList.toggle(
      "cum-align-left",
      r.left + r.width / 2 < window.innerWidth / 2
    );
    reserveStack();
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
      placePills();
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

  // ---- Native context panel scraping ------------------------------------
  // claude.ai computes the context-window breakdown client-side and shows the
  // number only while its context panel is expanded — there's no API field and
  // no persistent element. So we watch for that panel and read the exact figure
  // straight from it whenever the user opens it.
  function extractNativeContext(el) {
    try {
      if (!el || el.nodeType !== 1 || !window.CUMWeights) return;
      // Code only — and checked here rather than when the observer is set up,
      // because the SPA moves between a chat and Code without reloading, and an
      // observer that had declined to start would never notice the arrival.
      if (!isCodeChat()) return;
      if (els && els.root && els.root.contains(el)) return; // ignore our own UI
      const txt = el.textContent || "";
      if (!txt || txt.length > 300000 || !/context window/i.test(txt)) return;
      const parsed = window.CUMWeights.parseNativeContext(txt);
      if (!parsed) return;
      ctxPanelEl = el;
      nativeCtx = {
        key: convKey(),
        tokens: parsed.tokens,
        window: parsed.window,
        pct: parsed.pct,
        model: parseMenuModel(txt),
        at: Date.now(),
      };
      // Use the exact token count to sharpen the chat/code split's rate learner.
      learnFromRealCode();
      if (els) render();
    } catch (e) {
      /* ignore */
    }
  }

  // The usage menu lists a per-model weekly limit (e.g. "Weekly · Fable"); that
  // model-specific line names the model the Code chat is using. Parse the first
  // recognized model name (ignoring the "all models" aggregate line) so the rate
  // learner can weight its real token counts correctly. Null if none is found.
  function parseMenuModel(txt) {
    const re = /weekly\s*[·:•]\s*([a-z0-9.\- ]{1,24}?)(?=resets|\d|weekly|context|$)/gi;
    let m;
    while ((m = re.exec(txt))) {
      const name = m[1].trim();
      if (/all\s*models/i.test(name)) continue;
      if (/opus|sonnet|haiku|fable/i.test(name)) return name;
    }
    return null;
  }

  // Pair two real Code context readings (same conversation and weekly window) to
  // learn weekly-% per real, model-weighted token — ground truth that sharpens
  // the rate the gap split uses. Skipped unless we can identify the model, so an
  // unknown weight can't skew the accumulator. This only touches the rate, not
  // the chat/code buckets (the live/gap paths already attribute usage).
  let lastCodeReal = null; // { key, tokens, weeklyPct, wKey }
  function learnFromRealCode() {
    try {
      if (!window.CUMSplit || !window.CUMSplit.learn || !isCodeChat()) return;
      if (!nativeCtx || nativeCtx.tokens == null || state.weeklyPercent == null) return;
      const wKey = state.weeklyResetAt != null ? Math.round(state.weeklyResetAt / 60000) : null;
      const cur = {
        key: nativeCtx.key,
        tokens: nativeCtx.tokens,
        weeklyPct: state.weeklyPercent * 100,
        wKey: wKey,
      };
      const prev = lastCodeReal;
      lastCodeReal = cur;
      if (!prev || prev.key !== cur.key || prev.wKey !== cur.wKey) return;
      const dTok = cur.tokens - prev.tokens;
      const dW = cur.weeklyPct - prev.weeklyPct;
      if (!(dTok > 0) || !(dW > 0)) return;
      const model = nativeCtx.model || (state.context && state.context.model) || null;
      if (!model || !window.CUMWeights) return; // need a known model to weight
      const weighted = dTok * window.CUMWeights.modelWeight(model);
      chrome.storage.local.get(SPLIT_KEY, (res) => {
        const m = (res && res[SPLIT_KEY]) || window.CUMSplit.EMPTY;
        chrome.storage.local.set({ [SPLIT_KEY]: window.CUMSplit.learn(m, dW, weighted) }, () => {
          if (els) render();
        });
      });
    } catch (e) {
      /* ignore */
    }
  }

  function setupContextScraper() {
    try {
      if (ctxObserver || typeof MutationObserver === "undefined" || !document.body) return;
      ctxObserver = new MutationObserver((muts) => {
        for (const mut of muts) {
          const nodes = mut.addedNodes;
          if (!nodes) continue;
          for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].nodeType === 1) extractNativeContext(nodes[i]);
          }
        }
      });
      ctxObserver.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
      /* ignore */
    }
  }

  // ---- Background refresh of the Code context panel ----------------------
  // The real figure lives only in claude.ai's usage menu (open it → expand the
  // "Context window" section). To keep it current without the user doing that
  // each time, we briefly open that menu ourselves — hidden via CSS — after each
  // Code turn and on a slow timer, let the observer read it, then close it.
  const CTX_TRIGGER_SEL =
    'button[aria-haspopup="dialog"][aria-label^="Usage" i], [data-base-ui-click-trigger][aria-label^="Usage" i]';
  const CTX_READ_THROTTLE_MS = 15000;
  const CTX_PERIODIC_MS = 60000;
  const CTX_TURN_DELAY_MS = 4000;
  let ctxReading = false;
  let lastCtxReadAt = 0;
  let ctxTurnTimer = null;
  let lastCtxNavKey = null;

  function isCodeChat() {
    return /^\/code(\/|$)/.test(location.pathname);
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Some popovers open on pointer events rather than a bare click, so drive the
  // full sequence.
  function synthClick(el) {
    if (!el) return;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch (e) {
        /* ignore */
      }
    }
  }

  function findContextExpander(root) {
    const scope = root || document;
    const btns = scope.querySelectorAll('button, [role="button"]');
    for (const b of btns) {
      const t = (b.textContent || "").trim();
      if (/^context window/i.test(t) && t.length < 40) return b;
    }
    return null;
  }

  function scheduleTurnRead() {
    if (!isCodeChat()) return;
    clearTimeout(ctxTurnTimer);
    ctxTurnTimer = setTimeout(() => backgroundReadContext(), CTX_TURN_DELAY_MS);
  }

  async function backgroundReadContext() {
    if (ctxReading || !isCodeChat() || document.hidden) return;
    if (Date.now() - lastCtxReadAt < CTX_READ_THROTTLE_MS) return;
    const trigger = document.querySelector(CTX_TRIGGER_SEL);
    if (!trigger) return;
    // Don't hijack focus while the user is typing.
    const ae = document.activeElement;
    if (ae && (ae.isContentEditable || /^(INPUT|TEXTAREA)$/.test(ae.tagName))) return;
    // Don't fight a menu the user opened themselves.
    if (trigger.getAttribute("aria-expanded") === "true") return;

    ctxReading = true;
    const prevFocus = document.activeElement;
    document.documentElement.classList.add("cum-ctx-reading");
    try {
      synthClick(trigger);
      await wait(200);
      const dialog = document.querySelector('[role="dialog"]') || document.body;
      const exp = findContextExpander(dialog);
      if (exp && exp.getAttribute("aria-expanded") !== "true") {
        synthClick(exp);
        await wait(180);
      }
      extractNativeContext(document.querySelector('[role="dialog"]') || dialog);
      lastCtxReadAt = Date.now();
    } catch (e) {
      /* ignore */
    } finally {
      // Close whatever we opened, and restore focus.
      try {
        if (trigger.getAttribute("aria-expanded") === "true") synthClick(trigger);
        await wait(30);
        if (trigger.getAttribute("aria-expanded") === "true") {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }
      } catch (e) {
        /* ignore */
      }
      try {
        if (prevFocus && prevFocus.focus) prevFocus.focus();
      } catch (e) {
        /* ignore */
      }
      document.documentElement.classList.remove("cum-ctx-reading");
      ctxReading = false;
    }
  }

  // Context is shown on **Claude Code only**.
  //
  // There, claude.ai computes the figure itself and puts it in its own usage
  // menu, so what the meter shows is a real token count read out of the page —
  // worth having, and the reason the scraping below exists at all.
  //
  // On a Home chat there is no such number anywhere: the web app exposes no
  // token count in its API and draws none in its UI, so the only thing that
  // could be shown is our own count of characters divided by four. That
  // estimate cannot see the system prompt, the tools, or an attachment's real
  // cost, and drawn as a meter with a percentage under it, it gets read as a
  // measurement. A figure that looks precise and isn't is worse than no figure,
  // so a chat has neither the row in the panel nor the alarm pill.
  //
  // The estimate itself is still made — it is a parse of a payload the page
  // fetches anyway, and it is what teaches the model weights behind Daily
  // Usage's split (see liveLearnTokens). It just isn't shown to you as if it
  // were the context window.
  function contextIsShown() {
    return currentSurface() === "code";
  }

  // The context figure to show: the real one read from claude.ai's panel when we
  // have it for this conversation, else our per-conversation estimate (marked ~).
  function contextForDisplay() {
    if (!contextIsShown()) return null;
    const key = convKey();
    if (nativeCtx && nativeCtx.key === key && nativeCtx.window > 0) {
      return {
        tokens: nativeCtx.tokens,
        window: nativeCtx.window,
        pct: nativeCtx.pct != null ? nativeCtx.pct : clamp01(nativeCtx.tokens / nativeCtx.window),
        native: true,
        at: nativeCtx.at,
        model: null,
      };
    }
    const ctx = state.context;
    if (ctx && ctx.tokens != null && ctx.window && ctx.key === key) {
      return {
        tokens: ctx.tokens,
        window: ctx.window,
        pct: clamp01(ctx.tokens / ctx.window),
        estimated: true,
        model: ctx.model || null,
      };
    }
    return null;
  }

  // ---- Context-usage alarm pill ------------------------------------------
  // Buckets are 5%-wide (0 = <5%, 1 = 5–<10%, 2 = 10–<15%, …). Crossing UP into a
  // new bucket fires a brief alarm flash. The pill shows transiently on the first
  // 5% and latches permanently once context reaches 10%.
  let ctxPillKey = null;
  let ctxPillMaxBucket = 0;
  let ctxPillPermanent = false;
  let ctxPillTransientUntil = 0;
  let ctxAlarmTimer = null;
  const CTX_PILL_TRANSIENT_MS = 5000;

  function triggerCtxAlarm() {
    const pill = els && els.ctxPill;
    if (!pill) return;
    pill.hidden = false; // make sure the flash is seen
    pill.classList.remove("cum-ctx-alarm");
    void pill.offsetWidth; // reflow so the animation restarts
    pill.classList.add("cum-ctx-alarm");
    clearTimeout(ctxAlarmTimer);
    ctxAlarmTimer = setTimeout(() => {
      if (els && els.ctxPill) els.ctxPill.classList.remove("cum-ctx-alarm");
    }, 1700);
  }

  function updateContextPill() {
    if (!els || !els.ctxPill) return;
    // Off the Code surface the pill goes, and its latch with it — a pill left
    // showing from the Code tab you were just in would be reporting that
    // conversation's context against the chat you are now reading.
    if (!contextIsShown()) {
      els.ctxPill.hidden = true;
      ctxPillPermanent = false;
      ctxPillTransientUntil = 0;
      ctxPillKey = null;
      ctxPillMaxBucket = 0;
      return;
    }
    const cd = contextForDisplay();
    if (!cd || cd.pct == null) {
      if (!ctxPillPermanent && Date.now() >= ctxPillTransientUntil) els.ctxPill.hidden = true;
      return;
    }
    const pct = clamp01(cd.pct) * 100;
    const bucket = Math.floor(pct / 5);
    const key = convKey();
    // A new conversation adopts its current level silently (no alarm for the jump)
    // so the next 5% it climbs in this chat alarms fresh.
    if (key !== ctxPillKey) {
      ctxPillKey = key;
      ctxPillMaxBucket = bucket;
    }
    if (bucket >= 2) ctxPillPermanent = true;
    if (bucket > ctxPillMaxBucket && bucket >= 1) {
      ctxPillMaxBucket = bucket;
      triggerCtxAlarm();
      if (!ctxPillPermanent) ctxPillTransientUntil = Date.now() + CTX_PILL_TRANSIENT_MS;
    } else if (bucket < ctxPillMaxBucket) {
      ctxPillMaxBucket = bucket; // context dropped (branch/edit) — re-arm thresholds
    }
    const visible = ctxPillPermanent || Date.now() < ctxPillTransientUntil;
    els.ctxPill.hidden = !visible;
    if (visible) {
      placePills();
      els.ctxPillPct.textContent = fmtPercent(cd.pct);
      els.ctxPill.classList.toggle("cum-ctx-warn", pct >= 75 && pct < 90);
      els.ctxPill.classList.toggle("cum-ctx-danger", pct >= 90);
      els.ctxPill.title =
        (cd.native ? "Context (actual): " : "Context (estimated): ") + fmtPercent(cd.pct);
    }
  }

  // ---- Service-status warning --------------------------------------------
  // The background worker polls status.claude.com and stores the snapshot; the
  // pill just reflects it. A `minor` reading (degraded performance, a low-impact
  // incident) warns but does not hold a scheduled send — Claude still answers.
  let statusPillLevel = null; // last level we flashed for
  let statusAlarmTimer = null;

  function countHeld(jobs) {
    let n = 0;
    for (const j of jobs || []) if (j && j.status === "waiting") n++;
    return n;
  }

  function flashStatusPill() {
    const pill = els && els.statusPill;
    if (!pill) return;
    pill.classList.remove("cum-status-alarm");
    void pill.offsetWidth; // reflow so the animation restarts
    pill.classList.add("cum-status-alarm");
    clearTimeout(statusAlarmTimer);
    statusAlarmTimer = setTimeout(() => {
      if (els && els.statusPill) els.statusPill.classList.remove("cum-status-alarm");
    }, 1700);
  }

  // Only a READABLE, non-ok snapshot warns. An unreachable status page (level
  // "unknown") says nothing — a warning we can't stand behind is worse than none.
  function statusIsBad() {
    return !!(S && statusSnap && statusSnap.ok && statusSnap.level !== "ok");
  }

  const STATUS_LEVEL_CLASSES = [
    "cum-status-ok",
    "cum-status-minor",
    "cum-status-maintenance",
    "cum-status-major",
    "cum-status-critical",
    "cum-status-unknown",
  ];

  function setStatusLevelClass(el, level) {
    for (const c of STATUS_LEVEL_CLASSES) {
      el.classList.toggle(c, c === "cum-status-" + level);
    }
  }

  let statusPillShown = false;

  function updateStatusPill() {
    if (!els || !els.statusPill) return;
    const show = !!(statusWarn && statusIsBad());
    els.statusPill.hidden = !show;
    // Re-measure only when the stack's height can actually have changed — this
    // runs once a second, and a forced layout for nothing isn't free.
    const shownChanged = show !== statusPillShown;
    statusPillShown = show;
    if (!show) {
      statusPillLevel = null;
      if (shownChanged) placePills();
      return;
    }
    const level = statusSnap.level;
    els.statusText.textContent = S.shortLabel(statusSnap);
    setStatusLevelClass(els.statusPill, level);
    const lines = S.detailLines(statusSnap);
    els.statusPill.title =
      (lines.length ? lines.join("\n") : S.shortLabel(statusSnap)) +
      (heldSends ? "\n\n" + heldLabel() + " until this clears." : "") +
      "\n\nClick to open status.claude.com";
    // Flash when things get worse, not on every re-render (this runs each second).
    if (level !== statusPillLevel) {
      const worsened = S.rank(level) > S.rank(statusPillLevel || "ok");
      statusPillLevel = level;
      if (worsened) flashStatusPill();
      placePills(); // the label changed, so the stack may have grown a line
    } else if (shownChanged) {
      placePills();
    }
  }

  function heldLabel() {
    return heldSends === 1
      ? "1 scheduled send is waiting"
      : heldSends + " scheduled sends are waiting";
  }

  // The panel row is ALWAYS shown, unlike the pill. The pill stays out of the way
  // until something is wrong; the panel is where you deliberately went to look, so
  // "All Systems Operational" in green is the answer you came for — and it's the
  // only thing that distinguishes "everything is fine" from "the check is broken".
  function updateStatusPanel() {
    if (!els || !els.statusGroup) return;
    // Level drives both the dot's colour and the text. `unknown` is grey and says
    // so: a check we couldn't complete must never read as a green all-clear.
    const level = S && statusSnap ? (statusSnap.ok ? statusSnap.level : "unknown") : "unknown";
    setStatusLevelClass(els.pStatus, level);
    els.pStatusText.textContent = statusSnap && S ? S.shortLabel(statusSnap) : "Checking…";

    const lines = statusIsBad() ? S.detailLines(statusSnap) : [];
    if (heldSends) lines.unshift(heldLabel());
    // A reading we couldn't refresh carries its real age rather than being passed
    // off as current (`ok` plus an `error` is a remembered snapshot).
    if (statusSnap && statusSnap.ok && statusSnap.error) {
      lines.push("last checked " + timeAgo(statusSnap.fetchedAt));
    }
    els.pStatusDetail.textContent = lines.slice(0, 3).join(" · ");
    els.pStatusDetail.hidden = !lines.length;
  }

  // Ask the worker for a fresh reading (it owns the fetch — one per browser, not
  // one per tab) and take whatever it hands back.
  function requestStatus(force) {
    try {
      chrome.runtime?.sendMessage({ type: "cum-status", force: !!force }, (res) => {
        void chrome.runtime.lastError;
        if (res && res.status) {
          statusSnap = res.status;
          updateStatusPill();
          updateStatusPanel();
        }
      });
    } catch (e) {
      /* extension context reloaded — the storage listener will catch up */
    }
  }

  function render() {
    if (!els) return;

    const sdp = sessionDisplayPercent(); // includes estimated tenths when on
    // The ring reflects whichever limit is closest to cutting you off — the
    // 5-hour session, or the weekly budget mapped onto the same 5-hour scale.
    const disp = bindingDisplay();
    const dp = disp.pct;
    const circumference = 2 * Math.PI * 15.9155;
    if (dp == null) {
      els.ringFg.style.strokeDasharray = `0 ${circumference}`;
      els.ringLabel.textContent = "–";
      els.root.classList.remove("cum-warn", "cum-danger");
    } else {
      els.ringFg.style.strokeDasharray = `${dp * circumference} ${circumference}`;
      els.ringLabel.textContent = fmtPercent(dp);
      els.root.classList.toggle("cum-warn", dp >= 0.75 && dp < 0.9);
      els.root.classList.toggle("cum-danger", dp >= 0.9);
    }
    els.root.classList.toggle("cum-weekly-binding", !!disp.isWeekly);

    // The countdown reflects the binding window's reset — the weekly reset when
    // the weekly limit is what's about to cut you off.
    const remainMs = disp.resetAt != null ? disp.resetAt - Date.now() : null;
    const countdown =
      remainMs != null && remainMs > 0 ? fmtCountdown(remainMs) : primaryLabel();
    // A small "weekly" tag makes clear the ring flipped to the weekly limit.
    els.primary.innerHTML = disp.isWeekly
      ? '<span class="cum-tag">weekly</span>' + countdown
      : countdown;

    // Detail panel — session (5-hour) window (always the true 5-hour figures)
    els.pSession.textContent = sdp != null ? fmtPercent(sdp) : "—";
    els.pSessionBar.style.width = sdp != null ? `${sdp * 100}%` : "0%";
    setBarSeverity(els.pSessionBar, sdp);
    // Time elapsed in the 5-hour window = 1 − timeLeft/5h (the reset time is
    // your first message + 5h, so this is simply how far into the window you
    // are). If usage (bar above) stays at or below this, you pace out right as
    // the window resets.
    const sessElapsed = windowElapsed(state.resetAt, FIVE_HOURS_MS);
    els.pSessionElapsed.style.width = sessElapsed != null ? `${sessElapsed * 100}%` : "0%";
    els.pSessionReset.textContent =
      remainMs != null && remainMs > 0 ? fmtCountdown(remainMs) : "—";

    // Detail panel — weekly (7-day) window
    const wpct = state.weeklyPercent;
    if (wpct != null) {
      els.weeklyGroup.hidden = false;
      els.pWeekly.textContent = fmtPercent(wpct);
      els.pWeeklyBar.style.width = `${Math.round(wpct * 100)}%`;
      setBarSeverity(els.pWeeklyBar, wpct);
      // Fluid progress through the 168-hour week (not chunked into days).
      const wElapsed = windowElapsed(state.weeklyResetAt, SEVEN_DAYS_MS);
      els.pWeeklyElapsed.style.width = wElapsed != null ? `${wElapsed * 100}%` : "0%";
      const wMs = state.weeklyResetAt != null ? state.weeklyResetAt - Date.now() : null;
      els.pWeeklyReset.textContent =
        wMs != null && wMs > 0 ? fmtCountdown(wMs) : "—";
      // Predicted maxed 5-hour sessions left in this weekly window.
      const est =
        window.CUMPredict && predictModel
          ? window.CUMPredict.estimate(predictModel, wpct * 100)
          : { ready: false };
      if (els.sessionsRow) {
        if (est.ready) {
          els.sessionsRow.hidden = false;
          els.pSessions.textContent = "~" + fmtSessions(est.remaining);
          els.pSessions.title =
            "Estimated from how your weekly usage has tracked your 5-hour" +
            " sessions so far (~" +
            (est.total != null ? est.total.toFixed(1) : "?") +
            " per week). Rough guide, not a guarantee.";
        } else {
          els.sessionsRow.hidden = true;
        }
      }
    } else {
      els.weeklyGroup.hidden = true;
    }

    // Detail panel — context window. Prefer the exact figure read from claude.ai's
    // own context panel; otherwise fall back to our per-conversation estimate (~).
    const cd = contextForDisplay();
    if (cd) {
      const cpct = clamp01(cd.pct);
      const pre = cd.native ? "" : "~";
      els.contextGroup.hidden = false;
      els.pContext.textContent = pre + fmtPercent(cpct);
      els.pContextBar.style.width = `${Math.round(cpct * 100)}%`;
      setBarSeverity(els.pContextBar, cpct);
      els.pContextTokens.textContent = `${pre}${fmtTokens(cd.tokens)} / ${fmtTokens(cd.window)}`;
      if (els.pContextEst) {
        if (cd.native) {
          els.pContextEst.textContent = "actual";
          els.pContextEst.title = "Read from Claude's own context panel (" + timeAgo(cd.at) + ").";
        } else {
          els.pContextEst.textContent = "est.";
          els.pContextEst.title =
            "Estimated from the conversation's length. Open Claude's context panel once for the exact figure.";
        }
      }
      els.pContextModel.textContent = cd.model ? shortModel(cd.model) : cd.native ? "measured" : "estimated";
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

    updateContextPill();
    updateStatusPill();
    updateStatusPanel();
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
      // Keep re-reading the native context panel while it's open so the figure
      // tracks usage as it streams; drop the reference once it closes.
      if (ctxPanelEl) {
        if (ctxPanelEl.isConnected) extractNativeContext(ctxPanelEl);
        else ctxPanelEl = null;
      }
      // On navigating into a different Code chat, read its context figure.
      const navKey = convKey();
      if (navKey !== lastCtxNavKey) {
        lastCtxNavKey = navKey;
        if (isCodeChat()) setTimeout(backgroundReadContext, 1200);
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
    if (p.projects) mergeProjects(p.projects, p.full);
    if (p.homeActivityAt != null && (lastHomeActivityAt == null || p.homeActivityAt > lastHomeActivityAt))
      lastHomeActivityAt = p.homeActivityAt;
    if (p.homeWeighted != null) lastHomeWeighted = p.homeWeighted;
    // `turnEnded` is posted when the completion stream OPENS (its name predates
    // the streamDone signal below); together the two bracket the turn.
    if (p.turnEnded) {
      noteActivity("start");
      scheduleTurnRead();
    }
    if (p.streamDone) noteActivity("end");
  });

  // Fold harvested projects (from the page's own API) into the cached list the
  // scheduling picker reads, keyed by uuid. A partial capture (DOM scrape, a
  // filtered response) MERGES — add/refresh only. An authoritative full list
  // (`full`) REPLACES, so projects deleted on claude.ai are pruned here too.
  function mergeProjects(found, full) {
    if (!Array.isArray(found) || !found.length) return;
    try {
      chrome.storage?.local.get("cum_projects", (res) => {
        const existing = (res && res.cum_projects) || [];
        let next;
        if (full) {
          // Replace: dedupe the fresh list by uuid, keep its order.
          const byId = new Map();
          for (const p of found) if (p && p.uuid && !byId.has(p.uuid)) byId.set(p.uuid, p);
          next = Array.from(byId.values());
        } else {
          const byId = new Map(existing.map((p) => [p.uuid, p]));
          for (const p of found) if (p && p.uuid) byId.set(p.uuid, p);
          next = Array.from(byId.values());
        }
        // Only write when something actually changed (avoid storage churn).
        const same =
          next.length === existing.length &&
          next.every((p, i) => {
            const e = existing[i];
            return e && e.uuid === p.uuid && e.name === p.name && e.href === p.href;
          });
        if (!same) chrome.storage.local.set({ cum_projects: next });
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
      if (changes[PREDICT_KEY]) {
        // Another tab folded in a reading — keep our estimate in sync.
        predictModel = changes[PREDICT_KEY].newValue || predictModel;
        render();
      }
      if (changes[STATUS_KEY]) {
        statusSnap = changes[STATUS_KEY].newValue || null;
        updateStatusPill();
        updateStatusPanel();
      }
      if (changes[STATUS_CFG_KEY]) {
        statusWarn = (changes[STATUS_CFG_KEY].newValue || {}).warn !== false;
        updateStatusPill();
        updateStatusPanel();
      }
      if (changes[JOBS_KEY]) {
        // A send going on hold (or coming off it) changes what the panel says.
        heldSends = countHeld(changes[JOBS_KEY].newValue);
        updateStatusPill();
        updateStatusPanel();
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
    // Watch for claude.ai's native context panel so we can read the real figure.
    setupContextScraper();
    // On a Code chat, read the real context figure now and keep it fresh on a
    // slow safety timer (turn-end events refresh it promptly in between).
    if (isCodeChat()) setTimeout(backgroundReadContext, 2500);
    setInterval(() => {
      if (isCodeChat()) backgroundReadContext();
    }, CTX_PERIODIC_MS);
    // One-time cleanup: collapse any duplicate hit100/reset entries that earlier
    // versions (per-tab dedup) left behind.
    dedupeStoredLog();
    // If a window rolled over while no tab was open, backfill it before the
    // fresh baseline overwrites the stale reset time.
    reconstructMissedReset();
    // Kick off a proactive baseline read, then keep it fresh.
    requestBaseline();
    startPolling();
    // And a service-status read, so a tab opened mid-outage warns immediately
    // rather than at the worker's next poll.
    requestStatus(false);
  }

  load().then(init);
})();
