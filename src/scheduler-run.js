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
  const SEL = {
    fileInput: 'input[data-testid="file-upload"]',
    editor: 'div[data-testid="chat-input"]',
    send: 'button[aria-label="Send message"]',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitFor(selector, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + (timeoutMs || 20000);
      (function poll() {
        const el = document.querySelector(selector);
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
    const input = files.length ? await waitFor(SEL.fileInput) : null;
    const editor = await waitFor(SEL.editor);
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
      await sleep(300);
    }

    // 5. Send (only if there's something to send).
    if (!job.prompt && !files.length) return { ok: false, error: "empty job" };
    const send = await waitFor(SEL.send, 8000);
    if (!send) return { ok: false, error: "send button not found" };
    if (send.disabled) {
      await sleep(1200); // give uploads/validation a moment
    }
    if (send.disabled) return { ok: false, error: "send button stayed disabled" };
    send.click();
    return { ok: true };
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

  chrome.runtime?.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "cum-run-job") {
      runJob(msg.jobId)
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true; // async response
    }
    if (msg.type === "cum-scrape-projects") {
      sendResponse({ projects: scrapeProjects() });
      return false;
    }
  });
})();
