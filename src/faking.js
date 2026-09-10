/**
 * The fakes toggle — what the one-click switch in claude.ai's composer row
 * says, and whether it may be pressed.
 *
 * The peek already existed: a button inside the key panel that stands this
 * page's MESSAGES down so you see exactly what claude.ai renders in them, then
 * puts the real names back. Reaching it took opening a panel, which is two
 * clicks and a thing on screen to close, for a switch that is used mid-read and
 * is never anything but on or off. So the same decision gets a second home in
 * the composer row, beside Upload folder, with no panel of its own.
 *
 * The MESSAGES, and not the titles. The titles read in the real names in every
 * state there is — the repo owner's rule, September 2026 — because a peek asks
 * what claude.ai holds in the body, and a sidebar that went to fakes with it is
 * a sidebar you cannot find your way back out of. So this switch governs half
 * the page by design, and every sentence it says has to name which half.
 *
 * One switch, not two states of two switches: this and the panel's peek are
 * the same `paused` flag in src/pseudo-view.js, so pressing either moves both.
 *
 * The rules it keeps, which are the key button's rules and are deliberately
 * not re-decided here:
 *
 *   LIT IF AND ONLY IF REAL NAMES ARE IN THE MESSAGES — the half this switch
 *   governs. Colour means the body is not saying what claude.ai says. A peek
 *   and a run's hold both leave the messages in the fakes, so both are
 *   monochrome like the off state and are told apart by the word on the
 *   button. The titles are real throughout and are never what the colour is
 *   about; the button being THERE at all is what says so, and its tooltip
 *   says it in words.
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
 * And one decision that is not about the word at all: WHETHER THE ROW HAS
 * ANSWERED YET. A row that takes the button and shows nothing has either no
 * room or no layout yet, and a conversation Upload folder's own send just
 * created is measured mid-render every time — see roomVerdict, which is why
 * this button used to be in a run's chats and never in the ones the Folder
 * button started.
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
        ", and the titles keep their real names. A run's hand-off can fall back " +
        "to the text on screen, so this is not the control for it: pause the run — " +
        "or let it finish, hold or fail — and the messages come back by themselves."
      );
    if (paused)
      return (
        "The messages show the fakes — exactly what claude.ai renders. The " +
        "titles keep their real names, as they do in every state. Click to read " +
        "the messages back in the real names too." +
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
      " in place of the fakes. Click to see the messages exactly as claude.ai " +
      "renders them — the titles keep their real names either way." +
      SAFETY
    );
  }

  // ---- where it stands when the row will not show it -----------------------

  /**
   * A row that took the button and showed nothing has said one of two things,
   * and nothing about the measurement itself tells them apart: it has no ROOM,
   * or it has no LAYOUT YET.
   *
   * The second one is not a corner case — it is the conversation this button
   * most needs to be in. Upload folder's own send CREATES a conversation and
   * the tab that sent it watches claude.ai build the new composer row, so the
   * first insert lands mid-render and measures zero. A conversation you merely
   * OPEN — a run's chat, clicked in the sidebar — is settled by the time
   * anything measures it, which is why the same button was there in one and
   * never in the other. Answered once and kept, that one instant cost the
   * whole visit.
   *
   * So a row gets a WINDOW to lay itself out in, and only a row that is still
   * refusing at the end of it is a row with no room. Twelve seconds because
   * the tick is 1.5 and a new conversation's row settles in one or two of
   * them; long enough to cover a slow render, short enough that a row that
   * really is full has answered before you have read the reply.
   */
  const ROOM_GRACE_MS = 12000;

  /**
   * What to do about it.
   *
   *   waited   — ms since this row was FIRST asked to show the button
   *   answered — this row has already been through the window once and said no
   *              (a resize is what asks it again, and a row that has already
   *              answered is not owed a second silent window)
   *
   * "wait"   — take the button back out and ask again: nothing is concluded,
   *            and a button in the page and nowhere on the screen is worse
   *            than one that isn't there yet.
   * "corner" — the row has had its chance. Stand at the BOTTOM on its own
   *            rather than nowhere: a switch that vanishes is a translation
   *            with nothing on screen offering to turn it off.
   */
  function roomVerdict(ev) {
    const e = ev || {};
    if (e.answered) return "corner";
    const waited = typeof e.waited === "number" && e.waited > 0 ? e.waited : 0;
    return waited < ROOM_GRACE_MS ? "wait" : "corner";
  }

  const api = {
    buttonState: buttonState,
    roomVerdict: roomVerdict,
    ROOM_GRACE_MS: ROOM_GRACE_MS,
    REAL: REAL,
    FAKES: FAKES,
    HELD: HELD,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMFaking = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
