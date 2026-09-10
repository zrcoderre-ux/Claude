const test = require("node:test");
const assert = require("node:assert");
const K = require("../src/faking.js");

// The view state src/pseudo-view.js publishes, in the shapes the button has to
// draw from. viewState() answers { on:false, names:0, titles:0, paused, hold }
// where there is no key, and the full record where there is one.
const off = (over) => Object.assign({ on: false, names: 0, titles: 0, paused: false, hold: null }, over);
const on = (over) =>
  Object.assign(
    { on: true, id: "k1", name: "23STCV12345 Smith v. Jones", names: 12, titles: 3, paused: false, hold: null },
    over
  );

test("a page with a key translating it shows the real names, lit", () => {
  const b = K.buttonState(on());
  assert.equal(b.shown, true);
  assert.equal(b.faking, false);
  assert.equal(b.lit, true, "colour means this page is not saying what claude.ai says");
  assert.equal(b.disabled, false);
  assert.equal(b.label, K.REAL);
});

test("pressing it asks for the fakes, and pressing it again asks for them back", () => {
  assert.equal(K.buttonState(on()).next, true, "showing the real names — the press pauses");
  assert.equal(K.buttonState(on({ paused: true })).next, false, "paused — the press resumes");
});

test("a peek is monochrome, because the page IS showing the fakes", () => {
  const b = K.buttonState(on({ paused: true }));
  assert.equal(b.faking, true);
  assert.equal(b.lit, false);
  assert.equal(b.label, K.FAKES);
  assert.equal(b.disabled, false, "a peek is the user's own switch to throw back");
});

test("a run holding the messages is said, not offered", () => {
  // The hold is not the user's to lift here: the run's hand-off can fall back
  // to the rendered message, and pausing the run is what ends it.
  const b = K.buttonState(on({ hold: { name: "Smith v. Jones", via: "key" } }));
  assert.equal(b.disabled, true);
  assert.equal(b.faking, true);
  assert.equal(b.lit, false, "held is monochrome like a peek — the fakes are showing in both");
  assert.equal(b.label, K.HELD);
  assert.match(b.title, /pause the run/i);
  assert.match(b.title, /Smith v\. Jones/);
});

test("a held page with no run name still says what is happening", () => {
  const b = K.buttonState(on({ hold: { name: "", via: "chat" } }));
  assert.equal(b.label, K.HELD);
  assert.match(b.title, /a run is working/);
});

test("nothing to translate, nothing to switch — the button stays out of the row", () => {
  const b = K.buttonState(off());
  assert.equal(b.shown, false);
  assert.equal(b.lit, false);
});

test("a peek that outlived its key keeps its own way back", () => {
  // A key can be detached (or the tab can walk to a chat that has none) while
  // a peek is on. Hiding the switch there would leave the page standing down
  // with nothing on screen offering to turn it back on.
  const b = K.buttonState(off({ paused: true }));
  assert.equal(b.shown, true);
  assert.equal(b.disabled, false);
  assert.equal(b.next, false, "and it resumes");
  assert.equal(b.lit, false);
});

test("the tooltip always says what the switch does NOT turn off", () => {
  // Faking is display. A control that looks like it turns the feature off has
  // to say that the warning, the typeahead and the upload guard stay on.
  for (const st of [on(), on({ paused: true }), off(), off({ paused: true })]) {
    const b = K.buttonState(st);
    assert.match(b.title, /composer warning/);
    assert.match(b.title, /upload guard/);
    assert.match(b.title, /never remembered/);
  }
});

test("a translating page names its case in the tooltip", () => {
  assert.match(K.buttonState(on()).title, /23STCV12345 Smith v\. Jones/);
});

test("nothing at all is answered for a state that never arrived", () => {
  const b = K.buttonState(null);
  assert.equal(b.shown, false);
  assert.equal(b.disabled, false);
  assert.equal(b.label, K.REAL);
});

test("a key that is not attached here says so", () => {
  // Lit on a page with no conversation to attach to would otherwise read as an
  // attachment that cannot exist — which is what the panel, one click away,
  // was busy denying.
  const b = K.buttonState(on({ attached: false, names: 0, titles: 3 }));
  assert.equal(b.lit, true, "real names ARE on screen — in the chat names");
  assert.match(b.title, /No key is attached to this page/);
  assert.match(b.title, /chat names on this page/);
});

test("an attached key says nothing of the sort", () => {
  const b = K.buttonState(on({ attached: true }));
  assert.doesNotMatch(b.title, /not attached|No key is attached/);
});

// ---- the titles are outside the switch -------------------------------------
//
// The repo owner's rule (September 2026): the title reads in the real names in
// every state there is. The peek is about the BODY. That makes this button a
// control over half the page by design, and a control that says "showing the
// fakes" while a sidebar full of real names sits beside it is a control that
// has lied. So every state that stands the messages down has to name the half
// it did not touch.

test("a peek says which half it moved", () => {
  const b = K.buttonState(on({ paused: true }));
  assert.match(b.title, /messages/i, "it has to say the MESSAGES are the fakes");
  assert.match(b.title, /titles keep their real names/i);
});

test("a run's hold says it too", () => {
  const b = K.buttonState(on({ hold: { name: "Smith v. Jones", via: "key" } }));
  assert.match(b.title, /titles keep their real names/i);
  assert.match(b.title, /pause the run/i, "the messages are still the run's");
});

test("the ON state says the titles are not what the colour is about", () => {
  // Lit means the MESSAGES are in the real names. Pressing it does not take
  // the titles with them, and the tooltip is where that is said before the
  // press rather than discovered after it.
  const b = K.buttonState(on());
  assert.equal(b.lit, true);
  assert.match(b.title, /titles keep their real names/i);
});

// ---- where it stands when the row will not show it -------------------------
//
// The measurement is the same in both cases and only time tells them apart: a
// composer row with nothing left to give, and a composer row that has not laid
// itself out yet. The second is the conversation this button is most for — the
// one Upload folder's own send just created, watched from the tab that sent it
// — which is why it used to be in a run's chats and never in the folder's.

test("a row that shows nothing on the first ask is not a row with no room", () => {
  assert.equal(K.roomVerdict({ waited: 0 }), "wait");
  assert.equal(K.roomVerdict({ waited: 1500 }), "wait", "one tick later it is still rendering");
  assert.equal(K.roomVerdict({ waited: K.ROOM_GRACE_MS - 1 }), "wait");
});

test("a row still refusing at the end of its window has answered", () => {
  assert.equal(K.roomVerdict({ waited: K.ROOM_GRACE_MS }), "corner");
  assert.equal(K.roomVerdict({ waited: 60000 }), "corner");
});

test("the window is long enough for a new conversation's row to settle", () => {
  // The tick is 1.5s and a row built by our own send takes one or two of them.
  assert.ok(K.ROOM_GRACE_MS >= 6000, "a slow render must not be read as a full row");
  assert.ok(K.ROOM_GRACE_MS <= 20000, "a full row has to answer before the reply is read");
});

test("a row that has already answered is not owed a second silent window", () => {
  // What asks again is a resize, and a window being dragged must not take the
  // button off the screen for the whole of the window each time.
  assert.equal(K.roomVerdict({ waited: 0, answered: true }), "corner");
});

test("nothing readable about the wait is treated as the first ask", () => {
  assert.equal(K.roomVerdict({}), "wait");
  assert.equal(K.roomVerdict(), "wait");
  assert.equal(K.roomVerdict({ waited: -5 }), "wait", "a clock that went backwards is not a verdict");
});
