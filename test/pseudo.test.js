"use strict";

const test = require("node:test");
const assert = require("node:assert");

const P = require("../src/pseudo.js");

// The seven-column layout the current PDF-Linker writes. Column order must not
// matter — DeAnonymize locates columns by header name, and so must we.
const HEADERS = ["Category", "Real Value", "Replacement", "Context", "Status", "Source", "Occurrences"];

function sheet(name, rows) {
  return { name: name, rows: rows };
}

function keyOf(rows, extraSheets) {
  const sheets = [sheet("Key", [HEADERS].concat(rows))].concat(extraSheets || []);
  return P.parseKey(sheets, "pseudonym_key.xlsx");
}

test("isKeyFileName matches the macro's pattern plus dedup copies", () => {
  assert.ok(P.isKeyFileName("pseudonym_key.xlsx"));
  assert.ok(P.isKeyFileName("pseudonym_key (1).xlsx"));
  assert.ok(P.isKeyFileName("Pseudonym_Key.XLSX"));
  assert.ok(P.isKeyFileName("pseudonym key.xlsx"));
  assert.ok(P.isKeyFileName("C:\\Cases\\Rasho\\pseudonym_key.xlsx"));
  assert.ok(!P.isKeyFileName("Order 2024.xlsx"));
  assert.ok(!P.isKeyFileName("pseudonym_key.txt"));
  assert.ok(!P.isKeyFileName(""));
});

test("sheetsLookLikeKey fingerprints the shared headers, any column order", () => {
  assert.ok(P.sheetsLookLikeKey([sheet("S", [["Real Value", "Replacement"]])]));
  assert.ok(P.sheetsLookLikeKey([sheet("S", [["title row"], ["replacement", "REAL VALUE"]])]));
  assert.ok(!P.sheetsLookLikeKey([sheet("S", [["Date", "Qty", "Rate($)"]])]));
  assert.ok(!P.sheetsLookLikeKey([]));
});

test("parseKey reads by header name and builds both directions", () => {
  const key = keyOf([
    ["person", "Helen Rasho", "Ingrid Strangeways", "…", "", "spreadsheet", 12],
    ["person-token", "Rasho", "Strangeways", "…", "", "spreadsheet", 30],
  ]);
  assert.strictEqual(key.rows, 2);
  assert.deepStrictEqual(
    key.pairs.map((p) => p.fake + ">" + p.real).sort(),
    ["Ingrid Strangeways>Helen Rasho", "Strangeways>Rasho"]
  );
  assert.deepStrictEqual(key.warn.map((w) => w.real), ["Helen Rasho", "Rasho"]);
});

test("keep decisions in the Replacement cell are instructions, not pseudonyms", () => {
  const key = keyOf([
    ["entity", "Cal", "no", "", "", "", 0],
    ["entity", "Labor", "never", "", "", "", 0],
    ["entity", "Alder Law, P.C.", "[Law]", "", "", "", 0],
    ["entity", "Alder Law", "{Law}", "", "", "", 0],
    ["person", "Rasho", "Strangeways", "", "", "", 3],
  ]);
  assert.strictEqual(key.dropped.keeps, 4);
  assert.strictEqual(key.pairs.length, 1);
  // A kept value is present because the operator said so — never warned about.
  assert.deepStrictEqual(key.warn.map((w) => w.real), ["Rasho"]);
});

test("an alt-spelling row is forward-only: warned about, never reversed", () => {
  const key = keyOf([
    ["person", "Sedgwick-Linford", "Ardley-Marsh", "", "", "", 5],
    ["person", "Sedgwick- Linford", "Ardley-Marsh", "", "alt spelling", "", 2],
  ]);
  assert.strictEqual(key.pairs.length, 1);
  assert.strictEqual(key.pairs[0].real, "Sedgwick-Linford");
  // Both spellings are the party; typing either is a leak.
  assert.deepStrictEqual(key.warn.map((w) => w.real), ["Sedgwick-Linford", "Sedgwick- Linford"]);
});

test("a fake claimed by two canonical reals is retired, not guessed", () => {
  const key = keyOf([
    ["person", "Ann Doe", "Marlow", "", "", "", 1],
    ["person", "Bea Roe", "Marlow", "", "", "", 1],
    ["person", "Cy Poe", "Quill", "", "", "", 1],
  ]);
  assert.strictEqual(key.dropped.ambiguous, 1);
  assert.deepStrictEqual(key.pairs.map((p) => p.fake), ["Quill"]);
  // The reals still warn — ambiguity is a reversal problem, not a leak amnesty.
  assert.strictEqual(key.warn.length, 3);
});

test("a group that is all synthetic promotes one row", () => {
  const key = keyOf([["person", "Sarra", "Keswick", "", "alt spelling", "", 2]]);
  assert.strictEqual(key.pairs.length, 1);
  assert.strictEqual(key.pairs[0].real, "Sarra");
});

test("the pinned sheet's reals ride along", () => {
  const pinned = sheet("Pinned (never in text)", [
    HEADERS,
    ["person", "Gregory Walton", "Lowther Rolleston", "", "no match", "spreadsheet", 0],
  ]);
  const key = keyOf([["person", "Rasho", "Strangeways", "", "", "", 3]], [pinned]);
  assert.deepStrictEqual(key.warn.map((w) => w.real), ["Rasho", "Gregory Walton"]);
});

test("a row mapping a value onto itself is dropped", () => {
  const key = keyOf([["entity", "M & M", "M & M", "", "", "", 1]]);
  assert.strictEqual(key.pairs.length, 0);
});

test("translate swaps fakes for reals: longest first, whole words, wraps", () => {
  const c = P.compile(
    keyOf([
      ["person", "Helen Rasho", "Ingrid Strangeways", "", "", "", 9],
      ["person-token", "Rasho", "Strangeways", "", "", "", 20],
      ["person-token", "Helen", "Ingrid", "", "", "", 20],
    ])
  );
  const r = P.translate(c, "Plaintiff Ingrid Strangeways (“Strangeways”) appeared.");
  assert.strictEqual(r.text, "Plaintiff Helen Rasho (“Rasho”) appeared.");
  assert.strictEqual(r.count, 2);
  // A line wrap inside the full name still reads as the full name.
  assert.strictEqual(
    P.translate(c, "served Ingrid\nStrangeways there").text,
    "served Helen Rasho there"
  );
  // Whole words only: no firing inside a longer token.
  assert.strictEqual(P.translate(c, "the Strangewayses met").text, "the Strangewayses met");
});

test("an ALL-CAPS match is mirrored — a caption shouts its parties", () => {
  const c = P.compile(keyOf([["person", "Helen Rasho", "Ingrid Strangeways", "", "", "", 9]]));
  assert.strictEqual(
    P.translate(c, "INGRID STRANGEWAYS, an individual,").text,
    "HELEN RASHO, an individual,"
  );
});

test("fakes with digits and at-signs keep their edges", () => {
  const c = P.compile(
    keyOf([
      ["email", "barry@law.com", "quenby3@postbox9.org", "", "", "", 2],
      ["person-token", "Walton", "Deverell5", "", "", "", 2],
    ])
  );
  assert.strictEqual(
    P.translate(c, "mail quenby3@postbox9.org re Deverell5 today").text,
    "mail barry@law.com re Walton today"
  );
  // Boundary holds: a longer token containing the fake is not rewritten.
  assert.strictEqual(P.translate(c, "xDeverell5 Deverell56").count, 0);
});

test("translation is idempotent for a sane key", () => {
  const c = P.compile(
    keyOf([
      ["person", "Helen Rasho", "Ingrid Strangeways", "", "", "", 9],
      ["person-token", "Rasho", "Strangeways", "", "", "", 20],
    ])
  );
  const once = P.translate(c, "Strangeways moved; STRANGEWAYS again.").text;
  assert.strictEqual(P.translate(c, once).text, once);
});

test("findReals reports each real once, with the fake to use instead", () => {
  const key = keyOf([
    ["person", "Helen Rasho", "Ingrid Strangeways", "", "", "", 9],
    ["person-token", "Rasho", "Strangeways", "", "", "", 20],
    ["case_number", "24STCV01234", "87NNCV55555", "", "", "", 4],
  ]);
  const c = P.compileReals(key);
  const hits = P.findReals(c, "Rasho said RASHO; case 24STCV01234. Nothing else.");
  assert.deepStrictEqual(hits.map((h) => h.real), ["Rasho", "24STCV01234"]);
  assert.strictEqual(hits[0].fake, "Strangeways");
  // The full name standing whole reports once — not once more per token.
  const whole = P.findReals(c, "Helen Rasho appeared.");
  assert.deepStrictEqual(whole.map((h) => h.real), ["Helen Rasho"]);
  // Text with no reals is silent.
  assert.deepStrictEqual(P.findReals(c, "Strangeways appeared."), []);
});

test("conversationKeyFromUrl: uuid where there is one, path otherwise", () => {
  assert.strictEqual(
    P.conversationKeyFromUrl(
      "https://claude.ai/chat/0a1b2c3d-4e5f-6789-abcd-ef0123456789?x=1"
    ),
    "0a1b2c3d-4e5f-6789-abcd-ef0123456789"
  );
  assert.strictEqual(P.conversationKeyFromUrl("https://claude.ai/new"), "/new");
  assert.strictEqual(P.conversationKeyFromUrl(""), null);
});

test("an empty or headerless workbook parses to an empty key", () => {
  const key = P.parseKey([sheet("S", [["Date", "Qty"], ["1", "2"]])], "x.xlsx");
  assert.strictEqual(key.rows, 0);
  assert.strictEqual(key.pairs.length, 0);
  const c = P.compile(key);
  assert.strictEqual(P.translate(c, "anything").text, "anything");
  assert.deepStrictEqual(P.findReals(P.compileReals(key), "anything"), []);
});
