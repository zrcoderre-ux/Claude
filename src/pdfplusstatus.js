/**
 * Claude Usage Meter — the workflow runs as PDF+'s Home shows them (pure).
 *
 * The owner (November 2026), of PDF+'s Home: "I'd like to have the dashboard
 * display include the current status of any claude run going." PDF+ has no
 * network and cannot read this extension's storage, so the worker
 * (background.js, "PDF+'s Home: the runs") sends this summary to the E-Court
 * Suite's native host — the same host the PDF+ run route already uses — which
 * writes it into Downloads as FILE, where Home reads it.
 *
 * Only what Home shows goes out: each run's matter (its name, the case
 * number in it), the workflow it is a run of, where it stands in this
 * extension's own words (W.progressText), when it last moved, why it is held
 * or failed, and the address of the chat it last worked in. No prompt, reply,
 * paper or key. Drafts (set up, never armed) are not "going" and stay out;
 * a finished or canceled run stays listed for KEEP_ENDED_MS.
 */
(function (root) {
  "use strict";

  const W = root.CUMWorkflow || (typeof require === "function" ? require("./workflow.js") : null);

  const FILE = "Claude Run Status.json";
  const KEEP_ENDED_MS = 18 * 3600 * 1000;
  // While a run is going, the file is written again at least this often, so
  // Home can tell a run whose browser has gone quiet from one still working.
  const REFRESH_MS = 5 * 60 * 1000;
  const MAX_RUNS = 40;
  const ACTIVE = { pending: 1, waiting: 1, running: 1, paused: 1, error: 1 };
  const CASE_RE = /(?<![A-Za-z0-9])(?:(\d{2})[ -]?([A-Za-z]{4,6})[ -]?(\d{4,6})|([A-Za-z][CDFPQSTcdfpqst])[ -]?(\d{6}))(?![A-Za-z0-9])/;

  const str = (v) => (v == null ? "" : String(v));

  /** The first Los Angeles Superior Court case number in a name ("25STCV12345"), or "". */
  function caseNumberOf(name) {
    const m = CASE_RE.exec(str(name));
    if (!m) return "";
    return (m[1] ? m[1] + m[2] + m[3] : m[4] + m[5]).toUpperCase();
  }

  /** Whether a run is going (or stopped and waiting on someone), as opposed to over or never armed. */
  function isActive(run) {
    return !!run && !!ACTIVE[run.status];
  }

  /** The address of the chat the run last worked in (its transcript's newest step), else any it opened. */
  function lastChatUrl(run) {
    const chats = (run && run.chats) || {};
    const tr = Array.isArray(run && run.transcript) ? run.transcript : [];
    for (let i = tr.length - 1; i >= 0; i--) {
      const c = tr[i] && chats[tr[i].chatId];
      if (c && /^https:\/\/claude\.ai\//.test(str(c.url))) return c.url;
    }
    for (const k of Object.keys(chats)) if (/^https:\/\/claude\.ai\//.test(str(chats[k] && chats[k].url))) return chats[k].url;
    return "";
  }

  /**
   * The run's steps as Home draws them, like the runs list's history: [{ label
   * ("2A"), chat, pause, state: done | here | failed | todo, ms (how long it
   * took, where known) }], at most MAX_STEPS.
   */
  const MAX_STEPS = 30;
  function stepsOf(run, wf) {
    let plan = [];
    try { plan = W.planRun(W.runSource(run, wf)) || []; } catch (e) { plan = []; }
    const took = {};
    for (const t of run.transcript || []) if (t && typeof t.ms === "number") took[t.stepIndex] = t.ms;
    const at = run.stepIndex || 0;
    const here = (plan[at] && plan[at].wave) || [at];
    return plan.slice(0, MAX_STEPS).map((s) => {
      let state = "todo";
      if (run.status === "done" || s.index < at) state = "done";
      else if (here.indexOf(s.index) !== -1) state = run.status === "error" ? "failed" : run.status === "running" ? "here" : "next";
      const out = { label: str(s.label), chat: str(s.chatName), pause: s.kind === "pause", state };
      if (typeof took[s.index] === "number") out.ms = took[s.index];
      return out;
    });
  }

  /** One run as Home is told it. */
  function runEntry(run, wf, now) {
    const label = W.runLabel(run);
    const total = run.totalSteps || (run.plan && run.plan.steps ? run.plan.steps.length : 0);
    return {
      id: str(run.id),
      name: label.title,
      template: label.template,
      caseNumber: caseNumberOf(label.title),
      runDate: str(run.runDate),
      status: str(run.status),
      phase: str(run.phase),
      progress: W.progressText(run, wf),
      step: Math.min(total || 0, (run.stepIndex || 0) + (run.status === "done" ? 0 : 1)),
      total: total || 0,
      at: typeof run.lastProgressAt === "number" ? run.lastProgressAt : typeof run.createdAt === "number" ? run.createdAt : now,
      startedAt: typeof run.startedAt === "number" ? run.startedAt : null,
      finishedAt: typeof run.finishedAt === "number" && (run.status === "done" || run.status === "canceled") ? run.finishedAt : null,
      held: run.status === "waiting" ? str(run.holdReason).slice(0, 200) : "",
      error: run.status === "error" ? str(run.error).slice(0, 300) : "",
      url: lastChatUrl(run),
      steps: stepsOf(run, wf),
    };
  }

  /**
   * The file's contents: { version: 1, written, runs: [runEntry] } — the runs
   * going (newest move first), then those ended within KEEP_ENDED_MS.
   */
  function summarize(runs, workflows, now) {
    const t = now == null ? Date.now() : now;
    const out = [];
    for (const run of runs || []) {
      if (!run || !run.id) continue;
      const ended = run.status === "done" || run.status === "canceled";
      if (!isActive(run) && !ended) continue;
      if (ended && !(typeof run.finishedAt === "number" && t - run.finishedAt <= KEEP_ENDED_MS)) continue;
      const wf = W.getWorkflow ? W.getWorkflow(workflows || [], run.workflowId) : null;
      out.push(runEntry(run, wf, t));
    }
    out.sort((a, b) => (isActive(b) - isActive(a)) || b.at - a.at);
    return { version: 1, written: t, runs: out.slice(0, MAX_RUNS), workflows: workflowList(workflows) };
  }

  /**
   * The workflows PDF+'s Claude button offers (the owner, November 2026:
   * "change the claude run button to a drop down menu that lets me select the
   * workflow to run"): each one's id and name, as Options lists them, sorted
   * by name. Nothing of its prompts or papers.
   */
  const MAX_WORKFLOWS = 60;
  function workflowList(workflows) {
    const out = [];
    for (const wf of workflows || []) {
      if (!wf || !wf.id) continue;
      const name = String(wf.name || wf.templateName || "").replace(/\s+/g, " ").trim() || "(untitled)";
      out.push({ id: String(wf.id), name: name.slice(0, 120) });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return out.slice(0, MAX_WORKFLOWS);
  }

  /** What the file says, without when it was written: the same signature, nothing new to write. */
  function signature(data) {
    return JSON.stringify([((data && data.runs) || []).map((r) => [r.id, r.status, r.phase, r.progress, r.step, r.total, r.at, r.held, r.error, r.url, r.name, (r.steps || []).map((x) => x.state + (x.ms || "")).join(",")]),
      ((data && data.workflows) || []).map((w) => w.id + "=" + w.name)]);
  }

  /**
   * Whether to write now: something changed, or a run is going and the file
   * is older than REFRESH_MS (`last`: { sig, at } of the last write).
   */
  function shouldWrite(data, last, now) {
    const sig = signature(data);
    if (!last || last.sig !== sig) return true;
    const going = ((data && data.runs) || []).some(isActive);
    return going && (now == null ? Date.now() : now) - (last.at || 0) >= REFRESH_MS;
  }

  const api = { FILE, KEEP_ENDED_MS, REFRESH_MS, MAX_RUNS, MAX_STEPS, MAX_WORKFLOWS, caseNumberOf, isActive, lastChatUrl, stepsOf, runEntry, summarize, workflowList, signature, shouldWrite };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPdfPlusStatus = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
