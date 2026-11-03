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
 * Fail-open: no record, no pseudonym module, a storage read that never
 * answered — nothing is refused.
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

  let record = null;
  let box = null;
  let boxTimer = null;

  try {
    chrome.storage.local.get(P.LAST_COPY_KEY, (res) => {
      void chrome.runtime.lastError;
      record = (res && res[P.LAST_COPY_KEY]) || null;
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch[P.LAST_COPY_KEY]) record = ch[P.LAST_COPY_KEY].newValue || null;
    });
  } catch (e) {
    /* nothing remembered, nothing refused */
  }

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

  function refuse(field, found, cleaned) {
    close();
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = STYLES;
      (document.head || document.documentElement).appendChild(st);
    }
    const words = P.copiedPasteNote(found);
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
    if (cleaned && cleaned.ok) {
      const clean = document.createElement("button");
      clean.type = "button";
      clean.className = "cum-paste-refused-clean";
      clean.textContent = "Paste with the pseudonyms";
      // The field keeps its caret: the click must not take the focus first.
      clean.addEventListener("mousedown", (e) => e.preventDefault());
      clean.addEventListener("click", () => {
        close();
        insert(field, cleaned.text);
      });
      row.appendChild(clean);
    }
    box.append(h, p, row);
    document.documentElement.appendChild(box);
    boxTimer = setTimeout(close, 20000);
  }

  window.addEventListener(
    "paste",
    (ev) => {
      if (!ev.isTrusted || !record) return;
      const field = editable(ev.target);
      if (!guarded(field)) return;
      const dt = ev.clipboardData;
      const text = dt ? dt.getData("text/plain") || "" : "";
      const v = P.copiedPasteHold(record, text);
      if (!v.hold) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      refuse(field, v.names, P.copiedPasteClean(record, text));
    },
    true
  );
})();
