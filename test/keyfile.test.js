const test = require("node:test");
const assert = require("node:assert");
const K = require("../src/keyfile.js");

const bytes = (...n) => Uint8Array.from(n);

test("bytes survive the round trip, at every remainder", () => {
  // The three lengths mod 3 take different paths through the padding.
  for (const n of [0, 1, 2, 3, 4, 5, 255, 1024]) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 7 + 13) & 255);
    const back = K.base64ToBytes(K.bytesToBase64(b));
    assert.equal(back.length, n, "length at " + n);
    for (let i = 0; i < n; i++) assert.equal(back[i], b[i], "byte " + i + " at " + n);
  }
});

test("the base64 is the base64 everything else writes", () => {
  // "PK" — the first four bytes of every xlsx, which is what makes
  // this worth checking against a known answer rather than only against itself.
  assert.equal(K.bytesToBase64(bytes(0x50, 0x4b, 0x03, 0x04)), "UEsDBA==");
  assert.equal(K.bytesToBase64(bytes(77)), "TQ==");
  assert.equal(K.bytesToBase64(bytes(77, 97)), "TWE=");
  assert.equal(K.bytesToBase64(bytes(77, 97, 110)), "TWFu");
});

test("rubbish in the store decodes to nothing rather than throwing", () => {
  assert.equal(K.base64ToBytes("").length, 0);
  assert.equal(K.base64ToBytes(null).length, 0);
  assert.equal(K.base64ToBytes("!!!").length, 0);
});

test("a file is kept, or the reason it isn't is said out loud", () => {
  const r = K.fileRecord(bytes(1, 2, 3), "pseudonym_key.xlsx", 500);
  assert.equal(r.ok, true);
  assert.equal(r.record.name, "pseudonym_key.xlsx");
  assert.equal(r.record.size, 3);
  assert.equal(r.record.at, 500);
  // Empty is not a file.
  assert.equal(K.fileRecord(new Uint8Array(0), "k.xlsx", 1).ok, false);
  assert.equal(K.fileRecord(null, "k.xlsx", 1).ok, false);
  assert.match(K.fileRecord(null, "k.xlsx", 1).why, /empty/);
  // Nor is something far too big to be one — and the refusal says the sizes.
  const huge = { length: K.MAX_BYTES + 1 };
  const no = K.fileRecord(huge, "k.xlsx", 1);
  assert.equal(no.ok, false);
  assert.match(no.why, /8\.0 MB/);
  // A file with no name still has the name the macro looks for.
  assert.equal(K.fileRecord(bytes(1), "", 1).record.name, "pseudonym_key.xlsx");
});

test("filing a key's workbook never disturbs another key's", () => {
  const a = K.fileRecord(bytes(1), "pseudonym_key.xlsx", 1).record;
  const b = K.fileRecord(bytes(2), "pseudonym_key.xlsx", 2).record;
  let files = K.putFile({}, "k1", a);
  files = K.putFile(files, "k2", b);
  assert.deepEqual(Object.keys(files).sort(), ["k1", "k2"]);
  assert.equal(K.fileFor(files, "k1").b64, a.b64);
  // The input is not mutated — the caller writes what comes back.
  const before = K.putFile({}, "k1", a);
  K.putFile(before, "k2", b);
  assert.deepEqual(Object.keys(before), ["k1"]);
  // Nothing to file is not an entry.
  assert.deepEqual(K.putFile({}, "k1", null), {});
  assert.deepEqual(K.putFile({}, "", a), {});
});

test("the store is bounded, and the file just loaded always survives the trim", () => {
  let files = {};
  for (let i = 0; i < 5; i++)
    files = K.putFile(files, "old" + i, K.fileRecord(bytes(i + 1), "k.xlsx", 100 + i).record, 3);
  assert.equal(Object.keys(files).length, 3);
  // The oldest fell off; the newest are here.
  assert.equal(K.fileFor(files, "old0"), null);
  assert.ok(K.fileFor(files, "old4"));
  // Even a file older than everything already stored survives its own write —
  // a key just loaded that fell off its own store is the failure nobody would
  // think to look for.
  files = K.putFile(files, "ancient", K.fileRecord(bytes(9), "k.xlsx", 1).record, 3);
  assert.ok(K.fileFor(files, "ancient"));
  assert.equal(Object.keys(files).length, 3);
});

test("forgetting a key forgets its workbook too", () => {
  let files = K.putFile({}, "k1", K.fileRecord(bytes(1), "k.xlsx", 1).record);
  files = K.putFile(files, "k2", K.fileRecord(bytes(2), "k.xlsx", 2).record);
  assert.deepEqual(Object.keys(K.dropFiles(files, ["k1"])), ["k2"]);
  assert.deepEqual(Object.keys(K.dropFiles(files, ["k1", "k2"])), []);
  assert.deepEqual(Object.keys(K.dropFiles(files, [])), ["k1", "k2"]);
  assert.deepEqual(K.dropFiles(null, ["k1"]), {});
});

test("sizes read like sizes", () => {
  assert.equal(K.sizeText(0), "0 B");
  assert.equal(K.sizeText(900), "900 B");
  assert.equal(K.sizeText(14 * 1024), "14 KB");
  assert.equal(K.sizeText(1258291), "1.2 MB");
});

test("the panel says what it has, and what it doesn't have and why", () => {
  const rec = K.fileRecord(bytes(1, 2, 3), "pseudonym_key.xlsx", 1).record;
  const said = K.describeFile(rec, "Smith v. Jones");
  assert.match(said, /Smith v\. Jones/);
  assert.match(said, /pseudonym_key\.xlsx/);
  assert.match(said, /3 B/);
  // Nothing stored is a sentence, not a blank: it says which key, that there
  // is nothing to hand back, and what to do about it.
  const none = K.describeFile(null, "Smith v. Jones");
  assert.match(none, /No workbook is kept for Smith v\. Jones/);
  assert.match(none, /loading once more/);
  assert.match(K.describeFile(null, ""), /for this key/);
});

test("the file is handed back under the name it arrived with", () => {
  // The reversing macro looks for pseudonym_key.xlsx, so this name is copied,
  // never composed.
  assert.equal(K.saveAsName({ name: "pseudonym_key.xlsx" }), "pseudonym_key.xlsx");
  assert.equal(K.saveAsName({ name: "  Smith key.xlsx " }), "Smith key.xlsx");
  assert.equal(K.saveAsName(null), "pseudonym_key.xlsx");
});

test("a key with no stored workbook cannot be downloaded, and says so", () => {
  const files = K.putFile({}, "k1", K.fileRecord(bytes(1), "k.xlsx", 1).record);
  assert.equal(K.canDownload(files, "k1"), true);
  assert.equal(K.canDownload(files, "k2"), false);
  assert.equal(K.canDownload(files, ""), false);
  assert.equal(K.canDownload(null, "k1"), false);
  // An entry that lost its bytes is not a file either.
  assert.equal(K.canDownload({ k1: { name: "k.xlsx" } }, "k1"), false);
});
