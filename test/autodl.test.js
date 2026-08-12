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
  for (let i = 0; i < 10; i++) many.push({ key: "t1|f" + i });
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
