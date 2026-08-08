/* Claude Usage Meter — Options page: usage log table + CSV export */
(function () {
  "use strict";

  // ======================================================================
  // Sections
  // ======================================================================
  // Three panels in one page. Which one you were last on is remembered, so
  // reopening Options puts you back where you were working rather than at the
  // top of a page you have to scroll.
  const TAB_KEY = "cum_options_tab";
  const DEFAULT_TAB = "usage";

  function showTab(name, remember) {
    const tabs = Array.from(document.querySelectorAll(".tab"));
    const panels = Array.from(document.querySelectorAll(".panel"));
    const known = tabs.some((t) => t.getAttribute("data-panel") === name);
    const want = known ? name : DEFAULT_TAB;
    for (const t of tabs) {
      const on = t.getAttribute("data-panel") === want;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
    }
    for (const p of panels) p.hidden = p.getAttribute("data-panel") !== want;
    if (remember) {
      try {
        chrome.storage.local.set({ [TAB_KEY]: want });
      } catch (e) {
        /* ignore */
      }
    }
  }

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => showTab(t.getAttribute("data-panel"), true))
  );
  // Left/right across the tab strip, as a tablist is expected to behave.
  document.querySelector(".tabs")?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tabs = Array.from(document.querySelectorAll(".tab"));
    const at = tabs.findIndex((t) => t.classList.contains("on"));
    const next = tabs[(at + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    if (!next) return;
    e.preventDefault();
    showTab(next.getAttribute("data-panel"), true);
    next.focus();
  });

  // A section named in the URL wins over the remembered one, and is deliberately
  // not remembered itself: the run window's own copy of this page opens on
  // #workflows, and that shouldn't quietly decide where Options lands the next
  // time you open it from the toolbar.
  const asked = (location.hash || "").replace(/^#/, "");

  // Show something immediately, then correct it once storage answers — the
  // alternative is a blank page for a frame.
  showTab(asked || DEFAULT_TAB, false);
  if (!asked) {
    try {
      chrome.storage.local.get(TAB_KEY, (res) =>
        showTab((res && res[TAB_KEY]) || DEFAULT_TAB, false)
      );
    } catch (e) {
      /* ignore */
    }
  }

  const LOG_KEY = "cum_log";

  const el = {
    body: document.getElementById("log-body"),
    empty: document.getElementById("empty"),
    count: document.getElementById("count"),
    download: document.getElementById("download"),
    clear: document.getElementById("clear"),
    table: document.getElementById("log-table"),
    footnote: document.getElementById("footnote"),
  };

  let entries = [];

  function fmtDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function render() {
    const sorted = entries.slice().sort((a, b) => b.at - a.at); // newest first
    el.body.innerHTML = "";
    let anyApprox = false;
    for (const entry of sorted) {
      const tr = document.createElement("tr");
      const eventClass = entry.type === "hit100" ? "event-hit100" : "event-reset";
      const pctText = entry.percent == null ? "—" : `${entry.percent}%`;
      const approx = entry.approx
        ? ` <span class="approx" title="Reconstructed on load — no tab was open at the exact reset time, so this is the last value seen before it.">~</span>`
        : "";
      if (entry.approx) anyApprox = true;
      tr.innerHTML =
        `<td>${fmtDate(entry.at)}</td>` +
        `<td>${fmtTime(entry.at)}</td>` +
        `<td class="${eventClass}">${window.CUMLog.eventLabel(entry.type)}</td>` +
        `<td class="pct">${pctText}${approx}</td>`;
      el.body.appendChild(tr);
    }
    el.footnote.hidden = !anyApprox;
    el.count.textContent = entries.length
      ? `${entries.length} event${entries.length === 1 ? "" : "s"}`
      : "";
    el.table.hidden = entries.length === 0;
    el.empty.hidden = entries.length !== 0;
    el.download.disabled = entries.length === 0;
    el.clear.disabled = entries.length === 0;
  }

  function load() {
    chrome.storage.local.get(LOG_KEY, (res) => {
      entries = (res && res[LOG_KEY]) || [];
      render();
    });
  }

  function download() {
    const sorted = entries.slice().sort((a, b) => a.at - b.at); // chronological in the file
    const rows = sorted.map((e) => [
      fmtDate(e.at),
      fmtTime(e.at),
      window.CUMLog.eventLabel(e.type),
      e.percent == null ? "" : e.percent,
      e.approx ? "yes" : "",
    ]);
    const csv = window.CUMLog.buildCsv(rows, [
      "Date",
      "Time",
      "Event",
      "Usage %",
      "Approximate",
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `claude-usage-log-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  el.download.addEventListener("click", download);

  el.clear.addEventListener("click", () => {
    if (!confirm("Clear the entire usage log? This can't be undone.")) return;
    chrome.storage.local.set({ [LOG_KEY]: [] }, () => {
      entries = [];
      render();
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[LOG_KEY]) {
      entries = changes[LOG_KEY].newValue || [];
      render();
    }
  });

  load();


  // ======================================================================
  // Scheduled sends
  // ======================================================================
  const JOBS_KEY = "cum_jobs";
  const PROJECTS_KEY = "cum_projects";
  const J = window.CUMJobs;

  const jf = {
    list: document.getElementById("job-list"),
    empty: document.getElementById("job-empty"),
    mount: document.getElementById("job-form-mount"),
  };

  // The shared form (no chat context on the options page → New chat / projects).
  const jobForm = window.CUMJobForm.create(jf.mount, { onSubmitted: renderJobs });
  let jobsById = {};

  function triggerText(job) {
    if (job.trigger && job.trigger.type === "time")
      return "at " + new Date(job.trigger.at).toLocaleString();
    return "when usage resets";
  }
  const STATUS_LABEL = {
    pending: "Queued",
    waiting: "Waiting out an outage",
    running: "Sending…",
    done: "Sent",
    error: "Failed",
    canceled: "Canceled",
  };

  // Why a job is parked, and for how long — a held send that says nothing looks
  // exactly like a broken one.
  function holdText(job) {
    const S = window.CUMStatus;
    const waited =
      S && typeof job.heldSince === "number" ? S.fmtWaited(Date.now() - job.heldSince) : "";
    return (
      "⏸ " +
      (job.holdReason || "Claude is having problems") +
      (waited ? " · waiting " + waited : "") +
      " — it sends itself once this clears."
    );
  }

  function renderJobs() {
    chrome.storage.local.get(JOBS_KEY, (res) => {
      const jobs = (res && res[JOBS_KEY]) || [];
      jobsById = {};
      for (const j of jobs) jobsById[j.id] = j;
      const sorted = jobs.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      jf.list.innerHTML = "";
      for (const job of sorted) {
        const row = document.createElement("div");
        row.className = "job-item status-" + (job.status || "pending");
        const bits = [];
        if (job.files && job.files.length) bits.push(`${job.files.length} file${job.files.length === 1 ? "" : "s"}`);
        if (job.prompt) bits.push("prompt");
        const dest = J.targetLabel(job);
        if (dest && dest !== "New chat") bits.push(dest);
        if (job.model) bits.push(job.model);
        row.innerHTML =
          `<div class="job-head">` +
          `<div class="job-title">${escapeHtml(job.name || "(untitled)")}` +
          `<span class="job-badge">${STATUS_LABEL[job.status] || job.status}</span></div>` +
          `<div class="job-btns">` +
          // "Run now" on a held job is the override — it sends despite the outage.
          (J.isQueued(job)
            ? `<button class="job-run" data-id="${job.id}" title="${
                job.status === "waiting" ? "Send now, outage or not" : "Send now"
              }">Run now</button>`
            : "") +
          (job.status !== "running"
            ? `<button class="job-edit" data-id="${job.id}" title="Edit">Edit</button>`
            : "") +
          `<button class="job-del" data-id="${job.id}" title="Delete">✕</button>` +
          `</div></div>` +
          `<div class="job-main">` +
          `<div class="job-facts">` +
          bits.map((b) => `<span>${escapeHtml(b)}</span>`).join("") +
          `<span>${escapeHtml(triggerText(job))}</span>` +
          `</div>` +
          (job.error ? `<div class="job-err">${escapeHtml(job.error)}</div>` : "") +
          (job.status === "waiting"
            ? `<div class="job-hold">${escapeHtml(holdText(job))}</div>`
            : "") +
          (job.note ? `<div class="job-note">${escapeHtml(job.note)}</div>` : "") +
          `</div>`;
        jf.list.appendChild(row);
      }
      jf.empty.hidden = jobs.length !== 0;
      jf.list.querySelectorAll(".job-del").forEach((b) =>
        b.addEventListener("click", () => deleteJob(b.getAttribute("data-id")))
      );
      jf.list.querySelectorAll(".job-edit").forEach((b) =>
        b.addEventListener("click", () => {
          const job = jobsById[b.getAttribute("data-id")];
          if (job) jobForm.loadJob(job);
        })
      );
      jf.list.querySelectorAll(".job-run").forEach((b) =>
        b.addEventListener("click", () => {
          b.disabled = true;
          b.textContent = "Sending…";
          chrome.runtime.sendMessage({ type: "cum-run-now", jobId: b.getAttribute("data-id") }, () => {
            renderJobs();
          });
        })
      );
    });
  }

  function deleteJob(id) {
    chrome.storage.local.get(JOBS_KEY, (res) => {
      const jobs = (res && res[JOBS_KEY]) || [];
      const job = jobs.find((j) => j.id === id);
      const keys = job && job.files ? job.files.map((f) => J.fileKey(f.id)) : [];
      chrome.storage.local.set({ [JOBS_KEY]: J.removeJob(jobs, id) }, () => {
        if (keys.length) chrome.storage.local.remove(keys);
        renderJobs();
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[JOBS_KEY]) renderJobs();
  });

  renderJobs();


  // ======================================================================
  // Workflows (multi-chat runs)
  // ======================================================================
  const WORKFLOWS_KEY = "cum_workflows";
  // Runs are stored one per key (see workflow.js) so concurrent runs can't
  // overwrite each other; this reads them back as a list.
  function readRuns() {
    return new Promise((resolve) => {
      chrome.storage.local.get(WF.RUN_IDS_KEY, (r) => {
        const ids = (r && r[WF.RUN_IDS_KEY]) || [];
        if (!ids.length) return resolve([]);
        chrome.storage.local.get(ids.map(WF.runKey), (store) =>
          resolve(ids.map((id) => store[WF.runKey(id)]).filter(Boolean))
        );
      });
    });
  }
  const WF = window.CUMWorkflow;

  const wfui = {
    list: document.getElementById("wf-list"),
    empty: document.getElementById("wf-empty"),
    mount: document.getElementById("wf-form-mount"),
    newBtn: document.getElementById("wf-new"),
    runs: document.getElementById("wf-runs"),
    runsEmpty: document.getElementById("wf-runs-empty"),
  };

  const wfForm = window.CUMWorkflowForm.create(wfui.mount, {
    onSaved: renderWorkflows,
    onClosed: renderWorkflows,
  });
  let workflowsById = {};

  wfui.newBtn.addEventListener("click", () => wfForm.create());

  const RUN_STATUS_LABEL = {
    draft: "Not started",
    pending: "Queued",
    waiting: "Waiting out an outage",
    running: "Running",
    paused: "Paused",
    done: "Finished",
    error: "Stopped",
    canceled: "Canceled",
  };

  // "Drafting → Critic → Drafting → …" — the route the work takes, cut short
  // once it stops telling you anything new.
  function stepChain(wf) {
    const names = WF.planRun(wf).map((s) => s.chatName);
    const shown = names.slice(0, 6).join(" → ");
    return names.length > 6 ? shown + " → …" : shown;
  }

  function readWorkflows() {
    return new Promise((r) =>
      chrome.storage.local.get(WORKFLOWS_KEY, (res) => r((res && res[WORKFLOWS_KEY]) || []))
    );
  }

  // What this workflow usually costs, averaged over the runs of it that were
  // measured end to end. Percentage points of the weekly limit — the same units
  // the Usage tab's weekly meter is in, so "6%" here means six points of that
  // bar, not six percent of what you have left.
  const USAGE_NOTE =
    "Percentage points of your weekly limit, measured by watching the meter " +
    "across each step — and counted only for steps that had Claude to " +
    "themselves. A step that ran while any other chat was busy is left out " +
    "rather than credited with somebody else's work.";

  function workflowUsageFact(wf) {
    const u = wf && wf.usage;
    if (!u || !u.runs || typeof u.weekly !== "number") return "";
    return (
      `<span title="${escapeHtml(USAGE_NOTE)}">` +
      `~${escapeHtml(WF.formatPct(u.weekly))} of weekly per run` +
      ` <span class="job-dim">(over ${u.runs} run${u.runs === 1 ? "" : "s"}` +
      (typeof u.lastWeekly === "number"
        ? `, last ${escapeHtml(WF.formatPct(u.lastWeekly))}`
        : "") +
      `)</span></span>`
    );
  }

  // And what one run cost. Steps whose window reset mid-way can't be measured,
  // so the count is shown whenever it isn't the whole run — a total quietly
  // missing three steps would read as a cheap matter.
  function runUsageFact(run) {
    const u = WF.runUsage(run);
    if (!u.measured || typeof u.weekly !== "number") return "";
    return (
      `<span title="${escapeHtml(USAGE_NOTE)}">` +
      `${escapeHtml(WF.formatPct(u.weekly))} of weekly used` +
      (u.complete
        ? ""
        : ` <span class="job-dim">(${u.measured} of ${u.steps} steps had Claude to themselves)</span>`) +
      `</span>`
    );
  }

  function renderWorkflows() {
    readWorkflows().then((list) => {
      workflowsById = {};
      for (const w of list) workflowsById[w.id] = w;
      const sorted = list.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      wfui.list.innerHTML = "";
      for (const wf of sorted) {
        const row = document.createElement("div");
        row.className = "job-item";
        const armed = (wf.chats || []).filter((c) => c.startUrl);
        row.innerHTML =
          `<div class="job-head">` +
          `<div class="job-title">${escapeHtml(wf.name || "(untitled)")}` +
          (wf.builtin ? `<span class="job-badge">Pre-built</span>` : "") +
          // Armed for a matter: say so, and name the template it will go back
          // to, so a list of similarly-named rows stays readable.
          (wf.templateName && wf.templateName !== wf.name
            ? `<span class="job-badge">${escapeHtml(wf.templateName)}</span>`
            : "") +
          `</div>` +
          `<div class="job-btns">` +
          `<button class="job-edit wf-edit" data-id="${wf.id}" title="Edit">Edit</button>` +
          `<button class="job-edit wf-copy" data-id="${wf.id}" title="Duplicate">Copy</button>` +
          `<button class="job-run wf-create" data-id="${wf.id}" ` +
          `title="Set this workflow up for a matter, down in Runs — nothing starts until you say so">` +
          `Create run</button>` +
          `<button class="job-del wf-del" data-id="${wf.id}" title="Delete">✕</button>` +
          `</div></div>` +
          `<div class="job-main">` +
          (wf.description ? `<div class="job-desc">${escapeHtml(wf.description)}</div>` : "") +
          `<div class="job-facts">` +
          `<span>${escapeHtml(WF.summarize(wf))}</span>` +
          // No upload summary here. A template's documents belong to whatever
          // matter is next, and warning that a workflow will upload nothing is
          // warning about a run that doesn't exist yet — the run's own row says
          // it, while there's still something to do about it.
          (armed.length
            ? `<span>starts in an existing chat: ${escapeHtml(
                armed.map((c) => c.name).join(", ")
              )}</span>`
            : "") +
          workflowUsageFact(wf) +
          `</div>` +
          // No trigger here either: when a matter goes is the matter's business.
          // Create run makes the run, and its own editor asks when it starts.
          `<div class="job-chain">${escapeHtml(stepChain(wf))}</div>` +
          `</div>`;
        wfui.list.appendChild(row);
      }
      wfui.empty.hidden = list.length !== 0;

      wfui.list.querySelectorAll(".wf-edit").forEach((b) =>
        b.addEventListener("click", () => {
          const wf = workflowsById[b.getAttribute("data-id")];
          if (wf) wfForm.edit(wf);
        })
      );
      wfui.list.querySelectorAll(".wf-copy").forEach((b) =>
        b.addEventListener("click", () => copyWorkflow(b.getAttribute("data-id")))
      );
      wfui.list.querySelectorAll(".wf-del").forEach((b) =>
        b.addEventListener("click", () => deleteWorkflow(b.getAttribute("data-id")))
      );
      wfui.list.querySelectorAll(".wf-create").forEach((b) =>
        b.addEventListener("click", () => createRun(b, b.getAttribute("data-id")))
      );
    });
  }

  // Set a workflow up for a matter without arming the workflow itself. The run
  // is created immediately — with no trigger, so nothing can pick it up — and
  // opened for editing, which is where this matter's name, papers and tweaks
  // go. Close it without starting and the run simply waits at the top of the
  // list. The template goes back to its resting state either way, so the
  // Workflows section stays a list of templates rather than of matters.
  function createRun(btn, id) {
    if (wfForm.editingId() === id) {
      if (
        !confirm(
          "This workflow is open in the editor. The run copies the SAVED version — " +
            "any changes you haven't saved won't be included. Create the run anyway?"
        )
      )
        return;
    }
    btn.disabled = true;
    btn.textContent = "Creating…";
    chrome.runtime.sendMessage(
      { type: "cum-wf-run", workflowId: id, trigger: { type: "draft" } },
      (res) => {
        btn.disabled = false;
        btn.textContent = "Create run";
        if (!res || !res.ok)
          return alert("Could not create the run: " + ((res && res.error) || "unknown error"));
        renderWorkflows();
        // Straight into the run's own editor — the papers are the first thing
        // you'd want to add, and the whole point is that they go on the run.
        renderRuns().then(() => openRunEditor(res.runId));
      }
    );
  }

  function copyWorkflow(id) {
    readWorkflows().then((list) => {
      const wf = WF.getWorkflow(list, id);
      if (!wf) return;
      const copy = WF.cloneWorkflow(wf, crypto.randomUUID(), Date.now(), () => crypto.randomUUID());
      chrome.storage.local.set({ [WORKFLOWS_KEY]: WF.upsertWorkflow(list, copy) }, renderWorkflows);
    });
  }

  function deleteWorkflow(id) {
    readWorkflows().then((list) => {
      const wf = WF.getWorkflow(list, id);
      if (!wf) return;
      if (!confirm(`Delete “${wf.name}”? Its documents are deleted too. This can't be undone.`))
        return;
      const next = WF.removeWorkflow(list, id);
      // Only bin document bytes nothing else still needs — a copy of this
      // workflow, or a RUN that took these papers with it and may still be
      // uploading them.
      readRuns().then((allRuns) => {
        const stillUsed = WF.fileIdsInUse(next, null);
        const heldByRuns = WF.runFileIds(allRuns);
        const dead = (wf.docs || [])
          .map((d) => d.id)
          .filter((fid) => !stillUsed.has(fid) && !heldByRuns.has(fid));
        chrome.storage.local.set({ [WORKFLOWS_KEY]: next }, () => {
          if (dead.length) chrome.storage.local.remove(dead.map((fid) => J.fileKey(fid)));
          renderWorkflows();
        });
      });
    });
  }

  // ---- runs ----
  // What each finished step actually did — including how many documents went up
  // with it, so an upload that didn't happen is visible after the fact.
  // "0k chars" for a 40-character reply is worse than useless — it hides the
  // very thing worth noticing, which is that a step handed on almost nothing.
  function fmtChars(n) {
    const c = n || 0;
    if (c < 1000) return c + " chars";
    return Math.round(c / 100) / 10 + "k chars";
  }

  function transcriptHtml(run) {
    const steps = (run.transcript || [])
      .map((t) => {
        const thin = (t.chars || 0) < 400; // a reply this short is rarely the work
        const cls = "run-step" + (t.docs ? " has-docs" : "") + (thin ? " thin" : "");
        const took = typeof t.ms === "number" ? WF.formatMs(t.ms) : "";
        const split =
          typeof t.sendMs === "number" && typeof t.replyMs === "number"
            ? ` — ${WF.formatMs(t.sendMs)} sending, ${WF.formatMs(t.replyMs)} waiting for Claude`
            : "";
        return (
          `<span class="${cls}"${took ? ` title="Step ${t.stepIndex + 1} took ${escapeHtml(took)}${escapeHtml(split)}"` : ""}>` +
          `<b>${t.stepIndex + 1}</b> · ${escapeHtml(fmtChars(t.chars))}` +
          (t.docs ? ` · ${t.docs} doc${t.docs === 1 ? "" : "s"}` : "") +
          (took ? ` · ${escapeHtml(took)}` : "") +
          `</span>`
        );
      })
      .join("");
    return `<div class="run-steps">${steps}</div>`;
  }

  // ---- reading a run's steps ----
  // Which run has its steps open for reading. Separate from the editor: seeing
  // what a stopped run was about to send shouldn't mean opening it for edit and
  // risking a change you didn't intend.
  let showingStepsFor = null;

  // What a finished step cost, split into getting the message out (composing it,
  // uploading its documents) and waiting for the answer — the second being the
  // figure that varies, and the one worth knowing when a run feels slow. Steps
  // resumed from an earlier version of the run have no honest start, and say
  // nothing rather than guessing.
  function stepTimingLine(t) {
    if (!t || typeof t.ms !== "number") return "";
    const bits = [`took <b>${escapeHtml(WF.formatMs(t.ms))}</b>`];
    if (typeof t.sendMs === "number" && typeof t.replyMs === "number")
      bits.push(
        `${escapeHtml(WF.formatMs(t.sendMs))} sending · ${escapeHtml(WF.formatMs(t.replyMs))} waiting`
      );
    if (t.stoppedMs > 30000) bits.push(`${escapeHtml(WF.formatMs(t.stoppedMs))} stopped, not counted`);
    if (typeof t.usedWeekly === "number")
      bits.push(`${escapeHtml(WF.formatPct(t.usedWeekly))} of weekly`);
    else if (t.usageShared) bits.push("usage not measured — other chats were busy");
    if (typeof t.chars === "number") bits.push(`${t.chars.toLocaleString()} chars back`);
    return `<div class="wf-step-timing">${bits.join(" · ")}</div>`;
  }

  function stepsPanel(run, wf) {
    const plan = WF.planRun(WF.runSource(run, wf));
    if (!plan.length) return "";
    const timings = {};
    for (const t of run.transcript || []) if (t) timings[t.stepIndex] = t;
    const rows = plan
      .map((s) => {
        const done = s.index < run.stepIndex;
        const here = s.index === run.stepIndex;
        const cls = "wf-step-row" + (done ? " done" : "") + (here ? " here" : "");
        const state = done ? "done" : here ? "next" : "";
        return (
          `<div class="${cls}">` +
          `<div class="wf-step-no"><b>${s.index + 1}</b>${
            state ? `<span class="wf-step-state">${state}</span>` : ""
          }</div>` +
          `<div class="wf-step-body">` +
          `<div class="wf-step-meta">${escapeHtml(s.chatName)}` +
          (s.modelOn ? ` · ${escapeHtml(s.modelOn)}${s.modelOverride ? " (this step only)" : ""}` : "") +
          (s.carry ? ` · carries the previous reply as “${escapeHtml(s.carryLabel)}”` : "") +
          (s.docIds.length ? ` · ${s.docIds.length} document${s.docIds.length === 1 ? "" : "s"}` : "") +
          (s.marker ? ` · must contain “${escapeHtml(s.marker)}”` : "") +
          `</div>` +
          stepTimingLine(timings[s.index]) +
          `<pre class="wf-step-prompt-view">${escapeHtml(s.prompt || "(no prompt)")}</pre>` +
          `</div></div>`
        );
      })
      .join("");
    return `<div class="wf-steps-panel">${rows}</div>`;
  }

  // ---- fixing a partial run ----
  // Which run has its "continue from" panel open, and the choices made in it so
  // far (kept out here so a re-render doesn't wipe them).
  let fixingRunId = null;
  let fixDraft = null;

  function openFix(run, wf) {
    const source = WF.runSource(run, wf);
    const plan = WF.planRun(source);
    // Default to the step it stopped on, and to re-reading the hand-off — the
    // common case is "that step went wrong, do it again with what's in the
    // other chat now".
    const stepIndex = Math.min(run.stepIndex, Math.max(0, plan.length - 1));
    fixingRunId = run.id;
    // Reading the steps is what you do before deciding to fix. Once you've
    // decided, the prompts are just a wall of text between you and the panel.
    showingStepsFor = null;
    fixDraft = Object.assign(
      {
        stepIndex,
        chats: {},
      },
      WF.exclusiveFix({
        refetchCarry: !!WF.carrySource(source, stepIndex).needed,
        sent: run.phase === "awaiting-reply",
      })
    );
    for (const c of source.chats || [])
      fixDraft.chats[c.id] = ((run.chats || {})[c.id] || {}).url || "";
    renderRuns();
  }

  function fixPanel(run, wf) {
    if (!fixDraft) return "";
    // A run's own steps, not the template's — they may have diverged.
    const source = WF.runSource(run, wf);
    const plan = WF.planRun(source);
    const src = WF.carrySource(source, fixDraft.stepIndex);
    const opts = plan
      .map(
        (s, i) =>
          `<option value="${i}"${i === fixDraft.stepIndex ? " selected" : ""}>` +
          `Step ${i + 1} — ${escapeHtml(s.chatName)}</option>`
      )
      .join("");
    const chatRows = ((wf && wf.chats) || [])
      .map(
        (c) =>
          `<label class="wf-fix-chat"><span>${escapeHtml(c.name)}</span>` +
          `<input type="text" class="wf-fix-url" data-chat="${escapeHtml(c.id)}" ` +
          `value="${escapeHtml(fixDraft.chats[c.id] || "")}" placeholder="https://claude.ai/chat/…" /></label>`
      )
      .join("");
    // The step you've picked, spelled out. "Step 4 — Drafting" is not enough to
    // choose by: what you're deciding is which prompt goes out next, and the
    // difference between step 4 and step 6 is the prompt.
    const chosen = plan[fixDraft.stepIndex];
    const facts = chosen
      ? [escapeHtml(chosen.chatName)]
          .concat(chosen.modelOn ? [escapeHtml(chosen.modelOn)] : [])
          .concat(
            chosen.docIds.length
              ? [chosen.docIds.length + " document" + (chosen.docIds.length === 1 ? "" : "s")]
              : []
          )
          .concat(chosen.carry ? ["carries in as “" + escapeHtml(chosen.carryLabel) + "”"] : [])
          .concat(chosen.marker ? ["must contain “" + escapeHtml(chosen.marker) + "”"] : [])
          .join(" · ")
      : "";

    return (
      `<div class="wf-fix">` +
      `<div class="wf-fix-row"><b>Continue from</b> <select class="wf-fix-step">${opts}</select></div>` +
      (chosen
        ? `<div class="wf-fix-step-view">` +
          `<div class="wf-step-meta">${facts}</div>` +
          `<pre class="wf-step-prompt-view">${escapeHtml(chosen.prompt || "(no prompt)")}</pre>` +
          `</div>`
        : "") +
      (src.needed
        ? `<label class="wf-fix-check"><input type="checkbox" class="wf-fix-refetch"${
            fixDraft.refetchCarry ? " checked" : ""
          } /> Re-read <b>${escapeHtml(src.chatName)}</b>'s latest reply and carry it into this step` +
          `</label>`
        : `<div class="wf-fix-note">This step carries nothing in — it just runs its own prompt.</div>`) +
      `<label class="wf-fix-check"><input type="checkbox" class="wf-fix-sent"${
        fixDraft.sent ? " checked" : ""
      } /> This step's message already went out — wait for the reply instead of sending it again</label>` +
      (src.needed
        ? `<div class="wf-fix-note">Those two are alternatives — a message that has already gone ` +
          `out carries whatever it carries, so ticking one clears the other.</div>`
        : "") +
      `<div class="wf-fix-note">Conversations this run is using (edit if it lost track of one):</div>` +
      chatRows +
      `<div class="wf-fix-row"><button class="job-run wf-fix-go" data-id="${run.id}">Continue run</button>` +
      `<button class="job-edit wf-fix-cancel" data-id="${run.id}">Cancel</button></div>` +
      `</div>`
    );
  }

  function wireFixPanel() {
    const stepSel = wfui.runs.querySelector(".wf-fix-step");
    if (stepSel)
      stepSel.addEventListener("change", () => {
        fixDraft.stepIndex = parseInt(stepSel.value, 10) || 0;
        // Whether there's anything to carry — and from which chat — changes with
        // the step, so the panel has to be redrawn.
        const run = (lastRuns || []).find((r) => r.id === fixingRunId);
        const source = WF.runSource(run, fixWorkflow());
        fixDraft.refetchCarry = !!WF.carrySource(source, fixDraft.stepIndex).needed;
        fixDraft.sent = false; // a different step's message hasn't gone out
        renderRuns();
      });
    const refetch = wfui.runs.querySelector(".wf-fix-refetch");
    if (refetch)
      refetch.addEventListener("change", () => {
        fixDraft.refetchCarry = refetch.checked;
        Object.assign(fixDraft, WF.exclusiveFix(fixDraft, "refetch"));
        renderRuns();
      });
    const sent = wfui.runs.querySelector(".wf-fix-sent");
    if (sent)
      sent.addEventListener("change", () => {
        fixDraft.sent = sent.checked;
        Object.assign(fixDraft, WF.exclusiveFix(fixDraft, "sent"));
        renderRuns();
      });
    wfui.runs.querySelectorAll(".wf-fix-url").forEach((i) =>
      i.addEventListener("input", () => (fixDraft.chats[i.getAttribute("data-chat")] = i.value.trim()))
    );
    const cancel = wfui.runs.querySelector(".wf-fix-cancel");
    if (cancel)
      cancel.addEventListener("click", () => {
        fixingRunId = null;
        fixDraft = null;
        renderRuns();
      });
    const go = wfui.runs.querySelector(".wf-fix-go");
    if (go)
      go.addEventListener("click", () => {
        const id = go.getAttribute("data-id");
        const chats = {};
        for (const cid of Object.keys(fixDraft.chats)) chats[cid] = { url: fixDraft.chats[cid] };
        const choice = WF.exclusiveFix(fixDraft, "sent");
        const patch = {
          stepIndex: fixDraft.stepIndex,
          phase: choice.sent ? "awaiting-reply" : "idle",
          refetchCarry: choice.refetchCarry,
          chats,
        };
        go.disabled = true;
        go.textContent = fixDraft.refetchCarry ? "Reading the other chat…" : "Continuing…";
        chrome.runtime.sendMessage({ type: "cum-wf-resume", runId: id, patch }, (res) => {
          fixingRunId = null;
          fixDraft = null;
          if (res && !res.ok) alert("Could not continue: " + (res.error || "unknown error"));
          renderRuns();
        });
      });
  }

  let lastWorkflows = [];
  let lastRuns = [];
  function fixWorkflow() {
    const run = (lastRuns || []).find((r) => r.id === fixingRunId);
    return run ? WF.getWorkflow(lastWorkflows, run.workflowId) : null;
  }

  // What a datetime-local input wants: local time, "YYYY-MM-DDTHH:mm".
  function toLocalDatetime(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      "T" + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  }

  // A queued run's trigger, changeable in place — a hearing moves, or you want
  // it to go now rather than at the next reset.
  function retriggerBar(run) {
    const t = run.trigger || {};
    const at = t.type === "time" && typeof t.at === "number" ? toLocalDatetime(t.at) : "";
    const opt = (v, label) =>
      `<option value="${v}"${t.type === v ? " selected" : ""}>${label}</option>`;
    // The same control does two jobs: it starts a run that has never been armed,
    // and it reschedules one that's already queued. Only the verb differs.
    const draft = WF.isDraft(run);
    return (
      `<div class="job-meta wf-run-bar">` +
      (draft ? `<span class="wf-run-bar-lead">Start this run</span> ` : "") +
      `<select class="wf-when-run" data-id="${run.id}">` +
      opt("now", "Run now") +
      opt("reset", "When usage resets") +
      opt("time", "At a set time") +
      `</select> ` +
      `<input class="wf-at-run" type="datetime-local" data-id="${run.id}" value="${at}"${
        t.type === "time" ? "" : " disabled"
      } /> ` +
      `<button class="job-run wf-retrigger" data-id="${run.id}">${
        draft ? "Start" : "Change"
      }</button>` +
      `</div>`
    );
  }

  function runHoldText(run) {
    const S = window.CUMStatus;
    const waited =
      S && typeof run.heldSince === "number" ? S.fmtWaited(Date.now() - run.heldSince) : "";
    return (
      "⏸ " +
      (run.holdReason || "Claude is having problems") +
      (waited ? " · waiting " + waited : "") +
      " — it picks up where it left off once this clears."
    );
  }

  // What the run has cost in time so far, on the row itself: the total it has
  // spent working, and the typical step, which is what tells you whether the
  // next one is nearly done or barely started. Median, not mean — one step that
  // stalled for an hour shouldn't get to describe the other eight.
  function timingFact(run) {
    const t = WF.timingSummary(run);
    if (!t.steps) return "";
    return (
      `<span title="Working time only — time the run spent paused, held or stopped is excluded">` +
      `${escapeHtml(WF.formatMs(t.totalMs))} of work` +
      (t.steps > 1
        ? ` · typical step ${escapeHtml(WF.formatMs(t.medianMs))}` +
          ` · longest ${escapeHtml(WF.formatMs(t.longestMs))}` +
          ` (step ${(t.longest.stepIndex || 0) + 1})`
        : "") +
      `</span>`
    );
  }

  // The run's own editor: this matter's name, its papers, and any tweak to the
  // steps that belongs to this matter rather than to the template. Reached both
  // from Edit run and straight after Create run, which is the same act.
  function openRunEditor(runId) {
    const run = (lastRuns || []).find((r) => r.id === runId);
    if (!run) return;
    wfForm.editRun(run, (edited, trigger) => {
      // Documents new to a run ALREADY UNDER WAY are stamped with the step it
      // has reached, so they go up with the next step in their chats rather than
      // trying to ride an opening message that has already been sent. A run that
      // hasn't started yet has no such problem — its papers are just its papers.
      chrome.runtime.sendMessage(
        {
          type: "cum-wf-edit-run",
          runId: run.id,
          patch: {
            name: edited.name,
            chats: edited.chats,
            steps: edited.steps,
            docs: edited.docs,
          },
        },
        (res) => {
          if (res && !res.ok) {
            alert("Could not save: " + (res.error || "unknown error"));
            return renderRuns();
          }
          // The editor's own "When it starts" — applied after the edit, so the
          // run that goes is the one you just finished setting up.
          if (!trigger || !WF.canRetrigger(run)) return renderRuns();
          const armed = Object.assign({}, run, {
            docs: edited.docs,
            plan: { chats: edited.chats, steps: edited.steps },
          });
          // "Not yet" needs no confirming — nothing is about to go out. On a run
          // that was queued it puts it back to a draft, which is the only way to
          // un-schedule one without cancelling it.
          if (trigger.type !== "draft" && !WF.totalUploads(WF.runSource(armed, null))) {
            const stray = (edited.docs || []).length;
            if (
              !confirm(
                stray
                  ? `This run has ${stray} document(s), but none are ticked for a chat — nothing will be uploaded. Start it anyway?`
                  : "This run has no documents attached — its first message goes out with nothing. Start it anyway?"
              )
            )
              return renderRuns();
          }
          chrome.runtime.sendMessage(
            { type: "cum-wf-retrigger", runId: run.id, trigger },
            (r2) => {
              if (r2 && !r2.ok) alert("Saved, but could not start: " + (r2.error || "unknown error"));
              renderRuns();
            }
          );
        }
      );
    });
  }

  function renderRuns() {
    return Promise.all([
      readRuns(),
      new Promise((r) => chrome.storage.local.get(WORKFLOWS_KEY, (x) => r((x && x[WORKFLOWS_KEY]) || []))),
    ]).then(([runs, workflows]) => {
      lastRuns = runs;
      lastWorkflows = workflows;
      // Runs still being set up sit at the top: they're the ones waiting on you,
      // and a matter you're preparing shouldn't be below yesterday's finished
      // one. Everything else stays newest-first.
      const sorted = runs
        .slice()
        .sort(
          (a, b) =>
            (WF.isDraft(b) ? 1 : 0) - (WF.isDraft(a) ? 1 : 0) ||
            (b.createdAt || 0) - (a.createdAt || 0)
        );
      wfui.runs.innerHTML = "";
      for (const run of sorted) {
        const wf = WF.getWorkflow(workflows, run.workflowId);
        const label = WF.runLabel(run);
        const source = WF.runSource(run, wf);
        const links = Object.keys(run.chats || {})
          .map((cid) => {
            const url = (run.chats[cid] || {}).url;
            if (!url) return "";
            const name = WF.chatName(WF.runSource(run, wf), cid);
            return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(
              name
            )}</a>`;
          })
          .filter(Boolean)
          .join(" · ");
        const row = document.createElement("div");
        row.className = "job-item status-" + (run.status || "pending");
        const btns =
          `<button class="job-edit wf-run-steps" data-id="${run.id}" title="Read this run's prompts">${
            showingStepsFor === run.id ? "Hide steps" : "Steps"
          }</button>` +
          (run.status === "error" || run.status === "waiting" || run.status === "paused"
            ? `<button class="job-run wf-run-resume" data-id="${run.id}" title="${escapeHtml(
                WF.resumePlan(run).action
              )}">Resume</button>`
            : "") +
          // Nothing to carry on from until it has run at all.
          ((WF.isRunActive(run) && run.status !== "waiting") || WF.isDraft(run)
            ? ""
            : `<button class="job-edit wf-run-fix" data-id="${run.id}" title="Choose where to carry on from">Fix &amp; continue</button>`) +
          (WF.isRunActive(run)
            ? `<button class="job-edit wf-run-pause" data-id="${run.id}" title="Stop at the next step so you can change something">Pause</button>`
            : "") +
          (run.status !== "running" && run.status !== "done"
            ? `<button class="${WF.isDraft(run) ? "job-run" : "job-edit"} wf-run-edit" data-id="${
                run.id
              }" title="${
                WF.isDraft(run)
                  ? "Name this matter, add its papers, tweak its steps — this run only"
                  : "Add a step, fix a prompt, add documents — this run only"
              }">${WF.isDraft(run) ? "Set up" : "Edit run"}</button>`
            : "") +
          (WF.isRunActive(run) || run.status === "paused"
            ? `<button class="job-edit wf-run-cancel" data-id="${run.id}" title="Stop here for good">Cancel</button>`
            : "") +
          (Object.keys(run.chats || {}).length
            ? `<button class="job-run wf-run-show" data-id="${run.id}" title="Bring this run's window forward, reopening its chats if they were closed">Open chats</button>`
            : "") +
          `<button class="job-edit wf-run-save" data-id="${run.id}" title="Keep this run's steps as a new workflow">Save as workflow</button>` +
          (!WF.isRunActive(run) && typeof run.windowId === "number"
            ? `<button class="job-edit wf-run-closewin" data-id="${run.id}" title="Close this run's Chrome window and its chats">Close window</button>`
            : "") +
          `<button class="job-del wf-run-del" data-id="${run.id}" title="Remove from the list">✕</button>`;

        row.innerHTML =
          `<div class="job-head">` +
          `<div class="job-title">${
            label.named
              ? escapeHtml(label.title)
              : `<span class="job-unnamed">${escapeHtml(label.title)}</span>`
          }` +
          // The workflow it's a run of, kept beside the matter's own name. A run
          // never borrows that name outright — a runs list that reads like a
          // second copy of the workflows list tells you nothing about which
          // matter is which.
          (label.template ? `<span class="job-badge">${escapeHtml(label.template)}</span>` : "") +
          `<span class="job-badge">${RUN_STATUS_LABEL[run.status] || run.status}</span></div>` +
          `<div class="job-btns">${btns}</div></div>` +
          `<div class="job-main">` +
          `<div class="job-facts">` +
          `<span><b>${escapeHtml(WF.progressText(run, wf))}</b></span>` +
          // What will actually go up, said while there's still time to fix it —
          // these prompts talk about "the attached papers", and Claude answers
          // from nothing in a way that looks like work.
          (WF.started(run)
            ? run.docs && run.docs.length
              ? `<span>${run.docs.length} document${run.docs.length === 1 ? "" : "s"}</span>`
              : ""
            : `<span${WF.totalUploads(source) ? "" : ' class="warn"'}>${escapeHtml(
                WF.uploadSummary(source)
              )}</span>`) +
          (run.trigger && run.trigger.type === "time" && run.status === "pending"
            ? `<span>at ${escapeHtml(new Date(run.trigger.at).toLocaleString())}</span>`
            : "") +
          (run.trigger && run.trigger.type === "reset" && run.status === "pending"
            ? `<span>when usage resets</span>`
            : "") +
          timingFact(run) +
          runUsageFact(run) +
          (links ? `<span>Chats: ${links}</span>` : "") +
          `</div>` +
          (WF.canRetrigger(run) ? retriggerBar(run) : "") +
          (run.transcript && run.transcript.length ? transcriptHtml(run) : "") +
          (run.error ? `<div class="job-err">${escapeHtml(run.error)}</div>` : "") +
          (run.status === "waiting" ? `<div class="job-hold">${escapeHtml(runHoldText(run))}</div>` : "") +
          (run.note ? `<div class="job-note">${escapeHtml(run.note)}</div>` : "") +
          (showingStepsFor === run.id ? stepsPanel(run, wf) : "") +
          (fixingRunId === run.id ? fixPanel(run, wf) : "") +
          `</div>`;
        wfui.runs.appendChild(row);
      }
      wfui.runsEmpty.hidden = runs.length !== 0;

      wfui.runs.querySelectorAll(".wf-run-cancel").forEach((b) =>
        b.addEventListener("click", () => {
          b.disabled = true;
          chrome.runtime.sendMessage({ type: "cum-wf-cancel", runId: b.getAttribute("data-id") }, renderRuns);
        })
      );
      wfui.runs.querySelectorAll(".wf-run-resume").forEach((b) =>
        b.addEventListener("click", () => {
          b.disabled = true;
          b.textContent = "Resuming…";
          chrome.runtime.sendMessage({ type: "cum-wf-resume", runId: b.getAttribute("data-id") }, renderRuns);
        })
      );
      wfui.runs.querySelectorAll(".wf-run-save").forEach((b) =>
        b.addEventListener("click", () => {
          const run = runs.find((r) => r.id === b.getAttribute("data-id"));
          if (!run) return;
          const wf = WF.getWorkflow(workflows, run.workflowId);
          const name = prompt(
            "Save this run's chats and steps as a new workflow, called:",
            WF.runLabel(run).title
          );
          if (name === null) return;
          const made = WF.workflowFromRun(
            Object.assign({}, run, { name: name.trim() || run.name }),
            wf,
            crypto.randomUUID(),
            Date.now(),
            () => crypto.randomUUID()
          );
          chrome.storage.local.get(WORKFLOWS_KEY, (r2) => {
            const list = (r2 && r2[WORKFLOWS_KEY]) || [];
            chrome.storage.local.set(
              { [WORKFLOWS_KEY]: WF.upsertWorkflow(list, made) },
              () => {
                renderWorkflows();
                showTab("workflows", true);
              }
            );
          });
        })
      );
      wfui.runs.querySelectorAll(".wf-run-pause").forEach((b) =>
        b.addEventListener("click", () => {
          b.disabled = true;
          b.textContent = "Pausing…";
          chrome.runtime.sendMessage({ type: "cum-wf-pause", runId: b.getAttribute("data-id") }, renderRuns);
        })
      );
      wfui.runs.querySelectorAll(".wf-run-edit").forEach((b) =>
        b.addEventListener("click", () => openRunEditor(b.getAttribute("data-id")))
      );
      wfui.runs.querySelectorAll(".wf-run-steps").forEach((b) =>
        b.addEventListener("click", () => {
          const id = b.getAttribute("data-id");
          showingStepsFor = showingStepsFor === id ? null : id;
          renderRuns();
        })
      );
      wfui.runs.querySelectorAll(".wf-when-run").forEach((sel) =>
        sel.addEventListener("change", () => {
          const at = sel.parentElement.querySelector(".wf-at-run");
          at.disabled = sel.value !== "time";
          if (!at.disabled && !at.value) at.value = toLocalDatetime(Date.now() + 3600000);
        })
      );
      wfui.runs.querySelectorAll(".wf-retrigger").forEach((b) =>
        b.addEventListener("click", () => {
          const bar = b.parentElement;
          const when = bar.querySelector(".wf-when-run").value;
          let trigger = { type: when === "reset" ? "reset" : "now" };
          if (when === "time") {
            const raw = bar.querySelector(".wf-at-run").value;
            const at = raw ? new Date(raw).getTime() : NaN;
            if (!Number.isFinite(at)) return alert("Pick a valid date & time.");
            if (at <= Date.now()) return alert("Pick a time in the future.");
            trigger = { type: "time", at };
          }
          // Starting a run that uploads nothing, silently, is the failure worth
          // catching: these prompts talk about "the attached papers", and Claude
          // will answer from nothing and make it look like work.
          const run = (lastRuns || []).find((r) => r.id === b.getAttribute("data-id"));
          if (WF.isDraft(run) && !WF.totalUploads(WF.runSource(run, null))) {
            const stray = (run.docs || []).length;
            if (
              !confirm(
                stray
                  ? `This run has ${stray} document(s), but none are ticked for a chat — nothing will be uploaded. Start anyway?`
                  : "This run has no documents attached — its first message goes out with nothing. Start anyway?"
              )
            )
              return;
          }
          b.disabled = true;
          chrome.runtime.sendMessage(
            { type: "cum-wf-retrigger", runId: b.getAttribute("data-id"), trigger },
            (res) => {
              b.disabled = false;
              if (res && !res.ok) alert("Could not change: " + (res.error || "unknown error"));
              renderRuns();
            }
          );
        })
      );
      wfui.runs.querySelectorAll(".wf-run-show").forEach((b) =>
        b.addEventListener("click", () => {
          b.disabled = true;
          chrome.runtime.sendMessage(
            { type: "cum-wf-show-chats", runId: b.getAttribute("data-id") },
            (res) => {
              b.disabled = false;
              if (res && !res.ok) alert("Could not open: " + (res.error || "unknown error"));
              // Opening one of two chats and looking like it worked is the
              // failure worth naming.
              else if (res && res.missing && res.missing.length)
                alert(
                  "Opened " + res.opened + " conversation" + (res.opened === 1 ? "" : "s") +
                    ". No conversation is recorded for: " + res.missing.join(", ") +
                    " — the run never got as far as opening " +
                    (res.missing.length === 1 ? "it" : "them") +
                    ", or its link was cleared. Fix & continue lets you paste one in."
                );
              renderRuns();
            }
          );
        })
      );
      wfui.runs.querySelectorAll(".wf-run-closewin").forEach((b) =>
        b.addEventListener("click", () => {
          b.disabled = true;
          chrome.runtime.sendMessage(
            { type: "cum-wf-close-window", runId: b.getAttribute("data-id") },
            renderRuns
          );
        })
      );
      wfui.runs.querySelectorAll(".wf-run-fix").forEach((b) =>
        b.addEventListener("click", () => {
          const id = b.getAttribute("data-id");
          if (fixingRunId === id) {
            fixingRunId = null;
            fixDraft = null;
            return renderRuns();
          }
          const run = runs.find((r) => r.id === id);
          if (run) openFix(run, WF.getWorkflow(workflows, run.workflowId));
        })
      );
      if (fixingRunId) wireFixPanel();
      wfui.runs.querySelectorAll(".wf-run-del").forEach((b) =>
        b.addEventListener("click", () => {
          const id = b.getAttribute("data-id");
          Promise.all([
            readRuns(),
            new Promise((r) =>
              chrome.storage.local.get([WORKFLOWS_KEY, WF.RUN_IDS_KEY], (x) => r(x || {}))
            ),
          ]).then(([list, store]) => {
            const run = WF.getRun(list, id);
            const rest = WF.removeRun(list, id);
            // The run owned this matter's papers; with the run gone, so are
            // they — unless another run or a workflow still points at them.
            const stillUsed = WF.fileIdsInUse(store[WORKFLOWS_KEY] || [], null);
            const heldByRuns = WF.runFileIds(rest);
            const dead = ((run && run.docs) || [])
              .map((d) => d.id)
              .filter((fid) => !stillUsed.has(fid) && !heldByRuns.has(fid));
            const ids = (store[WF.RUN_IDS_KEY] || []).filter((x) => x !== id);
            chrome.storage.local.set({ [WF.RUN_IDS_KEY]: ids }, () => {
              chrome.storage.local.remove(
                [WF.runKey(id), WF.beatKey(id)].concat(dead.map((fid) => J.fileKey(fid))),
                renderRuns
              );
            });
          });
        })
      );
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[WORKFLOWS_KEY] && !wfForm.isOpen()) renderWorkflows();
    // Any run's own key, or the list of them — but not the heartbeats, which
    // tick every 20 seconds and show nothing.
    const runChanged = Object.keys(changes).some(
      (k) =>
        k === WF.RUN_IDS_KEY ||
        (k.indexOf(WF.RUN_PREFIX) === 0 && k.indexOf(WF.BEAT_PREFIX) !== 0)
    );
    if (runChanged) renderRuns();
  });

  renderWorkflows();
  renderRuns();


  // ======================================================================
  // Daily usage (weekday profile of weekly-limit consumption)
  // ======================================================================
  const DAILY_KEY = "cum_daily";
  const D = window.CUMDaily;
  // Weeks start Tuesday (the 5-hour/weekly usage resets Tue 9am PT), so the
  // chart leads with Tuesday.
  const WEEK_ORDER = [2, 3, 4, 5, 6, 0, 1]; // Tue → Mon
  const WEEK_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const dl = {
    chart: document.getElementById("daily-chart"),
    empty: document.getElementById("daily-empty"),
    note: document.getElementById("daily-note"),
  };

  function fmtPts(n) {
    if (!(n > 0)) return "0%";
    return (Math.round(n * 10) / 10).toFixed(n >= 10 ? 0 : 1) + "%";
  }

  function localDateStr(d) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  // One chart row with two bars (running average + this week's actual).
  function dailyRow(label, avg, week, weekPresent, maxVal, note, extraClass) {
    const aw = Math.round((avg / maxVal) * 100);
    const ww = Math.round(((week || 0) / maxVal) * 100);
    return (
      `<div class="daily-row${extraClass || ""}">` +
      `<span class="daily-day">${label}</span>` +
      `<span class="daily-bars">` +
      `<span class="daily-bar-wrap"><i class="daily-bar avg" style="width:${avg > 0 ? aw : 0}%"></i></span>` +
      `<span class="daily-bar-wrap"><i class="daily-bar week" style="width:${weekPresent ? ww : 0}%"></i></span>` +
      `</span>` +
      `<span class="daily-val">` +
      `<span class="daily-avg">${avg > 0 ? fmtPts(avg) : "—"}</span>` +
      `<span class="daily-week">${weekPresent ? fmtPts(week) : (note || "")}</span>` +
      `</span></div>`
    );
  }

  function renderDaily() {
    chrome.storage.local.get(DAILY_KEY, (res) => {
      const model = (res && res[DAILY_KEY]) || null;
      const sum = D ? D.summary(model) : { totalDays: 0, avg: [], counts: [], avgTotal: 0 };
      const wk = D ? D.weekActual(model, localDateStr(new Date()), 2) : { actual: [], present: [], total: 0 };
      if (!sum.totalDays && !wk.total) {
        dl.chart.hidden = true;
        dl.note.hidden = true;
        dl.empty.hidden = false;
        return;
      }
      dl.empty.hidden = true;
      dl.chart.hidden = false;
      // Bars (avg and this-week) share one scale so they're directly comparable.
      const maxVal =
        Math.max.apply(
          null,
          WEEK_ORDER.map((wd) => sum.avg[wd] || 0).concat(WEEK_ORDER.map((wd) => wk.actual[wd] || 0))
        ) || 1;
      let html =
        `<div class="daily-legend">` +
        `<span class="daily-key"><i class="daily-bar avg"></i>running avg</span>` +
        `<span class="daily-key"><i class="daily-bar week"></i>this week</span></div>`;
      for (const wd of WEEK_ORDER) {
        const count = sum.counts[wd] || 0;
        html += dailyRow(
          WEEK_NAMES[wd],
          sum.avg[wd] || 0,
          wk.actual[wd] || 0,
          !!wk.present[wd],
          maxVal,
          count ? "" : "",
          count || wk.present[wd] ? "" : " daily-empty-day"
        );
      }
      // Weekly totals at the bottom: cumulative usage through THIS point in the
      // week — the average-to-date (typical usage by now) vs this week's actual —
      // so you can gauge whether you're running faster or slower than usual.
      const avgToDate = D ? D.weekAverageToDate(model, localDateStr(new Date()), 2) : 0;
      const maxTotal = Math.max(avgToDate || 0, wk.total || 0) || 1;
      html += dailyRow("Week", avgToDate || 0, wk.total || 0, true, maxTotal, "", " daily-total");
      dl.chart.innerHTML = html;

      dl.note.hidden = false;
      dl.note.textContent =
        `Based on ${sum.totalDays} day${sum.totalDays === 1 ? "" : "s"} of history` +
        ` · by this point in the week you've typically used ~${fmtPts(avgToDate)}; this week: ${fmtPts(wk.total)}` +
        ` (a full week averages ~${fmtPts(sum.avgTotal)}).`;
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[DAILY_KEY]) renderDaily();
  });

  renderDaily();


  // ======================================================================
  // Chat vs Claude Code split (pie)
  // ======================================================================
  const SPLIT_KEY = "cum_split";
  const S = window.CUMSplit;
  const CHAT_COLOR = "#c96442";
  const CODE_COLOR = "#4a7ebb";

  const sp = {
    wrap: document.getElementById("split-wrap"),
    empty: document.getElementById("split-empty"),
    pie: document.getElementById("split-pie"),
    legend: document.getElementById("split-legend"),
    tools: document.getElementById("split-tools"),
    reset: document.getElementById("split-reset"),
  };

  if (sp.reset) {
    sp.reset.addEventListener("click", () => {
      if (!confirm("Reset the Chat vs Code chart? This clears its tracked data and starts fresh.")) return;
      chrome.storage.local.remove("cum_split", renderSplit);
    });
  }

  function renderSplit() {
    chrome.storage.local.get(SPLIT_KEY, (res) => {
      const model = (res && res[SPLIT_KEY]) || null;
      const s = S ? S.share(model) : { total: 0, chatPct: 0, codePct: 0 };
      if (!s.total) {
        sp.wrap.hidden = true;
        if (sp.tools) sp.tools.hidden = true;
        sp.empty.hidden = false;
        return;
      }
      sp.empty.hidden = true;
      sp.wrap.hidden = false;
      if (sp.tools) sp.tools.hidden = false;
      const chat = Math.round(s.chatPct);
      const code = 100 - chat;
      sp.pie.style.background =
        `conic-gradient(${CHAT_COLOR} 0 ${s.chatPct}%, ${CODE_COLOR} ${s.chatPct}% 100%)`;
      const key = (color, label, val) =>
        `<div class="split-key"><span class="split-sw" style="background:${color}"></span>` +
        `${label} <b>${val}%</b></div>`;
      sp.legend.innerHTML =
        key(CHAT_COLOR, "Home (chat)", chat) + key(CODE_COLOR, "Code", code);
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SPLIT_KEY]) renderSplit();
  });

  renderSplit();


  // ======================================================================
  // Workflows' share of usage
  // ======================================================================
  // The same units as Daily Usage — percentage points of the weekly limit — so
  // the workflow ledger divides straight into the daily totals. Both are fed by
  // the rise in the weekly meter; this one only counts the rises that happened
  // while a run's step was working.
  const WFU_KEY = "cum_wf_usage";
  const UU = window.CUMWfUsage;
  const WFU_WINDOW = 7; // days — the weekly limit's own span

  const wu = {
    wrap: document.getElementById("wfu-wrap"),
    empty: document.getElementById("wfu-empty"),
    fill: document.getElementById("wfu-fill"),
    figures: document.getElementById("wfu-figures"),
    list: document.getElementById("wfu-list"),
    note: document.getElementById("wfu-note"),
  };

  function renderWfUsage() {
    if (!wu.wrap || !UU) return;
    chrome.storage.local.get([WFU_KEY, DAILY_KEY], (res) => {
      const model = (res && res[WFU_KEY]) || null;
      const daily = ((res && res[DAILY_KEY]) || {}).days || {};
      const dates = UU.lastDates(localDateStr(new Date()), WFU_WINDOW);
      const s = UU.share(model, daily, dates);
      if (!s.workflow) {
        wu.wrap.hidden = true;
        wu.empty.hidden = false;
        if (wu.note) wu.note.hidden = true;
        return;
      }
      wu.empty.hidden = true;
      wu.wrap.hidden = false;
      if (wu.note) wu.note.hidden = false;

      // No total to divide by means the daily ledger hasn't caught up, not that
      // workflows used everything — so the bar stays empty and says why.
      const pct = s.share == null ? 0 : s.share;
      wu.fill.style.width = pct + "%";
      const pts = (n) => (Math.round(n * 10) / 10) + " pts";
      wu.figures.innerHTML =
        s.share == null
          ? `<b>${escapeHtml(pts(s.workflow))}</b> of your weekly limit went through workflow runs ` +
            `in the last ${WFU_WINDOW} days. <span class="job-dim">No overall total recorded for those ` +
            `days yet, so there's nothing to compare it against.</span>`
          : `At least <b>${Math.round(s.share)}%</b> of your usage in the last ${WFU_WINDOW} days went ` +
            `through workflow runs — <b>${escapeHtml(pts(s.workflow))}</b> of ${escapeHtml(pts(s.total))} ` +
            `of the weekly limit. <span class="job-dim">Steps that shared Claude with another chat ` +
            `aren't counted, so the real figure is higher.</span>`;

      // All-time by workflow: which of them the spending actually went to.
      const rows = UU.byWorkflow(model).slice(0, 8);
      wu.list.innerHTML = rows.length
        ? `<div class="wfu-list-head">All time, by workflow</div>` +
          rows
            .map(
              (w) =>
                `<div class="wfu-row"><span>${escapeHtml(w.name || "(deleted workflow)")}</span>` +
                `<b>${escapeHtml(pts(w.pct))}</b>` +
                `<span class="job-dim">${w.steps} step${w.steps === 1 ? "" : "s"}</span></div>`
            )
            .join("")
        : "";
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes[WFU_KEY] || changes[DAILY_KEY])) renderWfUsage();
  });

  renderWfUsage();
})();
