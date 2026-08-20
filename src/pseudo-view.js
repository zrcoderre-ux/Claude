/**
 * Claude Usage Meter — pseudonym translation on claude.ai (ISOLATED world).
 *
 * The decisions live in src/pseudo.js (pure, tested); this is the wiring.
 * Three jobs, one key:
 *
 *   1. DISPLAY translation. In a conversation a pseudonym key is attached to
 *      (through the popup, or riding a workflow run), every fake in the
 *      rendered messages is swapped for its real value — READ side only.
 *      Claude's own state is untouched: the swap edits text nodes in message
 *      turns, never the composer, and everything the extension sends or
 *      copies out of a chat reads claude.ai's API/state, not this DOM. A
 *      badge says translation is on and how many swaps are showing, so what
 *      you see is never silently different from what Claude sees.
 *
 *   2. The COMPOSER warning. While a key is attached, the draft message is
 *      watched for REAL values from the key; each one found gets a loud
 *      banner naming the fake to use instead. Warn, never rewrite — the
 *      composer belongs to the user.
 *
 *   3. The KEY-UPLOAD guard, active on every claude.ai page whether or not a
 *      key is attached anywhere. The key spreadsheet is the whole real↔fake
 *      map, so it must never ride an upload into a chat by accident: a file
 *      picked, dropped or pasted that is pseudonym_key*.xlsx by name — or any
 *      .xlsx whose sheets carry the key's header fingerprint — is held back
 *      and only goes through on an affirmative "Upload anyway". Other files
 *      in the same batch pass through untouched.
 *
 * Cowork note (see CLAUDE.md): the guard intercepts the page's file-chooser,
 * drop and paste events, which are generic DOM mechanics — but it is CONFIRMED
 * only on Chat. Cowork's upload traffic runs in a worker no page hook sees, so
 * treat the guard there as best-effort until seen working.
 */
(function () {
  "use strict";

  const P = window.CUMPseudo;
  const X = window.CUMXlsx;
  if (!P || !X) return;

  const KEYS_KEY = "cum_pseudo_keys"; // id -> parsed key (see popup.js)
  const CHATS_KEY = "cum_pseudo_chats"; // conversation key -> key id

  const MSG_SEL =
    '[data-testid="user-message"],[data-testid="assistant-message"],' +
    ".font-user-message,.font-claude-response,.font-claude-message";

  // ---- which key this conversation gets -----------------------------------

  let keys = {}; // the stored key library
  let chatMap = {}; // conversation -> key id
  let runsCache = { at: 0, runs: [] };

  let active = null; // { id, key, compiled, compiledReals, via }
  let lastConv = null;

  function convKey() {
    const W = window.CUMWorkflow;
    return W && W.conversationKey
      ? W.conversationKey(location.href)
      : P.conversationKeyFromUrl(location.href);
  }

  function storageGet(what) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(what, (r) => resolve(r || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  // A run carries its key the way it carries its documents — on the run. Any
  // run whose recorded chats include this conversation attaches its key here
  // without the popup being involved — and a run with no key of its own
  // answers to its GROUP's: related runs are one matter, and one matter has
  // one key (W.runPseudoKey settles whose wins).
  async function runKeyFor(conv) {
    const W = window.CUMWorkflow;
    if (!W || !W.RUN_IDS_KEY) return null;
    if (Date.now() - runsCache.at > 20000) {
      const idsRes = await storageGet([W.RUN_IDS_KEY, "cum_run_groups"]);
      const ids = idsRes[W.RUN_IDS_KEY] || [];
      const runs = [];
      if (ids.length) {
        const res = await storageGet(ids.map((id) => W.RUN_PREFIX + id));
        for (const id of ids) if (res[W.RUN_PREFIX + id]) runs.push(res[W.RUN_PREFIX + id]);
      }
      runsCache = { at: Date.now(), runs: runs, groups: idsRes.cum_run_groups || [] };
    }
    for (const run of runsCache.runs) {
      if (!run) continue;
      const chats = run.chats || {};
      for (const cid of Object.keys(chats)) {
        const url = chats[cid] && chats[cid].url;
        if (url && P.conversationKeyFromUrl(url) === conv) {
          const id = W.runPseudoKey
            ? W.runPseudoKey(run, runsCache.runs, runsCache.groups || [])
            : run.pseudoKeyId;
          if (id) return id;
        }
      }
    }
    return null;
  }

  async function resolveActive(force) {
    const conv = convKey();
    // With a key active, only a navigation matters; without one, keep looking —
    // a run records this conversation's URL a beat after opening it.
    if (!force && conv === lastConv && active) return;
    lastConv = conv;
    let id = conv ? chatMap[conv] : null;
    let via = "chat";
    if (!id && conv) {
      id = await runKeyFor(conv);
      via = "run";
    }
    const key = id ? keys[id] : null;
    if (!key) {
      if (active) {
        active = null;
        render();
      }
      return;
    }
    // Same key object, same chat → nothing to rebuild. A RELOADED key is a new
    // object under the same id, so it falls through and recompiles.
    if (active && active.id === id && active.conv === conv && active.key === key) return;
    active = {
      id: id,
      conv: conv,
      key: key,
      compiled: P.compile(key),
      compiledReals: P.compileReals(key),
      via: via,
    };
    swapped = new WeakMap();
    shown = 0;
    render();
    sweepSoon();
  }

  async function loadState() {
    const res = await storageGet([KEYS_KEY, CHATS_KEY]);
    keys = res[KEYS_KEY] || {};
    chatMap = res[CHATS_KEY] || {};
    await resolveActive(true);
  }

  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch[KEYS_KEY] || ch[CHATS_KEY]) loadState();
      else if (
        ch.cum_run_groups ||
        Object.keys(ch).some((k) => k.indexOf("cum_wf_run") === 0)
      ) {
        runsCache.at = 0;
        resolveActive(true);
      }
    });
  } catch (e) {
    /* translation stays off */
  }

  // ---- display translation --------------------------------------------------

  // node -> the text this script last wrote there, so re-observing our own
  // write (or React writing the same fake back mid-stream) never loops.
  let swapped = new WeakMap();
  let shown = 0; // occurrences currently swapped, for the badge
  let sweepTimer = null;

  function skippable(el) {
    if (!el) return true;
    if (el.closest('[contenteditable="true"],input,textarea,script,style')) return true;
    if (el.closest('[class*="cum-pseudo"]')) return true;
    return false;
  }

  function sweep() {
    sweepTimer = null;
    if (!active || !active.compiled.rx) return;
    let total = 0;
    for (const turn of document.querySelectorAll(MSG_SEL)) {
      const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue;
        if (!text || text.length < 2) continue;
        const prior = swapped.get(node);
        if (prior && prior.text === text) {
          // Already ours — nothing to rewrite, but it still counts on the badge.
          total += prior.count;
          continue;
        }
        if (skippable(node.parentElement)) continue;
        const r = P.translate(active.compiled, text);
        if (r.count > 0) {
          node.nodeValue = r.text;
          swapped.set(node, { text: r.text, count: r.count });
          total += r.count;
        } else {
          // Remember the miss too, so a long conversation isn't re-scanned
          // node by node on every streaming tick.
          swapped.set(node, { text: text, count: 0 });
        }
      }
    }
    if (total !== shown) {
      shown = total;
      render();
    }
  }

  function sweepSoon() {
    if (sweepTimer) return;
    sweepTimer = setTimeout(sweep, 180);
  }

  const mo = new MutationObserver(() => {
    if (active) sweepSoon();
  });

  // ---- the badge and the composer warning ------------------------------------

  let badge = null;
  let warnBox = null;

  function render() {
    if (!active) {
      if (badge) {
        badge.remove();
        badge = null;
      }
      if (warnBox) {
        warnBox.remove();
        warnBox = null;
      }
      return;
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "cum-pseudo-badge";
      badge.title =
        "Display only: this tab swaps the pseudonyms back to the real names for YOU. " +
        "Claude still holds — and only ever sees — the fakes. Sends, copies and " +
        "exports read claude.ai's own data, not this view.";
      document.documentElement.appendChild(badge);
    }
    const name = active.key.name || "pseudonym key";
    badge.textContent =
      "🔑 " + name + (shown ? " — " + shown + " name" + (shown === 1 ? "" : "s") + " restored" : "");
  }

  function warnHtmlFor(hits) {
    const bits = hits.slice(0, 4).map((h) => {
      const real = document.createElement("b");
      real.textContent = "“" + h.real + "”";
      const fake = document.createElement("b");
      fake.textContent = "“" + h.fake + "”";
      const line = document.createElement("div");
      line.className = "cum-pseudo-warn-line";
      line.append(real, " is a real value — the chat should say ", fake, ".");
      return line;
    });
    return bits;
  }

  function checkComposer() {
    if (!active || !active.compiledReals.rx) {
      if (warnBox) warnBox.hidden = true;
      return;
    }
    const C = window.CUMComposer;
    const ed =
      (C && C.findEditor && C.findEditor()) ||
      document.querySelector('div[contenteditable="true"]');
    const text = ed ? ed.innerText || ed.textContent || "" : "";
    // A draft opening with the PINCITE CHECK header is the operator pasting
    // official-reporter pincites out of Lexis — published citations, declared
    // safe. The warning stands down for that draft (P.isPincitePaste).
    const hits =
      text && !P.isPincitePaste(text) ? P.findReals(active.compiledReals, text) : [];
    if (!hits.length) {
      if (warnBox) warnBox.hidden = true;
      return;
    }
    if (!warnBox) {
      warnBox = document.createElement("div");
      warnBox.className = "cum-pseudo-warn";
      document.documentElement.appendChild(warnBox);
    }
    warnBox.hidden = false;
    warnBox.textContent = "";
    const head = document.createElement("div");
    head.className = "cum-pseudo-warn-head";
    head.textContent = "⚠ Real name in your draft";
    warnBox.appendChild(head);
    for (const line of warnHtmlFor(hits)) warnBox.appendChild(line);
    if (hits.length > 4) {
      const more = document.createElement("div");
      more.className = "cum-pseudo-warn-line";
      more.textContent = "…and " + (hits.length - 4) + " more.";
      warnBox.appendChild(more);
    }
  }

  // ---- the key-upload guard ---------------------------------------------------
  //
  // Always on. Interception is capture-phase on window, so it runs before any
  // page handler; a batch with a suspect file is swallowed whole, vetted
  // asynchronously (name first, then the sheet fingerprint for any .xlsx), and
  // re-dispatched with everything the user let through. `passing` marks our own
  // re-dispatch so it sails past this same listener.

  let passing = false;

  function suspectName(name) {
    return P.isKeyFileName(name) || /\.xlsx$/i.test(String(name || ""));
  }

  async function isKeyFile(file) {
    if (P.isKeyFileName(file.name)) return true;
    if (!/\.xlsx$/i.test(file.name || "")) return false;
    try {
      const wb = await X.parseXlsx(await file.arrayBuffer());
      return P.sheetsLookLikeKey(wb.sheets);
    } catch (e) {
      return false; // unreadable spreadsheets are not silently blocked
    }
  }

  function guardDialog(keyNames, otherCount) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "cum-pseudo-guard";
      const box = document.createElement("div");
      box.className = "cum-pseudo-guard-box";
      const h = document.createElement("div");
      h.className = "cum-pseudo-guard-head";
      h.textContent = "That looks like your pseudonym key";
      const p = document.createElement("p");
      p.textContent =
        keyNames.join(", ") +
        " is the real↔fake map. Uploading it into a chat hands Claude every real " +
        "name the pseudonymization exists to withhold." +
        (otherCount ? " The other " + otherCount + " file(s) will still go through." : "");
      const row = document.createElement("div");
      row.className = "cum-pseudo-guard-row";
      const keep = document.createElement("button");
      keep.className = "cum-pseudo-guard-keep";
      keep.textContent = "Keep it out";
      const send = document.createElement("button");
      send.className = "cum-pseudo-guard-send";
      send.textContent = "Upload anyway";
      row.append(keep, send);
      box.append(h, p, row);
      overlay.appendChild(box);
      const done = (ok) => {
        overlay.remove();
        resolve(ok);
      };
      keep.addEventListener("click", () => done(false));
      send.addEventListener("click", () => done(true));
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) done(false);
      });
      document.documentElement.appendChild(overlay);
      keep.focus();
    });
  }

  async function vet(files) {
    const keyFiles = [];
    const clean = [];
    for (const f of files) {
      if (await isKeyFile(f)) keyFiles.push(f);
      else clean.push(f);
    }
    if (!keyFiles.length) return files;
    const ok = await guardDialog(keyFiles.map((f) => f.name), clean.length);
    return ok ? files : clean;
  }

  function fileList(files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    return dt;
  }

  window.addEventListener(
    "change",
    (ev) => {
      if (passing) return;
      const input = ev.target;
      if (!input || input.type !== "file" || !input.files || !input.files.length) return;
      const files = Array.from(input.files);
      if (!files.some((f) => suspectName(f.name))) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      input.value = "";
      vet(files).then((release) => {
        if (!release.length) return;
        try {
          input.files = fileList(release).files;
          passing = true;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } finally {
          passing = false;
        }
      });
    },
    true
  );

  window.addEventListener(
    "drop",
    (ev) => {
      if (passing) return;
      const dt = ev.dataTransfer;
      const files = dt && dt.files ? Array.from(dt.files) : [];
      if (!files.length || !files.some((f) => suspectName(f.name))) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      const target = ev.target;
      vet(files).then((release) => {
        if (!release.length) return;
        const C = window.CUMComposer;
        const el =
          (target && target.isConnected && target) ||
          (C && C.findEditor && C.findEditor()) ||
          document.body;
        try {
          passing = true;
          if (C && C.dropFiles) C.dropFiles(el, release);
          else {
            const r = new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer: fileList(release),
            });
            el.dispatchEvent(r);
          }
        } finally {
          passing = false;
        }
      });
    },
    true
  );

  window.addEventListener(
    "paste",
    (ev) => {
      if (passing) return;
      const dt = ev.clipboardData;
      const files = dt && dt.files ? Array.from(dt.files) : [];
      if (!files.length || !files.some((f) => suspectName(f.name))) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      const target = ev.target;
      vet(files).then((release) => {
        if (!release.length) return;
        const el = (target && target.isConnected && target) || document.body;
        try {
          passing = true;
          el.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: fileList(release),
            })
          );
        } finally {
          passing = false;
        }
      });
    },
    true
  );

  // ---- start ------------------------------------------------------------------

  loadState().then(() => {
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    setInterval(() => {
      resolveActive(false); // SPA navigation
      checkComposer();
    }, 900);
  });
})();
