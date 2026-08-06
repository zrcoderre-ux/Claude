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

test("a duplicate step result cannot advance the run twice", () => {
  const { run } = startedRun();
  const once = W.applyStepResult(run, { stepIndex: 0, chatId: "a", reply: "A", now: NOW, total: 3 });
  const again = W.applyStepResult(once, { stepIndex: 0, chatId: "a", reply: "A", now: NOW, total: 3 });
  assert.equal(again.stepIndex, 1, "stale result for step 0 is ignored");
  assert.equal(again.transcript.length, 1);
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

test("turnSettled waits for generation to stop AND the text to hold still", () => {
  const base = { text: "an answer", generating: false, unchangedMs: 3000, minStableMs: 2500 };
  assert.ok(W.turnSettled(base));
  assert.equal(W.turnSettled(Object.assign({}, base, { generating: true })), false);
  assert.equal(W.turnSettled(Object.assign({}, base, { unchangedMs: 500 })), false);
  assert.equal(W.turnSettled(Object.assign({}, base, { text: "   " })), false);
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
