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

test("the same message is the same message however it was read", () => {
  // The payload's copy and the page's copy of one prompt differ in whitespace
  // and nothing else, and a key that told them apart would list both.
  assert.equal(
    T.entryKey("Draft the ruling"),
    T.entryKey("  draft   the\n  ruling  ")
  );
  assert.notEqual(T.entryKey("Draft the ruling"), T.entryKey("Draft the order"));
  assert.equal(T.entryKey(null), "");
});

const win = (...texts) => T.tocEntries(texts.map((t) => ({ text: t })));

test("scrolling adds to the list instead of replacing it", () => {
  // claude.ai unmounts what scrolls out of view, so each look at the page is a
  // WINDOW. Rebuilding from it is what made entries disappear behind you.
  const all = win("one", "two", "three", "four", "five");
  const top = win("one", "two", "three");
  const bottom = win("three", "four", "five");

  // Scrolled down: the window slides, the list grows.
  assert.deepEqual(T.mergeWindows(top, bottom).map((e) => e.label), [
    "one", "two", "three", "four", "five",
  ]);
  // And back up again: still five, not eight.
  assert.deepEqual(T.mergeWindows(bottom, top).map((e) => e.label), [
    "one", "two", "three", "four", "five",
  ]);
  // A window wholly inside what's known changes nothing but its own entries.
  assert.deepEqual(T.mergeWindows(all, win("three", "four")).map((e) => e.label),
    all.map((e) => e.label));
  // Numbering is of the list, not of the window it arrived in.
  assert.deepEqual(T.mergeWindows(top, bottom).map((e) => e.n), [1, 2, 3, 4, 5]);
});

test("a merge that can't find any overlap keeps both halves", () => {
  // Jumped far enough that the windows share nothing: the new one can only be
  // further down, and guessing wrong costs an entry out of order — where
  // dropping it costs the bookmark itself.
  const a = win("one", "two");
  const b = win("nine", "ten");
  assert.deepEqual(T.mergeWindows(a, b).map((e) => e.label), ["one", "two", "nine", "ten"]);
  assert.deepEqual(T.mergeWindows([], b).map((e) => e.label), ["nine", "ten"]);
  assert.deepEqual(T.mergeWindows(a, []).map((e) => e.label), ["one", "two"]);
  assert.deepEqual(T.mergeWindows(null, null), []);
});

test("a workflow's own prompts are marked with the step that sent them", () => {
  // A run's message is its step's prompt with the carried material pasted
  // under it, so the turn BEGINS with the prompt.
  const entries = win(
    "Draft the tentative ruling on the attached motion",
    "Attack the draft ruling below.\n\n----- BEGIN DRAFT -----\nblah\n----- END DRAFT -----",
    "something I typed myself",
    "Attack the draft ruling below.\n\n----- BEGIN DRAFT -----\nrevised\n----- END DRAFT -----"
  );
  const marked = T.stepMarks(entries, [
    { label: "1", prompt: "Draft the tentative ruling on the attached motion", runName: "Smith" },
    { label: "2A", prompt: "Attack the draft ruling below." },
    { label: "4", prompt: "Attack the draft ruling below." },
  ]);
  assert.deepEqual(marked.map((e) => e.step || null), ["1", "2A", null, "4"]);
  assert.equal(marked[0].run, "Smith");
  // The one you typed keeps its place in the numbering and is simply unmarked.
  assert.equal(marked[2].step, undefined);

  // Steps are claimed in order: the second identical prompt belongs to the
  // second step, not both of them to the first.
  const twice = T.stepMarks(win("Continue with the next section", "Continue with the next section"), [
    { label: "2", prompt: "Continue with the next section" },
    { label: "3", prompt: "Continue with the next section" },
  ]);
  assert.deepEqual(twice.map((e) => e.step), ["2", "3"]);

  // A prompt too short to be distinctive has to match outright, or it would
  // claim any message that opened with the same word.
  const shortish = T.stepMarks(win("Continue please, with the costs section"), [
    { label: "2", prompt: "Continue" },
  ]);
  assert.equal(shortish[0].step, undefined);
  assert.deepEqual(T.stepMarks(entries, []), entries);
});

test("seeking an unmounted message aims by how far through the chat it is", () => {
  // Nothing to scroll TO — the entry isn't rendered — so the first move is a
  // proportion of the scroll, and the caller measures where it landed and goes
  // again.
  assert.equal(T.seekDelta(0, 10, 1000, 20), 500);
  assert.equal(T.seekDelta(10, 0, 1000, 20), -500);
  assert.equal(T.seekDelta(5, 5, 1000, 20), 0);
  // No list to be a proportion of: don't move.
  assert.equal(T.seekDelta(0, 10, 1000, 0), 0);
  assert.equal(T.seekDelta(0, 10, 0, 20), 0);
});

// ---- the list tracks replies, keyed to the prompts they answer -------------

test("a reply entry carries the key of the prompt it answers", () => {
  const list = T.tocEntries([
    { text: "The ruling is granted for three reasons…", prev: "Draft the tentative ruling for the attached motion." },
    { text: "Here is the revision.", prev: null },
  ]);
  assert.equal(list[0].prevKey, T.entryKey("Draft the tentative ruling for the attached motion."));
  assert.equal(list[1].prevKey, "");
  assert.equal(list[0].key, T.entryKey("The ruling is granted for three reasons…"));
});

test("a step claims the REPLY that answers its prompt", () => {
  const entries = T.tocEntries([
    { text: "Understood, reading the papers now.", prev: "Use the tentative-ruling skill." },
    { text: "TENTATIVE RULING: the motion is granted…", prev: "Draft the tentative ruling for the attached motion papers." },
  ]);
  const marked = T.stepMarks(entries, [
    { label: "1", prompt: "Draft the tentative ruling for the attached motion papers.", runName: "MSJ" },
  ]);
  assert.equal(marked[0].step, undefined);
  assert.equal(marked[1].step, "1");
  assert.equal(marked[1].run, "MSJ");
});

test("findByPrompt lands on the reply, and says so when the list has nothing", () => {
  const entries = T.tocEntries([
    { text: "Reply one.", prev: "First prompt, long enough to be distinctive." },
    { text: "Reply two.", prev: "Second prompt, also long enough to matter." },
  ]);
  assert.equal(T.findByPrompt(entries, "Second prompt, also long enough to matter."), 1);
  // The run pastes carried material under the prompt, so prefix matching holds.
  assert.equal(T.findByPrompt(entries, "First prompt, long enough to be distinctive."), 0);
  assert.equal(T.findByPrompt(entries, "never sent"), -1);
  assert.equal(T.findByPrompt([], "anything at all here"), -1);
  assert.equal(T.findByPrompt(entries, ""), -1);
});

test("prompt-built entries without prevKey still match on their own key", () => {
  // The old shape — lists built from prompts — keeps working, which is what
  // lets the two shapes coexist across an update.
  const entries = T.tocEntries([{ text: "Draft the ruling for the attached papers." }]);
  const marked = T.stepMarks(entries, [{ label: "1", prompt: "Draft the ruling for the attached papers." }]);
  assert.equal(marked[0].step, "1");
});
