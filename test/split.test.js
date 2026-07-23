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

test("attributeGap sends a gap to Home when a chat was touched, else Code", () => {
  assert.deepEqual(S.attributeGap(12, true), { chatDelta: 12, codeDelta: 0 });
  assert.deepEqual(S.attributeGap(12, false), { chatDelta: 0, codeDelta: 12 });
  assert.deepEqual(S.attributeGap(0, true), { chatDelta: 0, codeDelta: 0 });
  assert.deepEqual(S.attributeGap(-5, false), { chatDelta: 0, codeDelta: 0 });
});

test("observe applies an explicit gap split and records the boundary time", () => {
  let m = S.observe(S.EMPTY, { weeklyPct: 40, weeklyResetAt: WR, surface: "chat", at: 1000 });
  assert.equal(m.lastAt, 1000);
  // A 10-pt gap attributed entirely to Code via content.
  m = S.observe(m, { weeklyPct: 50, weeklyResetAt: WR, chatDelta: 0, codeDelta: 10, at: 2000 });
  assert.equal(Math.round(m.code), 10);
  assert.equal(Math.round(m.chat), 0);
  assert.equal(m.lastAt, 2000);
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

test("live Home increments with learnTok teach a weekly-%-per-token rate", () => {
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "chat" },
    // +2 weekly% while Home grew by 1000 weighted tokens → rate 0.002 %/token.
    { weeklyPct: 2, weeklyResetAt: WR, surface: "chat", learnTok: 1000 },
    { weeklyPct: 5, weeklyResetAt: WR, surface: "chat", learnTok: 1500 },
  ]);
  // Cumulative: 5 weekly% over 2500 tokens → 0.002 %/token.
  assert.ok(Math.abs(S.rate(m) - 0.002) < 1e-9, "rate: " + S.rate(m));
});

test("rate is null before any learning; code increments don't teach it", () => {
  assert.equal(S.rate(S.EMPTY), null);
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "code" },
    { weeklyPct: 6, weeklyResetAt: WR, surface: "code", learnTok: 1000 },
  ]);
  assert.equal(S.rate(m), null); // only live Home increments learn
});

test("splitByContent apportions a both-used gap via the learned rate", () => {
  // Learn 0.002 %/token from live Home first.
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "chat" },
    { weeklyPct: 2, weeklyResetAt: WR, surface: "chat", learnTok: 1000 },
  ]);
  // A 10-pt gap where Home added 2000 weighted tokens → est chat = 2000*0.002 = 4.
  const parts = S.splitByContent(m, 10, 2000, true);
  assert.equal(Math.round(parts.chatDelta), 4);
  assert.equal(Math.round(parts.codeDelta), 6);
});

test("splitByContent caps chat at the whole gap and never goes negative", () => {
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "chat" },
    { weeklyPct: 2, weeklyResetAt: WR, surface: "chat", learnTok: 1000 },
  ]);
  // Estimated chat (huge content) exceeds the gap → clamp to the gap.
  const big = S.splitByContent(m, 5, 100000, true);
  assert.equal(Math.round(big.chatDelta), 5);
  assert.equal(Math.round(big.codeDelta), 0);
  // No content measured → all Home (binary fallback).
  const none = S.splitByContent(m, 5, 0, true);
  assert.equal(Math.round(none.chatDelta), 0);
  assert.equal(Math.round(none.codeDelta), 5);
});

test("splitByContent falls back to binary attribution without a learned rate", () => {
  assert.deepEqual(S.splitByContent(S.EMPTY, 8, 5000, true), { chatDelta: 8, codeDelta: 0 });
  assert.deepEqual(S.splitByContent(S.EMPTY, 8, 5000, false), { chatDelta: 0, codeDelta: 8 });
  assert.deepEqual(S.splitByContent(S.EMPTY, 0, 5000, true), { chatDelta: 0, codeDelta: 0 });
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
