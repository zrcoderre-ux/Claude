"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const D = require("../src/daily.js");

const WR = 10000 * 60000; // a weekly-window resetAt
const WR2 = 20000 * 60000; // a later weekly window

function feed(readings) {
  let m = D.EMPTY;
  for (const r of readings) m = D.observe(m, r);
  return m;
}

test("observe attributes weekly increases to the reading's date", () => {
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, dateStr: "2026-07-13" }, // Mon, baseline
    { weeklyPct: 6, weeklyResetAt: WR, dateStr: "2026-07-13" }, // +6 Mon
    { weeklyPct: 10, weeklyResetAt: WR, dateStr: "2026-07-14" }, // +4 Tue
    { weeklyPct: 25, weeklyResetAt: WR, dateStr: "2026-07-14" }, // +15 Tue
  ]);
  assert.equal(Math.round(m.days["2026-07-13"]), 6);
  assert.equal(Math.round(m.days["2026-07-14"]), 19);
});

test("the first reading only sets a baseline", () => {
  const m = feed([{ weeklyPct: 40, weeklyResetAt: WR, dateStr: "2026-07-13" }]);
  assert.deepEqual(m.days, {});
});

test("a weekly reset re-baselines instead of counting a drop", () => {
  const m = feed([
    { weeklyPct: 90, weeklyResetAt: WR, dateStr: "2026-07-13" },
    { weeklyPct: 95, weeklyResetAt: WR, dateStr: "2026-07-13" }, // +5
    { weeklyPct: 3, weeklyResetAt: WR2, dateStr: "2026-07-14" }, // reset → skip
    { weeklyPct: 8, weeklyResetAt: WR2, dateStr: "2026-07-14" }, // +5
  ]);
  assert.equal(Math.round(m.days["2026-07-13"]), 5);
  assert.equal(Math.round(m.days["2026-07-14"]), 5);
});

test("backwards / flat moves are ignored", () => {
  const m = feed([
    { weeklyPct: 20, weeklyResetAt: WR, dateStr: "2026-07-13" },
    { weeklyPct: 20, weeklyResetAt: WR, dateStr: "2026-07-13" }, // flat
    { weeklyPct: 15, weeklyResetAt: WR, dateStr: "2026-07-13" }, // backwards
  ]);
  assert.deepEqual(m.days, {});
});

test("weekdayOf maps dates to local weekday (0=Sun)", () => {
  assert.equal(D.weekdayOf("2026-07-13"), 1); // Monday
  assert.equal(D.weekdayOf("2026-07-19"), 0); // Sunday
  assert.equal(D.weekdayOf("2026-07-18"), 6); // Saturday
});

test("summary averages by weekday and computes shares", () => {
  // Two Mondays (avg 10) and one Wednesday (20); other days none.
  const model = {
    days: {
      "2026-07-13": 8, // Mon
      "2026-07-20": 12, // Mon → avg 10
      "2026-07-15": 20, // Wed
    },
    lastW: null,
    wKey: null,
  };
  const s = D.summary(model);
  assert.equal(s.totalDays, 3);
  assert.equal(Math.round(s.avg[1]), 10); // Mon avg
  assert.equal(Math.round(s.avg[3]), 20); // Wed avg
  assert.equal(s.counts[1], 2);
  // Shares: Mon 10, Wed 20 → total 30 → Mon 33%, Wed 67%.
  assert.equal(Math.round(s.share[1]), 33);
  assert.equal(Math.round(s.share[3]), 67);
  assert.equal(Math.round(s.avgTotal), 30);
  // Untracked weekday → zeroes.
  assert.equal(s.avg[2], 0);
  assert.equal(s.share[2], 0);
});

test("summary on an empty model is safe", () => {
  const s = D.summary(null);
  assert.equal(s.totalDays, 0);
  assert.equal(s.avgTotal, 0);
});

test("observe bounds the number of stored dates", () => {
  let m = D.EMPTY;
  // 200 distinct dates, each getting a bump (needs two readings per date, but a
  // continuing weekly window across dates also works: each date adds a step).
  m = D.observe(m, { weeklyPct: 0, weeklyResetAt: WR, dateStr: "2026-01-01" });
  let w = 0;
  for (let i = 0; i < 200; i++) {
    const d = new Date(2026, 0, 2 + i, 12);
    const ds = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    w += 0.2;
    m = D.observe(m, { weeklyPct: w, weeklyResetAt: WR, dateStr: ds });
  }
  assert.ok(Object.keys(m.days).length <= D.MAX_DAYS, "dates=" + Object.keys(m.days).length);
});
