/**
 * Claude Usage Meter — a slot in claude.ai's own header (ISOLATED world).
 *
 * One home for the buttons this extension adds to a conversation — Save, and
 * the contents list — so they sit together beside the file and share controls
 * instead of each hunting for its own anchor and landing somewhere different.
 *
 * Three rules, each of them the answer to a way this went wrong:
 *
 *   1. ONLY claude.ai's OWN controls count. Other extensions put buttons on
 *      this page too, and they are almost always attached to <body> rather
 *      than inside claude.ai's app root — so the search is scoped to that root
 *      and their buttons stop being candidates at all. Anchoring to another
 *      extension's button is how ours ended up beside it, wherever it went.
 *
 *   2. NAME FIRST, shape second. `Share` is the one control here worth
 *      matching by name, and where it is found there is nothing to infer. Only
 *      when it isn't does this fall back to the picture: a tight cluster of
 *      controls at the top right, found by walking left from the rightmost one
 *      while they keep touching, so a gap ends the cluster before it can
 *      swallow the chat dropdown.
 *
 *   3. ONCE PLACED, STAY. The check runs every second and a half; recomputing
 *      the anchor each time meant that any flicker in the page — a control
 *      that hadn't rendered yet, another extension arriving late — moved the
 *      buttons. So a slot already sitting in a row that is still in the
 *      document and still visible is left exactly where it is. It re-anchors
 *      when the row genuinely goes, which is what a navigation does.
 *
 * Everything here also checks that what it inserted is actually VISIBLE.
 * Inserted and visible are different things: a container that clips, or a flex
 * row with no room left, puts a button in the page and nowhere on the screen —
 * which is how a button goes missing rather than moving.
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
  let placedIn = null; // the row it is in, while that row still exists

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

  // claude.ai's own markup, and nothing else's. Extensions inject into <body>;
  // claude.ai renders inside one app container, so scoping the search to that
  // container is a cheap and very effective way of not anchoring to a stranger.
  function appRoot() {
    try {
      const named = document.querySelector("#__next, #root, [data-nextjs-scroll-focus-boundary]");
      if (named) return named;
      // Whatever top-level element holds the conversation. Written this way
      // rather than as a fixed id because claude.ai doesn't version either.
      const main = document.querySelector("main");
      const top = main && main.closest("body > *");
      if (top) return top;
    } catch (e) {
      /* ignore */
    }
    return document.body || document.documentElement;
  }

  function ours(el) {
    return !!(C.isOurs(el) || (el.closest && el.closest("#" + ID)));
  }

  // Every one of claude.ai's controls in the header band, left to right.
  function controlsInBand() {
    const out = [];
    let all;
    try {
      all = appRoot().querySelectorAll('button, a[role="button"]');
    } catch (e) {
      return out;
    }
    for (const b of all) {
      if (ours(b)) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.top < 0 || r.top > BAND_PX) continue;
      if (r.left < window.innerWidth * RIGHT_FRACTION) continue;
      out.push({ el: b, left: r.left, right: r.right, top: r.top });
    }
    return out.sort((a, b) => a.left - b.left);
  }

  // Share, by name. The one control in this row worth matching on what it is
  // called: it is the thing people mean by "next to the share button", and when
  // it is found there is nothing left to guess.
  const SHARE_SELECTORS = [
    'button[data-testid="share-button"]',
    'button[aria-label="Share"]',
    'button[aria-label*="share" i]',
  ];
  function shareButton() {
    const root = appRoot();
    for (const sel of SHARE_SELECTORS) {
      let b;
      try {
        b = root.querySelector(sel);
      } catch (e) {
        continue;
      }
      if (b && !ours(b) && inBand(b)) return b;
    }
    try {
      for (const b of root.querySelectorAll("button")) {
        if (ours(b) || !inBand(b)) continue;
        if (/^\s*share\s*$/i.test(b.textContent || "")) return b;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function inBand(el) {
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8 && r.top >= 0 && r.top <= BAND_PX;
  }

  // Cowork's own right-hand sidebar, and the control that opens and shuts it.
  //
  // It matters because in Cowork that control is often the ONLY thing in the
  // header band — there is no Share — and the cluster rule insists on two
  // before it will trust what it has found. So nothing was found, and `place`
  // did what it does when there is nowhere to go: docked the buttons into the
  // meter's own pill stack, which is the bottom-right corner and not a header
  // at all.
  //
  // Named, so rule 2 holds and a lone control is enough: this is not a guess
  // about shape, it is a control that says what it is. The slot goes to its
  // LEFT, which keeps our buttons out of the sidebar's way whether it is open
  // or shut — the toggle stays put either way, so anchoring to it is the one
  // choice that doesn't move when the sidebar does.
  // ON THE RIGHT, and that is not a detail. claude.ai's own navigation sidebar
  // lives on the LEFT, its toggle is in this same band, and it is labelled
  // "sidebar" too — so a name match that didn't also ask WHERE found that one
  // first and put our buttons beside it, which is the opposite corner from the
  // one they belong in. Both arms below check the side.
  const SIDEBAR_RE = /\b(sidebar|side panel|right panel|panel|drawer|inspector)\b/i;
  function onTheRight(el) {
    const r = el.getBoundingClientRect();
    return r.left >= window.innerWidth * RIGHT_FRACTION;
  }
  function sidebarToggle() {
    const root = appRoot();
    let best = null;
    try {
      for (const b of root.querySelectorAll('button, a[role="button"]')) {
        if (ours(b) || !inBand(b) || !onTheRight(b)) continue;
        const label =
          (b.getAttribute("aria-label") || "") +
          " " +
          (b.getAttribute("title") || "") +
          " " +
          (b.getAttribute("data-testid") || "");
        if (!SIDEBAR_RE.test(label)) continue;
        // The rightmost of them, since that is where the sidebar's own handle
        // sits when there is more than one panel control up there.
        const r = b.getBoundingClientRect();
        if (!best || r.left > best.left) best = { el: b, left: r.left };
      }
    } catch (e) {
      /* ignore */
    }
    return best ? best.el : null;
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

  // Where in the DOM to insert: the outermost wrapper around the leftmost
  // control of the cluster that doesn't also hold one of the others. Inserting
  // before THAT makes the slot a sibling of the controls as they were laid out,
  // rather than something wedged inside one button's own wrapper.
  // The run of touching controls around a particular one. Used with Share: the
  // cluster it belongs to is the cluster we want, whether or not it happens to
  // be the rightmost thing on the page.
  function clusterAround(target) {
    const all = controlsInBand();
    const at = all.findIndex(
      (c) => c.el === target || c.el.contains(target) || target.contains(c.el)
    );
    if (at === -1) return [];
    const group = [all[at]];
    for (let i = at - 1; i >= 0; i--) {
      const cur = all[i];
      const next = group[0];
      if (Math.abs(cur.top - next.top) > ROW_PX) break;
      if (next.left - cur.right > GAP_PX) break;
      group.unshift(cur);
    }
    for (let i = at + 1; i < all.length; i++) {
      const cur = all[i];
      const prev = group[group.length - 1];
      if (Math.abs(cur.top - prev.top) > ROW_PX) break;
      if (cur.left - prev.right > GAP_PX) break;
      group.push(cur);
    }
    return group;
  }

  function anchorPoint() {
    const share = shareButton();
    // Named anchor where there is one, measured row either way.
    const around = share ? clusterAround(share) : [];
    const useful = around.length ? around : cluster();
    // Nothing that looks like the header yet. Refuse rather than guess: a
    // half-rendered page offers a lone button somewhere, and because a placed
    // slot then STAYS placed, a bad guess made in the first second would be
    // lived with for the rest of the page's life.
    //
    // ...unless the lone control is the sidebar toggle, which is not a guess:
    // it is named, and in Cowork it is routinely the only thing up there.
    // Without this arm the buttons went to the pill stack instead of a header.
    if (!share && useful.length < 2) {
      const side = sidebarToggle();
      return side && side.parentElement ? { parent: side.parentElement, before: side } : null;
    }
    if (!useful.length) {
      // No cluster at all, but Share is there: sit immediately before it.
      if (share && share.parentElement) return { parent: share.parentElement, before: share };
      return null;
    }
    const first = useful[0].el;
    let node = first;
    while (node.parentElement && node.parentElement !== document.body) {
      const p = node.parentElement;
      if (useful.slice(1).some((g) => p.contains(g.el))) return { parent: p, before: node };
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
    placedIn = null;
  }

  // A row the slot has already been thrown out of. Without this, a header that
  // clips the slot would take it, fail the visibility check, hand it back, and
  // be offered it again on the next tick — a button flickering between two
  // places forever. The rejection is remembered per element, and the SPA builds
  // a new one on every navigation, so it forgets by itself.
  const rejected = new WeakMap();

  // Is the slot where it was put, and is that still a real place to be? This is
  // what stops the buttons wandering: nothing is recomputed while the answer is
  // yes, so a control that renders late — or another extension arriving after
  // us — can't drag them somewhere else.
  function settled(node) {
    return !!(
      slot &&
      placedIn &&
      placedIn.isConnected &&
      slot.parentElement === placedIn &&
      node.parentElement === slot &&
      visible(node)
    );
  }

  // The slot, in a row. A slot that is already in a row that still exists stays
  // in it — the second button to ask must not be able to move the first one,
  // which is what re-deriving the anchor per caller used to do.
  function slotHome() {
    if (slot && placedIn && placedIn.isConnected && slot.parentElement === placedIn) return slot;
    const at = anchorPoint();
    if (!at) return null;
    const s = build();
    if (s.parentElement !== at.parent || s.nextElementSibling !== at.before) {
      at.parent.insertBefore(s, at.before);
    }
    placedIn = at.parent;
    return s;
  }

  /**
   * Put a button in the header, or somewhere it can at least be seen.
   * Returns "header", "docked" or "loose" — the caller styles for each.
   */
  function place(node) {
    if (!node) return "loose";
    if (settled(node)) return "header";

    const s = slotHome();
    if (s && rejected.get(node) !== placedIn) {
      if (node.parentElement !== s) s.appendChild(node);
      if (visible(node)) return "header";
      // It went in and can't be seen. Take it back out, and don't try this row
      // again.
      rejected.set(node, placedIn);
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
    sidebarToggle: sidebarToggle,
    appRoot: appRoot,
  };
})();
