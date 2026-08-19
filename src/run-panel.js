/**
 * Claude Usage Meter — the workflow's own table of contents (ISOLATED world
 * content script).
 *
 * The contents list beside this one indexes the conversation you are in. This
 * one indexes the RUN: every step of it, in order, across all of its chats —
 * and clicking one takes you there, whichever conversation it happened in.
 *
 * That is the thing a multi-chat workflow otherwise makes hard. "What did the
 * advocate actually say about this paragraph" is a different tab, and finding
 * it by hand means remembering which. Here it is a click, and the step you
 * land on is scrolled to rather than merely opened.
 *
 * It appears only in a conversation a run owns. A chat you started yourself has
 * no run to index, and a button for it would be a button that does nothing.
 */
(function () {
  "use strict";

  const W = window.CUMWorkflow;
  const H = window.CUMHeaderSlot;
  const T = window.CUMToc;
  if (!W || !T) return;

  const ID = "cum-run";
  const BTN_ID = "cum-run-btn";
  const POS_KEY = "cum_run_pos";
  const OPEN_KEY = "cum_run_open";
  const SCAN_MS = 2000;

  let el = null;
  let btn = null;
  let listEl = null;
  let titleEl = null;
  let open = false;
  let pos = null;
  let run = null; // the run this conversation belongs to
  let here = null; // …and which of its chats this conversation is
  let steps = [];
  let convId = null;
  let reading = false;

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

  // ---- which run this conversation belongs to -----------------------------
  async function readRun() {
    const uuid = W.conversationId(location.pathname);
    if (!uuid) {
      run = null;
      steps = [];
      return;
    }
    if (reading) return;
    reading = true;
    try {
      const store = await storageGet(W.RUN_IDS_KEY);
      const ids = (store && store[W.RUN_IDS_KEY]) || [];
      if (!ids.length) return;
      const runs = await storageGet(ids.map((id) => W.runKey(id)));
      let best = null;
      let bestChat = null;
      for (const id of ids) {
        const r = runs[W.runKey(id)];
        const chatId = W.runHasConversation(r, uuid);
        if (!chatId) continue;
        // A conversation can be re-used by a later run of the same workflow.
        // The newest is the one you are looking at.
        if (!best || (r.startedAt || r.createdAt || 0) > (best.startedAt || best.createdAt || 0)) {
          best = r;
          bestChat = chatId;
        }
      }
      run = best;
      here = bestChat;
      convId = uuid;
      steps = best ? W.runDirectory(best, null) : [];
    } finally {
      reading = false;
    }
  }

  // ---- the panel ----------------------------------------------------------
  function build() {
    if (el) return el;
    btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.title = "The whole run — every step, in every chat";
    btn.innerHTML = `<span class="cum-run-ico">⇄</span><span class="cum-run-count"></span>`;
    btn.addEventListener("click", () => setOpen(!open));

    el = document.createElement("div");
    el.id = ID;
    el.hidden = true;
    el.innerHTML =
      `<div class="cum-run-body">` +
      `<div class="cum-run-head"><span class="cum-run-title">Run</span>` +
      `<button class="cum-run-close" type="button" title="Minimize">–</button></div>` +
      `<div class="cum-run-list"></div></div>`;
    (document.body || document.documentElement).appendChild(el);
    listEl = el.querySelector(".cum-run-list");
    titleEl = el.querySelector(".cum-run-title");
    el.querySelector(".cum-run-close").addEventListener("click", () => setOpen(false));
    setupDrag();
    return el;
  }

  function place() {
    if (!btn) return;
    // In the tray beside claude.ai's own sidebar toggle (the owner's spec —
    // src/tray.js): button and panel share the run slot, the panel opening in
    // line with the button row. The header slot remains only as the fallback
    // for a tray that didn't load.
    const T = window.CUMTray;
    if (T) {
      btn.classList.remove("cum-run-loose", "cum-run-docked");
      if (el) el.classList.add("cum-inline");
      T.put("run", btn, el);
      return;
    }
    const where = H ? H.place(btn) : "loose";
    btn.classList.toggle("cum-run-loose", where === "loose");
    btn.classList.toggle("cum-run-docked", where === "docked");
    if (!H && btn.parentNode !== document.body) document.body.appendChild(btn);
  }

  function setOpen(next) {
    open = !!next;
    storageSet({ [OPEN_KEY]: open });
    if (!el) return;
    if (btn) btn.classList.toggle("cum-run-on", open);
    render();
    if (open) keepOnScreen();
  }

  function clockOf(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function render() {
    if (!el) return;
    const has = steps.length > 0;
    if (btn) {
      btn.hidden = !has;
      btn.querySelector(".cum-run-count").textContent = has ? String(steps.length) : "";
    }
    el.hidden = !open || !has;
    if (el.hidden) return;
    titleEl.textContent = (run && W.runLabel(run).title) || "Run";
    titleEl.title = titleEl.textContent;
    listEl.innerHTML = "";
    for (const s of steps) {
      const row = document.createElement("button");
      row.type = "button";
      const mine = s.chatId === here;
      row.className =
        "cum-run-row" +
        (s.done ? " done" : "") +
        (s.here ? " here" : "") +
        (mine ? " mine" : "") +
        (s.url || mine ? "" : " dead");
      row.innerHTML =
        `<span class="cum-run-n"></span>` +
        `<span class="cum-run-main"><span class="cum-run-label"></span>` +
        `<span class="cum-run-sub"></span></span>`;
      row.querySelector(".cum-run-n").textContent = s.label;
      // The step's own prompt, shortened the same way the contents list does
      // it — the first line that actually says something.
      row.querySelector(".cum-run-label").textContent = T.tocLabel(s.prompt) || "(no prompt)";
      const sub = row.querySelector(".cum-run-sub");
      sub.textContent =
        s.chatName +
        (mine ? " · this chat" : "") +
        (s.parallel ? " · at once" : "") +
        (s.at ? " · " + clockOf(s.at) : s.here ? " · now" : "");
      row.title =
        (mine ? "Jump to this step" : "Open " + s.chatName + " at this step") +
        "\n\n" +
        (s.prompt || "");
      row.addEventListener("click", () => goTo(s));
      listEl.appendChild(row);
    }
  }

  // ---- moving between steps ----------------------------------------------
  function goTo(step) {
    // In this conversation: the contents list next door already knows how to
    // reach a message that may not be rendered at all.
    if (step.chatId === here && window.CUMTocJump) {
      if (window.CUMTocJump.toPrompt(step.prompt)) return;
    }
    if (!step.url && step.chatId !== here) return say(step, "hasn't run yet");
    // Somewhere else: the worker owns the tabs, so it does the moving. It
    // focuses that conversation and tells it where to scroll — this is the one
    // place a run's window is deliberately brought forward, because you asked
    // for it.
    try {
      chrome.runtime.sendMessage(
        {
          type: "cum-wf-goto",
          runId: run.id,
          stepIndex: step.index,
        },
        (res) => {
          void chrome.runtime.lastError;
          if (!res || !res.ok) say(step, (res && res.error) || "couldn't open that chat");
        }
      );
    } catch (e) {
      say(step, "couldn't open that chat");
    }
  }

  function say(step, what) {
    if (!listEl) return;
    const row = Array.from(listEl.children).find(
      (r) => r.querySelector(".cum-run-n").textContent === step.label
    );
    if (!row) return;
    const sub = row.querySelector(".cum-run-sub");
    const was = sub.textContent;
    sub.textContent = step.chatName + " · " + what;
    row.classList.add("bad");
    setTimeout(() => {
      sub.textContent = was;
      row.classList.remove("bad");
    }, 2600);
  }

  // Arriving from another chat's copy of this panel: scroll to the step that
  // was clicked. The page may still be rendering, so try for a while rather
  // than once.
  function receive(msg) {
    const want = msg && msg.prompt;
    if (!want) return;
    let tries = 0;
    (function attempt() {
      if (window.CUMTocJump && window.CUMTocJump.toPrompt(want)) return;
      if (++tries > 20) return;
      setTimeout(attempt, 500);
    })();
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== "cum-goto-step") return;
      receive(msg);
      sendResponse({ ok: true });
      return true;
    });
  } catch (e) {
    /* ignore */
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
  function keepOnScreen() {
    if (pos) applyPos(pos, false);
  }

  function setupDrag() {
    const h = el.querySelector(".cum-run-head");
    let sx = 0,
      sy = 0,
      ox = 0,
      oy = 0,
      on = false;
    h.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // In the tray the panel is part of a row and doesn't drag.
      if (el.classList.contains("cum-inline")) return;
      // Not on the minimize button. A drag started here captures the pointer,
      // and a captured pointer sends the click that follows to the capturing
      // element — so the button would be pressed and the bar clicked.
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
      if (!dragged && Math.hypot(dx, dy) < 4) return;
      dragged = true;
      el.classList.add("cum-run-dragging");
      applyPos({ left: ox + dx, top: oy + dy }, false);
    });
    const end = (e) => {
      if (!on) return;
      on = false;
      el.classList.remove("cum-run-dragging");
      if (dragged) applyPos(pos, true);
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

  // ---- wiring -------------------------------------------------------------
  storageGet([POS_KEY, OPEN_KEY]).then((r) => {
    if (r[POS_KEY]) pos = r[POS_KEY];
    open = !!r[OPEN_KEY];
    readRun().then(() => {
      if (!steps.length) return;
      build();
      place();
      if (pos) applyPos(pos, false);
      setOpen(open);
    });
  });

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      // A different conversation belongs to a different run — or to none.
      if (W.conversationId(location.pathname) !== convId) {
        run = null;
        steps = [];
        if (el) el.hidden = true;
        if (btn) btn.hidden = true;
      }
    }
    readRun().then(() => {
      if (!steps.length) {
        if (el) el.hidden = true;
        if (btn) btn.hidden = true;
        return;
      }
      build();
      render();
      place();
    });
  }, SCAN_MS);

  window.addEventListener("resize", keepOnScreen);
})();
