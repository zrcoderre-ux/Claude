/**
 * Native usage nags — the decisions behind hiding claude.ai's own
 * "Approaching weekly limit / Get more usage" banners (pure module).
 *
 * The owner measures usage with this extension and finds claude.ai's banners
 * frequently inaccurate, so they can be hidden — opt-in, from the popup, like
 * every other behaviour here that touches the page on the user's behalf.
 *
 * The delicate part is what must NOT be hidden: a conversation ABOUT usage
 * limits contains these very phrases, and a hider that ate sentences out of a
 * reply would be far worse than a wrong banner. So the match is two-part —
 * the words, and the SIZE: a banner says its phrase and stops, a paragraph
 * goes on. The wiring (src/nag-hide.js) additionally refuses anything inside
 * a message turn.
 *
 * Pure: no DOM, no chrome.
 */
(function (root) {
  "use strict";

  const squash = (v) =>
    String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]+/g, "");

  // The banners' own words, letters alone — claude.ai's markup carries
  // characters no whitespace rule removes. From the live banner: a span
  // "Approaching weekly limit" beside a "Get more usage" link and a Dismiss.
  const PHRASES = [
    "approachingweeklylimit",
    "approachingsessionlimit",
    "approachingmonthlylimit",
    "approachingusagelimit",
    "approachingyourlimit",
    "getmoreusage",
    "upgradeformoreusage",
  ];

  /** Whether this text carries a nag phrase at all. */
  function isNagText(text) {
    const t = squash(text);
    if (!t) return false;
    return PHRASES.some((p) => t.indexOf(p) !== -1);
  }

  // A banner says its phrase and stops; a paragraph discussing limits goes on.
  // The live banner's whole text — "Approaching weekly limitGet more usage" —
  // is ~40 characters; triple that is still no sentence about anything.
  const MAX_BANNER_CHARS = 140;
  /** Whether this text IS a nag — the words, at banner size. */
  function looksLikeNag(text) {
    if (!isNagText(text)) return false;
    return String(text || "").replace(/\s+/g, " ").trim().length <= MAX_BANNER_CHARS;
  }

  // How much text an ancestor may hold and still be the banner's own box —
  // the climb bound the wiring uses, so hiding the banner can never hide the
  // container the banner merely sits in.
  const CLIMB_ROOM = 240;

  const api = { isNagText, looksLikeNag, MAX_BANNER_CHARS, CLIMB_ROOM };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMNag = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
