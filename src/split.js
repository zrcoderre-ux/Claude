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

  // rNum/rDen accumulate a learned rate: weekly-% per model-weighted token,
  // measured from live Home usage (how much the weekly meter rose as a Home
  // conversation's content grew). It converts a gap's estimated chat content
  // into an estimated chat %, so the rest of the gap can go to Code.
  const EMPTY = { chat: 0, code: 0, lastW: null, wKey: null, lastAt: null, rNum: 0, rDen: 0 };
  const CAP = 10000; // keep the sums bounded; halving preserves the ratio
  const RATE_CAP = 5e6; // bound the rate accumulator so recent data dominates

  function keyOf(resetAt) {
    return resetAt == null ? null : Math.round(resetAt / 60000);
  }

  // Fold one reading in. `r` = { weeklyPct (0..100), weeklyResetAt, surface, at }
  // where surface is "code" (the Code tab) or "chat" (the Home tab), and `at` is
  // the reading's timestamp (kept as the gap boundary). Optional
  // `chatDelta`/`codeDelta` explicitly split the increment (content-based
  // attribution across a gap); otherwise the whole increment goes to `surface`.
  function observe(model, r) {
    const src = model || EMPTY;
    const m = {
      chat: src.chat || 0, code: src.code || 0,
      lastW: src.lastW, wKey: src.wKey, lastAt: src.lastAt,
      rNum: src.rNum || 0, rDen: src.rDen || 0,
    };
    if (!r || r.weeklyPct == null) return m;
    const wKey = keyOf(r.weeklyResetAt);
    if (m.lastW != null && wKey === m.wKey) {
      const dW = r.weeklyPct - m.lastW;
      if (dW > 0 && dW <= 100) {
        if (r.chatDelta != null || r.codeDelta != null) {
          m.chat += Math.max(0, r.chatDelta || 0);
          m.code += Math.max(0, r.codeDelta || 0);
        } else if (r.surface === "code") {
          m.code += dW;
        } else {
          m.chat += dW;
          // Live Home increment with a measured content growth (weighted
          // tokens): learn the weekly-%-per-token rate for future gap splits.
          if (r.learnTok > 0) {
            m.rNum += dW;
            m.rDen += r.learnTok;
            if (m.rDen > RATE_CAP) { m.rNum *= 0.5; m.rDen *= 0.5; }
          }
        }
        if (m.chat + m.code > CAP) {
          m.chat *= 0.5;
          m.code *= 0.5;
        }
      }
    }
    m.lastW = r.weeklyPct;
    m.wKey = wKey;
    if (r.at != null) m.lastAt = r.at;
    return m;
  }

  // Coarse gap attribution from a content signal alone: Home chats all live in
  // chat_conversations_v2, so if one was touched during the gap the usage was
  // (at least) Home; if none were, it was Code. Used as the fallback for
  // splitByContent before a rate is learned. Returns { chatDelta, codeDelta }.
  function attributeGap(gapDelta, homeTouched) {
    const d = gapDelta > 0 ? gapDelta : 0;
    if (!d) return { chatDelta: 0, codeDelta: 0 };
    return homeTouched ? { chatDelta: d, codeDelta: 0 } : { chatDelta: 0, codeDelta: d };
  }

  // Fold a rate observation in WITHOUT attributing usage to a bucket — for
  // ground-truth signals (the real Code context tokens read from claude.ai's own
  // panel) that should sharpen the weekly-%-per-token rate but not themselves be
  // counted as chat/code usage (the live/gap paths already bucket that). `dPct`
  // is the weekly-% rise over the interval; `weightedTokens` is the real,
  // model-weighted content added. Same accumulator and cap as the live learner.
  function learn(model, dPct, weightedTokens) {
    const src = model || EMPTY;
    const m = {
      chat: src.chat || 0, code: src.code || 0,
      lastW: src.lastW, wKey: src.wKey, lastAt: src.lastAt,
      rNum: src.rNum || 0, rDen: src.rDen || 0,
    };
    if (dPct > 0 && weightedTokens > 0) {
      m.rNum += dPct;
      m.rDen += weightedTokens;
      if (m.rDen > RATE_CAP) { m.rNum *= 0.5; m.rDen *= 0.5; }
    }
    return m;
  }

  // The learned weekly-%-per-weighted-token rate, or null before enough live
  // Home data has been observed.
  function rate(model) {
    const rDen = (model && model.rDen) || 0;
    if (rDen <= 0) return null;
    return ((model && model.rNum) || 0) / rDen;
  }

  // Split a gap in which Home was touched but Code may also have run. Estimate
  // Home's share from its measured content (`chatWeighted` = model-weighted
  // tokens added to Home chats during the gap) times the learned rate, and give
  // the remainder to Code. Falls back to the binary attributeGap when there's no
  // learned rate yet or no content measurement. Returns { chatDelta, codeDelta }.
  function splitByContent(model, gapDelta, chatWeighted, homeTouched) {
    const d = gapDelta > 0 ? gapDelta : 0;
    if (!d) return { chatDelta: 0, codeDelta: 0 };
    const rt = rate(model);
    if (rt == null || chatWeighted == null || !(chatWeighted >= 0)) {
      return attributeGap(d, homeTouched);
    }
    const est = Math.max(0, chatWeighted * rt);
    const chatDelta = Math.min(est, d);
    return { chatDelta, codeDelta: d - chatDelta };
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

  const api = { EMPTY, observe, learn, share, attributeGap, splitByContent, rate, CAP, RATE_CAP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMSplit = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
