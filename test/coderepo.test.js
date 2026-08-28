const test = require("node:test");
const assert = require("node:assert");
const R = require("../src/coderepo.js");

// ---- what counts as a repo -------------------------------------------------

test("a repo is owner/name, however it was written", () => {
  assert.equal(R.normRepo("anthropics/claude-code"), "anthropics/claude-code");
  assert.equal(R.normRepo("  anthropics/claude-code  "), "anthropics/claude-code");
  assert.equal(R.normRepo("https://github.com/zrcoderre-ux/Claude"), "zrcoderre-ux/Claude");
  assert.equal(R.normRepo("github.com/o/n.git"), "o/n");
  assert.equal(R.normRepo("git@github.com:o/n.git"), "o/n");
  // A URL can carry a whole tree behind it; the repo is the first two segments.
  assert.equal(R.normRepo("https://github.com/o/n/tree/main/src/x.js"), "o/n");
  assert.equal(R.normRepo("https://github.com/o/n/pull/12"), "o/n");
});

test("what is not a repo is null, because a wrong repo is worse than none", () => {
  assert.equal(R.normRepo("/code/session_abc123def"), null, "a path is not a repo");
  assert.equal(R.normRepo("12/25"), null, "a date is not a repo");
  assert.equal(R.normRepo("fix the login page"), null);
  assert.equal(R.normRepo("owner"), null, "no owner, no repo");
  assert.equal(R.normRepo(""), null);
  assert.equal(R.normRepo(null), null);
  assert.equal(R.normRepo(42), null);
  assert.equal(R.normRepo("a/" + "x".repeat(120)), null);
});

// ---- the branch that looks exactly like a repo ------------------------------

test("a bare token is believed only when it names a repo we already know", () => {
  // THE bug this feature exists to not have: a Claude Code branch is
  // `claude/some-slug`, which is the shape of `owner/name`. A row labelled
  // with its branch under a toggle that says "repo" is a wrong answer wearing
  // a right answer's clothes.
  assert.equal(R.repoInText("claude/recents-repo-toggle-dn9wh9", ["zrcoderre-ux/Claude"]), null);
  assert.equal(
    R.repoInText("zrcoderre-ux/Claude · claude/recents-repo-toggle", ["zrcoderre-ux/Claude"]),
    "zrcoderre-ux/Claude"
  );
  assert.equal(R.repoInText("o/n", []), null, "nothing known, nothing claimed");
});

test("a github URL is believed outright — a branch never appears as one", () => {
  assert.equal(R.repoInText("see https://github.com/o/n/pull/3", []), "o/n");
});

test("a control labelled as the repository is believed on its own text", () => {
  // The label is the evidence a row does not have: a repo picker shows repos,
  // so `acme/widgets` inside one is a repo even with nothing else known.
  assert.equal(R.repoInLabelled("acme/widgets Select repository"), "acme/widgets");
  assert.equal(R.repoInLabelled("Select repository"), null, "nothing picked, nothing learned");
  assert.equal(R.repoInLabelled("x".repeat(400) + " a/b"), null, "that is a page, not a control");
});

test("the known repos can come from the picker's list or the session map", () => {
  const map = { session_aaa111aaa: { repo: "o/n", at: 1 } };
  assert.equal(R.repoInText("touched o/n today", [["x/y"], map]), "o/n");
  assert.ok(R.knownSet(["o/n", "not a repo", "https://github.com/a/b"]).has("a/b"));
});

// ---- which session a row is -------------------------------------------------

test("a session id is read off a Claude Code link", () => {
  assert.equal(R.sessionId("/code/session_abc123"), "session_abc123");
  assert.equal(R.sessionId("https://claude.ai/code/session_x9y8z7q?tab=diff"), "session_x9y8z7q");
  assert.equal(R.sessionId("/code/2f1c9a44-1111-2222-3333-444455556666"), "2f1c9a44-1111-2222-3333-444455556666");
  assert.equal(R.sessionId("/code/new"), null, "the composer is not a row");
  assert.equal(R.sessionId("/code"), null);
  assert.equal(R.sessionId("/chat/2f1c9a44-1111-2222-3333-444455556666"), null);
  assert.equal(R.sessionId("/code/short"), null, "too short to be an id");
});

test("a Claude Code path is where a session's own repo can be read", () => {
  assert.equal(R.isCodePath("/code"), true);
  assert.equal(R.isCodePath("/code/session_abc123"), true);
  assert.equal(R.isCodePath("/codes"), false);
  assert.equal(R.isCodePath("/chat/x"), false);
});

// ---- reading the page's own session list ------------------------------------

test("a session list URL is worth parsing, a completion stream is not", () => {
  assert.equal(R.looksLikeSessionsUrl("https://claude.ai/api/organizations/x/code/sessions?limit=20"), true);
  assert.equal(R.looksLikeSessionsUrl("/api/cloud_sessions"), true);
  assert.equal(R.looksLikeSessionsUrl("/api/organizations/x/chat_conversations"), false);
  assert.equal(R.looksLikeSessionsUrl(null), false);
});

test("a record counts when it has a session id and a repo — never by its shape", () => {
  // Nothing here is a shape we were told about: the point is that a rename of
  // the wrapper, or of the repo's key, does not take the feature off the page.
  // An id that could not be a session's is skipped; an unfamiliar long one is
  // kept, because the id in a /code/ URL is as unversioned as the rest and a
  // record that matches no row on screen costs nothing.
  const body = {
    data: [
      { uuid: "session_aaa111aaa", name: "fix login", source: { url: "https://github.com/o/n" } },
      { id: "session_bbb222bbb", title: "docs", repository: { full_name: "a/b" } },
      { id: "session_ccc333ccc", title: "no repo here" },
      { id: "42", repo: "x/y" },
    ],
  };
  assert.deepEqual(R.extractSessions(body), [
    { id: "session_aaa111aaa", repo: "o/n" },
    { id: "session_bbb222bbb", repo: "a/b" },
  ]);
});

test("a naming key wins over a generic url on the same record", () => {
  const out = R.extractSessions([
    { id: "session_ddd444ddd", repo: "right/one", url: "https://github.com/wrong/one" },
  ]);
  assert.deepEqual(out, [{ id: "session_ddd444ddd", repo: "right/one" }]);
});

test("junk in, nothing out", () => {
  assert.deepEqual(R.extractSessions(null), []);
  assert.deepEqual(R.extractSessions("a string"), []);
  assert.deepEqual(R.extractSessions({ a: { b: { c: 1 } } }), []);
});

// ---- the map behind the rows ------------------------------------------------

test("nothing learned is nothing written — a list render is not a storage write", () => {
  const map = { session_aaa111aaa: { repo: "o/n", at: 5 } };
  assert.equal(R.mergeRepos(map, [{ id: "session_aaa111aaa", repo: "o/n" }], 9), null);
  assert.equal(R.mergeRepos(map, [], 9), null);
  assert.equal(R.mergeRepos(map, [{ id: "session_aaa111aaa", repo: "not a repo" }], 9), null);
});

test("a repo that changed is taken, and the old entries are kept", () => {
  const map = { session_aaa111aaa: { repo: "o/n", at: 5 } };
  const next = R.mergeRepos(map, [{ id: "session_bbb222bbb", repo: "a/b" }], 9);
  assert.deepEqual(next, {
    session_aaa111aaa: { repo: "o/n", at: 5 },
    session_bbb222bbb: { repo: "a/b", at: 9 },
  });
  assert.deepEqual(R.mergeRepos(map, [{ id: "session_aaa111aaa", repo: "o/other" }], 9), {
    session_aaa111aaa: { repo: "o/other", at: 9 },
  });
});

test("the map is capped, and it is the oldest that go", () => {
  const map = { a: { repo: "o/1", at: 1 }, b: { repo: "o/2", at: 2 } };
  const next = R.mergeRepos(map, [{ id: "c", repo: "o/3" }], 3, 2);
  assert.deepEqual(Object.keys(next).sort(), ["b", "c"]);
});

test("a repo reads back out of the map, however it was stored", () => {
  assert.equal(R.repoFor({ s: { repo: "o/n", at: 1 } }, "s"), "o/n");
  assert.equal(R.repoFor({ s: "o/n" }, "s"), "o/n", "an older bare-string entry still reads");
  assert.equal(R.repoFor({ s: { repo: "junk" } }, "s"), null);
  assert.equal(R.repoFor(null, "s"), null);
  assert.equal(R.repoFor({}, null), null);
});

// ---- which text in a row is the name ----------------------------------------

test("the name is the first text that could be one", () => {
  // A row is title, then furniture. Picking the longest instead would hand the
  // swap to a preview snippet.
  assert.equal(R.pickTitle(["Running", "Fix the login page", "o/n", "2 days ago"]), 1);
  assert.equal(R.pickTitle(["3h", "12/25", "·"]), -1);
  assert.equal(R.pickTitle([]), -1);
  assert.equal(R.pickTitle(null), -1);
});

test("furniture is not a name", () => {
  assert.equal(R.isTitleish("Fix the login page"), true);
  assert.equal(R.isTitleish("2 days ago"), false);
  assert.equal(R.isTitleish("3h"), false);
  assert.equal(R.isTitleish("Running"), false);
  assert.equal(R.isTitleish("Recents"), false);
  assert.equal(R.isTitleish("o/n"), false, "already a repo — swapping it says nothing");
  assert.equal(R.isTitleish("·"), false);
  assert.equal(R.isTitleish("x".repeat(200)), false, "prose is not a title");
});

// ---- the button --------------------------------------------------------------

test("the word names what the list is showing, not what the press would do", () => {
  assert.equal(R.buttonState(false, 0).label, "Titles");
  assert.equal(R.buttonState(true, 0).label, "Repos");
  assert.equal(R.buttonState(true, 0).lit, true, "colour means the list is not saying what claude.ai says");
  assert.equal(R.buttonState(false, 3).lit, false);
});

test("rows with no repo known are counted out loud", () => {
  assert.match(R.buttonState(true, 3).title, /3 rows have no repo known/);
  assert.match(R.buttonState(true, 1).title, /1 row has no repo known/);
  assert.doesNotMatch(R.buttonState(true, 0).title, /no repo known/);
  assert.match(R.buttonState(false, 5).title, /name/i);
});
