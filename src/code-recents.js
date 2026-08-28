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
  // { [sessionId]: { repo, at } }. The `2` is a clean break from the first
  // version of the map: it was filled by a reader that could be talked into a
  // BRANCH, and there is no telling from the outside which of its entries are
  // repos — so the old key is dropped rather than carried forward, and the map
  // fills again in a page or two from the API and the sessions you open.
  const MAP_KEY = "cum_code_repos_v2";
  const OLD_MAP_KEY = "cum_code_session_repos";
  const ON_KEY = "cum_code_repos_on"; // the switch, off by default
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
  let btn = null;
  let heading = null;
  let unknown = 0;
  // The owner the list is mostly on, left off the rows that are on it. Held
  // here only so the button can say what it took off.
  let owner = null;
  // node → { orig, shown }. The original is what claude.ai wrote; `shown` is
  // what we wrote over it, and the two together are what makes the switch
  // reversible after any number of re-renders.
  const swapped = new Map();
  const marked = new Set();
  // Headings whose collapse trigger the button cannot be placed outside of
  // without dropping onto a line of its own. See place().
  const inside = new WeakSet();

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
    owner = null;
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

  /**
   * The repos this page is entitled to recognise in a row's text: the ones
   * already LEARNED, from the API, a github address, or a labelled control.
   *
   * `cum_repos` — the scheduler's harvested repo list — is deliberately NOT
   * among them, though it was. It is filled by a scraper that sweeps a Claude
   * Code page for anything shaped like `owner/name` (src/composer.js,
   * scrapeRepos), and on that page the branch chips are shaped exactly like
   * that. Trusting it put branches in this list's rows — the very thing this
   * file was built to refuse — because a list of "known repos" that cannot
   * tell a branch from a repo is not knowledge, it is the same guess one step
   * removed.
   */
  function knownRepos() {
    return [map];
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
    // The fallback: this only ever runs if the window-level capture below
    // failed to register, since that one stops the press before it gets here.
    btn.addEventListener("click", (e) => {
      swallow(e);
      press();
    });
    // The heading is a DISCLOSURE: claude.ai's caret collapses Recents, and
    // the handler for it sits on an ancestor of the word "Recents". A press on
    // a button of ours that bubbles into it collapses the very list this
    // button is for — reported as "it takes multiple clicks to get where I
    // want", which is exactly what it looks like from the outside.
    //
    // anchorFor() keeps the button OUT of that control where it can, and the
    // press is stopped at the top of the event path where it cannot — see
    // the window-level capture at the bottom of this file.
    return btn;
  }

  function paint() {
    if (!btn) return;
    const st = R.buttonState(on, unknown, owner);
    const txt = btn.querySelector(".cum-repos-txt");
    if (txt) txt.textContent = st.label;
    btn.title = st.title;
    btn.setAttribute("aria-pressed", st.on ? "true" : "false");
    btn.classList.toggle("cum-repos-on", st.lit);
  }

  function press() {
    on = !on;
    storageSet({ [ON_KEY]: on });
    if (!on) restoreAll();
    apply();
  }

  function swallow(e) {
    try {
      e.stopPropagation();
      e.preventDefault();
    } catch (err) {
      /* ignore */
    }
  }
  function stopOnly(e) {
    try {
      e.stopPropagation();
    } catch (err) {
      /* ignore */
    }
  }
  // What claude.ai has made pressable. `aria-expanded` and `data-state` are
  // the disclosure's own tells; the rest are the shapes a row of furniture is
  // built out of.
  const PRESSABLE = 'button,summary,a,[role="button"],[aria-expanded],[data-state]';

  /**
   * Where the button goes: AFTER the control the heading lives inside, never
   * inside it. The word "Recents" is the label of a collapse trigger, so a
   * button placed beside the word is a button inside the trigger, and pressing
   * it collapses the list.
   *
   * The climb stops at the first ancestor that also contains the ROWS — that
   * one is the section, not the trigger, and hanging the button off it would
   * put it somewhere else entirely. A <summary> is the one control that cannot
   * be stepped out of (anything after it is the collapsed content), so there
   * the button stays beside the word and the window-level capture below is
   * what keeps the press off the disclosure.
   */
  function anchorFor(head, rows) {
    let node = head;
    let best = head;
    for (let i = 0; node && i < 5; i++) {
      // The current node is judged BEFORE the climb, because the control we
      // are looking for is the one whose PARENT holds the rows — it sits
      // beside the list, not around it, and testing after the climb walked
      // straight past it.
      try {
        if (node !== head && node.matches(PRESSABLE)) best = node;
      } catch (e) {
        /* ignore */
      }
      const parent = node.parentElement;
      if (!parent) break;
      if (rows.some((r) => parent.contains(r.el))) break;
      node = parent;
    }
    if (best !== head && best.tagName === "SUMMARY") return head;
    return best;
  }

  function insertAfter(b, at) {
    if (b.parentElement === at.parentElement && b.previousElementSibling === at) return true;
    try {
      at.parentElement.insertBefore(b, at.nextSibling);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** On the same line as the word, or pushed onto one of its own? */
  function wrapped(b, head) {
    try {
      const r = b.getBoundingClientRect();
      const h = head.getBoundingClientRect();
      if (r.height < 1 || h.height < 1) return false; // nothing measurable to judge
      return r.top >= h.bottom - 1;
    } catch (e) {
      return false;
    }
  }

  function place(head, rows) {
    const b = build();
    const at = inside.has(head) ? head : anchorFor(head, rows);
    if (!at || !at.parentElement) {
      if (b.parentNode) b.remove();
      return;
    }
    if (!insertAfter(b, at)) return;
    // Outside the trigger is the right place to BE and the wrong place to be
    // SEEN, if that trigger is a row in a column: the button lands under the
    // word instead of beside it, which is not what was asked for. Measured
    // rather than assumed, and remembered per heading so it is settled once
    // instead of re-judged on every tick. Beside the word, the swallowed
    // events are what keep the press off claude.ai's caret.
    if (at !== head && wrapped(b, head)) {
      inside.add(head);
      insertAfter(b, head);
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
    place(head, rows);
    if (!on) {
      if (swapped.size || marked.size) restoreAll();
      paint();
      return;
    }
    // READ THE WHOLE LIST BEFORE WRITING ANY OF IT. What a row says depends on
    // what the other rows say: an owner every row shares is an owner no row
    // needs to spend its width on. So the repos are collected first and the
    // labels decided once, rather than each row being written as it is read.
    const live = new Set();
    const found = [];
    let missing = 0;
    for (const row of rows) {
      live.add(row.el);
      const repo = repoForRow(row);
      if (!repo) missing++;
      found.push({ row: row, repo: repo });
    }
    owner = R.sharedOwner(found.map((f) => f.repo));
    for (const f of found) {
      if (!f.repo) {
        mark(f.row.el, true);
        // Its title stays exactly as claude.ai wrote it — including one we
        // had written a repo over before the map changed under us.
        for (const n of textNodes(f.row.el)) {
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
      mark(f.row.el, false);
      const nodes = textNodes(f.row.el);
      const idx = R.pickTitle(nodes.map(original));
      if (idx < 0) continue; // nothing in this row reads as a name; leave it be
      show(nodes[idx], R.repoLabel(f.repo, owner));
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
          '[aria-label*="repositor" i],[title*="repositor" i],[data-testid*="repositor" i]'
        )) {
          if (isOurs(el)) continue;
          const said =
            (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "") +
            " " + (el.getAttribute("data-testid") || "");
          // A control that mentions a branch is not evidence about a repo,
          // whatever else its label says — and a branch is the one wrong
          // answer here that looks exactly like a right one.
          if (/branch|ref\b/i.test(said)) continue;
          const t = (el.textContent || "").trim();
          if (t.length > 300) continue;
          repo = R.repoInText(t, knownRepos()) || R.repoInLabelled(t);
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

  storageGet([MAP_KEY, ON_KEY]).then((res) => {
    map = (res && res[MAP_KEY]) || {};
    on = !!(res && res[ON_KEY]);
    try {
      chrome.storage.local.remove(OLD_MAP_KEY);
    } catch (e) {
      /* ignore */
    }
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

  // ---- the press stops here ------------------------------------------------
  //
  // The heading is a DISCLOSURE: claude.ai's caret collapses Recents, and the
  // handler for it is on an ancestor of the word. A press on a button of ours
  // that reaches it collapses the very list the button is for — which is what
  // "it takes multiple clicks to get where I want" was.
  //
  // Stopping it on the button itself is not enough. A handler in the CAPTURE
  // phase runs on the way DOWN, before the event reaches our button at all,
  // and a listener of ours on the button cannot stop what has already fired.
  // Measured, not assumed: a mock trigger with a capture-phase collapse
  // swallowed the whole list on one press.
  //
  // So the press is taken at the top of the path, where nothing in the page
  // has seen it yet: one capture listener on the window, which acts only on
  // events aimed at OUR button and leaves every other press on the page
  // untouched. It has to do the toggling as well as the stopping, because
  // stopping a captured event keeps it from reaching the button's own
  // listener too — that listener stays as the fallback for a window this
  // could not be registered on.
  //
  // Every event of the gesture, not just the click: a collapse can as easily
  // be wired to the press as to the release.
  const ours = (e) => {
    try {
      const t = e.target;
      return !!t && !!t.closest && !!t.closest("#" + ID);
    } catch (err) {
      return false;
    }
  };
  try {
    window.addEventListener(
      "click",
      (e) => {
        if (!ours(e)) return;
        swallow(e);
        try {
          e.stopImmediatePropagation();
        } catch (err) {
          /* ignore */
        }
        press();
      },
      true
    );
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "keydown", "keyup"])
      window.addEventListener(
        type,
        (e) => {
          if (ours(e)) stopOnly(e);
        },
        true
      );
  } catch (e) {
    /* the button's own listener still works; only a captured collapse gets through */
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
