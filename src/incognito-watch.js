/**
 * Claude Usage Meter — incognito chat recovery (ISOLATED world content script).
 *
 * claude.ai doesn't save an incognito chat, so closing the tab takes the work
 * with it. This keeps a running copy in the extension while such a chat is
 * open, and nothing else does: an ordinary chat is already saved, and copying
 * it here would only duplicate what claude.ai holds.
 *
 * Read from the rendered page, because there is nowhere else to read it from —
 * the conversation API has no record of a chat that was never saved. Read, not
 * clicked: this is a conversation you are driving by hand, and a script
 * reaching for the copy box under your cursor would be its own kind of
 * accident.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  const G = window.CUMIncognito;
  const W = window.CUMWorkflow;
  if (!C || !G) return;

  const POLL_MS = 4000;
  // Badges claude.ai puts on a temporary chat. Matched only against short,
  // header-ish text — a MESSAGE that says "incognito" is a message, not a mode.
  const BADGE_RE = /^\s*(incognito|temporary)(\s+chat)?\s*$/i;
  const BADGE_SCOPE = "header, [role=banner], nav, [data-testid*='header' i]";

  let recordId = null;
  let record = null;
  let saving = false;

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
    return new Promise((r) => {
      try {
        chrome.storage.local.set(obj, r);
      } catch (e) {
        r();
      }
    });
  }

  function badgeSaysIncognito() {
    try {
      for (const scope of document.querySelectorAll(BADGE_SCOPE)) {
        for (const node of scope.querySelectorAll("span,div,p,button")) {
          if (C.isOurs(node)) continue;
          const t = node.textContent || "";
          // Only leaf-ish text: a container holding the whole header would
          // match on any word inside it.
          if (t.length > 24 || node.children.length) continue;
          if (BADGE_RE.test(t)) return true;
        }
      }
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  function isIncognito() {
    return G.looksIncognitoUrl(location.href) || badgeSaysIncognito();
  }

  // A stable id for THIS chat. The conversation id where there is one; failing
  // that — an incognito chat may never get one — a per-tab id kept in
  // sessionStorage, which lives exactly as long as the tab does.
  function chatId() {
    let conv = null;
    try {
      conv = W ? W.conversationId(location.pathname) : null;
    } catch (e) {
      /* ignore */
    }
    if (conv) return "conv-" + conv;
    try {
      let tab = sessionStorage.getItem("cum_ghost_tab");
      if (!tab) {
        tab = "tab-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem("cum_ghost_tab", tab);
      }
      return tab;
    } catch (e) {
      return "tab-unknown";
    }
  }

  // The conversation as it stands, oldest first. Both sides: a reply without
  // the question it answered is half a record.
  const TURN_SELECTORS = [
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    ".font-user-message",
    ".font-claude-response",
    ".font-claude-message",
  ];
  function turnsOnPage() {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(TURN_SELECTORS.join(","))).filter(
        (n) => !C.isOurs(n)
      );
    } catch (e) {
      return [];
    }
    // Document order, so the record reads as the conversation did.
    nodes.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    const out = [];
    for (const n of nodes) {
      // A node inside another matched node is the same turn seen twice.
      if (out.some((o) => o.node.contains(n))) continue;
      const human = /user-message|font-user-message/.test(
        (n.getAttribute("data-testid") || "") + " " + (n.className || "")
      );
      const text = (n.textContent || "").trim();
      if (!text) continue;
      out.push({ node: n, role: human ? "human" : "assistant", text: text });
    }
    return out;
  }

  async function load(id) {
    const key = G.recordKey(id);
    const got = await storageGet(key);
    return got[key] || G.newRecord(id, Date.now(), { url: location.href });
  }

  async function persist() {
    if (!record || saving) return;
    saving = true;
    try {
      await storageSet({ [G.recordKey(record.id)]: record });
      // The index, so the Options page can list records without scanning every
      // key in storage.
      const store = await storageGet(G.INDEX_KEY);
      const ids = store[G.INDEX_KEY] || [];
      if (ids.indexOf(record.id) === -1)
        await storageSet({ [G.INDEX_KEY]: ids.concat([record.id]) });
    } finally {
      saving = false;
    }
  }

  async function tick() {
    if (!isIncognito()) return;
    const id = chatId();
    if (id !== recordId) {
      recordId = id;
      record = await load(id);
    }
    if (!record) return;

    // Don't capture a reply that is still being written — the next poll will
    // take it whole, and addTurn replaces a turn it has already seen rather
    // than stacking the halves.
    let generating = false;
    try {
      generating = C.isGenerating();
    } catch (e) {
      /* ignore */
    }

    const turns = turnsOnPage();
    if (!turns.length) return;
    const now = Date.now();
    let next = record;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const isLast = i === turns.length - 1;
      if (isLast && generating && t.role === "assistant") continue;
      next = G.addTurn(next, t, now);
    }
    if (next === record) return;
    if (!next.url) next = Object.assign({}, next, { url: location.href });
    record = next;
    await persist();
  }

  setInterval(() => {
    tick().catch(() => {});
  }, POLL_MS);
  tick().catch(() => {});
})();
