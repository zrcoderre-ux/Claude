/**
 * Claude Usage Meter — Save chat (ISOLATED world content script).
 *
 * A button in claude.ai's own header, in with the file and share controls, that
 * saves the whole conversation as a Markdown file — so the next chat can be
 * handed everything this one worked out instead of a summary of it.
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
  const H = window.CUMHeaderSlot;
  if (!C || !W || !M) return;

  const ID = "cum-save-chat";
  const PLACE_MS = 1500;

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

  // The conversation as the page has it. Needed for a chat the API has no
  // record of — an incognito one is never saved, which is exactly the chat
  // whose contents are most worth rescuing — and as the answer when the API
  // can't be reached at all.
  const TURN_SELECTORS = [
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    ".font-user-message",
    ".font-claude-response",
    ".font-claude-message",
  ];
  function turnsFromPage() {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(TURN_SELECTORS.join(","))).filter(
        (n) => !C.isOurs(n)
      );
    } catch (e) {
      return [];
    }
    nodes.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    const out = [];
    for (const n of nodes) {
      if (out.some((o) => o.node.contains(n))) continue; // the same turn twice
      const text = (n.textContent || "").trim();
      if (!text) continue;
      const human = /user-message|font-user-message/.test(
        (n.getAttribute("data-testid") || "") + " " + (n.className || "")
      );
      out.push({ node: n, sender: human ? "human" : "assistant", text: text });
    }
    return out;
  }

  function conversationFromPage() {
    const turns = turnsFromPage();
    if (!turns.length) return null;
    return {
      name: (document.title || "").replace(/\s*[-–—|]\s*claude.*$/i, "").trim() ||
        turns[0].text.split("\n")[0].slice(0, 70),
      chat_messages: turns.map((t) => ({
        sender: t.sender,
        content: [{ type: "text", text: t.text }],
      })),
    };
  }

  // Put it back whenever the SPA rebuilds its header, which it does on every
  // navigation — and take it away where there is nothing to save. Nothing to
  // save means no messages, NOT no conversation id: an incognito chat has
  // plenty to save and never gets an id at all.
  function place() {
    if (!W.conversationId(location.pathname) && !turnsFromPage().length) {
      if (btn && btn.parentNode) btn.remove();
      return;
    }
    const b = build();
    // In the tray beside claude.ai's own sidebar toggle (the owner's spec —
    // src/tray.js), first slot, so Save leads the row. The header slot remains
    // only as the fallback for a tray that didn't load.
    const T = window.CUMTray;
    if (T) {
      b.classList.remove("cum-save-loose", "cum-save-docked");
      T.put("save", b);
    } else {
      const where = H ? H.place(b) : "loose";
      b.classList.toggle("cum-save-loose", where === "loose");
      b.classList.toggle("cum-save-docked", where === "docked");
      if (!H && b.parentNode !== document.body) document.body.appendChild(b);
    }
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
    btn.disabled = true;
    say("Saving…");
    try {
      // The conversation payload first — it holds the whole chat however far
      // you have scrolled, where the page holds only what is mounted.
      const uuid = W.conversationId(location.pathname);
      let conv = uuid ? await fetchConversation(uuid, 25000) : null;
      let messages = M.messagesOf(conv);
      if (!messages.length) {
        // No id, or no record under it: an incognito chat is never saved by
        // claude.ai, and that is the chat whose contents are worth most.
        conv = conversationFromPage();
        messages = M.messagesOf(conv);
      }
      // An empty answer is not a file. Saying so beats handing over an .md that
      // turns out to hold a heading and nothing else.
      if (!messages.length) return say("Couldn't read", true);
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
