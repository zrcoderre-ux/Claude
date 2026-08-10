const test = require("node:test");
const assert = require("node:assert");
const S = require("../src/stamp.js");

const AT = "2026-08-10T14:14:00.000Z";
const ms = (iso) => Date.parse(iso);

test("a message's time is read, never guessed", () => {
  assert.equal(S.atOf({ created_at: AT }), ms(AT));
  assert.equal(S.atOf({ createdAt: AT }), ms(AT));
  assert.equal(S.atOf({ created_at: 1770000000000 }), 1770000000000);
  // Unparseable is null rather than "now": a wrong time printed under a message
  // is worse than no time at all.
  assert.equal(S.atOf({ created_at: "whenever" }), null);
  assert.equal(S.atOf({}), null);
  assert.equal(S.atOf(null), null);
});

test("the gap says how long the turn took, at the scale it took it", () => {
  assert.equal(S.gapText(12_000), "12s later");
  assert.equal(S.gapText(17 * 60_000), "17m later");
  assert.equal(S.gapText(60 * 60_000), "1h later");
  assert.equal(S.gapText(72 * 60_000), "1h 12m later");
  // Nothing below a second is worth printing, and a negative gap is a clock
  // that can't be trusted rather than a turn that arrived early.
  assert.equal(S.gapText(400), "");
  assert.equal(S.gapText(-5000), "");
  assert.equal(S.gapText(null), "");
});

test("a conversation becomes one stamp per turn, in order", () => {
  const conv = {
    chat_messages: [
      { sender: "human", created_at: "2026-08-10T14:14:00Z", content: [{ type: "text", text: "Draft the ruling" }] },
      {
        sender: "assistant",
        created_at: "2026-08-10T14:31:00Z",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "The ruling" },
        ],
      },
      { sender: "human", created_at: "2026-08-11T09:02:00Z", content: [{ type: "text", text: "Revise it" }] },
    ],
  };
  const list = S.stampList(conv);
  assert.deepEqual(list.map((s) => s.sender), ["human", "assistant", "human"]);
  assert.equal(list[0].first, true);
  assert.equal(list[0].gap, "", "nothing came before the first turn");
  assert.equal(list[1].gap, "17m later");
  // Picked up the next morning: said once, on the turn that crossed the day.
  assert.equal(list[2].newDay, true);
  assert.equal(list[1].newDay, false);
  // The key is built from what the page renders — text blocks, not thinking.
  assert.equal(list[1].key, S.entryKey("The ruling"));
  assert.deepEqual(S.stampList(null), []);
});

test("a turn with no time of its own can't say how long it took", () => {
  const list = S.stampList({
    chat_messages: [
      { sender: "human", created_at: "2026-08-10T14:14:00Z", content: [{ type: "text", text: "one" }] },
      { sender: "assistant", content: [{ type: "text", text: "two" }] },
      { sender: "human", created_at: "2026-08-10T14:20:00Z", content: [{ type: "text", text: "three" }] },
    ],
  });
  assert.equal(list[1].at, null);
  assert.equal(list[1].gap, "");
  // …and the turn after it is measured from the last time that was real, not
  // from nothing.
  assert.equal(list[2].gap, "6m later");
});
