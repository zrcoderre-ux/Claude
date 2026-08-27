/**
 * A DOM small enough to LOAD the content scripts in, and nothing more.
 *
 * The suite tests the pure modules, which is where the decisions live. It
 * cannot see the one failure that takes a whole feature off the page in
 * silence: a content script that throws while it is INITIALISING. There is no
 * missing file and no error anyone reads — just a button that is not there.
 *
 * The class is worth covering on its own account, and it is worth covering
 * because it is what gets guessed at when a button does not appear. When the
 * key button was reported missing, "pseudo-view.js must be throwing before it
 * publishes the global key-panel.js reads" was the obvious theory and a
 * plausible one; this stub is what answered it in seconds — no, everything
 * loads, look elsewhere — instead of an afternoon of reading.
 *
 * So it has one job: run every content script's top-level body the way a
 * browser would, on a page with no claude.ai in it, and let anything that
 * throws be a failing test. It is deliberately not a browser. querySelector
 * answers nothing, layout is zero, and no event ever fires: a script that
 * needs more than that to LOAD is a script that would have needed it on a page
 * claude.ai had not finished drawing either.
 */
"use strict";

function makeStub() {
  const listeners = [];

  class ClassList {
    constructor(el) {
      this.el = el;
      this.set = new Set();
    }
    add(...n) {
      n.forEach((x) => x && this.set.add(x));
      this.sync();
    }
    remove(...n) {
      n.forEach((x) => this.set.delete(x));
      this.sync();
    }
    toggle(n, on) {
      if (on === undefined) on = !this.set.has(n);
      if (on) this.set.add(n);
      else this.set.delete(n);
      this.sync();
      return on;
    }
    contains(n) {
      return this.set.has(n);
    }
    sync() {
      this.el._className = Array.from(this.set).join(" ");
    }
  }

  class El {
    constructor(tag) {
      this.tagName = String(tag || "div").toUpperCase();
      this.nodeType = 1;
      this.children = [];
      this.childNodes = this.children;
      this.parentElement = null;
      this.attrs = {};
      this.style = new Proxy(
        { cssText: "" },
        {
          get: (t, k) => (k in t ? t[k] : ""),
          set: (t, k, v) => {
            t[k] = v;
            return true;
          },
        }
      );
      this.dataset = {};
      this.classList = new ClassList(this);
      this._className = "";
      this._text = "";
      this.value = "";
      this.files = [];
      this.hidden = false;
      this.disabled = false;
      this.readOnly = false;
      this.id = "";
      this.isConnected = false;
    }
    get className() {
      return this._className;
    }
    set className(v) {
      this._className = String(v || "");
      this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
    }
    get textContent() {
      return this._text || this.children.map((c) => c.textContent || "").join("");
    }
    set textContent(v) {
      this._text = String(v == null ? "" : v);
      this.children.length = 0;
    }
    get innerText() {
      return this.textContent;
    }
    set innerHTML(v) {
      this._html = String(v == null ? "" : v);
      this.children.length = 0;
    }
    get innerHTML() {
      return this._html || "";
    }
    get firstChild() {
      return this.children[0] || null;
    }
    get nextSibling() {
      return this.nextElementSibling;
    }
    get nextElementSibling() {
      const p = this.parentElement;
      if (!p) return null;
      return p.children[p.children.indexOf(this) + 1] || null;
    }
    get previousElementSibling() {
      const p = this.parentElement;
      if (!p) return null;
      return p.children[p.children.indexOf(this) - 1] || null;
    }
    get offsetWidth() {
      return 0;
    }
    get offsetHeight() {
      return 0;
    }
    appendChild(c) {
      if (!c) return c;
      if (c.parentElement) c.parentElement.removeChild(c);
      c.parentElement = this;
      c.isConnected = this.isConnected;
      this.children.push(c);
      return c;
    }
    append(...n) {
      for (const c of n) {
        if (typeof c === "string") this._text += c;
        else this.appendChild(c);
      }
    }
    insertBefore(c, ref) {
      if (!c) return c;
      if (c.parentElement) c.parentElement.removeChild(c);
      c.parentElement = this;
      c.isConnected = this.isConnected;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i === -1) this.children.push(c);
      else this.children.splice(i, 0, c);
      return c;
    }
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i !== -1) this.children.splice(i, 1);
      if (c) {
        c.parentElement = null;
        c.isConnected = false;
      }
      return c;
    }
    remove() {
      if (this.parentElement) this.parentElement.removeChild(this);
    }
    replaceWith(next) {
      if (this.parentElement) this.parentElement.insertBefore(next, this);
      this.remove();
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === "class") this.className = v;
      if (k === "id") this.id = String(v);
    }
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    }
    removeAttribute(k) {
      delete this.attrs[k];
    }
    hasAttribute(k) {
      return k in this.attrs;
    }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {
      return true;
    }
    click() {}
    focus() {}
    blur() {}
    select() {}
    setPointerCapture() {}
    releasePointerCapture() {}
    scrollIntoView() {}
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }
    querySelector() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
    closest() {
      return null;
    }
    matches() {
      return false;
    }
    contains(o) {
      if (o === this) return true;
      return this.children.some((c) => c.contains && c.contains(o));
    }
  }

  const doc = new El("body");
  const html = new El("html");
  html.isConnected = true;
  doc.isConnected = true;

  const document = {
    documentElement: html,
    body: doc,
    head: new El("head"),
    title: "Claude",
    activeElement: null,
    readyState: "complete",
    createElement: (t) => new El(t),
    createTextNode: (t) => {
      const n = new El("#text");
      n.nodeType = 3;
      n.nodeValue = String(t);
      return n;
    },
    createRange: () => ({
      selectNodeContents() {},
      setStart() {},
      setEnd() {},
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
      cloneRange() {
        return this;
      },
      collapse() {},
    }),
    createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (t, fn) => listeners.push([t, fn]),
    removeEventListener: () => {},
    execCommand: () => false,
    hasFocus: () => true,
    getSelection: () => ({
      rangeCount: 0,
      toString: () => "",
      getRangeAt: () => null,
      removeAllRanges() {},
      addRange() {},
      anchorNode: null,
    }),
  };

  const storage = {};
  const chrome = {
    runtime: {
      id: "stub",
      lastError: null,
      sendMessage: (msg, cb) => {
        if (typeof cb === "function") cb(undefined);
      },
      onMessage: { addListener: () => {} },
      getURL: (p) => "chrome-extension://stub/" + p,
    },
    storage: {
      local: {
        // The callback is never invoked, deliberately. Everything a content
        // script publishes it publishes SYNCHRONOUSLY; what it does once
        // storage answers is page work, and running it here would only walk
        // into the stub's own gaps (a querySelector that answers nothing, a
        // layout that is all zeroes) and report them as failures of the code.
        get: () => {},
        set: (obj, cb) => {
          Object.assign(storage, obj);
          if (cb) cb();
        },
        remove: (k, cb) => cb && cb(),
      },
      onChanged: { addListener: () => {} },
    },
  };

  const win = {
    location: {
      href: "https://claude.ai/new",
      pathname: "/new",
      origin: "https://claude.ai",
      hostname: "claude.ai",
      search: "",
    },
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    document: document,
    chrome: chrome,
    navigator: { userAgent: "stub", clipboard: { writeText: () => Promise.resolve() } },
    addEventListener: (t, fn) => listeners.push([t, fn]),
    removeEventListener: () => {},
    postMessage: () => {},
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    matchMedia: () => ({ matches: false, addListener: () => {}, addEventListener: () => {} }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    // Neither timer runs. This test is about the top-level body — what a
    // script schedules for later is the page's business, and letting it fire
    // here would only measure the stub's own gaps.
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    Event: class {
      constructor(t) {
        this.type = t;
      }
    },
    KeyboardEvent: class {
      constructor(t) {
        this.type = t;
      }
    },
    CustomEvent: class {
      constructor(t) {
        this.type = t;
      }
    },
    DataTransfer: class {
      constructor() {
        this.items = { add: () => {} };
        this.files = [];
      }
    },
    File: class {
      constructor(parts, name, opts) {
        this.name = name;
        this.type = (opts || {}).type || "";
        this.size = 0;
      }
    },
    Blob: class {},
    FileReader: class {
      readAsText() {}
    },
    fetch: () => Promise.reject(new Error("no network in the stub")),
    XMLHttpRequest: class {
      open() {}
      send() {}
    },
    WebSocket: class {},
    EventSource: class {},
    performance: { now: () => 0 },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.top = win;
  win.parent = win;
  return win;
}

module.exports = { makeStub };
