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

  const api = { GAP, FALLBACK, trayPlace };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPanelBar = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
