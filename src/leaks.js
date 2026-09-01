/**
 * Claude Usage Meter — a folder marked LEAKS never uploads (pure).
 *
 * Some folders hold papers that must not reach claude.ai at all — not
 * pseudonymized, not under Text Files, not as one combined file. The extension
 * already bars a file class (a spreadsheet never rides an upload, because the
 * pseudonym key is an .xlsx and "the key went up with the exhibits" has to be
 * impossible rather than unlikely). This bars a PLACE, and it is marked the
 * only way a folder can mark itself: by what is sitting in it.
 *
 * Drop a spreadsheet called LEAKS into a folder and nothing from that folder
 * goes up, through any door this extension owns — the Folder button on a chat
 * or a Cowork session, a run's documents, a workflow's. The marker is a file
 * the operator can create in one gesture from the machine that holds the
 * papers, without opening the extension, and it travels with the folder when
 * the folder is copied.
 *
 * The three decisions in here, and why each is the safe direction:
 *
 *   WHAT COUNTS AS THE MARKER. A spreadsheet whose name is LEAKS, in any case
 *   and with an OS duplicate suffix tolerated ("LEAKS (1).xlsx", "LEAKS
 *   copy.xlsx", "LEAKS 2024.xlsx"). A marker that stopped working because the
 *   folder was copied would be a bar that failed silently, which is the one
 *   failure this must not have. It errs towards matching: a spreadsheet
 *   somebody called LEAKS something is a spreadsheet somebody meant as this.
 *
 *   HOW FAR IT REACHES. The whole picked folder, not the subfolder the marker
 *   sits in. A marker four levels down bars everything at the top, because the
 *   operator marking a matter's discovery folder is marking the matter. Where
 *   several folders were dropped together, each is judged on its own — a
 *   marker in one is not a bar on the other — and a marker dropped LOOSE bars
 *   the loose files it came with, which is the same rule with the drop itself
 *   as the folder.
 *
 *   WHAT HAPPENS TO THE REST OF THE PICK. Nothing from a barred folder is
 *   taken: not the documents, not the Text Files, not one paper the operator
 *   might have wanted. A gate that lets most of a folder through is not a
 *   gate — and a partial upload is the shape that gets noticed a week later.
 *
 * It bars UPLOADS, and only uploads. Loading a pseudonym key out of a folder
 * (the key button, src/key-panel.js) is not an upload — the key is parsed into
 * the extension and attached, and the .xlsx itself never reaches a composer —
 * so a LEAKS folder's key still loads through its own door. That is the whole
 * point of a key: to make the papers that DO go up unreadable.
 *
 * Pure: no DOM, no chrome. Entries are duck-typed the way src/dropdir.js
 * produces them ({file, path}) and plain File objects are read too, so the
 * same gate answers at every door.
 */
(function (root) {
  "use strict";

  const str = (v) => (v == null ? "" : String(v));

  // Wider than the key's own .xlsx test (src/dropdir.js) and wider than the
  // upload bar (src/folderup.js), deliberately: those two ask "is this the
  // key?", and this asks "did somebody mark this folder?". A marker saved as
  // .csv out of Numbers is the same instruction as one saved as .xlsx.
  const SPREADSHEET_RE = /\.(xlsx|xlsm|xltx|xltm|xlsb|xls|csv|tsv|ods|numbers)$/i;

  // The name that marks a folder. Kept as its own constant because it is what
  // an operator types on the other side of the screen.
  const MARKER = "LEAKS";

  function isSpreadsheet(name) {
    return SPREADSHEET_RE.test(str(name).trim());
  }

  /** A file name without its extension. */
  function stemOf(name) {
    const n = str(name).trim();
    const i = n.lastIndexOf(".");
    return i <= 0 ? n : n.slice(0, i);
  }

  /**
   * The stem with what a COPY of it picked up taken off: "LEAKS (1)",
   * "LEAKS copy", "LEAKS copy 2", "LEAKS - Copy", "LEAKS 2024". Chrome,
   * Windows and macOS each append their own, and a duplicated folder whose
   * marker quietly stopped marking is exactly the silent failure a bar cannot
   * afford. Stripped repeatedly, because "LEAKS copy 2" carries two.
   */
  function bareStem(name) {
    let s = stemOf(name).toLowerCase().trim();
    for (let i = 0; i < 4; i++) {
      const next = s.replace(/[\s_-]*(\(\d+\)|copy|\d+)$/, "").replace(/[\s_-]+$/, "").trim();
      if (next === s || !next) break;
      s = next;
    }
    return s;
  }

  /** Is this file the marker — a spreadsheet called LEAKS? */
  function isMarker(name) {
    return isSpreadsheet(name) && bareStem(name) === MARKER.toLowerCase();
  }

  /** An entry ({file, path} or a plain File) as { name, path }. */
  function entryOf(entry) {
    const e = entry || {};
    const f = e.file || e;
    const path = str(e.path || f.webkitRelativePath || f.name || e.name);
    const name = path.indexOf("/") === -1 ? path : path.slice(path.lastIndexOf("/") + 1);
    return { name: name, path: path };
  }

  /**
   * Which folder a path belongs to, for the purpose of this bar: the top-level
   * folder's own name, or "" for a file picked loose. "" is a real answer and
   * not a missing one — the loose files of one drop are a folder as far as
   * this is concerned.
   */
  function folderOf(path) {
    const p = str(path);
    const i = p.indexOf("/");
    return i === -1 ? "" : p.slice(0, i);
  }

  /**
   * Judge a pick. `files` are [{file, path}] as src/dropdir.js produces them,
   * or plain Files.
   *
   * Answers:
   *   hit      any folder in this pick is marked — the caller must not upload
   *   folders  their names, in the order met ("" where the marker was loose)
   *   markers  the marker files' paths, for saying WHICH file did this
   *   held     the entries that will not go up
   *   files    what is left, which is everything from unmarked folders
   */
  function gate(files) {
    const list = files || [];
    const barred = new Set();
    const folders = [];
    const markers = [];
    for (const entry of list) {
      const e = entryOf(entry);
      if (!isMarker(e.name)) continue;
      markers.push(e.path);
      const folder = folderOf(e.path);
      if (!barred.has(folder)) {
        barred.add(folder);
        folders.push(folder);
      }
    }
    const held = [];
    const kept = [];
    for (const entry of list) {
      if (barred.has(folderOf(entryOf(entry).path))) held.push(entry);
      else kept.push(entry);
    }
    return {
      hit: barred.size > 0,
      folders: folders,
      markers: markers,
      held: held,
      files: kept,
    };
  }

  function count(n, one, many) {
    return n + " " + (n === 1 ? one : many || one + "s");
  }

  function nameList(names) {
    const said = (names || []).map((n) => str(n) || "the files picked loose");
    if (said.length < 3) return said.join(" and ");
    return said.slice(0, -1).join(", ") + " and " + said[said.length - 1];
  }

  /**
   * What the gate did, in one sentence — which folder, which file marked it,
   * and how much did not go. Named rather than counted: an operator who has to
   * work out WHY a pick was refused will pick it again.
   */
  function describe(res) {
    const r = res || {};
    if (!r.hit) return "";
    const marker = (r.markers && r.markers[0]) || MARKER;
    const name = marker.indexOf("/") === -1 ? marker : marker.slice(marker.lastIndexOf("/") + 1);
    const where = nameList(r.folders);
    const held = (r.held && r.held.length) || 0;
    return (
      "Nothing was uploaded from " +
      where +
      ": it holds " +
      name +
      ", and a folder marked " +
      MARKER +
      " never uploads. " +
      (held
        ? count(held, "file") + " " + (held === 1 ? "was" : "were") + " held back."
        : "Nothing was taken from it.") +
      " Remove that spreadsheet from the folder if this one really is meant to go up."
    );
  }

  /**
   * What to say when the gate itself could not be consulted — the module is
   * not on the page. The pick is refused rather than allowed: a bar against
   * papers reaching claude.ai that fails OPEN is not a bar, and the cost of
   * failing closed is a pick the operator makes again after a reload.
   */
  const ABSENT =
    "The " +
    MARKER +
    " upload gate is not loaded on this page, so nothing was uploaded — a folder could " +
    "not be checked for a " +
    MARKER +
    " spreadsheet. Reload the page and pick it again.";

  const api = {
    MARKER,
    ABSENT,
    isSpreadsheet,
    stemOf,
    bareStem,
    isMarker,
    folderOf,
    gate,
    describe,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMLeaks = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
