/**
 * Claude Usage Meter — scheduled-send job model (pure, testable).
 *
 * A "job" queues files (+ optional prompt, + optional Project) to be sent to a
 * new claude.ai chat at a set time or when usage next resets. Job metadata
 * lives in chrome.storage.local (cum_jobs); file bytes live as data-URLs under
 * cum_file_<id> (chrome.storage is the extension's own store, readable from the
 * options page, the service worker, and content scripts alike).
 *
 * This module holds only the pure logic (no chrome/DOM), so it unit-tests
 * directly under Node.
 */
(function (root) {
  "use strict";

  const ORIGIN = "https://claude.ai";

  function fileKey(fileId) {
    return "cum_file_" + fileId;
  }

  // Build a job from form fields. `id`/`now` are injectable for tests.
  function newJob(fields, id, now) {
    const f = fields || {};
    return {
      id: id,
      name: (f.name || "").trim(),
      prompt: typeof f.prompt === "string" ? f.prompt : "",
      projectUuid: f.projectUuid || null,
      projectName: f.projectName || null,
      projectHref: f.projectHref || null,
      trigger:
        f.trigger && f.trigger.type === "time"
          ? { type: "time", at: f.trigger.at }
          : { type: "reset" },
      files: (f.files || []).map((x) => ({
        id: x.id,
        name: x.name,
        type: x.type || "",
        size: x.size || 0,
      })),
      status: "pending", // pending | running | done | error | canceled
      createdAt: now,
      firedAt: null,
      error: null,
    };
  }

  function upsertJob(jobs, job) {
    const list = (jobs || []).slice();
    const i = list.findIndex((j) => j.id === job.id);
    if (i === -1) list.push(job);
    else list[i] = job;
    return list;
  }

  function removeJob(jobs, id) {
    return (jobs || []).filter((j) => j.id !== id);
  }

  function getJob(jobs, id) {
    return (jobs || []).find((j) => j.id === id) || null;
  }

  // The claude.ai URL a job should open to compose its message.
  function targetUrl(job) {
    if (job && job.projectHref) return ORIGIN + job.projectHref;
    if (job && job.projectUuid) return ORIGIN + "/cowork/project/" + job.projectUuid;
    return ORIGIN + "/new";
  }

  // Time-triggered jobs that are due (pending and at <= now).
  function dueTimeJobs(jobs, now) {
    return (jobs || []).filter(
      (j) =>
        j.status === "pending" &&
        j.trigger &&
        j.trigger.type === "time" &&
        typeof j.trigger.at === "number" &&
        j.trigger.at <= now
    );
  }

  function pendingResetJobs(jobs) {
    return (jobs || []).filter(
      (j) => j.status === "pending" && j.trigger && j.trigger.type === "reset"
    );
  }

  function hasPendingResetJobs(jobs) {
    return pendingResetJobs(jobs).length > 0;
  }

  // The soonest future time-trigger among pending jobs (for scheduling one
  // alarm), or null.
  function nextTimeTrigger(jobs, now) {
    let soonest = null;
    for (const j of jobs || []) {
      if (j.status !== "pending" || !j.trigger || j.trigger.type !== "time") continue;
      if (typeof j.trigger.at !== "number") continue;
      if (j.trigger.at <= (soonest == null ? Infinity : soonest)) soonest = j.trigger.at;
    }
    return soonest;
  }

  // Parse a data-URL ("data:mime;base64,AAAA") into { mime, base64 }.
  function parseDataUrl(dataUrl) {
    if (typeof dataUrl !== "string") return null;
    const m = dataUrl.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
    if (!m) return null;
    return { mime: m[1] || "application/octet-stream", base64: m[3] || "", isBase64: !!m[2] };
  }

  // Tidy a scraped project link's text (which concatenates title + metadata)
  // down to a readable label: drop a trailing relative-time / "Mon DD" suffix.
  function cleanProjectName(raw) {
    let s = String(raw || "").replace(/\s+/g, " ").trim();
    s = s.replace(
      /(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,\s*\d{4})?|Yesterday|Today)\s*$/i,
      ""
    ).trim();
    return s.length > 80 ? s.slice(0, 80).trim() + "…" : s;
  }

  // Extract the project uuid from a "/cowork/project/<uuid>" href.
  function projectUuidFromHref(href) {
    const m = String(href || "").match(/\/project\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  const api = {
    ORIGIN,
    fileKey,
    newJob,
    upsertJob,
    removeJob,
    getJob,
    targetUrl,
    dueTimeJobs,
    pendingResetJobs,
    hasPendingResetJobs,
    nextTimeTrigger,
    parseDataUrl,
    cleanProjectName,
    projectUuidFromHref,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMJobs = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
