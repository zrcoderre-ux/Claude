/**
 * Claude Usage Meter — pseudonym key logic (pure module).
 *
 * PDF-Linker scrubs a case's filings and writes pseudonym_key.xlsx, the
 * real↔fake map. Claude only ever sees the fakes; the person reading the chat
 * knows the case by its real names. This module holds every decision the
 * translation feature makes, so the wiring (pseudo-view.js, popup.js) stays a
 * thin layer over a tested core:
 *
 *   - parseKey:   key workbook rows → the usable map. Mirrors what
 *                 DeAnonymize.bas does with the same file: columns located by
 *                 HEADER NAME (never position), operator keep-decisions in the
 *                 Replacement column ("no", "never", "[...]", "{...}") are
 *                 instructions rather than pseudonyms and are dropped, an
 *                 "alt spelling" row is forward-only (its fake belongs to the
 *                 canonical row), and a fake claimed by two canonical reals is
 *                 ambiguous — retired from reversal rather than guessed at.
 *   - compile / translate:  fake → real for DISPLAY. Longest fake first so a
 *                 bare surname token never rewrites part of a longer full
 *                 name; whole words only; case-insensitive with an ALL-CAPS
 *                 match mirrored, since a caption shouts its parties.
 *   - compileReals / findReals:  which REAL values stand in a draft message —
 *                 the "you're about to type a real name" warning.
 *   - isKeyFileName / sheetsLookLikeKey:  is this file the key itself — the
 *                 one file that must never ride an upload into a chat.
 */
(function (root) {
  "use strict";

  // The macro's own pattern ("pseudonym_key*.xlsx"), plus the de-duplicated
  // copies Windows creates ("pseudonym_key (1).xlsx"). Matched on the base
  // name so a picked path and a dropped File agree.
  const KEY_FILE_RE = /^pseudonym[ _-]?key.*\.xlsx$/i;

  function isKeyFileName(name) {
    if (!name) return false;
    const base = String(name).split(/[\\/]/).pop();
    return KEY_FILE_RE.test(base.trim());
  }

  function fold(s) {
    return String(s == null ? "" : s).trim().replace(/\s+/g, " ").toLowerCase();
  }

  // Header row: the fingerprint is the headers every key layout shares —
  // DeAnonymize scans for "real value"/"replacement" by name, and so do we.
  function headerIndex(rows) {
    const lim = Math.min(rows ? rows.length : 0, 8);
    for (let i = 0; i < lim; i++) {
      const cells = (rows[i] || []).map(fold);
      if (cells.indexOf("real value") !== -1 && cells.indexOf("replacement") !== -1) return i;
    }
    return -1;
  }

  function sheetsLookLikeKey(sheets) {
    for (const s of sheets || []) if (headerIndex(s && s.rows) !== -1) return true;
    return false;
  }

  // An operator KEEP typed into the Replacement cell — "no"/"never" (leave the
  // Real Value verbatim), "[bracketed]"/"{braced}" keep-specs. Not a pseudonym:
  // it never appeared in any export, so it reverses nothing — and the value it
  // keeps is MEANT to appear verbatim, so it must not trip the warning either.
  function isKeepCell(v) {
    const f = fold(v);
    if (f === "no" || f === "never") return true;
    const t = String(v == null ? "" : v).trim();
    return (
      (t.length > 1 && t[0] === "[" && t[t.length - 1] === "]") ||
      (t.length > 1 && t[0] === "{" && t[t.length - 1] === "}")
    );
  }

  const ALT_STATUS = "alt spelling"; // forward-only: fake belongs to the canonical row

  /**
   * Key workbook → the map. `sheets` is what CUMXlsx.parseXlsx returns; every
   * sheet carrying the header fingerprint is read, which takes the pinned
   * "Pinned (never in text)" sheet along — a pinned party's fake can't appear
   * in text written from these exports, but its REAL name is exactly what the
   * warning exists to catch.
   *
   * Returns { name, rows, pairs, warn, dropped }:
   *   pairs — [{fake, real}] for display reversal, unambiguous owners only
   *   warn  — [{real, fake}] real values that must not be typed, with the
   *           stand-in to suggest instead
   */
  function parseKey(sheets, name) {
    const entries = [];
    let keeps = 0;
    for (const sheet of sheets || []) {
      const rows = (sheet && sheet.rows) || [];
      const hi = headerIndex(rows);
      if (hi === -1) continue;
      const heads = (rows[hi] || []).map(fold);
      const realCol = heads.indexOf("real value");
      const fakeCol = heads.indexOf("replacement");
      const statusCol = heads.indexOf("status");
      for (let i = hi + 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const real = String(row[realCol] == null ? "" : row[realCol]).trim();
        const fake = String(row[fakeCol] == null ? "" : row[fakeCol]).trim();
        if (!real || !fake) continue;
        if (isKeepCell(fake)) {
          keeps++;
          continue;
        }
        entries.push({
          real: real,
          fake: fake,
          alt: statusCol !== -1 && fold(row[statusCol]) === ALT_STATUS,
        });
      }
    }

    // Reversal: exactly one row may own each fake. Alt-spelling rows never
    // own; two CANONICAL rows claiming one fake is ambiguous and the mapping
    // is retired (the macro's fail-safe) rather than restored to a coin flip.
    const byFake = new Map();
    for (const e of entries) {
      const k = fold(e.fake);
      if (!byFake.has(k)) byFake.set(k, []);
      byFake.get(k).push(e);
    }
    const pairs = [];
    let ambiguous = 0;
    for (const group of byFake.values()) {
      const owners = group.filter((e) => !e.alt);
      // A group that is ALL synthetic promotes one row, exactly as write_key
      // does — a fake with no owner at all would reverse to nothing.
      const own = owners.length ? owners : [group[0]];
      if (own.length > 1) {
        ambiguous++;
        continue;
      }
      const e = own[0];
      if (fold(e.fake) === fold(e.real)) continue; // never map a value onto itself
      pairs.push({ fake: e.fake, real: e.real });
    }

    // The warning list: every real value the key binds, alt spellings
    // included — an OCR near-miss of a party's name is still that party.
    const warn = [];
    const seenReal = new Set();
    for (const e of entries) {
      const k = fold(e.real);
      if (seenReal.has(k)) continue;
      seenReal.add(k);
      warn.push({ real: e.real, fake: e.fake });
    }

    return {
      name: name || "",
      rows: entries.length,
      pairs: pairs,
      warn: warn,
      dropped: { keeps: keeps, ambiguous: ambiguous },
    };
  }

  // ---- matching -------------------------------------------------------------

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // One alternation, longest value first (the regex engine tries alternatives
  // in order, so the full name beats its own surname token). Values match
  // across a line wrap: a literal space in the value matches any whitespace
  // run. Boundaries are alphanumeric lookarounds rather than \b, because a
  // fake can end in a digit ("Deverell5") or hold an @ ("quenby3@postbox9.org")
  // and \b would misplace the edge.
  function buildMatcher(values) {
    const sorted = values
      .filter((v) => v)
      .slice()
      .sort((a, b) => b.length - a.length);
    if (!sorted.length) return null;
    const alts = sorted.map((v) => escapeRe(v).replace(/ /g, "\\s+")).join("|");
    return new RegExp("(?<![A-Za-z0-9_])(?:" + alts + ")(?![A-Za-z0-9_])", "gi");
  }

  function isAllCaps(s) {
    return /[A-Z]/.test(s) && s === s.toUpperCase();
  }

  /** Reversal matcher: translate() swaps every fake for its real value. */
  function compile(key) {
    const pairs = (key && key.pairs) || [];
    const map = new Map(pairs.map((p) => [fold(p.fake), p.real]));
    const rx = buildMatcher(pairs.map((p) => p.fake));
    return { rx: rx, map: map };
  }

  /**
   * Display translation. Single pass — replaced text is never re-scanned, so
   * a real value that happens to contain another row's fake word stays what
   * the document says. Returns { text, count }.
   */
  function translate(compiled, text) {
    if (!compiled || !compiled.rx || !text) return { text: text, count: 0 };
    let count = 0;
    const out = text.replace(compiled.rx, (m) => {
      const real = compiled.map.get(fold(m));
      if (real == null) return m;
      count++;
      return isAllCaps(m) ? real.toUpperCase() : real;
    });
    return { text: out, count: count };
  }

  /** Warning matcher over the REAL values. */
  function compileReals(key) {
    const warn = (key && key.warn) || [];
    const map = new Map();
    for (const w of warn) if (!map.has(fold(w.real))) map.set(fold(w.real), w);
    const rx = buildMatcher(warn.map((w) => w.real));
    return { rx: rx, map: map };
  }

  /**
   * Which real values stand in `text` — distinct, in first-seen order, each
   * with the fake to suggest instead. Longest-first matching means a full
   * name standing whole reports once, not once more per surname token.
   */
  function findReals(compiledReals, text) {
    if (!compiledReals || !compiledReals.rx || !text) return [];
    const seen = new Set();
    const out = [];
    compiledReals.rx.lastIndex = 0;
    let m;
    while ((m = compiledReals.rx.exec(text))) {
      const w = compiledReals.map.get(fold(m[0]));
      if (w && !seen.has(fold(w.real))) {
        seen.add(fold(w.real));
        out.push(w);
      }
      if (m.index === compiledReals.rx.lastIndex) compiledReals.rx.lastIndex++;
    }
    return out;
  }

  // Which conversation a claude.ai URL is — the same identity content.js and
  // the workflow model use, restated here so the popup (which loads neither)
  // agrees with them exactly.
  function conversationKeyFromUrl(url) {
    const s = String(url || "");
    const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (m) return m[0];
    try {
      return new URL(s).pathname;
    } catch (e) {
      return s || null;
    }
  }

  const api = {
    isKeyFileName,
    sheetsLookLikeKey,
    headerIndex,
    isKeepCell,
    parseKey,
    compile,
    translate,
    compileReals,
    findReals,
    buildMatcher,
    conversationKeyFromUrl,
    fold,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPseudo = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
