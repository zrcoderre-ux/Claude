"use strict";

// A paste into a workflow needs a key, and the key refuses a paste of its
// real values (src/paste-guard.js).

const test = require("node:test");
const assert = require("node:assert");

const P = require("../src/pseudo.js");

const SMITH = {
  warn: [
    { real: "Helen Rasho", fake: "Ingrid Strangeways" },
    { real: "Cross River Bank", fake: "Dunmore Trust" },
  ],
};
const JONES = { warn: [{ real: "Marta Quillfeather", fake: "Odile Brannock" }] };
const MASTER = { master: true, warn: [{ real: "Tobias Wren", fake: "Silas Farrow" }] };
const LIB = { smith: SMITH, jones: JONES, master: MASTER };

test("a run with no key takes no paste at all, text or files", () => {
  const scope = { mode: "run", keyId: "" };
  assert.deepStrictEqual(P.workflowPasteHold(scope, LIB, { text: "anything" }), { hold: true, why: "nokey" });
  assert.deepStrictEqual(P.workflowPasteHold(scope, LIB, { files: 2 }), { hold: true, why: "nokey" });
  // A key id the library no longer has is no key.
  assert.strictEqual(P.workflowPasteHold({ mode: "run", keyId: "gone" }, LIB, { text: "x" }).why, "nokey");
  // Nor is the master key, or an empty one.
  assert.strictEqual(P.workflowPasteHold({ mode: "run", keyId: "master" }, LIB, { text: "x" }).why, "nokey");
  assert.strictEqual(P.workflowPasteHold({ mode: "run", keyId: "e" }, { e: { warn: [] } }, { text: "x" }).why, "nokey");
  // An empty paste is nothing to refuse.
  assert.strictEqual(P.workflowPasteHold(scope, LIB, { text: "" }).hold, false);
});

test("a template needs some key in the library", () => {
  assert.strictEqual(P.workflowPasteHold({ mode: "template" }, {}, { text: "x" }).why, "nokey");
  assert.strictEqual(P.workflowPasteHold({ mode: "template" }, { master: MASTER }, { text: "x" }).why, "nokey");
  assert.strictEqual(P.workflowPasteHold({ mode: "template" }, LIB, { text: "Summarize the motion." }).hold, false);
});

test("with the run's key, its real values are refused and a clean version offered", () => {
  const scope = { mode: "run", keyId: "smith" };
  const v = P.workflowPasteHold(scope, LIB, { text: "HELEN RASHO v. Cross River Bank" });
  assert.strictEqual(v.hold, true);
  assert.strictEqual(v.why, "reals");
  assert.deepStrictEqual(v.names.map((h) => h.real).sort(), ["Cross River Bank", "Helen Rasho"]);
  assert.deepStrictEqual(v.clean, { text: "INGRID STRANGEWAYS v. Dunmore Trust", ok: true });
  // The fakes, and another case's names, pass under this run's key.
  assert.strictEqual(P.workflowPasteHold(scope, LIB, { text: "Ingrid Strangeways; Marta Quillfeather" }).hold, false);
  // Files pass once there is a key.
  assert.strictEqual(P.workflowPasteHold(scope, LIB, { files: 1 }).hold, false);
});

test("a template reads the paste against every case's key, the master key aside", () => {
  const v = P.workflowPasteHold({ mode: "template" }, LIB, { text: "Helen Rasho and Marta Quillfeather; Tobias Wren" });
  assert.strictEqual(v.why, "reals");
  assert.deepStrictEqual(v.names.map((h) => h.real).sort(), ["Helen Rasho", "Marta Quillfeather"]);
  assert.strictEqual(v.clean.text, "Ingrid Strangeways and Odile Brannock; Tobias Wren");
  assert.strictEqual(v.clean.ok, true);
});

test("workflowPasteNote says what is missing or what it found", () => {
  const nk = P.workflowPasteNote({ why: "nokey" }, { mode: "run" });
  assert.match(nk.head, /attach a key/);
  assert.match(nk.body, /Pseudonym key/);
  assert.match(P.workflowPasteNote({ why: "nokey" }, { mode: "template" }).body, /popup/);
  const r = P.workflowPasteNote(
    { why: "reals", names: [{ real: "Helen Rasho" }], clean: { ok: true } },
    { mode: "run" }
  );
  assert.match(r.body, /“Helen Rasho”/);
  assert.match(r.body, /this run's key/);
  assert.match(r.body, /pseudonyms/);
});

test("each flagged name says which keys flagged it", () => {
  const both = { b: { warn: [{ real: "Helen Rasho", fake: "Pell Mortlake" }] }, smith: SMITH };
  const v = P.workflowPasteHold({ mode: "template" }, both, { text: "Helen Rasho" });
  assert.deepStrictEqual(v.names[0].keyIds.sort(), ["b", "smith"]);
  const r = P.workflowPasteHold({ mode: "run", keyId: "smith" }, LIB, { text: "Cross River Bank" });
  assert.deepStrictEqual(r.names[0].keyIds, ["smith"]);
});

test("unfakeInLibrary takes a wrongly flagged value out by hand, and the paste then passes", () => {
  const scope = { mode: "run", keyId: "smith" };
  const text = "Cross River Bank filed the motion.";
  const v = P.workflowPasteHold(scope, LIB, { text: text });
  const res = P.unfakeInLibrary(LIB, v.names[0].keyIds, v.names[0].real);
  assert.deepStrictEqual(res.changed, ["smith"]);
  assert.notStrictEqual(res.library, LIB);
  assert.strictEqual(LIB.smith.warn.length, 2, "the library passed in is not changed");
  // Recorded as removed by hand, so a reload of the workbook keeps it out.
  assert.deepStrictEqual(res.library.smith.unfaked.map((u) => u.real), ["Cross River Bank"]);
  assert.strictEqual(P.workflowPasteHold(scope, res.library, { text: text }).hold, false);
  // The rest of the key still guards.
  assert.strictEqual(P.workflowPasteHold(scope, res.library, { text: "Helen Rasho" }).why, "reals");
  // Nothing to take out, or the master key: the same library back.
  assert.strictEqual(P.unfakeInLibrary(LIB, ["smith"], "Nobody").library, LIB);
  assert.deepStrictEqual(P.unfakeInLibrary(LIB, ["master"], "Tobias Wren").changed, []);
  assert.deepStrictEqual(P.unfakeInLibrary(LIB, ["gone"], "Helen Rasho").changed, []);
});

test("a key emptied by hand is still a key", () => {
  let lib = { one: { warn: [{ real: "Helen Rasho", fake: "Ingrid Strangeways" }], pairs: [{ real: "Helen Rasho", fake: "Ingrid Strangeways" }] } };
  lib = P.unfakeInLibrary(lib, ["one"], "Helen Rasho").library;
  assert.strictEqual(P.workflowPasteHold({ mode: "run", keyId: "one" }, lib, { text: "Helen Rasho" }).hold, false);
});

test("a run's chat takes no paste without the run's key, and holds its real values", () => {
  const H = [{ real: "Helen Rasho", fake: "Ingrid Strangeways" }];
  // Not a run's chat: this rule says nothing (the composer's own check runs).
  assert.strictEqual(P.runChatPasteHold({ runChat: false, hasKey: false, text: "x" }).hold, false);
  assert.deepStrictEqual(P.runChatPasteHold({ runChat: true, hasKey: false, text: "x" }), { hold: true, why: "nokey" });
  assert.strictEqual(P.runChatPasteHold({ runChat: true, hasKey: false, files: true }).why, "nokey");
  assert.strictEqual(P.runChatPasteHold({ runChat: true, hasKey: false, text: "" }).hold, false);
  const r = P.runChatPasteHold({ runChat: true, hasKey: true, text: "Helen Rasho", hits: H });
  assert.strictEqual(r.why, "reals");
  assert.strictEqual(r.names[0].real, "Helen Rasho");
  // With the key: clean text, files, a law report, a paste let through once.
  assert.strictEqual(P.runChatPasteHold({ runChat: true, hasKey: true, text: "plain", hits: [] }).hold, false);
  assert.strictEqual(P.runChatPasteHold({ runChat: true, hasKey: true, files: true }).hold, false);
  assert.strictEqual(P.runChatPasteHold({ runChat: true, hasKey: true, text: "x", hits: H, report: true }).hold, false);
  assert.strictEqual(P.runChatPasteHold({ runChat: true, hasKey: false, text: "x", allowed: true }).hold, false);
  assert.match(P.runChatPasteNote({ why: "nokey" }).body, /Pseudonym key/);
  assert.match(P.runChatPasteNote({ why: "reals", names: H }).body, /faked at the send/);
});
