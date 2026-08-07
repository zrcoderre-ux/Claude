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

  const C = window.CUMComposer;
  const W = window.CUMWorkflow;

  const POLL_MS = 1500;
  const HEARTBEAT_MS = 20000;
  // With the stream-closed signal, this is just "let the DOM finish painting".
  const SETTLE_MS = 1500;
  // Without it, the text has to hold still this long AND across this many
  // consecutive looks — see the visibility note in waitForReply.
  const STABLE_MS = 6000;
  const STABLE_POLLS = 3;
  // A reply that hasn't changed in this long is finished, whatever a lingering
  // Stop control claims — but only when no response stream is open to say
  // otherwise. Generous, because a turn that verifies authority by live
  // retrieval can sit silent for many minutes and is not stalled at all.
  const STALLED_MS = 15 * 60 * 1000;
  const COPY_WAIT_MS = 4000;

  // ---- the assistant's response stream ------------------------------------
  // inject.js reports when a text/event-stream response opens and when its body
  // finishes reading, which is the turn genuinely ending. Tracked from page
  // load so a stream that closes between polls is never missed.
  let streamStartedAt = 0;
  let streamDoneAt = 0;
  let anyStreamSeen = false;
  // claude.ai streams more than the assistant's answer over SSE, so only the
  // completion endpoint counts — some other stream closing must not release a
  // step whose reply is still being written.
  const COMPLETION_RE = /completion|\/retry|\/messages(\?|$)/i;
  try {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const m = event.data;
      const p = m && m.__channel === C.CHANNEL ? m.payload : null;
      if (!p || (!p.streamStart && !p.streamDone)) return;
      anyStreamSeen = true;
      if (!COMPLETION_RE.test(String(p.url || ""))) return;
      if (p.streamStart) streamStartedAt = p.at || Date.now();
      if (p.streamDone) streamDoneAt = p.at || Date.now();
    });
  } catch (e) {
    /* ignore */
  }

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

  // Human turns — needed to tell "Claude hasn't answered yet" apart from "the
  // answer is already here", which is the whole question when re-attaching to a
  // message that went out while nobody was watching.
  const HUMAN_SELECTORS = [
    '[data-testid="user-message"]',
    ".font-user-message",
    '[data-testid="human-message"]',
  ];
  function lastHuman() {
    for (const sel of HUMAN_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      const list = Array.from(nodes).filter((el) => !C.isOurs(el));
      if (list.length) return list[list.length - 1];
    }
    return null;
  }

  // Is Claude's answer still to come? True when the last thing in the
  // conversation is the human's message — the reply hasn't been written yet, so
  // waiting is the only correct thing to do.
  function replyPending() {
    // Claude visibly working is the strongest answer and needs no guess about
    // markup: a Stop control on screen, or a response stream still open.
    try {
      if (C.isGenerating()) return true;
    } catch (e) {
      /* fall through to the transcript */
    }
    if (streamStartedAt > streamDoneAt) return true;

    // Otherwise ask whose turn it is. This leans on a selector for the human's
    // messages, which is why it isn't the primary test — if claude.ai renames
    // it, the two signals above still catch the case that matters (a message
    // sent moments ago, being answered right now).
    const h = lastHuman();
    if (!h) return false;
    const a = lastAssistant();
    if (!a) return true; // a message with no answer under it
    try {
      return !!(h.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING);
    } catch (e) {
      return false;
    }
  }
  // textContent, not innerText: innerText is computed from layout, and a
  // background tab may not lay out at all — which makes a still-growing reply
  // look frozen, exactly the wrong answer for a stability check.
  function renderedText(el) {
    return el ? (el.textContent || "").trim() : "";
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
    // Every source is cleaned of claude.ai's "not supported on your current
    // device" placeholders before it is judged or carried. Where the page
    // couldn't draw a block, the copy box copies that notice verbatim; the
    // prose around it is still the answer, but the shells say nothing and must
    // not travel to the next chat as material to work from.
    const rendered = W.stripPlaceholders(renderedText(msgEl));
    const copied = W.stripPlaceholders(await copyViaButton(msgEl));

    // The copy box stays first choice — Claude's own markdown, minus the
    // thinking. Both sides of the length comparison are stripped, so a reply
    // that was largely unrenderable doesn't make an honest copy look suspect.
    if (copied && W.plausibleCopy(copied, rendered)) return { text: copied, via: "copy" };

    let api = "";
    const uuid = conversationUuid();
    if (uuid) api = W.stripPlaceholders(W.lastAssistantText(await fetchConversation(uuid)));
    if (api) return { text: api, via: "api" };

    // Whichever survivor says the most.
    const best = [
      { text: copied, via: "copy" },
      { text: rendered, via: "dom" },
    ]
      .filter((c) => c.text)
      .sort((a, b) => a.text.length - b.text.length)
      .pop();
    if (best) return { text: best.text, via: best.via };
    return {
      text: "",
      via: "none",
      reason:
        "every block in that reply is one this page couldn't render (“not supported on your current device”)",
    };
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
  // This run's own key — never the whole list. Two runs going at once must not
  // be able to write over each other by rewriting a shared array.
  async function readRun(runId) {
    const k = W.runKey(runId);
    return (await C.storageGet(k))[k] || null;
  }
  async function updateRun(runId, fn) {
    const run = await readRun(runId);
    if (!run) return null;
    const next = fn(run);
    if (!next) return run;
    await storageSet({ [W.runKey(runId)]: next });
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
    // A timestamp under its own key, not a rewrite of the run. Writing the run
    // here would mean posting a copy read up to 20 seconds ago — enough to undo
    // a pause or a cancel the worker set in between.
    const beat = () => storageSet({ [W.beatKey(runId)]: Date.now() });
    beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }

  // Wait for a reply that wasn't there before this step's message went out, and
  // for it to finish. `before` is { count, text } sampled just before sending —
  // the transcript can hold only the newest turn in the DOM, so a grown count is
  // one signal for "something new arrived", not the only one.
  async function waitForReply(runId, before, timeoutMs, sentAt, marker) {
    const startedAt = Date.now();
    // Finished replies that weren't what this step is for, so the diagnostics
    // can say "it answered, three times, but never with the ruling".
    const skipped = new Set();
    const deadline = startedAt + (timeoutMs || W.STEP_TIMEOUT_MS);
    const since = typeof sentAt === "number" ? sentAt : startedAt;
    let lastText = "";
    let lastChangeAt = Date.now();
    let stablePolls = 0;
    // The last thing this loop saw, so a timeout can say what it was looking at
    // rather than only that it gave up.
    let last = { fresh: false, noMessage: true };

    // Clicking into the tab is the moment the poll loop stops being throttled
    // and starts running every poll interval again. Everything measured while
    // the tab was in the background was measured across minute-wide gaps, so it
    // is not evidence about a turn that may still be running: throw the
    // stability window away and make the reply prove it's finished from here.
    // Without this, focusing a tab mid-turn cashes in a stale "unchanged for 60
    // seconds" and the run bolts to the next step over a half-written answer.
    let onVisible = null;
    try {
      onVisible = () => {
        if (document.visibilityState === "visible") {
          lastChangeAt = Date.now();
          stablePolls = 0;
        }
      };
      document.addEventListener("visibilitychange", onVisible);
    } catch (e) {
      /* ignore */
    }

    try {
      while (Date.now() < deadline) {
        const run = await readRun(runId);
        // Paused counts as "let go" too — the run keeps its place and its
        // phase, so resuming waits for this reply rather than re-sending.
        if (!run || run.status === "canceled" || run.status === "paused")
          return { el: null, canceled: true };
        const now = Date.now();
        const list = assistantMessages();
        const el = list.length ? list[list.length - 1] : null;
        if (el) {
          const text = renderedText(el);
          if (text !== lastText) {
            lastText = text;
            lastChangeAt = now;
            stablePolls = 0;
          } else {
            stablePolls++;
          }
          const fresh = W.isNewReply({
            count: list.length,
            beforeCount: before.count,
            text,
            beforeText: before.text,
          });
          // Only trust a stream that closed AFTER this step's message went out,
          // and only if a stream actually opened for it — a "done" left over
          // from the previous turn must not release this one.
          const streamDone = streamDoneAt > since && streamDoneAt >= streamStartedAt;
          const generating = streaming(el);
          const reason = W.settleReason({
            text,
            generating,
            unchangedMs: now - lastChangeAt,
            stablePolls,
            streamDone,
            // A completion stream still open for this turn — proof it hasn't
            // finished, whatever the text is doing.
            streamOpen: streamStartedAt > streamDoneAt && streamStartedAt > since,
            minSettleMs: SETTLE_MS,
            minStableMs: STABLE_MS,
            minStablePolls: STABLE_POLLS,
            stalledMs: STALLED_MS,
          });
          last = { fresh, generating, streamDone, chars: text.length, stablePolls, marker };
          if (fresh && reason) {
            // A finished reply that isn't the thing being asked for. Claude
            // answers a clarifying question, notes a missing paper, or offers
            // to continue — all real replies, none of them the ruling the next
            // chat is meant to attack. Take this one as the new baseline and go
            // on waiting for the one that is. (Auto-continue, if it's on,
            // clicks Continue in the meantime; the reply that follows is the
            // one that counts.)
            if (marker && !W.hasMarker(text, marker)) {
              if (!skipped.has(text)) {
                skipped.add(text);
                last.skipped = skipped.size;
              }
              before = { count: list.length, text: text };
              lastText = "";
              lastChangeAt = now;
              stablePolls = 0;
              await C.sleep(POLL_MS);
              continue;
            }
            return { el, canceled: false, via: reason };
          }
        } else {
          last = { fresh: false, noMessage: true };
        }
        await C.sleep(POLL_MS);
      }
      return { el: null, canceled: false, timedOut: true, state: last };
    } finally {
      try {
        if (onVisible) document.removeEventListener("visibilitychange", onVisible);
      } catch (e) {
        /* ignore */
      }
    }
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
    // When this step's message went out — the line after which a closing
    // response stream belongs to THIS turn and not the one before it.
    let sentAt = Date.now();
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
      sentAt = Date.now();
      const url = await settledUrl(20000);
      await updateRun(runId, (r) =>
        W.markSent(r, { chatId: msg.chatId, url, now: sentAt })
      );
    } else {
      // Re-attaching to a step whose message already went out. Two very
      // different situations, and taking the wrong one is how a step "succeeds"
      // by handing on an answer to the PREVIOUS question:
      //
      //   the reply is already there  → take the newest turn;
      //   the last turn is still the human's → Claude hasn't started yet, so
      //     wait for a genuinely new reply, however long that takes.
      //
      // Let the page finish rendering before judging which it is — a tab that
      // has only just loaded shows neither.
      await C.waitFor(C.findEditor, 20000);
      await C.sleep(1500);
      const list = assistantMessages();
      if (replyPending()) {
        before = {
          count: list.length,
          text: list.length ? renderedText(list[list.length - 1]) : "",
        };
        notes.push("waited for Claude to answer the message already in the chat");
      } else {
        before = { count: -1, text: null };
      }
      // The message went out before this tab took the step over; anything the
      // stream signals from here on is fair game.
      sentAt = typeof run.sentAt === "number" ? run.sentAt : 0;
    }

    const { el, canceled, timedOut, via: settledVia, state } = await waitForReply(
      runId,
      before,
      W.STEP_TIMEOUT_MS,
      sentAt,
      msg.marker || null
    );
    if (canceled) return { ok: false, canceled: true, error: "canceled" };
    if (!el) {
      // Say what the wait was actually looking at. "Did not finish in time" on
      // its own is unactionable, and this step costs a whole Claude turn to
      // retry.
      const s = state || {};
      const seen = s.noMessage
        ? "no assistant message ever appeared"
        : (s.chars || 0) + " chars, " +
          (s.fresh ? "recognised as new" : "NOT recognised as new (same as before the send)") + ", " +
          (s.generating ? "page still says generating" : "page says idle") + ", " +
          (s.streamDone ? "response stream closed" : anyStreamSeen ? "no completion stream seen for this turn" : "no stream events at all") +
          (s.skipped
            ? ' — and ' + s.skipped + " finished repl" + (s.skipped === 1 ? "y" : "ies") +
              ' never contained “' + s.marker + '”, so nothing was handed on'
            : "");
      return {
        ok: false,
        error: (timedOut ? "Claude did not finish replying in time" : "no reply found") + " — " + seen,
        note: notes.join("; ") || null,
      };
    }
    if (settledVia && settledVia !== "stream")
      notes.push(
        settledVia === "stalled"
          ? "took the reply after 3 minutes unchanged (the page still claimed it was generating)"
          : "turn end judged from the text holding still (no completion stream seen)"
      );

    const { text, via, reason } = await harvestReply(el);
    if (!text)
      return {
        ok: false,
        error: "could not read Claude's reply" + (reason ? " — " + reason : ""),
        note: notes.join("; ") || null,
      };
    if (via !== "copy")
      notes.push(
        "reply read from the " + (via === "api" ? "conversation API" : "page") +
          " (the copy box gave nothing usable)"
      );

    const url = location.href;
    const updated = await updateRun(runId, (r) => {
      const next = W.applyStepResult(r, {
        // The step the WORKER asked for, not wherever the run has got to. If
        // this message was delivered twice (the send retries when the page
        // doesn't answer), the second copy finds the run already advanced and
        // is ignored — rather than advancing it again and silently skipping a
        // step.
        stepIndex: typeof msg.stepIndex === "number" ? msg.stepIndex : r.stepIndex,
        chatId: msg.chatId,
        chatName: msg.chatName || null,
        reply: text,
        url,
        now: Date.now(),
        total: msg.total,
        docs: (msg.files || []).length,
      });
      // What this step actually did — how the documents went up, and whether
      // the reply had to be read some way other than the copy box. Kept on the
      // run so it's readable after the fact, not just in the moment.
      return notes.length ? Object.assign({}, next, { note: notes.join("; ") }) : next;
    });
    return {
      ok: true,
      url,
      chars: text.length,
      status: updated ? updated.status : null,
      stepIndex: updated ? updated.stepIndex : null,
      note: notes.join("; ") || null,
    };
  }

  // Read this conversation's latest reply without sending anything. Used when a
  // run is restarted part-way: the chat the previous step ran in is still open,
  // and its last answer is the text to carry into the step being resumed —
  // which spares the operator copying it across by hand.
  async function harvestLatest(msg) {
    const stop = msg.runId ? startHeartbeat(msg.runId) : () => {};
    try {
      // The chat may still be mid-answer (that's often WHY the run stopped), so
      // wait it out first — `before` is open-ended because anything on screen
      // here is fair game.
      const { el, canceled, timedOut } = await waitForReply(
        msg.runId,
        { count: -1, text: null },
        // Same hour of patience as a step: re-reading a chat that is still
        // mid-answer is the same wait, just from the other side.
        msg.timeoutMs || W.STEP_TIMEOUT_MS,
        0
      );
      if (canceled) return { ok: false, canceled: true, error: "canceled" };
      if (!el)
        return {
          ok: false,
          error: timedOut ? "that chat is still replying" : "no reply found in that chat",
        };
      const { text, via, reason } = await harvestReply(el);
      if (!text)
        return {
          ok: false,
          error: "could not read that chat's last reply" + (reason ? " — " + reason : ""),
        };
      return { ok: true, text, chars: text.length, via };
    } finally {
      stop();
    }
  }

  chrome.runtime?.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "cum-wf-step") {
      runStep(msg)
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true; // async response
    }
    if (msg.type === "cum-wf-harvest") {
      harvestLatest(msg)
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
  });
})();
