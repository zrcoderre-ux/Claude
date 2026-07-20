/**
 * Claude Usage Meter — per-day usage tracking (pure module).
 *
 * Attributes weekly-limit consumption to calendar days so the Options page can
 * show which days of the week you spend more of your weekly budget, and how
 * much. On each reading, the rise in the 7-day weekly meter since the last
 * reading (within the same weekly window) is added to the current local date's
 * bucket. Aggregating those dates by weekday gives an average daily magnitude
 * (weekly-limit %-points) and each weekday's share of a typical week's usage.
 *
 * Date strings ("YYYY-MM-DD", local) are supplied by the caller so this module
 * stays pure and testable.
 */
(function (root) {
  "use strict";

  const EMPTY = { days: {}, lastW: null, wKey: null };
  const MAX_DAYS = 180; // bound storage; keep the most recent dates

  function keyOf(resetAt) {
    return resetAt == null ? null : Math.round(resetAt / 60000);
  }

  // Fold one reading in. `r` = { weeklyPct (0..100), weeklyResetAt, dateStr }.
  function observe(model, r) {
    const src = model || EMPTY;
    const m = { days: Object.assign({}, src.days || {}), lastW: src.lastW, wKey: src.wKey };
    if (!r || r.weeklyPct == null || !r.dateStr) return m;
    const wKey = keyOf(r.weeklyResetAt);
    if (m.lastW != null && wKey === m.wKey) {
      const dW = r.weeklyPct - m.lastW;
      // Only a sane forward move; a weekly reset (meter drops to ~0) re-baselines.
      if (dW > 0 && dW <= 100) m.days[r.dateStr] = (m.days[r.dateStr] || 0) + dW;
    }
    m.lastW = r.weeklyPct;
    m.wKey = wKey;
    const dates = Object.keys(m.days).sort(); // YYYY-MM-DD sorts chronologically
    if (dates.length > MAX_DAYS) {
      for (const d of dates.slice(0, dates.length - MAX_DAYS)) delete m.days[d];
    }
    return m;
  }

  // Local weekday (0=Sun..6=Sat) for a YYYY-MM-DD string. Noon avoids DST edges.
  function weekdayOf(dateStr) {
    const parts = String(dateStr).split("-");
    const y = +parts[0], mo = +parts[1], d = +parts[2];
    return new Date(y, mo - 1, d, 12, 0, 0).getDay();
  }

  // Aggregate the per-date buckets into a weekday profile.
  //   avg[wd]   = mean weekly%-points consumed on that weekday
  //   share[wd] = that weekday's portion of a typical week's total usage (%)
  //   counts[wd]= how many dated samples fell on that weekday
  function summary(model) {
    const days = (model && model.days) || {};
    const sums = [0, 0, 0, 0, 0, 0, 0];
    const counts = [0, 0, 0, 0, 0, 0, 0];
    let totalPct = 0;
    let totalDays = 0;
    for (const date of Object.keys(days)) {
      const pct = days[date];
      if (!(pct > 0)) continue;
      const wd = weekdayOf(date);
      sums[wd] += pct;
      counts[wd] += 1;
      totalPct += pct;
      totalDays += 1;
    }
    const avg = sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
    const avgTotal = avg.reduce((a, b) => a + b, 0);
    const share = avg.map((a) => (avgTotal > 0 ? (a / avgTotal) * 100 : 0));
    return { avg, share, counts, sums, totalPct, totalDays, avgTotal };
  }

  const api = { EMPTY, observe, summary, weekdayOf, MAX_DAYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMDaily = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
