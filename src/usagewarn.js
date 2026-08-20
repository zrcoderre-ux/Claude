/**
 * Claude Usage Meter — usage-pace warnings (pure module).
 *
 * Two questions, one module:
 *
 *   1. "Am I burning through today's share of the week?" The weekly limit is a
 *      week's worth of usage; spent evenly it's 1/7 of it a day. Every day the
 *      day's own consumption crosses that share — and again at each further
 *      whole multiple of it, because a day that spends triple its share is
 *      worth hearing about twice — a warning fires.
 *   2. "How much of the week is gone?" Warnings at 50%, 75% and 90% of the
 *      weekly limit, once each per weekly window.
 *
 * The day's consumption comes from src/daily.js, which already attributes each
 * rise in the weekly meter to the calendar day it happened on. Both readings
 * are therefore in the same unit throughout: weekly-limit percentage POINTS.
 *
 * Firing state lives with the background worker (one per browser) rather than
 * per tab, so three open claude.ai tabs produce one notification, not three.
 * This module holds the decision; nothing here touches storage, the DOM, or
 * `chrome`.
 */
(function (root) {
  "use strict";

  // Weekly milestones, ascending. Each fires once per weekly window.
  const MARKS = [50, 75, 90];
  // An even split of the weekly limit across the seven days of the window.
  const DEFAULT_SHARE = 100 / 7;
  // A share below this would turn "each further multiple" into a firehose.
  const MIN_SHARE = 1;
  // ...and even a sane share gets a ceiling on how often one day may warn.
  const MAX_DAILY_STEPS = 10;
  // A fired mark re-arms once the meter has fallen this far back below it, so a
  // weekly window that rolled without telling us its new reset time still warns.
  const REARM_GAP = 1;
  // At or above this mark the pill stays up; anything lesser is shown briefly
  // and then gets out of the way (see standing().sticky).
  const STICKY_MARK = 75;

  const EMPTY = {
    wKey: null, // weekly window the fired marks belong to
    marks: [], // weekly marks already warned about in that window
    dayKey: null, // date ("YYYY-MM-DD") the daily count belongs to
    daySteps: 0, // how many whole daily shares that day has already warned at
  };

  function keyOf(resetAt) {
    return resetAt == null ? null : Math.round(resetAt / 60000);
  }

  /** The daily share, in weekly %-points: the configured one, or an even 1/7. */
  function shareOf(cfg) {
    const v = cfg && cfg.dailyShare;
    if (typeof v !== "number" || !isFinite(v) || !(v > 0) || v > 100) return DEFAULT_SHARE;
    return Math.max(MIN_SHARE, v);
  }

  // Weekly %-points, to a tenth — but only where the tenth says something. A
  // share of 14.3 and a day at 14.4 both rounding to "14%" would make the
  // warning read as though nothing had been crossed.
  function fmtPts(n) {
    if (n == null || !isFinite(n)) return "—";
    const v = Math.round(n * 10) / 10;
    return (v === Math.round(v) ? String(Math.round(v)) : v.toFixed(1)) + "%";
  }

  function dailyWarning(step, todayPct, share) {
    const over =
      step === 1
        ? "past your daily share of the weekly limit"
        : "more than " + step + "× your daily share of the weekly limit";
    return {
      kind: "daily",
      step: step,
      mark: null,
      level: step > 1 ? "danger" : "warn",
      pct: todayPct,
      share: share,
      title: step === 1 ? "Past your daily share" : step + "× your daily share",
      message:
        "Today has used " +
        fmtPts(todayPct) +
        " of your weekly limit — " +
        over +
        " (" +
        fmtPts(share) +
        " a day).",
    };
  }

  function weeklyWarning(mark, weeklyPct, resetText) {
    return {
      kind: "weekly",
      step: null,
      mark: mark,
      level: mark >= 90 ? "danger" : "warn",
      pct: weeklyPct,
      share: null,
      title: "Weekly usage past " + mark + "%",
      message:
        "You've used " +
        fmtPts(weeklyPct) +
        " of your weekly limit" +
        (resetText ? ", which resets in " + resetText : "") +
        ".",
    };
  }

  /**
   * Which warnings this reading has just earned, and the state to store back.
   *
   * `r` = { weeklyPct (0..100), todayPct (0..100, weekly %-points spent today),
   *         dateStr ("YYYY-MM-DD", local), weeklyResetAt (ms), resetText }
   *
   * Returns { state, fire: [warning, ...] } — `fire` is empty on the ordinary
   * reading, which is nearly all of them.
   */
  function due(state, r, cfg) {
    const src = state || EMPTY;
    const st = {
      wKey: src.wKey == null ? null : src.wKey,
      marks: (src.marks || []).slice(),
      dayKey: src.dayKey || null,
      daySteps: src.daySteps || 0,
    };
    const fire = [];
    if (!r) return { state: st, fire: fire };
    const share = shareOf(cfg);

    // ---- the day's share ------------------------------------------------
    // A new date starts a fresh day at zero warnings: "every time I cross my
    // daily share" is once a day at minimum, however the week is going.
    if (r.dateStr && r.dateStr !== st.dayKey) {
      st.dayKey = r.dateStr;
      st.daySteps = 0;
    }
    if (r.dateStr && r.todayPct != null && isFinite(r.todayPct)) {
      const steps = Math.min(MAX_DAILY_STEPS, Math.floor(r.todayPct / share));
      if (steps > st.daySteps) {
        // Several shares at once (a big reading after a long gap) is still one
        // warning — the highest — rather than a stack of them.
        st.daySteps = steps;
        fire.push(dailyWarning(steps, r.todayPct, share));
      }
    }

    // ---- the week's milestones ------------------------------------------
    if (r.weeklyPct != null && isFinite(r.weeklyPct)) {
      const wKey = keyOf(r.weeklyResetAt);
      if (wKey !== st.wKey) {
        st.marks = [];
        st.wKey = wKey;
      }
      // A meter that has dropped well below a mark it once crossed is a window
      // that rolled; re-arm rather than staying quiet for the new week.
      st.marks = st.marks.filter((m) => r.weeklyPct >= m - REARM_GAP);
      let top = null;
      for (const m of MARKS) {
        if (r.weeklyPct < m) continue;
        if (st.marks.indexOf(m) === -1) {
          st.marks.push(m);
          top = m; // MARKS ascends, so this ends on the highest new one
        }
      }
      st.marks.sort((a, b) => a - b);
      if (top != null) fire.push(weeklyWarning(top, r.weeklyPct, r.resetText));
    }

    return { state: st, fire: fire };
  }

  // How loud each standing condition is, for picking the one the pill shows.
  function weeklyStanding(mark, weeklyPct) {
    return {
      kind: "weekly",
      mark: mark,
      step: null,
      level: mark >= 90 ? "danger" : mark >= 75 ? "warn" : "info",
      rank: mark >= 90 ? 4 : mark >= 75 ? 3 : 1,
      sticky: mark >= STICKY_MARK,
      label: "Weekly " + fmtPts(weeklyPct),
      detail: "You've used " + fmtPts(weeklyPct) + " of your weekly limit.",
    };
  }

  function dailyStanding(step, todayPct, share) {
    return {
      kind: "daily",
      mark: null,
      step: step,
      level: step > 1 ? "danger" : "warn",
      rank: 2,
      sticky: false,
      label: "Today " + fmtPts(todayPct),
      detail:
        "Today has used " +
        fmtPts(todayPct) +
        " of your weekly limit; your daily share is " +
        fmtPts(share) +
        ".",
    };
  }

  /**
   * What the pill should say RIGHT NOW, independent of what has already fired:
   * the loudest condition this reading meets, or null when none does. The
   * weekly milestones outrank the day's share except at 50%, where a day
   * already over its share is the more useful thing to say.
   */
  function standing(r, cfg) {
    if (!r) return null;
    const share = shareOf(cfg);
    let best = null;
    const take = (c) => {
      if (!best || c.rank > best.rank) best = c;
    };
    if (r.weeklyPct != null && isFinite(r.weeklyPct)) {
      for (const m of MARKS) if (r.weeklyPct >= m) take(weeklyStanding(m, r.weeklyPct));
    }
    if (r.todayPct != null && isFinite(r.todayPct) && r.todayPct >= share) {
      take(dailyStanding(Math.min(MAX_DAILY_STEPS, Math.floor(r.todayPct / share)), r.todayPct, share));
    }
    return best;
  }

  const api = {
    EMPTY,
    MARKS,
    DEFAULT_SHARE,
    MIN_SHARE,
    MAX_DAILY_STEPS,
    STICKY_MARK,
    REARM_GAP,
    shareOf,
    fmtPts,
    due,
    standing,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMUsageWarn = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
