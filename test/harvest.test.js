/**
 * Tests for src/harvest.js — the usage-parsing heuristics.
 * Run with: node --test   (or: node test/harvest.test.js)
 */
const assert = require("node:assert");
const { test } = require("node:test");
const H = require("../src/harvest.js");

const NOW = 1_700_000_000_000; // fixed reference time (ms)
const opts = { now: NOW };

function headers(obj) {
  const m = new Map(Object.entries(obj));
  return { forEach: (cb) => m.forEach((v, k) => cb(v, k)) };
}

// ---- toEpochMs ---------------------------------------------------------
test("toEpochMs handles seconds-since-epoch", () => {
  assert.equal(H.toEpochMs(1_700_000_500, NOW), 1_700_000_500_000);
});

test("toEpochMs handles milliseconds", () => {
  assert.equal(H.toEpochMs(1_700_000_500_000, NOW), 1_700_000_500_000);
});

test("toEpochMs treats a small number as seconds-from-now (retry-after)", () => {
  assert.equal(H.toEpochMs(120, NOW), NOW + 120_000);
});

test("toEpochMs parses ISO-8601 strings", () => {
  const iso = "2023-11-14T22:14:00Z";
  assert.equal(H.toEpochMs(iso, NOW), Date.parse(iso));
});

// ---- Anthropic-style rate-limit headers --------------------------------
test("harvestHeaders reads anthropic-ratelimit-* (ISO reset)", () => {
  const resetIso = new Date(NOW + 3600_000).toISOString();
  const out = H.harvestHeaders(
    headers({
      "anthropic-ratelimit-requests-limit": "50",
      "anthropic-ratelimit-requests-remaining": "37",
      "anthropic-ratelimit-requests-reset": resetIso,
    }),
    opts
  );
  assert.equal(out.limit, 50);
  assert.equal(out.remaining, 37);
  assert.equal(out.resetAt, Date.parse(resetIso));
});

test("harvestHeaders prefers the unified bucket and earliest reset", () => {
  const tokReset = new Date(NOW + 7200_000).toISOString();
  const uniReset = new Date(NOW + 1800_000).toISOString();
  const out = H.harvestHeaders(
    headers({
      "anthropic-ratelimit-tokens-remaining": "9000",
      "anthropic-ratelimit-tokens-reset": tokReset,
      "anthropic-ratelimit-unified-limit": "45",
      "anthropic-ratelimit-unified-remaining": "12",
      "anthropic-ratelimit-unified-reset": uniReset,
    }),
    opts
  );
  assert.equal(out.limit, 45, "unified limit wins");
  assert.equal(out.remaining, 12, "unified remaining wins");
  assert.equal(out.resetAt, Date.parse(uniReset), "unified reset wins");
});

test("harvestHeaders handles retry-after as seconds", () => {
  const out = H.harvestHeaders(headers({ "Retry-After": "300" }), opts);
  assert.equal(out.resetAt, NOW + 300_000);
});

test("harvestHeaders ignores non-ratelimit headers", () => {
  const out = H.harvestHeaders(
    headers({ "content-length": "1234", "x-request-id": "abc" }),
    opts
  );
  assert.equal(H.hasData(out), false);
});

// ---- SSE bodies --------------------------------------------------------
test("parseBody extracts resets_at from a rate_limit_error SSE", () => {
  const resetsAt = Math.floor((NOW + 5400_000) / 1000);
  const sse = [
    'event: error',
    `data: {"type":"error","error":{"type":"rate_limit_error","message":"limit reached","resets_at":${resetsAt}}}`,
    "",
  ].join("\n");
  const out = H.parseBody(sse, opts);
  assert.equal(out.resetAt, resetsAt * 1000);
});

test("parseBody merges usage fields across SSE data lines", () => {
  const sse = [
    'data: {"type":"message_start"}',
    'data: {"session":{"messages_used":8,"message_limit":45}}',
    "",
  ].join("\n");
  const out = H.parseBody(sse, opts);
  assert.equal(out.used, 8);
  assert.equal(out.limit, 45);
});

// ---- False-positive guards (the important part) ------------------------
test("max_tokens is NOT treated as a session limit", () => {
  const out = H.harvest(
    { model: "claude", max_tokens: 8192, temperature: 1 },
    opts,
    {}
  );
  assert.equal(out.limit, undefined, "max_tokens must not set limit");
  assert.equal(H.hasData(out), false);
});

test("input/output token usage is NOT treated as session usage", () => {
  const out = H.harvest(
    { usage: { input_tokens: 1200, output_tokens: 350 } },
    opts,
    {}
  );
  assert.equal(out.used, undefined, "token counts must not set used");
  assert.equal(H.hasData(out), false);
});

test("array index / generic counters are ignored", () => {
  const out = H.harvest(
    { content: [{ index: 0, type: "text" }], count_tokens: 99 },
    opts,
    {}
  );
  assert.equal(H.hasData(out), false);
});

test("a realistic completion payload yields only real quota fields", () => {
  const payload = {
    type: "completion",
    model: "claude-opus",
    max_tokens: 4096,
    stop_reason: "end_turn",
    usage: { input_tokens: 500, output_tokens: 120 },
    rate_limit: { messages_used: 15, message_limit: 45, resets_at: Math.floor((NOW + 900_000) / 1000) },
  };
  const out = H.harvest(payload, opts, {});
  assert.equal(out.used, 15);
  assert.equal(out.limit, 45);
  assert.equal(out.resetAt, Math.floor((NOW + 900_000) / 1000) * 1000);
});

// ---- Real claude.ai /usage endpoint shape ------------------------------
test("parseClaudeUsage reads five_hour + seven_day utilization", () => {
  const body = {
    five_hour: { utilization: 48, resets_at: new Date(NOW + 2 * 3600_000).toISOString() },
    seven_day: { utilization: 43, resets_at: new Date(NOW + 4 * 86400_000).toISOString() },
    limits: [
      { kind: "five_hour", percent: 48, is_active: true, resets_at: new Date(NOW + 2 * 3600_000).toISOString() },
    ],
    spend: { used: { amount_minor: 0 }, limit: null, percent: 0 },
  };
  const out = H.parseClaudeUsage(body, opts);
  assert.equal(out.percent, 0.48);
  assert.equal(out.weeklyPercent, 0.43);
  assert.equal(out.resetAt, Date.parse(body.five_hour.resets_at));
  assert.equal(out.weeklyResetAt, Date.parse(body.seven_day.resets_at));
});

test("parseBody routes the usage payload through parseClaudeUsage", () => {
  const body = JSON.stringify({
    five_hour: { utilization: 90, resets_at: new Date(NOW + 600_000).toISOString() },
    // spend.limit / max fields must NOT leak in as a count-based limit
    spend: { limit: null, used: { amount_minor: 0, exponent: 2 } },
  });
  const out = H.parseBody(body, opts);
  assert.equal(out.percent, 0.9);
  assert.equal(out.limit, undefined, "no spurious count limit");
  assert.equal(out.used, undefined);
});

test("parseClaudeUsage falls back to the active limits[] entry", () => {
  const body = {
    limits: [
      { kind: "seven_day", percent: 20, is_active: false, resets_at: new Date(NOW + 86400_000).toISOString() },
      { kind: "five_hour", percent: 65, is_active: true, resets_at: new Date(NOW + 1800_000).toISOString() },
    ],
  };
  const out = H.parseClaudeUsage(body, opts);
  assert.equal(out.percent, 0.65);
  assert.equal(out.resetAt, Date.parse(body.limits[1].resets_at));
});

test("parseClaudeUsage ignores null utilization (unset windows)", () => {
  const body = { extra_usage: { utilization: null }, seven_day_opus: null };
  assert.equal(H.parseClaudeUsage(body, opts), null);
});

// ---- resetAt sanity bounds --------------------------------------------
test("a reset far in the past is rejected", () => {
  const out = H.harvest({ resets_at: Math.floor((NOW - 3600_000) / 1000) }, opts, {});
  assert.equal(out.resetAt, undefined);
});

test("a reset absurdly far in the future is rejected", () => {
  const out = H.harvest({ resets_at: Math.floor((NOW + 90 * 24 * 3600_000) / 1000) }, opts, {});
  assert.equal(out.resetAt, undefined);
});
