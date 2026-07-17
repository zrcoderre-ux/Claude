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
