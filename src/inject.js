/**
 * Claude Usage Meter — page-context interceptor (MAIN world).
 *
 * Runs inside claude.ai's own JS context so it can observe the network
 * requests the web app makes. It monkeypatches fetch() and XMLHttpRequest,
 * inspects responses for rate-limit / usage information, and forwards any
 * findings to the isolated content script via window.postMessage.
 *
 * It never consumes the real response body — responses are cloned first — so
 * the Claude web app keeps working exactly as before.
 */
(function () {
  "use strict";

  const CHANNEL = "CLAUDE_USAGE_METER";

  // Keys we treat as interesting when scanning JSON payloads/headers.
  const RESET_KEYS = /(reset|resets_at|resetsAt|reset_at|retry.?after|expires|until)/i;
  const LIMIT_KEYS = /(limit|max|cap|quota)/i;
  const REMAIN_KEYS = /(remaining|left|available)/i;
  const USED_KEYS = /(used|count|consumed|usage)/i;

  function post(payload) {
    try {
      window.postMessage({ __channel: CHANNEL, payload }, "https://claude.ai");
    } catch (e) {
      /* ignore */
    }
  }

  // Convert a value that might be seconds, ms, or an ISO string into an epoch-ms.
  function toEpochMs(value) {
    if (value == null) return null;
    if (typeof value === "number") {
      // Heuristic: seconds (< 1e12) vs milliseconds.
      if (value > 1e18) return null; // nanoseconds — too large, ignore
      if (value > 1e15) return Math.round(value / 1000); // microseconds
      if (value > 1e12) return value; // milliseconds
      if (value > 1e9) return value * 1000; // seconds since epoch
      // Small number => interpret as "seconds from now" (e.g. retry-after)
      return Date.now() + value * 1000;
    }
    if (typeof value === "string") {
      const num = Number(value);
      if (!Number.isNaN(num) && value.trim() !== "") return toEpochMs(num);
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
  }

  // Recursively walk an object collecting anything that smells like usage/limit info.
  function harvest(obj, depth, out) {
    if (obj == null || depth > 6) return out;
    if (typeof obj !== "object") return out;

    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val != null && typeof val === "object") {
        harvest(val, depth + 1, out);
        continue;
      }
      if (RESET_KEYS.test(key)) {
        const ms = toEpochMs(val);
        if (ms && ms > Date.now() - 60000) out.resetAt = ms;
      } else if (REMAIN_KEYS.test(key) && typeof val !== "boolean") {
        const n = Number(val);
        if (!Number.isNaN(n)) out.remaining = n;
      } else if (USED_KEYS.test(key) && typeof val !== "boolean") {
        const n = Number(val);
        if (!Number.isNaN(n)) out.used = n;
      } else if (LIMIT_KEYS.test(key) && typeof val !== "boolean") {
        const n = Number(val);
        if (!Number.isNaN(n)) out.limit = n;
      }
    }
    return out;
  }

  function harvestHeaders(headers) {
    const out = {};
    if (!headers || typeof headers.forEach !== "function") return out;
    headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (!lower.includes("ratelimit") && lower !== "retry-after") return;
      if (lower.includes("reset") || lower === "retry-after") {
        const ms = toEpochMs(value);
        if (ms) out.resetAt = ms;
      } else if (lower.includes("remaining")) {
        const n = Number(value);
        if (!Number.isNaN(n)) out.remaining = n;
      } else if (lower.includes("limit")) {
        const n = Number(value);
        if (!Number.isNaN(n)) out.limit = n;
      }
    });
    return out;
  }

  function emit(source, data) {
    if (!data) return;
    const hasSomething =
      data.resetAt != null ||
      data.remaining != null ||
      data.limit != null ||
      data.used != null;
    if (!hasSomething) return;
    post({ source, data, at: Date.now() });
  }

  function tryParse(text) {
    if (!text) return null;
    // Plain JSON
    try {
      return JSON.parse(text);
    } catch (e) {
      /* not plain JSON — maybe SSE */
    }
    // Server-sent events: pull `data: {...}` lines and merge harvested values.
    const merged = {};
    let found = false;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^data:\s*(\{.*\})\s*$/);
      if (!m) continue;
      try {
        const obj = JSON.parse(m[1]);
        harvest(obj, 0, merged);
        found = true;
      } catch (e) {
        /* skip malformed */
      }
    }
    return found ? { __sseMerged: merged } : null;
  }

  function inspectText(source, headers, text) {
    const headerData = harvestHeaders(headers);
    if (Object.keys(headerData).length) emit(source + ":headers", headerData);

    const parsed = tryParse(text);
    if (!parsed) return;
    if (parsed.__sseMerged) {
      emit(source + ":sse", parsed.__sseMerged);
    } else {
      emit(source + ":json", harvest(parsed, 0, {}));
    }
  }

  function isInteresting(url) {
    return typeof url === "string" && url.includes("/api/");
  }

  // ---- Patch fetch -------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url =
        typeof input === "string"
          ? input
          : input && input.url
          ? input.url
          : "";
      const promise = origFetch.apply(this, arguments);
      if (isInteresting(url)) {
        promise
          .then((response) => {
            try {
              const clone = response.clone();
              // Emit header-based info immediately.
              const headerData = harvestHeaders(response.headers);
              if (Object.keys(headerData).length)
                emit("fetch:headers", headerData);
              // Body may be a stream — read the clone fully in the background.
              clone
                .text()
                .then((text) => inspectText("fetch", response.headers, text))
                .catch(() => {});
            } catch (e) {
              /* ignore */
            }
          })
          .catch(() => {});
      }
      return promise;
    };
  }

  // ---- Patch XMLHttpRequest ---------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cum_url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (isInteresting(this.__cum_url)) {
      this.addEventListener("load", function () {
        try {
          const headerText = this.getAllResponseHeaders() || "";
          const headers = new Map();
          headerText
            .trim()
            .split(/\r?\n/)
            .forEach((line) => {
              const idx = line.indexOf(":");
              if (idx > 0)
                headers.set(
                  line.slice(0, idx).trim().toLowerCase(),
                  line.slice(idx + 1).trim()
                );
          });
          const fakeHeaders = { forEach: (cb) => headers.forEach((v, k) => cb(v, k)) };
          let text = "";
          try {
            text = this.responseType === "" || this.responseType === "text"
              ? this.responseText
              : "";
          } catch (e) {
            text = "";
          }
          inspectText("xhr", fakeHeaders, text);
        } catch (e) {
          /* ignore */
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  post({ ready: true });
})();
