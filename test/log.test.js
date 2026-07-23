/**
 * Tests for src/log.js — the usage-log helpers (capping, CSV building).
 * Run with: node --test test/log.test.js
 */
const assert = require("node:assert");
const { test } = require("node:test");
const L = require("../src/log.js");

test("addEntry appends", () => {
  const out = L.addEntry([{ a: 1 }], { a: 2 });
  assert.deepEqual(out, [{ a: 1 }, { a: 2 }]);
});

test("addEntry caps to the given max, dropping the oldest", () => {
  let entries = [];
  for (let i = 0; i < 5; i++) entries = L.addEntry(entries, { i }, 3);
  assert.deepEqual(entries.map((e) => e.i), [2, 3, 4]);
});

const HR = 60 * 60 * 1000;

test("isDuplicate: a hit100 stands open until a reset is logged", () => {
  const log = [{ at: 1000, type: "hit100", percent: 100 }];
  // Another hit100 with no reset since → duplicate (same session).
  assert.equal(L.isDuplicate(log, { at: 1000 + 3 * HR, type: "hit100", percent: 100 }), true);
  // After a reset, a new hit100 is allowed.
  const log2 = log.concat([{ at: 1000 + 5 * HR, type: "reset", percent: 100 }]);
  assert.equal(L.isDuplicate(log2, { at: 1000 + 6 * HR, type: "hit100", percent: 100 }), false);
  // First hit100 on an empty log is not a duplicate.
  assert.equal(L.isDuplicate([], { at: 1, type: "hit100", percent: 100 }), false);
});

test("isDuplicate: resets within the dedup window are the same reset", () => {
  const log = [{ at: 1_000_000, type: "reset", percent: 90 }];
  assert.equal(L.isDuplicate(log, { at: 1_000_000 + 60 * 1000, type: "reset" }), true); // 1 min later
  assert.equal(L.isDuplicate(log, { at: 1_000_000 + 5 * HR, type: "reset" }), false); // hours later
});

test("dedupe collapses duplicate hit100s and near-simultaneous resets", () => {
  const raw = [
    { at: 100, type: "hit100", percent: 100 },
    { at: 100 + 60 * 1000, type: "hit100", percent: 100 }, // dup (no reset between)
    { at: 100 + 2 * 60 * 1000, type: "hit100", percent: 100 }, // dup
    { at: 5 * HR, type: "reset", percent: 100 },
    { at: 5 * HR + 30 * 1000, type: "reset", percent: 100 }, // dup reset (30s later)
    { at: 6 * HR, type: "hit100", percent: 100 }, // new session → kept
  ];
  const out = L.dedupe(raw);
  assert.equal(out.filter((e) => e.type === "hit100").length, 2);
  assert.equal(out.filter((e) => e.type === "reset").length, 1);
});

test("addEntry uses DEFAULT_MAX_ENTRIES when no cap given", () => {
  let entries = [];
  for (let i = 0; i < L.DEFAULT_MAX_ENTRIES + 10; i++) entries = L.addEntry(entries, { i });
  assert.equal(entries.length, L.DEFAULT_MAX_ENTRIES);
  assert.equal(entries[0].i, 10); // oldest 10 dropped
});

test("csvEscape quotes values containing commas, quotes, or newlines", () => {
  assert.equal(L.csvEscape("plain"), "plain");
  assert.equal(L.csvEscape("a,b"), '"a,b"');
  assert.equal(L.csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(L.csvEscape("line1\nline2"), '"line1\nline2"');
  assert.equal(L.csvEscape(null), "");
  assert.equal(L.csvEscape(42), "42");
});

test("buildCsv renders a header and CRLF-joined rows", () => {
  const csv = L.buildCsv(
    [
      ["2026-07-17", "9:00:00 AM", "Hit 100%", 100],
      ["2026-07-17", "2:00:00 PM", "Window reset", 87.5],
    ],
    ["Date", "Time", "Event", "Usage %"]
  );
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "Date,Time,Event,Usage %");
  assert.equal(lines[1], "2026-07-17,9:00:00 AM,Hit 100%,100");
  assert.equal(lines[2], "2026-07-17,2:00:00 PM,Window reset,87.5");
  assert.equal(csv.endsWith("\r\n"), true, "trailing CRLF");
});

test("buildCsv without a header omits the header row", () => {
  const csv = L.buildCsv([["a", 1]]);
  assert.equal(csv, "a,1\r\n");
});

test("eventLabel maps known types and passes through unknown ones", () => {
  assert.equal(L.eventLabel("hit100"), "Hit 100%");
  assert.equal(L.eventLabel("reset"), "Window reset");
  assert.equal(L.eventLabel("mystery"), "mystery");
});
