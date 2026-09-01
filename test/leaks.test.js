/**
 * A folder marked LEAKS never uploads.
 * Run with: node --test test/leaks.test.js
 *
 * The bar is only worth anything if it holds in the shapes a real pick arrives
 * in: a marker four levels down, a marker in one of two dropped folders, a
 * marker that picked up "(1)" on its way through a copy, and the case folder
 * whose Text Files would otherwise be exactly what goes up.
 */
const test = require("node:test");
const assert = require("node:assert");
const L = require("../src/leaks.js");

const at = (path) => ({ path: path, file: { name: path.split("/").pop() } });

// ---- what counts as the marker -------------------------------------------

test("a spreadsheet called LEAKS is the marker, in any case and any spreadsheet format", () => {
  for (const n of ["LEAKS.xlsx", "leaks.xlsx", "Leaks.xlsm", "LEAKS.csv", "LEAKS.ods", "LEAKS.numbers"])
    assert.ok(L.isMarker(n), n + " should mark a folder");
});

test("a copy of the marker still marks the folder", () => {
  // Chrome, Windows and macOS each append their own suffix to a duplicate. A
  // marker that stopped marking because the folder was copied would be a bar
  // that failed silently, which is the one failure this cannot have.
  for (const n of ["LEAKS (1).xlsx", "LEAKS copy.xlsx", "LEAKS - Copy.xlsx", "LEAKS copy 2.xlsx", "LEAKS 2024.xlsx"])
    assert.ok(L.isMarker(n), n + " should still mark a folder");
});

test("a file that is not a spreadsheet, or not called LEAKS, marks nothing", () => {
  for (const n of ["LEAKS.txt", "LEAKS.pdf", "LEAKS.docx", "leaky.xlsx", "leaks-analysis.xlsx", "pseudonym_key.xlsx", "notes.xlsx", ""])
    assert.ok(!L.isMarker(n), n + " should not mark a folder");
});

// ---- how far the bar reaches ---------------------------------------------

test("a marker at the top of a folder bars everything under it", () => {
  const res = L.gate([
    at("Smith v. Jones/LEAKS.xlsx"),
    at("Smith v. Jones/Text Files/moving.txt"),
    at("Smith v. Jones/Text Files/opposition.txt"),
    at("Smith v. Jones/exhibits/exhibit-1.pdf"),
  ]);
  assert.equal(res.hit, true);
  assert.deepEqual(res.folders, ["Smith v. Jones"]);
  assert.equal(res.files.length, 0, "nothing from a marked folder may go up");
  assert.equal(res.held.length, 4, "the marker itself is held with the rest");
});

test("a marker buried deep bars the whole picked folder, not just its own subfolder", () => {
  // The operator marking a matter's discovery folder is marking the matter.
  const res = L.gate([
    at("Smith/Text Files/moving.txt"),
    at("Smith/discovery/2024/responses/LEAKS.xlsx"),
    at("Smith/exhibits/a.pdf"),
  ]);
  assert.equal(res.hit, true);
  assert.deepEqual(res.folders, ["Smith"]);
  assert.equal(res.files.length, 0);
});

test("one marked folder in a drop does not bar the other", () => {
  const res = L.gate([
    at("Smith/LEAKS.xlsx"),
    at("Smith/Text Files/moving.txt"),
    at("Jones/Text Files/moving.txt"),
    at("Jones/Text Files/reply.txt"),
  ]);
  assert.equal(res.hit, true);
  assert.deepEqual(res.folders, ["Smith"]);
  assert.deepEqual(res.files.map((f) => f.path), [
    "Jones/Text Files/moving.txt",
    "Jones/Text Files/reply.txt",
  ]);
  assert.deepEqual(res.held.map((f) => f.path), ["Smith/LEAKS.xlsx", "Smith/Text Files/moving.txt"]);
});

test("a marker dropped loose bars the loose files it came with, and no folder", () => {
  const res = L.gate([at("LEAKS.xlsx"), at("moving.txt"), at("Jones/Text Files/reply.txt")]);
  assert.equal(res.hit, true);
  assert.deepEqual(res.folders, [""]);
  assert.deepEqual(res.files.map((f) => f.path), ["Jones/Text Files/reply.txt"]);
});

test("an unmarked pick passes through untouched", () => {
  const files = [at("Smith/Text Files/moving.txt"), at("Smith/pseudonym_key.xlsx")];
  const res = L.gate(files);
  assert.equal(res.hit, false);
  assert.equal(res.held.length, 0);
  assert.deepEqual(res.files, files);
  assert.equal(L.describe(res), "", "an unmarked pick has nothing to say");
});

test("nothing picked is not a bar", () => {
  const res = L.gate([]);
  assert.equal(res.hit, false);
  assert.equal(L.gate(null).hit, false);
  assert.equal(res.files.length, 0);
});

// ---- the shapes a pick actually arrives in --------------------------------

test("plain Files are read the same way — a picked folder carries its path on each file", () => {
  // What <input webkitdirectory> hands back, and what reaches a form's
  // addFiles after a walk has thrown the paths away.
  const picked = [
    { name: "moving.txt", webkitRelativePath: "Smith/Text Files/moving.txt" },
    { name: "LEAKS.xlsx", webkitRelativePath: "Smith/LEAKS.xlsx" },
  ];
  const res = L.gate(picked);
  assert.equal(res.hit, true);
  assert.equal(res.files.length, 0);
  // And with no path at all, a marker still bars the files beside it.
  const loose = L.gate([{ name: "LEAKS.xlsx" }, { name: "moving.txt" }]);
  assert.equal(loose.hit, true);
  assert.equal(loose.files.length, 0);
});

// ---- what it says ---------------------------------------------------------

test("the refusal names the folder, the file that marked it, and what was held", () => {
  const res = L.gate([at("Smith/LEAKS (1).xlsx"), at("Smith/Text Files/moving.txt")]);
  const said = L.describe(res);
  assert.match(said, /Smith/);
  assert.match(said, /LEAKS \(1\)\.xlsx/);
  assert.match(said, /2 files were held back/);
  assert.ok(!/\//.test(said.split("Smith")[0]), "the marker is named, not pathed at");
});

test("a loose marker is described as the files picked loose rather than as an empty name", () => {
  const said = L.describe(L.gate([at("LEAKS.xlsx"), at("moving.txt")]));
  assert.match(said, /picked loose/);
  assert.ok(!/from :/.test(said), "an empty folder name never reaches the sentence");
});

test("two marked folders are both named", () => {
  const said = L.describe(L.gate([at("Smith/LEAKS.xlsx"), at("Jones/LEAKS.csv")]));
  assert.match(said, /Smith and Jones/);
});
