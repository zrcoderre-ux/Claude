const test = require("node:test");
const assert = require("node:assert");
const D = require("../src/dropdir.js");

// ---- fake FileSystemEntry tree -------------------------------------------
// The real ones are callback-only and hand out at most 100 children per read;
// these behave the same way, which is the only way that trap gets tested.

function file(name, size) {
  return {
    isFile: true,
    isDirectory: false,
    name: name,
    file: (ok) => ok({ name: name, size: size == null ? 10 : size, type: "text/plain" }),
  };
}

function unreadableFile(name) {
  return { isFile: true, isDirectory: false, name: name, file: (ok, fail) => fail(new Error("no")) };
}

function dir(name, children, opts) {
  const o = opts || {};
  return {
    isFile: false,
    isDirectory: true,
    name: name,
    createReader() {
      let i = 0;
      return {
        readEntries(ok, fail) {
          if (o.failRead) return fail(new Error("no"));
          // The real API's batch size, so a folder over it has to be read twice.
          const batch = children.slice(i, i + 100);
          i += batch.length;
          ok(batch);
        },
      };
    },
  };
}

test("a dropped folder yields the files inside it and never the folder", async () => {
  const tree = dir("papers", [file("moving.txt"), file("opposition.txt"), file("reply.txt")]);
  const res = await D.walk([tree]);
  assert.deepEqual(res.files.map((f) => f.file.name), [
    "moving.txt",
    "opposition.txt",
    "reply.txt",
  ]);
  assert.equal(res.folders, 1);
  assert.ok(!res.files.some((f) => f.file.name === "papers"), "the folder is not a document");
});

test("the folder and the file beside it go in one gesture — the point of the feature", async () => {
  // What the drop actually looks like: a folder of papers and the pseudonym
  // key sitting next to it, selected together.
  const res = await D.walk([
    dir("papers", [file("moving.txt"), file("opposition.txt")]),
    file("pseudonym_key.xlsx"),
  ]);
  assert.deepEqual(res.files.map((f) => f.file.name), [
    "moving.txt",
    "opposition.txt",
    "pseudonym_key.xlsx",
  ]);
});

test("a folder of more than 100 files comes back WHOLE", async () => {
  // readEntries hands back at most 100 and expects to be asked again. Reading
  // it once loses the rest without a word, which is the bug this guards.
  const many = [];
  for (let i = 1; i <= 140; i++) many.push(file("paper-" + i + ".txt"));
  const res = await D.walk([dir("papers", many)]);
  assert.equal(res.files.length, 140);
});

test("nested folders are descended, and every level's files land", async () => {
  const tree = dir("matter", [
    file("cover.txt"),
    dir("papers", [file("moving.txt"), dir("exhibits", [file("a.txt"), file("b.txt")])]),
  ]);
  const res = await D.walk([tree]);
  assert.deepEqual(res.files.map((f) => f.path), [
    "matter/cover.txt",
    "matter/papers/exhibits/a.txt",
    "matter/papers/exhibits/b.txt",
    "matter/papers/moving.txt",
  ]);
  assert.equal(res.folders, 3);
});

test("what a folder carries that nobody meant to upload is left out", async () => {
  const res = await D.walk([
    dir("papers", [file(".DS_Store"), file("moving.txt"), file("Thumbs.db"), file(".env")]),
  ]);
  assert.deepEqual(res.files.map((f) => f.file.name), ["moving.txt"]);
  assert.equal(res.junk, 3);
  assert.match(D.summarize(res), /Skipped 3 hidden files/);
});

test("junk names, by class and by name", () => {
  assert.equal(D.isJunkName(".DS_Store"), true);
  assert.equal(D.isJunkName(".gitignore"), true);
  assert.equal(D.isJunkName("Thumbs.db"), true);
  assert.equal(D.isJunkName("THUMBS.DB"), true);
  assert.equal(D.isJunkName("desktop.ini"), true);
  assert.equal(D.isJunkName(""), true);
  assert.equal(D.isJunkName("moving.txt"), false);
  assert.equal(D.isJunkName("Smith v. Jones.pdf"), false);
});

test("files come back in the order the folder reads in, numbers as numbers", async () => {
  // Filesystem order is no order at all, and these are uploaded — and, when
  // they're text, concatenated — in the order they're held.
  const res = await D.walk([
    dir("papers", [
      file("exhibit-10.txt"),
      file("exhibit-2.txt"),
      file("exhibit-1.txt"),
      file("Exhibit-3.txt"),
    ]),
  ]);
  assert.deepEqual(res.files.map((f) => f.file.name), [
    "exhibit-1.txt",
    "exhibit-2.txt",
    "Exhibit-3.txt",
    "exhibit-10.txt",
  ]);
});

test("a file that won't open is counted, and the rest of the drop still lands", async () => {
  const res = await D.walk([dir("papers", [file("a.txt"), unreadableFile("b.txt"), file("c.txt")])]);
  assert.deepEqual(res.files.map((f) => f.file.name), ["a.txt", "c.txt"]);
  assert.equal(res.skipped, 1);
  assert.match(D.summarize(res), /1 unreadable file/);
});

test("a folder that won't list is counted rather than thrown", async () => {
  const res = await D.walk([dir("locked", [file("a.txt")], { failRead: true }), file("b.txt")]);
  assert.deepEqual(res.files.map((f) => f.file.name), ["b.txt"]);
  assert.equal(res.skipped, 1);
});

test("the cap stops the walk and SAYS it stopped — a silent truncation is the failure", async () => {
  const many = [];
  for (let i = 1; i <= 40; i++) many.push(file("p" + i + ".txt"));
  const res = await D.walk([dir("papers", many)], { maxFiles: 10 });
  assert.equal(res.files.length, 10);
  assert.equal(res.capped, true);
  assert.match(D.summarize(res, { maxFiles: 10 }), /first 10 files.*left out/);
});

test("depth is capped too, and the shallow files still come", async () => {
  let deep = dir("bottom", [file("deep.txt")]);
  for (let i = 0; i < 12; i++) deep = dir("level" + i, [deep]);
  const res = await D.walk([dir("top", [file("shallow.txt"), deep])]);
  assert.deepEqual(res.files.map((f) => f.file.name), ["shallow.txt"]);
  assert.ok(res.deep > 0);
  assert.match(D.summarize(res), /nested deeper than/);
});

test("a folder PICKED rather than dropped follows the same rules", () => {
  const res = D.fromPicked([
    { name: ".DS_Store", webkitRelativePath: "papers/.DS_Store", size: 1 },
    { name: "exhibit-10.txt", webkitRelativePath: "papers/exhibit-10.txt", size: 1 },
    { name: "exhibit-2.txt", webkitRelativePath: "papers/exhibit-2.txt", size: 1 },
    { name: "note.txt", webkitRelativePath: "papers/notes/note.txt", size: 1 },
    { name: "config", webkitRelativePath: "papers/.git/config", size: 1 },
  ]);
  assert.deepEqual(res.files.map((f) => f.file.name), [
    "exhibit-2.txt",
    "exhibit-10.txt",
    "note.txt",
  ]);
  assert.equal(res.junk, 2, "the dotfile, and everything under the dotted folder");
  assert.equal(res.folders, 2);
});

test("one pick, files and a folder's contents together, folder itself never a row", () => {
  // The run editor has a single Choose files door, and a single drop zone, so
  // a matter's folder and the key sitting beside it arrive in one gesture.
  const res = D.fromPicked([
    { name: "pseudonym_key.xlsx", webkitRelativePath: "", size: 4 },
    { name: "cover.pdf", size: 3 },
    { name: "exhibit-10.txt", webkitRelativePath: "papers/exhibit-10.txt", size: 1 },
    { name: "exhibit-2.txt", webkitRelativePath: "papers/exhibit-2.txt", size: 1 },
    { name: ".DS_Store", webkitRelativePath: "papers/.DS_Store", size: 1 },
  ]);
  assert.deepEqual(res.files.map((f) => f.file.name), [
    "cover.pdf",
    "exhibit-2.txt",
    "exhibit-10.txt",
    "pseudonym_key.xlsx",
  ]);
  assert.equal(res.folders, 1, "only the folder that files actually came from");
  assert.equal(res.junk, 1);
  assert.ok(
    res.files.every((f) => f.file.name !== "papers"),
    "the folder is not among the files"
  );
});

test("a plain multi-file pick down the same door says nothing at all", () => {
  const res = D.fromPicked([
    { name: "a.txt", size: 1 },
    { name: "b.txt", size: 1 },
  ]);
  assert.equal(res.folders, 0);
  assert.equal(D.summarize(res), "", "nothing about folders when no folder was picked");
});

test("a picked folder is capped and says so, like a dropped one", () => {
  const list = [];
  for (let i = 1; i <= 30; i++)
    list.push({ name: "p" + i + ".txt", webkitRelativePath: "papers/p" + i + ".txt", size: 1 });
  const res = D.fromPicked(list, { maxFiles: 5 });
  assert.equal(res.files.length, 5);
  assert.equal(res.capped, true);
});

test("a plain drop of loose files says nothing at all", async () => {
  const res = await D.walk([file("a.txt"), file("b.txt")]);
  assert.equal(res.folders, 0);
  assert.equal(D.summarize(res), "", "nothing happened worth a sentence");
});

test("the sentence says the folder itself wasn't taken", async () => {
  const res = await D.walk([dir("papers", [file("a.txt"), file("b.txt")])]);
  assert.match(D.summarize(res), /Added 2 files from the folder/);
  assert.match(D.summarize(res), /the folder itself isn't a document/);
});

test("nothing to walk is not an error", async () => {
  const res = await D.walk([]);
  assert.deepEqual(res.files, []);
  assert.equal(D.summarize(res), "");
  assert.equal(D.summarize(null), "");
  const picked = D.fromPicked(null);
  assert.deepEqual(picked.files, []);
});

// ---- a case folder is taken apart, not uploaded ----------------------------
//
// A matter's folder holds the originals, in the real names. Only what is under
// its Text Files subfolder is pseudonymized, and only that goes to Claude — with
// the key attached rather than uploaded, and everything else left where it is.

const CASE_RE = /\b\d{2}[A-Za-z]{4}\d{5}\b/;
const isCase = (n) => CASE_RE.test(n);
const paths = (list) => list.map((x) => x.path);

function at(path, size) {
  return { file: { name: path.split("/").pop(), size: size == null ? 10 : size }, path: path };
}

const CASE_PICK = [
  at("23STCV12345 Rasho/pseudonym_key.xlsx"),
  at("23STCV12345 Rasho/Originals/01 complaint.pdf"),
  at("23STCV12345 Rasho/Originals/02 answer.pdf"),
  at("23STCV12345 Rasho/Correspondence/letter.docx"),
  at("23STCV12345 Rasho/Text Files/02 opposition.txt"),
  at("23STCV12345 Rasho/Text Files/01 motion.txt"),
  at("23STCV12345 Rasho/notes.md"),
];

test("a case folder hands over its Text Files and nothing else", () => {
  const r = D.splitCaseFolder(CASE_PICK, { isCaseName: isCase });
  assert.equal(r.ok, true);
  assert.equal(r.root, "23STCV12345 Rasho");
  assert.deepEqual(paths(r.docs), [
    "23STCV12345 Rasho/Text Files/01 motion.txt",
    "23STCV12345 Rasho/Text Files/02 opposition.txt",
  ]);
  assert.deepEqual(paths(r.keys), ["23STCV12345 Rasho/pseudonym_key.xlsx"]);
  assert.equal(r.left, 4, "the originals, the letter and the loose note stay where they are");
  assert.equal(r.capped, false);
});

test("the documents come out in the folder's own order", () => {
  // Numeric runs sort like numbers, so exhibit-2 precedes exhibit-10 — the
  // order the files are concatenated in when they are bundled.
  const r = D.splitCaseFolder(
    ["10 reply.txt", "2 opposition.txt", "1 motion.txt"].map((n) =>
      at("24STCV00001 Doe/Text Files/" + n)
    ),
    { isCaseName: isCase }
  );
  assert.deepEqual(
    paths(r.docs).map((p) => p.split("/").pop()),
    ["1 motion.txt", "2 opposition.txt", "10 reply.txt"]
  );
});

test("Text Files is one folder however it was typed", () => {
  for (const seg of ["Text Files", "text files", "Text_Files", "TextFiles", "TEXT FILES"]) {
    const r = D.splitCaseFolder([at("23STCV12345 Rasho/" + seg + "/a.txt")], {
      isCaseName: isCase,
    });
    assert.equal(r.docs.length, 1, seg);
  }
  // And nothing else is that folder.
  for (const seg of ["Texts", "Text Files Old", "Originals"]) {
    const r = D.splitCaseFolder([at("23STCV12345 Rasho/" + seg + "/a.txt")], {
      isCaseName: isCase,
    });
    assert.equal(r.docs.length, 0, seg);
    assert.equal(r.left, 1, seg);
  }
});

test("a folder nested under Text Files comes too", () => {
  const r = D.splitCaseFolder(
    [
      at("23STCV12345 Rasho/Text Files/Exhibits/ex-1.txt"),
      at("23STCV12345 Rasho/Text Files/motion.txt"),
    ],
    { isCaseName: isCase }
  );
  assert.equal(r.docs.length, 2);
});

test("a folder whose name carries no case number is not this rule's business", () => {
  const r = D.splitCaseFolder(
    [at("Research/Text Files/a.txt"), at("Research/b.pdf")],
    { isCaseName: isCase }
  );
  assert.equal(r.ok, false);
  assert.equal(r.why, "not-case");
  assert.deepEqual(r.docs, []);
  // Nothing is claimed either way — the caller hands it to the ordinary walk.
  assert.deepEqual(r.keys, []);
});

test("the key is taken wherever it sits, including loose beside the folder", () => {
  const r = D.splitCaseFolder(
    [
      at("23STCV12345 Rasho/Text Files/motion.txt"),
      at("23STCV12345 Rasho/Admin/pseudonym_key.xlsx"),
      at("pseudonym_key.xlsx"), // dropped next to the folder, in the same gesture
    ],
    { isCaseName: isCase }
  );
  assert.deepEqual(paths(r.keys), ["23STCV12345 Rasho/Admin/pseudonym_key.xlsx", "pseudonym_key.xlsx"]);
  assert.equal(r.docs.length, 1);
});

test("a spreadsheet inside Text Files is still a key candidate, never a document", () => {
  // A spreadsheet can't be a run document at all, so admitting one here would
  // only add a row that never uploads.
  const r = D.splitCaseFolder(
    [at("23STCV12345 Rasho/Text Files/pseudonym_key.xlsx"), at("23STCV12345 Rasho/Text Files/a.txt")],
    { isCaseName: isCase }
  );
  assert.deepEqual(paths(r.docs), ["23STCV12345 Rasho/Text Files/a.txt"]);
  assert.equal(r.keys.length, 1);
});

test("a case folder with no Text Files in it adds nothing, and says so", () => {
  const r = D.splitCaseFolder(
    [at("23STCV12345 Rasho/Originals/complaint.pdf"), at("23STCV12345 Rasho/pseudonym_key.xlsx")],
    { isCaseName: isCase }
  );
  assert.equal(r.ok, true, "it IS a case folder — which is exactly why nothing else goes");
  assert.deepEqual(r.docs, []);
  assert.equal(r.keys.length, 1);
  assert.match(D.summarizeCase(r), /No Text Files folder in 23STCV12345 Rasho/);
});

test("the cap applies to what is taken, not to what was scanned", () => {
  const many = [];
  for (let i = 0; i < 12; i++) many.push(at("23STCV12345 Rasho/Text Files/" + (100 + i) + ".txt"));
  for (let i = 0; i < 40; i++) many.push(at("23STCV12345 Rasho/Originals/" + i + ".pdf"));
  const r = D.splitCaseFolder(many, { isCaseName: isCase, maxFiles: 10 });
  assert.equal(r.docs.length, 10);
  assert.equal(r.capped, true);
  assert.equal(r.left, 40);
  assert.match(D.summarizeCase(r), /Took the first 10/);
});

test("the summary says what went, what stayed, and nothing when there is no split", () => {
  const r = D.splitCaseFolder(CASE_PICK, { isCaseName: isCase });
  const said = D.summarizeCase(r);
  assert.match(said, /Added 2 files from 23STCV12345 Rasho\/Text Files\./);
  assert.match(said, /Left 4 other files in the case folder alone/);
  assert.equal(D.summarizeCase(D.splitCaseFolder([at("Research/a.txt")], { isCaseName: isCase })), "");
  assert.equal(D.summarizeCase(null), "");
});

test("no predicate means no case folder — the rule is opt-in by name", () => {
  assert.equal(D.splitCaseFolder(CASE_PICK, {}).ok, false);
  assert.equal(D.splitCaseFolder(CASE_PICK).ok, false);
  assert.equal(D.splitCaseFolder(null, { isCaseName: isCase }).ok, false);
});

test("the scan cap is far above the upload cap, because it has to reach the folder", () => {
  assert.ok(D.MAX_SCAN > D.MAX_FILES * 5, D.MAX_SCAN + " vs " + D.MAX_FILES);
});
