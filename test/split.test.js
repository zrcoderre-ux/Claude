"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const S = require("../src/split.js");

const WR = 10000 * 60000;
const WR2 = 20000 * 60000;

function feed(readings) {
  let m = S.EMPTY;
  for (const r of readings) m = S.observe(m, r);
  return m;
}

test("observe attributes weekly increases to Home(chat) or Code by surface", () => {
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "chat" }, // baseline
    { weeklyPct: 10, weeklyResetAt: WR, surface: "chat" }, // +10 chat
    { weeklyPct: 16, weeklyResetAt: WR, surface: "code" }, // +6 code
    { weeklyPct: 20, weeklyResetAt: WR, surface: "code" }, // +4 code
  ]);
  assert.equal(Math.round(m.chat), 10);
  assert.equal(Math.round(m.code), 10);
});

test("explicit chatDelta/codeDelta split an increment (content-based attribution)", () => {
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "chat" },
    // A 20-pt gap attributed 12 to chat, 8 to code by content diffing.
    { weeklyPct: 20, weeklyResetAt: WR, surface: "chat", chatDelta: 12, codeDelta: 8 },
  ]);
  assert.equal(Math.round(m.chat), 12);
  assert.equal(Math.round(m.code), 8);
});

test("the first reading only baselines", () => {
  const m = feed([{ weeklyPct: 30, weeklyResetAt: WR, surface: "chat" }]);
  assert.equal(m.chat, 0);
  assert.equal(m.code, 0);
});

test("a weekly reset re-baselines rather than counting the drop", () => {
  const m = feed([
    { weeklyPct: 90, weeklyResetAt: WR, surface: "chat" },
    { weeklyPct: 95, weeklyResetAt: WR, surface: "chat" }, // +5 chat
    { weeklyPct: 4, weeklyResetAt: WR2, surface: "code" }, // reset → skip
    { weeklyPct: 9, weeklyResetAt: WR2, surface: "code" }, // +5 code
  ]);
  assert.equal(Math.round(m.chat), 5);
  assert.equal(Math.round(m.code), 5);
});

test("unknown/absent surface counts as chat", () => {
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR },
    { weeklyPct: 8, weeklyResetAt: WR }, // +8, no surface → chat
  ]);
  assert.equal(Math.round(m.chat), 8);
  assert.equal(m.code, 0);
});

test("share computes percentages", () => {
  const s = S.share({ chat: 30, code: 10 });
  assert.equal(s.total, 40);
  assert.equal(Math.round(s.chatPct), 75);
  assert.equal(Math.round(s.codePct), 25);
  const empty = S.share(null);
  assert.equal(empty.total, 0);
  assert.equal(empty.chatPct, 0);
});

test("the cap halves both sums while preserving the ratio", () => {
  let m = S.EMPTY;
  for (let i = 0; i < 1200; i++) {
    m = S.observe(m, { weeklyPct: 0, weeklyResetAt: WR + i * 60000, surface: "chat" });
    m = S.observe(m, { weeklyPct: 10, weeklyResetAt: WR + i * 60000, surface: i % 2 ? "code" : "chat" });
  }
  assert.ok(m.chat + m.code <= S.CAP * 1.05, "bounded: " + (m.chat + m.code));
  assert.ok(Math.abs(m.chat - m.code) / (m.chat + m.code) < 0.1, "ratio drifted");
});
