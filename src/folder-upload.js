/**
 * Claude Usage Meter — Upload folder, on a new conversation (ISOLATED world).
 *
 * A button in the tray beside claude.ai's own sidebar toggle, on a chat that
 * does not exist yet. It does to a chat you are about to type in exactly what
 * the run editor's folder pick does to a run (README: "A case folder is taken
 * apart, not uploaded"), and stops where a run would carry on:
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
 *   And when the conversation starts, it takes the folder's name — through the
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
  if (!C || !W || !DD || !F) return;

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
    btn.innerHTML =
      '<span class="cum-folder-ico">🗂</span><span class="cum-folder-txt">Folder</span>';
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
    place(); // puts the note in the tray slot beside the button
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
  async function loadKey(file, folder) {
    const P = window.CUMPseudo;
    const X = window.CUMXlsx;
    if (!P || !X || !X.parseXlsx || !F.isSpreadsheet(file.name)) return null;
    let key = null;
    try {
      const wb = await X.parseXlsx(await file.arrayBuffer());
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
    const decision = await titleFor(split.root, keyRec);
    const lines = [
      F.describeUpload({
        root: split.root,
        bundle: plan.bundle,
        singles: plan.singles,
        left: split.left,
        capped: split.capped,
      }),
      F.describeKey({
        root: split.root,
        keyName: keyRec ? keyRec.label : "",
        already: !!(keyRec && keyRec.already),
      }),
      F.describeTitle(decision),
    ];

    // Whatever happens to the upload, the key is loaded and the name is worked
    // out — so the wait is armed before the slow half rather than after it.
    const surface = surfaceHere();
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
    // The key the READER uses, not one of our own devising: pseudo-view keys
    // this map by W.conversationKey where it can and P.conversationKeyFromUrl
    // where it can't (a Cowork session has no uuid, so both fall back to the
    // path). A key filed under any other spelling is a key nothing finds.
    const conv = W.conversationKey
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
   * claude.ai titles a new conversation ITSELF, early — moments into the first
   * answer — and that lands on top of a rename made when the conversation
   * appeared. So the first minutes are re-checked on a backoff and the name is
   * stamped again only where claude.ai's own has won.
   *
   * On Chat the check is the conversation payload, because a tab translating a
   * key shows the real name in the header and the fake is what actually went
   * out. On Cowork there is nothing to fetch that answers, and nothing to
   * fetch either: renameCoworkSession reads the header's own control before it
   * touches anything and returns "ok" for a name already in place, so calling
   * it again IS the check.
   */
  async function keepNaming(conv, title) {
    const K = window.CUMCowork;
    for (const wait of [20000, 30000, 60000, 120000, 240000]) {
      await C.sleep(wait);
      const now = F.startedConversation(location.href);
      if (now.id !== conv.id) return; // moved on
      try {
        if (conv.surface === "cowork") {
          await C.renameCoworkSession(title);
          continue;
        }
        const got = await fetchConversation(conv.id);
        const payload = got && got.data;
        if (K && payload && K.sameTitle(K.conversationName(payload), title)) continue;
        await renameConversation(conv.id, title);
      } catch (e) {
        /* best effort: the conversation keeps whatever name it has */
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
    if (named.ok) {
      lines.push('Named it "' + named.name + '".');
      // The weaker evidence is said where it was what carried the decision, so
      // a name that landed on the wrong conversation is something you can see
      // rather than something you find later.
      if (/the page's word/.test(fresh.why)) lines.push("Confirmed from the page: " + fresh.why + ".");
      say(lines);
      keepNaming(conv, p.title);
    } else {
      lines.push(
        "Could not name it (" + named.error + ") — it keeps whatever claude.ai called it."
      );
      say(lines, true);
    }
  }

  // ---- placement -----------------------------------------------------------

  function place() {
    // The BUTTON belongs only where a send would CREATE the conversation. On a
    // chat that already exists there is nothing here to do that the run editor
    // doesn't do better, and a folder button over somebody's open work is an
    // invitation to attach a matter's papers to the wrong one.
    const wanted = F.isNewChatPath(location.href) && !!C.findEditor();
    if (!wanted && btn && btn.parentNode) btn.remove();
    // The NOTE outlives it by design: the send navigates off the composer, and
    // the naming happens after that. It stays while a pick is pending, on the
    // composer it was made from, and in the conversation it named — and goes
    // when the tab has moved on to something else.
    // Whatever it says, it gets long enough to be READ: a refusal written the
    // instant the tab left the composer would otherwise be swept away by the
    // same navigation that caused it.
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
    if (!wanted && !note) return;
    const b = wanted ? build() : null;
    // In the tray beside claude.ai's own sidebar toggle, with Save, the
    // contents list and Run (src/tray.js). The loose corner is only for a tray
    // that didn't load, and the class comes back off the moment one does.
    const T = window.CUMTray;
    if (T) {
      if (b) b.classList.remove("cum-folder-loose");
      if (note) note.classList.remove("cum-folder-loose");
      T.put("folder", b, note);
    } else {
      if (b) {
        b.classList.add("cum-folder-loose");
        if (b.parentNode !== document.body) document.body.appendChild(b);
      }
      if (note) {
        note.classList.add("cum-folder-loose");
        if (note.parentNode !== document.body) document.body.appendChild(note);
      }
    }
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
  tick();
})();
