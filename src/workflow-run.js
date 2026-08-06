/**
 * Claude Usage Meter — workflow step executor (ISOLATED world content script).
 *
 * One step of a multi-chat workflow: post a composed message into the
 * conversation this tab is showing, wait for Claude to finish answering, and
 * hand the answer back so the next step can paste it into the other chat.
 *
 * Reading the answer is the delicate part, and it is done the way a person
 * would: click the **copy box** under the finished reply. That control copies
 * the answer and NOT the thinking block, which is exactly what should travel to
 * the next chat. Three sources, in order of trust:
 *   1. the copy control, captured by hooking the page's clipboard write
 *      (src/inject.js) — no clipboard permission, works in a background tab,
 *      and gives Claude's own markdown;
 *   2. the conversation payload from claude.ai's API, text blocks only;
 *   3. the rendered message's text, as a last resort.
 * A copy that comes back suspiciously short (a code block's own copy button)
 * is rejected and falls through to (2) — see CUMWorkflow.plausibleCopy.
 *
 * Progress is written to storage as it happens, so a service worker that dies
 * mid-step can pick the run back up (the worker re-attaches with awaitOnly
 * rather than re-sending, which would double-post into the conversation).
 */
(function () {
  "use strict";

  const RUNS_KEY = "cum_wf_runs";
  const C = window.CUMComposer;
  const W = window.CUMWorkflow;

  const POLL_MS = 1500;
  const HEARTBEAT_MS = 20000;
  const STABLE_MS = 3000; // the reply must hold still this long before we take it
  const COPY_WAIT_MS = 4000;

  // Assistant turns, newest last. claude.ai's markup is unversioned, so this
  // walks a cascade and takes the first selector that matches anything.
  const ASSISTANT_SELECTORS = [
    '[data-testid="assistant-message"]',
    ".font-claude-response",
    ".font-claude-message",
    "[data-is-streaming]",
  ];
  function assistantMessages() {
    for (const sel of ASSISTANT_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      const list = Array.from(nodes).filter((el) => !C.isOurs(el));
      if (list.length) return list;
    }
    return [];
  }
  function lastAssistant() {
    const list = assistantMessages();
    return list.length ? list[list.length - 1] : null;
  }
  function renderedText(el) {
    return el ? (el.innerText || el.textContent || "").trim() : "";
  }
  // Streaming is advertised on the message itself; the Stop control is the
  // page-wide signal. Either one means "not finished".
  function streaming(el) {
    if (el && el.closest && el.closest('[data-is-streaming="true"]')) return true;
    if (el && el.getAttribute && el.getAttribute("data-is-streaming") === "true") return true;
    return C.isGenerating();
  }

  // ---- the copy box ------------------------------------------------------
  function copyish(b) {
    if (!b || C.isOurs(b)) return false;
    if (b.getAttribute("data-testid") === "action-bar-copy") return true;
    return (
      W.isCopyLabel(b.getAttribute("aria-label")) ||
      W.isCopyLabel(b.getAttribute("title")) ||
      W.isCopyLabel(b.textContent)
    );
  }
  // The copy control for a message lives in the action bar BELOW it, outside the
  // rendered message (confirmed live: an icon-only button whose only label is
  // aria-label="Copy", a sibling of Read aloud / Good response / Retry).
  // Searching outward from the message and never inside it keeps a code block's
  // own Copy button out of the running; preferring one that FOLLOWS the message
  // in document order keeps the preceding user message's Copy out of it too,
  // for the widths of scope where both are in view.
  function findCopyButton(msgEl) {
    if (!msgEl) return null;
    let scope = msgEl.parentElement;
    for (let i = 0; i < 4 && scope; i++) {
      const btns = Array.from(scope.querySelectorAll('button,[role="button"]')).filter(
        (b) => !msgEl.contains(b) && copyish(b)
      );
      if (btns.length) {
        const following = btns.find(
          (b) =>
            msgEl.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
        );
        return following || btns[0];
      }
      scope = scope.parentElement;
    }
    return null;
  }
  // The action bar can be hover-revealed; nudge the message first.
  function hover(el) {
    for (const type of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
      try {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch (e) {
        /* ignore */
      }
    }
  }

  // Click the copy control and catch what the page writes to the clipboard
  // (inject.js reports every clipboard write over the channel).
  function copyViaButton(msgEl) {
    return new Promise((resolve) => {
      let btn = findCopyButton(msgEl);
      if (!btn) {
        hover(msgEl);
        btn = findCopyButton(msgEl);
      }
      if (!btn) return resolve("");
      let settled = false;
      const finish = (text) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve(text || "");
      };
      function onMsg(event) {
        if (event.source !== window) return;
        const m = event.data;
        const p = m && m.__channel === C.CHANNEL ? m.payload : null;
        if (p && p.clipboardWrite && typeof p.clipboardWrite.text === "string")
          finish(p.clipboardWrite.text);
      }
      window.addEventListener("message", onMsg);
      const timer = setTimeout(() => finish(""), COPY_WAIT_MS);
      try {
        C.robustClick(btn);
      } catch (e) {
        finish("");
      }
    });
  }

  // ---- the conversation payload (fallback) -------------------------------
  function conversationUuid() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }
  let reqSeq = 0;
  function fetchConversation(uuid, timeoutMs) {
    return new Promise((resolve) => {
      const reqId = "wf" + ++reqSeq + "-" + Date.now();
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
        if (p && p.conversation && p.conversation.reqId === reqId) finish(p.conversation.data || null);
      }
      window.addEventListener("message", onMsg);
      const timer = setTimeout(() => finish(null), timeoutMs || 15000);
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

  async function harvestReply(msgEl) {
    const rendered = renderedText(msgEl);
    const copied = await copyViaButton(msgEl);
    if (W.plausibleCopy(copied, rendered)) return { text: copied.trim(), via: "copy" };
    const uuid = conversationUuid();
    if (uuid) {
      const conv = await fetchConversation(uuid);
      const text = W.lastAssistantText(conv);
      if (text) return { text, via: "api" };
    }
    return { text: rendered, via: "dom" };
  }

  // ---- run state ---------------------------------------------------------
  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, resolve);
      } catch (e) {
        resolve();
      }
    });
  }
  async function readRun(runId) {
    const store = await C.storageGet(RUNS_KEY);
    return W.getRun(store[RUNS_KEY] || [], runId);
  }
  async function updateRun(runId, fn) {
    const store = await C.storageGet(RUNS_KEY);
    const runs = store[RUNS_KEY] || [];
    const run = W.getRun(runs, runId);
    if (!run) return null;
    const next = fn(run);
    if (!next) return run;
    await storageSet({ [RUNS_KEY]: W.upsertRun(runs, next) });
    return next;
  }

  // The conversation URL this step ended up in. A first step starts at /new and
  // only gets its uuid once the message posts, so give it a moment.
  async function settledUrl(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
      if (/\/chat\/[0-9a-f-]{36}/i.test(location.pathname)) return location.href;
      await C.sleep(500);
    }
    return location.href;
  }

  // A step can take the better part of an hour (uploads, then a long turn). The
  // background worker treats a quiet run as abandoned and takes it over, so the
  // whole time a step is in this tab's hands it says so — otherwise a worker
  // restart mid-step would re-send the message and double-post it.
  function startHeartbeat(runId) {
    const beat = () => updateRun(runId, (r) => W.heartbeat(r, Date.now()));
    beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }

  // Wait for a reply that wasn't there before this step's message went out, and
  // for it to finish. `before` is { count, text } sampled just before sending —
  // the transcript can hold only the newest turn in the DOM, so a grown count is
  // one signal for "something new arrived", not the only one.
  async function waitForReply(runId, before, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || W.STEP_TIMEOUT_MS);
    let lastText = "";
    let lastChangeAt = Date.now();
    while (Date.now() < deadline) {
      const run = await readRun(runId);
      if (!run || run.status === "canceled") return { el: null, canceled: true };
      const now = Date.now();
      const list = assistantMessages();
      const el = list.length ? list[list.length - 1] : null;
      if (el) {
        const text = renderedText(el);
        if (text !== lastText) {
          lastText = text;
          lastChangeAt = now;
        }
        const fresh = W.isNewReply({
          count: list.length,
          beforeCount: before.count,
          text,
          beforeText: before.text,
        });
        if (
          fresh &&
          W.turnSettled({
            text,
            generating: streaming(el),
            unchangedMs: now - lastChangeAt,
            minStableMs: STABLE_MS,
          })
        )
          return { el, canceled: false };
      }
      await C.sleep(POLL_MS);
    }
    return { el: null, canceled: false, timedOut: true };
  }

  // ---- one step ----------------------------------------------------------
  async function runStep(msg) {
    const stop = startHeartbeat(msg.runId);
    try {
      return await runStepInner(msg);
    } finally {
      stop();
    }
  }

  async function runStepInner(msg) {
    const runId = msg.runId;
    const run = await readRun(runId);
    if (!run) return { ok: false, error: "run not found" };
    if (run.status === "canceled") return { ok: false, canceled: true, error: "canceled" };
    if (typeof msg.stepIndex === "number" && msg.stepIndex !== run.stepIndex)
      return { ok: false, error: "step already moved on" };

    const notes = [];
    // What the transcript looked like BEFORE we sent, so the reply we take can't
    // be the one that was already on screen.
    const priorList = assistantMessages();
    let before = {
      count: priorList.length,
      text: priorList.length ? renderedText(priorList[priorList.length - 1]) : "",
    };

    if (!msg.awaitOnly) {
      const { files, missing } = await C.filesFromStorage(msg.files || []);
      if (missing) return { ok: false, error: "missing document bytes: " + missing };
      const sent = await C.sendMessage({
        files,
        text: msg.text || "",
        model: msg.model || null,
        codeRepo: msg.codeRepo || null,
      });
      if (sent.notes && sent.notes.length) notes.push.apply(notes, sent.notes);
      if (!sent.ok)
        return { ok: false, error: sent.error, note: notes.join("; ") || null };
      const url = await settledUrl(20000);
      await updateRun(runId, (r) =>
        W.markSent(r, { chatId: msg.chatId, url, now: Date.now() })
      );
    } else {
      // Re-attaching to a step whose message already went out: the reply may
      // have arrived while nobody was watching, so there is no "before" to
      // compare against — take the newest turn and let the settled check decide.
      before = { count: -1, text: null };
    }

    const { el, canceled, timedOut } = await waitForReply(runId, before, W.STEP_TIMEOUT_MS);
    if (canceled) return { ok: false, canceled: true, error: "canceled" };
    if (!el)
      return {
        ok: false,
        error: timedOut ? "Claude did not finish replying in time" : "no reply found",
        note: notes.join("; ") || null,
      };

    const { text, via } = await harvestReply(el);
    if (!text) return { ok: false, error: "could not read Claude's reply", note: notes.join("; ") || null };
    if (via !== "copy") notes.push("reply read from the " + (via === "api" ? "conversation API" : "page") + " (copy box not usable)");

    const url = location.href;
    const updated = await updateRun(runId, (r) =>
      W.applyStepResult(r, {
        stepIndex: r.stepIndex,
        chatId: msg.chatId,
        chatName: msg.chatName || null,
        reply: text,
        url,
        now: Date.now(),
        total: msg.total,
      })
    );
    return {
      ok: true,
      url,
      chars: text.length,
      status: updated ? updated.status : null,
      stepIndex: updated ? updated.stepIndex : null,
      note: notes.join("; ") || null,
    };
  }

  chrome.runtime?.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "cum-wf-step") return;
    runStep(msg)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  });
})();
