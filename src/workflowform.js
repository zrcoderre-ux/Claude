/**
 * Claude Usage Meter — workflow editor (Options page).
 *
 * Builds and edits a multi-chat workflow: how many conversations are worked
 * between, where each one lives (new chat / a Project / Claude Code) and on
 * which model, the documents and which chats receive them, and the ordered
 * steps — each with its chat, its prompt, and whether the previous step's reply
 * is carried into it.
 *
 * CUMWorkflowForm.create(container, {
 *   onSaved: function(workflow) {},   // after a save lands in storage
 *   onClosed: function() {},          // editor dismissed
 * }) -> { edit(workflow), create(), close(), isOpen(), destroy() }
 *
 * Self-contained (its own styles, its own storage writes), like the
 * scheduled-send form it sits next to.
 */
(function (root) {
  "use strict";

  const WORKFLOWS_KEY = "cum_workflows";
  const PROJECTS_KEY = "cum_projects";
  const MODELS_KEY = "cum_models";
  const STYLE_ID = "cumwf-styles";
  const SEED_MODELS = ["Opus 4.8", "Sonnet 5", "Haiku 4.5", "Fable 5"];

  const STYLES = `
    .cumwf { display:flex; flex-direction:column; gap:8px; }
    .cumwf[hidden] { display:none; }
    .cumwf-label { font-size:11px; font-weight:600; color:#6b6b6b; margin-top:6px;
      text-transform:uppercase; letter-spacing:.04em; }
    .cumwf input[type=text], .cumwf textarea, .cumwf select, .cumwf input[type=number] {
      width:100%; padding:8px 10px; border:1px solid rgba(0,0,0,0.16); border-radius:8px;
      font:inherit; font-size:13px; background:#fff; color:#1f1f1f; box-sizing:border-box; }
    .cumwf textarea { resize:vertical; font-size:12.5px; line-height:1.45; }
    .cumwf-row { display:flex; gap:8px; align-items:center; }
    .cumwf-row > * { min-width:0; }
    .cumwf-btn { padding:7px 13px; border:1px solid rgba(0,0,0,0.14); border-radius:9px;
      background:#f5f4f0; color:#1f1f1f; font-size:13px; font-weight:600; cursor:pointer; }
    .cumwf-btn:hover { background:#ecebe5; }
    .cumwf-btn.primary { background:#c96442; border-color:#c96442; color:#fff; }
    .cumwf-btn.primary:hover { background:#b85838; }
    .cumwf-btn.ghost { background:none; }
    .cumwf-btn.mini { padding:3px 8px; font-size:12px; font-weight:500; }
    .cumwf-card { border:1px solid rgba(0,0,0,0.12); border-radius:10px; padding:10px 12px;
      display:flex; flex-direction:column; gap:6px; background:rgba(0,0,0,0.015); }
    .cumwf-card-head { display:flex; align-items:center; gap:8px; }
    .cumwf-card-title { font-size:12px; font-weight:700; color:#6b6b6b; flex:1;
      text-transform:uppercase; letter-spacing:.04em; }
    .cumwf-list { display:flex; flex-direction:column; gap:8px; }
    .cumwf-drop { display:flex; flex-direction:column; align-items:center; gap:8px;
      border:1.5px dashed rgba(0,0,0,0.22); border-radius:10px; padding:12px; text-align:center; }
    .cumwf-drop.drag { border-color:#c96442; background:rgba(201,100,66,0.06); }
    .cumwf-dz-text { margin:0; font-size:12.5px; color:#8a8a8a; }
    .cumwf-doc { display:flex; align-items:center; gap:10px; flex-wrap:wrap;
      border:1px solid rgba(0,0,0,0.1); border-radius:9px; padding:7px 10px; font-size:12.5px; }
    .cumwf-doc-name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:280px; }
    .cumwf-doc-size { color:#8a8a8a; }
    .cumwf-doc-chats { display:flex; gap:10px; flex-wrap:wrap; margin-left:auto; align-items:center; }
    .cumwf-doc-head { background:rgba(0,0,0,0.03); border-style:dashed; }
    .cumwf-doc-head .cumwf-doc-name { font-weight:700; color:#6b6b6b; }
    .cumwf-check { display:inline-flex; align-items:center; gap:4px; font-size:12px; }
    .cumwf-check input { margin:0; }
    .cumwf-hint { font-size:12px; color:#8a8a8a; margin:0; }
    .cumwf-actions { display:flex; align-items:center; gap:10px; margin-top:10px;
      position:sticky; bottom:0; padding:8px 0; background:inherit; }
    .cumwf-status { font-size:12px; font-weight:600; color:#1f7a3f; }
    .cumwf-status.err { color:#d23f31; }
    .cumwf-problems { margin:0; padding-left:18px; font-size:12px; color:#d23f31; }
    @media (prefers-color-scheme: dark) {
      .cumwf-label { color:#a5a29a; }
      .cumwf input[type=text], .cumwf textarea, .cumwf select, .cumwf input[type=number] {
        background:#1f1e1c; border-color:rgba(255,255,255,0.16); color:#f0efea; }
      .cumwf-btn { background:#35342f; border-color:rgba(255,255,255,0.14); color:#f0efea; }
      .cumwf-btn:hover { background:#403f39; }
      .cumwf-btn.primary { background:#c96442; border-color:#c96442; color:#fff; }
      .cumwf-card, .cumwf-doc { border-color:rgba(255,255,255,0.14); background:rgba(255,255,255,0.03); }
      .cumwf-doc-head { background:rgba(255,255,255,0.06); }
      .cumwf-doc-head .cumwf-doc-name { color:#a5a29a; }
      .cumwf-drop { border-color:rgba(255,255,255,0.22); }
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
    if (!b) return "";
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
  function storageSet(obj) {
    return new Promise((r) => {
      try {
        chrome.storage.local.set(obj, r);
      } catch (e) {
        r();
      }
    });
  }
  const uuid = () => crypto.randomUUID();

  function create(container, opts) {
    opts = opts || {};
    const W = root.CUMWorkflow;
    const J = root.CUMJobs;
    const doc = container.ownerDocument || document;
    injectStyles(doc);

    const el = doc.createElement("div");
    el.className = "cumwf";
    el.hidden = true;
    el.innerHTML =
      `<div class="cumwf-tmpl-row">` +
      `<label class="cumwf-label">Workflow name</label>` +
      `<input class="cumwf-template" type="text" placeholder="e.g. Tentative ruling — 3× devil's advocate" />` +
      `<p class="cumwf-hint">The template's own name. It keeps this one — it's what the workflow goes back ` +
      `to after each run starts.</p></div>` +
      `<label class="cumwf-label">Run name</label>` +
      `<input class="cumwf-name" type="text" placeholder="e.g. Demurrer — Smith v. Jones" />` +
      `<p class="cumwf-hint">This matter, this run. Starting a run gives it this name along with the ` +
      `documents below, then clears both from the template. Leave it blank to use the workflow name.</p>` +
      `<label class="cumwf-label">What it does (optional)</label>` +
      `<input class="cumwf-desc" type="text" placeholder="One line, for the list" />` +

      `<label class="cumwf-label">Chats worked between</label>` +
      `<div class="cumwf-row"><input class="cumwf-count" type="number" min="1" max="6" step="1" style="width:80px" />` +
      `<p class="cumwf-hint">Each chat is its own claude.ai conversation. The workflow moves between them, ` +
      `carrying the last reply across.</p></div>` +
      `<div class="cumwf-chats cumwf-list"></div>` +

      `<label class="cumwf-label">Documents</label>` +
      `<div class="cumwf-drop"><p class="cumwf-dz-text">Drag files here, or</p>` +
      `<div class="cumwf-row"><button class="cumwf-btn ghost cumwf-pick" type="button">Choose files…</button></div></div>` +
      `<input class="cumwf-file-input" type="file" multiple hidden />` +
      `<p class="cumwf-hint">Tick the chats that should receive each document — it goes up with that chat's first message.</p>` +
      `<label class="cumwf-check"><input class="cumwf-bundle" type="checkbox" /> Combine text documents into ` +
      `one labelled file before uploading</label>` +
      `<p class="cumwf-hint">Twenty separate attachments is where claude.ai starts showing Claude fewer than ` +
      `were sent. One file, with each document announced by name inside it, either arrives or doesn't. PDFs and ` +
      `Word files still go up on their own — only text is combined.</p>` +
      `<div class="cumwf-docs cumwf-list"></div>` +

      `<label class="cumwf-label">Steps</label>` +
      `<div class="cumwf-steps cumwf-list"></div>` +
      `<div class="cumwf-row"><button class="cumwf-btn ghost cumwf-add-step" type="button">+ Add step</button></div>` +

      `<ul class="cumwf-problems" hidden></ul>` +
      `<div class="cumwf-actions"><button class="cumwf-btn primary cumwf-save" type="button">Save workflow</button>` +
      `<button class="cumwf-btn ghost cumwf-cancel" type="button">Cancel</button>` +
      `<span class="cumwf-status" hidden></span></div>`;
    container.appendChild(el);

    const q = (c) => el.querySelector(c);
    const ui = {
      name: q(".cumwf-name"),
      template: q(".cumwf-template"),
      tmplRow: q(".cumwf-tmpl-row"),
      desc: q(".cumwf-desc"),
      count: q(".cumwf-count"),
      chats: q(".cumwf-chats"),
      drop: q(".cumwf-drop"),
      pick: q(".cumwf-pick"),
      bundle: q(".cumwf-bundle"),
      fileInput: q(".cumwf-file-input"),
      docs: q(".cumwf-docs"),
      steps: q(".cumwf-steps"),
      addStep: q(".cumwf-add-step"),
      problems: q(".cumwf-problems"),
      save: q(".cumwf-save"),
      cancel: q(".cumwf-cancel"),
      status: q(".cumwf-status"),
    };

    let wf = null; // the workflow being edited (a working copy)
    // When set, we're editing a RUN's own copy of its steps and papers rather
    // than a template, and this is where the result goes.
    let runSink = null;
    let originalDocIds = [];
    const pendingFiles = new Map(); // docId -> File, written to storage on save
    let projects = [];
    let models = [];

    // ---- pickers ---------------------------------------------------------
    function loadPickers() {
      storageGet([PROJECTS_KEY, MODELS_KEY]).then((r) => {
        projects = r[PROJECTS_KEY] || [];
        models = r[MODELS_KEY] || [];
        if (wf) renderChats();
      });
    }
    loadPickers();
    let onStorage = null;
    try {
      onStorage = (changes, area) => {
        if (area !== "local") return;
        if (changes[PROJECTS_KEY] || changes[MODELS_KEY]) loadPickers();
      };
      chrome.storage.onChanged.addListener(onStorage);
    } catch (e) {
      /* ignore */
    }

    function targetValue(chat) {
      const t = (chat && chat.target) || {};
      if (t.codeRepo) return "code";
      if (t.projectUuid) return "project:" + t.projectUuid;
      return "new";
    }

    // ---- chats -----------------------------------------------------------
    function renderChats() {
      ui.chats.innerHTML = "";
      (wf.chats || []).forEach((chat, i) => {
        const card = doc.createElement("div");
        card.className = "cumwf-card";
        const projOpts = projects
          .map((p) => {
            const name = J ? J.cleanProjectName(p.name) || p.uuid : p.name || p.uuid;
            return `<option value="project:${esc(p.uuid)}" data-name="${esc(name)}" data-href="${esc(p.href || "")}">New chat in ${esc(name)}</option>`;
          })
          .join("");
        const modelOpts = [""]
          .concat(models.length ? models : SEED_MODELS)
          .map((m) =>
            m
              ? `<option value="${esc(m)}">${esc(m)}</option>`
              : `<option value="">Default (leave current model)</option>`
          )
          .join("");
        card.innerHTML =
          `<div class="cumwf-card-head"><span class="cumwf-card-title">Chat ${esc(
            "ABCDEF"[i] || i + 1
          )}</span></div>` +
          `<input class="wf-chat-name" type="text" value="${esc(chat.name)}" placeholder="What this chat is for" />` +
          `<div class="cumwf-row">` +
          `<select class="wf-chat-target"><option value="new">New chat — no project</option>${projOpts}` +
          `<option value="code">New Claude Code chat (pick a repo)</option></select>` +
          `<select class="wf-chat-model">${modelOpts}</select></div>` +
          `<input class="wf-chat-repo" type="text" placeholder="owner/name" value="${esc(
            (chat.target && chat.target.codeRepo) || ""
          )}" hidden />` +
          `<input class="wf-chat-start" type="text" placeholder="Or start in an existing chat — paste its link" value="${esc(
            chat.startUrl || ""
          )}" />` +
          `<label class="cumwf-check"><input class="wf-chat-ruling" type="checkbox" ${
            chat.expectsRuling ? "checked" : ""
          } /> Its output is a tentative ruling — don't hand it to another chat unless the reply contains</label>` +
          `<input class="wf-chat-marker" type="text" placeholder="${esc(W.DEFAULT_OUTPUT_MARKER)}" value="${esc(
            chat.outputMarker || ""
          )}"${chat.expectsRuling ? "" : " hidden"} />` +
          `<p class="cumwf-hint"${chat.expectsRuling ? "" : " hidden"}>A clarifying question, a note that a paper ` +
          `is missing, or an offer to continue are all real replies — none of them the ruling. This waits for the ` +
          `one that is, which is usually the reply after auto-continue clicks Continue.</p>` +
          `<label class="cumwf-check"><input class="wf-chat-seed" type="checkbox" ${
            chat.seedFromLatest ? "checked" : ""
          } /> Treat that chat as step 0 — take its latest reply as the opening hand-off, and skip this ` +
          `chat's steps at the start</label>` +
          `<p class="cumwf-hint">Matter-specific, like the documents: starting a run hands this to the run ` +
          `and clears it here, so the next matter doesn't inherit this one's conversation.</p>`;
        const nameEl = card.querySelector(".wf-chat-name");
        const targetEl = card.querySelector(".wf-chat-target");
        const modelEl = card.querySelector(".wf-chat-model");
        const repoEl = card.querySelector(".wf-chat-repo");
        targetEl.value = targetValue(chat);
        if (!targetEl.value) targetEl.value = "new";
        modelEl.value = chat.model || "";
        const syncRepo = () => (repoEl.hidden = targetEl.value !== "code");
        syncRepo();

        nameEl.addEventListener("input", () => {
          chat.name = nameEl.value;
          renderSteps(); // step rows name their chat
          renderDocs();
        });
        targetEl.addEventListener("change", () => {
          const v = targetEl.value;
          const o = targetEl.selectedOptions[0];
          chat.target = { projectUuid: null, projectName: null, projectHref: null, codeRepo: null };
          if (v === "code") chat.target.codeRepo = repoEl.value.trim() || null;
          else if (v.indexOf("project:") === 0) {
            chat.target.projectUuid = v.slice("project:".length);
            chat.target.projectName = (o && o.dataset.name) || null;
            chat.target.projectHref = (o && o.dataset.href) || null;
          }
          syncRepo();
        });
        repoEl.addEventListener("input", () => {
          if (targetEl.value === "code") chat.target.codeRepo = repoEl.value.trim() || null;
        });
        modelEl.addEventListener("change", () => (chat.model = modelEl.value || null));
        const startEl = card.querySelector(".wf-chat-start");
        startEl.addEventListener("input", () => (chat.startUrl = startEl.value.trim() || null));
        const seedEl = card.querySelector(".wf-chat-seed");
        seedEl.addEventListener("change", () => (chat.seedFromLatest = seedEl.checked));
        const rulingEl = card.querySelector(".wf-chat-ruling");
        const markerEl = card.querySelector(".wf-chat-marker");
        const markerHint = markerEl.nextElementSibling;
        rulingEl.addEventListener("change", () => {
          chat.expectsRuling = rulingEl.checked;
          markerEl.hidden = !rulingEl.checked;
          if (markerHint) markerHint.hidden = !rulingEl.checked;
        });
        markerEl.addEventListener("input", () => (chat.outputMarker = markerEl.value.trim() || null));
        ui.chats.appendChild(card);
      });
    }

    ui.count.addEventListener("change", () => {
      const n = parseInt(ui.count.value, 10);
      wf = W.setChatCount(wf, isNaN(n) ? 1 : n, uuid);
      ui.count.value = wf.chats.length;
      renderChats();
      renderDocs();
      renderSteps();
    });

    // ---- documents -------------------------------------------------------
    function addFiles(list) {
      for (const f of list || []) {
        const id = uuid();
        pendingFiles.set(id, f);
        // A new document goes to EVERY chat. A chat that has the papers can
        // always ignore them; a chat that needed them and didn't get them
        // answers from nothing, which is the failure worth defaulting against.
        wf.docs.push(
          W.newDoc(
            { name: f.name, type: f.type, size: f.size, chats: wf.chats.map((c) => c.id) },
            id
          )
        );
      }
      renderDocs();
    }
    function renderDocs() {
      ui.docs.innerHTML = "";
      // A column toggle per chat: tick every document for that chat, or clear
      // them all. With five papers and three chats, doing it a box at a time is
      // fifteen clicks and an easy one to miss.
      if ((wf.docs || []).length && (wf.chats || []).length) {
        const head = doc.createElement("div");
        head.className = "cumwf-doc cumwf-doc-head";
        head.innerHTML =
          `<span class="cumwf-doc-name">All documents →</span>` +
          `<span class="cumwf-doc-chats">` +
          (wf.chats || [])
            .map((c) => {
              const all = wf.docs.every((d) => (d.chats || []).indexOf(c.id) !== -1);
              return `<button class="cumwf-btn mini wf-doc-all" type="button" data-chat="${esc(
                c.id
              )}">${all ? "Clear" : "All"} ${esc(c.name)}</button>`;
            })
            .join("") +
          `</span>`;
        head.querySelectorAll(".wf-doc-all").forEach((b) =>
          b.addEventListener("click", () => {
            const id = b.getAttribute("data-chat");
            const all = wf.docs.every((d) => (d.chats || []).indexOf(id) !== -1);
            for (const d of wf.docs) {
              const has = (d.chats || []).indexOf(id) !== -1;
              if (all && has) d.chats = d.chats.filter((x) => x !== id);
              else if (!all && !has) d.chats.push(id);
            }
            renderDocs();
          })
        );
        ui.docs.appendChild(head);
      }
      for (const d of wf.docs || []) {
        const row = doc.createElement("div");
        row.className = "cumwf-doc";
        const checks = (wf.chats || [])
          .map(
            (c) =>
              `<label class="cumwf-check"><input type="checkbox" data-chat="${esc(c.id)}" ${
                (d.chats || []).indexOf(c.id) !== -1 ? "checked" : ""
              } /> ${esc(c.name)}</label>`
          )
          .join("");
        row.innerHTML =
          `<span class="cumwf-doc-name">${esc(d.name)}</span>` +
          `<span class="cumwf-doc-size">${esc(fmtSize(d.size))}</span>` +
          `<span class="cumwf-doc-chats">${checks}` +
          `<button class="cumwf-btn mini wf-doc-del" type="button">Remove</button></span>`;
        row.querySelectorAll("input[type=checkbox]").forEach((cb) =>
          cb.addEventListener("change", () => {
            const id = cb.getAttribute("data-chat");
            const has = (d.chats || []).indexOf(id) !== -1;
            if (cb.checked && !has) d.chats.push(id);
            else if (!cb.checked && has) d.chats = d.chats.filter((x) => x !== id);
          })
        );
        row.querySelector(".wf-doc-del").addEventListener("click", () => {
          wf.docs = wf.docs.filter((x) => x.id !== d.id);
          pendingFiles.delete(d.id);
          renderDocs();
        });
        ui.docs.appendChild(row);
      }
    }
    ui.pick.addEventListener("click", () => ui.fileInput.click());
    ui.fileInput.addEventListener("change", () => {
      addFiles(Array.from(ui.fileInput.files || []));
      ui.fileInput.value = "";
    });
    ui.drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      ui.drop.classList.add("drag");
    });
    ui.drop.addEventListener("dragleave", () => ui.drop.classList.remove("drag"));
    ui.drop.addEventListener("drop", (e) => {
      e.preventDefault();
      ui.drop.classList.remove("drag");
      if (e.dataTransfer && e.dataTransfer.files) addFiles(Array.from(e.dataTransfer.files));
    });

    // ---- steps -----------------------------------------------------------
    function renderSteps() {
      ui.steps.innerHTML = "";
      (wf.steps || []).forEach((step, i) => {
        const card = doc.createElement("div");
        card.className = "cumwf-card";
        const chatOpts = (wf.chats || [])
          .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
          .join("");
        card.innerHTML =
          `<div class="cumwf-card-head"><span class="cumwf-card-title">Step ${i + 1}</span>` +
          `<select class="wf-step-chat" style="width:auto">${chatOpts}</select>` +
          `<button class="cumwf-btn mini wf-up" type="button" title="Move up">↑</button>` +
          `<button class="cumwf-btn mini wf-down" type="button" title="Move down">↓</button>` +
          `<button class="cumwf-btn mini wf-del" type="button" title="Delete step">✕</button></div>` +
          `<textarea class="wf-step-prompt" rows="4" placeholder="What this chat should do">${esc(
            step.prompt
          )}</textarea>` +
          (i === 0
            ? `<p class="cumwf-hint">The first step opens its chat — nothing to carry into it yet.</p>`
            : wf.steps[i - 1] && wf.steps[i - 1].chatId === step.chatId
            ? `<p class="cumwf-hint">Same chat as the step before it — that conversation already has this, ` +
              `so nothing is pasted in.</p>`
            : `<div class="cumwf-row"><label class="cumwf-check"><input class="wf-step-carry" type="checkbox" ${
                step.carry !== false ? "checked" : ""
              } /> Paste the previous step's reply under this prompt</label>` +
              `<input class="wf-step-label" type="text" placeholder="Call it… (e.g. devil's advocate report)" value="${esc(
                step.carryLabel || ""
              )}" /></div>`);
        const chatEl = card.querySelector(".wf-step-chat");
        chatEl.value = step.chatId || (wf.chats[0] && wf.chats[0].id) || "";
        chatEl.addEventListener("change", () => (step.chatId = chatEl.value));
        card.querySelector(".wf-step-prompt").addEventListener("input", function () {
          step.prompt = this.value;
        });
        // Changing a step's chat can make the carry control appear or vanish
        // (two steps in one chat never paste), so redraw rather than leave a
        // tick showing that no longer applies.
        chatEl.addEventListener("change", renderSteps);
        const carryEl = card.querySelector(".wf-step-carry");
        if (carryEl) carryEl.addEventListener("change", () => (step.carry = carryEl.checked));
        const labelEl = card.querySelector(".wf-step-label");
        if (labelEl) labelEl.addEventListener("input", () => (step.carryLabel = labelEl.value));
        card.querySelector(".wf-up").addEventListener("click", () => moveStep(i, -1));
        card.querySelector(".wf-down").addEventListener("click", () => moveStep(i, 1));
        card.querySelector(".wf-del").addEventListener("click", () => {
          wf.steps.splice(i, 1);
          renderSteps();
        });
        ui.steps.appendChild(card);
      });
    }
    function moveStep(i, delta) {
      const j = i + delta;
      if (j < 0 || j >= wf.steps.length) return;
      const [s] = wf.steps.splice(i, 1);
      wf.steps.splice(j, 0, s);
      // The step that lands first can't carry anything; the one that moved out
      // of first position gets its hand-off back.
      wf.steps.forEach((st, k) => (st.carry = k === 0 ? false : st.carry !== false));
      renderSteps();
    }
    ui.addStep.addEventListener("click", () => {
      const last = wf.steps[wf.steps.length - 1];
      // Alternate chats by default — that's what a back-and-forth workflow is.
      const nextChat =
        wf.chats.length > 1 && last
          ? wf.chats[(wf.chats.findIndex((c) => c.id === last.chatId) + 1) % wf.chats.length].id
          : (wf.chats[0] || {}).id;
      wf.steps.push(W.newStep({ chatId: nextChat, prompt: "", carry: wf.steps.length > 0 }, uuid()));
      renderSteps();
    });

    // ---- open / close ----------------------------------------------------
    function open(workflow) {
      wf = workflow;
      originalDocIds = (wf.docs || []).map((d) => d.id);
      pendingFiles.clear();
      ui.template.value = wf.templateName || wf.name || "";
      // Only show a run name when one has actually been set — a template at
      // rest carries its own name in both fields, and echoing it here would
      // read as "this run is called the same as the template".
      ui.name.value = wf.name && wf.name !== ui.template.value ? wf.name : "";
      ui.desc.value = wf.description || "";
      ui.bundle.checked = !!wf.bundleText;
      ui.count.value = (wf.chats || []).length || 1;
      ui.problems.hidden = true;
      renderChats();
      renderDocs();
      renderSteps();
      el.hidden = false;
      try {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) {
        /* ignore */
      }
      ui.name.focus();
    }

    function close() {
      el.hidden = true;
      wf = null;
      runSink = null;
      if (ui.tmplRow) ui.tmplRow.hidden = false;
      ui.save.textContent = "Save workflow";
      pendingFiles.clear();
      if (typeof opts.onClosed === "function") opts.onClosed();
    }

    function flash(text, err) {
      ui.status.textContent = text;
      ui.status.hidden = false;
      ui.status.classList.toggle("err", !!err);
      setTimeout(() => (ui.status.hidden = true), 2600);
    }

    function showProblems(list) {
      ui.problems.innerHTML = list.map((p) => `<li>${esc(p)}</li>`).join("");
      ui.problems.hidden = !list.length;
    }

    ui.cancel.addEventListener("click", close);

    ui.save.addEventListener("click", async () => {
      if (!wf) return;
      // The workflow's own name is the durable one; the run name is this
      // matter's, and a template sitting idle simply wears its own.
      const template = ui.template.value.trim() || ui.name.value.trim();
      wf.templateName = template;
      wf.name = ui.name.value.trim() || template;
      wf.description = ui.desc.value;
      wf.bundleText = ui.bundle.checked;
      const candidate = W.newWorkflow(wf, wf.id, Date.now());
      const problems = W.validate(candidate);
      // An unassigned document is a warning, not a blocker — it just doesn't get
      // uploaded, and the message says so.
      const blocking = problems.filter((p) => !/aren't assigned to a chat/.test(p));
      showProblems(problems);
      if (blocking.length) return flash(blocking[0], true);

      ui.save.disabled = true;
      try {
        const writes = {};
        for (const [id, file] of pendingFiles) writes[J.fileKey(id)] = await readAsDataURL(file);

        // Editing a run: the bytes still go to storage, but the shape goes back
        // to the caller to fold into the run — the template is not touched.
        if (runSink) {
          await storageSet(writes);
          const sink = runSink;
          flash("Saved.");
          close();
          sink(candidate);
          return;
        }

        const all = (await storageGet(WORKFLOWS_KEY))[WORKFLOWS_KEY] || [];
        const next = W.upsertWorkflow(all, candidate);
        writes[WORKFLOWS_KEY] = next;
        await storageSet(writes);
        // Documents dropped during this edit: bin their bytes, unless a copy of
        // this workflow still points at them.
        const keep = new Set(candidate.docs.map((d) => d.id));
        const elsewhere = W.fileIdsInUse(next, candidate.id);
        const dead = originalDocIds.filter((id) => !keep.has(id) && !elsewhere.has(id));
        if (dead.length) {
          try {
            chrome.storage.local.remove(dead.map((id) => J.fileKey(id)));
          } catch (e) {
            /* ignore */
          }
        }
        flash("Saved.");
        if (typeof opts.onSaved === "function") opts.onSaved(candidate);
        close();
      } catch (e) {
        flash("Failed: " + ((e && e.message) || e), true);
      } finally {
        ui.save.disabled = false;
      }
    });

    return {
      edit(workflow) {
        // Deep copy, so Cancel really cancels.
        open(W.newWorkflow(JSON.parse(JSON.stringify(workflow)), workflow.id, Date.now()));
      },
      create() {
        const a = uuid();
        const b = uuid();
        open(
          W.newWorkflow(
            {
              name: "",
              chats: [
                { id: a, name: "Chat A" },
                { id: b, name: "Chat B" },
              ],
              steps: [
                { id: uuid(), chatId: a, prompt: "", carry: false },
                { id: uuid(), chatId: b, prompt: "", carry: true },
              ],
            },
            uuid(),
            Date.now()
          )
        );
      },
      // Edit a RUN in progress: its own steps, chats and documents, none of
      // which belong to the template it came from. `onSave` receives the edited
      // shape; the file bytes are already stored by then.
      editRun(run, onSave) {
        runSink = onSave;
        const plan = run.plan || {};
        open(
          W.newWorkflow(
            {
              name: run.name,
              templateName: run.name,
              chats: plan.chats || [],
              docs: run.docs || [],
              steps: plan.steps || [],
            },
            run.id,
            Date.now()
          )
        );
        if (ui.tmplRow) ui.tmplRow.hidden = true; // a run has no resting name
        ui.name.value = run.name || "";
        ui.save.textContent = "Save changes to this run";
      },
      close,
      isOpen: () => !el.hidden,
      // Which workflow is open for editing, if any. Changes live in the form
      // until Save, so a run started while this is open would use the STORED
      // version — the caller warns rather than letting the two quietly differ.
      editingId: () => (el.hidden || !wf ? null : wf.id),
      destroy() {
        try {
          if (onStorage) chrome.storage.onChanged.removeListener(onStorage);
        } catch (e) {
          /* ignore */
        }
        el.remove();
      },
    };
  }

  root.CUMWorkflowForm = { create };
})(typeof globalThis !== "undefined" ? globalThis : this);
