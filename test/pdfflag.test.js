/**
 * A PDF uploads only on your say-so.
 * Run with: node --test test/pdfflag.test.js
 *
 * The question is only worth anything if it is asked where a person is there
 * to answer it and never where nobody is: a pick on claude.ai's own upload
 * button is asked about, and the scheduled send that goes out at 3 a.m. with
 * a PDF its operator already said yes to is not held for a second answer.
 */
const test = require("node:test");
const assert = require("node:assert");
const PF = require("../src/pdfflag.js");

const file = (name, type) => ({ name: name, type: type || "" });

// ---- what counts as a PDF ---------------------------------------------------

test("a PDF is known by its name, in any case", () => {
  for (const n of ["brief.pdf", "Brief.PDF", "Smith v. Jones — complaint.Pdf", "  exhibit 4.pdf "])
    assert.ok(PF.isPdfName(n), n + " should be a PDF");
  for (const n of ["brief.pdf.txt", "brief.txt", "pdf", "brief.pdfx", "notes-about.pdf.docx", "", null])
    assert.ok(!PF.isPdfName(n), String(n) + " should not be a PDF");
});

test("a PDF saved without its extension is still a PDF, by the type the browser read off it", () => {
  assert.ok(PF.isPdf(file("scan", "application/pdf")));
  assert.ok(PF.isPdf(file("scan", "Application/PDF")));
  assert.ok(PF.isPdf(file("brief.pdf", "")));
  assert.ok(!PF.isPdf(file("combined-documents.txt", "text/plain")));
  assert.ok(!PF.isPdf(file("pseudonym_key.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")));
  assert.ok(!PF.isPdf(null));
});

test("a walked entry is read the same as a file, so every door gets the same answer", () => {
  assert.ok(PF.isPdf({ path: "Smith/Text Files/brief.pdf", file: file("brief.pdf") }));
  assert.ok(!PF.isPdf({ path: "Smith/Text Files/brief.txt", file: file("brief.txt") }));
});

test("split keeps both halves in the order they came", () => {
  const a = file("a.txt"), b = file("b.pdf"), c = file("c.docx"), d = file("d.PDF");
  const s = PF.split([a, b, c, d]);
  // A Word document is held with the PDFs.
  assert.deepEqual(s.pdfs, [b, c, d]);
  assert.deepEqual(s.rest, [a]);
  assert.deepEqual(PF.split(null), { pdfs: [], rest: [] });
});

// ---- when claude.ai's own doors ask ----------------------------------------

test("a person's own pick, drop or paste of a PDF asks", () => {
  assert.equal(PF.asksAtPage({ trusted: true, ours: false, files: [file("brief.pdf")] }), true);
  // One PDF among other papers is still a PDF going up.
  assert.equal(PF.asksAtPage({ trusted: true, files: [file("a.txt"), file("b.pdf")] }), true);
});

test("the extension's own hand-offs are never asked about again", () => {
  // A scheduled send, a workflow step, the Folder button and the guard's own
  // release all reach claude.ai's input as synthetic events, carrying files
  // that were asked about where they were picked. Asking again would wedge a
  // send nobody is watching.
  assert.equal(PF.asksAtPage({ trusted: false, files: [file("brief.pdf")] }), false);
  assert.equal(PF.asksAtPage({ files: [file("brief.pdf")] }), false);
});

test("the extension's own drop zones ask for themselves", () => {
  assert.equal(PF.asksAtPage({ trusted: true, ours: true, files: [file("brief.pdf")] }), false);
});

test("a batch with no PDF or Word document in it never asks", () => {
  assert.equal(PF.asksAtPage({ trusted: true, files: [file("combined-documents.txt"), file("Tentative.md")] }), false);
  assert.equal(PF.asksAtPage({ trusted: true, files: [] }), false);
  assert.equal(PF.asksAtPage(null), false);
});

// ---- the words -------------------------------------------------------------

test("names are listed in full up to a point, then counted", () => {
  assert.equal(PF.nameList(["a.pdf"]), "a.pdf");
  assert.equal(PF.nameList(["a.pdf", "b.pdf"]), "a.pdf and b.pdf");
  assert.equal(PF.nameList(["a.pdf", "b.pdf", "c.pdf"]), "a.pdf, b.pdf and c.pdf");
  assert.equal(PF.nameList(["a.pdf", "b.pdf", "c.pdf", "d.pdf"]), "a.pdf, b.pdf, c.pdf and d.pdf");
  assert.equal(PF.nameList(["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf", "f.pdf"]), "a.pdf, b.pdf, c.pdf and 3 more");
  assert.equal(PF.nameList([file("a.pdf"), { file: file("b.pdf") }]), "a.pdf and b.pdf");
  assert.equal(PF.nameList([]), "");
});

test("the question at an upload names the PDF, says why, and keeps 'no' the safe word", () => {
  const q = PF.prompt(["brief.pdf"], 0);
  assert.equal(q.head, "Upload this PDF?");
  assert.match(q.body, /^brief\.pdf is a PDF\./);
  assert.match(q.body, /most often an original, in the real names/);
  assert.match(q.body, /Upload it only if you mean Claude to read it\.$/);
  assert.equal(q.keep, "Keep it out");
  // The key guard's words, so "Upload anyway was pressed for …" — the note a
  // release that never landed is owed — is true whichever guard asked.
  assert.equal(q.go, "Upload anyway");
});

test("the question counts the PDFs, and says the rest go up either way", () => {
  const q = PF.prompt([file("a.pdf"), file("b.pdf")], 3);
  assert.equal(q.head, "Upload these 2 PDFs?");
  assert.match(q.body, /^a\.pdf and b\.pdf are PDFs\./);
  assert.match(q.body, /Upload them only if you mean Claude to read them\./);
  assert.match(q.body, /The other 3 files go up either way\.$/);
  assert.equal(q.keep, "Keep them out");
  const one = PF.prompt(["a.pdf"], 1);
  assert.match(one.body, /The other file goes up either way\.$/);
});

test("the question at a send or a run says why it is asked now rather than later", () => {
  const q = PF.prompt(["brief.pdf"], 2, { queued: true });
  assert.equal(q.head, "Add this PDF?");
  assert.match(q.body, /upload when this goes out, with nobody there to ask then/);
  assert.match(q.body, /Add it only if you mean Claude to read it\./);
  assert.match(q.body, /The other 2 files are added either way\.$/);
  assert.equal(q.keep, "Leave it out");
  assert.equal(q.go, "Add PDF");
  const two = PF.prompt(["a.pdf", "b.pdf"], 1, { queued: true });
  assert.equal(two.go, "Add PDFs");
  assert.match(two.body, /They will upload when this goes out/);
  assert.match(two.body, /so they are asked about now/);
  assert.match(two.body, /The other file is added either way\.$/);
});

test("what is said after a no names what was kept out", () => {
  assert.equal(PF.heldNote(["brief.pdf"]), "Held back brief.pdf — a PDF uploads only when you say so.");
  assert.equal(
    PF.heldNote(["a.pdf", "b.pdf"]),
    "Held back 2 PDFs (a.pdf and b.pdf) — a PDF uploads only when you say so."
  );
  assert.equal(
    PF.heldNote([file("brief.pdf")], { queued: true }),
    "Left out brief.pdf — a PDF is added only when you say so."
  );
  assert.equal(PF.heldNote([]), "");
});

// ---- the last door: the send -------------------------------------------------
//
// claude.ai's own "+ Add files" got a PDF past every door that watches the
// pick, so the message itself is asked about: whatever the composer is
// carrying, a PDF nobody said yes to holds the send.

test("a PDF's name is found inside the caption that carries it", () => {
  assert.equal(PF.pdfNameIn("Smith complaint.pdf"), "Smith complaint.pdf");
  assert.equal(PF.pdfNameIn("brief.PDF · 2 MB"), "brief.PDF");
  assert.equal(PF.pdfNameIn("Remove brief.pdf"), "Remove brief.pdf");
  assert.equal(PF.pdfNameIn("brief.pdfx"), "");
  assert.equal(PF.pdfNameIn("combined-documents.txt"), "");
  assert.equal(PF.pdfNameIn(""), "");
  // A whole paragraph is not a caption.
  assert.equal(PF.pdfNameIn("x".repeat(400) + " brief.pdf"), "");
});

test("captions naming the same file are the same file — but a longer name is not", () => {
  assert.ok(PF.sameName("brief.pdf", "Remove brief.pdf"));
  assert.ok(PF.sameName("Remove brief.pdf", "BRIEF.pdf"));
  assert.ok(PF.sameName("brief.pdf", "brief.pdf"));
  assert.ok(!PF.sameName("brief.pdf", "notbrief.pdf"));
  assert.ok(!PF.sameName("brief.pdf", "reply.pdf"));
  assert.ok(!PF.sameName("", "brief.pdf"));
});

test("what the composer shows: names once each, and a PDF badge no name accounts for", () => {
  // A card's name, its remove button's label, and its type badge are one PDF.
  assert.deepStrictEqual(
    PF.pdfsShown(["Smith complaint.pdf", "Remove Smith complaint.pdf", "PDF", "12 pages"]),
    { names: ["Smith complaint.pdf"], unnamed: 0, unnamedWord: 0 }
  );
  // A card that says only what it is still says it is a PDF.
  assert.deepStrictEqual(PF.pdfsShown(["PDF"]), { names: [], unnamed: 1, unnamedWord: 0 });
  assert.deepStrictEqual(PF.pdfsShown(["a.pdf", "PDF", "PDF"]), { names: ["a.pdf"], unnamed: 1, unnamedWord: 0 });
  // Nothing PDF about it.
  assert.deepStrictEqual(PF.pdfsShown(["combined-documents.txt", "Send message", "Opus"]), {
    names: [],
    unnamed: 0,
    unnamedWord: 0,
  });
  assert.deepStrictEqual(PF.pdfsShown(null), { names: [], unnamed: 0, unnamedWord: 0 });
});

test("a send carrying a PDF nobody said yes to is held", () => {
  const v = PF.sendAsks({ shown: PF.pdfsShown(["brief.pdf"]), trusted: true });
  assert.equal(v.hold, true);
  assert.deepStrictEqual(v.names, ["brief.pdf"]);
  // A badge alone holds too: erring towards asking.
  assert.equal(PF.sendAsks({ shown: PF.pdfsShown(["PDF"]) }).hold, true);
});

test("a PDF said yes to — at the pick, by the Folder button, or at this send — goes", () => {
  const shown = PF.pdfsShown(["brief.pdf", "Remove brief.pdf"]);
  assert.equal(PF.sendAsks({ shown: shown, confirmed: ["brief.pdf"] }).hold, false);
  // A yes for one PDF is not a yes for another.
  assert.equal(
    PF.sendAsks({ shown: PF.pdfsShown(["brief.pdf", "exhibit.pdf"]), confirmed: ["brief.pdf"] }).hold,
    true
  );
  // A badge with no name can only be said yes to at the send, by its signature.
  const badge = PF.pdfsShown(["PDF"]);
  const first = PF.sendAsks({ shown: badge, confirmed: ["brief.pdf"] });
  assert.equal(first.hold, true);
  assert.equal(PF.sendAsks({ shown: badge, confirmedSig: first.sig }).hold, false);
  // ...and that signature is this set's, not the next one's.
  assert.equal(
    PF.sendAsks({ shown: PF.pdfsShown(["PDF", "PDF", "x.pdf"]), confirmedSig: first.sig }).hold,
    true
  );
});

test("an upload the page saw counts while the composer still shows an attachment", () => {
  const nothingShown = PF.pdfsShown([]);
  const v = PF.sendAsks({ shown: nothingShown, uploaded: ["brief.pdf"], attachments: true });
  assert.equal(v.hold, true);
  assert.deepStrictEqual(v.names, ["brief.pdf"]);
  // Removed since, and nothing attached now: not asked about forever.
  assert.equal(PF.sendAsks({ shown: nothingShown, uploaded: ["brief.pdf"], attachments: false }).hold, false);
  // Not a PDF, not counted.
  assert.equal(PF.sendAsks({ shown: nothingShown, uploaded: ["notes.txt"], attachments: true }).hold, false);
  // The same PDF the composer names is one PDF, not two.
  const both = PF.sendAsks({ shown: PF.pdfsShown(["brief.pdf"]), uploaded: ["brief.pdf"], attachments: true });
  assert.deepStrictEqual(both.names, ["brief.pdf"]);
});

test("the extension's own sends, and a message with no PDF, are never held", () => {
  assert.equal(PF.sendAsks({ shown: PF.pdfsShown(["brief.pdf"]), trusted: false }).hold, false);
  assert.equal(PF.sendAsks({ shown: PF.pdfsShown(["notes.txt"]) }).hold, false);
  assert.equal(PF.sendAsks({}).hold, false);
  assert.equal(PF.sendAsks(null).hold, false);
});

test("the send's question names what it carries and says how to send without it", () => {
  const one = PF.sendPrompt(["brief.pdf"], 0);
  assert.equal(one.head, "Send this PDF to Claude?");
  assert.match(one.body, /^This message carries brief\.pdf\./);
  assert.match(one.body, /remove its card from the message/);
  assert.equal(one.keep, "Don't send");
  assert.equal(one.go, "Send with the PDF");
  const two = PF.sendPrompt(["a.pdf"], 1, 0);
  assert.equal(two.head, "Send these 2 PDFs to Claude?");
  assert.match(two.body, /a\.pdf and 1 more PDF/);
  assert.equal(two.go, "Send with the PDFs");
  assert.match(PF.sendPrompt([], 1).body, /carries a PDF\./);
});

// ---- Word documents --------------------------------------------------------

test("a Word document is asked about the way a PDF is", () => {
  for (const n of ["decl.docx", "OLD.DOC", "macro.docm", "form.dotx", "form.dot", "form.dotm"]) {
    assert.ok(PF.isWord(file(n)), n);
    assert.ok(PF.isHeld(file(n)), n);
    assert.ok(!PF.isPdf(file(n)), n);
  }
  // By the type the browser read off it, when the name says nothing.
  assert.ok(PF.isHeld(file("scan", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")));
  assert.ok(PF.isHeld(file("scan", "application/msword")));
  // Not a Word document: an export of one, or a name that only contains it.
  assert.ok(!PF.isHeld(file("Tentative.md")));
  assert.ok(!PF.isHeld(file("decl.docx.txt")));
  assert.ok(!PF.isHeld(file("decl.docxx")));
  assert.equal(PF.asksAtPage({ trusted: true, files: [file("a.txt"), file("Smith Tentative.docx")] }), true);
  assert.equal(PF.asksAtPage({ trusted: false, files: [file("Smith Tentative.docx")] }), false);
});

test("the question names a Word document as one, and a batch of both as both", () => {
  const w = PF.prompt([file("decl.docx")], 1);
  assert.equal(w.head, "Upload this Word document?");
  assert.match(w.body, /^decl\.docx is a Word document\. /);
  assert.match(w.body, /a Word document is most often the draft itself or an original, in the real names/);
  assert.equal(w.go, "Upload anyway");
  const both = PF.prompt([file("a.pdf"), file("b.docx")], 0, { queued: true });
  assert.equal(both.head, "Add these 2 PDFs and Word documents?");
  assert.equal(both.go, "Add PDFs and Word documents");
  assert.equal(PF.prompt([file("a.pdf")], 0).head, "Upload this PDF?");
  assert.equal(PF.heldNote([file("decl.docx")]), "Held back decl.docx — a Word document uploads only when you say so.");
  assert.equal(
    PF.heldNote([file("a.pdf"), file("b.doc")], { queued: true }),
    "Left out 2 PDFs and Word documents (a.pdf and b.doc) — a PDF or Word document is added only when you say so."
  );
});

test("the send reads a Word card off the composer and asks about it", () => {
  assert.equal(PF.pdfNameIn("Remove decl.docx"), "Remove decl.docx");
  const shown = PF.pdfsShown(["decl.docx", "DOCX", "Remove decl.docx", "brief.pdf", "PDF", "DOCX"]);
  assert.deepEqual(shown, { names: ["decl.docx", "brief.pdf"], unnamed: 1, unnamedWord: 1 });
  const v = PF.sendAsks({ shown: PF.pdfsShown(["DOCX"]), attachments: true, trusted: true });
  assert.equal(v.hold, true);
  const q = PF.sendPrompt(v.names, v.unnamed, v.unnamedWord);
  assert.equal(q.head, "Send this Word document to Claude?");
  assert.match(q.body, /^This message carries a Word document\./);
  assert.equal(q.go, "Send with the Word document");
  // claude.ai's upload response names it too.
  const up = PF.sendAsks({ shown: { names: [], unnamed: 0 }, uploaded: ["decl.docx"], attachments: true, trusted: true });
  assert.deepEqual(up.names, ["decl.docx"]);
  assert.equal(up.hold, true);
  assert.equal(PF.sendAsks({ shown: shown, confirmed: ["decl.docx", "brief.pdf"], trusted: true }).hold, true, "a badge no name accounts for still asks");
  assert.match(PF.sendPrompt(["a.pdf"], 1, 1).body, /a\.pdf and 1 more Word document\./);
});
