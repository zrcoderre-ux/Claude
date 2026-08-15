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

  // ---- waiting, in a tab nobody is looking at -----------------------------
  //
  // Chrome throttles timers in a page that isn't on screen: after a few minutes
  // hidden, setTimeout is held to about ONE WAKE-UP A MINUTE. A run drives tabs
  // that sit deliberately behind whatever you're doing, so every wait in the
  // send path — each of them a fraction of a second — became a minute, and a
  // step looked like it was waiting for you to come and watch it.
  //
  // It used to be masked: the run's window was re-maximized before each step,
  // which raised it, which un-hid the tab. That is the focus theft that had to
  // go, and this is the half of the job that went with it.
  //
  // So a hidden page borrows the WORKER's clock. The worker is not a page and is
  // not throttled. Raced against the ordinary timer and capped, because a worker
  // restarted mid-wait would never answer and a step that hangs is worse than a
  // step that is slow.
  const WORKER_WAIT_MAX = 25000;
  const localSleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function hidden() {
    try {
      return document.visibilityState === "hidden";
    } catch (e) {
      return false;
    }
  }

  function workerSleep(ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (how) => {
        if (done) return;
        done = true;
        resolve(how);
      };
      try {
        chrome.runtime.sendMessage({ type: "cum-wait", ms: ms }, (res) => {
          // A worker that was restarted mid-wait answers with an error rather
          // than not at all. Reported, so the caller falls back to its own
          // clock instead of waking early.
          if (chrome.runtime.lastError || !res) return finish("failed");
          finish("worker");
        });
      } catch (e) {
        finish("failed");
      }
    });
  }

  async function sleep(ms) {
    let left = Math.max(0, Math.floor(ms) || 0);
    // Short waits aren't worth a message, and a visible page has a clock of its
    // own that works.
    if (left < 100 || !hidden()) return localSleep(left);
    while (left > 0) {
      const chunk = Math.min(left, WORKER_WAIT_MAX);
      const how = await Promise.race([workerSleep(chunk), localSleep(chunk).then(() => "local")]);
      if (how === "failed") await localSleep(chunk);
      left -= chunk;
    }
  }
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
    // Anything we inject into claude.ai's own furniture — the Copy-ruling
    // button sits in its action bar — carries a cum- class. An id is no use
    // there: there is one of those buttons per reply.
    if (/(^|\s)cum-/.test(cls)) return true;
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
  function findStop() {
    const stop =
      document.querySelector('button[aria-label*="Stop" i]') ||
      document.querySelector('[data-testid="stop-button"]');
    return stop && isVisible(stop) ? stop : null;
  }
  function isGenerating() {
    return !!findStop();
  }

  // End the turn that is being written. The page's own Stop control first,
  // since that is the thing that exists to do this; Escape after it, which
  // claude.ai treats the same way and which covers a Stop we failed to find.
  //
  // Worth doing rather than just walking away: an answer nobody is going to
  // read is still an answer being paid for, and a run paused because the prompt
  // was wrong is precisely when the rest of that answer is worth nothing.
  function stopGenerating() {
    let clicked = false;
    const stop = findStop();
    if (stop) {
      try {
        robustClick(stop);
        clicked = true;
      } catch (e) {
        /* fall through to Escape */
      }
    }
    try {
      const target = findEditor() || document.body;
      for (const type of ["keydown", "keyup"]) {
        target.dispatchEvent(
          new KeyboardEvent(type, {
            bubbles: true,
            cancelable: true,
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            which: 27,
          })
        );
      }
    } catch (e) {
      /* ignore */
    }
    return clicked;
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
        // Through sleep(), so this keeps polling at something like the rate it
        // asks for in a tab that isn't on screen. A throttled poll here is a
        // step waiting a minute for a composer that was already there.
        sleep(200).then(poll);
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

  // ---- opening a menu, and knowing that it opened -------------------------
  //
  // A dispatched click is untrusted, and the toggle taught what that costs on a
  // form control. Menus are the milder case — most React handlers fire on the
  // event alone — but "milder" is not "never", and a menu that failed to open
  // is indistinguishable from a menu with nothing in it: both report no items.
  // Two rounds were spent reading that ambiguity the wrong way.
  //
  // So opening is a step with its own answer. Click, look, click properly,
  // look again — and say which, because the trigger's aria-expanded and the
  // presence of items are different facts and only one of them is the question.
  function menuItems() {
    try {
      return Array.from(
        document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"]')
      ).filter((el) => !isOurs(el));
    } catch (e) {
      return [];
    }
  }

  const expanded = (el) => !!el && el.getAttribute("aria-expanded") === "true";

  /**
   * Open the menu `trigger` controls. Returns "" when it opened, or a sentence
   * saying what happened instead — never a bare boolean, since the caller's
   * whole job when this fails is to say why.
   */
  async function openMenu(trigger, was) {
    const before = (was || []).length;
    const grew = () => menuItems().length > before;
    for (const how of ["dispatched", "native"]) {
      if (how === "dispatched") robustClick(trigger);
      else {
        try {
          if (typeof trigger.click === "function") trigger.click();
        } catch (e) {
          /* the report below is the point */
        }
      }
      for (let i = 0; i < 8; i++) {
        await sleep(150);
        if (grew()) return "";
      }
      // Expanded but empty is a real state — a menu still rendering — so give
      // it a little longer before trying the harder click.
      if (expanded(trigger)) {
        for (let i = 0; i < 8; i++) {
          await sleep(200);
          if (grew()) return "";
        }
      }
    }
    return expanded(trigger)
      ? "the menu says it is open but has no items in it"
      : "the menu never opened (aria-expanded stayed " +
          JSON.stringify(trigger.getAttribute("aria-expanded") || "unset") +
          ")";
  }

  // ---- cowork: the surface, and what it's allowed to do on its own -------
  //
  // claude.ai calls the Chat/Cowork toggle a "Surface": a radiogroup of two
  // radios, sitting on the composer home and nowhere else. Choosing one is a
  // preference for the whole account rather than for this tab, which is why
  // every function here reports what it did instead of assuming.

  const K = () => root.CUMCowork || (typeof CUMCowork !== "undefined" ? CUMCowork : null);

  // Where the last selectSurface() gave up, in words. The verdict alone says a
  // piece was missing; three rounds of this have shown that which piece it was
  // is the only part anybody needs. Not acted on anywhere — it exists to be
  // read back by the panel's button.
  let lastSurfaceWhy = "";
  const surfaceWhy = () => lastSurfaceWhy;
  let lastProjectWhy = "";
  const projectWhy = () => lastProjectWhy;
  let lastRenameWhy = "";
  const renameWhy = () => lastRenameWhy;

  function findSurfaceGroup() {
    const g = document.querySelector('[role="radiogroup"][aria-label="Surface" i]');
    if (g && !isOurs(g)) return g;
    // The label is the only word in that markup that is neither choice, so it
    // is the one worth trusting; but if it changes, a radiogroup holding
    // exactly the two choices is still unmistakable.
    for (const el of document.querySelectorAll('[role="radiogroup"]')) {
      if (isOurs(el)) continue;
      const radios = Array.from(el.querySelectorAll('[role="radio"]'));
      if (radios.length !== 2) continue;
      const names = radios.map((r) => normLower(r.textContent));
      if (names.indexOf("chat") !== -1 && names.indexOf("cowork") !== -1) return el;
    }
    return null;
  }

  // The halves of the toggle. `[role="radio"]` is what the markup was first seen
  // using, but a native <input type="radio"> carries that role implicitly and
  // matches no attribute selector — so a group built the plain way would come
  // back empty, which reads as "this group has no halves" and stops the switch
  // before it clicks anything.
  function surfaceRadios() {
    const g = findSurfaceGroup();
    if (!g) return [];
    const tagged = Array.from(g.querySelectorAll('[role="radio"]')).filter((el) => !isOurs(el));
    if (tagged.length) return tagged;
    return Array.from(g.querySelectorAll('input[type="radio"],label,button')).filter(
      (el) => !isOurs(el)
    );
  }

  // What a half is called. Its own text where it has any; failing that the
  // label pointing at it, or its value — an <input> has no text of its own, and
  // the word sits in a <label> beside it.
  function surfaceRadioLabel(el) {
    if (!el) return "";
    const own = normLower(el.textContent);
    if (own) return own;
    for (const a of ["aria-label", "title", "value", "data-value"]) {
      const v = normLower(el.getAttribute && el.getAttribute(a));
      if (v) return v;
    }
    const id = el.getAttribute && el.getAttribute("id");
    if (id) {
      try {
        const lab = document.querySelector('label[for="' + id + '"]');
        if (lab) return normLower(lab.textContent);
      } catch (e) {
        /* an id with quotes in it is not worth a crash */
      }
    }
    const wrap = el.closest ? el.closest("label") : null;
    return wrap ? normLower(wrap.textContent) : "";
  }

  /**
   * The surface in force: "chat", "cowork", or "" when this page has neither a
   * toggle nor an approval control to judge by.
   *
   * Every way the markup might mark the live half, because the one it was first
   * seen using was none of them: both radios rendered aria-checked="false" and
   * the state lived on a hidden input sitting beside them, which is why the
   * approval control's presence is the answer of last resort.
   */
  function currentSurface() {
    const k = K();
    if (!k) return "";
    const group = findSurfaceGroup();
    const radios = surfaceRadios();
    const inputs = group ? Array.from(group.querySelectorAll('input[type="radio"]')) : [];
    const state = radios.map((r, i) => {
      const aria = r.getAttribute("aria-checked");
      const sel = r.getAttribute("aria-selected");
      const ds = normLower(r.getAttribute("data-state"));
      let checked = null;
      if (aria === "true" || sel === "true" || ds === "checked" || ds === "on" || ds === "active")
        checked = true;
      else if (aria === "false" || sel === "false") checked = false;
      // The visible half may say nothing while the input it stands for does.
      // Paired by position: the inputs are siblings of the radios, not children,
      // so there is no containment to follow.
      const input = r.querySelector('input[type="radio"]') || inputs[i] || null;
      if (input && input.checked) checked = true;
      return { label: surfaceRadioLabel(r), checked: checked };
    });
    return k.surfaceFromEvidence(state, !!findApprovalTrigger(), !!group);
  }

  /**
   * Put the toggle on `want`. Returns "inherit" (nothing asked), "ok" (already
   * there, or moved successfully), "unsupported" (no toggle on this page) or
   * "failed" (clicked and it didn't take).
   */
  async function selectSurface(want) {
    const why = (text, verdict) => {
      lastSurfaceWhy = text;
      return verdict;
    };
    const k = K();
    if (!k) return why("CUMCowork not loaded in this world", "unsupported");
    const wanted = k.surfaceFromLabel(want);
    if (!wanted) return why("asked for " + JSON.stringify(String(want)) + ", which is neither surface", "inherit");
    // No toggle at all — an existing conversation rather than the composer
    // home. That is the only thing that makes this unsupported.
    const group = findSurfaceGroup();
    if (!group) return why("no radiogroup on this page", "unsupported");

    const verdict = k.reconcileSurface(wanted, currentSurface());
    if (verdict === "inherit") return why("nothing asked for", "inherit");
    if (verdict === "ok") return why("already on " + wanted, "ok");
    // "unknown" falls through with "set". A page that won't say where its
    // toggle stands is not a page without one, and refusing to click a control
    // sitting in front of us was the whole bug.

    const label = k.labelForSurface(wanted).toLowerCase();
    const radios = surfaceRadios();
    // Asked of the pure module rather than compared as strings. It reduces a
    // label to its letters, which is what makes an invisible character in
    // claude.ai's markup — a zero-width space, which `\s` does not match —
    // stop being the difference between "cowork" and "cowork".
    let at = radios.findIndex((r) => k.surfaceFromLabel(surfaceRadioLabel(r)) === wanted);
    // And a half that carries a badge after its name still leads with it.
    if (at === -1) at = radios.findIndex((r) => surfaceRadioLabel(r).indexOf(label) === 0);
    if (at === -1)
      return why(
        "no half named " + JSON.stringify(label) + " among " +
          JSON.stringify(radios.map(surfaceRadioLabel).join("|")) +
          " (" + radios.length + " halves)",
        "unsupported"
      );

    // The composer re-renders around the toggle, so give it a beat before
    // believing anything.
    const settled = async (tries) => {
      for (let i = 0; i < (tries || 8); i++) {
        await sleep(200);
        if (currentSurface() === wanted) return true;
      }
      return false;
    };

    // A dispatched click is UNTRUSTED, and an untrusted event does not run
    // activation behaviour on a form control: a native <input type="radio">
    // cannot be checked by one, however faithfully the pointer sequence is
    // reproduced. That is why robustClick — right for the send button, whose
    // React handler only needs the event — could never move this toggle, whose
    // two halves are real radio inputs with spans drawn over them.
    //
    // el.click() is the method rather than the event, and it DOES run
    // activation behaviour. robustClick avoids it on purpose (a button that
    // takes both would submit twice); here it is the only thing that works.
    const nativeClick = (el) => {
      try {
        if (el && typeof el.click === "function") el.click();
      } catch (e) {
        /* ignore */
      }
    };

    const inputs = Array.from(group.querySelectorAll('input[type="radio"]'));

    // The visible half first, since that is what a person presses.
    robustClick(radios[at]);
    if (await settled(4)) return why("dispatched click on the half", "ok");
    nativeClick(radios[at]);
    if (await settled(4)) return why("el.click() on the half", "ok");

    // Then the input it stands for.
    if (inputs[at]) {
      nativeClick(inputs[at]);
      if (await settled(4)) return why("el.click() on the input", "ok");
      // ...and failing that, set it and say so. A React-controlled radio reads
      // its own `checked` back from state, so the property alone changes
      // nothing — but the change event is what the handler is listening for,
      // and the two together are what a real click amounts to.
      try {
        inputs[at].checked = true;
        for (const type of ["input", "change"])
          inputs[at].dispatchEvent(new Event(type, { bubbles: true }));
      } catch (e) {
        /* ignore */
      }
      if (await settled(6)) return why("checked + change on the input", "ok");
    }
    return why(
      "clicked the half " + (inputs[at] ? "and its input " : "(it has no input) ") +
        "every way there is and the surface still reads " +
        JSON.stringify(currentSurface() || "unreadable"),
      "failed"
    );
  }

  // The approval control. Its own aria-label is the mode in force, which makes
  // it both the trigger to click and the answer to "which mode is this?".
  function findApprovalTrigger() {
    const k = K();
    if (!k) return null;
    for (const m of k.MODES) {
      const b = document.querySelector('button[aria-label="' + m.label + '" i]');
      if (b && !isOurs(b)) return b;
    }
    return null;
  }

  /** The approval mode in force, or "" where there is no such control. */
  function currentApproval() {
    const k = K();
    const t = findApprovalTrigger();
    return k && t ? k.modeFromLabel(t.getAttribute("aria-label")) : "";
  }

  /**
   * Put the approval control on `want`. Same verdicts as selectSurface, with
   * "unsupported" meaning this page has no approval control — which is what
   * being in Chat looks like from here.
   */
  async function selectApproval(want) {
    const k = K();
    if (!k) return "unsupported";
    const wanted = k.modeFromLabel(want);
    if (!wanted) return "inherit";
    const verdict = k.reconcile(wanted, currentApproval());
    if (verdict === "inherit") return "inherit";
    if (verdict === "unknown") return "unsupported";
    if (verdict === "ok") return "ok";

    const trigger = findApprovalTrigger();
    if (!trigger) return "unsupported";
    if (await openMenu(trigger, menuItems())) {
      closeMenu();
      return "failed";
    }

    const rowOf = () => {
      for (const el of document.querySelectorAll('[role="menuitemradio"]')) {
        if (isOurs(el)) continue;
        if (k.rowIsMode(el.textContent, wanted)) return el;
      }
      return null;
    };
    let row = rowOf();
    for (let i = 0; i < 12 && !row; i++) {
      await sleep(200);
      row = rowOf();
    }
    if (!row) {
      closeMenu();
      return "failed";
    }
    robustClick(row);
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      if (currentApproval() === wanted) return "ok";
    }
    closeMenu();
    return "failed";
  }

  /**
   * Choose a project from Cowork's own menu. Unlike a scheduled send's project,
   * which is an address to navigate to, this one is a control on the composer —
   * so it is the only way to put a Cowork session in a project.
   *
   * The rows carry names and no uuids, so the name is all there is to match on,
   * and the two rows that navigate away ("Create new project", "View all
   * projects") are excluded by name for the same reason: clicking either during
   * an unattended send is worse than not finding the project.
   */
  async function selectCoworkProject(name) {
    const k = K();
    const why = (text, verdict) => {
      lastProjectWhy = text;
      return verdict;
    };
    if (!k) return why("CUMCowork not loaded in this world", "unsupported");
    if (!String(name || "").trim()) return why("no project asked for", "inherit");

    // The trigger reads "Project" until something is chosen and the project's
    // own name after — so both are how it might be found, and both are compared
    // on letters alone. This markup carries characters that no whitespace rule
    // removes, which is what made the surface toggle unmatchable.
    // A MENU trigger, not merely a button with the right word on it. Cowork's
    // opens a menu and says so — aria-haspopup, or an aria-expanded it flips —
    // while claude.ai's left navigation has a "Projects" entry that only
    // navigates. Clicking that one took the run to the projects page and left
    // it there, which is not a near miss of choosing a project: it is the end
    // of the run, and it is why this asks what a control DOES and not just what
    // it says.
    const opensAMenu = (b) =>
      b.hasAttribute("aria-haspopup") ||
      b.hasAttribute("aria-expanded") ||
      b.hasAttribute("aria-controls");
    const triggers = Array.from(document.querySelectorAll("button")).filter(
      (b) => !isOurs(b) && opensAMenu(b)
    );
    let trigger = triggers.find((b) => k.projectTriggerIs(b.textContent, name));
    if (trigger) return why("the trigger already reads " + JSON.stringify(name), "ok");
    trigger = triggers.find((b) => k.isProjectTriggerCaption(b.textContent));
    if (!trigger)
      return why(
        "no project menu — nothing that opens a menu is captioned Project or named " +
          JSON.stringify(name) + " (" + triggers.length + " menu buttons on the page)",
        "unsupported"
      );
    const before = menuItems();
    const trouble = await openMenu(trigger, before);
    if (trouble) return why(trouble, "notfound");

    // The list is labelled "Search projects", which is a promise of a filter —
    // and a filter is not a nicety here. A long list renders only what fits, so
    // a project far down it is not in the page to be clicked until the typing
    // brings it there. Same shape as the repo picker, for the same reason.
    // The menu is open and has rows in it — openMenu said so — which is what
    // makes it safe to look for the box they live in. An EMPTY container was
    // being accepted before, and an empty container is exactly what a menu that
    // never opened looks like.
    const rowsNow = menuItems();
    const holder = (el) => el && rowsNow.some((r) => el.contains(r));
    let box =
      Array.from(document.querySelectorAll('[role="listbox"][aria-label*="project" i]')).find(holder) ||
      Array.from(document.querySelectorAll('[role="listbox"]')).find(holder) ||
      Array.from(document.querySelectorAll('[role="menu"],[role="dialog"]')).find(holder) ||
      null;
    // Only ever inside the menu. Falling back to the document would find the
    // composer's own editor and type the project's name into the prompt — the
    // message would go out mangled, which is far worse than a project not
    // chosen.
    if (!box) return why("rows opened but nothing recognisable holds them", "notfound");
    const filter = box.querySelector('input:not([type="hidden"]), [contenteditable="true"]');
    if (filter) {
      try {
        filter.focus();
        const typed = document.execCommand && document.execCommand("insertText", false, name);
        if (!typed && "value" in filter) {
          filter.value = name;
          filter.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } catch (e) {
        /* an unfiltered list is still a list */
      }
      await sleep(700);
    }

    const rowOf = () => {
      const seen = [];
      for (const el of box.querySelectorAll('[role="option"],[role="menuitem"]')) {
        if (isOurs(el)) continue;
        const t = el.textContent || "";
        if (!k.isProjectRow(t)) continue; // never "Create new project" — it navigates
        seen.push(t.replace(/\s+/g, " ").trim().slice(0, 40));
        if (k.projectRowMatches(t, name)) return el;
      }
      lastSeenRows = seen;
      return null;
    };
    let lastSeenRows = [];
    let row = rowOf();
    for (let i = 0; i < 12 && !row; i++) {
      await sleep(200);
      row = rowOf();
    }
    if (!row) {
      closeMenu();
      return why(
        "no row named " + JSON.stringify(name) + " among " +
          JSON.stringify(lastSeenRows.join(" | ")) +
          (filter ? " (filtered)" : " (no filter box found)"),
        "notfound"
      );
    }
    robustClick(row);

    // Believed only when the trigger says so. A menu that closed is not a
    // project that was chosen, and an unattended send has no other way to tell
    // the difference.
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      if (triggers.concat([trigger]).some((b) => k.projectTriggerIs(b.textContent, name)))
        return why("clicked the row and the trigger now reads it", "ok");
      const live = Array.from(document.querySelectorAll("button")).filter((b) => !isOurs(b));
      if (live.some((b) => k.projectTriggerIs(b.textContent, name)))
        return why("clicked the row and the trigger now reads it", "ok");
    }
    closeMenu();
    return why("clicked the row but no trigger came to read " + JSON.stringify(name), "failed");
  }

  /**
   * Rename a Cowork session, the way a person does it.
   *
   * There is no API for this. Renaming one by hand makes no HTTP request at
   * all — watched for, on a page that renames a regular chat with a plain PUT —
   * so the title must be going over a socket, and the only door left is the one
   * you use: open the menu on the session's name, choose Rename, type into the
   * box that appears, confirm.
   *
   * That "no request, therefore impossible" reasoning was wrong twice over. It
   * ruled out the API and reported the feature as unavailable, when what it had
   * actually established was only that ONE route was closed.
   *
   * Everything here is named rather than positional, and nothing unknown is
   * ever pressed: an unattended run that clicks a menu item it can't read is
   * how a rename becomes a delete.
   */
  async function renameCoworkSession(title) {
    const why = (text, verdict) => {
      lastRenameWhy = text;
      return verdict;
    };
    const want = String(title || "").trim();
    if (!want) return why("no title asked for", "inherit");
    const k = K();
    if (!k) return why("CUMCowork not loaded in this world", "unsupported");

    const buttons = () =>
      Array.from(document.querySelectorAll("button")).filter((b) => !isOurs(b) && isVisible(b));
    const labelled = (test) =>
      buttons().find((b) => test(b.getAttribute("aria-label")));

    // Already called that.
    if (buttons().some((b) => k.titleNames(b.getAttribute("aria-label"), want)))
      return why("it was already called that", "ok");

    // The title is its own rename control, and its label says so:
    //   aria-label="Riddle puzzle, rename session"
    // No menu to open, no item to match — the two steps that had been failing,
    // and neither of them ever needed to happen.
    let opened = false;
    const direct = labelled((l) => k.isRenameSessionLabel(l));
    if (direct) {
      robustClick(direct);
      opened = !!(await waitForBox(700));
      if (!opened) {
        try {
          direct.click();
        } catch (e) {
          /* the menu below is the fallback */
        }
        opened = !!(await waitForBox(1500));
      }
    }

    // Failing that, the menu beside it — "More options for <name>" — and a row
    // that leads with Rename.
    let viaMenu = "";
    if (!opened) {
      const trigger = labelled((l) => k.isMoreOptionsLabel(l));
      if (!trigger)
        return why(
          direct
            ? "the title's rename control opened nothing to type into"
            : "no rename control and no options menu in the header",
          "unsupported"
        );
      const trouble = await openMenu(trigger, menuItems());
      // Read the menu BEFORE closing it. Reporting what it held after it had
      // been shut is how "saw nothing" became guaranteed rather than observed.
      const saw = menuItems()
        .map((el) => normLower(el.textContent).slice(0, 24))
        .join(" | ");
      if (trouble) return why(trouble + (saw ? " — saw " + JSON.stringify(saw) : ""), "unsupported");
      const item = menuItems().find((el) => k.isRenameRow(el.textContent));
      if (!item) {
        closeMenu();
        return why("no Rename in the options menu — saw " + JSON.stringify(saw), "unsupported");
      }
      robustClick(item);
      opened = !!(await waitForBox(2500));
      viaMenu = " via the options menu";
      if (!opened) return why("Rename opened nothing that could be typed into", "failed");
    }

    const field = await waitForBox(0);
    if (!field) return why("nothing to type into", "failed");

    try {
      field.focus();
      if ("value" in field && field.select) field.select();
      else if (document.execCommand) document.execCommand("selectAll", false, null);
      const typed = document.execCommand && document.execCommand("insertText", false, want);
      if (!typed && "value" in field) {
        field.value = want;
        for (const t of ["input", "change"]) field.dispatchEvent(new Event(t, { bubbles: true }));
      }
    } catch (e) {
      return why("couldn't type into the rename box", "failed");
    }
    await sleep(250);

    for (const t of ["keydown", "keypress", "keyup"]) {
      try {
        field.dispatchEvent(
          new KeyboardEvent(t, { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 })
        );
      } catch (e) {
        /* the button below is the fallback */
      }
    }

    // Took, as distinct from went in. Both header controls carry the session's
    // name, so either coming round to the new one is proof — where a dialog
    // closing would have been just as true of Cancel.
    const took = () => buttons().some((b) => k.titleNames(b.getAttribute("aria-label"), want));
    const settled = async (tries) => {
      for (let i = 0; i < (tries || 8); i++) {
        await sleep(250);
        if (took()) return true;
      }
      return false;
    };
    if (await settled(8)) return why("typed it and pressed Enter" + viaMenu, "ok");

    const dlg = document.querySelector('[role="dialog"],[role="alertdialog"]');
    if (dlg) {
      for (const b of dlg.querySelectorAll("button")) {
        if (isOurs(b)) continue;
        if (!/^(rename|save|done|confirm|ok)\b/.test(normLower(b.textContent))) continue;
        robustClick(b);
        if (await settled(8)) return why("typed it and pressed " + normLower(b.textContent), "ok");
        break;
      }
    }
    closeMenu();
    return why("typed it, but no control came round to reading " + JSON.stringify(want), "failed");
  }

  // The box a rename opens: inside a dialog where there is one, and never the
  // composer — a loose search finds the prompt editor, and the title would go
  // out as the message.
  async function waitForBox(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 0);
    for (;;) {
      const dlg = document.querySelector('[role="dialog"],[role="alertdialog"]');
      const scope = dlg || document;
      let found = null;
      try {
        for (const el of scope.querySelectorAll(
          'input[type="text"],input:not([type]),textarea,[contenteditable="true"]'
        )) {
          if (isOurs(el) || !isVisible(el) || el === findEditor()) continue;
          found = el;
          break;
        }
      } catch (e) {
        /* ignore */
      }
      if (found || Date.now() >= deadline) return found;
      await sleep(150);
    }
  }

  /**
   * What the header offers a rename, right now. Printed by the pill's button
   * when a rename didn't happen — the same trick that ended the surface
   * toggle, where a verdict said a piece was missing and only a census said
   * WHICH piece.
   */
  function renameReport() {
    const bits = [];
    let all = [];
    try {
      all = Array.from(document.querySelectorAll("button")).filter((b) => !isOurs(b));
    } catch (e) {
      return "couldn't query the page";
    }
    const header = all.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width >= 8 && r.height >= 8 && r.top >= 0 && r.top <= 120;
    });
    bits.push("header buttons: " + header.length + " of " + all.length);
    for (const b of header.slice(0, 12)) {
      bits.push(
        "  aria-label=" + JSON.stringify(b.getAttribute("aria-label") || "") +
          " text=" + JSON.stringify(normLower(b.textContent).slice(0, 30)) +
          " haspopup=" + JSON.stringify(b.getAttribute("aria-haspopup") || "") +
          " expanded=" + JSON.stringify(b.getAttribute("aria-expanded") || "")
      );
    }
    const items = menuItems();
    bits.push(
      "menu items open now: " + items.length +
        (items.length
          ? " — " + JSON.stringify(items.map((el) => normLower(el.textContent).slice(0, 24)).join(" | "))
          : "")
    );
    return bits.join("\n");
  }

  // ---- one composed message, end to end ----------------------------------
  // Attach files, pick model/repo, type `text`, click Send, confirm it left.
  // Returns { ok, error?, notes: [] } — notes are best-effort problems (model
  // not available, repo picker missing) that must not stop the send.
  async function sendMessage(opts) {
    const o = opts || {};
    const notes = [];
    const files = o.files || [];
    // Asked between the slow phases — attaching, uploading, typing — because a
    // pause pressed while twenty exhibits are going up should stop the message,
    // not be noticed a minute later when it has already gone.
    const halted = () => {
      try {
        return typeof o.stop === "function" ? o.stop() : null;
      } catch (e) {
        return null;
      }
    };
    const standDown = (why) => ({ ok: false, halted: why, error: "stopped — " + why, notes });
    let why = halted();
    if (why) return standDown(why);

    if (files.length) await waitFor(findFileInput, 15000); // may legitimately not exist
    let editor = await waitFor(findEditor);
    if (!editor) return { ok: false, error: "prompt editor not found", notes };

    // The surface comes first, and before anything is typed: switching it
    // re-renders the composer, so a prompt inserted beforehand would be thrown
    // away with the old one, and the editor handle we hold would go stale.
    const k = K();
    let surfaceWas = "";
    if (k && o.surface) {
      try {
        surfaceWas = currentSurface();
        const r = await selectSurface(o.surface);
        // With the reason. A run is unattended by definition, so the note is
        // the only place it can say WHICH part failed — and "unsupported" on
        // its own, without that, cost several rounds to diagnose by hand.
        if (r === "unsupported")
          notes.push(
            "no Chat/Cowork toggle on this page — sent on whichever it was (" + surfaceWhy() + ")"
          );
        else if (r === "failed")
          notes.push("couldn't switch to " + k.describeSurface(o.surface) + " (" + surfaceWhy() + ")");
        else if (r === "ok" && surfaceWas && surfaceWas !== k.surfaceFromLabel(o.surface)) {
          editor = (await waitFor(findEditor)) || editor;
        } else {
          surfaceWas = "";
        }
      } catch (e) {
        notes.push("Chat/Cowork switch failed");
        surfaceWas = "";
      }
    }

    // Approval belongs to Cowork. Asking for one anywhere else isn't an error
    // worth stopping for, but it is worth saying: the mode is remembered for
    // the whole account, so "it must have worked" is exactly the assumption
    // that gets a job sent under a mode nobody chose.
    if (k && o.approval) {
      if (!k.approvalApplies(o.surface, currentSurface())) {
        notes.push("asked for " + k.describeMode(o.approval) + " but this isn't Cowork — sent as-is");
      } else {
        try {
          const r = await selectApproval(o.approval);
          if (r === "unsupported")
            notes.push("asked for " + k.describeMode(o.approval) + " but found no approval control");
          else if (r === "failed") notes.push("couldn't set approval to " + k.describeMode(o.approval));
        } catch (e) {
          notes.push("approval switch failed");
        }
      }
    }

    // A Cowork project is a control, not an address — the only way in.
    if (k && o.coworkProject && k.approvalApplies(o.surface, currentSurface())) {
      try {
        const r = await selectCoworkProject(o.coworkProject);
        if (r === "unsupported") notes.push("no project menu on this page (" + projectWhy() + ")");
        else if (r === "notfound")
          notes.push('project "' + o.coworkProject + '" not chosen (' + projectWhy() + ")");
        else if (r === "failed")
          notes.push('project "' + o.coworkProject + '" not chosen (' + projectWhy() + ")");
      } catch (e) {
        notes.push("project select failed");
      }
    }

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
      why = halted();
      if (why) return standDown(why);
    }

    if (o.text) {
      insertPrompt(editor, o.text);
      await sleep(400);
    }
    if (!o.text && !files.length) return { ok: false, error: "nothing to send", notes };

    // The last look before it goes out. After this the message is Claude's.
    why = halted();
    if (why) return standDown(why);

    // Put the toggle back if we moved it. It is a preference for the whole
    // account rather than for this tab, so a 3am job that switches to Cowork
    // and walks away changes which surface the next window opens on. Once the
    // message has gone the composer home is gone with it and there is nothing
    // left to click — so this tries, and says so plainly when it can't.
    const restore = async () => {
      if (!k || !surfaceWas) return;
      let ok = false;
      try {
        ok = (await selectSurface(surfaceWas)) === "ok";
      } catch (e) {
        ok = false;
      }
      const note = k.surfaceLeftNote(surfaceWas, ok);
      if (note) notes.push(note);
    };

    const before = ((editor && editor.textContent) || "").trim();
    const send = await waitSendEnabled(15000);
    if (send && !sendDisabled(send)) {
      robustClick(send);
      if (await confirmSent(before)) {
        await restore();
        return { ok: true, notes };
      }
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
      if (await confirmSent(before)) {
        await restore();
        return { ok: true, notes };
      }
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
    findStop,
    stopGenerating,
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
    findSurfaceGroup,
    surfaceWhy,
    projectWhy,
    renameCoworkSession,
    renameWhy,
    renameReport,
    currentSurface,
    selectSurface,
    findApprovalTrigger,
    currentApproval,
    selectApproval,
    selectCoworkProject,
    harvestModels,
    harvestRepos,
    scrapeRepos,
    sendMessage,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
