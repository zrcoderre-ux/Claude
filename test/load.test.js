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
function loadAll(opts) {
  const win = makeStub(opts);
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
// ...and the same again on a CONVERSATION, for the buttons that only exist
// where there is a chat to act on. A page with no conversation is the state
// most of them are asked to stay out of, so it cannot be the only page tested.
const CHAT_ID = "0192f3fc-9b35-7715-b2cc-b227512b5459";
const inChat = loadAll({
  location: {
    href: "https://claude.ai/chat/" + CHAT_ID,
    pathname: "/chat/" + CHAT_ID,
  },
});

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
    "CUMUpFiles",
    "CUMLeaks",
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

test("the LEAKS gate loads before every door that has to consult it", () => {
  // src/leaks.js bars an upload out of a folder marked LEAKS. Every door reads
  // it by name — src/folder-upload.js on its first lines, the two forms when
  // they are built — and a door that finds it missing refuses the pick. So a
  // gate loading too late is not a silent hole, it is every folder pick in the
  // extension refused, and it is manifest order that keeps it early.
  const order = contentScripts();
  const at = (f) => order.indexOf(f);
  assert.ok(at("src/leaks.js") !== -1, "the LEAKS gate is not in the manifest");
  for (const door of ["src/jobform.js", "src/folder-upload.js"])
    assert.ok(at("src/leaks.js") < at(door), "src/leaks.js loads too late for " + door);
  // The run editor and the workflow editor live on the options page instead,
  // so that list is asserted on its own — the same gate, the other page.
  const html = fs.readFileSync(path.join(ROOT, "src/options.html"), "utf8");
  const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
  const opt = (f) => scripts.indexOf(f);
  assert.ok(opt("leaks.js") !== -1, "the LEAKS gate is not on the options page");
  for (const door of ["jobform.js", "workflowform.js"])
    assert.ok(opt("leaks.js") < opt(door), "leaks.js loads too late for " + door);
});

test("the tray holds a slot for every button that asks for one", () => {
  // src/tray.js keeps the row's order. A button whose slot is not in it calls
  // put() and is dropped on the floor — no error, no button.
  const src = fs.readFileSync(path.join(ROOT, "src/tray.js"), "utf8");
  const m = src.match(/const ORDER = \[([^\]]*)\]/);
  assert.ok(m, "tray.js no longer declares ORDER");
  const order = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  for (const slot of ["key", "save", "files", "toc", "run", "folder"])
    assert.ok(order.includes(slot), "no tray slot for " + slot);
  // The key leads the row, which is what puts it to the LEFT of Save.
  assert.equal(order[0], "key");
  assert.ok(order.indexOf("key") < order.indexOf("save"));
});

test("the Files button is loaded after everything it reads", () => {
  // It reads CUMUpFiles, CUMComposer, CUMWorkflow and CUMConv on its first
  // lines and returns quietly if any is missing — a button that is silently
  // not there, which is what this file exists to catch. Manifest order is what
  // makes them present, so it is asserted rather than assumed.
  const order = contentScripts();
  const at = (f) => order.indexOf(f);
  assert.ok(at("src/up-files.js") !== -1, "the Files button is not in the manifest");
  for (const dep of ["src/upfiles.js", "src/composer.js", "src/workflow.js", "src/conv.js", "src/tray.js"])
    assert.ok(at(dep) !== -1 && at(dep) < at("src/up-files.js"), dep + " loads too late for it");
  // Its own decisions load after the two modules they defer to.
  for (const dep of ["src/workflow.js", "src/mdexport.js"])
    assert.ok(at(dep) < at("src/upfiles.js"), dep + " loads too late for src/upfiles.js");
});

test("every content script runs on a conversation page too", () => {
  assert.deepEqual(inChat.errors, [], "content scripts threw while loading:\n" + inChat.errors.join("\n"));
});

test("the Files button lands in the tray on a conversation, and only there", () => {
  // The control that gives an uploaded file the download claude.ai never did.
  // It is asked to be ABSENT with no conversation open — there is nothing to
  // list — so both halves are asserted: absent on /new, present on a chat.
  const trayOf = (win) => {
    const t = win.document.body.children.find((c) => c.id === "cum-tray");
    assert.ok(t, "the tray was never put on the page");
    return t;
  };
  const slotOf = (win, name) =>
    trayOf(win).children.find((s) => s.dataset && s.dataset.slot === name);
  assert.ok(slotOf(loaded.win, "files"), "no tray slot for the Files button");
  assert.ok(
    !slotOf(loaded.win, "files").children.find((c) => c.id === "cum-upf-btn"),
    "the Files button drew itself on a page with no conversation to list"
  );
  const btn = slotOf(inChat.win, "files").children.find((c) => c.id === "cum-upf-btn");
  assert.ok(btn, "the files slot is empty — the button was built and never placed");
  assert.ok(btn.isConnected, "the Files button was placed but is not connected");
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
