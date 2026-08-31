/**
 * Tests for src/masterkey.js — every case, in title form.
 * Run with: node --test test/masterkey.test.js
 *
 * pseudo.js is required FIRST so the module reads the real one off the global:
 * what counts as a case number, what counts as a distinctive fake, and what a
 * name cleaner does are its decisions, and a test that stubbed them would
 * prove nothing about the master key.
 */
const test = require("node:test");
const assert = require("node:assert");
require("../src/pseudo.js");
const M = require("../src/masterkey.js");

// A key the shape P.parseKey builds. `pairs` is the reversal (fake -> real)
// and `warn` the forward direction (real -> fake) the cleaner reads.
function key(pairs, extra) {
  return Object.assign(
    {
      name: "pseudonym_key.xlsx",
      rows: pairs.length,
      pairs: pairs.map((p) => ({ fake: p[0], real: p[1] })),
      warn: pairs.map((p) => ({ real: p[1], fake: p[0] })),
      hint: "",
      savedAt: 0,
    },
    extra || {}
  );
}

// One ordinary matter: a case number, two parties, and a witness who has no
// business in a chat title.
const CABOT = () =>
  key(
    [
      ["24STCV09876", "23STCV12345"],
      ["Doe", "Cabot"],
      ["Roe", "Reyes"],
      ["Marlowe Quenby", "Priya Raghunathan"],
    ],
    { folder: "23STCV12345 Cabot v. Reyes", savedAt: 1000 }
  );

const STRANGEWAYS = () =>
  key(
    [
      ["22SMCV01111", "21STCV54321"],
      ["Alder", "Strangeways"],
      ["Bay", "Holloway"],
    ],
    { folder: "21STCV54321 Strangeways v. Holloway", savedAt: 2000 }
  );

// ---- distilling one key ----------------------------------------------------

test("a case is filed under its real case number", () => {
  const got = M.distil(CABOT());
  assert.equal(got.caseNo, "23STCV12345");
  assert.equal(got.real, "23STCV12345 Cabot v. Reyes");
  // The fake is the same name run through the key's own forward direction —
  // what a chat started from that folder is actually called.
  assert.equal(got.fake, "24STCV09876 Doe v. Roe");
  assert.equal(got.at, 1000);
});

test("the pairs kept are the ones a caption is made of", () => {
  const got = M.distil(CABOT());
  const fakes = got.pairs.map((p) => p.fake);
  assert.ok(fakes.includes("24STCV09876"), "the case number");
  assert.ok(fakes.includes("Doe") && fakes.includes("Roe"), "the parties");
  // The witness is in the key and not in the case's name — a title carrying
  // her would be a coincidence, and carrying every case's witnesses is what
  // would turn this into a translator for messages.
  assert.ok(!fakes.includes("Marlowe Quenby"), "not the witness");
});

test("the case number leads, and a full name beats the surname inside it", () => {
  const k = key(
    [
      ["Doe", "Cabot"],
      ["24STCV09876", "23STCV12345"],
      ["Jean Doe", "Marisol Cabot"],
    ],
    { folder: "23STCV12345 Marisol Cabot v. Reyes", savedAt: 1 }
  );
  const pairs = M.distil(k).pairs;
  assert.equal(pairs[0].fake, "24STCV09876");
  assert.ok(
    pairs.findIndex((p) => p.fake === "Jean Doe") < pairs.findIndex((p) => p.fake === "Doe"),
    "the full name is kept ahead of the bare surname it contains"
  );
});

test("a key that knows no folder still files, on what is distinctive in it", () => {
  // Loaded from the popup: no case folder named it, so there is no caption to
  // measure the rows against — what is left is the number and the fakes that
  // mean something standing alone.
  const k = key(
    [
      ["24STCV09876", "23STCV12345"],
      ["Deverell", "Strangeways"],
      ["Bay", "Holloway"],
    ],
    { hint: "Strangeways", savedAt: 5 }
  );
  const got = M.distil(k);
  assert.equal(got.caseNo, "23STCV12345");
  const fakes = got.pairs.map((p) => p.fake);
  assert.ok(fakes.includes("24STCV09876"));
  assert.ok(fakes.includes("Deverell"), "long enough to mean something on its own");
  assert.ok(!fakes.includes("Bay"), "three letters, and a word other chats are called");
});

test("a key with no case number is not filed, and says why", () => {
  const k = key([["Doe", "Cabot"]], { folder: "Cabot matter", savedAt: 1 });
  assert.equal(M.distil(k), null);
  assert.match(M.reject(k), /no case number/);
  assert.equal(M.reject(CABOT()), "");
});

test("a known caption is the whole of what a case contributes", () => {
  // Sixty rows, and only the number and the two parties are in the caption.
  // The rest are witnesses and addresses: they cannot tell you which case a
  // row in Recents is, and a library's worth of them is a merged library
  // rather than a digest.
  const many = [["24STCV09876", "23STCV12345"]];
  for (let i = 0; i < 60; i++) many.push(["Fakename" + i, "Realname" + i]);
  const got = M.distil(key(many, { folder: "23STCV12345 Realname0 v. Realname1", savedAt: 1 }));
  assert.deepEqual(got.pairs.map((p) => p.fake), ["24STCV09876", "Fakename0", "Fakename1"]);
});

test("every distinctive pair is kept — the count is not capped, only what qualifies", () => {
  // No folder, so there is no caption to measure against and rank 3 is all
  // there is. Fakes are minted unique across cases now, so keeping them all
  // costs the other cases nothing — and a pair thrown away was a title that
  // would have kept its fake.
  const many = [["24STCV09876", "23STCV12345"]];
  for (let i = 0; i < 60; i++) many.push(["Fakename" + i, "Realname" + i]);
  const got = M.distil(key(many, { savedAt: 1 }));
  assert.equal(got.pairs.length, 61);
  assert.equal(got.pairs[0].fake, "24STCV09876");
});

// ---- the cases -------------------------------------------------------------

test("cases come back newest first, one per case number", () => {
  let m = { cases: [] };
  m = M.remember(m, M.distil(CABOT()));
  m = M.remember(m, M.distil(STRANGEWAYS()));
  assert.deepEqual(
    m.cases.map((c) => c.caseNo),
    ["21STCV54321", "23STCV12345"]
  );
  // The same case again moves it to the front rather than sitting beside itself.
  m = M.remember(m, M.distil(CABOT()));
  assert.equal(m.cases.length, 2);
  assert.equal(m.cases[0].caseNo, "23STCV12345");
});

test("re-seeing a case REPLACES it — a correction is not a second spelling", () => {
  let m = M.remember({ cases: [] }, M.distil(CABOT()));
  const fixed = key(
    [
      ["24STCV09876", "23STCV12345"],
      ["Doe", "Cabott"], // the party's name, spelled right this time
      ["Roe", "Reyes"],
    ],
    { folder: "23STCV12345 Cabott v. Reyes", savedAt: 9000 }
  );
  m = M.remember(m, M.distil(fixed));
  assert.equal(m.cases.length, 1);
  const reals = m.cases[0].pairs.map((p) => p.real);
  assert.ok(reals.includes("Cabott"));
  assert.ok(!reals.includes("Cabot"), "the old spelling is gone, not merged");
});

test("no case ever falls off the end — only forget() and clear() remove one", () => {
  let m = { cases: [] };
  const real = (i) => 20 + i + "STCV" + (10000 + i);
  const N = 40; // twice the old cap of 20, to prove the cap is gone
  for (let i = 0; i < N; i++) {
    m = M.remember(
      m,
      M.distil(
        key([[40 + i + "STCV" + (20000 + i), real(i)], ["Doe" + i, "Real" + i]], {
          folder: real(i) + " Real" + i + " v. Other",
          savedAt: i,
        })
      )
    );
  }
  assert.equal(m.cases.length, N);
  assert.equal(m.cases[0].caseNo, real(N - 1), "newest first");
  assert.ok(m.cases.some((c) => c.caseNo === real(0)), "the oldest is still held");
});

test("forgetting a case takes it out and leaves the rest", () => {
  let m = M.remember({ cases: [] }, M.distil(CABOT()));
  m = M.remember(m, M.distil(STRANGEWAYS()));
  m = M.forget(m, "23stcv12345"); // however it is cased
  assert.deepEqual(
    m.cases.map((c) => c.caseNo),
    ["21STCV54321"]
  );
  assert.equal(M.forget(m, "").cases.length, 1);
});

// ---- rebuilding from the library -------------------------------------------

test("the whole library folds in, newest key on top", () => {
  const got = M.rebuild({ cases: [] }, { a: CABOT(), b: STRANGEWAYS() });
  assert.equal(got.added, 2);
  assert.equal(got.skipped, 0);
  assert.deepEqual(
    got.master.cases.map((c) => c.caseNo),
    ["21STCV54321", "23STCV12345"] // savedAt 2000 beats 1000
  );
});

test("a library write that changes nothing leaves the order alone", () => {
  const lib = { a: CABOT(), b: STRANGEWAYS() };
  const first = M.rebuild({ cases: [] }, lib);
  const again = M.rebuild(first.master, lib);
  assert.equal(again.added, 0);
  assert.equal(again.refreshed, 0);
  assert.deepEqual(
    again.master.cases.map((c) => c.caseNo),
    first.master.cases.map((c) => c.caseNo)
  );
});

test("a newer key for a held case refreshes it and moves it up", () => {
  const first = M.rebuild({ cases: [] }, { a: CABOT(), b: STRANGEWAYS() });
  const newer = CABOT();
  newer.savedAt = 5000;
  const again = M.rebuild(first.master, { a: newer, b: STRANGEWAYS() });
  assert.equal(again.refreshed, 1);
  assert.equal(again.master.cases[0].caseNo, "23STCV12345");
});

test("a case whose key has left the library stays — that is the whole point", () => {
  const first = M.rebuild({ cases: [] }, { a: CABOT(), b: STRANGEWAYS() });
  const again = M.rebuild(first.master, { b: STRANGEWAYS() }); // Cabot's key forgotten
  assert.ok(again.master.cases.some((c) => c.caseNo === "23STCV12345"));
});

test("keys that cannot be filed are counted, not swallowed", () => {
  const nameless = key([["Doe", "Cabot"]], { folder: "Cabot matter", savedAt: 3 });
  const got = M.rebuild({ cases: [] }, { a: CABOT(), b: nameless });
  assert.equal(got.skipped, 1);
  assert.equal(got.master.cases.length, 1);
});

// ---- the cases, as a key ---------------------------------------------------

test("the master key is a pseudonym key, and translates a title like one", () => {
  const P = require("../src/pseudo.js");
  let m = M.remember({ cases: [] }, M.distil(CABOT()));
  m = M.remember(m, M.distil(STRANGEWAYS()));
  const k = M.asKey(m);
  assert.equal(k.master, true);
  assert.equal(k.caseCount, 2);
  const compiled = P.compile(k);
  assert.equal(
    P.translate(compiled, "24STCV09876 Doe v. Roe — MSJ").text,
    "23STCV12345 Cabot v. Reyes — MSJ"
  );
  assert.equal(
    P.translate(compiled, "22SMCV01111 Alder v. Bay hearing").text,
    "21STCV54321 Strangeways v. Holloway hearing"
  );
  // And it labels itself, so the badge can say what is doing the translating.
  assert.match(P.keyTitle(k), /master key/);
});

test("the master key knows the forward direction too", () => {
  const P = require("../src/pseudo.js");
  const m = M.remember({ cases: [] }, M.distil(CABOT()));
  const fwd = P.compileForward(M.asKey(m));
  assert.equal(P.translate(fwd, "Cabot v. Reyes").text, "Doe v. Roe");
});

test("a fake two cases disagree about is retired, never guessed at", () => {
  const one = key([["24STCV09876", "23STCV12345"], ["Doe", "Cabot"]], {
    folder: "23STCV12345 Cabot v. Reyes",
    savedAt: 1,
  });
  // A second matter whose key happened to invent the same surname for someone
  // else. Generation no longer does this, but a key minted before that
  // guarantee still can. One matcher, two answers — so this one answers
  // neither.
  const two = key([["22SMCV01111", "21STCV54321"], ["Doe", "Strangeways"]], {
    folder: "21STCV54321 Strangeways v. Holloway",
    savedAt: 2,
  });
  let m = M.remember({ cases: [] }, M.distil(one));
  m = M.remember(m, M.distil(two));
  const k = M.asKey(m);
  assert.equal(k.retired, 1);
  assert.ok(!k.pairs.some((p) => p.fake === "Doe"), "the collision is gone");
  // The case numbers are untouched — they never collide, and they are what
  // identifies the matter anyway.
  assert.ok(k.pairs.some((p) => p.fake === "24STCV09876"));
  assert.ok(k.pairs.some((p) => p.fake === "22SMCV01111"));
});

test("an empty master key is nothing rather than an empty matcher", () => {
  assert.equal(M.asKey({ cases: [] }), null);
  assert.equal(M.asKey(null), null);
  assert.match(M.describe({ cases: [] }), /empty/);
});

test("what it holds is sayable, and listable", () => {
  const m = M.remember({ cases: [] }, M.distil(CABOT()));
  assert.match(M.describe(m), /holds 1 case/);
  assert.match(M.describe(m), /none falls off/);
  const list = M.caseList(m);
  assert.equal(list.length, 1);
  assert.equal(list[0].caseNo, "23STCV12345");
  assert.equal(list[0].real, "23STCV12345 Cabot v. Reyes");
  assert.equal(list[0].fake, "24STCV09876 Doe v. Roe");
});

// ---- emptying it -----------------------------------------------------------

test("emptying it STAYS empty while the same keys sit in the library", () => {
  const lib = { a: CABOT(), b: STRANGEWAYS() };
  const filled = M.rebuild({ cases: [] }, lib).master;
  assert.equal(filled.cases.length, 2);
  const emptied = M.clear(filled, 3000); // after both keys' savedAt
  assert.equal(emptied.cases.length, 0);
  // The library is still there, and the worker folds it in on every start. An
  // empty store that refilled itself would be a button that appeared to work.
  const after = M.rebuild(emptied, lib);
  assert.equal(after.master.cases.length, 0);
  assert.equal(after.added, 0);
});

test("loading a case's key again after emptying brings that case back", () => {
  const emptied = M.clear({ cases: [] }, 3000);
  const reloaded = CABOT();
  reloaded.savedAt = 4000; // loaded again, after the emptying
  const after = M.rebuild(emptied, { a: reloaded, b: STRANGEWAYS() });
  assert.deepEqual(
    after.master.cases.map((c) => c.caseNo),
    ["23STCV12345"] // Strangeways was loaded before the emptying and stays out
  );
});

test("a key stored before savedAt existed is still filed", () => {
  // `at` of 0, and a store that has never been emptied. Testing `at <= 0`
  // against a clearedAt of 0 would have filed none of them, ever.
  const old = CABOT();
  delete old.savedAt;
  const got = M.rebuild({ cases: [] }, { a: old });
  assert.equal(got.added, 1);
  assert.equal(got.master.cases[0].caseNo, "23STCV12345");
});

test("a key with no forward direction does not file the real name as the fake", () => {
  const k = CABOT();
  delete k.warn; // nothing to pseudonymize the case's own name with
  assert.equal(M.distil(k).fake, "");
  assert.equal(M.distil(k).real, "23STCV12345 Cabot v. Reyes");
});
