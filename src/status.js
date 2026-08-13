/**
 * Claude Usage Meter — Claude service-status model (pure, testable).
 *
 * Reads https://status.claude.com/api/v2/summary.json (an Atlassian Statuspage,
 * so the schema is the documented v2 one) and boils it down to a single verdict
 * the rest of the extension can act on:
 *
 *   - the pill shows a warning while Claude is degraded or down, and
 *   - a scheduled send HOLDS instead of firing into an outage.
 *
 * Two decisions carry most of the weight here.
 *
 * **What counts as "down".** The page's own blended `status.indicator` covers
 * every surface Anthropic publishes, including ones this extension never
 * touches — Bedrock, Vertex, the developer console. A Bedrock-only outage must
 * not hold a claude.ai send, so relevance is decided per component
 * (`isOffTopic`) and the page indicator is only trusted when our own components
 * look clean AND no excluded component explains the page's verdict (a schema
 * change must never read as "all clear"). api.anthropic.com is deliberately NOT
 * excluded: claude.ai rides the same serving layer, and holding a send through a
 * model outage is the conservative, recoverable mistake.
 *
 * **Warn vs hold.** `minor` (degraded performance, a low-impact incident) warns
 * only — Claude still answers, so blocking a send would cost more than it saves.
 * `major`/`critical`/`under_maintenance` block, because a send driven through
 * the real UI has nothing to fall back on. An unreachable status page is
 * `unknown` and blocks NOTHING (fail open) — the meter must not become a second
 * way for a send to silently not happen.
 *
 * No chrome/DOM deps, so this unit-tests directly under Node and is shared by
 * the service worker, the content script, the popup, and the options page.
 */
(function (root) {
  "use strict";

  const STATUS_PAGE_URL = "https://status.claude.com/";
  const SUMMARY_URL = "https://status.claude.com/api/v2/summary.json";

  // Severity ladder, best → worst. `maintenance` outranks `minor` because a
  // component under maintenance is deliberately unavailable, where "degraded"
  // still serves traffic. `unknown` (the status page itself unreachable) sits at
  // the bottom so it can never warn or block.
  const RANK = { unknown: 0, ok: 0, minor: 1, maintenance: 2, major: 3, critical: 4 };
  const BLOCKING_RANK = RANK.maintenance; // this rank and worse hold a send

  // How long a job may sit waiting before it goes out anyway. A queued send that
  // never leaves is its own failure, so the hold has a floor: after this the job
  // fires and carries a note saying how long it waited.
  const MAX_HOLD_MS = 6 * 60 * 60 * 1000;

  const COMPONENT_LEVEL = {
    operational: "ok",
    degraded_performance: "minor",
    partial_outage: "major",
    major_outage: "critical",
    under_maintenance: "maintenance",
  };

  const COMPONENT_TEXT = {
    operational: "operational",
    degraded_performance: "degraded",
    partial_outage: "partial outage",
    major_outage: "major outage",
    under_maintenance: "under maintenance",
  };

  const INDICATOR_LEVEL = {
    none: "ok",
    minor: "minor",
    major: "major",
    critical: "critical",
    maintenance: "maintenance",
  };

  // An incident that is still open is never "ok", so impact `none` maps to minor.
  const IMPACT_LEVEL = {
    none: "minor",
    maintenance: "maintenance",
    minor: "minor",
    major: "major",
    critical: "critical",
  };

  const INCIDENT_CLOSED = { resolved: true, postmortem: true };

  // Statuspage's own all-clear wording, used when the page didn't send one.
  const ALL_CLEAR = "All Systems Operational";

  // Surfaces this extension does not drive. An outage confined to one of these
  // must not warn on the pill or hold a send: the extension only ever types into
  // claude.ai. Kept deliberately narrow — anything unrecognised counts.
  const OFF_TOPIC_RE =
    /bedrock|vertex|foundry|sagemaker|azure|databricks|snowflake|console\.anthropic\.com|platform\.claude\.com|\b(console|workbench|dashboard|admin|billing|invoices?|docs|documentation|status\s*page|website|marketing)\b/i;

  function isOffTopic(name) {
    return OFF_TOPIC_RE.test(String(name || ""));
  }

  // ---- which models an incident is about ----------------------------------
  //
  // The status page has no component per model — its components are surfaces
  // (Claude.ai, Claude Code, api.anthropic.com), and which MODEL is in trouble
  // is said in the incident's title and its updates: "Elevated errors for Claude
  // Opus 4.5", "Sonnet degraded". So that is where this reads it from.
  //
  // Deliberately conservative in one direction. Finding no model named means
  // the incident is about everything, which holds a run exactly as it does
  // today — the failure of this parser is a run that waits when it needn't,
  // never a run that sends into an outage it should have waited out.
  const FAMILIES = "opus|sonnet|haiku|fable";
  // "Opus 4.5", "Claude Sonnet 4", "Haiku 4.5", or a bare family name. The
  // version is optional because an incident often names only the family.
  // The version may be written "4.5" in prose or "4-5" in an api id
  // (claude-opus-4-5), so both are read and normalised to the dotted form.
  const MODEL_RE = new RegExp(
    "\\b(?:claude[\\s-]+)?(" + FAMILIES + ")(?:[\\s-]+(\\d+(?:[.-]\\d+)?))?\\b",
    "gi"
  );
  function version(raw) {
    return raw ? String(raw).replace("-", ".") : null;
  }

  // A model as this compares them: family, and version where one was given.
  // "Claude Opus 4.5" and "opus 4.5" are the same model; "Opus" and "Opus 4.5"
  // are the same FAMILY, which is what an incident naming only the family means.
  function modelKey(text) {
    MODEL_RE.lastIndex = 0;
    const m = MODEL_RE.exec(String(text == null ? "" : text));
    if (!m) return null;
    return { family: m[1].toLowerCase(), version: version(m[2]) };
  }

  // Every model named in a piece of text.
  function modelsIn(text) {
    const out = [];
    const seen = Object.create(null);
    const str_ = String(text == null ? "" : text);
    MODEL_RE.lastIndex = 0;
    let m;
    while ((m = MODEL_RE.exec(str_))) {
      const key = m[1].toLowerCase() + "|" + (version(m[2]) || "");
      if (seen[key]) continue;
      seen[key] = true;
      out.push({ family: m[1].toLowerCase(), version: version(m[2]) });
    }
    return out;
  }

  // Does an incident about `named` cover the model you are about to use?
  //
  // A version named on either side has to agree; a family named without one
  // covers every version of it, which is what "Sonnet is degraded" means. And
  // an incident that named no model at all covers everything — see above.
  function modelAffected(named, mine) {
    if (!named || !named.length) return true; // about everything
    if (!mine) return true; // we don't know what we'd be using, so assume the worst
    for (const n of named) {
      if (n.family !== mine.family) continue;
      if (!n.version || !mine.version) return true; // family-wide either way
      if (n.version === mine.version) return true;
    }
    return false;
  }

  function rank(level) {
    const r = RANK[level];
    return typeof r === "number" ? r : 0;
  }

  function worse(a, b) {
    if (!b) return a || "ok";
    if (!a) return b;
    return rank(b) > rank(a) ? b : a;
  }

  function ms(iso) {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  }

  function clip(s, n) {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1).trim() + "…" : t;
  }

  // ---- Parsing ------------------------------------------------------------

  // Statuspage lists groups alongside their children; a group's status is just
  // the worst of its children, so counting it would only duplicate a name.
  function readComponents(json, keepOffTopic) {
    const out = [];
    for (const c of (json && json.components) || []) {
      if (!c || c.group) continue;
      const name = String(c.name || "").trim();
      if (!name) continue;
      const off = isOffTopic(name);
      if (off && !keepOffTopic) continue;
      const status = String(c.status || "operational").toLowerCase();
      out.push({
        id: c.id || null,
        name,
        status,
        level: COMPONENT_LEVEL[status] || "ok",
        offTopic: off,
      });
    }
    return out;
  }

  function readIncidents(json, keepOffTopic) {
    const out = [];
    for (const i of (json && json.incidents) || []) {
      if (!i) continue;
      const status = String(i.status || "").toLowerCase();
      if (INCIDENT_CLOSED[status]) continue;
      const names = ((i && i.components) || [])
        .map((c) => String((c && c.name) || "").trim())
        .filter(Boolean);
      // An incident with no component mapping is page-wide — keep it. One that
      // names only off-topic components is somebody else's outage.
      const off = !!names.length && !names.some((n) => !isOffTopic(n));
      if (off && !keepOffTopic) continue;
      const impact = String(i.impact || "none").toLowerCase();
      const updates = (i.incident_updates || []).filter(Boolean);
      out.push({
        id: i.id || null,
        name: clip(i.name, 90) || "Incident",
        status,
        impact,
        level: IMPACT_LEVEL[impact] || "minor",
        url: i.shortlink || STATUS_PAGE_URL,
        startedAt: ms(i.started_at || i.created_at),
        updatedAt: ms(i.updated_at),
        components: names,
        offTopic: off,
        // Statuspage returns updates newest-first.
        latest: updates.length ? clip(updates[0].body, 220) : null,
      });
    }
    return out;
  }

  function readMaintenances(json, keepOffTopic) {
    const out = [];
    for (const m of (json && json.scheduled_maintenances) || []) {
      if (!m) continue;
      const status = String(m.status || "").toLowerCase();
      if (INCIDENT_CLOSED[status] || status === "completed") continue;
      const names = ((m && m.components) || [])
        .map((c) => String((c && c.name) || "").trim())
        .filter(Boolean);
      const off = !!names.length && !names.some((n) => !isOffTopic(n));
      if (off && !keepOffTopic) continue;
      out.push({
        id: m.id || null,
        name: clip(m.name, 90) || "Scheduled maintenance",
        status,
        url: m.shortlink || STATUS_PAGE_URL,
        startsAt: ms(m.scheduled_for),
        endsAt: ms(m.scheduled_until),
        components: names,
        offTopic: off,
      });
    }
    return out;
  }

  // Does something we deliberately ignore account for a red page indicator? A
  // Bedrock outage — as a component status, an incident, or a maintenance —
  // raises the page's blended verdict, and that must not hold a claude.ai send.
  function offTopicTrouble(json) {
    if (readComponents(json, true).some((c) => c.offTopic && c.level !== "ok")) return true;
    if (readIncidents(json, true).some((i) => i.offTopic)) return true;
    return readMaintenances(json, true).some(
      (m) => m.offTopic && (m.status === "in_progress" || m.status === "verifying")
    );
  }

  function worstOf(list) {
    let best = null;
    for (const x of list || []) {
      if (!best || rank(x.level) > rank(best.level)) best = x;
    }
    return best;
  }

  /**
   * Normalise a summary.json payload into the snapshot everything else reads.
   * `now` is injectable for tests.
   */
  // The models an outage is about, taken from what the incidents SAY.
  //
  // null means "not model-specific" — either nothing named a model, or
  // something that is blocking named none, in which case the outage is about
  // everything until told otherwise. Only when every blocking incident names
  // models is the outage narrowed to them.
  //
  // Components are not consulted on purpose: they are surfaces, and a surface
  // being degraded is how a model incident SHOWS. Reading "Claude.ai: degraded"
  // as "no model named" would mean no outage was ever model-specific.
  function outageModels(incidents, maintenances) {
    const blocking = (incidents || [])
      .concat(maintenances || [])
      .filter((x) => x && rank(x.level) >= BLOCKING_RANK);
    if (!blocking.length) return null;
    const all = [];
    const seen = Object.create(null);
    for (const b of blocking) {
      const named = modelsIn(
        [b.name, b.latest, (b.components || []).join(" ")].filter(Boolean).join(" — ")
      );
      if (!named.length) return null; // one blocking thing about everything is enough
      for (const m of named) {
        const key = m.family + "|" + (m.version || "");
        if (seen[key]) continue;
        seen[key] = true;
        all.push(m);
      }
    }
    return all.length ? all : null;
  }

  function parseSummary(json, now) {
    const at = typeof now === "number" ? now : Date.now();
    const components = readComponents(json, false);
    const incidents = readIncidents(json, false);
    const allMaint = readMaintenances(json, false);
    const maintenances = allMaint.filter(
      (m) => m.status === "in_progress" || m.status === "verifying"
    );
    const upcoming = allMaint.filter((m) => m.status === "scheduled");

    let level = "ok";
    for (const c of components) level = worse(level, c.level);
    for (const i of incidents) level = worse(level, i.level);
    if (maintenances.length) level = worse(level, "maintenance");

    const indicator =
      String((json && json.status && json.status.indicator) || "").toLowerCase() || null;
    const description = (json && json.status && json.status.description) || null;
    const pageLevel = INDICATOR_LEVEL[indicator] || null;

    // Nothing of ours looks wrong, yet the page says otherwise. Trust the page —
    // unless something excluded accounts for it (a Bedrock outage raises the
    // blended indicator and is none of our business). When the schema moves and
    // we recognise nothing at all, the indicator is all we have, and a page
    // reading "Major Service Outage" must never come out as "all clear".
    if (rank(level) === 0 && pageLevel && rank(pageLevel) > 0 && !offTopicTrouble(json)) {
      level = pageLevel;
    }

    const affected = components.filter((c) => c.level !== "ok");
    return {
      ok: true,
      // Which models this outage is about, or null for "we can't tell, so all
      // of them". See outageModels — the null is what keeps a parser that
      // learns nothing from letting a run send into an outage.
      models: outageModels(incidents, maintenances),
      // fetchedAt is the age of the DATA; checkedAt is when we last tried. They
      // diverge when a reading is kept alive across a failed poll (see the
      // caller's grace window), which is what keeps a retry loop from spinning.
      fetchedAt: at,
      checkedAt: at,
      indicator,
      description,
      level,
      blocking: rank(level) >= BLOCKING_RANK,
      components,
      affected,
      incidents,
      maintenances,
      upcoming,
    };
  }

  /**
   * The snapshot for "we could not read the status page". Deliberately warns
   * about nothing and blocks nothing.
   */
  function unknown(error, now) {
    const at = typeof now === "number" ? now : Date.now();
    return {
      ok: false,
      fetchedAt: at,
      checkedAt: at,
      error: clip(error, 160) || "status unavailable",
      indicator: null,
      description: null,
      level: "unknown",
      blocking: false,
      components: [],
      affected: [],
      incidents: [],
      maintenances: [],
      upcoming: [],
    };
  }

  /** Is the DATA older than maxAgeMs? Use this to decide whether to trust it. */
  function isStale(snapshot, now, maxAgeMs) {
    if (!snapshot || typeof snapshot.fetchedAt !== "number") return true;
    const t = typeof now === "number" ? now : Date.now();
    return t - snapshot.fetchedAt >= (maxAgeMs == null ? 5 * 60 * 1000 : maxAgeMs);
  }

  /**
   * Is it time to POLL again? Measured from the last attempt, not the last
   * success — otherwise a status page that's down makes every caller retry
   * immediately, forever.
   */
  function isDuePoll(snapshot, now, everyMs) {
    if (!snapshot) return true;
    const last =
      typeof snapshot.checkedAt === "number"
        ? snapshot.checkedAt
        : typeof snapshot.fetchedAt === "number"
        ? snapshot.fetchedAt
        : null;
    if (last == null) return true;
    const t = typeof now === "number" ? now : Date.now();
    return t - last >= (everyMs == null ? 5 * 60 * 1000 : everyMs);
  }

  // ---- Labelling ----------------------------------------------------------

  /** A short pill-sized phrase for the current state. */
  function shortLabel(snapshot) {
    if (!snapshot) return "Status unknown";
    if (!snapshot.ok) return "Status unavailable";
    // All clear: prefer the page's OWN wording ("All Systems Operational") so the
    // panel reads exactly as status.claude.com does, rather than paraphrasing it.
    if (snapshot.level === "ok") return clip(snapshot.description, 42) || ALL_CLEAR;
    const comp = worstOf(snapshot.affected);
    if (comp && rank(comp.level) >= rank(snapshot.level)) {
      return clip(comp.name, 28) + " " + (COMPONENT_TEXT[comp.status] || comp.status);
    }
    const inc = worstOf(snapshot.incidents);
    if (inc && rank(inc.level) >= rank(snapshot.level)) return clip(inc.name, 42);
    if (snapshot.maintenances.length) return "Maintenance in progress";
    if (comp) return clip(comp.name, 28) + " " + (COMPONENT_TEXT[comp.status] || comp.status);
    if (inc) return clip(inc.name, 42);
    return clip(snapshot.description, 42) || "Service disruption";
  }

  /** Lines for the detail panel / notification body, most important first. */
  function detailLines(snapshot) {
    if (!snapshot) return [];
    if (!snapshot.ok) return [snapshot.error || "Could not reach status.claude.com"];
    const lines = [];
    for (const i of snapshot.incidents) {
      lines.push(i.name + (i.status ? " · " + i.status : ""));
    }
    for (const m of snapshot.maintenances) lines.push(m.name + " · maintenance");
    for (const c of snapshot.affected) {
      lines.push(c.name + " · " + (COMPONENT_TEXT[c.status] || c.status));
    }
    if (!lines.length && snapshot.description) lines.push(snapshot.description);
    for (const m of snapshot.upcoming) lines.push("Upcoming: " + m.name);
    return lines;
  }

  // ---- The send gate ------------------------------------------------------

  /**
   * Should a scheduled send wait? `opts`:
   *   enabled    — false disables the gate entirely (the popup toggle)
   *   force      — true for an explicit "Run now" (the operator overrides)
   *   heldSince  — when this job first went on hold, for the MAX_HOLD_MS floor
   *   now, maxHoldMs — injectable for tests
   *
   * Returns { hold, reason, waitedMs, expired }. `expired` means the job waited
   * out the ceiling and should go now, with `waitedMs` worth of explaining.
   */
  function holdDecision(snapshot, opts) {
    const o = opts || {};
    const now = typeof o.now === "number" ? o.now : Date.now();
    const none = { hold: false, reason: null, waitedMs: null, expired: false };
    if (o.enabled === false || o.force) return none;
    if (!snapshot || !snapshot.ok || !snapshot.blocking) return none;
    // An outage confined to models you aren't using is somebody else's outage.
    // `models` is null wherever that can't be established, so this only ever
    // releases a hold on a positive statement about what is broken.
    if (o.model && snapshot.models && !modelAffected(snapshot.models, o.model))
      return Object.assign({}, none, { spared: describeModels(snapshot.models) });
    const reason = shortLabel(snapshot);
    if (typeof o.heldSince === "number") {
      const waited = now - o.heldSince;
      const ceiling = o.maxHoldMs == null ? MAX_HOLD_MS : o.maxHoldMs;
      if (waited >= ceiling) {
        return { hold: false, reason, waitedMs: waited, expired: true };
      }
      return { hold: true, reason, waitedMs: waited, expired: false };
    }
    return { hold: true, reason, waitedMs: 0, expired: false };
  }

  // "Opus 4.5", "Sonnet and Haiku 4.5" — for saying why a run wasn't held.
  function describeModels(models) {
    const names = (models || []).map((m) =>
      m.family.charAt(0).toUpperCase() + m.family.slice(1) + (m.version ? " " + m.version : "")
    );
    if (!names.length) return "";
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  }

  /** "2h 05m" — for the held-job badge and the sent-anyway note. */
  function fmtWaited(ms_) {
    if (ms_ == null || ms_ < 0) return "";
    const total = Math.floor(ms_ / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m";
    if (m > 0) return m + "m";
    return total + "s";
  }

  const api = {
    STATUS_PAGE_URL,
    SUMMARY_URL,
    RANK,
    BLOCKING_RANK,
    MAX_HOLD_MS,
    COMPONENT_LEVEL,
    COMPONENT_TEXT,
    INDICATOR_LEVEL,
    isOffTopic,
    modelKey,
    modelsIn,
    modelAffected,
    describeModels,
    outageModels,
    rank,
    worse,
    worstOf,
    parseSummary,
    unknown,
    isStale,
    isDuePoll,
    shortLabel,
    detailLines,
    holdDecision,
    fmtWaited,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMStatus = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
