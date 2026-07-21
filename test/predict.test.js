"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const P = require("../src/predict.js");

const SR = 100 * 60000; // a session-window resetAt
const SR2 = 200 * 60000; // a later session window
const WR = 10000 * 60000; // a weekly-window resetAt
const WR2 = 20000 * 60000;

function feed(readings) {
  let m = P.EMPTY;
  for (const r of readings) m = P.observe(m, r);
  return m;
}

test("observe accumulates forward increments within the same windows", () => {
  const m = feed([
    { sessionPct: 0, weeklyPct: 0, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 50, weeklyPct: 5, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 100, weeklyPct: 10, sessionResetAt: SR, weeklyResetAt: WR },
  ]);
  assert.equal(m.sumS, 100);
  assert.equal(m.sumW, 10);
  assert.equal(m.samples, 2); // first reading only sets the baseline
});

test("the first reading never counts (no prior baseline)", () => {
  const m = feed([{ sessionPct: 30, weeklyPct: 3, sessionResetAt: SR, weeklyResetAt: WR }]);
  assert.equal(m.samples, 0);
  assert.equal(m.sumS, 0);
});

test("a session reset re-baselines rather than counting a drop", () => {
  const m = feed([
    { sessionPct: 0, weeklyPct: 0, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 100, weeklyPct: 10, sessionResetAt: SR, weeklyResetAt: WR }, // dS100 dW10
    { sessionPct: 0, weeklyPct: 10, sessionResetAt: SR2, weeklyResetAt: WR }, // new session → skip
    { sessionPct: 40, weeklyPct: 14, sessionResetAt: SR2, weeklyResetAt: WR }, // dS40 dW4
  ]);
  assert.equal(m.sumS, 140);
  assert.equal(m.sumW, 14);
  assert.equal(m.samples, 2);
});

test("a weekly reset re-baselines too", () => {
  const m = feed([
    { sessionPct: 0, weeklyPct: 90, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 50, weeklyPct: 95, sessionResetAt: SR, weeklyResetAt: WR }, // dS50 dW5
    { sessionPct: 60, weeklyPct: 0, sessionResetAt: SR, weeklyResetAt: WR2 }, // weekly reset → skip
    { sessionPct: 80, weeklyPct: 2, sessionResetAt: SR, weeklyResetAt: WR2 }, // dS20 dW2
  ]);
  assert.equal(m.sumS, 70);
  assert.equal(m.sumW, 7);
});

test("backwards / zero / negative moves are ignored", () => {
  const m = feed([
    { sessionPct: 50, weeklyPct: 5, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 50, weeklyPct: 5, sessionResetAt: SR, weeklyResetAt: WR }, // dS0 → skip
    { sessionPct: 40, weeklyPct: 5, sessionResetAt: SR, weeklyResetAt: WR }, // dS<0 → skip
    { sessionPct: 90, weeklyPct: 4, sessionResetAt: SR, weeklyResetAt: WR }, // dW<0 → skip
  ]);
  assert.equal(m.samples, 0);
});

test("estimate is not ready until there is enough data", () => {
  assert.equal(P.estimate(P.EMPTY, 0).ready, false);
  const thin = feed([
    { sessionPct: 0, weeklyPct: 0, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 5, weeklyPct: 1, sessionResetAt: SR, weeklyResetAt: WR },
  ]);
  assert.equal(P.estimate(thin, 1).ready, false); // sumS=5 < MIN_SESSION_OBSERVED
});

test("estimate predicts remaining maxed sessions from the learned ratio", () => {
  // Two full sessions cost 10 weekly% each → 10 sessions per week.
  const m = feed([
    { sessionPct: 0, weeklyPct: 0, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 50, weeklyPct: 2.5, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 100, weeklyPct: 5, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 0, weeklyPct: 5, sessionResetAt: SR2, weeklyResetAt: WR },
    { sessionPct: 100, weeklyPct: 10, sessionResetAt: SR2, weeklyResetAt: WR },
  ]);
  const est = P.estimate(m, 20);
  assert.equal(est.ready, true);
  assert.ok(Math.abs(est.perFull - 5) < 1e-9, "perFull=" + est.perFull);
  assert.ok(Math.abs(est.total - 20) < 1e-9, "total=" + est.total);
  assert.ok(Math.abs(est.remaining - 16) < 1e-9, "remaining=" + est.remaining);
});

test("remaining floors at zero when the weekly window is spent", () => {
  const m = feed([
    { sessionPct: 0, weeklyPct: 0, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 50, weeklyPct: 5, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 100, weeklyPct: 10, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 0, weeklyPct: 10, sessionResetAt: SR2, weeklyResetAt: WR },
    { sessionPct: 100, weeklyPct: 20, sessionResetAt: SR2, weeklyResetAt: WR },
  ]);
  const est = P.estimate(m, 100);
  assert.equal(est.ready, true);
  assert.equal(est.remaining, 0);
});

test("weeklyBindingUsage maps the weekly budget onto the 5-hour scale", () => {
  // Learn 10 weekly% per full session (two full sessions cost 5% each... use
  // the clean rate: 200 session%-points → 20 weekly%-points → 10%/session).
  const m = feed([
    { sessionPct: 0, weeklyPct: 0, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 50, weeklyPct: 2.5, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 100, weeklyPct: 5, sessionResetAt: SR, weeklyResetAt: WR },
    { sessionPct: 0, weeklyPct: 5, sessionResetAt: SR2, weeklyResetAt: WR },
    { sessionPct: 100, weeklyPct: 10, sessionResetAt: SR2, weeklyResetAt: WR },
  ]); // perFull = 5 weekly% per full session

  // Weekly at 97.5% → 2.5 left → 0.5 sessions remaining → shows 50%.
  const half = P.weeklyBindingUsage(m, 97.5);
  assert.ok(Math.abs(half - 0.5) < 1e-9, "half=" + half);

  // Weekly exhausted → 100%.
  assert.equal(P.weeklyBindingUsage(m, 100), 1);

  // Plenty of weekly left (≥ a full session) → not binding → null.
  assert.equal(P.weeklyBindingUsage(m, 50), null); // 50/5 = 10 sessions left

  // Exactly one session left is the boundary → not binding.
  assert.equal(P.weeklyBindingUsage(m, 95), null); // 5/5 = 1 session

  // Just under a session left → binding.
  const near = P.weeklyBindingUsage(m, 96); // 4/5 = 0.8 → 0.2 used
  assert.ok(Math.abs(near - 0.2) < 1e-9, "near=" + near);
});

test("weeklyBindingUsage is null before the model is ready", () => {
  assert.equal(P.weeklyBindingUsage(P.EMPTY, 99), null);
});

test("the cap halves the sums while preserving the ratio", () => {
  let m = P.EMPTY;
  // Drive many increments to exceed CAP; keep a constant 2:1 (session:weekly).
  for (let i = 0; i < 400; i++) {
    m = P.observe(m, { sessionPct: 0, weeklyPct: 0, sessionResetAt: SR + i * 60000, weeklyResetAt: WR });
    m = P.observe(m, { sessionPct: 20, weeklyPct: 10, sessionResetAt: SR + i * 60000, weeklyResetAt: WR });
  }
  assert.ok(m.sumS <= P.CAP * 1.05, "sumS bounded: " + m.sumS);
  assert.ok(Math.abs(m.sumW / m.sumS - 0.5) < 1e-9, "ratio preserved: " + m.sumW / m.sumS);
});
