/**
 * Claude Usage Meter — a run set up from PDF+'s Home (Options page wiring).
 *
 * The decisions are src/pdfplusrun.js's; this is the native host and the page.
 *
 * PDF+'s Claude button writes a request into Downloads and opens claude.ai
 * with a bare marker; content.js sees it and the worker opens Options on
 * Workflows (or tells an open one to look again). Here the request is read
 * through the E-Court Suite's native host (com.lacourt.ecourt_host, which
 * serves only the folder the request names, read-only) and shown as a banner
 * above the workflows. Nothing else about the page changes: you choose a
 * workflow and press its Create run, exactly as always, and the run's editor
 * then receives the case folder through takeFromPdfPlus — the same door, and
 * every check, a picked folder goes through. Dismiss lets the request go.
 * Without a request there is no banner and nothing different at all.
 */
(function () {
  "use strict";

  const R = window.CUMPdfPlusRun;
  const HOST = "com.lacourt.ecourt_host";
  let pending = null; // the checked request, while one waits
  let ui = null;
  let hooks = {}; // options.js: { createRun(workflowId) → whether that workflow's Create run was pressed }

  // One connection for a whole transfer: the host answers each message in
  // turn, so a queue of waiters is the whole protocol.
  function hostSession() {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      return null;
    }
    const waiting = [];
    let dead = null;
    port.onMessage.addListener((m) => {
      const w = waiting.shift();
      if (w) w.resolve(m);
    });
    port.onDisconnect.addListener(() => {
      dead = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "the native host closed";
      while (waiting.length) waiting.shift().reject(new Error(dead));
    });
    return {
      ask(msg, ms) {
        if (dead) return Promise.reject(new Error(dead));
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("the native host did not answer")), ms || 30000);
          waiting.push({
            resolve: (m) => (clearTimeout(t), resolve(m)),
            reject: (e) => (clearTimeout(t), reject(e)),
          });
          try {
            port.postMessage(msg);
          } catch (e) {
            reject(e);
          }
        });
      },
      close() {
        try {
          port.disconnect();
        } catch (e) {
          /* gone */
        }
      },
    };
  }

  function bytesOf(b64) {
    const bin = atob(String(b64 || ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function say(text, warn) {
    if (!ui) return;
    ui.text.textContent = text || "";
    ui.box.classList.toggle("warn", !!warn);
    ui.box.hidden = !text;
  }

  /** Read the request PDF+ left, and show it. */
  async function check() {
    if (!R) return;
    const s = hostSession();
    if (!s) return;
    let resp = null;
    try {
      resp = await s.ask({ action: "readRunRequest" }, 10000);
    } catch (e) {
      resp = null; // no host, or an older one: no banner, and nothing changes
    }
    s.close();
    const res = R.checkRequest(resp && resp.ok ? resp.request : null);
    pending = res.ok ? res.request : null;
    if (pending) say(R.bannerText(pending), false);
    else if (ui && !ui.box.classList.contains("warn")) say("", false);
    if (pending && pending.workflowId) autoCreate(pending);
  }

  // A workflow chosen from PDF+'s Claude menu (the owner, November 2026: "a
  // drop down menu that lets me select the workflow to run. That way it can
  // initiate the full thing for me, upload the documents and fill in the date
  // I can just hit the save and start this run button"): its Create run is
  // pressed here, once a request, which makes the run as a draft (nothing
  // starts) and brings the papers and the hearing date into its editor
  // (afterCreate). Starting it is still the owner's press.
  const autoDone = new Set();
  async function autoCreate(req) {
    if (!hooks.createRun || autoDone.has(req.id)) return;
    autoDone.add(req.id);
    // The list may still be drawing: a few looks before giving up.
    for (let i = 0; i < 20; i++) {
      if (pending !== req) return; // dismissed, or another request came
      if (hooks.createRun(req.workflowId)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (pending === req) say(R.failText("noworkflow", req), true);
  }

  /**
   * After Create run has opened the new run's editor: bring the case folder
   * over and hand it to the editor's own door. Answers { ok, why }.
   */
  async function afterCreate(form) {
    if (!pending || !R) return { ok: false, why: "none" };
    const req = pending;
    const s = hostSession();
    if (!s) {
      say(R.failText("host", req), true);
      return { ok: false, why: "host" };
    }
    try {
      say("Bringing " + req.folderName + "'s papers over from PDF+…", false);
      const list = await s.ask({ action: "listRunFolder", id: req.id });
      if (!list || !list.ok) {
        const why = list && list.error === "gone" ? "gone" : "host";
        say(R.failText(why, req) + (list && list.error && why === "host" ? " (" + list.error + ")" : ""), true);
        return { ok: false, why };
      }
      const files = [];
      for (const e of list.entries || []) {
        if (!R.safeRel(e.rel, req.folderName)) continue;
        const name = e.rel.slice(e.rel.lastIndexOf("/") + 1);
        let f;
        if (R.needsBytes(e.rel)) {
          const parts = [];
          let off = 0;
          for (;;) {
            const r = await s.ask({ action: "readRunFile", id: req.id, rel: e.rel, offset: off });
            if (!r || !r.ok) throw new Error((r && r.error) || "a file could not be read");
            const bytes = bytesOf(r.data);
            parts.push(bytes);
            off += bytes.length;
            if (r.eof || !bytes.length) break;
          }
          f = new File(parts, name, { lastModified: e.mtime || Date.now() });
        } else {
          // An original the case-folder split leaves where it is: its path
          // only, so the gate and the split see the folder whole.
          f = new File([], name, { lastModified: e.mtime || Date.now() });
          Object.defineProperty(f, "__cumStandIn", { value: true });
        }
        // As a picked folder's files carry it (DD.fromPicked reads it).
        Object.defineProperty(f, "webkitRelativePath", { value: e.rel });
        files.push(f);
      }
      const res = form.takeFromPdfPlus(files, { root: req.folderName, runDate: req.hearingDate });
      if (!res.ok) {
        say(R.failText(res.why, req), true);
        return res;
      }
      try {
        await s.ask({ action: "clearRunRequest", id: req.id }, 10000);
      } catch (e) {
        /* it ages out on its own (R.MAX_AGE_MS) */
      }
      pending = null;
      say(
        "PDF+'s papers for " + (req.caseName || req.folderName) + " went to the run through Choose folder…'s checks — " +
          "see what was taken just above its documents. " +
          (req.workflowId ? "Look it over and press Save and start this run." : "Choose its workflow steps and start it as usual."),
        false
      );
      return res;
    } catch (e) {
      say(R.failText("host", req) + " (" + ((e && e.message) || e) + ")", true);
      return { ok: false, why: "host" };
    } finally {
      s.close();
    }
  }

  async function dismiss() {
    const req = pending;
    pending = null;
    say("", false);
    if (!req) return;
    const s = hostSession();
    if (!s) return;
    try {
      await s.ask({ action: "clearRunRequest", id: req.id }, 10000);
    } catch (e) {
      /* it ages out on its own */
    }
    s.close();
  }

  /** Mount the banner above the Workflows toolbar (`anchor`), and look for a request. */
  function init(anchor, opts) {
    if (!anchor || !anchor.parentNode || !R) return;
    hooks = opts || {};
    const box = document.createElement("div");
    box.className = "pdfplus-banner";
    box.hidden = true;
    box.innerHTML = '<span class="pdfplus-text"></span><button type="button" class="pdfplus-dismiss">Dismiss</button>';
    anchor.parentNode.insertBefore(box, anchor);
    ui = { box, text: box.querySelector(".pdfplus-text") };
    box.querySelector(".pdfplus-dismiss").addEventListener("click", dismiss);
    check();
  }

  window.CUMPdfPlusBridge = { init, check, afterCreate, hasPending: () => !!pending };
})();
