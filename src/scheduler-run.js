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
      if (await confirmSent(before)) return { ok: true };
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
      if (await confirmSent(before)) return { ok: true };
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
