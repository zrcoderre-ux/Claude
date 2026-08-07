/**
 * Claude Usage Meter — workflow usage ledger (pure module).
 *
 * `daily.js` already records how much of the weekly limit you spend on each
 * calendar date, by watching the meter move. This records the part of that
 * spending a workflow run was responsible for, in the same units and the same
 * buckets, so the two can be divided one by the other: what share of your Claude
 * usage is going through workflows.
 *
 * The numerator is measured the same way as the denominator — the rise in the
 * 7-day meter across a step — so a step that ran while you were also working in
 * another tab counts that work too. It is usage *during* runs, not usage
 * provably *by* them, and every surface that shows it says so.
 *
 * Date strings ("YYYY-MM-DD", local) are supplied by the caller so this module
 * stays pure and testable.
 */
(function (root) {
  "use strict";

  const EMPTY = { days: {}, workflows: {} };
  const MAX_DAYS = 180; // same bound as daily.js, so the two stay comparable

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  // Fold one measured step in.
  //   r = { dateStr, pct, workflowId, workflowName }
  // `pct` is weekly-limit percentage points; a step whose window reset mid-way
  // reports null and must not be passed as a zero — that would claim we measured
  // it and found nothing.
  function observe(model, r) {
    const src = model || EMPTY;
    const m = {
      days: Object.assign({}, src.days || {}),
      workflows: Object.assign({}, src.workflows || {}),
    };
    if (!r || typeof r.pct !== "number" || !isFinite(r.pct) || r.pct < 0 || !r.dateStr) return m;

    m.days[r.dateStr] = round((m.days[r.dateStr] || 0) + r.pct);

    const id = r.workflowId || "unknown";
    const was = m.workflows[id] || { name: null, pct: 0, steps: 0 };
    m.workflows[id] = {
      // The name can change between runs — a workflow is renamed for the matter
      // in front of you — so the most recent one wins.
      name: r.workflowName || was.name || null,
      pct: round(was.pct + r.pct),
      steps: was.steps + 1,
    };

    const dates = Object.keys(m.days).sort(); // YYYY-MM-DD sorts chronologically
    if (dates.length > MAX_DAYS) {
      for (const d of dates.slice(0, dates.length - MAX_DAYS)) delete m.days[d];
    }
    return m;
  }

  // The N most recent dates ending at `todayStr`, newest last. Noon avoids the
  // DST edges, the same trick daily.js uses.
  function lastDates(todayStr, n) {
    const parts = String(todayStr).split("-");
    const y = +parts[0];
    const mo = +parts[1];
    const d = +parts[2];
    if (!(y > 0) || !(mo > 0) || !(d > 0) || !(n > 0)) return [];
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const dt = new Date(y, mo - 1, d - i, 12, 0, 0);
      out.push(
        dt.getFullYear() +
          "-" +
          String(dt.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(dt.getDate()).padStart(2, "0")
      );
    }
    return out;
  }

  // Workflow usage against total usage over the given dates.
  //   { workflow, total, share }  — share is 0..100, null when there's no total
  //     to divide by (nothing recorded yet, or a fresh install).
  // Clamped at 100: the two ledgers are fed by the same readings, but they're
  // written by different code paths and a rounding artefact shouldn't be allowed
  // to report that workflows used 101% of your usage.
  function share(model, dailyDays, dates) {
    const mine = (model && model.days) || {};
    const all = dailyDays || {};
    const list = dates && dates.length ? dates : Object.keys(all);
    let workflow = 0;
    let total = 0;
    for (const d of list) {
      workflow += mine[d] || 0;
      total += all[d] || 0;
    }
    return {
      workflow: round(workflow),
      total: round(total),
      share: total > 0 ? Math.min(100, round((workflow / total) * 100)) : null,
    };
  }

  // Which workflows that spending went to, biggest first. Names only — the
  // per-date detail isn't kept per workflow, so this is all-time.
  function byWorkflow(model) {
    const src = (model && model.workflows) || {};
    return Object.keys(src)
      .map((id) => Object.assign({ id: id }, src[id]))
      .filter((w) => w.pct > 0)
      .sort((a, b) => b.pct - a.pct);
  }

  const api = { EMPTY, observe, lastDates, share, byWorkflow, MAX_DAYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMWfUsage = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
