/**
 * Claude Usage Meter — incognito chat recovery (pure module).
 *
 * An incognito chat is not saved by claude.ai — that being the point of it —
 * so closing the tab takes the work with it. This keeps a running copy of each
 * one against exactly that accident, and throws it away again after a few days,
 * because a permanent record of a conversation you asked not to be recorded is
 * not a recovery feature, it's a filing cabinet nobody asked for.
 *
 * Everything here is the shape of the record and the rules about keeping it.
 * Detecting the chat and reading the replies is DOM work; it lives in
 * src/incognito-watch.js.
 */
(function (root) {
  "use strict";

  const KEY_PREFIX = "cum_ghost_";
  const INDEX_KEY = "cum_ghosts"; // ids, so records can be listed without a scan
  // "A few days." Long enough to notice the tab is gone and come looking;
  // short enough that an incognito chat doesn't quietly become permanent.
  const RETAIN_MS = 3 * 24 * 60 * 60 * 1000;
  // Generous — storage is unlimited and losing the work is the thing this
  // exists to prevent — but not unbounded, because nothing here is.
  const MAX_CHARS = 2 * 1024 * 1024;

  function str(x) {
    return typeof x === "string" ? x : x == null ? "" : String(x);
  }
  function trimmed(x) {
    return str(x).trim();
  }

  function recordKey(id) {
    return KEY_PREFIX + id;
  }

  // Is this an incognito chat, as far as the URL can say? claude.ai marks them
  // in the address; the watcher also looks for the badge on the page, because
  // markup and query strings are both unversioned and neither is worth relying
  // on alone. Deliberately narrow: recording an ordinary chat would duplicate
  // what claude.ai already keeps, which is not this feature's business.
  function looksIncognitoUrl(href) {
    const s = str(href).toLowerCase();
    if (!s) return false;
    if (/\/(temporary|incognito)(\/|\?|#|$)/.test(s)) return true;
    // The key with ANY value, or none at all — claude.ai writes it bare:
    // "/new?incognito=". Requiring =true is how a rule about a flag misses the
    // flag, so what's checked instead is whether it was explicitly turned OFF.
    const m = s.match(/[?&#](temporary|incognito|ephemeral)(=([^&#]*))?(?=&|#|$)/);
    if (!m) return false;
    const value = m[3];
    if (value === undefined || value === "") return true;
    return !/^(false|0|no|off)$/.test(value);
  }

  function newRecord(id, at, fields) {
    const f = fields || {};
    return {
      id: id,
      startedAt: at,
      updatedAt: at,
      url: trimmed(f.url),
      title: trimmed(f.title),
      turns: [],
      chars: 0,
      // Set when the cap forced the oldest turns out, so the file can say so
      // rather than looking complete.
      dropped: 0,
    };
  }

  // Append a turn. Returns the record unchanged when there's nothing to add or
  // when this is the same turn again — the watcher polls, and a reply that has
  // finished doesn't stop being on the page.
  function addTurn(record, turn, at) {
    const rec = record || newRecord("unknown", at);
    const role = trimmed(turn && turn.role).toLowerCase() === "assistant" ? "assistant" : "human";
    const text = trimmed(turn && turn.text);
    if (!text) return rec;

    const turns = (rec.turns || []).slice();
    const last = turns[turns.length - 1];
    // The same speaker saying the same thing, or the tail end of what they were
    // already saying: replace rather than repeat. A reply captured mid-stream
    // and again when it finished is one turn, not two.
    if (last && last.role === role && (text === last.text || text.indexOf(last.text) === 0)) {
      turns[turns.length - 1] = { role: role, text: text, at: at };
    } else {
      turns.push({ role: role, text: text, at: at });
    }

    let chars = turns.reduce((n, t) => n + t.text.length, 0);
    let dropped = rec.dropped || 0;
    // Over the cap, the OLDEST go. Recovery is mostly about the work just done,
    // and a record that refused to grow would stop saving exactly when a long
    // conversation needs it most.
    while (chars > MAX_CHARS && turns.length > 1) {
      chars -= turns[0].text.length;
      turns.shift();
      dropped++;
    }

    return Object.assign({}, rec, {
      turns: turns,
      chars: chars,
      dropped: dropped,
      updatedAt: at,
      title: trimmed(rec.title) || firstLine(turns[0] && turns[0].text),
    });
  }

  function firstLine(text) {
    const line = str(text)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return trimmed(line).slice(0, 70);
  }

  // Past its keeping. Separate from the sweep so the rule can be tested on its
  // own, and so a record with no timestamp at all is treated as stale rather
  // than as immortal.
  function isExpired(record, now, retainMs) {
    const keep = typeof retainMs === "number" ? retainMs : RETAIN_MS;
    const at = record && (record.updatedAt || record.startedAt);
    if (typeof at !== "number") return true;
    return now - at > keep;
  }

  function expired(records, now, retainMs) {
    return (records || []).filter((r) => isExpired(r, now, retainMs));
  }

  function live(records, now, retainMs) {
    return (records || [])
      .filter((r) => r && !isExpired(r, now, retainMs))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // Shaped like a conversation payload, so the Markdown exporter can save one of
  // these with no idea it wasn't fetched from claude.ai.
  function asConversation(record) {
    const rec = record || {};
    const turns = rec.turns || [];
    const head = rec.dropped
      ? [
          {
            sender: "human",
            content: [
              {
                type: "text",
                text:
                  "_[" + rec.dropped + " earlier turn" + (rec.dropped === 1 ? "" : "s") +
                  " dropped: this recovery record reached its size limit.]_",
              },
            ],
          },
        ]
      : [];
    return {
      name: trimmed(rec.title) || "Incognito chat",
      chat_messages: head.concat(
        turns.map((t) => ({
          sender: t.role === "assistant" ? "assistant" : "human",
          content: [{ type: "text", text: t.text }],
        }))
      ),
    };
  }

  function summarize(record) {
    const rec = record || {};
    const turns = (rec.turns || []).length;
    const replies = (rec.turns || []).filter((t) => t.role === "assistant").length;
    return {
      turns: turns,
      replies: replies,
      chars: rec.chars || 0,
      dropped: rec.dropped || 0,
    };
  }

  const api = {
    KEY_PREFIX,
    INDEX_KEY,
    RETAIN_MS,
    MAX_CHARS,
    recordKey,
    looksIncognitoUrl,
    newRecord,
    addTurn,
    isExpired,
    expired,
    live,
    asConversation,
    summarize,
    firstLine,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMIncognito = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
