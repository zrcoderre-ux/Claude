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
 * after it. Each flagged name in that refusal can be taken out of its key
 * right there ("Not a real name — remove from key", P.unfakeInLibrary — the
 * same by-hand removal as the composer's right-click, kept on the library
 * entry), and the paste is judged again and goes in when nothing else holds
 * it. Undo puts the name back.
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
    .cum-paste-refused-names { list-style:none; margin:0 0 8px; padding:0; max-height:40vh; overflow:auto; }
    .cum-paste-refused-names li { display:flex; gap:8px; align-items:center; justify-content:space-between; padding:3px 0;
      border-top:1px solid rgba(255,255,255,0.15); }
    .cum-paste-refused-names li span { min-width:0; overflow-wrap:anywhere; }
    .cum-paste-refused-names button { flex:none; font-size:12px; padding:2px 8px; }
    .cum-paste-refused.cum-paste-note { background:#1f4d2e; }
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

  // words: { head, body }; onClean: the pseudonym paste, or null; rows: the
  // flagged names, each { real, fake, onRemove }, listed with a button that
  // takes a wrongly flagged one out of its key.
  function refuse(words, onClean, rows, cleanLabel) {
    close();
    ensureStyles();
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
      clean.textContent = cleanLabel || "Paste with the pseudonyms";
      // The field keeps its caret: the click must not take the focus first.
      clean.addEventListener("mousedown", (e) => e.preventDefault());
      clean.addEventListener("click", () => {
        close();
        onClean();
      });
      row.appendChild(clean);
    }
    box.append(h, p);
    if (rows && rows.length) {
      const ul = document.createElement("ul");
      ul.className = "cum-paste-refused-names";
      for (const r of rows) {
        const li = document.createElement("li");
        const t = document.createElement("span");
        t.textContent = "“" + r.real + "”" + (r.fake ? " → " + r.fake : "");
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Not a real name — remove from key";
        b.title =
          "Flagged in error? Take “" + r.real + "” out of the key: it is no longer faked, warned about or " +
          "translated in this case. The spreadsheet keeps its row; the Key panel can put it back.";
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", () => {
          b.disabled = true;
          r.onRemove();
        });
        li.append(t, b);
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    box.appendChild(row);
    document.documentElement.appendChild(box);
    // A list to work through is not taken away mid-read.
    boxTimer = setTimeout(close, rows && rows.length ? 60000 : 20000);
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = STYLES;
    (document.head || document.documentElement).appendChild(st);
  }

  // A short note after a removal, with Undo.
  function note(text, onUndo) {
    close();
    ensureStyles();
    box = document.createElement("div");
    box.className = "cum-paste-refused cum-paste-note";
    box.setAttribute("role", "status");
    const p = document.createElement("p");
    p.textContent = text;
    const row = document.createElement("div");
    row.className = "cum-paste-refused-row";
    if (onUndo) {
      const u = document.createElement("button");
      u.type = "button";
      u.textContent = "Undo";
      u.addEventListener("mousedown", (e) => e.preventDefault());
      u.addEventListener("click", () => {
        close();
        onUndo();
      });
      row.appendChild(u);
    }
    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = "OK";
    ok.addEventListener("click", close);
    row.appendChild(ok);
    box.append(p, row);
    document.documentElement.appendChild(box);
    boxTimer = setTimeout(close, 15000);
  }

  // Read the library fresh, change it, write it back — another tab or the key
  // panel may have written since this page last read it. Answers the ids
  // changed (empty when nothing was, or the write failed).
  function changeLibrary(how, done) {
    try {
      chrome.storage.local.get(KEYS_STORE, (res) => {
        void chrome.runtime.lastError;
        const lib = (res && res[KEYS_STORE]) || {};
        const r = how(lib);
        if (!r.changed.length) return done([]);
        chrome.storage.local.set({ [KEYS_STORE]: r.library }, () => {
          if (chrome.runtime.lastError) return done([]);
          library = r.library;
          done(r.changed);
        });
      });
    } catch (e) {
      done([]);
    }
  }

  function keyNames(ids) {
    const lib = library || {};
    const label = (id) => (P.keyLabel && lib[id] ? P.keyLabel(lib[id]) : "the key");
    return ids.length === 1 ? label(ids[0]) : ids.length + " keys";
  }

  // Take a wrongly flagged value out of the keys that flagged it, then judge
  // the same paste again: in it goes when nothing else holds it.
  function removeAndRetry(scope, field, text, name) {
    changeLibrary(
      (lib) => P.unfakeInLibrary(lib, name.keyIds, name.real),
      (changed) => {
        if (!changed.length) {
          note("“" + name.real + "” could not be removed from " + keyNames(name.keyIds) + " — nothing was changed.", null);
          return;
        }
        const undo = () =>
          changeLibrary(
            (lib) => {
              const out = Object.assign({}, lib);
              const back = [];
              for (const id of changed) {
                if (!out[id] || !P.refakeKey) continue;
                const k = P.refakeKey(out[id], name.real);
                if (k !== out[id]) {
                  out[id] = k;
                  back.push(id);
                }
              }
              return { library: out, changed: back };
            },
            (back) =>
              note(
                back.length
                  ? "“" + name.real + "” is back in " + keyNames(back) + ". What was pasted stays — check it."
                  : "“" + name.real + "” could not be put back — the Key panel can do it.",
                null
              )
          );
        const said = "“" + name.real + "” is out of " + keyNames(changed) + ": no longer faked, warned about or translated. ";
        const v = P.workflowPasteHold(scope, library, { text: text });
        if (v.hold) return judgeWorkflow(scope, field, text, 0, said);
        if (field && lastCopyRefuses(field, text)) return;
        land(scope, field, text);
        note(said + "Pasted.", undo);
      }
    );
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
  function judgeWorkflow(scope, field, text, files, lead) {
    const v = P.workflowPasteHold(scope, library, { text: text, files: files });
    if (!v.hold) return "pass";
    const words = P.workflowPasteNote(v, scope);
    if (lead) words.body = lead + words.body;
    const onClean =
      v.why === "reals" && v.clean && v.clean.ok && !lastCopyHolds(v.clean.text)
        ? () => land(scope, field, v.clean.text)
        : null;
    const rows =
      v.why === "reals"
        ? (v.names || []).map((n) => ({
            real: n.real,
            fake: n.fake,
            onRemove: () => removeAndRetry(scope, field, text, n),
          }))
        : null;
    refuse(words, onClean, rows);
    return "refused";
  }

  function lastCopyHolds(text) {
    return !!(record && P.copiedPasteHold(record, text).hold);
  }

  // The same notice for the composer's run-chat check (src/pseudo-view.js),
  // so a refused paste reads the same in a run's chat as in its editor.
  window.CUMPasteNotice = { refuse: refuse, note: note, close: close };

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
