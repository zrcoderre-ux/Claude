/**
 * Claude Usage Meter — Auto-download files Claude produces (ISOLATED world).
 *
 * With the (opt-in, default-off) toggle on, a reply that hands you a file has
 * that file saved for you: the extension clicks the reply's own download
 * control once the turn has finished. The decisions — what counts as a save
 * control, what has already been saved, and the ceilings — live in the pure
 * module src/autodl.js; this is the DOM around them.
 *
 * Its own switch, off by default, like every other clicker in here: this one
 * writes to your disk, which is not a decision an extension gets to make for
 * you. And it is **real-time only** — a file is saved out of a reply this page
 * watched arrive, never out of a chat's backlog. Four guards, in the order they
 * matter:
 *
 * - **A reply has to have landed in front of us.** The signal is the one a
 *   workflow step trusts: `src/inject.js` reports when the assistant's
 *   `text/event-stream` opens and when its body finishes reading, which is the
 *   turn genuinely ending, and doesn't care whether the tab is in front. The
 *   page's own Stop control is the fallback where that hook never fires. Only
 *   then — and only once the answer differs from the one that was newest when
 *   the turn began — does that reply become somewhere a file may be taken from.
 * - **A census on arrival.** Whatever is on the page when this starts — or when
 *   you turn the toggle on, or when you open another conversation — is recorded
 *   as already handled.
 * - **Only the newest reply or two.** claude.ai unmounts messages that scroll
 *   out of view and mounts them again when you scroll back, so a watcher
 *   looking at the whole transcript would see a chat's entire history arrive as
 *   "new" every time you scrolled up.
 * - **Only buttons, and links that carry a `download` attribute.** A plain
 *   `<a>` captioned "Download …" navigates, and navigating away from the
 *   conversation you are reading would be a far worse accident than a file not
 *   saved.
 */
(function () {
  "use strict";

  const A = window.CUMAutoDl;
  const C = window.CUMComposer;
  const CFG_KEY = "cum_autodownload"; // { enabled, max }
  const SELF_POLL_MS = 2000;
  const MENU_MS = 350; // let a menu the click opened draw before reading it
  const PANEL_MS = 700; // ...and a preview panel, which is slower than a menu
  const ESCAPE_MS = 700; // let a click land before dismissing any menu it opened
  const SETTLE_MS = 20000; // how long a just-landed reply is still settling

  let cfg = { enabled: false, max: A ? A.MAX_PER_PAGE : 20 };
  let seen = []; // keys handled this page load (saved, or adopted by the census)
  let count = 0; // files actually saved this page load
  let lastAt = 0;
  let baselined = false;
  let where = ""; // the conversation this ledger belongs to
  let toldCap = false;
  let followed = ""; // the last file whose Download had to be chased into a panel

  // ---- which replies landed in front of us --------------------------------
  // Page-scoped rather than per-conversation, deliberately: a brand-new chat
  // changes its own URL from /new to /chat/{uuid} part-way through its FIRST
  // answer, and a turn-tracker reset by that would lose the very reply it was
  // watching — which is also the commonest way to ask Claude for a file.
  let live = []; // signatures of replies we watched arrive
  let armed = false; // a turn has ended; waiting to see the answer it produced
  let before = ""; // newest reply when the current turn began
  let wasGenerating = false;
  let settleUntil = 0; // grace for a reply still drawing its file card

  // The assistant's response stream, as reported by src/inject.js. Only the
  // completion endpoint counts — claude.ai streams plenty else over SSE, and an
  // unrelated one closing must not mark a reply as freshly landed.
  const COMPLETION_RE = /completion|\/retry|\/messages(\?|$)/i;
  try {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const m = event.data;
      const p = m && C && m.__channel === C.CHANNEL ? m.payload : null;
      if (!p || (!p.streamStart && !p.streamDone)) return;
      // What the page did while this was switched off is not ours to act on —
      // and a turn remembered from then would be waiting to mark an old reply
      // as live the moment the switch went the other way.
      if (!cfg.enabled) return;
      if (!COMPLETION_RE.test(String(p.url || ""))) return;
      if (p.streamStart) before = newestSignature();
      if (p.streamDone) armed = true;
    });
  } catch (e) {
    /* the Stop control below is the fallback */
  }

  // Assistant turns, newest last — the same cascade src/workflow-run.js walks,
  // because claude.ai's markup is unversioned and one of these matches.
  const ASSISTANT_SELECTORS = [
    '[data-testid="assistant-message"]',
    ".font-claude-response",
    ".font-claude-message",
    "[data-is-streaming]",
  ];
  // Not every `.font-claude-response` is a reply. claude.ai uses the same
  // response font for furniture — a project's title in the content panel is
  // one, inside an `<a href="/project/…">` — and that panel renders AFTER the
  // conversation, so "the last one" was the panel and everything downstream
  // was reading the wrong part of the page. A reply is never inside a link, a
  // button, or a file thumbnail; that is the whole of the rule.
  const NOT_A_MESSAGE = 'a[href],button,[role="button"],[data-testid="file-thumbnail"]';
  function isMessage(el) {
    if (!el || C.isOurs(el)) return false;
    try {
      if (el.closest(NOT_A_MESSAGE)) return false;
    } catch (e) {
      /* a browser without closest() would be a bigger problem than this */
    }
    return true;
  }

  function assistantMessages() {
    for (const sel of ASSISTANT_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      const list = Array.from(nodes).filter(isMessage);
      // Outermost only. claude.ai nests a matching element inside a matching
      // element, so every turn counted as two messages — which made the count
      // wrong, and made the inner one impossible to widen at all: the first
      // ancestor it tried already "held another reply", namely its own outer
      // half. That is why a reply reported no controls whatever: the climb
      // never got past the prose to the action bar sitting under it.
      const outer = list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
      if (outer.length) return outer;
    }
    return [];
  }

  // One step out from the element claude.ai marks as the message, so long as
  // that step doesn't swallow a SECOND reply. An attachment is drawn as a
  // sibling of the prose rather than inside it, and so is the reply's own
  // action bar, so a watcher looking only at the prose sees neither.
  //
  // "A second reply" means another message in the list — not another element
  // that happens to match one of the selectors. Counting raw matches read a
  // message that merely NESTS a matching element as two replies and stopped the
  // climb dead at the prose, which is exactly where the file card isn't. The
  // symptom was a reply reporting no controls at all, when every reply on
  // claude.ai has Copy and Retry sitting right under it.
  function widen(msgEl) {
    const all = assistantMessages();
    let scope = msgEl;
    for (let i = 0; i < 5; i++) {
      const p = scope.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      const swallows = all.some((m) => m !== msgEl && !msgEl.contains(m) && p.contains(m));
      if (swallows) break;
      scope = p;
    }
    return scope;
  }

  function newestSignature() {
    const list = assistantMessages();
    if (!list.length || !A) return "";
    return A.turnSignature(list[list.length - 1].textContent);
  }

  // A filename near a control that didn't name one. The card usually says what
  // the file is called even where the button only says "Download".
  function cardName(node) {
    let el = node;
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
      const n = A.fileNameIn(el.textContent);
      if (n) return n;
    }
    return "";
  }

  // Clickable at all. **Not** "visible": a card's download control is commonly
  // revealed on hover, which means it sits at zero opacity until the pointer is
  // over it — and a watcher that insisted on seeing it would wait forever for a
  // button that is right there and clicks perfectly well. This is what made the
  // feature do nothing: the control was found every time and ruled out every
  // time. Disabled still counts, and so does having been clicked already.
  function ready(el) {
    if (!el) return false;
    if (el.getAttribute && el.getAttribute("data-cum-dl")) return false; // saved already
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return false;
    if (!el.isConnected) return false;
    return true;
  }

  // Nudge a card, so anything it only draws under the pointer exists to be
  // found. The same trick src/replycopy.js uses on the action bar.
  function hover(el) {
    for (const type of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
      try {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch (e) {
        /* ignore */
      }
    }
  }

  // The file cards in a reply: the smallest element that names a file and has
  // something clickable on it. Found by the FILENAME rather than by the
  // control, because the filename is the part that doesn't change when
  // claude.ai's markup does — and because a card's control may be an icon with
  // no caption at all, which no amount of label-matching will ever find.
  const CARD_SCOPE = "div,span,a,li,article,section,figure,p";
  const CARD_MAX_TEXT = 120; // a card says a filename and a size, not a sentence
  const CONTROLS = 'button,[role="button"],a[download],a[href^="blob:"]';

  // Climb from the smallest thing that identifies a file to the nearest
  // ancestor that has a control on it. The label is a SIBLING of the download
  // button, not its parent, so stopping at the label finds nothing to press.
  // Bounded by `room`: once the text runs past a card's worth, the climb has
  // left the card and is into the prose around it, and a "card" that is really
  // a paragraph would hand back whatever button shared the reply with it.
  function climbToControl(start, room) {
    let card = start;
    for (let i = 0; i < 4; i++) {
      try {
        if (card.querySelector(CONTROLS)) return card;
      } catch (e) {
        return card;
      }
      const p = card.parentElement;
      if (!p) return card;
      const t = (p.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length > room) return card;
      card = p;
    }
    return card;
  }

  /**
   * The file cards in a reply, each with how confidently it was identified.
   *
   * Two ways in, because claude.ai draws a produced file both ways:
   *
   * - **By filename** (`ruling.docx` on the card) — strong. The filename is the
   *   part that doesn't change when the markup does, and a card carrying one is
   *   unambiguous enough that pressing the only control on it is safe.
   * - **By type chip** — a card whose name has no extension (`Tentative Ruling`)
   *   and a small `DOCX` beside it. Weaker, so it is `strict`: only a control
   *   that NAMES itself a download will be pressed on one of these. A stray
   *   `<strong>PDF</strong>` in a sentence must never cost you a click on the
   *   reply's Copy button.
   *
   * Found by what the card SAYS rather than by what it has on it: requiring a
   * control here is what made a card whose download button only exists under
   * the pointer invisible — it had no control, so it was not a card, so it was
   * never hovered, so it never got one. Chicken, meet egg.
   */
  function cardsIn(root) {
    let nodes;
    try {
      nodes = root.querySelectorAll(CARD_SCOPE);
    } catch (e) {
      return [];
    }
    const named = [];
    const chips = [];
    for (const el of nodes) {
      if (C.isOurs(el)) continue;
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (A.isTypeChip(text)) {
        chips.push(el);
        continue;
      }
      if (text.length > CARD_MAX_TEXT) continue;
      if (A.fileNameIn(text)) named.push(el);
    }

    const out = [];
    const push = (el, strict, name) => {
      if (!el) return;
      const at = out.findIndex((c) => c.el === el || c.el.contains(el) || el.contains(c.el));
      if (at === -1) return out.push({ el: el, strict: strict, name: name || "" });
      // The same card reached both ways is the strong reading of it.
      if (!strict && out[at].strict)
        out[at] = {
          el: el.contains(out[at].el) ? out[at].el : el,
          strict: false,
          name: name || out[at].name,
        };
    };

    for (const start of named) {
      if (named.some((o) => o !== start && start.contains(o))) continue; // not innermost
      // Read at the element that NAMED the file, not off the finished card.
      // A card's own text runs the name into the type chip beside it —
      // "ruling.md" + "md" is "ruling.mdmd" — and no filename survives that.
      const name = A.fileNameIn(start.textContent) || "";
      push(climbToControl(start, Math.min(CARD_MAX_TEXT, name.length + 40)), false, name);
    }
    for (const chip of chips) {
      // A chip on its own is not a card — the card is the thing that holds the
      // chip AND a name. Climb to it, and drop the chip if the only thing that
      // ever turned up was the chip repeated.
      const card = climbToControl(chip, CARD_MAX_TEXT);
      const text = (card.textContent || "").replace(/\s+/g, " ").trim();
      if (A.isTypeChip(text)) continue; // never grew past the chip
      push(card, true);
    }
    return out.filter((c) => !out.some((o) => o !== c && c.el.contains(o.el)));
  }

  // The control on a card that saves the file, best first. A card with exactly
  // one control at all is that control: an icon-only download button is the
  // ordinary shape, and refusing to press the only thing on a card that plainly
  // holds a file is refusing to do the job.
  function controlIn(card, strict) {
    const q = (sel) => {
      try {
        return Array.from(card.querySelectorAll(sel)).filter((el) => !C.isOurs(el));
      } catch (e) {
        return [];
      }
    };
    const named = (els, test) =>
      els.find((el) =>
        test(el.getAttribute("aria-label")) || test(el.getAttribute("title")) || test(el.textContent)
      );
    const links = q('a[download],a[href^="blob:"]');
    if (links.length) return links[0];
    const tagged = q('[data-testid*="download" i],[data-test-id*="download" i]');
    if (tagged.length) return tagged[0];
    const buttons = q('button,[role="button"]');
    const byName = named(buttons, A.isSaveLabel) || named(buttons, A.mentionsSave);
    if (byName) return byName;
    // A card identified only by its type chip stops here: it may not be a card
    // at all, and "the only button near it" is how you end up pressing Copy.
    if (strict) return null;
    // The last resort — press the only thing on the card — applies only to a
    // card that is a card: a filename and a size. On anything bigger, "the only
    // button" could be anything at all.
    const small = (card.textContent || "").replace(/\s+/g, " ").trim().length <= CARD_MAX_TEXT;
    if (!small || buttons.length !== 1) return null;
    return buttons[0];
  }

  // Is this control the card itself rather than something on it?
  //
  // claude.ai wraps the whole thumbnail in a `<button aria-label="ruling.docx,
  // docx, 117 lines">`, and pressing it **opens a preview** — it saves nothing.
  // That is the shape this feature kept failing in: a control was found, it was
  // pressed, a panel opened over the conversation, and Escape shut it again. It
  // is still worth pressing, because the Download control usually lives inside
  // what it opens — but it is an ENTRY, not the thing itself, so save() knows
  // to go looking afterwards.
  function isOpener(card, ctrl) {
    if (!ctrl) return false;
    const name = A.fileNameIn(card.textContent || "");
    if (!name) return false;
    const label =
      (ctrl.getAttribute("aria-label") || "") + " " + (ctrl.textContent || "");
    if (A.isSaveLabel(ctrl.getAttribute("aria-label")) || A.isSaveLabel(ctrl.textContent))
      return false;
    return label.replace(/\s+/g, " ").indexOf(name) !== -1;
  }

  // Every file this reply is offering. Document order, and everything that
  // matched — including what can't be clicked yet — because that order is what
  // the keys are numbered against where a control carries no filename, and a
  // list that dropped its clicked entries would renumber the rest.
  function offersIn(msgEl) {
    const found = [];
    const nodes = new Set();
    const add = (node, name, opener) => {
      if (!node || nodes.has(node) || C.isOurs(node)) return;
      nodes.add(node);
      found.push({ node, name: name || cardName(node), ready: ready(node), opener: !!opener });
    };
    try {
      for (const a of msgEl.querySelectorAll("a[download]"))
        add(a, (a.getAttribute("download") || "").trim() || A.fileName(a.textContent));
      // A control labelled as a save, anywhere in the reply. Buttons only —
      // a bare link would navigate rather than save.
      for (const b of msgEl.querySelectorAll('button, [role="button"]')) {
        const label =
          b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent;
        if (A.isSaveLabel(label)) add(b, A.fileName(label));
      }
      // ...and whatever the file cards themselves offer, which is the path that
      // finds an unlabelled icon.
      for (const card of cardsIn(msgEl)) {
        // Hovered FIRST, always, rather than only when nothing was found. The
        // thumbnail's action slot is empty markup until the pointer arrives —
        // claude.ai renders the per-file buttons on mouse-enter — so looking
        // before hovering finds the card's own preview button and settles for
        // it, when a real Download was one event away.
        hover(card.el);
        const ctrl = controlIn(card.el, card.strict);
        if (ctrl) add(ctrl, card.name || A.fileNameIn(card.el.textContent), isOpener(card.el, ctrl));
      }
    } catch (e) {
      return found;
    }
    return found;
  }

  function collect() {
    // The newest reply, plus the one before it so a missed poll can't lose a
    // file — and no further back, or scrolling would resurrect the whole chat.
    const recent = assistantMessages().slice(-2);
    const offers = [];
    for (const m of recent) {
      // The card can sit just outside the prose element claude.ai marks as the
      // message, so the reply's own container is searched where it holds no
      // other reply.
      const scope = widen(m);
      const found = offersIn(scope);
      if (!found.length) continue;
      const keys = A.offerKeys(
        A.turnSignature(m.textContent),
        found.map((f) => f.name)
      );
      found.forEach((f, i) =>
        offers.push({ key: keys[i], name: f.name, node: f.node, ready: f.ready, opener: f.opener })
      );
    }
    return offers;
  }

  // What the click just put on the page.
  //
  // Pressing a card does one of three things, and this doesn't need to know
  // which: it saves the file, it opens a menu with Download in it, or it opens
  // a preview panel with Download in it. The old code assumed the first, and
  // where it was really the second or third it pressed the card, waited, then
  // dismissed what had opened with Escape — the one shape where the feature
  // looked exactly like doing nothing at all.
  //
  // So rather than guess at the container — menu, dialog, popper, drawer, none
  // of which claude.ai promises to keep calling the same thing — take a census
  // of every control on the page before the click and look at what is NEW
  // afterwards. A new control that names itself a download is the one to press,
  // wherever it turned up. Nothing else is pressed: a new control that doesn't
  // say what it does could be Delete.
  const ANY_CONTROL = 'button,[role="button"],[role="menuitem"],[role="option"],a[download],a[href^="blob:"]';
  function controlCensus() {
    try {
      return new Set(Array.from(document.querySelectorAll(ANY_CONTROL)));
    } catch (e) {
      return new Set();
    }
  }

  function newSaveControl(before_) {
    let all;
    try {
      all = Array.from(document.querySelectorAll(ANY_CONTROL));
    } catch (e) {
      return null;
    }
    for (const el of all) {
      if (before_.has(el) || C.isOurs(el)) continue;
      if (el.tagName === "A" && el.hasAttribute("download")) return el;
      // The strict reading only. Inside a card that already names a file,
      // "Save a copy" is unambiguous; a sweep of the whole document is not the
      // inside of anything, and claude.ai captions plenty of unrelated things
      // "Save". The word has to lead: Download, Download …, Save as, Save file.
      const label = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent;
      if (A.isSaveLabel(label)) return el;
    }
    return null;
  }

  function escape() {
    try {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } catch (e) {
      /* ignore */
    }
  }

  function save(offer) {
    lastAt = Date.now();
    count++;
    followed = ""; // this save's own story, not the last one's
    try {
      offer.node.setAttribute("data-cum-dl", "1");
    } catch (e) {
      /* the ledger key is the real guard; this is the belt to its braces */
    }
    const before_ = controlCensus();
    try {
      offer.node.click();
    } catch (e) {
      return; // one that won't click is a file not saved, and nothing more
    }
    // Twice, because a menu draws in a frame and a preview panel takes rather
    // longer — and an opener that saved nothing is worth a second look before
    // its panel gets shut again.
    const chase = (attempt) => {
      const item = newSaveControl(before_);
      if (item) {
        try {
          item.click();
        } catch (e) {
          /* ignore */
        }
        followed = offer.name || "a file";
        setTimeout(escape, ESCAPE_MS); // shut whatever is left of what opened
        return;
      }
      if (attempt < 2) return setTimeout(() => chase(attempt + 1), PANEL_MS);
      // Nothing turned up. Either the click saved the file outright — the happy
      // case — or it opened something that must not be left sitting over the
      // conversation you're reading.
      escape();
    };
    setTimeout(() => chase(1), MENU_MS);
    const cap = cfg.max > 0 ? cfg.max : A.MAX_PER_PAGE;
    toast(`Saved ${offer.name || "a file"} (${count} / ${cap})`);
  }

  function tick() {
    // Off is the default, and the default must cost nothing: no scanning the
    // page every two seconds on the strength of a toggle nobody turned on.
    if (!A || !C || !cfg.enabled) return;
    let generating = false;
    try {
      generating = C.isGenerating();
    } catch (e) {
      generating = false;
    }

    // A different conversation is a different ledger, and a fresh census — the
    // chat you just opened must not be mistaken for output that just arrived.
    //
    // But not while a turn is in flight or its answer is still awaited: a new
    // chat renames itself from /new to /chat/{uuid} in the middle of its first
    // answer, and a census taken then would file that answer's file under
    // history, which is the exact reply the feature exists for. `where` still
    // moves, so the deferred reset can't fire later at a worse moment.
    //
    // The tally is deliberately NOT reset either: the ceiling is per page load,
    // and an SPA navigation is not one. A runaway must not be able to walk
    // around it by moving to the next chat.
    const here = location.pathname;
    if (here !== where) {
      where = here;
      if (!generating && !armed) {
        seen = [];
        lastAt = 0;
        baselined = false;
        settleUntil = 0; // what's newest in the chat you just opened is not it
      }
    }

    // The Stop control, for when inject.js's stream report never came. Same
    // two-part signal: note what was newest when the turn began, and arm when
    // it ends.
    const newest = newestSignature();
    if (generating && !wasGenerating) before = newest;
    if (!generating && wasGenerating) armed = true;
    wasGenerating = generating;

    // A turn ended AND the answer it produced is on the page. Only now is that
    // reply somewhere a file may be taken from.
    if (A.landed({ armed, generating, newest, before })) {
      live = A.rememberLive(live, newest);
      before = newest;
      armed = false;
      settleUntil = Date.now() + SETTLE_MS;
    } else if (!generating && settleUntil && Date.now() < settleUntil) {
      // A reply that has just landed may still be drawing its file card, and a
      // card that renders inside the opening of a SHORT answer moves that
      // reply's signature out from under the one we just marked. Re-marking for
      // a moment costs nothing — it is still only ever the newest reply, and
      // only in the seconds after one arrived.
      live = A.rememberLive(live, newest);
    }

    const offers = collect();
    const res = A.plan(offers, {
      enabled: cfg.enabled,
      generating,
      pending: armed, // a turn ended; its answer hasn't shown up yet
      baselined,
      live,
      seen,
      count,
      max: cfg.max,
      now: Date.now(),
      lastAt,
    });
    report(offers, res, generating);

    for (const k of res.adopt) if (seen.indexOf(k) === -1) seen.push(k);
    if (res.hold === "baseline") {
      baselined = true;
      return;
    }
    if (!res.take) {
      if (res.hold === "cap" && !toldCap) {
        toldCap = true;
        toast(`Auto-download paused — saved ${count}. Reload to save more.`);
      }
      return;
    }
    save(res.take);
  }

  // ---- What it can see -----------------------------------------------------
  // "It isn't working" is three different faults with one symptom: the turn
  // wasn't seen to land, no file was found in it, or the file was found and
  // held back. Without this the only way to tell them apart is to guess, which
  // is what made this take three rounds. The last reading is written where the
  // popup can show it, and only when it changes, so an idle tab writes nothing.
  let lastReport = "";
  function report(offers, res, generating) {
    const line =
      offers.length +
      " offered · " +
      (res.take ? "saving" : res.hold || "nothing new") +
      " · " +
      live.length +
      (live.length === 1 ? " reply watched" : " replies watched") +
      (generating ? " · generating" : "") +
      (baselined ? "" : " · census open") +
      (followed ? " · chased " + followed + " into a panel" : "");
    if (line === lastReport) return;
    lastReport = line;
    try {
      chrome.storage?.local.set({
        cum_autodownload_last: { at: Date.now(), line, saved: count },
      });
    } catch (e) {
      /* a diagnostic that throws would be its own joke */
    }
  }

  // ---- The probe -----------------------------------------------------------
  // Three rounds of "it isn't working" went on guesses about markup nobody
  // here can see. This is the end of that: press the button in the popup and
  // it writes down what it actually found in the newest reply — every control
  // and its caption, every piece of text that looks like a filename or a file
  // type, which of them it took for a card, and which gate is holding it. One
  // paste of that says exactly which of the three faults it is.
  const PROBE_KEY = "cum_autodownload_probe";
  const PROBE_MAX = 6000;

  function label(el) {
    const a = (el.getAttribute("aria-label") || "").trim();
    const t = (el.getAttribute("title") || "").trim();
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const bits = [];
    if (a) bits.push("aria-label=" + JSON.stringify(a));
    if (t && t !== a) bits.push("title=" + JSON.stringify(t));
    bits.push(txt ? JSON.stringify(txt) : "(no text)");
    const test = el.getAttribute("data-testid") || el.getAttribute("data-test-id");
    if (test) bits.push("testid=" + JSON.stringify(test));
    if (el.tagName === "A") {
      if (el.hasAttribute("download")) bits.push("download");
      const href = (el.getAttribute("href") || "").slice(0, 40);
      if (href) bits.push("href=" + JSON.stringify(href));
    }
    return bits.join(" ");
  }

  function probe() {
    const out = [];
    const say = (s) => out.push(s);
    try {
      say("Auto-download probe · " + location.pathname);
      if (!A || !C) return finishProbe(["Auto-download probe · the page's modules didn't load."]);
      let generating = false;
      try {
        generating = C.isGenerating();
      } catch (e) {
        /* ignore */
      }
      const cap = cfg.max > 0 ? cfg.max : A.MAX_PER_PAGE;
      say(
        "toggle " + (cfg.enabled ? "ON" : "OFF") +
          " · saved " + count + "/" + cap +
          " · census " + (baselined ? "closed" : "open") +
          " · " + (generating ? "generating" : "idle") +
          " · armed " + (armed ? "yes" : "no")
      );
      const list = assistantMessages();
      say(list.length + " assistant messages on the page · " + live.length + " watched arrive");
      if (!list.length) return finishProbe(out.concat(["No assistant message matched. That is the bug."]));

      // Every reply on the page, so a report taken while the file is three
      // answers up still says where it is. The automatic path only ever looks
      // at the newest one or two; this is a description, not a decision.
      say("--- file cards, across the whole conversation ---");
      let anywhere = 0;
      list.forEach((m, i) => {
        const found = cardsIn(widen(m));
        if (!found.length) return;
        anywhere += found.length;
        say(
          "  reply " + (i + 1) + "/" + list.length + " " +
            JSON.stringify(A.turnSignature(m.textContent).slice(0, 40)) + " — " +
            found.length + (found.length === 1 ? " card" : " cards")
        );
      });
      if (!anywhere) say("  (none anywhere — not just in the newest reply)");

      // ...then the newest one in detail, which is what the automatic path acts
      // on and therefore what its silence is about.
      const msg = list[list.length - 1];
      const sig = A.turnSignature(msg.textContent);
      say("newest reply: " + JSON.stringify(sig.slice(0, 70)));
      say("  watched arrive: " + (live.indexOf(sig) !== -1 ? "YES" : "no — nothing in it can be saved"));

      const scope = widen(msg);
      say(
        "  scope " + (scope === msg ? "= the message element" : "= " + scope.tagName.toLowerCase() + " above it") +
          ", holding " + (function () {
            try {
              return Array.from(scope.querySelectorAll(CONTROLS)).filter((el) => !C.isOurs(el)).length;
            } catch (e) {
              return "?";
            }
          })() + " controls"
      );

      const cards = cardsIn(scope);
      say("cards found: " + cards.length);
      for (const c of cards) {
        const text = (c.el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
        hover(c.el);
        const ctrl = controlIn(c.el, c.strict);
        say("  " + (c.strict ? "[by type chip] " : "[by filename] ") + JSON.stringify(text));
        say(
          "    control: " +
            (ctrl
              ? label(ctrl) + (isOpener(c.el, ctrl) ? "  (the card itself — opens a panel, then Download is chased inside it)" : "")
              : "NONE FOUND — this is why nothing is clicked")
        );
      }

      const offers = offersIn(scope);
      say("offers: " + offers.length);
      for (const o of offers)
        say("  " + JSON.stringify(o.name || "(unnamed)") + (o.ready ? "" : " — not clickable"));

      // And the raw material, so a card this failed to recognise can still be
      // recognised by a human reading the report.
      say("--- every control in the newest reply ---");
      let ctrls = [];
      try {
        ctrls = Array.from(scope.querySelectorAll(CONTROLS)).filter((el) => !C.isOurs(el));
      } catch (e) {
        /* ignore */
      }
      for (const el of ctrls.slice(0, 40)) say("  " + el.tagName.toLowerCase() + " " + label(el));
      if (!ctrls.length) say("  (none)");

      say("--- text that names a file or a type ---");
      let hits = 0;
      try {
        for (const el of scope.querySelectorAll(CARD_SCOPE)) {
          if (C.isOurs(el) || el.children.length) continue; // leaves only
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!t || t.length > CARD_MAX_TEXT) continue;
          const kind = A.fileNameIn(t) ? "filename" : A.isTypeChip(t) ? "type chip" : null;
          if (!kind) continue;
          if (hits++ > 20) break;
          say("  " + kind + ": " + JSON.stringify(t));
        }
      } catch (e) {
        /* ignore */
      }
      if (!hits) {
        say("  (none — no filename and no file-type chip anywhere in the reply)");
        // Then the card, whatever it is, is saying something this doesn't
        // recognise. Print the short pieces of text in the reply so what it
        // DOES say can be read off the report instead of guessed at.
        say("--- short pieces of text in the reply, in order ---");
        let n = 0;
        try {
          for (const el of scope.querySelectorAll(CARD_SCOPE)) {
            if (C.isOurs(el) || el.children.length) continue;
            const t = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (!t || t.length > 60) continue;
            if (n++ > 25) break;
            say("  " + JSON.stringify(t));
          }
        } catch (e) {
          /* ignore */
        }
        if (!n) say("  (none)");
      }
    } catch (e) {
      say("probe threw: " + String((e && e.message) || e));
    }
    return finishProbe(out);
  }

  /**
   * Press it now, on the reply that's on screen, and say what happened.
   *
   * Every gate off: no census, no live rule, no waiting for a turn to land.
   * Those exist so this never saves a chat's backlog unasked — but you asking
   * for this file, on this reply, in front of you, is not unasked. It runs the
   * SAME code the automatic path runs, which is the point: if this saves the
   * file, the finding and the clicking work and the gates are what held it; if
   * it doesn't, it says which step failed and there is nothing left to guess at.
   */
  function tryNow() {
    const out = [];
    const say = (s) => out.push(s);
    try {
      if (!A || !C) return finishProbe(["The page's modules didn't load — nothing here is running."]);
      const list = assistantMessages();
      if (!list.length)
        return finishProbe(["No assistant reply found on this page. Nothing to take a file from."]);

      // The WHOLE conversation, newest first — not just the newest reply. The
      // automatic path is deliberately restricted to the last reply or two,
      // because a watcher reading the whole transcript would resurrect a chat's
      // history every time you scrolled. You pressing this is not that: the
      // file you want is often several answers back, under whatever was said
      // after it.
      let msg = null;
      let scope = null;
      let cards = [];
      let offers = [];
      let back = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const sc = widen(list[i]);
        const found = offersIn(sc);
        if (!found.length && i !== list.length - 1) continue;
        msg = list[i];
        scope = sc;
        cards = cardsIn(sc);
        offers = found;
        back = list.length - 1 - i;
        if (found.length) break;
      }
      say(
        (back === 0 ? "Newest reply" : back + " replies back") + ", of " + list.length +
          " on the page: " + JSON.stringify(A.turnSignature(msg.textContent).slice(0, 60))
      );

      say(cards.length + (cards.length === 1 ? " file card found" : " file cards found"));
      if (!offers.length) {
        say("Nothing to press — no control anywhere in this conversation reads as a way to save a file.");
        for (const c of cards)
          say("  card " + JSON.stringify((c.el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60)) +
            " — " + (c.strict ? "found by its file type, so only a control that says Download counts" : "found by its filename") +
            ", and it has none");
        say("Scroll the file's own reply into view and press this again — claude.ai unmounts");
        say("messages that scroll out of sight, so one out of view isn't on the page at all.");
        return finishProbe(out);
      }

      const take = offers.filter((o) => o.ready);
      say(offers.length + " offered, " + take.length + " ready to press");
      for (const o of offers)
        say("  " + JSON.stringify(o.name || "(unnamed)") + " — " + label(o.node) +
          (o.ready ? "" : " — already pressed this page load") +
          (o.opener ? " — the card itself, so Download gets chased into whatever it opens" : ""));
      if (!take.length) return finishProbe(out.concat(["Nothing left to press — reload the page to start over."]));

      // Remembered, so the automatic path doesn't come back and press it again.
      const keys = A.offerKeys(A.turnSignature(msg.textContent), offers.map((o) => o.name));
      offers.forEach((o, i) => {
        if (o === take[0] && keys[i] && seen.indexOf(keys[i]) === -1) seen.push(keys[i]);
      });
      say("Pressing it now. If a panel opens, Download is looked for inside it and pressed too.");
      save(take[0]);
    } catch (e) {
      say("threw: " + String((e && e.message) || e));
    }
    return finishProbe(out);
  }

  function finishProbe(lines) {
    const text = lines.join("\n").slice(0, PROBE_MAX);
    try {
      chrome.storage?.local.set({ [PROBE_KEY]: { at: Date.now(), text: text } });
    } catch (e) {
      /* ignore */
    }
    return text;
  }

  // ---- Toast -------------------------------------------------------------
  let toastEl = null;
  let toastTimer = null;
  function toast(msg) {
    try {
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.id = "cum-dl-toast";
        (document.body || document.documentElement).appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.classList.add("cum-ac-show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("cum-ac-show"), 2600);
    } catch (e) {
      /* ignore */
    }
  }

  // ---- Config ------------------------------------------------------------
  function applyCfg(value) {
    const prev = cfg.enabled;
    cfg = Object.assign({ enabled: false, max: A ? A.MAX_PER_PAGE : 20 }, value || {});
    // Turning it back on clears the cap and re-takes the census: the files on
    // screen while it was off are ones you chose not to have saved. The turn
    // tracking goes with it — only a reply that lands from now on counts, so
    // the answer sitting on screen when you flick the switch stays where it is.
    if (cfg.enabled && !prev) {
      count = 0;
      toldCap = false;
      baselined = false;
      live = [];
      armed = false;
      before = "";
      settleUntil = 0;
    }
  }

  function loadCfg() {
    try {
      chrome.storage?.local.get([CFG_KEY], (res) => applyCfg(res && res[CFG_KEY]));
    } catch (e) {
      /* ignore */
    }
  }

  try {
    chrome.storage?.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[CFG_KEY]) applyCfg(changes[CFG_KEY].newValue);
    });
  } catch (e) {
    /* ignore */
  }

  // The worker nudges every claude.ai tab on the same channel the other
  // clickers use, so this keeps working in a tab that isn't in front.
  try {
    chrome.runtime?.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg === "cum-ac-poll") tick();
      if (msg === "cum-dl-probe" || (msg && msg.type === "cum-dl-probe")) {
        sendResponse({ ok: true, text: probe() });
        return true;
      }
      if (msg === "cum-dl-try" || (msg && msg.type === "cum-dl-try")) {
        sendResponse({ ok: true, text: tryNow() });
        return true;
      }
    });
  } catch (e) {
    /* ignore */
  }

  loadCfg();
  setInterval(tick, SELF_POLL_MS);
})();
