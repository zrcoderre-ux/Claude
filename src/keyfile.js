/**
 * The pseudonym key FILE — keeping the workbook that was loaded, so it can be
 * handed back.
 *
 * The library stores what a key MEANS: the rows parseKey could read, minus the
 * ones it deliberately drops (keep rows, ambiguous fakes). That is the right
 * thing to translate a page with and the wrong thing to give back as a file —
 * a rebuilt workbook would be missing exactly the rows the parser threw away,
 * and it would look like the original while being quietly less than it. So a
 * key can be re-downloaded only when its own bytes were kept, and a key that
 * predates this being kept says so plainly rather than handing over a
 * reconstruction.
 *
 * Which makes the rule here: the file is stored beside the library, never
 * inside it — the library is read on every page load and on every translation
 * sweep, and a megabyte of base64 riding along on all of that is a cost paid
 * for nothing. `cum_pseudo_keyfiles` is read only when the panel is open.
 *
 * Pure: no DOM, no chrome. The pickers, the writes and the anchor-and-blob save
 * live in the wiring (src/key-panel.js and the other three loaders).
 */
(function (root) {
  "use strict";

  // Where the bytes live, kept here so all four loaders and the panel name the
  // same place.
  const FILES_KEY = "cum_pseudo_keyfiles";

  // A key workbook is tens of kilobytes; a hundred-megabyte "key" is somebody
  // having picked the wrong file, and storing it helps nobody.
  const MAX_BYTES = 8 * 1024 * 1024;

  // How many files to keep. The library itself is unbounded — an entry is a few
  // kilobytes and forgetting one is a decision the operator makes — but these
  // are not, so the oldest fall off rather than growing without end.
  const KEEP_FILES = 20;

  const str = (v) => (v == null ? "" : String(v));
  const norm = (v) => str(v).replace(/\s+/g, " ").trim();

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  /**
   * Bytes to base64, three at a time. Written out rather than leaning on btoa
   * and String.fromCharCode.apply, because the callers are a content script, a
   * popup, an options page and a test runner: a key that could be saved in one
   * place and not another would be the worst kind of half-working, and the
   * apply() spread is a stack overflow waiting for a big enough workbook.
   */
  function bytesToBase64(bytes) {
    const b = bytes && bytes.length != null ? bytes : [];
    let out = "";
    for (let i = 0; i < b.length; i += 3) {
      const a0 = b[i] & 255;
      const has1 = i + 1 < b.length;
      const has2 = i + 2 < b.length;
      const a1 = has1 ? b[i + 1] & 255 : 0;
      const a2 = has2 ? b[i + 2] & 255 : 0;
      out += B64[a0 >> 2];
      out += B64[((a0 & 3) << 4) | (a1 >> 4)];
      out += has1 ? B64[((a1 & 15) << 2) | (a2 >> 6)] : "=";
      out += has2 ? B64[a2 & 63] : "=";
    }
    return out;
  }

  /** Base64 back to bytes. Anything that isn't base64 comes back empty. */
  function base64ToBytes(b64) {
    const s = str(b64).replace(/[^A-Za-z0-9+/=]/g, "").replace(/=+$/, "");
    const n = Math.floor((s.length * 6) / 8);
    const out = typeof Uint8Array === "function" ? new Uint8Array(n) : new Array(n);
    let acc = 0;
    let bits = 0;
    let at = 0;
    for (let i = 0; i < s.length; i++) {
      const v = B64.indexOf(s[i]);
      if (v < 0) continue;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[at++] = (acc >> bits) & 255;
      }
    }
    return out;
  }

  /**
   * The record to store for a loaded workbook, or the reason there isn't one.
   * `{ ok: true, record }` or `{ ok: false, why }` — never a silent nothing,
   * because "this key can't be re-downloaded" is a sentence the panel owes the
   * operator and an empty return is not one.
   */
  function fileRecord(bytes, name, at) {
    const b = bytes && bytes.length != null ? bytes : null;
    if (!b || !b.length) return { ok: false, why: "the file read as empty" };
    if (b.length > MAX_BYTES)
      return {
        ok: false,
        why: "the file is " + sizeText(b.length) + ", past the " + sizeText(MAX_BYTES) + " kept here",
      };
    return {
      ok: true,
      record: {
        name: norm(name) || "pseudonym_key.xlsx",
        size: b.length,
        at: at || 0,
        b64: bytesToBase64(b),
      },
    };
  }

  /** The stored file for a library id, or null. */
  function fileFor(files, id) {
    const f = files && typeof files === "object" ? files : {};
    const rec = id ? f[id] : null;
    return rec && rec.b64 ? rec : null;
  }

  /**
   * `files` with `record` filed under `id`, oldest dropped past `keep`. The
   * newest write always survives the trim — a key just loaded that fell off its
   * own store would be the one failure nobody would think to look for.
   */
  function putFile(files, id, record, keep) {
    const out = {};
    const src = files && typeof files === "object" ? files : {};
    for (const k of Object.keys(src)) out[k] = src[k];
    if (!id || !record || !record.b64) return out;
    out[id] = record;
    const cap = keep > 0 ? keep : KEEP_FILES;
    const ids = Object.keys(out);
    if (ids.length <= cap) return out;
    // Newest first, with the write that just happened moved to the front
    // whatever its timestamp says: a key just loaded that fell off its own
    // store is the failure nobody would think to look for.
    ids.sort((a, b) => (out[b].at || 0) - (out[a].at || 0));
    const order = [id].concat(ids.filter((k) => k !== id));
    const kept = {};
    for (const k of order.slice(0, cap)) kept[k] = out[k];
    return kept;
  }

  /** `files` without the entries for `ids` — what forgetting a key must do. */
  function dropFiles(files, ids) {
    const out = {};
    const src = files && typeof files === "object" ? files : {};
    const gone = {};
    for (const id of ids || []) gone[str(id)] = true;
    for (const k of Object.keys(src)) if (!gone[k]) out[k] = src[k];
    return out;
  }

  /** 14 KB, 1.2 MB — a size a person reads rather than a byte count. */
  function sizeText(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (Math.round((n / (1024 * 1024)) * 10) / 10).toFixed(1) + " MB";
  }

  /**
   * What the panel says about a key's stored file: the filename and size when
   * there is one, and WHY there isn't when there isn't — the two reasons being
   * a key loaded before the file was kept and one loaded since with no bytes
   * stored, which want different answers.
   *
   * `label` is what the key is called, so the sentence names the matter rather
   * than "this key".
   */
  function describeFile(rec, label) {
    const name = label ? norm(label) : "this key";
    if (rec && rec.b64)
      return (
        "The workbook loaded for " + name + " is kept here — " +
        norm(rec.name) + ", " + sizeText(rec.size) + "."
      );
    return (
      "No workbook is kept for " + name + ", so there is nothing to hand back. " +
      "Keys loaded before this panel started keeping the file, or loaded from a " +
      "run, need loading once more; what is stored for them is the rows, which " +
      "is less than the file was."
    );
  }

  /**
   * What the re-downloaded file is called: the name it arrived under, kept
   * exactly. The macro that reverses a pseudonymized document expects
   * `pseudonym_key.xlsx`, so this is one of the few places a name is copied
   * rather than composed.
   */
  function saveAsName(rec) {
    return (rec && norm(rec.name)) || "pseudonym_key.xlsx";
  }

  /** Whether a key can be handed back at all — what the button's state is. */
  function canDownload(files, id) {
    return !!fileFor(files, id);
  }

  const api = {
    FILES_KEY,
    MAX_BYTES,
    KEEP_FILES,
    bytesToBase64,
    base64ToBytes,
    fileRecord,
    fileFor,
    putFile,
    dropFiles,
    sizeText,
    describeFile,
    saveAsName,
    canDownload,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMKeyFile = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
