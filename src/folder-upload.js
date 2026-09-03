/**
 * Claude Usage Meter — Upload folder (ISOLATED world content script).
 *
 * A button in claude.ai's own composer row — to the RIGHT of the approval
 * control ("Skip all approvals") on Cowork, to the right of the Chat/Cowork
 * toggle on the composer home, and to the LEFT of Send in an ordinary chat,
 * which carries neither of those. On a conversation that does not exist yet
 * AND on one that already does. It does to the conversation you are typing in
 * exactly what the run editor's folder pick does to a run (README: "A case
 * folder is taken apart, not uploaded"), and stops where a run would carry
 * on:
 *
 *   The case folder is taken apart. Only what sits under `Text Files` becomes
 *   an upload; the matter's originals — the filings as served, in the real
 *   names — are left exactly where they are.
 *
 *   Its text files go up as ONE combined file, the same file a run builds and
 *   under the same name (W.bundleText / combined-documents.txt). Twelve
 *   attachments are twelve things claude.ai may or may not read; one labelled
 *   file with an index is one.
 *
 *   The `pseudonym_key.xlsx` beside them is LOADED, never uploaded: parsed
 *   into the extension's key library and attached to this conversation once it
 *   exists, so the chat reads back in the real names. The spreadsheet itself
 *   never reaches the composer.
 *
 *   Nothing is typed and nothing is sent. That half is the operator's, which
 *   is the whole reason this is a button rather than a run.
 *
 *   On CHAT and on COWORK, by two paths rather than one assumption. Cowork's
 *   uploads run in a worker no page hook sees, so they are confirmed by what
 *   the composer visibly carries (the Cowork send driver's own evidence, borrowed
 *   from src/cowork-composer.js rather than re-derived); its sessions are
 *   renamed by driving the header's own control (C.renameCoworkSession) rather
 *   than through the API a chat is renamed with; and a session that will not
 *   read back is judged fresh from the page instead, which the note says out
 *   loud as the weaker evidence it is.
 *
 *   IN A CONVERSATION THAT ALREADY EXISTS, the papers go up and the key is
 *   attached, and that is all. The chat keeps its name — renaming somebody's
 *   open work is not what "upload this folder" asked for, and a title is not
 *   display: claude.ai stores it, syncs it and searches it. It keeps any key
 *   already on it, too, since re-reading every message under another matter's
 *   map is worse than leaving it. Both are said out loud rather than left to
 *   be noticed.
 *
 *   And when the conversation is one this button's own send STARTS, it takes
 *   the folder's name — through the
 *   matter's own key first (real → fake), or not at all. A chat title is not
 *   display: claude.ai stores it, syncs it to every signed-in device and
 *   searches it, so "23STCV12345 Smith v. Jones" over a chat whose every
 *   uploaded page was scrubbed would hand back the one thing the scrubbing was
 *   for. Where the swap can't be made the chat is left unnamed and the note
 *   says why — never the real name as a fallback.
 *
 * The decisions live in src/folderup.js (pure, tested); this is the button,
 * the picker and the wait around them.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  const W = window.CUMWorkflow;
  const DD = window.CUMDropDir;
  const F = window.CUMFolderUp;
  const PB = window.CUMPanelBar;
  // The LEAKS gate (src/leaks.js). Read separately from the four above and
  // NOT in the guard below on purpose: a missing gate must not take the button
  // off the page quietly — it must be there and refuse, which is what handle()
  // does with it.
  const L = window.CUMLeaks;
  if (!C || !W || !DD || !F) return;

  const norm = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

  const ID = "cum-folder";
  const INPUT_ID = "cum-folder-input";
  const NOTE_ID = "cum-folder-note";
  const TICK_MS = 1500;
  const KEYS_KEY = "cum_pseudo_keys";
  const CHATS_KEY = "cum_pseudo_chats";

  // What the pick is waiting to do to the conversation it will start: attach
  // the key to it, and give it the folder's name. Held in the page rather than
  // in storage, and deliberately: a reload loses the composer's attachments
  // too, and a remembered name outliving them would land on whatever chat the
  // tab reached next.
  // { folder, title, why, keyId, surface, pickedAt, sawComposerAt, strayTicks,
  //   fetchTries }
  let pending = null;
  let claiming = "";
  // The conversation the note on screen is ABOUT, so a report about this chat
  // isn't swept away the moment the send navigates off the composer — and
  // doesn't follow you into the next matter either.
  let noteConv = "";
  let noteAt = 0; // when it was last written — see place()
  const NOTE_MIN_MS = 45000;

  let btn = null;
  let input = null;
  let note = null;

  // ---- the button ----------------------------------------------------------

  function build() {
    if (btn) return btn;
    btn = document.createElement("button");
    btn.id = ID;
    btn.type = "button";
    btn.title =
      "Take a case folder apart into this new conversation — chat or Cowork: its " +
      "Text Files go up as one combined file, its pseudonym key is loaded (never " +
      "uploaded), and the conversation takes the folder's name when you send";
    // A drawn folder rather than the 🗂 emoji it started with: an emoji is a
    // colour bitmap sitting among claude.ai's own line icons, and it looked
    // exactly like what it was. This is one stroked path in currentColor, so
    // it takes the row's colour in either theme and scales with the text.
    btn.innerHTML =
      '<span class="cum-folder-ico" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>' +
      "</svg></span>" +
      '<span class="cum-folder-txt">Folder</span>';
    btn.addEventListener("click", onPick);
    return btn;
  }

  function buildInput() {
    if (input && input.isConnected) return input;
    input = document.createElement("input");
    input.id = INPUT_ID; // C.isOurs — the key guard leaves our own picker alone
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.style.display = "none";
    input.addEventListener("change", () => {
      const list = Array.from(input.files || []);
      input.value = "";
      if (list.length) take(list);
    });
    (document.body || document.documentElement).appendChild(input);
    return input;
  }

  function label(text) {
    const el = btn && btn.querySelector(".cum-folder-txt");
    if (el) el.textContent = text;
  }

  function busy(on) {
    if (btn) btn.disabled = !!on;
  }

  // ---- the note ------------------------------------------------------------
  //
  // Not a toast. Everything this button has to say is something the operator
  // would otherwise have to count or would never learn at all — what was left
  // in the case folder, what the key did, and above all a chat that will NOT be
  // named and why — so it stays on screen until it is dismissed or replaced.

  function say(lines, bad) {
    const list = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
    if (!list.length) return;
    if (!note) {
      note = document.createElement("div");
      note.id = NOTE_ID;
    }
    note.innerHTML = "";
    noteAt = Date.now();
    note.classList.toggle("cum-folder-bad", !!bad);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cum-folder-close";
    close.textContent = "✕";
    close.title = "Dismiss";
    // Dismissed for good: the next thing worth saying builds its own note,
    // and a note put back by the placement tick would be undismissable.
    close.addEventListener("click", () => {
      if (note) note.remove();
      note = null;
    });
    note.appendChild(close);
    for (const line of list) {
      const p = document.createElement("p");
      p.textContent = line;
      note.appendChild(p);
    }
    place(); // puts the note on the page and under the button
  }

  // ---- storage -------------------------------------------------------------

  // Read, and say whether the read HAPPENED. C.storageGet answers {} for a
  // library that wouldn't read, which is the same answer as an empty library —
  // and "couldn't tell" must never be reported as "this matter has no key".
  function readLocal(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, data: {} });
          resolve({ ok: true, data: res || {} });
        });
      } catch (e) {
        resolve({ ok: false, data: {} });
      }
    });
  }

  function storageSet(obj) {
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

  // ---- the key -------------------------------------------------------------
  //
  // Same reading as the run editor's (workflowform.attachKeyFile) and the
  // popup's: content decides which library entry this is, never the filename —
  // every case's key file is called pseudonym_key.xlsx. The case FOLDER is what
  // the key is called from here on, so the popup, the run editor's picker and
  // the badge in this chat all name the same matter the same way.
  /**
   * Keep the workbook a key was read from, beside the library rather than in
   * it, so the key panel can hand it back (src/keyfile.js). Best effort: a
   * file too big to keep is a key that still works, minus the download.
   */
  async function rememberKeyFile(id, bytes, name) {
    const KF = window.CUMKeyFile;
    if (!KF || !id) return;
    const made = KF.fileRecord(bytes, name, Date.now());
    if (!made.ok) return;
    const store = await readLocal([KF.FILES_KEY]);
    if (!store.ok) return;
    await storageSet({ [KF.FILES_KEY]: KF.putFile(store.data[KF.FILES_KEY] || {}, id, made.record) });
  }

  async function loadKey(file, folder) {
    const P = window.CUMPseudo;
    const X = window.CUMXlsx;
    if (!P || !X || !X.parseXlsx || !F.isSpreadsheet(file.name)) return null;
    let key = null;
    let bytes = null;
    try {
      // Read ONCE and keep what was read: the key panel hands this workbook
      // back (src/keyfile.js), and it has to be the one that was parsed.
      const buf = await file.arrayBuffer();
      bytes = new Uint8Array(buf.slice(0)); // a copy: see src/key-panel.js
      const wb = await X.parseXlsx(buf);
      if (!wb || !(P.isKeyFileName(file.name) || P.sheetsLookLikeKey(wb.sheets))) return null;
      key = P.parseKey(wb.sheets, file.name);
    } catch (e) {
      return null; // unreadable: not a key, and the caller says what it found
    }
    if (!key || !key.rows) return null;
    key.savedAt = Date.now();
    if (folder) key.folder = folder;
    const store = await readLocal([KEYS_KEY]);
    const keys = store.data[KEYS_KEY] || {};
    const id = P.libraryIdFor(keys, key).id;
    keys[id] = P.keepKeyFacts ? P.keepKeyFacts(keys[id], key) : key;
    await storageSet({ [KEYS_KEY]: keys });
    await rememberKeyFile(id, bytes, file.name);
    return { id: id, key: keys[id], label: P.keyLabel ? P.keyLabel(keys[id]) : folder || file.name };
  }

  /**
   * This case folder's key, already in the library from an earlier pick, the
   * popup or a run. Matched on the folder name alone (F.keyForFolder) — two
   * matters are two folders, and a key that never named one claims nothing.
   */
  async function keyAlreadyLoaded(folder) {
    const P = window.CUMPseudo;
    if (!P) return null;
    const store = await readLocal([KEYS_KEY]);
    if (!store.ok) return null; // the library wouldn't read — titleFor says so
    const keys = store.data[KEYS_KEY] || {};
    const id = F.keyForFolder(keys, folder);
    if (!id) return null;
    return {
      id: id,
      key: keys[id],
      label: P.keyLabel ? P.keyLabel(keys[id]) : folder,
      already: true,
    };
  }

  // ---- the pick ------------------------------------------------------------

  function isCaseFolderName(name) {
    const P = window.CUMPseudo;
    return !!(P && P.caseNumbers && P.caseNumbers(name).length);
  }

  /**
   * Which surface this pick goes out on. The address settles it where it is a
   * Cowork one; otherwise the page's own Chat/Cowork toggle does; and where
   * neither says, F.pickSurface answers Cowork, whose confirmation covers both.
   */
  function surfaceHere() {
    let toggle = "";
    try {
      toggle = C.currentSurface();
    } catch (e) {
      toggle = "";
    }
    return F.pickSurface(location.href, toggle);
  }

  function onPick() {
    buildInput().click();
  }

  async function take(list) {
    busy(true);
    label("Reading…");
    try {
      await handle(list);
    } catch (e) {
      say(["That folder could not be read: " + String((e && e.message) || e)], true);
    } finally {
      busy(false);
      // Not a tick: the note says what happened, and a pick whose upload failed
      // is still armed to name the chat. The ellipsis says only that.
      label(pending ? "Folder…" : "Folder");
    }
  }

  async function handle(list) {
    // Scanned without the ordinary 300-file cap: the Text Files subfolder has
    // to be REACHED, and 300 files into a matter's originals is not far enough
    // in. Only what the split hands back is capped.
    const scan = DD.fromPicked(list, { maxFiles: DD.MAX_SCAN });

    // A folder marked LEAKS never uploads, and it is asked FIRST — before the
    // folder is taken apart, before a key is read out of it, before a name is
    // worked out. Everything downstream of here is machinery for getting
    // papers to claude.ai, and the whole point of the marker is that these
    // papers do not go.
    //
    // With the gate itself missing the pick is refused rather than allowed: a
    // bar against papers reaching claude.ai that fails open is not a bar, and
    // the cost of failing closed is one reload.
    if (!L) {
      say(
        [
          "The LEAKS upload gate is not loaded on this page, so nothing was uploaded — " +
            "this folder could not be checked for a LEAKS spreadsheet. Reload the page and " +
            "pick it again.",
        ],
        true
      );
      return;
    }
    const barred = L.gate(scan.files);
    if (barred.hit) {
      // Any wait armed by an earlier pick goes too: the note on screen is
      // about a folder that was refused, and a chat named after the last one
      // would be the wrong matter's name on it.
      pending = null;
      say(
        [
          L.describe(barred),
          "Its pseudonym key was not read either — this button only reads one on its way to " +
            "an upload. Load it from the key button if you need it.",
        ],
        true
      );
      return;
    }

    const split = DD.splitCaseFolder(scan.files, { isCaseName: isCaseFolderName });
    if (!split.ok) {
      say(
        [
          "That folder's name carries no case number, so it is not a case folder and this " +
            "button will not take it apart.",
          "A case folder is uploaded through its Text Files subfolder only — everything else " +
            "in it is the matter's originals. Drag ordinary files onto the composer instead.",
        ],
        true
      );
      return;
    }

    // The key first: it is the safety-critical half, it is quick, and the
    // title below cannot be decided without knowing whether there is one. Read
    // in the order the folder holds them and stop at the first real one; a
    // spreadsheet that isn't a key is not an error here, it is just not a key.
    let keyRec = null;
    for (const k of split.keys) {
      keyRec = await loadKey(k.file, split.root);
      if (keyRec) break;
    }
    // No key file in the pick, but this matter may already have one: a key
    // remembers the case folder it came out of, so a folder picked a second
    // time finds it without the .xlsx sitting there again.
    if (!keyRec) keyRec = await keyAlreadyLoaded(split.root);

    const plan = F.uploadPlan(split.docs);
    const upload = F.describeUpload({
      root: split.root,
      bundle: plan.bundle,
      singles: plan.singles,
      left: split.left,
      capped: split.capped,
    });

    // A conversation that ALREADY EXISTS takes the papers and nothing else:
    // there is no send to wait for, no name to give it, and any key already on
    // it stays. So this path finishes its half here and now, and no wait is
    // armed — an armed one would go looking for a conversation to claim and
    // find this one, which is the very chat it must not rename.
    const here = F.startedConversation(location.href);
    let lines;
    const surface = surfaceHere();
    if (here.id) {
      // Cleared rather than merely not armed: a wait left over from a pick
      // made on the composer would go looking for a conversation to claim and
      // find THIS one — the very chat that must keep its name.
      pending = null;
      lines = [upload].concat(await keyLinesHere(split.root, keyRec));
    } else {
      // Whatever happens to the upload, the key is loaded and the name is
      // worked out — so the wait is armed before the slow half rather than
      // after it.
      const decision = await titleFor(split.root, keyRec);
      lines = [
        upload,
        F.describeKey({
          root: split.root,
          keyName: keyRec ? keyRec.label : "",
          already: !!(keyRec && keyRec.already),
        }),
        F.describeTitle(decision),
      ];
      const now = Date.now();
      pending = {
        folder: split.root,
        title: decision.title,
        why: decision.why,
        keyId: keyRec ? keyRec.id : "",
        surface: surface,
        pickedAt: now,
        sawComposerAt: now,
        strayTicks: 0,
        fetchTries: 0,
      };
    }

    const files = await buildUploads(plan, lines);
    if (!files.length) {
      say(lines, true);
      return;
    }
    say(lines.concat(["Uploading…"]));
    label("Uploading…");
    const att = await attach(files, surface);
    if (att.ok) {
      lines.push(
        "Attached " +
          files.length +
          (files.length === 1 ? " file" : " files") +
          " (" + att.why + ") — nothing was typed and nothing was sent."
      );
      say(lines);
    } else {
      lines.push("The upload did not land: " + att.why + ". Nothing was sent.");
      say(lines, true);
    }
  }

  /**
   * Hand the files to the composer, and confirm they landed the way this
   * surface allows.
   *
   * Chat's confirmation is the upload responses inject.js sees, with its chip
   * markup behind them. Cowork's uploads run inside a worker no hook reaches
   * and its chips are not Chat's markup, so there the confirmation is the
   * composer visibly carrying the files — chips OR the filenames themselves —
   * which is exactly what the Cowork send driver already worked out. Borrowed
   * from it rather than written again here, because two copies of that
   * evidence would drift and only one of them would be the tested one.
   */
  async function attach(files, surface) {
    const CW = window.CUMCoworkSend;
    if (surface === "cowork" && CW && CW.attachFiles) {
      const r = await CW.attachFiles(files, 120000);
      return { ok: r.ok, why: (r.how ? "via " + r.how + ": " : "") + (r.why || "") };
    }
    const r = await C.attachFiles(files, 120000);
    const why = (r.how ? "via " + r.how + ": " : "") + (r.detail || "");
    if (surface !== "cowork") return { ok: r.ok, why: why };
    // Cowork without its own driver loaded: Chat's confirmation is the only one
    // there is, and on this surface its silence proves nothing — so what it saw
    // is reported rather than dressed up as a verdict either way.
    return {
      ok: r.ok,
      why: why + " (Cowork's own upload driver isn't loaded, so this is Chat's evidence)",
    };
  }

  /**
   * The files the composer receives: the combined text file, then everything
   * that could not be folded into it. Combining is an improvement, never a
   * precondition — a document that will not read as text is put back in the
   * list as itself rather than dropped or turned into mojibake.
   */
  async function buildUploads(plan, lines) {
    const out = [];
    const parts = [];
    const unread = [];
    for (const d of plan.bundle) {
      try {
        parts.push({ name: d.file.name, text: await d.file.text() });
      } catch (e) {
        unread.push(d.file);
      }
    }
    const combined = parts.length > 1 ? W.bundleText(parts) : "";
    if (combined) {
      out.push(
        new File([combined], F.BUNDLE_NAME, { type: "text/plain", lastModified: Date.now() })
      );
    } else {
      for (const d of plan.bundle) if (unread.indexOf(d.file) === -1) out.push(d.file);
    }
    if (unread.length) {
      lines.push(
        unread.length +
          (unread.length === 1 ? " text file" : " text files") +
          " would not read as text" +
          (combined ? " and went up on their own instead of into the combined file." : ", so nothing was combined and every file went up as itself.")
      );
      for (const f of unread) out.push(f);
    }
    for (const d of plan.singles) out.push(d.file);
    // The last word on the bar that matters most: a spreadsheet — which is what
    // a pseudonym key is — never reaches the composer, whatever came before.
    return out.filter((f) => f && !F.isSpreadsheet(f.name));
  }

  /**
   * The key half of a pick made inside a conversation that already exists:
   * read what that conversation is already on, let F.planHere decide, do the
   * one write it may call for, and answer the lines to say.
   */
  async function keyLinesHere(root, keyRec) {
    const store = await readLocal([KEYS_KEY, CHATS_KEY]);
    const keys = store.data[KEYS_KEY] || {};
    const chats = store.data[CHATS_KEY] || {};
    const P = window.CUMPseudo;
    const conv = P && P.conversationFromUrl ? P.conversationFromUrl(location.href) : "";
    const attachedId = (conv && chats[conv]) || "";
    const plan = F.planHere({
      root: root,
      keyId: keyRec ? keyRec.id : "",
      keyName: keyRec ? keyRec.label : "",
      attachedId: attachedId,
      attachedName:
        attachedId && keys[attachedId] && P && P.keyLabel ? P.keyLabel(keys[attachedId]) : "",
    });
    if (!plan.attach) return [plan.key, plan.name];
    const ok = await attachKeyHere(keyRec.id);
    return [
      ok
        ? norm(keyRec.label) +
          " is the pseudonym key — loaded into the extension and attached to this " +
          "conversation, never uploaded. It reads back in the real names."
        : "Could not attach the pseudonym key here — attach it from the key button.",
      plan.name,
    ];
  }

  async function titleFor(folder, keyRec) {
    const store = await readLocal([KEYS_KEY]);
    const keys = store.data[KEYS_KEY] || {};
    return F.chatTitleFor({
      folder: folder,
      looked: store.ok,
      keyId: keyRec ? keyRec.id : "",
      key: keyRec ? keys[keyRec.id] || keyRec.key : null,
    });
  }

  // ---- the conversation, once it exists ------------------------------------

  let reqSeq = 0;
  function ask(command, match, timeoutMs) {
    return new Promise((resolve) => {
      const reqId = "fu" + ++reqSeq + "-" + Date.now();
      let settled = false;
      const finish = (data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve(data || null);
      };
      function onMsg(event) {
        if (event.source !== window) return;
        const m = event.data;
        const p = m && m.__channel === C.CHANNEL ? m.payload : null;
        const got = p && p[match];
        if (got && got.reqId === reqId) finish(got);
      }
      window.addEventListener("message", onMsg);
      const timer = setTimeout(() => finish(null), timeoutMs || 12000);
      try {
        window.postMessage(
          { __channel: C.CHANNEL, command: Object.assign({ reqId: reqId }, command) },
          window.location.origin
        );
      } catch (e) {
        finish(null);
      }
    });
  }

  const renameConversation = (uuid, name) =>
    ask({ type: "renameConversation", uuid: uuid, name: name }, "renamed", 10000);
  const fetchConversation = (uuid) =>
    ask({ type: "fetchConversation", uuid: uuid }, "conversation", 12000);

  // Attach the folder's key to the conversation the send just created. The
  // same per-chat attachment the popup makes, written the same way — this chat
  // belongs to no run, so there is no case-wide rekey to do.
  async function attachKeyHere(keyId) {
    const P = window.CUMPseudo;
    if (!P || !keyId) return false;
    // The key the READER uses, not one of our own devising — and the STRICT
    // one, which is the same rule the popup and the key panel now attach by: a
    // key filed under a page rather than a conversation is a key every page of
    // that shape comes up wearing.
    const conv = P.conversationFromUrl
      ? P.conversationFromUrl(location.href)
      : W.conversationKey
      ? W.conversationKey(location.href)
      : P.conversationKeyFromUrl(location.href);
    if (!conv) return false;
    const store = await readLocal([CHATS_KEY]);
    if (!store.ok) return false;
    const chats = store.data[CHATS_KEY] || {};
    chats[conv] = keyId;
    return await storageSet({ [CHATS_KEY]: chats });
  }

  /** Give this conversation the folder's name. Answers { ok, name, error }. */
  async function nameIt(conv, title) {
    if (conv.surface === "cowork") {
      // A Cowork session has no rename API — renaming one by hand makes no
      // HTTP request at all — so it is done the way you do it: the control in
      // its own header, which C.renameCoworkSession drives and which answers
      // "ok" for a session already called that.
      //
      // Tried more than once, because the session's page has only just been
      // built: the header carries that control a moment after the address
      // changes, and "no rename control in the header" a second too early is
      // not the same thing as a session that cannot be named.
      let r = "failed";
      for (let i = 0; i < 3; i++) {
        if (i) await C.sleep(3000);
        // Checked before EVERY attempt: this rename drives the control in the
        // header of the page we are on, so doing it after the tab has moved
        // would rename whatever session it moved to. The chat path has no such
        // hazard — it names a conversation by id, through the API.
        if (F.startedConversation(location.href).id !== conv.id)
          return { ok: false, name: title, error: "the tab left that session before it could be named" };
        try {
          r = await C.renameCoworkSession(title);
        } catch (e) {
          r = "failed";
        }
        if (r === "ok") break;
      }
      return { ok: r === "ok", name: title, error: (C.renameWhy && C.renameWhy()) || r };
    }
    const named = await renameConversation(conv.id, title);
    return {
      ok: !!(named && named.ok),
      name: (named && named.name) || title,
      error: (named && named.error) || "no answer",
    };
  }

  /**
   * What this conversation is ACTUALLY called: true it carries `title`, false
   * it carries something else, null nothing could be read back.
   *
   * Asked of the conversation rather than of the rename: a rename answers for
   * the request it made, and the request is not the question. On Chat that is
   * the payload's own name — never the header, because a tab translating a key
   * shows the REAL name there while the fake is what actually went over. On
   * Cowork there is no payload that answers, so it is the header controls'
   * aria-labels, which is where a Cowork rename's name lives and which the
   * display swap never touches.
   */
  async function confirmName(conv, title) {
    const K = window.CUMCowork;
    if (!K) return null;
    if (conv.surface === "cowork") {
      if (F.startedConversation(location.href).id !== conv.id) return null;
      let shown = "";
      try {
        shown = (C.coworkSessionName && C.coworkSessionName()) || "";
      } catch (e) {
        return null;
      }
      return shown ? K.sameTitle(shown, title) : null;
    }
    const got = await fetchConversation(conv.id);
    const payload = got && got.data;
    if (!payload) return null;
    const name = K.conversationName(payload);
    return name ? K.sameTitle(name, title) : false;
  }

  /**
   * Hold the folder's name on the conversation until it stays there, and say
   * what happened either way.
   *
   * claude.ai titles a new conversation ITSELF, early — moments into the first
   * answer — and that lands on top of a rename made when the conversation
   * appeared. Two things were wrong with the way that was handled:
   *
   *   The note reported the ASK. 'Named it "X"' went up on an HTTP 200 and was
   *   never corrected, so the auto-title winning — the ordinary case, the case
   *   this whole backoff exists for — looked from the outside exactly like a
   *   button that had lied. Every pass now reads the conversation back and the
   *   note says what it found, ending in a plain "rename it by hand" where the
   *   name could not be made to stay.
   *
   *   It gave up the moment the tab moved. On Cowork it must: that rename
   *   drives the control in the header of the page we are on, and doing it
   *   elsewhere renames whatever session the tab moved to. On CHAT it must
   *   not: that rename is a request by id, the tab has nothing to do with it,
   *   and abandoning it meant that opening another chat in the twenty seconds
   *   before the first re-check — which is most of them, since that is when
   *   the answer is streaming and there is nothing to do but look elsewhere —
   *   left the auto-title in place for good.
   *
   * The first two passes are seconds rather than tens of seconds, because that
   * is when the auto-title actually lands.
   */
  const NAME_WAITS = [4000, 8000, 20000, 30000, 60000, 120000, 240000];
  async function holdName(conv, title, lines, said) {
    // Every pass, to the end of the ladder — not until the first success. The
    // auto-title lands ON TOP of a rename that took, so stopping at the first
    // confirmed name is stopping just before the thing being defended against.
    //
    // The note is rewritten only when what there is to say CHANGES, and only
    // while the tab is still on this conversation: Chat's rename carries on
    // wherever the tab goes, but the note must not follow it there.
    let last = said || "";
    const speak = (line, bad) => {
      if (!line || line === last) return;
      last = line;
      if (F.startedConversation(location.href).id !== conv.id) return;
      say(lines.concat([line]), bad);
    };
    for (let i = 0; i < NAME_WAITS.length; i++) {
      await C.sleep(NAME_WAITS[i]);
      // Cowork's rename is the page's own control, so leaving the session ends
      // it. Chat's is a request by id and does not care where the tab is.
      if (conv.surface === "cowork" && F.startedConversation(location.href).id !== conv.id) return;
      const settled = i === NAME_WAITS.length - 1;
      try {
        let took = await confirmName(conv, title);
        if (took !== true) {
          const named = await nameIt(conv, title);
          if (!named.ok) {
            speak(F.describeNamed({ title: title, error: named.error, settled: settled }), true);
            continue;
          }
          took = await confirmName(conv, title);
        }
        speak(F.describeNamed({ title: title, took: took, settled: settled }), took !== true);
      } catch (e) {
        /* the next pass tries again; the last one says it could not be read */
      }
    }
  }

  /** Human turns visible on the page — the page's own word on how far in it is. */
  function humanTurns() {
    const CW = window.CUMCoworkSend;
    if (CW && CW.humanTurns) {
      try {
        return CW.humanTurns();
      } catch (e) {
        /* fall through to the count below */
      }
    }
    let n = null;
    for (const sel of ['[data-testid="user-message"]', ".font-user-message"]) {
      try {
        const found = document.querySelectorAll(sel).length;
        n = n === null ? found : Math.max(n, found);
      } catch (e) {
        /* try the next shape */
      }
    }
    return n;
  }

  /**
   * The conversation the send created — or so the address says.
   *
   * The address cannot tell that from a conversation clicked in the sidebar,
   * and the difference is the whole safety of this: naming the wrong one
   * renames somebody's open work and hangs a matter's key on it. So the
   * evidence is gathered — the conversation itself where it reads back, the
   * page where it doesn't — and F.conversationFresh weighs it. Anything short
   * of a clear yes leaves the conversation alone and says so. One left unnamed
   * is a nuisance; one wrongly named is a mess.
   */
  async function claim(conv) {
    if (claiming === conv.id) return;
    claiming = conv.id;
    const p = pending;
    const got = await fetchConversation(conv.id);
    // That fetch can take seconds, and the tab can move in them. A pick that
    // has since been cleared or replaced is not this one's to finish, and the
    // page evidence below would be some other page's.
    if (pending !== p) {
      claiming = "";
      return;
    }
    const fresh = F.conversationFresh({
      conv: got && got.data,
      turns: humanTurns(),
      watched: !!p && Date.now() - p.sawComposerAt < 90000,
      pickedAt: p && p.pickedAt,
      now: Date.now(),
    });
    if (fresh.ok === null) {
      // Not an answer yet. The page may still be settling — let the tick try
      // again, a few times, before giving up on it out loud.
      claiming = "";
      if (pending && ++pending.fetchTries < 4) return;
      pending = null;
      noteConv = conv.id;
      label("Folder");
      say(
        [
          "Nothing was renamed and no key was attached here: " + fresh.why + ", and this " +
            "button will not name a conversation it cannot confirm is the one your folder " +
            "started.",
          p && p.keyId
            ? "The pseudonym key is loaded either way; attach it from the popup."
            : "Nothing else was changed.",
        ],
        true
      );
      return;
    }
    pending = null;
    noteConv = conv.id;
    label("Folder");
    if (fresh.ok === false) {
      say(
        [
          "This is not the conversation your folder started — " + fresh.why + ". Nothing was " +
            "renamed and no key was attached to it.",
          "Start a new conversation and press Folder there.",
        ],
        true
      );
      return;
    }
    const lines = [];
    if (p.keyId) {
      const ok = await attachKeyHere(p.keyId);
      lines.push(
        ok
          ? "The pseudonym key is attached to this conversation — it reads back in the real names."
          : "Could not attach the pseudonym key here — attach it from the popup."
      );
    }
    if (!p.title) {
      lines.push("This conversation was left unnamed: " + p.why + ".");
      say(lines, true);
      return;
    }
    label("Naming…");
    // The session's own page is still being built in the moment the address
    // changes; the chat's rename goes through the API and needs no such wait.
    if (conv.surface === "cowork") {
      await C.sleep(2500);
      if (F.startedConversation(location.href).id !== conv.id) {
        lines.push("The tab left this session before it could be named.");
        say(lines, true);
        return;
      }
    }
    const named = await nameIt(conv, p.title);
    label("Folder");
    // The weaker evidence is said where it was what carried the decision, so a
    // name that landed on the wrong conversation is something you can see
    // rather than something you find later.
    if (/the page's word/.test(fresh.why)) lines.push("Confirmed from the page: " + fresh.why + ".");
    // Read back rather than assumed. The rename answers for the request it
    // made; what the conversation is CALLED is a different question, and it is
    // the one the note has to answer — claude.ai's own auto-title is still to
    // come and routinely wins this first round.
    const took = named.ok ? await confirmName(conv, p.title) : false;
    const verdict = F.describeNamed({
      title: p.title,
      took: took,
      error: named.ok ? "" : named.error,
    });
    say(lines.concat([verdict]), took !== true);
    // Either way the name is held: an attempt that failed outright gets tried
    // again, and one that took gets defended against the auto-title still to
    // come. The verdict just said is handed over so the hold only speaks again
    // when there is something different to say.
    holdName(conv, p.title, lines, verdict);
  }

  // ---- placement -----------------------------------------------------------
  //
  // Beside the composer's OWN controls — next to "Skip all approvals" on
  // Cowork, next to the Chat/Cowork toggle where there is no approval control
  // (the owner's instruction, and it reads right: what this button does is an
  // upload, and that row is where the composer's own furniture lives). The
  // tray beside the sidebar toggle stays as the fallback for a page showing
  // neither of those controls.
  //
  // Two lessons from the header slot, which had to learn both the hard way:
  // ONLY claude.ai's own controls are anchored to, and INSERTED and VISIBLE
  // are different things — a row that clips, or one with no room left, puts a
  // button in the page and nowhere on the screen.

  /** Cowork's send control before Chat's: Cowork reads "Start Task" and wears
   * none of Chat's labels, so C.findSend answers nothing on the surface this
   * fallback most needed to work on. */
  function sendControl() {
    const CW = window.CUMCoworkSend;
    let el = null;
    try {
      el = (CW && CW.findSend && CW.findSend()) || (C.findSend && C.findSend());
    } catch (e) {
      return null;
    }
    return el;
  }

  /**
   * claude.ai's own control to sit beside, in the composer row under the
   * prompt box — and which side of it to sit on.
   *
   * Three ways of finding one, because the row is not the same row on the two
   * surfaces and the FIRST version of this found only one of them. On a Cowork
   * session that carried a "Skip all approvals" button the operator could see,
   * every one of them missed and the button fell back to the tray in the top
   * right corner, which is not a composer row at all.
   *
   *   1. The approval control (C.findApprovalTrigger) — which is where the
   *      widened search for it lives now: this file used to carry a second
   *      finder of its own, and one implementation of "what is the approval
   *      control" is the point.
   *   2. The Chat/Cowork toggle, which only ever sits on the composer home.
   *   3. SEND, which every composer has.
   *
   * The button goes AFTER the first two — to the right of Skip, which is where
   * it was asked for — and BEFORE Send, which is the last thing in that row and
   * the one control there it must never crowd or be mistaken for.
   */
  function rowAnchor() {
    const after = [
      () => C.findApprovalTrigger && C.findApprovalTrigger(),
      () => C.findSurfaceGroup && C.findSurfaceGroup(),
    ];
    for (const find of after) {
      let el = null;
      try {
        el = find();
      } catch (e) {
        el = null;
      }
      if (usable(el)) return { el: el, after: true };
    }
    const send = sendControl();
    return usable(send) ? { el: send, after: false } : null;
  }

  /**
   * An anchor has to be claude.ai's own furniture, on screen, and somewhere a
   * button can actually be put — never inside a rendered message, where a
   * "send" is the one in a code block Claude wrote.
   */
  function usable(el) {
    if (!el || !el.parentElement) return false;
    try {
      if (el.closest('[data-testid="assistant-message"],[data-testid="user-message"]')) return false;
    } catch (e) {
      /* a page whose closest() throws is not one to reason about */
    }
    return C.isVisible(el);
  }

  // The next (or previous) sibling that is claude.ai's OWN, skipping anything of
  // ours sitting between. The fakes toggle docks itself immediately to the
  // right of this button, and in an ordinary chat — where the anchor is SEND
  // and this button goes BEFORE it — a literal next-sibling test would read
  // that as "not docked". Both buttons would then re-insert on every tick,
  // each undoing the other, forever: permanent churn, and neither one keeping
  // its own hover or focus.
  const theirs = (el, dir) => {
    let n = el && el[dir];
    while (n && C.isOurs(n)) n = n[dir];
    return n;
  };

  function dockInRow(b) {
    const at = rowAnchor();
    if (!at) return false;
    // Checked before it is done, so a docked button is not torn out and put
    // back on every tick — which would cost it its own hover and focus.
    const placed = at.after
      ? b.parentElement === at.el.parentElement && theirs(b, "previousElementSibling") === at.el
      : b.parentElement === at.el.parentElement && theirs(b, "nextElementSibling") === at.el;
    if (!placed) {
      // The row is claude.ai's own furniture and the class decides how the
      // button looks in it, so it goes on BEFORE the insert rather than after:
      // measuring a button still wearing the tray's styling is measuring
      // something that is not what will be on the screen.
      b.classList.add("cum-folder-inrow");
      b.classList.remove("cum-folder-loose");
      try {
        at.el.parentElement.insertBefore(b, at.after ? at.el.nextSibling : at.el);
      } catch (e) {
        return false;
      }
    }
    if (!C.isVisible(b)) return false; // in the page, nowhere on the screen
    return true;
  }

  /** The tray beside claude.ai's sidebar toggle, or a corner of our own. */
  function dockInTray(b) {
    b.classList.remove("cum-folder-inrow");
    const T = window.CUMTray;
    if (T) {
      b.classList.remove("cum-folder-loose");
      T.put("folder", b);
      return;
    }
    b.classList.add("cum-folder-loose");
    if (b.parentElement !== document.body) document.body.appendChild(b);
  }

  /**
   * The note sits under the button it belongs to — above it, really, since the
   * composer is at the bottom of the window — and stands on its own at the
   * bottom centre once the button has gone, which it does the moment the send
   * navigates off the composer. CUMPanelBar.cardNear owns that geometry.
   */
  function positionNote() {
    if (!note) return;
    if (!note.isConnected) (document.body || document.documentElement).appendChild(note);
    let rect = null;
    try {
      if (btn && btn.isConnected && C.isVisible(btn)) rect = btn.getBoundingClientRect();
    } catch (e) {
      rect = null;
    }
    if (!PB || !PB.cardNear) return; // the stylesheet's own corner takes it
    const at = PB.cardNear(
      rect,
      { w: note.offsetWidth || 340, h: note.offsetHeight || 160 },
      { w: window.innerWidth, h: window.innerHeight }
    );
    note.style.left = at.left + "px";
    note.style.top = at.top + "px";
  }

  function place() {
    // Wherever there is a composer to put papers into: a conversation that does
    // not exist yet, and one that already does. What the pick DOES differs
    // between them (see handle) — an open chat keeps its name and keeps any key
    // already on it — but the button is welcome on both. The editor has to be
    // on screen either way, which is what keeps this off the lists.
    const wanted = F.buttonBelongs(location.href) && !!C.findEditor();
    if (!wanted && btn && btn.parentNode) btn.remove();
    // The NOTE outlives it by design: the send navigates off the composer, and
    // the naming happens after that. It stays while a pick is pending, on the
    // composer it was made from, and in the conversation it named — and goes
    // when the tab has moved on to something else. Whatever it says, it gets
    // long enough to be READ: a refusal written the instant the tab left the
    // composer would otherwise be swept away by the same navigation.
    if (
      note &&
      !wanted &&
      !pending &&
      F.startedConversation(location.href).id !== noteConv &&
      Date.now() - noteAt > NOTE_MIN_MS
    ) {
      note.remove();
      note = null;
    }
    if (wanted) {
      const b = build();
      if (!dockInRow(b)) dockInTray(b);
    }
    positionNote();
  }

  function tick() {
    place();
    if (!pending) return;
    const conv = F.startedConversation(location.href);
    if (conv.id) {
      claim(conv);
      return;
    }
    // Still on a composer: remember that this tab is watching it, which is
    // half of what says the next conversation to appear is the one this pick
    // started (the other half is that it holds one turn).
    if (F.isNewChatPath(location.href)) {
      pending.sawComposerAt = Date.now();
      pending.strayTicks = 0;
      return;
    }
    // The tab left the composer for something that is not a conversation at
    // all. Said once rather than waited on forever, and only after the address
    // has settled: an SPA navigation passes through states that are neither.
    if (++pending.strayTicks < 3) return;
    const keyed = !!pending.keyId;
    pending = null;
    label("Folder");
    say(
      [
        "This left the composer for a page that is not a conversation, so there was nothing " +
          "to name or attach the key to.",
        keyed
          ? "The pseudonym key is loaded either way; attach it to a conversation from the popup."
          : "Nothing was named and nothing was sent.",
      ],
      true
    );
  }

  setInterval(tick, TICK_MS);
  // The row the button sits in moves with the window; the note follows it
  // rather than waiting up to a tick to catch up.
  window.addEventListener("resize", positionNote);
  tick();
})();
