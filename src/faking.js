/**
 * The fakes toggle — what the one-click switch in claude.ai's composer row
 * says, and whether it may be pressed.
 *
 * The peek already existed: a button inside the key panel that pauses this
 * page's translation so you see exactly what claude.ai renders, then puts the
 * real names back. Reaching it took opening a panel, which is two clicks and a
 * thing on screen to close, for a switch that is used mid-read and is never
 * anything but on or off. So the same decision gets a second home in the
 * composer row, beside Upload folder, with no panel of its own.
 *
 * One switch, not two states of two switches: this and the panel's peek are
 * the same `paused` flag in src/pseudo-view.js, so pressing either moves both.
 *
 * The rules it keeps, which are the key button's rules and are deliberately
 * not re-decided here:
 *
 *   LIT IF AND ONLY IF REAL NAMES ARE ON SCREEN. Colour means this page is not
 *   saying what claude.ai says. A peek is monochrome like the off state,
 *   because a peek is the whole page in the fakes. A run's HOLD is not: it
 *   stands the messages down and leaves every title reading back in the real
 *   name, so the page is still not saying what claude.ai says and the button
 *   is still lit. It used to be monochrome here on the belief that a hold and
 *   a peek showed the same thing, and they never have.
 *
 *   A RUN'S HOLD IS NOT THE USER'S TO LIFT — AND PRESSING THIS DOES NOT LIFT
 *   IT. While a run is moving through this chat the messages show the fakes,
 *   because the run's hand-off can fall back to the rendered message, and no
 *   button here changes that; pausing the run is what ends it. But the TITLES
 *   are the peek's, held or not, and this button is how you see what claude.ai
 *   actually holds for one. So a held page still takes the press: it puts the
 *   titles back to the fakes, which is the one thing the hold was never doing
 *   for you. Disabling it was the hold answering a question nobody had asked
 *   it — and it left the panel saying "the titles keep their real names" beside
 *   the greyed-out control for exactly that.
 *
 *   THE SAFETY HALF NEVER STANDS DOWN. Faking is display: the composer
 *   warning, the typeahead swap and the upload guard stay on either side of
 *   this switch, and the tooltip says so, because a control that looks like it
 *   turns the feature off must say what it does not turn off.
 *
 * Pure: no DOM, no chrome. The button is src/fake-toggle.js.
 */
(function (root) {
  "use strict";

  // What the button says. The word names the STATE rather than the action —
  // the same choice the key button's count makes, and for the same invariant:
  // what is under it must be readable without pressing it or hovering it.
  const REAL = "Real names";
  const FAKES = "Fakes";
  const HELD = "Held";

  // True of every state, and the sentence this button most needs to carry: it
  // switches what you are LOOKING at and nothing else.
  const SAFETY =
    " This tab only, and never remembered. The composer warning, the typeahead " +
    "and the upload guard stay on either way — they are safety, not display.";

  /**
   * The whole button, from the view state src/pseudo-view.js publishes
   * (`{ on, name, paused, hold, names, titles }` — see its viewState).
   *
   * Returns:
   *   shown     — put it in the row at all
   *   faking    — the page is showing the fakes right now
   *   lit       — real names are on screen (the one thing colour may mean)
   *   disabled  — never; kept so the button's drawing has one thing to ask
   *   next      — what to hand setPaused() when it is pressed
   *   label     — the word on the button
   *   title     — the whole sentence, for the tooltip
   */
  function buttonState(view) {
    const st = view || {};
    const held = !!st.hold;
    const paused = !!st.paused;
    // Shown where there is a switch to throw: a key is translating this page,
    // or the page is standing down and this is how you get back. That second
    // one matters — a peek outlives the key that was attached when it started,
    // and a paused page whose only switch had vanished would be a translation
    // quietly off with nothing on screen offering to turn it on.
    const shown = !!st.on || paused;
    // The whole page in the fakes, which is the peek and only the peek. A hold
    // is a HALF stand-down — messages down, titles up — so it is not this, and
    // saying it was is what left the button claiming to be pressed already
    // while the titles beside it read in the real names.
    const faking = paused;
    return {
      shown: shown,
      faking: faking,
      lit: !!st.on && !faking,
      // Never. The hold owns the messages and this button was never the
      // control for those; what it does own is the titles, which a hold leaves
      // alone.
      disabled: false,
      // The flag this flips is `paused` in both directions, hold or no hold.
      next: !paused,
      // A peek names itself first: pressed while held, the page IS the fakes
      // and "Held" would be naming the half that didn't change.
      label: paused ? FAKES : held ? HELD : REAL,
      title: titleFor(st, held, paused),
    };
  }

  function titleFor(st, held, paused) {
    if (held)
      return (
        "The messages show the fakes while " +
        (st.hold && st.hold.name ? "“" + st.hold.name + "”" : "a run") +
        " is working" +
        (st.hold && st.hold.via === "key" ? " on this matter" : "") +
        ", and the titles keep their real names. A run's hand-off can fall back " +
        "to the text on screen, so this is not the control for the messages: " +
        "pause the run — or let it finish, hold or fail — and they come back by " +
        "themselves. Click to put the fakes back in the TITLES, which the run " +
        "never held." +
        SAFETY
      );
    if (paused)
      return (
        "Showing the fakes — this page is exactly what claude.ai renders. " +
        "Click to read it back in the real names." +
        SAFETY
      );
    if (!st.on)
      return "Nothing on this page is translated." + SAFETY;
    // A key ATTACHED to this conversation and a key merely reading the chat
    // names in the lists back are different facts, and the button has to say
    // which: lit on a page with no conversation to attach to (a blank
    // composer) otherwise reads as an attachment that cannot exist, while the
    // panel one click away says the page is not a conversation.
    if (st.on && st.attached === false)
      return (
        "Showing the real names in the chat names on this page" +
        (st.name ? ", from " + st.name : "") +
        ". No key is attached to this page. Click to see it exactly as claude.ai renders it." +
        SAFETY
      );
    return (
      "Showing the real names" +
      (st.name ? " from " + st.name : "") +
      " in place of the fakes. Click to see the page exactly as claude.ai renders it." +
      SAFETY
    );
  }

  const api = { buttonState: buttonState, REAL: REAL, FAKES: FAKES, HELD: HELD };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMFaking = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
