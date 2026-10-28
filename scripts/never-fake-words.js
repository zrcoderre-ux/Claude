#!/usr/bin/env node
/**
 * Rebuilds src/neverfake.js from "Never Fake Words.txt" — PDF-Linker's list
 * of the words it does not fake, copied here from its Word Lists/ folder.
 * Run after copying a new list in:  node scripts/never-fake-words.js
 * test/neverfake.test.js fails while the module and the list disagree.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LIST = path.join(ROOT, "Never Fake Words.txt");
const OUT = path.join(ROOT, "src", "neverfake.js");

/** The words of the list file: every line that is not a `#` header. */
function readList(text) {
  return String(text)
    .split(/\r?\n/)
    .map((w) => w.trim())
    .filter((w) => w && w[0] !== "#");
}

function moduleSource(words) {
  return (
    "/**\n" +
    " * PDF-Linker's never-fake words (pure module, GENERATED — do not edit).\n" +
    " *\n" +
    " * The words PDF-Linker reads as ordinary vocabulary, never as a name on\n" +
    " * their own: its dictionary (English, less surnames) and the hand lists its\n" +
    " * bare-token screen reads. src/pseudo.js matches a ONE-word real on this\n" +
    " * list only where it is capitalised, the rule PDF-Linker applies to a bare\n" +
    " * token, so a key row binding \"Provision\" never rewrites \"provision\".\n" +
    " * Copied from PDF-Linker's Word Lists/Never Fake Words.txt into this repo's\n" +
    " * root and rebuilt here by scripts/never-fake-words.js. The English words\n" +
    " * are SCOWL's; its notice is PDF-Linker's Word Lists/SCOWL Copyright.txt.\n" +
    " */\n" +
    "(function (root) {\n" +
    '  "use strict";\n' +
    "\n" +
    "  const WORDS = " + JSON.stringify(words.join("\n")) + ";\n" +
    "\n" +
    "  // Built on the first lookup, not at load: most pages never ask.\n" +
    "  let set = null;\n" +
    "  function words() {\n" +
    '    if (!set) set = new Set(WORDS.split("\\n"));\n' +
    "    return set;\n" +
    "  }\n" +
    "\n" +
    "  /** Is `word` (any case) one PDF-Linker never fakes on its own? */\n" +
    "  function has(word) {\n" +
    '    return !!word && words().has(String(word).toLowerCase());\n' +
    "  }\n" +
    "\n" +
    "  const api = { has, words };\n" +
    '  if (typeof module !== "undefined" && module.exports) module.exports = api;\n' +
    "  root.CUMNeverFake = api;\n" +
    '})(typeof globalThis !== "undefined" ? globalThis : this);\n'
  );
}

if (require.main === module) {
  fs.writeFileSync(OUT, moduleSource(readList(fs.readFileSync(LIST, "utf8"))));
  console.log("wrote " + path.relative(ROOT, OUT));
}

module.exports = { readList, moduleSource, LIST, OUT };
