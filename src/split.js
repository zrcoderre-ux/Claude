/**
 * Claude Usage Meter — Chat vs Cowork vs Claude Code usage split (pure module).
 *
 * Attributes each rise in the weekly meter to the surface of the tab that
 * observed it — an ordinary chat, a Cowork session, or a Claude Code (/code)
 * page — so the Options page can show what share of your usage goes to each.
 * The tab where you're actively working harvests the fresh usage first (its own
 * API calls trigger the read), so the increment lands in the right bucket; the
 * shared read-modify-write keeps other open tabs from double-counting it.
 *
 * Cowork is a third surface rather than a flavour of chat, and the evidence for
 * it is not the evidence for chat: a Cowork session lives under /conversations,
 * not chat_conversations_v2, so the content probe that measures Home chats
 * across a gap cannot see one. That asymmetry is the whole design of the gap
 * path below — what a gap can prove is "a Home CHAT was touched" and nothing
 * more, so the rest of a gap is Cowork-or-Code and is divided the only honest
 * way available: in the proportion those two have been seen LIVE, where the
 * surface was read off the page rather than inferred.
 */
(function (root) {
  "use strict";

  // rNum/rDen accumulate a learned rate: weekly-% per model-weighted token,
  // measured from live Home-CHAT usage (how much the weekly meter rose as a
  // chat's content grew). It converts a gap's estimated chat content into an
  // estimated chat %, so the rest of the gap can go elsewhere.
  //
  // liveCowork/liveCode are the same numbers as cowork/code but counted ONLY
  // from readings whose surface we read off the page. They're what the
  // ambiguous part of a gap is divided by, and keeping them separate is what
  // stops that division from feeding on its own guesses.
  const EMPTY = {
    chat: 0,
    cowork: 0,
    code: 0,
    lastW: null,
    wKey: null,
    lastAt: null,
    rNum: 0,
    rDen: 0,
    liveCowork: 0,
    liveCode: 0,
  };
  const CAP = 10000; // keep the sums bounded; halving preserves the ratio
  const RATE_CAP = 5e6; // bound the rate accumulator so recent data dominates

  function keyOf(resetAt) {
    return resetAt == null ? null : Math.round(resetAt / 60000);
  }

  // Carry a stored model forward. Every field is defaulted, because a model
  // written before Cowork was a bucket is missing three of them and must read
  // as "no Cowork seen" rather than as NaN.
  function carry(model) {
    const src = model || EMPTY;
    return {
      chat: src.chat || 0,
      cowork: src.cowork || 0,
      code: src.code || 0,
      lastW: src.lastW == null ? null : src.lastW,
      wKey: src.wKey == null ? null : src.wKey,
      lastAt: src.lastAt == null ? null : src.lastAt,
      rNum: src.rNum || 0,
      rDen: src.rDen || 0,
      liveCowork: src.liveCowork || 0,
      liveCode: src.liveCode || 0,
    };
  }

  // Fold one reading in. `r` = { weeklyPct (0..100), weeklyResetAt, surface, at }
  // where surface is "code", "cowork" or "chat", and `at` is the reading's
  // timestamp (kept as the gap boundary). Optional `chatDelta`/`coworkDelta`/
  // `codeDelta` explicitly split the increment (the gap path's content-based
  // attribution); otherwise the whole increment goes to `surface`.
  function observe(model, r) {
    const m = carry(model);
    if (!r || r.weeklyPct == null) return m;
    const wKey = keyOf(r.weeklyResetAt);
    if (m.lastW != null && wKey === m.wKey) {
      const dW = r.weeklyPct - m.lastW;
      if (dW > 0 && dW <= 100) {
        const explicit = r.chatDelta != null || r.coworkDelta != null || r.codeDelta != null;
        if (explicit) {
          m.chat += Math.max(0, r.chatDelta || 0);
          m.cowork += Math.max(0, r.coworkDelta || 0);
          m.code += Math.max(0, r.codeDelta || 0);
        } else if (r.surface === "code") {
          m.code += dW;
          m.liveCode += dW;
        } else if (r.surface === "cowork") {
          m.cowork += dW;
          m.liveCowork += dW;
          // No rate learning here: the content probe behind that rate reads
          // chat_conversations_v2, which holds no Cowork session, so a Cowork
          // increment has no measured content to pair with.
        } else {
          m.chat += dW;
          // Live chat increment with a measured content growth (weighted
          // tokens): learn the weekly-%-per-token rate for future gap splits.
          if (r.learnTok > 0) {
            m.rNum += dW;
            m.rDen += r.learnTok;
            if (m.rDen > RATE_CAP) {
              m.rNum *= 0.5;
              m.rDen *= 0.5;
            }
          }
        }
        if (m.chat + m.cowork + m.code > CAP) {
          m.chat *= 0.5;
          m.cowork *= 0.5;
          m.code *= 0.5;
        }
        if (m.liveCowork + m.liveCode > CAP) {
          m.liveCowork *= 0.5;
          m.liveCode *= 0.5;
        }
      }
    }
    m.lastW = r.weeklyPct;
    m.wKey = wKey;
    if (r.at != null) m.lastAt = r.at;
    return m;
  }

  /**
   * Divide usage that could be Cowork or Code and carries no evidence either
   * way — the part of a gap no probe can see into.
   *
   * The split is the proportion in which those two have been observed LIVE. It
   * never invents Cowork out of nothing: an account that has never had a Cowork
   * reading gets the whole remainder as Code, which is exactly what this did
   * before Cowork was a bucket.
   */
  function splitUnseen(model, delta) {
    const d = delta > 0 ? delta : 0;
    if (!d) return { coworkDelta: 0, codeDelta: 0 };
    const m = carry(model);
    const seen = m.liveCowork + m.liveCode;
    if (!(seen > 0)) return { coworkDelta: 0, codeDelta: d };
    const coworkDelta = d * (m.liveCowork / seen);
    return { coworkDelta: coworkDelta, codeDelta: d - coworkDelta };
  }

  // Coarse gap attribution from a content signal alone: Home CHATS all live in
  // chat_conversations_v2, so if one was touched during the gap the usage was
  // (at least) chat; if none were, it was Cowork or Code — divided by
  // splitUnseen, since nothing in a gap distinguishes those two. Used as the
  // fallback for splitByContent before a rate is learned.
  // Returns { chatDelta, coworkDelta, codeDelta }.
  function attributeGap(model, gapDelta, homeTouched) {
    const d = gapDelta > 0 ? gapDelta : 0;
    if (!d) return { chatDelta: 0, coworkDelta: 0, codeDelta: 0 };
    if (homeTouched) return { chatDelta: d, coworkDelta: 0, codeDelta: 0 };
    const rest = splitUnseen(model, d);
    return { chatDelta: 0, coworkDelta: rest.coworkDelta, codeDelta: rest.codeDelta };
  }

  // Fold a rate observation in WITHOUT attributing usage to a bucket — for
  // ground-truth signals (the real Code context tokens read from claude.ai's own
  // panel) that should sharpen the weekly-%-per-token rate but not themselves be
  // counted as usage (the live/gap paths already bucket that). `dPct` is the
  // weekly-% rise over the interval; `weightedTokens` is the real,
  // model-weighted content added. Same accumulator and cap as the live learner.
  function learn(model, dPct, weightedTokens) {
    const m = carry(model);
    if (dPct > 0 && weightedTokens > 0) {
      m.rNum += dPct;
      m.rDen += weightedTokens;
      if (m.rDen > RATE_CAP) {
        m.rNum *= 0.5;
        m.rDen *= 0.5;
      }
    }
    return m;
  }

  // The learned weekly-%-per-weighted-token rate, or null before enough live
  // chat data has been observed.
  function rate(model) {
    const rDen = (model && model.rDen) || 0;
    if (rDen <= 0) return null;
    return ((model && model.rNum) || 0) / rDen;
  }

  // Split a gap in which a Home chat was touched but Cowork or Code may also
  // have run. Estimate the chat's share from its measured content
  // (`chatWeighted` = model-weighted tokens added to Home chats during the gap)
  // times the learned rate, and divide the remainder between Cowork and Code by
  // what has been seen live. Falls back to the binary attributeGap when there's
  // no learned rate yet or no content measurement.
  // Returns { chatDelta, coworkDelta, codeDelta }.
  function splitByContent(model, gapDelta, chatWeighted, homeTouched) {
    const d = gapDelta > 0 ? gapDelta : 0;
    if (!d) return { chatDelta: 0, coworkDelta: 0, codeDelta: 0 };
    const rt = rate(model);
    if (rt == null || chatWeighted == null || !(chatWeighted >= 0)) {
      return attributeGap(model, d, homeTouched);
    }
    const est = Math.max(0, chatWeighted * rt);
    const chatDelta = Math.min(est, d);
    const rest = splitUnseen(model, d - chatDelta);
    return { chatDelta: chatDelta, coworkDelta: rest.coworkDelta, codeDelta: rest.codeDelta };
  }

  // { chat, cowork, code, total, chatPct, coworkPct, codePct } — the Pcts are
  // 0..100 and sum to 100 (or to 0 when nothing has been observed).
  function share(model) {
    const m = carry(model);
    const total = m.chat + m.cowork + m.code;
    const pct = (v) => (total > 0 ? (v / total) * 100 : 0);
    return {
      chat: m.chat,
      cowork: m.cowork,
      code: m.code,
      total: total,
      chatPct: pct(m.chat),
      coworkPct: pct(m.cowork),
      codePct: pct(m.code),
    };
  }

  const api = {
    EMPTY,
    observe,
    learn,
    share,
    attributeGap,
    splitByContent,
    splitUnseen,
    rate,
    CAP,
    RATE_CAP,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMSplit = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
