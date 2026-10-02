/**
 * Claude Usage Meter — a name no earlier conversation already has (pure).
 *
 * The extension names conversations in two places — a workflow run's chats and
 * the Upload folder button's — and the name it would give is often one an
 * earlier conversation already carries: the same folder uploaded twice, a new
 * run under a matter's name. Two rows reading the same in the sidebar say
 * nothing about which is which, so the later one gets a number: the first
 * conversation with a name is 1 without saying so, the next is "Name 2", then
 * "Name 3". The number is the smallest one free, starting at 2.
 *
 * What counts as taken:
 *   - every Home chat's name, read live from chat_conversations_v2 — the
 *     authority for chats, because it knows what has since been renamed or
 *     deleted;
 *   - every name this extension has given a Cowork session. Cowork sessions are
 *     not in that list and no list of them has been confirmed, so the names the
 *     extension gave them are the ones it can vouch for. (A chat's name it gave
 *     stands in only when the live list could not be read.)
 * The conversation being named never counts against itself.
 *
 * The choice is remembered by conversation id, so the passes that keep a name
 * on a conversation while claude.ai's auto-title competes for it keep giving
 * the SAME answer. Without that, the second pass would find its own "Name 2"
 * taken and move on to "Name 3".
 */
(function (root) {
  "use strict";

  const MAX_REMEMBERED = 500;
  const MAX_TITLE = 100;
  const EMPTY = { names: [] };

  // The comparison "already has the name" uses: case, spacing and punctuation
  // aside, the letters and digits — the same rule CUMCowork.sameTitle applies
  // to a name read back off the page.
  function squash(v) {
    return String(v == null ? "" : v)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function same(a, b) {
    const x = squash(a);
    return !!x && x === squash(b);
  }

  function isCoworkId(id) {
    return /^cse_/.test(String(id || ""));
  }

  // Where `title` sits in `base`'s series: 1 for the base itself, n for
  // "base n" (n >= 2), 0 for anything else.
  function numberIn(title, base) {
    if (same(title, base)) return 1;
    const m = /^(.*\S)\s+(\d{1,4})$/.exec(String(title == null ? "" : title).trim());
    if (!m) return 0;
    const n = +m[2];
    return n >= 2 && same(m[1], base) ? n : 0;
  }

  // The name to give: `base` when nothing taken has it, else "base n" for the
  // smallest n >= 2 nothing taken has. Kept within `max` by shortening the
  // base, never the number — the number is the part that tells them apart.
  function nextName(base, taken, max) {
    const b = String(base == null ? "" : base).trim();
    if (!b) return "";
    const used = new Set();
    for (const t of taken || []) {
      const n = numberIn(t, b);
      if (n) used.add(n);
    }
    if (!used.has(1)) return b;
    let n = 2;
    while (used.has(n)) n++;
    const suffix = " " + n;
    const cap = max || MAX_TITLE;
    if (b.length + suffix.length <= cap) return b + suffix;
    return b.slice(0, Math.max(1, cap - suffix.length)).trim() + suffix;
  }

  // One page of chat_conversations_v2: its conversations as { id, name }, and
  // whether it says more follow. A bare array says nothing about more.
  function parseList(json) {
    const arr = Array.isArray(json)
      ? json
      : json && typeof json === "object"
      ? json.data || json.conversations || json.chat_conversations || null
      : null;
    if (!Array.isArray(arr)) return null;
    const items = [];
    for (const c of arr) {
      if (!c || typeof c !== "object") continue;
      const id = c.uuid || c.id;
      const name = typeof c.name === "string" ? c.name : typeof c.title === "string" ? c.title : "";
      if (id) items.push({ id: String(id), name: name });
    }
    const more =
      json && !Array.isArray(json) && typeof json === "object"
        ? json.has_more === true || json.hasMore === true
        : false;
    return { items: items, hasMore: more };
  }

  // ---- What the extension has named, by conversation ---------------------
  // Entries { id, base, title, at }. `base` is the name asked for, `title` the
  // one given — a conversation asked for the same base again gets the same
  // title back.

  // The remembered entry for this conversation and this asked-for name, or
  // null. It carries `note` when the check behind it was only partial, so the
  // pass that reports can still say so after an earlier, silent pass decided.
  function entryFor(ledger, id, base) {
    if (!id) return null;
    for (const e of (ledger && ledger.names) || []) {
      if (e && e.id === id && same(e.base, base) && e.title) return e;
    }
    return null;
  }

  function recall(ledger, id, base) {
    const e = entryFor(ledger, id, base);
    return e ? e.title : "";
  }

  function remember(ledger, entry) {
    const prev = ((ledger && ledger.names) || []).filter((e) => e && e.id !== entry.id);
    const names = prev.concat([entry]);
    return { names: names.length > MAX_REMEMBERED ? names.slice(names.length - MAX_REMEMBERED) : names };
  }

  // Every name that counts as taken for conversation `selfId`. `live` is what
  // the chat list read came back with: { ok, items } — ok false (or no live at
  // all) means the list could not be read, and the chat names this extension
  // gave stand in for it.
  function takenFor(ledger, live, selfId) {
    const out = [];
    const liveOk = !!(live && live.ok && Array.isArray(live.items));
    if (liveOk) for (const it of live.items) if (it && it.id !== selfId && it.name) out.push(it.name);
    for (const e of (ledger && ledger.names) || []) {
      if (!e || e.id === selfId || !e.title) continue;
      if (isCoworkId(e.id) || !liveOk) out.push(e.title);
    }
    return out;
  }

  const api = {
    EMPTY,
    MAX_REMEMBERED,
    MAX_TITLE,
    same,
    isCoworkId,
    numberIn,
    nextName,
    parseList,
    entryFor,
    recall,
    remember,
    takenFor,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMTitles = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
