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

test("the run console sits under an open left panel with room beneath it", () => {
  const at = P.marginPlace({ w: 1400, h: 900 }, { left: 0, right: 288, top: 0, bottom: 600, width: 288, height: 600 });
  assert.equal(at.left, 0);
  assert.equal(at.top, 600 + P.GAP);
  assert.equal(at.width, Math.round(288 * P.MARGIN_FACTOR));
});

test("a full-height open panel has no underneath, so the console sits alongside", () => {
  const at = P.marginPlace({ w: 1400, h: 900 }, { left: 0, right: 288, top: 0, bottom: 900, width: 288, height: 900 });
  assert.equal(at.left, 288 + P.GAP);
  assert.equal(at.top, 56);
});

test("closed rail or no sidebar: where the open panel would go", () => {
  const rail = P.marginPlace({ w: 1400, h: 900 }, { left: 0, right: 64, top: 0, bottom: 900, width: 64, height: 900 });
  assert.equal(rail.left, 64 + P.GAP);
  assert.equal(rail.top, 56);
  assert.equal(rail.width, Math.round(P.MARGIN_BASE_W * P.MARGIN_FACTOR));
  const none = P.marginPlace({ w: 1400, h: 900 }, null);
  assert.equal(none.left, P.GAP);
});

test("the console never outgrows a small window", () => {
  const at = P.marginPlace({ w: 480, h: 700 }, null);
  assert.ok(at.width <= 480 - 40 || at.width === 320);
});
