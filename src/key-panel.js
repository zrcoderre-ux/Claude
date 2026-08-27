/**
 * Claude Usage Meter — the key button, beside Save (ISOLATED world).
 *
 * Everything the pseudonym feature needs, on the page, in one control: a key
 * in the tray next to claude.ai's own sidebar toggle, first in the row, and a
 * panel under it holding both halves of what used to be two separate things.
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
 * THE BUTTON CARRIES THE COUNT, and that is not decoration. The badge existed
 * for one invariant — a real name on screen always has something on screen
 * saying why — and a panel that has to be opened would have quietly ended it.
 * So the button reads "🔑 12" while twelve values are showing, goes quiet when
 * nothing is translated, and says so plainly when a peek or a run has the
 * display standing down.
 *
 * The decisions it renders are not here. src/pseudo-view.js owns the keys, the
 * sweep and the peek, and publishes state()/clean()/setPaused()/subscribe();
 * src/pseudo.js owns what a key IS; src/masterkey.js owns the last 20 cases.
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
  if (!C || !P || !X || !V) return;

  const BTN_ID = "cum-key-btn";
  const PANEL_ID = "cum-key";
  const KEYS_KEY = "cum_pseudo_keys";
  const CHATS_KEY = "cum_pseudo_chats";
  const MASTER_KEY = "cum_pseudo_master";
  const TICK_MS = 1200;

  let btn = null;
  let panel = null;
  let fileInput = null;
  let open = false;
  let state = { on: false, names: 0, titles: 0, paused: false, hold: null };
  let lastKeyId = null; // so a change of case empties the cleaner's boxes

  let keys = {};
  let chats = {};
  let master = null;
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
    const res = await get([KEYS_KEY, CHATS_KEY, MASTER_KEY]);
    keys = res.data[KEYS_KEY] || {};
    chats = res.data[CHATS_KEY] || {};
    master = res.data[MASTER_KEY] || null;
    draw();
  }

  /** Which conversation this tab IS, in the spelling every reader uses. */
  function convKey() {
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
      () => V.setPaused(!state.paused)
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
    const conv = convKey();
    const ids = Object.keys(keys);
    const attached = conv ? chats[conv] : null;
    box.appendChild(el("div", "cum-key-h", "This conversation"));
    box.appendChild(
      el(
        "p",
        "cum-key-line",
        !conv
          ? "Open a conversation to attach a key to it."
          : attached && keys[attached]
          ? "Attached: " + keyLabel(keys[attached])
          : ids.length
          ? "No key attached here."
          : "No key loaded yet."
      )
    );
    if (ids.length > 1) {
      const sel = el("select", "cum-key-select");
      for (const id of ids) {
        const opt = el("option", null, keyLabel(keys[id]));
        opt.value = id;
        sel.appendChild(opt);
      }
      if (attached && keys[attached]) sel.value = attached;
      sel.id = "cum-key-select";
      box.appendChild(sel);
    }
    const row = el("div", "cum-key-row");
    const attach = button("Attach to this chat", "cum-key-primary", () => {
      const sel = panel && panel.querySelector("#cum-key-select");
      const id = (sel && sel.value) || ids[0];
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

  // ---- the library -----------------------------------------------------------

  async function loadKeyFile(file) {
    if (!file) return;
    say("Reading " + file.name + "…");
    let wb;
    try {
      wb = await X.parseXlsx(await file.arrayBuffer());
    } catch (e) {
      return say("Couldn't read that file: " + String((e && e.message) || e));
    }
    if (!wb || !(P.isKeyFileName(file.name) || P.sheetsLookLikeKey(wb.sheets)))
      return say("That workbook has no Real Value / Replacement sheet — not a pseudonym key.");
    const key = P.parseKey(wb.sheets, file.name);
    if (!key || !key.rows) return say("The key parsed but holds no usable rows.");
    // Content decides identity, never the filename — every case's key is named
    // pseudonym_key.xlsx, and a filename as the library id would silently
    // replace the first case with the second.
    const where = P.libraryIdFor(keys, key);
    key.savedAt = Date.now();
    // The file cannot know which case FOLDER named this key, so a refresh from
    // here keeps what the entry already learned.
    keys[where.id] = P.keepKeyFacts ? P.keepKeyFacts(keys[where.id], key) : key;
    await set({ [KEYS_KEY]: keys });
    const d = key.dropped || {};
    say(
      (where.refreshed ? "Refreshed " : "Loaded ") +
        keyLabel(key) +
        (d.keeps ? " · " + d.keeps + " keep rows skipped" : "") +
        (d.ambiguous ? " · " + d.ambiguous + " ambiguous fakes retired" : "")
    );
    load();
  }

  function pickFile() {
    if (!fileInput || !fileInput.isConnected) {
      fileInput = el("input");
      // C.isOurs — the key-upload guard has to leave our own picker alone, or
      // the one door that exists for loading a key would refuse to load one.
      fileInput.id = "cum-key-file";
      fileInput.type = "file";
      fileInput.accept = ".xlsx";
      fileInput.style.display = "none";
      fileInput.addEventListener("change", () => {
        const f = (fileInput.files || [])[0];
        fileInput.value = "";
        if (f) loadKeyFile(f);
      });
      (document.body || document.documentElement).appendChild(fileInput);
    }
    fileInput.click();
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
          ? ids.length + (ids.length === 1 ? " key loaded." : " keys loaded.")
          : "Nothing loaded. A key is parsed here and never uploaded."
      )
    );
    const row = el("div", "cum-key-row");
    row.appendChild(button("Load pseudonym_key.xlsx…", "", pickFile));
    if (ids.length)
      row.appendChild(
        button("Forget key", "cum-key-warn", async () => {
          const sel = panel && panel.querySelector("#cum-key-select");
          const id = (sel && sel.value) || ids[0];
          if (!id) return;
          delete keys[id];
          for (const conv of Object.keys(chats)) if (chats[conv] === id) delete chats[conv];
          await set({ [KEYS_KEY]: keys, [CHATS_KEY]: chats });
          say("Forgotten, and detached everywhere it was attached.");
          load();
        })
      );
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
      const r = V.clean(input.value);
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
      btn.classList.toggle("cum-key-on", st.on && !st.paused && !st.hold);
      btn.classList.toggle("cum-key-off", st.on && (st.paused || !!st.hold));
      btn.title =
        (st.on
          ? st.name + " — " + statusLine(st)
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
  // First in the tray, so the key sits to the LEFT of Save (src/tray.js orders
  // the row). The tray is the only home: unlike Save there is no header slot
  // fallback, because a key control that turned up in a different place on a
  // page that didn't load the tray would be worse than one that waited.

  function place() {
    const T = window.CUMTray;
    if (!T) return;
    const b = build();
    if (open) T.put("key", b, buildPanel());
    else T.put("key", b);
  }

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
