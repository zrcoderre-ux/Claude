/**
 * Claude Usage Meter — pure usage-log helpers (shared by content.js, options.js,
 * and the test suite). No DOM/chrome APIs, so it's directly unit-testable.
 *
 * A log entry: { at: epochMs, type: "hit100" | "reset", percent: number }
 *   - "hit100": the moment the 5-hour session utilization reached 100%.
 *   - "reset":  the 5-hour window rolled over; `percent` is the utilization at
 *     that moment (how much of the window you'd used when it reset).
 */
(function (root) {
  "use strict";

  const DEFAULT_MAX_ENTRIES = 1000; // cap so the log can't grow unbounded
  const RESET_DEDUP_MS = 10 * 60 * 1000; // resets within 10 min are the same reset

  // Append an entry, keeping only the most recent `max` entries.
  function addEntry(entries, entry, max) {
    const cap = max || DEFAULT_MAX_ENTRIES;
    const next = (entries || []).concat([entry]);
    return next.length > cap ? next.slice(next.length - cap) : next;
  }

  function latestAt(log, type) {
    let t = null;
    for (const e of log || []) if (e && e.type === type && (t == null || e.at > t)) t = e.at;
    return t;
  }

  // Would `entry` duplicate something already in `log`? Content-based (not a
  // per-tab flag) so multiple open tabs / reloads can't each add their own copy.
  //   - reset:  a reset already recorded within RESET_DEDUP_MS (real resets are
  //     hours apart; the 5-hour window's resets_at jitters/creeps by minutes).
  //   - hit100: a hit100 already stands open for this session — i.e. the latest
  //     hit100 has no reset after it. Only a genuine reset re-arms the next one.
  function isDuplicate(log, entry) {
    if (!entry) return true;
    if (entry.type === "reset") {
      return (log || []).some(
        (e) => e && e.type === "reset" && Math.abs(e.at - entry.at) < RESET_DEDUP_MS
      );
    }
    if (entry.type === "hit100") {
      const lastHit = latestAt(log, "hit100");
      if (lastHit == null) return false;
      const lastReset = latestAt(log, "reset");
      return lastReset == null || lastHit > lastReset;
    }
    return false;
  }

  // Collapse duplicates out of an existing log (one-time cleanup on load).
  function dedupe(log) {
    const sorted = (log || []).slice().sort((a, b) => a.at - b.at);
    const out = [];
    for (const e of sorted) if (!isDuplicate(out, e)) out.push(e);
    return out;
  }

  function csvEscape(value) {
    if (value == null) return "";
    const s = String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsvRow(fields) {
    return fields.map(csvEscape).join(",");
  }

  // rows: array of arrays (already-formatted cell values). header: array of
  // column names, or omit for a headerless body.
  function buildCsv(rows, header) {
    const lines = [];
    if (header) lines.push(toCsvRow(header));
    for (const r of rows) lines.push(toCsvRow(r));
    return lines.join("\r\n") + "\r\n";
  }

  const EVENT_LABELS = { hit100: "Hit 100%", reset: "Window reset" };

  function eventLabel(type) {
    return EVENT_LABELS[type] || type;
  }

  const api = {
    addEntry, csvEscape, toCsvRow, buildCsv, eventLabel, isDuplicate, dedupe,
    DEFAULT_MAX_ENTRIES, RESET_DEDUP_MS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMLog = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
