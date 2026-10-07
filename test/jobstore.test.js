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

// ---- Chat and Cowork, merged ------------------------------------------------

test("a new job carries no surface, and no approval unless it was asked", () => {
  const j = J.newJob({ name: "x", surface: "cowork" }, "id", NOW);
  assert.equal("surface" in j, false, "claude.ai merged Chat and Cowork — nothing to pick");
  assert.equal(j.approval, null);
  assert.equal(J.approvalLabel(j), "");
});

const PROJ = "019f3fcd-9b35-7715-b2cc-b227512b5459";
// A job as it sits in storage from before the merge, set up on Cowork.
const legacy = (f) => Object.assign(J.newJob(f, "id", NOW), { surface: "cowork" });

test("a stored Cowork job with a project still opens at the project's page, by its id", () => {
  const j = legacy({ projectUuid: PROJ, projectHref: "/project/" + PROJ, projectName: "Cutlist" });
  assert.equal(J.targetUrl(j), "https://claude.ai/cowork/project/" + PROJ);
  // An id that only the href carries still counts.
  assert.equal(J.targetUrl(legacy({ projectHref: "/project/" + PROJ })), "https://claude.ai/cowork/project/" + PROJ);
  assert.equal(J.targetUrl(legacy({})), "https://claude.ai/new");
});

test("a new job with a project goes to the project it was given", () => {
  assert.equal(
    J.targetUrl(J.newJob({ projectUuid: PROJ, projectHref: "/project/" + PROJ }, "id", NOW)),
    "https://claude.ai/project/" + PROJ
  );
  assert.equal(J.targetUrl(J.newJob({ projectHref: "/cowork/project/abc" }, "id", NOW)), "https://claude.ai/cowork/project/abc");
  assert.equal(J.targetUrl(J.newJob({ projectUuid: PROJ }, "id", NOW)), "https://claude.ai/cowork/project/" + PROJ);
});

test("projectPageId is the project a job opens at, with targetUrl's precedence", () => {
  assert.equal(J.projectPageId(J.newJob({ projectUuid: PROJ }, "id", NOW)), PROJ);
  assert.equal(J.projectPageId(J.newJob({ projectHref: "/cowork/project/" + PROJ }, "id", NOW)), PROJ);
  assert.equal(J.projectPageId(J.newJob({}, "id", NOW)), null);
  assert.equal(J.projectPageId(null), null);
  // An existing conversation or a Code session wins over the project, as it
  // does in targetUrl — the tab is not opened at the project's page then.
  assert.equal(J.projectPageId(J.newJob({ projectUuid: PROJ, chatUrl: "/chat/abc" }, "id", NOW)), null);
  assert.equal(J.projectPageId(J.newJob({ projectUuid: PROJ, codeRepo: "a/b" }, "id", NOW)), null);
});

test("projectPageAt reads a project page's id off the address a send opens", () => {
  assert.equal(J.projectPageAt("https://claude.ai/cowork/project/" + PROJ), PROJ);
  assert.equal(J.projectPageAt("/cowork/project/" + PROJ.toUpperCase()), PROJ);
  assert.equal(J.projectPageAt("https://claude.ai/project/" + PROJ), null, "not a page the check knows");
  assert.equal(J.projectPageAt("https://claude.ai/new"), null);
  assert.equal(J.projectPageAt(null), null);
});

test("an existing conversation still wins over a stored surface", () => {
  assert.equal(J.targetUrl(legacy({ chatUrl: "/chat/abc" })), "https://claude.ai/chat/abc");
});

test("a job with no destination is a new chat, whatever it was set up on", () => {
  assert.equal(J.targetLabel(legacy({})), "New chat");
  assert.equal(J.targetLabel(J.newJob({}, "id", NOW)), "New chat");
});

test("the row names the approval mode only when the job set one", () => {
  require("../src/cowork.js");
  assert.equal(J.approvalLabel(J.newJob({ approval: "skip" }, "i", NOW)), "Skip all approvals");
  assert.equal(J.approvalLabel(J.newJob({}, "i", NOW)), "");
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

test("stripNonText drops the accordion icon's glyph and its invisible company", () => {
  // claude.ai draws the projects list's accordion with an icon font, so the
  // scraped row leads with a private-use codepoint — no glyph in any font the
  // extension renders in, which is the empty rectangle that showed up in front
  // of every project name in the workflow pickers.
  assert.equal(J.stripNonText(" Cutlist"), "Cutlist");
  assert.equal(J.stripNonText("Cutlist"), "Cutlist");
  // Planes 15 and 16 are private use too, and arrive as surrogate pairs.
  assert.equal(J.stripNonText("󰀀Cutlist"), "Cutlist");
  // The invisible marks a rich row sprinkles through its text.
  assert.equal(J.stripNonText("​Cut​list﻿"), "Cutlist");
  assert.equal(J.stripNonText("‪Cutlist‬"), "Cutlist");
  // And what a font substitutes for something it could not render.
  assert.equal(J.stripNonText("￼Cutlist"), "Cutlist");
  assert.equal(J.stripNonText("�Cutlist"), "Cutlist");
  // Text is left exactly as the user typed it — emoji and punctuation included.
  assert.equal(J.stripNonText("📁 Cutlist — v2"), "📁 Cutlist — v2");
  assert.equal(J.stripNonText(""), "");
  assert.equal(J.stripNonText(null), "");
});

test("cleanProjectName drops the icon glyph along with the rest of the debris", () => {
  assert.equal(J.cleanProjectName("Cutlist"), "Cutlist");
  assert.equal(
    J.cleanProjectName("Draft Tentative RulingsToggle chats for Draft Tentative Rulings"),
    "Draft Tentative Rulings"
  );
  assert.equal(J.cleanProjectName("Cutlist2 hours ago"), "Cutlist");
  // A name stored dirty before this fix is cleaned on the way out, too.
  assert.equal(J.targetLabel({ projectName: "Cutlist" }), "→ Cutlist");
});
