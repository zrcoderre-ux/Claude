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
  // Left to right. The key leads: it is the control you check BEFORE you read
  // or copy anything on a translated page, and Save is the one you reach for
  // after.
  const ORDER = ["key", "save", "files", "toc", "run", "folder"];
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

  // How far LEFT of its anchor the tray is displaced — claimed by name, one
  // claim per panel that occupies the right column (the bookmark panel
  // standing in for the closed sidebar; the run console dragged up in line
  // with the buttons). The largest single claim applies — the panels sit at
  // the same right edge, so the tray clears the widest one and has cleared
  // them all.
  let extraRight = 0;
  const extras = {};
  function offset(name, px) {
    extras[name] = Math.max(0, Number(px) || 0);
    let want = 0;
    for (const k of Object.keys(extras)) want = Math.max(want, extras[k]);
    extraRight = want;
    position();
  }

  function position() {
    if (!tray) return;
    const at = P.trayPlace(window.innerWidth, anchorRect());
    tray.style.top = at.top + "px";
    tray.style.right = at.right + extraRight + "px";
  }

  // ---- pushing the CHAT over, the way the native panel does ----------------
  // Panels register how much room they need; the chat is shifted by the
  // largest single claim (never a sum — see CUMPanelBar.chatReserve, which
  // computes each claim). Applied as a margin on claude.ai's own app root,
  // and taken back off the same element it was put on, even when the SPA has
  // rebuilt and the root has changed since.
  const reserves = {};
  let reservedOn = null;
  function reserve(name, px) {
    reserves[name] = Math.max(0, Number(px) || 0);
    let want = 0;
    for (const k of Object.keys(reserves)) want = Math.max(want, reserves[k]);
    let root = null;
    try {
      root = H && H.appRoot ? H.appRoot() : null;
    } catch (e) {
      root = null;
    }
    if (reservedOn && reservedOn !== root) {
      try {
        reservedOn.style.removeProperty("margin-right");
      } catch (e) {
        /* the old root is gone with the page it belonged to */
      }
      reservedOn = null;
    }
    if (!root) return;
    try {
      if (want > 0) {
        root.style.setProperty("margin-right", want + "px");
        reservedOn = root;
      } else {
        root.style.removeProperty("margin-right");
        reservedOn = null;
      }
    } catch (e) {
      /* ignore */
    }
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

  window.CUMTray = { put: put, position: position, reserve: reserve, offset: offset };
})();
