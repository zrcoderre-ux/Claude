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

  // Append an entry, keeping only the most recent `max` entries.
  function addEntry(entries, entry, max) {
    const cap = max || DEFAULT_MAX_ENTRIES;
    const next = (entries || []).concat([entry]);
    return next.length > cap ? next.slice(next.length - cap) : next;
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

  const api = { addEntry, csvEscape, toCsvRow, buildCsv, eventLabel, DEFAULT_MAX_ENTRIES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMLog = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
