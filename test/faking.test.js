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
