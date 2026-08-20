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
  const POS_KEY = "cum_pseudo_pos"; // where the user dragged the badge { left, top }

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
      // real → fake, for the badge's cleaner box.
      forward: P.compileForward(key),
      // the as-you-type prompt's entries (press → to swap).
      ahead: P.compileTypeahead(key),
      via: via,
    };
    swapped = new WeakMap();
    shown = 0;
    paused = false; // a peek never outlives its chat
    // A different key means a different map — a cleaner left open would keep
    // showing the last case's title over this one's swaps.
    closeCleaner();
    render();
    sweepSoon();
  }

  async function loadState() {
    const res = await storageGet([KEYS_KEY, CHATS_KEY, POS_KEY]);
    keys = res[KEYS_KEY] || {};
    chatMap = res[CHATS_KEY] || {};
    const p = res[POS_KEY];
    if (p && typeof p.left === "number" && typeof p.top === "number") badgePos = p;
    await resolveActive(true);
  }

  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch[POS_KEY]) {
        // Dragged in another tab: the badge is one control in as many tabs as
        // are open, and having to move it in each of them would be worse than
        // it moving under you here.
        const np = ch[POS_KEY].newValue;
        if (np && typeof np.left === "number" && typeof np.top === "number") {
          badgePos = np;
          placeBadge(false);
        }
      }
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

  // Paused = "let me peek at what claude.ai is actually showing": the fakes
  // are put back and no new text is translated until resumed. Per-tab and
  // deliberately NOT persisted — a peek that silently outlived the visit
  // would be a translation quietly off. The composer warning, the typeahead
  // and the upload guard stay on: they are safety, not display.
  let paused = false;

  function setPaused(on) {
    paused = !!on;
    if (paused) {
      for (const turn of document.querySelectorAll(MSG_SEL)) {
        const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const p = swapped.get(node);
          if (p && p.count > 0 && node.nodeValue === p.text) {
            node.nodeValue = p.orig;
            swapped.delete(node);
          }
        }
      }
      shown = 0;
    } else {
      sweepSoon();
    }
    render();
  }

  function sweep() {
    sweepTimer = null;
    if (!active || paused || !active.compiled.rx) return;
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
          // `orig` is what the pause toggle restores — the fakes as claude.ai
          // rendered them.
          swapped.set(node, { text: r.text, orig: text, count: r.count });
          total += r.count;
        } else {
          // Remember the miss too, so a long conversation isn't re-scanned
          // node by node on every streaming tick.
          swapped.set(node, { text: text, orig: text, count: 0 });
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
  let badgePos = null; // { left, top } once dragged; null = its default corner
  let badgeDragged = false; // set through a drag so the click that ends it isn't a tap

  // ---- dragging the badge ---------------------------------------------------
  // The same contract as the usage meter's own pill, because it's the same kind
  // of object: a small fixed thing sitting over someone else's page, which is
  // going to be over the wrong part of it sooner or later. Position is clamped
  // to the viewport, remembered across tabs and reloads, and a drag never counts
  // as the click that opens the cleaner.

  function clampBadge(left, top) {
    const r = badge.getBoundingClientRect();
    return {
      left: Math.min(Math.max(0, left), Math.max(0, window.innerWidth - r.width)),
      top: Math.min(Math.max(0, top), Math.max(0, window.innerHeight - r.height)),
    };
  }

  // Switch the badge from its default left/bottom corner to explicit left/top.
  // Called on every render and on resize, so a window narrowed since the drag
  // brings the badge back on screen instead of stranding it past the edge.
  function placeBadge(persist) {
    if (!badge || !badgePos) return;
    const c = clampBadge(badgePos.left, badgePos.top);
    badge.style.left = c.left + "px";
    badge.style.top = c.top + "px";
    badge.style.right = "auto";
    badge.style.bottom = "auto";
    badgePos = c;
    placeCleaner();
    if (persist) {
      try {
        chrome.storage?.local.set({ [POS_KEY]: c });
      } catch (e) {
        /* a position we couldn't store is still the position on screen */
      }
    }
  }

  // The cleaner opens off the badge, so it goes wherever the badge went — above
  // it where there's room for it, below it where there isn't.
  function placeCleaner() {
    if (!cleaner || !badge) return;
    if (!badgePos) {
      cleaner.style.left = "";
      cleaner.style.top = "";
      cleaner.style.bottom = "";
      return;
    }
    const b = badge.getBoundingClientRect();
    const h = cleaner.offsetHeight || 260;
    const w = cleaner.offsetWidth || 420;
    const above = b.top - 8 - h;
    const top = above >= 8 ? above : Math.min(b.bottom + 8, Math.max(8, window.innerHeight - h - 8));
    cleaner.style.left = Math.max(8, Math.min(b.left, window.innerWidth - w - 8)) + "px";
    cleaner.style.top = top + "px";
    cleaner.style.bottom = "auto";
  }

  function setupBadgeDrag(el) {
    let startX = 0, startY = 0, originLeft = 0, originTop = 0, moved = false, dragging = false;

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const r = el.getBoundingClientRect();
      originLeft = r.left;
      originTop = r.top;
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });

    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return; // ignore tiny jitters
      moved = true;
      badgePos = { left: originLeft + dx, top: originTop + dy };
      placeBadge(false);
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      if (moved) {
        badgeDragged = true; // the click that follows this drag is not a tap
        placeBadge(true);
      }
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  window.addEventListener("resize", () => {
    placeBadge(false);
  });

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
      closeCleaner();
      hideTip();
      return;
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "cum-pseudo-badge";
      badge.title =
        "Display only: this tab swaps the pseudonyms back to the real names for YOU. " +
        "Claude still holds — and only ever sees — the fakes. Sends, copies and " +
        "exports read claude.ai's own data, not this view. " +
        "Click to open the cleaner: type text with real names, copy out the fakes. " +
        "Drag it anywhere — where you put it is where it stays.";
      badge.addEventListener("click", () => {
        if (badgeDragged) {
          badgeDragged = false;
          return;
        }
        toggleCleaner();
      });
      setupBadgeDrag(badge);
      document.documentElement.appendChild(badge);
      placeBadge(false); // a position from an earlier visit, applied on arrival
    }
    // Led by the case hint: with two cases open in two tabs, every key file
    // is named pseudonym_key.xlsx and the badge has to say WHICH case this
    // tab is translating. (The tab already shows the real names — the hint
    // reveals nothing the translation doesn't.)
    const name =
      (active.key.hint ? active.key.hint + " · " : "") +
      (active.key.name || "pseudonym key");
    badge.textContent = paused
      ? "🔑 " + name + " — ⏸ showing the fakes"
      : "🔑 " + name + (shown ? " — " + shown + " name" + (shown === 1 ? "" : "s") + " restored" : "");
    badge.classList.toggle("cum-pseudo-paused", paused);
    const tog = cleaner && cleaner.querySelector(".cum-pseudo-clean-toggle");
    if (tog) tog.textContent = paused ? "▶ Show real names" : "⏸ Show the fakes";
  }

  // ---- the cleaner: type real names, paste out fakes -------------------------
  //
  // Opens from the badge. Whatever is typed is pseudonymized LIVE with the
  // attached key — the ReAnonymize direction, longest real first, keeps left
  // verbatim, common English never touched — into a read-only box beside it,
  // with Copy. It writes nothing into the composer: pasting the cleaned text
  // is deliberately the user's own move.

  let cleaner = null;

  function closeCleaner() {
    if (cleaner) {
      cleaner.remove();
      cleaner = null;
    }
  }

  function runCleaner() {
    if (!cleaner || !active) return;
    const src = cleaner.querySelector(".cum-pseudo-clean-in").value;
    const out = cleaner.querySelector(".cum-pseudo-clean-out");
    const note = cleaner.querySelector(".cum-pseudo-clean-note");
    const r = P.translate(active.forward, src);
    out.value = r.text;
    note.textContent = src
      ? r.count + " value" + (r.count === 1 ? "" : "s") + " swapped. Only values the key " +
        "knows are swapped — read it before pasting."
      : "";
  }

  function toggleCleaner() {
    if (cleaner) return closeCleaner();
    if (!active) return;
    cleaner = document.createElement("div");
    cleaner.className = "cum-pseudo-clean";
    const head = document.createElement("div");
    head.className = "cum-pseudo-clean-head";
    const title = document.createElement("span");
    title.textContent = "Pseudonymize for pasting — " + (active.key.name || "key");
    const x = document.createElement("button");
    x.className = "cum-pseudo-clean-x";
    x.textContent = "✕";
    x.title = "Close";
    x.addEventListener("click", closeCleaner);
    head.append(title, x);

    const input = document.createElement("textarea");
    input.className = "cum-pseudo-clean-in";
    input.placeholder = "Type or paste text with real names…";
    input.addEventListener("input", runCleaner);

    const out = document.createElement("textarea");
    out.className = "cum-pseudo-clean-out";
    out.readOnly = true;
    out.placeholder = "The cleaned version appears here.";

    const foot = document.createElement("div");
    foot.className = "cum-pseudo-clean-foot";
    // The peek toggle: pause the in-chat translation to see exactly what
    // claude.ai is showing (the fakes), then bring the real names back.
    const toggle = document.createElement("button");
    toggle.className = "cum-pseudo-clean-toggle";
    toggle.textContent = paused ? "▶ Show real names" : "⏸ Show the fakes";
    toggle.title =
      "Pause or resume this chat's translation. Paused shows the conversation exactly " +
      "as claude.ai renders it — the fakes. This tab only, and never remembered.";
    toggle.addEventListener("click", () => setPaused(!paused));
    const note = document.createElement("span");
    note.className = "cum-pseudo-clean-note";
    const copy = document.createElement("button");
    copy.className = "cum-pseudo-clean-copy";
    copy.textContent = "Copy cleaned";
    copy.addEventListener("click", () => {
      const text = out.value;
      if (!text) return;
      const flash = (ok) => {
        copy.textContent = ok ? "Copied ✓" : "Select it and copy by hand";
        setTimeout(() => {
          copy.textContent = "Copy cleaned";
        }, 1600);
      };
      try {
        navigator.clipboard.writeText(text).then(
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
    foot.append(toggle, note, copy);

    cleaner.append(head, input, out, foot);
    document.documentElement.appendChild(cleaner);
    placeCleaner(); // it opens off the badge, wherever the badge has been put
    input.focus();
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
    const hits = (
      text && !P.isPincitePaste(text) ? P.findReals(active.compiledReals, text) : []
    ).filter(
      // The value the caret prompt is offering right now is being handled —
      // the banner covers everything the caret is NOT on.
      (h) => !(tipHit && tipEl && !tipEl.hidden && P.fold(h.real) === P.fold(tipHit.real))
    );
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

  // ---- the as-you-type prompt: finish a real name, press → for the fake -----
  //
  // The moment the caret sits at the end of a just-typed REAL value, a small
  // prompt appears at the caret offering the pseudonym; ArrowRight swaps it
  // in place (via the selection + insertText, which ProseMirror handles as
  // ordinary typing), Escape dismisses for that spot, and any other typing
  // moves the caret past the word and the prompt goes on its own. The
  // banner below stays as the net for everything the caret is NOT on —
  // pasted text, a dismissed prompt — but never doubles the value currently
  // being offered.

  let tipEl = null;
  let tipHit = null; // { real, fake, matched, at } while showing
  let tipDismissed = null; // "at|real" the user Escaped, until the text moves
  let tipTimer = null;

  function editorEl() {
    const C = window.CUMComposer;
    return (
      (C && C.findEditor && C.findEditor()) ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  // The caret's position as an offset into the editor's own text, plus that
  // text up to the caret — null when the selection isn't a caret in the
  // editor.
  function caretContext(ed) {
    const sel = window.getSelection();
    if (!ed || !sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!ed.contains(r.startContainer)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(ed);
    pre.setEnd(r.startContainer, r.startOffset);
    return { textBefore: pre.toString(), range: r };
  }

  function hideTip() {
    tipHit = null;
    if (tipEl) tipEl.hidden = true;
  }

  function updateTip() {
    tipTimer = null;
    if (!active || !active.ahead || !active.ahead.length) return hideTip();
    const ed = editorEl();
    const ctx = ed && caretContext(ed);
    const hit = ctx && P.endingReal(active.ahead, ctx.textBefore);
    if (!hit) return hideTip();
    const sig = ctx.textBefore.length + "|" + P.fold(hit.real);
    if (tipDismissed === sig) return hideTip();
    tipHit = { real: hit.real, fake: hit.fake, matched: hit.matched, sig: sig };
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "cum-pseudo-tip";
      document.documentElement.appendChild(tipEl);
    }
    tipEl.textContent = "";
    const swap = document.createElement("b");
    swap.textContent = hit.matched + " → " + P.mirrorCase(hit.matched, hit.fake);
    const how = document.createElement("span");
    how.className = "cum-pseudo-tip-how";
    how.textContent = "  press → to swap · Esc to keep";
    tipEl.append(swap, how);
    tipEl.hidden = false;
    // At the caret, just above the line; a collapsed caret still has a rect.
    let rect = ctx.range.getBoundingClientRect();
    if (!rect || (!rect.top && !rect.left)) rect = ed.getBoundingClientRect();
    tipEl.style.left = Math.min(rect.left, window.innerWidth - 340) + "px";
    tipEl.style.top = Math.max(6, rect.top - 34) + "px";
  }

  function tipSoon() {
    if (tipTimer) return;
    tipTimer = setTimeout(updateTip, 80);
  }

  function swapAtCaret() {
    const ed = editorEl();
    const ctx = ed && caretContext(ed);
    const hit = ctx && P.endingReal(active.ahead, ctx.textBefore);
    // Confirm against what's showing — the caret may have moved since.
    if (!hit || !tipHit || P.fold(hit.real) !== P.fold(tipHit.real)) return false;
    const sel = window.getSelection();
    for (let i = 0; i < hit.matched.length; i++) sel.modify("extend", "backward", "character");
    ed.focus();
    // The same door composer.js types through — ProseMirror treats it as
    // ordinary input, so undo (Ctrl+Z) brings the real name back if wanted.
    document.execCommand("insertText", false, P.mirrorCase(hit.matched, hit.fake));
    hideTip();
    return true;
  }

  window.addEventListener(
    "keydown",
    (ev) => {
      if (!tipHit || !tipEl || tipEl.hidden) return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      if (ev.key === "ArrowRight") {
        if (swapAtCaret()) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
        }
      } else if (ev.key === "Escape") {
        tipDismissed = tipHit.sig;
        hideTip();
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    },
    true
  );

  document.addEventListener("selectionchange", () => {
    if (active) tipSoon();
  });

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
