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

test("projectUuidFromHref extracts the uuid", () => {
  assert.equal(
    J.projectUuidFromHref("/cowork/project/019f3fcd-9b35-7715-b2cc-b227512b5459"),
    "019f3fcd-9b35-7715-b2cc-b227512b5459"
  );
  assert.equal(J.projectUuidFromHref("/cowork/projects"), null);
});
