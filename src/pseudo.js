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
 *                 canonical row), a fake claimed by two canonical reals is
 *                 ambiguous — retired from reversal rather than guessed at —
 *                 and the bindings come off the APPLIED sheet, never the
 *                 "Pinned (never in text)" tab, which the macro refuses to read
 *                 for a reason that bit here too (see appliedSheet).
 *   - compile / translate:  fake → real for DISPLAY. Longest fake first so a
 *                 bare surname token never rewrites part of a longer full
 *                 name; whole words only; case-insensitive with an ALL-CAPS
 *                 match mirrored, since a caption shouts its parties.
 *   - compileReals / findReals:  which REAL values stand in a draft message —
 *                 the "you're about to type a real name" warning.
 *   - isKeyFileName / sheetsLookLikeKey:  is this file the key itself — the
 *                 one file that must never ride an upload into a chat.
 *   - runTranslationHold:  whether a workflow run is MOVING through this chat
 *                 (or this chat's matter), in which case the MESSAGES stand
 *                 down and show the fakes — a run's hand-off can fall back to
 *                 the rendered message, and the rendered message is what the
 *                 display rewrites. The chat TITLES are not held: nothing a
 *                 run does reads one off the screen. Derived from the run's
 *                 own status, so a pause, a hold, a failure or a dead driver
 *                 puts the real names straight back.
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

  // ---- which sheet the bindings live on -------------------------------------
  //
  // PDF-Linker writes TWO tabs, and only one of them is reversible:
  //
  //   "Pseudonym Key"           the bindings that were APPLIED to the exports.
  //                             These are the fakes a draft written from those
  //                             exports actually carries.
  //   "Pinned (never in text)"  bindings no export ever carried — a party
  //                             pinned so a later run reuses the same fake.
  //
  // DeAnonymize.bas reads the first by name and NEVER reads the second, and its
  // own comment says why in terms that apply here word for word: "a pinned row
  // can bind a real value the applied sheet also binds, under a different fake.
  // Loaded together, two rows then claim one pseudonym and the ambiguity guard
  // retires BOTH — so reading the pinned tab does not merely add dead rows, it
  // can retire live ones and leave a real name unrestored."
  //
  // This module read every header-bearing sheet, pinned tab included, and put
  // its rows in the reversal map beside the applied ones — the failure the
  // macro's comment describes. Two shapes, and they are worth telling apart:
  //
  //   A PINNED ROW ON AN APPLIED FAKE (different reals) retires both, exactly
  //   as the macro says, and the applied party then reverses NOWHERE: a chat
  //   title carrying it read back in the fake with nothing on the page able to
  //   say why. This is the break.
  //
  //   A PINNED ROW ON THE SAME REAL under its own fake retires nothing — the
  //   grouping is by fake, so the two sit in different groups and both used to
  //   survive into `pairs`. What it did instead was quieter: the forward map is
  //   first-seen per real, so with the pinned tab first in workbook order a
  //   chat title went out wearing a fake that appears in NO export. It read
  //   back, but it named the case by something Claude had never been shown, and
  //   it put a binding that was never applied into the master key.
  //
  // So the tabs are told apart here, the macro's way. Pinned rows still ride
  // along for the WARNING — a pinned party's real name typed into a chat is a
  // leak like any other — and they take no part in the reversal (`pairs`), in
  // the ambiguity grouping, or in naming the case (`hint`).
  const KEY_SHEET_NAME = "pseudonym key";
  const PINNED_SHEET_NAME = "pinned (never in text)";

  // Which READER made a stored key. A parsed key outlives the code that parsed
  // it — the library holds `pairs` and `warn`, not the workbook — so a fix to
  // the rules above heals nothing already loaded, and the operator's live cases
  // are exactly the ones that matter. The loaders keep each key's workbook
  // beside the library (src/keyfile.js), so the worker can re-read them; this
  // is what tells it which ones are behind. Bump it whenever a change here
  // would parse the same workbook differently.
  //
  //   2  the pinned tab is out of the reversal, and a fake claimed by one
  //      name's own casing pair is no longer retired as ambiguous.
  //   3  the applied rows come off ONE sheet, the macro's own FindKeySheet
  //      rule — not off every tab that isn't named exactly "Pinned (never in
  //      text)", which let a differently named second tab retire live rows.
  const PARSE_VERSION = 3;

  /** Was this stored key built by an older reader than the one running now? */
  function keyNeedsReparse(key) {
    return !key || key.parsed !== PARSE_VERSION;
  }

  /**
   * What to say about keys the worker could not re-read (background.js,
   * reparseKeys) — "" when there are none.
   *
   * A key still on an older reader still translates; it just translates by the
   * rules that were wrong, and the case it belongs to is one whose chats may
   * be sitting there in the fakes. That is precisely the silent half-working
   * this feature cannot afford, so it is said, by name, with the one thing
   * that fixes it.
   *
   * Read off the LIBRARY rather than off a list the worker keeps: a key still
   * carrying an older `parsed` IS the stale one, so there is no second store to
   * fall out of step with what the worker managed to heal.
   */
  function staleNote(keys) {
    const lib = keys || {};
    const names = Object.keys(lib)
      .filter((id) => lib[id] && keyNeedsReparse(lib[id]))
      .map((id) => keyTitle(lib[id]));
    if (!names.length) return "";
    return (
      (names.length === 1 ? "One case's key was" : names.length + " cases' keys were") +
      " loaded by an older reader and the spreadsheet is no longer kept here, so " +
      (names.length === 1 ? "it could" : "they could") +
      " not be re-read: " +
      names.join(", ") +
      ". Load the pseudonym_key.xlsx again — until then " +
      (names.length === 1 ? "that case" : "those cases") +
      " may read back in the fakes."
    );
  }

  // ---- attached, and matching nothing ---------------------------------------
  //
  // The key button lights for an ATTACHMENT as well as for a swap, deliberately:
  // the key is a fact about the chat rather than about what happens to be
  // rendered in it. But that makes two very different pages look the same — a
  // chat where the key is working and a chat where the key is attached and
  // matches NOTHING — and the second one is a translation that silently is not
  // happening, which is the failure this whole feature exists to not have.
  //
  // It has a small number of causes, and they are worth saying rather than
  // leaving to be worked out:
  //
  //   NOTHING TO MATCH YET. A chat whose turns carry no party name and whose
  //   title claude.ai has not written yet. Ordinary, and not a fault.
  //   NO REVERSIBLE ROWS. The key parsed, its warning side works and its
  //   cleaner works, but every binding was dropped from the reversal. Then the
  //   forward direction mints a fake nothing can put back.
  //   THE WRONG KEY. It is attached, it compiled, and its pseudonyms belong to
  //   another matter. Nothing will ever match, and the sample below is what
  //   makes that visible in one glance — a fake is what claude.ai already
  //   holds, so showing a few of them reveals nothing a chat doesn't.
  //
  // `st`: { attached, names, titles, pairs, sample, master }.
  function matchNothingNote(st) {
    const s = st || {};
    if (!s.attached) return "";
    if ((s.names || 0) > 0 || (s.titles || 0) > 0) return "";
    const off = trim(s.sheet) ? ' (read off the "' + trim(s.sheet) + '" sheet)' : "";
    if (!s.pairs)
      return (
        "This key has no reversible rows at all" +
        off +
        " — its warning side and its cleaner still work, but nothing it minted can be put " +
        "back. If that is not the tab your key's bindings are on, that is the fault: the " +
        'reversible rows are taken off the tab named "Pseudonym Key", else the first tab ' +
        "that is not the pinned one, which is the macro's own rule."
      );
    const sample = (s.sample || []).filter(Boolean);
    return (
      "Attached" + off + ", and nothing on this page matched it yet. " +
      (sample.length
        ? "This key's pseudonyms are " +
          sample.join(", ") +
          " — if this case's papers don't use those, the wrong key is attached and the key " +
          "picker above switches it. "
        : "") +
      "Otherwise there is simply nothing here carrying a name yet."
    );
  }

  /**
   * A few of this key's FAKE values, longest first — the ones a caption would
   * carry. Safe to show: a fake is what claude.ai already holds.
   */
  function sampleFakes(key, max) {
    const n = typeof max === "number" && max > 0 ? max : 3;
    return ((key && key.pairs) || [])
      .map((p) => trim(p && p.fake))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .slice(0, n);
  }

  function isPinnedSheet(sheet) {
    return fold(sheet && sheet.name) === PINNED_SHEET_NAME;
  }

  /**
   * The ONE sheet whose rows were APPLIED to the exports — the only sheet a
   * draft's fakes can have come from — or null.
   *
   * FindKeySheet's rule exactly, and "exactly" is the point: the tab titled
   * "Pseudonym Key" wherever it sits, else the FIRST header-bearing tab that is
   * not the pinned one, else nothing. Never the pinned tab, not even as the
   * last fallback.
   *
   * One sheet, not "every sheet that isn't the pinned one", which is where this
   * first landed. The difference only shows on a key whose applied tab is not
   * titled — an older PDF-Linker — and there it is the whole ballgame: taking
   * every non-pinned tab means a second tab whose name is not the exact string
   * below is read as applied, its rows collide with the real ones, and the
   * ambiguity guard retires both. The macro cannot have that bug, because it
   * stops at the first sheet it accepts. Neither can this now.
   */
  function appliedSheet(sheets) {
    const withHeader = (sheets || []).filter((s) => headerIndex((s && s.rows) || []) !== -1);
    for (const s of withHeader) if (fold(s && s.name) === KEY_SHEET_NAME) return s;
    for (const s of withHeader) if (!isPinnedSheet(s)) return s;
    return null;
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
   * Key workbook → the map. `sheets` is what CUMXlsx.parseXlsx returns. Every
   * sheet carrying the header fingerprint is read, and the APPLIED ones are
   * told from the pinned tab (appliedSheet, above): a pinned party's fake
   * can't appear in text written from these exports — so it is never reversed
   * and never collides with an applied row — but its REAL name is exactly what
   * the warning exists to catch, so the row still rides along for that.
   *
   * Returns { name, rows, pairs, warn, dropped }:
   *   pairs — [{fake, real}] for display reversal, unambiguous APPLIED owners
   *   warn  — [{real, fake, pinned}] real values that must not be typed, with
   *           the stand-in to suggest instead. A real bound on BOTH tabs keeps
   *           the APPLIED fake, whatever order the sheets came in: that is the
   *           one a reader can reverse.
   */
  function parseKey(sheets, name) {
    const entries = [];
    let keeps = 0;
    const applied = appliedSheet(sheets);
    for (const sheet of sheets || []) {
      const rows = (sheet && sheet.rows) || [];
      const hi = headerIndex(rows);
      if (hi === -1) continue;
      const pinned = sheet !== applied;
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
          pinned: pinned,
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
      derived.push({ real: baseReal, fake: baseFake, alt: e.alt, occ: 0, pinned: e.pinned });
    }
    for (const d of derived) entries.push(d);

    // Reversal: exactly one row may own each fake. Pinned rows are out of this
    // direction entirely (see appliedSheet) — their fakes are in no export, so
    // searching for one is at best wasted work and at worst retires the applied
    // row it collides with. Alt-spelling rows never own either. What is left is
    // the macro's own guard: two CANONICAL rows claiming one fake, and the
    // mapping is retired rather than restored to a coin flip.
    const byFake = new Map();
    for (const e of entries) {
      if (e.pinned) continue;
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
      // Ambiguous only when the REALS actually differ, which is the macro's
      // test (vbTextCompare) rather than a row count. Two rows on one fake are
      // usually the casing pair of a single name — "GARDELLA" from the caption
      // and "Gardella" from the body — and they restore identically, since the
      // swap recases from the matched text. Retiring those took the caption's
      // own parties out of the reversal, which is where a case folder's name
      // comes from and why a chat title kept its fakes.
      if (new Set(own.map((e) => fold(e.real))).size > 1) {
        ambiguous++;
        continue;
      }
      const e = own[0];
      if (fold(e.fake) === fold(e.real)) continue; // never map a value onto itself
      pairs.push({ fake: e.fake, real: e.real });
    }

    // The warning list: every real value the key binds, alt spellings and
    // pinned rows included — an OCR near-miss of a party's name is still that
    // party, and a party this batch never mentioned is still a name that must
    // not be typed into a chat.
    //
    // The FAKE beside it is the stand-in the cleaner offers and the chat title
    // is minted from, so a real bound on both tabs takes the APPLIED row's:
    // first-seen let workbook order decide, and where it landed on the pinned
    // tab the extension minted a title out of a fake nothing could reverse.
    const warn = [];
    const seenReal = new Map();
    for (const e of entries) {
      const k = fold(e.real);
      const at = seenReal.get(k);
      if (at === undefined) {
        seenReal.set(k, warn.length);
        warn.push({ real: e.real, fake: e.fake, pinned: !!e.pinned });
        continue;
      }
      if (warn[at].pinned && !e.pinned) {
        warn[at].fake = e.fake;
        warn[at].pinned = false;
      }
    }

    // Which CASE this key belongs to, said in one value: the real name the
    // exports used most. Every key is named pseudonym_key.xlsx, so the
    // filename can't tell two cases apart in a list — the lead party can.
    // Off the APPLIED rows only: a pinned party is one these filings never
    // mentioned, so naming the case after it would name it after the party it
    // is least about.
    let hint = "";
    let hintOcc = -1;
    for (const e of entries) {
      if (!e.pinned && !e.alt && !isCommonReal(e.real) && e.occ > hintOcc) {
        hint = e.real;
        hintOcc = e.occ;
      }
    }

    return {
      name: name || "",
      parsed: PARSE_VERSION,
      // WHICH TAB the reversible rows came off, so the panel can say it. Every
      // case's key file is called pseudonym_key.xlsx and every one of them has
      // more than one tab in it; "which sheet did you read" was the question
      // this feature could not answer about itself for three rounds of hunting.
      sheet: (applied && trim(applied.name)) || "",
      rows: entries.length,
      pairs: pairs,
      warn: warn,
      hint: hint,
      dropped: {
        keeps: keeps,
        ambiguous: ambiguous,
        pinned: entries.filter((e) => e.pinned).length,
      },
    };
  }

  // ---- what a key is CALLED -------------------------------------------------
  //
  // Every case's key file is named pseudonym_key.xlsx, so the filename can
  // never be the label: a picker listing it three times says nothing. Two
  // better answers, in order.
  //
  //   folder  the CASE FOLDER it was picked from — "23STCV12345 Smith v.
  //           Jones". This is the matter's own name, in the operator's own
  //           filing, and it is what the run is named after too (the case
  //           folder split sets both), so the key in the picker reads as the
  //           same thing as the run in the list. Set only where it is known.
  //   hint    the real value the case's exports used most, which is what tells
  //           two keys apart when nothing named the folder.
  //
  // All of it is local UI — a picker, a badge, a tab group — and none of it is
  // ever sent. The badge already shows the real names on the page it labels.
  function trim(s) {
    return String(s == null ? "" : s).trim();
  }

  function keyTitle(key) {
    const k = key || {};
    const folder = trim(k.folder);
    if (folder) return folder;
    const hint = trim(k.hint);
    const name = trim(k.name);
    if (hint && name) return hint + " — " + name;
    return hint || name || "pseudonym key";
  }

  /**
   * Whether the key button and the fakes toggle have anything to be about on
   * this page — the rule both of them are lit by, in one place because they
   * are one claim: THIS PAGE IS NOT SAYING WHAT CLAUDE.AI SAYS.
   *
   * Two things can make that true, and nothing else may:
   *
   *   AN ATTACHMENT. This conversation has a key. It is lit even with nothing
   *   matched yet, because the key is a fact about the chat rather than about
   *   what happens to be rendered in it.
   *
   *   REAL NAMES ON SCREEN. A name, a title, anything actually swapped.
   *
   * What may NOT light it is a key merely being AVAILABLE. The master key
   * stands by on every page in the browser; a blank composer that has no
   * conversation to attach a key to was lighting both buttons and naming a
   * case, while the panel one click away said "this page is not a
   * conversation". Both were true and together they were a contradiction, and
   * the button is the half people read.
   *
   * A peek or a run's hold keeps it in play with nothing on screen: both are
   * states you get OUT of with that button, and a switch that vanishes while
   * the thing it switches is still on is worse than one that stays.
   */
  function keyInPlay(st) {
    const s = st || {};
    if (s.attached) return true;
    if ((s.names || 0) > 0 || (s.titles || 0) > 0) return true;
    return !!s.paused || !!s.held;
  }

  // The same, with the size that tells a full key from a half-loaded one.
  function keyLabel(key) {
    const k = key || {};
    const rows = typeof k.rows === "number" ? k.rows : 0;
    return keyTitle(k) + " · " + rows + " row" + (rows === 1 ? "" : "s");
  }

  // Storing a key over the entry it refreshes. The ROWS are the new file's —
  // a key only ever grows — but what the FILE cannot know stays with the
  // entry: a key re-loaded from the popup a week later must not lose the case
  // folder that named it, and the same key picked from a different folder
  // takes the new one.
  function keepKeyFacts(prev, next) {
    if (!next) return next;
    const folder = trim(next.folder) || (prev && trim(prev.folder)) || "";
    if (!folder) return next;
    return Object.assign({}, next, { folder: folder });
  }

  // ---- which keys a picker offers ------------------------------------------
  //
  // The library never evicts: every case's key you have ever loaded is still in
  // it, and after a year of matters a dropdown of them is a list you scroll
  // rather than a list you choose from. A picker offers the last few, and the
  // rest are one file-pick away from being the last few again.
  //
  // Reading an old case back does not need this at all — that is what the
  // master key is for (src/masterkey.js keeps every case in title form).
  // This is only about ATTACHING, which is a thing you do to the matter
  // in front of you.
  const RECENT_KEYS = 3;

  function savedAtOf(key) {
    const t = key && key.savedAt;
    return typeof t === "number" && isFinite(t) ? t : 0;
  }

  /**
   * The ids a picker should offer, newest first.
   *
   * `opts.keep` is the id already chosen — the key attached to this chat, or
   * the one on this run. It is ALWAYS offered, whatever its age: a select that
   * cannot represent its own current value does not merely look wrong, it
   * silently resets to something else the moment anything reads it back (the
   * run editor already had to guard against exactly that: "the stored key is
   * gone; don't pretend"). Where it is not among the recent ones it takes the
   * place of the oldest that is, so the list stays the length it promises.
   *
   * `opts.max` overrides RECENT_KEYS. Keys with no savedAt — stored before the
   * loaders wrote one — sort last, and are ordered by name among themselves so
   * the list does not shuffle between renders.
   */
  function recentKeys(keys, opts) {
    const lib = keys || {};
    const o = opts || {};
    const max = typeof o.max === "number" && o.max > 0 ? Math.floor(o.max) : RECENT_KEYS;
    const ids = Object.keys(lib).filter((id) => lib[id]);
    ids.sort(
      (a, b) =>
        savedAtOf(lib[b]) - savedAtOf(lib[a]) ||
        fold(keyTitle(lib[a])).localeCompare(fold(keyTitle(lib[b])))
    );
    const out = ids.slice(0, max);
    const keep = trim(o.keep);
    if (keep && lib[keep] && out.indexOf(keep) === -1) {
      if (out.length >= max) out[out.length - 1] = keep;
      else out.push(keep);
    }
    return out;
  }

  /** How many the picker is not showing — said out loud, never just dropped. */
  function hiddenKeyCount(keys, shown) {
    const all = Object.keys(keys || {}).length;
    const n = (shown || []).length;
    return Math.max(0, all - n);
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
   * cleaner box and for the chat titles a run and the Folder button mint
   * (nameCleaner). Built from the same rows the warning watches (alt spellings
   * included — real→fake is exactly what they are for; keeps and common
   * words excluded), longest real first so a full name wins over its own
   * tokens. translate() runs it — same engine, opposite direction.
   *
   * What it emits has to be something compile() can put back, or a title goes
   * out in a fake that reads back as a fake forever. parseKey holds that end
   * up: where the applied sheet and the pinned tab both bind a real, the warn
   * row carries the APPLIED fake — the one in `pairs`. A real the pinned tab
   * alone binds still swaps, because its reserved fake beats its real name in
   * a title even though nothing will reverse it.
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

  // ---- a copy that carries the real names ------------------------------------
  //
  // The display translation's boundary was always "what LEAVES the page reads
  // claude.ai's own state, which still holds the fakes" — with one declared
  // exception: text you select and copy by hand out of the translated view
  // carries what you are looking at.
  //
  // That exception has quietly grown. Copy ruling copies the RENDERED message
  // now (src/copy-ruling.js — the markdown route lost on three separate
  // counts), so the extension's own button takes the real names too, and so
  // does every ⌘C, every right-click Copy, every drag of a paragraph out of an
  // answer. Which is usually exactly right: a tentative ruling is pasted into
  // a minute order, and a minute order says the parties' real names.
  //
  // It is catastrophic in one direction only — back into a chat — and the
  // difference between the two is invisible on the clipboard. So a copy that
  // carries real values says so, once, naming them. Warn, never rewrite: the
  // clipboard is the user's, exactly as the composer is.
  const COPY_WARN_MAX = 4;

  /**
   * What to say about a copy that carried real values, or null where there is
   * nothing to say. `hits` are findReals rows; `opts.caseName` is what the key
   * is called, where the caller knows.
   */
  function copyWarning(hits, opts) {
    const seen = new Set();
    const list = [];
    for (const h of hits || []) {
      const real = trim(h && h.real);
      if (!real || seen.has(fold(real))) continue;
      seen.add(fold(real));
      list.push({ real: real, fake: trim(h && h.fake) });
    }
    if (!list.length) return null;
    const name = trim((opts || {}).caseName);
    return {
      head: "⚠ That copy carries the REAL names",
      names: list.slice(0, COPY_WARN_MAX),
      more: Math.max(0, list.length - COPY_WARN_MAX),
      body:
        "The clipboard holds what this tab was showing you" +
        (name ? " for " + name : "") +
        " — the real values, not the pseudonyms claude.ai holds. That is what a " +
        "minute order wants. It is not what a chat can ever be given: do not " +
        "paste this back into Claude.",
    };
  }

  /**
   * Typeahead entries for the as-you-type prompt: the warning's own rows
   * (common English out), longest real first so "Helen Rasho" is offered
   * whole before its surname token, each carrying a regex that matches only
   * at the very END of the text — the word the caret just finished.
   *
   * `partial` marks a real that OPENS a longer real in the same key —
   * "Helen" when the key also binds "Helen Rasho", "Cross River Bank" beside
   * "Cross River Bank, LLC". The space bar cannot tell "Helen" the whole name
   * from "Helen" the first half of one, so it never swaps a partial: the arrow
   * still does, and the space simply types on toward the longer phrase, which
   * is offered whole (and swapped by space) the moment it is finished.
   */
  function compileTypeahead(key) {
    const warn = ((key && key.warn) || []).filter((w) => !isCommonReal(w.real));
    const folded = warn.map((w) => fold(w.real));
    return warn
      .slice()
      .sort((a, b) => b.real.length - a.real.length)
      .map((w) => ({
        real: w.real,
        fake: w.fake,
        partial: isOpeningOfLonger(fold(w.real), folded),
        rx: new RegExp(
          "(?<![A-Za-z0-9_])" +
            escapeRe(w.real).replace(/ /g, "\\s+") +
            (POSS_TAIL_RE.test(w.real) ? "" : "(?:['’][sS])?") +
            "$",
          "i"
        ),
      }));
  }

  // Whether `f` (folded) begins some LONGER folded real in `all` at a word
  // edge: "helen" opens "helen rasho"; it does not open "helena rasho".
  function isOpeningOfLonger(f, all) {
    if (!f) return false;
    for (const other of all) {
      if (other.length <= f.length || other.slice(0, f.length) !== f) continue;
      if (!/[a-z0-9_]/i.test(other.charAt(f.length))) return true;
    }
    return false;
  }

  /**
   * The real value `textBefore` ENDS with — the name just typed out, caret
   * hard against its last character — or null. `matched` is the text as the
   * user actually typed it, which is what the swap must remove and what the
   * fake's casing mirrors. `partial` says the name may be the opening of a
   * longer one in the key (see compileTypeahead). Each test runs against only
   * the tail, so a long draft costs the same as a short one per keystroke.
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
        return { real: e.real, fake: fake, matched: m[0], partial: !!e.partial };
      }
    }
    return null;
  }

  /**
   * Whether the space bar, pressed with `hit` under the caret, swaps the
   * name — yes for a whole name, no for one that may be the opening of a
   * longer real in the key. The arrow swaps either; this decides only what
   * the autocorrect is allowed to do on its own.
   */
  function swapsOnSpace(hit) {
    return !!hit && !hit.partial;
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

  /**
   * The conversation this URL IS — or "" where the address is not a
   * conversation at all.
   *
   * conversationKeyFromUrl above answers for ANY url, falling back to the
   * pathname, and it is right to: it is an IDENTITY, and two things looking at
   * the same page have to agree on what to call it.
   *
   * That is the wrong question for ATTACHING a key to. "/new" is a perfectly
   * good identity and a terrible conversation — a key attached to it is a key
   * attached to every new page you ever open, which is how the last matter's
   * names came to be sitting over the next one's blank composer. So does
   * "/cowork", "/recents", "/projects". The popup had already met two of them
   * and blocked those two by name, which is the shape of a rule nobody had
   * written down yet.
   *
   * So this asks the ADDRESS rather than the key: /chat/<uuid> and
   * /cowork/cse_<id>, and nothing else. A PROJECT page is refused too, though
   * its address carries a uuid that makes it look exactly like a chat's — the
   * path is what tells them apart, and only this function can see it.
   *
   * The spelling it answers in is conversationKeyFromUrl's, so what it hands
   * back is a key into the same maps.
   */
  function conversationFromUrl(url) {
    const s = String(url || "");
    let path = s;
    try {
      path = new URL(s).pathname;
    } catch (e) {
      /* not absolute — what we were given is the path */
    }
    path = path.replace(/\/+$/, "") || "/";
    if (/^\/chat\/[0-9a-f-]{36}/i.test(path) || /^\/cowork\/cse_[A-Za-z0-9_-]+/.test(path))
      return conversationKeyFromUrl(s);
    return "";
  }

  /**
   * Whether a STORED conversation key is one at all — for sweeping a map that
   * already holds entries this rule would never have written.
   *
   * Weaker than conversationFromUrl on purpose, because a key is not an
   * address: a bare uuid could be a chat's or a project page's and there is
   * nothing left in it to tell them apart, so it is kept. What it does catch
   * is every entry that is plainly a PAGE — "/new", "/recents", "/projects" —
   * which is the whole of the damage.
   */
  function isConversationKey(conv) {
    const s = trim(conv);
    if (!s) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
    return /(^|\/)cse_[A-Za-z0-9_-]+$/.test(s);
  }

  // ---- case numbers: the one value that must never go out unswapped --------
  //
  // A party's name in a chat title is a leak; a CASE NUMBER is the whole case.
  // It is unique, public, and searchable — one number turns a pseudonymized
  // draft back into the matter it came from, whatever the names were changed
  // to. So a run whose name carries one does not go out at all unless its
  // pseudonym key replaces that number (see the gate below).
  //
  // Modern LASC numbers are one shape: two digits of filing year, a two-
  // character court location code, a two-letter case type code and a five-digit
  // sequential number — 23STCV12345, 22SMCV01234, 24STLC00987. The pattern
  // takes the two letter groups together, since the parts are only meaningful
  // to a person: what matters here is that the whole token is a case number.
  //
  // The pre-2018 numbers the court still carries are two letters and six digits
  // — BC123456, EC098765 — and those are as real as the modern ones, so they
  // count too. Both are anchored on word boundaries and both are long and
  // shaped unlike anything a matter name is otherwise made of, which is what
  // keeps a gate this strict from firing on ordinary text.
  const CASE_NO_RES = [
    /\b\d{2}[A-Za-z]{4}\d{5}\b/g, // 23STCV12345
    /\b[A-Za-z]{2}\d{6}\b/g, // BC123456 (pre-2018)
  ];

  // Every case number in the text, in the order they appear, one entry per
  // number however many times it is written.
  function caseNumbers(text) {
    const s = String(text == null ? "" : text);
    const found = [];
    const seen = new Set();
    for (const re of CASE_NO_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        const k = fold(m[0]);
        if (seen.has(k)) continue;
        seen.add(k);
        found.push({ at: m.index, text: m[0] });
      }
    }
    return found.sort((a, b) => a.at - b.at).map((f) => f.text);
  }

  // Which of the case numbers in these strings the key would NOT swap. The test
  // is the swap itself rather than a lookup in the rows: a key row reading
  // "Case No. 23STCV12345" doesn't replace the bare number, and the title
  // cleaner wouldn't replace it either — so "does the cleaner change it" is the
  // only question worth asking, and it is the same question the title asks.
  function uncoveredCaseNumbers(key, texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    const fwd = key ? compileForward(key) : null;
    const out = [];
    const seen = new Set();
    for (const t of list) {
      for (const n of caseNumbers(t)) {
        const k = fold(n);
        if (seen.has(k)) continue;
        seen.add(k);
        const swapped = fwd && fwd.rx ? translate(fwd, n).text : n;
        if (fold(swapped) === k) out.push(n);
      }
    }
    return out;
  }

  function listNumbers(nums) {
    return nums.length === 1 ? nums[0] : nums.slice(0, -1).join(", ") + " and " + nums[nums.length - 1];
  }

  // May this run go out? `names` are the strings it can write into a chat title
  // (W.titleNames), `key` is the matter's parsed key and `looked` says the key
  // library answered at all.
  //
  // A name with no case number in it passes — this gate is about one value, not
  // about names in general, which the title cleaner handles. A name WITH one
  // passes only when the key actually replaces it. Everything else stops the
  // run, including "couldn't tell": a key library that wouldn't read is not a
  // key that carries the number.
  //
  // It is a refusal, not a hold — it never sits waiting for a condition to
  // change, and `why` carries both remedies (load a key that carries the
  // number, or take it out of the name), so the run says what to do rather than
  // parking silently.
  function caseNumberGate(state) {
    const s = state || {};
    const names = (s.names || []).filter(Boolean);
    const all = [];
    for (const n of names) for (const c of caseNumbers(n)) if (all.indexOf(c) === -1) all.push(c);
    if (!all.length) return { ok: true, numbers: [], why: "" };
    if (!s.looked)
      return {
        ok: false,
        numbers: all,
        why:
          "this run's name carries the case number " + listNumbers(all) +
          " and the pseudonym key library would not read, so nothing can say the number " +
          "would be replaced — a run whose name carries a real case number does not go out",
      };
    const missing = uncoveredCaseNumbers(s.key, names);
    if (!missing.length) return { ok: true, numbers: all, why: "" };
    return {
      ok: false,
      numbers: missing,
      why:
        "this run's name carries the case number " + listNumbers(missing) +
        ", and " +
        (s.key
          ? "this matter's pseudonym key does not replace it"
          : "no pseudonym key is attached to this matter") +
        " — a run whose name carries a real case number does not go out. Load a key that " +
        "carries that number, or take it out of the run's name.",
    };
  }

  // ---- names that LEAVE this browser ----------------------------------------
  //
  // A chat's title is not display: claude.ai stores it, shows it in the sidebar
  // and syncs it everywhere that account is signed in. So a run named for the
  // matter — which is how a run IS named, "8.11.26 Rasho MSJ" — would write the
  // real case name into Claude the moment it titled its first conversation,
  // with every paper that reached the chat carrying nothing but fakes. The
  // title is the leak the pseudonymization can't see.
  //
  // This is the cleaner's own direction (real → fake), compiled once for a
  // caller that has several strings to clean, and the identity function where
  // there is no key — a matter with no key attached is a matter with no fakes
  // to use, and inventing one would be worse than the real name.
  //
  // What it can promise is exactly what the cleaner promises: every value THE
  // KEY KNOWS is swapped. A name the key has never heard of passes through, so
  // the guarantee is only ever as complete as the key is.
  // Whether a chat's title can go out at all, and under what name. The caller
  // does the storage reading and hands over what it found: `looked` (the key
  // library answered at all), `keyId` (the key this matter names — its own or
  // its group's) and `key` (that key, actually in the library).
  //
  //   "plain"  no key on this matter: the run's name goes as typed. There are
  //            no fakes to use and nothing here to protect.
  //   "clean"  the key is here: real → fake, then send.
  //   "hold"   the matter HAS a key and the swap cannot be made. Then NO title
  //            goes — not the real name as a fallback — and `why` is what the
  //            run says out loud about the chat it left unnamed.
  //
  // The hold is the whole reason this is a decision rather than an `if`: every
  // path that can't produce a fake has to end in silence, and "couldn't tell"
  // is one of them. A library that wouldn't read is not a matter without a key.
  function titlePlan(state) {
    const s = state || {};
    if (!s.looked)
      return {
        mode: "hold",
        why: "the pseudonym key library would not read, so the run's name could not be checked against it",
      };
    if (!s.keyId) return { mode: "plain", why: "" };
    if (!s.key)
      return {
        mode: "hold",
        why: "this matter's pseudonym key is not in the key library any more, so the run's name could not be pseudonymized",
      };
    return { mode: "clean", why: "" };
  }

  function nameCleaner(key) {
    const fwd = key ? compileForward(key) : null;
    if (!fwd || !fwd.rx) return (s) => String(s == null ? "" : s);
    return (s) => translate(fwd, String(s == null ? "" : s)).text;
  }

  // ---- the title, coming back the other way ---------------------------------
  //
  // The title that LEFT is the fake, and it stays the fake: claude.ai stores
  // it, syncs it to every signed-in device and shows it in the sidebar, so
  // nothing here ever writes a real name back into it. But the person reading
  // that sidebar knows the case by its real name and its number, and a list of
  // "8.11.26 Strangeways MSJ" is a list they cannot navigate. So the title is
  // translated for DISPLAY exactly the way the messages are — the same map,
  // the same direction, in this tab only.
  //
  // A run moving through the chat does not stand this down the way it stands
  // the messages down (runTranslationHold, below): the hold is about what a
  // hand-off can pick up, and no hand-off has ever read a title.
  //
  // What is new is that one page shows MANY chats' titles at once and they are
  // not all this matter's. Each title is translated by ITS OWN chat's key
  // where that chat has one attached. Where it has none, by the one key in the
  // library that CLAIMS the title — and only where exactly one does, because a
  // wrong case name over a chat is worse than the fake it replaced.

  // claude.ai's own tail on the tab title — "8.11.26 Strangeways MSJ - Claude".
  // Only the NAME is translated; the tail is the site's own and stays as
  // written. The same shape content.js and save-chat.js strip to read the chat
  // name, so all three agree on where the name ends.
  const DOC_TITLE_TAIL_RE = /\s*[-–—|]\s*claude\b.*$/i;

  /** The tab title split into the chat's name and claude.ai's own tail. */
  function docTitleParts(title) {
    const s = String(title == null ? "" : title);
    const m = s.match(DOC_TITLE_TAIL_RE);
    return m ? { name: s.slice(0, m.index), tail: m[0] } : { name: s, tail: "" };
  }

  /** Every value a compiled matcher actually matched in `text`, in order. */
  function matchedValues(compiled, text) {
    const out = [];
    if (!compiled || !compiled.rx || !text) return out;
    compiled.rx.lastIndex = 0;
    let m;
    while ((m = compiled.rx.exec(text))) {
      out.push(m[0]);
      if (m[0] === "") compiled.rx.lastIndex++; // a zero-width match would spin
    }
    return out;
  }

  // Whether a fake standing in an UNATTACHED title is evidence the title is
  // that key's matter at all. A full name, a case number or a long invented
  // surname is; a short word that happened to be bound to a key row is not —
  // "Park" and "Alder" are pseudonyms in someone's key and also words another
  // case's chat can be called, and matching one of those by coincidence would
  // put the WRONG case's name over a chat, which is the one failure this path
  // has to avoid. Six letters is where a single word stops reading as ordinary
  // English; nothing rests on the exact number, since a miss costs a title
  // left in the fake and the attachment below always overrides it.
  //
  // Attached titles are never asked this question: the chat has been declared
  // that matter's, and its key translates whatever it translates.
  function isDistinctiveFake(value) {
    const f = fold(value);
    if (!f) return false;
    if (/\s/.test(f)) return true; // more than one word
    if (/[0-9]/.test(f)) return true; // a case number, or a fake carrying digits
    return f.length >= 6 && !COMMON_WORDS.has(f);
  }

  // The other way a title can be claimed: SEVERAL of one key's fakes standing
  // in it. "Park v. Bay hearing" is two short words that prove little apart
  // and a caption together — coincidence does not usually strike twice out of
  // the same key.
  function claimsTitle(matched) {
    if (matched.some(isDistinctiveFake)) return true;
    const distinct = new Set(matched.map(fold));
    return distinct.size >= 2;
  }

  // Which key in the library claims this title. `entries` are the compiled
  // reversal matchers, one per key ({ id, compiled }). Answers the swap that
  // key would make, or null where no key claims it — and null just the same
  // where TWO keys claim it with DIFFERENT answers, since a title that could
  // be either case is a title that gets neither and keeps the fake.
  function pickTitleKey(entries, text) {
    const src = String(text == null ? "" : text);
    if (!src.trim()) return null;
    let hit = null;
    for (const e of entries || []) {
      if (!e || !e.compiled) continue;
      if (!claimsTitle(matchedValues(e.compiled, src))) continue;
      const r = translate(e.compiled, src);
      if (!r.count) continue;
      if (!hit) {
        hit = { id: e.id, text: r.text, count: r.count };
        continue;
      }
      if (r.text !== hit.text) return null; // two keys, two answers
    }
    return hit;
  }

  // Which key translates one chat's title on screen. `attachedId` is the key
  // that chat has been given — through the popup, or by a run working the
  // matter — and it wins outright: an attachment is the operator saying which
  // case this is. Everything else falls to the library, under pickTitleKey's
  // one-claimant rule. `via` says which of the two answered, so the wiring can
  // say so.
  function titleKeyFor(state) {
    const s = state || {};
    if (s.attachedId) return { id: s.attachedId, via: "attached" };
    const hit = pickTitleKey(s.entries, s.text);
    return hit ? { id: hit.id, via: "match" } : null;
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
  // So while a run is MOVING, the MESSAGES in the conversations it can reach
  // show the fakes, exactly as claude.ai wrote them. Only the messages: what
  // a run can carry is what it can READ, and the one thing it never reads off
  // the screen is a chat's title (the Chat rename asks the conversation API,
  // the Cowork one reads an aria-label, and the title a run writes is its own
  // name run through the key first — titlePlan above). Holding the titles
  // bought nothing and cost the reader the line naming the case, in the very
  // minutes a run was working it. Two arms, because a run reaches further
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

  // ---- what a hand-off can READ off the page ---------------------------------
  //
  // Every shape a rendered TURN takes on claude.ai: the union of the two
  // cascades src/workflow-run.js walks to find the assistant's answer and the
  // human's message. It lives here, beside the hold, because it is the same
  // decision the hold is about — what a run can pick up off the screen — and
  // the display translation has to prune EXACTLY that set before it rewrites
  // anything while a run is moving. Two lists that drifted apart would be a
  // real name riding a hand-off into the next chat through a turn shape only
  // one of them knew about, so the suite holds them together
  // (test/pseudo.test.js reads workflow-run.js and checks this covers it).
  //
  // A superset is fine and a subset is not: the run takes the FIRST selector
  // that matches anything, so a shape it can reach is a shape the prune must
  // already have.
  const ASSISTANT_TURN_SELECTORS = [
    '[data-testid="assistant-message"]',
    ".font-claude-response",
    ".font-claude-message",
    "[data-is-streaming]",
  ];
  const HUMAN_TURN_SELECTORS = [
    '[data-testid="user-message"]',
    ".font-user-message",
    '[data-testid="human-message"]',
  ];

  /** Both cascades as one selector — what a page-wide pass must not walk into. */
  function turnSelector() {
    return ASSISTANT_TURN_SELECTORS.concat(HUMAN_TURN_SELECTORS).join(",");
  }

  const api = {
    isKeyFileName,
    sheetsLookLikeKey,
    isPinnedSheet,
    appliedSheet,
    PARSE_VERSION,
    keyNeedsReparse,
    staleNote,
    matchNothingNote,
    sampleFakes,
    headerIndex,
    isKeepCell,
    parseKey,
    keySignature,
    sameCaseKey,
    libraryIdFor,
    keyTitle,
    keyInPlay,
    keyLabel,
    keepKeyFacts,
    RECENT_KEYS,
    recentKeys,
    hiddenKeyCount,
    compile,
    translate,
    compileReals,
    compileForward,
    isCommonReal,
    findReals,
    copyWarning,
    COPY_WARN_MAX,
    compileTypeahead,
    endingReal,
    swapsOnSpace,
    mirrorCase,
    caseShape,
    applyCase,
    isPincitePaste,
    buildMatcher,
    conversationKeyFromUrl,
    conversationFromUrl,
    isConversationKey,
    caseNumbers,
    uncoveredCaseNumbers,
    caseNumberGate,
    nameCleaner,
    titlePlan,
    docTitleParts,
    matchedValues,
    isDistinctiveFake,
    claimsTitle,
    pickTitleKey,
    titleKeyFor,
    runTranslationHold,
    HOLD_STALE_MS,
    ASSISTANT_TURN_SELECTORS,
    HUMAN_TURN_SELECTORS,
    turnSelector,
    fold,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMPseudo = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
