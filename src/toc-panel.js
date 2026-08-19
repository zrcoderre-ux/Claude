/**
 * Claude Usage Meter — the table of contents panel (ISOLATED world content
 * script).
 *
 * A box, one per conversation, listing CLAUDE'S REPLIES (the owner's spec —
 * the replies are where the work product is). Click one and the chat jumps to
 * the top of that reply. Each entry is keyed to the prompt it answers, which
 * is how a workflow step — identified by its prompt — still finds its reply.
 *
 * Starts minimized — a chat you're just reading shouldn't have a panel over it —
 * behind a button in claude.ai's own header, in with the file and share
 * controls, beside Save. The panel it opens is still free-floating and
 * draggable, and its position is remembered: the same treatment the meter gets,
 * because the right corner for it depends on the window and on the day.
 *
 * The list is built from the CONVERSATION, not from the page. claude.ai unmounts
 * messages that scroll far out of view, so a list rebuilt from what's rendered
 * loses entries behind you as you scroll — which is the exact opposite of what
 * this is for. Where there is no conversation to read (an incognito chat is
 * never saved), the page's windows are merged instead of replacing each other.
 *
 * That means an entry you click may not be rendered at all, so there is nothing
 * to scroll to. See seek(): aim by proportion, look at what turned up, and go
 * again.
 */
(function () {
  "use strict";

  const T = window.CUMToc;
  const W = window.CUMWorkflow;
  const C = window.CUMComposer;
  const M = window.CUMMdExport;
  const St = window.CUMStamp;
  const V = window.CUMConv;
  if (!T) return;

  const ID = "cum-toc";
  const BTN_ID = "cum-toc-btn";
  const POS_KEY = "cum_toc_pos"; // { left, top }
  const OPEN_KEY = "cum_toc_open"; // remembered across chats, not per chat
  const RESCAN_MS = 1500;
  const REFETCH_MS = 6000; // no faster than this, however often a prompt lands

  let el = null;
  let btn = null;
  let listEl = null;
  let countEl = null;
  let open = false;
  let pos = null;
  let entries = []; // { n, key, label, … } — the list, one entry per message
  let fromApi = false; // the list came from the conversation, not the page
  let convId = null; // …and this is the conversation it came from
  let fetching = false;
  let lastFetch = 0;
  let misses = 0; // fetches that found nothing, which back the next one off
  let lastKey = "";

  function storageGet(keys) {
    return new Promise((r) => {
      try {
        chrome.storage.local.get(keys, (x) => r(x || {}));
      } catch (e) {
        r({});
      }
    });
  }
  function storageSet(obj) {
    try {
      chrome.storage.local.set(obj);
    } catch (e) {
      /* ignore */
    }
  }

  // ---- finding the messages ----------------------------------------------
  // The same selector cascades the workflow runner uses, for the same reason:
  // claude.ai's markup is unversioned, so try each and take the first that
  // matches anything. The list tracks Claude's REPLIES (the owner's spec);
  // the human messages are still read, because each reply is keyed to the
  // prompt it answers — that is how a workflow step finds its reply.
  const HUMAN_SELECTORS = [
    '[data-testid="user-message"]',
    ".font-user-message",
    '[data-testid="human-message"]',
  ];
  const REPLY_SELECTORS = [
    '[data-testid="assistant-message"]',
    ".font-claude-response",
    ".font-claude-message",
  ];

  function bySelectors(sels) {
    for (const sel of sels) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      const list = Array.from(nodes).filter((n) => !isOurs(n));
      if (list.length) return list;
    }
    return [];
  }
  function humanMessages() {
    return bySelectors(HUMAN_SELECTORS);
  }
  function replyMessages() {
    return bySelectors(REPLY_SELECTORS);
  }

  // A reply's text with its CONTROLS' captions removed — a Cowork reply
  // carries tool-status pills, and a label or key built over "Ran a command…"
  // says nothing about what the reply says.
  function textOf(node) {
    if (!node) return "";
    let copy;
    try {
      copy = node.cloneNode(true);
      for (const b of copy.querySelectorAll('button,[role="button"]')) b.remove();
    } catch (e) {
      return (node.textContent || "").trim();
    }
    return (copy.textContent || "").trim();
  }

  // Each rendered reply with the text of the prompt it answers — the nearest
  // human turn above it in the document.
  function repliesWithPrev() {
    const replies = replyMessages();
    const humans = humanMessages();
    return replies.map((r) => {
      let prev = null;
      for (const h of humans) {
        try {
          if (r.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING) prev = h;
          else break;
        } catch (e) {
          break;
        }
      }
      return { node: r, text: textOf(r), prev: prev ? (prev.textContent || "").trim() : null };
    });
  }

  function isOurs(node) {
    return !!(node && node.closest && node.closest("#" + ID + ", #" + BTN_ID));
  }

  // Which element actually scrolls. claude.ai scrolls an inner container, not
  // the document, and scrolling the wrong one does nothing at all.
  function scrollerFor(node) {
    let p = node && node.parentElement;
    while (p && p !== document.body) {
      const style = getComputedStyle(p);
      if (/(auto|scroll)/.test(style.overflowY) && p.scrollHeight > p.clientHeight + 40) return p;
      p = p.parentElement;
    }
    return null;
  }

  // Put the TOP of the reply near the top of the view: the reply IS the thing
  // being jumped to now, so its beginning is what belongs on screen.
  const TOP_GAP = 72; // room for claude.ai's own header
  function jumpTo(node) {
    if (!node || !node.isConnected) return false;
    const scroller = scrollerFor(node);
    const rect = node.getBoundingClientRect();
    try {
      if (scroller) {
        const base = scroller.getBoundingClientRect();
        scroller.scrollTo({
          top: scroller.scrollTop + (rect.top - base.top) - TOP_GAP,
          behavior: "smooth",
        });
      } else {
        window.scrollTo({ top: window.scrollY + rect.top - TOP_GAP, behavior: "smooth" });
      }
      flash(node);
      return true;
    } catch (e) {
      return false;
    }
  }

  // The scroller the conversation is in, without needing a message to start
  // from — the message you're looking for may not be mounted, which is the
  // whole problem seeking exists to solve.
  function conversationScroller() {
    const nodes = humanMessages();
    if (nodes.length) {
      const s = scrollerFor(nodes[0]);
      if (s) return s;
    }
    let best = null;
    try {
      for (const p of document.querySelectorAll("div,main,section")) {
        if (isOurs(p)) continue;
        const style = getComputedStyle(p);
        if (!/(auto|scroll)/.test(style.overflowY)) continue;
        const over = p.scrollHeight - p.clientHeight;
        if (over < 200) continue;
        if (!best || over > best.over) best = { el: p, over: over };
      }
    } catch (e) {
      /* ignore */
    }
    return best ? best.el : null;
  }

  // Where the mounted window sits in the list: the offset that turns "third
  // message on screen" into "eleventh message in the chat". Null when nothing on
  // screen is recognisable, which happens before the list has been fetched.
  function windowOffset(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const key = T.entryKey(textOf(nodes[i]));
      const at = entries.findIndex((e) => e.key === key);
      if (at !== -1) return at - i;
    }
    return null;
  }

  // Which mounted reply is which entry. Matched on text, and where a chat
  // repeats itself on whichever match is nearest to where that entry ought to
  // be, which the window offset makes answerable.
  function mountedNodeFor(index) {
    const want = entries[index];
    if (!want) return null;
    const nodes = replyMessages();
    const base = windowOffset(nodes);
    let best = null;
    nodes.forEach((node, i) => {
      if (T.entryKey(textOf(node)) !== want.key) return;
      const d = Math.abs((base === null ? i : base + i) - index);
      if (!best || d < best.d) best = { node: node, d: d };
    });
    return best ? best.node : null;
  }

  // Where in the list the view currently is — the first mounted reply we can
  // place. Null when nothing on screen is recognisable.
  function indexOnScreen() {
    const nodes = replyMessages();
    const base = windowOffset(nodes);
    return base === null ? null : base;
  }

  // Jump to an entry that isn't mounted. Nothing to scroll to, so it's a guess
  // and then a correction: scroll roughly where that entry should be, see which
  // entry actually turned up, and go again from there. A few passes is plenty —
  // each one lands closer, and the list is short enough that "closer" converges.
  const SEEK_TRIES = 8;
  const SEEK_WAIT_MS = 220;
  function seek(index, tries) {
    const node = mountedNodeFor(index);
    if (node) return jumpTo(node);
    if (tries >= SEEK_TRIES) return false;
    const scroller = conversationScroller();
    if (!scroller) return false;
    const span = scroller.scrollHeight - scroller.clientHeight;
    const from = indexOnScreen();
    let top;
    if (from === null) {
      // Nothing recognisable on screen: start from where the entry would be if
      // the chat were evenly spread, which is close enough to correct from.
      top = (span * (index + 0.5)) / Math.max(1, entries.length);
    } else {
      top = scroller.scrollTop + T.seekDelta(from, index, span, entries.length);
    }
    try {
      scroller.scrollTop = Math.max(0, Math.min(span, top));
    } catch (e) {
      return false;
    }
    setTimeout(() => seek(index, tries + 1), SEEK_WAIT_MS);
    return true;
  }

  // A moment's outline on what you jumped to. Landing silently in the middle of
  // a wall of text leaves you wondering whether the click did anything.
  function flash(node) {
    try {
      node.classList.add("cum-toc-hit");
      setTimeout(() => node.classList.remove("cum-toc-hit"), 1200);
    } catch (e) {
      /* ignore */
    }
  }

  // The clock time a message was sent, with its date where that isn't today —
  // a bare "2:14 PM" on something from last week says the wrong thing.
  function clockOf(ms) {
    const d = new Date(ms);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (St && St.sameDay(ms, Date.now())) return time;
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts) + ", " + time;
  }

  // ---- the panel ----------------------------------------------------------
  function build() {
    if (el) return el;
    // The toggle lives in the upper-right corner of the window, always — see
    // placeButton for why it stopped riding claude.ai's header. The panel it
    // opens still floats.
    btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.title = "Claude's replies in this chat";
    btn.innerHTML = `<span class="cum-toc-icon">☰</span><span class="cum-toc-count"></span>`;
    btn.addEventListener("click", () => setOpen(!open));

    el = document.createElement("div");
    el.id = ID;
    el.hidden = true;
    el.innerHTML =
      `<div class="cum-toc-body">` +
      `<div class="cum-toc-head"><span class="cum-toc-title">Replies</span>` +
      `<button class="cum-toc-close" type="button" title="Minimize">–</button></div>` +
      `<div class="cum-toc-list"></div></div>`;
    (document.body || document.documentElement).appendChild(el);

    listEl = el.querySelector(".cum-toc-list");
    countEl = btn.querySelector(".cum-toc-count");

    el.querySelector(".cum-toc-close").addEventListener("click", () => setOpen(false));
    setupDrag();
    placeButton();
    return el;
  }

  // In the tray beside claude.ai's own sidebar toggle (the owner's spec —
  // src/tray.js). The button and the panel ride the same slot, panel to the
  // button's side, its top level with the button row; the tray follows the
  // toggle as the sidebar opens and closes, which a fixed corner could not.
  // The corner remains only as the fallback for a tray that didn't load.
  function placeButton() {
    if (!btn) return;
    const T = window.CUMTray;
    if (!T) {
      btn.classList.add("cum-toc-corner");
      const home = document.body || document.documentElement;
      if (btn.parentNode !== home) home.appendChild(btn);
      return;
    }
    btn.classList.remove("cum-toc-corner");

    // The owner's spec: with the native sidebar CLOSED, the open bookmark
    // panel stands in for it — a right-edge column of the native panel's own
    // width, the chat and the buttons pushed left exactly as the native panel
    // pushes them. With the native panel OPEN, the bookmark rides the tray
    // slot beside it, as before.
    const H = window.CUMHeaderSlot;
    const P = window.CUMPanelBar;
    let side = { open: false, width: (P && P.SIDE_W) || 312 };
    try {
      const t = H && H.sidebarToggle();
      if (t) {
        const gap = window.innerWidth - t.getBoundingClientRect().right;
        if (gap > 200) side = { open: true, width: Math.round(gap) };
      }
    } catch (e) {
      /* closed is the safe reading */
    }
    const showing = !!(el && open && entries.length);
    const column = showing && !side.open;
    if (column) {
      el.classList.remove("cum-inline");
      el.classList.add("cum-column");
      const home = document.body || document.documentElement;
      if (el.parentNode !== home) home.appendChild(el);
      el.style.width = side.width + "px";
      T.put("toc", btn); // the button stays in the row; the panel takes the column
    } else {
      if (el) {
        el.classList.remove("cum-column");
        el.classList.add("cum-inline");
        el.style.width = "";
      }
      T.put("toc", btn, el);
    }
    // The chat moves over by the panel's width, and so do the buttons —
    // identically to the native panel (both through the tray, which owns the
    // margins so two panels can never double them).
    if (T.reserve && P)
      T.reserve("toc", P.chatReserve({ sidebarOpen: side.open, tocColumn: column, sideW: side.width }));
    if (T.offset) T.offset(column ? side.width + 8 : 0);
  }

  function setOpen(next) {
    open = !!next;
    storageSet({ [OPEN_KEY]: open });
    if (!el) return;
    if (btn) btn.classList.toggle("cum-toc-on", open);
    if (open) refresh(true);
    render();
    placeButton(); // the column stands up (or down) the moment it's toggled
    if (open) keepOnScreen();
  }

  function render() {
    if (!el) return;
    countEl.textContent = entries.length ? String(entries.length) : "";
    if (btn) btn.hidden = entries.length === 0;
    el.hidden = !open || entries.length === 0;
    if (el.hidden) return;
    listEl.innerHTML = "";
    entries.forEach((e, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cum-toc-row" + (e.empty ? " cum-toc-dim" : "");
      row.innerHTML =
        `<span class="cum-toc-n">${e.n}</span>` +
        `<span class="cum-toc-main"><span class="cum-toc-label"></span>` +
        `<span class="cum-toc-sub"></span></span>`;
      // textContent, not innerHTML: this is your own text and it may contain
      // anything at all.
      row.querySelector(".cum-toc-label").textContent = e.label;
      // When it was sent, and — where a workflow sent it — which step it was.
      const sub = row.querySelector(".cum-toc-sub");
      if (e.step) {
        const chip = document.createElement("span");
        chip.className = "cum-toc-step";
        chip.textContent = "Step " + e.step;
        if (e.run) chip.title = e.run;
        sub.appendChild(chip);
      }
      if (e.at) {
        const when = document.createElement("span");
        when.className = "cum-toc-when";
        when.textContent = clockOf(e.at);
        when.title = new Date(e.at).toLocaleString();
        sub.appendChild(when);
      }
      row.title = e.label;
      row.addEventListener("click", () => go(i));
      listEl.appendChild(row);
    });
  }

  // Jump to the nth entry, mounted or not.
  function go(index) {
    const node = mountedNodeFor(index);
    if (node) return jumpTo(node);
    seek(index, 0);
  }

  function refresh(force) {
    if (!el && !document.body) return;
    const paired = repliesWithPrev();
    // A cheap fingerprint, so a chat that hasn't changed doesn't rebuild the
    // list on every mutation — claude.ai mutates constantly while streaming.
    const key = paired.length + ":" + paired.map((p) => p.text.length).join(",");
    if (!force && key === lastKey) return;
    lastKey = key;

    const seen = T.tocEntries(paired.map((p) => ({ text: p.text, prev: p.prev })));
    if (fromApi) {
      // The conversation is the list; the page only says when to ask for it
      // again. A message on screen that the list doesn't know is one you just
      // sent.
      if (seen.some((s) => !entries.some((e) => e.key === s.key))) fetchList();
    } else {
      // No conversation to read — an incognito chat is never saved — so the
      // page is all there is. Merge rather than replace: what's mounted is a
      // window, and rebuilding from it is what made entries disappear as you
      // scrolled.
      entries = withSteps(T.mergeWindows(entries, seen));
    }
    build();
    render();
  }

  // ---- the conversation itself -------------------------------------------
  // The list is built from the conversation payload wherever there is one.
  // claude.ai unmounts messages that scroll out of view, so a list built from
  // the page holds only what you have lately looked at — entries vanishing
  // behind you as you scroll down, which is precisely what a table of contents
  // is supposed to prevent.
  // ---- which of these a workflow sent ------------------------------------
  //
  // A run's message is its step's prompt with the carried material pasted under
  // it, so a rendered turn that BEGINS with a step's prompt is that step. Worth
  // saying in the list: reading back through a nine-step run, "which one is the
  // second devil's advocate pass" is the question you actually have, and the
  // prompts alone all look alike.
  let runSteps = []; // { label, prompt, runName } for this conversation, in order
  let runsFor = null; // the conversation those steps were read for

  async function loadRunSteps() {
    const uuid = W ? W.conversationId(location.pathname) : null;
    if (!uuid || uuid === runsFor) return;
    runsFor = uuid;
    runSteps = [];
    let store;
    try {
      store = await storageGet(W.RUN_IDS_KEY);
    } catch (e) {
      return;
    }
    const ids = (store && store[W.RUN_IDS_KEY]) || [];
    if (!ids.length) return;
    const keys = ids.map((id) => W.runKey(id));
    const runs = await storageGet(keys);
    const out = [];
    for (const key of keys) {
      const run = runs[key];
      if (!run || !run.chats) continue;
      // Which of this run's chats is the conversation we're looking at.
      const chatId = Object.keys(run.chats).find((cid) => {
        const url = (run.chats[cid] || {}).url;
        return url && W.conversationId(url) === uuid;
      });
      if (!chatId) continue;
      const plan = W.planRun(W.runSource(run, null));
      for (const step of plan) {
        if (step.chatId !== chatId) continue;
        out.push({
          label: step.label,
          prompt: step.prompt,
          runName: (W.runLabel(run) || {}).title || null,
          // Steps are claimed in the order they ran, so keep them in it.
          index: step.index,
        });
      }
    }
    runSteps = out.sort((a, b) => a.index - b.index);
    // The list may already have been built before this landed — a run's steps
    // come out of storage, which is slower than reading the page.
    if (runSteps.length && entries.length) {
      entries = withSteps(entries);
      render();
    }
  }

  function withSteps(list) {
    return runSteps.length ? T.stepMarks(list, runSteps) : list;
  }

  function fetchList() {
    if (!M || fetching) return;
    const uuid = W ? W.conversationId(location.pathname) : null;
    if (!uuid) return;
    const now = Date.now();
    // Backed off after a miss, because a chat claude.ai has no record of — an
    // incognito one — will miss every single time, and asking every few seconds
    // for something that is never there is just noise.
    if (now - lastFetch < REFETCH_MS * (misses + 1)) return;
    fetching = true;
    lastFetch = now;
    // Through the shared cache: the timestamps under each turn want the same
    // payload, and two copies of this asking separately is two fetches of one
    // conversation every few seconds.
    (V ? V.get(uuid, 0) : Promise.resolve(null))
      .then((conv) => {
        fetching = false;
        misses = conv ? 0 : Math.min(misses + 1, 10);
        // Still the same chat? A slow answer for the chat you just left must
        // not become the list for the one you're in.
        if (!conv || uuid !== (W ? W.conversationId(location.pathname) : null)) return;
        // Claude's replies, each carrying the prompt it answers — walked in
        // order so a reply is keyed to the human turn just above it.
        const mine = [];
        let lastHuman = null;
        for (const m of M.messagesOf(conv)) {
          const who = String((m && (m.sender || m.role)) || "").toLowerCase();
          if (who === "human" || who === "user") {
            lastHuman = M.parts(m).text;
            continue;
          }
          if (who !== "assistant") continue;
          mine.push({ text: M.parts(m).text, prev: lastHuman, at: St ? St.atOf(m) : null });
          lastHuman = null;
        }
        if (!mine.length) return;
        entries = T.tocEntries(mine);
        entries = withSteps(entries);
        fromApi = true;
        convId = uuid;
        build();
        render();
      })
      .catch(() => {
        fetching = false;
      });
  }

  // ---- drag, and staying on screen ---------------------------------------
  let dragged = false;
  function applyPos(p, persist) {
    if (!el || !p) return;
    // In the tray the panel is laid out by the row, not by stored coordinates.
    if (el.classList.contains("cum-inline")) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(Math.max(0, p.left), Math.max(0, window.innerWidth - r.width));
    const top = Math.min(Math.max(0, p.top), Math.max(0, window.innerHeight - r.height));
    el.style.left = left + "px";
    el.style.top = top + "px";
    el.style.right = "auto";
    el.style.bottom = "auto";
    pos = { left, top };
    if (persist) storageSet({ [POS_KEY]: pos });
  }
  // Expanding makes it taller, which can push it off the bottom of a window it
  // fitted in while minimized.
  function keepOnScreen() {
    if (pos) applyPos(pos, false);
  }

  function setupDrag() {
    // The panel's own title bar, and only that. The toggle is in claude.ai's
    // header now, where dragging it would mean dragging it out of the row it
    // was put in.
    for (const h of [el.querySelector(".cum-toc-head")]) {
      let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
      h.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        // In the tray the panel is part of a row and doesn't drag.
        if (el.classList.contains("cum-inline")) return;
        // Not on a control that lives in the bar. Starting a drag here captures
        // the pointer, and a captured pointer sends the click that follows to
        // the CAPTURING element — so the minimize button was being pressed and
        // the title bar was being clicked, which is a button that does nothing.
        try {
          if (e.target && e.target.closest && e.target.closest("button")) return;
        } catch (err) {
          /* ignore */
        }
        on = true;
        dragged = false;
        sx = e.clientX;
        sy = e.clientY;
        const r = el.getBoundingClientRect();
        ox = r.left;
        oy = r.top;
        try {
          h.setPointerCapture(e.pointerId);
        } catch (err) {
          /* ignore */
        }
      });
      h.addEventListener("pointermove", (e) => {
        if (!on) return;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        if (!dragged && Math.hypot(dx, dy) < 4) return; // ignore a shaky click
        dragged = true;
        el.classList.add("cum-toc-dragging");
        applyPos({ left: ox + dx, top: oy + dy }, false);
      });
      const end = (e) => {
        if (!on) return;
        on = false;
        el.classList.remove("cum-toc-dragging");
        if (dragged) applyPos(pos, true);
        // Cleared after the click event that follows this pointerup.
        setTimeout(() => (dragged = false), 0);
        try {
          h.releasePointerCapture(e.pointerId);
        } catch (err) {
          /* ignore */
        }
      };
      h.addEventListener("pointerup", end);
      h.addEventListener("pointercancel", end);
    }
  }

  // ---- wiring -------------------------------------------------------------
  // Only where there's a conversation to have contents. /new has nothing yet,
  // and the panel appearing on an empty composer is clutter.
  function onAConversation() {
    try {
      return !!(W ? W.conversationId(location.pathname) : /\/chat\//.test(location.pathname));
    } catch (e) {
      return false;
    }
  }

  storageGet([POS_KEY, OPEN_KEY]).then((r) => {
    if (r[POS_KEY]) pos = r[POS_KEY];
    open = !!r[OPEN_KEY];
    if (onAConversation()) {
      loadRunSteps().then(fetchList).catch(() => {});
      refresh(true);
      if (pos) applyPos(pos, false);
      setOpen(open);
    }
  });

  function hideAll() {
    if (el) el.hidden = true;
    if (btn) btn.hidden = true;
  }

  // Rebuilt on a timer rather than a MutationObserver: claude.ai mutates on
  // every streamed token, and the fingerprint above makes a poll cheap where an
  // observer would fire thousands of times a turn.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastKey = "";
      // A different chat has a different list. Keeping the old one, even for a
      // moment, would offer bookmarks into a conversation you've left.
      const now = W ? W.conversationId(location.pathname) : null;
      if (now !== convId) {
        entries = [];
        fromApi = false;
        runSteps = [];
        runsFor = null;
        convId = now;
        lastFetch = 0;
        misses = 0;
      }
      hideAll();
    }
    if (!onAConversation()) {
      hideAll();
      return;
    }
    if (!fromApi) fetchList(); // a chat that has just acquired an id
    loadRunSteps().catch(() => {});
    refresh(false);
    // The SPA rebuilds its header on every navigation, taking our slot with it.
    placeButton();
  }, RESCAN_MS);

  window.addEventListener("resize", keepOnScreen);

  // Jumping to a step's message, for the workflow index next door. It knows
  // which prompt it wants and nothing about where messages are; this knows how
  // to find one that may not even be rendered. See seek().
  window.CUMTocJump = {
    toPrompt: function (prompt) {
      // The list tracks replies keyed to the prompts they answer, so a step's
      // prompt finds the REPLY to that step — which is where reading back
      // through a run actually wants to land. Same matching rule as the step
      // marks, asked of the pure module.
      const at = T.findByPrompt(entries, prompt);
      // Nothing in the list yet — the page may still be loading. Say so rather
      // than scrolling somewhere arbitrary.
      if (at === -1) return false;
      go(at);
      return true;
    },
    ready: function () {
      return entries.length > 0;
    },
  };
})();
