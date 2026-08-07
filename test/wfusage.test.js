const test = require("node:test");
const assert = require("node:assert");
const U = require("../src/wfusage.js");

test("observe buckets a step's usage by date and by workflow", () => {
  let m = U.observe(U.EMPTY, {
    dateStr: "2026-08-07",
    pct: 1.5,
    workflowId: "w1",
    workflowName: "Tentative ruling",
  });
  m = U.observe(m, { dateStr: "2026-08-07", pct: 2, workflowId: "w1", workflowName: "Tentative ruling" });
  m = U.observe(m, { dateStr: "2026-08-08", pct: 3, workflowId: "w2", workflowName: "Research" });

  assert.equal(m.days["2026-08-07"], 3.5);
  assert.equal(m.days["2026-08-08"], 3);
  assert.equal(m.workflows.w1.pct, 3.5);
  assert.equal(m.workflows.w1.steps, 2);
  assert.equal(m.workflows.w2.name, "Research");
});

test("a workflow renamed for the matter keeps its latest name", () => {
  let m = U.observe(U.EMPTY, { dateStr: "2026-08-07", pct: 1, workflowId: "w1", workflowName: "MSJ" });
  m = U.observe(m, { dateStr: "2026-08-08", pct: 1, workflowId: "w1", workflowName: "Demurrer" });
  assert.equal(m.workflows.w1.name, "Demurrer");
  // And a reading that arrives without a name doesn't erase the one we have.
  m = U.observe(m, { dateStr: "2026-08-09", pct: 1, workflowId: "w1" });
  assert.equal(m.workflows.w1.name, "Demurrer");
});

test("nothing measurable is not recorded as zero", () => {
  // A step whose weekly window reset mid-way reports null. Storing that as a
  // zero would claim we measured it and found no cost.
  const before = U.observe(U.EMPTY, { dateStr: "2026-08-07", pct: 2, workflowId: "w1" });
  for (const bad of [null, undefined, NaN, Infinity, -1, "3"]) {
    const after = U.observe(before, { dateStr: "2026-08-07", pct: bad, workflowId: "w1" });
    assert.deepEqual(after.days, before.days, String(bad));
    assert.equal(after.workflows.w1.steps, 1, String(bad));
  }
  // As is a reading with no date to file it under.
  assert.deepEqual(U.observe(before, { pct: 5, workflowId: "w1" }).days, before.days);
});

test("observe never mutates the model it was given", () => {
  const first = U.observe(U.EMPTY, { dateStr: "2026-08-07", pct: 2, workflowId: "w1" });
  const second = U.observe(first, { dateStr: "2026-08-07", pct: 2, workflowId: "w1" });
  assert.equal(first.days["2026-08-07"], 2);
  assert.equal(second.days["2026-08-07"], 4);
  assert.notEqual(first.workflows, second.workflows);
});

test("lastDates walks back across month and year boundaries", () => {
  assert.deepEqual(U.lastDates("2026-08-07", 3), ["2026-08-05", "2026-08-06", "2026-08-07"]);
  assert.deepEqual(U.lastDates("2026-03-02", 3), ["2026-02-28", "2026-03-01", "2026-03-02"]);
  assert.deepEqual(U.lastDates("2026-01-01", 2), ["2025-12-31", "2026-01-01"]);
  assert.deepEqual(U.lastDates("2024-03-01", 2), ["2024-02-29", "2024-03-01"], "leap year");
  assert.deepEqual(U.lastDates("nonsense", 3), []);
  assert.deepEqual(U.lastDates("2026-08-07", 0), []);
});

test("share divides workflow usage by the day's total usage", () => {
  const m = {
    days: { "2026-08-06": 4, "2026-08-07": 6, "2026-07-01": 100 },
    workflows: {},
  };
  const daily = { "2026-08-06": 10, "2026-08-07": 30, "2026-07-01": 200 };
  const s = U.share(m, daily, ["2026-08-06", "2026-08-07"]);
  assert.equal(s.workflow, 10);
  assert.equal(s.total, 40);
  assert.equal(s.share, 25, "dates outside the window are not counted");
});

test("share says nothing rather than 100% when there's no total", () => {
  const s = U.share({ days: { "2026-08-07": 3 } }, {}, ["2026-08-07"]);
  assert.equal(s.workflow, 3);
  assert.equal(s.total, 0);
  assert.equal(s.share, null, "a missing denominator is unknown, not everything");
});

test("share is clamped at 100 rather than reporting more than all of it", () => {
  // The two ledgers are fed by the same readings but written by different code
  // paths, so they can disagree at the edges. They must not disagree absurdly.
  const s = U.share({ days: { "2026-08-07": 12 } }, { "2026-08-07": 10 }, ["2026-08-07"]);
  assert.equal(s.share, 100);
});

test("byWorkflow ranks the spending, biggest first", () => {
  const m = {
    days: {},
    workflows: {
      a: { name: "Small", pct: 1, steps: 1 },
      b: { name: "Big", pct: 30, steps: 9 },
      c: { name: "Never ran", pct: 0, steps: 0 },
    },
  };
  const rows = U.byWorkflow(m);
  assert.deepEqual(rows.map((r) => r.name), ["Big", "Small"]);
  assert.equal(rows[0].id, "b");
});

test("the ledger is bounded, keeping the most recent dates", () => {
  let m = U.EMPTY;
  for (let i = 0; i < U.MAX_DAYS + 20; i++) {
    const d = new Date(2025, 0, 1 + i, 12);
    const s =
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0");
    m = U.observe(m, { dateStr: s, pct: 1, workflowId: "w1" });
  }
  const dates = Object.keys(m.days).sort();
  assert.equal(dates.length, U.MAX_DAYS);
  assert.equal(dates[dates.length - 1], "2025-07-19");
  assert.equal(m.workflows.w1.steps, U.MAX_DAYS + 20, "the per-workflow total isn't trimmed");
});
