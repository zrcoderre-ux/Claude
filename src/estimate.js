/**
 * Claude Usage Meter — tenths-place estimator (pure, testable).
 *
 * The /usage endpoint reports whole-number percentages. Within a fixed window
 * (usage only climbs until resets_at), we can estimate the fractional percent
 * by learning "tokens per 1%" from the integer jumps we observe, then dividing
 * the tokens seen since the last jump by that rate.
 *
 * This is intentionally conservative: the fraction is capped below 1.0 so the
 * estimate never crosses into the next integer, and it always snaps to the
 * authoritative server integer whenever that changes. It affects only the
 * tenths place, so the worst-case error is bounded to well under one percent.
 */
(function (root) {
  "use strict";

  const EMA_ALPHA = 0.3; // weight of each new observation in the moving average
  const MAX_FRACTION = 0.9; // never display more than baseInt + 0.9

  function createCalibrator(initial) {
    let perPct = initial && initial.perPct != null ? initial.perPct : null;
    let accum = initial && initial.accum != null ? initial.accum : 0;
    let baseInt = initial && initial.baseInt != null ? initial.baseInt : null;

    return {
      // Record consumption (in whatever consistent token proxy the caller uses)
      // observed since the last integer tick.
      addCost(tokens) {
        const n = Number(tokens);
        if (Number.isFinite(n) && n > 0) accum += n;
      },

      // Feed the latest authoritative integer percent (0..100). Calibrates the
      // tokens-per-percent rate on an upward tick and resets on a new window.
      observePercent(intPct) {
        const p = Math.round(Number(intPct));
        if (!Number.isFinite(p)) return;
        if (baseInt == null) {
          baseInt = p;
          return;
        }
        if (p > baseInt) {
          if (accum > 0) {
            const rate = accum / (p - baseInt);
            perPct = perPct == null ? rate : perPct * (1 - EMA_ALPHA) + rate * EMA_ALPHA;
          }
          baseInt = p;
          accum = 0;
        } else if (p < baseInt) {
          // Window reset (or usage decreased) — recalibrate from here.
          baseInt = p;
          accum = 0;
        }
      },

      // Estimated fraction of the way to the next percent (0 .. MAX_FRACTION).
      fraction() {
        if (!perPct || perPct <= 0 || accum <= 0) return 0;
        return Math.min(MAX_FRACTION, accum / perPct);
      },

      calibrated() {
        return perPct != null && perPct > 0;
      },

      reset() {
        accum = 0;
        baseInt = null;
      },

      snapshot() {
        return { perPct, accum, baseInt };
      },
    };
  }

  const api = { createCalibrator, EMA_ALPHA, MAX_FRACTION };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMEstimate = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
