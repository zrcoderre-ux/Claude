const test = require("node:test");
const assert = require("node:assert");
const K = require("../src/cowork.js");

test("a mode is read from the label claude.ai actually renders", () => {
  assert.equal(K.modeFromLabel("Manually approve"), "manual");
  assert.equal(K.modeFromLabel("Automatically approve"), "auto");
  assert.equal(K.modeFromLabel("Skip all approvals"), "skip");
});

test("the menu row runs the name into its description, so matching is by prefix", () => {
  // Exactly the strings the probe pulled off the live menu.
  assert.equal(
    K.modeFromLabel("Manually approveClaude pauses so you can approve each action"),
    "manual"
  );
  assert.equal(
    K.modeFromLabel("Automatically approveClaude runs on its own and pauses to ask"),
    "auto"
  );
  assert.equal(
    K.modeFromLabel("Skip all approvalsClaude never pauses, even for unsafe actions"),
    "skip"
  );
});

test("a description that mentions another mode doesn't steal the row", () => {
  // A substring test would call this "skip". Only the opening words count.
  assert.equal(
    K.modeFromLabel("Manually approveUnlike skip all approvals, Claude waits"),
    "manual"
  );
});

test("the short form on the trigger, and a stored key, both read back", () => {
  assert.equal(K.modeFromLabel("Auto"), "auto");
  assert.equal(K.modeFromLabel("auto"), "auto");
  assert.equal(K.modeFromLabel("skip"), "skip");
});

test("anything unrecognised is 'leave it alone', never a guess", () => {
  assert.equal(K.modeFromLabel(""), "");
  assert.equal(K.modeFromLabel(null), "");
  assert.equal(K.modeFromLabel(undefined), "");
  assert.equal(K.modeFromLabel("Model: Opus 5 High"), "");
  assert.equal(K.modeFromLabel("approve"), "");
});

test("whitespace and case in the page's markup don't matter", () => {
  assert.equal(K.modeFromLabel("  automatically   approve  "), "auto");
  assert.equal(K.modeFromLabel("SKIP ALL APPROVALS"), "skip");
});

test("a label round-trips back out for finding the control", () => {
  for (const m of K.MODES) assert.equal(K.modeFromLabel(K.labelForMode(m.key)), m.key);
  assert.equal(K.labelForMode(""), "");
  assert.equal(K.labelForMode("nonsense"), "");
});

test("an unset mode describes itself as leaving the page alone", () => {
  assert.equal(K.describeMode(""), "Leave as-is");
  assert.equal(K.describeMode("manual"), "Manually approve");
});

test("the picker offers 'leave as-is' first, the way the model select does", () => {
  const opts = K.modeOptions();
  assert.equal(opts.length, 4);
  assert.equal(opts[0].value, "");
  assert.deepEqual(
    opts.slice(1).map((o) => o.value),
    ["manual", "auto", "skip"]
  );
});

test("rowIsMode asks the prefix question the other way round", () => {
  const row = "Skip all approvalsClaude never pauses, even for unsafe actions";
  assert.equal(K.rowIsMode(row, "skip"), true);
  assert.equal(K.rowIsMode(row, "manual"), false);
  assert.equal(K.rowIsMode(row, ""), false);
  assert.equal(K.rowIsMode("", "skip"), false);
});

// ---- reconcile ------------------------------------------------------------

test("a job that didn't ask never moves the control", () => {
  assert.equal(K.reconcile("", "Automatically approve"), "inherit");
  assert.equal(K.reconcile(null, "Manually approve"), "inherit");
  // Not even when there's no control at all: nothing was asked for.
  assert.equal(K.reconcile("", ""), "inherit");
});

test("a job already on its mode is left alone", () => {
  assert.equal(K.reconcile("auto", "Automatically approve"), "ok");
  assert.equal(K.reconcile("manual", "Manually approve"), "ok");
});

test("a job on the wrong mode says so", () => {
  assert.equal(K.reconcile("manual", "Automatically approve"), "set");
  assert.equal(K.reconcile("skip", "Manually approve"), "set");
});

test("a job that asked, on a page with no approval control, is NOT quietly ok", () => {
  // The mode is sticky and invisible in the url, so this is the case that would
  // otherwise send in whatever mode the tab happened to be left in.
  assert.equal(K.reconcile("manual", ""), "unknown");
  assert.equal(K.reconcile("skip", null), "unknown");
});

test("the note is empty when nothing happened and loud when it didn't", () => {
  assert.equal(K.reconcileNote("", "Automatically approve"), "");
  assert.equal(K.reconcileNote("auto", "Automatically approve"), "");
  assert.match(K.reconcileNote("manual", "Automatically approve"), /Manually approve/);
  assert.match(K.reconcileNote("manual", ""), /isn't in Cowork/);
});

// ---- the surface ----------------------------------------------------------

test("the toggle's two radios are read by their whole label", () => {
  assert.equal(K.surfaceFromLabel("Chat"), "chat");
  assert.equal(K.surfaceFromLabel("Cowork"), "cowork");
  assert.equal(K.surfaceFromLabel("cowork"), "cowork");
  assert.equal(K.surfaceFromLabel("  Cowork  "), "cowork");
});

test("the ways a person writes co-work all land on the same surface", () => {
  assert.equal(K.surfaceFromLabel("co-work"), "cowork");
  assert.equal(K.surfaceFromLabel("Co Work"), "cowork");
});

test("a surface is not guessed from a longer string", () => {
  // Unlike the approval rows, nothing is appended to a radio's label, so a
  // prefix test here would match the whole toggle ("ChatCowork").
  assert.equal(K.surfaceFromLabel("ChatCowork"), "");
  assert.equal(K.surfaceFromLabel("Chat with Claude"), "");
  assert.equal(K.surfaceFromLabel(""), "");
  assert.equal(K.surfaceFromLabel(null), "");
});

test("a surface round-trips and describes itself", () => {
  for (const s of K.SURFACES) assert.equal(K.surfaceFromLabel(K.labelForSurface(s.key)), s.key);
  assert.equal(K.describeSurface(""), "Leave as-is");
  assert.equal(K.describeSurface("cowork"), "Cowork");
  assert.equal(K.labelForSurface("nonsense"), "");
});

test("the surface picker offers 'leave as-is' first too", () => {
  const opts = K.surfaceOptions();
  assert.deepEqual(
    opts.map((o) => o.value),
    ["", "chat", "cowork"]
  );
});

test("reconcileSurface answers the same four ways", () => {
  assert.equal(K.reconcileSurface("", "Chat"), "inherit");
  assert.equal(K.reconcileSurface("chat", "Chat"), "ok");
  assert.equal(K.reconcileSurface("cowork", "Chat"), "set");
  // No toggle on the page: ordinary, not a failure — it only exists on the
  // composer home, so a job resuming a conversation never had a choice.
  assert.equal(K.reconcileSurface("cowork", ""), "unknown");
});

test("approval only applies where an approval control exists", () => {
  assert.equal(K.approvalApplies("cowork", "Chat"), true);
  assert.equal(K.approvalApplies("chat", "Cowork"), false);
  // Unset surface: go by what the page is actually on.
  assert.equal(K.approvalApplies("", "Cowork"), true);
  assert.equal(K.approvalApplies("", "Chat"), false);
  assert.equal(K.approvalApplies("", ""), false);
});

test("moving the toggle and failing to move it back is said out loud", () => {
  // The choice is remembered for the account, not the tab, so a silent change
  // reaches the next window the user opens by hand.
  assert.match(K.surfaceLeftNote("chat", false), /next new tab/);
  assert.match(K.surfaceLeftNote("chat", false), /Chat/);
  assert.equal(K.surfaceLeftNote("chat", true), "");
  assert.equal(K.surfaceLeftNote("", false), "");
});

// ---- addresses ------------------------------------------------------------

test("a cowork session id is not a uuid and is read anyway", () => {
  assert.equal(
    K.sessionId("/cowork/cse_011f5HCzaWWJ2hm19v6NuQmN"),
    "cse_011f5HCzaWWJ2hm19v6NuQmN"
  );
  assert.equal(
    K.sessionId("https://claude.ai/cowork/cse_011f5HCzaWWJ2hm19v6NuQmN"),
    "cse_011f5HCzaWWJ2hm19v6NuQmN"
  );
});

test("a project address is not a session", () => {
  assert.equal(K.sessionId("/cowork/project/019f3fcd-9b35-7715-b2cc-b227512b5459"), null);
  assert.equal(K.sessionId("/new"), null);
  assert.equal(K.sessionId("/chat/019f3fcd-9b35-7715-b2cc-b227512b5459"), null);
  assert.equal(K.sessionId(""), null);
});

test("both cowork shapes read as cowork, and nothing else does", () => {
  assert.equal(K.isCoworkUrl("/cowork/cse_011f5HCzaWWJ2hm19v6NuQmN"), true);
  assert.equal(K.isCoworkUrl("/cowork/project/019f3fcd-9b35-7715-b2cc-b227512b5459"), true);
  assert.equal(K.isCoworkUrl("https://claude.ai/cowork/"), true);
  assert.equal(K.isCoworkUrl("/new"), false);
  assert.equal(K.isCoworkUrl("/chat/abc"), false);
  // Not a prefix match on some other path that merely starts with the letters.
  assert.equal(K.isCoworkUrl("/coworkers"), false);
});

// ---- projects -------------------------------------------------------------

test("a project row matches on its name, since the row carries no uuid", () => {
  assert.equal(K.projectRowMatches("Draft Tentative Rulings", "Draft Tentative Rulings"), true);
  assert.equal(K.projectRowMatches("draft tentative rulings", "Draft Tentative Rulings"), true);
  assert.equal(K.projectRowMatches("Cutlist", "Card Game Player"), false);
});

test("a badge after the name is tolerated; a different project is not", () => {
  assert.equal(K.projectRowMatches("Cutlist  Pinned", "Cutlist"), true);
  assert.equal(K.projectRowMatches("Cutlist Two", "Cutlist"), true);
  // A name that only appears partway in isn't this row.
  assert.equal(K.projectRowMatches("My Cutlist", "Cutlist"), false);
});

test("a long tail after the name stops counting as the same project", () => {
  assert.equal(
    K.projectRowMatches("Cutlist" + " and a great deal of other text besides", "Cutlist"),
    false
  );
});

test("nothing matches an empty name — an unset project must not pick a row", () => {
  assert.equal(K.projectRowMatches("Cutlist", ""), false);
  assert.equal(K.projectRowMatches("Cutlist", null), false);
  assert.equal(K.projectRowMatches("", "Cutlist"), false);
});

test("the two rows that navigate away are not projects", () => {
  assert.equal(K.isProjectRow("Create new project"), false);
  assert.equal(K.isProjectRow("View all projects"), false);
  assert.equal(K.isProjectRow("Draft Tentative Rulings"), true);
  assert.equal(K.isProjectRow(""), false);
});
