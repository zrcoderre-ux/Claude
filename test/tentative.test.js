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

// ---- the same decision over the page's own blocks -------------------------

// The shape that came back wrong: remarks, a rule, the ruling, a rule, a change
// report — with the rule written as a run of underscores.
function blocks(...spec) {
  return spec.map((s) =>
    s === "hr"
      ? { rule: true }
      : typeof s === "string"
        ? { text: s }
        : s
  );
}

test("the page's own <hr> ends the ruling, whatever the text of it would be", () => {
  const list = blocks(
    "Cleveland is stronger than I credited, and the full text settles two things.",
    "The quotation is set out below, cited to Cleveland at 682-683.",
    "hr",
    { text: "NATURE OF PROCEEDINGS", heading: true },
    "Hearing on Demurrer — with Motion to Strike.",
    { text: "BACKGROUND", heading: true },
    "Plaintiff filed this action against Defendant.",
    { text: "CONCLUSION", heading: true },
    "The Demurrer is sustained without leave to amend.",
    "hr",
    { text: "Change report", heading: true },
    "Cleveland now carries the holding instead of being distinguished."
  );
  const p = T.planBlocks(list);
  assert.equal(p.ok, true);
  assert.equal(p.reason, null);
  assert.equal(list[p.start].text, "NATURE OF PROCEEDINGS");
  assert.equal(list[p.end].text, "The Demurrer is sustained without leave to amend.");
});

test("a heading after the conclusion ends it too, where there is no rule", () => {
  // Claude doesn't always draw the line. A ruling has no section after its
  // conclusion, so a heading there belongs to whatever was written underneath.
  const list = blocks(
    { text: "NATURE OF PROCEEDINGS", heading: true },
    "Demurrer.",
    { text: "CONCLUSION", heading: true },
    "The Demurrer is OVERRULED.",
    { text: "Change report", heading: true },
    "Two further conclusions are quoted."
  );
  const p = T.planBlocks(list);
  assert.equal(list[p.end].text, "The Demurrer is OVERRULED.");
});

test("a heading BEFORE the conclusion is just another section", () => {
  const list = blocks(
    { text: "NATURE OF PROCEEDINGS", heading: true },
    "Demurrer.",
    { text: "ANALYSIS", heading: true },
    "The first cause of action fails.",
    { text: "CONCLUSION", heading: true },
    "SUSTAINED."
  );
  const p = T.planBlocks(list);
  assert.equal(p.start, 0);
  assert.equal(list[p.end].text, "SUSTAINED.");
});

test("a rule inside the ruling doesn't end it, on the page either", () => {
  const list = blocks(
    { text: "NATURE OF PROCEEDINGS", heading: true },
    "Motion for Summary Judgment.",
    "hr",
    { text: "DISCUSSION", heading: true },
    "Triable issues remain.",
    { text: "CONCLUSION", heading: true },
    "DENIED.",
    "hr",
    "Shall I expand the causation discussion?"
  );
  const p = T.planBlocks(list);
  assert.equal(p.start, 0);
  assert.equal(list[p.end].text, "DENIED.");
});

test("a block read off the page brings its own indentation, and still matches", () => {
  // textContent carries the source's whitespace, so a wrapper holding the
  // ruling begins with a newline. Taking its literal first line found nothing,
  // and a ruling nested one element deeper than expected went unrecognised.
  const wrapped = "\n      NATURE OF PROCEEDINGS\n      Hearing on Demurrer.\n      CONCLUSION\n      SUSTAINED.\n    ";
  assert.equal(T.startsRuling(wrapped), true);
  const p = T.planBlocks(blocks(wrapped, "hr", "Shall I revise?"));
  assert.equal(p.ok, true);
  assert.equal(p.start, 0);
  assert.equal(p.end, 0);
  // Its conclusion is inside it, so no caveat is reported: a warning about a
  // ruling that plainly has a conclusion teaches you to ignore the warning.
  assert.equal(p.reason, null);
  assert.equal(T.hasConclusion(wrapped), true);
  assert.equal(T.hasConclusion("NATURE OF PROCEEDINGS\nDemurrer."), false);
});

test("no ruling among the blocks is said so, not guessed at", () => {
  assert.equal(T.planBlocks(blocks("Sure — which motion?", "hr", "Let me know.")).ok, false);
  assert.equal(T.planBlocks([]).ok, false);
  assert.equal(T.planBlocks(null).ok, false);
});

test("a ruling in blocks with no conclusion carries the caveat", () => {
  const p = T.planBlocks(
    blocks({ text: "NATURE OF PROCEEDINGS", heading: true }, "Demurrer.", "The pleading is uncertain.")
  );
  assert.equal(p.ok, true);
  assert.equal(p.end, 2);
  assert.match(p.reason, /no CONCLUSION/);
});

// ---- the underscore rule, which is what came back wrong -------------------

test("a run of underscores is a break even with text directly above it", () => {
  // Only `-` and `=` underline a setext heading. Requiring a blank line above
  // every rule lost the end of a ruling in a reply whose paragraphs had none.
  const bar = "________________________________________";
  assert.equal(T.isBreak(["Some text.", bar], 1), true);
  assert.equal(T.isBreak(["Some text.", "***"], 1), true);
  // A dash rule still defers to the setext reading.
  assert.equal(T.isBreak(["CONCLUSION", "---"], 1), false);
  assert.equal(T.isBreak(["", "---"], 1), true);
});

test("the reply that came back wrong, as text, now cuts where it should", () => {
  const tight = [
    "Cleveland is stronger than I credited, and the full text settles two things.",
    "The quotation is set out below, cited to Cleveland at 682-683.",
    "________________________________________",
    "NATURE OF PROCEEDINGS",
    "Hearing on Demurrer — with Motion to Strike.",
    "CONCLUSION",
    "The Demurrer is sustained without leave to amend.",
    "________________________________________",
    "Change report",
    "Cleveland now carries the holding instead of being distinguished.",
  ].join("\n");
  const r = T.extractRuling(tight);
  assert.equal(r.ok, true);
  assert.equal(r.text.includes("Cleveland is stronger"), false);
  assert.equal(r.text.includes("Change report"), false);
  assert.equal(r.text.includes("____"), false);
  assert.ok(r.text.startsWith("NATURE OF PROCEEDINGS"));
  assert.ok(r.text.endsWith("The Demurrer is sustained without leave to amend."));
});

test("whether a reply has a ruling at all is answerable off the page", () => {
  // Read from the DOM the blocks run together, so this can't be line-anchored.
  assert.equal(T.mentionsRuling("NATURE OF PROCEEDINGSDefendant's demurrer."), true);
  assert.equal(T.mentionsRuling("Nature of the Proceedings"), true);
  assert.equal(T.mentionsRuling("Sure, which motion?"), false);
  assert.equal(T.mentionsRuling(""), false);
  assert.equal(T.mentionsRuling(null), false);
});
