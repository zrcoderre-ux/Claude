/**
 * The Chat composer's attach ladder, driven on a fake page with a fake clock.
 * Run with: node --test test/composer.test.js
 *
 * composer.js is wiring, not a pure module, but the one question this covers
 * is a measurement rather than a DOM shape, and getting it wrong failed real
 * runs: WHEN is the "before" chip count taken? The change event is discrete,
 * so React draws the chip before dispatchEvent returns. Counted after the
 * hand-over, that chip became the base, "new chips" never left zero, and a run
 * whose upload responses the page hook couldn't see stood down with the
 * document sitting on the composer:
 *
 *   could not attach 1 document(s) — 0/1 uploads confirmed,
 *   1 attachment(s) visible (tried: file input, then drop)
 *
 * The page here draws its chip synchronously inside dispatchEvent, the way
 * claude.ai does. The clock is virtual, so the eight-second chip grace and the
 * two-minute deadlines cost nothing.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CODE = fs.readFileSync(path.join(__dirname, "..", "src", "composer.js"), "utf8");
const CHANNEL = "CLAUDE_USAGE_METER";

const flush = () => new Promise((r) => setImmediate(r));

function makeClock() {
  let now = 1000000;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => {
    const id = ++seq;
    const d = Math.max(0, Number(ms) || 0);
    timers.set(id, { at: now + d, fn, every: every ? Math.max(1, d) : 0 });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, false),
    setInterval: (fn, ms) => add(fn, ms, true),
    clear: (id) => timers.delete(id),
    // Run `promise` to completion, firing timers in order in virtual time.
    async run(promise, limitMs) {
      let settled = false;
      let value;
      let error;
      promise.then(
        (v) => ((settled = true), (value = v)),
        (e) => ((settled = true), (error = e))
      );
      const end = now + limitMs;
      for (;;) {
        await flush();
        if (settled) break;
        let next = null;
        for (const [id, t] of timers) if (!next || t.at < next.t.at) next = { id, t };
        if (!next || next.t.at > end) throw new Error("did not settle within " + limitMs + "ms of virtual time");
        now = Math.max(now, next.t.at);
        if (next.t.every) next.t.at = now + next.t.every;
        else timers.delete(next.id);
        next.t.fn();
      }
      if (error) throw error;
      return value;
    },
  };
}

/**
 * A composer: an editor inside a form, a file input, and the chips the form
 * holds. `onChange(page)` and `onDrop(page)` are what claude.ai does when the
 * files are picked or dropped — synchronously, inside dispatchEvent.
 */
function makePage(opts) {
  const o = opts || {};
  const clock = makeClock();
  const listeners = [];
  const page = { chips: [], drops: 0, changes: 0, clock };
  for (let i = 0; i < (o.chipsBefore || 0); i++) page.chips.push({});

  const rect = () => ({ left: 0, top: 0, width: 600, height: 120 });
  const form = {
    querySelectorAll: (sel) => (sel === '[data-testid="file-thumbnail"]' ? page.chips.slice() : []),
    getBoundingClientRect: rect,
    dispatchEvent(ev) {
      if (ev.type === "drop") {
        page.drops++;
        if (o.onDrop) o.onDrop(page);
      }
      return true;
    },
  };
  const editor = {
    textContent: "",
    className: "",
    closest: (sel) => (sel === "form" ? form : null),
    getBoundingClientRect: rect,
  };
  const input = {
    files: null,
    className: "",
    closest: () => null,
    dispatchEvent(ev) {
      if (ev.type === "change") {
        page.changes++;
        if (o.onChange) o.onChange(page);
      }
      return true;
    },
  };
  const document = {
    visibilityState: "visible",
    body: form,
    querySelector(sel) {
      if (sel === 'div[data-testid="chat-input"]') return editor;
      if (sel === 'input[data-testid="file-upload"]') return input;
      return null;
    },
    querySelectorAll: () => [],
  };
  class Ev {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init || {});
    }
  }
  const win = {
    document,
    Date: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clear,
    setInterval: clock.setInterval,
    clearInterval: clock.clear,
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l[0] === type && l[1] === fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    location: { pathname: "/new", href: "https://claude.ai/new" },
    Event: Ev,
    DragEvent: Ev,
    DataTransfer: class {
      constructor() {
        this.files = [];
        this.items = { add: (f) => this.files.push(f) };
      }
    },
  };
  win.window = win;
  const ctx = vm.createContext(win);
  new vm.Script(CODE, { filename: "src/composer.js" }).runInContext(ctx);
  page.C = win.CUMComposer;
  // What inject.js relays when an upload-file response comes back. The source
  // has to be the context's own global: inside a vm context `window` answers
  // the global proxy, not the object the context was made from.
  const self = vm.runInContext("window", ctx);
  page.confirmUpload = () => {
    const ev = { source: self, data: { __channel: CHANNEL, payload: { upload: { success: true } } } };
    for (const [type, fn] of listeners.slice()) if (type === "message") fn(ev);
  };
  return page;
}

const FILE = { name: "Motion.pdf" };
const TEN_MINUTES = 10 * 60 * 1000;

test("a chip drawn during the change event carries an attach no upload response confirms", async () => {
  const page = makePage({ onChange: (p) => p.chips.push({}) });
  const started = page.clock.now();
  const att = await page.clock.run(page.C.attachFiles([FILE], 120000), TEN_MINUTES);
  assert.equal(att.ok, true, att.detail);
  assert.equal(att.how, "file input");
  assert.equal(att.visible, 1);
  assert.equal(page.drops, 0, "a landed file must not be dropped on a second time");
  // Chips stay the weaker signal: they carry it only after the grace.
  assert.ok(page.clock.now() - started >= 8000, "accepted on a chip before the grace ran out");
  assert.ok(page.clock.now() - started < 120000, "waited out the whole deadline for a chip already there");
});

test("a drop is measured from before the drop, too", async () => {
  const page = makePage({ onDrop: (p) => p.chips.push({}) });
  const att = await page.clock.run(page.C.attachFiles([FILE], 120000), TEN_MINUTES);
  assert.equal(att.ok, true, att.detail);
  assert.equal(att.how, "file input, then drop");
  assert.equal(att.visible, 1);
});

test("a chip already on the composer is not an attachment", async () => {
  // Nothing takes, but the composer was already showing one chip-shaped thing.
  const page = makePage({ chipsBefore: 1 });
  const att = await page.clock.run(page.C.attachFiles([FILE], 120000), TEN_MINUTES);
  assert.equal(att.ok, false);
  assert.equal(att.visible, 0);
  assert.match(att.detail, /0\/1 uploads confirmed, 0 attachment\(s\) visible/);
});

test("two files and one chip is not both files", async () => {
  const page = makePage({ onChange: (p) => p.chips.push({}) });
  const att = await page.clock.run(page.C.attachFiles([FILE, { name: "Opposition.pdf" }], 120000), TEN_MINUTES);
  assert.equal(att.ok, false);
});

test("an upload response still confirms without waiting on the chips", async () => {
  const page = makePage({
    onChange: (p) => {
      p.chips.push({});
      p.clock.setTimeout(() => p.confirmUpload(), 1500);
    },
  });
  const started = page.clock.now();
  const att = await page.clock.run(page.C.attachFiles([FILE], 120000), TEN_MINUTES);
  assert.equal(att.ok, true, att.detail);
  assert.equal(att.uploads, 1);
  assert.ok(page.clock.now() - started < 8000, "the upload response should not wait out the chip grace");
});
