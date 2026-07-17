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
    name: document.getElementById("job-name"),
    files: document.getElementById("job-files"),
    folder: document.getElementById("job-folder"),
    pickFiles: document.getElementById("pick-files"),
    pickFolder: document.getElementById("pick-folder"),
    dropzone: document.getElementById("job-dropzone"),
    chips: document.getElementById("job-file-chips"),
    summary: document.getElementById("job-file-summary"),
    prompt: document.getElementById("job-prompt"),
    project: document.getElementById("job-project"),
    refresh: document.getElementById("refresh-projects"),
    time: document.getElementById("job-time"),
    add: document.getElementById("add-job"),
    status: document.getElementById("job-status"),
    list: document.getElementById("job-list"),
    empty: document.getElementById("job-empty"),
  };

  function jfFlash(text, isError) {
    jf.status.textContent = text;
    jf.status.hidden = false;
    jf.status.classList.toggle("err", !!isError);
    setTimeout(() => (jf.status.hidden = true), 2600);
  }

  // Trigger radios enable/disable the time picker.
  document.querySelectorAll('input[name="jf-trigger"]').forEach((r) => {
    r.addEventListener("change", () => {
      jf.time.disabled = document.querySelector('input[name="jf-trigger"]:checked').value !== "time";
    });
  });

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
  }

  // Selected files live in memory so drag-dropped files (which aren't in an
  // <input>) can be tracked alongside picker selections.
  let selectedFiles = [];
  const fileKey = (f) => (f.webkitRelativePath || f.name) + ":" + f.size;

  function collectFiles() {
    return selectedFiles;
  }

  function addFiles(files) {
    const have = new Set(selectedFiles.map(fileKey));
    for (const f of files || []) {
      const k = fileKey(f);
      if (have.has(k)) continue;
      have.add(k);
      selectedFiles.push(f);
    }
    renderFiles();
  }

  function removeFile(key) {
    selectedFiles = selectedFiles.filter((f) => fileKey(f) !== key);
    renderFiles();
  }

  function fmtSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
    return bytes + " B";
  }

  function renderFiles() {
    jf.chips.innerHTML = "";
    for (const f of selectedFiles) {
      const chip = document.createElement("span");
      chip.className = "jf-chip";
      chip.innerHTML =
        `<span class="jf-chip-name">${escapeHtml(f.name)}</span>` +
        `<button class="jf-chip-x" type="button" title="Remove">✕</button>`;
      chip.querySelector(".jf-chip-x").addEventListener("click", () => removeFile(fileKey(f)));
      jf.chips.appendChild(chip);
    }
    const total = selectedFiles.reduce((s, f) => s + (f.size || 0), 0);
    if (!selectedFiles.length) {
      jf.summary.hidden = true;
    } else {
      let txt = `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} · ${fmtSize(total)}`;
      if (selectedFiles.length > 100) txt += " — that's a lot; consider narrowing the folder";
      else if (total > 60 * 1024 * 1024) txt += " — large; storing may be slow";
      jf.summary.textContent = txt;
      jf.summary.hidden = false;
    }
  }

  // ---- drag & drop (files and folders) ----------------------------------
  function walkEntry(entry, out) {
    return new Promise((resolve) => {
      if (!entry) return resolve();
      if (entry.isFile) {
        entry.file(
          (f) => {
            out.push(f);
            resolve();
          },
          () => resolve()
        );
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () =>
          reader.readEntries(
            async (batch) => {
              if (!batch.length) return resolve();
              for (const e of batch) await walkEntry(e, out);
              readBatch(); // readEntries yields in chunks
            },
            () => resolve()
          );
        readBatch();
      } else {
        resolve();
      }
    });
  }

  jf.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    jf.dropzone.classList.add("drag");
  });
  jf.dropzone.addEventListener("dragleave", () => jf.dropzone.classList.remove("drag"));
  jf.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    jf.dropzone.classList.remove("drag");
    const dt = e.dataTransfer;
    // webkitGetAsEntry() must be called synchronously during the drop event.
    const entries = dt && dt.items
      ? Array.from(dt.items)
          .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
          .filter(Boolean)
      : [];
    if (entries.length) {
      const out = [];
      Promise.all(entries.map((en) => walkEntry(en, out))).then(() => addFiles(out));
    } else if (dt && dt.files) {
      addFiles(Array.from(dt.files));
    }
  });

  jf.pickFiles.addEventListener("click", () => jf.files.click());
  jf.pickFolder.addEventListener("click", () => jf.folder.click());
  jf.files.addEventListener("change", () => {
    addFiles(Array.from(jf.files.files || []));
    jf.files.value = "";
  });
  jf.folder.addEventListener("change", () => {
    addFiles(Array.from(jf.folder.files || []));
    jf.folder.value = "";
  });

  function fillProjects(projects) {
    const list = projects || [];
    const current = jf.project.value;
    jf.project.innerHTML = '<option value="">New chat — no project</option>';
    for (const p of list) {
      const opt = document.createElement("option");
      opt.value = p.uuid;
      opt.textContent = J.cleanProjectName(p.name) || p.uuid;
      opt.dataset.name = J.cleanProjectName(p.name) || "";
      opt.dataset.href = p.href || "";
      jf.project.appendChild(opt);
    }
    if (current) jf.project.value = current;
  }

  function loadProjects() {
    chrome.storage.local.get(PROJECTS_KEY, (res) => fillProjects(res && res[PROJECTS_KEY]));
  }

  jf.refresh.addEventListener("click", () => {
    jf.refresh.disabled = true;
    jf.refresh.textContent = "Refreshing…";
    chrome.runtime.sendMessage({ type: "cum-refresh-projects" }, (res) => {
      jf.refresh.disabled = false;
      jf.refresh.textContent = "Refresh";
      if (res && res.projects) {
        fillProjects(res.projects);
        jfFlash(`Found ${res.projects.length} project${res.projects.length === 1 ? "" : "s"}`);
      } else {
        jfFlash((res && res.error) || "Couldn't load projects — is a claude.ai tab logged in?", true);
      }
    });
  });

  async function addJob() {
    const files = collectFiles();
    const prompt = jf.prompt.value;
    if (!files.length && !prompt.trim()) return jfFlash("Add a file, folder, or prompt.", true);

    const trigType = document.querySelector('input[name="jf-trigger"]:checked').value;
    let trigger = { type: "reset" };
    if (trigType === "time") {
      const at = jf.time.value ? new Date(jf.time.value).getTime() : NaN;
      if (!Number.isFinite(at)) return jfFlash("Pick a valid date & time.", true);
      if (at <= Date.now()) return jfFlash("Pick a time in the future.", true);
      trigger = { type: "time", at };
    }

    jf.add.disabled = true;
    try {
      const writes = {};
      const metas = [];
      for (const file of files) {
        const id = crypto.randomUUID();
        writes[J.fileKey(id)] = await readAsDataURL(file);
        metas.push({ id, name: file.name, type: file.type, size: file.size });
      }
      const projOpt = jf.project.selectedOptions[0];
      const job = J.newJob(
        {
          name: jf.name.value,
          prompt,
          files: metas,
          projectUuid: jf.project.value || null,
          projectName: (projOpt && projOpt.dataset.name) || null,
          projectHref: (projOpt && projOpt.dataset.href) || null,
          trigger,
        },
        crypto.randomUUID(),
        Date.now()
      );
      const cur = await new Promise((r) => chrome.storage.local.get(JOBS_KEY, (x) => r((x && x[JOBS_KEY]) || [])));
      writes[JOBS_KEY] = J.upsertJob(cur, job);
      await new Promise((r) => chrome.storage.local.set(writes, r));
      jf.name.value = "";
      jf.prompt.value = "";
      selectedFiles = [];
      renderFiles();
      jfFlash("Queued.");
      renderJobs();
    } catch (e) {
      jfFlash("Failed to queue: " + ((e && e.message) || e), true);
    } finally {
      jf.add.disabled = false;
    }
  }
  jf.add.addEventListener("click", addJob);

  function triggerText(job) {
    if (job.trigger && job.trigger.type === "time")
      return "at " + new Date(job.trigger.at).toLocaleString();
    return "when usage resets";
  }
  const STATUS_LABEL = { pending: "Queued", running: "Sending…", done: "Sent", error: "Failed", canceled: "Canceled" };

  function renderJobs() {
    chrome.storage.local.get(JOBS_KEY, (res) => {
      const jobs = (res && res[JOBS_KEY]) || [];
      const sorted = jobs.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      jf.list.innerHTML = "";
      for (const job of sorted) {
        const row = document.createElement("div");
        row.className = "job-item status-" + (job.status || "pending");
        const bits = [];
        if (job.files && job.files.length) bits.push(`${job.files.length} file${job.files.length === 1 ? "" : "s"}`);
        if (job.prompt) bits.push("prompt");
        if (job.projectName) bits.push("→ " + job.projectName);
        row.innerHTML =
          `<div class="job-main">` +
          `<div class="job-title">${escapeHtml(job.name || "(untitled)")}` +
          `<span class="job-badge">${STATUS_LABEL[job.status] || job.status}</span></div>` +
          `<div class="job-meta">${escapeHtml(bits.join(" · "))} · ${escapeHtml(triggerText(job))}</div>` +
          (job.error ? `<div class="job-err">${escapeHtml(job.error)}</div>` : "") +
          `</div>` +
          `<button class="job-del" data-id="${job.id}" title="Delete">✕</button>`;
        jf.list.appendChild(row);
      }
      jf.empty.hidden = jobs.length !== 0;
      jf.list.querySelectorAll(".job-del").forEach((b) =>
        b.addEventListener("click", () => deleteJob(b.getAttribute("data-id")))
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
    if (area !== "local") return;
    if (changes[JOBS_KEY]) renderJobs();
    if (changes[PROJECTS_KEY]) loadProjects();
  });

  loadProjects();
  renderJobs();
})();
