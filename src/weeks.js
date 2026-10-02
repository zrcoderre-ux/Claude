/**
 * Claude Usage Meter — the weekly ledger, by plan (pure module).
 *
 * claude.ai reports usage only as a percentage of the plan's OWN limit, so 40%
 * of a Max 20x week and 40% of a Max 5x week are different amounts of work, and
 * nothing the meter kept before this said which plan a reading came from. This
 * keeps one record per weekly window, tagged with the plan it was read under,
 * so two plans can be compared on numbers rather than on the price list.
 *
 * Each week records:
 *   - its PEAK — the weekly meter is cumulative within a window, so the last
 *     reading before the reset is the whole week's usage, however late in the
 *     week the watching started. What it can miss is the END: a week whose last
 *     reading came well before the reset is a floor, and is marked as one.
 *   - the paired rise of the session and weekly meters (sumS, sumW), which is
 *     the exchange rate between them: weekly %-points per full 5-hour session.
 *     Anthropic publishes the session limit as a multiple of Pro's (Max 5x is
 *     5×, Max 20x is 20×) and publishes nothing for the week, so the exchange
 *     rate is what turns a week into a unit both plans share — Pro sessions.
 *   - each 5-hour session's peak, so a Max 20x baseline can say how many of its
 *     sessions went past the point where Max 5x's session cap would have
 *     stopped them.
 *
 * Unlike src/predict.js, a reading where only the weekly meter ticked is still
 * paired: both meters count the same work, and dropping the readings where the
 * session meter happened not to cross an integer leaves the weekly side short.
 */
(function (root) {
  "use strict";

  const WEEK_MATCH_MS = 12 * 3600e3; // weekly resets this close are one window
  const SESSION_MATCH_MS = 3600e3; // 5-hour resets this close are one session
  const COMPLETE_TAIL_MS = 6 * 3600e3; // read this close to its end, a week's peak is its usage
  const STALE_PLAN_MS = 7 * 24 * 3600e3; // a plan not re-read in a week is said to be old
  const MAX_WEEKS = 104;
  const MAX_SESSIONS = 60; // a week holds at most ~34 five-hour windows
  const MIN_PAIRED_SESSION = 50; // session %-points paired before a rate is shown

  // Anthropic's published per-session multiples of the Pro plan.
  const MULTIPLE = { pro: 1, max_5x: 5, max_20x: 20 };
  const LABELS = {
    pro: "Pro",
    max: "Max (multiple unknown)",
    max_5x: "Max 5x",
    max_20x: "Max 20x",
    unknown: "Plan not recorded",
    mixed: "Plan changed mid-week",
  };

  const EMPTY = { weeks: [], last: null };

  function num(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  function planLabel(id) {
    if (!id) return LABELS.unknown;
    if (LABELS[id]) return LABELS[id];
    const m = /^max_(\d+)x$/.exec(id);
    return m ? "Max " + m[1] + "x" : String(id);
  }

  function multipleOf(id) {
    if (MULTIPLE[id]) return MULTIPLE[id];
    const m = /^max_(\d+)x$/.exec(id || "");
    return m ? +m[1] : null;
  }

  function copyWeek(w) {
    return Object.assign({}, w, {
      plans: Object.assign({}, w.plans || {}),
      sessions: (w.sessions || []).map((s) => Object.assign({}, s)),
    });
  }

  function near(a, b, tol) {
    return a != null && b != null && Math.abs(a - b) < tol;
  }

  // Fold one reading in. `r` = { at, weeklyPct (0..100), weeklyResetAt,
  // sessionPct, sessionResetAt, plan } — the session fields and plan optional.
  // A reading whose weekly reset has already passed is a leftover of the last
  // window and is ignored.
  function observe(model, r) {
    const src = model || EMPTY;
    const m = { weeks: (src.weeks || []).map(copyWeek), last: src.last || null };
    if (!r) return m;
    const at = num(r.at);
    const w = num(r.weeklyPct);
    const wReset = num(r.weeklyResetAt);
    if (at == null || w == null || w < 0 || w > 100 || wReset == null || wReset <= at) return m;
    const sPct = num(r.sessionPct);
    const sReset = num(r.sessionResetAt);
    const plan = typeof r.plan === "string" && r.plan ? r.plan : null;

    let week = m.weeks.find((x) => near(x.resetAt, wReset, WEEK_MATCH_MS));
    if (!week) {
      week = {
        resetAt: wReset,
        firstAt: at,
        firstPct: w,
        lastAt: at,
        peak: w,
        readings: 0,
        plans: {},
        sumS: 0,
        sumW: 0,
        sessions: [],
      };
      m.weeks.push(week);
    }
    week.resetAt = wReset; // the latest word on when it ends
    week.readings += 1;
    if (at < week.firstAt) {
      week.firstAt = at;
      week.firstPct = w;
    }
    if (at > week.lastAt) week.lastAt = at;
    if (w > week.peak) week.peak = w;
    if (plan) week.plans[plan] = (week.plans[plan] || 0) + 1;

    if (sPct != null && sPct >= 0 && sPct <= 100 && sReset != null) {
      const s = week.sessions.find((x) => near(x.resetAt, sReset, SESSION_MATCH_MS));
      if (s) {
        s.resetAt = sReset;
        if (sPct > s.peak) s.peak = sPct;
      } else {
        week.sessions.push({ resetAt: sReset, peak: sPct });
        if (week.sessions.length > MAX_SESSIONS) week.sessions.shift();
      }
    }

    const last = m.last;
    const inOrder = !last || !(at < last.at);
    if (
      last &&
      inOrder &&
      sPct != null &&
      last.sPct != null &&
      near(last.wReset, wReset, WEEK_MATCH_MS) &&
      near(last.sReset, sReset, SESSION_MATCH_MS) &&
      !(last.plan && plan && last.plan !== plan)
    ) {
      const dS = sPct - last.sPct;
      const dW = w - last.wPct;
      if (dS >= 0 && dW >= 0 && dS + dW > 0) {
        week.sumS += dS;
        week.sumW += dW;
      }
    }
    if (inOrder) m.last = { at, sPct, wPct: w, sReset, wReset, plan };

    m.weeks.sort((a, b) => a.resetAt - b.resetAt);
    if (m.weeks.length > MAX_WEEKS) m.weeks = m.weeks.slice(m.weeks.length - MAX_WEEKS);
    return m;
  }

  // The plan a week ran under: its one known plan, "mixed" when two appear,
  // "unknown" when none was recorded. Readings taken before the plan was first
  // read carry none, so they never make a week mixed.
  function planOfWeek(week) {
    const ids = Object.keys((week && week.plans) || {});
    if (!ids.length) return "unknown";
    return ids.length === 1 ? ids[0] : "mixed";
  }

  function median(xs) {
    if (!xs.length) return null;
    const s = xs.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // Every week with what it can be trusted for. A week has ENDED when its reset
  // has passed or a later window has been seen — Anthropic does reset a week
  // early now and then, and that week's own reset time never arrives. It is
  // COMPLETE when its last reading came within COMPLETE_TAIL_MS of that end, so
  // its peak is the week's usage rather than a floor; and SHORT when a later
  // window started well before its reset, so it wasn't a whole week.
  function describeWeeks(model, now) {
    const weeks = ((model && model.weeks) || []).slice().sort((a, b) => a.resetAt - b.resetAt);
    return weeks.map((wk, i) => {
      const next = weeks[i + 1] || null;
      const endAt = next ? Math.min(wk.resetAt, next.firstAt) : wk.resetAt;
      const ended = wk.resetAt <= now || !!next;
      const short = !!next && next.firstAt < wk.resetAt - WEEK_MATCH_MS;
      const tailMs = Math.max(0, endAt - wk.lastAt);
      const sessions = wk.sessions || [];
      return {
        resetAt: wk.resetAt,
        endAt,
        firstAt: wk.firstAt,
        lastAt: wk.lastAt,
        peak: wk.peak,
        readings: wk.readings,
        plan: planOfWeek(wk),
        ended,
        short,
        tailMs,
        complete: ended && !short && tailMs <= COMPLETE_TAIL_MS,
        sumS: wk.sumS || 0,
        sumW: wk.sumW || 0,
        perSession: wk.sumS >= MIN_PAIRED_SESSION ? (wk.sumW / wk.sumS) * 100 : null,
        sessions: sessions.length,
        sessionPeaks: sessions.map((s) => s.peak),
      };
    });
  }

  // Per plan: what a typical week used, the exchange rate, and the weekly
  // allowance in Pro sessions. Weeks under "unknown" or "mixed" are listed but
  // never compared — a week that can't say which limit it was measured against
  // can't be put beside one that can.
  function summary(model, now) {
    const weeks = describeWeeks(model, now);
    const byPlan = {};
    for (const wk of weeks) {
      const p = (byPlan[wk.plan] = byPlan[wk.plan] || {
        plan: wk.plan,
        label: planLabel(wk.plan),
        weeks: 0,
        ended: 0,
        complete: 0,
        peaks: [],
        sumS: 0,
        sumW: 0,
        sessionPeaks: [],
      });
      p.weeks += 1;
      if (wk.ended) p.ended += 1;
      if (wk.complete) {
        p.complete += 1;
        p.peaks.push(wk.peak);
      }
      p.sumS += wk.sumS;
      p.sumW += wk.sumW;
      p.sessionPeaks.push.apply(p.sessionPeaks, wk.sessionPeaks);
    }
    const plans = Object.keys(byPlan).map((id) => {
      const p = byPlan[id];
      const mult = id === "unknown" || id === "mixed" ? null : multipleOf(id);
      p.medianPeak = median(p.peaks);
      p.minPeak = p.peaks.length ? Math.min.apply(null, p.peaks) : null;
      p.maxPeak = p.peaks.length ? Math.max.apply(null, p.peaks) : null;
      p.perSession = p.sumS >= MIN_PAIRED_SESSION ? (p.sumW / p.sumS) * 100 : null;
      // Weekly allowance = (full sessions a week holds) × (Pro sessions per one).
      p.allowancePro = mult && p.perSession > 0 ? (100 / p.perSession) * mult : null;
      p.typicalPro =
        p.allowancePro != null && p.medianPeak != null ? (p.medianPeak / 100) * p.allowancePro : null;
      // Sessions that went past a smaller Max plan's whole session: on Max 20x,
      // a session above 25% is more than a Max 5x session holds. (Pro is the
      // unit, not a plan anyone here is weighing a move to.)
      p.sessionsPast = {};
      if (mult) {
        for (const q of Object.keys(MULTIPLE)) {
          if (q === "pro" || MULTIPLE[q] >= mult) continue;
          const cut = (MULTIPLE[q] / mult) * 100;
          p.sessionsPast[q] = { cut, count: p.sessionPeaks.filter((x) => x > cut).length };
        }
      }
      p.sessions = p.sessionPeaks.length;
      return p;
    });
    plans.sort((a, b) => (multipleOf(b.plan) || 0) - (multipleOf(a.plan) || 0));
    return { weeks, plans, compare: compare(plans) };
  }

  // The two plans with an allowance, side by side: how many times the larger
  // plan's week the smaller one's is, and what the larger plan's typical week
  // would be as a share of the smaller one's.
  function compare(plans) {
    const ready = plans.filter((p) => p.allowancePro != null);
    if (ready.length < 2) return null;
    const big = ready[0];
    const small = ready[ready.length - 1];
    if (big === small || !(small.allowancePro > 0)) return null;
    return {
      big: big.plan,
      small: small.plan,
      ratio: big.allowancePro / small.allowancePro,
      bigTypicalOfSmall:
        big.typicalPro != null ? (big.typicalPro / small.allowancePro) * 100 : null,
    };
  }

  // ---- The plan readings are tagged with -------------------------------
  // `cfg` (stored under cum_plan) = { auto: { id, raw, org, at } | null,
  // missAt, failAt, error, checkedAt, fallback }. `read` is what the page's
  // fetch of /api/organizations came back with: { ok: true, plan: {id,raw,org}
  // | null } or { ok: false, error }. A failed FETCH says nothing about the
  // plan and keeps the last one; a fetch that came back but named no plan is a
  // MISS, and from then on readings take the fallback — a remembered plan must
  // not go on tagging weeks after the page has stopped saying it.
  function notePlanRead(cfg, read, now) {
    const c = Object.assign({ auto: null, missAt: null, failAt: null, error: null, fallback: null }, cfg || {});
    c.checkedAt = now;
    if (!read || read.ok === false) {
      c.failAt = now;
      c.error = (read && read.error) || "no answer";
      return c;
    }
    c.failAt = null;
    c.error = null;
    const p = read.plan;
    if (p && typeof p.id === "string" && p.id) {
      c.auto = { id: p.id, raw: p.raw || null, org: p.org || null, at: now };
      c.missAt = null;
    } else {
      c.missAt = now;
    }
    return c;
  }

  function effectivePlan(cfg, now) {
    const c = cfg || {};
    const a = c.auto;
    if (a && a.id && !(c.missAt != null && c.missAt >= (a.at || 0))) {
      return { id: a.id, source: "auto", at: a.at, stale: now - (a.at || 0) > STALE_PLAN_MS };
    }
    if (c.fallback) return { id: c.fallback, source: "manual", at: null, stale: false };
    return { id: null, source: null, at: null, stale: false };
  }

  // ---- CSV -------------------------------------------------------------
  const CSV_HEADER = [
    "Week ending",
    "Plan",
    "Weekly usage %",
    "Complete",
    "Hours between last reading and week end",
    "Readings",
    "5-hour sessions seen",
    "Session peaks %",
    "Session %-points paired",
    "Weekly %-points paired",
    "Weekly % per full session",
  ];

  // `fmt(ms)` formats a timestamp; the caller supplies it so this stays pure.
  function csvRows(model, now, fmt) {
    const f = fmt || ((ms) => new Date(ms).toISOString());
    return describeWeeks(model, now).map((w) => [
      f(w.endAt),
      planLabel(w.plan),
      w.peak,
      !w.ended ? "in progress" : w.short ? "cut short" : w.complete ? "yes" : "at least",
      Math.round((w.tailMs / 3600e3) * 10) / 10,
      w.readings,
      w.sessions,
      w.sessionPeaks.join("; "),
      w.sumS,
      w.sumW,
      w.perSession == null ? "" : Math.round(w.perSession * 100) / 100,
    ]);
  }

  const api = {
    EMPTY,
    MULTIPLE,
    WEEK_MATCH_MS,
    SESSION_MATCH_MS,
    COMPLETE_TAIL_MS,
    STALE_PLAN_MS,
    MIN_PAIRED_SESSION,
    MAX_WEEKS,
    CSV_HEADER,
    observe,
    planOfWeek,
    planLabel,
    multipleOf,
    describeWeeks,
    summary,
    notePlanRead,
    effectivePlan,
    csvRows,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMWeeks = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
