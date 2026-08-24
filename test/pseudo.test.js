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

test("a pincite paste declares itself and stands the warning down", () => {
  assert.ok(P.isPincitePaste("PINCITE CHECK — OFFICIAL REPORTER PAGE BREAKS\nRasho v. Smith, 47 Cal.2d 469, 471"));
  // Tolerant of the dash and spacing a copy-paste mangles…
  assert.ok(P.isPincitePaste("  pincite check - official reporter page breaks\n…"));
  assert.ok(P.isPincitePaste("PINCITE CHECK -- OFFICIAL REPORTER PAGE BREAKS"));
  // …but only at the START, and only these words.
  assert.ok(!P.isPincitePaste("Re: PINCITE CHECK — OFFICIAL REPORTER PAGE BREAKS"));
  assert.ok(!P.isPincitePaste("PINCITE CHECK for Rasho"));
  assert.ok(!P.isPincitePaste(""));
});

test("compileForward pseudonymizes typed text: longest real first, keeps verbatim", () => {
  const key = keyOf([
    ["person", "Helen Rasho", "Ingrid Strangeways", "", "", "", 9],
    ["person-token", "Rasho", "Strangeways", "", "", "", 20],
    ["entity", "Cal", "no", "", "", "", 0], // a keep is left alone in both directions
    ["case_number", "24STCV01234", "87NNCV55555", "", "", "", 4],
  ]);
  const f = P.compileForward(key);
  const r = P.translate(f, "Helen Rasho (Cal case 24STCV01234): Rasho appeared.");
  assert.strictEqual(r.text, "Ingrid Strangeways (Cal case 87NNCV55555): Strangeways appeared.");
  assert.strictEqual(r.count, 3);
  // ALL-CAPS mirrors forward too.
  assert.strictEqual(P.translate(f, "HELEN RASHO").text, "INGRID STRANGEWAYS");
});

test("an alt spelling is forward-usable: typing the OCR spelling still cleans", () => {
  const key = keyOf([
    ["person", "Sara", "Keswick", "", "", "", 5],
    ["person", "Sarra", "Keswick", "", "alt spelling", "", 2],
  ]);
  const f = P.compileForward(key);
  assert.strictEqual(P.translate(f, "Sarra met Sara").text, "Keswick met Keswick");
});

test("common English is never flagged and never rewritten", () => {
  // A key that (wrongly or not) binds ordinary words alongside a real party.
  const key = keyOf([
    ["person-token", "As", "Quill", "", "", "", 1],
    ["person-token", "Was", "Marlow", "", "", "", 1],
    ["person-token", "And", "Fenmore", "", "", "", 1],
    ["person", "Rasho", "Strangeways", "", "", "", 9],
  ]);
  assert.ok(P.isCommonReal("as") && P.isCommonReal("The") && P.isCommonReal("v"));
  assert.ok(!P.isCommonReal("Rasho") && !P.isCommonReal("Cross River Bank"));
  const hits = P.findReals(P.compileReals(key), "As it was, Rasho and I left.");
  assert.deepStrictEqual(hits.map((h) => h.real), ["Rasho"]);
  const cleaned = P.translate(P.compileForward(key), "As it was, Rasho and I left.");
  assert.strictEqual(cleaned.text, "As it was, Strangeways and I left.");
});

// ---- multiple cases in the library at once ----------------------------------

test("the library id comes from content, never the filename", () => {
  // Two different cases, both named pseudonym_key.xlsx — as they always are.
  const caseA = keyOf([
    ["person", "Helen Rasho", "Ingrid Strangeways", "", "", "", 12],
    ["person-token", "Rasho", "Strangeways", "", "", "", 30],
    ["person-token", "Helen", "Ingrid", "", "", "", 20],
    ["case_number", "24STCV01234", "87NNCV55555", "", "", "", 4],
  ]);
  const caseB = keyOf([
    ["person", "Deng Xiaoxia", "Marta Ingersoll", "", "", "", 8],
    ["person-token", "Deng", "Ingersoll", "", "", "", 40],
    ["person-token", "Xiaoxia", "Marta", "", "", "", 22],
    ["case_number", "25STCV99887", "61NNCV12121", "", "", "", 2],
  ]);
  const lib = {};
  const a = P.libraryIdFor(lib, caseA);
  assert.strictEqual(a.refreshed, false);
  lib[a.id] = caseA;
  // Loading case B must NOT land on case A's entry.
  const b = P.libraryIdFor(lib, caseB);
  assert.strictEqual(b.refreshed, false);
  assert.notStrictEqual(b.id, a.id);
  lib[b.id] = caseB;
  assert.strictEqual(Object.keys(lib).length, 2);
});

test("the same case's refreshed key lands on its own entry", () => {
  const original = keyOf([
    ["person", "Helen Rasho", "Ingrid Strangeways", "", "", "", 12],
    ["person-token", "Rasho", "Strangeways", "", "", "", 30],
    ["person-token", "Helen", "Ingrid", "", "", "", 20],
    ["case_number", "24STCV01234", "87NNCV55555", "", "", "", 4],
  ]);
  // The re-run's key: everything the old one had, plus the forgotten filing's
  // new declarant — a key only ever grows.
  const refreshed = keyOf([
    ["person", "Helen Rasho", "Ingrid Strangeways", "", "", "", 14],
    ["person-token", "Rasho", "Strangeways", "", "", "", 41],
    ["person-token", "Helen", "Ingrid", "", "", "", 22],
    ["case_number", "24STCV01234", "87NNCV55555", "", "", "", 5],
    ["person", "Justin Carpenter", "Rafe Ellery", "", "", "", 6],
  ]);
  const lib = {};
  const a = P.libraryIdFor(lib, original);
  lib[a.id] = original;
  const again = P.libraryIdFor(lib, refreshed);
  assert.strictEqual(again.refreshed, true);
  assert.strictEqual(again.id, a.id); // attachments follow onto the new rows
  assert.ok(P.sameCaseKey(original, refreshed));
});

test("two tiny keys cannot coincide their way into one case", () => {
  const a = keyOf([["person", "Ann Doe", "Marlow", "", "", "", 1]]);
  const b = keyOf([["person", "Ann Doe", "Marlow", "", "", "", 1]]);
  // Identical single binding — under the shared floor of 3, still two entries.
  assert.ok(!P.sameCaseKey(a, b));
});

test("keySignature: same pairs same signature, any row order; different pairs differ", () => {
  const a = keyOf([
    ["person", "Helen Rasho", "Ingrid Strangeways", "", "", "", 12],
    ["person-token", "Rasho", "Strangeways", "", "", "", 30],
  ]);
  const b = keyOf([
    ["person-token", "Rasho", "Strangeways", "", "", "", 99],
    ["person", "Helen Rasho", "Ingrid Strangeways", "", "", "", 1],
  ]);
  assert.strictEqual(P.keySignature(a), P.keySignature(b));
  const c = keyOf([["person", "Deng Xiaoxia", "Marta Ingersoll", "", "", "", 8]]);
  assert.notStrictEqual(P.keySignature(a), P.keySignature(c));
});

test("the case hint is the real name the exports used most", () => {
  const key = keyOf([
    ["person", "Helen Rasho", "Ingrid Strangeways", "", "", "", 12],
    ["person-token", "Rasho", "Strangeways", "", "", "", 30],
    ["person", "Sarra", "Keswick", "", "alt spelling", "", 99], // never a hint
  ]);
  assert.strictEqual(key.hint, "Rasho");
});

// ---- the as-you-type prompt ---------------------------------------------------

test("endingReal fires only when the caret sits at the end of a just-typed real", () => {
  const key = keyOf([
    ["person", "Helen Rasho", "Ingrid Strangeways", "", "", "", 9],
    ["person-token", "Rasho", "Strangeways", "", "", "", 20],
    ["person-token", "As", "Quill", "", "", "", 1], // common — never prompted
  ]);
  const ahead = P.compileTypeahead(key);
  // The word just finished.
  const hit = P.endingReal(ahead, "Defendant served Rasho");
  assert.strictEqual(hit.real, "Rasho");
  assert.strictEqual(hit.fake, "Strangeways");
  // Longest first: the full name is offered whole, not its surname token.
  assert.strictEqual(P.endingReal(ahead, "Plaintiff Helen Rasho").real, "Helen Rasho");
  // Mid-word, wrong edges, and text past the word: no prompt.
  assert.strictEqual(P.endingReal(ahead, "Defendant served Rash"), null);
  assert.strictEqual(P.endingReal(ahead, "xRasho"), null);
  assert.strictEqual(P.endingReal(ahead, "Rasho appeared"), null);
  // Common English never prompts.
  assert.strictEqual(P.endingReal(ahead, "such as"), null);
  // The matched text keeps the typed casing — the swap mirrors it.
  const caps = P.endingReal(ahead, "V. HELEN RASHO");
  assert.strictEqual(caps.matched, "HELEN RASHO");
  assert.strictEqual(P.mirrorCase(caps.matched, caps.fake), "INGRID STRANGEWAYS");
  assert.strictEqual(P.mirrorCase("Rasho", "Strangeways"), "Strangeways");
  // Empty input is silent.
  assert.strictEqual(P.endingReal(ahead, ""), null);
});

// ---- possessives are the same party -------------------------------------------

test("a bare row covers the possessive: Zachary is John, so Zachary's is John's", () => {
  const key = keyOf([["person", "Zachary", "John", "", "", "", 8]]);
  // Forward (the cleaner and the swap): the 's rides across, as typed.
  const f = P.compileForward(key);
  assert.strictEqual(P.translate(f, "Zachary's motion").text, "John's motion");
  assert.strictEqual(P.translate(f, "Zachary’s motion").text, "John’s motion");
  assert.strictEqual(P.translate(f, "ZACHARY'S MOTION").text, "JOHN'S MOTION");
  // Display (fake → real): John's shows as Zachary's.
  const c = P.compile(key);
  assert.strictEqual(P.translate(c, "John's reply; John agreed.").text, "Zachary's reply; Zachary agreed.");
  // The warning sees the possessive too…
  assert.deepStrictEqual(P.findReals(P.compileReals(key), "Zachary's fault").map((h) => h.real), ["Zachary"]);
  // …and the typeahead offers the fake WITH the 's.
  const hit = P.endingReal(P.compileTypeahead(key), "It was Zachary's");
  assert.strictEqual(hit.matched, "Zachary's");
  assert.strictEqual(hit.fake, "John's");
  // No loose edges: a name that merely starts the same is untouched.
  assert.strictEqual(P.translate(f, "Zacharyson stayed").count, 0);
});

test("a possessive row covers the bare name: Zachary's is John's, so Zachary is John", () => {
  const key = keyOf([["person", "Zachary's", "John's", "", "", "", 8]]);
  const f = P.compileForward(key);
  assert.strictEqual(P.translate(f, "Zachary's car; Zachary drove.").text, "John's car; John drove.");
  const c = P.compile(key);
  assert.strictEqual(P.translate(c, "John's car; John drove.").text, "Zachary's car; Zachary drove.");
  // Both spellings warn.
  const hits = P.findReals(P.compileReals(key), "Zachary met Zachary's counsel");
  assert.deepStrictEqual(hits.map((h) => h.real).sort(), ["Zachary", "Zachary's"]);
  // A key that ALREADY has its own bare row keeps it — nothing derived over it.
  const both = keyOf([
    ["person", "Zachary's", "John's", "", "", "", 8],
    ["person", "Zachary", "John", "", "", "", 9],
  ]);
  assert.strictEqual(both.rows, 2);
  assert.strictEqual(P.translate(P.compileForward(both), "Zachary went").text, "John went");
});

// ---- Case matching --------------------------------------------------------

const CASE_KEY = {
  name: "case.xlsx",
  pairs: [
    // The key stores its real values the way a caption does — shouted. What
    // reads correctly in a sentence is NOT that, and this is the whole point.
    { real: "ZACHARY CODERRE", fake: "John Doe" },
    { real: "HELEN RASHO", fake: "Ingrid Strangeways" },
    { real: "McDonald", fake: "Quenby" },
    { real: "Cross River Bank, LLC", fake: "Zenith Holdings, LLC" },
    { real: "IBM", fake: "Onyx" },
  ],
  warn: [
    { real: "ZACHARY CODERRE", fake: "John Doe" },
    { real: "McDonald", fake: "Quenby" },
  ],
};

test("caseShape names the four shapes, and mixed is the one nothing is derived from", () => {
  assert.equal(P.caseShape("HELEN RASHO"), "upper");
  assert.equal(P.caseShape("helen rasho"), "lower");
  assert.equal(P.caseShape("Helen Rasho"), "title");
  assert.equal(P.caseShape("McDonald"), "mixed");
  assert.equal(P.caseShape("Cross River Bank, LLC"), "mixed");
  assert.equal(P.caseShape("24STCV01234"), "upper"); // its letters are shouted
  assert.equal(P.caseShape("(213) 555-0134"), "none"); // no letters to read
});

test("titling a SHOUTED value genuinely re-cases it — the reported bug", () => {
  // A key that stores "ZACHARY CODERRE" must not put a caption in the middle
  // of a sentence.
  assert.equal(P.applyCase("title", "ZACHARY CODERRE"), "Zachary Coderre");
  assert.equal(P.applyCase("title", "JOHN DOE"), "John Doe");
  assert.equal(P.applyCase("title", "zachary coderre"), "Zachary Coderre");
});

test("titling leaves alone what was written deliberately", () => {
  // Internal capitals are authored.
  assert.equal(P.applyCase("title", "McDonald"), "McDonald");
  assert.equal(P.applyCase("title", "OneWest Bank"), "OneWest Bank");
  // A capital standing in a value that is otherwise ordinary text was chosen
  // against that backdrop — there is nothing to guess about.
  assert.equal(P.applyCase("title", "Cross River Bank, LLC"), "Cross River Bank, LLC");
  assert.equal(P.applyCase("title", "IBM Credit Corp"), "IBM Credit Corp");
  // Only inside an all-caps value is the guess made, and there an initial, a
  // vowel-less short word, and the listed abbreviations keep their capitals.
  assert.equal(P.applyCase("title", "JOHN A DOE"), "John A Doe");
  assert.equal(P.applyCase("title", "CROSS RIVER BANK, LLC"), "Cross River Bank, LLC");
  assert.equal(P.applyCase("title", "SMITH DDS"), "Smith DDS");
  assert.equal(P.applyCase("title", "IBM"), "IBM");
});

test("shouting and quieting are the whole string, and an apostrophe isn't a word", () => {
  assert.equal(P.applyCase("upper", "Zachary Coderre"), "ZACHARY CODERRE");
  assert.equal(P.applyCase("lower", "ZACHARY CODERRE"), "zachary coderre");
  assert.equal(P.applyCase("title", "john's"), "John's");
  assert.equal(P.applyCase("title", "john\u2019s"), "John\u2019s");
  assert.equal(P.applyCase("mixed", "ZACHARY CODERRE"), "ZACHARY CODERRE", "nothing to derive");
});

test("the real name appears in the case the fake was written in", () => {
  const c = P.compile(CASE_KEY);
  assert.equal(P.translate(c, "John Doe filed a motion.").text, "Zachary Coderre filed a motion.");
  assert.equal(P.translate(c, "JOHN DOE, Plaintiff,").text, "ZACHARY CODERRE, Plaintiff,");
  assert.equal(P.translate(c, "john doe").text, "zachary coderre");
  assert.equal(P.translate(c, "Ingrid Strangeways moved.").text, "Helen Rasho moved.");
  assert.equal(P.translate(c, "INGRID STRANGEWAYS moved.").text, "HELEN RASHO moved.");
  assert.equal(P.translate(c, "ingrid strangeways moved.").text, "helen rasho moved.");
});

test("a value with case of its own keeps it, in every direction", () => {
  const c = P.compile(CASE_KEY);
  assert.equal(P.translate(c, "Quenby signed.").text, "McDonald signed.");
  assert.equal(P.translate(c, "QUENBY signed.").text, "MCDONALD signed.");
  assert.equal(P.translate(c, "quenby signed.").text, "mcdonald signed.");
  assert.equal(P.translate(c, "Onyx filed it.").text, "IBM filed it.");
  assert.equal(P.translate(c, "ONYX filed it.").text, "IBM filed it.");
  assert.equal(
    P.translate(c, "Zenith Holdings, LLC answered.").text,
    "Cross River Bank, LLC answered."
  );
  assert.equal(
    P.translate(c, "ZENITH HOLDINGS, LLC answered.").text,
    "CROSS RIVER BANK, LLC answered."
  );
});

test("the possessive carries the case without being read as part of it", () => {
  const c = P.compile(CASE_KEY);
  assert.equal(P.translate(c, "John Doe's motion").text, "Zachary Coderre's motion");
  assert.equal(P.translate(c, "JOHN DOE'S MOTION").text, "ZACHARY CODERRE'S MOTION");
  assert.equal(P.translate(c, "john doe's motion").text, "zachary coderre's motion");
  // The 's is cased with the sentence, never titled into its own word.
  assert.ok(P.translate(c, "John Doe's motion").text.indexOf("'S") === -1);
});

test("the caption's shout survives a line wrap in the middle of a name", () => {
  const c = P.compile(CASE_KEY);
  assert.equal(P.translate(c, "JOHN\n  DOE").text, "ZACHARY CODERRE");
  assert.equal(P.translate(c, "John\n  Doe").text, "Zachary Coderre");
});

test("the cleaner runs the same rule in the other direction", () => {
  const f = P.compileForward(CASE_KEY);
  // Typed the way the key stores it, and the way a sentence would.
  assert.equal(P.translate(f, "ZACHARY CODERRE moved.").text, "JOHN DOE moved.");
  assert.equal(P.translate(f, "Zachary Coderre moved.").text, "John Doe moved.");
  assert.equal(P.translate(f, "zachary coderre moved.").text, "john doe moved.");
  assert.equal(P.translate(f, "McDonald signed.").text, "Quenby signed.");
  assert.equal(P.translate(f, "MCDONALD signed.").text, "QUENBY signed.");
});

test("the typeahead swap offers the fake in the case the name was typed in", () => {
  const ahead = P.compileTypeahead(CASE_KEY);
  const lower = P.endingReal(ahead, "signed by zachary coderre");
  assert.equal(P.mirrorCase(lower.matched, lower.fake), "john doe");
  const caps = P.endingReal(ahead, "SIGNED BY ZACHARY CODERRE");
  assert.equal(P.mirrorCase(caps.matched, caps.fake), "JOHN DOE");
  const plain = P.endingReal(ahead, "signed by Zachary Coderre");
  assert.equal(P.mirrorCase(plain.matched, plain.fake), "John Doe");
});

// ---- a run in flight holds the display translation -------------------------
//
// The run's hand-off can fall back to the RENDERED message, and the rendered
// message is what the translation rewrites — so while a run is moving, the
// chats it can reach show the fakes. Everything else about the rule follows
// from that one sentence: it holds only while the run moves, it reaches the
// run's own chats and its matter's, and it can't outlive a driver that stopped.

const CONV_A = "11111111-2222-3333-4444-555555555555";
const CONV_B = "99999999-8888-7777-6666-555555555555";
const NOW = 1700000000000;

function run(over) {
  return Object.assign(
    {
      id: "r1",
      name: "Rasho — tentative",
      status: "running",
      lastProgressAt: NOW - 5000,
      pseudoKeyId: "key-rasho",
      chats: { c1: { url: "https://claude.ai/chat/" + CONV_A } },
    },
    over || {}
  );
}

function held(runs, opts) {
  return P.runTranslationHold(runs, Object.assign({ now: NOW }, opts || {}));
}

test("a moving run holds the translation in the chat it is driving", () => {
  const h = held([run()], { conv: CONV_A, keyId: "key-rasho" });
  assert.ok(h);
  assert.equal(h.runId, "r1");
  assert.equal(h.via, "chat");
  assert.equal(h.name, "Rasho — tentative");
});

test("it holds every chat on the run's matter, recorded or not", () => {
  // The chat a run opened a beat ago isn't in run.chats yet — the key is what
  // says it belongs to the matter under automation.
  const h = held([run()], { conv: CONV_B, keyId: "key-rasho" });
  assert.ok(h);
  assert.equal(h.via, "key");
});

test("another matter's chat is left alone", () => {
  assert.equal(held([run()], { conv: CONV_B, keyId: "key-other" }), null);
  assert.equal(held([run()], { conv: CONV_B, keyId: null }), null);
});

test("a group-mate's key holds too, through keyIdFor", () => {
  // Runs are per matter and a matter has one key: a run with no key of its own
  // answers to its group's (W.runPseudoKey), and the hold follows that answer.
  const r = run({ pseudoKeyId: null, chats: {} });
  const h = held([r], {
    conv: CONV_B,
    keyId: "key-rasho",
    keyIdFor: () => "key-rasho",
  });
  assert.ok(h);
  assert.equal(h.via, "key");
});

test("a pause, a hold, a failure or an ending puts the real names back", () => {
  for (const status of ["paused", "waiting", "error", "canceled", "done", "pending", "draft"]) {
    assert.equal(
      held([run({ status: status })], { conv: CONV_A, keyId: "key-rasho" }),
      null,
      status + " must not hold the translation"
    );
  }
});

test("a run whose driver has gone quiet holds nothing", () => {
  const dead = run({ lastProgressAt: NOW - 6 * 60 * 1000 });
  assert.equal(held([dead], { conv: CONV_A, keyId: "key-rasho" }), null);
  // Its heartbeat is the other half of the signal: a step waiting an hour for a
  // long answer is alive, and says so every 20 seconds.
  const beating = held([dead], {
    conv: CONV_A,
    keyId: "key-rasho",
    beats: { r1: NOW - 10000 },
  });
  assert.ok(beating);
  assert.equal(beating.via, "chat");
});

test("a run that has never said anything at all holds nothing", () => {
  const mute = run({ lastProgressAt: null });
  assert.equal(held([mute], { conv: CONV_A, keyId: "key-rasho" }), null);
});

test("the ceiling is the caller's to set", () => {
  const r = run({ lastProgressAt: NOW - 90 * 1000 });
  assert.ok(held([r], { conv: CONV_A, keyId: "key-rasho" }));
  assert.equal(held([r], { conv: CONV_A, keyId: "key-rasho", staleMs: 60 * 1000 }), null);
});

test("one moving run among many is enough", () => {
  const runs = [
    run({ id: "old", status: "done" }),
    run({ id: "other", status: "running", pseudoKeyId: "key-other", chats: {} }),
    run({ id: "live" }),
  ];
  const h = held(runs, { conv: CONV_A, keyId: "key-rasho" });
  assert.ok(h);
  assert.equal(h.runId, "live");
});

test("no runs, no chat, no key: nothing held", () => {
  assert.equal(held([], { conv: CONV_A, keyId: "key-rasho" }), null);
  assert.equal(held(null, { conv: CONV_A, keyId: "key-rasho" }), null);
  assert.equal(held([run()], {}), null);
});

test("a run naming this chat holds it even with no key of its own", () => {
  // The key can be attached to the CHAT through the popup while the run carries
  // none — the danger is the run driving this conversation, not where the key
  // came from.
  const h = held([run({ pseudoKeyId: null })], { conv: CONV_A, keyId: "key-rasho" });
  assert.ok(h);
  assert.equal(h.via, "chat");
});

// ---- names that leave this browser -----------------------------------------
//
// A chat's title is not display: claude.ai stores it, shows it in the sidebar
// and syncs it. A run is named for its matter, so the title is where the real
// case name would walk into Claude past every scrubbed paper.

const TITLE_KEY = {
  name: "pseudonym_key.xlsx",
  warn: [
    { real: "RASHO", fake: "STRANGEWAYS" },
    { real: "Helen Rasho", fake: "Ingrid Strangeways" },
    { real: "Cross River Bank, LLC", fake: "Zenith Holdings, LLC" },
  ],
};

test("nameCleaner swaps the matter's real name for the key's fake", () => {
  const clean = P.nameCleaner(TITLE_KEY);
  assert.equal(clean("8.11.26 Rasho MSJ"), "8.11.26 Strangeways MSJ");
  assert.equal(clean("Helen Rasho — tentative"), "Ingrid Strangeways — tentative");
  assert.equal(
    clean("Cross River Bank, LLC demurrer"),
    "Zenith Holdings, LLC demurrer"
  );
});

test("nameCleaner writes the fake in the case the name was typed in", () => {
  // A matter typed the way a caption reads must not put a caption in a title,
  // and one typed in a sentence must not shout.
  const clean = P.nameCleaner(TITLE_KEY);
  assert.equal(clean("8.11.26 RASHO MSJ"), "8.11.26 STRANGEWAYS MSJ");
  assert.equal(clean("8.11.26 rasho msj"), "8.11.26 strangeways msj");
  assert.equal(clean("Rasho's motion"), "Strangeways's motion");
});

test("nameCleaner leaves alone what the key never heard of", () => {
  // The promise is the key's own reach, and no more: a party the key doesn't
  // carry passes through, which is why the wiring says so out loud.
  const clean = P.nameCleaner(TITLE_KEY);
  assert.equal(clean("8.11.26 Fairbanks MSJ"), "8.11.26 Fairbanks MSJ");
  assert.equal(clean("Motion to Compel Arbitration"), "Motion to Compel Arbitration");
});

test("no key, no swap — and nothing thrown", () => {
  assert.equal(P.nameCleaner(null)("8.11.26 Rasho MSJ"), "8.11.26 Rasho MSJ");
  assert.equal(P.nameCleaner({ warn: [] })("8.11.26 Rasho MSJ"), "8.11.26 Rasho MSJ");
  assert.equal(P.nameCleaner(null)(null), "");
  assert.equal(P.nameCleaner(TITLE_KEY)(undefined), "");
});

test("titlePlan: no key on the matter, and the name goes as typed", () => {
  const p = P.titlePlan({ looked: true, keyId: null, key: false });
  assert.equal(p.mode, "plain");
});

test("titlePlan: the key is here, so the title is cleaned", () => {
  const p = P.titlePlan({ looked: true, keyId: "k1", key: true });
  assert.equal(p.mode, "clean");
});

test("titlePlan: a keyed matter whose key has gone sends NO title", () => {
  // Never the real name as a fallback. The chat is left unnamed and the run
  // says which way it failed.
  const p = P.titlePlan({ looked: true, keyId: "k1", key: false });
  assert.equal(p.mode, "hold");
  assert.match(p.why, /not in the key library/);
});

test("titlePlan: 'couldn't tell' is not 'no key'", () => {
  // A library that wouldn't read says nothing about whether this matter has a
  // key — so the title waits rather than guessing the safe-looking way.
  for (const state of [
    { looked: false, keyId: null, key: false },
    { looked: false, keyId: "k1", key: false },
    {},
    null,
  ]) {
    const p = P.titlePlan(state);
    assert.equal(p.mode, "hold", JSON.stringify(state));
    assert.match(p.why, /would not read/);
  }
});

// ---- the case number: the one value that stops a run ------------------------
//
// A party's name reaching claude.ai is a leak. A case number is the whole case:
// unique, public and searchable, so one of them turns a pseudonymized draft
// back into the matter it came from whatever the names were changed to.

const CASE_NO_KEY = {
  name: "pseudonym_key.xlsx",
  warn: [
    { real: "23STCV12345", fake: "26ABCD00000" },
    { real: "RASHO", fake: "STRANGEWAYS" },
  ],
};

test("caseNumbers reads the modern LASC shape", () => {
  // Two digits of filing year, the location and case-type codes, five digits.
  assert.deepEqual(P.caseNumbers("8.11.26 Rasho MSJ 23STCV12345"), ["23STCV12345"]);
  assert.deepEqual(P.caseNumbers("22SMCV01234 demurrer"), ["22SMCV01234"]);
  assert.deepEqual(P.caseNumbers("24STLC00987, 21GDCV00042"), ["24STLC00987", "21GDCV00042"]);
  assert.deepEqual(P.caseNumbers("23stcv12345"), ["23stcv12345"], "typed in lower case, still one");
});

test("caseNumbers reads the pre-2018 shape too", () => {
  // The court still carries them, and they are as real as the modern ones.
  assert.deepEqual(P.caseNumbers("BC123456 tentative"), ["BC123456"]);
  assert.deepEqual(P.caseNumbers("8.11.26 MSJ (EC098765)"), ["EC098765"]);
});

test("caseNumbers is quiet about everything else a matter name is made of", () => {
  for (const name of [
    "8.11.26 Motion to Compel Arbitration",
    "Rasho v. Strangeways — MSJ",
    "no numbers here 2023 STCV 12345",
    "Tentative ruling — 3× devil's advocate",
    "8.18.26 3:42 PM",
  ]) {
    assert.deepEqual(P.caseNumbers(name), [], name);
  }
  // Not a case number as written: the token is longer than one.
  assert.deepEqual(P.caseNumbers("123STCV123456"), []);
  assert.deepEqual(P.caseNumbers("A23STCV12345"), []);
});

test("the same number twice is one number", () => {
  assert.deepEqual(P.caseNumbers("23STCV12345 and again 23stcv12345"), ["23STCV12345"]);
});

test("covered means the key would actually SWAP it", () => {
  // Not "the rows mention it somewhere": a row reading "Case No. 23STCV12345"
  // doesn't replace the bare number, and the title cleaner wouldn't either.
  assert.deepEqual(P.uncoveredCaseNumbers(CASE_NO_KEY, ["8.11.26 MSJ 23STCV12345"]), []);
  assert.deepEqual(P.uncoveredCaseNumbers(CASE_NO_KEY, ["8.11.26 MSJ 23stcv12345"]), []);
  assert.deepEqual(P.uncoveredCaseNumbers(CASE_NO_KEY, ["8.11.26 MSJ 24STCV99999"]), [
    "24STCV99999",
  ]);
  assert.deepEqual(P.uncoveredCaseNumbers(null, ["8.11.26 MSJ 23STCV12345"]), ["23STCV12345"]);
  const wrapped = { warn: [{ real: "Case No. 23STCV12345", fake: "Case No. 26ABCD00000" }] };
  assert.deepEqual(P.uncoveredCaseNumbers(wrapped, ["8.11.26 MSJ 23STCV12345"]), [
    "23STCV12345",
  ]);
});

test("a name with no case number in it goes out", () => {
  const g = P.caseNumberGate({ names: ["8.11.26 Rasho MSJ", "Drafting"], key: null, looked: true });
  assert.equal(g.ok, true);
  assert.deepEqual(g.numbers, []);
});

test("a case number the key replaces goes out", () => {
  const g = P.caseNumberGate({
    names: ["8.11.26 Rasho MSJ 23STCV12345"],
    key: CASE_NO_KEY,
    looked: true,
  });
  assert.equal(g.ok, true);
});

test("a case number with no key, or a key that doesn't carry it, stops the run", () => {
  const none = P.caseNumberGate({ names: ["23STCV12345 MSJ"], key: null, looked: true });
  assert.equal(none.ok, false);
  assert.deepEqual(none.numbers, ["23STCV12345"]);
  assert.match(none.why, /no pseudonym key is attached/);
  assert.match(none.why, /23STCV12345/);
  // Both remedies are in the message: the run says what to do about it.
  assert.match(none.why, /Load a key that carries that number, or take it out/);

  const wrong = P.caseNumberGate({ names: ["24STCV99999 MSJ"], key: CASE_NO_KEY, looked: true });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /does not replace it/);
});

test("only the numbers the key MISSES are named", () => {
  const g = P.caseNumberGate({
    names: ["23STCV12345 and 24STCV99999"],
    key: CASE_NO_KEY,
    looked: true,
  });
  assert.equal(g.ok, false);
  assert.deepEqual(g.numbers, ["24STCV99999"], "the covered one isn't the problem");
  assert.ok(!/23STCV12345/.test(g.why), g.why);
});

test("two missing numbers read as a sentence", () => {
  const g = P.caseNumberGate({ names: ["23STCV11111 / 23STCV22222"], key: null, looked: true });
  assert.match(g.why, /23STCV11111 and 23STCV22222/);
});

test("a key library that wouldn't read stops the run too", () => {
  // "Couldn't tell" is not "the key carries it" — the whole point of the gate
  // is that nothing goes out on an assumption.
  const g = P.caseNumberGate({ names: ["23STCV12345 MSJ"], key: null, looked: false });
  assert.equal(g.ok, false);
  assert.match(g.why, /would not read/);
  // And with no case number to protect, an unreadable library stops nothing.
  assert.equal(P.caseNumberGate({ names: ["8.11.26 MSJ"], key: null, looked: false }).ok, true);
});

test("the gate reads every name that can reach a title, not just the run's", () => {
  const g = P.caseNumberGate({
    names: ["8.11.26 MSJ", "Tentative ruling", "23STCV12345 depo (B)"],
    key: null,
    looked: true,
  });
  assert.equal(g.ok, false);
  assert.deepEqual(g.numbers, ["23STCV12345"]);
});

test("no names at all is not a reason to stop", () => {
  assert.equal(P.caseNumberGate({ names: [], key: null, looked: true }).ok, true);
  assert.equal(P.caseNumberGate({}).ok, true);
  assert.equal(P.caseNumberGate(null).ok, true);
});
