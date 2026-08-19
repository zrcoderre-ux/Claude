const test = require("node:test");
const assert = require("node:assert");
const P = require("../src/panelbar.js");

test("the tray anchors by its right edge, a gap left of the toggle", () => {
  // Sidebar closed: the toggle sits near the window's right edge.
  const closed = P.trayPlace(1400, { left: 1352, top: 10 });
  assert.equal(closed.anchored, true);
  assert.equal(closed.top, 10);
  assert.equal(closed.right, 1400 - 1352 + P.GAP);
});

test("the sidebar opening moves the toggle left, and the tray follows", () => {
  // The owner measured Cowork's open sidebar at 312 wide: the toggle moves
  // that far left, and a tray that stayed put would sit inside the sidebar.
  const open = P.trayPlace(1400, { left: 1352 - 312, top: 10 });
  assert.equal(open.anchored, true);
  assert.equal(open.right, 1400 - (1352 - 312) + P.GAP);
});

test("no anchor is the corner, not a guess", () => {
  const at = P.trayPlace(1400, null);
  assert.equal(at.anchored, false);
  assert.equal(at.top, P.FALLBACK.top);
  assert.equal(at.right, P.FALLBACK.right);
});

test("a nonsense anchor is treated as absent rather than obeyed", () => {
  // Measured at zero before layout, off-screen, or somewhere mid-page — a
  // tray at a nonsense position is worse than one in the fallback corner.
  assert.equal(P.trayPlace(1400, { left: 0, top: 0 }).anchored, false);
  assert.equal(P.trayPlace(1400, { left: 2000, top: 10 }).anchored, false);
  assert.equal(P.trayPlace(1400, { left: 1200, top: 600 }).anchored, false);
  assert.equal(P.trayPlace(1400, { left: 12, top: 10 }).anchored, false, "the LEFT sidebar's toggle");
});
