/**
 * Claude Usage Meter — chat vs Claude Code usage split (pure module).
 *
 * Attributes each rise in the weekly meter to the surface of the tab that
 * observed it — regular chat, or a Claude Code (/code) page — so the Options
 * page can show what share of your usage goes to each. The tab where you're
 * actively working harvests the fresh usage first (its own API calls trigger
 * the read), so the increment lands in the right bucket; the shared
 * read-modify-write keeps other open tabs from double-counting it.
 */
(function (root) {
  "use strict";

  const EMPTY = { chat: 0, code: 0, lastW: null, wKey: null };
  const CAP = 10000; // keep the sums bounded; halving preserves the ratio

  function keyOf(resetAt) {
    return resetAt == null ? null : Math.round(resetAt / 60000);
  }

  // Fold one reading in. `r` = { weeklyPct (0..100), weeklyResetAt, surface }
  // where surface is "code" or "chat".
  function observe(model, r) {
    const src = model || EMPTY;
    const m = { chat: src.chat || 0, code: src.code || 0, lastW: src.lastW, wKey: src.wKey };
    if (!r || r.weeklyPct == null) return m;
    const wKey = keyOf(r.weeklyResetAt);
    if (m.lastW != null && wKey === m.wKey) {
      const dW = r.weeklyPct - m.lastW;
      if (dW > 0 && dW <= 100) {
        if (r.surface === "code") m.code += dW;
        else m.chat += dW;
        if (m.chat + m.code > CAP) {
          m.chat *= 0.5;
          m.code *= 0.5;
        }
      }
    }
    m.lastW = r.weeklyPct;
    m.wKey = wKey;
    return m;
  }

  // { chat, code, total, chatPct, codePct } — chatPct/codePct are 0..100.
  function share(model) {
    const chat = (model && model.chat) || 0;
    const code = (model && model.code) || 0;
    const total = chat + code;
    return {
      chat: chat,
      code: code,
      total: total,
      chatPct: total > 0 ? (chat / total) * 100 : 0,
      codePct: total > 0 ? (code / total) * 100 : 0,
    };
  }

  const api = { EMPTY, observe, share, CAP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMSplit = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
