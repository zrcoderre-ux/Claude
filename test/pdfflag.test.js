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
  assert.deepEqual(s.pdfs, [b, d]);
  assert.deepEqual(s.rest, [a, c]);
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

test("a batch with no PDF in it never asks", () => {
  assert.equal(PF.asksAtPage({ trusted: true, files: [file("combined-documents.txt"), file("brief.docx")] }), false);
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
