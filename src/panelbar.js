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
   * Where the run console sits — the owner's corrected spec: FIXED to the
   * right edge, only its dimensions adjustable, never its placement. `custom`
   * is { width, height } from the operator's own resizing, or null for the
   * defaults (1.75× the side panel's width, a bit over half the window tall).
   * Both are clamped to the window: a resize saved on a big monitor must not
   * overflow a laptop.
   */
  function consolePlace(viewport, sideW, custom) {
    const vw = (viewport && Number(viewport.w)) || 0;
    const vh = (viewport && Number(viewport.h)) || 0;
    const c = custom || null;
    const defW = Math.round((Number(sideW) || SIDE_W) * MARGIN_FACTOR);
    const width = Math.max(300, Math.min((c && c.width) || defW, Math.max(300, vw - 40)));
    const defH = Math.round(vh * 0.6);
    const height = Math.max(140, Math.min((c && c.height) || defH, Math.max(140, vh - CONSOLE_TOP - 12)));
    return { right: GAP, top: CONSOLE_TOP, width, height };
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

  const api = { GAP, FALLBACK, trayPlace, consolePlace, chatReserve, SIDE_W, MARGIN_FACTOR, CONSOLE_TOP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPanelBar = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
