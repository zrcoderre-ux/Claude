/**
 * Claude Usage Meter — auto-download of the files a reply produces (pure).
 *
 * With the toggle on, a file Claude hands you in a reply lands in your Downloads
 * folder without you reaching for the button. A workflow step once had a switch
 * of its own for this; it was removed in favour of this one, which does the same
 * thing for every chat rather than only for a run's.
 *
 * Everything here is the decision; the DOM work is in src/autodownload.js. The
 * decision is the part worth testing, because both ways of getting it wrong are
 * bad in their own way: a file that never saves is a feature that did nothing,
 * and a file that saves twice — or a whole chat's history re-saved on every
 * page load — is the extension writing junk to your disk unasked.
 *
 * **It is real-time only, and that is a rule rather than a hope.** A file is
 * saved out of a reply this page watched being written, and out of nothing
 * else. Four rules carry that:
 *
 * - **Only a reply that landed in front of us** (`landed`, `rememberLive`, and
 *   the `live` gate in `plan`). Opening a chat with forty files in it saves
 *   none of them — not because they look old, but because no answer arrived
 *   while anyone was watching. This holds however the page renders, however far
 *   you scroll it, and whether or not the keying below is perfect.
 * - **A census as well**, so nothing that was on the page when the ledger
 *   started can be taken even if it later looks new. Belt to the braces above:
 *   the two rules fail in different directions, and a backlog saved by accident
 *   is the failure worth paying twice to avoid.
 * - **What counts as a save control.** Out in the open, deliberately narrow:
 *   this runs unattended on every claude.ai page, so a bare "Save" — a caption
 *   claude.ai uses for saving things that aren't files at all — is not enough.
 *   "Download", or "Download <filename>", is. Inside a file card, where a
 *   filename is already on the thing, the looser reading applies.
 * - **A ceiling in both directions** — per reply and per page load — because a
 *   pathological message must not be able to fill a folder.
 */
(function (root) {
  "use strict";

  const MAX_PER_PAGE = 20; // files saved per page load, across all replies
  const MAX_PER_TURN = 6; // ...and within any one reply
  const COOLDOWN_MS = 1200; // never two saves closer together than this
  const TURN_SIG = 120; // chars of a reply that identify it

  // How far back catch-up may reach, by the clock rather than by a count of
  // replies. Twelve replies is no distance at all in a chat worked on for a
  // week: opening it hands catch-up a fortnight of files and asks the download
  // history to sort them out. Ten minutes is the span in which a file can
  // plausibly be something this session just produced.
  //
  // It bounds CATCH-UP only. A reply watched arriving is saved whatever the
  // clock says about the turn it belongs to — it happened in front of us, and
  // that is a better fact than any timestamp.
  const LOOKBACK_DEFAULT_MIN = 10;
  const LOOKBACK_MS = LOOKBACK_DEFAULT_MIN * 60 * 1000;

  // Settable, within bounds. One minute is the floor because zero would be a
  // catch-up that can never catch anything, which is what the switch itself is
  // for; a day is the ceiling because past that the clock has stopped saying
  // anything useful and you are back to trusting the download history alone —
  // which is the arrangement this replaced.
  const LOOKBACK_MIN_MIN = 1;
  const LOOKBACK_MAX_MIN = 1440;

  /** A stored setting read back as minutes: clamped, rounded, never NaN. */
  function lookbackMinutes(value) {
    const n = typeof value === "number" ? value : parseInt(str(value).trim(), 10);
    if (!isFinite(n)) return LOOKBACK_DEFAULT_MIN;
    return Math.min(LOOKBACK_MAX_MIN, Math.max(LOOKBACK_MIN_MIN, Math.round(n)));
  }

  /** The same, in milliseconds, straight from the config object. */
  function lookbackMsFor(cfg) {
    return lookbackMinutes(cfg && cfg.lookbackMin) * 60 * 1000;
  }

  /**
   * Is a turn recent enough for catch-up to touch its files?
   *
   * An unknown time is NOT recent. Catch-up reaching back through a chat is
   * exactly the case this bound exists for, so "we couldn't find out when this
   * happened" has to fail closed — otherwise the one situation the caller can't
   * measure is the one where the bound stops applying.
   */
  function withinLookback(at, now, maxMs) {
    if (typeof at !== "number" || !isFinite(at)) return false;
    const t = typeof now === "number" && isFinite(now) ? now : 0;
    const span = maxMs > 0 ? maxMs : LOOKBACK_MS;
    // A turn stamped in the future is a clock disagreeing with itself, not a
    // reason to save something: treat it as now rather than as infinitely old.
    return at - t <= span && t - at <= span;
  }

  function str(x) {
    return typeof x === "string" ? x : x == null ? "" : String(x);
  }

  function normLabel(text) {
    return str(text).replace(/\s+/g, " ").trim().toLowerCase().replace(/[.:]+$/, "");
  }

  // A control that saves a file. "Download", "Download ruling.docx",
  // "Save as PDF" — the word has to LEAD, so a button captioned with a sentence
  // that happens to mention downloading is not this.
  //
  // Bare "Save" is excluded on purpose (see the header). So is anything long:
  // a control's caption is a few words, and a paragraph that starts with
  // "Download" is prose.
  const SAVE_RE = /^(?:download|save as|save file)\b/;

  // ...but not a control that saves it SOMEWHERE ELSE. Cowork draws a file's
  // controls as a menu whose top row is Google Drive, and "Save to Google
  // Drive" reads as a save to every test above — so an auto-download that
  // trusted the word would upload the file to a third party instead of writing
  // it to disk. That is not a near miss of the feature; it is a different act,
  // outward-facing and not the extension's to perform unasked.
  //
  // Named destinations rather than a general suspicion of "to": a caption like
  // "Download to your computer" is exactly what we want, and must still pass.
  //
  // "copy" is deliberately only "copy link". Bare copy is how a local save
  // describes itself — "Save a copy" is the looser card wording this module has
  // always accepted — so excluding the word outright would turn this guard into
  // a second bug in the other direction.
  const ELSEWHERE_RE =
    /\b(?:google\s*drive|gdrive|drive|dropbox|onedrive|one\s*drive|sharepoint|icloud|box|notion|slack|gmail|e-?mail|share|link|copy\s+link|upload|send|export\s+to|connect|add\s+to)\b/;
  function goesElsewhere(text) {
    return ELSEWHERE_RE.test(normLabel(text));
  }

  function isSaveLabel(text) {
    const s = normLabel(text);
    if (!s || s.length > 80) return false;
    if (goesElsewhere(s)) return false;
    return SAVE_RE.test(s);
  }

  // The looser reading, used ONLY inside a file card — a card naming
  // `ruling.docx` with one control on it is not ambiguous the way a button
  // loose in a reply is, so "Download file" and "Save a copy" both count there.
  const SAVE_WORD = /\b(?:download|save)\b/;
  function mentionsSave(text) {
    const s = normLabel(text);
    if (!s || s.length > 80) return false;
    // The looser reading is looser about the WORD, never about the
    // destination — being inside a file card makes "Save a copy" unambiguous,
    // and does nothing at all to make "Save to Google Drive" a download.
    if (goesElsewhere(s)) return false;
    return SAVE_WORD.test(s);
  }

  // A control that doesn't save anything itself but opens the thing that does.
  // Cowork puts a file's Download behind one: an icon-only
  //   button[aria-label="More ways to open"]
  // whose menu holds "Google Drive" and "Download". It carries no filename and
  // no save word, so nothing above can see it, and a card whose only route to
  // the file is this button looks to this module like a card with no control.
  //
  // Narrow, and the words have to LEAD, on the same reasoning as SAVE_RE: this
  // runs unattended, and pressing an unknown button to see what happens is how
  // a "download" ends up being Delete. Being merely a disclosure is not licence
  // to press whatever it reveals — the caller still takes a census first and
  // presses only what names itself a save afterwards.
  const DISCLOSURE_RE = /^more\s+(?:ways|options|actions|choices)\b/;
  function isDisclosureLabel(text) {
    const s = normLabel(text);
    if (!s || s.length > 40) return false;
    return DISCLOSURE_RE.test(s);
  }

  // A caption that DESCRIBES Claude working through a file rather than
  // offering one. Cowork narrates its internal file review as a card —
  // "Reading project file Authority Watch Register 8.17.2026.md", live from
  // the owner's chat — that names a file and takes a press, but there is no
  // live file behind it: pressing it opens a review of the project's own
  // document, and nothing is there to save.
  //
  // Matched as a PHRASE — an activity verb leading into a file-ish noun —
  // rather than by the verb alone, because the verb alone is how files get
  // NAMED: "Reading List.md" is a file called Reading List, and a bare-verb
  // rule would have quietly stopped saving it. (fileNameIn can't referee
  // this: its pattern is deliberately wide enough that the whole narration,
  // verb and all, reads as one long filename.) "Created ruling.md" stays
  // pressable on purpose — creation is Cowork genuinely handing a file over,
  // and only the reading-type verbs are listed here.
  const ACTIVITY_RE = new RegExp(
    "^(?:read(?:ing)?|re-?read(?:ing)?|view(?:ing|ed)?|open(?:ing|ed)?|search(?:ing|ed)?|" +
      "scann(?:ing|ed)|scan|analyz(?:ing|ed)|analys(?:ing|ed)|review(?:ing|ed)?|check(?:ing|ed)?|" +
      "examin(?:ing|ed)|inspect(?:ing|ed)?|load(?:ing|ed)?|fetch(?:ing|ed)?)\\s+" +
      "(?:(?:the|a|this|its|your)\\s+)?(?:project\\s+)?" +
      "(?:file|files|document|documents|doc|docs|attachment|attachments|source|sources|knowledge)\\b"
  );
  function isFileActivity(text) {
    const s = normLabel(text);
    if (!s || s.length > 200) return false;
    return ACTIVITY_RE.test(s);
  }

  // Text that names a file. This is what identifies a card: claude.ai draws
  // what Claude produced as a small panel with the filename on it, and the
  // filename is the part that doesn't change when the markup does.
  const FILE_EXT =
    /(?:docx?|pdf|xlsx?|xls|csv|pptx?|md|markdown|txt|rtf|json|xml|ya?ml|zip|png|jpe?g|gif|svg|html?|ics)/;
  // The punctuation is deliberately wide. A document title is a document title
  // — "Verification Report: 24STCV83325 Motion for Attorney Fees 8.13.2026.md"
  // — and a class that stopped at the colon read the name as beginning after
  // it, which is a different name from the one that reaches your disk and so
  // never matches it.
  const FILENAME_RE = new RegExp(
    "([\\w][\\w ,;:!#+=@~'\\u2019()\\[\\]&.\\u2014\\u2013-]{0,80}\\." + FILE_EXT.source + ")\\b",
    "i"
  );
  function fileNameIn(text) {
    const s = str(text).replace(/\s+/g, " ").trim();
    if (!s || s.length > 200) return "";
    const m = FILENAME_RE.exec(s);
    return m ? m[1].trim() : "";
  }

  // A file-TYPE chip: the little uppercase token claude.ai puts beside a file's
  // name — `DOCX`, `PDF`, `XLSX`. It matters because a card's name often
  // carries no extension at all ("Tentative Ruling" + a `DOCX` chip), and a
  // card found only by `fileNameIn` above is then invisible.
  //
  // Deliberately only the WHOLE of a piece of text, never a word inside one.
  // "Here's the PDF." is a sentence, and treating it as a file card would mean
  // climbing out of it and pressing whatever button was nearest — which in a
  // reply is the Copy button. The caller pays for the looser identification by
  // insisting on a control that names itself; see cardsIn.
  const TYPE_CHIP_RE = new RegExp("^\\.?(?:" + FILE_EXT.source + ")$", "i");
  function isTypeChip(text) {
    const s = str(text).replace(/\s+/g, " ").trim();
    if (!s || s.length > 12) return false;
    return TYPE_CHIP_RE.test(s);
  }

  // The filename out of a control's caption, where it carries one. Used for the
  // ledger key and for what the toast says — never for deciding whether to
  // click, so getting nothing back here is not a failure.
  function fileName(label) {
    const s = str(label).replace(/\s+/g, " ").trim();
    const m = /^(?:download|save)(?:\s+as)?(?:\s+file)?\s*[:\-–—]?\s+(.+)$/i.exec(s);
    if (!m) return "";
    const name = m[1].replace(/^["'“‘]+|["'”’]+$/g, "").trim();
    if (!name || name.length > 120) return "";
    return name;
  }

  // How a file is recognised as one you already have.
  //
  // Matched on the NAME, because that is the only thing a card on the page and
  // an entry in your download history have in common — the history knows a path
  // and a size, the card knows neither. Chrome's own de-duplication is undone
  // first: a second copy of `ruling.docx` is saved as `ruling (1).docx` and a
  // third as `ruling (2).docx`, so a run of those would each look like a
  // different file and each earn another copy.
  // Characters a filesystem won't take. Chrome rewrites them on the way to disk
  // — a colon becomes an underscore — so the name written on the card and the
  // name sitting in Downloads are different strings for the same file, and
  // comparing them literally never matches. Both sides are folded to the same
  // thing: the punctuation to a space, then the spaces collapsed.
  const MANGLED = /[:*?"<>|/\\_]+/g;
  function downloadKey(name) {
    let s = str(name).replace(/\\/g, "/");
    s = s.slice(s.lastIndexOf("/") + 1);
    if (!s.trim()) return "";
    // " (1)" immediately before the extension, or at the end where there is
    // none — Chrome's own de-duplication, undone, so a second copy isn't taken
    // for a file you don't have.
    s = s.replace(/\s*\(\d+\)(?=\.[^.]*$)/, "").replace(/\s*\(\d+\)$/, "");
    s = s.replace(MANGLED, " ").replace(/\s+/g, " ").trim();
    return s.toLowerCase();
  }

  // Every name you already have, as a lookup.
  function downloadIndex(names) {
    const out = Object.create(null);
    for (const n of names || []) {
      const k = downloadKey(n);
      if (k) out[k] = true;
    }
    return out;
  }

  // What identifies a reply. Its opening is stable once written — where its
  // length, its ending and its position in the list are all still moving while
  // claude.ai streams it, mounts it and unmounts it again. (A reply shorter
  // than this does still change identity as it streams; nothing is clicked
  // mid-turn, which is where that stops mattering.)
  function turnSignature(text) {
    return str(text).replace(/\s+/g, " ").trim().slice(0, TURN_SIG);
  }

  // One key per file offered by a reply, unique within it. Two cards in the
  // same message can easily present the same caption ("Download") and carry no
  // filename at all; keyed on the caption alone the second would look like the
  // first and never be saved.
  function offerKeys(turn, names) {
    const t = str(turn).trim() || "?";
    const used = Object.create(null);
    return (names || []).map((n, i) => {
      let base = normLabel(n) || "file " + (i + 1);
      used[base] = (used[base] || 0) + 1;
      if (used[base] > 1) base += " #" + used[base];
      return t + "|" + base;
    });
  }

  // A reply this page watched being written, remembered by its opening. Kept
  // short: only the newest few replies can still be offering a file, and an
  // unbounded list of every turn in a long session is a leak with no use.
  const LIVE_MAX = 4;
  function rememberLive(live, sig, max) {
    const cap = max > 0 ? max : LIVE_MAX;
    const list = (live || []).slice(-cap);
    const s = turnSignature(sig);
    if (!s) return list;
    // Moved along rather than repeated: a reply re-marked while its file card
    // finishes rendering must not push the others off the end.
    return list
      .filter((x) => x !== s)
      .concat([s])
      .slice(-cap);
  }

  /**
   * Has a new reply landed?
   *
   * A turn ending is not on its own the thing to act on: the signal can arrive
   * before claude.ai has mounted the answer, and marking whatever is newest at
   * that instant would mark the PREVIOUS reply — an old one, whose files are
   * exactly the backlog this must never touch. So the reply that ended has to
   * be demonstrably different from the one that was newest when it started,
   * which is the same comparison a workflow step makes before it will take an
   * answer as its own.
   */
  function landed(state) {
    const s = state || {};
    if (!s.armed || s.generating) return false;
    const now = turnSignature(s.newest);
    if (!now) return false;
    return now !== turnSignature(s.before);
  }

  function turnOf(key) {
    const s = str(key);
    const i = s.indexOf("|");
    return i === -1 ? s : s.slice(0, i);
  }

  /**
   * What to do about the files currently on offer.
   *
   * offers: [{ key, ready, ... }] — everything a save control is being offered
   *         for right now, in document order. `ready: false` marks one that
   *         can't be clicked yet (hidden, disabled, already clicked): it still
   *         holds its place, because the keys of the files around it are
   *         numbered against this list and a list that shrank would rename
   *         them.
   * ctx:    { enabled, generating, pending, baselined, live[], seen[], count,
   *           max, maxPerTurn, now, lastAt, cooldownMs }
   *
   * → { adopt: [key], take: offer|null, hold: reason|null }
   *
   * `adopt` is what the caller must record as seen whether or not anything was
   * clicked — the census is expressed here rather than in the caller so it is
   * covered by the same tests as the clicking.
   *
   * `live` is the list of replies this page watched being written (see
   * rememberLive). **A file is only ever saved out of one of those.** This is
   * the rule that makes the feature real-time rather than retrospective, and it
   * is a stronger statement than the census: the census says "not what was here
   * when I arrived", where this says "only what I saw arrive". Nothing about a
   * chat you merely opened — however it renders, however you scroll it, however
   * the extension might mis-key it — can satisfy it.
   *
   * One file per call. Saves are paced rather than fired in a burst: each one
   * may raise a Save-as dialog, and a stack of them is worse than a slow trickle.
   */
  function plan(offers, ctx) {
    const c = ctx || {};
    const list = Array.isArray(offers) ? offers : [];
    const none = { adopt: [], take: null, hold: null };

    const live = {};
    for (const s of c.live || []) live[s] = true;

    /**
     * Take this one even though nobody watched its reply arrive?
     *
     * Only with `catchUp` on, and only where a real answer to "do I already
     * have this?" exists. Two conditions, both load-bearing:
     *
     * - It has to have a NAME. An unnamed control cannot be checked against
     *   anything, so catching it up would be saving a file on the strength of
     *   nothing at all — and a chat's backlog is exactly where that goes wrong
     *   at scale.
     * - Your download history has to have been READ. `downloaded` being absent
     *   means the question wasn't answered, not that the answer was no; acting
     *   on a missing answer is how a folder fills up with second copies.
     * - And the turn has to be RECENT. See LOOKBACK_MS: a count of replies is
     *   no measure of age in a chat worked on across days, and a file produced
     *   last Tuesday is not something this session is catching up on.
     */
    const dl = c.downloaded || null;
    let staleSeen = false;
    const catchable = (o) => {
      if (!c.catchUp || !dl) return false;
      if (!withinLookback(o && o.at, c.now, c.lookbackMs)) {
        staleSeen = true;
        return false;
      }
      const key = downloadKey(o && o.name);
      return !!key && !dl[key];
    };

    if (!c.enabled) return Object.assign({}, none, { hold: "off" });
    if (!c.baselined) {
      // The census does not close over a turn that is still in flight, or one
      // whose answer we are still waiting to see: whatever it produces is
      // output, and adopting it would file the thing this feature exists for
      // as history. (`pending` is that wait — a turn has ended and its answer
      // hasn't appeared yet.)
      if (c.generating || c.pending) return Object.assign({}, none, { hold: "settling" });
      // Nor does it adopt a reply we watched arrive. Turning the toggle on the
      // moment an answer lands is a coin toss between the two rules otherwise,
      // and the census is the one that should give way — it is the weaker
      // statement of the two.
      // ...nor one it is about to catch up. The census exists to file "what
      // was already here" as handled; with catch-up on, a named file you don't
      // have is not handled, and adopting it here would put it beyond reach for
      // the rest of the page load.
      return {
        adopt: list.filter((o) => !live[turnOf(o.key)] && !catchable(o)).map((o) => o.key),
        take: null,
        hold: "baseline",
      };
    }

    const seen = {};
    for (const k of c.seen || []) seen[k] = true;
    const fresh = list.filter((o) => !seen[o.key]);
    if (!fresh.length) return none;

    // Wait for the turn to finish. A file card can appear while Claude is still
    // writing, and a save dialog landing mid-answer is exactly the interruption
    // this is meant to save you from.
    if (c.generating) return Object.assign({}, none, { hold: "generating" });

    const max = c.max > 0 ? c.max : MAX_PER_PAGE;
    if ((c.count || 0) >= max) return Object.assign({}, none, { hold: "cap" });

    const cooldown = c.cooldownMs == null ? COOLDOWN_MS : c.cooldownMs;
    if (c.lastAt && (c.now || 0) - c.lastAt < cooldown)
      return Object.assign({}, none, { hold: "cooldown" });

    const perTurn = c.maxPerTurn > 0 ? c.maxPerTurn : MAX_PER_TURN;
    let held = null;
    for (const o of fresh) {
      const t = turnOf(o.key);
      // Not a reply we watched being written. Every file in a chat you have
      // merely opened lands here, and none of them is adopted: should this turn
      // out to be the reply in flight after all, it is still saved.
      if (!live[t] && !catchable(o)) {
        held =
          held ||
          (c.catchUp && !dl
            ? "no download history yet"
            : c.catchUp && staleSeen
            ? "older than the catch-up window"
            : "backlog");
        continue;
      }
      let n = 0;
      for (const k in seen) if (turnOf(k) === t) n++;
      if (n >= perTurn) {
        held = held || "reply cap"; // this reply has had its share
        continue;
      }
      // Not clickable yet. Not adopted either — a card that opens, or a button
      // that enables, a moment later is still a file this is meant to save.
      if (o.ready === false) {
        held = held || "not ready";
        continue;
      }
      return { adopt: [o.key], take: o, hold: null };
    }
    return Object.assign({}, none, { hold: held });
  }

  const api = {
    normLabel,
    isSaveLabel,
    mentionsSave,
    goesElsewhere,
    isDisclosureLabel,
    isFileActivity,
    LOOKBACK_MS,
    LOOKBACK_DEFAULT_MIN,
    LOOKBACK_MIN_MIN,
    LOOKBACK_MAX_MIN,
    lookbackMinutes,
    lookbackMsFor,
    withinLookback,
    fileNameIn,
    isTypeChip,
    downloadKey,
    downloadIndex,
    fileName,
    turnSignature,
    offerKeys,
    turnOf,
    rememberLive,
    landed,
    plan,
    MAX_PER_PAGE,
    MAX_PER_TURN,
    COOLDOWN_MS,
    TURN_SIG,
    LIVE_MAX,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMAutoDl = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
