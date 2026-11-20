/**
 * Claude Usage Meter — a run set up from PDF+'s Home (pure).
 *
 * The owner (November 2026): "Let's add integration with my Claude extension
 * too. I should be able to press a button to open the options tab and have it
 * automatically bring the hearing date and files up for me while I select the
 * workflow run." … "make sure that I can continue using the options page
 * normally too. Also make sure that this new method respects all existing
 * safeguards against accidental uploads."
 *
 * PDF+ knows where a hearing's case folder is on disk; Chrome will not let an
 * extension open a folder by its path. So PDF+ writes a REQUEST (case,
 * hearing date, the folder's path) into Downloads and opens claude.ai with a
 * bare marker (never the case's name, which claude.ai's own page would see);
 * the E-Court Suite's native host reads the request and serves that one
 * folder, read-only, to this extension (src/pdfplus-run.js); and Create run
 * on any workflow hands the folder to the run editor through THE SAME DOOR a
 * picked folder goes through (CUMWorkflowForm's takeFromPdfPlus → takePicked):
 * the LEAKS gate, the case-folder split (only Text Files go up, the key is
 * attached), the PDF question, the spreadsheet diversion and the caps all
 * apply as they do to Choose folder….
 *
 * Only the files that door could take are read across: what is under the
 * folder's Text Files, and every spreadsheet (a key candidate). The rest of
 * the folder — the originals — comes as empty STAND-INS carrying their paths,
 * so the gate and the split see the whole folder as a pick would, and a
 * stand-in that ever reached the documents is refused (standIns). The route
 * takes only a folder whose name carries a case number (a case folder), so
 * the ordinary walk, which would take everything, never runs on it.
 */
(function (root) {
  "use strict";

  const DD = root.CUMDropDir || (typeof require === "function" ? require("./dropdir.js") : null);

  // A request is for the moment it was made: an old one would hand a matter's
  // papers to whichever run is created next.
  const MAX_AGE_MS = 2 * 3600 * 1000;
  // What the native host sends of a file at a time (base64 under its 1 MB cap).
  const CHUNK = 700 * 1024;
  // The marker PDF+ opens claude.ai with.
  const MARKER = "#cum-pdfplus-run";
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  const str = (v) => (v == null ? "" : String(v));

  /**
   * The request as the host read it, checked: { ok, why, request }.
   * `why`: "none", "old", "bad". A request carries { version: 1, id, at,
   * caseNumber, caseName, motion, hearingDate (YYYY-MM-DD), folderName,
   * folderPath }.
   */
  function checkRequest(req, now) {
    if (!req || typeof req !== "object") return { ok: false, why: "none", request: null };
    const r = req;
    if (r.version !== 1 || !str(r.id) || !str(r.folderName) || !str(r.folderPath) || typeof r.at !== "number")
      return { ok: false, why: "bad", request: null };
    if (str(r.folderName).indexOf("/") !== -1 || str(r.folderName).indexOf("\\") !== -1)
      return { ok: false, why: "bad", request: null };
    if ((now == null ? Date.now() : now) - r.at > MAX_AGE_MS) return { ok: false, why: "old", request: null };
    const clean = {
      id: str(r.id),
      at: r.at,
      caseNumber: str(r.caseNumber).trim(),
      caseName: str(r.caseName).replace(/\s+/g, " ").trim(),
      motion: str(r.motion).replace(/\s+/g, " ").trim(),
      hearingDate: ISO_RE.test(str(r.hearingDate)) ? str(r.hearingDate) : "",
      folderName: str(r.folderName),
      folderPath: str(r.folderPath),
      // The workflow chosen from PDF+'s Claude menu, if one was: Options
      // presses its Create run itself (pdfplus-run.js, autoCreate).
      workflowId: /^[A-Za-z0-9_-]{1,80}$/.test(str(r.workflowId)) ? str(r.workflowId) : "",
      workflowName: str(r.workflowName).replace(/\s+/g, " ").trim().slice(0, 120),
    };
    return { ok: true, why: "", request: clean };
  }

  /**
   * Whether a path the host listed is safe to take: inside the folder named
   * (`folderName/…`), with no "..", no empty segment, no backslash.
   */
  function safeRel(rel, folderName) {
    const p = str(rel);
    if (!p || p.indexOf("\\") !== -1) return false;
    const segs = p.split("/");
    if (segs.length < 2 || segs[0] !== str(folderName)) return false;
    return segs.every((s) => s && s !== "." && s !== "..");
  }

  /**
   * Whether a file's bytes are read across: one the run editor's door could
   * take from a case folder — under its Text Files (DD.isTextFilesDir), or a
   * spreadsheet anywhere (a key candidate, DD.isSpreadsheetName).
   */
  function needsBytes(rel) {
    const segs = str(rel).split("/");
    const name = segs[segs.length - 1];
    if (DD && DD.isSpreadsheetName(name)) return true;
    return segs.slice(1, -1).some((s) => (DD ? DD.isTextFilesDir(s) : /^text ?files$/i.test(s)));
  }

  /** The stand-ins among a list of files (anything marked __cumStandIn). */
  function standIns(files) {
    return (files || []).filter((f) => f && f.__cumStandIn === true);
  }

  /** The offsets a file of `size` bytes is read at. */
  function chunkOffsets(size, chunk) {
    const c = chunk || CHUNK;
    const out = [];
    for (let o = 0; o < Math.max(1, size); o += c) out.push(o);
    return out;
  }

  /** "Fri, Nov 20" for a YYYY-MM-DD, or "". */
  function dayText(iso) {
    const m = str(iso).match(ISO_RE);
    if (!m) return "";
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  /** The banner's words for a request. */
  function bannerText(req) {
    if (!req) return "";
    const who = req.caseName || req.folderName;
    const num = req.caseNumber && who.indexOf(req.caseNumber) === -1 ? " (" + req.caseNumber + ")" : "";
    const when = req.hearingDate ? ", hearing " + dayText(req.hearingDate) : "";
    const what = req.motion ? " · " + req.motion : "";
    if (req.workflowId)
      return "From PDF+: " + who + num + when + what + ". Setting up a run of " + (req.workflowName || "the workflow chosen") +
        " — its papers come from " + req.folderName + ", through the same checks as Choose folder….";
    return "From PDF+: " + who + num + when + what + ". Press Create run on the workflow to use — its papers come from " +
      req.folderName + ", through the same checks as Choose folder….";
  }

  /** What to say where the papers could not be brought over. */
  function failText(why, req) {
    const where = (req && req.folderName) || "the case folder";
    switch (why) {
      case "host":
        return "PDF+'s papers could not be brought over: the native host did not answer. Re-run the E-Court host's install.ps1 with this extension's id (see the README), then press the Claude button in PDF+ again. Nothing was added; Choose folder… still works.";
      case "gone":
        return where + " is not where PDF+ said it was (moved or renamed since?). Nothing was added; press the Claude button in PDF+ again, or use Choose folder….";
      case "nocase":
        return where + "'s name carries no case number, so it cannot be taken apart as a case folder — nothing was added. Use Choose folder… and pick its Text Files yourself.";
      case "standin":
        return "Nothing was added from " + where + ": one of its originals was about to go into the documents, which this route never allows. Use Choose folder….";
      case "norun":
        return "Open a run first: PDF+'s papers go into a run as it is created.";
      case "noworkflow":
        return "The workflow chosen in PDF+" + (req && req.workflowName ? " (" + req.workflowName + ")" : "") +
          " is not here any more. Press Create run on the workflow to use — " + where + "'s papers still come with it.";
      default:
        return "PDF+'s papers could not be brought over (" + str(why) + "). Nothing was added; Choose folder… still works.";
    }
  }

  const api = { MAX_AGE_MS, CHUNK, MARKER, checkRequest, safeRel, needsBytes, standIns, chunkOffsets, dayText, bannerText, failText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPdfPlusRun = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
