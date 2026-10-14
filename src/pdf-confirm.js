/**
 * Claude Usage Meter — the PDF question, on screen.
 *
 * The decisions and the words are src/pdfflag.js's; this draws them. One
 * dialog for every door that asks — claude.ai's own upload button, drop and
 * paste (src/pseudo-view.js), the Folder button (src/folder-upload.js), the
 * scheduled-send form and the workflow editor — so the question looks the same
 * wherever a PDF comes in. It carries its own styles because two of those
 * doors live on the options page, where content.css is not loaded.
 *
 * The safe answer is the easy one. Focus starts on Keep it out; Escape and a
 * click outside the box both mean no; only the affirmative button means yes.
 * A question that could be answered yes by a stray keystroke would not be
 * asking.
 */
(function (root) {
  "use strict";

  const STYLE_ID = "cum-pdf-ask-styles";

  // The key guard's dress (content.css, .cum-pseudo-guard), so the two
  // questions a pick can raise read as one family. Above everything, the
  // in-page scheduled-send modal included: that modal is where a PDF is
  // dropped into a send, and a question drawn underneath it is unanswerable.
  const STYLES = `
    .cum-pdf-ask { position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,0.45);
      display:flex; align-items:center; justify-content:center; padding:16px; }
    .cum-pdf-ask-box { background:#fff; color:#1a1a18; border-radius:14px; padding:18px 20px;
      max-width:460px; font:14px/1.5 system-ui, sans-serif; box-shadow:0 8px 30px rgba(0,0,0,0.35);
      overflow-wrap:anywhere; }
    .cum-pdf-ask-head { font-weight:700; font-size:15px; margin-bottom:6px; }
    .cum-pdf-ask-box p { margin:0; }
    .cum-pdf-ask-row { display:flex; gap:10px; justify-content:flex-end; margin-top:12px; flex-wrap:wrap; }
    .cum-pdf-ask-row button { font:inherit; border-radius:9px; padding:6px 14px; cursor:pointer;
      border:1px solid rgba(0,0,0,0.25); background:#f4f3ef; color:inherit; }
    .cum-pdf-ask-row .cum-pdf-ask-keep { font-weight:700; }
    .cum-pdf-ask-row .cum-pdf-ask-go { color:#8a1a1a; }
    @media (prefers-color-scheme: dark) {
      .cum-pdf-ask-box { background:#2a2a28; color:#f0efea; }
      .cum-pdf-ask-row button { background:#1f1f1e; color:#f0efea; border-color:rgba(255,255,255,0.22); }
      .cum-pdf-ask-row .cum-pdf-ask-go { color:#ff9f9f; }
    }`;

  function injectStyles(doc) {
    if (doc.getElementById && doc.getElementById(STYLE_ID)) return;
    const st = doc.createElement("style");
    st.id = STYLE_ID;
    st.textContent = STYLES;
    (doc.head || doc.documentElement).appendChild(st);
  }

  /**
   * Put the question and wait for the answer: true only for the affirmative
   * button. `text` is what CUMPdfFlag.prompt answers — { head, body, keep, go }.
   */
  function ask(doc, text) {
    const d = doc || root.document;
    const t = text || {};
    return new Promise((resolve) => {
      injectStyles(d);
      const view = d.defaultView || root;
      const overlay = d.createElement("div");
      overlay.className = "cum-pdf-ask";
      overlay.setAttribute("role", "alertdialog");
      overlay.setAttribute("aria-modal", "true");
      const box = d.createElement("div");
      box.className = "cum-pdf-ask-box";
      const h = d.createElement("div");
      h.className = "cum-pdf-ask-head";
      h.textContent = t.head || "Upload this PDF?";
      const p = d.createElement("p");
      p.textContent = t.body || "";
      const row = d.createElement("div");
      row.className = "cum-pdf-ask-row";
      const keep = d.createElement("button");
      keep.type = "button";
      keep.className = "cum-pdf-ask-keep";
      keep.textContent = t.keep || "Keep it out";
      const go = d.createElement("button");
      go.type = "button";
      go.className = "cum-pdf-ask-go";
      go.textContent = t.go || "Upload anyway";
      row.append(keep, go);
      box.append(h, p, row);
      overlay.appendChild(box);

      let settled = false;
      // Escape is "no" — and it is THIS dialog's, so it stops here rather than
      // also closing the scheduled-send modal the question is drawn over.
      const onKey = (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        done(false);
      };
      function done(ok) {
        if (settled) return;
        settled = true;
        try {
          view.removeEventListener("keydown", onKey, true);
        } catch (e) {
          /* ignore */
        }
        overlay.remove();
        resolve(ok);
      }
      keep.addEventListener("click", () => done(false));
      go.addEventListener("click", () => done(true));
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) done(false);
      });
      try {
        view.addEventListener("keydown", onKey, true);
      } catch (e) {
        /* the buttons still answer */
      }
      (d.documentElement || d.body).appendChild(overlay);
      try {
        keep.focus();
      } catch (e) {
        /* ignore */
      }
    });
  }

  // What this page has said yes to, so the last door — the send (see
  // CUMPdfFlag.sendAsks) — asks only about a PDF nobody has. Filled at the
  // pick, by the Folder button, and by a yes at the send itself; emptied once a
  // message carrying them has gone, so the next message's PDF of the same name
  // is asked about afresh. In memory and per page: a reload forgets, which
  // errs towards asking.
  const said = { names: [], sig: "" };

  function remember(names) {
    for (const n of names || []) {
      const v = String(n == null ? "" : n).trim();
      if (v && said.names.indexOf(v) === -1) said.names.push(v);
    }
  }

  function rememberSend(sig, names) {
    said.sig = String(sig || "");
    remember(names);
  }

  function confirmed() {
    return { names: said.names.slice(), sig: said.sig };
  }

  function forget() {
    said.names = [];
    said.sig = "";
  }

  root.CUMPdfConfirm = {
    ask: ask,
    remember: remember,
    rememberSend: rememberSend,
    confirmed: confirmed,
    forget: forget,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
