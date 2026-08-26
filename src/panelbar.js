/**
 * Panel bar — the decisions behind the button tray that sits beside
 * claude.ai's own right-sidebar toggle (the owner's spec: Save, Bookmark and
 * Run next to the native control, panels opening IN LINE with the buttons,
 * everything shifting left as panels take space).
 *
 * The tray cannot be absolutely fixed: Cowork's sidebar toggle moves left by
 * the sidebar's own width when the sidebar opens, and a fixed tray ended up on
 * top of the toggle in one state and inside the sidebar in the other. So the
 * tray is anchored to wherever the toggle IS, re-read on a timer — and these
 * are the pure decisions that turn a measured anchor into a position, kept out
 * of the wiring so they can be tested.
 *
 * Pure: no DOM, no chrome.
 */
(function (root) {
  "use strict";

  // Space between the tray and the control it anchors to, and between units.
  const GAP = 8;
  // Nowhere to anchor (no toggle, no header cluster — a page still booting):
  // the corner the owner chose, high on the right.
  const FALLBACK = { top: 8, right: 12 };

  /**
   * Where the tray sits, as { top, right, anchored }. `anchor` is the anchor
   * control's viewport rect ({ left, top }), or null when none was found.
   * Anchoring is BY THE RIGHT EDGE: the tray's right edge lands GAP left of
   * the anchor, so panels opening inside the tray grow it leftward and push
   * the other buttons over — the shift the owner asked for — while the edge
   * beside the native control never moves.
   *
   * An anchor that makes no sense — off-screen, or measuring at zero before
   * layout — is treated as absent rather than obeyed: a tray at a nonsense
   * position is worse than one in the fallback corner.
   */
  function trayPlace(viewportW, anchor) {
    const vw = Number(viewportW) || 0;
    const a = anchor || null;
    const sane =
      a &&
      typeof a.left === "number" &&
      typeof a.top === "number" &&
      a.left > 40 && // a toggle at the far left is not the RIGHT sidebar's
      a.left <= vw &&
      a.top >= 0 &&
      a.top <= 200; // the header band, generously — not something mid-page
    if (!sane) return { top: FALLBACK.top, right: FALLBACK.right, anchored: false };
    return { top: Math.max(0, Math.round(a.top)), right: Math.max(0, Math.round(vw - a.left + GAP)), anchored: true };
  }

  // The native side panel's usual width, for every decision made before it
  // has been measured open (the owner measured 312) — and the run console's
  // width factor of it.
  const SIDE_W = 312;
  const MARGIN_FACTOR = 1.75;
  // Where the console's top sits: below the tray's button row, which it may
  // never overlap.
  const CONSOLE_TOP = 52;

  /**
   * Where the run console sits — the owner's spec, as amended: FIXED to the
   * right edge, dimensions adjustable, and the TOP draggable up and down —
   * vertical placement is the operator's, horizontal never is. `custom` is
   * { width, height, top } from the operator's own dragging, or null for the
   * defaults (1.75× the side panel's width, a bit over half the window tall,
   * top just under the button row). Everything is clamped to the window: a
   * spot saved on a big monitor must not overflow a laptop, and a dragged
   * top always leaves at least the minimum height on screen.
   */
  function consolePlace(viewport, sideW, custom) {
    const vw = (viewport && Number(viewport.w)) || 0;
    const vh = (viewport && Number(viewport.h)) || 0;
    const c = custom || null;
    const defW = Math.round((Number(sideW) || SIDE_W) * MARGIN_FACTOR);
    const width = Math.max(300, Math.min((c && c.width) || defW, Math.max(300, vw - 40)));
    const rawTop = c && typeof c.top === "number" ? c.top : CONSOLE_TOP;
    const top = Math.max(0, Math.min(Math.round(rawTop), Math.max(0, vh - 140 - 12)));
    const defH = Math.round(vh * 0.6);
    const height = Math.max(140, Math.min((c && c.height) || defH, Math.max(140, vh - top - 12)));
    return { right: GAP, top, width, height };
  }

  /**
   * How far the TRAY must move left to clear the console — the owner's rule:
   * the console affects the buttons' placement ONLY when it is dragged in
   * line with them, and they can never overlap. The console sits at the right
   * edge; when its top rises above the button row's bottom, the row must
   * clear the console's whole width (plus a gap). Below the row, nothing.
   */
  function trayDodge(consoleTop, consoleWidth, trayBottom) {
    // A measurement that is missing is not a measurement of zero.
    if (typeof consoleTop !== "number" || !isFinite(consoleTop)) return 0;
    if (typeof trayBottom !== "number" || !isFinite(trayBottom)) return 0;
    if (consoleTop >= trayBottom) return 0;
    return Math.max(0, Math.round(Number(consoleWidth) || 0) + GAP);
  }

  // A toggle-to-edge gap wider than this reads as the native side panel
  // being open (the panel itself is ~312; buttons are ~40).
  const SIDE_OPEN_MIN = 200;

  /**
   * The gap that tells the native side panel's state, read off its toggle:
   * the panel open pushes the toggle left by its own width, so the gap
   * between the toggle and the right edge IS the panel. But measured against
   * the WINDOW edge that gap lies: our own chat reservation (a margin-right
   * on the app root) displaces the toggle exactly the way the native panel
   * does, and a detector that measured to the window chased its own margin —
   * console open, sidebar closed → margin on → "sidebar open" → margin off →
   * "sidebar closed" → margin on, a cascade that never settled. Measured
   * against the APP ROOT's right edge, our margin moves root and toggle
   * together and cancels out, while the native panel — inside the root —
   * still shows as the gap. The window edge is only the fallback for when
   * the root cannot be measured.
   */
  function sideGap(toggleRight, rootRight, viewportW) {
    const rr = Number(rootRight);
    const edge = isFinite(rr) && rr > 0 ? rr : Number(viewportW) || 0;
    return Math.round(edge - (Number(toggleRight) || 0));
  }

  /**
   * How far the CHAT is pushed left by the extension's panels — always by the
   * NATIVE side panel's width, never a panel's own (the owner's spec: our
   * panels shift the conversation exactly as the native one does, so the chat
   * centres the same either way). The native panel being open already
   * provides the shift, so ours add nothing on top of it; and two of our
   * panels open at once still reserve the one width, not two.
   */
  function chatReserve(state) {
    const s = state || {};
    if (s.sidebarOpen) return 0;
    if (s.consoleOpen || s.tocColumn) return Math.round(Number(s.sideW) || SIDE_W);
    return 0;
  }

  /**
   * Where a small card sits relative to the control it belongs to — the Upload
   * folder button's note, whose button lives down in claude.ai's own composer
   * row rather than up in the tray.
   *
   * ABOVE the control by preference, because the composer is at the bottom of
   * the window and a card below it would be off-screen; below only when there
   * is no room above. Left-aligned with the control and clamped to the window,
   * so a control near the right edge doesn't push the card off it.
   *
   * With no control to anchor to — the note outlives the button, which is the
   * whole point of it: the send navigates off the composer and the naming
   * happens after that — the card goes to the bottom centre, clear of the
   * usage pill and the pseudonym badge in the corners.
   *
   * `anchor` is the control's viewport rect, `card` its own { w, h },
   * `viewport` the window's { w, h }. Answers { left, top } for a fixed card.
   */
  const CARD_EDGE = 8; // never closer than this to any window edge
  const CARD_BOTTOM = 96; // how far up from the bottom an unanchored card sits
  function cardNear(anchor, card, viewport) {
    const vw = (viewport && Number(viewport.w)) || 0;
    const vh = (viewport && Number(viewport.h)) || 0;
    const w = (card && Number(card.w)) || 0;
    const h = (card && Number(card.h)) || 0;
    const clampLeft = (x) => Math.max(CARD_EDGE, Math.min(Math.round(x), Math.max(CARD_EDGE, vw - w - CARD_EDGE)));
    const clampTop = (y) => Math.max(CARD_EDGE, Math.min(Math.round(y), Math.max(CARD_EDGE, vh - h - CARD_EDGE)));
    const a = anchor || null;
    const sane =
      a &&
      typeof a.top === "number" &&
      typeof a.left === "number" &&
      isFinite(a.top) &&
      isFinite(a.left) &&
      (Number(a.width) || 0) > 0 &&
      (Number(a.height) || 0) > 0;
    if (!sane) return { left: clampLeft((vw - w) / 2), top: clampTop(vh - h - CARD_BOTTOM) };
    const above = a.top - h - GAP;
    const top = above >= CARD_EDGE ? above : (Number(a.bottom) || a.top + (Number(a.height) || 0)) + GAP;
    return { left: clampLeft(a.left), top: clampTop(top) };
  }

  const api = {
    GAP,
    FALLBACK,
    cardNear,
    trayPlace,
    consolePlace,
    trayDodge,
    sideGap,
    SIDE_OPEN_MIN,
    chatReserve,
    SIDE_W,
    MARGIN_FACTOR,
    CONSOLE_TOP,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPanelBar = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
