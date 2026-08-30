/**
 * Tests for src/upfiles.js — getting back a file you uploaded.
 * Run with: node --test test/upfiles.test.js
 *
 * workflow.js is required FIRST so the module reads the real answer to "is this
 * a text document" off the global rather than its own fallback. That question
 * decides whether a recovered file is handed over as the original or as an
 * extract, and a test that stubbed it would prove nothing about the label the
 * panel puts on your file.
 */
const test = require("node:test");
const assert = require("node:assert");
require("../src/workflow.js");
const U = require("../src/upfiles.js");

// A conversation payload of the shape claude.ai answers with.
function conv(messages) {
  return { name: "A chat", chat_messages: messages };
}
const yours = (extra) => Object.assign({ sender: "human", text: "here" }, extra);
const claudes = (extra) => Object.assign({ sender: "assistant", text: "done" }, extra);

const IMAGE = {
  file_name: "photo.png",
  file_uuid: "aaaa1111",
  file_kind: "image",
  thumbnail_url: "/api/org1/files/aaaa1111/thumbnail",
  preview_url: "/api/org1/files/aaaa1111/preview",
};
const PDF = {
  file_name: "brief.pdf",
  file_size: 120345,
  file_type: "application/pdf",
  extracted_content: "IN THE SUPERIOR COURT…",
};

// ---- whose files these are -------------------------------------------------

test("only the files YOU attached are listed", () => {
  const list = U.uploadsOf(
    conv([
      yours({ files_v2: [IMAGE] }),
      claudes({ files: [{ file_name: "output.docx", url: "/api/org1/files/z/document" }] }),
    ])
  );
  assert.deepEqual(list.map((e) => e.name), ["photo.png"]);
});

test("a message that says 'user' rather than 'human' is still yours", () => {
  // The payload says human; a conversation rebuilt from the page says user.
  const list = U.uploadsOf(conv([{ role: "user", attachments: [PDF] }]));
  assert.equal(list.length, 1);
});

test("a conversation with no record at all is an empty list, not a crash", () => {
  for (const bad of [null, undefined, {}, { chat_messages: null }, { chat_messages: [null, 3] }])
    assert.deepEqual(U.uploadsOf(bad), []);
  assert.equal(U.describe([]), "No files were uploaded to this conversation.");
});

test("a row that is neither named, identified, fetchable nor readable is not an upload", () => {
  const list = U.uploadsOf(conv([yours({ attachments: [{ created_at: "2026-01-01" }, PDF] })]));
  assert.deepEqual(list.map((e) => e.name), ["brief.pdf"]);
});

// ---- where the bytes come from ---------------------------------------------

test("a thumbnail is never a source — but it does say where the file is", () => {
  const [e] = U.uploadsOf(conv([yours({ files_v2: [IMAGE] })]));
  const urls = e.urls.map((s) => s.url);
  assert.ok(!urls.some((u) => /thumbnail/.test(u)), "a thumbnail was offered as the file: " + urls);
  assert.equal(urls[0], "/api/org1/files/aaaa1111/preview", "the full-size asset should lead");
  assert.ok(urls.includes("/api/org1/files/aaaa1111/document"), "the sibling document was missed");
});

test("a thumbnail alone still yields the siblings beside it", () => {
  // The shape that would otherwise be unrecoverable: claude.ai named only the
  // small copy, and the full one is a path segment away.
  const [e] = U.uploadsOf(
    conv([yours({ files_v2: [{ file_name: "x.png", thumbnail_url: "/api/o/files/u7/thumbnail" }] })])
  );
  assert.deepEqual(e.urls.map((s) => s.url), [
    "/api/o/files/u7/document",
    "/api/o/files/u7/original",
    "/api/o/files/u7/preview",
  ]);
  assert.equal(U.recovery(e), "file");
});

test("the document asset leads the preview, which leads the loose keys", () => {
  const [e] = U.uploadsOf(
    conv([
      yours({
        files_v2: [
          {
            file_name: "brief.pdf",
            preview_url: "/api/o/files/u1/preview",
            document_asset: { url: "/api/o/files/u1/document" },
            download_url: "/api/o/files/u1/download",
          },
        ],
      }),
    ])
  );
  const urls = e.urls.map((s) => s.url);
  assert.equal(urls[0], "/api/o/files/u1/document");
  assert.equal(urls[1], "/api/o/files/u1/preview");
  assert.ok(urls.indexOf("/api/o/files/u1/download") > 1);
  // Every candidate says where it came from, because a failure prints them.
  assert.ok(e.urls.every((s) => s.why));
});

test("a URL that is not claude.ai's is dropped, cookies being what they are", () => {
  const [e] = U.uploadsOf(
    conv([
      yours({
        files_v2: [
          {
            file_name: "x.png",
            preview_url: "https://evil.example/api/org/files/u1/preview",
            url: "//evil.example/files/u1/document",
            document_asset: { url: "https://claude.ai/api/org/files/u1/document" },
          },
        ],
      }),
    ])
  );
  const urls = e.urls.map((s) => s.url);
  assert.ok(!urls.some((u) => /evil/.test(u)), "somewhere else was offered our cookies: " + urls);
  assert.equal(urls[0], "https://claude.ai/api/org/files/u1/document");
  // ...and the siblings walked off it stay on claude.ai too.
  assert.ok(urls.every((u) => u.indexOf("https://claude.ai/") === 0));
  assert.equal(U.safeUrl("https://notclaude.ai/x"), "");
  assert.equal(U.safeUrl("https://claude.ai.evil.com/x"), "");
  assert.equal(U.safeUrl("https://cdn.claude.ai/x"), "https://cdn.claude.ai/x");
  assert.equal(U.safeUrl("/api/x"), "/api/x");
});

test("a query string survives the sibling walk", () => {
  assert.deepEqual(U.siblingUrls("/api/o/files/u1/preview?v=2"), [
    "/api/o/files/u1/document?v=2",
    "/api/o/files/u1/original?v=2",
  ]);
  assert.deepEqual(U.siblingUrls("/api/o/conversations/u1/preview"), []);
});

// ---- the text, and what it honestly is -------------------------------------

test("a text file's extraction IS the file; a PDF's is not", () => {
  const list = U.uploadsOf(
    conv([
      yours({
        attachments: [
          PDF,
          { file_name: "notes.txt", file_size: 12, extracted_content: "hello" },
          { file_name: "sheet.csv", file_size: 12, extracted_content: "a,b" },
        ],
      }),
    ])
  );
  const how = {};
  for (const e of list) how[e.name] = U.recovery(e);
  assert.deepEqual(how, { "brief.pdf": "extract", "notes.txt": "text", "sheet.csv": "text" });
});

test("an extract never lands under the original document's name", () => {
  const plan = U.planDownloads(
    U.uploadsOf(conv([yours({ attachments: [PDF, { file_name: "notes.txt", extracted_content: "hi" }] })]))
  );
  const named = {};
  for (const row of plan) named[row.entry.name] = row.saveAs;
  // The words out of a PDF are not a PDF, and must not claim to be one.
  assert.equal(named["brief.pdf"], "brief.pdf.txt");
  assert.equal(named["notes.txt"], "notes.txt");
  assert.match(
    plan.find((r) => r.how === "extract").note,
    /TEXT claude\.ai read out of it/
  );
});

test("a file with nothing behind it is still listed, and says so", () => {
  const [e] = U.uploadsOf(conv([yours({ attachments: [{ file_name: "gone.pdf" }] })]));
  assert.equal(U.recovery(e), "none");
  const [row] = U.planDownloads([e]);
  assert.equal(row.saveAs, "", "a file with no source must not be offered a filename");
  assert.match(row.note, /a name and nothing else/);
  assert.match(U.describe([e]), /not at all/);
});

// ---- one file, listed twice -------------------------------------------------

test("the same upload on two turns is one file", () => {
  const list = U.uploadsOf(conv([yours({ files_v2: [IMAGE] }), yours({ files_v2: [IMAGE] })]));
  assert.equal(list.length, 1);
});

test("two sightings of one file contribute what the other lacked", () => {
  const bare = { file_name: "brief.pdf", file_uuid: "u5" };
  const withText = { file_uuid: "u5", file_size: 900, extracted_content: "words" };
  const [e] = U.uploadsOf(conv([yours({ attachments: [bare, withText] })]));
  assert.equal(e.name, "brief.pdf");
  assert.equal(e.size, 900);
  assert.equal(e.text, "words");
});

test("two different files of the same name both come back, distinguishably", () => {
  const plan = U.planDownloads(
    U.uploadsOf(
      conv([
        yours({ files_v2: [{ file_name: "brief.pdf", file_uuid: "u1", preview_url: "/api/o/files/u1/preview" }] }),
        yours({ files_v2: [{ file_name: "brief.pdf", file_uuid: "u2", preview_url: "/api/o/files/u2/preview" }] }),
      ])
    )
  );
  assert.deepEqual(plan.map((r) => r.saveAs), ["brief.pdf", "brief (2).pdf"]);
});

// ---- names ------------------------------------------------------------------

test("a filename is never a path, a dotfile, or a control character", () => {
  assert.equal(U.safeName("../../etc/passwd"), "-..-etc-passwd");
  assert.equal(U.safeName(".hidden.pdf"), "hidden.pdf");
  assert.equal(U.safeName("a\u0000b\u001fc.txt"), "abc.txt");
  assert.equal(U.safeName("   "), "file");
  assert.equal(U.safeName(null), "file");
  const long = U.safeName("x".repeat(400) + ".pdf");
  assert.ok(long.length <= U.MAX_NAME);
  assert.ok(long.endsWith(".pdf"), "the extension is what tells you what it is: " + long);
});

test("uniqueName counts up rather than overwriting", () => {
  assert.equal(U.uniqueName("a.pdf", []), "a.pdf");
  assert.equal(U.uniqueName("a.pdf", ["a.pdf"]), "a (2).pdf");
  assert.equal(U.uniqueName("a.pdf", ["a.pdf", "a (2).pdf"]), "a (3).pdf");
  assert.equal(U.uniqueName("a.pdf", ["A.PDF"]), "a (2).pdf", "case is not a difference on disk");
  assert.equal(U.uniqueName("README", ["README"]), "README (2)");
});

// ---- what came back ----------------------------------------------------------

test("claude.ai's own page is not a file, however cheerful the status", () => {
  assert.equal(U.looksLikeFile({ ok: true, bytes: 4200, type: "text/html; charset=utf-8" }), false);
  assert.equal(U.looksLikeFile({ ok: true, bytes: 0, type: "application/pdf" }), false);
  assert.equal(U.looksLikeFile({ ok: false, bytes: 900, type: "application/pdf" }), false);
  assert.equal(U.looksLikeFile({ ok: true, bytes: U.MAX_BYTES + 1, type: "application/pdf" }), false);
  assert.equal(U.looksLikeFile({ ok: true, bytes: 900, type: "application/pdf" }), true);
  assert.equal(U.looksLikeFile(null), false);
});

test("a failure says what was tried, not just that it failed", () => {
  const said = U.describeFailure("brief.pdf", [
    { url: "/api/org1/files/u1/document", what: "HTTP 404" },
    { url: "/api/org1/files/u1/preview?v=2", what: "HTTP 403" },
  ]);
  assert.match(said, /brief\.pdf/);
  assert.match(said, /u1\/document → HTTP 404/);
  assert.match(said, /u1\/preview → HTTP 403/);
  assert.match(U.describeFailure("x.pdf", []), /named nowhere to fetch it from/);
});

test("the sentence over the list counts every kind", () => {
  const list = U.uploadsOf(
    conv([
      yours({
        files_v2: [IMAGE],
        attachments: [PDF, { file_name: "notes.txt", extracted_content: "hi" }, { file_name: "gone.pdf" }],
      }),
    ])
  );
  const said = U.describe(list);
  assert.match(said, /^4 files you uploaded/);
  assert.match(said, /2 can be downloaded as uploaded/);
  assert.match(said, /1 only as the text/);
  assert.match(said, /1 not at all/);
  assert.match(U.describe([list[0]]), /^1 file you uploaded/);
});

test("sizes read as sizes", () => {
  assert.equal(U.sizeLabel(1), "1 byte");
  assert.equal(U.sizeLabel(900), "900 bytes");
  assert.equal(U.sizeLabel(2048), "2.0 KB");
  assert.equal(U.sizeLabel(120345), "118 KB");
  assert.equal(U.sizeLabel(5 * 1024 * 1024), "5.0 MB");
  assert.equal(U.sizeLabel(null), "");
  assert.equal(U.sizeLabel("nonsense"), "");
});
