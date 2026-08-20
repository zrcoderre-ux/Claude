/**
 * Claude Usage Meter — minimal .xlsx reader (pure module).
 *
 * Reads a workbook into sheets of string rows — just enough to load the
 * pseudonym key PDF-Linker writes (pseudonym_key.xlsx). No dependency: an
 * .xlsx is a zip of XML parts, the zip's central directory is a fixed binary
 * layout, and DecompressionStream("deflate-raw") — present in Chrome and in
 * Node 18+ — undoes the one compression method Excel and openpyxl use.
 *
 * Scope is deliberate: shared strings (rich-text runs concatenated, which is
 * what the key's Context column is), inline strings, plain values, and sheet
 * names in workbook order. Formulas, styles, dates-as-serials and the rest of
 * OOXML are out — a key sheet is text, and anything unrecognised comes back
 * as the cell's raw <v> text rather than an error.
 */
(function (root) {
  "use strict";

  // ---- zip ----------------------------------------------------------------

  const EOCD_SIG = 0x06054b50; // end of central directory
  const CEN_SIG = 0x02014b50; // central directory file header
  const LOC_SIG = 0x04034b50; // local file header

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer)
      return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    throw new Error("xlsx: expected bytes");
  }

  function u16(b, off) {
    return b[off] | (b[off + 1] << 8);
  }
  function u32(b, off) {
    return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16)) + b[off + 3] * 0x1000000;
  }

  /**
   * The zip's table of contents: [{name, method, size, start}] with `start`
   * pointing at the entry's DATA (the local header already skipped). The
   * central directory is authoritative — local headers may carry zero sizes
   * when the writer streamed — so sizes come from it, and only the local
   * header's own name/extra lengths are read to find where data begins.
   */
  function zipEntries(data) {
    const b = toBytes(data);
    // EOCD sits at the end, at most 64K of comment after it.
    let eocd = -1;
    const stop = Math.max(0, b.length - 65557);
    for (let i = b.length - 22; i >= stop; i--) {
      if (u32(b, i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("xlsx: not a zip (no central directory)");
    const count = u16(b, eocd + 10);
    let off = u32(b, eocd + 16);
    const entries = [];
    for (let n = 0; n < count; n++) {
      if (u32(b, off) !== CEN_SIG) break;
      const method = u16(b, off + 10);
      const compSize = u32(b, off + 20);
      const nameLen = u16(b, off + 28);
      const extraLen = u16(b, off + 30);
      const commentLen = u16(b, off + 32);
      const localOff = u32(b, off + 42);
      const name = utf8(b.subarray(off + 46, off + 46 + nameLen));
      if (u32(b, localOff) === LOC_SIG) {
        const lNameLen = u16(b, localOff + 26);
        const lExtraLen = u16(b, localOff + 28);
        entries.push({
          name: name,
          method: method,
          size: compSize,
          start: localOff + 30 + lNameLen + lExtraLen,
        });
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function utf8(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  /** Entry bytes → text. Method 0 is stored; 8 is deflate. */
  async function readEntry(data, entry) {
    const b = toBytes(data);
    const raw = b.subarray(entry.start, entry.start + entry.size);
    if (entry.method === 0) return utf8(raw);
    if (entry.method !== 8) throw new Error("xlsx: unsupported compression " + entry.method);
    const ds = new DecompressionStream("deflate-raw");
    // A fresh copy, not a subarray view — Response() can transfer the buffer.
    const body = new Response(new Blob([new Uint8Array(raw)]).stream().pipeThrough(ds));
    return utf8(new Uint8Array(await body.arrayBuffer()));
  }

  // ---- xml (regex over trusted machine-written parts) ----------------------

  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

  function unescapeXml(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, code) => {
      if (code[0] === "#") {
        const n =
          code[1] === "x" || code[1] === "X"
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10);
        return isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code] != null ? ENTITIES[code] : m;
    });
  }

  function attr(tag, name) {
    const m = tag.match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"'));
    return m ? unescapeXml(m[1]) : null;
  }

  /** Every <t> in a fragment, concatenated — one plain string per <si>/<is>,
   *  rich-text runs and phonetic-free alike. */
  function joinT(fragment) {
    let out = "";
    const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
    let m;
    while ((m = re.exec(fragment))) out += m[1] != null ? unescapeXml(m[1]) : "";
    return out;
  }

  function parseSharedStrings(xml) {
    const out = [];
    if (!xml) return out;
    const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g;
    let m;
    while ((m = re.exec(xml))) out.push(m[1] != null ? joinT(m[1]) : "");
    return out;
  }

  /** "BC7" → column 54 (0-based). */
  function colIndex(ref) {
    let col = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      col = col * 26 + (c - 64);
    }
    return col > 0 ? col - 1 : 0;
  }

  function cellText(cellTag, inner, shared) {
    const t = attr(cellTag, "t");
    if (t === "inlineStr") return joinT(inner);
    const vm = inner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
    const v = vm ? unescapeXml(vm[1]) : "";
    if (t === "s") {
      const i = parseInt(v, 10);
      return isFinite(i) && shared[i] != null ? shared[i] : "";
    }
    if (t === "b") return v === "1" ? "TRUE" : "FALSE";
    return v; // "str", numbers, anything else: the raw text
  }

  function parseSheetXml(xml, shared) {
    const rows = [];
    const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const row = [];
      let next = 0; // next column when a cell carries no r=
      const cellRe = /<c((?:\s[^>]*)?)\/>|<c((?:\s[^>]*)?)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        const tag = cm[1] != null ? cm[1] : cm[2];
        const inner = cm[3] || "";
        const ref = attr(tag, "r");
        const at = ref ? colIndex(ref) : next;
        row[at] = cm[1] != null ? "" : cellText(tag, inner, shared);
        next = at + 1;
      }
      for (let i = 0; i < row.length; i++) if (row[i] == null) row[i] = "";
      rows.push(row);
    }
    return rows;
  }

  // ---- workbook -------------------------------------------------------------

  /**
   * The workbook's sheets, in workbook order: [{name, rows: string[][]}].
   * Sheet names come from xl/workbook.xml and each is tied to its part through
   * the rels file; a workbook without rels (or with an unresolvable rid) falls
   * back to xl/worksheets/sheetN.xml in numeric order, which is what every
   * writer produces anyway.
   */
  async function parseXlsx(data) {
    const b = toBytes(data);
    const entries = zipEntries(b);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const text = async (name) => {
      const e = byName.get(name);
      return e ? readEntry(b, e) : "";
    };

    const shared = parseSharedStrings(await text("xl/sharedStrings.xml"));

    const rels = {};
    const relsXml = await text("xl/_rels/workbook.xml.rels");
    let m;
    const relRe = /<Relationship\s[^>]*\/?>/g;
    while ((m = relRe.exec(relsXml))) {
      const id = attr(m[0], "Id");
      let target = attr(m[0], "Target");
      if (!id || !target) continue;
      if (target.indexOf("/") === 0) target = target.slice(1);
      else if (target.indexOf("xl/") !== 0) target = "xl/" + target;
      rels[id] = target.replace(/\/\.\//g, "/");
    }

    const sheets = [];
    const wbXml = await text("xl/workbook.xml");
    const sheetRe = /<sheet\s[^>]*\/?>/g;
    while ((m = sheetRe.exec(wbXml))) {
      const name = attr(m[0], "name") || "Sheet" + (sheets.length + 1);
      const rid = attr(m[0], "r:id") || attr(m[0], "d2p1:id");
      sheets.push({ name: name, part: (rid && rels[rid]) || null });
    }
    if (!sheets.length) sheets.push({ name: "Sheet1", part: null });

    // Fallback part order for sheets the rels could not place.
    const parts = entries
      .map((e) => e.name)
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, c) => parseInt(a.match(/\d+/)[0], 10) - parseInt(c.match(/\d+/)[0], 10));
    let nextPart = 0;
    const out = [];
    for (const s of sheets) {
      let part = s.part;
      if (!part || !byName.has(part)) part = parts[nextPart] || null;
      if (part) {
        const at = parts.indexOf(part);
        if (at >= 0) nextPart = at + 1;
      }
      out.push({
        name: s.name,
        rows: part ? parseSheetXml(await text(part), shared) : [],
      });
    }
    return { sheets: out };
  }

  const api = {
    parseXlsx,
    zipEntries,
    readEntry,
    parseSharedStrings,
    parseSheetXml,
    colIndex,
    unescapeXml,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMXlsx = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
