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

test("attributeGap sends a gap to chat when one was touched, else Cowork-or-Code", () => {
  const E = S.EMPTY;
  assert.deepEqual(S.attributeGap(E, 12, true), { chatDelta: 12, coworkDelta: 0, codeDelta: 0 });
  assert.deepEqual(S.attributeGap(E, 12, false), { chatDelta: 0, coworkDelta: 0, codeDelta: 12 });
  assert.deepEqual(S.attributeGap(E, 0, true), { chatDelta: 0, coworkDelta: 0, codeDelta: 0 });
  assert.deepEqual(S.attributeGap(E, -5, false), { chatDelta: 0, coworkDelta: 0, codeDelta: 0 });
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

test("learn folds a ground-truth rate observation without touching buckets", () => {
  let m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "code" },
    { weeklyPct: 10, weeklyResetAt: WR, surface: "code" }, // +10 code usage
  ]);
  assert.equal(Math.round(m.code), 10);
  assert.equal(m.chat, 0);
  // Real Code tokens: +4 weekly% over 2000 weighted tokens → 0.002 %/token.
  m = S.learn(m, 4, 2000);
  assert.ok(Math.abs(S.rate(m) - 0.002) < 1e-9, "rate: " + S.rate(m));
  // Buckets are unchanged — learn only adjusts the rate.
  assert.equal(Math.round(m.code), 10);
  assert.equal(m.chat, 0);
});

test("learn ignores non-positive deltas", () => {
  let m = S.learn(S.EMPTY, 0, 1000);
  assert.equal(S.rate(m), null);
  m = S.learn(m, 5, 0);
  assert.equal(S.rate(m), null);
  m = S.learn(m, -2, 1000);
  assert.equal(S.rate(m), null);
});

test("a learn-taught rate drives splitByContent", () => {
  // No live Home data at all; the rate comes purely from real Code tokens.
  const m = S.learn(S.EMPTY, 2, 1000); // 0.002 %/token
  const parts = S.splitByContent(m, 10, 2000, true); // 2000*0.002 = 4 to chat
  assert.equal(Math.round(parts.chatDelta), 4);
  assert.equal(Math.round(parts.codeDelta), 6);
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
  assert.deepEqual(S.splitByContent(S.EMPTY, 8, 5000, true), {
    chatDelta: 8, coworkDelta: 0, codeDelta: 0,
  });
  assert.deepEqual(S.splitByContent(S.EMPTY, 8, 5000, false), {
    chatDelta: 0, coworkDelta: 0, codeDelta: 8,
  });
  assert.deepEqual(S.splitByContent(S.EMPTY, 0, 5000, true), {
    chatDelta: 0, coworkDelta: 0, codeDelta: 0,
  });
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


// ---- Cowork, the third surface -------------------------------------------

test("a Cowork reading is its own bucket, not chat and not code", () => {
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "chat" },
    { weeklyPct: 10, weeklyResetAt: WR, surface: "chat" }, // +10 chat
    { weeklyPct: 16, weeklyResetAt: WR, surface: "cowork" }, // +6 cowork
    { weeklyPct: 20, weeklyResetAt: WR, surface: "code" }, // +4 code
  ]);
  assert.equal(Math.round(m.chat), 10);
  assert.equal(Math.round(m.cowork), 6);
  assert.equal(Math.round(m.code), 4);
  const s = S.share(m);
  assert.equal(Math.round(s.chatPct), 50);
  assert.equal(Math.round(s.coworkPct), 30);
  assert.equal(Math.round(s.codePct), 20);
});

test("Cowork increments teach no rate — the content probe cannot see one", () => {
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "cowork" },
    { weeklyPct: 6, weeklyResetAt: WR, surface: "cowork", learnTok: 1000 },
  ]);
  assert.equal(S.rate(m), null);
});

test("a model stored before Cowork existed reads as no Cowork, not as NaN", () => {
  const old = { chat: 30, code: 10, lastW: 40, wKey: 10000, lastAt: 5, rNum: 2, rDen: 1000 };
  const s = S.share(old);
  assert.equal(s.total, 40);
  assert.equal(s.cowork, 0);
  assert.equal(s.coworkPct, 0);
  assert.equal(Math.round(s.chatPct), 75);
  // ...and it keeps accumulating from where it was.
  const m = S.observe(old, { weeklyPct: 45, weeklyResetAt: WR, surface: "cowork" });
  assert.equal(Math.round(m.cowork), 5);
  assert.equal(Math.round(m.chat), 30);
  assert.ok(Math.abs(S.rate(m) - 0.002) < 1e-9, "the learned rate survived");
});

test("an unseeable gap goes wholly to Code until Cowork has been seen live", () => {
  // This is the pre-Cowork behaviour, and it is what someone who never opens
  // Cowork must keep getting: nothing is invented out of no evidence.
  assert.deepEqual(S.splitUnseen(S.EMPTY, 9), { coworkDelta: 0, codeDelta: 9 });
  const chatOnly = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "chat" },
    { weeklyPct: 20, weeklyResetAt: WR, surface: "chat" },
  ]);
  assert.deepEqual(S.splitUnseen(chatOnly, 9), { coworkDelta: 0, codeDelta: 9 });
});

test("an unseeable gap divides by what has been seen live", () => {
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "cowork" },
    { weeklyPct: 30, weeklyResetAt: WR, surface: "cowork" }, // 30 live cowork
    { weeklyPct: 40, weeklyResetAt: WR, surface: "code" }, // 10 live code
  ]);
  const parts = S.splitUnseen(m, 8); // 3:1 → 6 cowork, 2 code
  assert.ok(Math.abs(parts.coworkDelta - 6) < 1e-9, "cowork: " + parts.coworkDelta);
  assert.ok(Math.abs(parts.codeDelta - 2) < 1e-9, "code: " + parts.codeDelta);
  // The whole gap is still accounted for, whatever the ratio.
  assert.ok(Math.abs(parts.coworkDelta + parts.codeDelta - 8) < 1e-9);
});

test("the live ratio is evidence only — a gap's own guesses never feed it", () => {
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "cowork" },
    { weeklyPct: 10, weeklyResetAt: WR, surface: "cowork" }, // live: 10 cowork
    { weeklyPct: 20, weeklyResetAt: WR, surface: "code" }, // live: 10 code
    // A gap attributed 50/50 by that ratio: the buckets move, the evidence doesn't.
    { weeklyPct: 40, weeklyResetAt: WR, coworkDelta: 10, codeDelta: 10 },
  ]);
  assert.equal(Math.round(m.cowork), 20);
  assert.equal(Math.round(m.code), 20);
  assert.equal(Math.round(m.liveCowork), 10);
  assert.equal(Math.round(m.liveCode), 10);
});

test("splitByContent gives the chat its measured share and divides the rest", () => {
  const m = feed([
    { weeklyPct: 0, weeklyResetAt: WR, surface: "chat" },
    { weeklyPct: 2, weeklyResetAt: WR, surface: "chat", learnTok: 1000 }, // 0.002 %/token
    { weeklyPct: 5, weeklyResetAt: WR, surface: "cowork" }, // live: 3 cowork
    { weeklyPct: 6, weeklyResetAt: WR, surface: "code" }, // live: 1 code
  ]);
  // A 10-pt gap in which the chats grew 2000 weighted tokens → 4 to chat, and
  // the remaining 6 divided 3:1 → 4.5 cowork, 1.5 code.
  const parts = S.splitByContent(m, 10, 2000, true);
  assert.ok(Math.abs(parts.chatDelta - 4) < 1e-9, "chat: " + parts.chatDelta);
  assert.ok(Math.abs(parts.coworkDelta - 4.5) < 1e-9, "cowork: " + parts.coworkDelta);
  assert.ok(Math.abs(parts.codeDelta - 1.5) < 1e-9, "code: " + parts.codeDelta);
});

test("the cap halves all three sums while preserving their ratios", () => {
  let m = S.EMPTY;
  const order = ["chat", "cowork", "code"];
  for (let i = 0; i < 1500; i++) {
    m = S.observe(m, { weeklyPct: 0, weeklyResetAt: WR + i * 60000, surface: "chat" });
    m = S.observe(m, { weeklyPct: 9, weeklyResetAt: WR + i * 60000, surface: order[i % 3] });
  }
  const total = m.chat + m.cowork + m.code;
  assert.ok(total <= S.CAP * 1.05, "bounded: " + total);
  for (const v of [m.chat, m.cowork, m.code]) {
    assert.ok(Math.abs(v / total - 1 / 3) < 0.05, "ratio drifted: " + v / total);
  }
  assert.ok(m.liveCowork + m.liveCode <= S.CAP * 1.05, "the evidence counters are bounded too");
});
