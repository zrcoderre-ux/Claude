const test = require("node:test");
const assert = require("node:assert");
const N = require("../src/nag.js");

test("the live banner's own text is a nag, however its markup runs it together", () => {
  // Straight off the page: the span, the link, and both concatenated the way
  // textContent concatenates them.
  assert.equal(N.isNagText("Approaching weekly limit"), true);
  assert.equal(N.isNagText("Get more usage"), true);
  assert.equal(N.looksLikeNag("Approaching weekly limitGet more usage"), true);
  assert.equal(N.looksLikeNag("Approaching session limit — Get more usage"), true);
});

test("a reply DISCUSSING limits is not a banner — the words at paragraph size stay", () => {
  const reply =
    "When claude.ai shows the Approaching weekly limit banner it is often " +
    "inaccurate, and the Get more usage link routes to billing. The extension " +
    "measures the same window from the API instead, which is why the two disagree.";
  assert.equal(N.isNagText(reply), true, "the words are there");
  assert.equal(N.looksLikeNag(reply), false, "but at this size it is a sentence, not a banner");
});

test("ordinary page text is left alone", () => {
  assert.equal(N.isNagText("Motion for Bifurcation of Trial"), false);
  assert.equal(N.isNagText(""), false);
  assert.equal(N.isNagText(null), false);
  assert.equal(N.looksLikeNag("Dismiss"), false);
});
