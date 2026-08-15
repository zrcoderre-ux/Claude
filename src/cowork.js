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
    const want = lower(name);
    if (!want) return false;
    const t = lower(rowText);
    if (!t) return false;
    if (t === want) return true;
    return t.indexOf(want) === 0 && t.length - want.length < 25;
  }

  // Rows that look like projects but aren't. Clicking either of these navigates
  // away, which for an unattended send is worse than not finding the project.
  const NOT_PROJECTS = ["create new project", "view all projects"];

  function isProjectRow(rowText) {
    const t = lower(rowText);
    if (!t) return false;
    return NOT_PROJECTS.indexOf(t) === -1;
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
    isProjectRow,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMCowork = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
