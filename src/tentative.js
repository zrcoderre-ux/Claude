/**
 * Claude Usage Meter — the tentative ruling out of a reply (pure module).
 *
 * A reply that contains a tentative ruling usually contains other things too:
 * a note about what was assumed, a question about a missing paper, an offer to
 * revise. Claude separates those from the ruling with a horizontal rule — which
 * you cannot select on the page, but which the copy box copies as `---`, along
 * with everything on either side of it.
 *
 * What goes into a minute order is the ruling and nothing else, so this cuts it
 * out: from the **NATURE OF PROCEEDINGS** heading through the end of the
 * **CONCLUSION** section, with the rules themselves dropped.
 *
 * Where the boundaries come from, and why:
 *
 * - **The start is the heading**, not the top of the reply. Everything Claude
 *   says before the ruling is commentary, whether or not a rule separates it.
 * - **The end is the first rule after CONCLUSION.** Not the first rule after
 *   the start: a ruling of any length may well have rules inside it, and one
 *   that ended at the first one would hand back the first section alone. Not
 *   the last rule in the reply either, which would take the commentary with it.
 * - **CONCLUSION is looked for after the start**, so a "Conclusion" in Claude's
 *   own remarks underneath can't be mistaken for the ruling's.
 * - **A rule directly under a line of text is left alone**, because in Markdown
 *   that is a setext heading rather than a break — `CONCLUSION` with `---` under
 *   it *is* the conclusion heading, and treating it as the end of the ruling
 *   would cut the disposition off.
 *
 * Nothing here rewrites what Claude wrote. Headings, emphasis and citations
 * travel exactly as they were, because the point is to paste the ruling
 * somewhere, not to reformat it on the way.
 */
(function (root) {
  "use strict";

  function str(x) {
    return typeof x === "string" ? x : x == null ? "" : String(x);
  }

  // A line with its Markdown decoration taken off, so a heading is recognised
  // whether it was written as "## CONCLUSION", "**CONCLUSION**", "CONCLUSION:"
  // or bare. claude.ai's own wording varies and none of these is wrong.
  function bareLine(line) {
    return str(line)
      .replace(/^\s{0,3}#{1,6}\s*/, "") // ATX heading
      .replace(/^\s{0,3}>\s?/, "") // block quote
      .replace(/[*_`~]/g, "") // emphasis, code ticks, strikethrough
      .trim();
  }

  const START_LINE = /^nature of (?:the )?proceedings\b/i;
  const END_LINE = /^conclusion\b/i;
  // The all-caps forms, for a heading that shares its line with something else
  // ("Here is the ruling. NATURE OF PROCEEDINGS: ..."). Case-sensitive on
  // purpose: a sentence mentioning the nature of proceedings is prose, where
  // the shouted form is the heading.
  const START_CAPS = /NATURE OF (?:THE )?PROCEEDINGS/;
  const END_CAPS = /\bCONCLUSION\b/;

  // Is this reply one that has a ruling in it at all? Used to decide whether to
  // offer the button, and deliberately loose — it runs against text read off
  // the page, where block elements run together and there are no line breaks to
  // anchor to.
  const START_ANY = /NATURE OF (?:THE )?PROCEEDINGS/i;
  function mentionsRuling(text) {
    return START_ANY.test(str(text));
  }

  // A thematic break: three or more -, * or _ (spaces allowed between), or a
  // run of dashes long enough to be a rule rather than punctuation.
  const RULE_RE = /^\s{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|[—–]{3,})$/;

  // ...but only where the line above is blank. A rule directly under text is a
  // setext heading — `CONCLUSION` underlined with `---` is the conclusion
  // HEADING, and reading it as the end of the ruling would drop the disposition
  // the whole document exists to state.
  function isBreak(lines, i) {
    if (!RULE_RE.test(str(lines[i]))) return false;
    if (i === 0) return true;
    return str(lines[i - 1]).trim() === "";
  }

  function findLine(lines, from, lineRe, capsRe) {
    for (let i = from; i < lines.length; i++) {
      if (lineRe.test(bareLine(lines[i]))) return { line: i, col: 0 };
    }
    // Nothing on a line of its own — take a shouted heading sharing its line
    // with other text, and cut at the heading rather than at the line.
    for (let i = from; i < lines.length; i++) {
      const m = capsRe.exec(str(lines[i]));
      if (m) return { line: i, col: m.index };
    }
    return null;
  }

  // Blank-line runs collapse to one, and the whole thing is trimmed. Dropping a
  // rule leaves a blank line on either side of where it was, and a paragraph
  // gap three lines deep is not what Claude wrote.
  function tidy(lines) {
    const out = [];
    for (const line of lines) {
      const l = str(line).replace(/[ \t]+$/, "");
      if (!l.trim() && out.length && !out[out.length - 1].trim()) continue;
      out.push(l);
    }
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  }

  /**
   * The ruling out of a reply.
   *
   * → { ok, text, reason }
   *
   * `reason` is filled in on both outcomes: on a failure it says what was
   * missing, and on a success it carries any caveat worth passing on — a ruling
   * taken to the end of the reply because it had no conclusion is a ruling that
   * may have picked up a sentence Claude added underneath, and the button that
   * copied it should be able to say so.
   */
  function extractRuling(text) {
    const src = str(text).replace(/\r\n?/g, "\n");
    const lines = src.split("\n");

    const start = findLine(lines, 0, START_LINE, START_CAPS);
    if (!start) return { ok: false, text: "", reason: "no NATURE OF PROCEEDINGS heading" };

    const concl = findLine(lines, start.line + 1, END_LINE, END_CAPS);

    // The rule that ends the ruling: the first one after the conclusion, or —
    // where the reply has no conclusion to go by — the first one after the
    // start, which is the best available guess at where the ruling stops.
    let end = lines.length - 1;
    for (let i = (concl ? concl.line : start.line) + 1; i < lines.length; i++) {
      if (isBreak(lines, i)) {
        end = i - 1;
        break;
      }
    }

    const kept = [];
    for (let i = start.line; i <= end; i++) {
      if (isBreak(lines, i)) continue; // a rule inside the ruling isn't the ruling
      kept.push(i === start.line && start.col ? lines[i].slice(start.col) : lines[i]);
    }

    const out = tidy(kept).join("\n");
    if (!out) return { ok: false, text: "", reason: "the ruling came out empty" };
    return {
      ok: true,
      text: out,
      reason: concl ? null : "no CONCLUSION heading — took the ruling to the end",
    };
  }

  const api = {
    bareLine,
    mentionsRuling,
    isBreak,
    extractRuling,
    START_LINE,
    END_LINE,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMTentative = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
