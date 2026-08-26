/**
 * Tests for src/folderup.js — a case folder taken into a new conversation.
 * Run with: node --test test/folderup.test.js
 *
 * workflow.js and pseudo.js are required FIRST so the module reads the real
 * ones off the global rather than a fake: what counts as a text file and what
 * a pseudonym key does with a name are their decisions, and a test that
 * stubbed them would prove nothing about the button.
 */
const test = require("node:test");
const assert = require("node:assert");
require("../src/workflow.js");
require("../src/pseudo.js");
const P = require("../src/pseudo.js");
const F = require("../src/folderup.js");

// A key the shape P.parseKey builds: `warn` carries the forward direction
// (real → fake, which is what a title goes through) and `pairs` the reverse.
function key(rows, extra) {
  return Object.assign(
    {
      name: "pseudonym_key.xlsx",
      rows: rows.length,
      warn: rows.map(([real, fake]) => ({ real: real, fake: fake })),
      pairs: rows.map(([real, fake]) => ({ fake: fake, real: real })),
      hint: rows.length ? rows[0][0] : "",
      dropped: {},
    },
    extra || {}
  );
}

const SMITH = key([
  ["23STCV12345", "24STCV99999"],
  ["Smith", "Marchetti"],
  ["Jones", "Okonkwo"],
]);

function doc(name, type) {
  return { file: { name: name, type: type || "" }, path: "case/Text Files/" + name };
}

// ---- where the button belongs ---------------------------------------------

test("the button belongs on a conversation that does not exist yet", () => {
  assert.equal(F.isNewChatPath("https://claude.ai/new"), true);
  assert.equal(F.isNewChatPath("https://claude.ai/"), true);
  assert.equal(F.isNewChatPath("https://claude.ai"), true);
  // A project's own composer starts a new chat inside that project.
  assert.equal(
    F.isNewChatPath("https://claude.ai/project/019f3fcd-9b35-7715-b2cc-b227512b5459"),
    true
  );
});

test("Cowork composes at its own addresses, and they count too", () => {
  // Toggling the surface leaves /new as /new, so that one is already covered.
  assert.equal(F.isNewChatPath("https://claude.ai/cowork"), true);
  assert.equal(
    F.isNewChatPath("https://claude.ai/cowork/project/019f3fcd-9b35-7715-b2cc-b227512b5459"),
    true
  );
  // A session is a conversation, not a composer.
  assert.equal(F.isNewChatPath("https://claude.ai/cowork/cse_011f5HCzaWWJ2hm19"), false);
});

test("and never on work that already exists, or where there is no path at all", () => {
  assert.equal(
    F.isNewChatPath("https://claude.ai/chat/019f3fcd-9b35-7715-b2cc-b227512b5459"),
    false
  );
  // Claude Code has neither an upload path here nor a rename one.
  assert.equal(F.isNewChatPath("https://claude.ai/code/session_01SXUhPi4YPzLy3o9"), false);
  // The projects LIST is not a composer, and neither is anything else here.
  assert.equal(F.isNewChatPath("https://claude.ai/projects"), false);
  assert.equal(F.isNewChatPath("https://claude.ai/recents"), false);
  assert.equal(F.isNewChatPath("https://claude.ai/settings/profile"), false);
});

test("the surface a pick goes out on: the address first, then the toggle", () => {
  // A Cowork address settles it whatever the toggle happens to read.
  assert.equal(F.pickSurface("https://claude.ai/cowork", "chat"), "cowork");
  assert.equal(
    F.pickSurface("https://claude.ai/cowork/project/019f3fcd-9b35-7715-b2cc-b227512b5459", ""),
    "cowork"
  );
  // On /new the toggle is the answer — the address never changes there.
  assert.equal(F.pickSurface("https://claude.ai/new", "chat"), "chat");
  assert.equal(F.pickSurface("https://claude.ai/new", "cowork"), "cowork");
  // Nothing to read: Cowork, because its confirmation covers both surfaces and
  // Chat's silence on Cowork would call a good upload a failure.
  assert.equal(F.pickSurface("https://claude.ai/new", ""), "cowork");
  assert.equal(F.pickSurface("https://claude.ai/", null), "cowork");
});

test("the conversation a send created is read off the address, with its surface", () => {
  assert.deepEqual(F.startedConversation("https://claude.ai/chat/019f3fcd-9b35-7715-b2cc-b227512b5459"), {
    id: "019f3fcd-9b35-7715-b2cc-b227512b5459",
    surface: "chat",
  });
  // A session's id is not a uuid, which is why it needs its own arm.
  assert.deepEqual(F.startedConversation("https://claude.ai/cowork/cse_011f5HCzaWWJ2hm19"), {
    id: "cse_011f5HCzaWWJ2hm19",
    surface: "cowork",
  });
  assert.deepEqual(F.startedConversation("https://claude.ai/new"), { id: "", surface: "" });
  // A project's uuid is not a conversation's — the wider pattern would take it.
  assert.deepEqual(
    F.startedConversation("https://claude.ai/cowork/project/019f3fcd-9b35-7715-b2cc-b227512b5459"),
    { id: "", surface: "" }
  );
});

// ---- what goes up ----------------------------------------------------------

test("two or more text files become one combined upload", () => {
  const plan = F.uploadPlan([doc("a.txt", "text/plain"), doc("b.md"), doc("c.txt")]);
  assert.equal(plan.bundle.length, 3);
  assert.equal(plan.singles.length, 0);
});

test("one text file is already one upload — there is nothing to combine it with", () => {
  const plan = F.uploadPlan([doc("only.txt", "text/plain")]);
  assert.equal(plan.bundle.length, 0);
  assert.equal(plan.singles.length, 1);
});

test("what isn't text goes up as itself — concatenating a PDF delivers mojibake", () => {
  const plan = F.uploadPlan([
    doc("brief.txt", "text/plain"),
    doc("exhibit.pdf", "application/pdf"),
    doc("decl.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    doc("notes.md"),
  ]);
  assert.deepEqual(plan.bundle.map((d) => d.file.name), ["brief.txt", "notes.md"]);
  assert.deepEqual(plan.singles.map((d) => d.file.name), ["exhibit.pdf", "decl.docx"]);
});

test("a spreadsheet never rides the upload — the pseudonym key is one", () => {
  const plan = F.uploadPlan([
    doc("pseudonym_key.xlsx"),
    doc("costs.xls"),
    doc("a.txt", "text/plain"),
    doc("b.txt", "text/plain"),
  ]);
  assert.deepEqual(plan.barred.map((d) => d.file.name), ["pseudonym_key.xlsx", "costs.xls"]);
  assert.deepEqual(plan.bundle.map((d) => d.file.name), ["a.txt", "b.txt"]);
  assert.equal(plan.singles.length, 0);
  assert.equal(F.isSpreadsheet("Pseudonym_Key.XLSX"), true);
  assert.equal(F.isSpreadsheet("brief.txt"), false);
});

test("an empty Text Files folder plans no upload at all", () => {
  const plan = F.uploadPlan([]);
  assert.deepEqual(plan, { bundle: [], singles: [], barred: [] });
});

// ---- what the chat gets called ---------------------------------------------

test("the folder's name goes over pseudonymized, case number included", () => {
  const got = F.chatTitleFor({
    folder: "23STCV12345 Smith v. Jones",
    looked: true,
    keyId: "k1",
    key: SMITH,
  });
  assert.equal(got.title, "24STCV99999 Marchetti v. Okonkwo");
  assert.equal(got.why, "");
});

test("a case number the key does not replace leaves the chat unnamed", () => {
  const partial = key([["Smith", "Marchetti"]]); // names, but not the number
  const got = F.chatTitleFor({
    folder: "23STCV12345 Smith v. Jones",
    looked: true,
    keyId: "k1",
    key: partial,
  });
  assert.equal(got.title, "");
  assert.match(got.why, /23STCV12345/);
  assert.match(got.why, /does not replace it/);
});

test("no key at all is no title — a case folder's name is the real one", () => {
  const got = F.chatTitleFor({ folder: "23STCV12345 Smith v. Jones", looked: true, keyId: "" });
  assert.equal(got.title, "");
  assert.match(got.why, /no pseudonym key came with it/);
});

test("a key library that would not read is not a matter without a key", () => {
  const got = F.chatTitleFor({ folder: "23STCV12345 Smith v. Jones", looked: false });
  assert.equal(got.title, "");
  assert.match(got.why, /would not read/);
});

test("a key that named this matter but has left the library holds the title too", () => {
  const got = F.chatTitleFor({
    folder: "23STCV12345 Smith v. Jones",
    looked: true,
    keyId: "k1",
    key: null,
  });
  assert.equal(got.title, "");
  assert.match(got.why, /not in the key library any more/);
});

test("the case comes across with the name, and a long name is cut to fit", () => {
  const shouty = F.chatTitleFor({
    folder: "23STCV12345 SMITH v. JONES",
    looked: true,
    keyId: "k1",
    key: SMITH,
  });
  assert.equal(shouty.title, "24STCV99999 MARCHETTI v. OKONKWO");
  const long = F.chatTitleFor({
    folder: "23STCV12345 Smith v. Jones " + "and others ".repeat(20),
    looked: true,
    keyId: "k1",
    key: SMITH,
  });
  assert.equal(long.title.length, F.MAX_TITLE);
  assert.ok(long.title.startsWith("24STCV99999 Marchetti v. Okonkwo"));
});

test("a folder with no name to take is not a title held for a reason worth reading", () => {
  const got = F.chatTitleFor({ folder: "", looked: true, keyId: "k1", key: SMITH });
  assert.equal(got.title, "");
  assert.match(got.why, /no name/);
});

test("the title decision is P.titlePlan's own — the two cannot drift apart", () => {
  // Same three modes, same inputs: what differs here is only the wording.
  assert.equal(P.titlePlan({ looked: false }).mode, "hold");
  assert.equal(P.titlePlan({ looked: true, keyId: "" }).mode, "plain");
  assert.equal(P.titlePlan({ looked: true, keyId: "k1", key: true }).mode, "clean");
});

// ---- what the button says ---------------------------------------------------

test("the upload note counts what is going and what was left behind", () => {
  const said = F.describeUpload({
    root: "23STCV12345 Smith v. Jones",
    bundle: [doc("a.txt"), doc("b.txt"), doc("c.txt")],
    singles: [doc("x.pdf")],
    left: 143,
  });
  assert.match(said, /3 text files/);
  assert.match(said, /as one combined file/);
  assert.match(said, /1 file that can't be combined/);
  assert.match(said, /Left 143 other files in the case folder alone/);
});

test("a Text Files folder with nothing in it says so rather than uploading the rest", () => {
  const said = F.describeUpload({ root: "23STCV12345 Smith v. Jones", bundle: [], singles: [] });
  assert.match(said, /No Text Files folder/);
  assert.doesNotMatch(said, /Attaching/);
});

test("a truncated pick is always said out loud", () => {
  const said = F.describeUpload({
    root: "case",
    bundle: [doc("a.txt"), doc("b.txt")],
    singles: [],
    capped: true,
  });
  assert.match(said, /the rest were left out/);
});

test("the key note says loaded and never uploaded, or that there wasn't one", () => {
  assert.match(F.describeKey({ root: "case", keyName: "23STCV12345 Smith" }), /never uploaded/);
  assert.match(F.describeKey({ root: "case", keyName: "" }), /No pseudonym key in case/);
});

test("the title note names the chat, or says plainly that it will not be named", () => {
  assert.match(F.describeTitle({ title: "24STCV99999 Marchetti" }), /will be named/);
  const held = F.describeTitle({ title: "", why: "no pseudonym key came with it" });
  assert.match(held, /will not be named/);
  assert.match(held, /no pseudonym key came with it/);
});

test("a folder picked a second time finds the key it loaded the first time", () => {
  const lib = {
    k1: Object.assign({ folder: "23STCV12345 Smith v. Jones" }, SMITH),
    k2: Object.assign({ folder: "22SMCV01234 Other v. Matter" }, SMITH),
    k3: SMITH, // never named a folder — it claims none
  };
  assert.equal(F.keyForFolder(lib, "23STCV12345 Smith v. Jones"), "k1");
  assert.equal(F.keyForFolder(lib, "23stcv12345 smith v. jones"), "k1");
  assert.equal(F.keyForFolder(lib, "23STCV99999 Nobody v. Nobody"), "");
  assert.equal(F.keyForFolder(lib, ""), "");
  assert.equal(F.keyForFolder(null, "23STCV12345 Smith v. Jones"), "");
});

test("the key note tells a fresh load from one that was already here", () => {
  assert.match(F.describeKey({ root: "case", keyName: "Smith" }), /loaded into the extension/);
  assert.match(
    F.describeKey({ root: "case", keyName: "Smith", already: true }),
    /already in the extension from an earlier pick/
  );
});

// ---- the conversation the send created, and the one you clicked -------------

const NOW = 1_800_000_000_000;
const iso = (ms) => new Date(ms).toISOString();
const msgs = (n) => Array.from({ length: n }, (_, i) => ({ uuid: "m" + i }));

test("a chat with the first send in it, made just now, is the one this started", () => {
  assert.equal(
    F.conversationFresh({ conv: { created_at: iso(NOW - 4000), chat_messages: msgs(1) }, now: NOW }).ok,
    true
  );
  // The reply landing makes it two, which is still the same conversation.
  assert.equal(
    F.conversationFresh({ conv: { created_at: iso(NOW - 40000), chat_messages: msgs(2) }, now: NOW }).ok,
    true
  );
});

test("a conversation already under way is somebody's work, whatever the address says", () => {
  const long = F.conversationFresh({
    conv: { created_at: iso(NOW - 4000), chat_messages: msgs(3) },
    now: NOW,
  });
  assert.equal(long.ok, false);
  assert.match(long.why, /already holds 3 messages/);
  // Short, but hours old — a chat left after one turn and clicked in the
  // sidebar. Renaming that is the mistake this test exists to prevent.
  const old = F.conversationFresh({
    conv: { created_at: iso(NOW - 5 * 3600 * 1000), chat_messages: msgs(1) },
    now: NOW,
  });
  assert.equal(old.ok, false);
  assert.match(old.why, /300 minutes ago/);
});

test("no conversation stamp falls back to the newest turn's own", () => {
  // The shapes are unversioned; a message carries a time in all of them.
  assert.equal(
    F.conversationFresh({ conv: { chat_messages: [{ created_at: iso(NOW - 6 * 3600 * 1000) }] }, now: NOW }).ok,
    false
  );
  assert.equal(
    F.conversationFresh({ conv: { chat_messages: [{ created_at: iso(NOW - 3000) }] }, now: NOW }).ok,
    true
  );
});

test("no stamp anywhere leaves the message count, which is still an answer", () => {
  assert.equal(F.conversationFresh({ conv: { chat_messages: msgs(1) }, now: NOW }).ok, true);
  assert.equal(
    F.conversationFresh({ conv: { created_at: "who knows", chat_messages: msgs(9) }, now: NOW }).ok,
    false
  );
});

// A Cowork session's payload is not a chat's, and may answer with neither
// turns nor a stamp. Then the page is the evidence — and it is three signals
// that have to agree, not one.

test("a Cowork session with nothing to read back is judged from the page", () => {
  const got = F.conversationFresh({
    conv: null,
    turns: 1,
    watched: true,
    pickedAt: NOW - 30000,
    now: NOW,
  });
  assert.equal(got.ok, true);
  assert.match(got.why, /the page's word/);
});

test("the page's word is not taken where any of the three disagrees", () => {
  // Turns already in it: this is a session that was going before the pick.
  const busy = F.conversationFresh({ conv: null, turns: 4, watched: true, pickedAt: NOW, now: NOW });
  assert.equal(busy.ok, false);
  assert.match(busy.why, /shows 4 turns/);
  // This tab never watched the composer become it — it was opened some other
  // way, and nothing here can say it is the one.
  assert.equal(
    F.conversationFresh({ conv: null, turns: 1, watched: false, pickedAt: NOW, now: NOW }).ok,
    null
  );
  // The pick is stale: an abandoned folder must not name a session picked up
  // an hour later.
  const stale = F.conversationFresh({
    conv: null,
    turns: 1,
    watched: true,
    pickedAt: NOW - 3600000,
    now: NOW,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.why, /picked 60 minutes ago/);
});

test("nothing read and nothing counted is 'can't tell', which is never a yes", () => {
  assert.equal(F.conversationFresh({ conv: null, turns: null, now: NOW }).ok, null);
  assert.equal(F.conversationFresh({}).ok, null);
  assert.equal(F.conversationFresh().ok, null);
});

test("a Cowork session that answers with a stamp and no turns is judged on the stamp", () => {
  // Its payload is not a chat's: there may be no chat_messages at all, and the
  // stamp is then the whole of what the conversation says about itself.
  assert.equal(F.conversationFresh({ conv: { created_at: iso(NOW - 5000) }, now: NOW }).ok, true);
  const old = F.conversationFresh({ conv: { created_at: iso(NOW - 3600000) }, now: NOW });
  assert.equal(old.ok, false);
  assert.match(old.why, /started 60 minutes ago/);
});

test("counting no turns is not counting none — it is a page that could not be read", () => {
  const got = F.conversationFresh({
    conv: null,
    turns: 0,
    watched: true,
    pickedAt: NOW - 5000,
    now: NOW,
  });
  assert.equal(got.ok, true);
  assert.match(got.why, /nothing on the page contradicted that/);
  assert.match(got.why, /the page's word/);
});
