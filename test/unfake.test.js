"use strict";

// A name taken out of the key by hand (P.unfakeKey and friends), and one
// occurrence in the draft sent as typed (P.shiftSpots and friends) — the
// composer's right-click.

const test = require("node:test");
const assert = require("node:assert");

const P = require("../src/pseudo.js");

const HEADERS = ["Category", "Real Value", "Replacement", "Context", "Status", "Source", "Occurrences"];

function keyOf(rows) {
  return P.parseKey([{ name: "Pseudonym Key", rows: [HEADERS].concat(rows) }], "pseudonym_key.xlsx");
}

const ROWS = [
  ["person", "Helen Rasho", "Ingrid Strangeways", "", "", "caption", "40"],
  ["entity", "Case Management Conference", "Quillfeather Assembly", "", "", "body", "90"],
  ["entity", "Case Management Conference's", "Quillfeather Assembly's", "", "", "body", "2"],
  ["entity", "Cross River Bank", "Dunmore Trust", "", "", "body", "12"],
];

test("unfakeKey takes the real value, its possessive and its fake out of every direction", () => {
  const key = keyOf(ROWS);
  assert.strictEqual(key.hint, "Case Management Conference"); // the most-used real
  const out = P.unfakeKey(key, "Case Management Conference");
  assert.ok(!out.warn.some((w) => /case management/i.test(w.real)));
  assert.ok(!out.pairs.some((p) => /case management/i.test(p.real)));
  assert.ok(out.warn.some((w) => w.real === "Helen Rasho"));
  assert.deepStrictEqual(P.unfakedNames(out), ["Case Management Conference"]);
  // The case is not named after boilerplate.
  assert.strictEqual(out.hint, "");
  // The draft no longer finds it, the display no longer reverses its fake, the
  // cleaner no longer swaps it.
  assert.deepStrictEqual(P.findReals(P.compileReals(out), "the Case Management Conference is set"), []);
  assert.strictEqual(P.translate(P.compile(out), "the Quillfeather Assembly").text, "the Quillfeather Assembly");
  assert.strictEqual(P.nameCleaner(out)("Case Management Conference"), "Case Management Conference");
  // Everything else still works.
  assert.strictEqual(P.nameCleaner(out)("Helen Rasho"), "Ingrid Strangeways");
  // The input was not mutated.
  assert.ok(key.warn.some((w) => w.real === "Case Management Conference"));
});

test("unfakeKey matches folded — case, spacing and quote marks — and nothing longer", () => {
  const key = keyOf(ROWS.concat([["entity", "Further Case Management Conference", "Hollin Moot", "", "", "body", "1"]]));
  const out = P.unfakeKey(key, "  case   management CONFERENCE ");
  assert.ok(out.warn.some((w) => w.real === "Further Case Management Conference"));
  assert.ok(!out.warn.some((w) => w.real === "Case Management Conference"));
  const q = keyOf([["person", "O'Brien", "D'Arcy", "", "", "caption", "3"]]);
  assert.strictEqual(P.unfakeKey(q, "O’Brien").warn.length, 0);
});

test("unfakeKey leaves a key it has nothing to take from alone, and never touches the master key", () => {
  const key = keyOf(ROWS);
  assert.strictEqual(P.unfakeKey(key, "Nobody At All"), key);
  assert.strictEqual(P.unfakeKey(key, ""), key);
  const once = P.unfakeKey(key, "Case Management Conference");
  assert.strictEqual(P.unfakeKey(once, "Case Management Conference"), once);
  const master = { master: true, warn: [{ real: "Helen Rasho", fake: "Ingrid" }], pairs: [] };
  assert.strictEqual(P.unfakeKey(master, "Helen Rasho"), master);
  assert.strictEqual(P.unfakeKey(null, "x"), null);
});

test("refakeKey puts back exactly what was taken", () => {
  const key = keyOf(ROWS);
  const out = P.refakeKey(P.unfakeKey(key, "Case Management Conference"), "case management conference");
  assert.strictEqual(out.unfaked, undefined);
  assert.deepStrictEqual(
    out.warn.map((w) => w.real).sort(),
    key.warn.map((w) => w.real).sort()
  );
  assert.deepStrictEqual(
    out.pairs.map((p) => p.real + ">" + p.fake).sort(),
    key.pairs.map((p) => p.real + ">" + p.fake).sort()
  );
  assert.strictEqual(out.hint, key.hint);
  assert.strictEqual(P.nameCleaner(out)("Case Management Conference"), "Quillfeather Assembly");
  // Restoring one of two keeps the other removed.
  const two = P.unfakeKey(P.unfakeKey(key, "Case Management Conference"), "Cross River Bank");
  const back = P.refakeKey(two, "Cross River Bank");
  assert.deepStrictEqual(P.unfakedNames(back), ["Case Management Conference"]);
  assert.ok(back.warn.some((w) => w.real === "Cross River Bank"));
  // Nothing recorded: the same key.
  assert.strictEqual(P.refakeKey(key, "Helen Rasho"), key);
});

test("a re-load of the same spreadsheet keeps the removal (keepKeyFacts)", () => {
  const stored = Object.assign(P.unfakeKey(keyOf(ROWS), "Case Management Conference"), { folder: "23STCV1 Rasho v. Q" });
  const fresh = keyOf(ROWS.concat([["person", "Pat Quill", "Moss Fenwick", "", "", "caption", "5"]]));
  const next = P.keepKeyFacts(stored, fresh);
  assert.strictEqual(next.folder, "23STCV1 Rasho v. Q");
  assert.deepStrictEqual(P.unfakedNames(next), ["Case Management Conference"]);
  assert.ok(!next.warn.some((w) => w.real === "Case Management Conference"));
  assert.ok(next.warn.some((w) => w.real === "Pat Quill"));
  // ...and can still put it back afterwards.
  assert.ok(P.refakeKey(next, "Case Management Conference").warn.some((w) => w.real === "Case Management Conference"));
  // The same case's key still lands on the same entry with one row removed.
  assert.strictEqual(P.libraryIdFor({ a: stored }, fresh).id, "a");
  // No removals and no folder: the fresh key exactly.
  const plain = keyOf(ROWS);
  assert.strictEqual(P.keepKeyFacts(keyOf(ROWS), plain), plain);
});

test("unfakedChanged notices a removal and a restoration, and nothing else", () => {
  const key = keyOf(ROWS);
  const gone = P.unfakeKey(key, "Cross River Bank");
  assert.ok(P.unfakedChanged({ a: key }, { a: gone }));
  assert.ok(P.unfakedChanged({ a: gone }, { a: key }));
  assert.ok(!P.unfakedChanged({ a: key }, { a: key, b: gone })); // a new load is the stamps' business
  assert.ok(!P.unfakedChanged({ a: gone }, { a: Object.assign({}, gone, { savedAt: 5 }) }));
  assert.ok(!P.unfakedChanged(undefined, undefined));
});

// ---- one occurrence, sent as typed ----------------------------------------------

const DRAFT = "Set the Case Management Conference. Then the Case Management Conference again.";
const SECOND = DRAFT.lastIndexOf("Case Management Conference");
const spotAt = (start, text) => ({ start: start, end: start + 26, matched: (text || DRAFT).slice(start, start + 26) });

test("shiftSpots carries a kept occurrence across typing before, after and beside it", () => {
  const spot = spotAt(SECOND);
  // Typing before it moves it.
  const before = "Please s" + DRAFT.slice(1);
  assert.deepStrictEqual(P.shiftSpots(DRAFT, before, [spot]).map((s) => s.start), [SECOND + 7]);
  // Typing after it leaves it.
  assert.deepStrictEqual(P.shiftSpots(DRAFT, DRAFT + " Thanks.", [spot]).map((s) => s.start), [SECOND]);
  // A space typed straight after it leaves it.
  const after = DRAFT.slice(0, SECOND + 26) + " " + DRAFT.slice(SECOND + 26);
  assert.deepStrictEqual(P.shiftSpots(DRAFT, after, [spot]).map((s) => s.start), [SECOND]);
  // A letter typed straight before it moves it.
  const glued = DRAFT.slice(0, SECOND) + "x" + DRAFT.slice(SECOND);
  assert.deepStrictEqual(P.shiftSpots(DRAFT, glued, [spot]).map((s) => s.start), [SECOND + 1]);
  // The same text: the same spots.
  assert.deepStrictEqual(P.shiftSpots(DRAFT, DRAFT, [spot]), [spot]);
});

test("shiftSpots drops a kept occurrence the edit touches or that no longer reads as the name", () => {
  const spot = spotAt(SECOND);
  const inside = DRAFT.slice(0, SECOND + 5) + "X" + DRAFT.slice(SECOND + 5);
  assert.deepStrictEqual(P.shiftSpots(DRAFT, inside, [spot]), []);
  const deleted = DRAFT.slice(0, SECOND) + DRAFT.slice(SECOND + 26);
  assert.deepStrictEqual(P.shiftSpots(DRAFT, deleted, [spot]), []);
  assert.deepStrictEqual(P.shiftSpots(DRAFT, "", [spot]), []);
  // The fake typed over the FIRST occurrence moves the kept second one.
  const faked = DRAFT.slice(0, 8) + "Quillfeather Assembly" + DRAFT.slice(8 + 26);
  const moved = P.shiftSpots(DRAFT, faked, [spot]);
  assert.strictEqual(moved.length, 1);
  assert.strictEqual(faked.slice(moved[0].start, moved[0].end), "Case Management Conference");
});

test("maskSpots hides exactly the kept occurrence from the matchers, offsets intact", () => {
  const key = keyOf(ROWS);
  const reals = P.compileReals(key);
  const masked = P.maskSpots(DRAFT, [spotAt(SECOND)]);
  assert.strictEqual(masked.length, DRAFT.length);
  const swaps = P.sendSwaps(reals, masked, []);
  assert.deepStrictEqual(swaps.map((s) => s.start), [8]);
  // The send's text: the first faked, the kept one as typed.
  const sent = P.swappedText(DRAFT, swaps);
  assert.ok(sent.indexOf("Set the Quillfeather Assembly.") === 0);
  assert.ok(/again\.$/.test(sent) && sent.indexOf("the Case Management Conference again") !== -1);
  // Nothing left to warn about once the kept one is masked and the rest faked.
  assert.deepStrictEqual(P.findReals(reals, P.swappedText(masked, swaps)), []);
  // Line breaks survive the mask, so two paragraphs never join.
  assert.strictEqual(P.maskSpots("ab\ncd", [{ start: 0, end: 5, matched: "ab\ncd" }]), "  \n  ");
  assert.strictEqual(P.maskSpots(DRAFT, []), DRAFT);
});

test("spanAtOffset and isSpotKept find the occurrence under the pointer", () => {
  const spans = P.draftSpans(P.compileReals(keyOf(ROWS)), DRAFT);
  assert.strictEqual(spans.length, 2);
  assert.strictEqual(P.spanAtOffset(spans, SECOND + 3).start, SECOND);
  assert.strictEqual(P.spanAtOffset(spans, SECOND + 26).start, SECOND); // the caret just past it
  assert.strictEqual(P.spanAtOffset(spans, 2), null);
  assert.ok(P.isSpotKept([spotAt(SECOND)], spans[1]));
  assert.ok(!P.isSpotKept([spotAt(SECOND)], spans[0]));
  assert.ok(!P.isSpotKept([], spans[0]));
});
