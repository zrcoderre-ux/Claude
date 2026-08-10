/**
 * Claude Usage Meter — the conversation payload, fetched once (ISOLATED world).
 *
 * Several things want the same thing: the contents list wants your messages,
 * the timestamps want when every turn happened, Save wants the lot. Each asking
 * separately means three fetches of the same conversation every few seconds, so
 * they ask here instead.
 *
 * Kept briefly and no longer. A conversation grows while you are in it, and a
 * cache that outlived the chat would leave the newest turn out of everything
 * built from it.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  if (!C) return;

  const FRESH_MS = 8000; // how long an answer counts as current
  const TIMEOUT_MS = 20000;

  let seq = 0;
  const cache = new Map(); // uuid -> { at, data }
  const inflight = new Map(); // uuid -> Promise

  function fetchOnce(uuid) {
    return new Promise((resolve) => {
      const reqId = "cv" + ++seq + "-" + Date.now();
      let settled = false;
      const finish = (data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve(data || null);
      };
      function onMsg(event) {
        if (event.source !== window) return;
        const m = event.data;
        const p = m && m.__channel === C.CHANNEL ? m.payload : null;
        if (p && p.conversation && p.conversation.reqId === reqId)
          finish(p.conversation.data || null);
      }
      window.addEventListener("message", onMsg);
      const timer = setTimeout(() => finish(null), TIMEOUT_MS);
      try {
        window.postMessage(
          { __channel: C.CHANNEL, command: { type: "fetchConversation", uuid, reqId } },
          window.location.origin
        );
      } catch (e) {
        finish(null);
      }
    });
  }

  /**
   * The conversation, from cache when it's fresh enough for the caller.
   * `maxAgeMs` of 0 forces a fetch. Returns null for a chat claude.ai has no
   * record of — an incognito one, which is never saved.
   */
  function get(uuid, maxAgeMs) {
    if (!uuid) return Promise.resolve(null);
    const max = typeof maxAgeMs === "number" ? maxAgeMs : FRESH_MS;
    const had = cache.get(uuid);
    if (had && Date.now() - had.at <= max) return Promise.resolve(had.data);
    // One request at a time per conversation, however many callers ask: three
    // asking at once is three fetches of the same thing.
    const going = inflight.get(uuid);
    if (going) return going;
    const p = fetchOnce(uuid)
      .then((data) => {
        inflight.delete(uuid);
        // A miss is cached too, briefly — an incognito chat will miss every
        // single time, and asking again immediately is just noise.
        cache.set(uuid, { at: Date.now(), data: data });
        return data;
      })
      .catch(() => {
        inflight.delete(uuid);
        return null;
      });
    inflight.set(uuid, p);
    return p;
  }

  function invalidate(uuid) {
    if (uuid) cache.delete(uuid);
    else cache.clear();
  }

  window.CUMConv = { get: get, invalidate: invalidate, FRESH_MS: FRESH_MS };
})();
