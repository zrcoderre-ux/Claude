/**
 * Claude Usage Meter — the run forms refuse a paste of the last copy's real
 * names.
 *
 * A copy off a translated chat carries the REAL names, and the page it was
 * made on says so (src/pseudo-view.js, "A copy that carries the real names").
 * The paste that matters is somewhere else: a run's step prompt in the options
 * page, or a scheduled send, filled from the last tentative. Those prompts are
 * sent by the extension as written, so nothing at the composer reads them, and
 * the real names would go to Claude.
 *
 * So the copy is remembered with the real names it carried (P.LAST_COPY_KEY),
 * and a paste into one of those forms that carries any of them is refused
 * before the field takes it, with a notice naming them. "Paste with the
 * pseudonyms" puts the same text in with the fakes instead, where every name
 * has one. A later copy on claude.ai that carried no real names clears it.
 * The decision is P.copiedPasteHold (tested); this is the wiring.
 *
 * Where it guards: every text field on the options page, and on claude.ai the
 * extension's own run and scheduled-send forms (`.cumjf`, `.cumwf`) and the
 * run margin's step editor. Never the composer, which has its own paste check,
 * and never the key panel's cleaner, where pasting real names is the point.
 *
 * A WORKFLOW asks more (P.workflowPasteHold, tested): nothing is pasted into
 * one until there is a pseudonym key to read the paste against — the run's
 * own key, or for a template, which is no case's, any key in the library —
 * and then a paste carrying that key's real values is refused, with the same
 * "Paste with the pseudonyms". That covers every box in the workflow editor
 * (`.cumwf`, which says which key it is under in `data-cum-paste-key` and
 * `data-cum-paste-mode`), text pasted onto it to become a document, files
 * pasted onto it, and the run margin's prompt and matter-name boxes
 * (`data-cum-paste-key` on the margin). The last-copy check above still runs
 * after it.
 *
 * Fail-open for the last copy: no record, no pseudonym module, a storage read
 * that never answered — nothing is refused. Not for the workflow's key: a
 * paste before the library has been read waits for it, and a library that
 * cannot be read is no key, so the paste is refused and says so.
 */
(function () {
  "use strict";

  const P = window.CUMPseudo;
  if (!P || !P.copiedPasteHold || !P.LAST_COPY_KEY) return;

  const ON_OPTIONS = location.protocol === "chrome-extension:";
  const FORM_SEL = ".cumjf, .cumwf, .cum-rm-editprompt";
  const STYLE_ID = "cum-paste-refused-styles";
  // Its own dress, since the options page does not load content.css.
  const STYLES = `
    .cum-paste-refused { position:fixed; z-index:2147483647; left:50%; bottom:24px; transform:translateX(-50%);
      max-width:min(560px, calc(100vw - 32px)); box-sizing:border-box; padding:12px 14px; border-radius:12px;
      background:#7a1f1f; color:#fff; border:1px solid rgba(255,255,255,0.25);
      font:13.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow:0 8px 30px rgba(0,0,0,0.35); }
    .cum-paste-refused-head { font-weight:700; margin:0 0 4px; }
    .cum-paste-refused p { margin:0 0 8px; }
    .cum-paste-refused-row { display:flex; gap:8px; justify-content:flex-end; }
    .cum-paste-refused button { font:inherit; color:inherit; cursor:pointer; border-radius:8px; padding:4px 12px;
      background:rgba(255,255,255,0.14); border:1px solid rgba(255,255,255,0.3); }
    .cum-paste-refused button.cum-paste-refused-clean { background:#fff; color:#7a1f1f; font-weight:700; border-color:#fff; }
  `;

  const WF_FIELDS = ".cum-rm-editprompt, .cum-rm-editname";
  // The popup's key library (src/popup.js, KEYS_KEY).
  const KEYS_STORE = "cum_pseudo_keys";

  let record = null;
  let library; // undefined until the first read answers
  let box = null;
  let boxTimer = null;

  function readLibrary(done) {
    try {
      chrome.storage.local.get(KEYS_STORE, (res) => {
        void chrome.runtime.lastError;
        library = (res && res[KEYS_STORE]) || {};
        if (done) done();
      });
    } catch (e) {
      library = {};
      if (done) done();
    }
  }

  try {
    chrome.storage.local.get(P.LAST_COPY_KEY, (res) => {
      void chrome.runtime.lastError;
      record = (res && res[P.LAST_COPY_KEY]) || null;
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch[P.LAST_COPY_KEY]) record = ch[P.LAST_COPY_KEY].newValue || null;
      if (ch[KEYS_STORE]) library = ch[KEYS_STORE].newValue || {};
    });
  } catch (e) {
    /* nothing remembered, nothing refused */
  }
  if (P.workflowPasteHold) readLibrary();

  function editable(el) {
    if (!el || el.nodeType !== 1) return null;
    const f = el.closest('textarea, input, [contenteditable=""], [contenteditable="true"]');
    if (!f) return null;
    if (f.tagName === "INPUT" && !/^(text|search|url|)$/i.test(f.type || "")) return null;
    return f;
  }

  function guarded(field) {
    if (!field) return false;
    if (ON_OPTIONS) return true;
    return !!field.closest(FORM_SEL);
  }

  /**
   * Which workflow a paste lands in, and under which key — or null when it is
   * not a workflow's. `doc` is set for a paste onto the run editor that isn't
   * into a box, which the editor turns into a document.
   */
  function workflowScope(target, field) {
    const el = target && target.nodeType === 1 ? target : target && target.parentElement;
    if (!el || !P.workflowPasteHold) return null;
    const form = el.closest(".cumwf");
    if (form && !form.hidden) {
      const mode = form.dataset.cumPasteMode === "template" ? "template" : "run";
      const scope = { mode: mode, keyId: form.dataset.cumPasteKey || "", form: form, doc: false };
      if (field) return scope;
      // A select, a number box: nothing a paste goes into.
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return null;
      // Onto the editor itself: a document, but only while the papers show.
      if (mode !== "run") return null;
      const docs = form.querySelector(".cumwf-docs-row");
      if (docs && docs.hidden) return null;
      scope.doc = true;
      return scope;
    }
    const f = field && field.closest(WF_FIELDS);
    if (f) {
      const host = f.closest("[data-cum-paste-key]");
      return { mode: "run", keyId: (host && host.dataset.cumPasteKey) || "", form: null, doc: false };
    }
    return null;
  }

  function close() {
    if (box) box.remove();
    box = null;
    clearTimeout(boxTimer);
  }

  function insert(field, text) {
    field.focus();
    // The field's own typing path, so its listeners see an input and Ctrl+Z
    // takes it back out.
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch (e) {
      ok = false;
    }
    if (!ok && "value" in field && typeof field.setRangeText === "function") {
      field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // Where a paste the guard let through goes: into the box, or for a paste
  // onto the run editor, to the editor as a document.
  function land(scope, field, text) {
    if (field) return insert(field, text);
    if (scope && scope.form)
      scope.form.dispatchEvent(new CustomEvent("cum-wf-paste-doc", { detail: { text: text } }));
  }

  // words: { head, body }; clean: { label, text } or null.
  function refuse(words, onClean) {
    close();
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = STYLES;
      (document.head || document.documentElement).appendChild(st);
    }
    box = document.createElement("div");
    box.className = "cum-paste-refused";
    box.setAttribute("role", "alert");
    const h = document.createElement("div");
    h.className = "cum-paste-refused-head";
    h.textContent = words.head;
    const p = document.createElement("p");
    p.textContent = words.body;
    const row = document.createElement("div");
    row.className = "cum-paste-refused-row";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = "Don't paste";
    ok.addEventListener("click", close);
    row.appendChild(ok);
    if (onClean) {
      const clean = document.createElement("button");
      clean.type = "button";
      clean.className = "cum-paste-refused-clean";
      clean.textContent = "Paste with the pseudonyms";
      // The field keeps its caret: the click must not take the focus first.
      clean.addEventListener("mousedown", (e) => e.preventDefault());
      clean.addEventListener("click", () => {
        close();
        onClean();
      });
      row.appendChild(clean);
    }
    box.append(h, p, row);
    document.documentElement.appendChild(box);
    boxTimer = setTimeout(close, 20000);
  }

  // The last copy's names, for a box the run forms guard. True when refused.
  function lastCopyRefuses(field, text) {
    if (!record || !guarded(field)) return false;
    const v = P.copiedPasteHold(record, text);
    if (!v.hold) return false;
    const cleaned = P.copiedPasteClean(record, text);
    refuse(P.copiedPasteNote(v.names), cleaned && cleaned.ok ? () => insert(field, cleaned.text) : null);
    return true;
  }

  // The workflow's own key. Answers "refused", "pass", or "landed" (the
  // guard put the paste in itself, after waiting for the library).
  function judgeWorkflow(scope, field, text, files) {
    const v = P.workflowPasteHold(scope, library, { text: text, files: files });
    if (!v.hold) return "pass";
    const words = P.workflowPasteNote(v, scope);
    const onClean =
      v.why === "reals" && v.clean && v.clean.ok && !lastCopyHolds(v.clean.text)
        ? () => land(scope, field, v.clean.text)
        : null;
    refuse(words, onClean);
    return "refused";
  }

  function lastCopyHolds(text) {
    return !!(record && P.copiedPasteHold(record, text).hold);
  }

  window.addEventListener(
    "paste",
    (ev) => {
      if (!ev.isTrusted) return;
      const field = editable(ev.target);
      const dt = ev.clipboardData;
      let text = "";
      try {
        text = (dt && typeof dt.getData === "function" && dt.getData("text/plain")) || "";
      } catch (e) {
        text = "";
      }
      const files = dt && dt.files ? dt.files.length || 0 : 0;
      const scope = workflowScope(ev.target, field);
      if (scope) {
        if (library === undefined) {
          // The library hasn't answered yet: hold the paste until it has,
          // then judge it as if it had just arrived. Files can't be handed
          // back, so they are refused for now.
          ev.preventDefault();
          ev.stopImmediatePropagation();
          if (files && !text) {
            refuse({ head: "Not pasted — the keys are still loading", body: "Paste the files again in a moment." }, null);
            return;
          }
          readLibrary(() => {
            if (judgeWorkflow(scope, field, text, 0) !== "pass") return;
            if (field && lastCopyRefuses(field, text)) return;
            land(scope, field, text);
          });
          return;
        }
        if (judgeWorkflow(scope, field, text, files) === "refused") {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          return;
        }
      }
      if (!field || !text) return;
      if (lastCopyRefuses(field, text)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    },
    true
  );
})();
