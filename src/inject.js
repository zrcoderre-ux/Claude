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
  const W = window.CUMWeights;
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

  // ---- Projects capture --------------------------------------------------
  // claude.ai loads the full project list from a JSON API (e.g.
  // /api/organizations/{uuid}/projects). Harvesting that response gives us
  // every project reliably — far better than scraping a virtualized grid.
  function looksLikeProjectsUrl(url) {
    return (
      typeof url === "string" &&
      /\/projects(?:[/?]|$)/.test(url) &&
      !/\/projects\/[0-9a-f-]{36}/i.test(url) // not a single-project sub-resource
    );
  }
  function extractProjects(json) {
    const arr = Array.isArray(json)
      ? json
      : json && Array.isArray(json.projects)
      ? json.projects
      : null;
    if (!arr) return null;
    const out = [];
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;
      const uuid = it.uuid || it.id;
      if (!uuid || !/^[0-9a-f-]{36}$/i.test(String(uuid))) continue;
      if (it.is_archived || it.archived_at) continue;
      const name = String(it.name || it.title || "").trim();
      out.push({ uuid: String(uuid), name, href: "/cowork/project/" + uuid });
    }
    return out.length ? out : null;
  }
  // A URL pointing at the canonical org project list (not a search/filter),
  // whose response is the authoritative full set — safe to replace with.
  function isFullProjectsUrl(url) {
    return (
      typeof url === "string" &&
      /\/api\/organizations\/[0-9a-f-]{36}\/projects(?:\?|$)/i.test(url) &&
      !/[?&](q|search|name|query)=/i.test(url)
    );
  }
  function maybeEmitProjects(url, text, explicitFull) {
    if (!looksLikeProjectsUrl(url) || !text) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return;
    }
    const projects = extractProjects(json);
    // `full` means this is the complete list, so the cache can be replaced
    // (which prunes deleted projects) rather than merely merged.
    if (projects) post({ projects, full: !!explicitFull || isFullProjectsUrl(url) });
  }

  // ---- Home-conversation activity ----------------------------------------
  // Home chats live in chat_conversations_v2 with an updated_at per chat. The
  // most-recent updated_at tells us when Home was last used — the signal for
  // attributing gap usage to Home (vs Code, which isn't in this list).
  function looksLikeConversationsUrl(url) {
    return typeof url === "string" && /\/chat_conversations(_v2)?(?:[/?]|$)/.test(url) &&
      !/\/chat_conversations(_v2)?\/[0-9a-f-]{36}/i.test(url); // not a single conversation
  }
  function maxConvUpdate(json) {
    const arr = Array.isArray(json) ? json : json && (json.data || json.conversations);
    if (!Array.isArray(arr)) return null;
    let max = 0;
    for (const c of arr) {
      const t = c && Date.parse(c.updated_at || c.updatedAt || "");
      if (t && !isNaN(t) && t > max) max = t;
    }
    return max || (arr.length === 0 ? 0 : null);
  }
  function maybeEmitConversations(url, text) {
    if (!looksLikeConversationsUrl(url) || !text) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return;
    }
    const t = maxConvUpdate(json);
    if (t != null) post({ homeActivityAt: t });
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
      maybeEmitProjects(url, text);
      maybeEmitConversations(url, text);
    } catch (e) {
      /* ignore */
    }
  }

  // ---- Patch WebSocket ---------------------------------------------------
  //
  // A turn ending is read off a text/event-stream's body finishing — a real
  // moment, and the reason that signal is trusted over anything the page draws.
  // Cowork produces no such stream, and no POST that a console probe pasted
  // into a loaded page can see, which leaves one candidate: a socket opened
  // BEFORE any of that could be watching.
  //
  // This runs at document_start, ahead of claude.ai's own scripts, so it is the
  // one place that can see such a socket at all.
  //
  // Observation only. A socket has no "response closed" to report — it opens
  // once and stays open — so what is posted is when frames arrive, and the
  // judging of what that means is left to the caller, which already knows what
  // it is waiting for.
  if (typeof window.WebSocket === "function") {
    const OrigWS = window.WebSocket;
    let lastPost = 0;
    function Patched(url, protocols) {
      const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
      try {
        post({ socketOpen: String(url || ""), at: Date.now() });
        ws.addEventListener("message", () => {
          // Throttled hard: a stream of tokens is a stream of frames, and the
          // content script needs to know they are STILL ARRIVING, not how many.
          const now = Date.now();
          if (now - lastPost < 400) return;
          lastPost = now;
          post({ socketFrame: true, url: String(url || ""), at: now });
        });
      } catch (e) {
        /* an unobservable socket is still a working one */
      }
      return ws;
    }
    try {
      Patched.prototype = OrigWS.prototype;
      for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Patched[k] = OrigWS[k];
      window.WebSocket = Patched;
    } catch (e) {
      window.WebSocket = OrigWS;
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
              // A streamed response is an assistant turn — signal it so the
              // content script can refresh the Code context panel afterward.
              const ct =
                (response.headers && response.headers.get && response.headers.get("content-type")) || "";
              // Headers arrive when the stream OPENS, so this marks a turn
              // starting, not finishing.
              const isStream = /text\/event-stream/i.test(ct);
              if (isStream) post({ turnEnded: true, streamStart: true, url, at: Date.now() });
              const headerData = H && H.harvestHeaders(response.headers);
              if (H && H.hasData(headerData)) emit("fetch:headers", headerData, url);
              response
                .clone()
                .text()
                .then((text) => {
                  const bodyData = H && H.parseBody(text);
                  if (H && H.hasData(bodyData)) emit("fetch:body", bodyData, url);
                  maybeEmitProjects(url, text);
                  maybeEmitConversations(url, text);
                  // Reading the whole body resolves exactly when the stream
                  // closes — the assistant's turn is over. This is the only
                  // authoritative "done" signal available: it comes from the
                  // network, so it doesn't care whether the tab is focused,
                  // rendered, or throttled, and a pause mid-turn can't fake it.
                  if (isStream) post({ streamDone: true, url, at: Date.now() });
                })
                .catch(() => {
                  // A stream that errored or was aborted is also no longer
                  // running; saying so beats leaving a waiter hanging.
                  if (isStream) post({ streamDone: true, aborted: true, url, at: Date.now() });
                });
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
      ids.forEach((id) => {
        fetchUsage(`/api/organizations/${id}/usage`);
        fetchProjects(`/api/organizations/${id}/projects`);
      });
    });
  }

  // Proactively pull the project list so the picker fills in without the user
  // having to visit the Projects page.
  function fetchProjects(url) {
    if (!origFetch) return;
    origFetch(url, { credentials: "include", headers: { accept: "*/*" } })
      .then((res) => (res.ok ? res.clone().text() : ""))
      .then((text) => maybeEmitProjects(url, text, true)) // authoritative full list
      .catch(() => {});
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
    } else if (c.type === "discoverProjects") {
      discoverProjects();
    } else if (c.type === "discoverConversations") {
      discoverConversations();
    } else if (c.type === "measureHome") {
      measureHome(typeof c.sinceMs === "number" ? c.sinceMs : null);
    } else if (c.type === "fetchConversation" && typeof c.uuid === "string") {
      fetchConversation(c.uuid, c.reqId);
    } else if (c.type === "renameConversation" && typeof c.uuid === "string") {
      renameConversation(c.uuid, c.name, c.reqId);
    }
  });

  // Where a conversation lives, which its id doesn't announce: an ordinary one
  // is under chat_conversations, a Cowork session under plain conversations —
  // as seen on the wiggle/list-files call a session makes as it opens,
  //   /api/organizations/<org>/conversations/cse_<id>/wiggle/list-files
  // Null for an id of neither shape, so the caller says "unavailable" rather
  // than sending a request built around a guess.
  //
  // This runs in the MAIN world and can't see src/cowork.js, which holds the
  // same decision under test as conversationApiPath(). The two must agree.
  function conversationApiPath(orgId, id) {
    if (!orgId || !id) return null;
    if (/^cse_[A-Za-z0-9_-]+$/.test(id)) return `/api/organizations/${orgId}/conversations/${id}`;
    if (/^[0-9a-f-]{36}$/i.test(id)) return `/api/organizations/${orgId}/chat_conversations/${id}`;
    return null;
  }

  // WRITING is a different question from reading, and only one of the two has
  // ever been watched happening. A rename is
  //   PUT /api/organizations/<org>/chat_conversations/<uuid>  {"name": "..."}
  // captured off the live page, and that collection is where a rename goes
  // whatever kind of conversation this is. The /conversations/<cse_id> shape
  // above was inferred from a READ — the wiggle/list-files call a session makes
  // as it opens — and inferring a write from a read is how a rename went to a
  // URL nobody had ever seen answer anything.
  function renameApiPath(orgId, id) {
    if (!orgId || !id) return null;
    return `/api/organizations/${orgId}/chat_conversations/${id}`;
  }
  const knownConversationId = (id) =>
    /^cse_[A-Za-z0-9_-]+$/.test(String(id || "")) || /^[0-9a-f-]{36}$/i.test(String(id || ""));

  // ---- Reading one conversation ------------------------------------------
  // The workflow runner needs the text of Claude's last reply to hand it to the
  // next chat. Its first choice is the page's own copy control (hooked below);
  // this is the fallback, and it's the same payload the context meter reads.
  function fetchConversation(uuid, reqId) {
    const reply = (obj) => post({ conversation: Object.assign({ reqId }, obj) });
    if (!origFetch || !knownConversationId(uuid)) return reply({ error: "unavailable" });
    const ids = new Set();
    origFetch("/api/organizations", { credentials: "include" })
      .then((r) => (r.ok ? r.clone().text() : ""))
      .then((t) => {
        probeOrgIds(t, ids);
        const orgs = Array.from(ids);
        if (!orgs.length) return reply({ error: "no organization" });
        // Try each org in turn — an account can belong to more than one, and
        // only the owning org answers for this conversation.
        return (function next(i) {
          if (i >= orgs.length) return reply({ error: "conversation not found" });
          const base = conversationApiPath(orgs[i], uuid);
          if (!base) return reply({ error: "unavailable" });
          // The tree/rendering params are chat_conversations' own; a Cowork
          // session is asked for plainly rather than with parameters invented
          // for it.
          const url = /\/chat_conversations\//.test(base)
            ? base + "?tree=True&rendering_mode=messages"
            : base;
          return origFetch(url, { credentials: "include", headers: { accept: "*/*" } })
            .then((res) => (res.ok ? res.clone().text() : ""))
            .then((text) => {
              if (!text) return next(i + 1);
              let json;
              try {
                json = JSON.parse(text);
              } catch (e) {
                return next(i + 1);
              }
              reply({ data: json });
            })
            .catch(() => next(i + 1));
        })(0);
      })
      .catch((e) => reply({ error: String((e && e.message) || e) }));
  }

  // ---- Naming a conversation ---------------------------------------------
  // A run leaves several conversations behind, and untitled they are three rows
  // of "Motion to Compel Arbitration" telling you nothing about which holds the
  // ruling. Driven through the same API the page's own rename uses, and through
  // the original fetch so the meter's hooks don't see its own traffic.
  //
  // Never fatal: a run whose work is done must not be reported as failed
  // because a title didn't take. Every path answers, so the caller can say what
  // happened instead of waiting.
  function renameConversation(uuid, name, reqId) {
    const reply = (obj) => post({ renamed: Object.assign({ reqId }, obj) });
    if (!origFetch || !knownConversationId(uuid)) return reply({ error: "unavailable" });
    const title = String(name || "").slice(0, 200);
    if (!title) return reply({ error: "no name" });
    const ids = new Set();
    origFetch("/api/organizations", { credentials: "include" })
      .then((r) => (r.ok ? r.clone().text() : ""))
      .then((t) => {
        probeOrgIds(t, ids);
        const orgs = Array.from(ids);
        if (!orgs.length) return reply({ error: "no organization" });
        // Each org in turn, and PUT then PATCH: only the owning org answers for
        // this conversation, and claude.ai's API is unversioned.
        return (function next(i, method) {
          if (i >= orgs.length)
            return method === "PUT" ? next(0, "PATCH") : reply({ error: "rename refused" });
          const base = renameApiPath(orgs[i], uuid);
          if (!base) return reply({ error: "unavailable" });
          return origFetch(base, {
            method: method,
            credentials: "include",
            headers: { "content-type": "application/json", accept: "*/*" },
            body: JSON.stringify({ name: title }),
          })
            .then((res) => (res.ok ? reply({ ok: true, name: title, method: method }) : next(i + 1, method)))
            .catch(() => next(i + 1, method));
        })(0, "PUT");
      })
      .catch((e) => reply({ error: String((e && e.message) || e) }));
  }

  // ---- Clipboard capture --------------------------------------------------
  // Claude's reply has a copy box under it that copies the answer WITHOUT the
  // thinking block. The workflow runner clicks it; this reports what the page
  // wrote, so the text can be read out of a background tab with no clipboard
  // permission and no focus requirement (navigator.clipboard.readText() has
  // both). Read-only: the original write still happens, untouched.
  // There are three ways a page can put text on the clipboard and claude.ai is
  // free to change which it uses, so all three are covered. The one that
  // actually fires today is `write()` with a ClipboardItem — the rich-text form,
  // which carries text/plain alongside text/html. Patching Clipboard.prototype
  // rather than the navigator.clipboard instance means a call that went through
  // a captured prototype reference is caught too.
  function hookClipboard() {
    const report = (text) => {
      const s = String(text == null ? "" : text);
      if (s) post({ clipboardWrite: { text: s, at: Date.now() } });
    };
    try {
      const proto =
        (window.Clipboard && window.Clipboard.prototype) ||
        (navigator.clipboard && Object.getPrototypeOf(navigator.clipboard));
      if (proto && typeof proto.writeText === "function") {
        const orig = proto.writeText;
        proto.writeText = function (text) {
          try {
            report(text);
          } catch (e) {
            /* ignore */
          }
          return orig.apply(this, arguments);
        };
      }
      if (proto && typeof proto.write === "function") {
        const origWrite = proto.write;
        proto.write = function (items) {
          try {
            for (const item of items || []) {
              if (!item || !item.types || item.types.indexOf("text/plain") === -1) continue;
              // getType resolves a Blob; reading it is async, which is fine —
              // the runner waits a few seconds for the text after clicking.
              item
                .getType("text/plain")
                .then((b) => b.text())
                .then(report)
                .catch(() => {});
            }
          } catch (e) {
            /* ignore */
          }
          return origWrite.apply(this, arguments);
        };
      }
    } catch (e) {
      /* ignore */
    }
    try {
      // Copies done the old way (execCommand, or a hidden textarea) surface as a
      // copy event; listening in the bubble phase means the page's own handler
      // has already filled in the data by the time we read it.
      document.addEventListener("copy", (e) => {
        try {
          const t = e.clipboardData && e.clipboardData.getData("text/plain");
          if (t) report(t);
        } catch (err) {
          /* ignore */
        }
      });
    } catch (e) {
      /* ignore */
    }
  }
  hookClipboard();

  // Probe org ids, then pull each org's project list from the API.
  function discoverProjects() {
    if (!origFetch) return;
    const ids = new Set();
    origFetch("/api/organizations", { credentials: "include" })
      .then((r) => (r.ok ? r.clone().text() : ""))
      .then((t) => {
        probeOrgIds(t, ids);
        ids.forEach((id) => fetchProjects(`/api/organizations/${id}/projects`));
      })
      .catch(() => {});
  }

  // Pull the Home conversation list (most-recent updated_at) so we can tell
  // whether Home was used during a usage gap.
  function fetchConversations(url) {
    if (!origFetch) return;
    origFetch(url, { credentials: "include", headers: { accept: "*/*" } })
      .then((res) => (res.ok ? res.clone().text() : ""))
      .then((text) => maybeEmitConversations(url, text))
      .catch(() => {});
  }
  function discoverConversations() {
    if (!origFetch) return;
    const ids = new Set();
    origFetch("/api/organizations", { credentials: "include" })
      .then((r) => (r.ok ? r.clone().text() : ""))
      .then((t) => {
        probeOrgIds(t, ids);
        ids.forEach((id) =>
          fetchConversations(`/api/organizations/${id}/chat_conversations_v2`)
        );
      })
      .catch(() => {});
  }

  // Measure how much Home-chat content was added since `sinceMs` (the gap
  // boundary), model-weighted, so content.js can split a both-used gap by
  // content. We list conversations, pick the ones updated in the gap, fetch each
  // one's messages, and sum the tokens of messages created during the gap. The
  // total is posted as { homeWeighted }; it also emits homeActivityAt en route.
  const MAX_CONVS_TO_MEASURE = 8;
  function measureHome(sinceMs) {
    if (!origFetch || !W) {
      post({ homeWeighted: 0, since: sinceMs });
      return;
    }
    const ids = new Set();
    origFetch("/api/organizations", { credentials: "include" })
      .then((r) => (r.ok ? r.clone().text() : ""))
      .then((t) => {
        probeOrgIds(t, ids);
        const orgs = Array.from(ids);
        return Promise.all(
          orgs.map((id) => measureHomeForOrg(id, sinceMs))
        ).then((totals) => {
          const homeWeighted = totals.reduce((a, b) => a + (b || 0), 0);
          post({ homeWeighted, since: sinceMs });
        });
      })
      .catch(() => post({ homeWeighted: 0, since: sinceMs }));
  }

  function measureHomeForOrg(orgId, sinceMs) {
    const listUrl = `/api/organizations/${orgId}/chat_conversations_v2`;
    return origFetch(listUrl, { credentials: "include", headers: { accept: "*/*" } })
      .then((res) => (res.ok ? res.clone().text() : ""))
      .then((text) => {
        if (!text) return 0;
        maybeEmitConversations(listUrl, text); // also surfaces homeActivityAt
        let json;
        try {
          json = JSON.parse(text);
        } catch (e) {
          return 0;
        }
        const arr = Array.isArray(json) ? json : json && (json.data || json.conversations);
        if (!Array.isArray(arr)) return 0;
        const touched = arr
          .filter((c) => {
            const t = c && Date.parse(c.updated_at || c.updatedAt || "");
            return t && !Number.isNaN(t) && (sinceMs == null || t >= sinceMs);
          })
          .map((c) => c.uuid || c.id)
          .filter((u) => u && /^[0-9a-f-]{36}$/i.test(String(u)))
          .slice(0, MAX_CONVS_TO_MEASURE);
        return Promise.all(
          touched.map((uuid) => measureConversation(orgId, uuid, sinceMs))
        ).then((vals) => vals.reduce((a, b) => a + (b || 0), 0));
      })
      .catch(() => 0);
  }

  function measureConversation(orgId, uuid, sinceMs) {
    const url = `/api/organizations/${orgId}/chat_conversations/${uuid}`;
    return origFetch(url, { credentials: "include", headers: { accept: "*/*" } })
      .then((res) => (res.ok ? res.clone().text() : ""))
      .then((text) => {
        if (!text) return 0;
        let json;
        try {
          json = JSON.parse(text);
        } catch (e) {
          return 0;
        }
        const msgs = json && json.chat_messages;
        const model = json && typeof json.model === "string" ? json.model : null;
        return W.sumNewContent(msgs, sinceMs, model);
      })
      .catch(() => 0);
  }

  post({ ready: true });
})();
