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

  let btn = null;
  let state = K.buttonState(null);
  // Set when the row took the button and had no room to show it. INSERTED and
  // VISIBLE are different things — the header slot's own lesson, which the
  // Folder button beside this one learned the hard way — and a button in the
  // page and nowhere on the screen is worse than one that isn't there: the
  // peek is still in the key panel, where it has always been. Sticky rather
  // than retried every tick, so a row with no room isn't handed a button and
  // taken back one and a half seconds later, forever.
  let noRoom = false;
  // The row the Folder button was last found in. claude.ai swapping its
  // composer out for another one's is a new row and gets its own answer about
  // whether there is room, rather than inheriting the old one's.
  let lastRow = null;

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

  function place() {
    const at = folder();
    const row = at ? at.parentElement : null;
    if (row !== lastRow) {
      lastRow = row;
      noRoom = false;
    }
    if (!state.shown || !at || noRoom) {
      if (btn && btn.parentNode) btn.remove();
      return;
    }
    const b = build();
    // Checked before it is done, so a docked button is not torn out and put
    // back on every tick — which would cost it its own hover and focus.
    if (b.parentElement !== at.parentElement || b.previousElementSibling !== at) {
      // The Folder button's own row class decides how a button of ours looks in
      // claude.ai's furniture, and it is put on BEFORE the insert: measuring one
      // still wearing the loose styling is measuring something that will not be
      // what is on the screen.
      b.classList.toggle("cum-fakes-inrow", at.classList.contains("cum-folder-inrow"));
      b.classList.toggle("cum-fakes-loose", at.classList.contains("cum-folder-loose"));
      try {
        at.parentElement.insertBefore(b, at.nextSibling);
      } catch (e) {
        return;
      }
      if (!C.isVisible(b)) {
        noRoom = true;
        b.remove();
        return;
      }
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
  // the row itself changing, so neither answer is kept past the question.
  window.addEventListener("resize", () => {
    noRoom = false;
    place();
  });
  place();
})();
