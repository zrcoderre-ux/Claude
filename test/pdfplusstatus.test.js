const test = require("node:test");
const assert = require("node:assert");
const W = require("../src/workflow.js");
const S = require("../src/pdfplusstatus.js");

const NOW = new Date(2026, 10, 19, 14, 0).getTime();
const plan = { chats: [{ id: "a", name: "Chat A" }, { id: "b", name: "Chat B" }], steps: [{ id: "s1", chatId: "a", prompt: "x" }, { id: "s2", chatId: "b", prompt: "y" }, { id: "s3", chatId: "a", prompt: "z" }] };
const run = (o) => Object.assign({
  id: "r1", name: "25STCV12345 ACME — 11/20/26", templateName: "Tentative ruling", status: "running", phase: "awaiting-reply",
  stepIndex: 1, totalSteps: 3, plan, chats: { a: { url: "https://claude.ai/chat/aaa" }, b: { url: "https://claude.ai/chat/bbb" } },
  transcript: [{ stepIndex: 0, chatId: "a" }], lastProgressAt: NOW - 120000, createdAt: NOW - 3600000, startedAt: NOW - 3000000, runDate: "2026-11-20",
}, o);

test("a run going: its matter, case number, workflow and where it stands", () => {
  const d = S.summarize([run()], [], NOW);
  assert.strictEqual(d.version, 1);
  const r = d.runs[0];
  assert.strictEqual(r.name, "25STCV12345 ACME — 11/20/26");
  assert.strictEqual(r.caseNumber, "25STCV12345");
  assert.strictEqual(r.template, "Tentative ruling");
  assert.strictEqual(r.status, "running");
  assert.strictEqual(r.step, 2);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.progress, W.progressText(run(), null));
  assert.match(r.progress, /Step 2 of 3/);
  assert.strictEqual(r.url, "https://claude.ai/chat/aaa");
});

test("drafts stay out; ended runs stay listed a while, then go", () => {
  const d = S.summarize([
    run({ id: "d", status: "draft" }),
    run({ id: "old", status: "done", finishedAt: NOW - S.KEEP_ENDED_MS - 1 }),
    run({ id: "new", status: "done", finishedAt: NOW - 3600000, stepIndex: 3 }),
    run({ id: "go" }),
  ], [], NOW);
  assert.deepStrictEqual(d.runs.map((r) => r.id), ["go", "new"]);
  assert.strictEqual(d.runs[1].finishedAt, NOW - 3600000);
});

test("held and failed say why; nothing of the papers or prompts goes out", () => {
  const d = S.summarize([run({ id: "h", status: "waiting", holdReason: "usage limit" }), run({ id: "e", status: "error", error: "no reply" })], [], NOW);
  const byId = Object.fromEntries(d.runs.map((r) => [r.id, r]));
  assert.strictEqual(byId.h.held, "usage limit");
  assert.strictEqual(byId.e.error, "no reply");
  assert.ok(!/"prompt"|"docs"|lastReply/.test(JSON.stringify(d)));
});

test("written again only when something changed, or a run going has gone quiet that long", () => {
  const d = S.summarize([run()], [], NOW);
  assert.strictEqual(S.shouldWrite(d, null, NOW), true);
  const last = { sig: S.signature(d), at: NOW };
  assert.strictEqual(S.shouldWrite(S.summarize([run()], [], NOW + 1000), last, NOW + 1000), false);
  assert.strictEqual(S.shouldWrite(S.summarize([run()], [], NOW + S.REFRESH_MS), last, NOW + S.REFRESH_MS), true);
  assert.strictEqual(S.shouldWrite(S.summarize([run({ stepIndex: 2 })], [], NOW + 1000), last, NOW + 1000), true);
  const idle = S.summarize([run({ status: "done", finishedAt: NOW })], [], NOW);
  assert.strictEqual(S.shouldWrite(idle, { sig: S.signature(idle), at: NOW }, NOW + S.REFRESH_MS * 3), false);
});

test("case numbers, as PDF+ reads them", () => {
  assert.strictEqual(S.caseNumberOf("25 stcv 12345 Doe"), "25STCV12345");
  assert.strictEqual(S.caseNumberOf("BC654321 Smith"), "BC654321");
  assert.strictEqual(S.caseNumberOf("Doe v. Roe"), "");
});
