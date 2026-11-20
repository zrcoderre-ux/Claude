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

test("each step, as the runs list's history draws it: done, here, still to do, with how long it took", () => {
  const r = run({ transcript: [{ stepIndex: 0, chatId: "a", ms: 240000 }] });
  const steps = S.summarize([r], [], NOW).runs[0].steps;
  assert.deepStrictEqual(steps.map((x) => [x.label, x.chat, x.state]), [["1", "Chat A", "done"], ["2", "Chat B", "here"], ["3", "Chat A", "todo"]]);
  assert.strictEqual(steps[0].ms, 240000);
  assert.strictEqual(steps[1].ms, undefined);
  assert.deepStrictEqual(S.summarize([run({ status: "error" })], [], NOW).runs[0].steps.map((x) => x.state), ["done", "failed", "todo"]);
  assert.deepStrictEqual(S.summarize([run({ status: "done", stepIndex: 3, finishedAt: NOW })], [], NOW).runs[0].steps.map((x) => x.state), ["done", "done", "done"]);
  assert.deepStrictEqual(S.summarize([run({ status: "waiting" })], [], NOW).runs[0].steps.map((x) => x.state), ["done", "next", "todo"]);
});

// The owner (November 2026): "change the claude run button to a drop down menu
// that lets me select the workflow to run". PDF+ lists them from this file.
test("the workflows go with the runs: id and name only, by name", () => {
  const wfs = [{ id: "w2", name: "Tentative ruling", chats: [{ prompt: "secret" }] }, { id: "w1", name: " Bench   memo " }, { name: "no id" }, { id: "w3", templateName: "Digest" }];
  const d = S.summarize([], wfs, NOW);
  assert.deepStrictEqual(d.workflows, [{ id: "w1", name: "Bench memo" }, { id: "w3", name: "Digest" }, { id: "w2", name: "Tentative ruling" }]);
  assert.ok(!JSON.stringify(d.workflows).includes("secret"));
});

test("a workflow added or renamed is a change to write", () => {
  const a = S.summarize([], [{ id: "w1", name: "Bench memo" }], NOW);
  const b = S.summarize([], [{ id: "w1", name: "Bench memo v2" }], NOW);
  assert.strictEqual(S.shouldWrite(b, { sig: S.signature(a), at: NOW }, NOW + 1000), true);
  assert.strictEqual(S.shouldWrite(a, { sig: S.signature(a), at: NOW }, NOW + 1000), false);
});

// The owner (November 2026): "It should show in the home page the status of the
// current or most recent claude run for each case (but only if there was one)".
test("each matter's most recent run stays, however long ago it ended (within KEEP_CASE_MS)", () => {
  const DAY = 24 * 3600 * 1000;
  const d = S.summarize([
    run({ id: "old1", name: "25STCV12345 ACME — 11/02/26", status: "done", finishedAt: NOW - 10 * DAY, lastProgressAt: NOW - 10 * DAY }),
    run({ id: "old2", name: "25STCV12345 ACME — 11/09/26", status: "done", finishedAt: NOW - 5 * DAY, lastProgressAt: NOW - 5 * DAY }),
    run({ id: "other", name: "24STCV00777 Doe — 11/01/26", status: "canceled", finishedAt: NOW - 3 * DAY, lastProgressAt: NOW - 3 * DAY }),
    run({ id: "ancient", name: "23STCV04444 Roe — 06/01/26", status: "done", finishedAt: NOW - S.KEEP_CASE_MS - DAY, lastProgressAt: NOW - S.KEEP_CASE_MS - DAY }),
    run({ id: "draft", name: "22STCV05555 Vance", status: "draft" }),
  ], [], NOW);
  assert.deepStrictEqual(d.runs.map((r) => r.id).sort(), ["old2", "other"]);
});

test("a matter with a run going or lately ended is not given an older one too", () => {
  const DAY = 24 * 3600 * 1000;
  const d = S.summarize([
    run({ id: "now", name: "25STCV12345 ACME — 11/20/26" }),
    run({ id: "old", name: "25STCV12345 ACME — 11/09/26", status: "done", finishedAt: NOW - 5 * DAY, lastProgressAt: NOW - 5 * DAY }),
  ], [], NOW);
  assert.deepStrictEqual(d.runs.map((r) => r.id), ["now"]);
});

// The owner (November 2026), of Home's Claude column: "I have yet to see a single one".
test("Options says whether PDF+'s Home gets the runs, and the fix for the usual failures", () => {
  assert.strictEqual(S.linkAdvice(null, "abc", NOW).tone, "idle");
  const ok = S.linkAdvice({ at: NOW - 60000, ok: true, path: "C:\\Users\\Clerk\\Downloads\\Claude Run Status.json" }, "abc", NOW);
  assert.strictEqual(ok.tone, "ok");
  assert.match(ok.text, /Claude Run Status\.json/);
  const forbidden = S.linkAdvice({ at: NOW, ok: false, error: "Access to the specified native messaging host is forbidden." }, "abcdefgh", NOW);
  assert.strictEqual(forbidden.tone, "warn");
  assert.match(forbidden.text, /-ExtraExtensionIds abcdefgh/);
  assert.match(S.linkAdvice({ at: NOW, ok: false, error: "Specified native messaging host not found." }, "x", NOW).text, /not installed/);
  assert.match(S.linkAdvice({ at: NOW, ok: false, error: "Unknown action: writeClaudeRuns" }, "x", NOW).text, /Pull the E-Court checkout/);
});
