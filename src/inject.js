/**
 * Claude Usage Meter — page-context interceptor (MAIN world).
 *
 * Runs inside claude.ai's own JS context so it can observe (and replay) the
 * network the web app makes. It:
 *   - monkeypatches fetch() / XMLHttpRequest and harvests rate-limit / usage
 *     info from responses (via CUMHarvest, loaded first),
 *   - remembers which URL produced usage data so the content script can ask us
 *     to re-fetch it later for a proactive baseline, and
 *   - on first load, best-effort probes /api/bootstrap + candidate usage
 *     endpoints so the meter can show a baseline before the user does anything.
 *
 * Responses are always cloned before reading, so the web app is unaffected.
 */
(function () {
  "use strict";

  const CHANNEL = "CLAUDE_USAGE_METER";
  const H = window.CUMHarvest;
  const origFetch =
    typeof window.fetch === "function" ? window.fetch.bind(window) : null;

  function post(payload) {
    try {
      window.postMessage({ __channel: CHANNEL, payload }, window.location.origin);
    } catch (e) {
      /* ignore */
    }
  }

  function emit(source, data, url) {
    if (!H || !H.hasData(data)) return;
    post({ source, data, url: url || null, at: Date.now() });
  }

  function isInteresting(url) {
    return typeof url === "string" && url.includes("/api/");
  }

  // A URL is a good "usage baseline" candidate if it looks account/limit shaped
  // rather than a per-message completion stream.
  function looksLikeUsageUrl(url) {
    return (
      typeof url === "string" &&
      /(usage|rate.?limit|limits|bootstrap|subscription|billing)/i.test(url)
    );
  }

  function inspect(source, headers, text, url) {
    if (!H) return;
    try {
      const headerData = H.harvestHeaders(headers);
      if (H.hasData(headerData)) emit(source + ":headers", headerData, url);
      const bodyData = H.parseBody(text);
      if (H.hasData(bodyData)) emit(source + ":body", bodyData, url);
    } catch (e) {
      /* ignore */
    }
  }

  // ---- Patch fetch -------------------------------------------------------
  if (origFetch) {
    window.fetch = function (input, init) {
      const url =
        typeof input === "string" ? input : input && input.url ? input.url : "";
      const promise = origFetch.apply(this, arguments);
      if (isInteresting(url)) {
        promise
          .then((response) => {
            try {
              const headerData = H && H.harvestHeaders(response.headers);
              if (H && H.hasData(headerData)) emit("fetch:headers", headerData, url);
              response
                .clone()
                .text()
                .then((text) => {
                  const bodyData = H && H.parseBody(text);
                  if (H && H.hasData(bodyData)) emit("fetch:body", bodyData, url);
                })
                .catch(() => {});
              // Scheduled-send: report file-upload completion so the executor
              // knows when it's safe to click Send.
              if (/upload-file/i.test(url)) {
                response
                  .clone()
                  .json()
                  .then((j) => {
                    post({
                      upload: {
                        file_name: j && (j.file_name || j.sanitized_name || null),
                        success: !!(j && j.success),
                      },
                    });
                  })
                  .catch(() => {});
              }
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
      const self = this;
      this.addEventListener("load", function () {
        try {
          const headers = new Map();
          (self.getAllResponseHeaders() || "")
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
          const fakeHeaders = {
            forEach: (cb) => headers.forEach((v, k) => cb(v, k)),
          };
          let text = "";
          try {
            const rt = self.responseType;
            if (rt === "" || rt === "text") text = self.responseText;
          } catch (e) {
            text = "";
          }
          inspect("xhr", fakeHeaders, text, self.__cum_url);
        } catch (e) {
          /* ignore */
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  // ---- Proactive fetch (baseline) ---------------------------------------
  // GET a same-origin API URL with the user's session and harvest it. Uses the
  // original fetch so we control credentials and can read the body directly.
  function fetchUsage(url) {
    if (!origFetch || !isInteresting(url)) return;
    origFetch(url, { credentials: "include", headers: { accept: "*/*" } })
      .then((res) => {
        if (!res.ok) return;
        const headerData = H && H.harvestHeaders(res.headers);
        if (H && H.hasData(headerData)) emit("baseline:headers", headerData, url);
        return res
          .clone()
          .text()
          .then((text) => inspect("baseline", res.headers, text, url));
      })
      .catch(() => {});
  }

  // Best-effort discovery for the very first run (no learned URL yet). The
  // confirmed usage endpoint is GET /api/organizations/{uuid}/usage, so we just
  // need an organization uuid — read it from /api/organizations (or /bootstrap).
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

  function probeOrgIds(text, ids) {
    if (!text) return;
    // Prefer uuids sitting next to a "uuid"/"organization" key; fall back to any.
    const near = /"(?:uuid|organization[^"]*|org[^"]*)"\s*:\s*"([0-9a-f-]{36})"/gi;
    let m;
    while ((m = near.exec(text)) && ids.size < 4) ids.add(m[1]);
    if (ids.size === 0) {
      const all = text.match(UUID_RE) || [];
      all.slice(0, 3).forEach((u) => ids.add(u));
    }
  }

  function discover() {
    if (!origFetch) return;
    const ids = new Set();
    const sources = ["/api/organizations", "/api/bootstrap"];
    Promise.all(
      sources.map((u) =>
        origFetch(u, { credentials: "include" })
          .then((r) => (r.ok ? r.clone().text() : ""))
          .then((t) => probeOrgIds(t, ids))
          .catch(() => {})
      )
    ).then(() => {
      ids.forEach((id) => fetchUsage(`/api/organizations/${id}/usage`));
    });
  }

  // ---- Commands from the content script ---------------------------------
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__channel !== CHANNEL || !msg.command) return;
    const c = msg.command;
    if (c.type === "fetchUsage" && typeof c.url === "string") {
      fetchUsage(c.url);
    } else if (c.type === "discover") {
      discover();
    }
  });

  post({ ready: true });
})();
