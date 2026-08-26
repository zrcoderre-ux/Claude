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

test("the top drags the console up and down, clamped to the window", () => {
  const up = P.consolePlace({ w: 1400, h: 900 }, 312, { top: 8 });
  assert.equal(up.top, 8);
  assert.equal(up.right, P.GAP, "vertical placement is the operator's; horizontal never is");
  // Dragged above the window: it stops at the top edge.
  assert.equal(P.consolePlace({ w: 1400, h: 900 }, 312, { top: -50 }).top, 0);
  // Dragged (or remembered from a taller monitor) below the window: enough of
  // it stays on screen to grab back.
  const low = P.consolePlace({ w: 1400, h: 600 }, 312, { top: 5000, height: 400 });
  assert.ok(low.top <= 600 - 140 - 12);
  assert.ok(low.top + low.height <= 600 - 12 + 1);
  // No dragged top: the default, under the button row.
  assert.equal(P.consolePlace({ w: 1400, h: 900 }, 312, { width: 700 }).top, P.CONSOLE_TOP);
});

test("the console pushes the buttons left only when dragged in line with them", () => {
  // Below the button row (the default): the buttons stay put.
  assert.equal(P.trayDodge(52, 546, 44), 0);
  // Dragged up in line with the row: they can never overlap — the row clears
  // the console's whole width plus a gap.
  assert.equal(P.trayDodge(8, 546, 44), 546 + P.GAP);
  // Nothing to measure, nothing to dodge.
  assert.equal(P.trayDodge(null, 546, 44), 0);
  assert.equal(P.trayDodge(8, 546, null), 0);
});

test("our own chat reservation does not read as the sidebar (the cascade)", () => {
  // Live failure: console open, sidebar closed. The reservation put a 312px
  // margin on the app root; measured against the WINDOW the toggle now sat
  // 312+ from the edge, which read as "sidebar open", which dropped the
  // reservation, which read as "sidebar closed"… a cascade that never
  // settled. Against the APP ROOT's edge the margin moves both together.
  const vw = 1400;
  const rootRightWithMargin = vw - 312; // our reservation applied
  const toggleRight = rootRightWithMargin - 16; // toggle just inside the root
  const gap = P.sideGap(toggleRight, rootRightWithMargin, vw);
  assert.ok(gap <= P.SIDE_OPEN_MIN, "still reads CLOSED — no cascade");
  assert.ok(vw - toggleRight > P.SIDE_OPEN_MIN, "the window-edge reading was the bug");
  // The native panel actually open still shows: the toggle moves left INSIDE
  // the root, whose edge stays put.
  assert.ok(P.sideGap(vw - 312 - 16, vw, vw) > P.SIDE_OPEN_MIN);
  // No root to measure: the window edge is the fallback, not a crash.
  assert.equal(P.sideGap(vw - 16, null, vw), 16);
});

// ---- the card that hangs off a button in the composer's own row -------------

const CARD = { w: 340, h: 180 };
const VIEW = { w: 1400, h: 900 };
const at = (left, top, w, h) => ({ left, top, width: w, height: h, bottom: top + h });

test("the note sits ABOVE the control it belongs to — the composer is at the bottom", () => {
  const got = P.cardNear(at(500, 760, 90, 34), CARD, VIEW);
  assert.equal(got.left, 500); // left-aligned with the button
  assert.equal(got.top, 760 - CARD.h - P.GAP);
});

test("with no room above, it goes below rather than off the top of the window", () => {
  const got = P.cardNear(at(500, 60, 90, 34), CARD, VIEW);
  assert.equal(got.top, 60 + 34 + P.GAP);
});

test("a control near the right edge doesn't push the card off it", () => {
  const got = P.cardNear(at(1380, 700, 90, 34), CARD, VIEW);
  assert.equal(got.left, VIEW.w - CARD.w - 8);
  assert.ok(got.left + CARD.w <= VIEW.w);
});

test("no control to anchor to — the note outlives the button — is the bottom centre", () => {
  const got = P.cardNear(null, CARD, VIEW);
  assert.equal(got.left, Math.round((VIEW.w - CARD.w) / 2));
  assert.equal(got.top, VIEW.h - CARD.h - 96);
  // A rect that measured at zero before layout is not an anchor either.
  assert.deepEqual(P.cardNear(at(500, 700, 0, 0), CARD, VIEW), got);
});

test("a card taller than the window is clamped rather than hung off the top", () => {
  const tall = { w: 340, h: 1200 };
  const got = P.cardNear(at(500, 760, 90, 34), tall, VIEW);
  assert.equal(got.top, 8);
});
