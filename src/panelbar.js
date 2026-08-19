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

  // The left sidebar panel's usual width, for sizing before it has been seen
  // open — and the factor the owner asked for.
  const MARGIN_BASE_W = 288;
  const MARGIN_FACTOR = 1.75;

  /**
   * Where the run console sits, as { left, top, width }. `side` is the left
   * sidebar's rect ({ left, right, top, bottom, width, height }) or null.
   * The owner's spec: right underneath the left panel when it is open, and
   * where the panel would go when it is closed; about 1.75× the panel's width.
   *
   * Three cases, in order: an open panel with room beneath it gets the console
   * directly under it; an open panel running the full height gets it alongside
   * (there is no "underneath" to have); a closed rail — or no sidebar at all —
   * gets it where the open panel would go, beside the rail under the top bar.
   */
  function marginPlace(viewport, side) {
    const vw = (viewport && Number(viewport.w)) || 0;
    const vh = (viewport && Number(viewport.h)) || 0;
    const open = !!(side && side.width >= 200);
    const baseW = open ? side.width : MARGIN_BASE_W;
    const width = Math.max(320, Math.min(Math.round(baseW * MARGIN_FACTOR), Math.max(320, vw - 40)));
    if (open && side.bottom < vh - 160)
      return { left: Math.max(0, Math.round(side.left)), top: Math.round(side.bottom + GAP), width };
    if (open) return { left: Math.round(side.right + GAP), top: 56, width };
    const left = side ? Math.min(Math.max(GAP, Math.round(side.right + GAP)), 120) : GAP;
    return { left, top: 56, width };
  }

  const api = { GAP, FALLBACK, trayPlace, marginPlace, MARGIN_BASE_W, MARGIN_FACTOR };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPanelBar = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
