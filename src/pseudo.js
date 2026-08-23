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
 *   - runTranslationHold:  whether a workflow run is MOVING through this chat
 *                 (or this chat's matter), in which case the display stands
 *                 down and shows the fakes — a run's hand-off can fall back to
 *                 the rendered message, and the rendered message is what the
 *                 display rewrites. Derived from the run's own status, so a
 *                 pause, a hold, a failure or a dead driver puts the real
 *                 names straight back.
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

  // A POSSESSIVE is the party's own name, not a second party — PDF-Linker's
  // own rule (its registry draws on the affix-stripped core). Both marks,
  // because the spreadsheet exports the straight one and Word writes the
  // typographic one.
  const POSS_TAIL_RE = /['’]s$/i;
  const POSS_MATCH_RE = /['’][sS]$/;

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
      const occCol = heads.indexOf("occurrences");
      for (let i = hi + 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const real = String(row[realCol] == null ? "" : row[realCol]).trim();
        const fake = String(row[fakeCol] == null ? "" : row[fakeCol]).trim();
        if (!real || !fake) continue;
        if (isKeepCell(fake)) {
          keeps++;
          continue;
        }
        const occ = occCol !== -1 ? parseInt(row[occCol], 10) : 0;
        entries.push({
          real: real,
          fake: fake,
          alt: statusCol !== -1 && fold(row[statusCol]) === ALT_STATUS,
          occ: isFinite(occ) && occ > 0 ? occ : 0,
        });
      }
    }

    // A row bound in the POSSESSIVE binds the bare name too: "Zachary's ->
    // John's" means Zachary IS John, so a derived base row is added unless
    // the key already carries one. (The other direction — a bare row meeting
    // a possessive in text — needs no extra row: the matchers accept an
    // optional trailing 's and carry it across, so "Zachary -> John" already
    // turns "Zachary's" into "John's".)
    const haveReal = new Set(entries.map((e) => fold(e.real)));
    const derived = [];
    for (const e of entries) {
      if (!POSS_TAIL_RE.test(e.real)) continue;
      const baseReal = e.real.replace(POSS_TAIL_RE, "");
      const baseFake = e.fake.replace(POSS_TAIL_RE, "");
      if (!baseReal || !baseFake || haveReal.has(fold(baseReal))) continue;
      haveReal.add(fold(baseReal));
      derived.push({ real: baseReal, fake: baseFake, alt: e.alt, occ: 0 });
    }
    for (const d of derived) entries.push(d);

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

    // Which CASE this key belongs to, said in one value: the real name the
    // exports used most. Every key is named pseudonym_key.xlsx, so the
    // filename can't tell two cases apart in a list — the lead party can.
    let hint = "";
    let hintOcc = -1;
    for (const e of entries) {
      if (!e.alt && !isCommonReal(e.real) && e.occ > hintOcc) {
        hint = e.real;
        hintOcc = e.occ;
      }
    }

    return {
      name: name || "",
      rows: entries.length,
      pairs: pairs,
      warn: warn,
      hint: hint,
      dropped: { keeps: keeps, ambiguous: ambiguous },
    };
  }

  // ---- the key library's identity ------------------------------------------
  //
  // Keys are CASE-specific, and every case's key file is named
  // pseudonym_key.xlsx — so a filename can never be the library id, or
  // loading the second case's key would silently replace the first and every
  // chat attached to it would translate with the wrong case. Identity comes
  // from CONTENT instead.

  function pairSet(key) {
    return ((key && key.pairs) || []).map((p) => fold(p.real) + ">" + fold(p.fake));
  }

  /** A short content signature over the reversal pairs (FNV-1a, order-free). */
  function keySignature(key) {
    const pairs = pairSet(key).sort();
    let h = 2166136261;
    for (const s of pairs) {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      h ^= 10;
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  /**
   * Are these the SAME CASE's key — one perhaps refreshed by a re-run that
   * added rows? A re-run only ever grows a key and never moves a binding, so
   * the older key's pairs survive into the newer one nearly whole; two
   * different cases share at most incidental bindings (a common attorney).
   * Same case = most of the smaller key's bindings appear in the other, with
   * a floor so two tiny keys can't coincide their way in.
   */
  function sameCaseKey(a, b) {
    const A = new Set(pairSet(a));
    const B = pairSet(b);
    if (!A.size || !B.length) return false;
    let shared = 0;
    for (const s of B) if (A.has(s)) shared++;
    return shared >= Math.max(3, Math.ceil(Math.min(A.size, B.length) * 0.6));
  }

  /**
   * Where a freshly parsed key goes in the stored library: onto the entry
   * that is the same case's key (a refresh — the id survives, so every chat
   * and run attached to it follows onto the new rows), else under a new id
   * of its own, filename + content signature, so two cases' identically
   * named files never collide.
   */
  function libraryIdFor(keys, key) {
    for (const id of Object.keys(keys || {})) {
      if (sameCaseKey(keys[id], key)) return { id: id, refreshed: true };
    }
    return { id: fold(key && key.name) + "#" + keySignature(key), refreshed: false };
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
    // A value not already possessive also matches its own possessive —
    // "John" matches "John's" — and the lookup carries the suffix across.
    const alts = sorted
      .map(
        (v) =>
          escapeRe(v).replace(/ /g, "\\s+") + (POSS_TAIL_RE.test(v) ? "" : "(?:['’][sS])?")
      )
      .join("|");
    return new RegExp("(?<![A-Za-z0-9_])(?:" + alts + ")(?![A-Za-z0-9_])", "gi");
  }

  /**
   * The shape a name is written in. Four answers, and the fourth is the point:
   *   upper  SHOUTED, the whole thing        (a caption, a heading)
   *   lower  quiet, the whole thing          (a slug, a lowercased list)
   *   title  Every Word Capitalised          (ordinary prose)
   *   mixed  anything with deliberate case inside it — "McDonald", "LLC",
   *          "OneWest" — which is a shape no transform can be derived from,
   *          so text of that shape is left exactly as it was written.
   * `none` is a value with no letters at all (a case number, a phone number).
   */
  function caseShape(s) {
    const t = String(s == null ? "" : s);
    if (!/[A-Za-z]/.test(t)) return "none";
    if (t === t.toUpperCase()) return "upper";
    if (t === t.toLowerCase()) return "lower";
    const words = t.match(/[A-Za-z]+/g) || [];
    return words.every((w) => /^[A-Z][a-z]*$/.test(w)) ? "title" : "mixed";
  }

  // Abbreviations a title pass must not take the capitals off. The test that
  // does most of the work is mechanical: an all-caps word of four letters or
  // fewer with no vowel in it (LLC, LLP, LP, PC, LTD, DDS, IBM, CVS) is an
  // abbreviation, not a shouted word, and one or two letters is an initial.
  // The short list beside it is for the ones that carry a vowel and would
  // otherwise come out as words. It can grow; nothing depends on it being
  // complete, and a miss costs one wrongly-titled abbreviation.
  const KEEP_UPPER = new Set(
    (
      "usa esq dba aka fka hoa ada eeoc inc " +
      // Agencies and the like, which do turn up as real values in a caption.
      "irs dmv fbi cia epa doj dhs faa atf dea sec fda fcc ftc osha ssa nlrb ibm aol"
    ).split(" ")
  );

  function looksAbbrev(word) {
    const letters = word.replace(/[^A-Za-z]/g, "");
    if (!letters) return false;
    if (letters.length <= 2) return true; // an initial, or PC / NA / JR
    if (KEEP_UPPER.has(letters.toLowerCase())) return true;
    return letters.length <= 4 && !/[AEIOUY]/i.test(letters);
  }

  // A word for casing purposes: letters, with an apostrophe INSIDE the word
  // rather than ending it — "O'Brien" and "Coderre's" are each one word, so
  // titling can't produce "O'BRien" or "Coderre'S".
  const WORD_RE = /[A-Za-z]+(?:['\u2019][A-Za-z]+)*/g;

  // `deliberate` — whether the value this word came out of has lowercase in it
  // somewhere, which makes every capital in it authored rather than incidental.
  function titleWord(w, deliberate) {
    const up = w === w.toUpperCase();
    const low = w === w.toLowerCase();
    // Internal capitals — "McDonald", "OneWest", "d'Angelo" — are authored,
    // and no title pass gets to overwrite them.
    if (!up && !low) return w;
    // An ALL-CAPS word standing in a value that is otherwise ordinary —
    // "Cross River Bank, LLC", "IBM Credit Corp" — was capitalised on purpose
    // against that backdrop, so it stays whatever it is. Only in a value that
    // is all-caps THROUGHOUT is there nothing to read, and the guess is made.
    if (up && (deliberate || looksAbbrev(w))) return w;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }

  /**
   * Write `value` in `shape`. Shouting and quieting are the whole string;
   * titling is per word, and it genuinely re-cases — a name the key stores as
   * "ZACHARY CODERRE" reads "Zachary Coderre" where the text is in ordinary
   * prose, which is the point of the whole exercise. What titling leaves alone
   * is what was deliberate: a word with internal capitals, any capital standing
   * in a value that is otherwise ordinary text, and — in a value that is
   * all-caps throughout, where there is nothing to read — an abbreviation.
   */
  function applyCase(shape, value) {
    const v = String(value == null ? "" : value);
    if (shape === "upper") return v.toUpperCase();
    if (shape === "lower") return v.toLowerCase();
    if (shape === "title") {
      const deliberate = v !== v.toUpperCase(); // it has lowercase of its own
      return v.replace(WORD_RE, (w) => titleWord(w, deliberate));
    }
    return v;
  }

  /**
   * The replacement in the matched text's own voice.
   *
   * THE TEXT'S CASE WINS. The key's own spelling of the real value is how it
   * was typed into a spreadsheet, not how it should read here: a caption's
   * "ZACHARY CODERRE" belongs in a sentence as "Zachary Coderre", and the
   * fake standing in ordinary prose is what says so. So the shape is read off
   * the matched text and written onto the replacement, every time.
   *
   * The one shape that yields no instruction is `mixed` — text with internal
   * capitals of its own — and there the value is left exactly as the key
   * stores it.
   */
  function mirrorCase(sample, value) {
    return applyCase(caseShape(sample), value);
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
      let mapped = compiled.map.get(fold(m));
      let suffix = "";
      if (mapped == null) {
        // A possessive of a bare value: swap the name, keep the 's as typed.
        const mp = m.match(POSS_MATCH_RE);
        if (mp) {
          mapped = compiled.map.get(fold(m.slice(0, -mp[0].length)));
          if (mapped != null) suffix = mp[0];
        }
      }
      if (mapped == null) return m;
      count++;
      // The possessive is left off the shape reading — "QUENBY'S" is shouted,
      // "Quenby's" is ordinary prose — and it is cased separately from the
      // name, so a shouted caption gets "CODERRE'S" and a sentence
      // "Coderre's" rather than "Coderre'S".
      const shape = caseShape(suffix ? m.slice(0, -suffix.length) : m);
      return applyCase(shape, mapped) + casedSuffix(shape, suffix);
    });
    return { text: out, count: count };
  }

  // The 's follows the sentence around it, not the name: shouted with a
  // shout, quiet with a quiet line, and otherwise exactly as it was typed.
  function casedSuffix(shape, suffix) {
    if (!suffix) return "";
    if (shape === "upper") return suffix.toUpperCase();
    if (shape === "lower") return suffix.toLowerCase();
    return suffix;
  }

  // Ordinary English that a key row can end up binding (a harvested token, a
  // one-word business short form) but that a person types in NORMAL USE —
  // "as", "and", "was", "is". Flagging those makes the warning cry wolf, and
  // rewriting them in the cleaner would wreck the sentence, so a real value
  // that IS one of these words, standing alone, is left out of both. The
  // multi-word forms stay: "Cross River Bank" is a party even though every
  // word in it is ordinary.
  const COMMON_WORDS = new Set(
    (
      "a an the and or but nor so if then than as at by for from in into of on onto to with " +
      "without under over is are was were be been being am do does did done has have had " +
      "having will would can could shall should may might must not no yes it its he she they " +
      "them his her their this that these those there here who whom whose which what when " +
      "where why how all any each every some most more less few both other another same such " +
      "only also very just about above below between during before after again further once " +
      "per via etc et al mr mrs ms dr jr sr no. vs v"
    ).split(/\s+/)
  );

  // A real value the warning and the cleaner both leave alone: a single
  // ordinary word (or a bare letter). Applied at COMPILE time, not parse
  // time, so a key already stored benefits without being reloaded.
  function isCommonReal(value) {
    const f = fold(value);
    return f.length < 2 || (COMMON_WORDS.has(f) && f.indexOf(" ") === -1);
  }

  /** Warning matcher over the REAL values — common English left out. */
  function compileReals(key) {
    const warn = ((key && key.warn) || []).filter((w) => !isCommonReal(w.real));
    const map = new Map();
    for (const w of warn) if (!map.has(fold(w.real))) map.set(fold(w.real), w);
    const rx = buildMatcher(warn.map((w) => w.real));
    return { rx: rx, map: map };
  }

  /**
   * FORWARD matcher: real → fake, the ReAnonymize direction, for the badge's
   * cleaner box. Built from the same rows the warning watches (alt spellings
   * included — real→fake is exactly what they are for; keeps and common
   * words excluded), longest real first so a full name wins over its own
   * tokens. translate() runs it — same engine, opposite direction.
   */
  function compileForward(key) {
    const warn = ((key && key.warn) || []).filter((w) => !isCommonReal(w.real));
    const map = new Map();
    for (const w of warn) if (!map.has(fold(w.real))) map.set(fold(w.real), w.fake);
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
      let w = compiledReals.map.get(fold(m[0]));
      if (!w) {
        const mp = m[0].match(POSS_MATCH_RE);
        if (mp) w = compiledReals.map.get(fold(m[0].slice(0, -mp[0].length)));
      }
      if (w && !seen.has(fold(w.real))) {
        seen.add(fold(w.real));
        out.push(w);
      }
      if (m.index === compiledReals.rx.lastIndex) compiledReals.rx.lastIndex++;
    }
    return out;
  }

  /**
   * Typeahead entries for the as-you-type prompt: the warning's own rows
   * (common English out), longest real first so "Helen Rasho" is offered
   * whole before its surname token, each carrying a regex that matches only
   * at the very END of the text — the word the caret just finished.
   */
  function compileTypeahead(key) {
    const warn = ((key && key.warn) || []).filter((w) => !isCommonReal(w.real));
    return warn
      .slice()
      .sort((a, b) => b.real.length - a.real.length)
      .map((w) => ({
        real: w.real,
        fake: w.fake,
        rx: new RegExp(
          "(?<![A-Za-z0-9_])" +
            escapeRe(w.real).replace(/ /g, "\\s+") +
            (POSS_TAIL_RE.test(w.real) ? "" : "(?:['’][sS])?") +
            "$",
          "i"
        ),
      }));
  }

  /**
   * The real value `textBefore` ENDS with — the name just typed out, caret
   * hard against its last character — or null. `matched` is the text as the
   * user actually typed it, which is what the swap must remove and what the
   * fake's casing mirrors. Each test runs against only the tail, so a long
   * draft costs the same as a short one per keystroke.
   */
  function endingReal(ahead, textBefore) {
    const t = String(textBefore || "");
    if (!t) return null;
    for (const e of ahead || []) {
      const tail = t.slice(-(e.real.length * 2 + 8));
      const m = e.rx.exec(tail);
      if (m) {
        // "Zachary's" typed against a bare "Zachary" row offers "John's" —
        // the possessive rides the swap rather than being lost by it.
        let fake = e.fake;
        const mp = m[0].match(POSS_MATCH_RE);
        if (mp && !POSS_TAIL_RE.test(e.real)) fake = e.fake + mp[0];
        return { real: e.real, fake: fake, matched: m[0] };
      }
    }
    return null;
  }

  // A draft that opens with this header is the operator pasting pincites out
  // of Lexis — published citations, so the party-name collisions with the
  // key's reals are authorities, not leaks (the same reason the scrubber
  // never touches a citation). The whole draft's warning stands down; the
  // header is the operator's own declaration, exactly like a keep. Tolerant
  // of the dash and spacing a copy-paste mangles, not of different words.
  const PINCITE_RE = /^\s*PINCITE\s+CHECK\s*[—–-]+\s*OFFICIAL\s+REPORTER\s+PAGE\s+BREAKS/i;

  function isPincitePaste(text) {
    return PINCITE_RE.test(String(text || ""));
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

  // ---- a run in flight holds the translation ---------------------------------
  //
  // A workflow run drives a conversation by machine: it sends, waits for the
  // answer, takes the reply and pastes it into the NEXT chat. It takes that
  // reply from claude.ai's own copy control where it can — but its fallback is
  // the RENDERED message (src/workflow-run.js, harvestReply, via "dom"), and the
  // rendered message is precisely what the display translation rewrites. Real
  // names would ride the hand-off into the next chat, which is the one thing
  // the pseudonymization exists to prevent.
  //
  // So while a run is MOVING, the conversations it can reach show the fakes,
  // exactly as claude.ai wrote them. Two arms, because a run reaches further
  // than the URLs it has written down so far:
  //
  //   - "chat": a conversation the run names among its own.
  //   - "key":  any conversation on the run's KEY. A run is a MATTER and a
  //             matter has one key, so this covers the chat the run opened a
  //             beat ago and hasn't recorded yet — the window where the first
  //             arm is still blind.
  //
  // MOVING is the whole test, and the hold is DERIVED rather than stored: it is
  // only ever a reading of the run's own status, so a run that pauses, is held
  // out for an outage, fails, is canceled or finishes brings the real names
  // back by itself. Nothing has to remember to switch anything on again — the
  // state that could be left behind doesn't exist.
  //
  // And a hold can never outlive the automation that asked for it. A run still
  // claiming "running" whose driver has gone quiet — tab closed, worker died
  // mid-step — is a failure, and a failure turns the translation back on: past
  // the ceiling, a silent run holds nothing. The run's heartbeat is the signal
  // (workflow.js writes it every 20 seconds from the page that holds the step),
  // with lastProgressAt beside it, and the ceiling is deliberately looser than
  // the watchdog's own STALE_MS so a worker handover doesn't flicker the badge.
  const HOLD_STALE_MS = 5 * 60 * 1000;

  function runNamesConv(run, conv) {
    if (!conv) return false;
    const chats = (run && run.chats) || {};
    for (const id of Object.keys(chats)) {
      const url = chats[id] && chats[id].url;
      if (url && conversationKeyFromUrl(url) === conv) return true;
    }
    return false;
  }

  // runs: every run in the store. opts: { conv, keyId, now, beats, staleMs,
  // keyIdFor }. `keyIdFor` resolves a run's key the way the rest of the feature
  // does — a run with none of its own answers to its GROUP's (W.runPseudoKey) —
  // and defaults to the run's own id so the decision is testable on its own.
  function runTranslationHold(runs, opts) {
    const o = opts || {};
    const now = typeof o.now === "number" ? o.now : Date.now();
    const staleMs = typeof o.staleMs === "number" ? o.staleMs : HOLD_STALE_MS;
    const beats = o.beats || {};
    const keyIdFor =
      typeof o.keyIdFor === "function" ? o.keyIdFor : (r) => (r && r.pseudoKeyId) || null;
    for (const run of runs || []) {
      // Every other status is a run that is not going to paste anything: draft,
      // queued, held, paused, failed, canceled, done.
      if (!run || run.status !== "running") continue;
      const beat = typeof beats[run.id] === "number" ? beats[run.id] : 0;
      const at = Math.max(
        typeof run.lastProgressAt === "number" ? run.lastProgressAt : 0,
        beat
      );
      if (!(at > 0) || now - at > staleMs) continue; // nothing alive is driving it
      const via = runNamesConv(run, o.conv)
        ? "chat"
        : o.keyId && keyIdFor(run) === o.keyId
        ? "key"
        : null;
      if (via) return { runId: run.id, name: String(run.name || "").trim(), via: via };
    }
    return null;
  }

  const api = {
    isKeyFileName,
    sheetsLookLikeKey,
    headerIndex,
    isKeepCell,
    parseKey,
    keySignature,
    sameCaseKey,
    libraryIdFor,
    compile,
    translate,
    compileReals,
    compileForward,
    isCommonReal,
    findReals,
    compileTypeahead,
    endingReal,
    mirrorCase,
    caseShape,
    applyCase,
    isPincitePaste,
    buildMatcher,
    conversationKeyFromUrl,
    runTranslationHold,
    HOLD_STALE_MS,
    fold,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPseudo = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
