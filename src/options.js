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

  // Show something immediately, then correct it once storage answers — the
  // alternative is a blank page for a frame.
  showTab(DEFAULT_TAB, false);
  try {
    chrome.storage.local.get(TAB_KEY, (res) => showTab((res && res[TAB_KEY]) || DEFAULT_TAB, false));
  } catch (e) {
    /* ignore */
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
          `<div class="job-main">` +
          `<div class="job-title">${escapeHtml(job.name || "(untitled)")}` +
          `<span class="job-badge">${STATUS_LABEL[job.status] || job.status}</span></div>` +
          `<div class="job-meta">${escapeHtml(bits.join(" · "))} · ${escapeHtml(triggerText(job))}</div>` +
          (job.error ? `<div class="job-err">${escapeHtml(job.error)}</div>` : "") +
          (job.status === "waiting"
            ? `<div class="job-hold">${escapeHtml(holdText(job))}</div>`
            : "") +
          (job.note ? `<div class="job-meta">⚠ ${escapeHtml(job.note)}</div>` : "") +
          `</div>` +
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
  const RUNS_KEY = "cum_wf_runs";
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

  function renderWorkflows() {
    readWorkflows().then((list) => {
      workflowsById = {};
      for (const w of list) workflowsById[w.id] = w;
      const sorted = list.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      wfui.list.innerHTML = "";
      for (const wf of sorted) {
        const row = document.createElement("div");
        row.className = "job-item";
        row.innerHTML =
          `<div class="job-main">` +
          `<div class="job-title">${escapeHtml(wf.name || "(untitled)")}` +
          (wf.builtin ? `<span class="job-badge">Pre-built</span>` : "") +
          // Armed for a matter: say so, and name the template it will go back
          // to, so a list of similarly-named rows stays readable.
          (wf.templateName && wf.templateName !== wf.name
            ? `<span class="job-badge">${escapeHtml(wf.templateName)}</span>`
            : "") +
          `</div>` +
          (wf.description ? `<div class="job-meta">${escapeHtml(wf.description)}</div>` : "") +
          `<div class="job-meta">${escapeHtml(WF.summarize(wf))} · ${escapeHtml(
            stepChain(wf)
          )}</div>` +
          `<div class="job-meta${WF.totalUploads(wf) ? "" : " job-err"}">${escapeHtml(
            WF.uploadSummary(wf)
          )}</div>` +
          (() => {
            const armed = (wf.chats || []).filter((c) => c.startUrl);
            return armed.length
              ? `<div class="job-meta">starts in an existing chat: ${escapeHtml(
                  armed.map((c) => c.name).join(", ")
                )}</div>`
              : "";
          })() +
          `<div class="job-meta wf-run-bar">` +
          `<select class="wf-when" data-id="${wf.id}">` +
          `<option value="now">Run now</option>` +
          `<option value="reset">When usage resets</option>` +
          `<option value="time">At a set time</option></select> ` +
          `<input class="wf-at" type="datetime-local" data-id="${wf.id}" disabled /> ` +
          `<button class="job-run wf-start" data-id="${wf.id}">Start</button>` +
          `</div></div>` +
          `<div class="job-btns">` +
          `<button class="job-edit wf-edit" data-id="${wf.id}" title="Edit">Edit</button>` +
          `<button class="job-edit wf-copy" data-id="${wf.id}" title="Duplicate">Copy</button>` +
          `<button class="job-del wf-del" data-id="${wf.id}" title="Delete">✕</button>` +
          `</div>`;
        wfui.list.appendChild(row);
      }
      wfui.empty.hidden = list.length !== 0;

      wfui.list.querySelectorAll(".wf-when").forEach((sel) =>
        sel.addEventListener("change", () => {
          const at = sel.parentElement.querySelector(".wf-at");
          at.disabled = sel.value !== "time";
        })
      );
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
      wfui.list.querySelectorAll(".wf-start").forEach((b) =>
        b.addEventListener("click", () => startWorkflow(b, b.getAttribute("data-id")))
      );
    });
  }

  function startWorkflow(btn, id) {
    const wf = workflowsById[id];
    // The editor holds changes in memory until Save, so a tick you just made is
    // not part of the run unless it was saved.
    if (wfForm.editingId() === id) {
      if (
        !confirm(
          "This workflow is open in the editor. The run uses the SAVED version — " +
            "any changes you haven't saved won't be included. Start anyway?"
        )
      )
        return;
    }
    // Don't let a run that uploads nothing start silently. These prompts talk
    // about "the attached papers"; Claude will answer anyway, from nothing, and
    // the result looks like work.
    if (wf && !WF.totalUploads(wf)) {
      const stray = (wf.docs || []).length;
      const msg = stray
        ? `“${wf.name}” has ${stray} document(s), but none are ticked for a chat — nothing will be uploaded. Start anyway?`
        : `“${wf.name}” has no documents attached — its first message goes out with nothing. Start anyway?`;
      if (!confirm(msg)) return;
    }
    const bar = btn.parentElement;
    const when = bar.querySelector(".wf-when").value;
    let trigger = { type: when === "reset" ? "reset" : "now" };
    if (when === "time") {
      const raw = bar.querySelector(".wf-at").value;
      const at = raw ? new Date(raw).getTime() : NaN;
      if (!Number.isFinite(at)) return alert("Pick a valid date & time.");
      if (at <= Date.now()) return alert("Pick a time in the future.");
      trigger = { type: "time", at };
    }
    btn.disabled = true;
    btn.textContent = "Starting…";
    chrome.runtime.sendMessage({ type: "cum-wf-run", workflowId: id, trigger }, (res) => {
      btn.disabled = false;
      btn.textContent = "Start";
      if (!res || !res.ok) alert("Could not start: " + ((res && res.error) || "unknown error"));
      renderRuns();
    });
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
      chrome.storage.local.get(RUNS_KEY, (r2) => {
        const stillUsed = WF.fileIdsInUse(next, null);
        const heldByRuns = WF.runFileIds((r2 && r2[RUNS_KEY]) || []);
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
  function transcriptText(run) {
    return (run.transcript || [])
      .map(
        (t) =>
          "· " + (t.stepIndex + 1) + (t.docs ? " (" + t.docs + " doc)" : "") +
          " → " + Math.round((t.chars || 0) / 100) / 10 + "k chars"
      )
      .join(" ");
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
    fixDraft = {
      stepIndex,
      refetchCarry: !!WF.carrySource(source, stepIndex).needed,
      sent: run.phase === "awaiting-reply",
      chats: {},
    };
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
    return (
      `<div class="wf-fix">` +
      `<div class="wf-fix-row"><b>Continue from</b> <select class="wf-fix-step">${opts}</select></div>` +
      (src.needed
        ? `<label class="wf-fix-check"><input type="checkbox" class="wf-fix-refetch"${
            fixDraft.refetchCarry ? " checked" : ""
          } /> Re-read <b>${escapeHtml(src.chatName)}</b>'s latest reply and carry it into this step` +
          `</label>`
        : `<div class="wf-fix-note">This step carries nothing in — it just runs its own prompt.</div>`) +
      `<label class="wf-fix-check"><input type="checkbox" class="wf-fix-sent"${
        fixDraft.sent ? " checked" : ""
      } /> This step's message already went out — wait for the reply instead of sending it again</label>` +
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
      refetch.addEventListener("change", () => (fixDraft.refetchCarry = refetch.checked));
    const sent = wfui.runs.querySelector(".wf-fix-sent");
    if (sent) sent.addEventListener("change", () => (fixDraft.sent = sent.checked));
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
        const patch = {
          stepIndex: fixDraft.stepIndex,
          phase: fixDraft.sent ? "awaiting-reply" : "idle",
          refetchCarry: !!fixDraft.refetchCarry && !fixDraft.sent,
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

  function renderRuns() {
    chrome.storage.local.get([RUNS_KEY, WORKFLOWS_KEY], (res) => {
      const runs = (res && res[RUNS_KEY]) || [];
      const workflows = (res && res[WORKFLOWS_KEY]) || [];
      lastRuns = runs;
      lastWorkflows = workflows;
      const sorted = runs.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      wfui.runs.innerHTML = "";
      for (const run of sorted) {
        const wf = WF.getWorkflow(workflows, run.workflowId);
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
        row.innerHTML =
          `<div class="job-main">` +
          `<div class="job-title">${escapeHtml(run.name || "Workflow")}` +
          `<span class="job-badge">${RUN_STATUS_LABEL[run.status] || run.status}</span></div>` +
          (run.docs && run.docs.length
            ? `<div class="job-meta">${run.docs.length} document${
                run.docs.length === 1 ? "" : "s"
              } — this run's own copy</div>`
            : "") +
          `<div class="job-meta">${escapeHtml(WF.progressText(run, wf))}` +
          (run.trigger && run.trigger.type === "time" && run.status === "pending"
            ? " · at " + escapeHtml(new Date(run.trigger.at).toLocaleString())
            : "") +
          (run.trigger && run.trigger.type === "reset" && run.status === "pending"
            ? " · when usage resets"
            : "") +
          `</div>` +
          (links ? `<div class="job-meta">Chats: ${links}</div>` : "") +
          (run.transcript && run.transcript.length
            ? `<div class="job-meta">${escapeHtml(transcriptText(run))}</div>`
            : "") +
          (run.error ? `<div class="job-err">${escapeHtml(run.error)}</div>` : "") +
          (run.status === "waiting" ? `<div class="job-hold">${escapeHtml(runHoldText(run))}</div>` : "") +
          (run.note ? `<div class="job-meta">${escapeHtml(run.note)}</div>` : "") +
          (fixingRunId === run.id ? fixPanel(run, wf) : "") +
          `</div>` +
          `<div class="job-btns">` +
          (run.status === "error" || run.status === "waiting" || run.status === "paused"
            ? `<button class="job-run wf-run-resume" data-id="${run.id}" title="${escapeHtml(
                WF.resumePlan(run).action
              )}">Resume</button>`
            : "") +
          (WF.isRunActive(run) && run.status !== "waiting"
            ? ""
            : `<button class="job-edit wf-run-fix" data-id="${run.id}" title="Choose where to carry on from">Fix &amp; continue</button>`) +
          (WF.isRunActive(run)
            ? `<button class="job-edit wf-run-pause" data-id="${run.id}" title="Stop at the next step so you can change something">Pause</button>`
            : "") +
          (run.status !== "running" && run.status !== "done"
            ? `<button class="job-edit wf-run-edit" data-id="${run.id}" title="Add a step, fix a prompt, add documents — this run only">Edit run</button>`
            : "") +
          (WF.isRunActive(run) || run.status === "paused"
            ? `<button class="job-edit wf-run-cancel" data-id="${run.id}" title="Stop here for good">Cancel</button>`
            : "") +
          `<button class="job-edit wf-run-save" data-id="${run.id}" title="Keep this run's steps as a new workflow">Save as workflow</button>` +
          (!WF.isRunActive(run) && typeof run.windowId === "number"
            ? `<button class="job-edit wf-run-closewin" data-id="${run.id}" title="Close this run's Chrome window and its chats">Close window</button>`
            : "") +
          `<button class="job-del wf-run-del" data-id="${run.id}" title="Remove from the list">✕</button>` +
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
            run.name || "Workflow from a run"
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
        b.addEventListener("click", () => {
          const run = runs.find((r) => r.id === b.getAttribute("data-id"));
          if (!run) return;
          wfForm.editRun(run, (edited) => {
            // Documents new to the run are stamped with the step it has reached,
            // so they go up with the next step in their chats rather than trying
            // to ride an opening message that has already been sent.
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
                if (res && !res.ok) alert("Could not save: " + (res.error || "unknown error"));
                renderRuns();
              }
            );
          });
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
          chrome.storage.local.get([RUNS_KEY, WORKFLOWS_KEY], (r) => {
            const list = (r && r[RUNS_KEY]) || [];
            const run = WF.getRun(list, id);
            const rest = WF.removeRun(list, id);
            // The run owned this matter's papers; with the run gone, so are
            // they — unless another run or a workflow still points at them.
            const stillUsed = WF.fileIdsInUse((r && r[WORKFLOWS_KEY]) || [], null);
            const heldByRuns = WF.runFileIds(rest);
            const dead = ((run && run.docs) || [])
              .map((d) => d.id)
              .filter((fid) => !stillUsed.has(fid) && !heldByRuns.has(fid));
            chrome.storage.local.set({ [RUNS_KEY]: rest }, () => {
              if (dead.length) chrome.storage.local.remove(dead.map((fid) => J.fileKey(fid)));
              renderRuns();
            });
          });
        })
      );
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[WORKFLOWS_KEY] && !wfForm.isOpen()) renderWorkflows();
    if (changes[RUNS_KEY]) renderRuns();
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
})();
