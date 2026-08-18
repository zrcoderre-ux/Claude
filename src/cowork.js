/**
 * Cowork — the decisions behind driving claude.ai's Cowork surface.
 *
 * Cowork is not a page. Toggling into it leaves /new as /new, and a sent
 * message lands on /cowork/cse_<id>, where the id is not a uuid. So there is
 * nothing in an address to tell a scheduled send which mode it woke up in, and
 * the mode is sticky: a brand-new tab comes up in whatever was last used.
 *
 * That makes reading the mode off the page the only honest answer, and the page
 * happens to say it plainly — the approval control's own aria-label IS the mode
 * in force ("Manually approve" / "Automatically approve" / "Skip all
 * approvals"). This module holds the mapping between that label, the storage
 * key a job carries, and the menu row that changes it, so a change to any of
 * claude.ai's wording is one edit here rather than an investigation.
 *
 * Pure: no DOM, no chrome. The finding and clicking live in composer.js.
 */
(function (root) {
  "use strict";

  // The three approval modes, in the order the menu lists them. `key` is what a
  // job stores; `label` is the trigger's aria-label and the menu row's opening
  // words; `short` is what the trigger renders when there's no room ("Auto").
  const MODES = [
    { key: "manual", label: "Manually approve", short: "Manual" },
    { key: "auto", label: "Automatically approve", short: "Auto" },
    { key: "skip", label: "Skip all approvals", short: "Skip" },
  ];

  // Cowork's own default, and the one the extension leaves alone. A job that
  // stores "" means "whatever the page is already on" — the same contract
  // job.model has, and for the same reason: acting on the user's behalf is
  // opt-in, so an unset field must never move a control.
  const INHERIT = "";

  // The two halves of the Chat/Cowork control, which claude.ai calls "Surface"
  // — a [role="radiogroup"][aria-label="Surface"] of two [role="radio"] spans.
  // The name is worth keeping: it is the one word in the markup that isn't
  // either of the choices, so it survives a rename of either.
  const SURFACES = [
    { key: "chat", label: "Chat" },
    { key: "cowork", label: "Cowork" },
  ];

  const str = (v) => (v == null ? "" : String(v));
  const norm = (v) => str(v).replace(/\s+/g, " ").trim();
  const lower = (v) => norm(v).toLowerCase();

  function modeByKey(key) {
    const k = lower(key);
    for (const m of MODES) if (m.key === k) return m;
    return null;
  }

  /**
   * The mode a label names. Accepts the trigger's aria-label, a menu row's full
   * text (which runs the name into its description — "Manually approveClaude
   * pauses so you can approve each action"), the short form, or a stored key.
   * Returns a mode key, or "" for anything it doesn't recognise.
   *
   * Prefix, not equality: the row text carries its description with no
   * separator, so an exact match would never fire and a substring match would
   * let a description mentioning another mode win.
   */
  function modeFromLabel(label) {
    const t = lower(label);
    if (!t) return INHERIT;
    const byKey = modeByKey(t);
    if (byKey) return byKey.key;
    for (const m of MODES) if (t.indexOf(m.label.toLowerCase()) === 0) return m.key;
    for (const m of MODES) if (t === m.short.toLowerCase()) return m.key;
    return INHERIT;
  }

  /** The aria-label claude.ai uses for a mode, for finding its trigger or row. */
  function labelForMode(key) {
    const m = modeByKey(key);
    return m ? m.label : "";
  }

  /** What to show a person: the label, or a word saying we won't touch it. */
  function describeMode(key) {
    const m = modeByKey(key);
    return m ? m.label : "Leave as-is";
  }

  /** Every label, for building a picker. Unset first, matching the model select. */
  function modeOptions() {
    return [{ value: INHERIT, label: "Leave as-is" }].concat(
      MODES.map((m) => ({ value: m.key, label: m.label }))
    );
  }

  /**
   * Whether a menu row is the one for `key`. The row's text opens with the
   * mode's name and continues into its description, so this is the prefix test
   * that `modeFromLabel` would apply, asked the other way round.
   */
  function rowIsMode(rowText, key) {
    const m = modeByKey(key);
    if (!m) return false;
    return lower(rowText).indexOf(m.label.toLowerCase()) === 0;
  }

  /**
   * What to do about the mode, given what the job asked for and what the page
   * is on. Returns one of:
   *
   *   "inherit"  — the job didn't ask, so nothing is touched
   *   "ok"       — the page is already on it
   *   "set"      — click through to `wanted`
   *   "unknown"  — the job asked, but this page has no approval control at all,
   *                which means it isn't in Cowork
   *
   * The last one is the one that matters. The mode is sticky and invisible in
   * the URL, so a job that asked for an approval mode and landed somewhere
   * without the control has NOT quietly got its way — it has been ignored, and
   * the caller is expected to say so rather than send anyway.
   */
  function reconcile(wanted, current) {
    const want = modeFromLabel(wanted);
    if (!want) return "inherit";
    const have = modeFromLabel(current);
    if (!have) return "unknown";
    return want === have ? "ok" : "set";
  }

  /** A note worth carrying back on the send, or "" when there's nothing to say. */
  function reconcileNote(wanted, current) {
    switch (reconcile(wanted, current)) {
      case "set":
        return "approval set to " + describeMode(wanted);
      case "unknown":
        return "asked for " + describeMode(wanted) + " but this page isn't in Cowork — sent as-is";
      default:
        return "";
    }
  }

  // ---- the surface itself ------------------------------------------------

  function surfaceByKey(key) {
    const k = lower(key);
    for (const s of SURFACES) if (s.key === k) return s;
    return null;
  }

  /**
   * Which half of the toggle a piece of text names. The radio's label is its
   * whole text ("Chat", "Cowork"), so this one is an equality test — unlike the
   * approval rows, nothing is appended.
   */
  /**
   * A surface name reduced to its letters. `\s` does not match a zero-width
   * space, so one sitting in a label survives every normalisation above and
   * makes "cowork" fail to equal "cowork" — invisibly, since JSON.stringify
   * prints it as nothing at all. That cost several rounds of reading code that
   * was, on its own terms, correct.
   *
   * Letters and digits only, which also folds in the hyphen and the space:
   * "Co-work", "Co Work" and "cowork" have never been different answers.
   */
  const squash = (v) => lower(v).replace(/[^a-z0-9]+/g, "");

  function surfaceFromLabel(label) {
    const t = squash(label);
    if (!t) return INHERIT;
    for (const s of SURFACES) if (t === squash(s.label)) return s.key;
    return INHERIT;
  }

  function labelForSurface(key) {
    const s = surfaceByKey(key);
    return s ? s.label : "";
  }

  function describeSurface(key) {
    const s = surfaceByKey(key);
    return s ? s.label : "Leave as-is";
  }

  function surfaceOptions() {
    return [{ value: INHERIT, label: "Leave as-is" }].concat(
      SURFACES.map((s) => ({ value: s.key, label: s.label }))
    );
  }

  /**
   * The surface in force, from whatever the page is willing to say.
   *
   * `radios` is [{ label, checked }] in document order, where `checked` is null
   * when the markup didn't say either way. That case is the normal one rather
   * than the exception: the live toggle was seen rendering BOTH of its halves
   * as aria-checked="false", with the real state on a hidden input beside them.
   * A reader that trusted aria-checked alone concluded "no toggle here" and
   * refused to click a control sitting in plain sight.
   *
   * So the last resort is the thing that was actually proved: an approval
   * control exists in Cowork and nowhere else. If the toggle is present and
   * there is no approval control, this is Chat.
   */
  function surfaceFromEvidence(radios, hasApproval, hasGroup) {
    for (const r of radios || []) {
      if (r && r.checked === true) {
        const s = surfaceFromLabel(r.label);
        if (s) return s;
      }
    }
    if (hasApproval) return "cowork";
    if (hasGroup) return "chat";
    return INHERIT;
  }

  /**
   * The same four answers as `reconcile`, about the Chat/Cowork toggle.
   *
   * "unknown" means the toggle isn't on this page at all, which is the ordinary
   * case rather than a failure: the control only exists on the composer home,
   * so a job resuming an existing conversation has no surface to choose and
   * never had one.
   */
  function reconcileSurface(wanted, current) {
    const want = surfaceFromLabel(wanted);
    if (!want) return "inherit";
    const have = surfaceFromLabel(current);
    if (!have) return "unknown";
    return want === have ? "ok" : "set";
  }

  /**
   * Whether a job asking for `wanted` should be touching the approval control
   * at all. Approval modes belong to Cowork; in Chat there is no such control,
   * and a job that carries one from an earlier edit shouldn't go hunting for it.
   */
  function approvalApplies(surfaceWanted, surfaceCurrent) {
    const want = surfaceFromLabel(surfaceWanted);
    if (want) return want === "cowork";
    return surfaceFromLabel(surfaceCurrent) === "cowork";
  }

  /**
   * What to say about a surface we changed and could not change back.
   *
   * The toggle is a single last-used preference for the whole account, not a
   * property of the tab: switch it in a background tab at 3am and the next tab
   * opened by hand comes up that way. So a job that moves it owes the user
   * either a restoration or a sentence, and the restoration is only possible
   * while the control is still on screen — which, after a send, it is not.
   */
  function surfaceLeftNote(changedFrom, restored) {
    const from = surfaceFromLabel(changedFrom);
    if (!from || restored) return "";
    return (
      "claude.ai was on " + labelForSurface(from) + " and this left it on the other one — " +
      "the Chat/Cowork choice is remembered for the whole account, so your next new tab will open there"
    );
  }

  // ---- addresses ---------------------------------------------------------

  // A Cowork session: /cowork/cse_<id>, where the id is emphatically not a uuid
  // (cse_011f5HCzaWWJ2hm19v6NuQmN). Everything in here that reaches for a
  // conversation id expects 36 hex-and-dashes, so this has to be its own arm.
  const SESSION_RE = /\/cowork\/(cse_[A-Za-z0-9_-]+)/;

  /** The session id in a Cowork address, or null. */
  function sessionId(href) {
    let path = str(href);
    try {
      path = new URL(path).pathname;
    } catch (e) {
      /* not absolute — treat what we were given as the path */
    }
    const m = path.match(SESSION_RE);
    return m ? m[1] : null;
  }

  /**
   * Where claude.ai's API keeps a conversation, given its id.
   *
   * The two shapes live in different places, which is not something the id
   * itself announces: an ordinary conversation is under `chat_conversations`,
   * while a Cowork session is under plain `conversations` — visible on the
   * `wiggle/list-files` call a session makes as it opens:
   *
   *   /api/organizations/<org>/conversations/cse_<id>/wiggle/list-files
   *
   * Returns null for an id of neither shape, so a caller can say "unavailable"
   * rather than send a request built around a guess.
   *
   * src/inject.js carries its own copy of this — it runs in the MAIN world and
   * can't see this module — and the two have to agree exactly.
   */
  function conversationApiPath(orgId, id) {
    const org = str(orgId);
    const conv = str(id);
    if (!org || !conv) return null;
    if (/^cse_[A-Za-z0-9_-]+$/.test(conv)) return "/api/organizations/" + org + "/conversations/" + conv;
    if (/^[0-9a-f-]{36}$/i.test(conv))
      return "/api/organizations/" + org + "/chat_conversations/" + conv;
    return null;
  }

  /** Whether an address is a Cowork one at all — session or project. */
  function isCoworkUrl(href) {
    let path = str(href);
    try {
      path = new URL(path).pathname;
    } catch (e) {
      /* not absolute */
    }
    return /^\/cowork(\/|$)/.test(path);
  }

  // ---- projects ----------------------------------------------------------

  /**
   * Whether a project row is the one named. Cowork's picker lists projects by
   * name only — there is no uuid on the row — so the name is all we have to go
   * on. Exact first, then a prefix, because a row can carry a badge or a
   * pinned marker after the name but never before it.
   */
  function projectRowMatches(rowText, name) {
    // Letters and digits, on both sides, for the reason the surface toggle
    // taught: this markup carries characters that no whitespace rule removes
    // and no report shows. A project's own punctuation is not the question —
    // the row and the stored name come from the same place and differ only in
    // what claude.ai has sprinkled through them.
    const want = squash(name);
    if (!want) return false;
    const t = squash(rowText);
    if (!t) return false;
    if (t === want) return true;
    return t.indexOf(want) === 0 && t.length - want.length < 25;
  }

  /** The name a project menu's trigger shows, or "" for the unset caption. */
  function projectTriggerName(text) {
    const t = squash(text);
    if (!t || t === "project" || t === "noproject" || t === "selectaproject") return "";
    return norm(text);
  }

  /** Whether a trigger's caption already names this project. */
  function projectTriggerIs(text, name) {
    const want = squash(name);
    return !!want && squash(text) === want;
  }

  // ---- a session's own menu ----------------------------------------------
  //
  // The control that opens it is labelled "More options for <the session's
  // current name>", which makes it two useful things at once: the door to the
  // Rename item, and a live reading of what the session is currently called.
  // The second is what lets a rename be CONFIRMED — the label changes — rather
  // than merely assumed because a dialog closed, which is as true of Cancel.
  const MORE_OPTIONS_RE = /^more\s+options\s+for\s+(.+)$/i;

  /** The session name inside "More options for X", or "" if that isn't one. */
  function nameFromMoreOptions(label) {
    const m = MORE_OPTIONS_RE.exec(norm(label));
    return m ? norm(m[1]) : "";
  }

  /** Whether a label is that control at all, whatever it currently names. */
  function isMoreOptionsLabel(label) {
    return MORE_OPTIONS_RE.test(norm(label));
  }

  /** Whether that control is now naming `name` — the proof a rename took. */
  function moreOptionsNames(label, name) {
    const want = squash(name);
    return !!want && squash(nameFromMoreOptions(label)) === want;
  }

  // The title itself is a rename control, and says so:
  //   aria-label="Riddle puzzle, rename session"
  // which is a door that needs no menu opened and no item matched — the two
  // steps that had been failing. The name is in there too, so this reads the
  // current title as well as offering to change it.
  const RENAME_SESSION_RE = /^(.*),\s*rename\s+session\s*$/i;

  /** Whether a label is the title's own rename control. */
  function isRenameSessionLabel(label) {
    return RENAME_SESSION_RE.test(norm(label));
  }

  /** The session name inside "<name>, rename session", or "". */
  function nameFromRenameSession(label) {
    const m = RENAME_SESSION_RE.exec(norm(label));
    return m ? norm(m[1]) : "";
  }

  /**
   * Whether either control now names `name` — the proof a rename took.
   * Both labels carry the title, so either one answering is enough.
   */
  function titleNames(label, name) {
    const want = squash(name);
    if (!want) return false;
    const from = nameFromMoreOptions(label) || nameFromRenameSession(label);
    return !!from && squash(from) === want;
  }

  /** Whether a menu row is the Rename one. Leading word only, as ever. */
  function isRenameRow(text) {
    return /^rename\b/.test(lower(text));
  }

  /**
   * Whether a caption is the menu's unset one — "Project" and its variants.
   *
   * SINGULAR only. "Projects" is the navigation entry in claude.ai's own left
   * sidebar, and accepting it sent a run to the projects page instead of into
   * its chat — a click that navigates is not a near miss of choosing a project,
   * it is the end of the run.
   */
  function isProjectTriggerCaption(text) {
    const t = squash(text);
    return (
      t === "project" ||
      t === "noproject" ||
      t === "selectaproject" ||
      t === "selectproject" ||
      t === "chooseproject" ||
      t === "chooseaproject" ||
      t === "addtoproject" ||
      t === "addtoaproject"
    );
  }

  // Rows that look like projects but aren't. Clicking either of these navigates
  // away, which for an unattended send is worse than not finding the project.
  const NOT_PROJECTS = ["create new project", "view all projects"];

  function isProjectRow(rowText) {
    const t = lower(rowText);
    if (!t) return false;
    return NOT_PROJECTS.indexOf(t) === -1;
  }

  // ---- the parallel send path --------------------------------------------
  //
  // Cowork is not Chat with a different address, and nothing built for Chat is
  // assumed to work here until it has been seen working here. The run that
  // taught this switched its model and then silently did nothing else — no
  // project chosen, no message sent — because the pieces after the model menu
  // were Chat plumbing being trusted on a surface that never confirmed them.
  // These are the decisions the Cowork send driver (src/cowork-composer.js)
  // runs on; the driver holds only the DOM wiring.

  /**
   * Which phases a Cowork send performs, in order. The composer home has the
   * surface toggle and the project menu; a page already inside a conversation
   * has neither, and asking for them there would be hunting for controls that
   * are not on the page.
   */
  function coworkPhases(job) {
    const j = job || {};
    const out = [];
    if (!j.onSession) out.push("surface");
    if (j.approval) out.push("approval");
    if (j.project && !j.onSession) out.push("project");
    if (j.model) out.push("model");
    if (j.files) out.push("attach");
    if (j.text) out.push("prompt");
    out.push("send");
    return out;
  }

  /**
   * Did the attachments actually land? Cowork's upload traffic runs inside a
   * worker the page hooks cannot see (the same blindness that makes its turn
   * end unknowable from the network), so upload confirmations MAY never arrive
   * and their absence proves nothing. The composer showing the files is the
   * evidence that exists: a chip per file, or the filenames themselves. Any
   * one source reaching the expected count is enough; none reaching it is a
   * send that must not go out — a prompt that says "the attached papers"
   * arriving bare sends anyway, and Claude answers plausibly from nothing.
   */
  function attachOutcome(ev) {
    const e = ev || {};
    const want = Math.max(0, Number(e.expected) || 0);
    if (!want) return { ok: true, why: "nothing to attach" };
    const uploads = Math.max(0, Number(e.uploads) || 0);
    const chips = Math.max(0, Number(e.chips) || 0);
    const named = Math.max(0, Number(e.named) || 0);
    if (uploads >= want) return { ok: true, why: uploads + " upload(s) confirmed" };
    if (chips >= want) return { ok: true, why: chips + " attachment chip(s) visible" };
    if (named >= want) return { ok: true, why: named + " filename(s) visible in the composer" };
    return {
      ok: false,
      why:
        "expected " + want + " attachment(s); saw " + uploads + " upload confirmation(s), " +
        chips + " chip(s), " + named + " filename(s)",
    };
  }

  /**
   * Whether a composer's visible text is carrying this filename. The failing
   * run put this beyond doubt: the files visibly attach on Cowork ("It adds
   * the files and then stops") while the upload confirmations and Chat's chip
   * markup both show nothing — so the name on screen is the evidence. Chips
   * truncate long names, so the stem or a leading slice is enough, but only at
   * eight characters or more: "a.txt" must appear whole, or an unrelated "a"
   * anywhere in the composer would vouch for it.
   */
  function nameSeen(text, name) {
    // Letters and digits only, on both sides — the surface toggle's lesson.
    // A live page held a chip whose name matched no raw substring test at
    // all: the characters claude.ai renders between the words are not the
    // characters the file was named with, and no report shows the difference.
    const t = squash(text);
    const n = squash(name);
    if (!t || !n) return false;
    if (t.indexOf(n) !== -1) return true;
    const stem = squash(str(name).replace(/\.[A-Za-z0-9]{1,8}$/, ""));
    if (stem.length >= 8 && t.indexOf(stem) !== -1) return true;
    // A truncated chip keeps the name's BEGINNING, so leading slices match in
    // either direction: the text carrying the name's first letters, or the
    // text itself being a first-slice of the name (an ellipsized caption
    // squashes to exactly that). Eight characters at least, and at least one
    // letter — a bare date or number is never distinctive enough to vouch for
    // a file, however long it is.
    const distinctive = (m) => m.length >= 8 && /[a-z]/.test(m);
    const prefix = n.slice(0, 12);
    if (distinctive(prefix) && t.indexOf(prefix) !== -1) return true;
    return distinctive(t) && t.length < n.length && n.indexOf(t) === 0;
  }

  /**
   * The proof a Cowork message actually left. /chat/ never appears in a Cowork
   * address, so the Chat driver's confirmation could never fire here; the
   * evidence that exists is the address becoming a session, a new human turn
   * mounting, the editor emptying, or the send control standing down — in that
   * order of strength. Returns the sentence naming the strongest evidence
   * seen, or "" for none.
   */
  function sentEvidence(ev) {
    const e = ev || {};
    if (e.becameSession) return "the address became a Cowork session";
    if (e.humanGrew) return "a new human turn appeared";
    if (e.cleared) return "the editor emptied";
    if (e.sendStoodDown) return "the send control stood down";
    return "";
  }

  /**
   * Whether the approval switch demonstrably took. The trigger's own
   * aria-label IS the mode in force, so it coming round to the wanted mode is
   * the page's word; the menu row marking itself checked is the same word said
   * earlier. A menu merely closing is neither — that is as true of Escape.
   */
  function approvalTook(ev, wanted) {
    const want = modeByKey(lower(wanted));
    if (!want) return false;
    const e = ev || {};
    if (modeFromLabel(e.triggerLabel) === want.key) return true;
    return !!e.rowChecked;
  }

  /** Whether two titles are the same name, letters and digits only — the
   * comparison that survives the invisible characters this markup carries. */
  function sameTitle(a, b) {
    const x = squash(a);
    return !!x && x === squash(b);
  }

  /** The name a conversation payload carries, or "". What a resumed step
   * checks before renaming: a title already the run's needs no second stamp. */
  function conversationName(conv) {
    return conv && typeof conv === "object" ? norm(conv.name) : "";
  }

  const api = {
    MODES,
    SURFACES,
    INHERIT,
    surfaceFromLabel,
    labelForSurface,
    describeSurface,
    surfaceOptions,
    reconcileSurface,
    surfaceFromEvidence,
    approvalApplies,
    surfaceLeftNote,
    modeFromLabel,
    labelForMode,
    describeMode,
    modeOptions,
    rowIsMode,
    reconcile,
    reconcileNote,
    sessionId,
    conversationApiPath,
    isCoworkUrl,
    projectRowMatches,
    projectTriggerName,
    projectTriggerIs,
    isProjectTriggerCaption,
    nameFromMoreOptions,
    isMoreOptionsLabel,
    moreOptionsNames,
    isRenameRow,
    isRenameSessionLabel,
    nameFromRenameSession,
    titleNames,
    isProjectRow,
    coworkPhases,
    attachOutcome,
    nameSeen,
    approvalTook,
    sentEvidence,
    sameTitle,
    conversationName,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMCowork = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
