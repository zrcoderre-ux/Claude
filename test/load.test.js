/**
 * Every content script LOADS.
 * Run with: node --test test/load.test.js
 *
 * The rest of the suite tests decisions. This tests the one thing no pure test
 * can see: whether a content script's top-level body runs at all. One that
 * throws while initialising takes its whole feature off the page and says
 * nothing — no console the operator reads, no missing file, just a button that
 * is not there.
 *
 * It also settles the theory that gets reached for first when a button does
 * not appear. The key button was reported missing; the obvious explanation was
 * that pseudo-view.js throws before publishing the global key-panel.js reads
 * on its first line. This said no in seconds — everything loads, every global
 * is published, look elsewhere — and elsewhere turned out to be CSS. That is
 * worth keeping whichever way the answer comes out.
 *
 * The scripts are run in MANIFEST ORDER against test/domstub.js, so a module
 * reading a global that an earlier one publishes gets the real thing — and a
 * module that reads one published LATER fails here, which is the other half of
 * the same bug.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { makeStub } = require("./domstub.js");

const ROOT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

function contentScripts() {
  const out = [];
  for (const block of manifest.content_scripts || []) for (const f of block.js || []) out.push(f);
  return out;
}

/** Run every content script in order; answer the shared window and any error. */
function loadAll() {
  const win = makeStub();
  const ctx = vm.createContext(win);
  // The scripts are written for a browser global object, so `window`, `self`
  // and the bare global all have to be the same thing — which is what the
  // context IS. Anything they reach for that a browser would have is on the
  // stub; anything else should be a failure here rather than on the page.
  const errors = [];
  for (const rel of contentScripts()) {
    const file = path.join(ROOT, rel);
    const code = fs.readFileSync(file, "utf8");
    try {
      new vm.Script(code, { filename: rel }).runInContext(ctx);
    } catch (e) {
      errors.push(rel + ": " + ((e && e.message) || e));
    }
  }
  return { win, errors };
}

const loaded = loadAll();

test("every content script runs its top-level body without throwing", () => {
  assert.deepEqual(loaded.errors, [], "content scripts threw while loading:\n" + loaded.errors.join("\n"));
});

test("each module publishes the global the next one reads", () => {
  // The ones other modules read by name. A missing global here is a feature
  // that will be silently absent on the page rather than visibly broken.
  const wanted = [
    "CUMComposer",
    "CUMWorkflow",
    "CUMPseudo",
    "CUMMasterKey",
    "CUMFolderUp",
    "CUMDropDir",
    "CUMCowork",
    "CUMXlsx",
    "CUMPanelBar",
    "CUMTray",
    "CUMPseudoView",
    "CUMFaking",
  ];
  const missing = wanted.filter((g) => !loaded.win[g]);
  assert.deepEqual(missing, [], "never published: " + missing.join(", "));
});

test("the pseudonym view publishes what the key button reads from it", () => {
  // The seam src/key-panel.js is built on. A rename on either side of it is a
  // button that draws nothing, which is the failure this file exists for.
  const V = loaded.win.CUMPseudoView;
  assert.ok(V, "CUMPseudoView was never published");
  for (const fn of ["state", "clean", "setPaused", "subscribe", "docTitle", "plainText"])
    assert.equal(typeof V[fn], "function", "CUMPseudoView." + fn);
  // And it answers on a page with no key and no claude.ai in it, since that is
  // the state the button is first drawn in.
  const st = V.state();
  assert.equal(typeof st, "object");
  assert.equal(st.on, false);
});

test("the fakes toggle is loaded after everything it reads", () => {
  // It reads CUMComposer, CUMPseudoView and CUMFaking on its first lines and
  // returns quietly if any is missing — which is a button that is silently not
  // there, the exact failure this file exists for. Manifest order is what
  // makes those three present, so it is asserted rather than assumed.
  const order = contentScripts();
  const at = (f) => order.indexOf(f);
  assert.ok(at("src/fake-toggle.js") !== -1, "the fakes toggle is not in the manifest");
  for (const dep of ["src/composer.js", "src/pseudo-view.js", "src/faking.js"])
    assert.ok(at(dep) !== -1 && at(dep) < at("src/fake-toggle.js"), dep + " loads too late for it");
  // And after the Folder button, which is the thing it docks itself beside.
  assert.ok(at("src/folder-upload.js") < at("src/fake-toggle.js"));
});

test("the tray holds a slot for every button that asks for one", () => {
  // src/tray.js keeps the row's order. A button whose slot is not in it calls
  // put() and is dropped on the floor — no error, no button.
  const src = fs.readFileSync(path.join(ROOT, "src/tray.js"), "utf8");
  const m = src.match(/const ORDER = \[([^\]]*)\]/);
  assert.ok(m, "tray.js no longer declares ORDER");
  const order = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  for (const slot of ["key", "save", "toc", "run", "folder"])
    assert.ok(order.includes(slot), "no tray slot for " + slot);
  // The key leads the row, which is what puts it to the LEFT of Save.
  assert.equal(order[0], "key");
  assert.ok(order.indexOf("key") < order.indexOf("save"));
});

test("the key button actually lands in the tray", () => {
  // Not "it loads" — it PLACES. src/key-panel.js calls place() on its way up,
  // so by the time every script has run the button should be in the tray's
  // first slot. Twice now a button has been reported missing while every
  // module loaded, every global was published and every slot existed; this is
  // the assertion that tells those apart.
  const body = loaded.win.document.body;
  const tray = body.children.find((c) => c.id === "cum-tray");
  assert.ok(tray, "the tray was never put on the page");
  const slots = tray.children.map((s) => s.dataset && s.dataset.slot);
  assert.equal(slots[0], "key", "the key slot does not lead the row");
  const keySlot = tray.children[0];
  const btn = keySlot.children.find((c) => c.id === "cum-key-btn");
  assert.ok(btn, "the key slot is empty — the button was built and never placed");
  assert.ok(btn.isConnected, "the key button was placed but is not connected");
});
