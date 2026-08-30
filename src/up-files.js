/**
 * Claude Usage Meter — the files you uploaded, downloadable again (ISOLATED
 * world content script).
 *
 * A button in the tray beside Save. It lists the files YOU sent to this
 * conversation and gives each one the download control claude.ai never did —
 * because a file you uploaded is, on claude.ai, a chip that opens a preview and
 * nothing else. Once the local copy is gone the chat is holding the only copy
 * and holding it away from you, which is the whole of why this exists.
 *
 * The list comes from the conversation PAYLOAD, never from the page: claude.ai
 * unmounts messages that scroll out of view, so a list read from the DOM would
 * be a list of the last few turns and would silently shorten as you scrolled.
 * src/upfiles.js owns every decision in it — whose file it is, where the bytes
 * can be fetched from, and whether what comes back is the file or only the text
 * claude.ai read out of it. This is the DOM, the fetch and the saving.
 *
 * Three things it will not do, each of them a way of appearing to work:
 *
 * - **Never hand over a thumbnail, or claude.ai's own page, as your file.** The
 *   asset URLs are tried in order and the answer is checked before anything is
 *   written (U.looksLikeFile): a 200 carrying an HTML error page would
 *   otherwise land on disk as "brief.pdf".
 * - **Never call an extract the original.** The words claude.ai read out of a
 *   PDF are saved as `brief.pdf.txt`, labelled as an extract in the row, and a
 *   file that WAS text is labelled as the file itself.
 * - **Never fail quietly.** A row that couldn't be fetched says which URLs were
 *   tried and what each answered, and — where claude.ai kept the text — offers
 *   that instead rather than leaving you with a button that does nothing.
 *
 * The fetch runs in the MAIN world (src/inject.js, `fetchFile`), because it is
 * the page's own session that may read the asset; the bytes come back here to
 * be written, because the page's CSP governs that world and not this one.
 */
(function () {
  "use strict";

  const U = window.CUMUpFiles;
  const C = window.CUMComposer;
  const W = window.CUMWorkflow;
  const V = window.CUMConv;
  if (!U || !C || !W) return;

  const BTN_ID = "cum-upf-btn";
  const PANEL_ID = "cum-upf-panel";
  const TICK_MS = 1200;
  const REFRESH_MS = 9000; // no faster than this while the panel is open
  // ...and far slower with it shut. The count on the button is worth keeping
  // current — it is how you learn this chat is holding files at all — but not
  // at the price of a conversation fetch every few seconds all day.
  const IDLE_MS = 60000;
  const BETWEEN_MS = 500; // between saves in a batch, so the browser keeps up
  const FETCH_MS = 45000; // one file's fetch, at the end of which we say so

  let btn = null;
  let panel = null;
  let open = false;
  let convId = null;
  let uploads = []; // what src/upfiles.js made of the payload
  let plan = []; // ...with the name each will be saved under
  let state = "idle"; // idle | loading | ready | none
  let note = ""; // the last thing that happened, said in the panel
  let busy = false;
  const rowNote = new Map(); // key -> what happened to that one file
  let lastFetch = 0;

  // ---- reading the conversation ---------------------------------------------

  const isCowork = () => location.pathname.indexOf("/cowork") === 0;

  function conversationId() {
    try {
      return W.conversationId(location.pathname) || W.conversationId(location.href) || null;
    } catch (e) {
      return null;
    }
  }

  function refresh(force) {
    const id = conversationId();
    if (id !== convId) {
      // Another chat: everything on screen belonged to the last one.
      convId = id;
      uploads = [];
      plan = [];
      rowNote.clear();
      note = "";
      state = id ? "idle" : "none";
      draw();
    }
    if (!id || !V) return;
    if (!force && Date.now() - lastFetch < (open ? REFRESH_MS : IDLE_MS)) return;
    lastFetch = Date.now();
    if (state !== "ready") state = "loading";
    draw();
    V.get(id, force ? 0 : REFRESH_MS)
      .then((conv) => {
        if (conversationId() !== id) return; // you navigated while it was in flight
        if (!conv) {
          // No record under this id. An incognito chat is never saved, and that
          // is a different sentence from "you uploaded nothing".
          uploads = [];
          plan = [];
          state = "none";
          return draw();
        }
        uploads = U.uploadsOf(conv);
        plan = U.planDownloads(uploads);
        state = "ready";
        draw();
      })
      .catch(() => {
        state = "none";
        draw();
      });
  }

  // ---- the fetch, and the saving --------------------------------------------

  let seq = 0;
  function fetchFile(urls) {
    return new Promise((resolve) => {
      const reqId = "uf" + ++seq + "-" + Date.now();
      let settled = false;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve(res || { error: "no answer", tried: [] });
      };
      function onMsg(event) {
        if (event.source !== window) return;
        const m = event.data;
        const p = m && m.__channel === C.CHANNEL ? m.payload : null;
        if (p && p.upfile && p.upfile.reqId === reqId) finish(p.upfile);
      }
      window.addEventListener("message", onMsg);
      const timer = setTimeout(
        () => finish({ error: "claude.ai didn't answer in time", tried: [] }),
        FETCH_MS
      );
      try {
        window.postMessage(
          { __channel: C.CHANNEL, command: { type: "fetchFile", urls: urls, reqId: reqId } },
          window.location.origin
        );
      } catch (e) {
        finish({ error: String((e && e.message) || e), tried: [] });
      }
    });
  }

  // The same anchor-and-blob save src/save-chat.js uses, and in the same world:
  // the page's CSP does not reach in here.
  function save(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 6000);
  }

  function saveText(row) {
    const text = row.text || "";
    if (!text) return false;
    save(row.saveAs, new Blob([text], { type: "text/plain;charset=utf-8" }));
    return true;
  }

  /**
   * One file, got back.
   *
   * Answers true only when something was actually written. Everything that can
   * go wrong is recorded against the row in the words of what was tried, so the
   * panel can say it rather than going quiet.
   */
  async function getOne(row) {
    if (!row || !row.saveAs) return false;
    rowNote.set(row.key, { text: "Fetching…", bad: false });
    draw();
    if (row.how !== "file") {
      const ok = saveText(row);
      rowNote.set(row.key, {
        text: ok
          ? row.how === "text"
            ? "Saved."
            : "Saved the extracted text."
          : "claude.ai kept nothing of this one.",
        bad: !ok,
      });
      draw();
      return ok;
    }
    const res = await fetchFile((row.urls || []).map((s) => s.url));
    if (!U.looksLikeFile(res)) {
      const tried = (res && res.tried) || [];
      if (res && res.ok) tried.push({ url: res.url, what: "not the file: " + (res.type || "?") });
      // A file we couldn't fetch may still have its text, and that is worth
      // offering out loud rather than leaving the row dead.
      const alt = row.entry && row.entry.text ? " claude.ai still has its text — “Text” saves that." : "";
      rowNote.set(row.key, {
        text: U.describeFailure(row.entry ? row.entry.name : row.saveAs, tried) + alt,
        bad: true,
      });
      draw();
      return false;
    }
    save(row.saveAs, new Blob([res.buf], { type: res.type || "application/octet-stream" }));
    rowNote.set(row.key, { text: "Saved " + U.sizeLabel(res.bytes) + ".", bad: false });
    draw();
    return true;
  }

  async function getAll() {
    const rows = plan.filter((r) => r.saveAs);
    if (!rows.length || busy) return;
    busy = true;
    let saved = 0;
    let failed = 0;
    for (const row of rows) {
      note = "Getting " + (saved + failed + 1) + " of " + rows.length + "…";
      draw();
      // eslint-disable-next-line no-await-in-loop
      if (await getOne(row)) saved++;
      else failed++;
      // eslint-disable-next-line no-await-in-loop
      await C.sleep(BETWEEN_MS);
    }
    busy = false;
    note =
      "Saved " + saved + " of " + rows.length + (failed ? " — " + failed + " didn't come back." : ".");
    draw();
  }

  // ---- the button and the panel ---------------------------------------------

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, cls, onClick, title) {
    const b = el("button", "cum-upf-b " + (cls || ""), label);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  function build() {
    if (btn && btn.isConnected) return btn;
    btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.title = "The files you uploaded to this conversation — download them again";
    btn.innerHTML =
      '<span class="cum-upf-ico" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9z"/>' +
      '<path d="M13 3v6h6"/><path d="M12 12v5"/><path d="m9.5 14.5 2.5 2.5 2.5-2.5"/>' +
      "</svg></span>" +
      '<span class="cum-upf-txt">Files</span>' +
      '<span class="cum-upf-count"></span>';
    btn.addEventListener("click", () => setOpen(!open));
    return btn;
  }

  function setOpen(on) {
    open = !!on;
    if (!open && panel) {
      panel.remove();
      panel = null;
      note = ""; // what happened last time is not news the next time it opens
    }
    if (open) refresh(true);
    place();
    draw();
  }

  function buildPanel() {
    if (panel && panel.isConnected) return panel;
    panel = el("div", "cum-upf-panel");
    panel.id = PANEL_ID;
    return panel;
  }

  // What the row says about itself, under its name.
  const HOW_LABEL = {
    file: "the file as you uploaded it",
    text: "the file as you uploaded it (kept as text)",
    extract: "extracted text only — not the document",
    none: "claude.ai kept only the name",
  };

  function drawRow(row) {
    const wrap = el("div", "cum-upf-row" + (row.how === "none" ? " cum-upf-dead" : ""));
    const head = el("div", "cum-upf-rowhead");
    const name = el("div", "cum-upf-name", row.entry.name);
    name.title = row.saveAs ? "Saves as " + row.saveAs : row.note;
    head.appendChild(name);
    if (row.saveAs) {
      head.appendChild(
        button(row.how === "file" ? "Download" : "Save text", "cum-upf-get", () => {
          if (!busy) getOne(row);
        })
      );
    }
    wrap.appendChild(head);
    const bits = [];
    const size = U.sizeLabel(row.entry.size);
    if (size) bits.push(size);
    bits.push(HOW_LABEL[row.how]);
    wrap.appendChild(el("div", "cum-upf-meta", bits.join(" · ")));
    // A file whose bytes wouldn't come but whose text claude.ai kept: the
    // second-best answer, offered rather than merely mentioned.
    const said = rowNote.get(row.key);
    if (said) {
      const line = el("div", "cum-upf-said" + (said.bad ? " cum-upf-bad" : ""), said.text);
      wrap.appendChild(line);
      if (said.bad && row.how === "file" && row.entry.text) {
        wrap.appendChild(
          button("Text", "cum-upf-alt", () => {
            const alt = {
              key: row.key,
              entry: row.entry,
              how: row.entry.textIsOriginal ? "text" : "extract",
              saveAs: U.textFileName(row.entry.name, row.entry.textIsOriginal),
              text: row.entry.text,
            };
            getOne(alt);
          })
        );
      }
    }
    return wrap;
  }

  function draw() {
    const b = build();
    const count = plan.filter((r) => r.saveAs).length;
    const countEl = b.querySelector(".cum-upf-count");
    if (countEl) countEl.textContent = state === "ready" && count ? String(count) : "";
    b.classList.toggle("cum-upf-open", open);
    if (!open || !panel) return;

    panel.textContent = "";
    const head = el("div", "cum-upf-head");
    head.appendChild(el("div", "cum-upf-title", "Files you uploaded"));
    const x = button("×", "cum-upf-x", () => setOpen(false), "Close");
    head.appendChild(x);
    panel.appendChild(head);

    const body = el("div", "cum-upf-body");
    if (state === "loading" && !plan.length) {
      body.appendChild(el("p", "cum-upf-line", "Reading the conversation…"));
    } else if (state === "none") {
      body.appendChild(
        el(
          "p",
          "cum-upf-line",
          !conversationId()
            ? "Open a conversation to see what was uploaded to it."
            : "claude.ai has no record of this conversation — an incognito chat is " +
                "never saved, so there is nothing to fetch its files from."
        )
      );
    } else {
      body.appendChild(el("p", "cum-upf-line", U.describe(uploads)));
      // Cowork is not Chat with a different address. Its uploads have never
      // been confirmed to come back in the payload this reads, so an empty
      // list there is "not found here", not "you uploaded nothing" — which on
      // a session you plainly attached files to would be a flat untruth.
      if (!uploads.length && isCowork())
        body.appendChild(
          el(
            "p",
            "cum-upf-dim",
            "This is a Cowork session, and Cowork keeps its uploads somewhere this " +
              "has not been confirmed to read. Files attached here may not be listed " +
              "even though you sent them."
          )
        );
      if (plan.length) {
        const list = el("div", "cum-upf-list");
        for (const row of plan) list.appendChild(drawRow(row));
        body.appendChild(list);
        const bar = el("div", "cum-upf-bar");
        const gettable = plan.filter((r) => r.saveAs).length;
        if (gettable > 1)
          bar.appendChild(
            button(busy ? "Getting…" : "Download all", "cum-upf-primary", getAll)
          );
        bar.appendChild(button("Refresh", "", () => refresh(true)));
        body.appendChild(bar);
      }
    }
    if (note) body.appendChild(el("p", "cum-upf-note", note));
    panel.appendChild(body);
  }

  // ---- placement -------------------------------------------------------------
  // The tray first, then beside Save wherever Save ended up, then its own
  // corner — the three homes src/key-panel.js had to grow, for the reason it
  // grew them: a control handed to a row that never drew it is a feature that
  // is silently not there.

  let zeroTicks = 0;
  function docked(b) {
    if (!b || !b.isConnected) return false;
    if (C.isVisible(b)) {
      zeroTicks = 0;
      return true;
    }
    return ++zeroTicks < 4;
  }

  function hang() {
    if (!open) return;
    const p = buildPanel();
    p.classList.add("cum-upf-hang");
    if (p.parentElement !== document.body) (document.body || document.documentElement).appendChild(p);
  }

  function besideSave(b) {
    const save = document.getElementById("cum-save-chat");
    if (!save || !save.parentElement || !C.isVisible(save)) return false;
    if (b.parentElement !== save.parentElement || save.nextElementSibling !== b) {
      try {
        save.parentElement.insertBefore(b, save.nextElementSibling);
      } catch (e) {
        return false;
      }
    }
    hang();
    return docked(b);
  }

  function loose(b) {
    b.classList.add("cum-upf-loose");
    if (b.parentElement !== document.body) (document.body || document.documentElement).appendChild(b);
    hang();
  }

  function place() {
    // Only where there is a conversation to have uploaded anything to.
    if (!conversationId()) {
      if (open) setOpen(false);
      if (btn && btn.parentNode) btn.remove();
      if (panel && panel.parentNode) panel.remove();
      return;
    }
    const b = build();
    const T = window.CUMTray;
    if (T) {
      try {
        T.put("files", b, open ? buildPanel() : null);
      } catch (e) {
        /* the two homes below are what that failing means */
      }
      if (docked(b)) {
        b.classList.remove("cum-upf-loose");
        if (panel) panel.classList.remove("cum-upf-hang");
        return;
      }
    }
    if (besideSave(b)) {
      b.classList.remove("cum-upf-loose");
      return;
    }
    loose(b);
  }

  function tick() {
    place();
    if (conversationId()) refresh(false);
  }

  setInterval(tick, TICK_MS);
  tick();
})();
