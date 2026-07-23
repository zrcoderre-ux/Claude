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

test("weekActual pulls the current Tuesday-start week's per-day usage", () => {
  // 2026-07-23 is a Thursday. Week starting Tuesday (dow 2) = 2026-07-21.
  const model = {
    days: {
      "2026-07-21": 5, // Tue (this week)
      "2026-07-22": 8, // Wed (this week)
      "2026-07-23": 3, // Thu (this week, = ref day)
      "2026-07-20": 99, // Mon — previous week, must be excluded
      "2026-07-24": 99, // Fri — future this week, excluded (after ref)
    },
  };
  const w = D.weekActual(model, "2026-07-23", 2);
  assert.equal(w.weekStart, "2026-07-21");
  assert.equal(w.actual[2], 5); // Tue
  assert.equal(w.actual[3], 8); // Wed
  assert.equal(w.actual[4], 3); // Thu
  assert.equal(w.actual[1], 0); // Mon not part of this week
  assert.equal(w.total, 16); // 5+8+3, prior/future excluded
  // Days that have occurred this week are present; future ones are not.
  assert.equal(w.present[2], true); // Tue
  assert.equal(w.present[4], true); // Thu (ref day)
  assert.equal(w.present[5], false); // Fri hasn't happened yet
  assert.equal(w.present[1], false); // Mon (next week)
});

test("weekAverageToDate sums daily averages only through the current day", () => {
  // Build averages: Tue avg 5, Wed avg 8, Thu avg 3 (one sample each), plus a
  // Fri sample that must NOT count when today is Thursday.
  const model = {
    days: {
      "2026-06-16": 5, // Tue
      "2026-06-17": 8, // Wed
      "2026-06-18": 3, // Thu
      "2026-06-19": 20, // Fri (future relative to a Thursday ref)
    },
  };
  // Ref is a Thursday → elapsed weekdays this week: Tue, Wed, Thu.
  const toDate = D.weekAverageToDate(model, "2026-07-23", 2); // 2026-07-23 = Thu
  assert.ok(Math.abs(toDate - (5 + 8 + 3)) < 1e-9, "avgToDate=" + toDate); // Fri excluded
  // On a Tuesday ref, only Tuesday counts.
  const tueOnly = D.weekAverageToDate(model, "2026-07-21", 2); // 2026-07-21 = Tue
  assert.ok(Math.abs(tueOnly - 5) < 1e-9, "tueOnly=" + tueOnly);
});

test("weekActual when today IS the week start (Tuesday)", () => {
  const model = { days: { "2026-07-21": 4 } };
  const w = D.weekActual(model, "2026-07-21", 2);
  assert.equal(w.weekStart, "2026-07-21");
  assert.equal(w.total, 4);
  assert.equal(w.present[2], true);
  assert.equal(w.present[3], false); // Wed not yet
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
