/**
 * Claude Usage Meter — content-cost estimator (pure, world-agnostic).
 *
 * Estimates how much a chat message "costs" toward the weekly limit, so a gap
 * in which both Home and Code were used can be split by content rather than
 * lumped onto one surface. Cost is a rough, model-weighted token estimate that
 * accounts for:
 *   - the message's word count (~1.33 tokens/word),
 *   - the presence and size of attachments/files, and
 *   - which model produced the conversation (Opus draws down the weekly budget
 *     far faster than Sonnet/Haiku, so the same words cost more).
 *
 * The absolute scale doesn't matter — content.js learns a weekly-%-per-token
 * rate from live Home usage and applies it to these estimates — but the *ratios*
 * (model, attachments) do, which is what these weights capture. Loaded in both
 * the MAIN world (inject.js measures conversation content) and the ISOLATED
 * world (content.js weights live context growth), and required directly in tests.
 */
(function (root) {
  "use strict";

  const TOKENS_PER_WORD = 1.33; // English averages ~0.75 words/token
  const CHARS_PER_TOKEN = 4; // fallback for attachment text
  const MAX_ATTACH_TOKENS = 200000; // cap one attachment's contribution
  const UNKNOWN_ATTACH_TOKENS = 1000; // an attachment we can't size

  // Relative weekly-budget cost per token, referenced to Opus (=1). These are
  // heuristic — the plans meter models differently and the exact ratio isn't
  // published — but they capture that heavier models spend the weekly limit
  // faster. Unknown models are assumed premium so chat is never undercounted.
  function modelWeight(model) {
    if (!model) return 1;
    const m = String(model).toLowerCase();
    if (/opus/.test(m)) return 1;
    if (/sonnet/.test(m)) return 0.3;
    if (/haiku/.test(m)) return 0.08;
    if (/fable/.test(m)) return 0.3;
    return 1;
  }

  function wordCount(text) {
    if (typeof text !== "string") return 0;
    const t = text.trim();
    if (!t) return 0;
    return t.split(/\s+/).length;
  }

  // The message's human text. `text` (human turns) and `content[].text`
  // (assistant turns) usually mirror each other, so take the longer rather than
  // summing — mirrors harvest.js's messageChars to avoid double-counting.
  function messageText(msg) {
    if (!msg || typeof msg !== "object") return "";
    const top = typeof msg.text === "string" ? msg.text : "";
    let joined = "";
    if (Array.isArray(msg.content)) {
      for (const blk of msg.content) {
        if (!blk || typeof blk !== "object") continue;
        if (typeof blk.text === "string") joined += blk.text;
        else if (typeof blk.content === "string") joined += blk.content;
      }
    }
    return top.length >= joined.length ? top : joined;
  }

  // Estimate the token weight of a message's attachments and files. Prefers real
  // sizes (extracted text length, or byte size), else a flat per-item estimate.
  function attachmentTokens(msg) {
    if (!msg || typeof msg !== "object") return 0;
    let total = 0;
    const lists = [];
    if (Array.isArray(msg.attachments)) lists.push(msg.attachments);
    if (Array.isArray(msg.files)) lists.push(msg.files);
    if (Array.isArray(msg.sync_sources)) lists.push(msg.sync_sources);
    for (const list of lists) {
      for (const a of list) {
        if (!a || typeof a !== "object") {
          total += UNKNOWN_ATTACH_TOKENS;
          continue;
        }
        let tok;
        if (typeof a.extracted_content === "string" && a.extracted_content) {
          tok = a.extracted_content.length / CHARS_PER_TOKEN;
        } else {
          const bytes = numeric(
            a.file_size != null ? a.file_size : a.size != null ? a.size : a.file_size_bytes
          );
          tok = bytes != null && bytes > 0 ? bytes / CHARS_PER_TOKEN : UNKNOWN_ATTACH_TOKENS;
        }
        total += Math.min(tok, MAX_ATTACH_TOKENS);
      }
    }
    return total;
  }

  function numeric(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
    return null;
  }

  // Raw (unweighted) token estimate for one message = words + attachments.
  function messageTokens(msg) {
    return wordCount(messageText(msg)) * TOKENS_PER_WORD + attachmentTokens(msg);
  }

  // Total model-weighted token estimate for the messages in a conversation that
  // were created at/after `sinceMs` (the gap boundary). `model` is the
  // conversation's model. Passing sinceMs = null counts every message.
  function sumNewContent(messages, sinceMs, model) {
    if (!Array.isArray(messages)) return 0;
    let raw = 0;
    for (const m of messages) {
      if (sinceMs != null) {
        const t = Date.parse((m && (m.created_at || m.updated_at)) || "");
        if (!t || Number.isNaN(t) || t < sinceMs) continue;
      }
      raw += messageTokens(m);
    }
    return raw * modelWeight(model);
  }

  // Read the real context figures out of the Code tab's native context panel
  // text (e.g. "Context window 696.1k / 1.0M (70%)"). The web app tokenizes
  // client-side and shows no persistent number — the figure exists only while
  // that panel is expanded — so this is the one authoritative source when the
  // user opens it. Matches only the full "used / total (pct%)" breakdown, so the
  // bare collapsed "Context window" label is ignored. Returns { tokens, window,
  // pct } (pct 0..1) or null. Tolerant of the value being split across spans,
  // since it runs on a container's concatenated textContent.
  function parseNativeContext(text) {
    if (typeof text !== "string" || !/context window/i.test(text)) return null;
    const m = text.match(
      /context window[^%]*?(\d[\d.]*)\s*([kmb])?\s*\/\s*(\d[\d.]*)\s*([kmb])\s*\(\s*(\d+(?:\.\d+)?)\s*%\)/i
    );
    if (!m) return null;
    const used = toTokens(m[1], m[2] || m[4]);
    const win = toTokens(m[3], m[4]);
    const pct = parseFloat(m[5]) / 100;
    if (!(win > 0) || !(pct >= 0)) return null;
    return { tokens: used, window: win, pct };
  }

  function toTokens(n, unit) {
    const v = parseFloat(n);
    if (!(v >= 0)) return 0;
    const u = (unit || "").toLowerCase();
    if (u === "b") return v * 1e9;
    if (u === "m") return v * 1e6;
    if (u === "k") return v * 1e3;
    return v;
  }

  const api = {
    TOKENS_PER_WORD,
    modelWeight,
    wordCount,
    messageText,
    attachmentTokens,
    messageTokens,
    sumNewContent,
    parseNativeContext,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMWeights = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
