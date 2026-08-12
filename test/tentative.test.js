const test = require("node:test");
const assert = require("node:assert");
const T = require("../src/tentative.js");

// A reply shaped the way Claude actually sends one: a note, a rule, the ruling,
// a rule, and an offer to revise.
const REPLY = [
  "I've drafted the tentative below. Note that the reply brief wasn't in the",
  "packet, so I've assumed none was filed.",
  "",
  "---",
  "",
  "## NATURE OF PROCEEDINGS",
  "",
  "Defendant's Demurrer to the First Amended Complaint.",
  "",
  "## DISCUSSION",
  "",
  "The first cause of action fails to state facts sufficient to constitute a",
  "cause of action.",
  "",
  "## CONCLUSION",
  "",
  "The demurrer is SUSTAINED with 20 days' leave to amend. Moving party to give",
  "notice.",
  "",
  "---",
  "",
  "Would you like me to add a paragraph on the request for judicial notice?",
].join("\n");

test("the ruling comes out, and nothing on either side of it does", () => {
  const r = T.extractRuling(REPLY);
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.ok(r.text.startsWith("## NATURE OF PROCEEDINGS"));
  assert.ok(r.text.endsWith("notice."));
  // Neither the preamble nor the offer underneath.
  assert.equal(r.text.includes("I've drafted"), false);
  assert.equal(r.text.includes("Would you like"), false);
  // Nor the rules that separated them.
  assert.equal(r.text.includes("---"), false);
  // What is in between is untouched.
  assert.ok(r.text.includes("## DISCUSSION"));
  assert.ok(r.text.includes("SUSTAINED with 20 days' leave to amend"));
});

test("a reply that is only the ruling comes back whole", () => {
  const only = [
    "NATURE OF PROCEEDINGS",
    "",
    "Motion to Compel Arbitration.",
    "",
    "CONCLUSION",
    "",
    "The motion is GRANTED.",
  ].join("\n");
  const r = T.extractRuling(only);
  assert.equal(r.ok, true);
  assert.equal(r.text, only);
});

test("a rule inside the ruling doesn't end it", () => {
  // A long ruling may well be ruled off between its own sections. Ending at the
  // first break after the START would hand back the first section alone.
  const withRules = [
    "**NATURE OF PROCEEDINGS**",
    "",
    "Motion for Summary Judgment.",
    "",
    "---",
    "",
    "**DISCUSSION**",
    "",
    "Triable issues remain as to causation.",
    "",
    "---",
    "",
    "**CONCLUSION**",
    "",
    "The motion is DENIED.",
    "",
    "---",
    "",
    "I can expand the causation discussion if you'd like.",
  ].join("\n");
  const r = T.extractRuling(withRules);
  assert.ok(r.text.includes("**DISCUSSION**"));
  assert.ok(r.text.endsWith("The motion is DENIED."));
  assert.equal(r.text.includes("---"), false);
  assert.equal(r.text.includes("I can expand"), false);
});

test("a Conclusion in Claude's remarks underneath is not the ruling's", () => {
  const trailing = [
    "NATURE OF PROCEEDINGS",
    "",
    "Demurrer.",
    "",
    "CONCLUSION",
    "",
    "The demurrer is OVERRULED.",
    "",
    "---",
    "",
    "## Conclusion",
    "",
    "That's the ruling — let me know if the caption needs changing.",
  ].join("\n");
  const r = T.extractRuling(trailing);
  assert.ok(r.text.endsWith("The demurrer is OVERRULED."));
  assert.equal(r.text.includes("let me know"), false);
});

test("a setext underline is a heading, not the end of the ruling", () => {
  // "CONCLUSION" with --- under it IS the conclusion heading. Reading that rule
  // as a break would cut off the disposition — the one line that has to travel.
  const setext = [
    "NATURE OF PROCEEDINGS",
    "---------------------",
    "",
    "Motion to Strike.",
    "",
    "CONCLUSION",
    "----------",
    "",
    "The motion is GRANTED in part.",
  ].join("\n");
  const r = T.extractRuling(setext);
  assert.equal(r.ok, true);
  assert.ok(r.text.includes("The motion is GRANTED in part."));
});

test("the horizontal rule is recognised however it was written", () => {
  for (const rule of ["---", "***", "___", "- - -", "  ---  ", "—————", "*****"])
    assert.equal(T.isBreak(["", rule], 1), true, rule);
  // Not a rule: text, a list item, or a rule sitting directly under a line
  // (which makes it a setext heading instead).
  assert.equal(T.isBreak(["", "-- "], 1), false);
  assert.equal(T.isBreak(["", "- item"], 1), false);
  assert.equal(T.isBreak(["HEADING", "---"], 1), false);
});

test("a heading sharing its line with other text still starts the ruling", () => {
  const inline = "Here it is. NATURE OF PROCEEDINGS: Demurrer.\n\nCONCLUSION\n\nSUSTAINED.";
  const r = T.extractRuling(inline);
  assert.equal(r.ok, true);
  assert.ok(r.text.startsWith("NATURE OF PROCEEDINGS: Demurrer."));
  assert.equal(r.text.includes("Here it is."), false);
});

test("the heading is matched however it was decorated", () => {
  for (const head of [
    "## NATURE OF PROCEEDINGS",
    "**NATURE OF PROCEEDINGS**",
    "NATURE OF PROCEEDINGS:",
    "### **Nature of the Proceedings**",
    "> NATURE OF PROCEEDINGS",
  ]) {
    const r = T.extractRuling(head + "\n\nBody.\n\nCONCLUSION\n\nGRANTED.");
    assert.equal(r.ok, true, head);
    assert.ok(r.text.endsWith("GRANTED."), head);
  }
});

test("no ruling in the reply is said so, not guessed at", () => {
  const r = T.extractRuling("Sure — which motion did you want the tentative on?");
  assert.equal(r.ok, false);
  assert.equal(r.text, "");
  assert.match(r.reason, /NATURE OF PROCEEDINGS/);
  assert.equal(T.extractRuling("").ok, false);
  assert.equal(T.extractRuling(null).ok, false);
});

test("a ruling with no conclusion is copied, with the caveat said out loud", () => {
  const partial = "NATURE OF PROCEEDINGS\n\nDemurrer.\n\nDISCUSSION\n\nThe pleading is uncertain.";
  const r = T.extractRuling(partial);
  assert.equal(r.ok, true);
  assert.ok(r.text.includes("The pleading is uncertain."));
  assert.match(r.reason, /no CONCLUSION/);
  // ...and it still stops at the rule, where there is one.
  const cut = partial + "\n\n---\n\nShall I draft the conclusion?";
  const r2 = T.extractRuling(cut);
  assert.equal(r2.text.includes("Shall I draft"), false);
});

test("the gap a dropped rule leaves doesn't survive in the text", () => {
  const r = T.extractRuling(
    "NATURE OF PROCEEDINGS\n\nDemurrer.\n\n---\n\nCONCLUSION\n\nSUSTAINED."
  );
  assert.equal(r.text, "NATURE OF PROCEEDINGS\n\nDemurrer.\n\nCONCLUSION\n\nSUSTAINED.");
});

test("windows line endings don't change the answer", () => {
  const r = T.extractRuling("NATURE OF PROCEEDINGS\r\n\r\nDemurrer.\r\n\r\nCONCLUSION\r\n\r\nGRANTED.");
  assert.equal(r.text, "NATURE OF PROCEEDINGS\n\nDemurrer.\n\nCONCLUSION\n\nGRANTED.");
});

test("whether a reply has a ruling at all is answerable off the page", () => {
  // Read from the DOM the blocks run together, so this can't be line-anchored.
  assert.equal(T.mentionsRuling("NATURE OF PROCEEDINGSDefendant's demurrer."), true);
  assert.equal(T.mentionsRuling("Nature of the Proceedings"), true);
  assert.equal(T.mentionsRuling("Sure, which motion?"), false);
  assert.equal(T.mentionsRuling(""), false);
  assert.equal(T.mentionsRuling(null), false);
});
