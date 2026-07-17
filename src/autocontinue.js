/**
 * Claude Usage Meter — Auto-continue (ISOLATED world content script).
 *
 * When a long agentic turn hits Claude's per-turn tool-use / length limit,
 * claude.ai shows a "Continue" button. With the (opt-in, default-off) toggle
 * enabled, this finds that button and clicks it for you, so long runs don't
 * stall waiting for a human.
 *
 * Safety: only clicks a visible, enabled button whose label is exactly
 * "Continue"; a per-click cooldown and a max-continuations cap (per page load)
 * prevent runaway clicking. A background service worker nudges this via
 * "cum-ac-poll" messages so it also works in backgrounded tabs.
 */
(function () {
  "use strict";

  const CFG_KEY = "cum_autocontinue"; // { enabled: bool, max: number }
  const STATE_KEY = "cum_state"; // usage snapshot (for the retry gate)
  const SELF_POLL_MS = 2000; // foreground self-poll
  const COOLDOWN_MS = 4000; // never click twice within this window

  // Button labels that resume a paused turn. Kept as sets so it's easy to add
  // locale/wording variants after verifying against the live UI.
  const CONTINUE_LABELS = ["continue"];
  // "Try again" appears when the usage limit is hit (claude.ai + Claude Code).
  // Unlike Continue, we only click it once usage has actually reset.
  const RETRY_LABELS = ["try again", "retry"];

  let cfg = { enabled: false, max: 50 };
  let clickCount = 0; // continues performed this page load
  let lastClickAt = 0;
  let paused = false; // set true once the cap is reached (until re-enabled)
  let armed = true; // click once per appearance; re-arm only when the button is gone
  let retryArmed = true; // same, for the usage-limit "Try again" button
  let retrySawLimit = false; // only auto-retry if we saw the usage cap while shown
  let usageState = null; // latest cum_state (percent / resetAt) for the retry gate

  // ---- pure helpers (exposed for unit tests) ----------------------------
  function normText(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
  }
  function isContinueLabel(text) {
    return CONTINUE_LABELS.indexOf(normText(text)) !== -1;
  }
  function isRetryLabel(text) {
    return RETRY_LABELS.indexOf(normText(text)) !== -1;
  }

  // ---- DOM ---------------------------------------------------------------
  function isClickable(el) {
    if (!el || el.disabled) return false;
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const cs = window.getComputedStyle(el);
    if (!cs || cs.display === "none" || cs.visibility === "hidden") return false;
    if (Number(cs.opacity) === 0) return false;
    return true;
  }

  function findButton(pred) {
    const nodes = document.querySelectorAll('button, [role="button"]');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!pred(el.textContent)) continue;
      if (!isClickable(el)) continue;
      return el;
    }
    return null;
  }
  function findContinueButton() {
    return findButton(isContinueLabel);
  }
  // Prefer "try again" over the more generic "retry".
  function findRetryButton() {
    for (let i = 0; i < RETRY_LABELS.length; i++) {
      const want = RETRY_LABELS[i];
      const btn = findButton((t) => normText(t) === want);
      if (btn) return btn;
    }
    return null;
  }

  // At/over the session cap (per the usage meter).
  function usageMaxed() {
    return !!(usageState && usageState.percent != null && usageState.percent >= 0.995);
  }
  // Available again once the window resets — content.js clears percent on reset.
  function usageAvailable() {
    return !usageMaxed();
  }

  // Claude is actively generating when a "Stop" control is present — don't
  // interrupt it with a Continue click.
  function isGenerating() {
    const stop =
      document.querySelector('button[aria-label*="Stop" i]') ||
      document.querySelector('[data-testid="stop-button"]');
    return !!(stop && isClickable(stop));
  }

  function clickOnce(btn, label) {
    lastClickAt = Date.now();
    clickCount++;
    try {
      btn.click();
    } catch (e) {
      /* ignore */
    }
    toast(`${label} (${clickCount}${cfg.max ? " / " + cfg.max : ""})`);
  }

  function tick() {
    if (!cfg.enabled || paused) return;
    if (cfg.max && cfg.max > 0 && clickCount >= cfg.max) {
      paused = true;
      toast(`Auto-continue paused — reached ${cfg.max}. Toggle it off/on to resume.`);
      return;
    }
    const now = Date.now();

    // 1) "Continue" (tool-use / length limit) — click immediately, once per
    //    appearance, but not while Claude is generating.
    const cont = findContinueButton();
    if (cont) {
      if (armed && !isGenerating() && now - lastClickAt >= COOLDOWN_MS) {
        armed = false;
        clickOnce(cont, "Auto-continued");
      }
    } else {
      armed = true;
    }

    // 2) "Try again" (usage limit) — only engage if we saw the usage cap while
    //    the button was showing (so we don't touch unrelated retry buttons),
    //    then wait until usage resets and click once.
    const retry = findRetryButton();
    if (retry) {
      if (usageMaxed()) retrySawLimit = true; // we're genuinely rate-limited
      if (
        retryArmed &&
        retrySawLimit &&
        usageAvailable() &&
        !isGenerating() &&
        now - lastClickAt >= COOLDOWN_MS
      ) {
        retryArmed = false;
        clickOnce(retry, "Resumed after reset");
      }
    } else {
      retryArmed = true;
      retrySawLimit = false;
    }
  }

  // ---- Toast -------------------------------------------------------------
  let toastEl = null;
  let toastTimer = null;
  function toast(msg) {
    try {
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.id = "cum-ac-toast";
        (document.body || document.documentElement).appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.classList.add("cum-ac-show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("cum-ac-show"), 2600);
    } catch (e) {
      /* ignore */
    }
  }

  // ---- Config ------------------------------------------------------------
  function applyCfg(value) {
    const prevEnabled = cfg.enabled;
    cfg = Object.assign({ enabled: false, max: 50 }, value || {});
    if (cfg.enabled && !prevEnabled) {
      // Re-enabling clears the cap/pause so the user can resume after a cap.
      clickCount = 0;
      paused = false;
    }
  }

  function loadCfg() {
    try {
      chrome.storage?.local.get([CFG_KEY, STATE_KEY], (res) => {
        applyCfg(res && res[CFG_KEY]);
        if (res && res[STATE_KEY]) usageState = res[STATE_KEY];
      });
    } catch (e) {
      /* ignore */
    }
  }

  try {
    chrome.storage?.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[CFG_KEY]) applyCfg(changes[CFG_KEY].newValue);
      if (changes[STATE_KEY]) usageState = changes[STATE_KEY].newValue || null;
    });
  } catch (e) {
    /* ignore */
  }

  // Background service worker nudges us so we run even in throttled bg tabs.
  try {
    chrome.runtime?.onMessage.addListener((msg) => {
      if (msg === "cum-ac-poll") tick();
    });
  } catch (e) {
    /* ignore */
  }

  loadCfg();
  setInterval(tick, SELF_POLL_MS);

  // Expose pure helpers for tests.
  window.CUMAutoContinue = {
    normText,
    isContinueLabel,
    isRetryLabel,
    CONTINUE_LABELS,
    RETRY_LABELS,
  };
})();
