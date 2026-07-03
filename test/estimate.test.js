/**
 * Tests for src/estimate.js — the tenths-place calibrator.
 * Run with: node --test test/estimate.test.js
 */
const assert = require("node:assert");
const { test } = require("node:test");
const { createCalibrator } = require("../src/estimate.js");

test("no estimate before any calibration", () => {
  const c = createCalibrator();
  c.observePercent(48); // first observation just sets the baseline
  c.addCost(5000);
  assert.equal(c.calibrated(), false);
  assert.equal(c.fraction(), 0);
});

test("calibrates tokens-per-percent from an integer jump", () => {
  const c = createCalibrator();
  c.observePercent(48); // baseline
  c.addCost(10000); // consume 10k tokens...
  c.observePercent(49); // ...which moved us exactly 1%
  assert.equal(c.calibrated(), true);
  // Now 3k more tokens ≈ 0.3 of the next percent.
  c.addCost(3000);
  assert.ok(Math.abs(c.fraction() - 0.3) < 1e-9, `fraction=${c.fraction()}`);
});

test("fraction is capped below 1.0 (never crosses the next integer)", () => {
  const c = createCalibrator();
  c.observePercent(10);
  c.addCost(10000);
  c.observePercent(11); // perPct = 10000
  c.addCost(50000); // 5% worth — but we must not cross into the next %
  assert.equal(c.fraction(), 0.9);
});

test("snaps and resets accumulation on each upward tick", () => {
  const c = createCalibrator();
  c.observePercent(10);
  c.addCost(10000);
  c.observePercent(11); // calibrate, accum resets
  c.addCost(4000);
  assert.ok(Math.abs(c.fraction() - 0.4) < 1e-9);
  c.observePercent(12); // another tick → accum resets again
  assert.equal(c.fraction(), 0);
});

test("a multi-percent jump divides the accumulated cost", () => {
  const c = createCalibrator();
  c.observePercent(20);
  c.addCost(30000);
  c.observePercent(23); // +3% for 30k → 10k per percent
  c.addCost(5000);
  assert.ok(Math.abs(c.fraction() - 0.5) < 1e-9, `fraction=${c.fraction()}`);
});

test("a downward move (window reset) clears accumulation", () => {
  const c = createCalibrator();
  c.observePercent(10);
  c.addCost(10000);
  c.observePercent(11); // perPct = 10000
  c.addCost(6000);
  assert.ok(c.fraction() > 0);
  c.observePercent(2); // window rolled over
  assert.equal(c.fraction(), 0);
});

test("EMA blends successive rate observations", () => {
  const c = createCalibrator();
  c.observePercent(0);
  c.addCost(10000);
  c.observePercent(1); // perPct = 10000
  c.addCost(20000);
  c.observePercent(2); // rate 20000 → EMA 0.7*10000 + 0.3*20000 = 13000
  c.addCost(6500);
  assert.ok(Math.abs(c.fraction() - 0.5) < 1e-9, `fraction=${c.fraction()}`);
});

test("snapshot round-trips calibration state", () => {
  const c = createCalibrator();
  c.observePercent(10);
  c.addCost(10000);
  c.observePercent(11);
  c.addCost(2000);
  const snap = c.snapshot();
  const c2 = createCalibrator(snap);
  assert.ok(Math.abs(c2.fraction() - 0.2) < 1e-9);
  assert.equal(c2.calibrated(), true);
});
