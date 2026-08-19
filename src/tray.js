/**
 * Claude Usage Meter — the button tray beside claude.ai's own sidebar toggle
 * (ISOLATED world content script).
 *
 * The owner's spec, verbatim in spirit: the extension's Save, Bookmark and Run
 * buttons sit NEXT TO the native top-right sidebar control, in both sidebar
 * states; the Bookmark and Run panels open IN LINE with the buttons — panel
 * tops level with the button row, the way the native sidebar panel opens —
 * and an open panel shifts the rest of the row over.
 *
 * The tray therefore cannot be absolutely fixed: Cowork's sidebar toggle
 * moves left by the sidebar's own width when the sidebar opens, and a fixed
 * button sat on top of the toggle in one state and inside the sidebar in the
 * other. The tray re-anchors to wherever the toggle is on a timer, falling
 * back to the header cluster's left edge (Chat has no sidebar toggle), and to
 * the top-right corner when the page offers neither.
 *
 * Layout does the shifting for free: the tray is one flex row pinned by its
 * RIGHT edge, each feature is a slot holding [button][panel], and a panel
 * appearing widens the tray leftward — the buttons to its left move over,
 * the edge beside the native control never does. The geometry decisions live
 * in src/panelbar.js, pure and tested.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  const H = window.CUMHeaderSlot;
  const P = window.CUMPanelBar;
  if (!C || !P) return;

  const ID = "cum-tray";
  const ORDER = ["save", "toc", "run"];
  const TICK_MS = 1000;

  let tray = null;
  const slots = {};

  function build() {
    if (tray && tray.isConnected) return tray;
    tray = document.getElementById(ID);
    if (!tray) {
      tray = document.createElement("div");
      tray.id = ID;
      for (const name of ORDER) {
        const s = document.createElement("div");
        s.className = "cum-tray-slot";
        s.dataset.slot = name;
        tray.appendChild(s);
        slots[name] = s;
      }
    } else {
      for (const s of tray.querySelectorAll(".cum-tray-slot")) slots[s.dataset.slot] = s;
    }
    (document.body || document.documentElement).appendChild(tray);
    return tray;
  }

  // The control the tray anchors to: the right sidebar's toggle where there
  // is one (Cowork), else the leftmost control of the header's own cluster
  // (Chat), else nothing — panelbar's fallback corner takes it from there.
  function anchorRect() {
    try {
      const side = H && H.sidebarToggle();
      if (side) {
        const r = side.getBoundingClientRect();
        return { left: r.left, top: r.top };
      }
    } catch (e) {
      /* the cluster below is the fallback */
    }
    try {
      const cl = H && H.cluster();
      if (cl && cl.length) return { left: cl[0].left, top: cl[0].top };
    } catch (e) {
      /* the corner is the last resort */
    }
    return null;
  }

  function position() {
    if (!tray) return;
    const at = P.trayPlace(window.innerWidth, anchorRect());
    tray.style.top = at.top + "px";
    tray.style.right = at.right + "px";
  }

  /**
   * Put a feature's pieces in its slot, in the order given — the button, and
   * (for the panel features) the panel beside it. Idempotent per tick; nodes
   * already in place are left alone, so focus and scroll inside an open panel
   * survive the re-assertion. Visibility stays each module's own business —
   * a hidden button or panel takes no space in the row.
   */
  function put(name) {
    build();
    const s = slots[name];
    if (!s) return;
    const nodes = Array.prototype.slice.call(arguments, 1).filter(Boolean);
    nodes.forEach((node, i) => {
      if (node.parentElement !== s || s.children[i] !== node) {
        const before = s.children[i] || null;
        s.insertBefore(node, before);
      }
    });
    position();
  }

  setInterval(position, TICK_MS);
  window.addEventListener("resize", position);

  window.CUMTray = { put: put, position: position };
})();
