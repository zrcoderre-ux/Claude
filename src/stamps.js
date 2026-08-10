/**
 * Claude Usage Meter — the time under every turn (ISOLATED world content
 * script).
 *
 * claude.ai shows one relative time per conversation and keeps the real one
 * behind a hover. Reading back through a day's work, "1 hour ago" is the least
 * useful form of that fact — so every turn, yours and Claude's, gets a line
 * under it saying the clock time it was sent and how long after the turn before
 * it landed.
 *
 * The times come from the conversation payload, because the page doesn't hold
 * them in any form worth parsing. That means a chat claude.ai has no record of
 * — an incognito one — gets no stamps, which is the honest answer: this would
 * otherwise be inventing them.
 *
 * Matching a payload message to a rendered turn is done on its text, with the
 * mounted window's offset to break ties, exactly as the contents list does it.
 * claude.ai unmounts what scrolls away, so index alone means nothing.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  const W = window.CUMWorkflow;
  const S = window.CUMStamp;
  const V = window.CUMConv;
  if (!C || !W || !S || !V) return;

  const CLASS = "cum-stamp";
  const MARK = "data-cum-stamped"; // what this turn was stamped with
  const SCAN_MS = 2000;

  const TURNS = [
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    ".font-user-message",
    ".font-claude-response",
    ".font-claude-message",
  ];

  function ours(node) {
    return !!(node && node.closest && node.closest("#cum-root, #cum-toc, ." + CLASS));
  }

  // The conversation's turns as rendered, oldest first, one entry per turn.
  function turnsOnPage() {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(TURNS.join(","))).filter((n) => !ours(n));
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
      out.push({ node: n, key: S.entryKey(text) });
    }
    return out;
  }

  // Where the mounted window sits in the conversation, so "the third turn on
  // screen" can be read as "the eleventh in the chat" — and so a chat that says
  // the same thing twice stamps the right one.
  function windowOffset(page, stamps) {
    for (let i = 0; i < page.length; i++) {
      const at = stamps.findIndex((s) => s.key === page[i].key);
      if (at !== -1) return at - i;
    }
    return null;
  }

  function clockOf(ms, withDate) {
    const d = new Date(ms);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (!withDate) return time;
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts) + ", " + time;
  }

  function lineFor(stamp) {
    if (!stamp || stamp.at == null) return "";
    // The date rides on the turn that crossed a day, and on the first turn of a
    // conversation that didn't happen today — once, where it tells you
    // something, rather than on every line.
    const withDate = stamp.newDay || (stamp.first && !S.sameDay(stamp.at, Date.now()));
    return clockOf(stamp.at, withDate) + (stamp.gap ? " · " + stamp.gap : "");
  }

  function stampNode(node, text) {
    if (!text) return;
    if (node.getAttribute(MARK) === text) return; // already says exactly this
    let el = node.querySelector(":scope > ." + CLASS);
    if (!el) {
      el = document.createElement("div");
      el.className = CLASS;
      node.appendChild(el);
    }
    el.textContent = text;
    node.setAttribute(MARK, text);
  }

  let convId = null;
  let stamps = [];
  let asking = false;
  let misses = 0;

  async function refresh() {
    const uuid = W.conversationId(location.pathname);
    if (!uuid) return;
    if (uuid !== convId) {
      convId = uuid;
      stamps = [];
      misses = 0;
    }
    const page = turnsOnPage();
    if (!page.length) return;

    // Ask again when the page holds a turn the list doesn't know — which is what
    // a message you just sent looks like. Backed off after a miss, since a chat
    // with no record will miss every time.
    const unknown = page.some((p) => !stamps.some((s) => s.key === p.key));
    if (!asking && (!stamps.length || unknown)) {
      asking = true;
      try {
        const conv = await V.get(uuid, unknown ? 0 : V.FRESH_MS * (misses + 1));
        if (uuid === W.conversationId(location.pathname)) {
          const next = S.stampList(conv);
          if (next.length) {
            stamps = next;
            misses = 0;
          } else {
            misses = Math.min(misses + 1, 10);
          }
        }
      } finally {
        asking = false;
      }
    }
    if (!stamps.length) return;

    const base = windowOffset(page, stamps);
    if (base === null) return;
    page.forEach((p, i) => {
      const s = stamps[base + i];
      // Only where the payload and the page agree about what this turn is. A
      // time under the wrong message is worse than no time.
      if (!s || s.key !== p.key) return;
      stampNode(p.node, lineFor(s));
    });
  }

  setInterval(() => {
    refresh().catch(() => {});
  }, SCAN_MS);
  refresh().catch(() => {});
})();
