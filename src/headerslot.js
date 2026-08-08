/**
 * Claude Usage Meter — a slot in claude.ai's own header (ISOLATED world).
 *
 * One home for the buttons this extension adds to a conversation — Save, and
 * the contents list — so they sit together beside the file and share controls
 * instead of each hunting for its own anchor and landing somewhere different.
 *
 * Found by SHAPE, not by name. claude.ai doesn't version this markup, and the
 * named guesses drifted: the selector list matched the chat dropdown, which is
 * its own control well to the left of the file/share pair, so that is where the
 * buttons went. What's stable is the picture — a tight cluster of controls at
 * the top right, with clear space between it and anything further left. So the
 * cluster is found by adjacency: start at the rightmost control in the header
 * band and walk left while the controls keep touching. A gap ends it, which is
 * exactly what separates that cluster from the dropdown.
 *
 * Everything here checks that what it inserted is actually VISIBLE. Inserted
 * and visible are different things: a container that clips, or a flex row with
 * no room left, puts a button in the page and nowhere on the screen — which is
 * how a button goes missing rather than moving.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  if (!C) return;

  const ID = "cum-hslot";
  const BAND_PX = 90; // how far down the window claude.ai's header reaches
  const RIGHT_FRACTION = 0.45; // and the half of it these controls live in
  const GAP_PX = 28; // more space than this between two controls is a gap
  const ROW_PX = 12; // and this much difference in height is another row

  let slot = null;

  function visible(node) {
    if (!node) return false;
    const r = node.getBoundingClientRect();
    return (
      r.width >= 16 &&
      r.height >= 12 &&
      r.top >= 0 &&
      r.left >= 0 &&
      r.bottom <= window.innerHeight &&
      r.right <= window.innerWidth
    );
  }

  // Every control in the header band, left to right. Ours are skipped, or the
  // slot would start measuring itself.
  function controlsInBand() {
    const out = [];
    let all;
    try {
      all = document.querySelectorAll('button, a[role="button"]');
    } catch (e) {
      return out;
    }
    for (const b of all) {
      if (C.isOurs(b) || (b.closest && b.closest("#" + ID))) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.top < 0 || r.top > BAND_PX) continue;
      if (r.left < window.innerWidth * RIGHT_FRACTION) continue;
      out.push({ el: b, left: r.left, right: r.right, top: r.top });
    }
    return out.sort((a, b) => a.left - b.left);
  }

  // The rightmost run of controls that touch each other. Walking left stops at
  // the first real gap, so the file/share pair is found without the dropdown
  // that sits well clear of it.
  function cluster() {
    const all = controlsInBand();
    if (!all.length) return [];
    const group = [all[all.length - 1]];
    for (let i = all.length - 2; i >= 0; i--) {
      const cur = all[i];
      const next = group[0];
      if (Math.abs(cur.top - next.top) > ROW_PX) break; // a different row
      if (next.left - cur.right > GAP_PX) break; // a different group
      group.unshift(cur);
    }
    return group;
  }

  // Where in the DOM that cluster's left end is: the outermost wrapper around
  // the leftmost control that doesn't also hold one of the others. Inserting
  // before THAT makes the slot a sibling of the controls as they were laid out,
  // rather than something wedged inside one button's own wrapper.
  function anchorPoint() {
    const group = cluster();
    if (!group.length) return null;
    const first = group[0].el;
    let node = first;
    while (node.parentElement && node.parentElement !== document.body) {
      const p = node.parentElement;
      if (group.slice(1).some((g) => p.contains(g.el))) return { parent: p, before: node };
      node = p;
    }
    return first.parentElement ? { parent: first.parentElement, before: first } : null;
  }

  function build() {
    if (slot) return slot;
    slot = document.createElement("div");
    slot.id = ID;
    return slot;
  }

  function detach() {
    if (slot && slot.parentNode) slot.remove();
  }

  // A row the slot has already been thrown out of. Without this, a header that
  // clips the slot would take it, fail the visibility check, hand it back, and
  // be offered it again on the next tick — a button flickering between two
  // places forever. The rejection is remembered per element, and the SPA builds
  // a new one on every navigation, so it forgets by itself.
  const rejected = new WeakMap();

  /**
   * Put a button in the header, or somewhere it can at least be seen.
   * Returns "header", "docked" or "loose" — the caller styles for each.
   */
  function place(node) {
    if (!node) return "loose";
    const at = anchorPoint();
    if (at && rejected.get(node) !== at.parent) {
      const s = build();
      if (s.parentElement !== at.parent || s.nextElementSibling !== at.before) {
        at.parent.insertBefore(s, at.before);
      }
      if (node.parentElement !== s) s.appendChild(node);
      if (visible(node)) return "header";
      // It went in and can't be seen. Take it back out, and don't try this row
      // again.
      rejected.set(node, at.parent);
      node.remove();
      if (!s.childElementCount) detach();
    }
    // Nothing to sit beside, or nowhere in it that shows. Dock into the meter's
    // own indicator stack, which is ours and so cannot be covering anything of
    // claude.ai's.
    const stack = document.getElementById("cum-pills");
    const home = stack || document.body || document.documentElement;
    if (node.parentNode !== home) home.appendChild(node);
    return stack ? "docked" : "loose";
  }

  window.CUMHeaderSlot = {
    place: place,
    detach: detach,
    visible: visible,
    cluster: cluster,
  };
})();
