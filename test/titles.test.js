"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const T = require("../src/titles.js");

test("a name nothing has is given as it is", () => {
  assert.equal(T.nextName("Smith v. Jones", []), "Smith v. Jones");
  assert.equal(T.nextName("Smith v. Jones", ["Other matter", "Smith v. Jones: Drafting (A)"]), "Smith v. Jones");
});

test("a name an earlier conversation has gets 2, then 3", () => {
  assert.equal(T.nextName("Smith v. Jones", ["Smith v. Jones"]), "Smith v. Jones 2");
  assert.equal(T.nextName("Smith v. Jones", ["Smith v. Jones", "Smith v. Jones 2"]), "Smith v. Jones 3");
});

test("the smallest number free, starting at 2", () => {
  assert.equal(T.nextName("X", ["X", "X 3"]), "X 2");
  assert.equal(T.nextName("X", ["X", "X 2", "X 4"]), "X 3");
});

test("only the name itself starts the numbering — a numbered one alone doesn't", () => {
  assert.equal(T.nextName("X", ["X 2"]), "X");
});

test("case, spacing and punctuation don't make a different name", () => {
  assert.equal(T.nextName("Smith v. Jones", ["smith v jones"]), "Smith v. Jones 2");
  assert.equal(T.nextName("MSJ: Drafting (A)", ["MSJ:  Drafting (A)", "msj drafting a 2"]), "MSJ: Drafting (A) 3");
});

test("a name that ends in a number is its own series", () => {
  assert.equal(T.nextName("Case 2024", ["Case 2024"]), "Case 2024 2");
  assert.equal(T.nextName("Case", ["Case", "Case 2024"]), "Case 2");
  assert.equal(T.nextName("Case 2024", ["Case 2025"]), "Case 2024");
});

test("names in other scripts compare by their letters too", () => {
  assert.equal(T.nextName("Дело Иванова", ["дело иванова"]), "Дело Иванова 2");
  assert.equal(T.nextName("Дело Иванова", ["Дело Петрова"]), "Дело Иванова");
});

test("the number stays whole; the name is what gets shortened", () => {
  const base = "a".repeat(100);
  const out = T.nextName(base, [base], 100);
  assert.equal(out.length, 100);
  assert.ok(out.endsWith(" 2"));
});

test("an empty name stays empty", () => {
  assert.equal(T.nextName("", ["anything"]), "");
  assert.equal(T.nextName("   ", []), "");
});

test("parseList reads a page of chat_conversations_v2, bare or wrapped", () => {
  const bare = T.parseList([{ uuid: "a", name: "One" }, { uuid: "b", name: "" }, null]);
  assert.deepEqual(bare, { items: [{ id: "a", name: "One" }, { id: "b", name: "" }], hasMore: false });
  const wrapped = T.parseList({ data: [{ uuid: "c", name: "Two" }], has_more: true });
  assert.deepEqual(wrapped, { items: [{ id: "c", name: "Two" }], hasMore: true });
  assert.equal(T.parseList({ five_hour: {} }), null);
  assert.equal(T.parseList(null), null);
});

test("a conversation asked for the same name again gets the same answer", () => {
  let led = T.remember(T.EMPTY, { id: "c1", base: "X", title: "X 2", at: 1 });
  assert.equal(T.recall(led, "c1", "X"), "X 2");
  assert.equal(T.recall(led, "c1", "Y"), "", "a different name asked for is a new question");
  assert.equal(T.recall(led, "c2", "X"), "");
  led = T.remember(led, { id: "c1", base: "X", title: "X 3", at: 2 });
  assert.equal(led.names.length, 1);
  assert.equal(T.recall(led, "c1", "X"), "X 3");
});

test("the record of names given is bounded", () => {
  let led = T.EMPTY;
  for (let i = 0; i < T.MAX_REMEMBERED + 10; i++) led = T.remember(led, { id: "c" + i, base: "X", title: "X", at: i });
  assert.equal(led.names.length, T.MAX_REMEMBERED);
  assert.equal(led.names[0].id, "c10");
});

test("taken: live chat names plus the Cowork names given, never the conversation itself", () => {
  const led = {
    names: [
      { id: "cse_1", base: "X", title: "X", at: 1 },
      { id: "11111111-1111-4111-8111-111111111111", base: "Y", title: "Y", at: 2 },
    ],
  };
  const live = { ok: true, items: [{ id: "self", name: "X 2" }, { id: "other", name: "Z" }] };
  assert.deepEqual(T.takenFor(led, live, "self").sort(), ["X", "Z"]);
  // The live list is the authority for chats: a chat the extension named "Y"
  // that has since been renamed or deleted is not in it, so "Y" is free.
  assert.ok(T.takenFor(led, live, "self").indexOf("Y") === -1);
  // ...and the Cowork session being named doesn't count against itself.
  assert.deepEqual(T.takenFor(led, live, "cse_1").sort(), ["X 2", "Z"]);
});

test("taken: with no live list, every name the extension gave stands in", () => {
  const led = {
    names: [
      { id: "cse_1", base: "X", title: "X", at: 1 },
      { id: "11111111-1111-4111-8111-111111111111", base: "Y", title: "Y", at: 2 },
    ],
  };
  assert.deepEqual(T.takenFor(led, { ok: false, error: "HTTP 500" }, "self").sort(), ["X", "Y"]);
  assert.deepEqual(T.takenFor(led, null, "self").sort(), ["X", "Y"]);
});

test("the whole decision: a second upload of the same folder is numbered", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const live = { ok: true, items: [{ id: first, name: "Smith v. Jones" }, { id: second, name: "Untitled" }] };
  let led = T.EMPTY;
  const title = T.nextName("Smith v. Jones", T.takenFor(led, live, second));
  assert.equal(title, "Smith v. Jones 2");
  led = T.remember(led, { id: second, base: "Smith v. Jones", title, at: 1 });
  // The keep-naming pass, once the rename has landed: the same answer, not 3.
  const after = { ok: true, items: [{ id: first, name: "Smith v. Jones" }, { id: second, name: "Smith v. Jones 2" }] };
  assert.equal(T.recall(led, second, "Smith v. Jones") || T.nextName("Smith v. Jones", T.takenFor(led, after, second)), "Smith v. Jones 2");
});

test("a partial check is remembered with the name, for the pass that reports", () => {
  const led = T.remember(T.EMPTY, { id: "c1", base: "X", title: "X 2", note: "checked partly", at: 1 });
  assert.equal(T.entryFor(led, "c1", "X").note, "checked partly");
  assert.equal(T.entryFor(led, "c1", "Y"), null);
  assert.equal(T.entryFor(led, "", "X"), null);
});
