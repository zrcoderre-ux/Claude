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

  // Surfaces this extension does not drive. An outage confined to one of these
  // must not warn on the pill or hold a send: the extension only ever types into
  // claude.ai. Kept deliberately narrow — anything unrecognised counts.
  const OFF_TOPIC_RE =
    /bedrock|vertex|foundry|sagemaker|azure|databricks|snowflake|console\.anthropic\.com|platform\.claude\.com|\b(console|workbench|dashboard|admin|billing|invoices?|docs|documentation|status\s*page|website|marketing)\b/i;

  function isOffTopic(name) {
    return OFF_TOPIC_RE.test(String(name || ""));
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
    if (snapshot.level === "ok") return "All systems operational";
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
