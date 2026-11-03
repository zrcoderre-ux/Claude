"use strict";

// The last copy that carried real names, remembered so the run and
// scheduled-send forms refuse a paste of them (src/paste-guard.js).

const test = require("node:test");
const assert = require("node:assert");

const P = require("../src/pseudo.js");

const HITS = [
  { real: "Helen Rasho", fake: "Ingrid Strangeways" },
  { real: "Cross River Bank", fake: "Dunmore Trust" },
  { real: "helen rasho", fake: "Ingrid Strangeways" },
];

test("lastCopyRecord keeps each real name once, with its fake", () => {
  const r = P.lastCopyRecord(HITS, 42);
  assert.strictEqual(r.at, 42);
  assert.deepStrictEqual(r.names, [
    { real: "Helen Rasho", fake: "Ingrid Strangeways" },
    { real: "Cross River Bank", fake: "Dunmore Trust" },
  ]);
  assert.deepStrictEqual(P.lastCopyRecord([], 1).names, []);
  assert.deepStrictEqual(P.lastCopyRecord(null).names, []);
});

test("copiedPasteHold refuses a paste carrying a remembered name, in any case", () => {
  const r = P.lastCopyRecord(HITS, 1);
  const v = P.copiedPasteHold(r, "The court GRANTS Helen Rasho's motion against CROSS RIVER BANK.");
  assert.strictEqual(v.hold, true);
  assert.deepStrictEqual(v.names.map((h) => h.real).sort(), ["Cross River Bank", "Helen Rasho"]);
});

test("copiedPasteHold lets everything else through", () => {
  const r = P.lastCopyRecord(HITS, 1);
  // A paste from somewhere else, without those names.
  assert.strictEqual(P.copiedPasteHold(r, "Draft the final tentative for Ingrid Strangeways.").hold, false);
  // A part of a word is not the name.
  assert.strictEqual(P.copiedPasteHold(r, "Helen Rashomon").hold, false);
  // The last copy carried no real names, or there is no record.
  assert.strictEqual(P.copiedPasteHold(P.lastCopyRecord([], 2), "Helen Rasho").hold, false);
  assert.strictEqual(P.copiedPasteHold(null, "Helen Rasho").hold, false);
  assert.strictEqual(P.copiedPasteHold(r, "").hold, false);
});

test("copiedPasteClean swaps the remembered names for their pseudonyms", () => {
  const r = P.lastCopyRecord(HITS, 1);
  const c = P.copiedPasteClean(r, "HELEN RASHO v. Cross River Bank");
  assert.strictEqual(c.text, "INGRID STRANGEWAYS v. Dunmore Trust");
  assert.strictEqual(c.ok, true);
  // A name with no known fake: no clean version to offer.
  const noFake = P.lastCopyRecord([{ real: "Helen Rasho", fake: "" }], 1);
  assert.strictEqual(P.copiedPasteClean(noFake, "Helen Rasho").ok, false);
  // Nothing to swap is not "cleaned".
  assert.strictEqual(P.copiedPasteClean(r, "nothing here").ok, false);
});

test("copiedPasteNote names what it refused and why", () => {
  const one = P.copiedPasteNote([{ real: "Helen Rasho" }]);
  assert.match(one.head, /^Not pasted/);
  assert.match(one.body, /real name “Helen Rasho”/);
  assert.match(one.body, /goes to Claude exactly as written/);
  const many = P.copiedPasteNote([1, 2, 3, 4, 5, 6].map((i) => ({ real: "N" + i })));
  assert.match(many.body, /and 2 more/);
});
