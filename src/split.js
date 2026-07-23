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

  const EMPTY = { chat: 0, code: 0, away: 0, lastW: null, wKey: null, lastAt: null };
  const CAP = 10000; // keep the sums bounded; halving preserves the ratio
  // A jump in the weekly meter that follows a gap longer than this (or that a
  // hidden tab observes) didn't come from active use of the tab we're on — most
  // likely mobile or another device. The desktop poll runs every 5 min, so a
  // ~12 min threshold cleanly separates "watching continuously" from "away".
  const GAP_MS = 12 * 60 * 1000;

  function keyOf(resetAt) {
    return resetAt == null ? null : Math.round(resetAt / 60000);
  }

  // Fold one reading in. `r` = { weeklyPct (0..100), weeklyResetAt, surface,
  // at, visible } — surface is "code"/"chat"; `at` is the reading's timestamp;
  // `visible` is whether the observing tab is foreground.
  function observe(model, r) {
    const src = model || EMPTY;
    const m = {
      chat: src.chat || 0, code: src.code || 0, away: src.away || 0,
      lastW: src.lastW, wKey: src.wKey, lastAt: src.lastAt,
    };
    if (!r || r.weeklyPct == null) return m;
    const wKey = keyOf(r.weeklyResetAt);
    if (m.lastW != null && wKey === m.wKey) {
      const dW = r.weeklyPct - m.lastW;
      if (dW > 0 && dW <= 100) {
        // Count toward the current surface only if we were actively watching
        // (recent prior reading) AND this tab is foreground; otherwise the usage
        // accrued while we were away (mobile / another device).
        const recent = m.lastAt != null && r.at != null && r.at - m.lastAt <= GAP_MS;
        const live = recent && r.visible !== false;
        if (live) {
          if (r.surface === "code") m.code += dW;
          else m.chat += dW;
        } else {
          m.away += dW;
        }
        if (m.chat + m.code + m.away > CAP) {
          m.chat *= 0.5;
          m.code *= 0.5;
          m.away *= 0.5;
        }
      }
    }
    m.lastW = r.weeklyPct;
    m.wKey = wKey;
    if (r.at != null) m.lastAt = r.at;
    return m;
  }

  // { chat, code, away, total, chatPct, codePct, awayPct } — pcts are 0..100.
  function share(model) {
    const chat = (model && model.chat) || 0;
    const code = (model && model.code) || 0;
    const away = (model && model.away) || 0;
    const total = chat + code + away;
    return {
      chat: chat,
      code: code,
      away: away,
      total: total,
      chatPct: total > 0 ? (chat / total) * 100 : 0,
      codePct: total > 0 ? (code / total) * 100 : 0,
      awayPct: total > 0 ? (away / total) * 100 : 0,
    };
  }

  const api = { EMPTY, observe, share, CAP, GAP_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMSplit = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
