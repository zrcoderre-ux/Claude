const test = require("node:test");
const assert = require("node:assert");
const U = require("../src/usagewarn.js");

const DAY = "2026-08-20";
const WEEK = Date.UTC(2026, 7, 25, 16, 0, 0); // some weekly reset instant

function read(over) {
  return Object.assign({ weeklyPct: 0, todayPct: 0, dateStr: DAY, weeklyResetAt: WEEK }, over);
}

test("the daily share defaults to an even seventh of the weekly limit", () => {
  assert.ok(Math.abs(U.shareOf(null) - 100 / 7) < 1e-9);
  assert.ok(Math.abs(U.shareOf({}) - 100 / 7) < 1e-9);
  assert.equal(U.shareOf({ dailyShare: 20 }), 20);
  // Nonsense configuration falls back rather than warning wrongly.
  assert.ok(Math.abs(U.shareOf({ dailyShare: 0 }) - 100 / 7) < 1e-9);
  assert.ok(Math.abs(U.shareOf({ dailyShare: 140 }) - 100 / 7) < 1e-9);
  assert.ok(Math.abs(U.shareOf({ dailyShare: "20" }) - 100 / 7) < 1e-9);
  // ...and a share small enough to fire on every reading is floored.
  assert.equal(U.shareOf({ dailyShare: 0.2 }), U.MIN_SHARE);
});

test("crossing the day's share warns once, and not again that day", () => {
  let st = U.EMPTY;
  let r = U.due(st, read({ todayPct: 14 }), null);
  assert.deepEqual(r.fire, [], "under the share, nothing");
  st = r.state;

  r = U.due(st, read({ todayPct: 14.5 }), null);
  assert.equal(r.fire.length, 1);
  assert.equal(r.fire[0].kind, "daily");
  assert.equal(r.fire[0].step, 1);
  assert.match(r.fire[0].message, /14\.5% of your weekly limit/);
  st = r.state;

  // Still over, and climbing — but the same crossing.
  st = U.due(st, read({ todayPct: 18 }), null).state;
  assert.deepEqual(U.due(st, read({ todayPct: 20 }), null).fire, []);
});

test("a new day re-arms it — that is what 'every time' means", () => {
  let st = U.due(U.EMPTY, read({ todayPct: 30 }), null).state;
  assert.equal(st.daySteps, 2);
  const next = U.due(st, read({ todayPct: 15, dateStr: "2026-08-21" }), null);
  assert.equal(next.fire.length, 1);
  assert.equal(next.fire[0].kind, "daily");
  assert.equal(next.state.dayKey, "2026-08-21");
});

test("a day that spends several shares warns again at each whole multiple", () => {
  let st = U.due(U.EMPTY, read({ todayPct: 15 }), null).state; // 1x
  let r = U.due(st, read({ todayPct: 29 }), null); // 2x (28.6)
  assert.equal(r.fire.length, 1);
  assert.equal(r.fire[0].step, 2);
  assert.match(r.fire[0].title, /2×/);
  st = r.state;
  r = U.due(st, read({ todayPct: 40 }), null); // still 2x
  assert.deepEqual(r.fire, []);
  r = U.due(r.state, read({ todayPct: 43.5 }), null); // 3x (42.9)
  assert.equal(r.fire[0].step, 3);
});

test("a jump across several shares is one warning, the highest", () => {
  const r = U.due(U.EMPTY, read({ todayPct: 60 }), null);
  const daily = r.fire.filter((f) => f.kind === "daily");
  assert.equal(daily.length, 1);
  assert.equal(daily[0].step, 4);
  assert.equal(r.state.daySteps, 4);
});

test("one day cannot warn forever, however small the share", () => {
  const cfg = { dailyShare: 1 };
  let st = U.EMPTY;
  let count = 0;
  for (let pct = 1; pct <= 100; pct++) {
    const r = U.due(st, read({ todayPct: pct, weeklyPct: null }), cfg);
    count += r.fire.length;
    st = r.state;
  }
  assert.equal(count, U.MAX_DAILY_STEPS);
});

test("the weekly milestones fire once each, in the window they belong to", () => {
  let st = U.EMPTY;
  let r = U.due(st, read({ weeklyPct: 49.9 }), null);
  assert.deepEqual(r.fire, []);
  st = r.state;

  r = U.due(st, read({ weeklyPct: 50 }), null);
  assert.equal(r.fire.length, 1);
  assert.equal(r.fire[0].mark, 50);
  assert.equal(r.fire[0].level, "warn");
  st = r.state;

  assert.deepEqual(U.due(st, read({ weeklyPct: 60 }), null).fire, [], "no second 50%");

  r = U.due(st, read({ weeklyPct: 76 }), null);
  assert.equal(r.fire[0].mark, 75);
  st = r.state;

  r = U.due(st, read({ weeklyPct: 91 }), null);
  assert.equal(r.fire[0].mark, 90);
  assert.equal(r.fire[0].level, "danger", "90% is the red one");
  assert.deepEqual(r.state.marks, [50, 75, 90]);
});

test("crossing two milestones at once says the higher one, and only once", () => {
  const r = U.due(U.EMPTY, read({ weeklyPct: 92 }), null);
  const weekly = r.fire.filter((f) => f.kind === "weekly");
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0].mark, 90);
  assert.deepEqual(r.state.marks, [50, 75, 90], "the ones it skipped are still spent");
});

test("the next weekly window re-arms every milestone", () => {
  const st = U.due(U.EMPTY, read({ weeklyPct: 92 }), null).state;
  const next = U.due(st, read({ weeklyPct: 51, weeklyResetAt: WEEK + 7 * 86400e3 }), null);
  assert.equal(next.fire.length, 1);
  assert.equal(next.fire[0].mark, 50);
});

test("a meter that fell away below a spent mark re-arms it too", () => {
  // A reset whose new reset time we haven't read yet: same window key, but the
  // meter has plainly rolled over.
  const st = U.due(U.EMPTY, read({ weeklyPct: 92 }), null).state;
  const next = U.due(st, read({ weeklyPct: 3 }), null);
  assert.deepEqual(next.state.marks, [], "all three re-armed");
  const later = U.due(next.state, read({ weeklyPct: 52 }), null);
  assert.equal(later.fire[0].mark, 50);
});

test("a reading with nothing in it changes nothing", () => {
  const st = U.due(U.EMPTY, read({ weeklyPct: 80, todayPct: 20 }), null).state;
  const r = U.due(st, null, null);
  assert.deepEqual(r.fire, []);
  assert.deepEqual(r.state.marks, [50, 75]);
  assert.equal(r.state.daySteps, 1);
  // Missing halves are simply skipped, not guessed at.
  assert.deepEqual(U.due(st, read({ weeklyPct: null, todayPct: null }), null).fire, []);
});

test("both kinds can land on the same reading", () => {
  const r = U.due(U.EMPTY, read({ weeklyPct: 51, todayPct: 16 }), null);
  assert.deepEqual(r.fire.map((f) => f.kind), ["daily", "weekly"]);
});

test("the reset text rides along when the caller has one", () => {
  const r = U.due(U.EMPTY, read({ weeklyPct: 76, resetText: "2d 4h" }), null);
  assert.match(r.fire[0].message, /resets in 2d 4h/);
  assert.doesNotMatch(U.due(U.EMPTY, read({ weeklyPct: 76 }), null).fire[0].message, /resets in/);
});

test("the pill says the loudest thing that is true right now", () => {
  assert.equal(U.standing(read({}), null), null, "a quiet week says nothing");
  assert.equal(U.standing(read({ weeklyPct: 52 }), null).kind, "weekly");
  assert.equal(U.standing(read({ weeklyPct: 52 }), null).sticky, false, "50% gets out of the way");
  // At 50% weekly, a day over its share is the more useful thing to say.
  const both = U.standing(read({ weeklyPct: 52, todayPct: 20 }), null);
  assert.equal(both.kind, "daily");
  // At 75% and above the week outranks it, and stays on screen.
  const wk = U.standing(read({ weeklyPct: 80, todayPct: 20 }), null);
  assert.equal(wk.kind, "weekly");
  assert.equal(wk.sticky, true);
  assert.equal(U.standing(read({ weeklyPct: 95 }), null).level, "danger");
});

test("standing() reads the same share the warnings do", () => {
  assert.equal(U.standing(read({ todayPct: 16 }), { dailyShare: 25 }), null);
  assert.equal(U.standing(read({ todayPct: 26 }), { dailyShare: 25 }).kind, "daily");
});

test("percentages print to a tenth only where the tenth says something", () => {
  assert.equal(U.fmtPts(14.285714), "14.3%");
  assert.equal(U.fmtPts(52), "52%");
  assert.equal(U.fmtPts(15.04), "15%");
  assert.equal(U.fmtPts(null), "—");
});
