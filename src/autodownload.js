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
  const ESCAPE_MS = 700; // let a click land before dismissing any menu it opened
  const SETTLE_MS = 20000; // how long a just-landed reply is still settling

  let cfg = { enabled: false, max: A ? A.MAX_PER_PAGE : 20 };
  let seen = []; // keys handled this page load (saved, or adopted by the census)
  let count = 0; // files actually saved this page load
  let lastAt = 0;
  let baselined = false;
  let where = ""; // the conversation this ledger belongs to
  let toldCap = false;

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
  function assistantMessages() {
    for (const sel of ASSISTANT_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      const list = Array.from(nodes).filter((el) => !C.isOurs(el));
      if (list.length) return list;
    }
    return [];
  }

  // One step out from the element claude.ai marks as the message, so long as
  // that step doesn't swallow a second reply. An attachment is often drawn as a
  // sibling of the prose rather than inside it, and a watcher looking only at
  // the prose would never see the card at all.
  function repliesIn(el) {
    let n = 0;
    for (const sel of ASSISTANT_SELECTORS) {
      try {
        n = Math.max(n, el.querySelectorAll(sel).length);
      } catch (e) {
        /* ignore */
      }
    }
    return n;
  }
  function widen(msgEl) {
    let scope = msgEl;
    // Climb while the ancestor still holds this reply and no other. That is the
    // turn's own wrapper, whatever claude.ai calls it this month, and the
    // attachment is inside it even when it is outside the prose.
    for (let i = 0; i < 4; i++) {
      const p = scope.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      if (repliesIn(p) > 1) break;
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
  const CARD_SCOPE = "div,span,a,li,article,section,figure";
  const CARD_MAX_TEXT = 120; // a card says a filename and a size, not a sentence
  function cardsIn(root) {
    const cards = [];
    let nodes;
    try {
      nodes = root.querySelectorAll(CARD_SCOPE);
    } catch (e) {
      return cards;
    }
    const named = [];
    for (const el of nodes) {
      if (C.isOurs(el)) continue;
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length > CARD_MAX_TEXT) continue;
      // Recognised by its FILENAME, and by nothing else. Requiring a control
      // here is what made a card whose download button only exists under the
      // pointer invisible to this: it had no control, so it was not a card, so
      // it was never hovered, so it never got one. Chicken, meet egg.
      if (!A.fileNameIn(text)) continue;
      named.push(el);
    }
    // Start at the innermost thing that names the file — usually the label
    // inside the card — then climb to the nearest ancestor that has a control
    // on it. The label is a sibling of the download button, not its parent, so
    // stopping at the label finds nothing to press; and stopping at the first
    // ancestor with a filename would stop at the label too.
    const CONTROLS = 'button,[role="button"],a[download],a[href^="blob:"]';
    for (const start of named) {
      if (named.some((o) => o !== start && start.contains(o))) continue; // not innermost
      // How far out the card can be: a card says the filename and little else —
      // a size, a file type, a bullet between them. Once the text runs past
      // that, the climb has left the card and is into the prose around it, and
      // a "card" that is really a paragraph would hand back whatever button
      // happened to be in the same reply.
      const name = A.fileNameIn(start.textContent) || "";
      const room = Math.min(CARD_MAX_TEXT, name.length + 40);
      let card = start;
      for (let i = 0; i < 3; i++) {
        try {
          if (card.querySelector(CONTROLS)) break;
        } catch (e) {
          break;
        }
        const p = card.parentElement;
        if (!p) break;
        const t = (p.textContent || "").replace(/\s+/g, " ").trim();
        if (t.length > room) break;
        card = p;
      }
      if (!cards.some((c) => c === card || c.contains(card))) cards.push(card);
    }
    return cards.filter((el) => !cards.some((other) => other !== el && el.contains(other)));
  }

  // The control on a card that saves the file, best first. A card with exactly
  // one control at all is that control: an icon-only download button is the
  // ordinary shape, and refusing to press the only thing on a card that plainly
  // holds a file is refusing to do the job.
  function controlIn(card) {
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
    // The last resort — press the only thing on the card — applies only to a
    // card that is a card: a filename and a size. On anything bigger, "the only
    // button" could be anything at all.
    const small = (card.textContent || "").replace(/\s+/g, " ").trim().length <= CARD_MAX_TEXT;
    return (
      named(buttons, A.isSaveLabel) ||
      named(buttons, A.mentionsSave) ||
      (small && buttons.length === 1 ? buttons[0] : null)
    );
  }

  // Every file this reply is offering. Document order, and everything that
  // matched — including what can't be clicked yet — because that order is what
  // the keys are numbered against where a control carries no filename, and a
  // list that dropped its clicked entries would renumber the rest.
  function offersIn(msgEl) {
    const found = [];
    const nodes = new Set();
    const add = (node, name) => {
      if (!node || nodes.has(node) || C.isOurs(node)) return;
      nodes.add(node);
      found.push({ node, name: name || cardName(node), ready: ready(node) });
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
        let ctrl = controlIn(card);
        if (!ctrl) {
          hover(card); // a control drawn only under the pointer
          ctrl = controlIn(card);
        }
        if (ctrl) add(ctrl, A.fileNameIn(card.textContent));
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
        offers.push({ key: keys[i], name: f.name, node: f.node, ready: f.ready })
      );
    }
    return offers;
  }

  function save(offer) {
    lastAt = Date.now();
    count++;
    try {
      offer.node.setAttribute("data-cum-dl", "1");
    } catch (e) {
      /* the ledger key is the real guard; this is the belt to its braces */
    }
    try {
      offer.node.click();
    } catch (e) {
      return; // one that won't click is a file not saved, and nothing more
    }
    // A control that opens a menu instead of saving leaves it open, and a stray
    // popup would sit over the conversation you're reading.
    setTimeout(() => {
      try {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
      } catch (e) {
        /* ignore */
      }
    }, ESCAPE_MS);
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
      (baselined ? "" : " · census open");
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
    chrome.runtime?.onMessage.addListener((msg) => {
      if (msg === "cum-ac-poll") tick();
    });
  } catch (e) {
    /* ignore */
  }

  loadCfg();
  setInterval(tick, SELF_POLL_MS);
})();
