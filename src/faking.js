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
 *   saying what claude.ai says. A peek and a run's hold both leave the fakes
 *   showing, so both are monochrome like the off state and are told apart by
 *   the word on the button.
 *
 *   A RUN'S HOLD IS NOT THE USER'S TO LIFT HERE. While a run is moving through
 *   this chat the messages show the fakes because the run's hand-off can fall
 *   back to the rendered message. The button says so and does nothing, the way
 *   the panel's peek does; pausing the run is what ends it.
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
   *   disabled  — a run has the display, and this is not the control for it
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
    const faking = paused || held;
    return {
      shown: shown,
      faking: faking,
      lit: !!st.on && !faking,
      disabled: held,
      // The flag this flips is `paused`, so a held page (whose button is
      // disabled anyway) never answers "resume" to a press it can't take.
      next: !paused,
      label: held ? HELD : paused ? FAKES : REAL,
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
        ". A run's hand-off can fall back to the text on screen, so this is not " +
        "the control for it: pause the run — or let it finish, hold or fail — and " +
        "the real names come back by themselves."
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
