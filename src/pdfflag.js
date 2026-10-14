/**
 * Claude Usage Meter — a PDF uploads only on your say-so (pure).
 *
 * The pseudonymized papers reach claude.ai as TEXT — the Text Files a case
 * folder holds, the combined file built out of them. A PDF is the other kind
 * of paper: most often an original, the filing as served, in the real names.
 * So a PDF is never uploaded on the strength of a pick alone. Every door asks
 * first, by name, and the answer has to be an affirmative one:
 *
 *   claude.ai's OWN doors — its upload button (the file input it opens), a
 *   drop on the page, a paste. Asked in src/pseudo-view.js, beside the key
 *   guard, before claude.ai's own handlers see the event.
 *
 *   The Upload folder button (src/folder-upload.js), before anything is
 *   handed to the composer.
 *
 *   A scheduled send's files (src/jobform.js) and a workflow run's documents
 *   (src/workflowform.js) — asked when the PDF is ADDED, because that is the
 *   last moment anybody is there to answer. Those uploads happen later, on
 *   their own, and a question put to an empty room would be a send that
 *   silently never goes (CLAUDE.md: an automation that fails to act must fail
 *   loudly).
 *
 * Which is why the page-side question is asked of TRUSTED events only — a
 * person's own pick, drop or paste. The extension's own hand-offs (a scheduled
 * send, a workflow step, the Folder button, the guard's own release) are
 * synthetic events, and every one of them carries files that were asked about
 * at the door they came in by. Asking again would ask twice where somebody is
 * watching and wedge a send where nobody is.
 *
 * Other files in the same batch are never held: the question is about the
 * PDFs, and "Keep it out" keeps out exactly those.
 *
 * Pure: no DOM, no chrome. Files are duck-typed ({ name, type }), and entries
 * the way src/dropdir.js produces them ({ file, path }) are read too, so the
 * same answer comes back at every door.
 */
(function (root) {
  "use strict";

  const str = (v) => (v == null ? "" : String(v));

  const PDF_RE = /\.pdf$/i;
  const PDF_TYPE = "application/pdf";

  // How many names a question spells out before it counts the rest. A dialog
  // listing forty exhibits is a dialog nobody reads to the end.
  const MAX_NAMED = 4;

  function isPdfName(name) {
    return PDF_RE.test(str(name).trim());
  }

  /** A File, or the file inside a walked entry. */
  function fileOf(x) {
    return x && x.file && typeof x.file === "object" ? x.file : x;
  }

  /**
   * Is this a PDF? By name, or by the type the browser read off it — a PDF
   * saved without its extension still says application/pdf.
   */
  function isPdf(x) {
    const f = fileOf(x);
    if (!f) return false;
    return isPdfName(f.name) || str(f.type).trim().toLowerCase() === PDF_TYPE;
  }

  /** The PDFs, and everything else, each in the order it came. */
  function split(list) {
    const pdfs = [];
    const rest = [];
    for (const x of list || []) (isPdf(x) ? pdfs : rest).push(x);
    return { pdfs: pdfs, rest: rest };
  }

  /**
   * Does an event at claude.ai's own doors — a pick on its file input, a drop,
   * a paste — have to ask before it goes on?
   *
   *   trusted  the event's isTrusted: a person did this. The extension's own
   *            hand-offs are synthetic, and were asked about where their files
   *            were picked
   *   ours     it landed on the extension's own picker or drop zone, which
   *            asks for itself
   *   files    what it carries
   */
  function asksAtPage(o) {
    const e = o || {};
    if (!e.trusted || e.ours) return false;
    return (e.files || []).some(isPdf);
  }

  function names(list) {
    return (list || []).map((x) => {
      const f = fileOf(x);
      return str(f && typeof f === "object" ? f.name : f).trim();
    }).filter(Boolean);
  }

  /** "a.pdf", "a.pdf and b.pdf", "a.pdf, b.pdf and c.pdf", "a.pdf, b.pdf, c.pdf and 5 more". */
  function nameList(list) {
    const all = names(list);
    if (!all.length) return "";
    if (all.length > MAX_NAMED) {
      const shown = all.slice(0, MAX_NAMED - 1);
      return shown.join(", ") + " and " + (all.length - shown.length) + " more";
    }
    if (all.length === 1) return all[0];
    return all.slice(0, -1).join(", ") + " and " + all[all.length - 1];
  }

  const plural = (n, one, many) => (n === 1 ? one : many);

  /**
   * The question, in words. `pdfs` are the PDFs (files or names), `others`
   * how many other files came with them, and `opts.queued` says the PDF is
   * being ADDED to a send or a run that uploads later rather than going up
   * now.
   *
   * The affirmative button reads "Upload anyway" at the page's doors, the same
   * words the key guard uses — so the note owed for a release that never
   * landed ("Upload anyway was pressed for …") is true whichever guard asked.
   *
   * Returns { head, body, keep, go }.
   */
  function prompt(pdfs, others, opts) {
    const o = opts || {};
    const n = Math.max(1, names(pdfs).length);
    const rest = Math.max(0, Number(others) || 0);
    const list = nameList(pdfs) || "This file";
    const it = plural(n, "it", "them");
    const head = o.queued
      ? plural(n, "Add this PDF?", "Add these " + n + " PDFs?")
      : plural(n, "Upload this PDF?", "Upload these " + n + " PDFs?");
    const body =
      list + plural(n, " is a PDF.", " are PDFs.") +
      " The pseudonymized papers go up as text, so a PDF is most often an original, " +
      "in the real names. " +
      (o.queued
        ? plural(n, "It", "They") + " will upload when this goes out, with nobody there to ask then — " +
          "so " + plural(n, "it is", "they are") + " asked about now. " +
          "Add " + it + " only if you mean Claude to read " + it + "."
        : "Upload " + it + " only if you mean Claude to read " + it + ".") +
      (rest
        ? " The other " + plural(rest, "file", rest + " files") +
          (o.queued ? " " + plural(rest, "is", "are") + " added" : " " + plural(rest, "goes", "go") + " up") +
          " either way."
        : "");
    return {
      head: head,
      body: body,
      keep: o.queued ? plural(n, "Leave it out", "Leave them out") : plural(n, "Keep it out", "Keep them out"),
      go: o.queued ? plural(n, "Add PDF", "Add PDFs") : "Upload anyway",
    };
  }

  /**
   * What is said once the answer was no — in the Folder button's card and the
   * forms' status line, where the PDF would otherwise just be missing.
   */
  function heldNote(pdfs, opts) {
    const o = opts || {};
    const n = names(pdfs).length;
    if (!n) return "";
    const list = nameList(pdfs);
    const what = n === 1 ? list : n + " PDFs (" + list + ")";
    return o.queued
      ? "Left out " + what + " — a PDF is added only when you say so."
      : "Held back " + what + " — a PDF uploads only when you say so.";
  }

  const api = {
    MAX_NAMED,
    PDF_TYPE,
    isPdfName,
    isPdf,
    split,
    asksAtPage,
    nameList,
    prompt,
    heldNote,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPdfFlag = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
