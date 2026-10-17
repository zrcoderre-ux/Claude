"use strict";

const test = require("node:test");
const assert = require("node:assert");

const M = require("../src/pseudomark.js");
const P = require("../src/pseudo.js");

test("the defaults are the PDF viewer's: on, a light cyan, 0.18", () => {
  assert.deepStrictEqual(M.normalizeMark(null), { on: true, color: "#19dcfa", alpha: 0.18 });
  assert.deepStrictEqual(M.normalizeMark({}), M.DEFAULT_MARK);
});

test("a bad colour or intensity falls back rather than painting nothing", () => {
  assert.strictEqual(M.normalizeMark({ color: "red" }).color, "#19dcfa");
  assert.strictEqual(M.normalizeMark({ color: "#ABCDEF" }).color, "#abcdef");
  assert.strictEqual(M.normalizeMark({ alpha: "x" }).alpha, 0.18);
  assert.strictEqual(M.normalizeMark({ alpha: null }).alpha, 0.18);
  assert.strictEqual(M.normalizeMark({ alpha: 0 }).alpha, M.ALPHA_MIN);
  assert.strictEqual(M.normalizeMark({ alpha: 5 }).alpha, M.ALPHA_MAX);
  assert.strictEqual(M.normalizeMark({ on: false }).on, false);
});

test("the fills: the mark, and a stronger one under the pointer", () => {
  assert.deepStrictEqual(M.markColors({ color: "#ff0080", alpha: 0.2 }), {
    bg: "rgba(255, 0, 128, 0.200)",
    hover: "rgba(255, 0, 128, 0.500)",
  });
  assert.strictEqual(M.markColors({ alpha: 0.9 }).hover, "rgba(25, 220, 250, 1.000)");
  assert.match(M.markCss(null), /::highlight\(cum-pseudo\)\{background-color:rgba\(25, 220, 250, 0\.180\)\}/);
  assert.match(M.markCss(null), /::highlight\(cum-pseudo-hover\)/);
});

test("the swap under the caret, its far edge included where nothing starts there", () => {
  const spans = [[0, 5, "Doe"], [5, 9, "Roe"], [12, 16, "Poe"]];
  assert.strictEqual(M.spanAt(spans, 0)[2], "Doe");
  assert.strictEqual(M.spanAt(spans, 5)[2], "Roe"); // a span starts here: it wins
  assert.strictEqual(M.spanAt(spans, 9)[2], "Roe"); // the far edge
  assert.strictEqual(M.spanAt(spans, 10), null);
  assert.strictEqual(M.spanAt(spans, 16)[2], "Poe");
  assert.strictEqual(M.spanAt([], 0), null);
  assert.strictEqual(M.spanAt(spans, -1), null);
});

test("translate says where each swap landed, in the text it returns", () => {
  const c = P.compile({
    pairs: [
      { fake: "Strangeways", real: "Rasho" },
      { fake: "Ingrid Strangeways", real: "Helen Rasho" },
      { fake: "Smith", real: "Coderre" },
    ],
  });
  const r = P.translate(c, "INGRID STRANGEWAYS met Strangeways\u2019s lawyer.");
  assert.deepStrictEqual(
    r.spans.map((s) => [r.text.slice(s[0], s[1]), s[2]]),
    [["HELEN RASHO", "INGRID STRANGEWAYS"], ["Rasho\u2019s", "Strangeways\u2019s"]]
  );
  // A name held in a citation is no swap and gets no mark.
  const h = P.translate(c, "Smith relies on Smith v. Jones (2010) 50 Cal.4th 100.", { citations: true });
  assert.deepStrictEqual(h.spans, [[0, 7, "Smith"]]);
  assert.deepStrictEqual(P.translate(c, "").spans, []);
});

test("the hover names the pseudonym", () => {
  assert.strictEqual(M.tipText("Ingrid Strangeways"), "Pseudonym: Ingrid Strangeways");
});
