/**
 * Claude Usage Meter — shared scheduled-send form (used by the Options page and
 * the in-page pill modal). Self-contained: builds the form into a container,
 * injects its own styles, handles file selection (drag-drop + pickers), the
 * project/target picker, the trigger, and job creation into chrome.storage.
 *
 * CUMJobForm.create(container, {
 *   chatContext: { url, title } | null,   // enables a "This chat" target
 *   onSubmitted: function() {},           // called after a job is queued
 * }) -> { destroy() }
 */
(function (root) {
  "use strict";

  const JOBS_KEY = "cum_jobs";
  const PROJECTS_KEY = "cum_projects";
  const STYLE_ID = "cumjf-styles";

  const STYLES = `
    .cumjf { display:flex; flex-direction:column; gap:6px; }
    .cumjf-label { font-size:11px; font-weight:600; color:#6b6b6b; margin-top:6px; }
    .cumjf input[type=text], .cumjf textarea, .cumjf select, .cumjf input[type=datetime-local] {
      width:100%; padding:8px 10px; border:1px solid rgba(0,0,0,0.16); border-radius:8px;
      font:inherit; font-size:13px; background:#fff; color:#1f1f1f; box-sizing:border-box; }
    .cumjf textarea { resize:vertical; }
    .cumjf-drop { display:flex; flex-direction:column; align-items:center; gap:8px;
      border:1.5px dashed rgba(0,0,0,0.22); border-radius:10px; padding:14px; text-align:center;
      transition:border-color .15s, background .15s; }
    .cumjf-drop.drag { border-color:#c96442; background:rgba(201,100,66,0.06); }
    .cumjf-dz-text { margin:0; font-size:12.5px; color:#8a8a8a; }
    .cumjf-row { display:flex; gap:8px; align-items:center; }
    .cumjf-btn { padding:8px 14px; border:1px solid rgba(0,0,0,0.14); border-radius:9px;
      background:#f5f4f0; color:#1f1f1f; font-size:13px; font-weight:600; cursor:pointer; }
    .cumjf-btn:hover { background:#ecebe5; }
    .cumjf-btn.primary { background:#c96442; border-color:#c96442; color:#fff; }
    .cumjf-btn.primary:hover { background:#b85838; }
    .cumjf-btn.ghost { background:none; }
    .cumjf-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
    .cumjf-chip { display:inline-flex; align-items:center; gap:6px; max-width:220px;
      padding:3px 6px 3px 9px; border:1px solid rgba(0,0,0,0.12); border-radius:999px;
      background:#f5f4f0; font-size:12px; }
    .cumjf-chip-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cumjf-chip-x { border:none; background:none; color:#9a9a9a; cursor:pointer; font-size:11px; }
    .cumjf-chip-x:hover { color:#d23f31; }
    .cumjf-summary { font-size:12px; color:#6b6b6b; padding:2px 2px 0; }
    .cumjf-when { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
    .cumjf-radio { font-size:13px; display:inline-flex; align-items:center; gap:5px; }
    .cumjf-when input[type=datetime-local] { width:auto; flex:1; min-width:170px; }
    .cumjf-actions { display:flex; align-items:center; gap:12px; margin-top:10px; }
    .cumjf-status { font-size:12px; font-weight:600; color:#1f7a3f; }
    .cumjf-status.err { color:#d23f31; }
    @media (prefers-color-scheme: dark) {
      .cumjf-label { color:#a5a29a; }
      .cumjf input[type=text], .cumjf textarea, .cumjf select, .cumjf input[type=datetime-local] {
        background:#1f1e1c; border-color:rgba(255,255,255,0.16); color:#f0efea; }
      .cumjf-drop { border-color:rgba(255,255,255,0.22); }
      .cumjf-btn { background:#35342f; border-color:rgba(255,255,255,0.14); color:#f0efea; }
      .cumjf-btn:hover { background:#403f39; }
      .cumjf-btn.primary { background:#c96442; border-color:#c96442; color:#fff; }
      .cumjf-chip { background:#35342f; border-color:rgba(255,255,255,0.14); }
    }`;

  function injectStyles(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const s = doc.createElement("style");
    s.id = STYLE_ID;
    s.textContent = STYLES;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  function fmtSize(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
    if (b >= 1024) return Math.round(b / 1024) + " KB";
    return b + " B";
  }
  function readAsDataURL(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(file);
    });
  }
  function storageGet(keys) {
    return new Promise((r) => {
      try {
        chrome.storage.local.get(keys, (x) => r(x || {}));
      } catch (e) {
        r({});
      }
    });
  }

  function create(container, opts) {
    opts = opts || {};
    const J = root.CUMJobs;
    const doc = container.ownerDocument || document;
    injectStyles(doc);

    const chat = opts.chatContext || null;
    const el = doc.createElement("div");
    el.className = "cumjf";
    el.innerHTML =
      `<label class="cumjf-label">Label (optional)</label>` +
      `<input class="cumjf-name" type="text" placeholder="e.g. Weekly report run" />` +
      `<label class="cumjf-label">Files</label>` +
      `<div class="cumjf-drop"><p class="cumjf-dz-text">Drag files or a folder here, or</p>` +
      `<div class="cumjf-row"><button class="cumjf-btn ghost cumjf-pick-files" type="button">Choose files…</button>` +
      `<button class="cumjf-btn ghost cumjf-pick-folder" type="button">Choose folder…</button></div></div>` +
      `<input class="cumjf-files" type="file" multiple hidden />` +
      `<input class="cumjf-folder" type="file" webkitdirectory hidden />` +
      `<div class="cumjf-chips"></div><div class="cumjf-summary" hidden></div>` +
      `<label class="cumjf-label">Prompt (optional)</label>` +
      `<textarea class="cumjf-prompt" rows="3" placeholder="What should Claude do?"></textarea>` +
      `<label class="cumjf-label">Send to</label>` +
      `<div class="cumjf-row"><select class="cumjf-target"></select>` +
      `<button class="cumjf-btn ghost cumjf-refresh" type="button">Refresh</button></div>` +
      `<label class="cumjf-label">When to send</label>` +
      `<div class="cumjf-when">` +
      `<label class="cumjf-radio"><input type="radio" name="cumjf-trig" value="reset" checked /> When usage resets</label>` +
      `<label class="cumjf-radio"><input type="radio" name="cumjf-trig" value="time" /> At a set time</label>` +
      `<input class="cumjf-time" type="datetime-local" disabled /></div>` +
      `<div class="cumjf-actions"><button class="cumjf-btn primary cumjf-add" type="button">Queue send</button>` +
      `<span class="cumjf-status" hidden></span></div>`;
    container.appendChild(el);

    const q = (c) => el.querySelector(c);
    const ui = {
      name: q(".cumjf-name"),
      drop: q(".cumjf-drop"),
      files: q(".cumjf-files"),
      folder: q(".cumjf-folder"),
      pickFiles: q(".cumjf-pick-files"),
      pickFolder: q(".cumjf-pick-folder"),
      chips: q(".cumjf-chips"),
      summary: q(".cumjf-summary"),
      prompt: q(".cumjf-prompt"),
      target: q(".cumjf-target"),
      refresh: q(".cumjf-refresh"),
      time: q(".cumjf-time"),
      add: q(".cumjf-add"),
      status: q(".cumjf-status"),
    };

    // ---- files ----
    let files = [];
    const key = (f) => (f.webkitRelativePath || f.name) + ":" + f.size;
    function addFiles(list) {
      const have = new Set(files.map(key));
      for (const f of list || []) {
        if (have.has(key(f))) continue;
        have.add(key(f));
        files.push(f);
      }
      renderFiles();
    }
    function renderFiles() {
      ui.chips.innerHTML = "";
      for (const f of files) {
        const chip = doc.createElement("span");
        chip.className = "cumjf-chip";
        chip.innerHTML = `<span class="cumjf-chip-name">${esc(f.name)}</span><button class="cumjf-chip-x" type="button">✕</button>`;
        chip.querySelector(".cumjf-chip-x").addEventListener("click", () => {
          files = files.filter((x) => key(x) !== key(f));
          renderFiles();
        });
        ui.chips.appendChild(chip);
      }
      const total = files.reduce((s, f) => s + (f.size || 0), 0);
      if (!files.length) ui.summary.hidden = true;
      else {
        let t = `${files.length} file${files.length === 1 ? "" : "s"} · ${fmtSize(total)}`;
        if (files.length > 100) t += " — that's a lot";
        else if (total > 60 * 1048576) t += " — large; storing may be slow";
        ui.summary.textContent = t;
        ui.summary.hidden = false;
      }
    }
    function walk(entry, out) {
      return new Promise((resolve) => {
        if (!entry) return resolve();
        if (entry.isFile) entry.file((f) => (out.push(f), resolve()), () => resolve());
        else if (entry.isDirectory) {
          const rd = entry.createReader();
          const batch = () => rd.readEntries(async (es) => {
            if (!es.length) return resolve();
            for (const e of es) await walk(e, out);
            batch();
          }, () => resolve());
          batch();
        } else resolve();
      });
    }
    ui.drop.addEventListener("dragover", (e) => (e.preventDefault(), ui.drop.classList.add("drag")));
    ui.drop.addEventListener("dragleave", () => ui.drop.classList.remove("drag"));
    ui.drop.addEventListener("drop", (e) => {
      e.preventDefault();
      ui.drop.classList.remove("drag");
      const dt = e.dataTransfer;
      const entries = dt && dt.items
        ? Array.from(dt.items).map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean)
        : [];
      if (entries.length) {
        const out = [];
        Promise.all(entries.map((en) => walk(en, out))).then(() => addFiles(out));
      } else if (dt && dt.files) addFiles(Array.from(dt.files));
    });
    ui.pickFiles.addEventListener("click", () => ui.files.click());
    ui.pickFolder.addEventListener("click", () => ui.folder.click());
    ui.files.addEventListener("change", () => (addFiles(Array.from(ui.files.files || [])), (ui.files.value = "")));
    ui.folder.addEventListener("change", () => (addFiles(Array.from(ui.folder.files || [])), (ui.folder.value = "")));

    // ---- target (New chat / This chat / projects) ----
    function fillTarget(projects) {
      const cur = ui.target.value;
      ui.target.innerHTML = "";
      const add = (value, label, data) => {
        const o = doc.createElement("option");
        o.value = value;
        o.textContent = label;
        if (data) Object.assign(o.dataset, data);
        ui.target.appendChild(o);
      };
      add("new", "New chat — no project");
      if (chat && chat.url) add("chat", "This chat" + (chat.title ? " — " + chat.title : ""));
      for (const p of projects || []) {
        add("project:" + p.uuid, J.cleanProjectName(p.name) || p.uuid, {
          name: J.cleanProjectName(p.name) || "",
          href: p.href || "",
        });
      }
      if (cur && ui.target.querySelector(`option[value="${cur}"]`)) ui.target.value = cur;
      else if (chat && chat.url) ui.target.value = "chat"; // default to this chat when available
    }
    storageGet(PROJECTS_KEY).then((r) => fillTarget(r[PROJECTS_KEY]));
    ui.refresh.addEventListener("click", () => {
      ui.refresh.disabled = true;
      ui.refresh.textContent = "…";
      try {
        chrome.runtime.sendMessage({ type: "cum-refresh-projects" }, (res) => {
          ui.refresh.disabled = false;
          ui.refresh.textContent = "Refresh";
          if (res && res.projects && res.projects.length) {
            fillTarget(res.projects);
            flash(`Found ${res.projects.length} project(s)`);
          } else flash((res && res.error) || "No projects found — log into claude.ai", true);
        });
      } catch (e) {
        ui.refresh.disabled = false;
        ui.refresh.textContent = "Refresh";
      }
    });

    // ---- trigger ----
    el.querySelectorAll('input[name="cumjf-trig"]').forEach((r) =>
      r.addEventListener("change", () => {
        ui.time.disabled = el.querySelector('input[name="cumjf-trig"]:checked').value !== "time";
      })
    );

    function flash(text, err) {
      ui.status.textContent = text;
      ui.status.hidden = false;
      ui.status.classList.toggle("err", !!err);
      setTimeout(() => (ui.status.hidden = true), 2600);
    }

    // ---- submit ----
    ui.add.addEventListener("click", async () => {
      const prompt = ui.prompt.value;
      if (!files.length && !prompt.trim()) return flash("Add a file, folder, or prompt.", true);
      const trigType = el.querySelector('input[name="cumjf-trig"]:checked').value;
      let trigger = { type: "reset" };
      if (trigType === "time") {
        const at = ui.time.value ? new Date(ui.time.value).getTime() : NaN;
        if (!Number.isFinite(at)) return flash("Pick a valid date & time.", true);
        if (at <= Date.now()) return flash("Pick a time in the future.", true);
        trigger = { type: "time", at };
      }
      ui.add.disabled = true;
      try {
        const writes = {};
        const metas = [];
        for (const f of files) {
          const id = crypto.randomUUID();
          writes[J.fileKey(id)] = await readAsDataURL(f);
          metas.push({ id, name: f.name, type: f.type, size: f.size });
        }
        const fields = { name: ui.name.value, prompt, files: metas, trigger };
        const tv = ui.target.value;
        if (tv === "chat" && chat) {
          fields.chatUrl = chat.url;
          fields.chatTitle = chat.title || null;
        } else if (tv.indexOf("project:") === 0) {
          const o = ui.target.selectedOptions[0];
          fields.projectUuid = tv.slice("project:".length);
          fields.projectName = (o && o.dataset.name) || null;
          fields.projectHref = (o && o.dataset.href) || null;
        }
        const job = J.newJob(fields, crypto.randomUUID(), Date.now());
        const cur = (await storageGet(JOBS_KEY))[JOBS_KEY] || [];
        writes[JOBS_KEY] = J.upsertJob(cur, job);
        await new Promise((r) => chrome.storage.local.set(writes, r));
        ui.name.value = "";
        ui.prompt.value = "";
        files = [];
        renderFiles();
        flash("Queued.");
        if (typeof opts.onSubmitted === "function") opts.onSubmitted(job);
      } catch (e) {
        flash("Failed: " + ((e && e.message) || e), true);
      } finally {
        ui.add.disabled = false;
      }
    });

    return {
      destroy() {
        el.remove();
      },
    };
  }

  root.CUMJobForm = { create };
})(typeof globalThis !== "undefined" ? globalThis : this);
