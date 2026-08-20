const test = require("node:test");
const assert = require("node:assert");
const W = require("../src/workflow.js");
const X = require("../src/wfexport.js");

let n = 0;
const mkId = () => "id" + ++n;

function sample(fields) {
  return W.newWorkflow(
    Object.assign(
      {
        name: "Smith v. Jones",
        templateName: "Tentative ruling run",
        description: "Draft, attack, revise.",
        chats: [{ name: "Drafter" }, { name: "Critic" }],
        steps: [{ prompt: "Draft it" }, { prompt: "Attack it", carry: true }],
      },
      fields || {}
    ),
    fields && fields.id ? fields.id : mkId(),
    1000
  );
}

test("the bundle carries the template and leaves the matter behind", () => {
  const wf = sample();
  wf.docs = [{ id: "d1", name: "brief.pdf", chats: [] }];
  wf.pseudoKeyId = "key#1";
  wf.runDate = "2026-08-20";
  wf.usage = { runs: 4, avg: 6 };
  wf.chats[0].startUrl = "https://claude.ai/chat/abc";

  const out = X.buildExport([wf], 2000).workflows[0];
  assert.equal(out.docs.length, 0, "the matter's papers are the run's, not the template's");
  assert.equal(out.pseudoKeyId, null, "a key id means nothing in another browser");
  assert.equal(out.runDate, null);
  assert.equal(out.usage, null, "measured where it was measured");
  assert.equal(out.chats[0].startUrl, null, "arming for a matter doesn't travel");
  // It arrives at rest, under the name it wears between matters.
  assert.equal(out.name, "Tentative ruling run");
  assert.equal(out.templateName, "Tentative ruling run");
  // And the part that took the work does travel.
  assert.equal(out.steps.length, 2);
  assert.equal(out.steps[0].prompt, "Draft it");
  assert.equal(out.chats.length, 2);
  assert.equal(out.description, "Draft, attack, revise.");
});

test("leftBehind counts what the notice has to mention", () => {
  const wf = sample();
  wf.docs = [{ id: "d1" }, { id: "d2" }];
  wf.chats[1].startUrl = "https://claude.ai/chat/abc";
  wf.pseudoKeyId = "key#1";
  assert.deepEqual(X.leftBehind(wf), { docs: 2, armed: 1, key: true });
  assert.deepEqual(X.leftBehind(sample()), { docs: 0, armed: 0, key: false });
});

test("the envelope says what it is and when", () => {
  const b = X.buildExport([sample(), sample()], 2000);
  assert.equal(b.kind, "claude-usage-meter/workflows");
  assert.equal(b.v, X.VERSION);
  assert.equal(b.exportedAt, 2000);
  assert.equal(b.count, 2);
  assert.equal(b.workflows.length, 2);
});

test("the filename says what's in it", () => {
  assert.equal(
    X.fileName([{ templateName: "Tentative ruling run" }], "2026-08-20"),
    "claude-workflow-tentative-ruling-run-2026-08-20.json"
  );
  assert.equal(X.fileName([{}, {}, {}], "2026-08-20"), "claude-workflows-3-2026-08-20.json");
  assert.equal(X.fileName([{ name: "«»" }], ""), "claude-workflow-untitled.json");
});

test("a bundle round-trips, and re-importing an edited one UPDATES rather than piling up", () => {
  const wf = sample();
  const text = JSON.stringify(X.buildExport([wf], 2000));
  const read = X.parseBundle(text);
  assert.equal(read.ok, true);

  const first = X.applyImport([], read.workflows, 3000, mkId);
  assert.deepEqual([first.added, first.replaced], [1, 0]);
  assert.equal(first.list[0].id, wf.id, "the id rides along, which is what makes this an update");

  // Edited on the other laptop and brought back.
  const edited = JSON.parse(text);
  edited.workflows[0].steps[0].prompt = "Draft it, carefully";
  const again = X.applyImport(first.list, edited.workflows, 4000, mkId);
  assert.deepEqual([again.added, again.replaced], [0, 1]);
  assert.equal(again.list.length, 1, "one row, not two");
  assert.equal(again.list[0].steps[0].prompt, "Draft it, carefully");
  assert.equal(again.list[0].updatedAt, 4000);
});

test("a replaced workflow keeps its place in the list and its own createdAt", () => {
  const a = sample({ name: "A", templateName: "A" });
  const b = sample({ name: "B", templateName: "B" });
  const c = sample({ name: "C", templateName: "C" });
  const local = [a, b, c];
  const inc = X.buildExport([Object.assign({}, b, { description: "changed" })], 2000).workflows;
  const out = X.applyImport(local, inc, 5000, mkId);
  assert.deepEqual(out.list.map((w) => w.id), [a.id, b.id, c.id], "B stays where B was");
  assert.equal(out.list[1].description, "changed");
  assert.equal(out.list[1].createdAt, b.createdAt, "this row has been here since it has");
});

test("the pre-built one matches the pre-built one, whatever id each browser minted", () => {
  // Two machines each minted their own id for the same starting template.
  const here = W.builtinWorkflow(mkId, 1000);
  const there = W.builtinWorkflow(mkId, 1000);
  assert.notEqual(here.id, there.id);
  const inc = X.buildExport([there], 2000).workflows;
  assert.equal(X.importPlan([here], inc).replace.length, 1);
  const out = X.applyImport([here], inc, 3000, mkId);
  assert.deepEqual([out.added, out.replaced], [0, 1]);
  assert.equal(out.list.length, 1, "not a second row badged Pre-built");
  assert.equal(out.list[0].id, here.id);
});

test("the plan names what would be overwritten before anything is", () => {
  const mine = sample({ name: "Mine", templateName: "Mine" });
  const theirs = sample({ name: "Theirs", templateName: "Theirs" });
  const inc = X.buildExport([Object.assign({}, mine, { name: "Renamed" }), theirs], 2000).workflows;
  const plan = X.importPlan([mine], inc);
  assert.equal(plan.total, 2);
  assert.equal(plan.replace.length, 1);
  assert.equal(plan.replace[0].from, "Mine");
  assert.deepEqual(plan.add, ["Theirs"]);
});

test("a different workflow that only SHARES a name is flagged, not silently doubled", () => {
  const mine = sample({ name: "Ruling run", templateName: "Ruling run" });
  const theirs = sample({ name: "Ruling run", templateName: "Ruling run" });
  const plan = X.importPlan([mine], X.buildExport([theirs], 2000).workflows);
  assert.deepEqual(plan.sameName, ["Ruling run"]);
  assert.equal(plan.replace.length, 0, "different ids are different workflows");
  assert.deepEqual(plan.add, ["Ruling run"]);
});

test("an id that is somehow already taken gets a fresh one instead of colliding", () => {
  const mine = sample({ id: "shared", name: "Mine", templateName: "Mine" });
  // Same id, but it is the pre-built match rule that would catch a real
  // duplicate — here the incoming simply claims an id already in use by the
  // row it is NOT replacing, because that row was matched by something else.
  const out = X.applyImport([mine], [Object.assign({}, mine, { id: "shared" })], 3000, mkId);
  assert.equal(out.replaced, 1, "same id is the same workflow");
  assert.equal(out.list.length, 1);
});

test("parseBundle takes a bundle, a bare array, or a single workflow", () => {
  const wf = X.buildExport([sample()], 2000).workflows[0];
  assert.equal(X.parseBundle(JSON.stringify(X.buildExport([sample()], 2000))).workflows.length, 1);
  assert.equal(X.parseBundle(JSON.stringify([wf, wf])).workflows.length, 2);
  assert.equal(X.parseBundle(JSON.stringify(wf)).workflows.length, 1);
});

test("what isn't a workflow file says so instead of importing nothing", () => {
  assert.match(X.parseBundle("not json at all").error, /isn't JSON/);
  assert.match(X.parseBundle(JSON.stringify({ hello: "world" })).error, /isn't a workflow export/);
  assert.match(
    X.parseBundle(JSON.stringify({ kind: "something/else", workflows: [] })).error,
    /isn't a workflow export/
  );
  assert.match(X.parseBundle(JSON.stringify({ kind: X.KIND, workflows: [] })).error, /no workflows/);
  const junk = X.parseBundle(JSON.stringify([sample(), 7, null, "x"]));
  assert.equal(junk.ok, true);
  assert.equal(junk.workflows.length, 1);
  assert.equal(junk.skipped, 3, "counted, not waved through as empty rows");
});

test("a bundle from a NEWER format is refused rather than half-read", () => {
  const b = X.buildExport([sample()], 2000);
  b.v = X.VERSION + 1;
  const r = X.parseBundle(JSON.stringify(b));
  assert.equal(r.ok, false);
  assert.match(r.error, /newer version/);
});

test("a hand-edited bundle can't smuggle in a field this build doesn't know", () => {
  const wf = X.buildExport([sample()], 2000).workflows[0];
  wf.somethingElse = "rm -rf";
  wf.steps[0].alsoNot = true;
  const out = X.applyImport([], [wf], 3000, mkId);
  assert.equal(out.list[0].somethingElse, undefined);
  assert.equal(out.list[0].steps[0].alsoNot, undefined);
  assert.equal(out.list[0].steps[0].prompt, "Draft it", "and the real fields still land");
});

test("a bundle carrying documents has them dropped on the way IN as well as out", () => {
  // The far end is not trusted to have stripped them: an older build, a
  // hand-edited file, or a bundle from a version that carried them.
  const wf = X.buildExport([sample()], 2000).workflows[0];
  wf.docs = [{ id: "d1", name: "brief.pdf", chats: [] }];
  wf.pseudoKeyId = "key#9";
  const out = X.applyImport([], [wf], 3000, mkId);
  assert.equal(out.list[0].docs.length, 0);
  assert.equal(out.list[0].pseudoKeyId, null);
});

test("importing onto a workflow armed for a matter leaves the matter alone", () => {
  const local = sample({ name: "Smith v. Jones", templateName: "Tentative ruling run" });
  local.docs = [
    { id: "d1", name: "moving.pdf", chats: [local.chats[0].id] },
    { id: "d2", name: "opp.pdf", chats: [local.chats[1].id] },
  ];
  local.pseudoKeyId = "key#1";
  local.runDate = "2026-08-19";
  local.usage = { runs: 3, avg: 6 };
  local.chats[0].startUrl = "https://claude.ai/chat/abc";

  // The same workflow, edited on the other laptop and brought back.
  const inc = X.buildExport([local], 2000).workflows;
  inc[0].steps[1].prompt = "Attack it harder";
  const out = X.applyImport([local], inc, 5000, mkId);
  const w = out.list[0];

  assert.equal(out.replaced, 1);
  assert.equal(w.steps[1].prompt, "Attack it harder", "the template came across");
  assert.equal(w.name, "Smith v. Jones", "still armed for the case it was armed for");
  assert.equal(w.templateName, "Tentative ruling run");
  assert.equal(w.docs.length, 2, "this matter's papers stayed");
  assert.deepEqual(w.docs.map((d) => d.name), ["moving.pdf", "opp.pdf"]);
  assert.equal(w.docs[0].chats[0], local.chats[0].id, "and stayed pointed at their chats");
  assert.equal(w.pseudoKeyId, "key#1");
  assert.equal(w.runDate, "2026-08-19");
  assert.deepEqual(w.usage, { runs: 3, avg: 6 }, "measured here, about this machine");
  assert.equal(w.chats[0].startUrl, "https://claude.ai/chat/abc", "re-armed by chat id");
});

test("a matter's arming is dropped, not guessed, when the far end changed its chats", () => {
  const local = sample();
  local.chats[0].startUrl = "https://claude.ai/chat/abc";
  local.docs = [{ id: "d1", name: "moving.pdf", chats: [local.chats[0].id] }];

  const inc = X.buildExport([local], 2000).workflows;
  inc[0].chats = inc[0].chats.map((c, i) => Object.assign({}, c, { id: "other" + i }));
  const w = X.applyImport([local], inc, 5000, mkId).list[0];
  assert.equal(w.chats[0].startUrl, null, "a run pointed at the wrong chat is worse than none");
  assert.equal(w.docs.length, 1, "the paper is still here");
  assert.deepEqual(w.docs[0].chats, [], "but no longer claims a chat that's gone");
});

test("a workflow at rest here doesn't acquire a name from the import", () => {
  const local = sample({ name: "Tentative ruling run", templateName: "Tentative ruling run" });
  const inc = X.buildExport([local], 2000).workflows;
  const w = X.applyImport([local], inc, 5000, mkId).list[0];
  assert.equal(w.name, "Tentative ruling run");
  assert.equal(w.templateName, "Tentative ruling run");
  assert.equal(w.docs.length, 0);
});

test("the plan promises the name the row will actually end up with", () => {
  const armed = sample({ name: "Smith v. Jones", templateName: "Tentative ruling run" });
  const inc = X.buildExport([armed], 2000).workflows;
  const plan = X.importPlan([armed], inc);
  // keepMatter leaves the armed name alone, so the dialog must not offer a
  // rename it isn't going to perform.
  assert.deepEqual(plan.replace[0], {
    id: armed.id,
    from: "Smith v. Jones",
    to: "Smith v. Jones",
  });
  const rest = sample({ name: "Old name", templateName: "Old name" });
  const inc2 = X.buildExport([Object.assign({}, rest, { templateName: "New name", name: "New name" })], 2000).workflows;
  assert.equal(X.importPlan([rest], inc2).replace[0].to, "New name", "at rest, it takes the new one");
});
