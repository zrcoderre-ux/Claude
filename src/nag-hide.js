/**
 * Claude Usage Meter — hides claude.ai's own usage nags (ISOLATED world).
 *
 * Opt-in from the popup ("Hide claude.ai's usage-limit banners", off by
 * default). What counts as a nag is src/nag.js, pure and tested; this is the
 * finding and hiding, with the two refusals that keep it safe: nothing inside
 * a message turn is ever touched (a reply DISCUSSING limits says these very
 * words), and the climb from the matched text to the box that gets hidden is
 * bounded, so the banner's container can never take the page with it.
 * Turning the toggle off un-hides everything it hid, immediately.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  const N = window.CUMNag;
  if (!N) return;

  const KEY = "cum_hide_nags";
  const MARK = "data-cum-nag";
  const MSG =
    '[data-testid="user-message"],[data-testid="assistant-message"],' +
    ".font-user-message,.font-claude-response,.font-claude-message";

  let on = false;
  try {
    chrome.storage.local.get(KEY, (r) => {
      on = !!(r && r[KEY]);
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local" || !ch[KEY]) return;
      on = !!ch[KEY].newValue;
      if (!on) unhideAll();
    });
  } catch (e) {
    /* stays off */
  }

  function unhideAll() {
    for (const el of document.querySelectorAll("[" + MARK + "]")) {
      try {
        el.style.removeProperty("display");
        el.removeAttribute(MARK);
      } catch (e) {
        /* ignore */
      }
    }
  }

  function sweep() {
    if (!on) return;
    let leaves;
    try {
      leaves = document.querySelectorAll("span,div,p");
    } catch (e) {
      return;
    }
    for (const el of leaves) {
      if (el.children.length) continue; // the phrase lives in a leaf
      const t = el.textContent || "";
      if (!N.isNagText(t)) continue;
      if (C && C.isOurs(el)) continue;
      let inTurn = false;
      try {
        inTurn = !!(el.closest && el.closest(MSG));
      } catch (e) {
        inTurn = true; // can't tell — leave it alone
      }
      if (inTurn) continue;
      // Climb to the banner's own box: the nearest ancestor still saying only
      // banner-sized things. Bounded, so the box can never be the page.
      let box = el;
      for (let i = 0; i < 5; i++) {
        const p = box.parentElement;
        if (!p || p === document.body || p === document.documentElement) break;
        const pt = (p.textContent || "").replace(/\s+/g, " ").trim();
        if (pt.length > N.CLIMB_ROOM) break;
        box = p;
      }
      if (!N.looksLikeNag(box.textContent)) continue;
      if (box.hasAttribute(MARK)) continue;
      try {
        box.setAttribute(MARK, "1");
        box.style.setProperty("display", "none", "important");
      } catch (e) {
        /* ignore */
      }
    }
  }

  setInterval(sweep, 1500);
})();
