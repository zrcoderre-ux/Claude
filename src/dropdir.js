/**
 * Claude Usage Meter — a dropped FOLDER, taken apart (pure).
 *
 * Dragging a folder onto an uploader should hand it the files inside, not the
 * folder. That is the whole feature, and it is what lets a matter's papers and
 * the pseudonym key sitting beside them go in one gesture: drop the folder and
 * the key together, the folder is walked, the key is recognised on its way past.
 *
 * The walk is here rather than in the two forms that need it because it has
 * three traps in it, and every one of them fails SILENTLY:
 *
 *   readEntries returns AT MOST 100 entries per call, and the way you learn
 *   there are more is that it says so on the next call. Read it once and a
 *   folder of 140 papers quietly becomes 100.
 *
 *   A folder carries files nobody meant to upload — .DS_Store beside every
 *   Mac folder, Thumbs.db beside every Windows one. They cost an attachment
 *   slot each and tell Claude nothing.
 *
 *   And a folder can be enormous, or a symlink loop. A cap is needed, and a
 *   cap that doesn't say it was reached is a truncation pretending to be an
 *   upload.
 *
 * Pure in the sense that matters: no chrome, no document, no window. The
 * entries it walks are duck-typed — anything with isFile/isDirectory, file()
 * and createReader() — so the whole thing tests under Node against fakes,
 * which is the only way the 100-entry trap ever gets tested at all.
 */
(function (root) {
  "use strict";

  // What a folder carries that nobody meant to upload. Dotfiles as a class
  // (.DS_Store, .gitignore, .env — the last of which REALLY shouldn't ride
  // along), plus the named few that don't start with a dot.
  const JUNK = new Set(["thumbs.db", "desktop.ini", "icon\r", "__macosx", ".ds_store"]);

  function isJunkName(name) {
    const n = String(name == null ? "" : name).trim();
    if (!n) return true;
    if (n.charAt(0) === ".") return true; // every dotfile, on every platform
    return JUNK.has(n.toLowerCase());
  }

  // A folder of papers is big; a home directory is not a folder of papers.
  // Both caps are deliberately generous — they exist to stop a catastrophe,
  // not to shape what you may upload — and reaching either one is REPORTED.
  const MAX_FILES = 300;
  const MAX_DEPTH = 8;

  function baseName(path) {
    const p = String(path == null ? "" : path);
    const i = p.lastIndexOf("/");
    return i === -1 ? p : p.slice(i + 1);
  }

  // Folder order, not filesystem order. The files a run receives are uploaded
  // in the order they are held and, when they're text, concatenated in it —
  // so "the order the folder reads in" is the answer, and readEntries' own
  // order is no answer at all. Numeric runs sort like numbers, so exhibit-2
  // precedes exhibit-10.
  function comparePaths(a, b) {
    return String(a).localeCompare(String(b), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  function sortByPath(list) {
    return (list || []).slice().sort((x, y) => comparePaths(x.path, y.path));
  }

  /**
   * Walk dropped entries into a flat list of files.
   *
   * `entries` are FileSystemEntry-shaped. Directories are descended into and
   * never themselves produce a file — a folder is not a document. Returns
   * { files: [{file, path}], folders, skipped, junk, capped, deep }.
   *
   * Never rejects: an entry that can't be read is counted in `skipped` and the
   * rest of the drop still lands. Half a folder with a note about it beats an
   * error where a drop should have been.
   */
  function walk(entries, opts) {
    const o = opts || {};
    const maxFiles = o.maxFiles == null ? MAX_FILES : o.maxFiles;
    const maxDepth = o.maxDepth == null ? MAX_DEPTH : o.maxDepth;
    const out = { files: [], folders: 0, skipped: 0, junk: 0, capped: false, deep: 0 };

    function one(entry, prefix, depth) {
      return new Promise((resolve) => {
        if (!entry || out.capped) return resolve();
        const name = entry.name || baseName(entry.fullPath || "");
        const path = prefix ? prefix + "/" + name : name;
        if (isJunkName(name)) {
          out.junk++;
          return resolve();
        }
        if (entry.isFile) {
          if (out.files.length >= maxFiles) {
            out.capped = true;
            return resolve();
          }
          // entry.file() is the only way to the bytes, and it is callback-only.
          entry.file(
            (f) => {
              out.files.push({ file: f, path: path });
              resolve();
            },
            () => {
              out.skipped++;
              resolve();
            }
          );
          return;
        }
        if (!entry.isDirectory) return resolve(); // neither: nothing to take
        out.folders++;
        if (depth >= maxDepth) {
          out.deep++;
          return resolve();
        }
        const reader = entry.createReader();
        // THE TRAP: readEntries hands back at most 100 entries and expects to
        // be called again until it hands back none. Reading once loses
        // everything past the hundredth without a word.
        const batch = () => {
          reader.readEntries(
            async (list) => {
              if (!list || !list.length) return resolve();
              for (const e of list) await one(e, path, depth + 1);
              if (out.capped) return resolve();
              batch();
            },
            () => {
              out.skipped++;
              resolve();
            }
          );
        };
        batch();
      });
    }

    // One at a time rather than Promise.all: the cap has to be able to stop
    // the walk, and a deterministic order costs nothing here.
    let chain = Promise.resolve();
    for (const e of entries || []) chain = chain.then(() => one(e, "", 0));
    return chain.then(() => {
      out.files = sortByPath(out.files);
      return out;
    });
  }

  /**
   * The same rules over a <input webkitdirectory> pick, which hands back a
   * flat FileList with the folder path on each file instead of entries.
   */
  function fromPicked(fileList, opts) {
    const o = opts || {};
    const maxFiles = o.maxFiles == null ? MAX_FILES : o.maxFiles;
    const out = { files: [], folders: 0, skipped: 0, junk: 0, capped: false, deep: 0 };
    const seenDirs = new Set();
    for (const f of fileList || []) {
      const path = f.webkitRelativePath || f.name || "";
      // A junk file by its own name; a dotted FOLDER anywhere in the path
      // (".git/…") takes everything under it with it. Counted before the
      // folder is, so a folder nothing survives isn't reported as a source.
      if (path.split("/").some(isJunkName)) {
        out.junk++;
        continue;
      }
      const dir = path.indexOf("/") === -1 ? "" : path.slice(0, path.lastIndexOf("/"));
      if (dir) seenDirs.add(dir);
      if (out.files.length >= maxFiles) {
        out.capped = true;
        break;
      }
      out.files.push({ file: f, path: path });
    }
    out.folders = seenDirs.size;
    out.files = sortByPath(out.files);
    return out;
  }

  /**
   * What just happened, in one sentence, or "" when there is nothing worth
   * saying (a plain drop of two files that both landed). A cap or a skip is
   * ALWAYS said: a truncation nobody mentions is the failure this module
   * exists to avoid.
   */
  function summarize(res, opts) {
    if (!res) return "";
    const maxFiles = (opts && opts.maxFiles) || MAX_FILES;
    const n = res.files.length;
    const notes = [];
    if (res.junk) notes.push(res.junk === 1 ? "1 hidden file" : res.junk + " hidden files");
    if (res.skipped)
      notes.push(res.skipped === 1 ? "1 unreadable file" : res.skipped + " unreadable files");
    if (res.deep) notes.push("folders nested deeper than " + MAX_DEPTH);
    const skipped = notes.length ? " Skipped " + notes.join(", ") + "." : "";
    if (res.capped)
      return (
        "Took the first " +
        maxFiles +
        " files — that folder holds more, and the rest were left out." +
        skipped
      );
    if (!res.folders) return skipped.trim(); // a plain file drop; only notes matter
    const files = n === 1 ? "1 file" : n + " files";
    const from = res.folders === 1 ? "the folder" : res.folders + " folders";
    return "Added " + files + " from " + from + " — the folder itself isn't a document." + skipped;
  }

  const api = {
    JUNK,
    isJunkName,
    MAX_FILES,
    MAX_DEPTH,
    baseName,
    comparePaths,
    sortByPath,
    walk,
    fromPicked,
    summarize,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMDropDir = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
