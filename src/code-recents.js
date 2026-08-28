/**
 * Claude Usage Meter — the Repos toggle beside Recents (ISOLATED world).
 *
 * The owner's ask, in their words: a toggle button next to Recents that
 * changes the display from the conversation name to the REPO each
 * conversation is on, so "which session last touched this repo" is a glance
 * rather than a hunt through titles.
 *
 * So: one button, immediately after claude.ai's own "Recents" heading, and one
 * flag. Pressed, every row in that list says its repo in place of its name.
 * Pressed again, the names come back — the same text nodes, the same values,
 * because the swap keeps each one's original beside it rather than re-deriving
 * a title it never owned.
 *
 * WHAT IT WILL NOT DO IS GUESS. A Claude Code branch (`claude/some-slug`) has
 * the exact shape of `owner/name`, so a row's own text is not enough on its
 * own; the rules for what counts as evidence of a repo live in
 * src/coderepo.js, pure and tested. A row this page cannot name a repo for
 * KEEPS ITS TITLE and is dimmed, which says "not known" without pretending and
 * without costing the row its use as a link.
 *
 * WHERE IT APPEARS is decided by evidence, not by a path: a "Recents" heading
 * with at least one Claude Code session link under it. claude.ai moving that
 * list to another address keeps working; a Recents heading with no sessions in
 * it (Home's own) never gets the button.
 *
 * The repo map is filled by src/inject.js watching the page's own session API
 * and by this file learning the repo of any session you open. Neither is
 * required for the other, and the button says how many rows are still unknown.
 *
 * It shares its text nodes with the pseudonym translation, which sweeps the
 * same lists for a different reason (src/pseudo-view.js). Each keeps its own
 * original beside what it wrote, and each re-writes on the next render, so the
 * two cannot lose a title between them — a row translated into its real case
 * name and then switched to its repo says the repo, and says the real name
 * again when the switch goes back.
 */
(function () {
  "use strict";

  const R = window.CUMCodeRepo;
  if (!R) return;

  const ID = "cum-repos";
  const MAP_KEY = "cum_code_session_repos"; // { [sessionId]: { repo, at } }
  const ON_KEY = "cum_code_repos_on"; // the switch, off by default
  const KNOWN_KEY = "cum_repos"; // the picker's harvested repo list
  const TICK_MS = 1200;
  // A DATA ATTRIBUTE, never a class of ours. Everything in this extension
  // knows its own work by `[id^="cum-"],[class*="cum-"]` — this file included,
  // three lines down — so putting one of our classes on claude.ai's row makes
  // that row look like ours to every scanner here, our own text walker among
  // them. It cost a pass that found no rows, restored what it had just
  // written, and found them again a tick later, forever.
  const MARK = "data-cum-repos";

  let on = false;
  let map = {};
  let known = [];
  let btn = null;
  let heading = null;
  let unknown = 0;
  // node → { orig, shown }. The original is what claude.ai wrote; `shown` is
  // what we wrote over it, and the two together are what makes the switch
  // reversible after any number of re-renders.
  const swapped = new Map();
  const marked = new Set();

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (e) {
        resolve({});
      }
    });
  }
  function storageSet(obj) {
    try {
      chrome.storage.local.set(obj);
    } catch (e) {
      /* a switch that cannot be remembered still works for this page */
    }
  }

  const isOurs = (el) => {
    try {
      return !!el && !!el.closest && !!el.closest('[id^="cum-"],[class*="cum-"]');
    } catch (e) {
      return false;
    }
  };

  function visible(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) {
      return false;
    }
  }

  // ---- finding the list ----------------------------------------------------

  /**
   * The cheap question, asked before the dear one. Finding the heading means
   * scanning every span and div on the page, and this runs on a tick and on
   * every batch of claude.ai's own mutations — on a chat mid-stream that is a
   * whole-document scan several times a second for a list that is not there.
   * One indexed selector says no first.
   */
  function anySessionLink() {
    try {
      return !!document.querySelector('a[href*="/code/"]');
    } catch (e) {
      return false;
    }
  }

  const HEAD_SEL = "h1,h2,h3,h4,h5,h6,span,div,p,strong,b,label,legend";
  const IS_RECENTS = /^recents?$/i;

  /**
   * claude.ai's own "Recents" label. Leaf elements only — the word itself,
   * never the section that contains it — and re-found only when the one we
   * had has gone, since this is a whole-document scan on a tick.
   */
  function findHeading() {
    if (heading && heading.isConnected && IS_RECENTS.test((heading.textContent || "").trim()))
      return heading;
    heading = null;
    let els;
    try {
      els = document.querySelectorAll(HEAD_SEL);
    } catch (e) {
      return null;
    }
    for (const el of els) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (t.length > 10 || !IS_RECENTS.test(t)) continue;
      if (isOurs(el) || !visible(el)) continue;
      heading = el;
      return el;
    }
    return null;
  }

  /** The session rows under a heading: links whose href IS a Claude Code session. */
  function rowsFor(head) {
    let el = head;
    for (let i = 0; el && i < 8; i++, el = el.parentElement) {
      let links;
      try {
        links = el.querySelectorAll('a[href*="/code/"]');
      } catch (e) {
        continue;
      }
      const rows = [];
      for (const a of links) {
        if (isOurs(a)) continue;
        const id = R.sessionId(a.getAttribute("href") || a.href || "");
        if (!id) continue;
        // A link nested inside another row's link is that row, once.
        if (rows.some((r) => r.el.contains(a))) continue;
        rows.push({ el: a, id: id });
      }
      if (rows.length) return rows;
    }
    return [];
  }

  // ---- reading and writing a row's text ------------------------------------

  const SKIP_SEL = 'script,style,svg,input,textarea,[contenteditable="true"],[id^="cum-"],[class*="cum-"]';

  /** Every text node in a row, in document order, ours and chrome excluded. */
  function textNodes(row) {
    const out = [];
    let walker;
    try {
      walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          try {
            if (p.closest(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
          } catch (e) {
            return NodeFilter.FILTER_REJECT;
          }
          return (node.nodeValue || "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
    } catch (e) {
      return out;
    }
    let n;
    while ((n = walker.nextNode())) {
      out.push(n);
      if (out.length > 40) break;
    }
    return out;
  }

  /** What claude.ai wrote in a node — not what we may have written over it. */
  function original(node) {
    const rec = swapped.get(node);
    if (rec && node.nodeValue === rec.shown) return rec.orig;
    return node.nodeValue || "";
  }

  function show(node, text) {
    let rec = swapped.get(node);
    if (rec && node.nodeValue !== rec.shown) {
      // claude.ai re-rendered this row under us: what is there now is the new
      // original, and writing the repo over it again is the whole point of
      // running on a tick.
      rec.orig = node.nodeValue || "";
    }
    if (!rec) {
      rec = { orig: node.nodeValue || "", shown: text };
      swapped.set(node, rec);
    }
    if (node.nodeValue === text) {
      rec.shown = text;
      return;
    }
    rec.shown = text;
    try {
      node.nodeValue = text;
    } catch (e) {
      swapped.delete(node);
    }
  }

  function unmark(el) {
    try {
      el.removeAttribute(MARK);
    } catch (e) {
      /* ignore */
    }
  }

  function restoreAll() {
    for (const [node, rec] of swapped) {
      try {
        if (node.nodeValue === rec.shown) node.nodeValue = rec.orig;
      } catch (e) {
        /* a node claude.ai has thrown away needs nothing put back */
      }
    }
    swapped.clear();
    for (const el of marked) unmark(el);
    marked.clear();
    unknown = 0;
  }

  function mark(el, isUnknown) {
    try {
      el.setAttribute(MARK, isUnknown ? "unknown" : "repo");
      marked.add(el);
    } catch (e) {
      /* ignore */
    }
  }

  // ---- the repo a row is on ------------------------------------------------

  function knownRepos() {
    return [known, map];
  }

  function repoForRow(row) {
    const stored = R.repoFor(map, row.id);
    if (stored) return stored;
    // The row's own text — believed only under src/coderepo.js's rules, which
    // is what keeps a branch off a row that says "repo".
    let text = "";
    for (const n of textNodes(row.el)) text += " " + original(n);
    return R.repoInText(text, knownRepos()) || R.repoInText(row.el.getAttribute("href") || "", knownRepos());
  }

  // ---- the button ----------------------------------------------------------

  function build() {
    if (btn) return btn;
    btn = document.createElement("button");
    btn.id = ID;
    btn.type = "button";
    // A branch mark rather than an emoji: it sits among claude.ai's own line
    // icons and has to be one of them.
    btn.innerHTML =
      '<span class="cum-repos-ico" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/>' +
      '<circle cx="18" cy="9" r="2.4"/><path d="M6 8.4v7.2"/>' +
      '<path d="M18 11.4c0 3-2.4 4.2-5 4.2H8.4"/>' +
      "</svg></span>" +
      '<span class="cum-repos-txt"></span>';
    btn.addEventListener("click", () => {
      on = !on;
      storageSet({ [ON_KEY]: on });
      if (!on) restoreAll();
      apply();
    });
    return btn;
  }

  function paint() {
    if (!btn) return;
    const st = R.buttonState(on, unknown);
    const txt = btn.querySelector(".cum-repos-txt");
    if (txt) txt.textContent = st.label;
    btn.title = st.title;
    btn.setAttribute("aria-pressed", st.on ? "true" : "false");
    btn.classList.toggle("cum-repos-on", st.lit);
  }

  function place(head) {
    const b = build();
    if (!head || !head.parentElement) {
      if (b.parentNode) b.remove();
      return;
    }
    if (b.parentElement !== head.parentElement || b.previousElementSibling !== head) {
      try {
        head.parentElement.insertBefore(b, head.nextSibling);
      } catch (e) {
        /* ignore */
      }
    }
  }

  // ---- the pass ------------------------------------------------------------

  function apply() {
    const head = anySessionLink() ? findHeading() : null;
    const rows = head ? rowsFor(head) : [];
    if (!head || !rows.length) {
      // Not the Claude Code list: no button, and nothing left rewritten.
      if (btn && btn.parentNode) btn.remove();
      if (swapped.size || marked.size) restoreAll();
      return;
    }
    place(head);
    if (!on) {
      if (swapped.size || marked.size) restoreAll();
      paint();
      return;
    }
    const live = new Set();
    let missing = 0;
    for (const row of rows) {
      live.add(row.el);
      const repo = repoForRow(row);
      if (!repo) {
        missing++;
        mark(row.el, true);
        // Its title stays exactly as claude.ai wrote it — including one we
        // had written a repo over before the map changed under us.
        for (const n of textNodes(row.el)) {
          const rec = swapped.get(n);
          if (rec && n.nodeValue === rec.shown) {
            try {
              n.nodeValue = rec.orig;
            } catch (e) {
              /* ignore */
            }
            swapped.delete(n);
          }
        }
        continue;
      }
      mark(row.el, false);
      const nodes = textNodes(row.el);
      const idx = R.pickTitle(nodes.map(original));
      if (idx < 0) continue; // nothing in this row reads as a name; leave it be
      show(nodes[idx], repo);
    }
    // Rows claude.ai has since dropped: forget their marks, keep nobody's text.
    for (const el of Array.from(marked))
      if (!live.has(el)) {
        unmark(el);
        marked.delete(el);
      }
    unknown = missing;
    paint();
  }

  // ---- learning the repo of a session you are looking at --------------------

  let learnedFor = null;

  function learnCurrent() {
    const id = R.sessionId(location.pathname);
    if (!id || id === learnedFor || R.repoFor(map, id)) return;
    let repo = null;
    // A github link on the page names a repo outright — a branch never appears
    // as one, which is why this is believed where a bare token is not.
    try {
      for (const a of document.querySelectorAll('a[href*="github.com/"]')) {
        if (isOurs(a)) continue;
        repo = R.normRepo(a.getAttribute("href") || a.href || "");
        if (repo) break;
      }
    } catch (e) {
      /* ignore */
    }
    if (!repo) {
      // A control claude.ai has LABELLED as the repository: its text is a repo
      // because the label says so, so a bare token is evidence here.
      try {
        for (const el of document.querySelectorAll(
          '[aria-label*="repositor" i],[title*="repositor" i],[data-testid*="repo" i]'
        )) {
          if (isOurs(el)) continue;
          const t = ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "")).trim();
          if (t.length > 300) continue;
          repo = R.repoInText(t, knownRepos()) || R.repoInLabelled(el.textContent || "");
          if (repo) break;
        }
      } catch (e) {
        /* ignore */
      }
    }
    if (!repo) return;
    learnedFor = id;
    const next = R.mergeRepos(map, [{ id: id, repo: repo }]);
    if (next) {
      map = next;
      storageSet({ [MAP_KEY]: next });
    }
  }

  // ---- wiring --------------------------------------------------------------

  let pending = null;
  function schedule() {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      tick();
    }, 250);
  }

  function tick() {
    try {
      if (R.isCodePath(location.pathname)) learnCurrent();
      apply();
    } catch (e) {
      /* a list we could not read is a list left as claude.ai drew it */
    }
  }

  storageGet([MAP_KEY, ON_KEY, KNOWN_KEY]).then((res) => {
    map = (res && res[MAP_KEY]) || {};
    known = (res && res[KNOWN_KEY]) || [];
    on = !!(res && res[ON_KEY]);
    tick();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes) return;
      let touched = false;
      if (changes[MAP_KEY]) {
        map = changes[MAP_KEY].newValue || {};
        touched = true;
      }
      if (changes[KNOWN_KEY]) {
        known = changes[KNOWN_KEY].newValue || [];
        touched = true;
      }
      if (changes[ON_KEY]) {
        const next = !!changes[ON_KEY].newValue;
        if (next !== on) {
          on = next;
          if (!on) restoreAll();
          touched = true;
        }
      }
      if (touched) schedule();
    });
  } catch (e) {
    /* ignore */
  }

  // A list claude.ai re-renders (a session finishing, a filter, a route change)
  // is a list whose rows are new nodes; the observer catches those inside a
  // frame, and the tick catches everything the observer's own throttle misses.
  try {
    new MutationObserver(schedule).observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });
  } catch (e) {
    /* ignore */
  }
  setInterval(tick, TICK_MS);
  tick();
})();
