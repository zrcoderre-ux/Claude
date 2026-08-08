const test = require("node:test");
const assert = require("node:assert");
const G = require("../src/incognito.js");

const NOW = 1770000000000;
const DAY = 24 * 60 * 60 * 1000;

test("only a chat claude.ai isn't keeping is recorded", () => {
  assert.equal(G.looksIncognitoUrl("https://claude.ai/new?temporary=true"), true);
  assert.equal(G.looksIncognitoUrl("https://claude.ai/chat/abc?incognito=1"), true);
  assert.equal(G.looksIncognitoUrl("https://claude.ai/incognito/abc"), true);
  assert.equal(G.looksIncognitoUrl("https://claude.ai/new#temporary"), true);
  // An ordinary chat is already saved by claude.ai; copying it here would only
  // duplicate what it holds.
  assert.equal(G.looksIncognitoUrl("https://claude.ai/chat/abc"), false);
  assert.equal(G.looksIncognitoUrl("https://claude.ai/new"), false);
  // And the word appearing in a conversation's id is not a mode.
  assert.equal(G.looksIncognitoUrl("https://claude.ai/chat/temporary-ruling-notes"), false);
  assert.equal(G.looksIncognitoUrl(""), false);
  assert.equal(G.looksIncognitoUrl(null), false);
});

test("a turn seen again while it was still being written replaces itself", () => {
  // The watcher polls, so a reply is caught part-written and then whole. That's
  // one turn, not two — and the whole one is the one to keep.
  let rec = G.newRecord("c1", NOW, { url: "https://claude.ai/new?temporary=true" });
  rec = G.addTurn(rec, { role: "human", text: "Draft the ruling" }, NOW);
  rec = G.addTurn(rec, { role: "assistant", text: "The ruling so" }, NOW + 1000);
  rec = G.addTurn(rec, { role: "assistant", text: "The ruling so far, in full." }, NOW + 2000);
  assert.equal(rec.turns.length, 2);
  assert.equal(rec.turns[1].text, "The ruling so far, in full.");

  // The identical text again changes nothing but the timestamp.
  rec = G.addTurn(rec, { role: "assistant", text: "The ruling so far, in full." }, NOW + 3000);
  assert.equal(rec.turns.length, 2);

  // A genuinely new turn by the same speaker is its own turn.
  rec = G.addTurn(rec, { role: "assistant", text: "A separate point." }, NOW + 4000);
  assert.equal(rec.turns.length, 3);
  // Empty text is not a turn.
  assert.equal(G.addTurn(rec, { role: "human", text: "   " }, NOW).turns.length, 3);
});

test("a record that outgrows its cap drops the oldest, and says it did", () => {
  let rec = G.newRecord("c1", NOW);
  const big = "x".repeat(600 * 1024);
  for (let i = 0; i < 6; i++)
    rec = G.addTurn(rec, { role: i % 2 ? "assistant" : "human", text: big + i }, NOW + i);
  assert.ok(rec.chars <= G.MAX_CHARS, rec.chars);
  assert.ok(rec.dropped > 0, "and it doesn't pretend to be complete");
  // The newest survives: recovery is mostly about the work just done.
  assert.ok(rec.turns[rec.turns.length - 1].text.endsWith("5"));
  // Which the saved file states rather than leaving to be noticed.
  const md = G.asConversation(rec);
  assert.match(md.chat_messages[0].content[0].text, /dropped/);
});

test("records are kept for a few days and then are not", () => {
  const fresh = { id: "a", updatedAt: NOW - 1000 };
  const old = { id: "b", updatedAt: NOW - 4 * DAY };
  assert.equal(G.isExpired(fresh, NOW), false);
  assert.equal(G.isExpired(old, NOW), true);
  // A record with no timestamp is stale, not immortal — the failure mode of
  // "keep it if unsure" is a permanent copy of a chat you asked not to keep.
  assert.equal(G.isExpired({ id: "c" }, NOW), true);
  assert.equal(G.isExpired(null, NOW), true);

  assert.deepEqual(G.expired([fresh, old], NOW).map((r) => r.id), ["b"]);
  assert.deepEqual(G.live([fresh, old], NOW).map((r) => r.id), ["a"]);
  // Newest first, which is the one you're looking for.
  const mid = { id: "d", updatedAt: NOW - 2000 };
  assert.deepEqual(G.live([mid, fresh], NOW).map((r) => r.id), ["a", "d"]);
});

test("a record saves like any other conversation", () => {
  let rec = G.newRecord("c1", NOW);
  rec = G.addTurn(rec, { role: "human", text: "First question" }, NOW);
  rec = G.addTurn(rec, { role: "assistant", text: "First answer" }, NOW + 1);
  const conv = G.asConversation(rec);
  assert.equal(conv.name, "First question", "titled from how it opened");
  assert.deepEqual(conv.chat_messages.map((m) => m.sender), ["human", "assistant"]);
  assert.equal(conv.chat_messages[1].content[0].text, "First answer");

  const s = G.summarize(rec);
  assert.equal(s.turns, 2);
  assert.equal(s.replies, 1);
  assert.equal(s.chars, "First question".length + "First answer".length);
  assert.deepEqual(G.summarize(null), { turns: 0, replies: 0, chars: 0, dropped: 0 });
  assert.equal(G.asConversation(null).name, "Incognito chat");
});
