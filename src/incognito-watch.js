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
  // Badges claude.ai puts on a temporary chat. Confirmed live: a leaf
  //   <span class="text-sm select-none">Incognito chat</span>
  // sitting at the very top left of the page (y≈16), which the top-of-window
  // fallback below catches whether or not it is inside anything calling itself
  // a header.
  //
  // The WORD, not that exact caption:
  // "Incognito", "Incognito chat", "Temporary chat · not saved" are all the
  // same badge, and betting on one wording is how the fallback stops falling
  // back. Safe because of what it is matched against, below — a MESSAGE that
  // says "incognito" is a message, not a mode.
  const BADGE_RE = /\b(incognito|temporary)\b/i;
  const BADGE_MAX = 30; // badge-sized text, not a sentence
  const BADGE_SCOPE = "header, [role=banner], nav, [data-testid*='header' i]";
  // Where the header would be, for a page that doesn't use any of those.
  const BADGE_TOP_PX = 170;

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

  // The conversation's own turns. Declared here because the badge check needs
  // them too: text inside a message is what someone SAID about incognito mode,
  // which is not the same as being in it.
  const TURN_SELECTORS = [
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    ".font-user-message",
    ".font-claude-response",
    ".font-claude-message",
  ];

  // A leaf, badge-sized, and not part of the conversation itself. Those three
  // together are what make matching a mere word safe.
  function badgeish(node) {
    if (!node || C.isOurs(node) || node.children.length) return false;
    const t = (node.textContent || "").trim();
    if (!t || t.length > BADGE_MAX || !BADGE_RE.test(t)) return false;
    try {
      // Text inside a message is what someone SAID about incognito mode, which
      // is not the same as being in it.
      if (node.closest(TURN_SELECTORS.join(","))) return false;
    } catch (e) {
      /* ignore */
    }
    return true;
  }

  function badgeSaysIncognito() {
    try {
      for (const scope of document.querySelectorAll(BADGE_SCOPE)) {
        for (const node of scope.querySelectorAll("span,div,p,button")) {
          if (badgeish(node)) return true;
        }
      }
      // No header of any name claude.ai answers to. Fall back to where a header
      // would be: near the top of the page, which a message only reaches by
      // being scrolled there — hence the exclusion above.
      for (const node of document.querySelectorAll("span,div,p,button")) {
        if (!badgeish(node)) continue;
        const r = node.getBoundingClientRect();
        if (r.width && r.top >= 0 && r.top <= BADGE_TOP_PX) return true;
      }
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  // Session storage, so all of this lives exactly as long as the tab does —
  // which is exactly as long as the chat it describes.
  const MODE_KEY = "cum_ghost_mode"; // this tab is on an incognito chat
  const CONV_KEY = "cum_ghost_conv"; // …and this is the conversation it became
  const TAB_KEY = "cum_ghost_tab"; // the record it writes to

  function session(key, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(key);
      sessionStorage.setItem(key, value);
    } catch (e) {
      /* ignore */
    }
    return value;
  }

  // The flag rides the COMPOSER url — "/new?incognito=" — and claude.ai
  // navigates away from it the moment the chat exists. So the answer is sticky
  // for the tab: seen once, this tab is on an incognito chat until it plainly
  // isn't. Losing the mode at the exact moment the first reply lands would make
  // this feature miss the only thing it exists for.
  function isIncognito() {
    if (G.looksIncognitoUrl(location.href) || badgeSaysIncognito()) {
      session(MODE_KEY, "1");
      // The conversation it turned into, remembered the first time we see one:
      // that id is this chat's, and any OTHER id later means we've left.
      const conv = convId();
      if (conv && !session(CONV_KEY)) session(CONV_KEY, conv);
      return true;
    }
    if (session(MODE_KEY) !== "1") return false;

    // Sticky, but not blind. A tab taken to a different conversation, with no
    // flag and no badge, is not the incognito chat any more — and appending an
    // ordinary chat to this record would be the opposite of the point.
    const conv = convId();
    const started = session(CONV_KEY);
    if (conv && started && conv !== started) {
      session(MODE_KEY, "0");
      return false;
    }
    if (conv && !started) session(CONV_KEY, conv);
    return true;
  }

  function convId() {
    try {
      return W ? W.conversationId(location.pathname) : null;
    } catch (e) {
      return null;
    }
  }

  // One record per tab, for the life of the tab. NOT keyed on the conversation
  // id: an incognito chat starts at /new with no id and acquires one when it's
  // created, and a record keyed on that would be split in two at exactly the
  // moment the first reply arrived.
  function chatId() {
    let tab = session(TAB_KEY);
    if (!tab) {
      tab = "tab-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      session(TAB_KEY, tab);
    }
    return tab;
  }

  // The conversation as it stands, oldest first. Both sides: a reply without
  // the question it answered is half a record.
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
