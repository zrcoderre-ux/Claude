"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const W = require("../src/weights.js");

test("wordCount counts whitespace-separated words", () => {
  assert.equal(W.wordCount("hello there general kenobi"), 4);
  assert.equal(W.wordCount("  spaced   out  "), 2);
  assert.equal(W.wordCount(""), 0);
  assert.equal(W.wordCount(null), 0);
});

test("modelWeight ranks models and defaults premium", () => {
  assert.equal(W.modelWeight("claude-opus-4-8"), 1);
  assert.ok(W.modelWeight("claude-sonnet-5") < 1);
  assert.ok(W.modelWeight("claude-haiku-4-5") < W.modelWeight("claude-sonnet-5"));
  assert.equal(W.modelWeight(null), 1); // unknown → assume premium
  assert.equal(W.modelWeight("something-else"), 1);
});

test("messageText takes the longer of text vs content, not the sum", () => {
  const msg = { text: "a much longer top level string here", content: [{ text: "short" }] };
  assert.equal(W.messageText(msg), "a much longer top level string here");
  const assistant = { text: "", content: [{ text: "the assistant reply lives in content" }] };
  assert.equal(W.messageText(assistant), "the assistant reply lives in content");
});

test("attachmentTokens uses extracted text, byte size, or a flat estimate", () => {
  const extracted = { attachments: [{ extracted_content: "x".repeat(400) }] };
  assert.equal(W.attachmentTokens(extracted), 100); // 400 chars / 4

  const sized = { files: [{ file_size: 4000 }] };
  assert.equal(W.attachmentTokens(sized), 1000); // 4000 bytes / 4

  const unknown = { attachments: [{ file_name: "mystery.bin" }] };
  assert.equal(W.attachmentTokens(unknown), 1000); // flat fallback

  assert.equal(W.attachmentTokens({}), 0);
});

test("messageTokens combines words and attachments", () => {
  const msg = { text: "one two three four", files: [{ file_size: 4000 }] };
  // 4 words * 1.33 + 1000 attachment tokens
  assert.equal(Math.round(W.messageTokens(msg)), Math.round(4 * 1.33 + 1000));
});

test("sumNewContent only counts messages created at/after the boundary, weighted by model", () => {
  const t0 = Date.parse("2026-07-20T00:00:00Z");
  const boundary = Date.parse("2026-07-22T00:00:00Z");
  const after = "2026-07-22T12:00:00Z";
  const messages = [
    { text: "old message ignored because it predates the gap", created_at: "2026-07-20T00:00:00Z" },
    { text: "fresh words one two three", created_at: after },
  ];
  const opus = W.sumNewContent(messages, boundary, "claude-opus-4-8");
  const sonnet = W.sumNewContent(messages, boundary, "claude-sonnet-5");
  // Only the fresh message counts (5 words), and Opus weighs more than Sonnet.
  assert.ok(opus > 0);
  assert.ok(sonnet < opus);
  assert.ok(sonnet > 0);
  void t0;
});

test("sumNewContent with null boundary counts every message", () => {
  const messages = [
    { text: "a b c", created_at: "2026-07-20T00:00:00Z" },
    { text: "d e f", created_at: "2026-07-22T00:00:00Z" },
  ];
  const all = W.sumNewContent(messages, null, "claude-opus-4-8");
  assert.ok(all >= 6 * 1.33 * 0.99);
});

test("sumNewContent tolerates junk input", () => {
  assert.equal(W.sumNewContent(null, 0, "opus"), 0);
  assert.equal(W.sumNewContent([], 0, "opus"), 0);
});
