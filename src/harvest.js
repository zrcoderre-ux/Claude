/**
 * Claude Usage Meter — pure usage-harvesting logic.
 *
 * This file is deliberately free of DOM / chrome APIs so it can be:
 *   - loaded first in the MAIN world (before inject.js) and used via
 *     `globalThis.CUMHarvest`, and
 *   - required directly from Node in the test suite.
 *
 * The heuristics are intentionally broad — Claude.ai exposes no documented
 * usage API — but tuned to avoid the obvious false positives (e.g. treating a
 * request's `max_tokens` as the session limit).
 */
(function (root) {
  "use strict";

  // A reset timestamp: header names like `*-reset`, JSON `resets_at`, etc.
  const RESET_KEYS =
    /(^|[_-])(reset|resets_at|resetsat|reset_at|resets|expires|expires_at|retry.?after)([_-]|$)/i;

  // A quota/limit. NOTE: must NOT match `max_tokens`, `max_length`, etc. — only
  // limit-shaped names and explicit *_limit fields.
  const LIMIT_KEYS =
    /(^|[_-])(limit|quota|allowance|cap)([_-]|$)|(rate.?limit|message.?limit|usage.?limit|session.?limit)/i;

  // How much is left.
  const REMAIN_KEYS =
    /(^|[_-])(remaining|remainder|left|available|avail)([_-]|$)/i;

  // How much is used. Avoid bare `count` (matches unrelated counters) and token
  // fields (input_tokens / output_tokens are not session usage).
  const USED_KEYS =
    /(^|[_-])(used|consumed|usage_count|messages?_used|utilization)([_-]|$)/i;

  // Keys whose values must never be interpreted as a numeric quota, even if the
  // name would otherwise match (guards against model params leaking in).
  const DENY_KEYS = /(token|temperature|top_[pk]|index|width|height|timeout_)/i;

  function isPlainNumberLike(v) {
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v === "string" && v.trim() !== "") return !Number.isNaN(Number(v));
    return false;
  }

  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  // Convert seconds / ms / ISO-8601 / HTTP-date into epoch-ms.
  function toEpochMs(value, now) {
    now = now || Date.now();
    if (value == null) return null;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      if (value > 1e18) return null; // nanoseconds — out of range
      if (value > 1e15) return Math.round(value / 1000); // microseconds → ms
      if (value > 1e12) return value; // already ms
      if (value > 1e9) return value * 1000; // seconds since epoch → ms
      if (value >= 0) return now + value * 1000; // small: seconds-from-now
      return null;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") return null;
      const num = Number(trimmed);
      if (!Number.isNaN(num)) return toEpochMs(num, now);
      const parsed = Date.parse(trimmed); // ISO-8601 or HTTP-date
      if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
  }

  // Recursively collect usage-shaped values from an arbitrary object.
  function harvest(obj, opts, out, depth) {
    opts = opts || {};
    out = out || {};
    depth = depth || 0;
    const now = opts.now || Date.now();
    if (obj == null || depth > 8 || typeof obj !== "object") return out;

    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val != null && typeof val === "object") {
        harvest(val, opts, out, depth + 1);
        continue;
      }
      if (DENY_KEYS.test(key)) continue;

      if (RESET_KEYS.test(key)) {
        const ms = toEpochMs(val, now);
        // Only accept a plausible near-future reset (allow small clock skew).
        if (ms && ms > now - 60000 && ms < now + 40 * 24 * 3600 * 1000) {
          if (out.resetAt == null || ms < out.resetAt) out.resetAt = ms;
        }
      } else if (REMAIN_KEYS.test(key) && isPlainNumberLike(val)) {
        out.remaining = Number(val);
      } else if (USED_KEYS.test(key) && isPlainNumberLike(val)) {
        out.used = Number(val);
      } else if (LIMIT_KEYS.test(key) && isPlainNumberLike(val)) {
        const n = Number(val);
        if (n > 0) out.limit = n;
      }
    }
    return out;
  }

  // Harvest from HTTP response headers. `iter` calls back (value, name).
  function harvestHeaders(iterable, opts) {
    opts = opts || {};
    const now = opts.now || Date.now();
    const out = {};
    let unifiedReset = null;
    const resetCandidates = [];

    const forEach =
      iterable && typeof iterable.forEach === "function"
        ? iterable.forEach.bind(iterable)
        : null;
    if (!forEach) return out;

    forEach((value, name) => {
      const lower = String(name).toLowerCase();
      const isRl = lower.includes("ratelimit") || lower.includes("rate-limit");
      if (!isRl && lower !== "retry-after") return;

      if (lower.includes("reset") || lower === "retry-after") {
        const ms = toEpochMs(value, now);
        if (ms && ms > now - 60000) {
          if (lower.includes("unified")) unifiedReset = ms;
          resetCandidates.push(ms);
        }
      } else if (lower.includes("remaining")) {
        const n = Number(value);
        if (!Number.isNaN(n)) {
          // Prefer the unified/overall bucket; otherwise keep the smallest.
          if (lower.includes("unified") || out.remaining == null)
            out.remaining = n;
          else out.remaining = Math.min(out.remaining, n);
        }
      } else if (lower.includes("limit")) {
        const n = Number(value);
        if (!Number.isNaN(n) && n > 0) {
          if (lower.includes("unified") || out.limit == null) out.limit = n;
        }
      }
    });

    if (unifiedReset != null) out.resetAt = unifiedReset;
    else if (resetCandidates.length) out.resetAt = Math.min(...resetCandidates);
    return out;
  }

  // Parse the claude.ai Settings → Usage response:
  //   GET /api/organizations/{uuid}/usage
  // Shape: { five_hour:{utilization,resets_at}, seven_day:{utilization,resets_at},
  //          limits:[{kind,percent,resets_at,is_active,...}], spend:{...} }
  // `utilization`/`percent` are 0–100. We surface the 5-hour window as the
  // "session" and the 7-day window as "weekly".
  function parseClaudeUsage(obj, opts) {
    if (!obj || typeof obj !== "object") return null;
    const now = (opts && opts.now) || Date.now();
    const out = {};

    function windowOf(w) {
      if (!w || typeof w !== "object" || typeof w.utilization !== "number")
        return null;
      const r = toEpochMs(w.resets_at, now);
      return { percent: clamp01(w.utilization / 100), resetAt: r || null };
    }

    const fh = windowOf(obj.five_hour);
    if (fh) {
      out.percent = fh.percent;
      if (fh.resetAt) out.resetAt = fh.resetAt;
    }
    const sd = windowOf(obj.seven_day);
    if (sd) {
      out.weeklyPercent = sd.percent;
      if (sd.resetAt) out.weeklyResetAt = sd.resetAt;
    }

    // Fallback to the active entry in limits[] if the named windows are absent.
    if (out.percent == null && Array.isArray(obj.limits)) {
      const active =
        obj.limits.find((l) => l && l.is_active && typeof l.percent === "number") ||
        obj.limits.find((l) => l && typeof l.percent === "number");
      if (active) {
        out.percent = clamp01(active.percent / 100);
        const r = toEpochMs(active.resets_at, now);
        if (r) out.resetAt = r;
      }
    }

    return out.percent != null || out.weeklyPercent != null ? out : null;
  }

  // Parse the extra-usage / overage spend cap:
  //   GET /api/organizations/{uuid}/overage_spend_limit
  // Shape: { is_enabled, monthly_credit_limit, used_credits, currency, ... }
  // Credit amounts are minor units (cents), so 3000 => $30.00.
  function parseOverage(obj) {
    if (!obj || typeof obj !== "object") return null;
    const hasShape =
      "monthly_credit_limit" in obj &&
      ("used_credits" in obj || "is_enabled" in obj);
    if (!hasShape) return null;
    const limit =
      typeof obj.monthly_credit_limit === "number"
        ? obj.monthly_credit_limit
        : null;
    const used =
      typeof obj.used_credits === "number"
        ? obj.used_credits
        : obj.used_credits == null
        ? 0
        : null;
    if (limit == null && used == null) return null;
    return {
      overage: {
        usedMinor: used,
        limitMinor: limit,
        enabled: !!obj.is_enabled,
        currency: typeof obj.currency === "string" ? obj.currency : "usd",
      },
    };
  }

  // Context-window usage from a message/completion payload. The prompt size
  // (input_tokens + cached input) is the context consumed on the latest turn.
  function contextWindowFor(model) {
    if (!model) return 200000;
    if (/1m|\[1m\]/i.test(model)) return 1000000; // 1M-context beta variants
    return 200000; // current Claude models
  }

  function harvestContext(obj, ctx, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== "object" || depth > 6) return ctx;
    if (typeof obj.model === "string" && /claude|opus|sonnet|haiku|fable/i.test(obj.model))
      ctx.model = obj.model;
    const u = obj.usage;
    if (u && typeof u === "object") {
      const inp =
        (Number(u.input_tokens) || 0) +
        (Number(u.cache_read_input_tokens) || 0) +
        (Number(u.cache_creation_input_tokens) || 0);
      if (inp > 0) ctx.tokens = Math.max(ctx.tokens || 0, inp);
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === "object") harvestContext(v, ctx, depth + 1);
    }
    return ctx;
  }

  function finalizeContext(ctx) {
    if (!ctx || ctx.tokens == null) return null;
    return { tokens: ctx.tokens, model: ctx.model || null, window: contextWindowFor(ctx.model) };
  }

  // Parse a response body that may be JSON or Server-Sent Events.
  function parseBody(text, opts) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim();
    if (trimmed === "") return null;

    // Try whole-body JSON first.
    if (trimmed[0] === "{" || trimmed[0] === "[") {
      try {
        const obj = JSON.parse(trimmed);
        // Prefer the structured Usage / overage endpoints; a given response is
        // one or the other. Fall back to the generic scanner for anything else.
        const usage = parseClaudeUsage(obj, opts);
        const overage = parseOverage(obj);
        if (usage || overage) return Object.assign({}, usage, overage);
        const generic = harvest(obj, opts, {});
        const context = finalizeContext(harvestContext(obj, {}));
        if (context) generic.context = context;
        return generic;
      } catch (e) {
        /* fall through to SSE */
      }
    }

    // Server-sent events: merge every `data: {...}` line.
    const out = {};
    const ctx = {};
    let found = false;
    const lines = trimmed.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^data:\s*(\{.*\})\s*$/);
      if (!m) continue;
      try {
        const obj = JSON.parse(m[1]);
        harvest(obj, opts, out);
        harvestContext(obj, ctx);
        found = true;
      } catch (e) {
        /* skip malformed line */
      }
    }
    const context = finalizeContext(ctx);
    if (context) out.context = context;
    return found && (hasData(out) || context) ? out : null;
  }

  function hasData(d) {
    return (
      !!d &&
      (d.resetAt != null ||
        d.remaining != null ||
        d.limit != null ||
        d.used != null ||
        d.percent != null ||
        d.weeklyPercent != null ||
        d.overage != null ||
        d.context != null)
    );
  }

  const api = {
    toEpochMs,
    harvest,
    harvestHeaders,
    parseClaudeUsage,
    parseOverage,
    parseBody,
    hasData,
    _patterns: { RESET_KEYS, LIMIT_KEYS, REMAIN_KEYS, USED_KEYS, DENY_KEYS },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMHarvest = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
