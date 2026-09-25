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
  // The heading welded to the sentence under it. textContent drops a <br> and
  // runs one block into the next without a space, so `CONCLUSION` on its own
  // line over a one-sentence disposition reads off the page as
  // "CONCLUSIONThe hearing ..." — where neither pattern above sees a word
  // boundary, and a ruling with a conclusion was reported as having none. The
  // shouted word followed by a capital and then a lower-case letter is the
  // heading and the start of the next sentence; "CONCLUSIONS OF LAW" is not.
  const END_GLUED = /^CONCLUSION(?=[A-Z][a-z])/;
  function isConclusionLine(line) {
    const bare = bareLine(line);
    return END_LINE.test(bare) || END_GLUED.test(bare) || END_CAPS.test(str(line));
  }

  // A block that reads as a heading though the page didn't draw it as one: a
  // short line set wholly in bold, with no sentence punctuation to end it.
  // Claude writes "**Change report**" as often as "## Change report", and
  // after the conclusion either one is the start of what it wrote underneath.
  // Ending in a full stop keeps "**IT IS SO ORDERED.**" in the ruling.
  const HEADISH_MAX = 80;
  function looksLikeHeading(text) {
    const t = str(text).trim();
    if (!t || t.length > HEADISH_MAX || /\n/.test(t)) return false;
    return !/[.;,!?]$/.test(t);
  }

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

  // ...but a run of DASHES directly under a line of text is a setext heading
  // rather than a break — `CONCLUSION` underlined with `---` is the conclusion
  // HEADING, and reading it as the end of the ruling would drop the disposition
  // the whole document exists to state. Only `-` and `=` do that in Markdown,
  // so `___` and `***` are breaks wherever they appear: requiring a blank line
  // above them lost the ruling's end in a reply whose paragraphs weren't
  // separated by one.
  function isBreak(lines, i) {
    const line = str(lines[i]);
    if (!RULE_RE.test(line)) return false;
    if (!/^\s{0,3}-/.test(line)) return true;
    if (i === 0) return true;
    return str(lines[i - 1]).trim() === "";
  }

  // A markdown line that is a heading, after the conclusion: "## Change
  // report", or a short line wholly in bold ("**Change report**").
  function headingLine(line) {
    const l = str(line).trim();
    if (/^#{1,6}\s+\S/.test(l)) return true;
    const m = /^(\*\*|__)(.+)\1:?$/.exec(l);
    return !!m && looksLikeHeading(m[2]);
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

  // The first line that says anything. Not simply the first: a block read off
  // the page carries the source's own indentation, so a wrapper holding the
  // ruling begins with a newline and its "first line" is empty — which is how a
  // ruling nested one element deeper than expected went unrecognised.
  function firstLine(text) {
    for (const line of str(text).split("\n")) if (line.trim()) return line;
    return "";
  }

  function startsRuling(text) {
    const t = firstLine(text);
    return START_LINE.test(bareLine(t)) || START_CAPS.test(t);
  }
  function startsConclusion(text) {
    return isConclusionLine(firstLine(text));
  }
  // A conclusion heading anywhere in a block, for a ruling that arrives as one
  // block rather than as a run of them.
  function hasConclusion(text) {
    for (const line of str(text).split("\n")) {
      if (!line.trim()) continue;
      if (isConclusionLine(line)) return true;
    }
    return false;
  }

  /**
   * The same decision, over the reply as the page has drawn it.
   *
   * blocks: [{ text, rule, heading, bold }] — the message's own top-level
   *         blocks in order. `rule` is an <hr>, which is the whole reason this
   *         exists: on the page a horizontal rule is an ELEMENT, where in text
   *         it is three characters that have to be told apart from a setext
   *         underline, a table border and a row of dashes someone typed. The
   *         page knows. `bold` says the block's text is set wholly in bold.
   *
   * → { ok, start, end, endLine, reason } — indices into `blocks`, inclusive.
   *   `endLine`, where it is not -1, is how many of block `end`'s lines are the
   *   ruling's: the rest of that block is what Claude wrote underneath.
   */
  function planBlocks(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    const fail = (reason) => ({ ok: false, start: -1, end: -1, reason });

    let start = -1;
    for (let i = 0; i < list.length; i++) {
      const b = list[i] || {};
      if (b.rule) continue;
      if (startsRuling(b.text)) {
        start = i;
        break;
      }
    }
    if (start === -1) return fail("no NATURE OF PROCEEDINGS heading");

    let concl = -1;
    for (let i = start + 1; i < list.length; i++) {
      const b = list[i] || {};
      if (!b.rule && startsConclusion(b.text)) {
        concl = i;
        break;
      }
    }
    // A ruling that arrives as ONE block carries its conclusion inside it. The
    // cut is the same either way; what changes is whether the button reports a
    // caveat, and reporting one about a ruling that plainly has a conclusion
    // teaches you to ignore the caveat that matters.
    if (concl === -1 && hasConclusion((list[start] || {}).text)) concl = start;

    // The end: the first rule after the conclusion. Failing that, the first
    // HEADING after it — a ruling has no section after its conclusion, so a
    // heading there belongs to whatever Claude wrote underneath (a bold line
    // standing alone counts: see looksLikeHeading). Failing both, the last
    // block.
    let end = list.length - 1;
    let endLine = -1;
    let reason = concl === -1 ? "no CONCLUSION heading — took the ruling to the end" : null;
    for (let i = (concl === -1 ? start : concl) + 1; i < list.length; i++) {
      const b = list[i] || {};
      const heading = b.heading || (b.bold && looksLikeHeading(b.text));
      if (b.rule || (concl !== -1 && heading)) {
        end = i - 1;
        break;
      }
    }

    // ...and the same heading INSIDE a block. claude.ai draws a single newline
    // as a <br>, so "CONCLUSION", the disposition and "**Change report**"
    // written on consecutive lines are one paragraph on the page — and cutting
    // only between blocks took the change report, and everything under it,
    // along with the ruling.
    if (concl !== -1) {
      const inner = headingInside(list, concl, end, start);
      if (inner) {
        end = inner.block;
        endLine = inner.line;
        const kept = linesOf(list[end]).slice(0, endLine);
        if (!kept.some((l) => l.text.trim())) {
          end--;
          endLine = -1;
        }
      }
    }

    while (end > start && !str((list[end] || {}).text).trim()) {
      end--;
      endLine = -1;
    }
    if (end < start) return fail("the ruling came out empty");
    return { ok: true, start, end, endLine, reason };
  }

  // A block's lines, each with whether it is set wholly in bold. The page
  // supplies them (`lines`); a block described by its text alone takes its
  // block-level `bold` for every line.
  function linesOf(b) {
    const blk = b || {};
    if (Array.isArray(blk.lines)) {
      return blk.lines.map((l) => ({ text: str(l && l.text), bold: !!(l && l.bold) }));
    }
    return str(blk.text)
      .split("\n")
      .map((t) => ({ text: t, bold: !!blk.bold }));
  }

  // The first bold heading-like line after the conclusion heading, within the
  // blocks from the conclusion's through `last`. → { block, line } | null.
  function headingInside(list, concl, last, start) {
    for (let i = concl; i <= last; i++) {
      const lines = linesOf(list[i]);
      let from = 0;
      if (i === concl) {
        // Past the conclusion heading itself — and, where the whole ruling is
        // one block, past its NATURE OF PROCEEDINGS line first.
        let j = 0;
        if (concl === start) {
          while (j < lines.length && !lines[j].text.trim()) j++;
          j++;
        }
        while (j < lines.length && !isConclusionLine(lines[j].text)) j++;
        from = j + 1;
      }
      for (let j = from; j < lines.length; j++) {
        const l = lines[j];
        if (l.bold && looksLikeHeading(l.text)) return { block: i, line: j };
      }
    }
    return null;
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
      if (isBreak(lines, i) || (concl && headingLine(lines[i]))) {
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
    startsRuling,
    startsConclusion,
    hasConclusion,
    looksLikeHeading,
    planBlocks,
    extractRuling,
    START_LINE,
    END_LINE,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMTentative = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
