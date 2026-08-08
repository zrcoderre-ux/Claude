/**
 * Claude Usage Meter — table of contents for a conversation (pure module).
 *
 * A long chat is a scroll bar and nothing else. This turns YOUR messages into
 * a list you can jump between — the same job a table of authorities does in a
 * brief — so the shape of a conversation is visible without reading it.
 *
 * Only the labelling and list-building live here. Finding the messages and
 * scrolling to them is DOM work and belongs in src/toc-panel.js; this is the
 * part worth testing, because a label that says nothing makes the list useless
 * and a label that lies makes it worse than useless.
 */
(function (root) {
  "use strict";

  const MAX_LABEL = 80;

  function str(x) {
    return typeof x === "string" ? x : x == null ? "" : String(x);
  }

  // The first line that carries any meaning. A prompt often opens with a skill
  // invocation — "Use the devils-advocate skill." — and if every entry in the
  // list said that, the list would distinguish nothing. So a first line that is
  // only an instruction to Claude is stepped over in favour of the next one,
  // unless it's all there is.
  const BOILERPLATE = /^(use the [\w-]+ skill|continue|go on|thanks?|ok(ay)?)\b[.!]?$/i;

  function meaningfulLines(text) {
    return str(text)
      .split("\n")
      .map((l) =>
        l
          // Markdown decoration is not part of what the line says.
          .replace(/^[\s>#*\-•\d.)\]]+/, "")
          .replace(/[*_`]+/g, "")
          .trim()
      )
      .filter((l) => l.length > 0);
  }

  // A label for one message. Cut on a word boundary where there is one — a
  // label ending mid-word reads as though the text is missing rather than
  // shortened.
  function tocLabel(text, max) {
    const cap = typeof max === "number" && max > 8 ? max : MAX_LABEL;
    const lines = meaningfulLines(text);
    if (!lines.length) return "";
    let line = lines.find((l) => !BOILERPLATE.test(l)) || lines[0];
    if (line.length <= cap) return line;
    const cut = line.slice(0, cap);
    const space = cut.lastIndexOf(" ");
    return (space > cap * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:—-]+$/, "") + "…";
  }

  // The list itself. Numbered from 1 in the order they were sent, because the
  // number is what you actually navigate by ("the third thing I asked"), and
  // it's the one part of an entry that can't be ambiguous.
  //
  // Messages with nothing to label — an upload with no words, say — still get
  // an entry: they happened, they take up room in the chat, and a list that
  // skipped them would put entry 4 where the fifth message is.
  function tocEntries(messages) {
    const out = [];
    for (const m of messages || []) {
      if (!m) continue;
      const text = typeof m === "string" ? m : str(m.text);
      const label = tocLabel(text);
      out.push({
        n: out.length + 1,
        id: (typeof m === "object" && m.id) || null,
        label: label || "(no text)",
        empty: !label,
        chars: text.length,
      });
    }
    return out;
  }

  const api = { tocLabel, tocEntries, MAX_LABEL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMToc = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
