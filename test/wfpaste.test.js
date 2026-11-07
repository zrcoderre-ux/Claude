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
