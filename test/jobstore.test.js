/**
 * Tests for src/jobstore.js — the scheduled-send job model (pure logic).
 * Run with: node --test test/jobstore.test.js
 */
const assert = require("node:assert");
const { test } = require("node:test");
const J = require("../src/jobstore.js");

const NOW = 1_800_000_000_000;

test("newJob defaults to a reset trigger and pending status", () => {
  const job = J.newJob({ prompt: "hi", files: [{ id: "f1", name: "a.txt" }] }, "job1", NOW);
  assert.equal(job.id, "job1");
  assert.equal(job.status, "pending");
  assert.deepEqual(job.trigger, { type: "reset" });
  assert.equal(job.createdAt, NOW);
  assert.equal(job.files.length, 1);
  assert.equal(job.files[0].id, "f1");
});

test("newJob stores an optional model, defaulting to null", () => {
  assert.equal(J.newJob({ prompt: "hi" }, "j", NOW).model, null);
  assert.equal(J.newJob({ prompt: "hi", model: "" }, "j", NOW).model, null);
  assert.equal(J.newJob({ prompt: "hi", model: "  Opus 4.8 " }, "j", NOW).model, "Opus 4.8");
});

test("parseModelName isolates the model name from a menu row", () => {
  // Regular chat: name glued to a description.
  assert.equal(J.parseModelName("Opus 4.8For complex tasks"), "Opus 4.8");
  assert.equal(J.parseModelName("Sonnet 5Most efficient for everyday tasks"), "Sonnet 5");
  assert.equal(J.parseModelName("Haiku 4.5Fastest for quick answers"), "Haiku 4.5");
  assert.equal(J.parseModelName("Fable 5Included until July 19For your toughest challenges"), "Fable 5");
  assert.equal(J.parseModelName(""), null);
  assert.equal(J.parseModelName("More models"), null);
});

test("newJob keeps a valid time trigger", () => {
  const at = NOW + 3600_000;
  const job = J.newJob({ trigger: { type: "time", at } }, "j", NOW);
  assert.deepEqual(job.trigger, { type: "time", at });
});

test("upsert / remove / get", () => {
  let jobs = [];
  jobs = J.upsertJob(jobs, J.newJob({}, "a", NOW));
  jobs = J.upsertJob(jobs, J.newJob({}, "b", NOW));
  assert.equal(jobs.length, 2);
  jobs = J.upsertJob(jobs, Object.assign(J.getJob(jobs, "a"), { status: "done" }));
  assert.equal(jobs.length, 2, "upsert of existing id replaces, not appends");
  assert.equal(J.getJob(jobs, "a").status, "done");
  jobs = J.removeJob(jobs, "a");
  assert.equal(jobs.length, 1);
  assert.equal(J.getJob(jobs, "a"), null);
});

test("targetUrl picks new / project url", () => {
  assert.equal(J.targetUrl(J.newJob({}, "x", NOW)), "https://claude.ai/new");
  assert.equal(
    J.targetUrl(J.newJob({ projectHref: "/cowork/project/abc" }, "x", NOW)),
    "https://claude.ai/cowork/project/abc"
  );
  assert.equal(
    J.targetUrl(J.newJob({ projectUuid: "uuid-1" }, "x", NOW)),
    "https://claude.ai/cowork/project/uuid-1"
  );
});

test("codeRepo target opens a fresh Claude Code session and labels the repo", () => {
  const job = J.newJob({ codeRepo: "  zrcoderre-ux/Claude  ", prompt: "go" }, "x", NOW);
  assert.equal(job.codeRepo, "zrcoderre-ux/Claude");
  assert.equal(J.targetUrl(job), "https://claude.ai/code");
  assert.equal(J.targetLabel(job), "→ Claude Code: zrcoderre-ux/Claude");
  // Empty repo stays null.
  assert.equal(J.newJob({ codeRepo: "" }, "x", NOW).codeRepo, null);
  // chatUrl still wins over codeRepo if both are somehow present.
  assert.equal(
    J.targetUrl(J.newJob({ chatUrl: "https://claude.ai/code/session_z", codeRepo: "a/b" }, "x", NOW)),
    "https://claude.ai/code/session_z"
  );
});

test("targetUrl uses an existing chat URL and takes precedence", () => {
  assert.equal(
    J.targetUrl(J.newJob({ chatUrl: "https://claude.ai/chat/abc" }, "x", NOW)),
    "https://claude.ai/chat/abc"
  );
  assert.equal(
    J.targetUrl(J.newJob({ chatUrl: "/chat/abc" }, "x", NOW)),
    "https://claude.ai/chat/abc"
  );
  // chat wins over project
  assert.equal(
    J.targetUrl(J.newJob({ chatUrl: "/chat/abc", projectUuid: "p" }, "x", NOW)),
    "https://claude.ai/chat/abc"
  );
});

test("targetLabel describes the destination", () => {
  assert.equal(J.targetLabel(J.newJob({}, "x", NOW)), "New chat");
  assert.equal(J.targetLabel(J.newJob({ projectName: "Rulings" }, "x", NOW)), "→ Rulings");
  assert.equal(
    J.targetLabel(J.newJob({ chatUrl: "/chat/a", chatTitle: "My chat" }, "x", NOW)),
    "→ My chat"
  );
});

test("dueTimeJobs returns only pending time jobs at/after now", () => {
  const jobs = [
    J.newJob({ trigger: { type: "time", at: NOW - 1000 } }, "past", NOW),
    J.newJob({ trigger: { type: "time", at: NOW + 1000 } }, "future", NOW),
    J.newJob({ trigger: { type: "reset" } }, "reset", NOW),
  ];
  const due = J.dueTimeJobs(jobs, NOW);
  assert.deepEqual(due.map((j) => j.id), ["past"]);
});

test("dueTimeJobs skips non-pending jobs", () => {
  const jobs = [Object.assign(J.newJob({ trigger: { type: "time", at: NOW - 1 } }, "d", NOW), { status: "done" })];
  assert.equal(J.dueTimeJobs(jobs, NOW).length, 0);
});

test("pendingResetJobs / hasPendingResetJobs", () => {
  const jobs = [
    J.newJob({ trigger: { type: "reset" } }, "r1", NOW),
    Object.assign(J.newJob({ trigger: { type: "reset" } }, "r2", NOW), { status: "done" }),
    J.newJob({ trigger: { type: "time", at: NOW } }, "t", NOW),
  ];
  assert.deepEqual(J.pendingResetJobs(jobs).map((j) => j.id), ["r1"]);
  assert.equal(J.hasPendingResetJobs(jobs), true);
  assert.equal(J.hasPendingResetJobs([]), false);
});

test("nextTimeTrigger returns the soonest pending time", () => {
  const jobs = [
    J.newJob({ trigger: { type: "time", at: NOW + 5000 } }, "a", NOW),
    J.newJob({ trigger: { type: "time", at: NOW + 2000 } }, "b", NOW),
    J.newJob({ trigger: { type: "reset" } }, "c", NOW),
  ];
  assert.equal(J.nextTimeTrigger(jobs, NOW), NOW + 2000);
  assert.equal(J.nextTimeTrigger([J.newJob({ trigger: { type: "reset" } }, "r", NOW)], NOW), null);
});

test("parseDataUrl splits mime and base64", () => {
  const r = J.parseDataUrl("data:text/plain;base64,aGk=");
  assert.equal(r.mime, "text/plain");
  assert.equal(r.base64, "aGk=");
  assert.equal(r.isBase64, true);
  assert.equal(J.parseDataUrl("not-a-data-url"), null);
});

test("cleanProjectName strips trailing relative-time / date suffix", () => {
  assert.equal(J.cleanProjectName("Draft Tentative Rulings2 hours ago"), "Draft Tentative Rulings");
  assert.equal(J.cleanProjectName("CutlistMay 28"), "Cutlist");
  assert.equal(J.cleanProjectName("Motion DeadlinesApr 7"), "Motion Deadlines");
  assert.equal(J.cleanProjectName("Plain Name"), "Plain Name");
});

test("cleanProjectName strips the sidebar row's chat-expander label", () => {
  // The expander's text concatenates seamlessly onto the title — no space, no
  // word boundary — and repeats the name after it.
  assert.equal(
    J.cleanProjectName("Draft Tentative RulingsToggle chats for Draft Tentative Rulings"),
    "Draft Tentative Rulings"
  );
  // With the date metadata after it, as a raw scrape carries it.
  assert.equal(J.cleanProjectName("CutlistToggle chats for Cutlist2 hours ago"), "Cutlist");
});

test("projectUuidFromHref extracts the uuid", () => {
  assert.equal(
    J.projectUuidFromHref("/cowork/project/019f3fcd-9b35-7715-b2cc-b227512b5459"),
    "019f3fcd-9b35-7715-b2cc-b227512b5459"
  );
  assert.equal(J.projectUuidFromHref("/cowork/projects"), null);
});

test("sameConversationUrl matches the same chat across query/hash/slash and PWA", () => {
  const base = "https://claude.ai/chat/019f3fcd-9b35-7715-b2cc-b227512b5459";
  // Ignore trailing slash, query string, and hash (a PWA window may add params).
  assert.equal(J.sameConversationUrl(base, base + "/"), true);
  assert.equal(J.sameConversationUrl(base, base + "?utm=x"), true);
  assert.equal(J.sameConversationUrl(base, base + "#foo"), true);
  assert.equal(J.sameConversationUrl(base + "?a=1", base + "?b=2"), true);
  // Claude Code sessions match on their /code/session_… path.
  const cc = "https://claude.ai/code/session_01SXUhPi4YPzLy3o9qEHfphe";
  assert.equal(J.sameConversationUrl(cc, cc + "?ref=pwa"), true);
  // Different conversations / origins / garbage do not match.
  assert.equal(
    J.sameConversationUrl(base, "https://claude.ai/chat/aaaaaaaa-0000-0000-0000-000000000000"),
    false
  );
  assert.equal(J.sameConversationUrl(base, "https://example.com/chat/x"), false);
  assert.equal(J.sameConversationUrl(base, "not a url"), false);
  assert.equal(J.sameConversationUrl(cc, "https://claude.ai/new"), false);
});

// ---- cowork ---------------------------------------------------------------

test("a job says nothing about the surface unless it was asked to", () => {
  const j = J.newJob({ name: "x" }, "id", NOW);
  assert.equal(j.surface, null);
  assert.equal(j.approval, null);
  assert.equal(J.surfaceLabel(j), "");
});

test("a cowork job goes to the composer home even when it has a project", () => {
  // The toggle, the approval control and the project menu all live there and
  // nowhere else — arriving at the project page means arriving with no way to
  // set any of the three.
  const j = J.newJob(
    { surface: "cowork", projectHref: "/cowork/project/abc", projectName: "Cutlist" },
    "id",
    NOW
  );
  assert.equal(J.targetUrl(j), "https://claude.ai/new");
});

test("a chat job with a project still goes to the project, as it always did", () => {
  const j = J.newJob({ projectHref: "/cowork/project/abc" }, "id", NOW);
  assert.equal(J.targetUrl(j), "https://claude.ai/cowork/project/abc");
});

test("an existing conversation still wins over the surface", () => {
  const j = J.newJob({ surface: "cowork", chatUrl: "/chat/abc" }, "id", NOW);
  assert.equal(J.targetUrl(j), "https://claude.ai/chat/abc");
});

test("a cowork job with no destination reads as a Cowork session", () => {
  assert.equal(J.targetLabel(J.newJob({ surface: "cowork" }, "id", NOW)), "New Cowork session");
  assert.equal(J.targetLabel(J.newJob({ surface: "chat" }, "id", NOW)), "New chat");
});

test("the surface chip names the approval mode only where there is one", () => {
  require("../src/cowork.js");
  assert.equal(J.surfaceLabel(J.newJob({ surface: "chat", approval: "skip" }, "i", NOW)), "Chat");
  assert.equal(
    J.surfaceLabel(J.newJob({ surface: "cowork", approval: "skip" }, "i", NOW)),
    "Cowork · Skip all approvals"
  );
  assert.equal(J.surfaceLabel(J.newJob({ surface: "cowork" }, "i", NOW)), "Cowork");
});

test("cleanProjectName strips the chats-toggle caption a live run was armed with", () => {
  // Off a failed run's own note: the sidebar row's expander reads "Toggle
  // chats for <name>", textContent runs it straight onto the title, and the
  // doubled name filtered the project menu down to nothing.
  assert.equal(
    J.cleanProjectName("Draft Tentative RulingsToggle chats for Draft Tentative Rulings"),
    "Draft Tentative Rulings"
  );
  assert.equal(J.cleanProjectName("Draft Tentative Rulings"), "Draft Tentative Rulings");
});
