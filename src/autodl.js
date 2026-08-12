/**
 * Claude Usage Meter — auto-download of the files a reply produces (pure).
 *
 * A workflow step can already be told to save whatever its reply offers
 * (`downloadFiles`, see src/workflow.js). This is the same idea for the chats
 * you drive yourself: with the toggle on, a file Claude hands you in a reply
 * lands in your Downloads folder without you reaching for the button.
 *
 * Everything here is the decision; the DOM work is in src/autodownload.js. The
 * decision is the part worth testing, because both ways of getting it wrong are
 * bad in their own way: a file that never saves is a feature that did nothing,
 * and a file that saves twice — or a whole chat's history re-saved on every
 * page load — is the extension writing junk to your disk unasked.
 *
 * Three rules carry that weight:
 *
 * - **What counts as a save control.** Deliberately narrower than
 *   `CUMWorkflow.isDownloadLabel`, which a *step* uses under a run you started
 *   and are watching. This one runs unattended on every claude.ai page, so a
 *   bare "Save" — a caption claude.ai uses for saving things that aren't files
 *   at all — is not enough. "Download", or "Download <filename>", is.
 * - **A census before anything is clicked.** Nothing already on the page when
 *   the ledger starts is ever downloaded; it is adopted as seen. Otherwise
 *   opening an old chat, or turning the toggle on while reading one, would
 *   re-save every file in it.
 * - **A ceiling in both directions** — per reply and per page load — because a
 *   pathological message must not be able to fill a folder.
 */
(function (root) {
  "use strict";

  const MAX_PER_PAGE = 20; // files saved per page load, across all replies
  const MAX_PER_TURN = 6; // ...and within any one reply
  const COOLDOWN_MS = 1200; // never two saves closer together than this
  const TURN_SIG = 120; // chars of a reply that identify it

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
  function isSaveLabel(text) {
    const s = normLabel(text);
    if (!s || s.length > 80) return false;
    return SAVE_RE.test(s);
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
   * ctx:    { enabled, generating, baselined, seen[], count, max, maxPerTurn,
   *           now, lastAt, cooldownMs }
   *
   * → { adopt: [key], take: offer|null, hold: reason|null }
   *
   * `adopt` is what the caller must record as seen whether or not anything was
   * clicked — the census is expressed here rather than in the caller so it is
   * covered by the same tests as the clicking.
   *
   * One file per call. Saves are paced rather than fired in a burst: each one
   * may raise a Save-as dialog, and a stack of them is worse than a slow trickle.
   */
  function plan(offers, ctx) {
    const c = ctx || {};
    const list = Array.isArray(offers) ? offers : [];
    const none = { adopt: [], take: null, hold: null };

    if (!c.enabled) return Object.assign({}, none, { hold: "off" });
    // The census: everything already here is history, not output.
    if (!c.baselined)
      return { adopt: list.map((o) => o.key), take: null, hold: "baseline" };

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
    fileName,
    turnSignature,
    offerKeys,
    turnOf,
    plan,
    MAX_PER_PAGE,
    MAX_PER_TURN,
    COOLDOWN_MS,
    TURN_SIG,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMAutoDl = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
