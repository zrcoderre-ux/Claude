const test = require("node:test");
const assert = require("node:assert");
const R = require("../src/pdfplusrun.js");

const NOW = new Date(2026, 10, 19, 10, 0).getTime();
const good = {
  version: 1, id: "abc", at: NOW - 60000, caseNumber: "25STCV12345", caseName: "ACME HOLDINGS, LP vs TAYLOR ROE",
  motion: "Demurrer", hearingDate: "2026-11-20", folderName: "25STCV12345 ACME", folderPath: "C:\\Users\\Clerk\\Downloads\\25STCV12345 ACME",
};

test("a request PDF+ wrote is taken, checked", () => {
  const r = R.checkRequest(good, NOW);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.request.hearingDate, "2026-11-20");
  assert.strictEqual(r.request.folderName, "25STCV12345 ACME");
});

test("none, a stale one, and a malformed one are not", () => {
  assert.deepStrictEqual(R.checkRequest(null, NOW).why, "none");
  assert.strictEqual(R.checkRequest(Object.assign({}, good, { at: NOW - R.MAX_AGE_MS - 1 }), NOW).why, "old");
  assert.strictEqual(R.checkRequest(Object.assign({}, good, { version: 2 }), NOW).why, "bad");
  assert.strictEqual(R.checkRequest(Object.assign({}, good, { folderPath: "" }), NOW).why, "bad");
  assert.strictEqual(R.checkRequest(Object.assign({}, good, { folderName: "a/b" }), NOW).why, "bad");
  assert.strictEqual(R.checkRequest(Object.assign({}, good, { hearingDate: "11/20/26" }), NOW).request.hearingDate, "");
});

test("only paths inside the named folder are taken", () => {
  assert.strictEqual(R.safeRel("25STCV12345 ACME/Text Files/a.txt", "25STCV12345 ACME"), true);
  assert.strictEqual(R.safeRel("25STCV12345 ACME/../secret.txt", "25STCV12345 ACME"), false);
  assert.strictEqual(R.safeRel("Other/Text Files/a.txt", "25STCV12345 ACME"), false);
  assert.strictEqual(R.safeRel("25STCV12345 ACME//a.txt", "25STCV12345 ACME"), false);
  assert.strictEqual(R.safeRel("25STCV12345 ACME\\a.txt", "25STCV12345 ACME"), false);
  assert.strictEqual(R.safeRel("25STCV12345 ACME", "25STCV12345 ACME"), false);
});

test("bytes are read only for what the case-folder door could take", () => {
  assert.strictEqual(R.needsBytes("25STCV12345 ACME/Text Files/Demurrer.txt"), true);
  assert.strictEqual(R.needsBytes("25STCV12345 ACME/Text Files/sub/Exhibit 1.txt"), true);
  assert.strictEqual(R.needsBytes("25STCV12345 ACME/text_files/Opp.txt"), true);
  assert.strictEqual(R.needsBytes("25STCV12345 ACME/pseudonym_key.xlsx"), true);
  assert.strictEqual(R.needsBytes("25STCV12345 ACME/LEAKS.xlsx"), true);
  assert.strictEqual(R.needsBytes("25STCV12345 ACME/Demurrer.pdf"), false);
  assert.strictEqual(R.needsBytes("25STCV12345 ACME/Exhibits/Exhibit A.pdf"), false);
  assert.strictEqual(R.needsBytes("25STCV12345 ACME/Text Files"), false);
});

test("a stand-in is spotted among files", () => {
  const real = { name: "a.txt" };
  const stand = { name: "b.pdf", __cumStandIn: true };
  assert.deepStrictEqual(R.standIns([real, stand, null]), [stand]);
  assert.deepStrictEqual(R.standIns([real]), []);
});

test("a file is read in chunks under the host's message cap", () => {
  assert.deepStrictEqual(R.chunkOffsets(0), [0]);
  assert.deepStrictEqual(R.chunkOffsets(10, 4), [0, 4, 8]);
  assert.ok(R.CHUNK * 4 / 3 < 1024 * 1024, "base64 of a chunk stays under 1 MB");
});

test("the banner says the case, its hearing and where the papers come from", () => {
  const t = R.bannerText(R.checkRequest(good, NOW).request);
  assert.match(t, /^From PDF\+: ACME HOLDINGS, LP vs TAYLOR ROE \(25STCV12345\), hearing Fri, Nov 20 · Demurrer\./);
  assert.match(t, /same checks as Choose folder/);
  assert.match(R.failText("nocase", good), /carries no case number/);
  assert.match(R.failText("standin", good), /never allows/);
});

// The owner (November 2026): "change the claude run button to a drop down menu
// that lets me select the workflow to run".
test("a workflow chosen in PDF+ comes with the request; a malformed id does not", () => {
  const r = R.checkRequest(Object.assign({}, good, { workflowId: "wf_123-abc", workflowName: "  Tentative   ruling " }), NOW);
  assert.strictEqual(r.request.workflowId, "wf_123-abc");
  assert.strictEqual(r.request.workflowName, "Tentative ruling");
  assert.strictEqual(R.checkRequest(Object.assign({}, good, { workflowId: "a b/c" }), NOW).request.workflowId, "");
  assert.strictEqual(R.checkRequest(good, NOW).request.workflowId, "");
});

test("the banner says the run is being set up, and a missing workflow says so", () => {
  const req = R.checkRequest(Object.assign({}, good, { workflowId: "w1", workflowName: "Tentative ruling" }), NOW).request;
  assert.match(R.bannerText(req), /Setting up a run of Tentative ruling/);
  assert.match(R.bannerText(R.checkRequest(good, NOW).request), /Press Create run/);
  assert.match(R.failText("noworkflow", req), /Tentative ruling\) is not here any more/);
});

// The owner (November 2026): "PDF+'s papers could not be brought over: the
// native host did not answer … (no such request)" — the request had been taken
// by another Options page; that is said as what it is.
test("a request another Options page took is said so, not blamed on the host", () => {
  const req = R.checkRequest(good, NOW).request;
  assert.match(R.failText("taken", req), /another Options tab took it/);
  assert.doesNotMatch(R.failText("taken", req), /native host/);
});

test("the case's eCourt page rides the request, and only an eCourt link", () => {
  const url = "https://civil.lacourt.org/ecourt/ecms/case?id=111";
  assert.strictEqual(R.checkRequest(Object.assign({}, good, { ecourtUrl: url }), NOW).request.ecourtUrl, url);
  assert.strictEqual(R.checkRequest(Object.assign({}, good, { ecourtUrl: "https://example.com/ecourt/x" }), NOW).request.ecourtUrl, "");
  assert.strictEqual(R.checkRequest(good, NOW).request.ecourtUrl, "");
});
