/**
 * Claude Usage Meter — when each turn happened (pure module).
 *
 * claude.ai shows one relative time per conversation and hides the real one
 * behind a hover. Reading back through a day's work, "1 hour ago" is the least
 * useful form of that fact: what you want is the clock time it was sent, and how
 * long the turn after it took.
 *
 * This is the deciding half — which times exist, what the gap between two turns
 * should say, whether a turn needs its date as well as its clock. Rendering the
 * clock itself is left to the caller, because that is locale work and belongs
 * where a locale exists; putting the turns on the page is DOM work and lives in
 * src/stamps.js.
 */
(function (root) {
  "use strict";

  function str(x) {
    return typeof x === "string" ? x : x == null ? "" : String(x);
  }

  // The same normalisation the contents list uses, repeated rather than shared
  // so this module stands alone in a test. It is what matches a message in the
  // payload to the one rendered on the page: the two differ in whitespace and
  // nothing else.
  const KEY_CHARS = 120;
  function entryKey(text) {
    return str(text).replace(/\s+/g, " ").trim().toLowerCase().slice(0, KEY_CHARS);
  }

  // When a message says it happened. claude.ai sends ISO strings; anything
  // unparseable is null rather than a guess, since a wrong time printed under a
  // message is worse than no time at all.
  function atOf(message) {
    const raw = message && (message.created_at || message.createdAt || message.updated_at);
    if (typeof raw === "number" && isFinite(raw)) return raw;
    const t = Date.parse(str(raw));
    return isFinite(t) ? t : null;
  }

  function sameDay(a, b) {
    if (typeof a !== "number" || typeof b !== "number") return false;
    const x = new Date(a);
    const y = new Date(b);
    return (
      x.getFullYear() === y.getFullYear() &&
      x.getMonth() === y.getMonth() &&
      x.getDate() === y.getDate()
    );
  }

  // How long after the turn before it. Written the way you'd say it, and rounded
  // the way the number deserves: seconds matter for a quick answer, minutes for
  // a long one, and nothing below a second is worth printing.
  function gapText(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
    const s = Math.round(ms / 1000);
    if (s < 1) return "";
    if (s < 60) return s + "s later";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m later";
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? h + "h " + rem + "m later" : h + "h later";
  }

  /**
   * One entry per message, in order: what it is, when it was, and how long
   * after the one before. `key` is how the caller finds the rendered turn this
   * describes.
   */
  function stampList(conv) {
    const list = conv && (conv.chat_messages || conv.messages);
    const msgs = Array.isArray(list) ? list.filter((m) => m && typeof m === "object") : [];
    const out = [];
    let prevAt = null;
    for (const m of msgs) {
      const who = str(m.sender || m.role).toLowerCase();
      const at = atOf(m);
      const text = textOf(m);
      out.push({
        sender: who === "assistant" ? "assistant" : "human",
        key: entryKey(text),
        at: at,
        // The gap is only real when both ends are. A message with no time of
        // its own can't tell you how long it took.
        gapMs: at != null && prevAt != null ? Math.max(0, at - prevAt) : null,
        gap: at != null && prevAt != null ? gapText(at - prevAt) : "",
        // A conversation picked up the next morning should say so once, on the
        // turn that crossed the day, rather than printing the date on all of
        // them.
        newDay: at != null && prevAt != null && !sameDay(at, prevAt),
        first: prevAt === null,
      });
      if (at != null) prevAt = at;
    }
    return out;
  }

  // The message's own words — text blocks only, which is what the page renders
  // as the turn and therefore what the key has to be built from.
  function textOf(m) {
    if (m && Array.isArray(m.content)) {
      const parts = [];
      for (const blk of m.content) {
        if (!blk || typeof blk !== "object") continue;
        const type = str(blk.type);
        if ((!type || type === "text") && typeof blk.text === "string") parts.push(blk.text);
      }
      const joined = parts.join("\n").trim();
      if (joined) return joined;
    }
    return str(m && m.text);
  }

  const api = { entryKey, atOf, gapText, sameDay, stampList, textOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMStamp = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
