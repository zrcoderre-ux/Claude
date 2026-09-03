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
    /* Grip for dragging a step. A handle rather than the whole card, so
       selecting text in the prompt still works: the card is only made draggable
       while the pointer is down on this. */
    .cumwf-grip { flex:0 0 auto; cursor:grab; user-select:none; line-height:1;
      padding:2px 4px; border-radius:6px; color:#8a8a8a; font-size:14px;
      background:none; border:none; }
    .cumwf-grip:hover { background:rgba(0,0,0,0.06); color:#6b6b6b; }
    .cumwf-grip:active { cursor:grabbing; }
    .cumwf-card.cumwf-dragging { opacity:.45; }
    /* Where it would land. Drawn on the card the dragged one would sit above,
       so the gap is visible without moving anything until you let go. */
    .cumwf-card.cumwf-drop-before { box-shadow:0 -3px 0 -1px #c96442; }
    .cumwf-list.cumwf-drop-end > .cumwf-card:last-child { box-shadow:0 3px 0 -1px #c96442; }
    .cumwf-card-title { font-size:12px; font-weight:700; color:#6b6b6b; flex:1;
      text-transform:uppercase; letter-spacing:.04em; }
    /* Steps that run at the same time, drawn as one block: a bar down the side
       joining them, so a wave reads as a wave rather than as three steps that
       happen to be next to each other. */
    .cumwf-card.cumwf-par { border-left:3px solid #c96442; border-radius:4px 10px 10px 4px;
      margin-left:10px; }
    .cumwf-card.cumwf-par-first { border-top-left-radius:10px; }
    .cumwf-card.cumwf-par-last { border-bottom-left-radius:10px; }
    /* A pause is a gate between steps, not a step: drawn flatter and quieter so
       the list reads as work with a stop in it. */
    .cumwf-card.cumwf-pause { background:rgba(0,0,0,0.04); border-style:dashed; }
    .cumwf-par-tag { flex:0 0 auto; font-size:11px; font-weight:700; letter-spacing:.03em;
      color:#c96442; background:rgba(201,100,66,0.12); border:none; border-radius:999px;
      padding:2px 8px; cursor:pointer; font-family:inherit; }
    .cumwf-par-tag:hover { background:rgba(201,100,66,0.22); }
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
    /* The completion offered under a prompt. Deliberately a bar rather than
       ghost text inside the box: these prompts run to several lines, and five
       greyed-out lines behind what you're typing is noise, not help. */
    .cumwf-ac { display:flex; align-items:baseline; gap:8px; font-size:12px;
      padding:5px 8px; border:1px solid rgba(201,100,66,0.45); border-radius:8px;
      background:rgba(201,100,66,0.07); cursor:pointer; }
    .cumwf-ac[hidden] { display:none; }
    .cumwf-ac-key { flex:0 0 auto; font-weight:700; color:#c96442; }
    .cumwf-ac-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      color:#4a4a4a; }
    .cumwf-ac-more { flex:0 0 auto; margin-left:auto; color:#8a8a8a; font-size:11px; }
    /* The re-run answers, indented under their switch so they read as its
       detail rather than as more workflow settings. */
    .cumwf-rerun-row { display:flex; flex-direction:column; gap:6px;
      margin:2px 0 2px 18px; padding-left:10px; border-left:2px solid rgba(0,0,0,0.10); }
    .cumwf-rerun-row[hidden] { display:none; }
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
      .cumwf-grip { color:#8a877f; }
      .cumwf-grip:hover { background:rgba(255,255,255,0.08); color:#d4d1c9; }
      .cumwf-rerun-row { border-left-color:rgba(255,255,255,0.16); }
      .cumwf-card.cumwf-pause { background:rgba(255,255,255,0.05); }
      .cumwf-ac { background:rgba(201,100,66,0.14); border-color:rgba(224,135,101,0.5); }
      .cumwf-ac-text { color:#d4d1c9; }
      .cumwf-ac-key { color:#e08765; }
      .cumwf-card.cumwf-par { border-left-color:#e08765; }
      .cumwf-par-tag { color:#e08765; background:rgba(224,135,101,0.18); }
      .cumwf-par-tag:hover { background:rgba(224,135,101,0.3); }
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
    const K = root.CUMCowork;
    const DD = root.CUMDropDir; // a dropped folder, taken apart
    const L = root.CUMLeaks; // a folder marked LEAKS never uploads

    // A <select>'s markup from one of cowork.js's option lists. The unset entry
    // carries its own wording per control, since "Leave as-is" beside three
    // other selects says nothing about what is being left.
    function optionsFor(options, unsetLabel) {
      return (options || [])
        .map(
          (o) =>
            `<option value="${esc(o.value)}">${esc(o.value ? o.label : unsetLabel || o.label)}</option>`
        )
        .join("");
    }
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
      `<div class="cumwf-name-row"><label class="cumwf-label">Run name</label>` +
      `<input class="cumwf-name" type="text" placeholder="e.g. Demurrer — Smith v. Jones" />` +
      `<p class="cumwf-hint">This matter, this run. A run keeps the name of the workflow it came from ` +
      `either way — this is what tells one matter from another.</p></div>` +

      // The matter's DATE — optional, typed as mm/dd/yy or picked from the
      // calendar. It becomes the end of the run's name automatically
      // (composeRunName), so the name box holds the matter alone.
      `<div class="cumwf-date-row"><label class="cumwf-label">Run date (optional)</label>` +
      `<div class="cumwf-row"><input class="cumwf-date" type="text" placeholder="mm/dd/yy" style="width:120px" />` +
      `<button class="cumwf-btn ghost cumwf-date-pick" type="button" title="Pick from a calendar">📅</button>` +
      `<input class="cumwf-date-native" type="date" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none" tabindex="-1" />` +
      `<p class="cumwf-hint">Added to the end of the run's name automatically — and the runs list can sort by it.</p></div></div>` +

      // The papers come straight after the matter's name and date, because
      // they are the matter — everything below them is how the workflow is
      // WORKED, and a run is set up by saying what it is about before saying
      // how. Documents are a MATTER's, so they live on the run. A template holding
      // papers is a template that quietly sends the last matter's exhibits to
      // the next one.
      `<div class="cumwf-docs-row"><label class="cumwf-label">Documents</label>` +
      `<div class="cumwf-drop" tabindex="0"><p class="cumwf-dz-text">Drag files or a folder here, paste text, or</p>` +
      `<div class="cumwf-row"><button class="cumwf-btn ghost cumwf-pick" type="button" ` +
      `title="The papers themselves. A folder hands over the files inside it; the folder itself isn't a document." ` +
      `>Choose files…</button>` +
      `<button class="cumwf-btn ghost cumwf-folder-pick" type="button" ` +
      `title="A whole folder. A CASE folder — one whose name carries a case number — hands over only the files ` +
      `in its Text Files subfolder, plus the pseudonym key, which is attached rather than uploaded. Everything ` +
      `else in it stays where it is.">Choose folder…</button></div></div>` +
      `<input class="cumwf-file-input" type="file" multiple hidden />` +
      `<input class="cumwf-folder-input" type="file" webkitdirectory hidden />` +
      `<p class="cumwf-hint">One door for every paper. A folder hands over the files inside it and never itself, ` +
      `so a matter's folder and the pseudonym_key.xlsx beside it can arrive together — the text files become ` +
      `documents, the key is attached below.</p>` +
      `<p class="cumwf-hint"><b>A case folder is taken apart, not uploaded.</b> Choose folder (or a drop) on a ` +
      `folder whose name carries a case number — <code>23STCV12345 Smith</code> — adds only what is under its ` +
      `<b>Text Files</b> subfolder and attaches the <b>pseudonym key</b> it finds. The originals beside them, in ` +
      `the real names, are left where they are, and the run takes the folder's name unless you have typed one. ` +
      `Any other folder is handed over whole, as it always was.</p>` +
      `<p class="cumwf-hint">Tick the chats that should receive each document — it goes up with that chat's first message. ` +
      `Text pasted anywhere here that isn't a box becomes a .txt document, named from its first line.</p>` +
      `<div class="cumwf-docs cumwf-list"></div></div>` +

      // The matter's pseudonym key rides the run the way its papers do — but
      // ATTACHED, never uploaded: the run's conversations show the reader the
      // real names while Claude keeps seeing the fakes (src/pseudo-view.js),
      // and the key file itself stays out of every chat.
      `<div class="cumwf-pseudo-row"><label class="cumwf-label">Pseudonym key</label>` +
      `<select class="cumwf-pseudo"><option value="">None</option></select>` +
      `<p class="cumwf-hint">Keys are loaded from pseudonym_key.xlsx in the extension's popup. ` +
      `Attaching one here translates the fakes back to real names in this run's chats — display ` +
      `only, nothing is sent — and warns if a prompt carries a real name. The key is never uploaded. ` +
      `Runs are per case, so one key covers a whole related-runs group: set it on any one of them ` +
      `and the rest share it.</p></div>` +

      `<div class="cumwf-desc-row"><label class="cumwf-label">What it does (optional)</label>` +
      `<input class="cumwf-desc" type="text" placeholder="One line, for the list" /></div>` +

      `<label class="cumwf-label">Chats worked between</label>` +
      `<div class="cumwf-row"><input class="cumwf-count" type="number" min="1" max="6" step="1" style="width:80px" />` +
      `<p class="cumwf-hint">Each chat is its own claude.ai conversation. The workflow moves between them, ` +
      `carrying the last reply across.</p></div>` +
      `<div class="cumwf-chats cumwf-list"></div>` +

      // ...but HOW they upload is the template's business, and travels to every
      // run, so it sits with the other switches rather than with the papers.
      `<label class="cumwf-check"><input class="cumwf-bundle" type="checkbox" /> Combine text documents into ` +
      `one labelled file before uploading</label>` +
      `<p class="cumwf-hint">On by default. Twenty separate attachments is where claude.ai starts showing Claude ` +
      `fewer than were sent. One file, with each document announced by name inside it, either arrives or doesn't. ` +
      `PDFs and Word files still go up on their own — only text is combined.</p>` +

      `<label class="cumwf-check"><input class="cumwf-name-chats" type="checkbox" /> Name each conversation ` +
      `after the run — “<span class="cumwf-name-eg">Matter</span>: Chat A”</label>` +
      `<p class="cumwf-hint">Only conversations a run opens itself. A chat you point it at keeps the name ` +
      `it has: retitling work you started is not the extension's business.</p>` +
      `<label class="cumwf-check"><input class="cumwf-rerun" type="checkbox" /> Offer to run a finished ` +
      `run again</label>` +
      `<p class="cumwf-hint">Adds a Re-run button to this workflow's finished runs. Off by default; each ` +
      `run keeps its own copy of this and of the answers below, so one matter can differ without touching ` +
      `the workflow.</p>` +
      `<div class="cumwf-rerun-row" hidden>` +
      `<div class="cumwf-row"><label class="cumwf-hint" style="flex:0 0 auto">Start a re-run at</label>` +
      `<select class="cumwf-rr-step" style="width:auto"></select></div>` +
      `<p class="cumwf-hint">A workflow that opens by producing the thing the rest of it works on has ` +
      `nothing to produce the second time.</p>` +
      `<label class="cumwf-check"><input class="cumwf-rr-fresh" type="checkbox" /> In fresh conversations ` +
      `— otherwise it carries on in that run's chats</label>` +
      `<label class="cumwf-check"><input class="cumwf-rr-carry" type="checkbox" /> Paste that run's final ` +
      `reply into the step it starts at</label>` +
      `<label class="cumwf-check"><input class="cumwf-rr-docs" type="checkbox" /> Give fresh conversations ` +
      `the same documents</label>` +
      `<p class="cumwf-hint">The last two apply to fresh conversations, which start empty: without them a ` +
      `re-run begins knowing nothing of what came before, and its papers never arrive. Every answer here ` +
      `is a default — Re-run still asks, so you can change your mind for one run.</p></div>` +

      `<label class="cumwf-check"><input class="cumwf-ignore-outage" type="checkbox" /> Keep going during a ` +
      `claude.ai outage</label>` +
      `<p class="cumwf-hint">Off by default: when status.claude.com reports trouble, a run holds until it ` +
      `clears. Most outages are partial, and a run that never touches the broken part loses hours waiting ` +
      `for nothing. Tick this and it presses on regardless. An outage that names models is already handled ` +
      `— a run on a model nobody has reported never waits.</p>` +

      `<label class="cumwf-check"><input class="cumwf-new-window" type="checkbox" /> Open this run in a ` +
      `window of its own</label>` +
      `<p class="cumwf-hint">Off by default: the run's chats open as background tabs in the window you ` +
      `already have, behind whatever you're doing. Tick this and it gets a window to itself, maximized, ` +
      `with the Options page pinned beside its chats as a control panel — worth it for a long run you ` +
      `want to watch, and a window to find and close when you don't. The size is not only cosmetic: ` +
      `claude.ai serves a narrower layout below a certain width, which renders some blocks as ` +
      `\u201cnot supported on your current device\u201d, so a small window can cost a step its material. ` +
      `Like every switch here it is the workflow's default and a run's to change.</p>` +

      `<label class="cumwf-label">Steps</label>` +
      `<div class="cumwf-steps cumwf-list"></div>` +
      `<div class="cumwf-row"><button class="cumwf-btn ghost cumwf-add-step" type="button">+ Add step</button>` +
      `<button class="cumwf-btn ghost cumwf-add-pause" type="button" title="Stop the run here so you can read what it has produced">+ Add pause</button></div>` +

      // Runs only: when this one should go. It lives here rather than on the
      // workflow's row because it belongs to the matter, not the template —
      // and because the last thing you do after setting a run up is decide
      // whether it goes now, at a time, or not yet.
      `<div class="cumwf-when-row" hidden>` +
      `<label class="cumwf-label">When it starts</label>` +
      `<div class="cumwf-row">` +
      `<select class="cumwf-when">` +
      `<option value="draft">Not yet — leave it set up and waiting</option>` +
      `<option value="now">Run now</option>` +
      `<option value="reset">When usage resets</option>` +
      `<option value="time">At a set time</option>` +
      `</select>` +
      `<input class="cumwf-at" type="datetime-local" disabled /></div>` +
      `<p class="cumwf-hint cumwf-when-hint"></p></div>` +

      `<ul class="cumwf-problems" hidden></ul>` +
      `<div class="cumwf-actions"><button class="cumwf-btn primary cumwf-save" type="button">Save workflow</button>` +
      `<button class="cumwf-btn ghost cumwf-cancel" type="button">Cancel</button>` +
      `<span class="cumwf-status" hidden></span></div>`;
    container.appendChild(el);

    const q = (c) => el.querySelector(c);
    const ui = {
      name: q(".cumwf-name"),
      date: q(".cumwf-date"),
      dateRow: q(".cumwf-date-row"),
      datePick: q(".cumwf-date-pick"),
      dateNative: q(".cumwf-date-native"),
      template: q(".cumwf-template"),
      tmplRow: q(".cumwf-tmpl-row"),
      nameRow: q(".cumwf-name-row"),
      desc: q(".cumwf-desc"),
      count: q(".cumwf-count"),
      chats: q(".cumwf-chats"),
      drop: q(".cumwf-drop"),
      pick: q(".cumwf-pick"),
      bundle: q(".cumwf-bundle"),
      nameChats: q(".cumwf-name-chats"),
      rerun: q(".cumwf-rerun"),
      rerunRow: q(".cumwf-rerun-row"),
      ignoreOutage: q(".cumwf-ignore-outage"),
      newWindow: q(".cumwf-new-window"),
      rrStep: q(".cumwf-rr-step"),
      rrFresh: q(".cumwf-rr-fresh"),
      rrCarry: q(".cumwf-rr-carry"),
      rrDocs: q(".cumwf-rr-docs"),
      fileInput: q(".cumwf-file-input"),
      folderInput: q(".cumwf-folder-input"),
      folderPick: q(".cumwf-folder-pick"),
      docs: q(".cumwf-docs"),
      docsRow: q(".cumwf-docs-row"),
      pseudo: q(".cumwf-pseudo"),
      pseudoRow: q(".cumwf-pseudo-row"),
      descRow: q(".cumwf-desc-row"),
      steps: q(".cumwf-steps"),
      addStep: q(".cumwf-add-step"),
      addPause: q(".cumwf-add-pause"),
      whenRow: q(".cumwf-when-row"),
      when: q(".cumwf-when"),
      at: q(".cumwf-at"),
      whenHint: q(".cumwf-when-hint"),
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
        if (changes[WORKFLOWS_KEY] && !el.hidden) refreshPromptPool();
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
        const surfaceOpts = optionsFor(K ? K.surfaceOptions() : [], "Surface: leave as-is");
        const approvalOpts = optionsFor(K ? K.modeOptions() : [], "Approvals: leave as-is");
        card.innerHTML =
          `<div class="cumwf-card-head"><span class="cumwf-card-title">Chat ${esc(
            "ABCDEF"[i] || i + 1
          )}</span></div>` +
          `<input class="wf-chat-name" type="text" value="${esc(chat.name)}" placeholder="What this chat is for" />` +
          `<div class="cumwf-row">` +
          `<select class="wf-chat-target"><option value="new">New chat — no project</option>${projOpts}` +
          `<option value="code">New Claude Code chat (pick a repo)</option></select>` +
          `<select class="wf-chat-model">${modelOpts}</select>` +
          `<select class="wf-chat-surface" title="Which surface this chat opens on">${surfaceOpts}</select>` +
          `<select class="wf-chat-approval" title="How much Claude may do unattended, in Cowork">${approvalOpts}</select>` +
          `</div>` +
          `<input class="wf-chat-repo" type="text" placeholder="owner/name" value="${esc(
            (chat.target && chat.target.codeRepo) || ""
          )}" hidden />` +
          `<input class="wf-chat-start" type="text" placeholder="Or start in an existing chat — paste its link" value="${esc(
            chat.startUrl || ""
          )}" />` +
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
        const surfaceEl = card.querySelector(".wf-chat-surface");
        const approvalEl = card.querySelector(".wf-chat-approval");
        surfaceEl.value = (chat.target && chat.target.surface) || "";
        approvalEl.value = chat.approval || "";
        const syncRepo = () => (repoEl.hidden = targetEl.value !== "code");
        // Approvals belong to Cowork. Offering the choice on a Chat conversation
        // would be promising something the send has no control to keep.
        const syncApproval = () => (approvalEl.hidden = surfaceEl.value !== "cowork");
        syncRepo();
        syncApproval();

        nameEl.addEventListener("input", () => {
          chat.name = nameEl.value;
          renderSteps(); // step rows name their chat
          renderDocs();
        });
        targetEl.addEventListener("change", () => {
          const v = targetEl.value;
          const o = targetEl.selectedOptions[0];
          chat.target = {
            projectUuid: null,
            projectName: null,
            projectHref: null,
            codeRepo: null,
            // The surface survives a change of destination: which project a
            // chat lives in and whether it's a Cowork one are separate answers,
            // and re-picking the project shouldn't silently undo the other.
            surface: surfaceEl.value || null,
          };
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
        modelEl.addEventListener("change", () => {
          chat.model = modelEl.value || null;
          // Each step shows what it inherits, so those labels are now stale.
          renderSteps();
        });
        surfaceEl.addEventListener("change", () => {
          chat.target = chat.target || {};
          chat.target.surface = surfaceEl.value || null;
          // A chat that leaves Cowork keeps no approval mode: it would be a
          // setting with nothing to act on, waiting to surprise whoever turns
          // Cowork back on months later.
          if (surfaceEl.value !== "cowork") {
            chat.approval = null;
            approvalEl.value = "";
          }
          syncApproval();
          renderSteps(); // the steps' inherit labels just changed
        });
        approvalEl.addEventListener("change", () => {
          chat.approval = approvalEl.value || null;
          renderSteps();
        });
        const startEl = card.querySelector(".wf-chat-start");
        startEl.addEventListener("input", () => (chat.startUrl = startEl.value.trim() || null));
        const seedEl = card.querySelector(".wf-chat-seed");
        seedEl.addEventListener("change", () => (chat.seedFromLatest = seedEl.checked));
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
    // Text pasted into the editor, anywhere that isn't a box you were typing
    // in, becomes a document — the same move claude.ai makes when you paste
    // something too big to be a message. There is nowhere else for it to go
    // here, so there's no length threshold to guess at: if you pasted it onto
    // the documents field, you meant it to be a document.
    function pasteAsDocument(text) {
      const body = String(text || "");
      if (!body.trim()) return;
      const name = W.pastedDocName(
        body,
        (wf.docs || []).map((d) => d.name)
      );
      addFiles([new File([body], name, { type: "text/plain" })]);
      flash("Added " + name);
    }

    el.addEventListener("paste", (e) => {
      if (el.hidden) return;
      // Nowhere for it to go while the papers are the run's. Pasting into a
      // template's editor would otherwise make a document you couldn't see.
      if (ui.docsRow && ui.docsRow.hidden) return;
      // Never steal a paste meant for a prompt, a name or a link.
      const t = e.target;
      const tag = (t && t.tagName) || "";
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || (t && t.isContentEditable))
        return;
      const cd = e.clipboardData;
      if (!cd) return;
      // Real files on the clipboard are just files — they don't need wrapping
      // in a text document to be understood.
      if (cd.files && cd.files.length) {
        e.preventDefault();
        return addFiles(Array.from(cd.files));
      }
      const text = cd.getData("text/plain");
      if (!text || !text.trim()) return;
      e.preventDefault();
      pasteAsDocument(text);
    });

    // Is this spreadsheet the matter's KEY, and if so attach it — parsed and
    // stored as the run's key, which is where it was headed: attached, never
    // uploaded. Answers true when it did, and is quiet either way, because one
    // caller is OFFERING candidates (the case-folder split hands over every
    // .xlsx it saw) and a refusal per spreadsheet would be noise there.
    /**
     * Keep the workbook a run's key was read from, beside the library rather
     * than in it, so the key panel on the page can hand it back. Best effort:
     * a file too big to keep is a key that still works, minus the download.
     */
    async function rememberKeyFile(id, bytes, name) {
      const KF = window.CUMKeyFile;
      if (!KF || !id) return;
      const made = KF.fileRecord(bytes, name, Date.now());
      if (!made.ok) return;
      await new Promise((res) =>
        chrome.storage.local.get(KF.FILES_KEY, (r) => {
          const files = KF.putFile((r && r[KF.FILES_KEY]) || {}, id, made.record);
          chrome.storage.local.set({ [KF.FILES_KEY]: files }, res);
        })
      );
    }

    async function attachKeyFile(f, folder) {
      const P = window.CUMPseudo;
      const X = window.CUMXlsx;
      if (P && X && /\.xlsx$/i.test(f.name || "")) {
        try {
          // Read ONCE and keep what was read: the key panel on the page hands
          // this workbook back (src/keyfile.js), and it has to be the workbook
          // that was parsed rather than whatever is at that path later.
          const buf = X.parseXlsx ? await f.arrayBuffer() : null;
          const wb = buf ? await X.parseXlsx(buf) : null;
          if (wb && (P.isKeyFileName(f.name) || P.sheetsLookLikeKey(wb.sheets))) {
            const key = P.parseKey(wb.sheets, f.name);
            if (key.rows) {
              // Content decides the library id (P.libraryIdFor): the same
              // case's refreshed key lands on its entry, another case's key
              // sits beside it — the filename is always pseudonym_key.xlsx.
              let id = null;
              key.savedAt = Date.now();
              // The case folder is what this key is CALLED from here on — the
              // same name the run takes, so the picker and the runs list read
              // as the same matter. A key picked loose keeps whatever the
              // entry already learned (P.keepKeyFacts).
              if (folder) key.folder = folder;
              await new Promise((res) =>
                chrome.storage.local.get("cum_pseudo_keys", (r) => {
                  const keys = (r && r.cum_pseudo_keys) || {};
                  id = P.libraryIdFor(keys, key).id;
                  keys[id] = P.keepKeyFacts ? P.keepKeyFacts(keys[id], key) : key;
                  chrome.storage.local.set({ cum_pseudo_keys: keys }, res);
                })
              );
              await rememberKeyFile(id, new Uint8Array(buf.slice(0)), f.name);
              wf.pseudoKeyId = id;
              loadPseudoKeys();
              flash(
                (folder ? folder : f.name) +
                  " is the pseudonym key — attached to this run instead of uploaded."
              );
              return true;
            }
          }
        } catch (e) {
          /* unreadable: not a key, and the caller decides what to say */
        }
      }
      return false;
    }

    // A spreadsheet never becomes a run document — the model drops one at every
    // shaping path and the runner refuses to read one (W.docBarred /
    // allowedDocs), so admitting it here would only show a row that silently
    // never uploads. The pseudonym key gets the better answer above; everything
    // else gets told, by name, that it wasn't added.
    async function divertSpreadsheet(f) {
      if (await attachKeyFile(f)) return;
      flash("Spreadsheets never ride a run's uploads — " + f.name + " was not added.", true);
    }

    // A folder's files, once the walk has taken it apart. The folder itself is
    // never among them — that is the whole point — and what the walk left out
    // is said rather than left to be noticed.
    function takeFolder(res) {
      if (!res) return;
      // On the walked entries rather than the files: only the paths say which
      // folder a file came out of, and they are gone by the time addFiles sees
      // a File. A barred pick stops here — nothing is added, and the walk's own
      // summary is not said, because nothing was taken to summarize.
      const gated = leaksHeld(res.files);
      if (!gated || gated.hit) return;
      addFiles(gated.files.map((x) => x.file));
      const said = DD ? DD.summarize(res) : "";
      if (said) flash(said);
    }

    // Does this folder's name carry a case number? The whole case-folder rule
    // is gated on that one question, and P.caseNumbers is the same reader the
    // run gate uses — so a folder this takes apart is a folder whose run will
    // be held to having a key that covers the number.
    function isCaseFolderName(name) {
      const P = window.CUMPseudo;
      return !!(P && P.caseNumbers && P.caseNumbers(name).length);
    }

    // A case folder, taken apart: only what is under Text Files becomes a
    // document, the key is attached, and the originals beside them are left
    // alone. Answers false when this wasn't a case folder at all, so the caller
    // can hand it to the ordinary walk instead.
    function takeCaseFolder(files) {
      if (!DD || !DD.splitCaseFolder) return false;
      // A case folder marked LEAKS is refused whole — its Text Files, its
      // originals and its key alike. Answered as HANDLED rather than "not a
      // case folder", so the caller does not hand the same pick to the
      // ordinary walk and take it apart by the other door.
      const gated = leaksHeld(files);
      if (!gated || gated.hit) return true;
      const split = DD.splitCaseFolder(gated.files, { isCaseName: isCaseFolderName });
      if (!split.ok) return false;
      addFiles(split.docs.map((x) => x.file));
      flash(DD.summarizeCase(split));
      // The matter's name, from the folder that IS the matter — but never over
      // a name already typed: what you wrote about this run beats what the
      // folder happens to be called.
      if (ui.name && !ui.name.value.trim()) ui.name.value = split.root;
      // The key rides the run ATTACHED, so it goes to the key slot rather than
      // into the documents — which is the whole reason a case folder is worth
      // taking apart in one gesture. Read in order and stop at the first real
      // one; a folder with no key in it is said out loud, because a run whose
      // name carries a case number needs one before it will go anywhere.
      (async () => {
        for (const k of split.keys) if (await attachKeyFile(k.file, split.root)) return;
        if (ui.pseudo && ui.pseudo.value) return; // one was already attached
        flash(
          "No pseudonym key in " + split.root + " — attach one below, or this run won't go out: " +
            "its name carries a case number.",
          true
        );
      })();
      return true;
    }

    // Same name AND same size as one already here: a second drop of the same
    // folder, or the file picked twice. Two genuinely different papers that
    // agree on both is a coincidence worth losing to the far commoner case of
    // forty duplicated exhibits.
    function docKey(f) {
      return String(f.name || "") + ":" + (f.size || 0);
    }

    // A folder marked LEAKS never uploads (src/leaks.js). Asked at every door
    // into a workflow's documents, and before anything else is done with a
    // pick — a workflow uploads what it is holding on its own schedule, so a
    // paper that got in here goes out with nobody watching.
    //
    // With the gate itself missing the pick is refused rather than allowed: a
    // bar against papers reaching claude.ai that fails open is not a bar.
    function leaksHeld(entries) {
      if (!L) {
        flash(
          "The LEAKS upload gate is not loaded, so nothing was added — a folder could not be " +
            "checked for a LEAKS spreadsheet. Reload this page and pick it again.",
          true
        );
        return null;
      }
      const res = L.gate(entries);
      if (res.hit) flash(L.describe(res), true);
      return res;
    }

    function addFiles(list) {
      // Before the spreadsheet diversion below, which would otherwise read the
      // marker itself as a candidate pseudonym key.
      const gated = leaksHeld(Array.from(list || []));
      if (!gated) return;
      list = gated.files;
      const incoming = [];
      const have = new Set((wf.docs || []).map(docKey));
      let dupes = 0;
      for (const f of list || []) {
        if (W.docBarred && W.docBarred(f.name)) {
          divertSpreadsheet(f);
          continue;
        }
        if (have.has(docKey(f))) {
          dupes++;
          continue;
        }
        have.add(docKey(f));
        incoming.push(f);
      }
      if (dupes) flash(dupes === 1 ? "1 file was already here." : dupes + " files were already here.");
      for (const f of incoming) {
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
    // Every pick — a handful of files, a whole folder, or a folder and the key
    // sitting beside it — goes through the same door and the same rules, so
    // there is nothing to decide before choosing. A folder is flattened to the
    // files inside it, junk is dropped and the order is the folder's own.
    // Without the walker loaded, files are still files: never lose a pick.
    function takePicked(list) {
      if (!DD) return addFiles(list);
      // Scanned without the ordinary cap first: a case folder's Text Files
      // subfolder has to be REACHED, and 300 files into a matter's originals is
      // not far enough in. Only what the split hands back is capped.
      const scan = DD.fromPicked(list, { maxFiles: DD.MAX_SCAN });
      if (takeCaseFolder(scan.files)) return;
      takeFolder(DD.fromPicked(list));
    }
    // The browser's file dialog will not select a folder — that is the OS
    // panel, not a choice this form makes — so the folder door is this same
    // button held down with a modifier, and the drop zone, which takes files
    // and folders together in one gesture.
    ui.pick.addEventListener("click", (e) => {
      if (ui.folderInput && e.altKey) ui.folderInput.click();
      else ui.fileInput.click();
    });
    // Its own door again, rather than a modifier on the other one: picking a
    // folder is what the case rule is for, and a feature you have to know a
    // keystroke to reach is a feature that gets used by accident instead.
    if (ui.folderPick && ui.folderInput)
      ui.folderPick.addEventListener("click", () => ui.folderInput.click());
    ui.fileInput.addEventListener("change", () => {
      takePicked(Array.from(ui.fileInput.files || []));
      ui.fileInput.value = "";
    });
    if (ui.folderInput)
      ui.folderInput.addEventListener("change", () => {
        takePicked(Array.from(ui.folderInput.files || []));
        ui.folderInput.value = "";
      });

    // The date's two doors agree: the calendar seeds from what the box says,
    // and a pick writes back in the box's own mm/dd/yy spelling.
    if (ui.datePick && ui.dateNative) {
      ui.datePick.addEventListener("click", () => {
        const iso = W.parseRunDate(ui.date.value);
        if (iso) ui.dateNative.value = iso;
        try {
          ui.dateNative.showPicker();
        } catch (e) {
          ui.dateNative.click();
        }
      });
      ui.dateNative.addEventListener("change", () => {
        const iso = W.isoRunDate(ui.dateNative.value);
        if (iso) ui.date.value = W.runDateLabel(iso);
      });
    }
    ui.drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      ui.drop.classList.add("drag");
    });
    ui.drop.addEventListener("dragleave", () => ui.drop.classList.remove("drag"));
    ui.drop.addEventListener("drop", (e) => {
      e.preventDefault();
      ui.drop.classList.remove("drag");
      const dt = e.dataTransfer;
      if (!dt) return;
      // webkitGetAsEntry has to be called NOW: the items list is emptied the
      // moment this handler returns, so the entries are collected first and
      // walked afterwards. An entry is what tells a folder from a file —
      // dt.files reports a dropped folder as a zero-byte file, which is how a
      // folder used to end up in the list as a document that uploads nothing.
      const entries = dt.items
        ? Array.from(dt.items)
            .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
            .filter(Boolean)
        : [];
      // A dropped CASE folder is the same folder as a picked one, so it is
      // taken apart the same way — and its name is readable before the walk,
      // which is what lets the scan cap be raised only where it has to be.
      const caseDrop = entries.some((en) => en && en.isDirectory && isCaseFolderName(en.name));
      if (entries.length && DD)
        DD.walk(entries, caseDrop ? { maxFiles: DD.MAX_SCAN } : null).then((res) => {
          if (caseDrop && takeCaseFolder(res.files)) return;
          takeFolder(res);
        });
      else if (dt.files) addFiles(Array.from(dt.files));
    });

    // A pause: the run stops here so what it has produced can be read. No chat,
    // no prompt, no model — it is a gate between two steps, and its card says
    // only the one thing there is to decide about it.
    function pauseCard(step, i, labels) {
      const card = doc.createElement("div");
      card.className = "cumwf-card cumwf-pause";
      card.setAttribute("data-step-id", step.id);
      const mins = W.pauseMinutes(step.pauseMinutes);
      card.innerHTML =
        `<div class="cumwf-card-head">` +
        `<button class="cumwf-grip" type="button" title="Drag to reorder" aria-label="Drag to reorder">⠿</button>` +
        `<span class="cumwf-card-title">Step ${esc(labels[i] || i + 1)} — pause</span>` +
        `<button class="cumwf-btn mini wf-up" type="button" title="Move up">↑</button>` +
        `<button class="cumwf-btn mini wf-down" type="button" title="Move down">↓</button>` +
        `<button class="cumwf-btn mini wf-add" type="button" title="Add a step below this one">＋</button>` +
        `<button class="cumwf-btn mini wf-del" type="button" title="Remove this pause">✕</button>` +
        `</div>` +
        `<div class="cumwf-row"><label class="cumwf-check"><input class="wf-pause-timed" type="checkbox" ${
          mins > 0 ? "checked" : ""
        } /> Carry on by itself after</label>` +
        `<input class="wf-pause-mins" type="number" min="1" max="${W.PAUSE_MAX_MINUTES}" step="1" ` +
        `style="width:90px" value="${mins > 0 ? mins : 60}"${mins > 0 ? "" : " hidden"} />` +
        `<span class="cumwf-hint wf-pause-unit"${mins > 0 ? "" : " hidden"}>minutes</span></div>` +
        `<p class="cumwf-hint">${
          mins > 0
            ? "It waits " +
              esc(W.formatMs(mins * 60000)) +
              ", then carries on without you — Resume goes sooner. For work you would LIKE to " +
              "look over but would rather not have waiting all night if you don't."
            : "It waits for Resume, however long that takes. For work you mean to read before " +
              "the rest of the run is built on top of it."
        }</p>`;
      const timed = card.querySelector(".wf-pause-timed");
      const box = card.querySelector(".wf-pause-mins");
      timed.addEventListener("change", () => {
        step.pauseMinutes = timed.checked ? W.pauseMinutes(box.value) || 60 : 0;
        renderSteps();
      });
      box.addEventListener("input", () => {
        step.pauseMinutes = W.pauseMinutes(box.value);
      });
      wireStepDrag(card);
      card.querySelector(".wf-up").addEventListener("click", () => moveStep(i, -1));
      card.querySelector(".wf-down").addEventListener("click", () => moveStep(i, 1));
      card.querySelector(".wf-add").addEventListener("click", () => insertStep(i + 1));
      card.querySelector(".wf-del").addEventListener("click", () => {
        wf.steps.splice(i, 1);
        renderSteps();
      });
      return card;
    }

    // ---- steps -----------------------------------------------------------
    function renderSteps() {
      ui.steps.innerHTML = "";
      // "1", "2A", "2B", "2C", "3" — and which steps run together, so a card
      // can say what it is part of rather than only where it sits.
      const labels = W.stepLabels(wf.steps || []);
      const waves = W.stepWaves(wf.steps || []);
      const waveFor = [];
      for (const w of waves) for (const m of w.members) waveFor[m] = w;
      (wf.steps || []).forEach((step, i) => {
        if (W.isPauseStep(step)) {
          ui.steps.appendChild(pauseCard(step, i, labels));
          return;
        }
        const wave = waveFor[i] || { members: [i] };
        const parallel = wave.members.length > 1;
        const card = doc.createElement("div");
        card.className =
          "cumwf-card" +
          (parallel
            ? " cumwf-par" +
              (wave.members[0] === i ? " cumwf-par-first" : "") +
              (wave.members[wave.members.length - 1] === i ? " cumwf-par-last" : "")
            : "");
        const chatOpts = (wf.chats || [])
          .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
          .join("");
        // Per-step model. Blank inherits the chat's, which is what nearly every
        // step wants; naming one here switches the conversation to it for this
        // step and leaves it there, so a chat can draft on one model and revise
        // on another.
        const chat = (wf.chats || []).find((c) => c.id === step.chatId) || {};
        const inherited = chat.model || "whatever the chat is on";
        const known = models.length ? models : SEED_MODELS;
        const stepModelOpts = [""]
          // A model that has since left claude.ai's picker still has to show, or
          // the select would fall back to blank and silently lose the choice.
          .concat(step.model && known.indexOf(step.model) === -1 ? [step.model] : [])
          .concat(known)
          .map((m) =>
            m
              ? `<option value="${esc(m)}">${esc(m)}</option>`
              : `<option value="">Model: ${esc(inherited)}</option>`
          )
          .join("");
        // Per-step approvals, on the same terms as the model: blank inherits
        // the chat's, and naming one here leaves the conversation on it for the
        // steps after — so a chat can research with the brakes off and then
        // edit a filing with them on.
        const coworkChat = (chat.target && chat.target.surface) === "cowork";
        const inheritedApproval =
          K && chat.approval ? K.describeMode(chat.approval) : "whatever the chat is on";
        const stepApprovalOpts = optionsFor(
          K ? K.modeOptions() : [],
          "Approvals: " + inheritedApproval
        );
        card.setAttribute("data-step-id", step.id);
        card.innerHTML =
          `<div class="cumwf-card-head">` +
          `<button class="cumwf-grip" type="button" title="Drag to reorder" aria-label="Drag to reorder">⠿</button>` +
          `<span class="cumwf-card-title">Step ${esc(labels[i] || i + 1)}</span>` +
          (parallel
            ? `<button class="cumwf-par-tag wf-unpar" type="button" title="Runs at the same time as ${esc(
                wave.members.filter((m) => m !== i).map((m) => labels[m]).join(" and ")
              )}, in its own chat — click to take it out of the wave">⇉ at once</button>`
            : "") +
          `<select class="wf-step-chat" style="width:auto">${chatOpts}</select>` +
          `<select class="wf-step-model" style="width:auto" title="Which model answers this step">${stepModelOpts}</select>` +
          `<select class="wf-step-approval" style="width:auto" title="How much Claude may do unattended on this step"${
            coworkChat ? "" : " hidden"
          }>${stepApprovalOpts}</select>` +
          `<button class="cumwf-btn mini wf-up" type="button" title="Move up">↑</button>` +
          `<button class="cumwf-btn mini wf-down" type="button" title="Move down">↓</button>` +
          // Add HERE, rather than at the bottom and then dragged up. Next to
          // the delete, since both are about this step's place in the list.
          `<button class="cumwf-btn mini wf-add" type="button" title="Add a step below this one">＋</button>` +
          // …and one that adds a step running ALONGSIDE this one rather than
          // after it: same hand-off in, both replies out to whatever follows.
          `<button class="cumwf-btn mini wf-par" type="button" title="Add a step that runs at the same time as this one, in another chat">⇉</button>` +
          `<button class="cumwf-btn mini wf-del" type="button" title="Delete step">✕</button></div>` +
          `<textarea class="wf-step-prompt" rows="4" placeholder="What this chat should do">${esc(
            step.prompt
          )}</textarea>` +
          `<div class="cumwf-ac" hidden><span class="cumwf-ac-key">↵</span>` +
          `<span class="cumwf-ac-text"></span><span class="cumwf-ac-more"></span></div>` +
          // What this step is handed, judged from the step before its WAVE:
          // 2B's neighbour is 2A, but 2A is not where its material comes from.
          // They are given the same thing at the same time — that is what makes
          // them parallel rather than a queue.
          (wave.members[0] === 0
            ? `<p class="cumwf-hint">${
                parallel
                  ? "These steps open their chats together — nothing to carry into them yet."
                  : "The first step opens its chat — nothing to carry into it yet."
              }</p>`
            : wf.steps[wave.members[0] - 1] &&
              wf.steps[wave.members[0] - 1].chatId === step.chatId
            ? `<p class="cumwf-hint">Same chat as the step before it — that conversation already has this, ` +
              `so nothing is pasted in.</p>`
            : `<div class="cumwf-row"><label class="cumwf-check"><input class="wf-step-carry" type="checkbox" ${
                step.carry !== false ? "checked" : ""
              } /> Paste ${
                parallel ? "step " + esc(labels[wave.members[0] - 1]) + "'s" : "the previous step's"
              } reply under this prompt</label>` +
              `<input class="wf-step-label" type="text" placeholder="Call it… (e.g. devil's advocate report)" value="${esc(
                step.carryLabel || ""
              )}" /></div>`) +
          (parallel
            ? `<p class="cumwf-hint">Runs at the same time as ${esc(
                wave.members.filter((m) => m !== i).map((m) => "step " + labels[m]).join(" and ")
              )}, and never sees ${wave.members.length > 2 ? "them" : "it"}. ${
                wf.steps[wave.members[wave.members.length - 1] + 1]
                  ? "Step " +
                    esc(labels[wave.members[wave.members.length - 1] + 1]) +
                    " is handed all of their replies together."
                  : "Add a step after them to read all of their replies together."
              }</p>`
            : "") +
          // Per STEP, not per chat: the drafting conversation writes the ruling,
          // then revises it, then takes a style pass over it, and only some of
          // those replies have to be a ruling before they travel.
          `<label class="cumwf-check"><input class="wf-step-ruling" type="checkbox" ${
            step.expectsRuling ? "checked" : ""
          } /> Its output is a tentative ruling — don't move to the next step unless the reply contains</label>` +
          `<input class="wf-step-marker" type="text" placeholder="${esc(W.DEFAULT_OUTPUT_MARKER)}" value="${esc(
            step.outputMarker || ""
          )}"${step.expectsRuling ? "" : " hidden"} />` +
          `<p class="cumwf-hint"${step.expectsRuling ? "" : " hidden"}>A clarifying question, a note that a paper ` +
          `is missing, or a turn cut off at the tool-use limit are all real replies — none of them the ruling. ` +
          `Applies whether or not the next step is in another chat: a second step sent on top of half a ruling is ` +
          `still working from half a ruling. A reply that isn't one gets <b>one</b> request to carry on; if the ` +
          `next one still isn't the ruling the run <b>pauses</b> rather than building on it. And the phrase turning ` +
          `up doesn't end the wait — it's the ruling's first line, so the reply then has to hold still for a minute ` +
          `before it counts as finished.</p>`;
        const chatEl = card.querySelector(".wf-step-chat");
        chatEl.value = step.chatId || (wf.chats[0] && wf.chats[0].id) || "";
        chatEl.addEventListener("change", () => (step.chatId = chatEl.value));
        const stepModelEl = card.querySelector(".wf-step-model");
        stepModelEl.value = step.model || "";
        stepModelEl.addEventListener("change", () => (step.model = stepModelEl.value || null));
        const stepApprovalEl = card.querySelector(".wf-step-approval");
        if (stepApprovalEl) {
          stepApprovalEl.value = step.approval || "";
          stepApprovalEl.addEventListener("change", () => (step.approval = stepApprovalEl.value || null));
        }
        wirePromptComplete(card.querySelector(".wf-step-prompt"), card.querySelector(".cumwf-ac"), step);
        // Changing a step's chat can make the carry control appear or vanish
        // (two steps in one chat never paste), so redraw rather than leave a
        // tick showing that no longer applies.
        chatEl.addEventListener("change", renderSteps);
        const carryEl = card.querySelector(".wf-step-carry");
        if (carryEl) carryEl.addEventListener("change", () => (step.carry = carryEl.checked));
        const labelEl = card.querySelector(".wf-step-label");
        if (labelEl) labelEl.addEventListener("input", () => (step.carryLabel = labelEl.value));
        const rulingEl = card.querySelector(".wf-step-ruling");
        const markerEl = card.querySelector(".wf-step-marker");
        const markerHint = markerEl && markerEl.nextElementSibling;
        if (rulingEl && markerEl)
          rulingEl.addEventListener("change", () => {
            step.expectsRuling = rulingEl.checked;
            markerEl.hidden = !rulingEl.checked;
            if (markerHint) markerHint.hidden = !rulingEl.checked;
          });
        if (markerEl)
          markerEl.addEventListener("input", () => (step.outputMarker = markerEl.value.trim() || null));
        wireStepDrag(card);
        card.querySelector(".wf-up").addEventListener("click", () => moveStep(i, -1));
        card.querySelector(".wf-down").addEventListener("click", () => moveStep(i, 1));
        card.querySelector(".wf-add").addEventListener("click", () => insertStep(i + 1));
        card.querySelector(".wf-par").addEventListener("click", () => insertParallel(i));
        const unpar = card.querySelector(".wf-unpar");
        if (unpar) unpar.addEventListener("click", () => leaveWave(i));
        card.querySelector(".wf-del").addEventListener("click", () => {
          wf.steps.splice(i, 1);
          renderSteps();
        });
        ui.steps.appendChild(card);
      });
      renderRerunStep();
    }
    // ---- completing a prompt you've written before -------------------------
    // Prompts recur across steps and across workflows, and retyping one is a
    // chance to get it subtly different from the version that works. Every
    // prompt already written is offered back as you type the start of it.
    //
    // Enter accepts — and ONLY when something is being offered, so Enter is an
    // ordinary newline the rest of the time. Escape dismisses until the next
    // keystroke; the arrows pick among candidates when there's more than one.
    let promptsKnown = []; // {text, uses}, rebuilt whenever the pool can have changed

    function refreshPromptPool() {
      storageGet(WORKFLOWS_KEY).then((r) => {
        const all = (r && r[WORKFLOWS_KEY]) || [];
        // Every workflow's steps, plus the ones open in this editor — a prompt
        // written a moment ago in step 2 is exactly what step 4 wants.
        promptsKnown = W.promptPool(all, (wf && wf.steps) || []);
      });
    }

    function wirePromptComplete(input, bar, step) {
      let list = [];
      let at = 0;
      let dismissed = false;

      const textEl = bar.querySelector(".cumwf-ac-text");
      const moreEl = bar.querySelector(".cumwf-ac-more");

      function hide() {
        bar.hidden = true;
        list = [];
        at = 0;
      }

      function show() {
        const s = list[at];
        if (!s) return hide();
        // One line of it, so the bar stays a bar. The count says how much more
        // is coming, which is the thing you'd want to know before accepting.
        const lines = s.text.split("\n");
        textEl.textContent = lines[0].slice(0, 120) + (lines[0].length > 120 ? "…" : "");
        moreEl.textContent =
          (lines.length > 1 ? lines.length + " lines" : s.text.length + " chars") +
          (list.length > 1 ? " · " + (at + 1) + "/" + list.length + " ↑↓" : "");
        bar.hidden = false;
      }

      function offer() {
        if (dismissed) return hide();
        // Only while typing at the END of the box: completing what's in front of
        // a caret parked in the middle would rewrite the rest of the prompt.
        if (input.selectionStart !== input.value.length) return hide();
        list = W.promptSuggestions(promptsKnown, input.value, 5).filter(
          (s) => s.text !== input.value
        );
        at = 0;
        list.length ? show() : hide();
      }

      function accept() {
        const s = list[at];
        if (!s) return;
        input.value = s.text;
        step.prompt = s.text;
        try {
          input.setSelectionRange(s.text.length, s.text.length);
        } catch (e) {
          /* ignore */
        }
        hide();
      }

      input.addEventListener("input", function () {
        step.prompt = this.value;
        dismissed = false;
        offer();
      });
      input.addEventListener("click", offer);
      input.addEventListener("blur", () => setTimeout(hide, 120)); // let a click land
      input.addEventListener("keydown", (e) => {
        if (bar.hidden) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          return accept();
        }
        if (e.key === "Escape") {
          dismissed = true;
          return hide();
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          at = (at + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
          show();
        }
      });
      bar.addEventListener("mousedown", (e) => {
        e.preventDefault(); // don't blur the box out from under the click
        accept();
        input.focus();
      });
    }

    // The step a re-run starts at, rebuilt whenever the steps change — the
    // choice is an index into a list the editor is busy rewriting.
    function renderRerunStep(want) {
      if (!ui.rrStep) return;
      const at = typeof want === "number" ? want : parseInt(ui.rrStep.value, 10) || 0;
      const steps = wf && wf.steps ? wf.steps : [];
      ui.rrStep.innerHTML = steps
        .map((s, i) => {
          const chat = (wf.chats || []).find((c) => c.id === s.chatId);
          return `<option value="${i}">Step ${i + 1} — ${esc((chat && chat.name) || "?")}</option>`;
        })
        .join("");
      ui.rrStep.value = String(Math.min(Math.max(0, at), Math.max(0, steps.length - 1)));
    }

    ui.rerun.addEventListener("change", () => {
      ui.rerunRow.hidden = !ui.rerun.checked;
      if (ui.rerun.checked) renderRerunStep();
    });

    // One notch at a time, for a small correction or a keyboard. Both this and
    // dragging end up in reorderSteps, which is where the rule that the first
    // step can't carry anything lives.
    function moveStep(i, delta) {
      const j = i + delta;
      if (j < 0 || j >= wf.steps.length) return;
      const order = wf.steps.map((s) => s.id);
      order.splice(j, 0, order.splice(i, 1)[0]);
      wf.steps = W.reorderSteps(wf.steps, order);
      renderSteps();
    }

    // ---- dragging a step ---------------------------------------------------
    // Nine steps is enough that moving one from the end to the middle is six
    // clicks of an arrow, each one re-rendering under the cursor. Dragging is
    // the direct version; the arrows stay for a one-notch nudge.
    //
    // Nothing is moved until the drop: the card the pointer is over is marked
    // instead, so the list doesn't rearrange itself while you're still looking
    // for the gap you want.
    let dragCard = null;
    let dropBefore = null; // the card it would land above; null means the end

    function clearDropMarks() {
      ui.steps.classList.remove("cumwf-drop-end");
      for (const c of ui.steps.querySelectorAll(".cumwf-drop-before"))
        c.classList.remove("cumwf-drop-before");
    }

    function markDrop(y) {
      const cards = Array.from(ui.steps.querySelectorAll(".cumwf-card"));
      dropBefore = null;
      for (const c of cards) {
        if (c === dragCard) continue;
        const r = c.getBoundingClientRect();
        if (y < r.top + r.height / 2) {
          dropBefore = c;
          break;
        }
      }
      clearDropMarks();
      if (dropBefore) dropBefore.classList.add("cumwf-drop-before");
      else if (cards.length) ui.steps.classList.add("cumwf-drop-end");
    }

    function wireStepDrag(card) {
      const grip = card.querySelector(".cumwf-grip");
      // Only draggable while the grip is held. Otherwise the browser would take
      // over selecting text in the prompt below it.
      grip.addEventListener("mousedown", () => (card.draggable = true));
      grip.addEventListener("mouseup", () => (card.draggable = false));
      card.addEventListener("dragstart", (e) => {
        dragCard = card;
        card.classList.add("cumwf-dragging");
        try {
          e.dataTransfer.effectAllowed = "move";
          // Firefox refuses to start a drag without payload; the id is only a
          // formality since both ends are this list.
          e.dataTransfer.setData("text/plain", card.getAttribute("data-step-id") || "");
        } catch (err) {
          /* ignore */
        }
      });
      card.addEventListener("dragend", () => {
        card.draggable = false;
        card.classList.remove("cumwf-dragging");
        clearDropMarks();
        dragCard = null;
        dropBefore = null;
      });
    }

    ui.steps.addEventListener("dragover", (e) => {
      if (!dragCard) return;
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = "move";
      } catch (err) {
        /* ignore */
      }
      markDrop(e.clientY);
    });
    ui.steps.addEventListener("dragleave", (e) => {
      // Only when the pointer has actually left the list, not on the way
      // between two cards inside it.
      if (dragCard && !ui.steps.contains(e.relatedTarget)) clearDropMarks();
    });
    ui.steps.addEventListener("drop", (e) => {
      if (!dragCard) return;
      e.preventDefault();
      const moving = dragCard.getAttribute("data-step-id");
      const landsAbove = dropBefore ? dropBefore.getAttribute("data-step-id") : null;
      const order = [];
      for (const s of wf.steps) {
        if (String(s.id) === moving) continue;
        if (landsAbove != null && String(s.id) === landsAbove) order.push(moving);
        order.push(s.id);
      }
      if (landsAbove == null) order.push(moving);
      wf.steps = W.reorderSteps(wf.steps, order);
      clearDropMarks();
      dragCard = null;
      dropBefore = null;
      renderSteps();
    });
    // A new step, taking its chat from the one it will follow: alternating is
    // what a back-and-forth workflow does, and a step added in the middle
    // belongs to the same alternation as one added at the end.
    function newStepAfter(index) {
      const prev = index >= 0 ? wf.steps[index] : null;
      const nextChat =
        wf.chats.length > 1 && prev
          ? wf.chats[(wf.chats.findIndex((c) => c.id === prev.chatId) + 1) % wf.chats.length].id
          : (wf.chats[0] || {}).id;
      return W.newStep({ chatId: nextChat, prompt: "", carry: index >= 0 }, uuid());
    }

    // Insert at a position rather than only at the end. Building a workflow is
    // mostly realising a step is missing between two you already have, and
    // adding it at the bottom and dragging it up five places is the same act
    // with more steps in it.
    function insertStep(at) {
      let where = Math.max(0, Math.min(at, wf.steps.length));
      // "Below this one", pressed on a step that runs alongside others, means
      // below all of them — a step dropped into the middle of a wave would
      // split it, which is not what the button says it does.
      const wave = where > 0 ? W.waveOf(wf.steps, where - 1) : null;
      if (wave && wave.members.length > 1) where = wave.members[wave.members.length - 1] + 1;
      wf.steps.splice(where, 0, newStepAfter(where - 1));
      renderSteps();
      // Straight into the empty prompt, since writing it is the next thing.
      focusStep(where);
    }

    // A step that runs AT THE SAME TIME as this one: same hand-off in, its own
    // chat, and whatever follows the pair reads both replies. Three
    // devil's-advocate reports at once instead of one after another.
    function insertParallel(i) {
      const wave = W.waveOf(wf.steps, i) || { members: [i] };
      const start = wave.members[0];
      const end = wave.members[wave.members.length - 1];
      // A wave needs an id, and a step that didn't have one gets it now — this
      // is the moment it stopped being on its own.
      const group = wf.steps[start].group || "wave-" + uuid();
      for (const m of wave.members) wf.steps[m].group = group;

      // Its own chat. Steps running at once cannot share a conversation: they
      // would post into it together and each would read the other's answer as
      // its own. Take a chat the wave isn't already using, and add one if there
      // isn't one to take.
      const used = wave.members.map((m) => wf.steps[m].chatId);
      let free = (wf.chats || []).find((c) => used.indexOf(c.id) === -1);
      if (!free && wf.chats.length < W.MAX_CHATS) {
        wf = W.setChatCount(wf, wf.chats.length + 1, uuid);
        ui.count.value = wf.chats.length;
        free = wf.chats[wf.chats.length - 1];
        renderChats();
        renderDocs();
      }
      wf.steps.splice(
        end + 1,
        0,
        W.newStep(
          {
            chatId: (free || wf.chats[wf.chats.length - 1] || {}).id,
            prompt: wf.steps[i].prompt,
            carry: start > 0,
            carryLabel: wf.steps[start].carryLabel,
            model: wf.steps[i].model,
            group: group,
          },
          uuid()
        )
      );
      renderSteps();
      focusStep(end + 1);
    }

    // Out of the wave, back to being an ordinary step — running after the ones
    // it used to run beside.
    function leaveWave(i) {
      wf.steps[i] = Object.assign({}, wf.steps[i], { group: null });
      // A wave of one is not a wave: the last two members left in it stop being
      // parallel as well, and leaving the id on them would be a lie the moment
      // a third step was added below.
      const wave = W.waveOf(wf.steps, i === 0 ? 0 : i - 1);
      if (wave && wave.members.length === 1) wf.steps[wave.members[0]].group = null;
      renderSteps();
    }

    // Bring a new step into view — and DON'T put the cursor in it. Taking focus
    // moves it out of whatever box you were in, which is a change you didn't
    // ask for in return for a keystroke you'd have made anyway.
    function focusStep(at) {
      const card = ui.steps.children[at];
      if (!card) return;
      try {
        card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } catch (e) {
        /* ignore */
      }
    }

    ui.addStep.addEventListener("click", () => insertStep(wf.steps.length));
    if (ui.addPause)
      ui.addPause.addEventListener("click", () => {
        wf.steps.push(W.newStep({ kind: "pause", pauseMinutes: 0 }, uuid()));
        renderSteps();
      });

    // ---- open / close ----------------------------------------------------
    // Which of the two things is open. A workflow and a run are edited by the
    // same form, and nearly every difference between them comes back to this:
    // the template owns its name and what it does, the run owns the matter's
    // name and the matter's papers, and neither should be offered the other's.
    let editingRun = false;

    function applyMode() {
      // The template's own name, and the one line saying what it does. Both are
      // the workflow's: a run is one use of it, not a place to rename or
      // redescribe it.
      if (ui.tmplRow) ui.tmplRow.hidden = editingRun;
      if (ui.descRow) ui.descRow.hidden = editingRun;
      // The matter's name, and the matter's papers. Both are the run's: a
      // template carrying either would hand the last matter's name and the last
      // matter's exhibits to the next one.
      if (ui.nameRow) ui.nameRow.hidden = !editingRun;
      if (ui.docsRow) ui.docsRow.hidden = !editingRun;
      // The key and the date are the matter's, exactly as the papers are.
      if (ui.pseudoRow) ui.pseudoRow.hidden = !editingRun;
      if (ui.dateRow) ui.dateRow.hidden = !editingRun;
    }

    // The popup's stored key library — read fresh each open, so a key loaded a
    // moment ago is already offered.
    function loadPseudoKeys() {
      if (!ui.pseudo) return;
      try {
        chrome.storage.local.get("cum_pseudo_keys", (res) => {
          const keys = (res && res.cum_pseudo_keys) || {};
          ui.pseudo.innerHTML = "";
          const none = document.createElement("option");
          none.value = "";
          none.textContent = "None";
          ui.pseudo.appendChild(none);
          // The last few, newest first — plus the key this run already carries,
          // whatever its age. The library never evicts, and a run editor
          // offering every case ever loaded is a list you scroll rather than
          // one you choose from.
          const P0 = window.CUMPseudo;
          const offered = P0 && P0.recentKeys
            ? P0.recentKeys(keys, { keep: (wf && wf.pseudoKeyId) || "" })
            : Object.keys(keys);
          for (const id of offered) {
            const opt = document.createElement("option");
            opt.value = id;
            // Called what the popup and the in-chat badge call it: the case
            // FOLDER it was picked from where there is one, the case hint
            // where there isn't. Every key file is named pseudonym_key.xlsx,
            // and a list of that name three times over says nothing.
            const P = window.CUMPseudo;
            opt.textContent =
              P && P.keyLabel
                ? P.keyLabel(keys[id])
                : (keys[id].name || id) + " · " + (keys[id].rows || 0) + " rows";
            ui.pseudo.appendChild(opt);
          }
          const hidden = P0 && P0.hiddenKeyCount ? P0.hiddenKeyCount(keys, offered) : 0;
          if (hidden) {
            const more = document.createElement("option");
            more.disabled = true;
            more.textContent =
              "… " + hidden + " older " + (hidden === 1 ? "key" : "keys") + " not shown";
            ui.pseudo.appendChild(more);
          }
          ui.pseudo.value = (wf && wf.pseudoKeyId) || "";
          if (ui.pseudo.value !== ((wf && wf.pseudoKeyId) || ""))
            ui.pseudo.value = ""; // the stored key is gone; don't pretend
        });
      } catch (e) {
        /* the picker just stays at None */
      }
    }

    function open(workflow) {
      wf = workflow;
      editingRun = false;
      originalDocIds = (wf.docs || []).map((d) => d.id);
      pendingFiles.clear();
      loadPseudoKeys();
      ui.template.value = wf.templateName || wf.name || "";
      // Only show a run name when one has actually been set — a template at
      // rest carries its own name in both fields, and echoing it here would
      // read as "this run is called the same as the template". The name box
      // shows the MATTER alone: the date label lives in its own box, and
      // echoing it here would double it on save.
      ui.name.value =
        wf.name && wf.name !== ui.template.value ? W.runBaseName(wf.name) : "";
      if (ui.date) {
        ui.date.value = wf.runDate ? W.runDateLabel(wf.runDate) : "";
        if (ui.dateNative) ui.dateNative.value = wf.runDate || "";
      }
      ui.desc.value = wf.description || "";
      applyMode();
      ui.bundle.checked = !!wf.bundleText;
      ui.nameChats.checked = wf.nameChats !== false;
      ui.rerun.checked = !!wf.allowRerun;
      ui.ignoreOutage.checked = !!wf.ignoreOutage;
      if (ui.newWindow) ui.newWindow.checked = !!wf.newWindow;
      const rr = W.rerunDefaults(wf.rerun);
      ui.rrFresh.checked = rr.freshChats;
      ui.rrCarry.checked = rr.carryFinal;
      ui.rrDocs.checked = rr.reuseDocs;
      ui.rerunRow.hidden = !ui.rerun.checked;
      renderRerunStep(rr.stepIndex);
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
      // Everything already written, so a prompt repeated from another workflow
      // is offered from the first keystroke rather than after the first save.
      refreshPromptPool();
      ui.name.focus();
    }

    function close() {
      el.hidden = true;
      wf = null;
      runSink = null;
      if (ui.tmplRow) ui.tmplRow.hidden = false;
      if (ui.whenRow) ui.whenRow.hidden = true;
      ui.name.placeholder = "e.g. Demurrer — Smith v. Jones";
      ui.save.textContent = "Save workflow";
      pendingFiles.clear();
      if (typeof opts.onClosed === "function") opts.onClosed();
    }

    // One gesture can be worth two sentences — a folder's files landed AND the
    // key sitting beside them was recognised, which arrives a moment later
    // because the spreadsheet has to be parsed first. The later line used to
    // overwrite the earlier one, so the folder went unreported in exactly the
    // drop it was written for. While a line is still up, a line of the same
    // kind JOINS it; an error still replaces a success outright.
    function flash(text, err) {
      const live = !ui.status.hidden && !!ui.status.textContent;
      const joins = live && ui.status.classList.contains("err") === !!err;
      const both = joins ? ui.status.textContent + " " + text : text;
      ui.status.textContent = both.length > 300 ? text : both;
      ui.status.hidden = false;
      ui.status.classList.toggle("err", !!err);
      // On the function so it hoists with it — flash is called from handlers
      // wired above the place it is written.
      if (flash.timer) clearTimeout(flash.timer);
      flash.timer = setTimeout(() => (ui.status.hidden = true), joins ? 4200 : 2600);
    }

    function showProblems(list) {
      ui.problems.innerHTML = list.map((p) => `<li>${esc(p)}</li>`).join("");
      ui.problems.hidden = !list.length;
    }

    ui.cancel.addEventListener("click", close);

    // The trigger chosen at the bottom of a run's editor, or null when the row
    // isn't showing (a workflow, or a run already under way). `false` means the
    // operator asked for a time that has been and gone.
    function readTrigger() {
      if (!ui.whenRow || ui.whenRow.hidden) return null;
      const when = ui.when.value;
      if (when === "draft") return { type: "draft" };
      if (when !== "time") return { type: when === "reset" ? "reset" : "now" };
      const raw = ui.at.value;
      const at = raw ? new Date(raw).getTime() : NaN;
      if (!Number.isFinite(at) || at <= Date.now()) return false;
      return { type: "time", at: at };
    }

    function syncWhen() {
      const when = ui.when.value;
      ui.at.disabled = when !== "time";
      if (when === "time" && !ui.at.value) {
        const d = new Date(Date.now() + 3600000 - new Date().getTimezoneOffset() * 60000);
        ui.at.value = d.toISOString().slice(0, 16);
      }
      ui.whenHint.textContent =
        when === "draft"
          ? "It stays at the top of the runs list, doing nothing, until you come back and start it."
          : when === "now"
          ? "It opens its own window and begins as soon as you save — this is what a run does unless " +
            "you say otherwise here. With no documents ticked for a chat, it asks first."
          : when === "reset"
          ? "It waits for your next 5-hour usage reset, then begins."
          : "It waits for the time above, then begins.";
    }
    // The button says what pressing it does, because with "Run now" standing
    // by default "Save changes to this run" would be understating it.
    function syncSaveLabel() {
      if (!editingRun) return;
      const armed = ui.whenRow && !ui.whenRow.hidden && ui.when.value !== "draft";
      ui.save.textContent = armed ? "Save and start this run" : "Save changes to this run";
    }

    ui.when.addEventListener("change", () => {
      syncWhen();
      syncSaveLabel();
    });

    ui.save.addEventListener("click", async () => {
      if (!wf) return;
      // The workflow's own name is the durable one; the run name is this
      // matter's, and a template sitting idle simply wears its own.
      // Each editor writes only its own name. A template's two names are the
      // same name — it wears its own until a run borrows it — and a run's
      // template name is history, not a field: renaming the workflow from
      // inside one of its runs would rename it for every other matter.
      if (editingRun) {
        wf.name = ui.name.value.trim() || wf.name;
      } else {
        const template = ui.template.value.trim() || wf.templateName || wf.name;
        wf.templateName = template;
        wf.name = template;
        wf.description = ui.desc.value;
      }
      wf.bundleText = ui.bundle.checked;
      wf.nameChats = ui.nameChats.checked;
      wf.allowRerun = ui.rerun.checked;
      wf.ignoreOutage = ui.ignoreOutage.checked;
      if (ui.newWindow) wf.newWindow = ui.newWindow.checked;
      wf.rerun = {
        stepIndex: parseInt(ui.rrStep.value, 10) || 0,
        freshChats: ui.rrFresh.checked,
        carryFinal: ui.rrCarry.checked,
        reuseDocs: ui.rrDocs.checked,
      };
      if (ui.pseudo) wf.pseudoKeyId = ui.pseudo.value || null;
      // The date box: empty is no date; anything else must BE a date, or the
      // save says so out loud rather than quietly leaving it off the name.
      if (ui.date && !ui.dateRow.hidden) {
        const dateText = ui.date.value.trim();
        const runDateIso = dateText ? W.parseRunDate(dateText) : null;
        if (dateText && !runDateIso)
          return flash("Run date should be mm/dd/yy (e.g. 8/12/26).", true);
        wf.runDate = runDateIso;
      }
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
          const trigger = readTrigger();
          if (trigger === false) return flash("Pick a time in the future.", true);
          flash("Saved.");
          close();
          sink(candidate, trigger);
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
              // The run's own copies of the switches, not the template's
              // defaults — this editor writes every one of them back, so
              // opening it with defaults would quietly undo the run's answers.
              bundleText: run.bundleText,
              nameChats: run.nameChats,
              allowRerun: run.allowRerun,
              rerun: run.rerun,
              ignoreOutage: run.ignoreOutage,
              // Its own window is the run's answer too — the editor writes this
              // box back on save, so opening with the template's default would
              // quietly turn a run's own window off.
              newWindow: run.newWindow,
              pseudoKeyId: run.pseudoKeyId,
              runDate: run.runDate,
            },
            run.id,
            Date.now()
          )
        );
        editingRun = true;
        applyMode();
        ui.name.value = run.name || "";
        // The workflow it came from, named where the template's own name would
        // be — a run keeps that association even after the template is renamed
        // or deleted, but it isn't the run's name and can't be edited here.
        const from = W.runLabel(run).template;
        ui.name.placeholder = from
          ? "What this matter is — from “" + from + "”"
          : "What this matter is — e.g. Demurrer — Smith v. Jones";
        // Its trigger, but only while it still has one to give. Once a run has
        // started, when it started is history.
        const armable = W.canRetrigger(run);
        ui.whenRow.hidden = !armable;
        if (armable) {
          const t = run.trigger || {};
          // Opens on "Run now" unless this run is keeping an arrangement of its
          // own (a time, the next usage reset) — W.editorTriggerType owns that
          // decision. Saving a run you have just set up is what starts it; the
          // select is right there for the matter that shouldn't go yet.
          ui.when.value = W.editorTriggerType(run);
          if (t.type === "time" && typeof t.at === "number") {
            const d = new Date(t.at - new Date(t.at).getTimezoneOffset() * 60000);
            ui.at.value = d.toISOString().slice(0, 16);
          }
          syncWhen();
        }
        syncSaveLabel();
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
