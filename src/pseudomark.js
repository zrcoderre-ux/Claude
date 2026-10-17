/**
 * Claude Usage Meter — the pseudonym marks (pure).
 *
 * The text reader in the PDF viewer shows every fake as its real value,
 * LIGHTLY HIGHLIGHTED, and hovering a marked name shows the pseudonym
 * underneath. The same here: a name the display swapped is marked, so what you
 * read in the real names is never confused with what claude.ai holds, and the
 * hover says exactly what Claude saw in its place.
 *
 * The marks are drawn with the CSS Custom Highlight API rather than by wrapping
 * the name in an element. claude.ai is a React app; the display swap already
 * edits a text node's value, which React tolerates, but splitting a node into
 * spans is the kind of edit that breaks a streaming reply's reconciliation. A
 * highlight is painted over a Range and changes nothing in the DOM — and so
 * nothing in a copy either: Copy ruling and ⌘C carry the text, never the mark.
 *
 * The decisions in here:
 *
 *   THE SETTINGS. On, colour and intensity — the reader's own three, with its
 *   defaults (a light cyan at 0.18), so the two tools look the same until
 *   someone sets them apart. A colour that isn't a #rrggbb hex, or an
 *   intensity out of range, falls back rather than painting nothing: a mark
 *   that silently stopped showing would be the feature switched off without
 *   anyone choosing to.
 *
 *   WHICH SWAP IS UNDER THE POINTER. The page answers with a caret position —
 *   a text node and an offset between two characters — and the swap is the
 *   one whose span holds it. An offset on a span's far edge (the pointer over
 *   the last letter's right half) belongs to that span, but only where no span
 *   starts there.
 *
 * Pure: no DOM, no chrome. The painting and the hover are src/pseudo-view.js;
 * the controls are the key panel's (src/key-panel.js).
 */
(function (root) {
  "use strict";

  const MARK_KEY = "cum_pseudo_mark";
  const DEFAULT_MARK = { on: true, color: "#19dcfa", alpha: 0.18 };
  const ALPHA_MIN = 0.04;
  const ALPHA_MAX = 0.9;
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;

  /** A stored setting as one to paint with: { on, color, alpha }, every field valid. */
  function normalizeMark(v) {
    const s = v && typeof v === "object" ? v : {};
    const color = HEX_RE.test(String(s.color || "")) ? String(s.color).toLowerCase() : DEFAULT_MARK.color;
    const a = Number(s.alpha);
    const alpha = isFinite(a) && s.alpha !== null && s.alpha !== "" ? Math.min(ALPHA_MAX, Math.max(ALPHA_MIN, a)) : DEFAULT_MARK.alpha;
    return { on: s.on === undefined ? DEFAULT_MARK.on : !!s.on, color: color, alpha: alpha };
  }

  /** The two fills: the mark, and the stronger one under the pointer. */
  function markColors(v) {
    const s = normalizeMark(v);
    const r = parseInt(s.color.slice(1, 3), 16);
    const g = parseInt(s.color.slice(3, 5), 16);
    const b = parseInt(s.color.slice(5, 7), 16);
    const rgba = (x) => "rgba(" + r + ", " + g + ", " + b + ", " + Math.min(1, x).toFixed(3) + ")";
    return { bg: rgba(s.alpha), hover: rgba(s.alpha + 0.3) };
  }

  /**
   * The stylesheet for the two highlights. A literal colour rather than a
   * custom property: what a ::highlight() rule resolves var() against has
   * changed across Chrome versions, and a literal cannot.
   */
  function markCss(v) {
    const c = markColors(v);
    return (
      "::highlight(cum-pseudo){background-color:" + c.bg + "}" +
      "::highlight(cum-pseudo-hover){background-color:" + c.hover + "}"
    );
  }

  /** The span of `spans` ([start, end, fake]) that holds caret `offset`, or null. */
  function spanAt(spans, offset) {
    if (!spans || !spans.length || !(offset >= 0)) return null;
    let edge = null;
    for (const s of spans) {
      if (offset >= s[0] && offset < s[1]) return s;
      if (offset === s[1]) edge = s;
    }
    return edge;
  }

  /** What the hover says over a marked name. */
  function tipText(fake) {
    return "Pseudonym: " + String(fake == null ? "" : fake);
  }

  const api = {
    MARK_KEY,
    DEFAULT_MARK,
    ALPHA_MIN,
    ALPHA_MAX,
    normalizeMark,
    markColors,
    markCss,
    spanAt,
    tipText,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPseudoMark = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
