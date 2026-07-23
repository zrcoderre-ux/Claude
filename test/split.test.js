"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const S = require("../src/split.js");

const WR = 10000 * 60000;
const WR2 = 20000 * 60000;
const T0 = 1_000_000_000_000; // a base timestamp
const MIN = 60 * 1000;

// Helper: readings spaced 1 minute apart (well within GAP_MS), foreground.
function live(readings) {
  let m = S.EMPTY;
  readings.forEach((r, i) => {
    m = S.observe(m, Object.assign({ at: T0 + i * MIN, visible: true }, r));
  });
  return m;
}

test("observe attributes live weekly increases to chat or code by surface", () => {
  const m = live([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "chat" }, // baseline
    { weeklyPct: 10, weeklyResetAt: WR, surface: "chat" }, // +10 chat
    { weeklyPct: 16, weeklyResetAt: WR, surface: "code" }, // +6 code
    { weeklyPct: 20, weeklyResetAt: WR, surface: "code" }, // +4 code
  ]);
  assert.equal(Math.round(m.chat), 10);
  assert.equal(Math.round(m.code), 10);
  assert.equal(Math.round(m.away), 0);
});

test("a jump after a long gap counts as away (mobile / other)", () => {
  let m = S.EMPTY;
  m = S.observe(m, { weeklyPct: 20, weeklyResetAt: WR, surface: "chat", at: T0, visible: true });
  // 30 minutes later the meter has jumped 15 pts while we weren't watching.
  m = S.observe(m, { weeklyPct: 35, weeklyResetAt: WR, surface: "chat", at: T0 + 30 * MIN, visible: true });
  assert.equal(Math.round(m.away), 15);
  assert.equal(Math.round(m.chat), 0);
  // The next live increment counts to the surface again.
  m = S.observe(m, { weeklyPct: 40, weeklyResetAt: WR, surface: "chat", at: T0 + 31 * MIN, visible: true });
  assert.equal(Math.round(m.chat), 5);
});

test("a jump seen by a hidden (background) tab counts as away", () => {
  let m = S.EMPTY;
  m = S.observe(m, { weeklyPct: 10, weeklyResetAt: WR, surface: "code", at: T0, visible: true });
  m = S.observe(m, { weeklyPct: 18, weeklyResetAt: WR, surface: "code", at: T0 + MIN, visible: false });
  assert.equal(Math.round(m.away), 8);
  assert.equal(Math.round(m.code), 0);
});

test("the first reading only baselines", () => {
  const m = live([{ weeklyPct: 30, weeklyResetAt: WR, surface: "chat" }]);
  assert.equal(m.chat, 0);
  assert.equal(m.code, 0);
  assert.equal(m.away, 0);
});

test("a weekly reset re-baselines rather than counting the drop", () => {
  const m = live([
    { weeklyPct: 90, weeklyResetAt: WR, surface: "chat" },
    { weeklyPct: 95, weeklyResetAt: WR, surface: "chat" }, // +5 chat
    { weeklyPct: 4, weeklyResetAt: WR2, surface: "code" }, // reset → skip
    { weeklyPct: 9, weeklyResetAt: WR2, surface: "code" }, // +5 code
  ]);
  assert.equal(Math.round(m.chat), 5);
  assert.equal(Math.round(m.code), 5);
});

test("unknown/absent surface counts as chat when live", () => {
  const m = live([
    { weeklyPct: 0, weeklyResetAt: WR },
    { weeklyPct: 8, weeklyResetAt: WR }, // +8, no surface → chat
  ]);
  assert.equal(Math.round(m.chat), 8);
  assert.equal(m.code, 0);
});

test("share computes percentages across chat / code / away", () => {
  const s = S.share({ chat: 30, code: 10, away: 10 });
  assert.equal(s.total, 50);
  assert.equal(Math.round(s.chatPct), 60);
  assert.equal(Math.round(s.codePct), 20);
  assert.equal(Math.round(s.awayPct), 20);
  const empty = S.share(null);
  assert.equal(empty.total, 0);
  assert.equal(empty.chatPct, 0);
});

test("the cap halves all sums while preserving the ratio", () => {
  let m = S.EMPTY;
  for (let i = 0; i < 1200; i++) {
    m = S.observe(m, { weeklyPct: 0, weeklyResetAt: WR + i * MIN, surface: "chat", at: T0 + 2 * i * MIN, visible: true });
    m = S.observe(m, { weeklyPct: 10, weeklyResetAt: WR + i * MIN, surface: i % 2 ? "code" : "chat", at: T0 + (2 * i + 1) * MIN, visible: true });
  }
  assert.ok(m.chat + m.code + m.away <= S.CAP * 1.05, "bounded: " + (m.chat + m.code + m.away));
  assert.ok(Math.abs(m.chat - m.code) / (m.chat + m.code) < 0.1, "ratio drifted");
});
