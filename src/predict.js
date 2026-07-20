/**
 * Claude Usage Meter — session/weekly correlation & prediction (pure module).
 *
 * Goal: estimate how many *maxed-out 5-hour sessions* worth of weekly budget
 * remain in the current 7-day window. The 5-hour max is only the unit of
 * measure — the estimate is learned from ALL usage readings, not just the
 * moments the session hits 100%.
 *
 * How: on every reading we see the 5-hour session utilization and the 7-day
 * weekly utilization. Between two readings taken inside the same session AND
 * weekly window, the weekly meter rises by some dW while the session meter
 * rises by dS. Accumulating those increments gives an exchange rate
 *   r = Σ weekly% / Σ session%      (weekly% consumed per 1% of a session)
 * so a full (100%) session costs ~ r·100 weekly%, and the sessions left in the
 * week is (100 − weekly%) / (r·100).
 *
 * Increments are only counted when both windows are unchanged and the deltas
 * are sane forward moves — a session or weekly reset (meter drops to ~0) just
 * re-baselines without polluting the totals.
 */
(function (root) {
  "use strict";

  const EMPTY = {
    sumS: 0, // Σ session %-points observed
    sumW: 0, // Σ weekly %-points observed over the same spans
    samples: 0, // number of increments folded in
    lastS: null, // last session % seen
    lastW: null, // last weekly % seen
    sKey: null, // session-window key (rounded resetAt)
    wKey: null, // weekly-window key (rounded resetAt)
  };

  const CAP = 5000; // keep the sums bounded; halving preserves the ratio
  const MIN_SAMPLES = 3;
  const MIN_SESSION_OBSERVED = 25; // cumulative session %-points before trusting it

  function keyOf(resetAt) {
    return resetAt == null ? null : Math.round(resetAt / 60000);
  }

  // Fold one reading into the model. `r` = { sessionPct, weeklyPct,
  // sessionResetAt, weeklyResetAt } with percentages on a 0..100 scale.
  function observe(model, r) {
    const m = Object.assign({}, EMPTY, model || {});
    if (!r || r.sessionPct == null || r.weeklyPct == null) return m;
    const sKey = keyOf(r.sessionResetAt);
    const wKey = keyOf(r.weeklyResetAt);
    const sameWindows =
      m.lastS != null && m.lastW != null && sKey === m.sKey && wKey === m.wKey;
    if (sameWindows) {
      const dS = r.sessionPct - m.lastS;
      const dW = r.weeklyPct - m.lastW;
      // Count only sane forward increments; a reset or backwards/no move is skipped.
      if (dS > 0 && dW >= 0 && dS <= 100 && dW <= 100) {
        m.sumS += dS;
        m.sumW += dW;
        m.samples += 1;
        if (m.sumS > CAP) {
          m.sumS *= 0.5;
          m.sumW *= 0.5;
        }
      }
    }
    m.lastS = r.sessionPct;
    m.lastW = r.weeklyPct;
    m.sKey = sKey;
    m.wKey = wKey;
    return m;
  }

  // Estimate remaining full (maxed) 5-hour sessions in the current weekly
  // window. `weeklyPct` is the current 7-day utilization on a 0..100 scale.
  function estimate(model, weeklyPct) {
    const m = model || {};
    if (!m.samples || m.samples < MIN_SAMPLES || m.sumS < MIN_SESSION_OBSERVED || m.sumW <= 0)
      return { ready: false };
    const perSessionPct = m.sumW / m.sumS; // weekly% per 1% of session
    const perFull = perSessionPct * 100; // weekly% per full maxed session
    if (!(perFull > 0)) return { ready: false };
    const wp = typeof weeklyPct === "number" ? weeklyPct : 0;
    const remaining = Math.max(0, (100 - wp) / perFull);
    const total = 100 / perFull;
    return { ready: true, remaining, total, perFull };
  }

  const api = { EMPTY, observe, estimate, keyOf, MIN_SAMPLES, MIN_SESSION_OBSERVED, CAP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPredict = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
