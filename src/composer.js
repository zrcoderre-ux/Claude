/**
 * Claude Usage Meter — claude.ai composer driver (ISOLATED world content script).
 *
 * Everything that touches claude.ai's own composer DOM lives here: finding the
 * editor, the file input and the send control, attaching files and waiting for
 * their uploads, typing a prompt, picking a model or a Claude Code repo, and
 * confirming the message actually went out.
 *
 * It is shared by the scheduled-send runner (src/scheduler-run.js) and the
 * workflow runner (src/workflow-run.js). claude.ai's markup is unversioned, so
 * having ONE place to fix when it changes matters more than the indirection
 * costs — a second copy of these selectors would be a second thing to miss.
 *
 * Selectors were confirmed against the live composer. Regular chat tags most
 * things with data-testid; Claude Code on the web uses a bare tiptap editor,
 * untagged file inputs and aria-label="Send", so every finder falls back.
 */
(function (root) {
  "use strict";

  const CHANNEL = "CLAUDE_USAGE_METER";
  const MODELS_KEY = "cum_models";
  const REPOS_KEY = "cum_repos";
  const SEL = {
    fileInput: 'input[data-testid="file-upload"]',
    editor: 'div[data-testid="chat-input"]',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isCodePage = () => /^\/code(\/|$)/.test(location.pathname);

  // Deliberately NOT offsetParent: that is null for any position:fixed element,
  // and claude.ai's composer bar — Stop button included — is fixed. Reading the
  // Stop control as absent means reading a turn that is still generating as
  // finished, which is how a workflow steps on its own reply.
  function isVisible(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = window.getComputedStyle(el);
      if (!cs) return true;
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      return Number(cs.opacity) !== 0;
    } catch (e) {
      return true; // can't tell — assume it's there rather than ignore it
    }
  }
  // Skip elements that belong to our own injected UI so we never drive them by
  // accident.
  function isOurs(el) {
    if (!el) return false;
    if (el.closest && el.closest(".cumjf-form")) return true;
    const cls = el.className ? String(el.className) : "";
    if (cls.indexOf("cumjf") === 0 || cls.indexOf(" cumjf") !== -1) return true;
    if (cls.indexOf("cumwf") === 0 || cls.indexOf(" cumwf") !== -1) return true;
    const id = el.id || "";
    return id.indexOf("cum-") === 0;
  }
  function pick(nodeList) {
    for (const el of nodeList) if (!isOurs(el)) return el;
    return null;
  }

  // The prompt editor. Regular chat tags it data-testid="chat-input"; Claude
  // Code uses a bare tiptap/ProseMirror div (placeholder "Prompt").
  function findEditor() {
    const tagged = document.querySelector(SEL.editor);
    if (tagged) return tagged;
    const cands = document.querySelectorAll(
      'div.ProseMirror[contenteditable="true"], .tiptap[contenteditable="true"]'
    );
    for (const el of cands) if (isVisible(el) && !isOurs(el)) return el;
    return null;
  }

  // The composer file input. Regular chat tags it data-testid="file-upload";
  // Claude Code uses an untagged hidden multiple file input.
  function findFileInput() {
    const tagged = document.querySelector(SEL.fileInput);
    if (tagged) return tagged;
    return (
      pick(document.querySelectorAll('input[type="file"][multiple]')) ||
      pick(document.querySelectorAll('input[type="file"]'))
    );
  }

  // The send control (resilient to label differences: "Send message" on regular
  // chat, "Send" on Claude Code).
  function findSend() {
    return (
      pick(document.querySelectorAll('button[aria-label="Send message"]')) ||
      pick(document.querySelectorAll('button[aria-label="Send Message"]')) ||
      pick(document.querySelectorAll('button[aria-label*="Send message" i]')) ||
      pick(document.querySelectorAll('[data-testid="send-button"]')) ||
      pick(document.querySelectorAll('button[aria-label="Send"]')) ||
      pick(document.querySelectorAll('button[type="submit"][aria-label*="send" i]')) ||
      null
    );
  }

  // Claude is mid-turn when a Stop control is on screen.
  function isGenerating() {
    const stop =
      document.querySelector('button[aria-label*="Stop" i]') ||
      document.querySelector('[data-testid="stop-button"]');
    return !!(stop && isVisible(stop));
  }

  function waitFor(finder, timeoutMs) {
    const get = typeof finder === "function" ? finder : () => document.querySelector(finder);
    return new Promise((resolve) => {
      const deadline = Date.now() + (timeoutMs || 20000);
      (function poll() {
        let el = null;
        try {
          el = get();
        } catch (e) {
          el = null;
        }
        if (el) return resolve(el);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(poll, 200);
      })();
    });
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  function dataUrlToFile(dataUrl, name, type) {
    const comma = dataUrl.indexOf(",");
    const meta = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    const isB64 = /;base64/i.test(meta);
    let bytes;
    if (isB64) {
      const bin = atob(body);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }
    return new File([bytes], name, { type: type || "application/octet-stream" });
  }

  // Rebuild the stored File objects for a list of { id, name, type } descriptors.
  // Returns { files, missing } — a missing blob is fatal to the caller, never
  // something to send half of.
  async function filesFromStorage(descriptors) {
    const list = descriptors || [];
    if (!list.length) return { files: [], missing: null };
    const blobs = await storageGet(list.map((f) => "cum_file_" + f.id));
    const files = [];
    for (const f of list) {
      const dataUrl = blobs["cum_file_" + f.id];
      if (!dataUrl) return { files: [], missing: f.name || f.id };
      files.push(dataUrlToFile(dataUrl, f.name, f.type));
    }
    return { files, missing: null };
  }

  function setFiles(input, files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Fire a realistic pointer+mouse+click sequence — claude's send button is a
  // custom (data-cds) button that may not respond to a bare .click().
  function robustClick(el) {
    const r = el.getBoundingClientRect();
    const p = {
      bubbles: true, cancelable: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    const fire = (Ctor, type, extra) => {
      try {
        el.dispatchEvent(new Ctor(type, Object.assign({ pointerId: 1, isPrimary: true }, p, extra)));
      } catch (e) {
        /* ignore */
      }
    };
    // A single synthetic gesture — a pointer/mouse sequence ending in one click.
    // We deliberately do NOT also call el.click(), to avoid double-submitting.
    fire(PointerEvent, "pointerdown");
    fire(MouseEvent, "mousedown");
    fire(PointerEvent, "pointerup");
    fire(MouseEvent, "mouseup");
    fire(MouseEvent, "click");
  }

  function sendDisabled(btn) {
    return !btn || btn.disabled || btn.getAttribute("aria-disabled") === "true";
  }

  async function waitSendEnabled(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 12000);
    while (Date.now() < deadline) {
      const btn = findSend();
      if (btn && !sendDisabled(btn)) return btn;
      await sleep(300);
    }
    return findSend();
  }

  // After clicking, confirm the message actually went out: the composer clears,
  // the send control disables/disappears, or we navigate into a conversation.
  async function confirmSent(editorTextBefore) {
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const btn = findSend();
      const ed = findEditor();
      const edText = ed ? (ed.textContent || "").trim() : "";
      if (!btn || sendDisabled(btn)) return true;
      if (editorTextBefore && edText === "") return true;
      if (/\/chat\//.test(location.pathname)) return true;
    }
    return false;
  }

  function insertPrompt(editor, text) {
    if (!text) return;
    editor.focus();
    // ProseMirror handles the input/beforeinput that execCommand generates.
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch (e) {
      ok = false;
    }
    if (!ok || !(editor.textContent || "").includes(text.slice(0, 8))) {
      // Fallback: synthesize a paste of plain text.
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        editor.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })
        );
      } catch (e) {
        /* ignore */
      }
    }
  }

  // The composer's own container — the scope attachment chips live in. Counting
  // page-wide is not safe: on a PROJECT page the project's knowledge files
  // render as buttons with headings, so "enough chips are showing" can be true
  // before a single file has been attached, and the prompt then sends with
  // nothing on it.
  function composerScope() {
    const ed = findEditor();
    if (!ed) return document;
    return (
      ed.closest("form") ||
      ed.closest('[class*="composer" i]') ||
      (ed.parentElement && ed.parentElement.parentElement) ||
      document
    );
  }

  // How many attachment chips the composer is showing. The markup is
  // unversioned, so take the best of several shapes rather than trusting one.
  function countChips() {
    const root = composerScope();
    const counts = [
      root.querySelectorAll("button h3").length,
      root.querySelectorAll('[data-testid="file-thumbnail"]').length,
      root.querySelectorAll('[data-testid*="attachment" i]').length,
      root.querySelectorAll('[data-testid*="file-chip" i]').length,
    ];
    return Math.max.apply(null, counts);
  }

  // Chips are the WEAKER signal and must never be the fast path. The upload
  // responses reported by inject.js are the real confirmation; a chip count is
  // only consulted after this much time has passed, so a page that already
  // happens to show matching markup can't wave the attachment through in the
  // first 400ms — which is exactly how a message goes out with nothing on it.
  const CHIP_GRACE_MS = 8000;

  // Wait until `expected` uploads have reported success (via inject.js), or —
  // after the grace period — that many NEW attachment chips are showing.
  // Resolves { ok, uploads, chips } so a caller can say WHY it gave up: an
  // upload that silently doesn't happen is the failure mode that matters here.
  function waitUploads(expected, timeoutMs) {
    return new Promise((resolve) => {
      if (expected <= 0) return resolve({ ok: true, uploads: 0, chips: 0 });
      const baseChips = countChips(); // this composer may already show some
      const startedAt = Date.now();
      let done = 0;
      const deadline = startedAt + (timeoutMs || 120000);
      function onMsg(event) {
        if (event.source !== window) return;
        const m = event.data;
        if (m && m.__channel === CHANNEL && m.payload && m.payload.upload) {
          if (m.payload.upload.success) done++;
          if (done >= expected) finish(true);
        }
      }
      window.addEventListener("message", onMsg);
      const timer = setInterval(() => {
        const chips = countChips() - baseChips;
        if (done >= expected) return finish(true);
        if (chips >= expected && Date.now() - startedAt >= CHIP_GRACE_MS) return finish(true);
        // Out of time. ALL of them or none: "some uploaded" was accepted here,
        // which is how a message goes out with twelve of twenty papers on it
        // and Claude answers from the twelve without either of us knowing.
        if (Date.now() > deadline) return finish(done >= expected || chips >= expected);
      }, 400);
      function finish(ok) {
        clearInterval(timer);
        window.removeEventListener("message", onMsg);
        resolve({ ok, uploads: done, chips: Math.max(0, countChips() - baseChips) });
      }
    });
  }

  // Where a file drop lands: the composer's own form/container, falling back to
  // the page. claude.ai accepts dropped files as well as picked ones, which is
  // the second way in when the hidden input can't be found or React ignores it.
  function findDropTarget() {
    const scope = composerScope();
    if (scope && scope !== document) return scope;
    return findEditor() || document.body;
  }

  function dropFiles(el, files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    for (const type of ["dragenter", "dragover", "drop"]) {
      try {
        const ev = new DragEvent(type, Object.assign({ dataTransfer: dt }, base));
        el.dispatchEvent(ev);
      } catch (e) {
        /* ignore */
      }
    }
  }

  // Attach `files` to the composer and wait for them to land. Tries the hidden
  // file input first, then a synthesized drop. Returns { ok, how, detail } —
  // `detail` names what was actually observed, so a failure can say more than
  // "uploads did not complete".
  // Twenty papers need more than two minutes. The ceiling scales with how many
  // are going up, so a big matter isn't cut off by a limit set for a small one.
  function uploadDeadline(count, given) {
    return Math.max(given || 120000, (count || 0) * 15000);
  }

  async function attachFiles(files, timeoutMs) {
    const baseChips = countChips(); // before anything is attached
    const input = findFileInput();
    let how = null;
    let res = { ok: false, uploads: 0, chips: 0 };
    if (input) {
      setFiles(input, files);
      how = "file input";
      res = await waitUploads(files.length, uploadDeadline(files.length, timeoutMs));
    }
    if (!res.ok) {
      // Second way in: drop them on the composer.
      const target = findDropTarget();
      if (target) {
        dropFiles(target, files);
        how = how ? how + ", then drop" : "drop";
        res = await waitUploads(files.length, Math.min(uploadDeadline(files.length, timeoutMs), 120000));
      }
    }
    // Bounded settle: let the chips catch up with the uploads, so the send that
    // follows cannot beat the attachments onto the composer. Not fatal if the
    // chip markup never matches — the upload responses already confirmed it.
    if (res.ok) {
      const settleBy = Date.now() + 10000;
      while (countChips() - baseChips < files.length && Date.now() < settleBy) await sleep(400);
    }
    const visible = Math.max(0, countChips() - baseChips);
    const detail =
      (input ? "" : "no file input found; ") +
      res.uploads + "/" + files.length + " uploads confirmed, " + visible + " attachment(s) visible";
    return { ok: res.ok, how, detail, uploads: res.uploads, visible };
  }

  // ---- Model selection ---------------------------------------------------
  function modelNameOf(text) {
    try {
      if (root.CUMJobs && root.CUMJobs.parseModelName) return root.CUMJobs.parseModelName(text);
    } catch (e) {
      /* fall through */
    }
    const s = String(text || "").replace(/\s+/g, " ").trim();
    const m = s.match(/^((?:Fable|Opus|Sonnet|Haiku|Claude)[A-Za-z]*\s*\d+(?:\.\d+)?)/i);
    return m ? m[1].trim() : null;
  }
  const normLower = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

  // The model dropdown trigger. Regular chat tags it; Claude Code uses a bare
  // aria-haspopup="menu" button whose visible text is just a model name.
  function findModelTrigger() {
    const tagged =
      document.querySelector('button[data-testid="model-selector-dropdown"]') ||
      document.querySelector('button[aria-label^="Model:" i]');
    if (tagged && !isOurs(tagged)) return tagged;
    for (const b of document.querySelectorAll('button[aria-haspopup="menu"]')) {
      if (isOurs(b)) continue;
      if (modelNameOf(b.textContent)) return b;
    }
    return null;
  }
  function modelRadios() {
    return Array.from(document.querySelectorAll('[role="menuitemradio"]')).filter((el) => !isOurs(el));
  }
  function menuItemMatching(re) {
    for (const el of document.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')) {
      if (isOurs(el)) continue;
      if (re.test((el.textContent || "").trim())) return el;
    }
    return null;
  }

  // Merge the currently-visible model names into cum_models so the scheduler
  // picker stays live. Regular chat only — Claude Code glues a shortcut digit to
  // each row, which would corrupt the version.
  function harvestModels() {
    if (isCodePage()) return;
    const names = [];
    for (const r of modelRadios()) {
      const n = modelNameOf(r.textContent);
      if (n && names.indexOf(n) === -1) names.push(n);
    }
    if (!names.length) return;
    try {
      chrome.storage.local.get(MODELS_KEY, (res) => {
        const prev = (res && res[MODELS_KEY]) || [];
        const merged = [];
        const seen = new Set();
        for (const n of names.concat(prev)) {
          const k = n.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(n);
        }
        if (merged.length !== prev.length || merged.some((n, i) => n !== prev[i]))
          chrome.storage.local.set({ [MODELS_KEY]: merged });
      });
    } catch (e) {
      /* ignore */
    }
  }

  function closeMenu() {
    try {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape", code: "Escape" })
      );
    } catch (e) {
      /* ignore */
    }
  }

  // Pick `model` in the composer. Returns "ok" (selected or already active),
  // "unsupported" (no picker found), or "notfound" (opened but not listed).
  async function selectModel(model) {
    if (!model) return "ok";
    const want = normLower(model);
    const trigger = findModelTrigger();
    if (!trigger) return "unsupported";
    const cur = normLower((trigger.getAttribute("aria-label") || "") + " " + (trigger.textContent || ""));
    if (cur.indexOf(want) !== -1) return "ok"; // already on it

    robustClick(trigger);
    let radios = [];
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      radios = modelRadios();
      if (radios.length) break;
      await sleep(150);
    }
    harvestModels(); // whatever is visible now
    let target = radios.find((r) => normLower(r.textContent).indexOf(want) === 0);
    if (!target) {
      // Dig into "More models" once.
      const more = menuItemMatching(/more models/i);
      if (more) {
        robustClick(more);
        const dl2 = Date.now() + 3000;
        while (Date.now() < dl2 && !target) {
          radios = modelRadios();
          target = radios.find((r) => normLower(r.textContent).indexOf(want) === 0);
          if (!target) await sleep(150);
        }
      }
    }
    if (target) {
      robustClick(target);
      await sleep(350);
      closeMenu();
      return "ok";
    }
    closeMenu();
    return "notfound";
  }

  // ---- Claude Code: repo selection for a fresh session -------------------
  const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

  // The "+" / "Select repo…" control that opens the repo dialog.
  function findRepoCombobox() {
    return (
      document.querySelector('button[role="combobox"][aria-label*="repositor" i]') ||
      document.querySelector('button[aria-haspopup="dialog"][aria-label*="repositor" i]') ||
      Array.from(document.querySelectorAll('button[role="combobox"],button[aria-haspopup="dialog"]')).find(
        (b) =>
          !isOurs(b) &&
          /select repo|add repositor/i.test((b.textContent || "") + " " + (b.getAttribute("aria-label") || ""))
      ) ||
      null
    );
  }

  // Scrape the visible repo names (owner/name) for the scheduler's picker.
  function scrapeRepos() {
    const out = [];
    for (const e of document.querySelectorAll("span,div,button,a,li,[role='option']")) {
      if (e.children.length) continue; // leaf nodes only
      const t = (e.textContent || "").trim();
      if (REPO_RE.test(t) && out.indexOf(t) === -1) out.push(t);
    }
    return out.slice(0, 100);
  }
  function harvestRepos() {
    if (!isCodePage()) return;
    const repos = scrapeRepos();
    if (!repos.length) return;
    try {
      chrome.storage.local.get(REPOS_KEY, (res) => {
        const prev = (res && res[REPOS_KEY]) || [];
        const merged = prev.slice();
        for (const r of repos) if (merged.indexOf(r) === -1) merged.push(r);
        if (merged.length !== prev.length) chrome.storage.local.set({ [REPOS_KEY]: merged });
      });
    } catch (e) {
      /* ignore */
    }
  }

  // Pick `repo` (owner/name) in a fresh Claude Code session. Returns "ok",
  // "unsupported" (no picker), or "notfound" (opened but repo not listed).
  async function selectCodeRepo(repo) {
    const want = normLower(repo);
    const combo = findRepoCombobox();
    if (!combo) return "unsupported";
    if (normLower(combo.textContent).indexOf(want) !== -1) return "ok"; // already chosen
    robustClick(combo);

    // Wait for the dialog to render.
    let dlg = null;
    const dl = Date.now() + 4000;
    while (Date.now() < dl) {
      dlg = document.querySelector('[role="dialog"]');
      if (dlg) break;
      await sleep(150);
    }
    const scope = dlg || document;

    // If the dialog has a search box, type the repo to filter the list.
    const input = scope.querySelector('input:not([type="hidden"]), [contenteditable="true"]');
    if (input) {
      try {
        input.focus();
        const ok = document.execCommand && document.execCommand("insertText", false, repo);
        if (!ok && "value" in input) {
          input.value = repo;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } catch (e) {
        /* ignore */
      }
      await sleep(700);
    }

    const rowOf = () => {
      const cands = scope.querySelectorAll('[role="option"],[role="menuitem"],li,button,a,div,span');
      let starts = null;
      for (const el of cands) {
        if (isOurs(el)) continue;
        const t = normLower(el.textContent);
        if (!t) continue;
        if (t === want) return el; // exact owner/name
        if (starts == null && t.indexOf(want) === 0 && t.length - want.length < 25) starts = el;
      }
      return starts;
    };
    let target = rowOf();
    for (let i = 0; i < 12 && !target; i++) {
      await sleep(200);
      target = rowOf();
    }
    if (!target) {
      closeMenu();
      return "notfound";
    }
    robustClick(target);
    await sleep(500);
    return "ok";
  }

  // ---- one composed message, end to end ----------------------------------
  // Attach files, pick model/repo, type `text`, click Send, confirm it left.
  // Returns { ok, error?, notes: [] } — notes are best-effort problems (model
  // not available, repo picker missing) that must not stop the send.
  async function sendMessage(opts) {
    const o = opts || {};
    const notes = [];
    const files = o.files || [];

    if (files.length) await waitFor(findFileInput, 15000); // may legitimately not exist
    const editor = await waitFor(findEditor);
    if (!editor) return { ok: false, error: "prompt editor not found", notes };

    if (o.codeRepo) {
      try {
        const r = await selectCodeRepo(o.codeRepo);
        if (r === "unsupported") notes.push("repo picker not found");
        else if (r === "notfound") notes.push('repo "' + o.codeRepo + '" not in the list');
      } catch (e) {
        notes.push("repo select failed");
      }
    }
    if (o.model) {
      try {
        const r = await selectModel(o.model);
        if (r === "unsupported") notes.push("couldn't find the model picker");
        else if (r === "notfound") notes.push('model "' + o.model + '" not available');
      } catch (e) {
        notes.push("model switch failed");
      }
    }

    // Attach first, and never send without the files: a prompt that says "the
    // attached papers" arriving with nothing attached is worse than not sending
    // — Claude answers anyway, plausibly, from nothing.
    if (files.length) {
      const att = await attachFiles(files, o.uploadTimeoutMs || 120000);
      if (!att.ok)
        return {
          ok: false,
          error:
            "could not attach " + files.length + " document(s) — " + att.detail +
            (att.how ? " (tried: " + att.how + ")" : ""),
          notes,
        };
      notes.push(
        "attached " + files.length + " document(s) via " + att.how +
          " (" + att.uploads + " upload(s) confirmed)"
      );
      await sleep(600);
    }

    if (o.text) {
      insertPrompt(editor, o.text);
      await sleep(400);
    }
    if (!o.text && !files.length) return { ok: false, error: "nothing to send", notes };

    const before = ((editor && editor.textContent) || "").trim();
    const send = await waitSendEnabled(15000);
    if (send && !sendDisabled(send)) {
      robustClick(send);
      if (await confirmSent(before)) return { ok: true, notes };
    }
    // Fallback: press Enter in the editor (claude sends on Enter).
    if (editor) {
      editor.focus();
      for (const t of ["keydown", "keypress", "keyup"]) {
        try {
          editor.dispatchEvent(
            new KeyboardEvent(t, { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 })
          );
        } catch (e) {
          /* ignore */
        }
      }
      if (await confirmSent(before)) return { ok: true, notes };
    }
    if (!send) return { ok: false, error: "send button not found", notes };
    if (sendDisabled(send)) return { ok: false, error: "send button stayed disabled", notes };
    return { ok: false, error: "clicked send but message did not appear to go out", notes };
  }

  root.CUMComposer = {
    CHANNEL,
    sleep,
    isCodePage,
    isVisible,
    isOurs,
    pick,
    findEditor,
    findFileInput,
    findSend,
    isGenerating,
    waitFor,
    storageGet,
    dataUrlToFile,
    filesFromStorage,
    setFiles,
    attachFiles,
    countChips,
    dropFiles,
    robustClick,
    sendDisabled,
    waitSendEnabled,
    confirmSent,
    insertPrompt,
    waitUploads,
    selectModel,
    selectCodeRepo,
    harvestModels,
    harvestRepos,
    scrapeRepos,
    sendMessage,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
