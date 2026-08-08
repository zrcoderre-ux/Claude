/**
 * Tests for src/workflow.js — the multi-chat workflow model (pure logic).
 * Run with: node --test test/workflow.test.js
 */
const assert = require("node:assert");
const { test } = require("node:test");
const W = require("../src/workflow.js");

const NOW = 1_800_000_000_000;

// Deterministic ids, so a plan can be asserted on.
function idgen(prefix) {
  let n = 0;
  return () => `${prefix || "id"}${++n}`;
}

function twoChatWorkflow() {
  const mk = idgen("x");
  return W.newWorkflow(
    {
      name: "Two chats",
      chats: [
        { id: "a", name: "Drafting" },
        { id: "b", name: "Critic" },
      ],
      docs: [{ id: "d1", name: "motion.pdf", size: 10, chats: ["a"] }],
      steps: [
        { id: "s1", chatId: "a", prompt: "draft it" },
        { id: "s2", chatId: "b", prompt: "attack it", carryLabel: "draft" },
        { id: "s3", chatId: "a", prompt: "revise it", carryLabel: "report" },
      ],
    },
    mk(),
    NOW
  );
}

test("newWorkflow normalizes the first step to carry nothing", () => {
  const wf = twoChatWorkflow();
  assert.equal(wf.steps[0].carry, false, "nothing exists to carry into step 1");
  assert.equal(wf.steps[1].carry, true);
  assert.equal(wf.createdAt, NOW);
});

test("a step pointing at a deleted chat falls back rather than losing its prompt", () => {
  const wf = twoChatWorkflow();
  const shrunk = W.setChatCount(wf, 1, idgen("n"));
  assert.equal(shrunk.chats.length, 1);
  assert.equal(shrunk.steps.length, 3, "steps survive");
  assert.ok(
    shrunk.steps.every((s) => s.chatId === "a"),
    "steps that referenced the removed chat move to the remaining one"
  );
});

test("setChatCount adds named slots and clamps to the maximum", () => {
  const wf = W.setChatCount(twoChatWorkflow(), 4, idgen("n"));
  assert.equal(wf.chats.length, 4);
  assert.equal(wf.chats[2].name, "Chat C");
  assert.equal(W.setChatCount(wf, 99, idgen("n")).chats.length, W.MAX_CHATS);
  assert.equal(W.setChatCount(wf, 0, idgen("n")).chats.length, 1);
});

test("shrinking drops document assignments for removed chats", () => {
  const wf = twoChatWorkflow();
  wf.docs[0].chats = ["a", "b"];
  const shrunk = W.setChatCount(W.normalize(wf), 1, idgen("n"));
  assert.deepEqual(shrunk.docs[0].chats, ["a"]);
});

test("planRun attaches a chat's documents to its first step only", () => {
  const plan = W.planRun(twoChatWorkflow());
  assert.deepEqual(plan.map((p) => p.chatName), ["Drafting", "Critic", "Drafting"]);
  assert.deepEqual(plan[0].docIds, ["d1"]);
  assert.equal(plan[0].firstInChat, true);
  assert.deepEqual(plan[1].docIds, [], "chat B has no documents assigned");
  assert.deepEqual(plan[2].docIds, [], "chat A's second step is already in the conversation");
  assert.equal(plan[2].firstInChat, false);
});

test("composeStepText pastes the previous reply between explicit markers", () => {
  const plan = W.planRun(twoChatWorkflow());
  const text = W.composeStepText(plan[1], "  THE DRAFT  ");
  assert.match(text, /^attack it\n\n----- BEGIN DRAFT -----\nTHE DRAFT\n----- END DRAFT -----$/);
});

test("composeStepText leaves a non-carrying step (and an empty reply) alone", () => {
  const plan = W.planRun(twoChatWorkflow());
  assert.equal(W.composeStepText(plan[0], "ignored"), "draft it");
  assert.equal(W.composeStepText(plan[1], "   "), "attack it");
});

test("only actual text is folded into a combined upload", () => {
  assert.ok(W.isTextDoc({ name: "Motion.txt", type: "text/plain" }));
  assert.ok(W.isTextDoc({ name: "notes.md", type: "" }), "untyped, but named like text");
  assert.ok(W.isTextDoc({ name: "data.csv", type: "application/csv" }));
  // A PDF or a Word file has to go up on its own — folding it in would deliver
  // mojibake instead of a brief.
  assert.equal(W.isTextDoc({ name: "Motion.pdf", type: "application/pdf" }), false);
  assert.equal(W.isTextDoc({ name: "Decl.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), false);
  assert.equal(W.isTextDoc({ name: "scan.png", type: "image/png" }), false);
  assert.equal(W.isTextDoc({ name: "mystery", type: "" }), false);
});

test("bundleText announces what's inside and marks where each document begins", () => {
  const out = W.bundleText([
    { name: "Motion.txt", text: "  THE MOTION  " },
    { name: "Complaint.txt", text: "THE COMPLAINT" },
  ]);
  assert.match(out, /^This file contains 2 documents/);
  assert.match(out, /They are, in order: Motion\.txt, Complaint\.txt\./);
  assert.match(out, /===== BEGIN FILE: Motion\.txt =====\n\nTHE MOTION\n\n===== END FILE: Motion\.txt =====/);
  assert.match(out, /===== BEGIN FILE: Complaint\.txt =====/);
  // An empty document contributes nothing but doesn't break the count.
  const one = W.bundleText([{ name: "a.txt", text: "A" }, { name: "b.txt", text: "   " }]);
  assert.match(one, /^This file contains 1 document/);
  assert.equal(W.bundleText([]), "");
  assert.equal(W.bundleText(null), "");
});

// A workflow whose papers are a mixed bag, ticked for both chats.
function bundleWorkflow(extra) {
  return W.newWorkflow(
    Object.assign(
      {
        name: "b",
        bundleText: true,
        chats: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
        docs: [
          { id: "t1", name: "motion.md", type: "text/markdown", chats: ["a", "b"] },
          { id: "t2", name: "opp.md", type: "text/markdown", chats: ["a", "b"] },
          { id: "p1", name: "exhibits.pdf", type: "application/pdf", chats: ["a"] },
          { id: "t3", name: "reply.md", type: "text/markdown", chats: ["b"] },
        ],
        steps: [
          { id: "s1", chatId: "a", prompt: "draft" },
          { id: "s2", chatId: "b", prompt: "attack", carry: true },
        ],
      },
      extra || {}
    ),
    "w1",
    NOW
  );
}

test("bundlePlan groups by the message that will carry the file", () => {
  const wf = bundleWorkflow();
  const groups = W.bundlePlan(wf);
  assert.equal(groups.length, 2, "the two chats' papers differ, so they need different files");

  const a = groups.find((g) => g.chatIds.indexOf("a") !== -1);
  assert.deepEqual(a.docIds, ["t1", "t2"], "the PDF is not foldable and stays out");
  assert.deepEqual(a.chatIds, ["a"]);
  assert.equal(a.addedAt, null, "rides the chat's opening message");

  const b = groups.find((g) => g.chatIds.indexOf("b") !== -1);
  assert.deepEqual(b.docIds, ["t1", "t2", "t3"], "a document ticked for both is in both files");

  // Off by default, and never for a lone document.
  assert.deepEqual(W.bundlePlan(bundleWorkflow({ bundleText: false })), []);
  assert.deepEqual(
    W.bundlePlan(
      W.newWorkflow(
        {
          name: "one",
          bundleText: true,
          chats: [{ id: "a", name: "A" }],
          docs: [{ id: "t1", name: "a.md", type: "text/markdown", chats: ["a"] }],
          steps: [{ chatId: "a", prompt: "go" }],
        },
        "w2",
        NOW
      )
    ),
    []
  );
});

test("chats getting the same papers share one combined file", () => {
  // Documents default to every chat, so this is the ordinary case. Six chats
  // must not mean six byte-identical files built and stored.
  const wf = W.newWorkflow(
    {
      name: "same",
      bundleText: true,
      chats: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }],
      docs: [
        { id: "t1", name: "motion.md", type: "text/markdown", chats: ["a", "b", "c"] },
        { id: "t2", name: "opp.md", type: "text/markdown", chats: ["a", "b", "c"] },
      ],
      steps: [
        { chatId: "a", prompt: "1" },
        { chatId: "b", prompt: "2" },
        { chatId: "c", prompt: "3" },
      ],
    },
    "w1",
    NOW
  );
  const groups = W.bundlePlan(wf);
  assert.equal(groups.length, 1, "built once");
  assert.deepEqual(groups[0].chatIds, ["a", "b", "c"], "uploaded to each");

  // And the one file reaches all three, exactly as a document ticked for three
  // chats already does.
  const folded = W.foldBundle(wf.docs, groups[0], { id: "c1", name: "combined-documents.txt", type: "text/plain" });
  const plan = W.planRun(Object.assign({}, wf, { docs: folded }));
  assert.deepEqual(plan[0].docIds, ["c1"]);
  assert.deepEqual(plan[1].docIds, ["c1"]);
  assert.deepEqual(plan[2].docIds, ["c1"]);
  assert.deepEqual(W.bundlePlan(Object.assign({}, wf, { docs: folded })), [], "nothing left to fold");
});

test("documents added mid-run bundle with their own batch, not the opening one", () => {
  const wf = bundleWorkflow();
  const late = wf.docs.concat([
    { id: "L1", name: "supp1.md", type: "text/markdown", chats: ["a"], addedAt: 1 },
    { id: "L2", name: "supp2.md", type: "text/markdown", chats: ["a"], addedAt: 1 },
  ]);
  const groups = W.bundlePlan(Object.assign({}, wf, { docs: late.map((d) => W.newDoc(d, d.id)) }));
  const forA = groups.filter((g) => g.chatIds.indexOf("a") !== -1);
  assert.equal(forA.length, 2, "the opening upload and the later one are different messages");
  assert.deepEqual(forA.find((g) => g.addedAt === 1).docIds, ["L1", "L2"]);
  assert.deepEqual(forA.find((g) => g.addedAt === null).docIds, ["t1", "t2"]);
});

test("folding a group swaps its documents for the combined file, and is idempotent", () => {
  const wf = bundleWorkflow();
  const group = W.bundlePlan(wf).find((g) => g.chatIds.indexOf("a") !== -1);
  const folded = W.foldBundle(wf.docs, group, {
    id: "c1",
    name: "combined-documents.txt",
    type: "text/plain",
    size: 99,
  });

  const byId = Object.fromEntries(folded.map((d) => [d.id, d]));
  assert.deepEqual(byId.t1.chats, ["b"], "still going to the chat that has its own bundle");
  assert.deepEqual(byId.t2.chats, ["b"]);
  assert.deepEqual(byId.p1.chats, ["a"], "the PDF is untouched");
  assert.deepEqual(byId.c1.chats, ["a"]);
  assert.equal(byId.c1.bundled, 2, "so a run can say five papers went up as one file");

  // What chat A's opening message now uploads: the combined file and the PDF.
  const after = Object.assign({}, wf, { docs: folded });
  assert.deepEqual(W.planRun(after)[0].docIds.sort(), ["c1", "p1"]);

  // And running the plan again finds nothing left to fold for chat A.
  assert.deepEqual(
    W.bundlePlan(after).map((g) => g.chatIds),
    [["b"]]
  );
});

test("a mid-run bundle rides the step its documents were added for", () => {
  const wf = bundleWorkflow();
  const docs = wf.docs.concat(
    [
      { id: "L1", name: "supp1.md", type: "text/markdown", chats: ["b"], addedAt: 1 },
      { id: "L2", name: "supp2.md", type: "text/markdown", chats: ["b"], addedAt: 1 },
    ].map((d) => W.newDoc(d, d.id))
  );
  const src = Object.assign({}, wf, { docs: docs });
  const group = W.bundlePlan(src).find((g) => g.addedAt === 1);
  const folded = W.foldBundle(docs, group, { id: "c2", name: "combined-documents.txt", type: "text/plain" });
  const bundle = folded.find((d) => d.id === "c2");
  assert.equal(bundle.addedAt, 1, "so it goes up with step 2, not chat B's opening message");
  assert.ok(W.planRun(Object.assign({}, wf, { docs: folded }))[1].docIds.indexOf("c2") !== -1);
});

test("uploadSummary says, per chat, what will actually go up", () => {
  const wf = twoChatWorkflow();
  assert.equal(W.totalUploads(wf), 1);
  assert.equal(W.uploadSummary(wf), "uploads: Drafting 1 · Critic 0");
  // The failure this exists to make visible: prompts about "the attached
  // papers" with nothing attached anywhere.
  const bare = W.newWorkflow({ name: "x", chats: [{ id: "a", name: "A" }], steps: [{ chatId: "a", prompt: "read the attached" }] }, "w", NOW);
  assert.equal(W.totalUploads(bare), 0);
  assert.equal(W.uploadSummary(bare), "no documents will be uploaded");
  // Documents that exist but are ticked for nobody count as zero, not as one.
  const stray = W.normalize(Object.assign({}, bare, { docs: [W.newDoc({ name: "a.pdf", chats: [] }, "d")] }));
  assert.equal(W.totalUploads(stray), 0);

  // With combining on it says what claude.ai will actually receive — "5
  // documents" and "1 attachment" are both true, and only one is the point.
  assert.equal(
    W.uploadSummary(bundleWorkflow()),
    "uploads: A 3 · B 3 · 5 text documents combine into 2 files"
  );
});

test("a step's transcript entry records how many documents went up with it", () => {
  const { run } = startedRun();
  const r = W.applyStepResult(run, { stepIndex: 0, chatId: "a", reply: "DRAFT", now: NOW, total: 3, docs: 5 });
  assert.equal(r.transcript[0].docs, 5);
  const none = W.applyStepResult(run, { stepIndex: 0, chatId: "a", reply: "DRAFT", now: NOW, total: 3 });
  assert.equal(none.transcript[0].docs, 0, "zero is recorded, not omitted");
});

test("validate flags the things that make a run pointless", () => {
  assert.deepEqual(W.validate(W.newWorkflow({ name: "x", chats: [{ id: "a" }] }, "w", NOW)), [
    "Add at least one step.",
  ]);
  const wf = twoChatWorkflow();
  wf.docs.push({ id: "d2", name: "stray.pdf", chats: [] });
  assert.ok(W.validate(W.normalize(wf)).some((p) => /aren't assigned to a chat/.test(p)));
  assert.deepEqual(W.validate(twoChatWorkflow()), []);
});

test("cloneWorkflow re-ids chats and steps but keeps document bytes shared", () => {
  const wf = twoChatWorkflow();
  const copy = W.cloneWorkflow(wf, "w2", NOW + 1, idgen("c"));
  assert.equal(copy.name, "Two chats (copy)");
  assert.equal(copy.builtin, false);
  assert.notEqual(copy.chats[0].id, wf.chats[0].id);
  assert.equal(copy.docs[0].id, wf.docs[0].id, "same stored file");
  assert.deepEqual(
    copy.docs[0].chats,
    [copy.chats[0].id],
    "the assignment follows the chat through the copy"
  );
  const plan = W.planRun(copy);
  assert.deepEqual(plan.map((p) => p.chatName), ["Drafting", "Critic", "Drafting"]);
  assert.deepEqual(plan[0].docIds, ["d1"]);
});

test("fileIdsInUse protects a copy's documents when the original is deleted", () => {
  const wf = twoChatWorkflow();
  const copy = W.cloneWorkflow(wf, "w2", NOW, idgen("c"));
  const inUse = W.fileIdsInUse([wf, copy], wf.id);
  assert.ok(inUse.has("d1"), "the copy still references the bytes");
  assert.equal(W.fileIdsInUse([wf], wf.id).size, 0);
});

test("starting a run empties the template and hands it this matter's papers", () => {
  // Named and armed for the matter in hand.
  const armed = W.newWorkflow(
    Object.assign({}, twoChatWorkflow(), {
      name: "Demurrer — Smith v. Jones",
      templateName: "Tentative ruling — 3× devil's advocate",
    }),
    "w1",
    NOW
  );
  const run = W.newRun(armed, "r1", NOW, { type: "now" }, armed.docs);
  assert.equal(run.name, "Demurrer — Smith v. Jones", "the run keeps the matter's name");
  assert.equal(run.docs.length, 1, "and its papers");

  const rested = W.resetToTemplate(armed, NOW + 1);
  assert.equal(rested.name, "Tentative ruling — 3× devil's advocate");
  assert.deepEqual(rested.docs, [], "ready to be armed for the next matter");
  assert.equal(rested.steps.length, armed.steps.length, "the workflow itself is untouched");

  // The run still uploads, from its own copy, though the template has none.
  const plan = W.planRun(rested, run.docs);
  assert.deepEqual(plan[0].docIds, ["d1"]);
  assert.equal(W.totalUploads(rested), 0, "the emptied template would upload nothing");
});

test("a chat can be pointed at an existing conversation, and that goes with the run", () => {
  const url = "https://claude.ai/chat/2f1c7a9e-0b44-4a2e-9f61-5d8c3e77b012";
  const armed = W.newWorkflow(
    Object.assign({}, twoChatWorkflow(), {
      chats: [
        { id: "a", name: "Drafting", startUrl: url },
        { id: "b", name: "Critic" },
      ],
    }),
    "w1",
    NOW
  );
  // The run starts already "returning" to that conversation — the same field it
  // fills in for itself as it goes — so step 1 goes there instead of opening one.
  const run = W.newRun(armed, "r1", NOW, { type: "now" }, armed.docs);
  assert.deepEqual(run.chats, { a: { url } });

  // And the template forgets it, so the next matter doesn't inherit this chat.
  const rested = W.resetToTemplate(armed, NOW + 1);
  assert.equal(rested.chats[0].startUrl, null);
  assert.deepEqual(W.newRun(rested, "r2", NOW + 2, { type: "now" }).chats, {});

  // A link that isn't a conversation is worth saying so about.
  assert.ok(W.looksLikeChatUrl(url));
  assert.equal(W.looksLikeChatUrl("https://example.com/notes"), false);
  assert.equal(W.looksLikeChatUrl(""), false);
  const wrong = W.newWorkflow(
    Object.assign({}, twoChatWorkflow(), {
      chats: [{ id: "a", name: "Drafting", startUrl: "https://example.com/x" }, { id: "b", name: "Critic" }],
    }),
    "w2",
    NOW
  );
  assert.ok(W.validate(wrong).some((p) => /doesn't look like a claude\.ai conversation/.test(p)));
});

test("an existing chat can stand in as step 0", () => {
  const url = "https://claude.ai/chat/2f1c7a9e-0b44-4a2e-9f61-5d8c3e77b012";
  // Chat A already holds a draft written by hand, so the run should begin by
  // taking that across to B rather than drafting again.
  const wf = W.newWorkflow(
    Object.assign({}, twoChatWorkflow(), {
      chats: [
        { id: "a", name: "Drafting", startUrl: url, seedFromLatest: true },
        { id: "b", name: "Critic" },
      ],
    }),
    "w1",
    NOW
  );
  const run = W.newRun(wf, "r1", NOW, { type: "now" }, wf.docs);
  assert.equal(run.stepIndex, 1, "step 1 was chat A's — already done by hand");
  assert.equal(run.seedFrom, "a", "and its latest reply is the opening hand-off");
  assert.deepEqual(run.chats, { a: { url } });
  // The step it starts on is the one that pastes into B.
  const plan = W.planRun(W.runSource(run, wf));
  assert.equal(plan[run.stepIndex].chatName, "Critic");
  assert.equal(plan[run.stepIndex].carry, true);
  assert.match(W.composeStepText(plan[run.stepIndex], "THE HAND-WRITTEN DRAFT"), /THE HAND-WRITTEN DRAFT/);

  // Leading steps are skipped as a group, not just one.
  const twoLeading = W.newWorkflow(
    Object.assign({}, wf, {
      steps: [
        { id: "s1", chatId: "a", prompt: "draft" },
        { id: "s2", chatId: "a", prompt: "verify" },
        { id: "s3", chatId: "b", prompt: "attack" },
      ],
    }),
    "w2",
    NOW
  );
  assert.equal(W.seedPlan(twoLeading).stepIndex, 2);

  // Without the tick it's just a chat to start in: step 1 still runs, there.
  const plain = W.newWorkflow(
    Object.assign({}, wf, { chats: [{ id: "a", name: "Drafting", startUrl: url }, { id: "b", name: "Critic" }] }),
    "w3",
    NOW
  );
  const plainRun = W.newRun(plain, "r2", NOW, { type: "now" });
  assert.equal(plainRun.stepIndex, 0);
  assert.equal(plainRun.seedFrom, null);
});

test("step 0 is flagged when it would leave nothing to do, or has no chat", () => {
  const url = "https://claude.ai/chat/2f1c7a9e-0b44-4a2e-9f61-5d8c3e77b012";
  const allOneChat = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "Only", startUrl: url, seedFromLatest: true }],
      steps: [{ chatId: "a", prompt: "go" }],
    },
    "w",
    NOW
  );
  assert.ok(W.validate(allOneChat).some((p) => /leaves nothing to do/.test(p)));
  assert.equal(W.seedPlan(allOneChat).stepIndex, 0, "and it never runs off the end");

  const noLink = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "Drafting", seedFromLatest: true }, { id: "b", name: "Critic" }],
      steps: [{ chatId: "a", prompt: "draft" }, { chatId: "b", prompt: "attack" }],
    },
    "w2",
    NOW
  );
  assert.ok(W.validate(noLink).some((p) => /has no chat link/.test(p)));
  assert.equal(W.seedPlan(noLink).seedFrom, null, "no link, no step 0");
});

test("a run's papers aren't deleted with the template that started it", () => {
  const wf = twoChatWorkflow();
  const run = W.newRun(wf, "r1", NOW, { type: "now" }, wf.docs);
  const rested = W.resetToTemplate(wf, NOW);
  // Deleting the (now empty) template must not take the running job's bytes.
  assert.equal(W.fileIdsInUse([rested], rested.id).size, 0);
  assert.ok(W.runFileIds([run]).has("d1"), "the run is still holding them");
  assert.equal(W.runFileIds([]).size, 0);
});

test("templateName defaults to the name, so an unrenamed workflow keeps it", () => {
  const wf = W.newWorkflow({ name: "Just a workflow", chats: [{ id: "a" }], steps: [{ chatId: "a", prompt: "go" }] }, "w", NOW);
  assert.equal(wf.templateName, "Just a workflow");
  assert.equal(W.resetToTemplate(wf, NOW).name, "Just a workflow");
});

test("upsert / remove / get for workflows", () => {
  let list = [];
  const wf = twoChatWorkflow();
  list = W.upsertWorkflow(list, wf);
  list = W.upsertWorkflow(list, Object.assign({}, wf, { name: "Renamed" }));
  assert.equal(list.length, 1);
  assert.equal(W.getWorkflow(list, wf.id).name, "Renamed");
  assert.equal(W.removeWorkflow(list, wf.id).length, 0);
});

// ---- runs ----------------------------------------------------------------

function startedRun() {
  const wf = twoChatWorkflow();
  return { wf, run: W.markStarted(W.newRun(wf, "r1", NOW, { type: "now" }), NOW) };
}

test("a run walks its steps and finishes on the last one", () => {
  const { wf, run } = startedRun();
  const plan = W.planRun(wf);
  let r = W.markSent(run, { chatId: "a", url: "https://claude.ai/chat/u1", now: NOW });
  assert.equal(r.phase, "awaiting-reply");
  r = W.applyStepResult(r, { stepIndex: 0, chatId: "a", reply: "DRAFT", url: "https://claude.ai/chat/u1", now: NOW + 1, total: plan.length });
  assert.equal(r.stepIndex, 1);
  assert.equal(r.lastReply, "DRAFT");
  assert.equal(r.status, "running");
  assert.equal(r.chats.a.url, "https://claude.ai/chat/u1");
  r = W.applyStepResult(r, { stepIndex: 1, chatId: "b", reply: "REPORT", now: NOW + 2, total: plan.length });
  r = W.applyStepResult(r, { stepIndex: 2, chatId: "a", reply: "REVISED", now: NOW + 3, total: plan.length });
  assert.equal(r.status, "done");
  assert.equal(r.finishedAt, NOW + 3);
  assert.equal(r.transcript.length, 3);
  assert.equal(r.transcript[2].chars, "REVISED".length);
});

test("a step result for a step already passed is ignored, not applied again", () => {
  // The worker retries delivery when a page doesn't answer, so the same step
  // can be run twice. The second copy names the step the WORKER asked for, so
  // it lands on a run that has moved on and must do nothing — applying it would
  // advance the run again and skip a step's prompt entirely.
  const { run } = startedRun();
  const first = W.applyStepResult(run, { stepIndex: 0, chatId: "a", reply: "DRAFT", now: NOW, total: 3 });
  assert.equal(first.stepIndex, 1);
  const duplicate = W.applyStepResult(first, { stepIndex: 0, chatId: "a", reply: "DRAFT", now: NOW + 9, total: 3 });
  assert.equal(duplicate.stepIndex, 1, "the run stays where it is");
  assert.equal(duplicate.transcript.length, 1);
  assert.equal(duplicate.lastReply, "DRAFT");
});

test("a duplicate step result cannot advance the run twice", () => {
  const { run } = startedRun();
  const once = W.applyStepResult(run, { stepIndex: 0, chatId: "a", reply: "A", now: NOW, total: 3 });
  const again = W.applyStepResult(once, { stepIndex: 0, chatId: "a", reply: "A", now: NOW, total: 3 });
  assert.equal(again.stepIndex, 1, "stale result for step 0 is ignored");
  assert.equal(again.transcript.length, 1);
});

test("a run remembers its own window, and forgets one that's gone", () => {
  const { run } = startedRun();
  assert.equal(run.windowId, null);
  const placed = W.withWindow(run, 42);
  assert.equal(placed.windowId, 42);
  assert.equal(W.withWindow(placed, null).windowId, null, "closed window → open a fresh one");
  assert.equal(W.withWindow(placed, undefined).windowId, null);
  // Fixing a partial run keeps it pointed at the same window.
  assert.equal(W.reviseRun(placed, { stepIndex: 1 }, NOW).windowId, 42);
});

test("a run executes its own copy, not the template's", () => {
  const wf = twoChatWorkflow();
  const run = W.newRun(wf, "r1", NOW, { type: "now" }, wf.docs);
  assert.equal(run.plan.steps.length, 3);
  // The template is re-armed for another matter and rewritten entirely.
  const reused = W.newWorkflow(
    Object.assign({}, wf, { steps: [{ id: "z", chatId: "a", prompt: "something else" }] }),
    wf.id,
    NOW + 1
  );
  const src = W.runSource(run, reused);
  assert.equal(src.steps.length, 3, "the run in flight is unaffected");
  assert.equal(W.planRun(src)[1].prompt, "attack it");
  // A run from before runs carried their own falls back to the workflow.
  const legacy = Object.assign({}, run, { plan: null });
  assert.equal(W.runSource(legacy, reused).steps.length, 1);
});

test("a step can be added to a run in progress without touching the template", () => {
  const wf = twoChatWorkflow();
  let run = W.newRun(wf, "r1", NOW, { type: "now" }, wf.docs);
  run = W.applyStepResult(W.markStarted(run, NOW), {
    stepIndex: 0, chatId: "a", reply: "DRAFT", now: NOW, total: 3,
  });
  assert.equal(run.stepIndex, 1);

  const steps = run.plan.steps.slice();
  steps.splice(2, 0, { id: "extra", chatId: "b", prompt: "one more pass", carry: true });
  const edited = W.applyRunEdit(run, { steps }, NOW + 5);
  assert.equal(edited.totalSteps, 4);
  assert.equal(W.planRun(W.runSource(edited, wf))[2].prompt, "one more pass");
  assert.equal(edited.stepIndex, 1, "where it had got to is untouched");
  assert.equal(wf.steps.length, 3, "the template is not edited");
});

test("documents added mid-run ride the next step in their chats", () => {
  const wf = twoChatWorkflow();
  let run = W.newRun(wf, "r1", NOW, { type: "now" }, wf.docs);
  // Two steps done; chat A's and chat B's opening messages have both gone.
  run = Object.assign({}, run, { stepIndex: 2 });
  const docs = run.docs.concat([{ id: "late", name: "reply-brief.pdf", chats: ["a", "b"] }]);
  const edited = W.applyRunEdit(run, { docs }, NOW + 5);

  const added = edited.docs.find((d) => d.id === "late");
  assert.equal(added.addedAt, 2, "stamped with where the run had reached");
  const plan = W.planRun(W.runSource(edited, wf));
  assert.deepEqual(plan[0].docIds, ["d1"], "the opening message is long gone; unchanged");
  assert.deepEqual(plan[2].docIds, ["late"], "goes up with the next step in chat A");
  // Chat B's next step is in the future here, so it rides that one instead.
  const withB = W.applyRunEdit(
    Object.assign({}, run, { stepIndex: 0 }),
    { docs, steps: run.plan.steps },
    NOW + 6
  );
  const planB = W.planRun(W.runSource(withB, wf));
  assert.ok(planB[1].docIds.indexOf("late") !== -1, "chat B's next step carries it");
});

test("an edited run can be saved back as a new workflow", () => {
  const wf = twoChatWorkflow();
  let run = W.newRun(Object.assign({}, wf, { name: "Demurrer — Smith" }), "r1", NOW, { type: "now" }, wf.docs);
  // Edited mid-flight: an extra pass nobody's template has.
  const steps = run.plan.steps.concat([{ id: "x", chatId: "b", prompt: "one more pass", carry: true }]);
  run = W.applyRunEdit(run, { steps }, NOW + 1);

  const made = W.workflowFromRun(run, wf, "w2", NOW + 2, idgen("n"));
  assert.equal(made.name, "Demurrer — Smith");
  assert.equal(made.templateName, "Demurrer — Smith");
  assert.equal(made.steps.length, 4, "including the step added mid-run");
  assert.equal(made.steps[3].prompt, "one more pass");
  assert.deepEqual(made.docs, [], "a template starts empty — those papers were that matter's");
  assert.deepEqual(W.validate(made), []);
  // Fresh ids: a new template, not a reference back to the run's workflow.
  assert.notEqual(made.chats[0].id, wf.chats[0].id);
  assert.deepEqual(
    W.planRun(made).map((s) => s.chatName),
    ["Drafting", "Critic", "Drafting", "Critic"]
  );

  // It works when the original workflow is gone entirely.
  const orphan = W.workflowFromRun(run, null, "w3", NOW + 3, idgen("o"));
  assert.equal(orphan.steps.length, 4);
});

test("a queued run's trigger can be changed, a started one's can't", () => {
  const wf = twoChatWorkflow();
  const queued = W.newRun(wf, "r1", NOW, { type: "reset" });
  assert.ok(W.canRetrigger(queued));

  const later = W.retrigger(queued, { type: "time", at: NOW + 7200000 }, NOW);
  assert.deepEqual(later.trigger, { type: "time", at: NOW + 7200000 });
  assert.deepEqual(W.dueRuns([later], NOW).map((r) => r.id), [], "not yet");
  assert.deepEqual(W.dueRuns([later], NOW + 7200000).map((r) => r.id), ["r1"]);
  assert.equal(W.nextRunTrigger([later], NOW), NOW + 7200000);

  // ...and back the other way, or straight to now.
  assert.deepEqual(W.retrigger(later, { type: "reset" }, NOW).trigger, { type: "reset" });
  assert.deepEqual(W.retrigger(later, { type: "now" }, NOW).trigger, { type: "now" });
  assert.deepEqual(W.retrigger(later, {}, NOW).trigger, { type: "now" }, "unknown means now");
  assert.equal(later.stepIndex, queued.stepIndex, "nothing else moves");

  // Once it's going, the trigger is history — Pause is the tool then.
  assert.equal(W.canRetrigger(W.markStarted(queued, NOW)), false);
  assert.equal(W.canRetrigger(W.markPaused(queued, NOW)), false);
  assert.equal(W.canRetrigger(null), false);
});

test("pausing keeps a run's place; resuming picks it up", () => {
  const { run } = startedRun();
  const waiting = W.markSent(run, { chatId: "a", url: "u", now: NOW });
  const paused = W.markPaused(waiting, NOW + 1);
  assert.equal(paused.status, "paused");
  assert.equal(paused.stepIndex, waiting.stepIndex, "same place");
  assert.equal(paused.phase, "awaiting-reply", "and it still knows the message went out");
  assert.equal(W.resumePlan(paused).alreadySent, true);
  assert.equal(W.isRunActive(paused), false, "nothing picks a paused run back up on its own");
  assert.equal(W.pickupRuns([paused], NOW + W.STALE_MS + 1, W.STALE_MS).length, 0);
});

test("pasted text is named from its own first line", () => {
  assert.equal(
    W.pastedDocName("Opposition to Motion to Compel\n\nComes now…", []),
    "Opposition to Motion to Compel.txt",
    "which tells you what it is in the list"
  );
  // Heading marks, bullets and quotes are decoration on the title.
  assert.equal(W.pastedDocName("## Reply Brief\nbody", []), "Reply Brief.txt");
  assert.equal(W.pastedDocName("> Declaration of Smith\nbody", []), "Declaration of Smith.txt");
  // Leading blank lines are skipped, not taken as the title.
  assert.equal(W.pastedDocName("\n\n\nDeclaration of Jones\nbody", []), "Declaration of Jones.txt");
  // Characters a filename can't hold don't reach the filename.
  assert.equal(W.pastedDocName('Smith v. Jones: MSJ / part 2\nbody', []), "Smith v. Jones MSJ part 2.txt");
  // A very long first line is cut rather than becoming the whole paste.
  const long = W.pastedDocName("x".repeat(400) + "\nbody", []);
  assert.ok(long.length <= 65, long.length);
});

test("pasted text with no usable title is numbered, past what's already there", () => {
  assert.equal(W.pastedDocName("a\nb", []), "Pasted text 1.txt", "too short to be a title");
  assert.equal(W.pastedDocName("", []), "Pasted text 1.txt");
  assert.equal(W.pastedDocName(null, []), "Pasted text 1.txt");
  assert.equal(
    W.pastedDocName("###\nbody", ["Pasted text 1.txt", "Pasted text 2.txt"]),
    "Pasted text 3.txt",
    "so two pastes never collide"
  );
  // And a title already taken gets its own number rather than overwriting.
  assert.equal(
    W.pastedDocName("Reply Brief\nbody", ["reply brief.txt"]),
    "Reply Brief (2).txt",
    "matched case-insensitively, as a filesystem would"
  );
});

const DA = "Use the devils-advocate skill.\n\nAttack the merits of the draft below.";
const RULE = "Use the tentative-ruling skill and draft the ruling in full.";

test("the prompt pool counts how often each one has been written", () => {
  const mk = (prompts) => ({ steps: prompts.map((p) => ({ prompt: p })) });
  const pool = W.promptPool(
    [mk([DA, RULE]), mk([DA]), mk([DA, "short"])],
    [{ prompt: RULE }]
  );
  const by = Object.fromEntries(pool.map((p) => [p.text, p.uses]));
  assert.equal(by[DA], 3, "counted across workflows");
  assert.equal(by[RULE], 2, "and the steps open in the editor count too");
  assert.equal(by.short, undefined, "a prompt too short to be worth completing to");
  assert.deepEqual(W.promptPool(null, null), []);
});

test("a completion is offered only for what you've actually started typing", () => {
  const pool = W.promptPool([{ steps: [{ prompt: DA }, { prompt: RULE }] }]);

  const hit = W.promptSuggestions(pool, "Use the devils");
  assert.equal(hit.length, 1);
  assert.equal(hit[0].text, DA);
  assert.equal(hit[0].rest, DA.slice("Use the devils".length), "just the part still to type");

  // Case doesn't matter; the completion still returns what was actually stored.
  assert.equal(W.promptSuggestions(pool, "use the DEVILS")[0].text, DA);
  // A prefix shared by both offers both.
  assert.equal(W.promptSuggestions(pool, "Use the ").length, 2);

  // Not a prefix, so not offered — a fuzzy match that guesses wrong is worse
  // than no guess, because accepting is one keystroke.
  assert.deepEqual(W.promptSuggestions(pool, "Attack the merits"), []);
  assert.deepEqual(W.promptSuggestions(pool, "Use"), [], "too little typed to guess from");
  assert.deepEqual(W.promptSuggestions(pool, "   "), []);
  assert.deepEqual(W.promptSuggestions(pool, DA), [], "already typed in full — nothing to add");
  assert.deepEqual(W.promptSuggestions(null, "Use the devils"), []);
});

test("the prompt written most often is offered first", () => {
  const once = "Use the same opening but only once.";
  const often = "Use the same opening but often, and this one is longer.";
  const pool = [
    { text: once, uses: 1 },
    { text: often, uses: 7 },
  ];
  const out = W.promptSuggestions(pool, "Use the same opening but");
  assert.equal(out[0].text, often, "seven uses beats one, even though it's longer");

  // Equal footing falls back to the shortest — the least presumptuous guess.
  const tie = W.promptSuggestions(
    [{ text: once, uses: 2 }, { text: often, uses: 2 }],
    "Use the same opening but"
  );
  assert.equal(tie[0].text, once);
  assert.equal(W.promptSuggestions(pool, "Use the same opening but", 1).length, 1);
});

test("reorderSteps puts steps where the drop said, and fixes the first one", () => {
  const wf = twoChatWorkflow(); // s1(a) → s2(b) → s3(a)
  const ids = wf.steps.map((s) => s.id);
  assert.deepEqual(ids, ["s1", "s2", "s3"]);
  assert.equal(wf.steps[0].carry, false);
  assert.equal(wf.steps[1].carry, true);

  // Dragged from the end to the top. s3 lands first and can't carry; s1 now
  // follows s3, which is the same chat, so it can't either; s2 follows a chat it
  // isn't in, so it does.
  const moved = W.reorderSteps(wf.steps, ["s3", "s1", "s2"]);
  assert.deepEqual(moved.map((s) => s.id), ["s3", "s1", "s2"]);
  assert.equal(moved[0].carry, false, "nothing before it to carry from");
  assert.equal(moved[1].carry, false, "chat A already has what chat A just wrote");
  assert.equal(moved[2].carry, true);

  // The originals are untouched — a drag that's abandoned mid-way changes
  // nothing until it lands.
  assert.deepEqual(wf.steps.map((s) => s.id), ["s1", "s2", "s3"]);
  assert.equal(wf.steps[0].carry, false);
});

test("reordering restores a hand-off that only position had suppressed", () => {
  // s2 sits directly after s1 in the SAME chat, so the editor doesn't offer it
  // a tick at all and normalize stores false. Moved somewhere that isn't true,
  // it should carry again — losing hand-offs silently mid-reshuffle is the
  // failure this exists to prevent.
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      steps: [
        { id: "s1", chatId: "a", prompt: "draft" },
        { id: "s2", chatId: "a", prompt: "again" }, // same chat → carry false
        { id: "s3", chatId: "b", prompt: "attack" },
      ],
    },
    "w1",
    NOW
  );
  assert.equal(wf.steps[1].carry, false, "as stored");

  const moved = W.reorderSteps(wf.steps, ["s1", "s3", "s2"]);
  assert.deepEqual(moved.map((s) => s.id), ["s1", "s3", "s2"]);
  assert.equal(moved[2].carry, true, "now it follows chat B, so it has something to carry");

  // A no that WAS a choice still travels: s3 carries by default, untick it and
  // moving it keeps the answer.
  const said = wf.steps.map((s) => (s.id === "s3" ? Object.assign({}, s, { carry: false }) : s));
  const after = W.reorderSteps(said, ["s3", "s1", "s2"]);
  assert.equal(after.find((s) => s.id === "s3").carry, false, "it was first, so still false");
  const later = W.reorderSteps(said, ["s1", "s2", "s3"]);
  assert.equal(later.find((s) => s.id === "s3").carry, false, "and back where it was, still no");
});

test("a reorder that names fewer steps than exist doesn't lose the rest", () => {
  const wf = twoChatWorkflow();
  // A card that somehow isn't in the list keeps its place rather than taking
  // its prompt with it.
  const kept = W.reorderSteps(wf.steps, ["s3"]);
  assert.deepEqual(kept.map((s) => s.id), ["s3", "s1", "s2"]);
  assert.deepEqual(W.reorderSteps(wf.steps, []).map((s) => s.id), ["s1", "s2", "s3"]);
  assert.deepEqual(W.reorderSteps(wf.steps, ["s2", "s2", "nope"]).map((s) => s.id), ["s2", "s1", "s3"]);
  assert.deepEqual(W.reorderSteps([], ["s1"]), []);
  assert.deepEqual(W.reorderSteps(null, null), []);
});

test("two steps in the same chat never paste into each other", () => {
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      steps: [
        { chatId: "a", prompt: "draft" },
        { chatId: "a", prompt: "verify", carry: true }, // ticked, but pointless
        { chatId: "b", prompt: "attack", carry: true },
      ],
    },
    "w",
    NOW
  );
  assert.equal(wf.steps[1].carry, false, "that conversation already has it");
  assert.equal(wf.steps[2].carry, true);
  const plan = W.planRun(wf);
  assert.equal(W.composeStepText(plan[1], "THE DRAFT"), "verify", "nothing pasted");
  assert.match(W.composeStepText(plan[2], "THE DRAFT"), /THE DRAFT/);
});

test("a chat whose output is a ruling only hands on a reply that is one", () => {
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [
        { id: "a", name: "Drafting", expectsRuling: true },
        { id: "b", name: "Critic" },
      ],
      steps: [
        { chatId: "a", prompt: "draft" },
        { chatId: "b", prompt: "attack" },
        { chatId: "a", prompt: "revise" },
      ],
    },
    "w",
    NOW
  );
  const plan = W.planRun(wf);
  assert.equal(plan[0].handsOn, true);
  assert.equal(plan[0].marker, "NATURE OF PROCEEDINGS", "step 1's reply goes to chat B");
  assert.equal(plan[1].marker, null, "chat B isn't marked as producing a ruling");
  assert.equal(plan[2].marker, null, "the last step's reply goes nowhere");

  // The gate itself.
  assert.ok(W.hasMarker("…\nNATURE OF PROCEEDINGS: Hearing on Demurrer\n…", "NATURE OF PROCEEDINGS"));
  assert.ok(W.hasMarker("nature   of\nproceedings", "NATURE OF PROCEEDINGS"), "spacing and case are noise");
  assert.equal(
    W.hasMarker("I need the reply brief before I can draft this. Shall I continue?", "NATURE OF PROCEEDINGS"),
    false,
    "a clarifying question is a real reply, but not the ruling"
  );
  assert.equal(W.hasMarker("anything", null), true, "no marker, no gate");
});

test("the ruling gate is off wherever nothing is pasted onward", () => {
  // Same chat twice: the second step's reply isn't handed anywhere, so a chat
  // marked as producing rulings imposes nothing on it.
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "Drafting", expectsRuling: true }, { id: "b", name: "B" }],
      steps: [
        { chatId: "a", prompt: "draft" },
        { chatId: "a", prompt: "style pass" },
        { chatId: "b", prompt: "attack", carry: false },
      ],
    },
    "w",
    NOW
  );
  const plan = W.planRun(wf);
  assert.equal(plan[0].marker, null, "next step is the same chat — nothing travels");
  assert.equal(plan[1].marker, null, "the step after doesn't carry");
  assert.equal(W.chatMarker({ expectsRuling: true, outputMarker: "  CONCLUSION " }), "CONCLUSION");
  assert.equal(W.chatMarker({ expectsRuling: false, outputMarker: "CONCLUSION" }), null);
});

test("carrySource points at the chat that produced the hand-off", () => {
  const wf = twoChatWorkflow();
  // Step 3 (revise, in A) carries what step 2 (attack, in B) produced.
  const src = W.carrySource(wf, 2);
  assert.deepEqual(
    { needed: src.needed, chatName: src.chatName, fromStep: src.fromStep },
    { needed: true, chatName: "Critic", fromStep: 1 }
  );
  assert.equal(W.carrySource(wf, 0).needed, false, "the first step carries nothing");
  const noCarry = W.normalize(
    Object.assign({}, wf, { steps: wf.steps.map((s, i) => Object.assign({}, s, { carry: false })) })
  );
  assert.equal(W.carrySource(noCarry, 2).needed, false);
});

test("reviseRun continues from a chosen step without re-sending what already went out", () => {
  const { wf, run } = startedRun();
  // Two steps done, then it died waiting on step 3's reply.
  let r = W.applyStepResult(run, { stepIndex: 0, chatId: "a", reply: "DRAFT", now: NOW, total: 3 });
  r = W.applyStepResult(r, { stepIndex: 1, chatId: "b", reply: "REPORT", now: NOW + 1, total: 3 });
  r = W.markSent(r, { chatId: "a", url: "https://claude.ai/chat/u1", now: NOW + 2 });
  r = W.markError(r, "Claude did not finish replying in time", NOW + 3);
  assert.equal(r.phase, "awaiting-reply", "stopping remembers the message went out");
  assert.equal(W.resumePlan(r).alreadySent, true);

  // Resume as-is: wait for the reply rather than posting it again.
  const asIs = W.reviseRun(r, { stepIndex: r.stepIndex, phase: "awaiting-reply" }, NOW + 4);
  assert.equal(asIs.status, "running");
  assert.equal(asIs.phase, "awaiting-reply");
  assert.equal(asIs.error, null);
  assert.equal(asIs.stepIndex, 2);

  // Or go back a step and run it again from scratch, with a corrected link.
  const back = W.reviseRun(
    r,
    { stepIndex: 1, phase: "idle", lastReply: "FIXED DRAFT", chats: { b: { url: "https://claude.ai/chat/u9" } } },
    NOW + 5
  );
  assert.equal(back.stepIndex, 1);
  assert.equal(back.phase, "idle", "it will send this step's message");
  assert.equal(back.lastReply, "FIXED DRAFT");
  assert.equal(back.chats.b.url, "https://claude.ai/chat/u9");
  assert.equal(back.chats.a.url, "https://claude.ai/chat/u1", "untouched chats keep their link");
  assert.deepEqual(
    back.transcript.map((t) => t.stepIndex),
    [0],
    "history from the resume point on is dropped — it hasn't happened again yet"
  );
  assert.equal(back.sentAt, null);
});

const MIN = 60_000;

test("a step records how long it took, split into sending and waiting", () => {
  const { run } = startedRun();
  let r = W.markSending(run, NOW);
  r = W.markSent(r, { chatId: "a", url: "https://claude.ai/chat/u1", now: NOW + 2 * MIN });
  r = W.applyStepResult(r, {
    stepIndex: 0,
    chatId: "a",
    reply: "DRAFT",
    now: NOW + 14 * MIN,
    total: 3,
  });
  const t = r.transcript[0];
  assert.equal(t.sendMs, 2 * MIN, "composing the message and getting its documents up");
  assert.equal(t.replyMs, 12 * MIN, "and Claude answering");
  assert.equal(t.ms, 14 * MIN);
  assert.equal(t.ms, t.sendMs + t.replyMs, "the legs add up to the whole");
  assert.equal(t.stoppedMs, 0);
  assert.equal(r.stepStartedAt, null, "the clock is cleared for the next step");
});

test("time a run spends stopped is not charged to the step", () => {
  const { run } = startedRun();
  let r = W.markSending(run, NOW);
  r = W.markSent(r, { chatId: "a", url: "https://claude.ai/chat/u1", now: NOW + MIN });
  // Paused a minute in, picked back up an hour later.
  r = W.markPaused(r, NOW + 2 * MIN);
  assert.equal(r.stepStoppedAt, NOW + 2 * MIN);
  r = W.reviseRun(r, { stepIndex: 0, phase: "awaiting-reply" }, NOW + 62 * MIN);
  assert.equal(r.stepStoppedAt, null);
  assert.equal(r.stepStoppedMs, 60 * MIN);
  r = W.applyStepResult(r, { stepIndex: 0, chatId: "a", reply: "DRAFT", now: NOW + 65 * MIN, total: 3 });
  const t = r.transcript[0];
  assert.equal(t.stoppedMs, 60 * MIN);
  assert.equal(t.ms, 5 * MIN, "an hour paused is an hour stopped, not an hour of work");
  assert.equal(t.replyMs, 4 * MIN);
});

test("re-attaching to a sent step keeps the record that it was sent", () => {
  // A worker that dies mid-wait comes back and calls markSending again. If that
  // overwrote the phase, the retry would post the same message a second time.
  const { run } = startedRun();
  let r = W.markSending(run, NOW);
  r = W.markSent(r, { chatId: "a", url: "https://claude.ai/chat/u1", now: NOW + MIN });
  r = W.markSending(r, NOW + 5 * MIN);
  assert.equal(r.phase, "awaiting-reply");
  assert.equal(r.status, "running");
  assert.equal(r.stepStartedAt, NOW, "and its clock keeps running from the first attempt");
  r = W.applyStepResult(r, { stepIndex: 0, chatId: "a", reply: "DRAFT", now: NOW + 20 * MIN, total: 3 });
  assert.equal(r.transcript[0].ms, 20 * MIN);
});

test("a step with no honest start reports nothing rather than guessing", () => {
  // Told its message already went out — this run never sent it, so it has no
  // moment to measure from.
  const { run } = startedRun();
  let r = W.reviseRun(run, { stepIndex: 0, phase: "awaiting-reply" }, NOW);
  r = W.applyStepResult(r, { stepIndex: 0, chatId: "a", reply: "DRAFT", now: NOW + 9 * MIN, total: 3 });
  assert.equal(r.transcript[0].ms, null);
  assert.equal(r.transcript[0].sendMs, null);
  assert.equal(r.transcript[0].replyMs, 9 * MIN, "what it can say, it says");
});

test("re-sending a step times the attempt that worked, not every attempt", () => {
  const { run } = startedRun();
  let r = W.markSending(run, NOW);
  r = W.markError(r, "Claude did not finish replying in time", NOW + 40 * MIN);
  r = W.reviseRun(r, { stepIndex: 0, phase: "idle" }, NOW + 100 * MIN);
  r = W.markSending(r, NOW + 100 * MIN);
  r = W.markSent(r, { chatId: "a", url: "https://claude.ai/chat/u1", now: NOW + 101 * MIN });
  r = W.applyStepResult(r, { stepIndex: 0, chatId: "a", reply: "DRAFT", now: NOW + 110 * MIN, total: 3 });
  assert.equal(r.transcript[0].ms, 10 * MIN);
  assert.equal(r.transcript[0].stoppedMs, 0, "the failed attempt's clock went with it");
});

test("timingSummary describes a run by its median step, not its worst", () => {
  const empty = W.timingSummary({ transcript: [] });
  assert.equal(empty.steps, 0);
  assert.equal(empty.totalMs, null);

  const t = W.timingSummary({
    transcript: [
      { stepIndex: 0, ms: 5 * MIN },
      { stepIndex: 1, ms: 60 * MIN },
      { stepIndex: 2, ms: 7 * MIN },
      { stepIndex: 3, ms: null }, // still running, or never measured
    ],
  });
  assert.equal(t.steps, 3, "only steps that reported a time");
  assert.equal(t.totalMs, 72 * MIN);
  assert.equal(t.medianMs, 7 * MIN, "the hour-long outlier doesn't get to speak for the rest");
  assert.equal(t.longestMs, 60 * MIN);
  assert.equal(t.longest.stepIndex, 1);
});

test("formatMs says the useful thing at each scale", () => {
  assert.equal(W.formatMs(0), "0s");
  assert.equal(W.formatMs(42_000), "42s");
  assert.equal(W.formatMs(90_000), "1m 30s");
  assert.equal(W.formatMs(12 * MIN), "12m");
  assert.equal(W.formatMs(60 * MIN), "1h");
  assert.equal(W.formatMs(95 * MIN), "1h 35m");
  assert.equal(W.formatMs(null), "");
  assert.equal(W.formatMs(-5), "");
});

const SAMPLE = { percent: 0.2, resetAt: 5000, weeklyPercent: 0.4, weeklyResetAt: 90000, updatedAt: 1 };

test("a step records what your usage did while it ran", () => {
  const before = W.usageSample(SAMPLE);
  assert.equal(before.session, 20);
  assert.equal(before.weekly, 40);

  const { run } = startedRun();
  let r = W.markSending(run, NOW, before);
  r = W.markSent(r, { chatId: "a", url: "https://claude.ai/chat/u1", now: NOW + 1 });
  r = W.applyStepResult(r, {
    stepIndex: 0,
    chatId: "a",
    reply: "DRAFT",
    now: NOW + 2,
    total: 3,
    usage: W.usageSample(Object.assign({}, SAMPLE, { percent: 0.235, weeklyPercent: 0.412 })),
  });
  assert.equal(r.transcript[0].usedSession, 3.5);
  assert.equal(r.transcript[0].usedWeekly, 1.2);
  assert.equal(r.stepUsage, null, "the baseline is cleared with the rest of the step's state");
});

test("a window that reset mid-step can't be differenced", () => {
  const before = W.usageSample(SAMPLE);
  // The 5-hour window rolled over — new resetAt, and the meter back near zero.
  const after = W.usageSample(
    Object.assign({}, SAMPLE, { percent: 0.03, resetAt: 6000, weeklyPercent: 0.44 })
  );
  const cost = W.usageCost(before, after);
  assert.equal(cost.session, null, "what it had already spent in the old window is gone");
  assert.equal(cost.weekly, 4, "the weekly window didn't roll, so it still counts");

  // A drop with no new reset time is a reset we didn't see. Same answer.
  assert.equal(
    W.usageCost(before, W.usageSample(Object.assign({}, SAMPLE, { weeklyPercent: 0.1 }))).weekly,
    null
  );
  // And nothing to compare against reads as unmeasured, not as free.
  assert.equal(W.usageCost(null, after).weekly, null);
  assert.equal(W.usageCost(before, W.usageSample({})).weekly, null);
});

test("a draft run exists but nothing picks it up", () => {
  const wf = twoChatWorkflow();
  const draft = W.newRun(wf, "r1", NOW, { type: "draft" });
  assert.equal(draft.status, "draft");
  assert.equal(draft.trigger.type, "draft");
  assert.equal(W.isDraft(draft), true);
  assert.equal(W.isRunActive(draft), false, "so nothing treats it as in flight");

  // Every scheduler gates on "pending", and a draft is not that.
  assert.deepEqual(W.dueRuns([draft], NOW + 1e9), []);
  assert.deepEqual(W.pendingResetRuns([draft]), []);
  assert.deepEqual(W.pickupRuns([draft], NOW + W.STALE_MS + 1, W.STALE_MS), []);
  assert.deepEqual(W.heldRuns([draft]), []);
  assert.match(W.progressText(draft, wf), /Not started/);
});

test("a run made from a resting template starts unnamed, but knows its workflow", () => {
  const wf = W.newWorkflow(
    { name: "Tentative ruling", templateName: "Tentative ruling", chats: [{ id: "a", name: "A" }], steps: [{ chatId: "a", prompt: "go" }] },
    "w1",
    NOW
  );
  const run = W.newRun(wf, "r1", NOW, { type: "draft" });
  assert.equal(run.name, "", "it has nothing to say about the matter yet");
  assert.equal(run.templateName, "Tentative ruling");

  const label = W.runLabel(run);
  assert.equal(label.named, false);
  assert.equal(label.title, "Tentative ruling", "so the row is still recognisable");
  assert.equal(label.template, "", "and doesn't say the same thing twice");

  // Named for the matter, the workflow moves to the badge beside it.
  const named = W.applyRunEdit(run, { name: "Demurrer — Smith v. Jones" }, NOW + 1);
  const l2 = W.runLabel(named);
  assert.equal(l2.named, true);
  assert.equal(l2.title, "Demurrer — Smith v. Jones");
  assert.equal(l2.template, "Tentative ruling");
});

test("a workflow armed for a matter still hands that name to its run", () => {
  // The older way round: type the matter's name onto the template and go. That
  // name IS the matter, so the run takes it.
  const wf = W.newWorkflow(
    {
      name: "MSJ — Alvarez",
      templateName: "Tentative ruling",
      chats: [{ id: "a", name: "A" }],
      steps: [{ chatId: "a", prompt: "go" }],
    },
    "w1",
    NOW
  );
  const run = W.newRun(wf, "r1", NOW, { type: "now" });
  assert.equal(run.name, "MSJ — Alvarez");
  assert.equal(run.templateName, "Tentative ruling");
  assert.equal(W.runLabel(run).template, "Tentative ruling");
});

test("a run remembers its workflow after the template is renamed or deleted", () => {
  const wf = twoChatWorkflow();
  const run = W.newRun(wf, "r1", NOW, { type: "draft" });
  // Nothing about the run points at the template's current name.
  assert.equal(W.runLabel(run).title, "Two chats");
  assert.equal(W.getWorkflow([], run.workflowId), null, "even with the template gone");
  assert.equal(W.runLabel(run).title, "Two chats");
});

test("giving a draft a trigger is what starts it", () => {
  const wf = twoChatWorkflow();
  const draft = W.newRun(wf, "r1", NOW, { type: "draft" });
  assert.equal(W.canRetrigger(draft), true, "the same control that reschedules a queued run");

  const armed = W.retrigger(draft, { type: "reset" }, NOW + 10);
  assert.equal(armed.status, "pending");
  assert.equal(armed.trigger.type, "reset");
  assert.equal(W.isDraft(armed), false);
  assert.equal(W.pendingResetRuns([armed]).length, 1);

  // Rescheduling a run that was already queued doesn't change its status.
  const queued = W.newRun(wf, "r2", NOW, { type: "reset" });
  assert.equal(W.retrigger(queued, { type: "now" }, NOW + 10).status, "pending");

  // And taking the trigger back off a queued run un-schedules it rather than
  // running it — this is the one place a bad default would send a matter out.
  const back = W.retrigger(queued, { type: "draft" }, NOW + 10);
  assert.equal(back.status, "draft");
  assert.equal(back.trigger.type, "draft");
  assert.deepEqual(W.dueRuns([back], NOW + 1e9), []);
  // And a run that has actually started can't be re-armed at all.
  assert.equal(W.canRetrigger(W.markStarted(queued, NOW)), false);
});

test("papers added to a run that hasn't started go up with its opening message", () => {
  const wf = twoChatWorkflow();
  const draft = W.newRun(wf, "r1", NOW, { type: "draft" });
  const edited = W.applyRunEdit(
    draft,
    { docs: draft.docs.concat([{ id: "new", name: "moving papers.pdf", chats: ["a"] }]) },
    NOW + 1
  );
  // Stamped with step 0, which for a run that hasn't moved IS the chat's
  // opening message — so it goes up exactly where it would have anyway.
  assert.equal(edited.docs.find((d) => d.id === "new").addedAt, 0);
  assert.deepEqual(
    W.planRun(W.runSource(edited, null))[0].docIds,
    ["d1", "new"],
    "the chat's first step carries both, the one it inherited and the one just added"
  );

  // Whereas the same edit to a run under way holds them for the next step, as
  // before: that chat's opening message has already gone.
  const running = W.markStarted(W.newRun(wf, "r2", NOW, { type: "now" }), NOW);
  const midRun = W.applyRunEdit(
    Object.assign({}, running, { stepIndex: 1 }),
    { docs: running.docs.concat([{ id: "d2", name: "reply brief.pdf", chats: ["a"] }]) },
    NOW + 1
  );
  assert.equal(midRun.docs.find((d) => d.id === "d2").addedAt, 1);
  const midPlan = W.planRun(W.runSource(midRun, null));
  assert.deepEqual(midPlan[0].docIds, ["d1"], "not the message already sent");
  assert.deepEqual(midPlan[2].docIds, ["d2"], "chat A's next step carries it instead");
});

test("a step can name its own model, and the chat keeps it afterwards", () => {
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "A", model: "Opus 4.1" }, { id: "b", name: "B" }],
      steps: [
        { chatId: "a", prompt: "draft" }, // inherits Opus 4.1
        { chatId: "b", prompt: "attack", model: "Sonnet 4.5" }, // B has no model of its own
        { chatId: "a", prompt: "revise", model: "Haiku 4.5" }, // switches A mid-conversation
        { chatId: "a", prompt: "final" }, // and A stays there
      ],
    },
    "w1",
    NOW
  );
  const plan = W.planRun(wf);

  assert.equal(plan[0].model, "Opus 4.1", "the chat's own model, picked as it opens");
  assert.equal(plan[0].modelOverride, false);
  assert.equal(plan[1].model, "Sonnet 4.5");
  assert.equal(plan[1].modelOverride, true);
  assert.equal(plan[2].model, "Haiku 4.5", "switches A part-way through");
  assert.equal(plan[3].model, null, "already on it — no menu opened for nothing");
  assert.equal(plan[3].modelOn, "Haiku 4.5", "but the surfaces still know what it answers on");
  assert.equal(plan[3].modelOverride, false);

  assert.match(W.summarize(wf), /Opus 4\.1 → Sonnet 4\.5 → Haiku 4\.5/);
});

test("a chat with no model at all leaves every step alone", () => {
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "A" }],
      steps: [{ chatId: "a", prompt: "one" }, { chatId: "a", prompt: "two" }],
    },
    "w1",
    NOW
  );
  const plan = W.planRun(wf);
  assert.equal(plan[0].model, null, "nothing to pick means nothing is picked");
  assert.equal(plan[0].modelOn, null);
  assert.equal(plan[1].model, null);
  assert.ok(!/→/.test(W.summarize(wf)), "and nothing to say about it on the row");
});

test("a step only counts when it had Claude to itself", () => {
  const win = { from: 1000, to: 2000, conv: "mine" };
  const busy = (start, end) => ({ mine: { start: 900, end: 1900 }, other: { start, end } });

  assert.equal(W.soleActor({ mine: { start: 1100, end: 1900 } }, win), true, "its own turn");
  assert.equal(W.soleActor({}, win), true, "an empty ledger is clean, not unknown");

  // Any overlap at all disqualifies it, from either side.
  assert.equal(W.soleActor(busy(1200, 1300), win), false, "wholly inside");
  assert.equal(W.soleActor(busy(500, 1200), win), false, "started before, ran into it");
  assert.equal(W.soleActor(busy(1900, 2500), win), false, "started inside, ran past");
  assert.equal(W.soleActor(busy(500, 2500), win), false, "spanned the whole step");
  assert.equal(W.soleActor(busy(1500, null), win), false, "still running when we looked");
  assert.equal(W.soleActor(busy(500, null), win), false, "started before and never ended");

  // Outside it entirely is fine.
  assert.equal(W.soleActor(busy(200, 800), win), true, "finished before the step began");
  assert.equal(W.soleActor(busy(2200, 2400), win), true, "began after it ended");

  // A run's other chats are its own — they're idle while this step runs, and a
  // run must not be able to contaminate itself.
  assert.equal(
    W.soleActor({ chatB: { start: 1200, end: 1300 } }, { from: 1000, to: 2000, conv: ["mine", "chatB"] }),
    true
  );

  // Can't say is never yes.
  assert.equal(W.soleActor(null, win), false, "no ledger at all");
  assert.equal(W.soleActor({}, { from: null, to: 2000, conv: "mine" }), false, "no step start");
  assert.equal(W.soleActor({}, {}), false);
});

test("a shared step records a refusal, not a zero", () => {
  const { run } = startedRun();
  let r = W.markSending(run, NOW, W.usageSample(SAMPLE));
  r = W.markSent(r, { chatId: "a", url: "https://claude.ai/chat/u1", now: NOW + 1 });
  r = W.applyStepResult(r, {
    stepIndex: 0,
    chatId: "a",
    reply: "DRAFT",
    now: NOW + 2,
    total: 3,
    usage: W.usageSample(Object.assign({}, SAMPLE, { weeklyPercent: 0.9 })),
    usageClean: false,
  });
  const t = r.transcript[0];
  assert.equal(t.usedWeekly, null, "50 points of somebody else's work is not this step's");
  assert.equal(t.usedSession, null);
  assert.equal(t.usageShared, true, "and the row can say why it's blank");
  assert.equal(W.runUsage(r).measured, 0);
  assert.equal(W.runUsage(r).complete, false, "so it can't reach the workflow's average");
});

// A finished three-step run, ready to be run again.
function finishedRun(extra) {
  const wf = W.newWorkflow(
    Object.assign(
      {
        name: "Tentative ruling",
        templateName: "Tentative ruling",
        allowRerun: true,
        chats: [{ id: "a", name: "Drafting" }, { id: "b", name: "Critic" }],
        docs: [{ id: "d1", name: "motion.pdf", chats: ["a"] }],
        steps: [
          { id: "s1", chatId: "a", prompt: "draft" },
          { id: "s2", chatId: "b", prompt: "attack", carry: true },
          { id: "s3", chatId: "a", prompt: "revise", carry: true },
        ],
      },
      extra || {}
    ),
    "w1",
    NOW
  );
  let run = W.applyRunEdit(
    W.newRun(wf, "r1", NOW, { type: "now" }),
    { name: "8.11.26 MSJ" },
    NOW
  );
  run = Object.assign({}, run, {
    status: "done",
    stepIndex: 3,
    lastReply: "THE REVISED RULING",
    chats: { a: { url: "https://claude.ai/chat/u1" }, b: { url: "https://claude.ai/chat/u2" } },
  });
  return { wf, run };
}

test("only a finished run that was told it may is offered a re-run", () => {
  const { run } = finishedRun();
  assert.equal(W.canRerun(run), true);
  assert.equal(W.canRerun(Object.assign({}, run, { status: "running" })), false, "not mid-flight");
  assert.equal(W.canRerun(Object.assign({}, run, { status: "error" })), false);
  assert.equal(W.canRerun(Object.assign({}, run, { allowRerun: false })), false, "off by default");
  assert.equal(W.canRerun(finishedRun({ allowRerun: false }).run), false);
  assert.equal(W.canRerun(null), false);
});

test("a re-run continuing in the same chats keeps them and re-uploads nothing", () => {
  const { run } = finishedRun();
  const again = W.rerunOf(run, { stepIndex: 1, freshChats: false }, "r2", NOW + 1);

  assert.equal(again.status, "draft", "it waits like any other new run");
  assert.equal(again.stepIndex, 1, "skipping the step that produced what the rest works on");
  assert.equal(again.rerunOf, "r1");
  assert.equal(again.name, "8.11.26 MSJ (re-run 1)");
  assert.deepEqual(again.chats, run.chats, "carries on in the conversations it built");
  assert.equal(again.lastReply, "", "they already hold the work — nothing to paste in");

  // The papers rode step 0, which this re-run doesn't run, so nothing goes up
  // again — those chats already have them.
  const plan = W.planRun(W.runSource(again, null));
  assert.deepEqual(plan[1].docIds, []);
  assert.deepEqual(plan[2].docIds, []);
});

test("a re-run in fresh chats re-uploads the papers on the step it starts at", () => {
  const { run } = finishedRun();
  const again = W.rerunOf(run, { stepIndex: 1, freshChats: true, carryFinal: true }, "r2", NOW + 1);

  assert.deepEqual(again.chats, {}, "new conversations, so it opens its own");
  assert.equal(again.lastReply, "THE REVISED RULING", "and the last run's answer goes in with it");

  // Chat A's papers went up on step 0 last time. Step 0 doesn't run now, and
  // the new chat A is empty — so they have to ride A's first step that does.
  const plan = W.planRun(W.runSource(again, null));
  assert.deepEqual(plan[2].docIds, ["d1"], "chat A's next step carries them");
  assert.deepEqual(plan[0].docIds, [], "not the step being skipped");
});

test("the re-run answers are the workflow's, and a run inherits them", () => {
  const { run } = finishedRun({
    rerun: { stepIndex: 2, freshChats: true, carryFinal: true, reuseDocs: false },
  });
  // The run carries its own copy, so one matter can differ from the next.
  assert.deepEqual(run.rerun, {
    stepIndex: 2,
    freshChats: true,
    carryFinal: true,
    reuseDocs: false,
  });
  assert.deepEqual(W.rerunSettings(run), run.rerun, "and that's what Re-run opens with");

  // Changed for this run alone.
  const mine = W.applyRunEdit(run, { rerun: { stepIndex: 1 } }, NOW + 1);
  assert.equal(mine.rerun.stepIndex, 1);
  assert.equal(mine.rerun.freshChats, false, "an answer not given takes the default");
  assert.equal(W.applyRunEdit(run, {}, NOW + 1).rerun.stepIndex, 2, "an edit that says nothing");
});

test("a run from a workflow with no re-run answers still has usable ones", () => {
  // The button must not depend on the workflow having had an opinion.
  const { run } = finishedRun();
  const d = W.rerunSettings(run);
  assert.equal(d.stepIndex, 1, "the second step — the common case");
  assert.equal(d.freshChats, false);
  assert.equal(d.carryFinal, true);
  assert.equal(d.reuseDocs, true);
  // A run made before any of this existed has no `rerun` at all.
  assert.deepEqual(W.rerunSettings(Object.assign({}, run, { rerun: undefined })), d);
  // And a step from a plan that has since been shortened is clamped.
  const short = Object.assign({}, run, {
    rerun: { stepIndex: 9 },
    plan: { chats: run.plan.chats, steps: run.plan.steps.slice(0, 2) },
  });
  assert.equal(W.rerunSettings(short).stepIndex, 1);
});

test("fresh conversations can be told not to take the papers again", () => {
  const { run } = finishedRun();
  const without = W.rerunOf(
    run,
    { stepIndex: 1, freshChats: true, reuseDocs: false },
    "r2",
    NOW + 1
  );
  // Kept on the run — the matter still had them — but left on the step nothing
  // runs, so they never go up.
  assert.equal(without.docs.length, 1, "still on the record");
  assert.equal(without.docs[0].addedAt, undefined);
  const plan = W.planRun(W.runSource(without, null));
  assert.deepEqual(plan[1].docIds, []);
  assert.deepEqual(plan[2].docIds, []);

  // And on by default, which is what "the same run, again" means.
  const with_ = W.rerunOf(run, { stepIndex: 1, freshChats: true }, "r3", NOW + 1);
  assert.deepEqual(W.planRun(W.runSource(with_, null))[2].docIds, ["d1"]);
});

test("a re-run never pastes into a step that takes no hand-off", () => {
  const { run } = finishedRun();
  // Step 1 (index 0) opens its chat and carries nothing.
  assert.equal(W.rerunCarries(run, 0), false);
  assert.equal(W.rerunCarries(run, 1), true);
  const again = W.rerunOf(run, { stepIndex: 0, freshChats: true, carryFinal: false }, "r2", NOW + 1);
  assert.equal(again.lastReply, "");
});

test("re-runs of re-runs are numbered rather than nested", () => {
  const { run } = finishedRun();
  const second = W.rerunOf(run, { stepIndex: 1 }, "r2", NOW + 1);
  assert.equal(second.name, "8.11.26 MSJ (re-run 1)");
  const done = Object.assign({}, second, { status: "done", allowRerun: true });
  const third = W.rerunOf(done, { stepIndex: 1 }, "r3", NOW + 2);
  assert.equal(third.name, "8.11.26 MSJ (re-run 2)", "not “(re-run 1) (re-run 1)”");
  assert.equal(third.rerunCount, 2);
  // An unnamed run leans on the workflow it came from, as everywhere else.
  const bare = W.rerunOf(Object.assign({}, run, { name: "" }), { stepIndex: 1 }, "r4", NOW + 3);
  assert.equal(bare.name, "Tentative ruling (re-run 1)");
});

test("a step index outside the plan is clamped, not obeyed", () => {
  const { run } = finishedRun();
  assert.equal(W.rerunOf(run, { stepIndex: 99 }, "r2", NOW).stepIndex, 2, "the last step");
  assert.equal(W.rerunOf(run, { stepIndex: -3 }, "r2", NOW).stepIndex, 0);
  assert.equal(W.rerunOf(run, {}, "r2", NOW).stepIndex, 0);
  assert.equal(W.rerunOf(null, {}, "r2", NOW), null);
});

test("a run's own switches survive an edit of that run", () => {
  const { run } = finishedRun();
  const off = W.applyRunEdit(run, { allowRerun: false, downloadFiles: true }, NOW + 1);
  assert.equal(off.allowRerun, false, "turned off for this run without touching the workflow");
  assert.equal(off.downloadFiles, true);
  assert.equal(off.nameChats, run.nameChats, "and an edit that says nothing changes nothing");
  assert.equal(W.applyRunEdit(run, {}, NOW + 1).allowRerun, true);
});

test("a download control is never mistaken for the copy box", () => {
  // The failure this prevents: clicking Download when the copy box was wanted
  // saves a file nobody asked for AND hands back no text at all.
  assert.ok(W.isDownloadLabel("Download"));
  assert.ok(W.isDownloadLabel("  download  "));
  assert.ok(W.isDownloadLabel("Download ruling.docx"), "aria-labels name the file");
  assert.ok(W.isDownloadLabel("Save"));
  // And it must not swallow the copy box, or a reply could never be read.
  assert.equal(W.isDownloadLabel("Copy"), false);
  assert.equal(W.isDownloadLabel(""), false);
  assert.equal(W.isDownloadLabel(null), false);
  // Prose that happens to mention downloading is not a control.
  assert.equal(W.isDownloadLabel("You can download the file from the link above"), false);
  assert.equal(W.isDownloadLabel("Redownload"), false, "matched at the word, not the substring");
  // The two rules stay disjoint: nothing may be both.
  for (const s of ["Copy", "copy message", "Download", "Save"])
    assert.ok(!(W.isCopyLabel(s) && W.isDownloadLabel(s)), s);
});

test("a run's conversations are named for the matter and their job in it", () => {
  const wf = W.newWorkflow(
    {
      name: "Tentative ruling",
      templateName: "Tentative ruling",
      chats: [{ id: "a", name: "Drafting (A)" }],
      steps: [{ chatId: "a", prompt: "go" }],
    },
    "w1",
    NOW
  );
  const run = W.applyRunEdit(
    W.newRun(wf, "r1", NOW, { type: "draft" }),
    { name: "8.11.26 Motion to Compel Arbitration" },
    NOW + 1
  );
  assert.equal(
    W.chatTitle(run, "Drafting (A)"),
    "8.11.26 Motion to Compel Arbitration: Drafting (A)"
  );

  // An unnamed run still has something to say — the workflow it's a run of.
  const bare = W.newRun(wf, "r2", NOW, { type: "draft" });
  assert.equal(W.chatTitle(bare, "Drafting (A)"), "Tentative ruling: Drafting (A)");

  // Missing halves don't produce dangling punctuation.
  assert.equal(W.chatTitle(run, ""), "8.11.26 Motion to Compel Arbitration");
  assert.equal(W.chatTitle({ name: "", templateName: "" }, "Drafting (A)"), "Drafting (A)");
});

test("a long matter is shortened, never the chat's own name", () => {
  const chat = "Devil's advocate (B)";
  const long = "8.11.26 " + "Motion to Compel Arbitration and to Stay Proceedings ".repeat(3);
  const title = W.chatTitle({ name: long }, chat);
  assert.ok(title.length <= 100, "fits: " + title.length);
  assert.ok(title.endsWith(": " + chat), "the half that tells the run's chats apart survives whole");
  assert.ok(title.startsWith("8.11.26 Motion to Compel"), "and the matter is still recognisable");
  assert.ok(/…: /.test(title), "with the cut marked");
});

test("conversationIdFromApiUrl reads the conversation off a completion request", () => {
  const id = "0198fe12-3456-7890-abcd-ef0123456789";
  assert.equal(
    W.conversationIdFromApiUrl("/api/organizations/" + "aaaaaaaa-1111-2222-3333-444444444444" +
      "/chat_conversations/" + id + "/completion"),
    id,
    "the conversation, not the organization"
  );
  assert.equal(W.conversationIdFromApiUrl("/api/organizations/x/chat_conversations/" + id), id);
  assert.equal(W.conversationIdFromApiUrl("/api/bootstrap"), null);
  assert.equal(W.conversationIdFromApiUrl(null), null);
});

test("conversationId finds the conversation on every surface that shows one", () => {
  const conv = "0198fe12-3456-7890-abcd-ef0123456789";
  const proj = "aaaaaaaa-1111-2222-3333-444444444444";
  assert.equal(W.conversationId("https://claude.ai/chat/" + conv), conv);
  assert.equal(W.conversationId("/chat/" + conv), conv);
  assert.equal(W.conversationId("https://claude.ai/chat/" + conv + "?x=1#y"), conv);
  // A container names itself first; the conversation is the specific one.
  assert.equal(W.conversationId("/project/" + proj + "/chat/" + conv), conv, "/chat/ still wins");
  assert.equal(W.conversationId("/cowork/project/" + proj + "/" + conv), conv, "the last id");
  assert.equal(W.conversationId("/code/" + conv), conv);
  // Nothing to ask about — which must read as "no id", not as some other id.
  assert.equal(W.conversationId("https://claude.ai/new"), null);
  assert.equal(W.conversationId(""), null);
  assert.equal(W.conversationId(null), null);
  // A page that names only its container gives that: the API answers "not
  // found", which is a real reading and says so, rather than being skipped.
  assert.equal(W.conversationId("/cowork/project/" + proj), proj);
});

test("conversationKey names a conversation the same way from any URL shape", () => {
  const id = "0198fe12-3456-7890-abcd-ef0123456789";
  assert.equal(W.conversationKey("https://claude.ai/chat/" + id), id);
  assert.equal(W.conversationKey("https://claude.ai/chat/" + id + "?foo=1#x"), id);
  assert.equal(W.conversationKey("https://claude.ai/new"), "/new");
  assert.equal(W.conversationKey(""), "");
});

test("runUsage totals a run and says how much of it was measured", () => {
  const run = {
    transcript: [
      { stepIndex: 0, usedWeekly: 1.2, usedSession: 3 },
      { stepIndex: 1, usedWeekly: 0.8, usedSession: 2 },
      { stepIndex: 2, usedWeekly: null, usedSession: null }, // window reset here
    ],
  };
  const u = W.runUsage(run);
  assert.equal(u.steps, 3);
  assert.equal(u.measured, 2);
  assert.equal(u.weekly, 2);
  assert.equal(u.session, 5);
  assert.equal(u.complete, false, "so the total can't be passed off as the whole run");

  assert.equal(W.runUsage({ transcript: [] }).weekly, null, "nothing measured is null, not zero");
  assert.equal(W.runUsage(null).complete, false);
});

test("a workflow averages the runs it can, and ignores the ones it can't", () => {
  const wf = W.newWorkflow({ name: "x", chats: [{ id: "a", name: "A" }] }, "w1", NOW);
  assert.equal(wf.usage, null);

  const complete = (weekly) => ({ transcript: [{ stepIndex: 0, usedWeekly: weekly }] });
  let w = W.noteRunUsage(wf, complete(4));
  assert.equal(w.usage.runs, 1);
  assert.equal(w.usage.weekly, 4);

  w = W.noteRunUsage(w, complete(6));
  assert.equal(w.usage.runs, 2);
  assert.equal(w.usage.weekly, 5, "the running mean");
  assert.equal(w.usage.lastWeekly, 6);

  // A run with an unmeasured step would drag the average down for a reason
  // nothing on the face of it explains, so it's left out.
  const partial = { transcript: [{ stepIndex: 0, usedWeekly: 4 }, { stepIndex: 1, usedWeekly: null }] };
  assert.equal(W.noteRunUsage(w, partial), w, "unchanged, same object");
  assert.equal(W.noteRunUsage(w, { transcript: [] }), w);
  assert.equal(W.noteRunUsage(null, complete(4)), null);
});

test("editing a workflow doesn't erase what its runs cost", () => {
  const wf = W.newWorkflow({ name: "x", chats: [{ id: "a", name: "A" }] }, "w1", NOW);
  const measured = W.noteRunUsage(wf, { transcript: [{ stepIndex: 0, usedWeekly: 4 }] });
  const list = W.upsertWorkflow([], measured);

  // The editor rebuilds the workflow from its form, which has no field for this.
  const edited = W.newWorkflow({ name: "x renamed", chats: [{ id: "a", name: "A" }] }, "w1", NOW + 1);
  assert.equal(edited.usage, null);
  const after = W.upsertWorkflow(list, edited);
  assert.equal(after[0].name, "x renamed");
  assert.equal(after[0].usage.weekly, 4, "measurement survives an edit");

  // But a workflow that carries its own figure keeps it — this is a fallback,
  // not an override.
  const withOwn = Object.assign({}, edited, { usage: { runs: 9, weekly: 1 } });
  assert.equal(W.upsertWorkflow(list, withOwn)[0].usage.runs, 9);
});

test("formatPct never rounds real work down to nothing", () => {
  assert.equal(W.formatPct(0), "0%");
  assert.equal(W.formatPct(0.04), "<0.1%");
  assert.equal(W.formatPct(1.24), "1.2%");
  assert.equal(W.formatPct(12), "12%");
  assert.equal(W.formatPct(null), "");
});

test("re-reading the previous reply and 'already sent' are alternatives", () => {
  // Either alone is left exactly as it is.
  assert.deepEqual(W.exclusiveFix({ refetchCarry: true, sent: false }), {
    refetchCarry: true,
    sent: false,
  });
  assert.deepEqual(W.exclusiveFix({ refetchCarry: false, sent: true }), {
    refetchCarry: false,
    sent: true,
  });
  assert.deepEqual(W.exclusiveFix({}), { refetchCarry: false, sent: false });

  // Ticking one clears the other, whichever way round.
  assert.deepEqual(W.exclusiveFix({ refetchCarry: true, sent: true }, "refetch"), {
    refetchCarry: true,
    sent: false,
  });
  assert.deepEqual(W.exclusiveFix({ refetchCarry: true, sent: true }, "sent"), {
    refetchCarry: false,
    sent: true,
  });

  // With nobody having clicked — the panel's opening defaults — the observation
  // about the chat beats the preference about it.
  assert.deepEqual(W.exclusiveFix({ refetchCarry: true, sent: true }), {
    refetchCarry: false,
    sent: true,
  });
});

test("reviseRun clamps a step index that isn't a step", () => {
  const { run } = startedRun();
  assert.equal(W.reviseRun(run, { stepIndex: 99 }, NOW).stepIndex, 2, "last step");
  assert.equal(W.reviseRun(run, { stepIndex: -4 }, NOW).stepIndex, 0);
  assert.equal(W.reviseRun(run, {}, NOW).stepIndex, run.stepIndex);
});

test("held runs keep their original heldSince so the wait has a ceiling", () => {
  const { run } = startedRun();
  const held = W.markHeld(run, "Claude.ai major outage", NOW);
  const stillHeld = W.markHeld(held, "Claude.ai major outage", NOW + 60_000);
  assert.equal(stillHeld.heldSince, NOW);
  assert.equal(W.heldRuns([stillHeld]).length, 1);
});

test("trigger selection mirrors the scheduled-send triggers", () => {
  const wf = twoChatWorkflow();
  const now = W.newRun(wf, "r1", NOW, { type: "now" });
  const later = W.newRun(wf, "r2", NOW, { type: "time", at: NOW + 5000 });
  const onReset = W.newRun(wf, "r3", NOW, { type: "reset" });
  const runs = [now, later, onReset];
  assert.deepEqual(W.dueRuns(runs, NOW).map((r) => r.id), ["r1"]);
  assert.deepEqual(W.dueRuns(runs, NOW + 5000).map((r) => r.id), ["r1", "r2"]);
  assert.deepEqual(W.pendingResetRuns(runs).map((r) => r.id), ["r3"]);
  assert.equal(W.nextRunTrigger(runs, NOW), NOW + 5000);
  assert.equal(W.nextRunTrigger([now, onReset], NOW), null);
});

test("two runs at once can't overwrite each other", () => {
  // Each run has its own key, and its heartbeat has another — so nothing any
  // run writes is a whole-list rewrite that could carry a stale copy of a
  // sibling back over its progress.
  assert.equal(W.runKey("abc"), "cum_wf_run_abc");
  assert.equal(W.beatKey("abc"), "cum_wf_beat_abc");
  assert.notEqual(W.runKey("a"), W.runKey("b"));
  assert.notEqual(W.runKey("a"), W.beatKey("a"));
  // The ids list is distinguishable from a run's own key, since the change
  // listeners tell them apart by prefix.
  assert.equal(W.RUN_IDS_KEY.indexOf(W.RUN_PREFIX), 0);
  assert.equal(W.beatKey("x").indexOf(W.BEAT_PREFIX), 0);
});

test("a live heartbeat keeps the watchdog off a step, per run", () => {
  const { run } = startedRun();
  const a = Object.assign({}, W.markSending(run, NOW), { id: "a" });
  const b = Object.assign({}, W.markSending(run, NOW), { id: "b" });
  const late = NOW + W.STALE_MS + 1;
  // A's page is still beating; B's has gone quiet. Only B is taken over, and
  // one run's silence says nothing about the other.
  const picked = W.pickupRuns([a, b], late, W.STALE_MS, { a: late - 1000, b: NOW });
  assert.deepEqual(picked.map((r) => r.id), ["b"]);
  assert.equal(W.isStale(a, late, W.STALE_MS, late - 1000), false);
  assert.equal(W.isStale(a, late, W.STALE_MS, 0), true, "no beat falls back to the run's own mark");
});

test("a restarted worker picks up between steps, but never mid-send", () => {
  const { run } = startedRun();
  const between = W.heartbeat(run, NOW); // phase "idle"
  assert.equal(W.pickupRuns([between], NOW + 1000, W.STALE_MS).length, 1);

  const sending = W.markSending(run, NOW);
  assert.equal(
    W.pickupRuns([sending], NOW + 10_000, W.STALE_MS).length,
    0,
    "a step still going out must not be re-sent"
  );
  assert.equal(
    W.pickupRuns([sending], NOW + W.STALE_MS + 1, W.STALE_MS).length,
    1,
    "once the heartbeat stops, the driver is gone"
  );

  const waiting = W.markSent(run, { chatId: "a", url: "u", now: NOW });
  assert.equal(W.pickupRuns([waiting], NOW + 10_000, W.STALE_MS).length, 0);

  const done = Object.assign({}, between, { status: "done" });
  assert.equal(W.pickupRuns([done], NOW + W.STALE_MS + 1, W.STALE_MS).length, 0);
});

test("progressText says where the run is", () => {
  const { wf, run } = startedRun();
  assert.match(W.progressText(run, wf), /Step 1 of 3 · Drafting — sending/);
  const waiting = W.markSent(run, { chatId: "a", url: "u", now: NOW });
  assert.match(W.progressText(waiting, wf), /waiting for Claude/);
  assert.match(W.progressText(W.markError(run, "boom", NOW), wf), /Failed at step 1 of 3/);
});

// ---- reading Claude's reply ---------------------------------------------

test("lastAssistantText takes the newest assistant answer, without its thinking", () => {
  const conv = {
    chat_messages: [
      { sender: "human", content: [{ type: "text", text: "draft it" }] },
      {
        sender: "assistant",
        content: [
          { type: "thinking", thinking: "let me consider CCP 437c" },
          { type: "text", text: "THE RULING" },
          { type: "tool_use", input: { q: "search" } },
          { type: "text", text: "…continued" },
        ],
      },
      { sender: "human", content: [{ type: "text", text: "again" }] },
      { sender: "assistant", content: [{ type: "text", text: "SECOND ANSWER" }] },
    ],
  };
  assert.equal(W.lastAssistantText(conv), "SECOND ANSWER");
  conv.chat_messages.pop();
  assert.equal(W.lastAssistantText(conv), "THE RULING\n…continued");
});

test("lastAssistantText falls back to the flat text field, and copes with junk", () => {
  assert.equal(W.lastAssistantText({ chat_messages: [{ sender: "assistant", text: "hi" }] }), "hi");
  assert.equal(W.lastAssistantText({ chat_messages: [] }), "");
  assert.equal(W.lastAssistantText(null), "");
  assert.equal(W.lastAssistantText({ chat_messages: [{ sender: "human", text: "hi" }] }), "");
});

test("isCopyLabel matches the message copy box, never a code block's", () => {
  assert.ok(W.isCopyLabel("Copy"));
  assert.ok(W.isCopyLabel(" copy to clipboard "));
  assert.ok(W.isCopyLabel("Copy message"));
  assert.equal(W.isCopyLabel("Copy code"), false);
  assert.equal(W.isCopyLabel("Copy link"), false);
  assert.equal(W.isCopyLabel("Retry"), false);
  assert.equal(W.isCopyLabel(""), false);
});

test("a reply of unrenderable-block placeholders is not a reply", () => {
  // What the copy box actually handed back on a re-run: three empty shells.
  const shells =
    "```\nThis block is not supported on your current device yet.\n```\n\n" +
    "```\nThis block is not supported on your current device yet.\n```\n\n" +
    "```\nThis block is not supported on your current device yet.\n```";
  assert.ok(W.hasUnsupportedBlocks(shells));
  assert.ok(W.isMostlyPlaceholder(shells), "pasting this asks the next chat to revise nothing");
  assert.equal(W.usableLength(shells), 0);

  // A real report that happens to contain one unrenderable block is still a
  // report — flag it, don't discard it.
  const mostlyReal = "The demurrer analysis rests on two premises. " + "x".repeat(400) +
    "\n\nThis block is not supported on your current device yet.";
  assert.ok(W.hasUnsupportedBlocks(mostlyReal));
  assert.equal(W.isMostlyPlaceholder(mostlyReal), false);

  assert.equal(W.hasUnsupportedBlocks("a normal reply"), false);
  assert.equal(W.isMostlyPlaceholder(""), false);
});

test("an interrupted response is spotted, whichever way it's worded", () => {
  assert.ok(W.looksInterrupted("Claude's response was interrupted"));
  assert.ok(W.looksInterrupted("Claude’s response was interrupted"), "curly apostrophe");
  assert.ok(W.looksInterrupted("…half a ruling\n\nResponse was interrupted"));
  assert.ok(W.looksInterrupted("claude's  response   was interrupted"), "spacing is noise");
  // Not every mention of an interruption is one of these notices, but the
  // phrase is specific enough that a ruling won't produce it by accident.
  assert.equal(W.looksInterrupted("The hearing was interrupted by counsel."), false);
  assert.equal(W.looksInterrupted("NATURE OF PROCEEDINGS: Hearing on Demurrer"), false);
  assert.equal(W.looksInterrupted(""), false);
});

test("stripPlaceholders removes the shells and keeps the report", () => {
  // What the copy box actually handed back: four unrenderable blocks, then the
  // real verification report and ruling underneath.
  const shell = "```\nThis block is not supported on your current device yet.\n```";
  const mixed =
    [shell, shell, shell, shell].join("\n\n") +
    "\n\nI ran the verification pass against the four uploaded papers.\n\n" +
    "1. Argument omitted. The Demurrer argues…";
  const out = W.stripPlaceholders(mixed);
  assert.equal(out.indexOf("not supported"), -1, "no shells travel");
  assert.match(out, /^I ran the verification pass/, "and no blank run-up either");
  assert.match(out, /Argument omitted/);
  // All shells and nothing else leaves nothing to carry.
  assert.equal(W.stripPlaceholders([shell, shell].join("\n\n")), "");
  assert.equal(W.stripPlaceholders("a normal reply"), "a normal reply");
  // The bare notice, unfenced, goes too.
  assert.equal(
    W.stripPlaceholders("Before.\nThis block is not supported on your current device yet.\nAfter."),
    "Before.\n\nAfter."
  );
});

test("lastAssistantText keeps a report Claude wrote into an artifact", () => {
  const conv = {
    chat_messages: [
      {
        sender: "assistant",
        content: [
          { type: "thinking", thinking: "considering the demurrer" },
          { type: "text", text: "Here's the report:" },
          {
            type: "tool_use",
            input: { command: "create", title: "Devil's advocate", content: "CHALLENGE ONE: the premise fails." },
          },
        ],
      },
    ],
  };
  const text = W.lastAssistantText(conv);
  assert.match(text, /Here's the report:/);
  assert.match(text, /CHALLENGE ONE/, "the artifact IS the answer, not scratch work");
  assert.equal(/considering the demurrer/.test(text), false, "thinking still stays out");

  // A reply that quotes its own artifact shouldn't deliver it twice.
  const dup = {
    chat_messages: [
      {
        sender: "assistant",
        content: [
          { type: "text", text: "CHALLENGE ONE: the premise fails. And more besides." },
          { type: "tool_use", input: { content: "CHALLENGE ONE: the premise fails. And more besides." } },
        ],
      },
    ],
  };
  assert.equal(W.lastAssistantText(dup), "CHALLENGE ONE: the premise fails. And more besides.");
});

test("plausibleCopy rejects a code block's copy button hijacking the reply", () => {
  const ruling = "x".repeat(4000);
  assert.ok(W.plausibleCopy(ruling, ruling));
  assert.ok(W.plausibleCopy("x".repeat(2000), ruling), "trimmed markdown is still the answer");
  assert.equal(W.plausibleCopy("npm test", ruling), false, "a fenced snippet is not the ruling");
  assert.equal(W.plausibleCopy("", ruling), false);
  assert.ok(W.plausibleCopy("ok", "short reply"), "too short on screen to judge");
});

test("isNewReply spots a new answer even when the rendered count never grows", () => {
  // claude.ai can keep only the newest turn in the DOM, so count stays at 1.
  const virtualized = { count: 1, beforeCount: 1, beforeText: "OLD ANSWER" };
  assert.ok(W.isNewReply(Object.assign({ text: "NEW ANSWER" }, virtualized)));
  assert.equal(
    W.isNewReply(Object.assign({ text: " OLD ANSWER " }, virtualized)),
    false,
    "the reply that was already there is not a new one"
  );
  // The ordinary case: a turn was appended.
  assert.ok(W.isNewReply({ count: 3, beforeCount: 2, text: "X", beforeText: "X" }));
  // A fresh chat has nothing before it.
  assert.ok(W.isNewReply({ count: 1, beforeCount: 0, text: "FIRST", beforeText: "" }));
  // Re-attaching to a step already sent passes beforeCount -1: take what's there.
  assert.ok(W.isNewReply({ count: 1, beforeCount: -1, text: "WHATEVER", beforeText: null }));
  assert.equal(W.isNewReply({ count: 1, beforeCount: 0, text: "   " }), false);
  assert.equal(W.isNewReply(null), false);
});

test("turnSettled takes the network's word for it when the stream has closed", () => {
  const done = { text: "an answer", generating: false, streamDone: true, unchangedMs: 1500 };
  assert.ok(W.turnSettled(done), "stream closed and the DOM caught up");
  assert.equal(
    W.turnSettled(Object.assign({}, done, { unchangedMs: 200 })),
    false,
    "still give the DOM a moment to finish rendering"
  );
  assert.ok(
    W.turnSettled(Object.assign({}, done, { generating: true })),
    "the closed stream outranks the page: a Stop control that never comes down " +
      "would otherwise park the step until it times out"
  );
});

test("a reply that stops changing is finished, whatever the page claims", () => {
  // A Stop control the page never takes down must not park a step until the
  // step timeout: a long spell of unchanging reply outranks it, and the run
  // says that's what it did.
  const stuck = { text: "the ruling", generating: true, unchangedMs: 1000000, stalledMs: 900000 };
  assert.equal(W.settleReason(stuck), "stalled");
  assert.equal(
    W.settleReason(Object.assign({}, stuck, { unchangedMs: 20000 })),
    null,
    "still generating and recently changed — keep waiting"
  );
  // ...but an OPEN response stream is not a guess about markup, it's the turn
  // still running. A skill verifying authority by live retrieval sits silent
  // for many minutes and is not stalled at all.
  assert.equal(
    W.settleReason(Object.assign({}, stuck, { streamOpen: true })),
    null,
    "a stream still open outranks any amount of silence"
  );
  assert.equal(W.settleReason({ text: "x", generating: false, streamDone: true, unchangedMs: 2000 }), "stream");
  assert.equal(
    W.settleReason({ text: "x", generating: true, streamDone: true, unchangedMs: 2000 }),
    "stream",
    "the closed stream outranks the DOM, so a wrong Stop reading can't hang the run"
  );
  assert.equal(
    W.settleReason({ text: "x", generating: false, unchangedMs: 9000, stablePolls: 5 }),
    "stable"
  );
  assert.equal(W.settleReason({ text: "", streamDone: true, unchangedMs: 9000 }), null);
});

test("without a stream signal, one quiet reading is not enough to advance", () => {
  // The background-tab trap: timers throttle to ~1/min, so a single "unchanged"
  // observation spans a minute of not looking. Clicking into the tab must not
  // cash that in as a finished turn.
  const oneLook = { text: "half an answer", generating: false, unchangedMs: 60000, stablePolls: 1 };
  assert.equal(W.turnSettled(oneLook), false, "one observation across a throttled gap proves nothing");
  assert.ok(W.turnSettled(Object.assign({}, oneLook, { stablePolls: 3 })));
  assert.equal(
    W.turnSettled({ text: "x", generating: false, unchangedMs: 2000, stablePolls: 9 }),
    false,
    "consecutive polls still have to span real time"
  );
  assert.equal(W.turnSettled({ text: "   ", generating: false, unchangedMs: 60000, stablePolls: 9 }), false);
  assert.equal(W.turnSettled(null), false);
});

// ---- the pre-built workflow ---------------------------------------------

test("the pre-built workflow is the owner's tentative-ruling loop", () => {
  const wf = W.builtinWorkflow(idgen("p"), NOW);
  assert.equal(wf.builtin, true);
  assert.equal(wf.chats.length, 2, "two chats worked between");
  assert.deepEqual(W.validate(wf), []);
  const plan = W.planRun(wf);
  // draft, then 3× (attack, revise), then the final edit and the style pass.
  assert.equal(plan.length, 9);
  const inB = plan.filter((p) => p.chatName === "Devil's advocate (B)");
  assert.equal(inB.length, 3, "three devil's advocate passes");
  assert.ok(inB.every((p) => p.carry), "each pass is handed the current draft");
  assert.match(plan[0].prompt, /tentative-ruling skill/);
  assert.match(plan[1].prompt, /devils-advocate skill/);
  assert.match(plan[plan.length - 1].prompt, /ruling-style skill/);
  assert.equal(plan[plan.length - 1].chatName, "Drafting (A)", "the style pass runs in A");
  assert.equal(plan[plan.length - 1].carry, false, "A already has the ruling in its own chat");
  // Documents uploaded to chat A land on the drafting step, before anything else.
  const withDocs = W.normalize(
    Object.assign({}, wf, { docs: [W.newDoc({ name: "papers.pdf", chats: [wf.chats[0].id] }, "d")] })
  );
  assert.deepEqual(W.planRun(withDocs)[0].docIds, ["d"]);
});
