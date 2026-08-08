/**
 * Claude Usage Meter — Save chat (ISOLATED world content script).
 *
 * A button in claude.ai's own header, beside Share, that saves the whole
 * conversation as a Markdown file — so the next chat can be handed everything
 * this one worked out instead of a summary of it.
 *
 * It saves the conversation PAYLOAD rather than the page: claude.ai unmounts
 * messages that scroll out of view, so anything read from the DOM would save
 * whichever part you happened to be looking at. The rendering lives in
 * src/mdexport.js, which is where the decisions about what to include are.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  const W = window.CUMWorkflow;
  const M = window.CUMMdExport;
  if (!C || !W || !M) return;

  const ID = "cum-save-chat";
  const PLACE_MS = 1500;

  // Beside Share, which is where you'd look for it. Each of these is a guess at
  // unversioned markup, so they're tried in turn and the first that matches
  // wins; if none do, the button falls back to floating in the corner rather
  // than not existing.
  const NEIGHBOUR_SELECTORS = [
    'button[data-testid="share-button"]',
    'button[aria-label*="share" i]',
    'button[aria-label*="chat controls" i]',
    'button[data-testid="chat-menu-trigger"]',
  ];

  function usable(b) {
    if (!b || C.isOurs(b)) return false;
    const r = b.getBoundingClientRect();
    return !!(r.width && r.height);
  }

  // The top-right cluster of controls, found by WHERE IT IS rather than by what
  // anything is called. Names are the first try because they're exact, but
  // claude.ai doesn't version them, and a name that stops matching used to mean
  // the button floated over the header — landing on top of the very controls it
  // was meant to sit beside.
  const HEADER_BAND_PX = 90;
  function findNeighbour() {
    for (const sel of NEIGHBOUR_SELECTORS) {
      let b;
      try {
        b = document.querySelector(sel);
      } catch (e) {
        continue;
      }
      if (usable(b)) return b;
    }
    try {
      for (const b of document.querySelectorAll("header button, [role=banner] button")) {
        if (usable(b) && /^\s*share\s*$/i.test(b.textContent || "")) return b;
      }
    } catch (e) {
      /* ignore */
    }
    // Geometry. Everything in the top band, on the right half of the window —
    // and the LEFTMOST of those, so this sits beside that cluster rather than
    // in the middle of it.
    let best = null;
    try {
      for (const b of document.querySelectorAll('button, a[role="button"]')) {
        if (!usable(b)) continue;
        const r = b.getBoundingClientRect();
        if (r.top < 0 || r.top > HEADER_BAND_PX) continue;
        if (r.left < window.innerWidth * 0.55) continue;
        if (!best || r.left < best.left) best = { el: b, left: r.left };
      }
    } catch (e) {
      /* ignore */
    }
    return best ? best.el : null;
  }

  let btn = null;
  function build() {
    if (btn) return btn;
    btn = document.createElement("button");
    btn.id = ID;
    btn.type = "button";
    btn.title = "Save this conversation as a Markdown file";
    btn.innerHTML = `<span class="cum-save-ico">↓</span><span class="cum-save-txt">Save</span>`;
    btn.addEventListener("click", save);
    return btn;
  }

  // Put it back whenever the SPA rebuilds its header, which it does on every
  // navigation — and take it away where there's no conversation to save.
  function place() {
    const conv = W.conversationId(location.pathname);
    if (!conv) {
      if (btn && btn.parentNode) btn.remove();
      return;
    }
    const b = build();
    const neighbour = findNeighbour();
    if (neighbour && neighbour.parentElement) {
      if (b.parentElement !== neighbour.parentElement || b.nextElementSibling !== neighbour) {
        neighbour.parentElement.insertBefore(b, neighbour);
      }
      b.classList.remove("cum-save-loose", "cum-save-docked");
      measureStack();
      return;
    }
    // Nothing found at all. Dock into the meter's own indicator stack, which is
    // ours and therefore can't be sitting on top of anything of claude.ai's —
    // the previous fallback floated at the top right and covered Share, which
    // is the one place a button called Save must not be.
    const stack = document.getElementById("cum-pills");
    const home = stack || document.body || document.documentElement;
    if (b.parentNode !== home) home.appendChild(b);
    b.classList.toggle("cum-save-loose", !stack);
    b.classList.toggle("cum-save-docked", !!stack);
    measureStack();
  }

  // The meter's stack just changed height, which decides whether it hangs above
  // or below the meter and how much room the meter's panel has to leave it.
  function measureStack() {
    try {
      if (window.CUMPills) window.CUMPills.measure();
    } catch (e) {
      /* ignore */
    }
  }

  // ---- fetching and saving -------------------------------------------------
  let reqSeq = 0;
  function fetchConversation(uuid, timeoutMs) {
    return new Promise((resolve) => {
      const reqId = "sv" + ++reqSeq + "-" + Date.now();
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
        if (p && p.conversation && p.conversation.reqId === reqId) finish(p.conversation.data || null);
      }
      window.addEventListener("message", onMsg);
      const timer = setTimeout(() => finish(null), timeoutMs || 20000);
      try {
        window.postMessage(
          { __channel: C.CHANNEL, command: { type: "fetchConversation", uuid, reqId } },
          window.location.origin
        );
      } catch (e) {
        finish(null);
      }
    });
  }

  function localDate(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function say(text, bad) {
    if (!btn) return;
    const label = btn.querySelector(".cum-save-txt");
    if (!label) return;
    label.textContent = text;
    btn.classList.toggle("cum-save-bad", !!bad);
    clearTimeout(say.t);
    say.t = setTimeout(() => {
      label.textContent = "Save";
      btn.classList.remove("cum-save-bad");
    }, 2600);
  }

  async function save() {
    const uuid = W.conversationId(location.pathname);
    if (!uuid) return say("No chat", true);
    btn.disabled = true;
    say("Saving…");
    try {
      const conv = await fetchConversation(uuid, 25000);
      const messages = M.messagesOf(conv);
      // An empty answer is not a file. Saying so beats handing over an .md that
      // turns out to hold a heading and nothing else.
      if (!conv || !messages.length) return say("Couldn't read", true);
      const now = Date.now();
      download(
        M.exportFileName(conv, localDate(now)),
        M.conversationMarkdown(conv, {
          url: location.href,
          dateStr: new Date(now).toLocaleString(),
        })
      );
      say("Saved " + messages.length);
    } catch (e) {
      say("Failed", true);
    } finally {
      btn.disabled = false;
    }
  }

  setInterval(place, PLACE_MS);
  place();
})();
