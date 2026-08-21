const test = require("node:test");
const assert = require("node:assert");
const A = require("../src/autodl.js");

// ---- what counts as a save control -------------------------------------

test("a control that saves a file is recognised by its leading word", () => {
  assert.equal(A.isSaveLabel("Download"), true);
  assert.equal(A.isSaveLabel("  download  "), true);
  assert.equal(A.isSaveLabel("Download:"), true);
  assert.equal(A.isSaveLabel("Download ruling.docx"), true);
  assert.equal(A.isSaveLabel("Download as PDF"), true);
  assert.equal(A.isSaveLabel("Save as CSV"), true);
  assert.equal(A.isSaveLabel("Save file"), true);
});

test("a bare Save is NOT enough for an unattended clicker", () => {
  // CUMWorkflow.isDownloadLabel takes it, because a workflow step is a run you
  // started and are watching. This one runs on every page, and claude.ai says
  // "Save" over things that aren't files.
  assert.equal(A.isSaveLabel("Save"), false);
  assert.equal(A.isSaveLabel("Save to project"), false);
});

test("the word has to lead, and a caption has to be caption-sized", () => {
  assert.equal(A.isSaveLabel("Click here to download the report"), false);
  assert.equal(A.isSaveLabel("Downloading…"), false);
  assert.equal(A.isSaveLabel("Downloads"), false);
  assert.equal(A.isSaveLabel("Copy"), false);
  assert.equal(A.isSaveLabel("Retry"), false);
  assert.equal(A.isSaveLabel(""), false);
  assert.equal(A.isSaveLabel(null), false);
  assert.equal(A.isSaveLabel("Download " + "x".repeat(200)), false);
});

test("a file card is recognised by the filename on it", () => {
  // This is what finds a card whose control is an unlabelled icon — no amount
  // of label-matching ever will.
  assert.equal(A.fileNameIn("Smith v Jones — MSJ.docx"), "Smith v Jones — MSJ.docx");
  assert.equal(A.fileNameIn("ruling.docx 24 KB"), "ruling.docx");
  assert.equal(A.fileNameIn("Exhibit A (redacted).pdf"), "Exhibit A (redacted).pdf");
  assert.equal(A.fileNameIn("tentative.md"), "tentative.md");
  assert.equal(A.fileNameIn("data.csv"), "data.csv");
  // Not a filename: prose, a citation, a bare word, or a wall of text.
  assert.equal(A.fileNameIn("Cleveland at 682-683."), "");
  assert.equal(A.fileNameIn("no extension here"), "");
  assert.equal(A.fileNameIn("x".repeat(300) + " ruling.docx"), "");
  assert.equal(A.fileNameIn(""), "");
  assert.equal(A.fileNameIn(null), "");
});

test("the looser save wording is available, for use inside a card", () => {
  // Loose on purpose, and only ever applied where a filename is already on the
  // card — "Save a copy" beside `ruling.docx` is not ambiguous the way a button
  // loose in a reply is.
  assert.equal(A.mentionsSave("Download file"), true);
  assert.equal(A.mentionsSave("Save a copy"), true);
  assert.equal(A.mentionsSave("Preview"), false);
  assert.equal(A.mentionsSave("Copy"), false);
  assert.equal(A.mentionsSave(""), false);
  // The strict rule stays strict — it is the one used out in the open.
  assert.equal(A.isSaveLabel("Save a copy"), false);
});

// ---- naming -------------------------------------------------------------

test("a filename is taken out of the caption where there is one", () => {
  assert.equal(A.fileName("Download ruling.docx"), "ruling.docx");
  assert.equal(A.fileName("Download: Smith v Jones.pdf"), "Smith v Jones.pdf");
  assert.equal(A.fileName('Download "report.csv"'), "report.csv");
  assert.equal(A.fileName("Save as summary.md"), "summary.md");
});

test("a caption with no filename in it yields nothing, which is not a failure", () => {
  assert.equal(A.fileName("Download"), "");
  assert.equal(A.fileName(""), "");
  assert.equal(A.fileName(null), "");
});

// ---- identity -----------------------------------------------------------

test("a reply is identified by its opening, not by how it ends", () => {
  // What this has to survive is claude.ai unmounting a message and mounting it
  // again — the opening comes back identical where the tail may since have
  // grown. (While a short reply is still streaming its signature does move;
  // nothing is ever clicked mid-turn, which is where that stops mattering.)
  const opening = "Here is the revised tentative ruling. ".repeat(5); // > TURN_SIG
  assert.equal(A.turnSignature(opening), A.turnSignature(opening + " And a closing note."));
  assert.equal(A.turnSignature(opening).length, A.TURN_SIG);
  assert.equal(A.turnSignature("  spaced   out\n\ntext "), "spaced out text");
  assert.notEqual(A.turnSignature("One reply"), A.turnSignature("Another reply"));
});

test("two unnamed files in one reply get keys of their own", () => {
  const keys = A.offerKeys("turn one", ["", ""]);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  // ...and so do two that happen to share a caption.
  const same = A.offerKeys("turn one", ["report.csv", "report.csv"]);
  assert.notEqual(same[0], same[1]);
});

test("the same file in the same reply keys the same, in a different reply it doesn't", () => {
  assert.equal(A.offerKeys("turn one", ["a.docx"])[0], A.offerKeys("turn one", ["a.docx"])[0]);
  assert.notEqual(A.offerKeys("turn one", ["a.docx"])[0], A.offerKeys("turn two", ["a.docx"])[0]);
  assert.equal(A.turnOf(A.offerKeys("turn one", ["a.docx"])[0]), "turn one");
});

// ---- the plan -----------------------------------------------------------

const OFFERS = [{ key: "t1|a.docx" }, { key: "t1|b.csv" }];
function ctx(over) {
  return Object.assign(
    {
      enabled: true,
      generating: false,
      baselined: true,
      // The default context is a reply we watched arrive — that being the only
      // situation in which anything is ever saved.
      live: ["t1", "t2"],
      seen: [],
      count: 0,
      max: 20,
      now: 100000,
      lastAt: 0,
    },
    over || {}
  );
}

test("off means off — nothing is taken and nothing is even adopted", () => {
  const r = A.plan(OFFERS, ctx({ enabled: false, baselined: false }));
  assert.equal(r.take, null);
  assert.deepEqual(r.adopt, []);
  assert.equal(r.hold, "off");
});

test("the census adopts what is already on the page without saving any of it", () => {
  // Opening a chat full of files, or turning the toggle on while reading one,
  // must never write a folder's worth of history to disk.
  const r = A.plan(OFFERS, ctx({ baselined: false, live: [] }));
  assert.equal(r.take, null);
  assert.deepEqual(r.adopt, ["t1|a.docx", "t1|b.csv"]);
  assert.equal(r.hold, "baseline");
});

test("the census waits for a turn in flight rather than closing over it", () => {
  // Turning the toggle on, or landing on the page, while Claude is mid-answer.
  // Closing the census here would adopt the answer being written as history.
  const mid = A.plan(OFFERS, ctx({ baselined: false, generating: true }));
  assert.deepEqual(mid.adopt, []);
  assert.equal(mid.hold, "settling");
  // Same while the turn has ended and its answer hasn't appeared yet.
  const waiting = A.plan(OFFERS, ctx({ baselined: false, pending: true }));
  assert.deepEqual(waiting.adopt, []);
  assert.equal(waiting.hold, "settling");
});

test("the census never adopts a reply we watched arrive", () => {
  const offers = [{ key: "old|history.pdf" }, { key: "new|report.docx" }];
  const r = A.plan(offers, ctx({ baselined: false, live: ["new"] }));
  assert.deepEqual(r.adopt, ["old|history.pdf"]);
  // ...so the file that just landed is still saved on the next pass.
  const after = A.plan(offers, ctx({ live: ["new"], seen: ["old|history.pdf"] }));
  assert.equal(after.take.key, "new|report.docx");
});

test("a file that arrives after the census is saved, once", () => {
  const seen = ["t1|a.docx", "t1|b.csv"];
  const fresh = OFFERS.concat([{ key: "t2|new.pdf" }]);
  const r = A.plan(fresh, ctx({ seen }));
  assert.equal(r.take.key, "t2|new.pdf");
  assert.deepEqual(r.adopt, ["t2|new.pdf"]);
  // Once it's on the ledger it is never taken again.
  const again = A.plan(fresh, ctx({ seen: seen.concat(["t2|new.pdf"]) }));
  assert.equal(again.take, null);
  assert.equal(again.hold, null);
});

test("nothing is saved while Claude is still writing", () => {
  const r = A.plan(OFFERS, ctx({ generating: true }));
  assert.equal(r.take, null);
  assert.equal(r.hold, "generating");
  // ...and it isn't adopted either, so it is still saved once the turn ends.
  assert.deepEqual(r.adopt, []);
});

test("saves are paced rather than fired in a burst", () => {
  const held = A.plan(OFFERS, ctx({ now: 100000, lastAt: 99500 }));
  assert.equal(held.take, null);
  assert.equal(held.hold, "cooldown");
  const ready = A.plan(OFFERS, ctx({ now: 101000, lastAt: 99500 }));
  assert.equal(ready.take.key, "t1|a.docx");
});

test("one file per call, so each save has to come back round", () => {
  const first = A.plan(OFFERS, ctx());
  assert.equal(first.take.key, "t1|a.docx");
  assert.deepEqual(first.adopt, ["t1|a.docx"]);
  const second = A.plan(OFFERS, ctx({ seen: ["t1|a.docx"] }));
  assert.equal(second.take.key, "t1|b.csv");
});

test("a page-load ceiling stops a runaway", () => {
  const r = A.plan(OFFERS, ctx({ count: 20, max: 20 }));
  assert.equal(r.take, null);
  assert.equal(r.hold, "cap");
});

test("a single pathological reply can't fill the folder either", () => {
  const many = [];
  // More than one reply's share, whatever that share is set to.
  for (let i = 0; i < A.MAX_PER_TURN + 4; i++) many.push({ key: "t1|f" + i });
  const seen = many.slice(0, A.MAX_PER_TURN).map((o) => o.key);
  const r = A.plan(many, ctx({ seen }));
  assert.equal(r.take, null);
  assert.equal(r.hold, "reply cap");
  // A different reply is unaffected by the one that hit its ceiling.
  const next = A.plan(many.concat([{ key: "t2|ok.docx" }]), ctx({ seen }));
  assert.equal(next.take.key, "t2|ok.docx");
});

test("a control that can't be clicked yet holds its place and waits its turn", () => {
  // It keeps its place because the keys around it are numbered against this
  // list — and it is NOT adopted, so a card that opens a moment later is still
  // saved rather than written off as history.
  const offers = [{ key: "t1|a.docx", ready: false }, { key: "t1|b.csv" }];
  const first = A.plan(offers, ctx());
  assert.equal(first.take.key, "t1|b.csv");
  const stillWaiting = A.plan(offers, ctx({ seen: ["t1|b.csv"] }));
  assert.equal(stillWaiting.take, null);
  assert.deepEqual(stillWaiting.adopt, []);
  assert.equal(stillWaiting.hold, "not ready");
  // Once it can be clicked, it is.
  const now = A.plan([{ key: "t1|a.docx", ready: true }], ctx({ seen: ["t1|b.csv"] }));
  assert.equal(now.take.key, "t1|a.docx");
});

test("the census counts what isn't clickable yet as history too", () => {
  // Otherwise a chat you opened would save itself as its cards finished
  // rendering, which is the one thing the census exists to prevent.
  const r = A.plan(
    [{ key: "t1|a.docx", ready: false }],
    ctx({ baselined: false, live: [] })
  );
  assert.deepEqual(r.adopt, ["t1|a.docx"]);
  assert.equal(r.take, null);
});

// ---- real-time only ------------------------------------------------------

test("a chat's backlog is never saved, however new its files look", () => {
  // The census is not what does this work: even with an empty ledger and a
  // clean page, a file out of a reply nobody watched arrive is not taken.
  const r = A.plan(OFFERS, ctx({ live: [], seen: [] }));
  assert.equal(r.take, null);
  assert.equal(r.hold, "backlog");
  // And it is not adopted either — if that reply turns out to be the one in
  // flight, its file is still saved when the turn lands.
  assert.deepEqual(r.adopt, []);
});

test("only the reply that landed is drawn from, not the one beside it", () => {
  const offers = [{ key: "old|history.pdf" }, { key: "new|report.docx" }];
  const r = A.plan(offers, ctx({ live: ["new"] }));
  assert.equal(r.take.key, "new|report.docx");
  // ...and with that one saved there is nothing further to take.
  const after = A.plan(offers, ctx({ live: ["new"], seen: ["new|report.docx"] }));
  assert.equal(after.take, null);
  assert.equal(after.hold, "backlog");
});

test("a reply counts as landed only once its answer is actually on the page", () => {
  // The turn-end signal can beat claude.ai's rendering of the answer. Acting on
  // it then would mark the PREVIOUS reply as live — an old one, whose files are
  // precisely the backlog this must never touch.
  assert.equal(A.landed({ armed: true, newest: "the answer", before: "the one before" }), true);
  assert.equal(A.landed({ armed: true, newest: "same reply", before: "same reply" }), false);
  assert.equal(A.landed({ armed: true, newest: "", before: "" }), false);
  // Nothing has ended yet.
  assert.equal(A.landed({ armed: false, newest: "an answer", before: "" }), false);
  // Still writing.
  assert.equal(A.landed({ armed: true, generating: true, newest: "a", before: "b" }), false);
  assert.equal(A.landed(null), false);
});

test("the live list remembers the last few replies and no more", () => {
  let live = [];
  for (const s of ["one", "two", "three", "four", "five", "six"])
    live = A.rememberLive(live, s);
  assert.equal(live.length, A.LIVE_MAX);
  assert.equal(live[live.length - 1], "six");
  assert.equal(live.indexOf("one"), -1);
  // Re-marking the same reply moves it along rather than filling the list with
  // copies — a card that renders late does exactly that.
  const twice = A.rememberLive(A.rememberLive([], "a"), "a");
  assert.deepEqual(twice, ["a"]);
  // Nothing to mark leaves the list as it was.
  assert.deepEqual(A.rememberLive(["a"], ""), ["a"]);
});

test("no offers at all is quiet — no hold, nothing adopted", () => {
  const r = A.plan([], ctx());
  assert.equal(r.take, null);
  assert.equal(r.hold, null);
  assert.deepEqual(r.adopt, []);
});

test("nonsense in gets nothing out rather than throwing", () => {
  assert.equal(A.plan(null, ctx()).take, null);
  assert.equal(A.plan(undefined, undefined).hold, "off");
});

test("a file-type chip is the WHOLE of a piece of text, never a word in one", () => {
  for (const s of ["DOCX", "docx", ".docx", "PDF", " XLSX ", ".pdf", "MD", "CSV"])
    assert.equal(A.isTypeChip(s), true, s);
  // A sentence that mentions a file type is not a card, and treating it as one
  // means climbing out of prose to press whatever button is nearest.
  for (const s of [
    "Here is the PDF",
    "the PDF you asked for",
    "PDF version",
    "ruling.docx",
    "",
    null,
    "DOCX (18 KB)",
  ])
    assert.equal(A.isTypeChip(s), false, String(s));
});

test("a chip is only a chip for a type we'd actually save", () => {
  assert.equal(A.isTypeChip("EXE"), false);
  assert.equal(A.isTypeChip("Ruling"), false);
});

// ---- catching up on files you don't already have ---------------------------

test("downloadKey matches a card against a Downloads folder entry", () => {
  // The history gives a path; a card gives a name.
  assert.equal(A.downloadKey("/Users/me/Downloads/ruling.docx"), "ruling.docx");
  assert.equal(A.downloadKey("C:\\Users\\me\\Downloads\\Ruling.DOCX"), "ruling.docx");
  // Chrome's own de-duplication, undone — otherwise a second copy looks like a
  // file you don't have and earns a third.
  assert.equal(A.downloadKey("ruling (1).docx"), "ruling.docx");
  assert.equal(A.downloadKey("ruling (12).docx"), "ruling.docx");
  assert.equal(A.downloadKey("ruling(1).docx"), "ruling.docx");
  // ...but only the suffix Chrome adds. A number in the name is the name.
  assert.equal(A.downloadKey("24STCV83325 (Smith).docx"), "24stcv83325 (smith).docx");
  assert.equal(A.downloadKey("ruling 2026 (draft).md"), "ruling 2026 (draft).md");
  assert.equal(A.downloadKey(""), "");
  assert.equal(A.downloadKey(null), "");
});

test("downloadIndex is a lookup of what you already have", () => {
  const have = A.downloadIndex(["/d/Ruling.docx", "/d/report (2).pdf", "", null]);
  assert.equal(have["ruling.docx"], true);
  assert.equal(have["report.pdf"], true);
  assert.equal(have["other.docx"], undefined);
});

function backlogCtx(over) {
  return Object.assign(
    {
      enabled: true,
      baselined: true,
      live: [], // nothing was watched arriving — this is a chat you opened
      seen: [],
      count: 0,
      now: 1000,
      lastAt: 0,
    },
    over || {}
  );
}
// `at` is when the TURN happened. backlogCtx pins now at 1000, so this is a
// file from a moment ago — old enough to be a backlog, new enough for catch-up.
const OLD = [{ key: "turn|ruling.docx", name: "ruling.docx", ready: true, at: 1000 }];

test("without catch-up, an old file is still left exactly where it is", () => {
  const res = A.plan(OLD, backlogCtx());
  assert.equal(res.take, null);
  assert.equal(res.hold, "backlog");
});

test("with catch-up, a file you don't have is taken; one you have is not", () => {
  const missing = A.plan(OLD, backlogCtx({ catchUp: true, downloaded: A.downloadIndex([]) }));
  assert.equal(missing.take && missing.take.name, "ruling.docx");

  const got = A.plan(
    OLD,
    backlogCtx({ catchUp: true, downloaded: A.downloadIndex(["/d/ruling (1).docx"]) })
  );
  assert.equal(got.take, null);
  assert.equal(got.hold, "backlog");
});

test("catch-up never acts on a question that wasn't answered", () => {
  // No history read yet: null is "don't know", which is not "you don't have
  // it". Acting on it would save every file in the conversation.
  const res = A.plan(OLD, backlogCtx({ catchUp: true, downloaded: null }));
  assert.equal(res.take, null);
  assert.equal(res.hold, "no download history yet");
});

test("catch-up never acts on a file it can't name", () => {
  const unnamed = [{ key: "turn|file 1", name: "", ready: true, at: 1000 }];
  const res = A.plan(unnamed, backlogCtx({ catchUp: true, downloaded: A.downloadIndex([]) }));
  assert.equal(res.take, null, "nothing to check against, so nothing is taken");
  assert.equal(res.hold, "backlog");
});

test("the census doesn't adopt a file catch-up is about to take", () => {
  // Adopting it would file it as handled and put it beyond reach for the rest
  // of the page load — the census means "already dealt with", and an old file
  // you don't have is not dealt with.
  const open = backlogCtx({ baselined: false, catchUp: true, downloaded: A.downloadIndex([]) });
  const res = A.plan(OLD, open);
  assert.equal(res.hold, "baseline");
  assert.deepEqual(res.adopt, [], "left for the next pass to take");

  // One you DO have is adopted, because it is genuinely dealt with.
  const had = A.plan(
    OLD,
    backlogCtx({ baselined: false, catchUp: true, downloaded: A.downloadIndex(["ruling.docx"]) })
  );
  assert.deepEqual(had.adopt, ["turn|ruling.docx"]);

  // And with catch-up off the census behaves exactly as it always did.
  assert.deepEqual(A.plan(OLD, backlogCtx({ baselined: false })).adopt, ["turn|ruling.docx"]);
});

test("catch-up doesn't loosen any of the other ceilings", () => {
  const ctx = { catchUp: true, downloaded: A.downloadIndex([]) };
  assert.equal(A.plan(OLD, backlogCtx(Object.assign({ generating: true }, ctx))).hold, "generating");
  assert.equal(A.plan(OLD, backlogCtx(Object.assign({ count: 20, max: 20 }, ctx))).hold, "cap");
  assert.equal(
    A.plan(OLD, backlogCtx(Object.assign({ lastAt: 900, now: 1000 }, ctx))).hold,
    "cooldown"
  );
  assert.equal(A.plan(OLD, backlogCtx(Object.assign({ enabled: false }, ctx))).hold, "off");
});

test("a filename survives the punctuation a document title actually has", () => {
  // A colon in the title used to truncate the name to what followed it, which
  // is a different name from the one that reaches your disk.
  assert.equal(
    A.fileNameIn("Verification Report: 24STCV83325 Motion for Attorney Fees 8.13.2026.md"),
    "Verification Report: 24STCV83325 Motion for Attorney Fees 8.13.2026.md"
  );
  assert.equal(A.fileNameIn("Ruling — Smith v. Jones (demurrer).docx"), "Ruling — Smith v. Jones (demurrer).docx");
  assert.equal(A.fileNameIn("Notes #3 & follow-up.txt"), "Notes #3 & follow-up.txt");
});

test("the card's name and the name on disk fold to the same key", () => {
  // Chrome rewrites what a filesystem won't take: the colon becomes an
  // underscore. Compared literally, the two never match and every file is
  // saved a second time — which is the bug this closes.
  const card = A.fileNameIn("Verification Report: 24STCV83325 Motion for Attorney Fees 8.13.2026.md");
  const key = A.downloadKey(card);
  for (const disk of [
    "/Users/me/Downloads/Verification Report_ 24STCV83325 Motion for Attorney Fees 8.13.2026.md",
    "/Users/me/Downloads/Verification Report_ 24STCV83325 Motion for Attorney Fees 8.13.2026 (1).md",
    "C:\\Users\\me\\Downloads\\Verification_Report__24STCV83325_Motion_for_Attorney_Fees_8.13.2026.md",
  ])
    assert.equal(A.downloadKey(disk), key, disk);

  // Folding punctuation must not fold two genuinely different files together.
  assert.notEqual(A.downloadKey("Verification Report: 24STCV83326.md"), key);
  assert.notEqual(A.downloadKey("ruling.docx"), A.downloadKey("ruling.md"));
});

test("the other characters a filesystem refuses fold the same way", () => {
  const key = A.downloadKey("Q1 report.md");
  for (const s of ["Q1*report.md", 'Q1"report.md', "Q1<report.md", "Q1|report.md", "Q1?report.md"])
    assert.equal(A.downloadKey(s), key, s);
});

// ---- a save that isn't a download -----------------------------------------

test("a control that saves the file somewhere else is not a save control", () => {
  // Cowork draws a file's controls as a menu whose top row is Google Drive.
  // Every one of these reads as a save to the plain word test, and clicking any
  // of them uploads the file to a third party instead of writing it to disk.
  for (const label of [
    "Save to Google Drive",
    "Save a copy to Google Drive",
    "Add to Drive",
    "Save to Dropbox",
    "Save to OneDrive",
    "Upload to Box",
    "Export to Notion",
    "Share",
    "Copy link",
    "Send in email",
  ]) {
    assert.equal(A.goesElsewhere(label), true, label + " goes elsewhere");
    assert.equal(A.mentionsSave(label), false, label + " is not a save control in a card");
    assert.equal(A.isSaveLabel(label), false, label + " is not a save control in the open");
  }
});

test("an ordinary download still passes, including one that names a destination", () => {
  assert.equal(A.isSaveLabel("Download"), true);
  assert.equal(A.isSaveLabel("Download ruling.docx"), true);
  assert.equal(A.isSaveLabel("Save as PDF"), true);
  // "to your computer" is the case a blanket suspicion of "to" would have
  // broken — it is exactly what we want to click.
  assert.equal(A.isSaveLabel("Download to your computer"), true);
  assert.equal(A.mentionsSave("Download file"), true);
  assert.equal(A.mentionsSave("Save a copy"), true);
});

// ---- a download behind a disclosure ---------------------------------------

test("Cowork's disclosure is recognised, so the card stops looking controlless", () => {
  // The live button, exactly: icon-only, no filename, no save word. Nothing
  // else in this module can see it, which is why a Cowork file card read as a
  // card with nothing on it to press.
  assert.equal(A.isDisclosureLabel("More ways to open"), true);
  assert.equal(A.isDisclosureLabel("More options"), true);
  assert.equal(A.isDisclosureLabel("More actions"), true);
});

test("a disclosure is not itself a save control", () => {
  assert.equal(A.isSaveLabel("More ways to open"), false);
  assert.equal(A.mentionsSave("More ways to open"), false);
});

test("the words have to lead, so prose and other buttons stay out", () => {
  assert.equal(A.isDisclosureLabel("Download"), false);
  assert.equal(A.isDisclosureLabel("Delete"), false);
  assert.equal(A.isDisclosureLabel("Show more"), false);
  assert.equal(A.isDisclosureLabel("There are more ways to open this file"), false);
  assert.equal(A.isDisclosureLabel(""), false);
  assert.equal(A.isDisclosureLabel(null), false);
});

test("the row inside that menu is judged strictly, and Drive loses", () => {
  // Both rows are [role="menuitem"], both new after the click, and only one of
  // them is the file arriving on your disk.
  assert.equal(A.isSaveLabel("Download"), true);
  assert.equal(A.isSaveLabel("Google Drive"), false);
  assert.equal(A.mentionsSave("Google Drive"), false);
});

// ---- how far back catch-up may reach --------------------------------------

test("the window is ten minutes, measured from the turn", () => {
  const now = 10_000_000;
  assert.equal(A.LOOKBACK_MS, 10 * 60 * 1000);
  assert.equal(A.withinLookback(now, now), true);
  assert.equal(A.withinLookback(now - 9 * 60 * 1000, now), true);
  assert.equal(A.withinLookback(now - A.LOOKBACK_MS, now), true, "the edge is inside");
  assert.equal(A.withinLookback(now - A.LOOKBACK_MS - 1, now), false);
  assert.equal(A.withinLookback(now - 24 * 3600 * 1000, now), false);
});

test("a time we don't have is not recent", () => {
  // This is the case the bound exists for: catch-up reaching back through a
  // chat. If "we couldn't find out when" counted as recent, the one situation
  // that can't be measured would be the one the bound stops applying to.
  const now = 10_000_000;
  assert.equal(A.withinLookback(null, now), false);
  assert.equal(A.withinLookback(undefined, now), false);
  assert.equal(A.withinLookback("just now", now), false);
  assert.equal(A.withinLookback(NaN, now), false);
});

test("a turn stamped in the future is a bad clock, not an ancient file", () => {
  const now = 10_000_000;
  assert.equal(A.withinLookback(now + 30_000, now), true, "a little ahead is still now");
  assert.equal(A.withinLookback(now + 24 * 3600 * 1000, now), false, "a day ahead is nonsense");
});

test("catch-up leaves a file older than the window exactly where it is", () => {
  const stale = [
    { key: "turn|ruling.docx", name: "ruling.docx", ready: true, at: 1000 - 20 * 60 * 1000 },
  ];
  const res = A.plan(stale, backlogCtx({ catchUp: true, downloaded: A.downloadIndex([]) }));
  assert.equal(res.take, null, "opening an old chat saves none of it");
  assert.equal(res.hold, "older than the catch-up window");
});

test("a file with no time at all is left too, and says why", () => {
  const undated = [{ key: "turn|ruling.docx", name: "ruling.docx", ready: true }];
  const res = A.plan(undated, backlogCtx({ catchUp: true, downloaded: A.downloadIndex([]) }));
  assert.equal(res.take, null);
  assert.equal(res.hold, "older than the catch-up window");
});

test("the window bounds catch-up only — a reply watched arriving is still saved", () => {
  // It happened in front of us, which is a better fact than any timestamp.
  const old = [
    { key: "turn|ruling.docx", name: "ruling.docx", ready: true, at: 1000 - 48 * 3600 * 1000 },
  ];
  const res = A.plan(old, backlogCtx({ live: ["turn"] }));
  assert.equal(res.take && res.take.name, "ruling.docx");
});

test("the window is settable, so a caller can be stricter than the default", () => {
  const at = 1000 - 5 * 60 * 1000;
  const offers = [{ key: "turn|ruling.docx", name: "ruling.docx", ready: true, at: at }];
  const base = { catchUp: true, downloaded: A.downloadIndex([]) };
  assert.ok(A.plan(offers, backlogCtx(base)).take, "inside the ten-minute default");
  assert.equal(
    A.plan(offers, backlogCtx(Object.assign({ lookbackMs: 60 * 1000 }, base))).take,
    null,
    "outside a one-minute window"
  );
});

test("the census still adopts a file that is now beyond catch-up's reach", () => {
  // It is genuinely dealt with: nothing is ever going to save it, so leaving it
  // unadopted would mean re-examining it on every pass for the rest of the page.
  const stale = [
    { key: "turn|ruling.docx", name: "ruling.docx", ready: true, at: 1000 - 20 * 60 * 1000 },
  ];
  const res = A.plan(
    stale,
    backlogCtx({ baselined: false, catchUp: true, downloaded: A.downloadIndex([]) })
  );
  assert.deepEqual(res.adopt, ["turn|ruling.docx"]);
});

test("the window is a setting, clamped so a stored number can't disable the bound", () => {
  assert.equal(A.lookbackMinutes(30), 30);
  assert.equal(A.lookbackMinutes("45"), 45);
  assert.equal(A.lookbackMinutes(2.6), 3, "rounded, since minutes come from a number input");
  // Zero would be a catch-up that can never catch anything — which is what
  // turning the switch off is for.
  assert.equal(A.lookbackMinutes(0), A.LOOKBACK_MIN_MIN);
  assert.equal(A.lookbackMinutes(-99), A.LOOKBACK_MIN_MIN);
  assert.equal(A.lookbackMinutes(99999), A.LOOKBACK_MAX_MIN);
});

test("a setting that was never set, or is nonsense, falls back to the default", () => {
  assert.equal(A.lookbackMinutes(undefined), A.LOOKBACK_DEFAULT_MIN);
  assert.equal(A.lookbackMinutes(null), A.LOOKBACK_DEFAULT_MIN);
  assert.equal(A.lookbackMinutes(""), A.LOOKBACK_DEFAULT_MIN);
  assert.equal(A.lookbackMinutes("soon"), A.LOOKBACK_DEFAULT_MIN);
  assert.equal(A.lookbackMinutes(NaN), A.LOOKBACK_DEFAULT_MIN);
});

test("the config object converts straight to the milliseconds plan wants", () => {
  assert.equal(A.lookbackMsFor({ lookbackMin: 25 }), 25 * 60 * 1000);
  assert.equal(A.lookbackMsFor({}), A.LOOKBACK_MS);
  assert.equal(A.lookbackMsFor(null), A.LOOKBACK_MS);
});

test("a longer window really does reach further back", () => {
  const at = 1000 - 40 * 60 * 1000; // forty minutes before backlogCtx's `now`
  const offers = [{ key: "turn|ruling.docx", name: "ruling.docx", ready: true, at: at }];
  const base = { catchUp: true, downloaded: A.downloadIndex([]) };
  assert.equal(A.plan(offers, backlogCtx(base)).take, null, "outside the ten-minute default");
  assert.ok(
    A.plan(offers, backlogCtx(Object.assign({ lookbackMs: A.lookbackMsFor({ lookbackMin: 60 }) }, base))).take,
    "inside an hour"
  );
});

// ---- internal file review is not a file offer ------------------------------

test("Cowork's internal file review is narration, not a file offer", () => {
  // Live from the owner's chat: this card names a file, takes a press, and
  // hands you nothing — pressing it opens a review of the project's own
  // document. The extension must not attempt to download it.
  assert.equal(A.isFileActivity("Reading project file Authority Watch Register 8.17.2026.md"), true);
  assert.equal(A.isFileActivity("Read file notes 8.12.2026.md"), true);
  assert.equal(A.isFileActivity("Viewed document exhibit list.pdf"), true);
  assert.equal(A.isFileActivity("Searching project files"), true);
});

test("a file Claude hands over still reads as an offer", () => {
  // Creation is Cowork genuinely producing a file — it keeps being pressed.
  assert.equal(A.isFileActivity("Created ruling revised.md"), false);
  // A bare filename is a card, whatever words the name starts with.
  assert.equal(A.isFileActivity("Authority Watch Register 8.17.2026.md"), false);
  assert.equal(A.isFileActivity("Reading List.md"), false, "a file NAMED with the verb still saves");
  assert.equal(A.isFileActivity("Download ruling.docx"), false);
  assert.equal(A.isFileActivity(""), false);
  assert.equal(A.isFileActivity(null), false);
});

// ---- Cowork's artifact blocks ----------------------------------------------

test("an artifact block's text reads as a name and a type", () => {
  // Live from the owner's console dump: the display name runs straight into
  // the kind word, and the destinations trail after the type.
  assert.deepEqual(
    A.artifactCard(
      "Verification report 26stcp07311 petition to compel arbitration 8.19.2026Document · MD Google Drive"
    ),
    { name: "Verification report 26stcp07311 petition to compel arbitration 8.19.2026", type: "md" }
  );
  assert.deepEqual(A.artifactCard("Citation verification log 26stcp07311 8.19.2026Document · MD"), {
    name: "Citation verification log 26stcp07311 8.19.2026",
    type: "md",
  });
  // Not everything with a dot in it is a block.
  assert.equal(A.artifactCard("Here's the report · reviewed carefully"), null);
  assert.equal(A.artifactCard(""), null);
  assert.equal(A.artifactCard(null), null);
});

test("artifact blocks save on Cowork by census, not the live gate", () => {
  // The stream signal that feeds the live gate is confirmed broken on
  // Cowork, so the census is the gate: what was on the page when the ledger
  // started is adopted, and a block that appears after it is output.
  const offers = [{ key: "artifact|report.md", name: "report.md", ready: true }];
  const base = { enabled: true, baselined: true, seen: [], count: 0, max: 20, now: 10000, lastAt: 0 };

  // Before the census closes: adopted, never saved.
  const first = A.artifactPlan(offers, Object.assign({}, base, { baselined: false }));
  assert.equal(first.hold, "baseline");
  assert.deepEqual(first.adopt, ["artifact|report.md"]);
  assert.equal(first.take, null);

  // After: a fresh block is output, and is taken.
  const taken = A.artifactPlan(offers, base);
  assert.equal(taken.take, offers[0]);

  // Adopted or already pressed: left alone.
  assert.equal(A.artifactPlan(offers, Object.assign({}, base, { seen: ["artifact|report.md"] })).take, null);

  // The shared ceilings still hold.
  assert.equal(A.artifactPlan(offers, Object.assign({}, base, { generating: true })).hold, "generating");
  assert.equal(A.artifactPlan(offers, Object.assign({}, base, { count: 20 })).hold, "cap");
  assert.equal(A.artifactPlan(offers, Object.assign({}, base, { lastAt: 9500 })).hold, "cooldown");
  assert.equal(A.artifactPlan(offers, Object.assign({}, base, { enabled: false })).hold, "off");
  const notReady = A.artifactPlan(
    [{ key: "artifact|x.md", name: "x.md", ready: false }],
    base
  );
  assert.equal(notReady.take, null);
  assert.equal(notReady.hold, "not ready");
});

test("the census does not close over a Cowork turn still in flight", () => {
  const offers = [{ key: "artifact|report.md", name: "report.md", ready: true }];
  const held = A.artifactPlan(offers, { enabled: true, baselined: false, generating: true });
  assert.equal(held.hold, "settling");
  assert.deepEqual(held.adopt, [], "nothing adopted while the answer is still arriving");
});

// ---- Several files at once -----------------------------------------------

test("a reply's whole batch of documents saves, one at a time", () => {
  // Eight files in one reply: the shape that was being cut off at six, and
  // the shape the caller walks through a call at a time.
  const offers = [];
  for (let i = 1; i <= 8; i++) offers.push({ key: "t1|doc-" + i + ".docx", name: "doc-" + i + ".docx" });
  const seen = [];
  const taken = [];
  for (let i = 0; i < 8; i++) {
    const r = A.plan(offers, ctx({ seen: seen.slice() }));
    assert.ok(r.take, "call " + (i + 1) + " should still have one to take");
    taken.push(r.take.key);
    seen.push.apply(seen, r.adopt);
  }
  assert.equal(taken.length, 8);
  assert.equal(new Set(taken).size, 8, "each call takes a different file");
  assert.deepEqual(taken, offers.map((o) => o.key), "and in the order the reply presents them");
  // And then it stops, rather than coming back round for a second copy.
  assert.equal(A.plan(offers, ctx({ seen })).take, null);
});

test("one reply's share is more than a batch of documents", () => {
  assert.ok(A.MAX_PER_TURN >= 10, "a set of papers is the ordinary case, not the pathological one");
  assert.ok(A.MAX_PER_TURN <= A.MAX_PER_PAGE, "the page ceiling is still the outer one");
});

test("arrivalOf matches the file we pressed for BY NAME", () => {
  // Two saves seconds apart: b landed first, then a. a's check must find a,
  // not "the newest download, which is newer than my press".
  const items = [
    { name: "a.docx", at: 5000 },
    { name: "b.docx", at: 3000 },
  ];
  const got = A.arrivalOf(items, "a.docx", 4000);
  assert.deepEqual(got, { arrived: true, name: "a.docx", byName: true });
  // b's own check, made while only b had landed, is equally about b.
  assert.deepEqual(A.arrivalOf([items[1]], "b.docx", 2500), {
    arrived: true,
    name: "b.docx",
    byName: true,
  });
});

test("a file that hasn't arrived isn't credited to its neighbour's download", () => {
  // The old rule — newest download newer than my press — said yes here, and
  // named the wrong file while doing it.
  const items = [{ name: "b.docx", at: 5000 }];
  const got = A.arrivalOf(items, "a.docx", 4000);
  assert.equal(got.arrived, true, "something did arrive, so this is not a no");
  assert.equal(got.byName, false, "but it is not evidence about a.docx by name");
  assert.equal(got.name, "b.docx", "and it says which file it actually saw");
});

test("Chrome's own de-duplication still counts as the file arriving", () => {
  const items = [{ name: "ruling (1).docx", at: 5000 }];
  assert.deepEqual(A.arrivalOf(items, "ruling.docx", 4000), {
    arrived: true,
    name: "ruling (1).docx",
    byName: true,
  });
});

test("nothing since the press is a no; an unanswered question stays unknown", () => {
  const items = [{ name: "old.docx", at: 1000 }];
  assert.equal(A.arrivalOf(items, "a.docx", 9000).arrived, false);
  assert.equal(A.arrivalOf([], "a.docx", 9000).arrived, false, "an empty folder is an answer");
  assert.equal(A.arrivalOf(null, "a.docx", 9000).arrived, null, "no answer is not a no");
  assert.equal(A.arrivalOf(undefined, "a.docx", 9000).arrived, null);
});

test("an unnamed offer falls back to what arrived since the press", () => {
  const items = [{ name: "whatever.pdf", at: 5000 }];
  const got = A.arrivalOf(items, "", 4000);
  assert.equal(got.arrived, true);
  assert.equal(got.byName, false);
  assert.equal(got.name, "whatever.pdf");
});

test("the clock's slack is a second, not a licence", () => {
  assert.equal(A.arrivalOf([{ name: "a.docx", at: 4200 }], "a.docx", 5000).arrived, true);
  assert.equal(A.arrivalOf([{ name: "a.docx", at: 3000 }], "a.docx", 5000).arrived, false);
});

// ---- the manual button takes the whole reply ------------------------------

test("the batch is every file the reply offers, in the order it offers them", () => {
  const offers = [
    { key: "t1|ruling.docx", name: "ruling.docx" },
    { key: "t1|exhibit-a.pdf", name: "exhibit-a.pdf" },
    { key: "t1|exhibit-b.pdf", name: "exhibit-b.pdf" },
  ];
  const r = A.batchPlan(offers);
  assert.deepEqual(r.take.map((o) => o.name), ["ruling.docx", "exhibit-a.pdf", "exhibit-b.pdf"]);
  assert.deepEqual(r.notReady, []);
  assert.equal(r.capped, 0);
  assert.match(A.batchSummary(r), /Saving all 3 files from this reply, one at a time\./);
});

test("one file is still a batch, and reads like one file", () => {
  const r = A.batchPlan([{ key: "t1|only.docx", name: "only.docx" }]);
  assert.equal(r.take.length, 1);
  assert.equal(A.batchSummary(r), "Saving 1 file from this reply.");
});

test("what has already been pressed is left out and SAID, not silently skipped", () => {
  const r = A.batchPlan([
    { key: "t1|a.docx", name: "a.docx", ready: false },
    { key: "t1|b.docx", name: "b.docx" },
  ]);
  assert.deepEqual(r.take.map((o) => o.name), ["b.docx"]);
  assert.deepEqual(r.notReady.map((o) => o.name), ["a.docx"]);
  assert.match(A.batchSummary(r), /1 was already pressed/);
});

test("the batch has a ceiling, and says what it left out", () => {
  const many = [];
  for (let i = 1; i <= A.MAX_PER_TURN + 3; i++) many.push({ key: "t1|f" + i, name: "f" + i });
  const r = A.batchPlan(many);
  assert.equal(r.take.length, A.MAX_PER_TURN);
  assert.equal(r.capped, 3);
  assert.match(A.batchSummary(r), /3 left out by the \d+-file ceiling/);
});

test("a smaller ceiling can be asked for", () => {
  const r = A.batchPlan([{ key: "a" }, { key: "b" }, { key: "c" }], { max: 2 });
  assert.equal(r.take.length, 2);
  assert.equal(r.capped, 1);
});

test("the same file offered twice is pressed once", () => {
  // Two paths can find one control — a[download] and the card scan — and
  // pressing it twice is a second copy on your disk.
  const r = A.batchPlan([
    { key: "t1|a.docx", name: "a.docx" },
    { key: "t1|a.docx", name: "a.docx" },
    { key: "t1|b.docx", name: "b.docx" },
  ]);
  assert.deepEqual(r.take.map((o) => o.name), ["a.docx", "b.docx"]);
});

test("nothing pressable is an answer rather than an empty batch", () => {
  const r = A.batchPlan([{ key: "t1|a.docx", name: "a.docx", ready: false }]);
  assert.deepEqual(r.take, []);
  assert.equal(A.batchSummary(r), "Nothing here can be pressed.");
  assert.equal(A.batchSummary(A.batchPlan([])), "Nothing here can be pressed.");
  assert.equal(A.batchSummary(null), "");
});

test("junk in the list doesn't break the batch", () => {
  const r = A.batchPlan([null, { key: "t1|a.docx", name: "a.docx" }, undefined]);
  assert.deepEqual(r.take.map((o) => o.name), ["a.docx"]);
});
