/**
 * Tests for src/status.js — the Claude service-status model (pure logic).
 * Run with: node --test test/status.test.js
 */
const assert = require("node:assert");
const { test } = require("node:test");
const S = require("../src/status.js");

const NOW = 1_800_000_000_000;

// A summary.json shaped like status.claude.com's (Atlassian Statuspage v2).
function summary(over) {
  return Object.assign(
    {
      page: { id: "abc", name: "Claude", url: "https://status.claude.com" },
      status: { indicator: "none", description: "All Systems Operational" },
      components: [
        { id: "c1", name: "Claude.ai", status: "operational" },
        { id: "c2", name: "Claude Code", status: "operational" },
        { id: "c3", name: "api.anthropic.com", status: "operational" },
        { id: "c4", name: "console.anthropic.com", status: "operational" },
        { id: "c5", name: "Claude on Bedrock", status: "operational" },
        { id: "c6", name: "Claude on Vertex", status: "operational" },
      ],
      incidents: [],
      scheduled_maintenances: [],
    },
    over || {}
  );
}

function comp(name, status) {
  const s = summary();
  s.components = s.components.map((c) => (c.name === name ? Object.assign({}, c, { status }) : c));
  return s;
}

test("an all-clear page is ok and blocks nothing", () => {
  const snap = S.parseSummary(summary(), NOW);
  assert.equal(snap.ok, true);
  assert.equal(snap.level, "ok");
  assert.equal(snap.blocking, false);
  assert.equal(snap.affected.length, 0);
  assert.equal(S.shortLabel(snap), "All systems operational");
  assert.equal(S.holdDecision(snap, { now: NOW }).hold, false);
});

test("degraded performance warns but does not hold a send", () => {
  const snap = S.parseSummary(comp("Claude.ai", "degraded_performance"), NOW);
  assert.equal(snap.level, "minor");
  assert.equal(snap.blocking, false);
  assert.equal(S.shortLabel(snap), "Claude.ai degraded");
  assert.equal(S.holdDecision(snap, { now: NOW }).hold, false);
});

test("a major outage holds a send and names the component", () => {
  const snap = S.parseSummary(comp("Claude.ai", "major_outage"), NOW);
  assert.equal(snap.level, "critical");
  assert.equal(snap.blocking, true);
  const gate = S.holdDecision(snap, { now: NOW });
  assert.equal(gate.hold, true);
  assert.match(gate.reason, /Claude\.ai major outage/);
});

test("a partial outage holds too", () => {
  const snap = S.parseSummary(comp("Claude Code", "partial_outage"), NOW);
  assert.equal(snap.level, "major");
  assert.equal(snap.blocking, true);
});

test("maintenance on a component we drive holds the send", () => {
  const snap = S.parseSummary(comp("Claude.ai", "under_maintenance"), NOW);
  assert.equal(snap.level, "maintenance");
  assert.equal(snap.blocking, true);
  assert.equal(S.shortLabel(snap), "Claude.ai under maintenance");
});

test("an outage confined to a surface we never drive is ignored", () => {
  // Bedrock / Vertex / the developer console are not how the extension sends —
  // and the page's blended indicator goes red for them, so this is exactly the
  // case that must not hold a claude.ai send.
  for (const name of ["Claude on Bedrock", "Claude on Vertex", "console.anthropic.com"]) {
    const s = comp(name, "major_outage");
    s.status = { indicator: "critical", description: "Major Service Outage" };
    const snap = S.parseSummary(s, NOW);
    assert.equal(snap.level, "ok", name + " should not raise our level");
    assert.equal(snap.blocking, false, name + " should not hold a send");
  }
});

test("api.anthropic.com is NOT excluded — claude.ai rides the same serving layer", () => {
  const snap = S.parseSummary(comp("api.anthropic.com", "major_outage"), NOW);
  assert.equal(snap.blocking, true);
});

test("component groups are skipped so a name is never counted twice", () => {
  const s = summary();
  s.components = [
    { id: "g", name: "Claude", status: "major_outage", group: true, components: ["c1"] },
    { id: "c1", name: "Claude.ai", status: "major_outage" },
  ];
  const snap = S.parseSummary(s, NOW);
  assert.equal(snap.affected.length, 1);
  assert.equal(snap.affected[0].name, "Claude.ai");
});

test("an unresolved incident with no component mapping is page-wide and holds", () => {
  const s = summary({
    status: { indicator: "major", description: "Partial System Outage" },
    incidents: [
      {
        id: "i1",
        name: "Elevated errors on message send",
        status: "investigating",
        impact: "major",
        components: [],
        started_at: "2027-01-15T10:00:00Z",
        shortlink: "https://stspg.io/x",
        incident_updates: [{ body: "We are investigating.", created_at: "2027-01-15T10:01:00Z" }],
      },
    ],
  });
  const snap = S.parseSummary(s, NOW);
  assert.equal(snap.level, "major");
  assert.equal(snap.blocking, true);
  assert.equal(snap.incidents.length, 1);
  assert.equal(snap.incidents[0].latest, "We are investigating.");
  assert.equal(S.shortLabel(snap), "Elevated errors on message send");
});

test("an incident naming only off-topic components is somebody else's outage", () => {
  const s = summary({
    status: { indicator: "major", description: "Partial System Outage" },
    incidents: [
      {
        id: "i1",
        name: "Bedrock capacity",
        status: "identified",
        impact: "major",
        components: [{ id: "c5", name: "Claude on Bedrock" }],
      },
    ],
  });
  const snap = S.parseSummary(s, NOW);
  assert.equal(snap.incidents.length, 0);
  assert.equal(snap.blocking, false);
});

test("a resolved incident is not a signal", () => {
  const s = summary({
    incidents: [{ id: "i1", name: "Old thing", status: "resolved", impact: "critical" }],
  });
  assert.equal(S.parseSummary(s, NOW).level, "ok");
});

test("an in-progress maintenance holds; a merely scheduled one does not", () => {
  const inProgress = summary({
    scheduled_maintenances: [
      {
        id: "m1",
        name: "Database upgrade",
        status: "in_progress",
        components: [{ id: "c1", name: "Claude.ai" }],
        scheduled_for: "2027-01-15T10:00:00Z",
        scheduled_until: "2027-01-15T12:00:00Z",
      },
    ],
  });
  const a = S.parseSummary(inProgress, NOW);
  assert.equal(a.level, "maintenance");
  assert.equal(a.blocking, true);
  assert.equal(a.maintenances.length, 1);

  const scheduled = summary({
    scheduled_maintenances: [
      { id: "m1", name: "Database upgrade", status: "scheduled", components: [] },
    ],
  });
  const b = S.parseSummary(scheduled, NOW);
  assert.equal(b.level, "ok");
  assert.equal(b.blocking, false);
  assert.equal(b.upcoming.length, 1);
  assert.deepEqual(S.detailLines(b), ["All Systems Operational", "Upcoming: Database upgrade"]);
});

test("the page indicator is trusted when nothing of ours explains it", () => {
  // A schema change (no components we recognise) must not read as "all clear".
  const s = summary({
    status: { indicator: "critical", description: "Major Service Outage" },
    components: [],
  });
  const snap = S.parseSummary(s, NOW);
  assert.equal(snap.level, "critical");
  assert.equal(snap.blocking, true);

  // Components all green and the page says so too → still ok.
  const clean = S.parseSummary(summary(), NOW);
  assert.equal(clean.level, "ok");
});

test("an unreadable status page warns about nothing and holds nothing", () => {
  const snap = S.unknown("HTTP 503", NOW);
  assert.equal(snap.ok, false);
  assert.equal(snap.level, "unknown");
  assert.equal(snap.blocking, false);
  assert.equal(S.holdDecision(snap, { now: NOW }).hold, false);
  assert.equal(S.rank("unknown"), 0);
  assert.equal(S.shortLabel(snap), "Status unavailable");
});

test("holdDecision: the gate can be switched off, and Run now always overrides", () => {
  const snap = S.parseSummary(comp("Claude.ai", "major_outage"), NOW);
  assert.equal(S.holdDecision(snap, { enabled: false, now: NOW }).hold, false);
  assert.equal(S.holdDecision(snap, { force: true, now: NOW }).hold, false);
});

test("holdDecision: a job sends anyway once it has waited out the ceiling", () => {
  const snap = S.parseSummary(comp("Claude.ai", "major_outage"), NOW);
  const heldSince = NOW - S.MAX_HOLD_MS + 1000;
  const still = S.holdDecision(snap, { heldSince, now: NOW });
  assert.equal(still.hold, true);
  assert.equal(still.expired, false);

  const past = S.holdDecision(snap, { heldSince: NOW - S.MAX_HOLD_MS - 1, now: NOW });
  assert.equal(past.hold, false);
  assert.equal(past.expired, true);
  assert.ok(past.reason, "an expired hold still explains itself in the job's note");
  assert.ok(past.waitedMs > S.MAX_HOLD_MS);
});

test("holdDecision: a first hold reports zero waited so heldSince can be stamped", () => {
  const snap = S.parseSummary(comp("Claude.ai", "major_outage"), NOW);
  const first = S.holdDecision(snap, { now: NOW });
  assert.equal(first.hold, true);
  assert.equal(first.waitedMs, 0);
});

test("worse() ranks maintenance above degraded but below an outage", () => {
  assert.equal(S.worse("ok", "minor"), "minor");
  assert.equal(S.worse("minor", "maintenance"), "maintenance");
  assert.equal(S.worse("maintenance", "major"), "major");
  assert.equal(S.worse("critical", "major"), "critical");
  assert.equal(S.worse("ok", null), "ok");
});

test("detailLines leads with the incident, then maintenance, then components", () => {
  const s = summary({
    status: { indicator: "major", description: "Partial System Outage" },
    incidents: [{ id: "i1", name: "Send failures", status: "identified", impact: "major" }],
  });
  s.components = s.components.map((c) =>
    c.name === "Claude.ai" ? Object.assign({}, c, { status: "partial_outage" }) : c
  );
  const lines = S.detailLines(S.parseSummary(s, NOW));
  assert.equal(lines[0], "Send failures · identified");
  assert.ok(lines.includes("Claude.ai · partial outage"));
});

test("isStale measures against the reading's own timestamp", () => {
  const snap = S.parseSummary(summary(), NOW);
  assert.equal(S.isStale(snap, NOW + 1000, 60_000), false);
  assert.equal(S.isStale(snap, NOW + 61_000, 60_000), true);
  assert.equal(S.isStale(null, NOW, 60_000), true);
});

test("isDuePoll measures the last ATTEMPT, so a down status page isn't retried in a loop", () => {
  // A reading kept alive across a failed poll: the data is old (fetchedAt), but
  // we just tried (checkedAt). It should be distrusted and NOT immediately
  // re-fetched — otherwise every worker start hammers the status page.
  const kept = Object.assign({}, S.parseSummary(summary(), NOW), {
    error: "HTTP 503",
    checkedAt: NOW + 10 * 60_000,
  });
  const now = NOW + 10 * 60_000 + 1000;
  assert.equal(S.isStale(kept, now, 60_000), true, "the data is old");
  assert.equal(S.isDuePoll(kept, now, 5 * 60_000), false, "but we just checked");
  assert.equal(S.isDuePoll(kept, NOW + 16 * 60_000, 5 * 60_000), true);
  // A fresh reading sets both, so the two agree.
  const fresh = S.parseSummary(summary(), NOW);
  assert.equal(fresh.checkedAt, fresh.fetchedAt);
  assert.equal(S.isDuePoll(null, NOW, 60_000), true);
  // An older stored snapshot with no checkedAt falls back to fetchedAt.
  assert.equal(S.isDuePoll({ fetchedAt: NOW }, NOW + 61_000, 60_000), true);
  assert.equal(S.isDuePoll({ fetchedAt: NOW }, NOW + 1000, 60_000), false);
});

test("fmtWaited reads as a duration", () => {
  assert.equal(S.fmtWaited(45_000), "45s");
  assert.equal(S.fmtWaited(9 * 60_000), "9m");
  assert.equal(S.fmtWaited(2 * 3600_000 + 5 * 60_000), "2h 05m");
});

test("isOffTopic keeps the surfaces we drive and drops the ones we don't", () => {
  for (const n of ["Claude.ai", "Claude Code", "api.anthropic.com", "Claude Chat"]) {
    assert.equal(S.isOffTopic(n), false, n);
  }
  for (const n of [
    "Claude on Bedrock",
    "Claude on Vertex AI",
    "console.anthropic.com",
    "Anthropic Console",
    "Developer Docs",
  ]) {
    assert.equal(S.isOffTopic(n), true, n);
  }
});

test("a malformed payload degrades to ok rather than throwing", () => {
  for (const bad of [null, undefined, {}, { components: null }, { components: [null, {}] }]) {
    const snap = S.parseSummary(bad, NOW);
    assert.equal(snap.ok, true);
    assert.equal(snap.blocking, false);
  }
});
