/**
 * Tests for src/autocontinue.js — the button-label predicates.
 * Run with: node --test test/autocontinue.test.js
 *
 * The module is a content script, so it needs a couple of globals before it will
 * load under Node. Everything it does at load time beyond that is already inside
 * a try/catch (it expects `chrome` to be missing outside an extension), so a
 * minimal window/document is enough to reach the exported helpers.
 */
const assert = require("node:assert");
const { test } = require("node:test");

global.window = global.window || {};
global.document = global.document || { querySelectorAll: () => [] };
const realSetInterval = global.setInterval;
global.setInterval = () => 0; // don't leave the self-poll running under the runner
require("../src/autocontinue.js");
global.setInterval = realSetInterval;

const AC = global.window.CUMAutoContinue;

test("the module exposes its label predicates", () => {
  assert.ok(AC, "src/autocontinue.js should export window.CUMAutoContinue");
  assert.equal(typeof AC.isAllowOnceLabel, "function");
});

test('isAllowOnceLabel matches "Allow once" in the shapes the UI renders', () => {
  for (const label of [
    "Allow once",
    "allow once",
    "ALLOW ONCE",
    "  Allow   once  ",
    "Allow once1", // a keyboard-shortcut hint glued on, as Claude Code menus do
    "Allow once 2",
    "Allow once ⏎",
  ]) {
    assert.equal(AC.isAllowOnceLabel(label), true, JSON.stringify(label));
  }
});

test("isAllowOnceLabel refuses every grant that outlives the prompt", () => {
  // This is the whole safety property: an automation may click through ONE call,
  // never hand out a standing permission.
  for (const label of [
    "Allow always",
    "Always allow",
    "Allow for this chat",
    "Allow for this session",
    "Allow all",
    "Allow",
    "Don't allow",
    "Deny",
    "Reject",
    "Allow once and always", // a compound label is not the narrow button
    "Disallow once",
  ]) {
    assert.equal(AC.isAllowOnceLabel(label), false, JSON.stringify(label));
  }
});

test("isAllowOnceLabel tolerates junk input", () => {
  for (const v of [null, undefined, "", "   ", 0, {}]) {
    assert.equal(AC.isAllowOnceLabel(v), false, String(v));
  }
});

test("the Continue and Try-again predicates stay exact-match", () => {
  assert.equal(AC.isContinueLabel("Continue"), true);
  assert.equal(AC.isContinueLabel(" continue "), true);
  assert.equal(AC.isContinueLabel("Continue anyway"), false);
  assert.equal(AC.isRetryLabel("Try again"), true);
  assert.equal(AC.isRetryLabel("Retry"), true);
  assert.equal(AC.isRetryLabel("Try again later"), false);
  // ...and neither one answers for the permission prompt.
  assert.equal(AC.isContinueLabel("Allow once"), false);
  assert.equal(AC.isRetryLabel("Allow once"), false);
  assert.equal(AC.isAllowOnceLabel("Continue"), false);
});
