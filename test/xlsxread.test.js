"use strict";

const test = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");

const X = require("../src/xlsxread.js");

// ---- a tiny zip writer, enough to build fixtures --------------------------

function bytes(...parts) {
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
}
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** files: [{name, text}] → a zip buffer. `stored` skips deflate. */
function buildZip(files, opts) {
  const stored = opts && opts.stored;
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const f of files) {
    const raw = Buffer.from(f.text, "utf-8");
    const data = stored ? raw : zlib.deflateRawSync(raw);
    const method = stored ? 0 : 8;
    const name = Buffer.from(f.name, "utf-8");
    const local = bytes(
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(0), u32(data.length), u32(raw.length), u16(name.length), u16(0),
      name, data
    );
    centrals.push(
      bytes(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
        u32(0), u32(data.length), u32(raw.length), u16(name.length), u16(0),
        u16(0), u16(0), u16(0), u32(0), u32(off), name
      )
    );
    locals.push(local);
    off += local.length;
  }
  const cd = bytes(...centrals);
  const eocd = bytes(
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(off), u16(0)
  );
  return bytes(...locals, cd, eocd);
}

// ---- a small workbook fixture ----------------------------------------------

const WORKBOOK = `<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <sheets>
  <sheet name="Key" sheetId="1" r:id="rId1"/>
  <sheet name="Pinned (never in text)" sheetId="2" r:id="rId2"/>
 </sheets>
</workbook>`;

const RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/>
 <Relationship Id="rId2" Type="t" Target="worksheets/sheet2.xml"/>
</Relationships>`;

// Rich-text runs in one <si> (what the key's Context column is), an escaped
// entity, and a plain string.
const SHARED = `<?xml version="1.0"?>
<sst count="4" uniqueCount="4">
 <si><t>Real Value</t></si>
 <si><t>Replacement</t></si>
 <si><r><t>Smith </t></r><r><rPr><b/></rPr><t xml:space="preserve">&amp; Sons</t></r></si>
 <si><t>Keswick</t></si>
</sst>`;

// Header via shared strings, one row of shared + inline + str cells, a gap
// column (C skipped via r=), and a self-closed empty cell.
const SHEET1 = `<?xml version="1.0"?>
<worksheet><sheetData>
 <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
 <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="D2" t="inlineStr"><is><t>inline</t></is></c></row>
 <row r="3"><c r="A3" t="str"><v>=SUM(1)</v></c><c r="B3"><v>42</v></c><c r="C3"/></row>
</sheetData></worksheet>`;

const SHEET2 = `<?xml version="1.0"?>
<worksheet><sheetData>
 <row><c t="inlineStr"><is><t>Real Value</t></is></c><c t="inlineStr"><is><t>Replacement</t></is></c></row>
 <row><c t="inlineStr"><is><t>Jane Roe</t></is></c><c t="inlineStr"><is><t>Marlow</t></is></c></row>
</sheetData></worksheet>`;

function fixtureZip(opts) {
  return buildZip(
    [
      { name: "xl/workbook.xml", text: WORKBOOK },
      { name: "xl/_rels/workbook.xml.rels", text: RELS },
      { name: "xl/sharedStrings.xml", text: SHARED },
      { name: "xl/worksheets/sheet1.xml", text: SHEET1 },
      { name: "xl/worksheets/sheet2.xml", text: SHEET2 },
    ],
    opts
  );
}

test("zipEntries reads the central directory", () => {
  const zip = fixtureZip();
  const names = X.zipEntries(zip).map((e) => e.name);
  assert.deepStrictEqual(names, [
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/sharedStrings.xml",
    "xl/worksheets/sheet1.xml",
    "xl/worksheets/sheet2.xml",
  ]);
});

test("parseXlsx reads a deflated workbook: names, order, cells", async () => {
  const wb = await X.parseXlsx(fixtureZip());
  assert.strictEqual(wb.sheets.length, 2);
  assert.strictEqual(wb.sheets[0].name, "Key");
  assert.strictEqual(wb.sheets[1].name, "Pinned (never in text)");
  const rows = wb.sheets[0].rows;
  assert.deepStrictEqual(rows[0], ["Real Value", "Replacement"]);
  // Rich-text runs concatenate; the entity unescapes; the skipped column is "".
  assert.deepStrictEqual(rows[1], ["Smith & Sons", "Keswick", "", "inline"]);
  // t="str" keeps its text; a bare numeric cell keeps its raw digits.
  assert.deepStrictEqual(rows[2], ["=SUM(1)", "42", ""]);
  assert.deepStrictEqual(wb.sheets[1].rows[1], ["Jane Roe", "Marlow"]);
});

test("parseXlsx reads a stored (uncompressed) workbook the same", async () => {
  const wb = await X.parseXlsx(fixtureZip({ stored: true }));
  assert.deepStrictEqual(wb.sheets[0].rows[1][0], "Smith & Sons");
});

test("a workbook without rels falls back to sheetN order", async () => {
  const zip = buildZip([
    { name: "xl/workbook.xml", text: WORKBOOK },
    { name: "xl/sharedStrings.xml", text: SHARED },
    { name: "xl/worksheets/sheet1.xml", text: SHEET1 },
    { name: "xl/worksheets/sheet2.xml", text: SHEET2 },
  ]);
  const wb = await X.parseXlsx(zip);
  assert.strictEqual(wb.sheets[0].rows[0][0], "Real Value");
  assert.strictEqual(wb.sheets[1].rows[1][0], "Jane Roe");
});

test("not a zip is a loud error, not junk rows", () => {
  assert.throws(() => X.zipEntries(Buffer.from("this is a .txt export")), /not a zip/);
});

test("colIndex and unescapeXml", () => {
  assert.strictEqual(X.colIndex("A1"), 0);
  assert.strictEqual(X.colIndex("Z9"), 25);
  assert.strictEqual(X.colIndex("AA10"), 26);
  assert.strictEqual(X.unescapeXml("Rasho &amp; Sons &lt;3 &#x2019;s &#65;"), "Rasho & Sons <3 ’s A");
});

test("accepts Uint8Array and ArrayBuffer alike", async () => {
  const buf = fixtureZip();
  const u8 = new Uint8Array(buf);
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const a = await X.parseXlsx(u8);
  const b = await X.parseXlsx(ab);
  assert.deepStrictEqual(a.sheets[0].rows, b.sheets[0].rows);
});
