/**
 * Claude Usage Meter — the table of contents panel (ISOLATED world content
 * script).
 *
 * A floating box, one per conversation, listing your own messages. Click one
 * and the chat jumps to the END of that prompt — which is where Claude's answer
 * to it begins, and so the place you actually want to land when you're reading
 * back through what a conversation did.
 *
 * Starts minimized — a chat you're just reading shouldn't have a panel over it —
 * behind a button in claude.ai's own header, in with the file and share
 * controls, beside Save. The panel it opens is still free-floating and
 * draggable, and its position is remembered: the same treatment the meter gets,
 * because the right corner for it depends on the window and on the day.
 *
 * The list is built from the page. claude.ai unmounts messages that scroll far
 * out of view, so a very long conversation lists what it currently holds and
 * grows as you scroll — see the note in refresh().
 */
(function () {
  "use strict";

  const T = window.CUMToc;
  const W = window.CUMWorkflow;
  const H = window.CUMHeaderSlot;
  if (!T) return;

  const ID = "cum-toc";
  const BTN_ID = "cum-toc-btn";
  const POS_KEY = "cum_toc_pos"; // { left, top }
  const OPEN_KEY = "cum_toc_open"; // remembered across chats, not per chat
  const RESCAN_MS = 1500;

  let el = null;
  let btn = null;
  let listEl = null;
  let countEl = null;
  let open = false;
  let pos = null;
  let entries = []; // { n, label, el } — el is the message it points at
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

  // ---- finding your messages ---------------------------------------------
  // The same selector cascade the workflow runner uses, for the same reason:
  // claude.ai's markup is unversioned, so try each and take the first that
  // matches anything.
  const HUMAN_SELECTORS = [
    '[data-testid="user-message"]',
    ".font-user-message",
    '[data-testid="human-message"]',
  ];

  function humanMessages() {
    for (const sel of HUMAN_SELECTORS) {
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

  // Put the END of a prompt near the top of the view, so what's on screen is
  // the answer to it. scrollIntoView({block:"end"}) would park it at the
  // BOTTOM, hiding the very thing you jumped to read.
  const TOP_GAP = 72; // room for claude.ai's own header
  function jumpTo(node) {
    if (!node || !node.isConnected) return false;
    const scroller = scrollerFor(node);
    const rect = node.getBoundingClientRect();
    try {
      if (scroller) {
        const base = scroller.getBoundingClientRect();
        scroller.scrollTo({
          top: scroller.scrollTop + (rect.bottom - base.top) - TOP_GAP,
          behavior: "smooth",
        });
      } else {
        window.scrollTo({ top: window.scrollY + rect.bottom - TOP_GAP, behavior: "smooth" });
      }
      flash(node);
      return true;
    } catch (e) {
      return false;
    }
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

  // ---- the panel ----------------------------------------------------------
  function build() {
    if (el) return el;
    // The toggle is a header button, not part of the panel: it belongs with
    // Save and claude.ai's own controls, which is where you look for something
    // that acts on this chat. The panel it opens still floats.
    btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.title = "Your messages in this chat";
    btn.innerHTML = `<span class="cum-toc-icon">☰</span><span class="cum-toc-count"></span>`;
    btn.addEventListener("click", () => setOpen(!open));

    el = document.createElement("div");
    el.id = ID;
    el.hidden = true;
    el.innerHTML =
      `<div class="cum-toc-body">` +
      `<div class="cum-toc-head"><span class="cum-toc-title">Your messages</span>` +
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

  // Beside Save, in claude.ai's header — same slot, so the two arrive together
  // rather than each finding its own anchor. See src/headerslot.js.
  function placeButton() {
    if (!btn) return;
    const where = H ? H.place(btn) : "loose";
    btn.classList.toggle("cum-toc-loose", where === "loose");
    btn.classList.toggle("cum-toc-docked", where === "docked");
    if (!H && btn.parentNode !== document.body) document.body.appendChild(btn);
    try {
      if (window.CUMPills) window.CUMPills.measure();
    } catch (e) {
      /* ignore */
    }
  }

  function setOpen(next) {
    open = !!next;
    storageSet({ [OPEN_KEY]: open });
    if (!el) return;
    if (btn) btn.classList.toggle("cum-toc-on", open);
    if (open) refresh(true);
    render();
    if (open) keepOnScreen();
  }

  function render() {
    if (!el) return;
    countEl.textContent = entries.length ? String(entries.length) : "";
    if (btn) btn.hidden = entries.length === 0;
    el.hidden = !open || entries.length === 0;
    if (el.hidden) return;
    listEl.innerHTML = "";
    for (const e of entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cum-toc-row" + (e.empty ? " cum-toc-dim" : "");
      row.innerHTML =
        `<span class="cum-toc-n">${e.n}</span><span class="cum-toc-label"></span>`;
      // textContent, not innerHTML: this is your own text and it may contain
      // anything at all.
      row.querySelector(".cum-toc-label").textContent = e.label;
      row.title = e.label;
      row.addEventListener("click", () => jumpTo(e.el));
      listEl.appendChild(row);
    }
  }

  function refresh(force) {
    if (!el && !document.body) return;
    const nodes = humanMessages();
    // A cheap fingerprint, so a chat that hasn't changed doesn't rebuild the
    // list on every mutation — claude.ai mutates constantly while streaming.
    const key = nodes.length + ":" + nodes.map((n) => (n.textContent || "").length).join(",");
    if (!force && key === lastKey) return;
    lastKey = key;

    const built = T.tocEntries(nodes.map((n) => ({ text: n.textContent || "" })));
    entries = built.map((e, i) => Object.assign({}, e, { el: nodes[i] }));
    build();
    render();
  }

  // ---- drag, and staying on screen ---------------------------------------
  let dragged = false;
  function applyPos(p, persist) {
    if (!el || !p) return;
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
      entries = [];
      hideAll();
    }
    if (!onAConversation()) {
      hideAll();
      return;
    }
    refresh(false);
    // The SPA rebuilds its header on every navigation, taking our slot with it.
    placeButton();
  }, RESCAN_MS);

  window.addEventListener("resize", keepOnScreen);
})();
