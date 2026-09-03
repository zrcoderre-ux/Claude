/**
 * Claude Usage Meter — the key button, beside Save (ISOLATED world).
 *
 * Everything the pseudonym feature needs, on the page, in one control: a key
 * to the LEFT of Save — in the tray beside claude.ai's own sidebar toggle where
 * that row exists, beside Save wherever else Save has ended up if it doesn't,
 * and its own corner failing both — with a panel holding what used to be two
 * separate things.
 *
 * Three homes because the first version had one and no way of telling whether
 * it had worked: it handed the button to the tray and returned, and when the
 * button did not appear there was no error, no fallback and nothing on screen.
 * A control the operator has no other way to reach must not have a path where
 * it quietly does not exist — so place() now CHECKS, and every module this
 * file reads except the two it cannot draw without is optional, because a
 * missing section is a sentence the panel can say and a missing button is not.
 *
 *   WHAT THE FLOATING BADGE SAID. Which case this tab is translating, how many
 *   names and titles are showing in the real values, whether a run is holding
 *   the messages, the peek that puts the fakes back, and the cleaner. That
 *   badge was a draggable lozenge sitting over claude.ai's page — one more
 *   thing to move out of the way of the thing you were reading — and it is
 *   gone.
 *
 *   WHAT THE POPUP DOES. Load a pseudonym_key.xlsx, attach it to this chat,
 *   detach it, forget it, and see (or empty) the master key. The popup keeps
 *   all of it: this is an alternative to reaching for it, not a replacement,
 *   because the popup is also where you go when the page will not load.
 *
 *   AND THE KEY FILE BACK. The workbook a key was loaded from is kept beside
 *   the library (src/keyfile.js) and handed back by the download button here —
 *   the bytes that were loaded, never a rebuild from the stored rows, because
 *   the rows are what the parser could read and the file was more than that.
 *
 * THE BUTTON CARRIES THE COUNT, and that is not decoration. The badge existed
 * for one invariant — a real name on screen always has something on screen
 * saying why — and a panel that has to be opened would have quietly ended it.
 * So the button reads "12" while twelve values are showing, goes quiet when
 * nothing is translated, and says so plainly when a peek or a run has the
 * display standing down.
 *
 * And it is COLOURED if and only if real names are on screen. That is the same
 * invariant turned into something you do not have to read: colour means this
 * page is not saying what claude.ai says, black and white means it is. A peek
 * and a run's hold are therefore monochrome like the off state — in both of
 * them the page is showing the fakes — and are told apart by the word on the
 * button rather than by a second colour that would dilute the first.
 *
 * The decisions it renders are not here. src/pseudo-view.js owns the keys, the
 * sweep and the peek, and publishes state()/clean()/setPaused()/subscribe();
 * src/pseudo.js owns what a key IS; src/masterkey.js owns the distilled cases.
 * This file is the button, the panel, and the storage writes the popup's own
 * controls make — written the same way, against the same keys, so a change
 * made here and a change made there are the same change.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  const P = window.CUMPseudo;
  const X = window.CUMXlsx;
  const V = window.CUMPseudoView;
  const M = window.CUMMasterKey;
  const KF = window.CUMKeyFile;
  // Only the two this file cannot draw a single thing without. X (the workbook
  // reader), V (the live translation state) and M (the master key) are each
  // one SECTION of the panel, and a missing section is a sentence the panel
  // can say — where a missing BUTTON is nothing at all, on a page where the
  // operator has no other way to reach the key from. Requiring all five was a
  // fifth way for this control to not exist without explaining itself.
  if (!C || !P) return;

  const BTN_ID = "cum-key-btn";
  const PANEL_ID = "cum-key";
  const KEYS_KEY = "cum_pseudo_keys";
  const CHATS_KEY = "cum_pseudo_chats";
  const MASTER_KEY = "cum_pseudo_master";
  // The loaded workbooks themselves, beside the library rather than inside it
  // (src/keyfile.js says why). Read here so the panel can hand one back.
  const FILES_KEY = (KF && KF.FILES_KEY) || "cum_pseudo_keyfiles";
  const TICK_MS = 1200;

  let btn = null;
  let panel = null;
  let fileInput = null;
  let open = false;
  let state = { on: false, names: 0, titles: 0, paused: false, hold: null };
  let lastKeyId = null; // so a change of case empties the cleaner's boxes
  let selectEl = null; // this draw's key picker, where there is one

  let keys = {};
  let chats = {};
  let master = null;
  let keyFiles = {};
  let note = ""; // the last thing that happened, said in the panel

  // ---- storage ---------------------------------------------------------------
  //
  // Read, and say whether the read HAPPENED, for the same reason src/dropdir.js
  // and the Folder button do: an empty answer and a failed read are the same
  // shape and must never be the same sentence.

  function get(what) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(what, (res) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, data: {} });
          resolve({ ok: true, data: res || {} });
        });
      } catch (e) {
        resolve({ ok: false, data: {} });
      }
    });
  }

  function set(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => {
          void chrome.runtime.lastError;
          resolve(true);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function load() {
    const res = await get([KEYS_KEY, CHATS_KEY, MASTER_KEY, FILES_KEY]);
    keys = res.data[KEYS_KEY] || {};
    chats = res.data[CHATS_KEY] || {};
    master = res.data[MASTER_KEY] || null;
    keyFiles = res.data[FILES_KEY] || {};
    draw();
  }

  /**
   * The conversation this tab IS, in the spelling every reader uses — and ""
   * on a page that is not a conversation.
   *
   * The strict one, deliberately: everything this panel does with it is a
   * WRITE. A key attached to "/new" is a key attached to every new page ever
   * opened, and the next matter's blank composer would come up wearing the
   * last one's names.
   */
  function convKey() {
    if (P.conversationFromUrl) return P.conversationFromUrl(location.href);
    const W = window.CUMWorkflow;
    return W && W.conversationKey
      ? W.conversationKey(location.href)
      : P.conversationKeyFromUrl(location.href);
  }

  const keyLabel = (k) => (P.keyLabel ? P.keyLabel(k) : (k && k.name) || "key");

  // ---- the button ------------------------------------------------------------

  function build() {
    if (btn && btn.isConnected) return btn;
    btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    // A drawn key rather than the 🔑 emoji the badge used: an emoji is a colour
    // bitmap sitting among claude.ai's own line icons, and beside the Folder
    // button's drawn mark it would look exactly like what it was.
    btn.innerHTML =
      '<span class="cum-key-ico" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/>' +
      '<path d="m17 6 3 3"/></svg></span>' +
      '<span class="cum-key-txt">Key</span>' +
      '<span class="cum-key-count"></span>';
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
    if (open) load();
    place();
    draw();
  }

  // ---- the panel -------------------------------------------------------------

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, cls, onClick) {
    const b = el("button", "cum-key-b " + (cls || ""), label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function buildPanel() {
    if (panel && panel.isConnected) return panel;
    panel = el("div", "cum-key-panel");
    panel.id = PANEL_ID;
    return panel;
  }

  function say(text) {
    note = text || "";
    draw();
  }

  // ---- what the display is doing --------------------------------------------

  /**
   * The badge's own sentence, rebuilt from the state it used to render.
   *
   * A HALF stand-down is a real state and has to read like one: a run holding
   * this chat shows the fakes in the MESSAGES while the titles keep their real
   * names, and "showing the fakes" over a title that plainly isn't was the
   * badge's worst line before it learned to say which was which.
   */
  function statusLine(st) {
    if (!st.on) return "Nothing on this page is translated.";
    const bits = [];
    if (st.names) bits.push(st.names + " name" + (st.names === 1 ? "" : "s"));
    if (st.titles) bits.push(st.titles + " title" + (st.titles === 1 ? "" : "s"));
    const titles = st.titles
      ? " The titles keep their real names — " + st.titles + " of them."
      : "";
    if (st.hold)
      return (
        "The messages show the fakes while " +
        (st.hold.name ? "“" + st.hold.name + "”" : "a run") +
        " is running" +
        (st.hold.via === "key" ? " on this matter" : "") +
        "." +
        titles
      );
    if (st.paused) return "Paused — this page is showing exactly what claude.ai renders." + titles;
    // Nothing is attached here: what is lit is the chat names in the lists
    // being read back, not a key on this page. Said plainly, because the two
    // are different facts and only one of them can be true on a page that is
    // not a conversation at all.
    if (st.attached === false)
      return bits.length
        ? bits.join(" and ") +
            " read back in the lists on this page. No key is attached to this page itself."
        : "No key is attached to this page.";
    return bits.length
      ? bits.join(" and ") + " restored to the real values on this page."
      : "This key is on, and nothing on this page has matched it yet.";
  }

  function drawStatus(st) {
    const box = el("div", "cum-key-status");
    const head = el("div", "cum-key-case");
    head.textContent = st.on ? st.name : "No key is translating this page";
    box.appendChild(head);
    box.appendChild(el("p", "cum-key-line", statusLine(st)));
    if (st.on && st.master)
      box.appendChild(
        el(
          "p",
          "cum-key-line cum-key-dim",
          "That is the master key — the last " +
            (st.caseCount || 0) +
            " cases, distilled from every key you have loaded. It answers only where " +
            "no loaded key claims a title, and it never touches a message."
        )
      );
    // The peek. A run's hold is not the user's to lift here: the button says
    // which run and what ends it, because pausing that run is one click and is
    // exactly what the rule is waiting for.
    const peek = button(
      st.hold
        ? "Held while a run works"
        : st.paused
        ? "Show the real names"
        : "Show the fakes",
      "cum-key-peek",
      () => V && V.setPaused(!state.paused)
    );
    peek.disabled = !!st.hold || !st.on;
    peek.title = st.hold
      ? "A run's hand-off can fall back to the text on screen, so real names in a " +
        "message could reach the next chat. Pause the run — or let it finish, hold " +
        "or fail — and the real names come back by themselves."
      : "Pause or resume this page's translation — messages AND titles, since a peek " +
        "is for seeing the page exactly as claude.ai renders it. This tab only, and " +
        "never remembered.";
    box.appendChild(peek);
    return box;
  }

  // ---- this chat -------------------------------------------------------------

  function rekey(keyId, done) {
    const conv = convKey();
    if (!conv) return done(false);
    // A chat that belongs to a RUN is part of a case, and a case has one key:
    // the worker owns that write so the run, its group and their chats all
    // follow. A chat no run owns gets the plain per-chat attachment. Exactly
    // what the popup does, and deliberately the same message.
    let answered = false;
    const fallback = async () => {
      if (answered) return;
      answered = true;
      if (keyId) chats[conv] = keyId;
      else delete chats[conv];
      await set({ [CHATS_KEY]: chats });
      done(true, 0);
    };
    try {
      chrome.runtime.sendMessage(
        { type: "cum-pseudo-rekey", conv: conv, keyId: keyId },
        (res) => {
          void chrome.runtime.lastError;
          if (res && res.ok && res.runs) {
            answered = true;
            load();
            return done(true, res.runs);
          }
          fallback();
        }
      );
    } catch (e) {
      fallback();
    }
  }

  function drawChat() {
    const box = el("div", "cum-key-sec");
    selectEl = null;
    const conv = convKey();
    const ids = Object.keys(keys);
    const attached = conv ? chats[conv] : null;
    box.appendChild(el("div", "cum-key-h", "This conversation"));
    box.appendChild(
      el(
        "p",
        "cum-key-line",
        !conv
          ? "This page is not a conversation — open a chat or a Cowork session to attach a key to it."
          : attached && keys[attached]
          ? "Attached: " + keyLabel(keys[attached])
          : ids.length
          ? "No key attached here."
          : "No key loaded yet."
      )
    );
    // The last few, newest first — and whatever is attached here, whatever its
    // age, or the select could not show its own current value.
    const offered = P.recentKeys ? P.recentKeys(keys, { keep: attached }) : ids;
    if (offered.length > 1) {
      const sel = el("select", "cum-key-select");
      for (const id of offered) {
        const opt = el("option", null, keyLabel(keys[id]));
        opt.value = id;
        sel.appendChild(opt);
      }
      const hidden = P.hiddenKeyCount ? P.hiddenKeyCount(keys, offered) : 0;
      if (hidden) {
        // Said, never just dropped. A list quietly missing nine of its twelve
        // entries is a list that has lied about what the library holds.
        const more = el("option", null, "… " + hidden + " older " + (hidden === 1 ? "key" : "keys") + " not shown");
        more.disabled = true;
        sel.appendChild(more);
      }
      if (attached && keys[attached]) sel.value = attached;
      sel.id = "cum-key-select";
      selectEl = sel;
      box.appendChild(sel);
    }
    const row = el("div", "cum-key-row");
    const attach = button("Attach to this chat", "cum-key-primary", () => {
      const id = selectedKeyId();
      if (!id) return;
      rekey(id, (ok, runs) =>
        say(
          !ok
            ? "Could not attach it here."
            : runs
            ? "Attached to this case — " + runs + " run(s) and all their chats follow."
            : "Attached — this chat now reads back in the real names."
        )
      );
    });
    attach.disabled = !conv || !ids.length;
    row.appendChild(attach);
    if (attached)
      row.appendChild(
        button("Detach", "", () =>
          rekey(null, (ok, runs) =>
            say(
              !ok
                ? "Could not detach it."
                : runs
                ? "Detached from this case — " + runs + " run(s) and all their chats follow."
                : "Detached — reload to see the fakes again."
            )
          )
        )
      );
    box.appendChild(row);
    return box;
  }

  // ---- the workbook itself ---------------------------------------------------

  /**
   * Keep the bytes that were loaded, under the library id they became. Says
   * whether it happened: a file too big to keep is a key that still works,
   * minus the download, and the panel would rather say that than let the
   * button appear and then do nothing.
   */
  async function rememberFile(id, bytes, name) {
    if (!KF) return { ok: false, why: "the key-file store isn't loaded on this page" };
    const made = KF.fileRecord(bytes, name, Date.now());
    if (!made.ok) return made;
    const res = await get([FILES_KEY]);
    const files = KF.putFile(res.data[FILES_KEY] || {}, id, made.record);
    const wrote = await set({ [FILES_KEY]: files });
    if (!wrote) return { ok: false, why: "the write didn't go through" };
    keyFiles = files;
    return { ok: true };
  }

  /**
   * Hand a stored workbook back. The same anchor-and-blob save src/save-chat.js
   * and src/up-files.js use, in the same world, for the same reason: the page's
   * CSP does not reach in here.
   */
  function downloadFile(id) {
    const rec = KF && KF.fileFor(keyFiles, id);
    if (!rec)
      return say(
        KF
          ? KF.describeFile(null, keyLabel(keys[id]))
          : "The key-file store isn't loaded on this page, so nothing can be handed back."
      );
    let url = "";
    try {
      const blob = new Blob([KF.base64ToBytes(rec.b64)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      url = URL.createObjectURL(blob);
      const a = el("a");
      a.href = url;
      a.download = KF.saveAsName(rec);
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      return say("Couldn't save that file: " + String((e && e.message) || e));
    }
    setTimeout(() => URL.revokeObjectURL(url), 6000);
    say("Saved " + KF.saveAsName(rec) + " — the key for " + keyLabel(keys[id]) + ".");
  }

  // ---- the library -----------------------------------------------------------

  /**
   * One spreadsheet, parsed and filed. `folder` is the case folder it was
   * picked out of, where there was one — which is what the key ends up CALLED
   * everywhere it appears.
   */
  async function loadKeyFile(file, folder) {
    if (!file) return false;
    if (!X || !X.parseXlsx) {
      say("The workbook reader isn't loaded on this page — load the key from the popup.");
      return false;
    }
    let wb;
    let bytes = null;
    try {
      const buf = await file.arrayBuffer();
      // Read ONCE. A File is a handle on something that can be moved or
      // rewritten between two reads, and the workbook this panel keeps has to
      // be the workbook it parsed, not whatever is at that path a moment later.
      // A COPY, not a view: the reader is free to do what it likes with the
      // buffer it was handed, and a workbook that came back empty because
      // something downstream detached it would be a download nobody could
      // explain.
      bytes = new Uint8Array(buf.slice(0));
      wb = await X.parseXlsx(buf);
    } catch (e) {
      return false; // unreadable is not a key; the caller says what it found
    }
    if (!wb || !(P.isKeyFileName(file.name) || P.sheetsLookLikeKey(wb.sheets))) return false;
    const key = P.parseKey(wb.sheets, file.name);
    if (!key || !key.rows) return false;
    // Content decides identity, never the filename — every case's key is named
    // pseudonym_key.xlsx, and a filename as the library id would silently
    // replace the first case with the second.
    const where = P.libraryIdFor(keys, key);
    key.savedAt = Date.now();
    if (folder) key.folder = folder;
    // A refresh keeps what the entry already learned, since a file re-picked
    // from somewhere else cannot know the folder that first named it.
    keys[where.id] = P.keepKeyFacts ? P.keepKeyFacts(keys[where.id], key) : key;
    await set({ [KEYS_KEY]: keys });
    // ...and the workbook itself, so the panel can hand it back. A refresh
    // replaces the stored file with the one just read: the library entry is
    // now that file's rows, and a download that gave back the PREVIOUS
    // workbook would be a key that doesn't match what this tab is translating
    // with. Kept separately from the rows, and never fatal — a file too big to
    // keep is a key that still works, minus the download.
    const kept = await rememberFile(where.id, bytes, file.name);
    const d = key.dropped || {};
    say(
      (where.refreshed ? "Refreshed " : "Loaded ") +
        keyLabel(keys[where.id]) +
        (d.keeps ? " · " + d.keeps + " keep rows skipped" : "") +
        (d.ambiguous ? " · " + d.ambiguous + " ambiguous fakes retired" : "") +
        (kept.ok ? "" : " · the file itself isn't kept (" + kept.why + ")")
    );
    load();
    return true;
  }

  /**
   * A CASE FOLDER is picked and only its key is taken.
   *
   * Every case's key file is named pseudonym_key.xlsx, so the file itself
   * cannot say which matter it is — which is why a key loaded loose has only
   * its "case hint" to be called by, and why a picker full of them reads as a
   * list of the same thing. The folder around it is the matter's own name, in
   * the operator's own filing, and it is the same name the run editor's picker,
   * the runs list, the tab group and this panel all use.
   *
   * Nothing else in that folder is opened, uploaded or looked at beyond the
   * spreadsheets: the papers are the Folder button's business
   * (src/folder-upload.js), and this is the key's.
   */
  async function loadFromFolder(list) {
    const DD = window.CUMDropDir;
    if (!DD || !DD.keyFolder) return say("The folder reader isn't loaded on this page.");
    // Scanned without the ordinary cap: the key can sit anywhere under the
    // matter, and 300 files into the originals is not far enough in.
    const scan = DD.fromPicked(list, { maxFiles: DD.MAX_SCAN });
    const found = DD.keyFolder(scan.files);
    if (!found.keys.length)
      return say(
        "No spreadsheet in " + (found.root || "that folder") + " — a pseudonym key is an .xlsx."
      );
    say("Reading the key in " + (found.root || "that folder") + "…");
    // In the order the folder holds them, stopping at the first REAL one: a
    // spreadsheet that isn't a key is not an error here, it just isn't a key.
    for (const k of found.keys) {
      if (await loadKeyFile(k.file, found.root)) return;
    }
    say(
      "Nothing in " +
        (found.root || "that folder") +
        " read as a pseudonym key — no Real Value / Replacement sheet in any of its " +
        found.keys.length +
        " spreadsheet" +
        (found.keys.length === 1 ? "" : "s") +
        "."
    );
  }

  function pickFolder() {
    if (!fileInput || !fileInput.isConnected) {
      fileInput = el("input");
      // C.isOurs — the key-upload guard has to leave our own picker alone, or
      // the one door that exists for loading a key would refuse to load one.
      fileInput.id = "cum-key-file";
      fileInput.type = "file";
      fileInput.multiple = true;
      fileInput.setAttribute("webkitdirectory", "");
      fileInput.setAttribute("directory", "");
      fileInput.style.display = "none";
      fileInput.addEventListener("change", () => {
        const list = Array.from(fileInput.files || []);
        fileInput.value = "";
        if (list.length) loadFromFolder(list);
      });
      (document.body || document.documentElement).appendChild(fileInput);
    }
    fileInput.click();
  }

  /** The first key any picker in this panel would be offering right now. */
  function offeredFirst() {
    const conv = convKey();
    const attached = (conv && chats[conv]) || "";
    const offered = P.recentKeys ? P.recentKeys(keys, { keep: attached }) : Object.keys(keys);
    return offered[0] || "";
  }

  /**
   * The key every control in this panel is talking about — read at the moment
   * it is needed, because the picker is a live control and the panel is not
   * redrawn when it changes.
   *
   * The picker's own value first, then what this chat is attached to (which is
   * what the picker SHOWS when it is drawn), then the first key it would
   * offer. Attach, Forget and Download all ask this one question, so no two of
   * them can ever act on different keys.
   */
  function selectedKeyId() {
    const sel = (selectEl && selectEl.isConnected && selectEl) ||
      (panel && panel.querySelector("#cum-key-select"));
    if (sel && sel.value && keys[sel.value]) return sel.value;
    const conv = convKey();
    const attached = (conv && chats[conv]) || "";
    if (attached && keys[attached]) return attached;
    return offeredFirst();
  }

  function drawLibrary() {
    const box = el("div", "cum-key-sec");
    const ids = Object.keys(keys);
    box.appendChild(el("div", "cum-key-h", "Key library"));
    box.appendChild(
      el(
        "p",
        "cum-key-line",
        ids.length
          ? ids.length +
              (ids.length === 1 ? " key loaded." : " keys loaded.") +
              (ids.length > (P.RECENT_KEYS || 3)
                ? " The picker offers the " + (P.RECENT_KEYS || 3) + " most recent."
                : "")
          : "Nothing loaded. A key is parsed here and never uploaded."
      )
    );
    box.appendChild(
      el(
        "p",
        "cum-key-line cum-key-dim",
        "Pick the case FOLDER — only its pseudonym_key.xlsx is read, and the folder's " +
          "name is what the key is called from then on. A loose key file loads from the " +
          "extension popup."
      )
    );
    // A key the worker could not re-read under the current parser still
    // translates — by the rules that were wrong — so the cases it covers are
    // named here rather than left to read back in fakes with nothing on screen
    // saying why. See background.js, reparseKeys.
    const staleSaid = P.staleNote ? P.staleNote(keys) : "";
    if (staleSaid) box.appendChild(el("p", "cum-key-line cum-key-warn-text", staleSaid));
    const row = el("div", "cum-key-row");
    // A FOLDER rather than the file. Every case's key is named
    // pseudonym_key.xlsx, so the file cannot say which matter it is — the
    // folder around it can, and a key that knows its case folder is a key the
    // picker, the runs list and the tab group can all call by the matter's own
    // name. Only the key is read: nothing in that folder is uploaded, opened
    // or looked at beyond the one spreadsheet.
    row.appendChild(button("Load key from case folder…", "", pickFolder));
    // Give the loaded workbook back. What this panel stores is the ROWS, which
    // is less than the file was (parseKey drops keep rows and ambiguous
    // fakes), so this hands back the bytes that were loaded or it says it
    // cannot — it never rebuilds a spreadsheet that would look like the
    // original while quietly holding less than it.
    if (ids.length) {
      const down = button("Download key file", "", () => downloadFile(selectedKeyId()));
      const fileLine = el("p", "cum-key-line cum-key-dim", "");
      const refresh = () => {
        const id = selectedKeyId();
        const rec = KF ? KF.fileFor(keyFiles, id) : null;
        fileLine.textContent = KF
          ? KF.describeFile(rec, keyLabel(keys[id]))
          : "The key-file store isn't loaded on this page, so nothing can be handed back.";
        down.disabled = !rec;
        down.title = rec
          ? "Save " + KF.saveAsName(rec) + " again — the file this key was loaded from"
          : "Nothing kept for this key — load it once more and it will be";
      };
      refresh();
      // The picker is live and the panel is not redrawn when it moves, so the
      // sentence and the button follow it rather than describing whichever key
      // happened to be chosen when this was drawn.
      if (selectEl) selectEl.addEventListener("change", refresh);
      row.appendChild(down);
      box.appendChild(fileLine);
      row.appendChild(
        button("Forget key", "cum-key-warn", async () => {
          const id = selectedKeyId();
          if (!id) return;
          delete keys[id];
          for (const conv of Object.keys(chats)) if (chats[conv] === id) delete chats[conv];
          // The workbook goes with it. "Forget this case" that left the file
          // it was loaded from sitting in storage would not be forgetting it.
          keyFiles = KF ? KF.dropFiles(keyFiles, [id]) : keyFiles;
          await set({ [KEYS_KEY]: keys, [CHATS_KEY]: chats, [FILES_KEY]: keyFiles });
          say("Forgotten, and detached everywhere it was attached.");
          load();
        })
      );
    }
    box.appendChild(row);
    return box;
  }

  // ---- the master key --------------------------------------------------------

  function drawMaster() {
    if (!M) return null;
    const box = el("div", "cum-key-sec");
    const list = M.caseList(master);
    box.appendChild(el("div", "cum-key-h", "Master key"));
    box.appendChild(el("p", "cum-key-line", M.describe(master)));
    if (list.length) {
      const ul = el("ul", "cum-key-cases");
      for (const c of list.slice(0, 6)) ul.appendChild(el("li", null, c.real || c.caseNo));
      if (list.length > 6) ul.appendChild(el("li", "cum-key-dim", "…and " + (list.length - 6) + " more"));
      box.appendChild(ul);
      // A case held here after its key left the library can never be distilled
      // again — rebuild() walks the library, and there is nothing left to read.
      // So a reader fix reaches every case whose key is still loaded and no
      // others, and the ones it could not reach are named rather than left
      // translating a Recents row by rules that were wrong.
      const behind = M.staleCases ? M.staleCases(master) : [];
      if (behind.length)
        box.appendChild(
          el(
            "p",
            "cum-key-line cum-key-warn-text",
            (behind.length === 1 ? "One case here was" : behind.length + " cases here were") +
              " distilled by an older reader and their keys have left the library, so they " +
              "could not be re-read: " +
              behind.map((c) => c.real).join(", ") +
              ". Load that case's pseudonym_key.xlsx once and it is corrected."
          )
        );
      box.appendChild(
        button("Empty the master key", "cum-key-warn", async () => {
          // Emptied outright rather than case by case: this is the "take the
          // real case names off this machine" control, and one that made you do
          // it twenty times would not be that.
          master = M.clear(master, Date.now());
          await set({ [MASTER_KEY]: master });
          say("Emptied. Recents goes back to the fakes for any case whose key isn't loaded.");
          load();
        })
      );
    }
    return box;
  }

  // ---- the cleaner -----------------------------------------------------------

  function drawCleaner(st) {
    if (!st.on || !st.canClean) return null;
    const box = el("div", "cum-key-sec");
    box.appendChild(el("div", "cum-key-h", "Pseudonymize for pasting"));
    const input = el("textarea", "cum-key-in");
    input.placeholder = "Type or paste text with real names…";
    const out = el("textarea", "cum-key-out");
    out.readOnly = true;
    out.placeholder = "The cleaned version appears here.";
    const foot = el("div", "cum-key-row");
    const count = el("span", "cum-key-line cum-key-dim");
    const run = () => {
      const r = V ? V.clean(input.value) : { text: input.value, count: 0 };
      out.value = r.text;
      count.textContent = input.value
        ? r.count +
          " value" +
          (r.count === 1 ? "" : "s") +
          " swapped. Only values the key knows are swapped — read it before pasting."
        : "";
    };
    input.addEventListener("input", run);
    const copy = button("Copy cleaned", "", () => {
      if (!out.value) return;
      const flash = (ok) => {
        copy.textContent = ok ? "Copied ✓" : "Select it and copy by hand";
        setTimeout(() => {
          copy.textContent = "Copy cleaned";
        }, 1600);
      };
      try {
        navigator.clipboard.writeText(out.value).then(
          () => flash(true),
          () => {
            out.select();
            flash(document.execCommand("copy"));
          }
        );
      } catch (e) {
        out.select();
        flash(document.execCommand("copy"));
      }
    });
    foot.appendChild(copy);
    box.append(input, out, foot, count);
    return box;
  }

  // ---- drawing ---------------------------------------------------------------

  function countText(st) {
    if (!st.on) return "";
    if (st.hold) return "held";
    if (st.paused) return "fakes";
    const n = (st.names || 0) + (st.titles || 0);
    return n ? String(n) : "on";
  }

  function draw() {
    const st = state;
    if (btn) {
      const c = btn.querySelector(".cum-key-count");
      if (c) c.textContent = countText(st);
      // Lit if and ONLY if real names are on screen — see content.css. A peek
      // and a run's hold both leave the page showing the fakes, so both are
      // monochrome like the off state and are told apart by the word on the
      // button rather than by a second colour.
      btn.classList.toggle("cum-key-on", st.on && !st.paused && !st.hold);
      btn.classList.toggle("cum-key-off", st.on && (st.paused || !!st.hold));
      btn.title =
        (st.on
          ? st.name +
            (st.attached === false ? " (not attached here)" : "") +
            " — " + statusLine(st)
          : "Pseudonym key: nothing on this page is translated.") +
        " Display only: Claude still holds — and only ever sees — the fakes. " +
        "Click for the key, the peek, the cleaner and the master key.";
    }
    if (!open || !panel) return;
    // A sweep lands whenever the count changes, which on a busy page is while
    // you are still typing into the cleaner — and a rebuild under the caret
    // takes the focus with it. So a redraw that arrives while something in
    // this panel is being TYPED into refreshes the status and leaves the rest
    // alone; a click on one of the buttons is not typing and gets the full
    // rebuild it needs to show what the click did.
    const ae = document.activeElement;
    if (ae && panel.contains(ae) && /^(TEXTAREA|INPUT|SELECT)$/.test(ae.tagName)) {
      const cur = panel.querySelector(".cum-key-status");
      if (cur && !cur.contains(ae)) cur.replaceWith(drawStatus(st));
      return;
    }
    // Rebuilt rather than patched, except the cleaner's boxes: a panel this
    // small is cheaper to redraw than to diff, and a stale half is how a
    // control comes to describe a case that is no longer on screen.
    const keepIn = panel.querySelector(".cum-key-in");
    const keepOut = panel.querySelector(".cum-key-out");
    const carry =
      lastKeyId === st.id ? { in: keepIn && keepIn.value, out: keepOut && keepOut.value } : null;
    lastKeyId = st.id;
    panel.textContent = "";
    const head = el("div", "cum-key-head");
    head.appendChild(el("span", "cum-key-title", "Pseudonym key"));
    const x = button("✕", "cum-key-x", () => setOpen(false));
    x.title = "Close";
    head.appendChild(x);
    panel.appendChild(head);
    const body = el("div", "cum-key-body");
    body.appendChild(drawStatus(st));
    body.appendChild(drawChat());
    body.appendChild(drawLibrary());
    const m = drawMaster();
    if (m) body.appendChild(m);
    const cleaner = drawCleaner(st);
    if (cleaner) body.appendChild(cleaner);
    if (note) body.appendChild(el("p", "cum-key-note", note));
    panel.appendChild(body);
    if (carry && cleaner) {
      const i = panel.querySelector(".cum-key-in");
      const o = panel.querySelector(".cum-key-out");
      if (i) i.value = carry.in || "";
      if (o) o.value = carry.out || "";
    }
  }

  // ---- placement -------------------------------------------------------------
  //
  // First in the tray, whose row puts the key to the LEFT of Save — and then
  // CHECKED, which is the part that was missing.
  //
  // This used to hand the button to CUMTray and return, with nothing anywhere
  // asking whether a button had appeared. When it hadn't, there was no error,
  // no fallback and nothing on screen: the operator's whole account of it was
  // "still no key", and every test said the code was fine, because in a stub
  // it is. A control the operator has no other way to reach must not have a
  // path where it quietly does not exist.
  //
  // So: the tray, then beside Save wherever Save actually is — which is the
  // instruction anyway, "to the left of the Save button", and it holds whether
  // Save ended up in the tray, in claude.ai's header, or loose in a corner —
  // and failing even that, its own fixed corner. Three homes, and the button
  // is on the page at the end of all three.

  let zeroTicks = 0;
  function docked(b) {
    if (!b || !b.isConnected) return false;
    // On the page is not the same as ON SCREEN. A row that clips, or one with
    // no room left, puts a button in the page and nowhere the operator can
    // reach — the lesson the header slot had to learn twice. But it is COUNTED
    // rather than acted on at once: a button measures zero for a tick while
    // the row lays out, and a control that hopped between two homes on every
    // tick would be worse than one in the wrong home.
    if (C.isVisible(b)) {
      zeroTicks = 0;
      return true;
    }
    return ++zeroTicks < 4;
  }

  /** Immediately before the Save button, wherever Save has ended up. */
  function besideSave(b) {
    const save = document.getElementById("cum-save-chat");
    if (!save || !save.parentElement || !C.isVisible(save)) return false;
    if (b.parentElement !== save.parentElement || b.nextElementSibling !== save) {
      try {
        save.parentElement.insertBefore(b, save);
      } catch (e) {
        return false;
      }
    }
    if (open) {
      const p = buildPanel();
      p.classList.add("cum-key-hang");
      if (p.parentElement !== document.body) (document.body || document.documentElement).appendChild(p);
    }
    return docked(b);
  }

  /** Its own corner. Last, and never silent — the tooltip says it is here. */
  function loose(b) {
    b.classList.add("cum-key-loose");
    if (b.parentElement !== document.body) (document.body || document.documentElement).appendChild(b);
    if (open) {
      const p = buildPanel();
      p.classList.add("cum-key-hang");
      if (p.parentElement !== document.body) (document.body || document.documentElement).appendChild(p);
    }
  }

  function place() {
    const b = build();
    const T = window.CUMTray;
    if (T) {
      try {
        T.put("key", b, open ? buildPanel() : null);
      } catch (e) {
        /* the two homes below are what that failing means */
      }
      if (docked(b)) {
        b.classList.remove("cum-key-loose");
        const p = panel;
        if (p) p.classList.remove("cum-key-hang");
        return;
      }
    }
    if (besideSave(b)) {
      b.classList.remove("cum-key-loose");
      return;
    }
    loose(b);
  }

  if (V)
    V.subscribe((st) => {
      state = st || state;
      draw();
    });

  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch[KEYS_KEY] || ch[CHATS_KEY] || ch[MASTER_KEY]) load();
    });
  } catch (e) {
    /* the panel still works; it just won't follow another tab's change */
  }

  setInterval(place, TICK_MS);
  place();
  load();
})();
