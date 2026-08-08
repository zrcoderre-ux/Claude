const test = require("node:test");
const assert = require("node:assert");
const T = require("../src/toc.js");

test("a label is the first line that actually says something", () => {
  assert.equal(T.tocLabel("Draft the tentative ruling\n\nmore"), "Draft the tentative ruling");
  // Markdown decoration is not part of what the line says.
  assert.equal(T.tocLabel("## Revise the ruling"), "Revise the ruling");
  assert.equal(T.tocLabel("> quoted opening\nrest"), "quoted opening");
  assert.equal(T.tocLabel("1. First question"), "First question");
  assert.equal(T.tocLabel("**Bold opening**"), "Bold opening");
  // Blank leaders are skipped rather than taken as an empty label.
  assert.equal(T.tocLabel("\n\n   \nThe real first line"), "The real first line");
  assert.equal(T.tocLabel(""), "");
  assert.equal(T.tocLabel(null), "");
});

test("an opening that every prompt shares is stepped over", () => {
  // If each entry read "Use the devils-advocate skill", the list would
  // distinguish nothing — which is the whole job of a list.
  assert.equal(
    T.tocLabel("Use the devils-advocate skill.\n\nAttack the draft ruling below."),
    "Attack the draft ruling below."
  );
  assert.equal(T.tocLabel("Continue\n\nNow do the costs section."), "Now do the costs section.");
  // Unless it's all there is — an entry has to say something.
  assert.equal(T.tocLabel("Use the tentative-ruling skill"), "Use the tentative-ruling skill");
  assert.equal(T.tocLabel("Continue"), "Continue");
});

test("a long line is cut at a word, not through one", () => {
  const line = "Draft a California civil tentative ruling on the attached motion package today";
  const out = T.tocLabel(line, 40);
  assert.ok(out.length <= 41, out.length);
  assert.ok(out.endsWith("…"));
  assert.ok(!/\s…$/.test(out), "no space left dangling before the ellipsis");
  // The cut lands on a word boundary, so the label reads as shortened rather
  // than as text that has gone missing.
  assert.ok(line.startsWith(out.slice(0, -1)), out);
  assert.ok(out.slice(0, -1).split(" ").length > 3, out);

  // A single unbroken run has no boundary to find, and is cut anyway.
  const long = T.tocLabel("x".repeat(200), 30);
  assert.ok(long.length <= 31, long.length);
});

test("entries are numbered in the order they were sent", () => {
  const list = T.tocEntries([
    { text: "First question" },
    { text: "Use the devils-advocate skill.\n\nSecond question" },
    { text: "Third question" },
  ]);
  assert.deepEqual(list.map((e) => e.n), [1, 2, 3]);
  assert.deepEqual(list.map((e) => e.label), [
    "First question",
    "Second question",
    "Third question",
  ]);
});

test("a message with nothing to label still gets an entry", () => {
  // An upload with no words happened, and takes up room in the chat. Skipping
  // it would put entry 2 where the third message is, which is worse than a
  // vague entry — the number is what you navigate by.
  const list = T.tocEntries([{ text: "First" }, { text: "   " }, { text: "Third" }]);
  assert.deepEqual(list.map((e) => e.n), [1, 2, 3]);
  assert.equal(list[1].label, "(no text)");
  assert.equal(list[1].empty, true);
  assert.equal(list[0].empty, false);

  assert.deepEqual(T.tocEntries([]), []);
  assert.deepEqual(T.tocEntries(null), []);
  // Plain strings work as well as objects, since that's what the DOM gives.
  assert.equal(T.tocEntries(["Hello there"])[0].label, "Hello there");
});
