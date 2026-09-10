/**
 * Claude Usage Meter — the fakes toggle, beside Upload folder (ISOLATED world).
 *
 * A second home for the peek. The key panel has always held it, and reaching
 * it there is a click to open the panel, a click to throw the switch and a
 * click to close again — for a control that is used mid-read, is never
 * anything but on or off, and answers one question: am I looking at the real
 * names or at what claude.ai actually holds?
 *
 * So it also sits in claude.ai's own composer row, immediately to the RIGHT of
 * the Folder button, with no panel to open. Pressing it is pressing the
 * panel's peek — one `paused` flag in src/pseudo-view.js, so the two controls
 * can never disagree about which way the page is being read.
 *
 * ANCHORED TO THE FOLDER BUTTON, not to claude.ai's furniture. src/folder-
 * upload.js already solved where a button of ours goes in that row, learned it
 * the hard way on Cowork, and has three homes to fall back through — the
 * composer row, the tray, a corner of its own. Following the Folder button
 * wherever it lands means "to the right of Folder" is true in all three, and
 * that a change to that placement is still one edit in one file. It also
 * settles this button's own lifetime for free: where there is a composer to
 * type into there is a Folder button, and where there isn't, the key button in
 * the tray still carries the count, the word (`fakes`, `held`) and the peek.
 *
 * The decisions — what the word says, when it is lit, when it may be pressed —
 * live in src/faking.js, pure and tested. This is the button and the docking.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  const V = window.CUMPseudoView;
  const K = window.CUMFaking;
  if (!C || !V || !K) return;

  const ID = "cum-fakes";
  const FOLDER_ID = "cum-folder";
  const TICK_MS = 1500;
  // An insert that measures nothing costs a layout, and place() runs on every
  // render the sweep publishes — which, mid-reply, is a great many. So a row
  // that has just shown nothing is asked again on the TICK's cadence rather
  // than the stream's.
  const RETRY_MS = 750;

  let btn = null;
  let state = K.buttonState(null);
  // INSERTED and VISIBLE are different things — the header slot's own lesson,
  // which the Folder button beside this one learned the hard way. So the
  // button is measured after it is docked, and what a row that shows nothing
  // has actually said is src/faking.js's roomVerdict: a row still being BUILT
  // measures exactly like a row with no ROOM, and the composer row of a
  // conversation this button's own Folder just created is mid-render every
  // time. Judged on that one measurement, it was the run's chats that carried
  // the button and never the ones the folder started.
  //
  // firstTryAt — when this row was first asked to show it, which is the window
  //              it gets to lay itself out in
  // lastFailAt — when it last showed nothing, so the ask goes at the tick's
  //              pace and not the sweep's
  // saidNoRoom — this row has been through the window once and refused, so a
  //              resize's second ask is answered on the spot rather than
  //              costing another silent twelve seconds
  // cornered   — the row refused: the button stands at the bottom on its own,
  //              and stays there until the row changes or the window resizes
  let lastRow = null;
  let firstTryAt = 0;
  let lastFailAt = 0;
  let saidNoRoom = false;
  let cornered = false;

  function build() {
    if (btn) return btn;
    btn = document.createElement("button");
    btn.id = ID; // C.isOurs — the row scanners leave our own buttons alone
    btn.type = "button";
    // A drawn mark rather than an emoji, for the reason the folder icon is one:
    // this sits among claude.ai's own line icons and has to be one of them.
    // An eye, because that is what the switch is about — what is on screen,
    // never what Claude is given.
    btn.innerHTML =
      '<span class="cum-fakes-ico" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/>' +
      '<circle cx="12" cy="12" r="3"/>' +
      "</svg></span>" +
      '<span class="cum-fakes-txt"></span>';
    btn.addEventListener("click", () => {
      // Read the live state rather than the drawn one: a sweep may have landed
      // between the last paint and this click, and a run's hold arrives that
      // way. buttonState answers the same question either way.
      const now = K.buttonState(V.state());
      if (now.disabled) return;
      V.setPaused(now.next);
    });
    return btn;
  }

  function paint() {
    if (!btn) return;
    const txt = btn.querySelector(".cum-fakes-txt");
    if (txt) txt.textContent = state.label;
    btn.disabled = state.disabled;
    btn.title = state.title;
    // A toggle, and said so to a screen reader in the terms it has: pressed
    // means the fakes are showing. The word on the button says it to everyone
    // else, and the colour says the half that must not need reading.
    btn.setAttribute("aria-pressed", state.faking ? "true" : "false");
    // Lit if and ONLY if real names are on screen — the key button's rule, and
    // the same class contract: colour means this page is not saying what
    // claude.ai says. See content.css.
    btn.classList.toggle("cum-fakes-on", state.lit);
    btn.classList.toggle("cum-fakes-off", state.shown && !state.lit);
  }

  /**
   * The Folder button's last-resort home is a corner it draws for itself, at a
   * FIXED position — so a button merely inserted after it in the body would not
   * be beside it at all. Measured rather than guessed: the width of that button
   * changes with the word on it, and so does this one's.
   */
  function follow(at, b) {
    if (!b.classList.contains("cum-fakes-loose")) return;
    try {
      const r = at.getBoundingClientRect();
      if (r.width < 1) return; // the stylesheet's own corner takes it
      b.style.left = Math.round(r.right + 8) + "px";
      b.style.bottom = Math.round(window.innerHeight - r.bottom) + "px";
    } catch (e) {
      /* likewise */
    }
  }

  /** The Folder button, wherever it has ended up, or null. */
  function folder() {
    const el = document.getElementById(FOLDER_ID);
    if (!el || !el.parentElement) return null;
    try {
      return C.isVisible(el) ? el : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * The bottom of the conversation, on its own — the home for a row that will
   * not show the button. Not the tray at the top: this switch is used mid-read
   * with the composer in front of you, the key button up there already carries
   * the panel's peek, and a second control saying the same thing in the same
   * corner is the one nobody presses.
   */
  function corner(b) {
    b.classList.remove("cum-fakes-inrow", "cum-fakes-loose");
    b.classList.add("cum-fakes-corner");
    // Whatever follow() measured for a loose Folder button is not this
    // button's place any more; the stylesheet's corner is.
    b.style.left = "";
    b.style.bottom = "";
    if (b.parentElement !== document.body) document.body.appendChild(b);
  }

  function place() {
    const at = folder();
    const row = at ? at.parentElement : null;
    if (row !== lastRow) {
      // claude.ai swapping its composer out for another one's is a new row and
      // gets its own answer about whether there is room, rather than
      // inheriting the old one's.
      lastRow = row;
      firstTryAt = 0;
      lastFailAt = 0;
      saidNoRoom = false;
      cornered = false;
    }
    if (!state.shown || !at) {
      if (btn && btn.parentNode) btn.remove();
      return;
    }
    const b = build();
    if (cornered) {
      corner(b);
      paint();
      return;
    }
    // Checked before it is done, so a docked button is not torn out and put
    // back on every tick — which would cost it its own hover and focus.
    if (b.parentElement !== at.parentElement || b.previousElementSibling !== at) {
      const now = Date.now();
      if (lastFailAt && now - lastFailAt < RETRY_MS) return;
      // The Folder button's own row class decides how a button of ours looks in
      // claude.ai's furniture, and it is put on BEFORE the insert: measuring one
      // still wearing the loose styling is measuring something that will not be
      // what is on the screen.
      b.classList.remove("cum-fakes-corner");
      b.classList.toggle("cum-fakes-inrow", at.classList.contains("cum-folder-inrow"));
      b.classList.toggle("cum-fakes-loose", at.classList.contains("cum-folder-loose"));
      try {
        at.parentElement.insertBefore(b, at.nextSibling);
      } catch (e) {
        return;
      }
      if (!firstTryAt) firstTryAt = now;
      if (!C.isVisible(b)) {
        lastFailAt = now;
        const verdict = K.roomVerdict({ waited: now - firstTryAt, answered: saidNoRoom });
        if (verdict === "wait") {
          // Nothing is concluded: out it comes, and the next tick asks the row
          // again. The peek is in the key panel meanwhile, where it has always
          // been.
          b.remove();
          return;
        }
        saidNoRoom = true;
        cornered = true;
        corner(b);
        paint();
        return;
      }
      // The row has shown it. Whatever it said before, this row has room — so
      // a zero measurement in it later is a rebuild rather than a refusal, and
      // gets the window again rather than the corner on the spot.
      firstTryAt = 0;
      lastFailAt = 0;
      saidNoRoom = false;
    }
    follow(at, b);
    paint();
  }

  // The sweep publishes on every render, which is how the button follows a
  // peek, a run's hold starting or ending, and a key being attached or
  // detached without polling any of them.
  V.subscribe((st) => {
    state = K.buttonState(st);
    place();
  });

  // ...and a tick for the other half: claude.ai re-renders its composer row
  // (and the Folder button re-docks) without anything about the translation
  // changing, so a button placed once would quietly stop being in the row.
  setInterval(place, TICK_MS);
  // A row that had no room may have some now. The other thing that changes
  // that — claude.ai swapping the composer row out — is caught in place() by
  // the row itself changing, so neither answer is kept past the question. The
  // row's refusal is REMEMBERED across this ask (saidNoRoom), so a window
  // being dragged doesn't take the button off the screen for twelve seconds a
  // drag: one measurement decides it now.
  window.addEventListener("resize", () => {
    firstTryAt = 0;
    lastFailAt = 0;
    cornered = false;
    place();
  });
  place();
})();
