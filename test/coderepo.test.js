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

test("the known repos are the ones already learned", () => {
  // The list the row-text fallback is measured against is the session map —
  // repos learned from the API, an address, or a labelled control. A list
  // scraped off the page for anything with a slash in it is not knowledge:
  // it carries branch chips too, and trusting one put branches in the rows.
  const map = { session_aaa111aaa: { repo: "o/n", at: 1 } };
  assert.equal(R.repoInText("touched o/n today", [map]), "o/n");
  assert.equal(R.repoInText("claude/some-slug", [map]), null);
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

test("a branch is never read as a repo, wherever a record keeps it", () => {
  // The bug this rewrite exists for: rows came back named after the branch
  // the session was running on, because the reader walked into whatever a
  // record held and took the first thing shaped like `owner/name`. The shape
  // never says what a value IS — the key has to.
  const branchOnly = [
    { id: "session_aaa111aaa", branch: "claude/some-slug-x1" },
    { id: "session_bbb222bbb", git_branch: "claude/some-slug-x2" },
    { id: "session_ccc333ccc", branch: { name: "claude/some-slug-x3" } },
    { id: "session_ddd444ddd", tags: ["claude/some-slug-x4"] },
    { id: "session_eee555eee", head_ref: "claude/some-slug-x5" },
    { id: "session_fff666fff", outcome_branch: "claude/some-slug-x6" },
  ];
  assert.deepEqual(R.extractSessions(branchOnly), [], "no repo named, so no repo claimed");
  // And a record that carries both comes back with the repo, not the branch —
  // including a branch nested inside the repo's own object.
  assert.deepEqual(
    R.extractSessions([
      { id: "session_ggg777ggg", repo: "o/n", git_branch: "claude/some-slug" },
      { id: "session_hhh888hhh", repository: { full_name: "a/b", branch: "claude/other-slug" } },
    ]),
    [
      { id: "session_ggg777ggg", repo: "o/n" },
      { id: "session_hhh888hhh", repo: "a/b" },
    ]
  );
});

test("a key that only MIGHT hold a repo has to prove it with an address", () => {
  // `source: "claude/some-slug"` is not evidence of anything; the same key
  // holding a github address is.
  assert.deepEqual(R.extractSessions([{ id: "session_aaa111aaa", source: "claude/some-slug" }]), []);
  assert.deepEqual(R.extractSessions([{ id: "session_aaa111aaa", source: { url: "https://github.com/o/n" } }]), [
    { id: "session_aaa111aaa", repo: "o/n" },
  ]);
});

test("a repo written as two halves is put back together", () => {
  assert.deepEqual(
    R.extractSessions([
      { id: "session_aaa111aaa", repository: { name: "Claude", owner: { login: "zrcoderre-ux" }, branch: "claude/x" } },
    ]),
    [{ id: "session_aaa111aaa", repo: "zrcoderre-ux/Claude" }]
  );
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

// ---- the owner every row shares ---------------------------------------------

test("an owner the list is mostly on comes off the rows", () => {
  // A dozen rows on zrcoderre-ux/ spend their first eleven characters saying
  // nothing, a dozen times.
  const list = ["zrcoderre-ux/Claude", "zrcoderre-ux/notes", "anthropics/claude-code"];
  const owner = R.sharedOwner(list);
  assert.equal(owner, "zrcoderre-ux");
  assert.equal(R.repoLabel("zrcoderre-ux/Claude", owner), "Claude");
  assert.equal(
    R.repoLabel("anthropics/claude-code", owner),
    "anthropics/claude-code",
    "the row on another owner keeps it — that is the row you need to see is different"
  );
});

test("nothing is trimmed where trimming would be arbitrary", () => {
  assert.equal(R.sharedOwner(["a/x"]), null, "one repo has no repetition to hide");
  assert.equal(R.sharedOwner(["a/x", "b/y"]), null);
  assert.equal(R.sharedOwner(["a/x", "a/y", "b/z", "b/w"]), null, "a tie is left alone");
  assert.equal(R.sharedOwner([]), null);
  assert.equal(R.sharedOwner(null), null);
  assert.equal(R.sharedOwner(["a/x", "a/y", null, "junk"]), "a", "rows with no repo do not vote");
});

test("a label with no owner to drop is the repo itself", () => {
  assert.equal(R.repoLabel("o/n", null), "o/n");
  assert.equal(R.repoLabel("o/n", "other"), "o/n");
  assert.equal(R.repoLabel("junk", "o"), null);
});

// ---- the button --------------------------------------------------------------

test("the word names what the list is showing, not what the press would do", () => {
  assert.equal(R.buttonState(false, 0).label, "Titles");
  assert.equal(R.buttonState(true, 0).label, "Repos");
  assert.equal(R.buttonState(true, 0).lit, true, "colour means the list is not saying what claude.ai says");
  assert.equal(R.buttonState(false, 3).lit, false);
});

test("the button says which owner it took off", () => {
  assert.match(R.buttonState(true, 0, "zrcoderre-ux").title, /zrcoderre-ux\/ are shown by name alone/);
  assert.doesNotMatch(R.buttonState(true, 0, null).title, /name alone/);
  assert.doesNotMatch(R.buttonState(false, 0, "zrcoderre-ux").title, /name alone/);
});

test("rows with no repo known are counted out loud", () => {
  assert.match(R.buttonState(true, 3).title, /3 rows have no repo known/);
  assert.match(R.buttonState(true, 1).title, /1 row has no repo known/);
  assert.doesNotMatch(R.buttonState(true, 0).title, /no repo known/);
  assert.match(R.buttonState(false, 5).title, /name/i);
});
