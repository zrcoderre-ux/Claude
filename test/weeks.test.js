"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const W = require("../src/weeks.js");

const H = 3600e3;
const D = 24 * H;
const T0 = Date.UTC(2026, 8, 29, 8); // a week's start
const R1 = T0 + 7 * D; // ...its reset
const R2 = R1 + 7 * D; // the next week's

function feed(readings, model) {
  let m = model || W.EMPTY;
  for (const r of readings) m = W.observe(m, r);
  return m;
}

// A reading in week `wReset`, session `sReset`, at `at`.
function rd(at, w, s, sReset, wReset, plan) {
  return { at, weeklyPct: w, sessionPct: s, sessionResetAt: sReset, weeklyResetAt: wReset, plan };
}

test("a week keeps its peak, its first and its last reading", () => {
  const m = feed([
    rd(T0 + 2 * D, 12, 5, T0 + 2 * D + 5 * H, R1, "max_20x"),
    rd(T0 + 3 * D, 20, 30, T0 + 3 * D + 4 * H, R1, "max_20x"),
    rd(T0 + 4 * D, 31, 10, T0 + 4 * D + 4 * H, R1, "max_20x"),
  ]);
  assert.equal(m.weeks.length, 1);
  const wk = m.weeks[0];
  assert.equal(wk.peak, 31);
  assert.equal(wk.firstPct, 12);
  assert.equal(wk.firstAt, T0 + 2 * D);
  assert.equal(wk.lastAt, T0 + 4 * D);
  assert.equal(wk.readings, 3);
});

test("a reading whose weekly reset has passed is a leftover and is ignored", () => {
  const m = feed([rd(R1 + H, 40, 5, R1 + 3 * H, R1, "max_20x")]);
  assert.equal(m.weeks.length, 0);
});

test("a new reset is a new week; a reset that creeps by minutes is the same one", () => {
  const m = feed([
    rd(T0 + D, 10, 5, T0 + D + 4 * H, R1, "max_20x"),
    rd(T0 + 2 * D, 15, 5, T0 + 2 * D + 4 * H, R1 + 7 * 60e3, "max_20x"),
    rd(R1 + H, 2, 5, R1 + 5 * H, R2, "max_20x"),
  ]);
  assert.equal(m.weeks.length, 2);
  assert.equal(m.weeks[0].peak, 15);
  assert.equal(m.weeks[1].peak, 2);
});

test("readings are tagged by plan; a week under two plans is mixed", () => {
  const one = feed([rd(T0 + D, 10, 5, T0 + D + 4 * H, R1, "max_20x")]);
  assert.equal(W.planOfWeek(one.weeks[0]), "max_20x");
  const mixed = feed([rd(T0 + 2 * D, 20, 5, T0 + 2 * D + 4 * H, R1, "max_5x")], one);
  assert.equal(W.planOfWeek(mixed.weeks[0]), "mixed");
});

test("a reading taken before the plan was read doesn't make a week mixed", () => {
  const m = feed([
    rd(T0 + D, 10, 5, T0 + D + 4 * H, R1, null),
    rd(T0 + D + H, 11, 9, T0 + D + 4 * H, R1, "max_20x"),
  ]);
  assert.equal(W.planOfWeek(m.weeks[0]), "max_20x");
  assert.equal(W.planOfWeek(feed([rd(T0 + D, 10, 5, T0 + D + 4 * H, R1)]).weeks[0]), "unknown");
});

test("paired rises count a weekly tick the session meter didn't match", () => {
  const S = T0 + D + 4 * H;
  const m = feed([
    rd(T0 + D, 10, 20, S, R1, "max_20x"),
    rd(T0 + D + 300e3, 10, 23, S, R1, "max_20x"), // session only
    rd(T0 + D + 600e3, 11, 23, S, R1, "max_20x"), // weekly only — predict.js drops this
    rd(T0 + D + 900e3, 11, 23, S, R1, "max_20x"), // nothing moved
  ]);
  assert.equal(m.weeks[0].sumS, 3);
  assert.equal(m.weeks[0].sumW, 1);
});

test("no pairing across a session reset, a plan change, or a reading out of order", () => {
  const S1 = T0 + D + 4 * H;
  const S2 = T0 + D + 10 * H;
  let m = feed([
    rd(T0 + D, 10, 80, S1, R1, "max_20x"),
    rd(T0 + D + 6 * H, 14, 10, S2, R1, "max_20x"), // new session: not paired
  ]);
  assert.equal(m.weeks[0].sumS, 0);
  assert.equal(m.weeks[0].sumW, 0);
  m = feed([rd(T0 + D + 7 * H, 20, 40, S2, R1, "max_5x")], m); // plan changed: not paired
  assert.equal(m.weeks[0].sumS, 0);
  m = feed([rd(T0 + D + 6.5 * H, 15, 20, S2, R1, "max_5x")], m); // older than the last
  assert.equal(m.weeks[0].sumS, 0);
  assert.equal(m.last.at, T0 + D + 7 * H, "an out-of-order reading doesn't replace the last");
});

test("each 5-hour session is kept with its peak; a creeping reset is one session", () => {
  const S1 = T0 + D + 4 * H;
  const S2 = T0 + D + 10 * H;
  const m = feed([
    rd(T0 + D, 10, 12, S1, R1, "max_20x"),
    rd(T0 + D + H, 11, 31, S1 + 3 * 60e3, R1, "max_20x"),
    rd(T0 + D + 6 * H, 12, 8, S2, R1, "max_20x"),
  ]);
  assert.deepEqual(
    m.weeks[0].sessions.map((s) => s.peak),
    [31, 8]
  );
});

test("a week read close to its reset is complete; one read early is a floor", () => {
  const close = feed([rd(R1 - 2 * H, 40, 5, R1 + H, R1, "max_20x")]);
  const early = feed([rd(R1 - 10 * H, 40, 5, R1 - 7 * H, R1, "max_20x")]);
  const [c] = W.describeWeeks(close, R1 + H);
  const [e] = W.describeWeeks(early, R1 + H);
  assert.equal(c.complete, true);
  assert.equal(e.complete, false);
  assert.equal(e.ended, true);
  assert.equal(Math.round(e.tailMs / H), 10);
  // ...and a week still running is neither.
  const [live] = W.describeWeeks(close, R1 - H);
  assert.equal(live.ended, false);
  assert.equal(live.complete, false);
});

test("a week reset early by a later window is ended, short, and not complete", () => {
  const early = R1 - 3 * D; // a reset that came days ahead of schedule
  const m = feed([
    rd(early - 30 * 60e3, 30, 5, early + 4 * H, R1, "max_20x"),
    rd(early + 10 * 60e3, 0, 1, early + 5 * H, early + 7 * D, "max_20x"),
  ]);
  const [wk] = W.describeWeeks(m, early + H);
  assert.equal(wk.ended, true);
  assert.equal(wk.short, true);
  assert.equal(wk.complete, false);
});

// Max 20x: a full session costs 5 weekly %-points → 20 full sessions a week,
// 20 Pro sessions each → 400. Max 5x: a full session costs 10 → 10 × 5 = 50.
function twoPlans() {
  const SA = T0 + D + 4 * H;
  const SB = R1 + 2 * H;
  const SC = R1 + D + 4 * H;
  return feed([
    rd(T0 + D, 0, 0, SA, R1, "max_20x"),
    rd(T0 + D + H, 2, 50, SA, R1, "max_20x"),
    rd(T0 + D + 2 * H, 5, 100, SA, R1, "max_20x"),
    rd(R1 - H, 5, 10, SB, R1, "max_20x"),
    rd(R1 + D, 0, 0, SC, R2, "max_5x"),
    rd(R1 + D + 3 * H, 10, 100, SC, R2, "max_5x"),
    rd(R2 - 2 * H, 10, 0, R2 + 3 * H, R2, "max_5x"),
  ]);
}

test("summary: the exchange rate and the weekly allowance in Pro sessions", () => {
  const s = W.summary(twoPlans(), R2 + H);
  const big = s.plans.find((p) => p.plan === "max_20x");
  const small = s.plans.find((p) => p.plan === "max_5x");
  assert.equal(big.perSession, 5);
  assert.equal(big.allowancePro, 400);
  assert.equal(big.medianPeak, 5);
  assert.equal(big.typicalPro, 20);
  assert.equal(small.perSession, 10);
  assert.equal(small.allowancePro, 50);
  assert.equal(s.compare.big, "max_20x");
  assert.equal(s.compare.small, "max_5x");
  assert.equal(s.compare.ratio, 8);
  assert.equal(s.compare.bigTypicalOfSmall, 40);
});

test("summary: Max 20x sessions past a quarter would have outrun a Max 5x session", () => {
  const s = W.summary(twoPlans(), R2 + H);
  const big = s.plans.find((p) => p.plan === "max_20x");
  assert.equal(big.sessionsPast.max_5x.cut, 25);
  assert.equal(big.sessionsPast.max_5x.count, 1); // the 100% one, not the 10% one
  assert.equal(big.sessions, 2);
});

test("summary: only complete weeks set the typical week", () => {
  const m = feed([
    rd(R1 - 10 * H, 60, 5, R1 - 7 * H, R1, "max_20x"), // a floor
    rd(R2 - H, 30, 5, R2 + 2 * H, R2, "max_20x"), // complete
  ]);
  const [p] = W.summary(m, R2 + H).plans;
  assert.equal(p.ended, 2);
  assert.equal(p.complete, 1);
  assert.equal(p.medianPeak, 30);
});

test("summary: no rate until enough of a session has been paired", () => {
  const S = T0 + D + 4 * H;
  const m = feed([rd(T0 + D, 0, 0, S, R1, "max_20x"), rd(T0 + D + H, 1, 20, S, R1, "max_20x")]);
  const [p] = W.summary(m, R1 + H).plans;
  assert.equal(p.perSession, null);
  assert.equal(p.allowancePro, null);
});

test("summary: an unknown or mixed week is listed but never compared", () => {
  const S = T0 + D + 4 * H;
  const m = feed([
    rd(T0 + D, 0, 0, S, R1, null),
    rd(T0 + D + H, 5, 100, S, R1, null),
  ]);
  const s = W.summary(m, R1 + H);
  assert.equal(s.plans[0].plan, "unknown");
  assert.equal(s.plans[0].allowancePro, null);
  assert.equal(s.compare, null);
});

test("the ledger is bounded", () => {
  let m = W.EMPTY;
  for (let i = 0; i < W.MAX_WEEKS + 5; i++) {
    const r = T0 + (i + 1) * 7 * D;
    m = W.observe(m, rd(r - D, 10, 5, r - D + 4 * H, r, "max_20x"));
  }
  assert.equal(m.weeks.length, W.MAX_WEEKS);
  assert.equal(m.weeks[0].resetAt, T0 + 6 * 7 * D);
});

test("observe doesn't touch the model it was given", () => {
  const m = feed([rd(T0 + D, 10, 5, T0 + D + 4 * H, R1, "max_20x")]);
  const before = JSON.stringify(m);
  W.observe(m, rd(T0 + D + H, 12, 9, T0 + D + 4 * H, R1, "max_20x"));
  assert.equal(JSON.stringify(m), before);
});

// ---- the plan readings are tagged with ---------------------------------
test("a plan read from the page is the plan", () => {
  const c = W.notePlanRead({}, { ok: true, plan: { id: "max_20x", raw: "default_claude_max_20x", org: "o" } }, 1000);
  assert.deepEqual(W.effectivePlan(c, 2000), { id: "max_20x", source: "auto", at: 1000, stale: false });
});

test("a failed fetch keeps the last plan; a fetch naming none drops to the fallback", () => {
  let c = W.notePlanRead({ fallback: "max_5x" }, { ok: true, plan: { id: "max_20x" } }, 1000);
  c = W.notePlanRead(c, { ok: false, error: "HTTP 503" }, 2000);
  assert.equal(W.effectivePlan(c, 2000).id, "max_20x");
  assert.equal(c.error, "HTTP 503");
  c = W.notePlanRead(c, { ok: true, plan: null }, 3000);
  assert.deepEqual(W.effectivePlan(c, 3000), { id: "max_5x", source: "manual", at: null, stale: false });
  c = W.notePlanRead(c, { ok: true, plan: { id: "max_5x" } }, 4000);
  assert.equal(W.effectivePlan(c, 4000).source, "auto");
});

test("no plan and no fallback tags nothing; an old plan says it's old", () => {
  assert.equal(W.effectivePlan({}, 1).id, null);
  const c = W.notePlanRead({}, { ok: true, plan: { id: "max_20x" } }, 0);
  assert.equal(W.effectivePlan(c, W.STALE_PLAN_MS + 1).stale, true);
});

test("plan labels", () => {
  assert.equal(W.planLabel("max_20x"), "Max 20x");
  assert.equal(W.planLabel("max_5x"), "Max 5x");
  assert.equal(W.planLabel("max_40x"), "Max 40x");
  assert.equal(W.planLabel(null), "Plan not recorded");
  assert.equal(W.multipleOf("max_40x"), 40);
  assert.equal(W.multipleOf("max"), null);
});

test("csvRows: one row per week, as wide as the header", () => {
  const rows = W.csvRows(twoPlans(), R2 + H, () => "when");
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.length, W.CSV_HEADER.length);
  assert.deepEqual(rows[0].slice(0, 4), ["when", "Max 20x", 5, "yes"]);
  assert.equal(rows[0][10], 5);
  assert.equal(rows[1][1], "Max 5x");
});

test("summary: Pro is the unit, not a plan sessions are measured against", () => {
  const s = W.summary(twoPlans(), R2 + H);
  const big = s.plans.find((p) => p.plan === "max_20x");
  assert.deepEqual(Object.keys(big.sessionsPast), ["max_5x"]);
});
