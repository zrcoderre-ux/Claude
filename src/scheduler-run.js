/**
 * Claude Usage Meter — scheduled-send executor (ISOLATED world content script).
 *
 * Runs on claude.ai. When the background worker opens a tab to the right
 * composer (/new or /cowork/project/<uuid>) and sends "cum-run-job", this:
 *   1. reconstructs the queued File objects from stored bytes,
 *   2. sets them on the hidden file input (data-testid="file-upload"),
 *   3. waits for each upload to finish (POST .../wiggle/upload-file, reported by
 *      inject.js), with a chip-count + timeout fallback,
 *   4. types the prompt into the ProseMirror editor (data-testid="chat-input"),
 *   5. clicks Send (aria-label="Send message"),
 * then reports the result back to the worker.
 *
 * Selectors were confirmed against the live composer; SEL is the one place to
 * update them if the UI changes.
 */
(function () {
  "use strict";

  const CHANNEL = "CLAUDE_USAGE_METER";
  const JOBS_KEY = "cum_jobs";
  const MODELS_KEY = "cum_models";
  const REPOS_KEY = "cum_repos";
  const isCodePage = () => /^\/code(\/|$)/.test(location.pathname);
  // Regular claude.ai chat markup. Claude Code on the web uses different markup
  // (a bare tiptap/ProseMirror editor, untagged file inputs, aria-label="Send"),
  // so the find* helpers below fall back to it.
  const SEL = {
    fileInput: 'input[data-testid="file-upload"]',
    editor: 'div[data-testid="chat-input"]',
  };

  function isVisible(el) {
    return !!el && el.offsetParent !== null;
  }
  // Skip elements that belong to our own injected scheduling form/UI so we never
  // drive them by accident.
  function isOurs(el) {
    if (!el) return false;
    if (el.closest && el.closest(".cumjf-form")) return true;
    const cls = el.className ? String(el.className) : "";
    if (cls.indexOf("cumjf") === 0 || cls.indexOf(" cumjf") !== -1) return true;
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

  // ---- Model selection ---------------------------------------------------
  function modelNameOf(text) {
    try {
      if (window.CUMJobs && window.CUMJobs.parseModelName)
        return window.CUMJobs.parseModelName(text);
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
        (b) => !isOurs(b) && /select repo|add repositor/i.test((b.textContent || "") + " " + (b.getAttribute("aria-label") || ""))
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitFor(finder, timeoutMs) {
    const get =
      typeof finder === "function"
        ? finder
        : () => document.querySelector(finder);
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

  // Wait until `expected` uploads have reported success (via inject.js), or a
  // fallback: `expected` attachment chips are present, or we time out.
  function waitUploads(expected, timeoutMs) {
    return new Promise((resolve) => {
      if (expected <= 0) return resolve(true);
      let done = 0;
      const deadline = Date.now() + (timeoutMs || 120000);
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
        // DOM fallback: enough attachment chips rendered.
        const chips = document.querySelectorAll('button h3').length;
        if (done >= expected || chips >= expected) return finish(true);
        if (Date.now() > deadline) return finish(done > 0 || chips > 0);
      }, 400);
      function finish(ok) {
        clearInterval(timer);
        window.removeEventListener("message", onMsg);
        resolve(ok);
      }
    });
  }

  async function runJob(jobId) {
    const store = await storageGet([JOBS_KEY]);
    const jobs = store[JOBS_KEY] || [];
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return { ok: false, error: "job not found" };

    // 1. Load file bytes and rebuild File objects.
    const files = [];
    if (job.files && job.files.length) {
      const keys = job.files.map((f) => "cum_file_" + f.id);
      const blobs = await storageGet(keys);
      for (const f of job.files) {
        const dataUrl = blobs["cum_file_" + f.id];
        if (!dataUrl) return { ok: false, error: "missing file bytes: " + f.name };
        files.push(dataUrlToFile(dataUrl, f.name, f.type));
      }
    }

    // 2. Wait for the composer to render.
    const input = files.length ? await waitFor(findFileInput) : null;
    const editor = await waitFor(findEditor);
    if (files.length && !input) return { ok: false, error: "file input not found" };
    if (!editor) return { ok: false, error: "prompt editor not found" };

    const notes = [];

    // 2a. New Claude Code session: pick the repo via the "+" / Select repo
    // dialog before anything else.
    if (job.codeRepo) {
      try {
        const r = await selectCodeRepo(job.codeRepo);
        if (r === "unsupported") notes.push("repo picker not found");
        else if (r === "notfound") notes.push('repo "' + job.codeRepo + '" not in the list');
      } catch (e) {
        notes.push("repo select failed");
      }
    }

    // 2b. Pick the requested model (best-effort; never fatal — fall back to
    // whatever model the composer is already on).
    if (job.model) {
      try {
        const r = await selectModel(job.model);
        if (r === "unsupported") notes.push("couldn't find the model picker");
        else if (r === "notfound") notes.push('model "' + job.model + '" not available');
      } catch (e) {
        notes.push("model switch failed");
      }
    }
    const modelNote = notes.length ? notes.join("; ") : null;

    // 3. Attach + wait for uploads.
    if (files.length) {
      setFiles(input, files);
      const uploaded = await waitUploads(files.length, 120000);
      if (!uploaded) return { ok: false, error: "uploads did not complete" };
      await sleep(600);
    }

    // 4. Type the prompt.
    if (job.prompt) {
      insertPrompt(editor, job.prompt);
      await sleep(400);
    }

    // 5. Send (only if there's something to send).
    if (!job.prompt && !files.length) return { ok: false, error: "empty job" };
    const before = ((editor && editor.textContent) || "").trim();
    const send = await waitSendEnabled(15000);
    if (send && !sendDisabled(send)) {
      robustClick(send);
      if (await confirmSent(before)) return { ok: true, note: modelNote };
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
      if (await confirmSent(before)) return { ok: true, note: modelNote };
    }
    if (!send) return { ok: false, error: "send button not found" };
    if (sendDisabled(send)) return { ok: false, error: "send button stayed disabled" };
    return { ok: false, error: "clicked send but message did not appear to go out" };
  }

  // Scrape the visible project links (for the options-page picker).
  function scrapeProjects() {
    const out = [];
    document.querySelectorAll('a[href*="/project/"]').forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      const m = href.match(/\/project\/([0-9a-f-]{36})/i);
      if (!m) return;
      if (out.some((p) => p.uuid === m[1])) return;
      out.push({ uuid: m[1], href, name: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100) });
    });
    return out;
  }

  // Zero-friction: whenever the user is naturally on claude.ai and project links
  // are present (the Projects page, or the sidebar), merge them into the cached
  // list so the options picker fills in without an explicit refresh.
  function autoScrapeProjects() {
    let found;
    try {
      found = scrapeProjects();
    } catch (e) {
      return;
    }
    if (!found.length) return;
    try {
      chrome.storage.local.get("cum_projects", (res) => {
        const existing = (res && res.cum_projects) || [];
        const byId = new Map(existing.map((p) => [p.uuid, p]));
        for (const p of found) byId.set(p.uuid, p);
        chrome.storage.local.set({ cum_projects: Array.from(byId.values()) });
      });
    } catch (e) {
      /* ignore */
    }
  }
  // SPA renders late; sample a few times after load.
  setTimeout(autoScrapeProjects, 2500);
  setTimeout(autoScrapeProjects, 6000);
  setTimeout(autoScrapeProjects, 15000);

  // Keep the scheduler's model list live: whenever the user opens the model
  // menu (regular chat only), harvest the visible names. Cheap — the selector
  // matches nothing unless a menu is actually open.
  setInterval(() => {
    try {
      if (!isCodePage() && document.querySelector('[role="menuitemradio"]')) harvestModels();
    } catch (e) {
      /* ignore */
    }
  }, 2500);

  // On Claude Code pages, keep the repo list live for the scheduler picker.
  setTimeout(harvestRepos, 3000);
  setTimeout(harvestRepos, 8000);
  setInterval(() => {
    try {
      harvestRepos();
    } catch (e) {
      /* ignore */
    }
  }, 6000);

  chrome.runtime?.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "cum-run-job") {
      runJob(msg.jobId)
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true; // async response
    }
    if (msg.type === "cum-discover-projects") {
      // Ask the MAIN-world interceptor to pull the project list from the API.
      try {
        window.postMessage(
          { __channel: CHANNEL, command: { type: "discoverProjects" } },
          window.location.origin
        );
      } catch (e) {
        /* ignore */
      }
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "cum-scrape-projects") {
      const projects = scrapeProjects();
      // The grid can virtualize (only visible cards live in the DOM), so nudge
      // the scroll position before the next scrape to reveal more cards.
      try {
        const doc = document.scrollingElement || document.documentElement;
        window.scrollTo(0, (doc.scrollTop || 0) + Math.round(window.innerHeight * 0.85));
      } catch (e) {
        /* ignore */
      }
      sendResponse({ projects });
      return false;
    }
  });
})();
