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

test("the console is pinned to the right edge, dimensions only", () => {
  const at = P.consolePlace({ w: 1400, h: 900 }, 312, null);
  assert.equal(at.right, P.GAP);
  assert.equal(at.top, P.CONSOLE_TOP);
  assert.equal(at.width, Math.round(312 * P.MARGIN_FACTOR));
  const sized = P.consolePlace({ w: 1400, h: 900 }, 312, { width: 700, height: 500 });
  assert.equal(sized.width, 700);
  assert.equal(sized.height, 500);
  assert.equal(sized.right, P.GAP, "resizing never moves it off the right edge");
});

test("a resize saved on a big monitor is clamped to a small window", () => {
  const at = P.consolePlace({ w: 800, h: 600 }, 312, { width: 1200, height: 900 });
  assert.ok(at.width <= 800 - 40);
  assert.ok(at.height <= 600 - P.CONSOLE_TOP - 12);
});

test("the chat shifts by the NATIVE panel's width, and never twice", () => {
  // Native panel open: it already shifted the chat — ours add nothing.
  assert.equal(P.chatReserve({ sidebarOpen: true, consoleOpen: true, tocColumn: true, sideW: 312 }), 0);
  // Native closed, console open: the chat shifts as if the native panel were
  // open — the side panel's width, not the console's own.
  assert.equal(P.chatReserve({ sidebarOpen: false, consoleOpen: true, sideW: 312 }), 312);
  // The bookmark column reserves the same, and both together still reserve one.
  assert.equal(P.chatReserve({ sidebarOpen: false, tocColumn: true, sideW: 312 }), 312);
  assert.equal(P.chatReserve({ sidebarOpen: false, consoleOpen: true, tocColumn: true, sideW: 312 }), 312);
  // Everything closed: the chat sits centred, untouched.
  assert.equal(P.chatReserve({ sidebarOpen: false, sideW: 312 }), 0);
  assert.equal(P.chatReserve(null), 0);
});
