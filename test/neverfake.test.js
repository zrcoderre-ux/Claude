"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");

const G = require("../scripts/never-fake-words.js");
const N = require("../src/neverfake.js");

test("src/neverfake.js is rebuilt from the committed list", () => {
  const words = G.readList(fs.readFileSync(G.LIST, "utf8"));
  assert.strictEqual(fs.readFileSync(G.OUT, "utf8"), G.moduleSource(words),
    "run: node scripts/never-fake-words.js");
  assert.strictEqual(N.words().size, words.length);
});

test("the list is PDF-Linker's: the vocabulary in, a surname out", () => {
  assert.ok(N.has("provision"));
  assert.ok(N.has("Provision"));
  assert.ok(N.has("contractors"));
  assert.ok(!N.has("smith"));
  assert.ok(!N.has(""));
});
