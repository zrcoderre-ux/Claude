/**
 * Claude Usage Meter — a PDF or a Word document uploads only on your say-so
 * (pure).
 *
 * The pseudonymized papers reach claude.ai as TEXT — the Text Files a case
 * folder holds, the combined file built out of them. A PDF is the other kind
 * of paper: most often an original, the filing as served, in the real names.
 * A Word document is the same: the draft as written, or a filing as received,
 * in the real names — re-anonymizing a draft writes TEXT, not another .docx.
 * So neither is uploaded on the strength of a pick alone. Every door asks
 * first, by name, and the answer has to be an affirmative one. (Every "PDF"
 * below reads "PDF or Word document"; the module keeps its name.)
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
 * PDFs and Word documents, and "Keep it out" keeps out exactly those.
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
  // Word's own formats: the document, the macro document and the templates,
  // old binary and Open XML alike.
  const WORD_EXT = "docx?|docm|dotx?|dotm";
  const WORD_RE = new RegExp("\\.(?:" + WORD_EXT + ")$", "i");
  const WORD_TYPES = [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    "application/vnd.ms-word.document.macroenabled.12",
    "application/vnd.ms-word.template.macroenabled.12",
  ];

  // How many names a question spells out before it counts the rest. A dialog
  // listing forty exhibits is a dialog nobody reads to the end.
  const MAX_NAMED = 4;

  function isPdfName(name) {
    return PDF_RE.test(str(name).trim());
  }

  function isWordName(name) {
    return WORD_RE.test(str(name).trim());
  }

  /** A name the question is asked about: a PDF's or a Word document's. */
  function isHeldName(name) {
    return isPdfName(name) || isWordName(name);
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

  /** Is this a Word document? By name, or by the type the browser read off it. */
  function isWord(x) {
    const f = fileOf(x);
    if (!f) return false;
    return isWordName(f.name) || WORD_TYPES.indexOf(str(f.type).trim().toLowerCase()) !== -1;
  }

  /** Is this a file the question is asked about — a PDF or a Word document? */
  function isHeld(x) {
    return isPdf(x) || isWord(x);
  }

  /**
   * The PDFs and Word documents, and everything else, each in the order it
   * came. `pdfs` is the held files, Word documents among them.
   */
  function split(list) {
    const pdfs = [];
    const rest = [];
    for (const x of list || []) (isHeld(x) ? pdfs : rest).push(x);
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
    return (e.files || []).some(isHeld);
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

  const PDF_KIND = { one: "PDF", many: "PDFs", a: "a PDF" };
  const WORD_KIND = { one: "Word document", many: "Word documents", a: "a Word document" };
  const BOTH_KIND = { one: "PDF or Word document", many: "PDFs and Word documents", a: "a PDF or Word document" };

  /**
   * What the files are called — PDF_KIND, WORD_KIND, or BOTH_KIND for a batch
   * of both. Files are read by name and type, bare names by name; `words` is a
   * count of Word documents with no name to read (a "DOCX" badge), `pdfs` the
   * same for PDFs.
   */
  function kindOf(list, pdfs, words) {
    let pdf = (Number(pdfs) || 0) > 0;
    let word = (Number(words) || 0) > 0;
    for (const x of list || []) {
      const f = fileOf(x);
      if (f && typeof f === "object" ? isWord(f) : isWordName(f)) word = true;
      else pdf = true;
    }
    if (word && !pdf) return WORD_KIND;
    if (word) return BOTH_KIND;
    return PDF_KIND;
  }

  // Why a held file is asked about, for the kinds in the batch.
  function why(kind) {
    const was =
      kind === WORD_KIND
        ? "a Word document is most often the draft itself or an original"
        : kind === BOTH_KIND
          ? "a PDF or a Word document is most often an original"
          : "a PDF is most often an original";
    return "The pseudonymized papers go up as text, so " + was + ", in the real names.";
  }

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
    const k = kindOf(pdfs);
    const head = o.queued
      ? plural(n, "Add this " + k.one + "?", "Add these " + n + " " + k.many + "?")
      : plural(n, "Upload this " + k.one + "?", "Upload these " + n + " " + k.many + "?");
    const body =
      list + plural(n, " is " + k.a + ".", " are " + k.many + ".") +
      " " + why(k) + " " +
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
      go: o.queued ? plural(n, "Add " + k.one, "Add " + k.many) : "Upload anyway",
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
    const k = kindOf(pdfs);
    const what = n === 1 ? list : n + " " + k.many + " (" + list + ")";
    return o.queued
      ? "Left out " + what + " — " + k.a + " is added only when you say so."
      : "Held back " + what + " — " + k.a + " uploads only when you say so.";
  }

  // ---- the last door: the send ------------------------------------------------
  //
  // Every door above asks when it can SEE the pick. claude.ai's own "+ Add
  // files" was seen to get a PDF past all of them (owner's report, October
  // 2026): its pick never reached the page as an event the guard could hold —
  // a file input that isn't in the document, or the browser's own file picker,
  // tells nobody but claude.ai. So the message itself is the last door. Before
  // a send goes, the composer is read for what it is CARRYING, however it got
  // there, and a PDF nobody has said yes to holds the send behind the question.
  //
  // What the composer carries is read off its own words, outside the draft:
  // each leaf's text and each label, title and alt in the composer box. A PDF
  // card names its file there ("brief.pdf", "Remove brief.pdf"), or at least
  // says "PDF"; the network's own record of an upload (claude.ai's upload
  // response, where the page can see it) counts too, while the composer is
  // still showing an attachment. Erring towards asking is the direction this
  // is built in: a question too many costs a click; one too few is an
  // original in the real names reaching Claude.

  // A file name ending .pdf, as it sits inside a longer caption: everything
  // before it that a file name may hold, back to a character none can. Leading
  // words ("Remove brief.pdf") ride along, and sameName forgives them.
  // A Word document's card is read the same way: "decl.docx", or a "DOCX" badge.
  const PDF_IN_TEXT_RE = new RegExp(
    "([^\\\\/:*?\"<>|\\r\\n\\t]{1,200}?\\.(?:pdf|" + WORD_EXT + "))(?![a-z0-9])",
    "i"
  );
  const BADGE_RE = /^\s*pdf\s*$/i;
  const WORD_BADGE_RE = new RegExp("^\\s*(?:" + WORD_EXT + ")\\s*$", "i");

  const fold = (v) => str(v).replace(/\s+/g, " ").trim().toLowerCase();

  /** The PDF or Word file name a caption carries, or "". */
  function pdfNameIn(text) {
    const t = str(text);
    if (!t || t.length > 300) return "";
    const m = t.match(PDF_IN_TEXT_RE);
    return m ? m[1].replace(/\s+/g, " ").trim() : "";
  }

  /**
   * Whether two captions name the same file: equal, or one is the other with
   * words in front of it ("Remove brief.pdf" and "brief.pdf"), the words ending
   * at a space or punctuation — so "notbrief.pdf" is not "brief.pdf".
   */
  function sameName(a, b) {
    const x = fold(a);
    const y = fold(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const [long, short] = x.length > y.length ? [x, y] : [y, x];
    if (!long.endsWith(short)) return false;
    return /[^a-z0-9]$/.test(long.slice(0, long.length - short.length));
  }

  /**
   * The PDFs and Word documents a composer is showing, from its own words
   * (`strings`): distinct names, shortest form kept, and a count of "PDF" and
   * "DOCX" badges that no name accounts for — a card that says only what it
   * is still says what it is. `unnamedWord` is how many of those are Word's.
   */
  function pdfsShown(strings) {
    const found = [];
    let badges = 0;
    let wordBadges = 0;
    for (const s of strings || []) {
      if (BADGE_RE.test(str(s))) {
        badges++;
        continue;
      }
      if (WORD_BADGE_RE.test(str(s))) {
        wordBadges++;
        continue;
      }
      const n = pdfNameIn(s);
      if (!n) continue;
      const at = found.findIndex((f) => sameName(f, n));
      if (at === -1) found.push(n);
      else if (n.length < found[at].length) found[at] = n;
    }
    const words = found.filter(isWordName).length;
    const unnamedPdf = Math.max(0, badges - (found.length - words));
    const unnamedWord = Math.max(0, wordBadges - words);
    return { names: found, unnamed: unnamedPdf + unnamedWord, unnamedWord: unnamedWord };
  }

  /** One signature per set of PDFs, order- and case-blind. */
  function pdfSig(names, unnamed) {
    const list = (names || []).map(fold).filter(Boolean).sort();
    return list.join("\u0000") + "#" + Math.max(0, Number(unnamed) || 0);
  }

  /**
   * Whether this send has to ask first.
   *
   *   shown          pdfsShown(...) — what the composer shows
   *   uploaded       PDF names claude.ai's upload responses reported since the
   *                  last send, where the page can see them (Chat)
   *   attachments    the composer is showing an attachment at all; an upload
   *                  only counts while it is, so one removed since is not
   *                  asked about forever
   *   confirmed      names said yes to already — at the pick, by the Folder
   *                  button, or at an earlier send of this same draft
   *   confirmedSig   the set a send-time yes was given for, which is what
   *                  covers a card showing only "PDF"
   *   trusted        a person's own Enter or click; the extension's sends
   *                  were asked about where their files came in
   *
   * Answers { hold, names, unnamed, sig }.
   */
  function sendAsks(ev) {
    const e = ev || {};
    const shown = e.shown || { names: [], unnamed: 0 };
    const names = (shown.names || []).slice();
    if (e.attachments)
      for (const u of e.uploaded || [])
        if (isHeldName(u) && !names.some((n) => sameName(n, u))) names.push(str(u).trim());
    const unnamed = Math.max(0, Number(shown.unnamed) || 0);
    const unnamedWord = Math.min(unnamed, Math.max(0, Number(shown.unnamedWord) || 0));
    const sig = pdfSig(names, unnamed);
    const free = (reason) => ({ hold: false, why: reason, names: names, unnamed: unnamed, unnamedWord: unnamedWord, sig: sig });
    if (e.trusted === false) return free("not the user's own send");
    if (!names.length && !unnamed) return free("no PDF or Word document in the message");
    if (e.confirmedSig && e.confirmedSig === sig) return free("said yes to at this send");
    const yes = e.confirmed || [];
    const open = names.filter((n) => !yes.some((c) => sameName(c, n)));
    if (!open.length && !unnamed) return free("every PDF and Word document was said yes to");
    return {
      hold: true,
      why: "an unconfirmed PDF or Word document in the message",
      names: names,
      unnamed: unnamed,
      unnamedWord: unnamedWord,
      sig: sig,
    };
  }

  /**
   * The send-time question's words: { head, body, keep, go }. `unnamedWord`
   * is how many of the `unnamed` cards are Word's ("DOCX" badges).
   */
  function sendPrompt(names, unnamed, unnamedWord) {
    const list = (names || []).filter(Boolean);
    const extra = Math.max(0, Number(unnamed) || 0);
    const extraWord = Math.min(extra, Math.max(0, Number(unnamedWord) || 0));
    const n = list.length + extra;
    const one = n === 1;
    const k = kindOf(list, extra - extraWord, extraWord);
    const more = kindOf([], extra - extraWord, extraWord);
    const said = list.length
      ? nameList(list) + (extra ? " and " + extra + " more " + plural(extra, more.one, more.many) : "")
      : one ? k.a : n + " " + k.many;
    return {
      head: one ? "Send this " + k.one + " to Claude?" : "Send these " + n + " " + k.many + " to Claude?",
      body:
        "This message carries " + said + ". " + why(k) + " Send " + plural(n, "it", "them") +
        " only if you mean Claude to read " + plural(n, "it", "them") + ". To send without " +
        plural(n, "it", "them") + ", choose Don't send, remove " + plural(n, "its card", "their cards") +
        " from the message, and send again.",
      keep: "Don't send",
      go: one ? "Send with the " + k.one : "Send with the " + k.many,
    };
  }

  const api = {
    MAX_NAMED,
    PDF_TYPE,
    WORD_TYPES,
    isPdfName,
    isWordName,
    isHeldName,
    isPdf,
    isWord,
    isHeld,
    kindOf,
    split,
    asksAtPage,
    nameList,
    prompt,
    heldNote,
    pdfNameIn,
    sameName,
    pdfsShown,
    pdfSig,
    sendAsks,
    sendPrompt,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPdfFlag = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
