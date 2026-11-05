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

// ---- the short conclusion that read as no conclusion ----------------------

test("a conclusion heading welded to its sentence is still the conclusion", () => {
  // textContent drops the <br> under a heading, so a one-sentence disposition
  // came off the page as "CONCLUSIONThe hearing ..." and the button said
  // "no CONCLUSION" over a ruling that had one.
  const welded =
    "CONCLUSIONThe hearing on the Petition for Approval of Transfer of Structured " +
    "Settlement Payment Rights is continued to a later date to be set at the hearing.";
  assert.equal(T.startsConclusion(welded), true);
  assert.equal(T.hasConclusion("NATURE OF PROCEEDINGS\n" + welded), true);
  const list = blocks(
    { text: "NATURE OF PROCEEDINGS", heading: true },
    "Petition for Approval of Transfer of Structured Settlement Payment Rights.",
    welded,
    "hr",
    "Change report",
    "The structure pass needed no changes."
  );
  const p = T.planBlocks(list);
  assert.equal(p.ok, true);
  assert.equal(p.reason, null);
  assert.equal(list[p.end].text, welded);
});

test("the welded form doesn't take other words for the heading", () => {
  assert.equal(T.startsConclusion("CONCLUSIONS OF LAW"), false);
  assert.equal(T.startsConclusion("Conclusionary allegations do not suffice."), false);
});

test("a bold line after the conclusion ends the ruling like a heading", () => {
  const list = blocks(
    { text: "NATURE OF PROCEEDINGS", heading: true },
    "Petition for Approval of Transfer of Structured Settlement Payment Rights.",
    { text: "CONCLUSION", bold: true },
    "The hearing on the Petition is continued to a later date to be set at the hearing.",
    { text: "Change report", bold: true },
    "The structure pass needed no changes."
  );
  const p = T.planBlocks(list);
  assert.equal(p.reason, null);
  assert.equal(list[p.end].text, "The hearing on the Petition is continued to a later date to be set at the hearing.");
});

test("a bold sentence in the conclusion stays in the ruling", () => {
  const list = blocks(
    { text: "NATURE OF PROCEEDINGS", heading: true },
    "Demurrer.",
    { text: "CONCLUSION", heading: true },
    "The Demurrer is SUSTAINED.",
    { text: "IT IS SO ORDERED.", bold: true }
  );
  assert.equal(list[T.planBlocks(list).end].text, "IT IS SO ORDERED.");
  assert.equal(T.looksLikeHeading("Change report"), true);
  assert.equal(T.looksLikeHeading("Change report:"), true);
  assert.equal(T.looksLikeHeading("IT IS SO ORDERED."), false);
  assert.equal(T.looksLikeHeading("x".repeat(120)), false);
});

// ---- the change report inside the conclusion's own paragraph --------------

// claude.ai draws a single newline as a <br>, so CONCLUSION, the disposition
// and "**Change report**" on consecutive lines are ONE paragraph on the page.
const L = (text, bold) => ({ text, bold: !!bold });
function para(...lines) {
  return { text: lines.map((l) => l.text).join("\n"), lines };
}

test("a bold heading line inside the conclusion's paragraph ends the ruling there", () => {
  const list = [
    { text: "Revised below." },
    { rule: true },
    para(L("NATURE OF PROCEEDINGS", true), L("Petition for Approval of Transfer of Structured Settlement Payment Rights.")),
    para(L("CONCLUSION", true), L("The Petition is denied without prejudice."), L("Change report", true)),
    { text: "1. I cut a clause." },
  ];
  const p = T.planBlocks(list);
  assert.equal(p.ok, true);
  assert.equal(p.reason, null);
  assert.equal(p.start, 2);
  assert.equal(p.end, 3);
  assert.equal(p.endLine, 2); // CONCLUSION and the disposition, not the report
});

test("the whole ruling as one block is cut inside it too", () => {
  const one = para(
    L("NATURE OF PROCEEDINGS", true),
    L("Petition."),
    L("CONCLUSION", true),
    L("Denied."),
    L("Change report", true),
    L("I cut a clause.")
  );
  const p = T.planBlocks([one, { text: "More commentary." }]);
  assert.equal(p.end, 0);
  assert.equal(p.endLine, 4);
});

test("a heading line starting the next block ends the ruling at the block before", () => {
  const list = [
    para(L("NATURE OF PROCEEDINGS", true), L("Petition.")),
    para(L("CONCLUSION", true), L("Denied.")),
    para(L("Change report", true), L("1. I cut a clause.")),
  ];
  const p = T.planBlocks(list);
  assert.equal(p.end, 1);
  assert.equal(p.endLine, -1);
});

test("bold lines that aren't headings stay in the conclusion", () => {
  const p = T.planBlocks([
    para(L("NATURE OF PROCEEDINGS", true), L("Petition.")),
    para(L("CONCLUSION", true), L("Denied."), L("IT IS SO ORDERED.", true)),
  ]);
  assert.equal(p.end, 1);
  assert.equal(p.endLine, -1);
});

test("as markdown, a bold heading line after the conclusion ends the ruling", () => {
  const md =
    "**NATURE OF PROCEEDINGS**\nPetition.\n\n**CONCLUSION**\n" +
    "The Petition is denied without prejudice.\n**Change report**\n\n1. I cut a clause.";
  const r = T.extractRuling(md);
  assert.equal(r.reason, null);
  assert.ok(r.text.endsWith("The Petition is denied without prejudice."));
  assert.equal(r.text.includes("Change report"), false);
  const atx = T.extractRuling("NATURE OF PROCEEDINGS\n\nPetition.\n\nCONCLUSION\n\nDenied.\n\n## Change report\n\nx");
  assert.ok(atx.text.endsWith("Denied."));
  // ...but not before the conclusion: a bold section heading is the ruling's.
  const mid = T.extractRuling("NATURE OF PROCEEDINGS\n\n**Analysis**\n\nText.\n\nCONCLUSION\n\nDenied.");
  assert.ok(mid.text.includes("**Analysis**"));
});

// ---- the screen-reader label over a reply that opens with the ruling -------

// claude.ai labels every reply for screen readers: "Claude responded: " and the
// reply's first line. A reply that OPENS with the ruling therefore carries the
// heading twice, the first time behind the label — and the label was taken for
// the heading. It went onto the clipboard, the ruling under it went whole with
// its change report, and the button said "no CONCLUSION".
const LABEL = "Claude responded: NATURE OF PROCEEDINGS: Hearing on Petition for Approval of Transfer";

test("a heading on its own line is told from one sharing a line", () => {
  assert.equal(T.rulingStart("NATURE OF PROCEEDINGS: Hearing on Petition."), 2);
  assert.equal(T.rulingStart("**NATURE OF PROCEEDINGS**"), 2);
  assert.equal(T.rulingStart(LABEL), 1);
  assert.equal(T.rulingStart("Here it is. NATURE OF PROCEEDINGS: Demurrer."), 1);
  assert.equal(T.rulingStart("Sure — which motion?"), 0);
  assert.equal(T.startsRuling(LABEL), true);
});

test("the label ahead of the ruling is not where the ruling starts", () => {
  const list = [
    { text: LABEL },
    para(L("NATURE OF PROCEEDINGS: Hearing on Petition for Approval of Transfer")),
    para(L("The Petition is denied without prejudice.")),
    para(L("CONCLUSION", true)),
    para(L("The Petition is denied without prejudice.")),
    para(L("Change report", true)),
    { text: "1. In Part I, I added a sentence." },
  ];
  const p = T.planBlocks(list);
  assert.equal(p.ok, true);
  assert.equal(p.reason, null);
  assert.equal(p.start, 1);
  assert.equal(p.end, 4);
});

test("the label beside ONE block holding the whole reply: the block, cut at the report", () => {
  // The exact shape that came back wrong: the label, then the reply as one
  // block, with CONCLUSION somewhere inside it rather than at its top.
  const whole = para(
    L("NATURE OF PROCEEDINGS: Hearing on Petition for Approval of Transfer"),
    L("The Petition is denied without prejudice."),
    L("BACKGROUND", true),
    L("Petitioner filed this proceeding."),
    L("CONCLUSION", true),
    L("The Petition is denied without prejudice."),
    L("Change report", true),
    L("In Part I, I added a sentence."),
    L("FLAGGED", true)
  );
  const p = T.planBlocks([{ text: LABEL }, whole]);
  assert.equal(p.ok, true);
  assert.equal(p.reason, null);
  assert.equal(p.start, 1);
  assert.equal(p.end, 1);
  assert.equal(p.endLine, 6);
});

test("a heading sharing its line still starts the ruling where nothing starts with it", () => {
  const p = T.planBlocks(
    blocks("Here it is. NATURE OF PROCEEDINGS: Demurrer.", { text: "CONCLUSION", heading: true }, "SUSTAINED.")
  );
  assert.equal(p.ok, true);
  assert.equal(p.start, 0);
  assert.equal(p.reason, null);
});

// ---- where the button goes ------------------------------------------------

test("rulingSpot: beside claude.ai's copy control when there is one", () => {
  assert.equal(T.rulingSpot({ wanted: true, placed: false, bar: true, waitedMs: 0 }), "bar");
});

test("rulingSpot: under the reply once no copy control has turned up", () => {
  assert.equal(T.rulingSpot({ wanted: true, bar: false, waitedMs: 0 }), "wait");
  assert.equal(T.rulingSpot({ wanted: true, bar: false, waitedMs: T.BELOW_AFTER_MS - 1 }), "wait");
  assert.equal(T.rulingSpot({ wanted: true, bar: false, waitedMs: T.BELOW_AFTER_MS }), "below");
});

test("rulingSpot: a placed button stays put, and goes when there's no ruling", () => {
  assert.equal(T.rulingSpot({ wanted: true, placed: true, bar: true }), "keep");
  assert.equal(T.rulingSpot({ wanted: true, placed: true, bar: false }), "keep");
  assert.equal(T.rulingSpot({ wanted: false, placed: true }), "remove");
  assert.equal(T.rulingSpot({ wanted: false, placed: false }), "keep");
  assert.equal(T.rulingSpot(null), "keep");
});

test("latestRulingCopy: a second button on the newest reply, kept while the ruling scrolls away", () => {
  const m = (sig, ruling, streaming) => ({ sig, ruling: !!ruling, streaming: !!streaming });
  const L = T.latestRulingCopy;
  // Nothing on the page, or no ruling anywhere in the chat: no button.
  assert.strictEqual(L(null, []).host, -1);
  let r = L(null, [m("a"), m("b")]);
  assert.strictEqual(r.host, -1);
  // The newest reply is the ruling: its own button is there.
  assert.strictEqual(L(null, [m("a"), m("R", 1)]).host, -1);
  // A ruling and then more talk: the button is on the newest, copying the ruling.
  r = L(null, [m("R", 1), m("b"), m("c")]);
  assert.deepStrictEqual([r.host, r.from], [2, 0]);
  // The ruling scrolls out of the page; the button stays, copying the remembered one.
  r = L(r.state, [m("b"), m("c")]);
  assert.deepStrictEqual([r.host, r.from], [1, -1]);
  r = L(r.state, [m("c")]);
  assert.deepStrictEqual([r.host, r.from], [0, -1]);
  // Scrolled up so far the newest reply is gone: no button there, nothing forgotten.
  const up = L(r.state, [m("R", 1), m("b")]);
  assert.strictEqual(up.host, -1);
  // ...unless the last reply on the page ends on screen: then it is the newest.
  const fresh = L(up.state, [m("R", 1), m("x")], { atBottom: true });
  assert.deepStrictEqual([fresh.host, fresh.from], [1, 0]);
  r = L(up.state, [m("b"), m("c")]);
  assert.deepStrictEqual([r.host, r.from], [1, -1]);
  // A new response: no button while it is written, then it moves to it.
  r = L(r.state, [m("b"), m("c"), m("d", 0, 1)]);
  assert.strictEqual(r.host, -1);
  r = L(r.state, [m("b"), m("c"), m("d")]);
  assert.deepStrictEqual([r.host, r.from], [2, -1]);
  // A newer ruling replaces the remembered one, and as the newest it has its own button.
  r = L(r.state, [m("c"), m("d"), m("R2", 1)]);
  assert.strictEqual(r.host, -1);
  r = L(r.state, [m("d"), m("R2", 1), m("e")]);
  assert.deepStrictEqual([r.host, r.from], [2, 1]);
  assert.strictEqual(r.state.rulingSig, "R2");
});

test("rulingPage: never on Claude Code; opensConclusion: a block that opens with it", () => {
  assert.strictEqual(T.rulingPage("/code/session_01abc"), false);
  assert.strictEqual(T.rulingPage("/code"), false);
  assert.strictEqual(T.rulingPage("/chat/1234"), true);
  assert.strictEqual(T.rulingPage("/cowork/abc"), true);
  assert.strictEqual(T.rulingPage("/codex"), true);
  assert.strictEqual(T.opensConclusion("CONCLUSION"), true);
  assert.strictEqual(T.opensConclusion("**Conclusion**"), true);
  assert.strictEqual(T.opensConclusion("from NATURE OF PROCEEDINGS through the CONCLUSION"), false);
});

test("linksToOpen: each openable destination once, in order", () => {
  const out = T.linksToOpen(
    [
      "https://example.com/a.pdf#page=3",
      "chrome-extension://abcdef/viewer.html?file=x.pdf#page=4",
      "https://example.com/a.pdf#page=5", // same page, another anchor: one destination
      "https://app.test/#/matter/1",
      "https://app.test/#/matter/2", // a route, not an anchor: two
      "javascript:alert(1)",
      "mailto:a@b.c",
      "#section",
      "",
      "file:///Users/me/case/opp.pdf",
      "/chat/abc",
    ],
    "https://claude.ai/chat/xyz"
  );
  assert.deepStrictEqual(out, [
    "https://example.com/a.pdf#page=3",
    "chrome-extension://abcdef/viewer.html?file=x.pdf#page=4",
    "https://app.test/#/matter/1",
    "https://app.test/#/matter/2",
    "file:///Users/me/case/opp.pdf",
    "https://claude.ai/chat/abc",
  ]);
  assert.deepStrictEqual(T.linksToOpen(null), []);
});

test("orderLinks: reading order, cases first then the rest, like Shift+Space", () => {
  const h = (url, kind, top, left) => ({ url, kind, top, left });
  const out = T.orderLinks([
    h("https://lexis.test/code?s=437c", "code", 10, 300),
    h("https://lexis.test/case?c=Aguilar", "case", 10, 20),
    h("https://lexis.test/case?c=Smith", "shortform", 200, 50),
    h("https://lexis.test/code?s=1005", undefined, 120, 10),
    h("https://lexis.test/case?c=Jones", "supra", 12, 150), // same line as Aguilar (within 4px)
    h("https://lexis.test/case?c=Aguilar#pin", "case", 300, 0), // same case again
    h("mailto:x@y.z", "case", 0, 0),
  ]);
  assert.deepStrictEqual(out, [
    "https://lexis.test/case?c=Aguilar",
    "https://lexis.test/case?c=Jones",
    "https://lexis.test/case?c=Smith",
    "https://lexis.test/code?s=437c",
    "https://lexis.test/code?s=1005",
  ]);
  assert.deepStrictEqual(T.orderLinks(null), []);
});

test("holdsRulingText: a ruling in the payload's markdown, not a mention", () => {
  assert.strictEqual(T.holdsRulingText("Here.\n\n---\n\n**NATURE OF PROCEEDINGS**\n\nMotion.\n\n## CONCLUSION\n\nGranted."), true);
  assert.strictEqual(T.holdsRulingText("## Nature of Proceedings\n\nMotion."), true);
  assert.strictEqual(T.holdsRulingText("Here is the ruling. NATURE OF PROCEEDINGS: Motion.\n\nCONCLUSION\n\nGranted."), true);
  assert.strictEqual(T.holdsRulingText("It copies from NATURE OF PROCEEDINGS through the end of the CONCLUSION."), false);
  assert.strictEqual(T.holdsRulingText(""), false);
});

test("latestRulingCopy: a ruling the payload reports but the page never showed", () => {
  const m = (sig, ruling) => ({ sig, ruling: !!ruling, streaming: false });
  const r = T.latestRulingCopy(null, [m("b"), m("c")], { unseenRuling: true });
  assert.deepStrictEqual([r.host, r.from, r.seek], [1, -1, true]);
  assert.strictEqual(T.latestRulingCopy(null, [m("b"), m("c")]).host, -1);
  // Once it has been on the page it is the ordinary remembered ruling.
  const seen = T.latestRulingCopy(r.state, [m("R", 1), m("b"), m("c")], { unseenRuling: true });
  assert.deepStrictEqual([seen.host, seen.from, !!seen.seek], [2, 0, false]);
});

test("textKey: the payload's markdown and the page's text agree", () => {
  const md = "Here is the **tentative**, with [a link](https://x.test/y).\n\n---\n\n## NATURE OF PROCEEDINGS";
  const page = "Here is the tentative, with a link.NATURE OF PROCEEDINGS";
  assert.strictEqual(T.textKey(md), T.textKey(page));
  assert.notStrictEqual(T.textKey("Another reply"), T.textKey(page));
  assert.strictEqual(T.textKey(null), "");
});
