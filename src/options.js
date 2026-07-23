/* Claude Usage Meter — Options page: usage log table + CSV export */
(function () {
  "use strict";

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
  const STATUS_LABEL = { pending: "Queued", running: "Sending…", done: "Sent", error: "Failed", canceled: "Canceled" };

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
          (job.note ? `<div class="job-meta">⚠ ${escapeHtml(job.note)}</div>` : "") +
          `</div>` +
          `<div class="job-btns">` +
          (job.status === "pending"
            ? `<button class="job-run" data-id="${job.id}" title="Send now">Run now</button>`
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

  function renderDaily() {
    chrome.storage.local.get(DAILY_KEY, (res) => {
      const model = (res && res[DAILY_KEY]) || null;
      const sum = D ? D.summary(model) : { totalDays: 0, share: [], avg: [], counts: [] };
      if (!sum.totalDays) {
        dl.chart.hidden = true;
        dl.note.hidden = true;
        dl.empty.hidden = false;
        return;
      }
      dl.empty.hidden = true;
      dl.chart.hidden = false;
      // Each day's number is the average share of the FULL weekly limit consumed
      // on that weekday (e.g. "Mon 12%" = a typical Monday uses 12% of the week).
      // Bars scale to the busiest weekday so the shape is readable.
      const maxAvg = Math.max.apply(null, WEEK_ORDER.map((wd) => sum.avg[wd] || 0)) || 1;
      dl.chart.innerHTML = "";
      for (const wd of WEEK_ORDER) {
        const avg = sum.avg[wd] || 0;
        const count = sum.counts[wd] || 0;
        const row = document.createElement("div");
        row.className = "daily-row" + (count ? "" : " daily-empty-day");
        const width = Math.round((avg / maxAvg) * 100);
        row.innerHTML =
          `<span class="daily-day">${WEEK_NAMES[wd]}</span>` +
          `<span class="daily-bar-wrap"><i class="daily-bar" style="width:${width}%"></i></span>` +
          `<span class="daily-val">${count ? fmtPts(avg) : "—"}` +
          `<span class="daily-sub">${count ? count + (count === 1 ? " day" : " days") : "no data"}</span></span>`;
        dl.chart.appendChild(row);
      }
      dl.note.hidden = false;
      dl.note.textContent =
        `Based on ${sum.totalDays} day${sum.totalDays === 1 ? "" : "s"} of data` +
        ` · a typical week totals about ${fmtPts(sum.avgTotal)} of your weekly limit.`;
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[DAILY_KEY]) renderDaily();
  });

  renderDaily();
})();
