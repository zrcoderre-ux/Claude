/**
 * Claude Usage Meter — the master key: every case, in title form (pure).
 *
 * The sidebar is where a case is FOUND, and a list of "8.11.26 Strangeways
 * MSJ" is a list you cannot navigate. src/pseudo-view.js already translates
 * those rows, but only for a case whose full pseudonym key is sitting in the
 * library right now, and only where exactly one key in that library claims the
 * row (P.pickTitleKey). Neither holds for long: keys get replaced and cleared
 * out, and the more of them there are the likelier two of them disagree about
 * a row and it keeps the fake.
 *
 * So this is the standing digest underneath that. Every pseudonym key that
 * passes through the extension is distilled, automatically, down to the part a
 * TITLE needs — the case number, the parties, and nothing else — and every
 * case is kept, newest first, with no ceiling. Nothing to upload, nothing to
 * download, no spreadsheet to keep track of: load a case's key once, for
 * anything, and its rows in Recents read in the real case name from then on.
 *
 * There used to be a ceiling (the last twenty cases, two dozen pairs each),
 * and it existed for one reason: pseudonym generation could mint the same
 * fake surname for two different matters, and the more cases shared one
 * matcher the likelier two of them disagreed about a fake and retired a pair
 * that mattered. Generation now guarantees a fake is never reused across
 * cases, so piling up cases no longer costs the cases already held anything —
 * and a cap that only ever threw away real case names had nothing left to
 * pay for. The retirement below stays, as the backstop for keys minted
 * before that guarantee.
 *
 * What it is deliberately NOT:
 *
 *   NOT A TRANSLATOR FOR MESSAGES. A distilled key is a handful of pairs out
 *   of a key that had hundreds. Run over a brief it would swap the caption and
 *   leave every declarant, witness and address in the fakes — a document half
 *   in one language and half in the other, with nothing saying which half you
 *   are reading. A title is short enough to be all or nothing, and that is the
 *   only place this is allowed to speak.
 *
 *   NOT A SECOND OPINION. Where the real key is in the library and claims a
 *   row, the real key wins — it knows more. This answers only where nothing
 *   else did, which is what makes adding it unable to take a translation away.
 *
 *   NOT A GUESS. Two cases whose keys bind the same fake to different real
 *   values retire that fake here exactly as parseKey retires an ambiguous one:
 *   a row that could be either case gets neither. Generation no longer mints
 *   the same fake twice, so this should never fire on new keys — but a key
 *   from before that guarantee can still collide, and the wrong case's name
 *   over a chat is the one failure this path cannot have.
 *
 * Filed by the REAL CASE NUMBER, which is what makes two cases two cases: the
 * folder gets renamed, the parties get spelled three ways, the number does
 * not. A key with no case number anywhere in it is not filed at all — it has
 * nothing to be unique BY — and the count of those is reported rather than
 * swallowed.
 *
 * Real names live here, on this machine, in extension storage — the same place
 * the full keys already live, and the same rule applies: it is read-side only.
 * Nothing here is ever sent, uploaded, or written into a title claude.ai
 * stores. It is clearable on its own from the popup, because a store of real
 * case names that outlives the keys it came from has to be a store you can
 * see and empty.
 *
 * Pure: no DOM, no chrome. Reads src/pseudo.js through the global it publishes
 * (CUMPseudo), the way src/folderup.js does, so a test gets the real decisions
 * about what a case number is rather than a fake's.
 */
(function (root) {
  "use strict";

  const str = (v) => (v == null ? "" : String(v));
  const norm = (v) => str(v).replace(/\s+/g, " ").trim();
  const fold = (v) => norm(v).toLowerCase();

  const P = () => root.CUMPseudo || null;

  // ---- one case, distilled --------------------------------------------------

  /** Every case number this key knows about, real side, in first-seen order. */
  function caseNumbersOf(key) {
    const p = P();
    if (!p || !p.caseNumbers) return [];
    const k = key || {};
    const seen = new Set();
    const out = [];
    const take = (text) => {
      for (const n of p.caseNumbers(text)) {
        const f = fold(n);
        if (seen.has(f)) continue;
        seen.add(f);
        out.push(n);
      }
    };
    // The folder first: that is the operator's own filing, and its number is
    // the one they would say out loud. Then the key's own rows, which is where
    // a key loaded from the popup — knowing no folder — keeps its number.
    take(k.folder);
    take(k.hint);
    for (const pair of k.pairs || []) take(pair && pair.real);
    return out;
  }

  function fakeNameOf(clean, real) {
    if (!clean || !real) return "";
    const out = norm(clean(real));
    return out && fold(out) !== fold(real) ? out : "";
  }

  /** The name this case goes by, in the real values: its folder, or its hint. */
  function caseNameOf(key) {
    const k = key || {};
    return norm(k.folder) || norm(k.hint);
  }

  /**
   * The pairs a title actually needs, in the order they earn their place:
   *
   *   1. the case NUMBERS — the one value that identifies the matter outright
   *   2. everything standing in the case's own NAME — its parties, which is
   *      what the rest of a caption is made of
   *   3. failing a name to measure against, whatever is distinctive enough to
   *      mean something standing alone (P.isDistinctiveFake, the same test
   *      that decides whether a fake in an unattached title is evidence at
   *      all). This is what a key loaded from the popup, which knows no case
   *      folder, has INSTEAD of rank 2 — never as well as it.
   *
   * That last word matters. Where the caption is known there is no reason to
   * carry the witnesses, the declarants and the addresses: they cannot tell
   * you which case a row in Recents is, and a library's worth of them is what
   * turns this from a title matcher into a merged library — the translator
   * for messages this must never become. So a case contributes its number and
   * its parties, and that is all. What qualifies is filtered; how many
   * qualify is not.
   *
   * Longest real first inside each rank, so a full name is kept over the bare
   * surname it contains.
   */
  function titlePairs(key) {
    const p = P();
    const k = key || {};
    const name = fold(caseNameOf(k));
    const ranked = [];
    for (const pair of k.pairs || []) {
      const real = norm(pair && pair.real);
      const fake = norm(pair && pair.fake);
      if (!real || !fake) continue;
      let rank;
      if (p && p.caseNumbers && p.caseNumbers(real).length) rank = 0;
      else if (name) rank = name.indexOf(fold(real)) !== -1 ? 1 : -1;
      else if (p && p.isDistinctiveFake && p.isDistinctiveFake(fake)) rank = 2;
      else rank = -1;
      if (rank < 0) continue;
      ranked.push({ rank: rank, real: real, fake: fake });
    }
    ranked.sort((a, b) => a.rank - b.rank || b.real.length - a.real.length);
    return ranked.map((r) => ({ fake: r.fake, real: r.real }));
  }

  /**
   * One library key, reduced to a master-key case — or null where it cannot be
   * filed.
   *
   * `at` is when this key was last loaded (key.savedAt), which is what "most
   * recent" is measured on.
   */
  function distil(key, at) {
    const k = key || {};
    const numbers = caseNumbersOf(k);
    if (!numbers.length) return null; // nothing to be unique by — see reject()
    const pairs = titlePairs(k);
    if (!pairs.length) return null;
    const p = P();
    const real = caseNameOf(k);
    // The case's own name run through the key's FORWARD direction — what a
    // chat started from that folder is actually called. Where the key carries
    // no forward direction the cleaner is the identity function, which would
    // file the real name under `fake`; "" says "not known" instead, because
    // this is what the popup prints beside the real one.
    const clean = p && p.nameCleaner ? p.nameCleaner(k) : null;
    const stamp = typeof k.savedAt === "number" ? k.savedAt : typeof at === "number" ? at : 0;
    return {
      caseNo: numbers[0],
      numbers: numbers,
      real: real,
      fake: fakeNameOf(clean, real),
      at: stamp,
      pairs: pairs,
      // Which READER distilled it. A case is kept here after its key has left
      // the library — that is the whole point of this store — and rebuild()
      // only walks the library, so such a case can never be distilled again. A
      // reader fix therefore reaches every case whose key is still loaded and
      // no others, and staleCases() below is how the ones it could not reach
      // are named rather than left translating by rules that were wrong.
      parsed: p && p.PARSE_VERSION,
    };
  }

  /** Why a key could not be filed, in words, or "" where it could. */
  function reject(key) {
    if (!P()) return "the pseudonym module is not loaded";
    if (!caseNumbersOf(key).length)
      return "no case number anywhere in it — there is nothing to file it under";
    if (!titlePairs(key).length) return "nothing in it that a chat title could carry";
    return "";
  }

  // ---- the cases -------------------------------------------------------------

  function cases(master) {
    const m = master || {};
    return Array.isArray(m.cases) ? m.cases : [];
  }

  /**
   * Put a case at the front. Newest first, one entry per real case number, and
   * nothing falls off the end: a case leaves only by forget() or clear(), the
   * operator's own hand, never by another case arriving.
   *
   * Re-seeing a case REPLACES its entry rather than merging with it: a key
   * reloaded after a correction is the corrected key, and a master key holding
   * the union of both spellings would translate a title to whichever it saw
   * first.
   */
  function remember(master, entry) {
    if (!entry || !entry.caseNo) return { cases: cases(master) };
    const want = fold(entry.caseNo);
    const kept = cases(master).filter((c) => fold(c && c.caseNo) !== want);
    return { cases: [entry].concat(kept) };
  }

  /**
   * The held cases distilled by an older reader — [{ caseNo, real }], newest
   * first. Empty where every case is current.
   *
   * These are the cases whose key is no longer in the library: one that is
   * still loaded was re-read and re-distilled by the worker (background.js,
   * reparseKeys), and one whose spreadsheet is gone has nothing left to
   * distil from. Loading that case's key once more is the whole remedy, and
   * saying which cases want it is the alternative to a Recents row that
   * quietly still reads in the fakes.
   */
  function staleCases(master) {
    const p = P();
    const want = p && p.PARSE_VERSION;
    if (!want) return [];
    return cases(master)
      .filter((c) => c && c.parsed !== want)
      .map((c) => ({ caseNo: c.caseNo, real: c.real || c.caseNo }));
  }

  /** Drop one case, by its real case number. */
  function forget(master, caseNo) {
    const want = fold(caseNo);
    const out = { cases: cases(master), clearedAt: clearedAt(master) };
    if (!want) return out;
    out.cases = out.cases.filter((c) => fold(c && c.caseNo) !== want);
    return out;
  }

  function clearedAt(master) {
    const at = master && master.clearedAt;
    return typeof at === "number" && isFinite(at) ? at : 0;
  }

  /**
   * Empty it, and make the emptying STICK.
   *
   * The library it was distilled from is still sitting there, so an empty
   * store alone would refill itself the next time anything folded the library
   * in — which is every worker start. That would make "empty the master key"
   * a button that appears to work and has not, over a store of real case
   * names, which is the worst kind of button there is. So the moment is
   * recorded, and rebuild() ignores every key that was already loaded by then:
   * emptied means emptied until you load a case's key again, which is the
   * operator saying they want that case back.
   */
  function clear(master, at) {
    return { cases: [], clearedAt: typeof at === "number" ? at : Date.now() };
  }

  /**
   * The master key the whole library implies, folded onto what is already
   * held.
   *
   * `keys` is the stored library, id -> parsed key. Every key is distilled and
   * remembered oldest-first, so the newest ends up at the front; a case
   * already held is refreshed only where the key is NEWER than the record,
   * which keeps an unrelated library write from shuffling the order.
   *
   * Cases whose keys have since gone from the library stay: outliving the
   * spreadsheet is the whole point of this, and the popup's own control is how
   * they leave.
   *
   * `opts.force` refreshes a held case from its key whatever the stamps say.
   * It is for the one caller that knows the RECORD is stale rather than the
   * key: a library re-read under a newer parser (P.PARSE_VERSION) writes the
   * same keys back under the same savedAt, and without this the distilled case
   * — built from the old reader's pairs, and carrying whatever it got wrong —
   * would sit in front of the fix forever.
   *
   * Answers { master, added, refreshed, skipped } — skipped being the keys that
   * could not be filed, which the caller says out loud rather than swallowing.
   */
  function rebuild(master, keys, opts) {
    const force = !!(opts && opts.force);
    const since = clearedAt(master);
    let out = { cases: cases(master), clearedAt: since };
    const lib = keys || {};
    const held = new Map();
    for (const c of out.cases) held.set(fold(c && c.caseNo), c);
    const entries = [];
    let skipped = 0;
    for (const id of Object.keys(lib)) {
      const entry = distil(lib[id]);
      if (!entry) {
        skipped++;
        continue;
      }
      // Loaded before the store was emptied: the operator has said they do not
      // want these, and the key still sitting in the library is not them
      // changing their mind. Loading it again is.
      //
      // Only where there WAS an emptying: a key stored before savedAt was
      // written carries at 0, and a test of `0 <= 0` would file none of them
      // ever, in a store that had never been emptied at all.
      if (since && entry.at <= since) continue;
      entries.push(entry);
    }
    entries.sort((a, b) => a.at - b.at); // oldest first, so the newest lands on top
    let added = 0;
    let refreshed = 0;
    for (const entry of entries) {
      const prev = held.get(fold(entry.caseNo));
      if (prev && !force && (prev.at || 0) >= entry.at) continue;
      if (prev) refreshed++;
      else added++;
      out = Object.assign(remember(out, entry), { clearedAt: since });
    }
    return { master: out, added: added, refreshed: refreshed, skipped: skipped };
  }

  // ---- the cases, as a key ---------------------------------------------------

  /**
   * The master key as a PSEUDONYM KEY — the same shape parseKey builds, so
   * every reader downstream (P.compile, P.compileForward, P.keyTitle, the
   * badge, the cleaner) takes it without knowing it is one. Null where there
   * is nothing to translate with.
   *
   * A fake bound to two different real values across two cases is RETIRED, the
   * fail-safe parseKey applies within one key applied across all of them.
   * Generation no longer reuses a fake across cases, so on new keys this never
   * fires — it stays for keys minted before that guarantee, because a coin
   * flip between two matters puts the wrong case's name over a chat.
   */
  function asKey(master) {
    const list = cases(master);
    if (!list.length) return null;
    const byFake = new Map();
    for (const c of list) {
      for (const pair of (c && c.pairs) || []) {
        const f = fold(pair.fake);
        if (!f) continue;
        if (!byFake.has(f)) byFake.set(f, []);
        byFake.get(f).push(pair);
      }
    }
    const pairs = [];
    let retired = 0;
    for (const group of byFake.values()) {
      const reals = new Set(group.map((g) => fold(g.real)));
      if (reals.size > 1) {
        retired++;
        continue;
      }
      pairs.push({ fake: group[0].fake, real: group[0].real });
    }
    if (!pairs.length) return null;
    return {
      name: "master key",
      folder: "master key · " + count(list.length, "recent case"),
      rows: pairs.length,
      pairs: pairs,
      // The forward direction, for the composer warning and the cleaner: a real
      // name typed into a chat on any of these cases is still a leak, and the
      // master key knows the fake to use instead.
      warn: pairs.map((p) => ({ real: p.real, fake: p.fake })),
      master: true,
      caseCount: list.length,
      retired: retired,
    };
  }

  function count(n, one, many) {
    return n + " " + (n === 1 ? one : many || one + "s");
  }

  /** What the master key holds, in one sentence, for the popup. */
  function describe(master) {
    const list = cases(master);
    if (!list.length)
      return (
        "The master key is empty. Load any case's pseudonym key once — from here, the run " +
        "editor or the Folder button — and this remembers that case, so its chats read back " +
        "in the real name from then on."
      );
    const k = asKey(master);
    const retired = k && k.retired ? " " + count(k.retired, "name") + " two of them disagreed " +
      "about is retired rather than guessed at." : "";
    return (
      "The master key holds " +
      count(list.length, "case") +
      " (" +
      count((k && k.rows) || 0, "name") +
      "), newest first — every case ever loaded, none falls off." +
      retired +
      " It reads Recents back in the real case names on its own — no key file to load, and no " +
      "real name ever leaves this browser."
    );
  }

  /** The case numbers it holds, newest first — what the popup lists. */
  function caseList(master) {
    return cases(master).map((c) => ({
      caseNo: str(c && c.caseNo),
      real: str(c && c.real),
      fake: str(c && c.fake),
      at: (c && c.at) || 0,
    }));
  }

  const api = {
    caseNumbersOf,
    caseNameOf,
    titlePairs,
    distil,
    reject,
    remember,
    staleCases,
    forget,
    clear,
    rebuild,
    asKey,
    describe,
    caseList,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMMasterKey = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
