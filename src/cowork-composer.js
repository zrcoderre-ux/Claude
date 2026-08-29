/**
 * Claude Usage Meter — Cowork send driver (ISOLATED world content script).
 *
 * Cowork gets its own send path, parallel to the Chat one in src/composer.js.
 * The standing rule: nothing built for Chat is assumed to work on Cowork until
 * it has been SEEN working on Cowork. The run that taught this switched its
 * model and then silently did nothing else — the project was never chosen and
 * the message never left, because everything after the model menu was Chat
 * plumbing being trusted on a surface that had never confirmed it.
 *
 * What this driver borrows from src/composer.js is only what is either
 * surface-agnostic mechanics (sleep, robustClick, menu open/close, visibility)
 * or has been confirmed working on Cowork itself:
 *   - the Chat/Cowork toggle (selectSurface — built for and proved on Cowork),
 *   - the model menu (selectModel — seen switching models on a live Cowork run).
 * The approval control is READ (its label is part of the surface evidence) and
 * never touched: the mode is sticky, so leaving it alone is leaving it on
 * whatever was last chosen by hand.
 * Everything else — choosing the project, attaching files, confirming the
 * attachments, typing the prompt, pressing send, and proving the message left —
 * is done here, with Cowork's own evidence, and reported phase by phase so a
 * run that stops says exactly WHERE it stopped instead of stopping silently.
 *
 * The decisions (which phases apply, what counts as an attachment landing,
 * what counts as a message leaving) live in src/cowork.js, pure and tested.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  const K = window.CUMCowork;
  if (!C || !K) return;

  const sleep = C.sleep;
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

  /**
   * Should this driver take the send? Yes when the job asks for Cowork, when
   * the page is a Cowork address, or when the composer in front of us is on
   * Cowork and the job expressed no preference. A job that asks for Chat is
   * never ours — the Chat driver flips the toggle itself.
   */
  function applies(o) {
    const j = o || {};
    const want = K.surfaceFromLabel(j.surface || "");
    if (want === "chat") return false;
    if (want === "cowork") return true;
    if (K.isCoworkUrl(location.href)) return true;
    try {
      return C.currentSurface() === "cowork";
    } catch (e) {
      return false;
    }
  }

  // ---- Cowork's composer ---------------------------------------------------

  // The box the editor lives in. The editor's near ancestors are PROVED too
  // narrow on this UI — a live dump showed ed.parentElement.parentElement
  // holding zero buttons, with no <form> and no class*="composer" anywhere
  // above it — so walk up until the box actually contains composer furniture
  // (a button, or the file input), and fall back to the whole body rather
  // than to a box that holds nothing.
  function scopeOf() {
    const ed = C.findEditor();
    if (!ed) return document.body || document;
    let el = ed.parentElement;
    for (let i = 0; el && i < 8; i++) {
      try {
        if (el.querySelector('button,input[type="file"]')) return el;
      } catch (e) {
        break;
      }
      el = el.parentElement;
    }
    return document.body || document;
  }

  // Chip-ish markup, counted page-wide minus our own UI. Chat's counter looks
  // inside a composer scope this UI does not have; the baseline delta taken in
  // attachFiles is what keeps page-wide counting honest — only chips that
  // APPEAR during the attach vouch for it.
  function pageChips() {
    const counts = [0];
    for (const sel of [
      '[data-testid="file-thumbnail"]',
      '[data-testid*="attachment" i]',
      '[data-testid*="file-chip" i]',
      "button h3",
    ]) {
      let n = 0;
      try {
        for (const el of document.querySelectorAll(sel)) if (!C.isOurs(el)) n++;
      } catch (e) {
        continue;
      }
      counts.push(n);
    }
    return Math.max.apply(null, counts);
  }

  // How many of these files' names the page is visibly carrying, counted on
  // leaf nodes anywhere except our own UI. Page-wide, deliberately: the live
  // run that forced this reported "0 filename(s)" on a composer the operator
  // could SEE holding the file — Cowork renders its chips outside every
  // container the editor anchors, so a scan scoped to the editor's box misses
  // them. The baseline delta (taken before the attach) keeps anything already
  // on the page — a project knowledge file, a note in our own pill — from
  // vouching for a new attachment. Truncation-tolerant: see CUMCowork.nameSeen.
  function namedCount(files) {
    let els;
    try {
      els = document.querySelectorAll("button,h3,span,div,[title]");
    } catch (e) {
      return 0;
    }
    // Chip containers, read WHOLE. A chip can spread its caption across
    // sibling spans (a truncation component renders the start and the end as
    // separate leaves), and then no single leaf carries enough of the name to
    // vouch for it.
    let chips;
    try {
      chips = document.querySelectorAll(
        '[data-testid="file-thumbnail"],[data-testid*="attachment" i],[data-testid*="file-chip" i],button'
      );
    } catch (e) {
      chips = [];
    }
    let n = 0;
    for (const f of files) {
      if (!f || !f.name) continue;
      let hit = false;
      for (const el of els) {
        if (el.children && el.children.length) continue; // leaves carry the caption
        if (C.isOurs(el)) continue;
        const title = (el.getAttribute && el.getAttribute("title")) || "";
        if (K.nameSeen(el.textContent || "", f.name) || K.nameSeen(title, f.name)) {
          hit = true;
          break;
        }
      }
      for (const el of hit ? [] : chips) {
        if (C.isOurs(el)) continue;
        if (K.nameSeen(el.textContent || "", f.name)) {
          hit = true;
          break;
        }
      }
      if (hit) n++;
    }
    return n;
  }

  function humanTurns() {
    let n = 0;
    for (const sel of [
      '[data-testid="user-message"]',
      ".font-user-message",
      '[data-testid="human-message"]',
    ]) {
      try {
        n = Math.max(n, document.querySelectorAll(sel).length);
      } catch (e) {
        /* try the next shape */
      }
    }
    return n;
  }

  // The send control. Cowork's composer starts a TASK: its button reads
  // "Start Task" where Chat's reads "Send message" — named by the operator
  // off the live page, after a run found nothing wearing any of Chat's
  // labels. Captions are judged by CUMCowork.isSendCaption (letters alone,
  // prefix-anchored, so "Restart task" can never press as sending), on the
  // aria-label and the visible text both, in the composer's box first and
  // page-wide after; Chat's shapes stay in the cascade for the day the two
  // surfaces converge.
  function findSendControl(scope) {
    const byCaption = (root) => {
      let list;
      try {
        list = (root || document).querySelectorAll('button,[role="button"]');
      } catch (e) {
        return null;
      }
      for (const el of list) {
        if (C.isOurs(el) || !C.isVisible(el)) continue;
        const aria = (el.getAttribute && el.getAttribute("aria-label")) || "";
        if (K.isSendCaption(aria) || K.isSendCaption(el.textContent)) return el;
      }
      return null;
    };
    const inScope = (sel) => {
      let list;
      try {
        list = (scope || document).querySelectorAll(sel);
      } catch (e) {
        return null;
      }
      for (const el of list) if (!C.isOurs(el) && C.isVisible(el)) return el;
      return null;
    };
    return (
      byCaption(scope) ||
      byCaption(document) ||
      inScope('button[aria-label*="send" i]') ||
      inScope('[data-testid="send-button"]') ||
      inScope('button[type="submit"]') ||
      C.findSend()
    );
  }

  // ---- choosing the project ------------------------------------------------

  // The containers a popup can arrive in, censused so "opened" can be read off
  // the page even when the rows wear no role at all — which Cowork's project
  // menu has done on a live run.
  const POPUP =
    '[role="menu"],[role="listbox"],[role="dialog"],[data-state="open"],[data-radix-popper-content-wrapper]';
  function popupCensus() {
    try {
      return new Set(Array.from(document.querySelectorAll(POPUP)));
    } catch (e) {
      return new Set();
    }
  }
  function newPopup(before) {
    let all;
    try {
      all = Array.from(document.querySelectorAll(POPUP));
    } catch (e) {
      return null;
    }
    const fresh = all.filter((el) => !before.has(el) && !C.isOurs(el) && C.isVisible(el));
    return fresh.find((el) => !fresh.some((o) => o !== el && o.contains(el))) || null;
  }

  /**
   * Open the project menu on Cowork — its own gestures, not Chat's. The live
   * failure this answers: C.openMenu clicked the trigger both ways and gave
   * up with aria-expanded still "false". So this escalates through every way
   * a popup trigger can be asked to open — the shared pointer click; the same
   * sequence stamped pointerType "mouse", which a picky handler can demand
   * and a synthetic PointerEvent doesn't carry by default; a native click;
   * then the keyboard the ARIA pattern promises (Enter, Space, ArrowDown) —
   * and it reads "opened" off the page three ways: a NEW popup container, new
   * role'd rows, or the trigger's own aria-expanded. Returns { box, why }.
   */
  async function openProjectMenu(trigger) {
    const rowsBefore = C.menuItems().length;
    const before = popupCensus();
    const opened = () => {
      const fresh = newPopup(before);
      if (fresh) return fresh;
      const rows = C.menuItems();
      if (rows.length > rowsBefore) {
        const holder = (el) => el && rows.some((r) => el.contains(r));
        return (
          Array.from(
            document.querySelectorAll('[role="listbox"],[role="menu"],[role="dialog"]')
          ).find(holder) || null
        );
      }
      return null;
    };
    const key = (type, k, code, keyCode) => {
      try {
        trigger.dispatchEvent(
          new KeyboardEvent(type, {
            key: k,
            code: code,
            keyCode: keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true,
          })
        );
      } catch (e) {
        /* the report below is the point */
      }
    };
    const focusFirst = () => {
      try {
        trigger.focus();
      } catch (e) {
        /* ignore */
      }
    };
    const mouseTyped = () => {
      const r = trigger.getBoundingClientRect();
      const p = {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        pointerId: 1,
        isPrimary: true,
        pointerType: "mouse",
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      };
      for (const [Ctor, type] of [
        [PointerEvent, "pointerdown"],
        [MouseEvent, "mousedown"],
        [PointerEvent, "pointerup"],
        [MouseEvent, "mouseup"],
        [MouseEvent, "click"],
      ]) {
        try {
          trigger.dispatchEvent(new Ctor(type, p));
        } catch (e) {
          /* ignore */
        }
      }
    };
    const gestures = [
      ["a pointer click", () => C.robustClick(trigger)],
      ["a mouse-typed pointer click", mouseTyped],
      [
        "a native click",
        () => {
          try {
            if (typeof trigger.click === "function") trigger.click();
          } catch (e) {
            /* ignore */
          }
        },
      ],
      ["Enter", () => (focusFirst(), key("keydown", "Enter", "Enter", 13), key("keyup", "Enter", "Enter", 13))],
      ["Space", () => (focusFirst(), key("keydown", " ", "Space", 32), key("keyup", " ", "Space", 32))],
      [
        "ArrowDown",
        () => (focusFirst(), key("keydown", "ArrowDown", "ArrowDown", 40), key("keyup", "ArrowDown", "ArrowDown", 40)),
      ],
    ];
    const tried = [];
    for (const g of gestures) {
      tried.push(g[0]);
      g[1]();
      for (let i = 0; i < 8; i++) {
        await sleep(150);
        const box = opened();
        if (box) return { box: box, why: "" };
      }
      // Says open but nothing found yet — a menu still rendering gets longer.
      if (trigger.getAttribute && trigger.getAttribute("aria-expanded") === "true") {
        for (let i = 0; i < 8; i++) {
          await sleep(200);
          const box = opened();
          if (box) return { box: box, why: "" };
        }
      }
    }
    const attr = (n) => (trigger.getAttribute && trigger.getAttribute(n)) || "unset";
    return {
      box: null,
      why:
        "would not open for " + tried.join(", ") +
        " (aria-haspopup " + JSON.stringify(attr("aria-haspopup")) +
        ", aria-expanded ended " + JSON.stringify(attr("aria-expanded")) + ")",
    };
  }

  /**
   * Ask the worker to make this tab the visible one in its own window.
   *
   * Only the worker can do it, and only it knows whether doing it would take
   * the screen from you: a window that isn't focused can change its visible tab
   * with nothing moving in front of anyone. Answers always — `{ ok, why }` or
   * `{ ok: false, error }` — because a caller that cannot tell "no" from
   * "no answer" reports neither.
   */
  function showThisTab() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      // The worker can be asleep; it wakes on the message, but a send that
      // never lands must not hold the phase open.
      setTimeout(() => finish({ ok: false, error: "the extension's worker didn't answer" }), 8000);
      try {
        chrome.runtime.sendMessage({ type: "cum-show-tab" }, (res) => {
          if (chrome.runtime.lastError || !res)
            return finish({
              ok: false,
              error:
                (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
                "the extension's worker didn't answer",
            });
          finish(res);
        });
      } catch (e) {
        finish({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  /**
   * Choose a project from Cowork's menu, the wide way. The Chat driver's
   * version looked at literal <button> elements only; when claude.ai stops
   * rendering one, that version reports an empty page and the job sails on
   * without its project. Here anything that behaves like a menu trigger
   * counts — button, [role="button"], [role="combobox"] — and a failure names
   * the captions that WERE on the page, so the next shape change is a small
   * edit rather than an investigation.
   *
   * The rows that navigate away ("Create new project", "View all projects")
   * stay excluded by name; during an unattended send a click that navigates is
   * not a near miss, it is the end of the run. Returns { ok, why }.
   */
  async function selectProject(name) {
    // A stored name can carry an old scrape's debris ("…Toggle chats for …");
    // matching forgives that, but the FILTER doesn't — typing the corrupted
    // string filters the list down to nothing. So the cleaned name is what
    // gets typed, matched, and reported. See K.wantedProjectName.
    name = K.wantedProjectName(name);
    const caption = (b) =>
      norm(b.textContent) || norm(b.getAttribute && b.getAttribute("aria-label"));
    const opensAMenu = (b) =>
      (b.hasAttribute &&
        (b.hasAttribute("aria-haspopup") ||
          b.hasAttribute("aria-expanded") ||
          b.hasAttribute("aria-controls"))) ||
      (b.getAttribute && String(b.getAttribute("role")).toLowerCase() === "combobox");
    const candidates = Array.from(
      document.querySelectorAll('button,[role="button"],[role="combobox"]')
    ).filter((b) => !C.isOurs(b) && C.isVisible(b) && opensAMenu(b));

    const already = candidates.find((b) => K.projectTriggerIs(caption(b), name));
    if (already) return { ok: true, why: "the trigger already reads " + JSON.stringify(name) };
    // EVERY control captioned like a project trigger, not just the first — a
    // live run found a trigger, clicked it both ways, and the menu never
    // opened; when there are two (a pre-mounted twin from another layout is
    // claude.ai's habit), the first may be the dead one.
    const triggers = candidates.filter((b) => K.isProjectTriggerCaption(caption(b)));
    if (!triggers.length)
      return {
        ok: false,
        why:
          "no project menu — none of the " + candidates.length +
          " menu controls on the page is captioned like one (saw " +
          JSON.stringify(candidates.map(caption).filter(Boolean).slice(0, 12).join(" | ")) +
          ")",
      };

    // Only ever inside the menu — falling back to the document would find the
    // composer's own editor and type the project's name into the prompt.
    let box = null;
    const attempts = [];
    let openedWith = null;
    for (const t of triggers) {
      const got = await openProjectMenu(t);
      if (got.box) {
        box = got.box;
        openedWith = t;
        break;
      }
      attempts.push(JSON.stringify(caption(t) || "(uncaptioned)") + " " + got.why);
      C.closeMenu();
    }
    if (!box)
      return {
        ok: false,
        why: "the project menu never opened — " + attempts.join(" · "),
      };
    // The menu's own words, read straight off it — the one reading that can't
    // be fooled by rows wearing no menu role.
    const menuText = () => {
      try {
        return norm(box.textContent);
      } catch (e) {
        return "";
      }
    };
    // An open menu is not a loaded one. Cowork fetches the project list from
    // the server and mounts skeleton rows captioned "Loading" while it waits;
    // read in that moment the menu has no rows, no filter box, and nothing to
    // match. The run that taught this stood down after two and a half seconds
    // with 'no row named "Draft Tentative Rulings" among ""' while the menu was
    // saying "Loading" twelve times over. So the wait comes FIRST, and every
    // read below — the filter box included, since it mounts with the list —
    // happens on a settled menu. See K.menuStillLoading.
    const waitStarted = Date.now();
    const untilLoaded = async (ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until && K.menuStillLoading(menuText())) await sleep(250);
      return !K.menuStillLoading(menuText());
    };
    // A list that is merely slow arrives inside this.
    let loaded = await untilLoaded(6000);
    // …and one that is behind a hidden tab never does. The second run to hit
    // this waited thirty-three seconds on twelve "Loading" rows: the list loads
    // when the tab is in front and NEVER while it is behind, so the remedy is
    // to be looked at, not to wait longer. The worker makes this tab the
    // visible one in its OWN window — which is enough for the page, since a
    // window that isn't focused still has a visible tab — and refuses outright
    // where that window is the one you are working in. See K.menuNeedsTheTab.
    let tabNote = "";
    if (!loaded && K.menuNeedsTheTab(document.visibilityState, menuText())) {
      const shown = await showThisTab();
      tabNote = shown.ok
        ? "the tab was in the background, so it was brought to the front of its own window (" +
          (shown.why || "shown") + ")"
        : "the tab was in the background and could not be brought forward — " +
          (shown.error || "no reason given");
      if (shown.ok) {
        // Being visible is not instant, and the page has to see it happen.
        for (let i = 0; i < 16 && document.visibilityState !== "visible"; i++) await sleep(250);
        loaded = await untilLoaded(6000);
        // Still placeholders with the tab in front: the query this menu is
        // waiting on was never going to start. Close it and open it again —
        // a fresh mount asks again, which waiting cannot.
        if (!loaded && openedWith) {
          C.closeMenu();
          await sleep(600);
          const again = await openProjectMenu(openedWith);
          if (again.box) box = again.box;
          tabNote += "; the menu was closed and opened again";
          loaded = await untilLoaded(12000);
        }
      }
    }
    // Whatever happened above, give a list that is still arriving its last few
    // seconds before anything is read off the menu.
    if (!loaded) await untilLoaded(8000);
    const waited = Math.round((Date.now() - waitStarted) / 1000);
    // A long list renders only what fits, so the filter isn't a nicety: a
    // project far down it is not in the page to be clicked until typing brings
    // it there.
    // Polled, not read once: the box mounts WITH the list, so a menu that has
    // only just stopped saying "Loading" can be a beat short of having one.
    const findFilter = () => box.querySelector('input:not([type="hidden"]), [contenteditable="true"]');
    let filter = findFilter();
    for (let i = 0; i < 8 && !filter; i++) {
      await sleep(250);
      filter = findFilter();
    }
    // What the search box actually holds — read back, never assumed. A live
    // run showed the menu at "No matches" straight through the clear-and-retry
    // pass: a React-controlled input takes execCommand's edits into the DOM
    // and reads its own state back over them, so the box LOOKED handled and
    // held whatever it held. The read-back is what makes the report honest.
    const readBox = () => {
      if (!filter) return "";
      if ("value" in filter) return String(filter.value || "");
      return String(filter.textContent || "");
    };
    // Write the box through the element's OWN value setter — the one React
    // hooks — then say the input event happened. This is the only write that
    // both changes a controlled input and makes its owner believe it.
    const setBox = (text) => {
      if (!filter) return;
      try {
        filter.focus();
        if ("value" in filter) {
          let set = null;
          try {
            const proto = Object.getPrototypeOf(filter);
            const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
            if (desc && desc.set) set = desc.set;
          } catch (e) {
            /* fall through to the plain assignment */
          }
          if (set) set.call(filter, text);
          else filter.value = text;
          filter.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          if (document.execCommand) {
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, text);
          }
        }
      } catch (e) {
        /* the read-back below reports what actually landed */
      }
    };
    if (filter) {
      setBox(name);
      await sleep(700);
      // Not what was asked for — one more attempt, then the report says what
      // the box held rather than what was typed at it.
      if (readBox() !== name) {
        setBox(name);
        await sleep(700);
      }
    }

    let lastSeen = [];
    const rowOf = () => {
      const seen = [];
      for (const el of box.querySelectorAll(
        '[role="option"],[role="menuitem"],[role="menuitemradio"]'
      )) {
        if (C.isOurs(el)) continue;
        const t = el.textContent || "";
        // Everything is RECORDED, excluded rows included — a report that
        // dropped them before writing them down once claimed an empty menu
        // ("among \"\"") while rows were sitting in it.
        seen.push(norm(t).slice(0, 40));
        if (!K.isProjectRow(t)) continue; // never "Create new project" — it navigates
        if (K.projectRowMatches(t, name)) return el;
      }
      lastSeen = seen;
      return null;
    };
    // The rows may carry no menu role at all — a live menu answered every
    // role-based scan with nothing while visibly listing projects. This match
    // is by the project's OWN NAME, innermost element first, and presses the
    // clickable thing that name sits on; the navigating rows stay excluded,
    // and nothing that doesn't say the name is ever pressed.
    const wideRowOf = () => {
      let best = null;
      let list;
      try {
        list = box.querySelectorAll('button,[role="button"],a,li,div,span');
      } catch (e) {
        return null;
      }
      for (const el of list) {
        if (C.isOurs(el)) continue;
        const t = el.textContent || "";
        if (!K.isProjectRow(t)) continue;
        if (!K.projectRowMatches(t, name)) continue;
        if (!best || best.contains(el)) best = el;
      }
      if (!best || best === box) return null;
      const clickable =
        best.closest &&
        best.closest('button,[role="button"],a,li,[role="option"],[role="menuitem"]');
      // Never climb OUT of the menu: a wrapper found above the box is not a
      // row, and pressing it is pressing the unknown.
      return clickable && box.contains(clickable) && clickable !== box ? clickable : best;
    };
    let row = rowOf();
    for (let i = 0; i < 20 && !row; i++) {
      await sleep(250);
      row = rowOf();
    }
    if (!row) row = wideRowOf();
    // No filter box means no clear-and-retry pass below, and a menu that only
    // just stopped saying "Loading" renders its rows a beat after it. Without
    // this the unfiltered path was the SHORTEST one on the page — the least
    // patience given to exactly the menu that had least to show.
    if (!row && !filter) {
      for (let i = 0; i < 10 && !row; i++) {
        await sleep(500);
        row = rowOf();
      }
      if (!row) row = wideRowOf();
    }
    // A filter that left NOTHING is evidence against the box's contents, not
    // against the list. Clear it — through the controlled-input write, and
    // VERIFIED, because an unverified clear once left "No matches" standing
    // through this whole pass — and read the list plain before giving up. A
    // server-backed list re-renders slowly, so the cleared list gets real time.
    if (!row && filter) {
      setBox("");
      await sleep(1200);
      if (readBox() !== "") {
        setBox("");
        await sleep(1200);
      }
      row = rowOf();
      for (let i = 0; i < 8 && !row; i++) {
        await sleep(250);
        row = rowOf();
      }
      if (!row) row = wideRowOf();
    }
    if (!row) {
      // What the menu actually displayed, read straight off it — the report
      // that can't be fooled by rows wearing no role. If this still fails,
      // the note carries the menu's own words instead of a guess.
      const full = menuText();
      const shown = full.slice(0, 160);
      // ...and what the search box was left holding, read off the element.
      // "" after a verified clear plus a menu still saying nothing means the
      // LIST is the problem; the name still sitting there means the clear is.
      const held = readBox();
      // A menu still showing placeholders never got as far as having rows, and
      // saying "no row named X" of it blames the project for the list's
      // lateness. Name what actually happened, so the next run's fix is a
      // longer wait rather than a hunt for a project that was always there.
      const stalled = K.menuStillLoading(full);
      C.closeMenu();
      return {
        ok: false,
        why: stalled
          ? "the project menu never finished loading — still placeholders after " +
            Math.round((Date.now() - waitStarted) / 1000) + "s" +
            (tabNote ? " (" + tabNote + ")" : "") +
            "; the menu's own text: " + JSON.stringify(shown)
          : "no row named " + JSON.stringify(name) + " among " +
            JSON.stringify(lastSeen.join(" | ")) +
            (filter
              ? " (filtered, then cleared — the box was left holding " + JSON.stringify(held) + ")"
              : " (no filter box found" +
                (waited ? "; the menu stopped saying Loading after " + waited + "s" : "") +
                ")") +
            " — the menu's own text: " + JSON.stringify(shown),
      };
    }
    C.robustClick(row);

    // Believed only when a trigger comes round to reading the name — a menu
    // that closed is not a project that was chosen.
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      const live = Array.from(
        document.querySelectorAll('button,[role="button"],[role="combobox"]')
      ).filter((b) => !C.isOurs(b));
      if (live.some((b) => K.projectTriggerIs(caption(b), name)))
        return { ok: true, why: "chose it from the menu" };
    }
    C.closeMenu();
    return { ok: false, why: "clicked the row but no control came to read " + JSON.stringify(name) };
  }

  // ---- attaching, with Cowork's evidence -----------------------------------

  /**
   * Attach `files` and confirm they landed. Chat's confirmation leans on the
   * upload responses inject.js sees; Cowork's uploads run inside its worker
   * where no hook reaches, so here the confirmations are welcome when they
   * arrive and never waited on: the composer visibly carrying the files —
   * chips, or the filenames themselves — is the evidence that exists. See
   * CUMCowork.attachOutcome for the decision.
   */
  async function attachFiles(files, timeoutMs) {
    const baseChips = pageChips();
    const baseNamed = namedCount(files);
    let uploads = 0;
    const onMsg = (event) => {
      if (event.source !== window) return;
      const m = event.data;
      if (m && m.__channel === C.CHANNEL && m.payload && m.payload.upload && m.payload.upload.success)
        uploads++;
    };
    try {
      window.addEventListener("message", onMsg);
    } catch (e) {
      /* uploads stays 0; the visible evidence still counts */
    }
    try {
      const evidence = () =>
        K.attachOutcome({
          expected: files.length,
          uploads: uploads,
          chips: pageChips() - baseChips,
          named: namedCount(files) - baseNamed,
        });
      const watch = async (ms) => {
        // The first look is polite, not instant — chips render behind the
        // attach, and markup that already happens to match must not wave the
        // files through in the first moment.
        const until = Date.now() + ms;
        await sleep(2000);
        let v = evidence();
        while (!v.ok && Date.now() < until) {
          await sleep(700);
          v = evidence();
        }
        return v;
      };

      // The input first, then a drop ON TOP of it — never one or the other.
      // Cowork has been seen taking files from the input and has also been
      // seen ignoring it; a present-but-dead input must not use up the whole
      // deadline, so it gets a short watch and the drop gets the rest.
      const input = C.findFileInput();
      let how = "";
      let verdict = { ok: false, why: "no way in was tried" };
      if (input) {
        try {
          C.setFiles(input, files);
          how = "file input";
          verdict = await watch(20000);
        } catch (e) {
          how = "file input (threw)";
        }
      }
      if (!verdict.ok) {
        const scope = scopeOf();
        C.dropFiles(scope === document ? document.body : scope, files);
        how = how ? how + ", then drop" : "drop";
        // Scaled like Chat's: twenty papers need more than two minutes.
        verdict = await watch(Math.max(timeoutMs || 120000, files.length * 15000));
      }
      // A moment more, so the send can't beat the last chip onto the composer.
      if (verdict.ok) await sleep(1500);
      return { ok: verdict.ok, how: how, why: verdict.why };
    } finally {
      try {
        window.removeEventListener("message", onMsg);
      } catch (e) {
        /* ignore */
      }
    }
  }

  // ---- the send itself -----------------------------------------------------

  // Watch for the message leaving, with Cowork's evidence — see
  // CUMCowork.sentEvidence for what counts and in what order of strength.
  async function confirmSent(hadText, humanBefore, pathBefore, hadButton) {
    for (let i = 0; i < 24; i++) {
      await sleep(400);
      const ed = C.findEditor();
      const btn = findSendControl(scopeOf());
      const ev = K.sentEvidence({
        becameSession: !!K.sessionId(location.pathname) && location.pathname !== pathBefore,
        humanGrew: humanTurns() > humanBefore,
        cleared: !!hadText && !!ed && (ed.textContent || "").trim() === "",
        // Only a control that was STANDING before the press can stand down.
        // With no control ever found this is vacuously true from the first
        // look, and would confirm an Enter that sent nothing.
        sendStoodDown: !!hadButton && (!btn || C.sendDisabled(btn)),
      });
      if (ev) return ev;
    }
    return "";
  }

  /**
   * One composed Cowork message, end to end. Same contract as the Chat
   * driver's sendMessage — { ok, error?, halted?, notes } — but every phase
   * reports, and a phase that fails fails the SEND, loudly, rather than
   * leaving a note and sailing on: a message sent into the wrong project is
   * worse than one that waits.
   */
  async function send(o) {
    const j = o || {};
    const notes = [];
    const trail = [];
    const say = (phase, outcome) => trail.push(phase + ": " + outcome);
    const story = () => "cowork send — " + trail.join("; ");
    const fail = (error) => ({ ok: false, error: error + " [" + story() + "]", notes: notes });
    const halted = () => {
      try {
        return typeof j.stop === "function" ? j.stop() : null;
      } catch (e) {
        return null;
      }
    };
    const standDown = (why) => ({ ok: false, halted: why, error: "stopped — " + why, notes: notes });

    const files = j.files || [];
    if (!j.text && !files.length) return { ok: false, error: "nothing to send", notes: notes };
    let why = halted();
    if (why) return standDown(why);

    // A Cowork page keeps booting well past document-complete; give the
    // composer real time before concluding it isn't there.
    let editor = await C.waitFor(C.findEditor, 25000);
    if (!editor) return fail("no prompt editor on this Cowork page");
    say("editor", "found");

    // The project's name, cleaned at the moment of USE. A scraped name can
    // arrive carrying the sidebar row's own furniture — "Draft Tentative
    // RulingsToggle chats for Draft Tentative Rulings" — and a run armed with
    // that name filters the project menu down to nothing and fails. Cleaning
    // here heals every config already stored, without re-arming anything.
    const J = window.CUMJobs;
    const project =
      (J && j.coworkProject ? J.cleanProjectName(j.coworkProject) : j.coworkProject) || null;

    // The toggle only exists on the composer home; inside a conversation there
    // is no surface to choose and no project menu to open.
    const onHome = !!C.findSurfaceGroup();
    const phases = K.coworkPhases({
      onSession: !onHome,
      project: !!project,
      model: !!j.model,
      files: !!files.length,
      text: !!j.text,
    });
    if (!onHome && project)
      notes.push("project not chosen — this page is already inside a conversation");

    // What the toggle was on before we touched it, for the note a changed
    // account-wide preference owes the user.
    let surfaceWas = "";

    for (const phase of phases) {
      why = halted();
      if (why) return standDown(why);

      if (phase === "surface") {
        try {
          surfaceWas = C.currentSurface();
        } catch (e) {
          surfaceWas = "";
        }
        const r = await C.selectSurface("cowork");
        if (r !== "ok")
          return fail("could not put the composer on Cowork (" + C.surfaceWhy() + ")");
        if (surfaceWas === "cowork") surfaceWas = "";
        say("surface", surfaceWas ? "switched from " + surfaceWas : "on Cowork");
        // Switching re-renders the composer; a handle held across it is stale.
        editor = (await C.waitFor(C.findEditor, 15000)) || editor;
      } else if (phase === "project") {
        const r = await selectProject(project);
        if (!r.ok)
          return fail(
            'project "' + project + '" not chosen — ' + r.why +
              " — not sent: a message that lands outside its project is worse than one that waits"
          );
        say("project", JSON.stringify(project) + " (" + r.why + ")");
      } else if (phase === "model") {
        let r;
        try {
          r = await C.selectModel(j.model);
        } catch (e) {
          r = "failed";
        }
        if (r === "ok") say("model", j.model);
        else {
          // Survivable, like on Chat: the send goes on the model the page is
          // on, and the note says so.
          notes.push('model "' + j.model + '" not selected (' + r + ") — sent on the current one");
          say("model", "not selected (" + r + ")");
        }
      } else if (phase === "attach") {
        const att = await attachFiles(files, j.uploadTimeoutMs);
        if (!att.ok)
          return fail(
            "could not confirm " + files.length + " attachment(s) landed via " + att.how +
              " — " + att.why
          );
        say("attach", files.length + " file(s) via " + att.how + " (" + att.why + ")");
        notes.push("attached " + files.length + " document(s) via " + att.how + " (" + att.why + ")");
        await sleep(600);
      } else if (phase === "prompt") {
        // Menus re-render the composer; never type into a stale handle.
        editor = C.findEditor() || editor;
        C.insertPrompt(editor, j.text);
        await sleep(400);
        const holds =
          (((C.findEditor() || editor).textContent) || "").indexOf(j.text.trim().slice(0, 8)) !== -1;
        if (!holds) return fail("typed the prompt but the editor never took it");
        say("prompt", j.text.length + " chars in the editor");
      } else if (phase === "send") {
        why = halted();
        if (why) return standDown(why);
        const scope = scopeOf();
        const humanBefore = humanTurns();
        const pathBefore = location.pathname;
        const hadText = (((C.findEditor() || editor).textContent) || "").trim();

        // claude.ai holds the control disabled until its uploads finish, which
        // is the upload gate Cowork's hidden traffic denies us — so this wait
        // is doing real work, not politeness.
        let btn = null;
        const untilEnabled = Date.now() + 30000;
        while (Date.now() < untilEnabled) {
          btn = findSendControl(scope);
          if (btn && !C.sendDisabled(btn)) break;
          await sleep(300);
        }
        // No control found is NOT the end: Enter in the editor is the
        // composer's own send and needs no button at all. The run that
        // taught this got everything right — project, attach, prompt — and
        // then died here without ever pressing the one key that would have
        // finished the job.
        if (btn && !C.sendDisabled(btn)) {
          C.robustClick(btn);
          const ev = await confirmSent(hadText, humanBefore, pathBefore, true);
          if (ev) {
            say("send", ev);
            notes.push(story());
            const left = surfaceWas ? K.surfaceLeftNote(surfaceWas, false) : "";
            if (left) notes.push(left);
            return { ok: true, notes: notes };
          }
        }
        // Enter in the editor, which claude.ai also sends on.
        const ed = C.findEditor() || editor;
        try {
          ed.focus();
          for (const t of ["keydown", "keypress", "keyup"])
            ed.dispatchEvent(
              new KeyboardEvent(t, {
                bubbles: true,
                cancelable: true,
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
              })
            );
        } catch (e) {
          /* the report below says what was observed */
        }
        const ev2 = await confirmSent(hadText, humanBefore, pathBefore, !!btn);
        if (ev2) {
          say("send", ev2 + " (via Enter)");
          notes.push(story());
          const left = surfaceWas ? K.surfaceLeftNote(surfaceWas, false) : "";
          if (left) notes.push(left);
          return { ok: true, notes: notes };
        }
        return fail(
          !btn
            ? "no send control matched any known shape, and Enter sent nothing"
            : C.sendDisabled(btn)
            ? "the send control never enabled (uploads may still be processing, or the composer rejected the message), and Enter sent nothing"
            : "pressed send, then Enter, and nothing showed the message leaving"
        );
      }
    }
    // Every phase list ends in "send", so this line is unreachable — kept so a
    // future edit that breaks that invariant fails loudly instead of returning
    // undefined.
    return fail("send phase never ran");
  }

  // attachFiles and humanTurns are Cowork's, not the send's: the Upload folder
  // button (src/folder-upload.js) attaches to this composer without sending,
  // and it must confirm the attachment the way this surface allows rather than
  // the way Chat does. One implementation of that evidence, not two.
  window.CUMCoworkSend = {
    applies: applies,
    send: send,
    selectProject: selectProject,
    attachFiles: attachFiles,
    humanTurns: humanTurns,
    // Exported because Cowork's send control does NOT wear any of Chat's
    // labels — it reads "Start Task" — so C.findSend answers nothing here.
    // Anything that needs to find it (the Folder button anchors its placement
    // to it) reuses this rather than learning that the hard way a second time.
    findSend: function () {
      return findSendControl(scopeOf());
    },
  };
})();
