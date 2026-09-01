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

test("bundleText opens with a numbered index and marks where each document begins", () => {
  const out = W.bundleText([
    { name: "Motion.txt", text: "  THE MOTION  " },
    { name: "Complaint.txt", text: "THE COMPLAINT AND MORE" },
  ]);
  assert.match(out, /^This file contains 2 documents/);
  // A real index up top — one numbered line per document, with its length —
  // not a prose sentence running the names together (the owner's ask).
  assert.match(out, /Index, in order:\n1\. Motion\.txt — 2 words\n2\. Complaint\.txt — 4 words/);
  assert.match(out, /===== BEGIN FILE: Motion\.txt =====\n\nTHE MOTION\n\n===== END FILE: Motion\.txt =====/);
  assert.match(out, /===== BEGIN FILE: Complaint\.txt =====/);
  // An empty document contributes nothing but doesn't break the count.
  const one = W.bundleText([{ name: "a.txt", text: "A" }, { name: "b.txt", text: "   " }]);
  assert.match(one, /^This file contains 1 document,/);
  assert.match(one, /1\. a\.txt — 1 word\b/);
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

test("a pause is not a step missing its prompt", () => {
  // The bug: adding a pause to a run put "Every step needs a prompt." on the
  // editor and blocked the save. A pause HAS no prompt — it is a gate between
  // steps, not something anybody says to a chat.
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      steps: [
        { chatId: "a", prompt: "draft" },
        { kind: "pause", pauseMinutes: 0 },
        { chatId: "b", prompt: "attack" },
      ],
    },
    "w",
    NOW
  );
  assert.deepEqual(W.validate(wf), []);
  // A real step with no prompt is still an error, pause or no pause.
  wf.steps[2].prompt = "  ";
  assert.deepEqual(W.validate(wf), ["Every step needs a prompt."]);
});

test("a run of nothing but pauses has nothing to wait between", () => {
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "A" }],
      steps: [{ kind: "pause", pauseMinutes: 30 }],
    },
    "w",
    NOW
  );
  assert.deepEqual(W.validate(wf), [
    "A pause waits between steps — add a step for it to wait between.",
  ]);
});

test("two pauses in one wave are not two steps sharing a chat", () => {
  // Neither carries a chat, so the parallel-chat rule has nothing to say about
  // them — it exists to stop two steps posting into one conversation at once.
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "A" }],
      steps: [
        { chatId: "a", prompt: "draft" },
        { kind: "pause", pauseMinutes: 0, group: "g" },
        { kind: "pause", pauseMinutes: 5, group: "g" },
      ],
    },
    "w",
    NOW
  );
  assert.deepEqual(W.validate(wf), []);
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

test("the watchdog picks up a run that was told to go and never went", () => {
  // A run is driven by the in-process call made the moment it is armed, and a
  // service worker is allowed to die in the middle of that. Nothing else was
  // looking for the wreckage: the time alarm is only ever set from a "time"
  // trigger, so a "now" run that missed its own call sat at Not started until
  // somebody pressed Start by hand.
  const wf = twoChatWorkflow();
  const armed = W.newRun(wf, "r1", NOW, { type: "now" });
  assert.equal(armed.status, "pending");
  assert.deepEqual(
    W.pickupRuns([armed], NOW + 1000, W.STALE_MS, {}).map((r) => r.id),
    ["r1"],
    "thirty seconds later, the watchdog has it"
  );

  // A time that has come counts the same way; one still ahead does not.
  const later = W.newRun(wf, "r2", NOW, { type: "time", at: NOW + 7200000 });
  assert.deepEqual(W.pickupRuns([later], NOW + 1000, W.STALE_MS, {}), []);
  assert.deepEqual(
    W.pickupRuns([later], NOW + 7200001, W.STALE_MS, {}).map((r) => r.id),
    ["r2"]
  );

  // What must NOT be swept up: a run waiting for its usage reset, a draft
  // nobody has armed, and a run that is genuinely being worked right now.
  const reset = W.newRun(wf, "r3", NOW, { type: "reset" });
  const draft = W.newRun(wf, "r4", NOW, { type: "draft" });
  assert.deepEqual(W.pickupRuns([reset, draft], NOW + 1e9, W.STALE_MS, {}), []);
  const working = Object.assign({}, W.markStarted(armed, NOW), {
    phase: "awaiting-reply",
    lastProgressAt: NOW,
  });
  assert.deepEqual(W.pickupRuns([working], NOW + 1000, W.STALE_MS, {}), []);

  // Both kinds at once, each for its own reason.
  const stalled = Object.assign({}, W.markStarted(armed, NOW), {
    id: "r5",
    phase: "awaiting-reply",
    lastProgressAt: NOW,
  });
  assert.deepEqual(
    W.pickupRuns([stalled, armed], NOW + W.STALE_MS + 1, W.STALE_MS, {}).map((r) => r.id),
    ["r5", "r1"]
  );
});

test("a run's editor opens on Run now, and keeps a real arrangement", () => {
  // The second gesture — set the matter up, then come back and start it — is
  // how a matter ends up late, so setting one up and saving it IS starting it.
  const wf = twoChatWorkflow();
  assert.equal(W.editorTriggerType(W.newRun(wf, "r1", NOW, { type: "draft" })), "now");
  assert.equal(W.editorTriggerType(W.newRun(wf, "r2", NOW, { type: "now" })), "now");
  assert.equal(W.editorTriggerType(null), "now");
  assert.equal(W.editorTriggerType({}), "now");

  // An arrangement is a decision already made, and an edit is not a change of
  // mind about it.
  assert.equal(W.editorTriggerType(W.newRun(wf, "r3", NOW, { type: "reset" })), "reset");
  assert.equal(
    W.editorTriggerType(W.newRun(wf, "r4", NOW, { type: "time", at: NOW + 7200000 })),
    "time"
  );
});

test("a run with nothing to upload asks before it goes", () => {
  const wf = twoChatWorkflow();
  const armed = W.newRun(wf, "r1", NOW, { type: "draft" });
  assert.equal(W.startWarning(armed, null), "", "its motion.pdf is ticked for a chat");

  // No papers at all, and papers that are ticked for nobody, are different
  // mistakes and read differently.
  const bare = Object.assign({}, armed, { docs: [] });
  assert.match(W.startWarning(bare, null), /no documents attached/);
  const stray = Object.assign({}, armed, {
    docs: [W.newDoc({ name: "a.pdf", chats: [] }, "d")],
  });
  assert.match(W.startWarning(stray, null), /^This run has 1 document\(s\), but none are ticked/);
  assert.equal(W.startWarning(null, null), "This run has no documents attached — its first message goes out with nothing. Start it anyway?");
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

test("a step whose output is a ruling only hands on a reply that is one", () => {
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [
        { id: "a", name: "Drafting" },
        { id: "b", name: "Critic" },
      ],
      steps: [
        { chatId: "a", prompt: "draft", expectsRuling: true },
        { chatId: "b", prompt: "attack" },
        { chatId: "a", prompt: "revise", expectsRuling: true },
      ],
    },
    "w",
    NOW
  );
  const plan = W.planRun(wf);
  assert.equal(plan[0].handsOn, true);
  assert.equal(plan[0].marker, "NATURE OF PROCEEDINGS", "step 1's reply goes to chat B");
  assert.equal(plan[1].marker, null, "step 2 isn't marked as producing a ruling");
  assert.equal(
    plan[2].marker,
    "NATURE OF PROCEEDINGS",
    "the last step's reply goes nowhere, but it is still a ruling this run must produce"
  );

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

test("the ruling gate guards moving on, not only pasting onward", () => {
  // Same chat twice. Nothing is pasted between them — but a second step sent on
  // top of half a ruling is still a second step working from half a ruling, so
  // a step told to produce one has to produce one either way.
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "Drafting" }, { id: "b", name: "B" }],
      steps: [
        { chatId: "a", prompt: "draft", expectsRuling: true },
        { chatId: "a", prompt: "style pass", expectsRuling: true },
        { chatId: "b", prompt: "attack", carry: false },
      ],
    },
    "w",
    NOW
  );
  const plan = W.planRun(wf);
  assert.equal(plan[0].marker, "NATURE OF PROCEEDINGS", "same chat, but still must be a ruling");
  assert.equal(plan[1].marker, "NATURE OF PROCEEDINGS", "and so must the step after it");
  assert.equal(plan[2].marker, null, "a step that never claimed to produce one is ungated");
  assert.equal(W.stepMarker({ expectsRuling: true, outputMarker: "  CONCLUSION " }), "CONCLUSION");
  assert.equal(W.stepMarker({ expectsRuling: false, outputMarker: "CONCLUSION" }), null);
});

test("the marker is a step's business, so one chat can differ across its steps", () => {
  // The drafting chat writes the ruling, then takes a style pass over it. Only
  // the first has to BE a ruling before it travels — asked of the chat, one
  // answer had to cover both.
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "Drafting" }, { id: "b", name: "Critic" }],
      steps: [
        { chatId: "a", prompt: "draft", expectsRuling: true },
        { chatId: "b", prompt: "attack" },
        { chatId: "a", prompt: "style pass" },
        { chatId: "b", prompt: "check it again" },
      ],
    },
    "w",
    NOW
  );
  const plan = W.planRun(wf);
  assert.equal(plan[0].marker, "NATURE OF PROCEEDINGS", "the draft must be a ruling");
  assert.equal(plan[2].marker, null, "the style pass wasn't asked to produce one");
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

// ---- steps that run at the same time ---------------------------------------
const parWf = () => ({
  id: "wf",
  name: "Three advocates",
  chats: [
    { id: "c1", name: "Drafting" },
    { id: "c2", name: "Advocate A" },
    { id: "c3", name: "Advocate B" },
    { id: "c4", name: "Advocate C" },
  ],
  steps: [
    { id: "s1", chatId: "c1", prompt: "Draft it" },
    { id: "s2", chatId: "c2", prompt: "Attack it", group: "g" },
    { id: "s3", chatId: "c3", prompt: "Attack it", group: "g" },
    { id: "s4", chatId: "c4", prompt: "Attack it", group: "g" },
    { id: "s5", chatId: "c1", prompt: "Revise" },
  ],
  docs: [],
});

test("adjacent steps sharing a group are one wave, and are numbered as one", () => {
  const wf = parWf();
  assert.deepEqual(W.stepWaves(wf.steps).map((w) => w.members), [[0], [1, 2, 3], [4]]);
  assert.deepEqual(W.stepLabels(wf.steps), ["1", "2A", "2B", "2C", "3"]);
  // A group of one is an ordinary step: a letter would imply siblings that
  // aren't there.
  assert.deepEqual(W.stepLabels([{ id: "a", group: "g" }, { id: "b" }]), ["1", "2"]);

  // Adjacency is half the definition. A step dragged in between two members
  // splits them — an id acting at a distance would keep two steps that are no
  // longer next to each other silently in lockstep.
  const split = wf.steps.slice();
  split.splice(2, 0, { id: "x", chatId: "c1", prompt: "interloper" });
  assert.deepEqual(W.stepWaves(split).map((w) => w.members), [[0], [1], [2], [3, 4], [5]]);
});

test("a wave takes one hand-off and gives back all of them", () => {
  const plan = W.planRun(parWf());
  // Every member carries from the step before the WAVE — 2B does not read 2A,
  // which is the whole of what makes them parallel rather than a queue.
  assert.deepEqual(plan.map((s) => s.carry), [false, true, true, true, true]);
  assert.deepEqual(plan.map((s) => s.parallel), [false, true, true, true, false]);
  assert.deepEqual(plan[2].wave, [1, 2, 3]);
  assert.equal(plan[2].waveStart, 1);
  // And each hands on to the step AFTER the wave, so each needs its marker —
  // 2A's reader is 3, not 2B.
  assert.deepEqual(plan.map((s) => s.handsOn), [true, true, true, true, false]);

  // Which chats step 3 is fed from: all three of them, named so the replies can
  // be told apart.
  const src = W.carrySource(parWf(), 4);
  assert.equal(src.needed, true);
  assert.deepEqual(src.sources.map((s) => s.chatName), ["Advocate A", "Advocate B", "Advocate C"]);
  assert.deepEqual(src.sources.map((s) => s.label), [
    "Advocate A (2A)",
    "Advocate B (2B)",
    "Advocate C (2C)",
  ]);
});

test("steps that run at once must not share a chat", () => {
  const wf = parWf();
  assert.deepEqual(W.validate(wf), []);
  wf.steps[2].chatId = "c2"; // 2B into 2A's conversation
  const problems = W.validate(wf);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /2A and 2B/);
  assert.match(problems[0], /same time/);
});

test("a wave's replies are folded into one hand-off, labelled", () => {
  assert.equal(W.foldWave([{ label: "A", text: "only one" }]), "only one");
  const folded = W.foldWave([
    { label: "Advocate A (2A)", text: "first report" },
    { label: "Advocate B (2B)", text: "second report" },
    { label: "", text: "   " }, // a member with nothing to say adds nothing
  ]);
  assert.match(folded, /ADVOCATE A \(2A\)/);
  assert.match(folded, /ADVOCATE B \(2B\)/);
  assert.ok(folded.indexOf("first report") < folded.indexOf("second report"));
  assert.equal(W.foldWave([]), "");
});

test("a finished wave advances the run past all of it at once", () => {
  const now = 1770000000000;
  const run = {
    id: "r",
    stepIndex: 1,
    totalSteps: 5,
    status: "running",
    phase: "sending",
    transcript: [{ stepIndex: 0, ms: 1000 }],
    chats: {},
    stepStartedAt: now - 60_000,
    stepUsage: { weekly: 0.2, session: 0.1, weeklyResetAt: 1, sessionResetAt: 2 },
  };
  const next = W.applyWaveResult(run, {
    members: [
      { stepIndex: 1, chatId: "c2", chatName: "Advocate A", label: "A", reply: "one", url: "u2", ms: 40_000 },
      { stepIndex: 2, chatId: "c3", chatName: "Advocate B", label: "B", reply: "two", url: "u3", ms: 55_000 },
      { stepIndex: 3, chatId: "c4", chatName: "Advocate C", label: "C", reply: "three", url: "u4", ms: 30_000 },
    ],
    now: now,
    total: 5,
    usage: { weekly: 0.26, session: 0.13, weeklyResetAt: 1, sessionResetAt: 2 },
    usageClean: true,
  });
  assert.equal(next.stepIndex, 4, "past the whole wave, not one member of it");
  assert.equal(next.status, "running");
  // All three replies travel on, each named.
  assert.match(next.lastReply, /one/);
  assert.match(next.lastReply, /three/);
  assert.deepEqual(Object.keys(next.chats).sort(), ["c2", "c3", "c4"]);
  // One row per member, each with its own time — the wave took as long as its
  // slowest, so adding them up would report the saving as a cost.
  assert.deepEqual(next.transcript.map((t) => t.stepIndex), [0, 1, 2, 3]);
  assert.deepEqual(next.transcript.slice(1).map((t) => t.ms), [40_000, 55_000, 30_000]);
  // Usage belongs to the wave: three chats answering at once move one meter and
  // there is no honest way to split it, so it is recorded once.
  const used = next.transcript.slice(1).map((t) => t.usedWeekly);
  assert.equal(typeof used[0], "number");
  assert.deepEqual(used.slice(1), [null, null]);
  assert.equal(next.transcript[1].usageWave, true);
  assert.equal(next.transcript[2].usageShared, true, "and says why it's blank");

  // The last wave in a workflow finishes the run.
  const done = W.applyWaveResult(Object.assign({}, run, { totalSteps: 3 }), {
    members: [{ stepIndex: 1, chatId: "c2", reply: "x" }, { stepIndex: 2, chatId: "c3", reply: "y" }],
    now: now,
    total: 3,
  });
  assert.equal(done.status, "done");
  assert.equal(done.finishedAt, now);
});

test("restarting inside a wave restarts the wave", () => {
  const wf = parWf();
  const run = W.newRun(wf, "r", 1770000000000, null, []);
  // Picking 2B would leave step 3 waiting on replies nothing was going to
  // write: the members run together or not at all.
  const revised = W.reviseRun(Object.assign({}, run, { status: "error" }), { stepIndex: 2 }, 1770000000000);
  assert.equal(revised.stepIndex, 1);
  // A step outside a wave is left where it was asked for.
  assert.equal(W.reviseRun(run, { stepIndex: 4 }, 1770000000000).stepIndex, 4);
});

test("a run is an index you can move around by, finished or not", () => {
  const wf = parWf();
  const run = Object.assign(W.newRun(wf, "r", 1770000000000, null, []), {
    status: "running",
    stepIndex: 2,
    chats: {
      c1: { url: "https://claude.ai/chat/11111111-1111-1111-1111-111111111111" },
      c2: { url: "https://claude.ai/chat/22222222-2222-2222-2222-222222222222" },
    },
    transcript: [{ stepIndex: 0, at: 1770000060000, chars: 900, ms: 60000 }],
  });

  const dir = W.runDirectory(run, wf);
  assert.deepEqual(dir.map((s) => s.label), ["1", "2A", "2B", "2C", "3"]);
  assert.equal(dir[0].done, true);
  assert.equal(dir[0].at, 1770000060000);
  // Where the run is: the whole wave, since all of it is what it's doing.
  assert.deepEqual(dir.map((s) => s.here), [false, true, true, true, false]);
  // Somewhere to go, but only where that conversation exists yet.
  assert.match(dir[0].url, /11111111/);
  assert.equal(dir[2].url, null, "a step whose chat hasn't opened has nowhere to send you");

  // Which chat this conversation is — asked by a page that knows only its own
  // id, so it can find the run it belongs to.
  assert.equal(W.runHasConversation(run, "22222222-2222-2222-2222-222222222222"), "c2");
  assert.equal(W.runHasConversation(run, "33333333-3333-3333-3333-333333333333"), null);
  assert.equal(W.runHasConversation(null, "x"), null);

  // A finished run still indexes: reading back through what it did is most of
  // what this is for, and nothing about it is "current" any more.
  const done = W.runDirectory(Object.assign({}, run, { status: "done", stepIndex: 5 }), wf);
  assert.deepEqual(done.map((s) => s.here), [false, false, false, false, false]);
  assert.equal(done[0].done, true);
  assert.match(done[1].url, /22222222/);
  assert.deepEqual(W.runDirectory(null, wf), []);
});

test("a run records when it ran, not only what its steps cost", () => {
  const start = 1770000000000;
  const transcript = [
    { stepIndex: 0, ms: 20 * MIN },
    { stepIndex: 1, ms: 20 * MIN },
  ];

  // Still going: measured to now, and said to be so.
  const live = W.runTiming({ startedAt: start, transcript: transcript }, start + 90 * MIN);
  assert.equal(live.startedAt, start);
  assert.equal(live.finishedAt, null);
  assert.equal(live.running, true);
  assert.equal(live.elapsedMs, 90 * MIN);
  assert.equal(live.workingMs, 40 * MIN);
  // The gap is the run waiting on something — a hold, a pause, you. Named,
  // because "1h 30m end to end" beside "40m of work" is the first thing anyone
  // asks about.
  assert.equal(live.idleMs, 50 * MIN);

  const done = W.runTiming(
    { startedAt: start, finishedAt: start + 2 * 60 * MIN, transcript: transcript },
    start + 99 * 60 * MIN // "now" is irrelevant once it has finished
  );
  assert.equal(done.running, false);
  assert.equal(done.elapsedMs, 2 * 60 * MIN);
  assert.equal(done.finishedAt, start + 2 * 60 * MIN);

  // A run that never started has no times to report, and a draft is exactly
  // that — reporting one would date it to whenever the page was opened.
  const draft = W.runTiming({ transcript: [] }, start);
  assert.equal(draft.startedAt, null);
  assert.equal(draft.elapsedMs, null);
  assert.equal(draft.idleMs, null);
  assert.equal(draft.running, false);
  assert.equal(W.runTiming(null, start).startedAt, null);
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

test("a run stops when there's no usage left to send into", () => {
  assert.equal(W.usageExhausted({ percent: 0.4 }), false);
  assert.equal(W.usageExhausted({ percent: 1 }), true);
  // Whole percents come back from the endpoint, so 99.6% has nothing left worth
  // spending a step on.
  assert.equal(W.usageExhausted({ percent: 0.996 }), true);
  assert.equal(W.usageExhausted({ percent: 0.98 }), false);
  // A weekly limit blocks a fresh 5-hour session just as firmly.
  assert.equal(W.usageExhausted({ percent: 0.1, weeklyPercent: 1 }), true);
  // And a meter that knows nothing must not stop anything — the run is the
  // work; a missing reading is no reason to hold it up.
  assert.equal(W.usageExhausted({}), false);
  assert.equal(W.usageExhausted(null), false);
  assert.equal(W.usageExhausted({ percent: null, weeklyPercent: undefined }), false);
});

test("a run out of usage arranges to pick itself back up", () => {
  const NOW2 = 1893456000000;
  const back = NOW2 + 3 * 60 * 60 * 1000;
  const run = { id: "r1", status: "running", stepIndex: 3, totalSteps: 9 };
  const paused = W.markPausedForUsage(run, NOW2, back);
  assert.equal(paused.status, "paused");
  assert.equal(paused.resumeOnUsage, true);
  assert.equal(paused.resumeAt, back);
  assert.equal(paused.stepIndex, 3); // it keeps its place
  // The meter not knowing when isn't a reason to give up on resuming — the
  // reading is asked again either way; there is just no time to set an alarm by.
  assert.equal(W.markPausedForUsage(run, NOW2, null).resumeOnUsage, true);
  assert.equal(W.markPausedForUsage(run, NOW2, null).resumeAt, null);
});

test("pausing a run by hand means it stays paused", () => {
  const NOW2 = 1893456000000;
  const auto = W.markPausedForUsage({ id: "r1", status: "running" }, NOW2, NOW2 + 1000);
  // Pausing it yourself is a decision that it waits for you, so the standing
  // arrangement goes.
  const byHand = W.markPaused(auto, NOW2 + 5);
  assert.equal(byHand.resumeOnUsage, false);
  assert.equal(byHand.resumeAt, null);
  // ...and so does Stay paused, which changes nothing else about the run.
  const held = W.holdPaused(auto);
  assert.equal(held.resumeOnUsage, false);
  assert.equal(held.status, "paused");
  assert.equal(held.stepIndex, auto.stepIndex);
});

test("the runs waiting on the meter are picked out, and the first one dated", () => {
  const t = 1893456000000;
  const runs = [
    { id: "a", status: "paused" }, // paused by hand
    { id: "b", status: "paused", resumeOnUsage: true, resumeAt: t + 9000 },
    { id: "c", status: "paused", resumeOnUsage: true, resumeAt: t + 1000 },
    { id: "d", status: "running", resumeOnUsage: true, resumeAt: t }, // already going
  ];
  assert.deepEqual(W.usageWaitingRuns(runs).map((r) => r.id), ["b", "c"]);
  // The alarm is set by whichever expects to go first.
  assert.equal(W.nextUsageResume(runs), t + 1000);
  // One with no time on it doesn't stop the others being dated.
  assert.equal(W.nextUsageResume([{ id: "e", status: "paused", resumeOnUsage: true }]), null);
  assert.deepEqual(W.usageWaitingRuns([]), []);
  assert.equal(W.nextUsageResume(null), null);
});

test("a reading that has outlived its own window doesn't block anything", () => {
  const t = 1893456000000;
  // Current and full: blocked, and the run pauses.
  assert.equal(W.usageBlocked({ percent: 1, resetAt: t + 1000, updatedAt: t }, t), true);
  // The window it describes has since reset — that percent belongs to a window
  // that has ended, so it says nothing about this one.
  assert.equal(W.usageBlocked({ percent: 1, resetAt: t - 1000, updatedAt: t - 2000 }, t), false);
  // Old enough that it cannot be describing now. Usage is read by claude.ai's
  // own pages, so a browser with no tab open refreshes nothing — and a run that
  // ran out overnight would otherwise wait on a number that can never change.
  assert.equal(
    W.usageBlocked({ percent: 1, resetAt: t + 99999999, updatedAt: t - W.USAGE_STALE_MS - 1 }, t),
    false
  );
  // Fresh and not full: nothing to block.
  assert.equal(W.usageBlocked({ percent: 0.3, resetAt: t + 1000, updatedAt: t }, t), false);
  // A meter that knows nothing blocks nothing.
  assert.equal(W.usageBlocked({}, t), false);
  assert.equal(W.usageBlocked(null, t), false);
});

test("a paused run can say when its usage comes back", () => {
  const t = 1893456000000;
  assert.equal(W.usageBackAt({ percent: 1, resetAt: t }), t);
  assert.equal(W.usageBackAt({ weeklyPercent: 1, weeklyResetAt: t }), t);
  // Both out: work resumes when the LATER of them returns.
  assert.equal(
    W.usageBackAt({ percent: 1, resetAt: t, weeklyPercent: 1, weeklyResetAt: t + 5000 }),
    t + 5000
  );
  // The window that isn't out doesn't get to name the time.
  assert.equal(W.usageBackAt({ percent: 1, resetAt: t, weeklyPercent: 0.2, weeklyResetAt: 1 }), t);
  // Nothing known is nothing said, rather than a time we'd be guessing at.
  assert.equal(W.usageBackAt({ percent: 1 }), null);
  assert.equal(W.usageBackAt(null), null);
});

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
  // With no papers on it yet, the row asks for them.
  assert.match(W.progressText(Object.assign({}, draft, { docs: [] }), wf), /add this matter's papers/);
  // With papers on it, it stops asking — a run set up with its exhibits
  // already attached, still being told to attach them, reads as though they
  // hadn't arrived.
  const withDocs = Object.assign({}, draft, {
    docs: [{ id: "d1", name: "Motion.pdf" }, { id: "d2", name: "Opposition.pdf" }],
  });
  const said = W.progressText(withDocs, wf);
  assert.match(said, /2 documents ready/);
  assert.equal(/add this matter's papers/.test(said), false);
  assert.match(W.progressText(draft, wf), /1 document ready/, "singular where there is one");
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

  // It goes. A re-run is the same matter again — there is nothing left to set
  // up, which is the point of it being one press rather than Create run and a
  // trip through the editor.
  assert.equal(again.status, "pending");
  assert.equal(again.trigger.type, "now");
  assert.equal(again.stepIndex, 1, "skipping the step that produced what the rest works on");
  // ...unless the caller parks it, which is what a re-run being set up rather
  // than started looks like.
  const parked = W.rerunOf(run, { stepIndex: 1, freshChats: false, start: false }, "r3", NOW + 1);
  assert.equal(parked.trigger.type, "draft");
  assert.equal(again.rerunOf, "r1");
  assert.equal(again.name, "8.11.26 MSJ (Run 2)", "the original was Run 1");
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
  // Step ONE. The point of a re-run is that it is quick: press it and the
  // matter goes again from the top. A workflow whose first step produces the
  // thing the rest of it works on says so itself, and its runs inherit that.
  assert.equal(d.stepIndex, 0);
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

test("runs are numbered the way you'd count them out loud", () => {
  const { run } = finishedRun();
  assert.equal(W.runNumber(run), 1, "the original is Run 1");

  const second = W.rerunOf(run, { stepIndex: 1 }, "r2", NOW + 1);
  assert.equal(second.name, "8.11.26 MSJ (Run 2)", "so its first re-run is Run 2");
  assert.equal(W.runNumber(second), 2);

  const done = Object.assign({}, second, { status: "done", allowRerun: true });
  const third = W.rerunOf(done, { stepIndex: 1 }, "r3", NOW + 2);
  assert.equal(third.name, "8.11.26 MSJ (Run 3)", "not “(Run 2) (Run 2)”");
  assert.equal(third.rerunCount, 2);
  assert.equal(W.runNumber(third), 3);

  // Runs made before this counted them the other way. Their suffix is stripped
  // too, so an old run still re-runs into a cleanly numbered name.
  const old = Object.assign({}, run, { name: "8.11.26 MSJ (re-run 1)", rerunCount: 1 });
  assert.equal(W.rerunOf(old, { stepIndex: 1 }, "r5", NOW + 4).name, "8.11.26 MSJ (Run 3)");

  // An unnamed run leans on the workflow it came from, as everywhere else.
  const bare = W.rerunOf(Object.assign({}, run, { name: "" }), { stepIndex: 1 }, "r4", NOW + 3);
  assert.equal(bare.name, "Tentative ruling (Run 2)");
});

test("a re-run's conversations are the originals' names with the run number", () => {
  const { run } = finishedRun();
  assert.equal(
    W.chatTitle(run, "Drafting (A)"),
    "8.11.26 MSJ: Drafting (A)",
    "the first run says nothing — there is nothing yet to tell it from"
  );

  const second = W.rerunOf(run, { stepIndex: 1, freshChats: true }, "r2", NOW + 1);
  assert.equal(
    W.chatTitle(second, "Drafting (A)"),
    "8.11.26 MSJ: Drafting (A) (Run 2)",
    "the same title as the original, and the number at the END so the two read together"
  );

  const done = Object.assign({}, second, { status: "done", allowRerun: true });
  const third = W.rerunOf(done, { stepIndex: 1, freshChats: true }, "r3", NOW + 2);
  assert.equal(W.chatTitle(third, "Drafting (A)"), "8.11.26 MSJ: Drafting (A) (Run 3)");

  // And when it has to be cut, the run number survives — it's what tells this
  // conversation from the one it repeats.
  const long = Object.assign({}, third, {
    name: "8.11.26 " + "Motion to Compel Arbitration and to Stay Proceedings ".repeat(3),
  });
  const cut = W.chatTitle(long, "Devil's advocate (B)");
  assert.ok(cut.length <= 100, cut.length);
  assert.ok(cut.endsWith("Devil's advocate (B) (Run 3)"), cut);
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
  const off = W.applyRunEdit(run, { allowRerun: false, bundleText: true }, NOW + 1);
  assert.equal(off.allowRerun, false, "turned off for this run without touching the workflow");
  assert.equal(off.bundleText, true);
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

  // An unnamed run's matter is WHEN it was made, then the workflow it's a run
  // of — the template's name alone is the same for every matter the workflow
  // ever runs, so it can't tell an untitled run's chats from the last one's.
  const bare = W.newRun(wf, "r2", NOW, { type: "draft" });
  assert.equal(
    W.chatTitle(bare, "Drafting (A)"),
    W.runStamp(bare) + " Tentative ruling: Drafting (A)"
  );

  // Missing halves don't produce dangling punctuation.
  assert.equal(W.chatTitle(run, ""), "8.11.26 Motion to Compel Arbitration");
  assert.equal(W.chatTitle({ name: "", templateName: "" }, "Drafting (A)"), "Drafting (A)");
});

test("an untitled run's chats are titled by its creation date and time", () => {
  // Local-time constructions, so the expected strings hold in any timezone.
  const afternoon = new Date(2026, 7, 18, 15, 42).getTime(); // Aug 18 2026, 3:42 PM
  assert.equal(W.runStamp({ createdAt: afternoon }), "8.18.26 3:42 PM");
  const morning = new Date(2026, 0, 5, 0, 7).getTime(); // Jan 5 2026, 12:07 AM
  assert.equal(W.runStamp({ createdAt: morning }), "1.5.26 12:07 AM");
  const noon = new Date(2026, 11, 31, 12, 0).getTime();
  assert.equal(W.runStamp({ createdAt: noon }), "12.31.26 12:00 PM");
  // No creation time recorded (a hand-built or ancient run): no stamp, and
  // chatTitle falls back to the template's name as it always did.
  assert.equal(W.runStamp({}), "");
  assert.equal(W.runStamp({ createdAt: "soon" }), "");

  const untitled = { name: "", templateName: "Tentative ruling", createdAt: afternoon };
  assert.equal(
    W.chatTitle(untitled, "Drafting (A)"),
    "8.18.26 3:42 PM Tentative ruling: Drafting (A)"
  );
  // No template either: the stamp does the whole job rather than leaving the
  // conversation untitled.
  assert.equal(
    W.chatTitle({ name: "", templateName: "", createdAt: afternoon }, "Drafting (A)"),
    "8.18.26 3:42 PM: Drafting (A)"
  );
  // A named run never carries the stamp — its name is the matter.
  assert.equal(
    W.chatTitle({ name: "8.11.26 MSJ", templateName: "T", createdAt: afternoon }, "Drafting (A)"),
    "8.11.26 MSJ: Drafting (A)"
  );
});

test("a run's tab group and its group label are named for the case folder", () => {
  // The same order P.keyTitle uses. A key picked out of a case folder carries
  // that folder's name, and it is what the run is named after too — so the tab
  // group, the runs list and the key picker all read as one matter.
  const keys = {
    k1: { folder: "23STCV12345 Smith", hint: "SMITH", name: "pseudonym_key.xlsx" },
    k2: { hint: "RASHO", name: "pseudonym_key.xlsx" },
  };
  assert.equal(W.tabGroupTitle({ pseudoKeyId: "k1", name: "8.11.26 MSJ" }, keys), "23STCV12345 Smith");
  assert.equal(W.tabGroupTitle({ pseudoKeyId: "k2", name: "8.11.26 MSJ" }, keys), "RASHO");
  assert.equal(W.tabGroupTitle({ name: "8.11.26 MSJ" }, keys), "8.11.26 MSJ");
  const runs = [{ id: "r1", pseudoKeyId: "k1", name: "8.11.26 MSJ", createdAt: 1 }];
  assert.equal(W.groupLabel({ runIds: ["r1"] }, runs, keys), "23STCV12345 Smith");
});

test("titleNames is every name that can reach a chat title", () => {
  // What the case-number gate reads: the matter's own name, the template's
  // (which stands in for the matter on a run nobody named) and each chat's.
  const run = { name: "8.11.26 MSJ", templateName: "Tentative ruling" };
  const src = { chats: [{ name: "Drafting" }, { name: "Devil's advocate" }, { name: "Drafting" }] };
  assert.deepEqual(W.titleNames(run, src), [
    "8.11.26 MSJ",
    "Tentative ruling",
    "Drafting",
    "Devil's advocate",
  ]);
  // Blanks and duplicates say nothing, so they aren't there.
  assert.deepEqual(W.titleNames({ name: "  ", templateName: "T" }, { chats: [{ name: "T" }] }), ["T"]);
  assert.deepEqual(W.titleNames(null, null), []);
});

test("a matter with a pseudonym key is titled in the FAKE name", () => {
  // The title is the one thing a run sends that the pseudonymization never
  // scrubbed: claude.ai stores it, shows it in the sidebar and syncs it. The
  // cleaner comes from the run's key (P.nameCleaner); here it stands in for it.
  const clean = (t) => String(t).replace(/Rasho/g, "Strangeways");
  assert.equal(
    W.chatTitle({ name: "8.11.26 Rasho MSJ" }, "Drafting (A)", clean),
    "8.11.26 Strangeways MSJ: Drafting (A)"
  );
  // The chat's own name goes through it too — a step named for a party is as
  // much of a leak as the matter is.
  assert.equal(
    W.chatTitle({ name: "8.11.26 MSJ" }, "Rasho depo (B)", clean),
    "8.11.26 MSJ: Strangeways depo (B)"
  );
  // No cleaner passed is the old behaviour exactly — a matter with no key.
  assert.equal(
    W.chatTitle({ name: "8.11.26 Rasho MSJ" }, "Drafting (A)"),
    "8.11.26 Rasho MSJ: Drafting (A)"
  );
  // And an unnamed run's stamp-and-template fallback is cleaned as well: the
  // template's resting name is the operator's to type, party name and all.
  const afternoon = new Date(2026, 7, 18, 15, 42).getTime();
  assert.equal(
    W.chatTitle({ name: "", templateName: "Rasho tentative", createdAt: afternoon }, "Drafting (A)", clean),
    "8.18.26 3:42 PM Strangeways tentative: Drafting (A)"
  );
});

test("the title is cleaned BEFORE it is cut to fit", () => {
  // The fakes are a different length from the reals, so a title trimmed to fit
  // the real name fits the fake one badly — and a cut made first can leave half
  // a real name standing where the swap can no longer find it.
  const chat = "Devil's advocate (B)";
  const long = "8.11.26 Rasho " + "Motion to Compel Arbitration and to Stay Proceedings ".repeat(3);
  const clean = (t) => String(t).replace(/Rasho/g, "Strangeways");
  const title = W.chatTitle({ name: long }, chat, clean);
  assert.ok(title.length <= 100, "fits: " + title.length);
  assert.ok(!/Rasho/.test(title), "no part of the real name survives: " + title);
  assert.ok(title.startsWith("8.11.26 Strangeways Motion to Compel"), title);
  assert.ok(title.endsWith(": " + chat), "the chat's own name still survives whole");
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

// ---- the settings, their defaults, and their journey to the run ------------

test("combining documents and offering a re-run are on unless turned off", () => {
  const fresh = W.newWorkflow({ name: "x" }, "w", NOW);
  assert.equal(fresh.bundleText, true, "one labelled file beats twenty attachments");
  assert.equal(fresh.allowRerun, true);
  assert.equal(fresh.nameChats, true);
  // A decision to the contrary is still a decision.
  const off = W.newWorkflow({ name: "x", bundleText: false, allowRerun: false }, "w", NOW);
  assert.equal(off.bundleText, false);
  assert.equal(off.allowRerun, false);
  // And the switch that went away, replaced by the extension's own file saver,
  // is not carried around any more.
  assert.equal("downloadFiles" in fresh, false);
});

test("every switch a workflow carries reaches its run", () => {
  // The point of this test is the loop: a setting added to a workflow and
  // forgotten in newRun is a run quietly doing something other than what the
  // template you set up says.
  const SWITCHES = ["bundleText", "nameChats", "allowRerun"];
  for (const value of [true, false]) {
    const fields = { name: "x", chats: [{ id: "a", name: "A" }], steps: [{ chatId: "a", prompt: "go" }] };
    for (const k of SWITCHES) fields[k] = value;
    const wf = W.newWorkflow(fields, "w", NOW);
    const run = W.newRun(wf, "r", NOW, { type: "now" }, wf.docs);
    for (const k of SWITCHES) assert.equal(run[k], value, k + " should have travelled as " + value);
  }
  // A run made with no workflow at all still lands on the defaults rather than
  // on false — "nothing said" is not "turned off".
  const bare = W.newRun(null, "r", NOW, { type: "now" }, []);
  assert.equal(bare.bundleText, true);
  assert.equal(bare.allowRerun, true);
});

test("a finished run offers a re-run unless it was told not to", () => {
  const done = { status: "done" };
  assert.equal(W.canRerun(Object.assign({}, done, { allowRerun: true })), true);
  assert.equal(W.canRerun(Object.assign({}, done, { allowRerun: false })), false);
  // A run stored before the switch existed said nothing, which now reads as yes.
  assert.equal(W.canRerun(done), true);
  assert.equal(W.canRerun({ status: "running", allowRerun: true }), false);
});

test("an older workflow is carried into the new shape once", () => {
  const old = {
    id: "w",
    name: "x",
    // The old defaults, written down — not decisions.
    bundleText: false,
    allowRerun: false,
    downloadFiles: true,
    chats: [
      { id: "a", name: "Drafting", expectsRuling: true, outputMarker: "CONCLUSION" },
      { id: "b", name: "Critic" },
    ],
    steps: [
      { id: "s1", chatId: "a", prompt: "draft" },
      { id: "s2", chatId: "b", prompt: "attack" },
      { id: "s3", chatId: "a", prompt: "revise" },
    ],
  };
  const moved = W.migrateSettings(old);
  assert.equal(moved.bundleText, true);
  assert.equal(moved.allowRerun, true);
  assert.equal("downloadFiles" in moved, false);
  // The marker moves onto every step of the chat that carried it — that is what
  // the chat-level setting meant. Narrowing it to particular steps is the point
  // of the move, and is the user's to do.
  assert.deepEqual(
    moved.steps.map((s) => [s.id, !!s.expectsRuling, s.outputMarker || null]),
    [["s1", true, "CONCLUSION"], ["s2", false, null], ["s3", true, "CONCLUSION"]]
  );
  assert.equal("expectsRuling" in moved.chats[0], false, "and off the chat, which no longer holds it");

  // Once. After this a `false` is a decision, and is left alone.
  const again = W.migrateSettings(Object.assign({}, moved, { bundleText: false }));
  assert.equal(again.bundleText, false);
  assert.equal(W.migrateSettings(moved), moved, "nothing to do is nothing done");
});

test("a run already under way is carried over more carefully", () => {
  const run = {
    id: "r",
    status: "running",
    allowRerun: false,
    downloadFiles: true,
    bundleText: false,
    plan: {
      chats: [{ id: "a", name: "Drafting", expectsRuling: true }],
      steps: [{ id: "s1", chatId: "a", prompt: "draft" }],
    },
  };
  const moved = W.migrateRunSettings(run);
  assert.equal(moved.plan.steps[0].expectsRuling, true, "the marker still has to travel");
  assert.equal(moved.plan.steps[0].outputMarker, W.DEFAULT_OUTPUT_MARKER);
  assert.equal(moved.allowRerun, true);
  assert.equal("downloadFiles" in moved, false);
  // ...but NOT bundleText: a run's documents are bundled once, when it starts,
  // and changing the answer under one already in flight would decide something
  // it has already done.
  assert.equal(moved.bundleText, false);
});

test("a pause is a decision about the run, not about the tab it was pressed in", () => {
  // One definition, asked by every page a run is driving and at every point a
  // step could stand down. A wave is three conversations working at once, and
  // leaving the other two to finish is two long answers paid for and discarded.
  assert.equal(W.runHalted({ status: "running" }), null);
  assert.equal(W.runHalted({ status: "paused" }), "paused");
  assert.equal(W.runHalted({ status: "canceled" }), "canceled");
  // A run that has gone from storage isn't a run any step should keep driving.
  assert.equal(W.runHalted(null), "gone");
  assert.equal(W.runHalted(undefined), "gone");
  // Everything else carries on: waiting out an outage and finishing are not
  // reasons for a step in flight to drop what it is doing.
  assert.equal(W.runHalted({ status: "waiting" }), null);
  assert.equal(W.runHalted({ status: "done" }), null);
  assert.equal(W.runHalted({ status: "pending" }), null);
});

// ---- a pause built into the workflow ---------------------------------------

function pausedWorkflow(mins) {
  return W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      steps: [
        { chatId: "a", prompt: "draft" },
        { kind: "pause", pauseMinutes: mins },
        { chatId: "b", prompt: "attack" },
      ],
    },
    "w",
    NOW
  );
}

test("a pause step is a gate, not a conversation", () => {
  const wf = pausedWorkflow(0);
  const gate = wf.steps[1];
  assert.equal(W.isPauseStep(gate), true);
  assert.equal(gate.chatId, null, "a gate in a chat would put a stop inside a conversation");
  assert.equal(gate.carry, false);
  const plan = W.planRun(wf);
  assert.equal(plan[1].kind, "pause");
  assert.equal(plan[1].handsOn, false);
  assert.deepEqual(plan[1].docIds, []);
  assert.equal(plan[1].parallel, false);
});

test("a pause doesn't swallow the hand-off it sits in the middle of", () => {
  // Step 1 drafts in A, a pause, then B attacks. B still carries A's reply, and
  // A still has to produce something worth carrying.
  const plan = W.planRun(pausedWorkflow(0));
  assert.equal(plan[0].handsOn, true, "the step after the pause is in another chat");
  assert.equal(plan[2].carry, true, "and it carries, the pause notwithstanding");
});

test("two steps in one chat still don't carry across a pause between them", () => {
  const wf = W.newWorkflow(
    {
      name: "x",
      chats: [{ id: "a", name: "A" }],
      steps: [
        { chatId: "a", prompt: "draft" },
        { kind: "pause", pauseMinutes: 30 },
        { chatId: "a", prompt: "revise" },
      ],
    },
    "w",
    NOW
  );
  const plan = W.planRun(wf);
  assert.equal(plan[2].carry, false, "that conversation already has it");
  assert.equal(plan[0].handsOn, false, "so nothing is pasted between them");
});

test("a pause is either indefinite or a number of minutes", () => {
  assert.equal(W.pauseMinutes(0), 0, "indefinite — waits for you");
  assert.equal(W.pauseMinutes(-10), 0);
  assert.equal(W.pauseMinutes(null), 0);
  assert.equal(W.pauseMinutes("45"), 45);
  assert.equal(W.pauseMinutes(45.7), 45);
  assert.equal(W.pauseMinutes(1e9), W.PAUSE_MAX_MINUTES, "past a week, Not yet is the answer");
});

test("a run stopped by a pause step steps past it first", () => {
  // The gate has happened, the way any step has happened once it is done — so
  // Resume, yours or the clock's, carries on with what follows rather than
  // stopping on the same gate again.
  const run = { id: "r", status: "running", stepIndex: 1, totalSteps: 3 };
  const at = NOW + 30 * 60000;
  const held = W.markPausedForStep(Object.assign({}, run, { stepIndex: 2 }), NOW, at);
  assert.equal(held.status, "paused");
  assert.equal(held.stepIndex, 2);
  assert.equal(held.resumeAt, at);
  assert.equal(held.pausedByStep, true);
  assert.equal(held.resumeOnUsage, false, "it is waiting on a clock, not on the meter");
  // Indefinite: no time on it at all, so nothing but Resume lifts it.
  assert.equal(W.markPausedForStep(run, NOW, null).resumeAt, null);
});

test("the clock lifts a timed pause, and only once it is due", () => {
  const soon = { id: "a", status: "paused", resumeAt: NOW + 1000 };
  const due = { id: "b", status: "paused", resumeAt: NOW - 1 };
  const forever = { id: "c", status: "paused" };
  const meter = { id: "d", status: "paused", resumeOnUsage: true, resumeAt: NOW - 1 };
  const runs = [soon, due, forever, meter];
  assert.deepEqual(W.clockWaitingRuns(runs, NOW).map((r) => r.id), ["b"]);
  // A run waiting on the METER is not this — it is asked of the reading, not
  // of the clock, and lifting it here would send it into an empty window.
  assert.equal(W.clockWaitingRuns(runs, NOW).some((r) => r.id === "d"), false);
  // The alarm is set by whichever is due first, and an indefinite pause sets no
  // alarm at all.
  assert.equal(W.nextClockResume(runs, NOW), NOW + 1000);
  assert.equal(W.nextClockResume([forever], NOW), null);
  assert.equal(W.nextClockResume([], NOW), null);
});

test("stillness only settles a turn if we watched it become still", () => {
  const base = {
    text: "a finished-looking reply",
    generating: false,
    unchangedMs: 60000,
    stablePolls: 9,
    streamDone: false,
    streamOpen: false,
  };
  // Watched: the text moved, or a turn mounted, while we were looking.
  assert.equal(W.settleReason(Object.assign({}, base, { watched: true })), "stable");
  // Not watched: it was already there when we arrived and never moved. That is
  // the PREVIOUS answer sitting where it always was — and taking it is how a
  // run restarted at an earlier step walks through the rest of itself in
  // seconds, collecting each stale reply in turn.
  assert.equal(W.settleReason(Object.assign({}, base, { watched: false })), null);
  // Said nothing: unchanged, since every other caller of this means "stable".
  assert.equal(W.settleReason(base), "stable");
  // The stream outranks all of it. A stream that closed after this message went
  // out is proof the turn happened, whether or not we saw the text move.
  assert.equal(
    W.settleReason(Object.assign({}, base, { watched: false, streamDone: true, unchangedMs: 2000 })),
    "stream"
  );
  // And a stalled turn is still judged on its own terms.
  assert.equal(
    W.settleReason(
      Object.assign({}, base, { watched: false, generating: true, unchangedMs: 20 * 60000 })
    ),
    "stalled"
  );
});

// ---- Which model a step runs on, and waiting out an outage -----------------

function modelWorkflow() {
  return W.newWorkflow(
    {
      name: "Models",
      chats: [
        { id: "a", name: "Drafting", model: "Opus 4.5" },
        { id: "b", name: "Critic" },
      ],
      steps: [
        { id: "s1", chatId: "a", prompt: "draft" },
        { id: "s2", chatId: "a", prompt: "again", model: "Sonnet 5" },
        { id: "s3", chatId: "b", prompt: "criticise" },
      ],
    },
    "w1",
    NOW
  );
}

test("stepModel: the step's own model, then the chat's, then your default", () => {
  const wf = modelWorkflow();
  const run = W.newRun(wf, "r1", NOW);
  const at = (i) => W.stepModel(Object.assign({}, run, { stepIndex: i }), wf, "Opus 5");
  assert.equal(at(0), "Opus 4.5"); // the chat's
  assert.equal(at(1), "Sonnet 5"); // the step's, overriding it
  assert.equal(at(2), "Opus 5"); // a chat that names none — your default
});

test("stepModel: a chat stays on the model a step switched it to", () => {
  const wf = modelWorkflow();
  wf.steps.push({ id: "s4", chatId: "a", prompt: "and again" });
  const run = W.newRun(wf, "r1", NOW);
  assert.equal(W.stepModel(Object.assign({}, run, { stepIndex: 3 }), wf, "Opus 5"), "Sonnet 5");
});

test("stepModel falls back to nothing when there is no default either", () => {
  const wf = modelWorkflow();
  const run = W.newRun(wf, "r1", NOW);
  assert.equal(W.stepModel(Object.assign({}, run, { stepIndex: 2 }), wf, ""), null);
  // Past the end of the plan there is no step to ask about.
  assert.equal(W.stepModel(Object.assign({}, run, { stepIndex: 9 }), wf, "Opus 5"), "Opus 5");
});

test("waiting out an outage is opt-out, and the answer travels to the run", () => {
  const patient = W.newWorkflow({ name: "x", chats: [{ id: "a" }] }, "w1", NOW);
  assert.equal(patient.ignoreOutage, false);
  assert.equal(W.ignoresOutage(W.newRun(patient, "r1", NOW)), false);

  const impatient = W.newWorkflow(
    { name: "x", chats: [{ id: "a" }], ignoreOutage: true },
    "w2",
    NOW
  );
  assert.equal(impatient.ignoreOutage, true);
  assert.equal(W.ignoresOutage(W.newRun(impatient, "r2", NOW)), true);
  assert.equal(W.ignoresOutage(null), false);
});

test("Go anyway is remembered on the run, and only on that run", () => {
  const wf = W.newWorkflow({ name: "x", chats: [{ id: "a" }] }, "w1", NOW);
  const run = W.newRun(wf, "r1", NOW);
  const going = W.applyRunEdit(run, { ignoreOutage: true }, NOW);
  assert.equal(W.ignoresOutage(going), true);
  assert.equal(wf.ignoreOutage, false);
  // ...and can be taken back.
  assert.equal(W.ignoresOutage(W.applyRunEdit(going, { ignoreOutage: false }, NOW)), false);
});

test("a re-run inherits the run's outage answer, not the workflow's", () => {
  const wf = W.newWorkflow({ name: "x", chats: [{ id: "a" }], steps: [{ chatId: "a", prompt: "go" }] }, "w1", NOW);
  const run = Object.assign({}, W.newRun(wf, "r1", NOW), { status: "done", ignoreOutage: true });
  const again = W.rerunOf(run, { stepIndex: 0 }, "r2", NOW + 1);
  assert.equal(W.ignoresOutage(again), true);
});

// ---- the marker is the ruling's first line, not its last -------------------

test("a reply that matches the marker still has to hold still", () => {
  const quiet = 60000;
  // Still being written — the marker is the heading, and everything under it
  // is yet to arrive.
  assert.equal(W.rulingReady({ generating: true, unchangedMs: quiet * 2 }), false);
  assert.equal(
    W.rulingReady({ streamOpen: true, unchangedMs: quiet * 2 }),
    false,
    "a completion stream open for this turn settles it, whatever the text is doing"
  );
  // Idle, but only just — a ruling that pauses to verify a citation looks
  // exactly like this, and taking it here is taking a fragment.
  assert.equal(W.rulingReady({ unchangedMs: 5000 }), false);
  assert.equal(W.rulingReady({ unchangedMs: quiet - 1 }), false);
  assert.equal(W.rulingReady({ unchangedMs: quiet }), true);
  assert.equal(W.rulingReady({ unchangedMs: quiet * 3 }), true);
  // A caller may shorten it, which is how the tests above run in a second.
  assert.equal(W.rulingReady({ unchangedMs: 40, quietMs: 30 }), true);
  assert.equal(W.rulingReady({}), false, "nothing observed is not the same as quiet");
});

test("the quiet window is much longer than an ordinary settle", () => {
  // Being early costs a whole run; being late costs a minute.
  assert.ok(W.RULING_QUIET_MS >= 30000, "generous on purpose");
});

test("the page's own thinking and tool captions are not a reply", () => {
  // What the page shows while a skill runs. This IS the whole of the turn's
  // text for as long as the call takes, and it holds perfectly still.
  assert.equal(W.isToolChatter("Used a skill"), true);
  assert.equal(W.isToolChatter("Ran skill: record-verification"), true);
  assert.equal(W.isToolChatter("Thinking"), true);
  assert.equal(W.isToolChatter("Thought for 12s"), true);
  assert.equal(W.isToolChatter("Show thinking"), true);
  assert.equal(W.isToolChatter("Searched the web"), true);
  // The page glues them together with nothing in between — which is how they
  // were read off a live turn, and why they are matched rather than split.
  assert.equal(W.isToolChatter("Used a skillRan skill: record-verification"), true);
  assert.equal(
    W.isToolChatter("ThinkingUsed a skillRan skill: record-verificationThought for 3m"),
    true
  );
  // A counter or a separator hanging off one of them is still furniture.
  assert.equal(W.isToolChatter("Ran skill: record-verification · 3 steps"), true);

  // Prose is not, however much of the vocabulary it happens to use.
  assert.equal(
    W.isToolChatter("I ran skill: record-verification and two of the cites do not check out."),
    false
  );
  assert.equal(
    W.isToolChatter("Which exhibit did you mean? I don't see Exhibit C with the declaration."),
    false
  );
  assert.equal(
    W.isToolChatter("NATURE OF PROCEEDINGS\n\nPlaintiff moves to compel further responses."),
    false
  );
  // Nothing at all is not furniture — it is nothing, and the callers say so
  // themselves.
  assert.equal(W.isToolChatter(""), false);
  assert.equal(W.isToolChatter("   "), false);
  assert.equal(W.isToolChatter(null), false);
});

test("a turn cannot settle on the page's furniture, however long it sits there", () => {
  const chatter = "Used a skillRan skill: record-verification";
  // Every settle branch there is, handed the strongest evidence each one takes.
  assert.equal(
    W.settleReason({ text: chatter, streamDone: true, unchangedMs: 600000, watched: true }),
    null,
    "a stream that closed for a tool call must not release a caption"
  );
  assert.equal(
    W.settleReason({
      text: chatter,
      unchangedMs: 600000,
      stablePolls: 99,
      watched: true,
    }),
    null
  );
  assert.equal(
    W.settleReason({ text: chatter, generating: true, unchangedMs: 60 * 60000, watched: true }),
    null
  );
  // The same evidence, over a real reply, does settle — so it is the caption
  // being refused, not the sample.
  assert.equal(
    W.settleReason({ text: "a real answer", streamDone: true, unchangedMs: 600000, watched: true }),
    "stream"
  );
});

test("a reply is not told to carry on until it has stopped", () => {
  const quiet = W.NUDGE_QUIET_MS;
  const ask = "Which exhibit did you mean?";
  // Furniture is never nudged: the turn behind it is still running.
  assert.equal(W.nudgeReady({ text: "Ran skill: record-verification", unchangedMs: quiet * 3 }), false);
  assert.equal(W.nudgeReady({ text: "", unchangedMs: quiet * 3 }), false);
  // A real reply that isn't the ruling still has to hold still first — a turn
  // gone quiet for a tool reads exactly like one that has ended.
  assert.equal(W.nudgeReady({ text: ask, unchangedMs: 6000 }), false);
  assert.equal(W.nudgeReady({ text: ask, unchangedMs: quiet - 1 }), false);
  assert.equal(W.nudgeReady({ text: ask, unchangedMs: quiet }), true);
  assert.equal(W.nudgeReady({ text: ask, generating: true, unchangedMs: quiet * 3 }), false);
  assert.equal(W.nudgeReady({ text: ask, streamOpen: true, unchangedMs: quiet * 3 }), false);
  assert.equal(W.nudgeReady({}), false);
  // A caller may shorten the window, which is how these run in a second.
  assert.equal(W.nudgeReady({ text: ask, unchangedMs: 40, quietMs: 30 }), true);
  // As generous as the window a matching reply must prove, for the same reason.
  assert.ok(W.NUDGE_QUIET_MS >= 30000, "being early spends a turn interrupting live work");
});

test("the continue prompt asks for the whole thing, and names the marker", () => {
  const p = W.continuePrompt("NATURE OF PROCEEDINGS");
  assert.ok(/^Continue from exactly where you stopped/.test(p));
  assert.ok(p.indexOf("NATURE OF PROCEEDINGS") !== -1);
  assert.ok(/not a summary/.test(p), "the failure mode being guarded is a précis of the ruling");
  // A step with its own marker gets its own marker back.
  assert.ok(W.continuePrompt("CONCLUSION").indexOf("CONCLUSION") !== -1);
  // And one with none falls back rather than asking for “”.
  assert.ok(W.continuePrompt("").indexOf(W.DEFAULT_OUTPUT_MARKER) !== -1);
  assert.ok(W.continuePrompt(null).indexOf(W.DEFAULT_OUTPUT_MARKER) !== -1);
});

test("the ruling gate reaches workflows that already exist, and runs already going", () => {
  // Nothing about the gate is stored. It is computed from the plan every time a
  // step is dispatched, which is what makes a change to the rule apply to a
  // workflow saved months ago — and to a run paused halfway through one — with
  // no migration and no re-creating anything.
  //
  // The old shape: the marker on the CHAT, and two steps in that one chat. Under
  // the rule this replaces, neither step was gated (nothing was pasted between
  // them, and the second handed nowhere). Both are gated now.
  const old = {
    id: "w",
    name: "Tentative ruling",
    chats: [{ id: "a", name: "Drafting", expectsRuling: true }],
    steps: [
      { id: "s1", chatId: "a", prompt: "draft" },
      { id: "s2", chatId: "a", prompt: "revise it" },
    ],
  };
  const plan = W.planRun(W.migrateSettings(old));
  assert.deepEqual(
    plan.map((s) => s.marker),
    [W.DEFAULT_OUTPUT_MARKER, W.DEFAULT_OUTPUT_MARKER],
    "both steps, though neither hands anything over"
  );

  // And a run in flight, planned from its own stored copy rather than the
  // template's — including one sitting at its second step.
  const run = W.migrateRunSettings({
    id: "r",
    status: "paused",
    stepIndex: 1,
    plan: {
      chats: [{ id: "a", name: "Drafting", expectsRuling: true }],
      steps: [
        { id: "s1", chatId: "a", prompt: "draft" },
        { id: "s2", chatId: "a", prompt: "revise it" },
      ],
    },
  });
  const running = W.planRun(W.runSource(run, null));
  assert.equal(running[run.stepIndex].marker, W.DEFAULT_OUTPUT_MARKER);
});

// ---- cowork ---------------------------------------------------------------

function coworkWorkflow() {
  return W.newWorkflow(
    {
      name: "Cowork",
      chats: [
        { id: "a", name: "Research", surface: "cowork" },
        { id: "b", name: "Drafting", surface: "cowork" },
      ],
      steps: [
        { id: "s1", chatId: "a", prompt: "dig" },
        { id: "s2", chatId: "a", prompt: "dig more" },
        { id: "s3", chatId: "b", prompt: "write it" },
        { id: "s4", chatId: "b", prompt: "check it" },
      ],
    },
    idgen("c"),
    NOW
  );
}

test("a chat's surface survives newChatSlot from either shape", () => {
  const wf = coworkWorkflow();
  assert.equal(wf.chats[0].target.surface, "cowork");
  // And from an already-nested target, which is how a saved workflow comes back.
  const again = W.newWorkflow({ chats: [{ id: "a", target: { surface: "cowork" } }] }, idgen("d"), NOW);
  assert.equal(again.chats[0].target.surface, "cowork");
});

test("a workflow that says nothing about the surface still says nothing", () => {
  const wf = twoChatWorkflow();
  assert.equal(wf.chats[0].target.surface, null);
});

test("the approval mode is not the extension's business, at any level", () => {
  // It is sticky — a new tab comes up on whatever was last chosen by hand — so
  // there is nothing to carry and nothing to set, however a stored workflow
  // (or one saved before this) spells it.
  const wf = W.newWorkflow(
    {
      chats: [{ id: "a", name: "A", surface: "cowork", approval: "skip" }],
      steps: [{ id: "s1", chatId: "a", prompt: "go", approval: "manual" }],
    },
    idgen("v"),
    NOW
  );
  assert.equal(wf.chats[0].approval, undefined);
  assert.equal(wf.steps[0].approval, undefined);
  const plan = W.planRun(wf);
  assert.equal(plan[0].approval, undefined);
  assert.equal(plan[0].approvalOn, undefined);
});

test("every step carries its chat's surface, so a resumed run lands right way up", () => {
  const plan = W.planRun(coworkWorkflow());
  assert.deepEqual(plan.map((p) => p.surface), ["cowork", "cowork", "cowork", "cowork"]);
});

test("a pause step has no surface to set", () => {
  const wf = W.newWorkflow(
    {
      chats: [{ id: "a", name: "A", surface: "cowork" }],
      steps: [
        { id: "s1", chatId: "a", prompt: "go" },
        { id: "s2", kind: "pause", pauseMinutes: 0 },
        { id: "s3", chatId: "a", prompt: "on" },
      ],
    },
    idgen("p"),
    NOW
  );
  const plan = W.planRun(wf);
  const pause = plan.find((p) => p.kind === "pause");
  assert.equal(pause.surface, null);
});

test("a run paused under the old build resumes with no approvals to worry about", () => {
  // Exactly the shape storage still holds: a plan snapshotted when chats and
  // steps carried an approval mode. Nothing re-normalises a started run, so
  // runSource is the door it comes back through — and it drops the field for
  // the planner, the run editor and everything else that walks these steps.
  const run = {
    id: "r-old",
    stepIndex: 1,
    status: "waiting",
    docs: [],
    plan: {
      chats: [{ id: "a", name: "Research", target: { surface: "cowork" }, approval: "skip" }],
      steps: [
        { id: "s1", chatId: "a", prompt: "dig", approval: "skip" },
        { id: "s2", chatId: "a", prompt: "write", approval: "manual" },
      ],
    },
  };
  const src = W.runSource(run, null);
  for (const c of src.chats) assert.equal("approval" in c, false);
  for (const s of src.steps) assert.equal("approval" in s, false);
  const plan = W.planRun(src);
  assert.equal(plan[0].approval, undefined);
  assert.equal(plan[1].approvalOn, undefined);
  // The surface still travels — only the retired field went.
  assert.deepEqual(plan.map((p) => p.surface), ["cowork", "cowork"]);
  // And the stored run itself is left as it was; the scrub is on the way out.
  assert.equal(run.plan.steps[0].approval, "skip");
});

test("a template last saved under the old build is scrubbed on the same door", () => {
  const wf = {
    chats: [{ id: "a", name: "A", target: { surface: "cowork" }, approval: "manual" }],
    steps: [{ id: "s1", chatId: "a", prompt: "go", approval: "skip" }],
    docs: [],
  };
  const src = W.runSource({ id: "r", docs: [] }, wf);
  assert.equal("approval" in src.chats[0], false);
  assert.equal("approval" in src.steps[0], false);
});

test("a re-run of an old run carries no approvals into the new template", () => {
  const run = {
    id: "r-old",
    name: "Smith v. Jones",
    docs: [],
    plan: {
      chats: [{ id: "a", name: "A", target: { surface: "cowork" }, approval: "skip" }],
      steps: [{ id: "s1", chatId: "a", prompt: "go", approval: "skip" }],
    },
  };
  const wf = W.workflowFromRun(run, null, "w-new", NOW, idgen("n"));
  assert.equal(wf.chats[0].approval, undefined);
  assert.equal(wf.steps[0].approval, undefined);
  assert.equal(wf.chats[0].target.surface, "cowork");
});

test("a run takes its own copy of the surface", () => {
  const wf = coworkWorkflow();
  const run = W.newRun(wf, "r1", NOW, { type: "now" }, []);
  assert.equal(run.plan.chats[0].target.surface, "cowork");
  // Editing the template afterwards must not reach the run.
  wf.chats[0].target.surface = "chat";
  assert.equal(run.plan.chats[0].target.surface, "cowork");
});

test("a cowork session id is a conversation id even though it isn't a uuid", () => {
  assert.equal(
    W.conversationId("/cowork/cse_011f5HCzaWWJ2hm19v6NuQmN"),
    "cse_011f5HCzaWWJ2hm19v6NuQmN"
  );
  assert.equal(
    W.conversationId("https://claude.ai/cowork/cse_011f5HCzaWWJ2hm19v6NuQmN"),
    "cse_011f5HCzaWWJ2hm19v6NuQmN"
  );
  // A project address still resolves to the project, as it did before.
  const proj = "019f3fcd-9b35-7715-b2cc-b227512b5459";
  assert.equal(W.conversationId("/cowork/project/" + proj), proj);
});

test("a cowork address still counts as a claude.ai conversation link", () => {
  assert.equal(W.looksLikeChatUrl("https://claude.ai/cowork/cse_011f5HCzaWWJ2hm19v6NuQmN"), true);
});

// ---- a window of its own --------------------------------------------------

test("a run opens in the window you already have, unless asked otherwise", () => {
  // Off is the plain reading: a run puts tabs behind what you are doing, and a
  // second window is something to find, move and close rather than something
  // you asked for.
  assert.equal(W.newWorkflow({ name: "x" }, idgen("w"), NOW).newWindow, false);
  assert.equal(W.newWorkflow({ name: "x", newWindow: true }, idgen("w"), NOW).newWindow, true);
});

test("the window switch travels to the run, like every other switch", () => {
  const wf = W.newWorkflow({ name: "x", newWindow: true }, idgen("w"), NOW);
  assert.equal(W.newRun(wf, "r1", NOW, { type: "now" }, []).newWindow, true);
  const plain = W.newWorkflow({ name: "y" }, idgen("w"), NOW);
  assert.equal(W.newRun(plain, "r2", NOW, { type: "now" }, []).newWindow, false);
});

test("a run's copy is its own, so changing it doesn't reach the template", () => {
  const wf = W.newWorkflow({ name: "x", newWindow: true }, idgen("w"), NOW);
  const run = W.newRun(wf, "r1", NOW, { type: "now" }, []);
  run.newWindow = false;
  assert.equal(wf.newWindow, true);
});

test("a workflow saved before this switch existed reads as off", () => {
  // Nothing to migrate: the field is falsy by default, and falsy is the
  // behaviour asked for.
  const old = W.newWorkflow({ name: "x" }, idgen("w"), NOW);
  delete old.newWindow;
  assert.equal(W.newRun(old, "r1", NOW, { type: "now" }, []).newWindow, false);
});

// ---- which stream is this conversation's ----------------------------------

test("chat and code completion urls are recognised as they always were", () => {
  const at = "/chat/019f3fcd-9b35-7715-b2cc-b227512b5459";
  assert.equal(W.looksLikeCompletionUrl("/api/.../completion", at), true);
  assert.equal(W.looksLikeCompletionUrl("/api/organizations/x/retry", at), true);
  assert.equal(W.looksLikeCompletionUrl("/api/messages?beta=true", at), true);
});

test("a cowork stream is recognised by naming this very session", () => {
  // Cowork's completion address carries none of those words, so a run fell back
  // to watching the text hold still — slower, and a weaker claim than the
  // network's. The session id is the narrower test, not the looser one.
  const at = "/cowork/cse_011f5HCzaWWJ2hm19v6NuQmN";
  assert.equal(
    W.looksLikeCompletionUrl("/api/organizations/x/conversations/cse_011f5HCzaWWJ2hm19v6NuQmN/x", at),
    true
  );
});

test("another session's stream is not this one's", () => {
  const at = "/cowork/cse_011f5HCzaWWJ2hm19v6NuQmN";
  assert.equal(W.looksLikeCompletionUrl("/api/organizations/x/conversations/cse_OTHER/x", at), false);
  assert.equal(W.looksLikeCompletionUrl("/api/event_logging/v2/batch", at), false);
  assert.equal(W.looksLikeCompletionUrl("/api/telemetry", at), false);
});

test("off a cowork page the session arm never fires, and nothing is guessed", () => {
  assert.equal(W.looksLikeCompletionUrl("/api/organizations/x/anything", "/new"), false);
  assert.equal(W.looksLikeCompletionUrl("", "/cowork/cse_01Ab"), false);
  assert.equal(W.looksLikeCompletionUrl(null, null), false);
});

// ---- settling where the network says nothing -------------------------------

test("six seconds of stillness settles a turn where a stream was seen", () => {
  const s = {
    text: "an answer",
    watched: true,
    unchangedMs: 6000,
    stablePolls: 3,
  };
  assert.equal(W.settleReason(s), "stable");
});

test("...and does not, where the surface shows no network signal at all", () => {
  // Cowork. The open stream is what proves a tool-call pause isn't a finished
  // answer, and there is no stream — so stillness is the whole argument and
  // six seconds is not much of one.
  const s = {
    text: "an answer",
    watched: true,
    unchangedMs: 6000,
    stablePolls: 3,
    noNetworkSignal: true,
  };
  assert.equal(W.settleReason(s), null);
});

test("a blind surface settles once the stillness is a real argument", () => {
  const s = {
    text: "an answer",
    watched: true,
    unchangedMs: 30000,
    stablePolls: 12,
    noNetworkSignal: true,
  };
  assert.equal(W.settleReason(s), "stable");
  // Long enough, but not enough looks: a tab that woke up and measured one
  // wide gap has not watched anything hold still.
  assert.equal(W.settleReason(Object.assign({}, s, { stablePolls: 4 })), null);
});

test("being blind never overrides the signals that are certain", () => {
  const base = { text: "an answer", watched: true, unchangedMs: 2000, noNetworkSignal: true };
  // A stream that closed for this message is authoritative, blind or not.
  assert.equal(W.settleReason(Object.assign({}, base, { streamDone: true })), "stream");
  // ...and a page still generating is still not finished.
  assert.equal(
    W.settleReason(Object.assign({}, base, { generating: true, unchangedMs: 60000 })),
    null
  );
});

test("a page still generating is given twice as long where the network says nothing", () => {
  // The stalled ceiling exists to stop a run hanging on a Stop control that
  // never goes away. In Cowork it is the LAST thing holding the turn, and a
  // twenty-minute tool call is a slow tool call rather than a stuck page.
  const base = { text: "an answer", watched: true, generating: true };
  const at = (ms, blind) =>
    W.settleReason(Object.assign({}, base, { unchangedMs: ms, noNetworkSignal: !!blind }));

  assert.equal(at(15 * 60 * 1000, false), "stalled", "fifteen minutes, where a stream exists");
  assert.equal(at(15 * 60 * 1000, true), null, "...but not on a surface that shows us nothing");
  assert.equal(at(29 * 60 * 1000, true), null);
  assert.equal(at(30 * 60 * 1000, true), "stalled");
});

test("a caller asking for longer than the floor still gets what it asked for", () => {
  const s = {
    text: "an answer",
    watched: true,
    generating: true,
    noNetworkSignal: true,
    stalledMs: 60 * 60 * 1000,
    unchangedMs: 45 * 60 * 1000,
  };
  assert.equal(W.settleReason(s), null, "the floor raises a ceiling, it never lowers one");
});

// ---- who may name a conversation, and when ---------------------------------

test("a conversation the run's own send opened stays the run's to name, on resume too", () => {
  const { run } = startedRun();
  // Before anything is sent there is no record: the run is about to open the
  // conversation itself, so the name is its to give.
  assert.equal(W.ownsChatName((run.chats || {}).a), true);
  assert.equal(W.ownsChatName(undefined), true);
  // The run's own send put the url there — markSent marks it opened, and a
  // step resumed after a worker restart may catch up the rename.
  const sent = W.markSent(run, { chatId: "a", url: "https://claude.ai/cowork/cse_abc", now: NOW });
  assert.equal(sent.chats.a.opened, true);
  assert.equal(W.ownsChatName(sent.chats.a), true);
});

test("a chat the operator pasted in never earns the flag, however many sends return to it", () => {
  const wf = twoChatWorkflow();
  wf.chats[0].startUrl = "https://claude.ai/chat/00000000-0000-4000-8000-000000000001";
  const run = W.markStarted(W.newRun(wf, "r1", NOW, { type: "now" }), NOW);
  // Seeded from the pasted link: url present, not opened by the run.
  assert.equal(W.ownsChatName(run.chats.a), false);
  // A later send INTO that conversation records the url again — and must not
  // launder it into a run-opened one.
  const sent = W.markSent(run, { chatId: "a", url: run.chats.a.url, now: NOW });
  assert.equal(!!sent.chats.a.opened, false);
  assert.equal(W.ownsChatName(sent.chats.a), false);
});

test("records from before the flag existed fall on the safe side: no rename", () => {
  // An in-flight run from an older version has {url} with no `opened`. The
  // run cannot say it opened that chat, so it must not claim the name.
  assert.equal(W.ownsChatName({ url: "https://claude.ai/chat/u1" }), false);
});

test("the flag survives the step landing and the wave folding", () => {
  const { run } = startedRun();
  const sent = W.markSent(run, { chatId: "a", url: "https://claude.ai/chat/u1", now: NOW });
  const landed = W.applyStepResult(sent, {
    stepIndex: 0, chatId: "a", reply: "DRAFT", url: "https://claude.ai/chat/u1", now: NOW + 1, total: 3,
  });
  assert.equal(landed.chats.a.opened, true, "applyStepResult keeps it");
  const waved = W.applyWaveResult(landed, {
    members: [{ stepIndex: 1, chatId: "b", chatName: "Critic", reply: "R", url: "https://claude.ai/chat/u2", at: NOW + 2 }],
    now: NOW + 2,
    total: 3,
  });
  assert.equal(waved.chats.b.opened, true, "a wave member's chat is run-opened too");
  assert.equal(waved.chats.a.opened, true, "and the earlier chat keeps its flag");
});

// ---- a copy that is not the reply ------------------------------------------

test("a copy is believed only when it carries the reply's own ending", () => {
  const report = "Devil's Advocate: the ruling weighs and finds the showing short. " +
    "Consequence: the holding needs different reasoning to stand.";
  // A faithful copy — markdown punctuation differs, letters agree.
  assert.equal(
    W.copyCarriesEnd("## Devil's Advocate\n*the ruling weighs* and finds the showing short. " +
      "**Consequence:** the holding needs different reasoning to stand.", report),
    true
  );
  // Cowork's failure, live: the copy control handed back the turn's TOOL
  // PROMPTS — long, plausible by length, and the answer nowhere inside.
  const toolPrompts = "Retrieve and read the FULL TEXT of Banner Entertainment, Inc. " +
    "v. Superior Court. Use WebSearch and WebFetch. Return raw findings, no preamble. " +
    "Retrieve and read the FULL TEXT of two California opinions. Report in detail.";
  assert.equal(W.copyCarriesEnd(toolPrompts, report), false);
  assert.equal(W.plausibleCopy(toolPrompts, report), true, "length alone waves it through — the bug");
});

test("a short reply still has to be in the copy — the hole a whole file walked through", () => {
  // The live failure: a Cowork turn whose answer was a file it had just
  // written rendered one line of prose, and the copy control handed back the
  // OPEN DOCUMENT. Under the old floor (fewer than twenty letters, believe the
  // copy) the report travelled to the next chat as Claude's own words.
  const short = "Done.";
  assert.equal(W.copyCarriesEnd("Done.", short), true);
  assert.equal(W.copyCarriesEnd("**Done.**", short), true, "markdown around it is still it");
  assert.equal(
    W.copyCarriesEnd("# Verification report\n\nEvery cite in the ruling checks out.", short),
    false
  );
  // Nothing rendered at all is a different thing: no reply on the page to
  // compare against, so this test has nothing to say and stands aside.
  assert.equal(W.copyCarriesEnd("anything", ""), true);
  assert.equal(W.copyCarriesEnd("", "a long enough rendered reply to actually judge against"), false);
});

test("the reply's action bar is known by the company it keeps", () => {
  assert.equal(W.isReplyActionLabel("Retry"), true);
  assert.equal(W.isReplyActionLabel("Good response"), true);
  assert.equal(W.isReplyActionLabel("Bad response"), true);
  assert.equal(W.isReplyActionLabel("Read aloud"), true);
  assert.equal(W.isReplyActionLabel("Copy"), true);
  // A document pane's toolbar, which is what got copied instead of the reply.
  assert.equal(W.isReplyActionLabel("Download"), false);
  assert.equal(W.isReplyActionLabel("Share"), false);
  assert.equal(W.isReplyActionLabel("Open in new tab"), false);
  assert.equal(W.isReplyActionLabel(""), false);
  assert.equal(W.isReplyActionLabel("Retry the request if it fails, then report back to the user"), false);
});

test("a conversation read that fails says which way it failed", () => {
  assert.equal(
    W.conversationFetchWhy({
      error: "no org served this conversation (2 tried)",
      tried: ["/api/organizations/1234abcd\u2026/conversations/cse_01 → HTTP 404"],
    }),
    "no org served this conversation (2 tried) — tried /api/organizations/1234abcd\u2026/conversations/cse_01 → HTTP 404"
  );
  assert.equal(
    W.conversationFetchWhy({ error: "the page never answered within 20s" }),
    "the page never answered within 20s"
  );
  // Four attempts are enough to see a pattern; the rest are counted, not listed.
  const many = ["a → HTTP 403", "b → HTTP 403", "c → HTTP 403", "d → HTTP 403", "e → HTTP 403"];
  assert.equal(
    W.conversationFetchWhy({ error: "none", tried: many }),
    "none — tried a → HTTP 403; b → HTTP 403; c → HTTP 403; d → HTTP 403 (+1 more)"
  );
  assert.equal(W.conversationFetchWhy({}), "no reason given");
  assert.equal(W.conversationFetchWhy(null), "no reason given");
});

// ---- the run console's redraw decision -------------------------------------

test("opening a form repaints even though the run's core stood still", () => {
  // The live failure: Fix & continue and Edit run appeared to do nothing —
  // clicking set the draft, but the anti-repaint guard saw an open form over
  // an unchanged core and skipped the form's own first paint.
  assert.equal(
    W.consoleRedraw({ asked: true, key: "k2", lastKey: "k1", core: "c", lastCore: "c", formOpen: true }),
    true
  );
});

test("a heartbeat under an open form does not pull the textarea out from under the operator", () => {
  assert.equal(
    W.consoleRedraw({ asked: false, key: "k-with-new-note", lastKey: "k1", core: "c", lastCore: "c", formOpen: true }),
    false
  );
});

test("with no form open, any change repaints and no change holds still", () => {
  assert.equal(W.consoleRedraw({ asked: false, key: "k2", lastKey: "k1", core: "c2", lastCore: "c1", formOpen: false }), true);
  assert.equal(W.consoleRedraw({ asked: false, key: "k1", lastKey: "k1", core: "c", lastCore: "c", formOpen: false }), false);
});

test("the run moving repaints even while a form is open", () => {
  assert.equal(
    W.consoleRedraw({ asked: false, key: "k2", lastKey: "k1", core: "c2", lastCore: "c1", formOpen: true }),
    true
  );
});

// ---- Fix & continue's DEFAULTS are exclusive too ---------------------------

test("a fix form's defaults never open with both boxes checked", () => {
  // The owner caught it live in the run console: a carrying step interrupted
  // mid-wait defaulted "already went out" AND "re-read the carry" both on.
  // With no `changed` argument — the defaults case — the message already
  // being out wins.
  assert.deepEqual(W.exclusiveFix({ refetchCarry: true, sent: true }), {
    refetchCarry: false,
    sent: true,
  });
});

// ---- reading a Cowork session's payload ------------------------------------

test("a Cowork session payload is read defensively, assistant entries only", () => {
  // The chat shape, should the collections simply agree.
  assert.equal(
    W.coworkReplyText({ chat_messages: [{ sender: "human", text: "ask" }, { sender: "assistant", text: "THE RULING" }] }),
    "THE RULING"
  );
  // A messages array with role and content blocks.
  assert.equal(
    W.coworkReplyText({
      messages: [
        { role: "user", content: [{ type: "text", text: "the prompt" }] },
        { role: "assistant", content: [{ type: "text", text: "THE REPORT" }] },
      ],
    }),
    "THE REPORT"
  );
  // One level down, and by `author`.
  assert.equal(
    W.coworkReplyText({ session: { events: [{ author: "assistant", text: "NESTED" }] } }),
    "NESTED"
  );
  // An unattributed entry could as easily be the prompt — never taken.
  assert.equal(W.coworkReplyText({ messages: [{ text: "who wrote this?" }] }), "");
  assert.equal(W.coworkReplyText(null), "");
  assert.equal(W.coworkReplyText({ uuid: "cse_x", name: "run" }), "");
});

test("an unrecognised payload reports its shape instead of nothing", () => {
  assert.equal(
    W.payloadShape({ uuid: "cse_x", name: "run", steps: [{ id: 1, kind: "tool" }] }),
    "keys: uuid,name,steps; steps[0]: id,kind"
  );
  assert.equal(W.payloadShape(null), "no payload");
});

// ---- which run the in-conversation console shows ----------------------------

test("a finished run keeps its console — the live failure was a Run button that did nothing", () => {
  const done = { id: "d", status: "done", startedAt: 100 };
  // The console skipped done/canceled outright, while the tray's Run button
  // matched them — a visible button whose click opened nothing.
  assert.equal(W.consoleRun([{ run: done, matched: true }]), done);
  // A LIVE run in the same conversation outranks it.
  const live = { id: "l", status: "paused", startedAt: 50 };
  assert.equal(W.consoleRun([{ run: done, matched: true }, { run: live, matched: true }]), live);
  // Among finished runs the NEWEST wins — a conversation is re-used by later
  // runs of the same workflow.
  const older = { id: "o", status: "done", startedAt: 10 };
  assert.equal(W.consoleRun([{ run: older, matched: true }, { run: done, matched: true }]), done);
  // The tab driving a step shows its run even before a URL is stored.
  const driving = { id: "g", status: "running" };
  assert.equal(W.consoleRun([{ run: driving, driving: true }]), driving);
  // A finished run somewhere ELSE is not this conversation's console.
  assert.equal(W.consoleRun([{ run: done, matched: false }]), null);
  assert.equal(W.consoleRun([]), null);
  assert.equal(W.consoleRun(null), null);
});

// ---- the pseudonym key rides the run --------------------------------------

test("a run carries its pseudonym key: start, edit, re-run, and reset", () => {
  const wf = W.newWorkflow(
    {
      name: "Matter",
      templateName: "Tentative",
      pseudoKeyId: "pseudonym_key.xlsx",
      chats: [{ id: "a", name: "A" }],
      steps: [{ id: "s1", chatId: "a", prompt: "draft" }],
    },
    "w1",
    NOW
  );
  assert.equal(wf.pseudoKeyId, "pseudonym_key.xlsx");

  const run = W.newRun(wf, "r1", NOW, { type: "now" }, wf.docs);
  assert.equal(run.pseudoKeyId, "pseudonym_key.xlsx");

  // An edit that says nothing about the key leaves it; one that names a key
  // (or none) is applied.
  assert.equal(W.applyRunEdit(run, { name: "Matter" }, NOW + 1).pseudoKeyId, "pseudonym_key.xlsx");
  assert.equal(W.applyRunEdit(run, { pseudoKeyId: null }, NOW + 1).pseudoKeyId, null);
  assert.equal(W.applyRunEdit(run, { pseudoKeyId: "other.xlsx" }, NOW + 1).pseudoKeyId, "other.xlsx");

  // A re-run is the same matter, so the same key.
  const again = W.rerunOf(run, { stepIndex: 0, freshChats: false }, "r2", NOW + 2);
  assert.equal(again.pseudoKeyId, "pseudonym_key.xlsx");

  // Back to a blank template: the key was this matter's, like the papers.
  assert.equal(W.resetToTemplate(wf, NOW + 3).pseudoKeyId, null);
});

// ---- run dates -------------------------------------------------------------

test("parseRunDate: mm/dd/yy by hand, ISO from the calendar, garbage is null", () => {
  assert.equal(W.parseRunDate("8/12/26"), "2026-08-12");
  assert.equal(W.parseRunDate("08/12/26"), "2026-08-12");
  assert.equal(W.parseRunDate("12-31-2026"), "2026-12-31");
  assert.equal(W.parseRunDate("8.12.26"), "2026-08-12");
  assert.equal(W.parseRunDate("2026-08-12"), "2026-08-12");
  assert.equal(W.parseRunDate("2/30/26"), null); // the right shape, not a day
  assert.equal(W.parseRunDate("hearing soon"), null);
  assert.equal(W.parseRunDate(""), null);
  assert.equal(W.runDateLabel("2026-08-12"), "8/12/26");
});

test("composeRunName puts the date at the end, once, and strips it cleanly", () => {
  assert.equal(W.composeRunName("MSJ Rasho", "2026-08-12"), "MSJ Rasho 8/12/26");
  // Re-saving does not stack a second label; changing the date replaces it.
  assert.equal(W.composeRunName("MSJ Rasho 8/12/26", "2026-08-12"), "MSJ Rasho 8/12/26");
  assert.equal(W.composeRunName("MSJ Rasho 8/12/26", "2026-09-02"), "MSJ Rasho 9/2/26");
  // Clearing the date really removes it.
  assert.equal(W.composeRunName("MSJ Rasho 8/12/26", null), "MSJ Rasho");
  // A re-run's "(Run 2)" stays LAST — matter, date, run number.
  assert.equal(W.composeRunName("MSJ Rasho 8/12/26 (Run 2)", "2026-08-12"), "MSJ Rasho 8/12/26 (Run 2)");
  // No name at all: the date IS the name.
  assert.equal(W.composeRunName("", "2026-08-12"), "8/12/26");
  assert.equal(W.runBaseName("MSJ Rasho 8/12/26 (Run 2)"), "MSJ Rasho");
});

test("a run's date rides start, edit, re-run, and reset, and names itself", () => {
  const wf = W.newWorkflow(
    {
      name: "MSJ Rasho",
      templateName: "Tentative",
      runDate: "8/12/26", // as typed — normalized on the way in
      chats: [{ id: "a", name: "A" }],
      steps: [{ id: "s1", chatId: "a", prompt: "draft" }],
    },
    "w1",
    NOW
  );
  assert.equal(wf.runDate, "2026-08-12");
  const run = W.newRun(wf, "r1", NOW, { type: "now" }, wf.docs);
  assert.equal(run.name, "MSJ Rasho 8/12/26");
  assert.equal(run.runDate, "2026-08-12");

  // Editing the name alone keeps the date on the end; editing the date
  // rewrites the label; clearing it removes it.
  assert.equal(W.applyRunEdit(run, { name: "MSJ Rasho amended" }, NOW).name, "MSJ Rasho amended 8/12/26");
  const moved = W.applyRunEdit(run, { runDate: "9/2/26" }, NOW);
  assert.equal(moved.name, "MSJ Rasho 9/2/26");
  assert.equal(moved.runDate, "2026-09-02");
  const cleared = W.applyRunEdit(run, { runDate: null }, NOW);
  assert.equal(cleared.name, "MSJ Rasho");
  assert.equal(cleared.runDate, null);

  const again = W.rerunOf(run, { stepIndex: 0, freshChats: false }, "r2", NOW + 1);
  assert.equal(again.runDate, "2026-08-12");
  assert.equal(again.name, "MSJ Rasho 8/12/26 (Run 2)");

  assert.equal(W.resetToTemplate(wf, NOW + 2).runDate, null);
});

// ---- related-run groups ----------------------------------------------------

test("assignGroup moves runs rather than forking them; small groups dissolve", () => {
  let groups = W.assignGroup([], ["r1", "r2", "r3"], "g1");
  assert.equal(W.groupOf(groups, "r2"), "g1");
  // Re-grouping r2+r4 pulls r2 out of g1, which keeps r1+r3.
  groups = W.assignGroup(groups, ["r2", "r4"], "g2");
  assert.equal(W.groupOf(groups, "r2"), "g2");
  assert.equal(W.groupOf(groups, "r1"), "g1");
  // Pulling r3 out leaves g1 with one member — not a group any more.
  groups = W.ungroupRuns(groups, ["r3"]);
  assert.equal(W.groupOf(groups, "r1"), null);
  assert.equal(W.groupOf(groups, "r2"), "g2");
  // Fewer than two checked runs makes no group.
  assert.deepEqual(W.assignGroup([], ["r9"], "gx"), []);
});

test("pruneGroups drops deleted runs and says whether anything moved", () => {
  const groups = [{ id: "g1", runIds: ["r1", "r2", "r3"] }];
  const runs = [{ id: "r1" }, { id: "r2" }];
  const pruned = W.pruneGroups(groups, runs);
  assert.deepEqual(pruned.groups, [{ id: "g1", runIds: ["r1", "r2"] }]);
  assert.equal(pruned.changed, true);
  assert.equal(W.pruneGroups(pruned.groups, runs).changed, false);
});

test("a grouped run inherits a group-mate's pseudonym key, earliest mate first", () => {
  const runs = [
    { id: "r1", createdAt: 3, pseudoKeyId: "late.xlsx" },
    { id: "r2", createdAt: 1, pseudoKeyId: "early.xlsx" },
    { id: "r3", createdAt: 2 },
    { id: "r4", createdAt: 4 },
  ];
  const groups = [{ id: "g1", runIds: ["r1", "r2", "r3"] }];
  // Its own key always wins.
  assert.equal(W.runPseudoKey(runs[0], runs, groups), "late.xlsx");
  // No key of its own: the earliest-created mate that names one.
  assert.equal(W.runPseudoKey(runs[2], runs, groups), "early.xlsx");
  // Not in any group: nothing to inherit.
  assert.equal(W.runPseudoKey(runs[3], runs, groups), null);
});

// ---- the runs list's three orders -------------------------------------------

function bareRun(id, createdAt, extra) {
  return Object.assign({ id: id, createdAt: createdAt, status: "done" }, extra || {});
}

test("sortRuns: created is drafts-first then newest-first", () => {
  const runs = [
    bareRun("old", 1),
    bareRun("new", 3),
    bareRun("draft", 2, { status: "draft" }),
  ];
  assert.deepEqual(W.sortRuns(runs, "created", []).map((r) => r.id), ["draft", "new", "old"]);
});

test("sortRuns: date puts dated runs first, soonest first; the rest keep creation order", () => {
  const runs = [
    bareRun("undated-new", 5),
    bareRun("sep", 1, { runDate: "2026-09-02" }),
    bareRun("undated-old", 2),
    bareRun("aug", 3, { runDate: "2026-08-12" }),
  ];
  assert.deepEqual(W.sortRuns(runs, "date", []).map((r) => r.id), [
    "aug",
    "sep",
    "undated-new",
    "undated-old",
  ]);
});

test("sortRuns: group pulls members together where the group first appears", () => {
  const runs = [bareRun("a", 5), bareRun("b", 4), bareRun("c", 3), bareRun("d", 2)];
  const groups = [{ id: "g1", runIds: ["a", "d"] }];
  // Default order is a,b,c,d; the group's first member is a, so d joins it.
  assert.deepEqual(W.sortRuns(runs, "group", groups).map((r) => r.id), ["a", "d", "b", "c"]);
});

// ---- a spreadsheet never rides a run's uploads --------------------------------

test("xlsx documents are dropped at every shaping path and at the runner's read", () => {
  const docs = [
    { id: "d1", name: "motion.pdf", chats: ["a"] },
    { id: "d2", name: "pseudonym_key.xlsx", chats: ["a"] },
    { id: "d3", name: "damages.XLSX", chats: ["a"] },
  ];
  const wf = W.newWorkflow(
    { name: "x", docs: docs, chats: [{ id: "a" }], steps: [{ chatId: "a", prompt: "p" }] },
    "w",
    NOW
  );
  assert.deepEqual(wf.docs.map((d) => d.name), ["motion.pdf"]);
  const run = W.newRun(wf, "r", NOW, { type: "now" }, docs);
  assert.deepEqual(run.docs.map((d) => d.name), ["motion.pdf"]);
  const edited = W.applyRunEdit(run, { docs: docs }, NOW);
  assert.deepEqual(edited.docs.map((d) => d.name), ["motion.pdf"]);
  // A run stored BEFORE the bar existed still cannot upload one.
  assert.deepEqual(W.allDocs({ docs: docs }).map((d) => d.name), ["motion.pdf"]);
  assert.ok(W.docBarred("Key (1).xlsx") && W.docBarred("book.xlsm") && !W.docBarred("brief.docx"));
});

test("a group is one case, one key: the guard's question and the resolution agree", () => {
  const runs = [
    { id: "r1", createdAt: 1, pseudoKeyId: "rasho#a1b2" },
    { id: "r2", createdAt: 2 },
    { id: "r3", createdAt: 3, pseudoKeyId: "rasho#a1b2" },
    { id: "r4", createdAt: 4, pseudoKeyId: "deng#c3d4" },
  ];
  // One case's runs: one distinct key, however many members name it.
  assert.deepEqual(W.distinctPseudoKeys(runs, ["r1", "r2", "r3"]), ["rasho#a1b2"]);
  // Two cases checked together: two keys — the state Save group refuses.
  assert.deepEqual(W.distinctPseudoKeys(runs, ["r1", "r4"]), ["rasho#a1b2", "deng#c3d4"]);
  // No keys at all is fine — a group may predate its key.
  assert.deepEqual(W.distinctPseudoKeys(runs, ["r2"]), []);
  // And once grouped, the one key reaches the member that never named it.
  const groups = [{ id: "g1", runIds: ["r1", "r2", "r3"] }];
  assert.equal(W.runPseudoKey(runs[1], runs, groups), "rasho#a1b2");
});

test("rekeyPlan: a key changed in one chat reaches the run, its group, and their chats", () => {
  const u = (n) => "https://claude.ai/chat/0a1b2c3d-4e5f-6789-abcd-ef000000000" + n;
  const runs = [
    { id: "r1", createdAt: 1, chats: { a: { url: u(1) }, b: { url: u(2) } } },
    { id: "r2", createdAt: 2, chats: { a: { url: u(3) } } }, // grouped with r1
    { id: "r3", createdAt: 3, chats: { a: { url: u(4) } } }, // unrelated case
  ];
  const groups = [{ id: "g1", runIds: ["r1", "r2"] }];
  // From a chat r1 owns: r1 and its group-mate r2 rewrite; r3 does not.
  const plan = W.rekeyPlan(runs, groups, { conv: "0a1b2c3d-4e5f-6789-abcd-ef0000000001" });
  assert.deepEqual(plan.runIds.sort(), ["r1", "r2"]);
  // Every conversation those runs own is named, so a stray chat-level
  // attachment shadowing one of them can be brought along.
  assert.deepEqual(plan.convs.sort(), [
    "0a1b2c3d-4e5f-6789-abcd-ef0000000001",
    "0a1b2c3d-4e5f-6789-abcd-ef0000000002",
    "0a1b2c3d-4e5f-6789-abcd-ef0000000003",
  ]);
  // By run id (the run editor's path): same expansion.
  assert.deepEqual(W.rekeyPlan(runs, groups, { runId: "r2" }).runIds.sort(), ["r1", "r2"]);
  // A conversation no run owns: empty plan — the caller attaches chat-level.
  assert.deepEqual(W.rekeyPlan(runs, groups, { conv: "not-owned" }), { runIds: [], convs: [] });
});

test("a group is named the way its key is: hint, then key name, then a member's matter", () => {
  const keys = {
    "pseudonym_key.xlsx#a1": { name: "pseudonym_key.xlsx", hint: "Rasho", rows: 187 },
    "pseudonym_key.xlsx#b2": { name: "pseudonym_key.xlsx", hint: "", rows: 12 },
  };
  const runs = [
    { id: "r1", createdAt: 2, name: "MSJ 8/12/26", pseudoKeyId: "pseudonym_key.xlsx#a1" },
    { id: "r2", createdAt: 1, name: "" },
    { id: "r3", createdAt: 3, name: "Demurrer Deng 9/2/26" },
    { id: "r4", createdAt: 4, name: "", pseudoKeyId: "pseudonym_key.xlsx#b2" },
  ];
  // The key's hint names the group, whichever member carries the key.
  assert.equal(W.groupLabel({ id: "g", runIds: ["r2", "r1"] }, runs, keys), "Rasho");
  // A key with no hint falls back to its file name.
  assert.equal(W.groupLabel({ id: "g", runIds: ["r4", "r2"] }, runs, keys), "pseudonym_key.xlsx");
  // No key anywhere: the earliest named member's matter, date label stripped.
  assert.equal(W.groupLabel({ id: "g", runIds: ["r2", "r3"] }, runs, keys), "Demurrer Deng");
  // Keyless and nameless: empty — the caller's numbered fallback.
  assert.equal(W.groupLabel({ id: "g", runIds: ["r2"] }, runs, keys), "");
  // A stored key id that no longer resolves is not a label.
  assert.equal(
    W.groupLabel({ id: "g", runIds: ["r2"] }, [{ id: "r2", createdAt: 1, name: "", pseudoKeyId: "gone" }], keys),
    ""
  );
});

test("a run's tab group is named and colored for the case", () => {
  const keys = { "k#1": { name: "pseudonym_key.xlsx", hint: "Rasho", rows: 187 } };
  // The key's hint names the group…
  assert.equal(
    W.tabGroupTitle({ name: "MSJ 8/12/26", pseudoKeyId: "k#1" }, keys),
    "Rasho"
  );
  // …the matter's own name (date label off) when there's no key…
  assert.equal(W.tabGroupTitle({ name: "MSJ Rasho 8/12/26" }, keys), "MSJ Rasho");
  // …the template's when the run is nameless, and never an empty title.
  assert.equal(W.tabGroupTitle({ name: "", templateName: "Tentative" }, keys), "Tentative");
  assert.equal(W.tabGroupTitle({}, {}), "run");
  // Long titles are cut before Chrome mangles them.
  const long = W.tabGroupTitle({ name: "A Very Long Matter Name That Keeps Going" }, {});
  assert.ok(long.length <= 24 && long.endsWith("…"));

  // Deterministic color from the seed, always one of Chrome's palette — and
  // seeding on the KEY means every run of one case wears the same color.
  const c1 = W.tabGroupColor("k#1");
  assert.equal(c1, W.tabGroupColor("k#1"));
  assert.ok(["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"].includes(c1));
});
