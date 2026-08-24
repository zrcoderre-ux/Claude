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
  const RC = window.CUMReplyCopy;
  if (!RC) return; // no copy box, no way to read a reply — see src/replycopy.js

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

  // ---- the assistant's response stream ------------------------------------
  // inject.js reports when a text/event-stream response opens and when its body
  // finishes reading, which is the turn genuinely ending. Tracked from page
  // load so a stream that closes between polls is never missed.
  let streamStartedAt = 0;
  let streamDoneAt = 0;
  let anyStreamSeen = false;
  let streamConvId = null; // named by the completion URL — see the listener
  // Frames on the page's own socket. Not a stream closing — a socket opens once
  // and stays open, so there is no such moment to have — but frames arriving is
  // a fact about the NETWORK, which is what makes it better than the text
  // holding still: a throttled background tab stops laying out and never stops
  // receiving.
  //
  // In Cowork it has never fired, and neither has the event-stream hook, on a
  // surface that plainly sends and receives. The likeliest reading is that its
  // traffic runs through a worker — which has its own fetch, in its own scope,
  // and cannot be patched from the page — so the page sees the telemetry it
  // sends itself and nothing else. Left in place because it costs nothing and
  // would start working the day that changes; the note says which signal
  // decided, so nobody has to guess which world we are in.
  let lastFrameAt = 0;
  let anyFrameSeen = false;
  const FRAME_QUIET_MS = 4000; // frames this far apart are a turn that ended
  // claude.ai streams more than the assistant's answer over SSE, so only the
  // completion endpoint counts — some other stream closing must not release a
  // step whose reply is still being written.
  try {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const m = event.data;
      const p = m && m.__channel === C.CHANNEL ? m.payload : null;
      if (p && p.socketFrame) {
        anyFrameSeen = true;
        lastFrameAt = p.at || Date.now();
        return;
      }
      if (!p || (!p.streamStart && !p.streamDone)) return;
      anyStreamSeen = true;
      if (!W.looksLikeCompletionUrl(p.url, location.pathname)) return;
      if (p.streamStart) streamStartedAt = p.at || Date.now();
      if (p.streamDone) streamDoneAt = p.at || Date.now();
      // The completion request names the conversation it is for. In a Project
      // the address bar never does — it holds the project's id and nothing
      // else — so without this the conversation API, which is the authority on
      // whether the reply arrived, could not be asked at all.
      const fromUrl = W.conversationIdFromApiUrl(p.url);
      if (fromUrl) streamConvId = fromUrl;
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

  // Which element is claiming the page is generating. On this surface that
  // claim held a step for half an hour past its reply, so a report that says
  // "generating" without saying WHAT said so is a report that can't be checked.
  function stopDescription() {
    let stop = null;
    try {
      stop = C.findStop();
    } catch (e) {
      /* fall through */
    }
    if (!stop) return "stop control gone by the time this was written";
    const bits = ["stop control:"];
    for (const a of ["aria-label", "data-testid", "title"]) {
      const v = stop.getAttribute && stop.getAttribute(a);
      if (v) bits.push(a + "=" + JSON.stringify(v));
    }
    const t = (stop.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30);
    if (t) bits.push("text=" + JSON.stringify(t));
    return bits.join(" ");
  }

  // claude.ai puts "Claude's response was interrupted" beside the fragment it
  // managed to write, so look at the message and the block around it — not the
  // whole page, where an older interrupted turn would keep tripping this.
  function interruptedAt(el) {
    if (!el) return false;
    if (W.looksInterrupted(el.textContent || "")) return true;
    const near = el.parentElement;
    return !!(near && W.looksInterrupted(near.textContent || ""));
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
    // ...or frames still arriving on the socket, where that is the only
    // network signal there is.
    if (lastFrameAt && Date.now() - lastFrameAt < FRAME_QUIET_MS) return true;

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
  // The reply's text with its CONTROLS' text removed, for judging stillness.
  // A Cowork reply carries tool-status pills — buttons reading "Ran a command,
  // used a tool…" — that keep re-captioning themselves while the agent works,
  // and on a surface with no network signal, stillness is the whole of the
  // evidence: every pill tick reset the clock, the clock had thirty minutes to
  // run, and a reply that had plainly arrived was never taken. The prose is
  // what is being waited for, so the prose is what has to hold still.
  function stabilityText(el) {
    if (!el) return "";
    let copy;
    try {
      copy = el.cloneNode(true);
      for (const b of copy.querySelectorAll('button,[role="button"]')) b.remove();
    } catch (e) {
      return renderedText(el);
    }
    return (copy.textContent || "").trim();
  }
  // Streaming is advertised on the message itself; the Stop control is the
  // page-wide signal. Either one means "not finished".
  function streaming(el) {
    if (el && el.closest && el.closest('[data-is-streaming="true"]')) return true;
    if (el && el.getAttribute && el.getAttribute("data-is-streaming") === "true") return true;
    return C.isGenerating();
  }

  // Something in the reply visibly WORKING — a spinner, a progress control, a
  // busy region. On Cowork, prose stillness is the only settle signal there
  // is, and an agent turn holds its prose perfectly still for MINUTES while
  // sub-agents run — a step settled on "Launching parallel retrieval while I
  // finish the record." and handed that, mid-turn, to the next chat. The
  // pills' own text can't be the counter-signal (it re-captions forever —
  // #196); a visible working indicator can, because it goes away when the
  // work does. Only VISIBLE ones count: a hidden spinner kept in the markup
  // must not hold a finished step hostage.
  function busyIn(el) {
    if (!el) return false;
    const sel =
      '[aria-busy="true"],[role="progressbar"],[class*="spinner" i],[class*="animate-spin" i],[data-state="running" i]';
    const anyVisible = (root) => {
      let list;
      try {
        list = root.querySelectorAll(sel);
      } catch (e) {
        return false;
      }
      for (const n of list) if (C.isVisible(n)) return true;
      return false;
    };
    if (anyVisible(el)) return true;
    const near = el.parentElement;
    return !!(near && anyVisible(near));
  }

  // ---- the copy box ------------------------------------------------------
  // Where it is, and how to catch what it writes, is src/replycopy.js — shared
  // with the Copy-ruling button, which sits beside the same control.
  const copyViaButton = RC.copyViaButton;

  // ---- the conversation payload (fallback) -------------------------------
  // The conversation this tab is showing, for the API that is the authority on
  // whether the reply arrived. Insisting on a literal /chat/ segment made that
  // authority silently unavailable on every other surface claude.ai serves a
  // conversation from — a project or a Code session — and an authority that
  // quietly isn't consulted is worse than one that fails loudly.
  //
  // A /chat/ id still wins where there is one. Otherwise the LAST id in the path
  // is the most specific: /project/<project-id>/… names the project first and
  // the conversation after it.
  // Where the path names the conversation, believe the path — it is current
  // even after the SPA moves between chats. Otherwise fall back to whatever the
  // completion stream said, which is the only source a Project run has.
  function conversationUuid() {
    const fromPath = W.conversationId(location.pathname);
    if (fromPath && /\/chat\//i.test(location.pathname)) return fromPath;
    return streamConvId || fromPath;
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

  // Give this conversation the run's name. Best-effort in every direction: it
  // answers whatever happens, the caller doesn't wait on it deciding anything,
  // and a title that won't take is a note on the run rather than a failed step.
  function renameConversation(uuid, name, timeoutMs) {
    return new Promise((resolve) => {
      const reqId = "wfn" + ++reqSeq + "-" + Date.now();
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
        if (p && p.renamed && p.renamed.reqId === reqId) finish(p.renamed);
      }
      window.addEventListener("message", onMsg);
      const timer = setTimeout(() => finish(null), timeoutMs || 8000);
      try {
        window.postMessage(
          { __channel: C.CHANNEL, command: { type: "renameConversation", uuid, name, reqId } },
          window.location.origin
        );
      } catch (e) {
        finish(null);
      }
    });
  }

  // Give this conversation the run's name. Only the message that OPENED it, and
  // only a conversation this run opened: a chat you pointed the run at is yours,
  // and renaming it would be the extension retitling your work.
  //
  // Called once the conversation exists, kept up during the wait (see
  // keepNaming), and settled once the reply is in. claude.ai titles a new
  // conversation ITSELF — early, moments into the first answer — and that
  // lands on top of the send-time attempt. Only the final pass reports, so the
  // run's note says what the chat ended up called rather than narrating the
  // attempts.
  async function nameThisChat(msg, notes, onlyIfUnnamed) {
    if (!msg.title) {
      // Held rather than absent: the worker had a name for this chat and would
      // not send it, because it could not be pseudonymized (see chatTitleFor).
      // A chat quietly left under claude.ai's own auto-title would look like
      // the naming switch being off.
      if (msg.titleHeld && notes) notes.push(msg.titleHeld);
      return;
    }
    if (!msg.firstInChat) return;
    const uuid = conversationUuid();
    // A Cowork SESSION has no rename API — renaming one by hand makes no HTTP
    // request at all, watched for on a page that renames a regular chat with a
    // plain PUT a few lines away. So it is done the way you do it: open the
    // menu on the session's name, choose Rename, type into the box.
    //
    // The earlier reading of that silence — "no request, therefore it cannot be
    // renamed" — was wrong. What it established was that one route was closed,
    // not that all of them were.
    //
    // Gated on the ID rather than the address: a conversation inside a Cowork
    // PROJECT is an ordinary chat with an ordinary uuid, and the API is both
    // available and better there — no menus, nothing to mis-click.
    if (uuid && /^cse_/.test(uuid)) {
      // renameCoworkSession reads the title off the header before touching
      // anything and answers "ok" for a name already in place — which is the
      // check-first behaviour the onlyIfUnnamed pass wants; it only changes
      // what gets SAID about it below.
      let r;
      try {
        r = await C.renameCoworkSession(msg.title);
      } catch (e) {
        r = "failed";
      }
      if (!notes) return;
      const already = /already called/i.test(C.renameWhy() || "");
      if (r === "ok") {
        if (!(onlyIfUnnamed && already)) notes.push('named this chat "' + msg.title + '"');
      } else notes.push("could not name this Cowork chat (" + (C.renameWhy() || r) + ")");
      return;
    }
    if (onlyIfUnnamed && uuid) {
      // This pass exists to CATCH UP a rename an earlier send never made — not
      // to stamp the title again over one that took, or over one typed by
      // hand. Ask the conversation itself first; if the fetch won't answer,
      // fall through and rename, which is idempotent where it was already
      // right.
      const K = window.CUMCowork;
      const conv = await fetchConversation(uuid, 10000);
      if (K && conv && K.sameTitle(K.conversationName(conv), msg.title)) return;
    }
    const named = uuid ? await renameConversation(uuid, msg.title) : null;
    if (!notes) return;
    if (named && named.ok) notes.push('named this chat "' + named.name + '"');
    else notes.push("could not name this chat (" + ((named && named.error) || "no answer") + ")");
  }

  // Keep the run's name on a conversation it just opened, while the reply is
  // still being written. claude.ai auto-titles a new conversation EARLY —
  // moments into the first answer, not after it (from the operator, watching
  // it live) — and its title lands on top of the rename made at send time.
  // The pass after the reply used to be the correction, which on a long
  // Cowork turn left the chat under claude.ai's name for hours. So the first
  // minutes of the wait re-check on a backoff and re-stamp only where the
  // auto-title has won; the post-reply pass remains the last word, and the
  // only one that reports. Returns a stopper, called when the wait ends.
  function keepNaming(msg) {
    if (!msg.title || !msg.firstInChat) return () => {};
    let alive = true;
    (async () => {
      // Clustered early, because that is when the auto-title lands.
      for (const wait of [20000, 30000, 60000, 120000, 240000]) {
        await C.sleep(wait);
        if (!alive) return;
        try {
          await nameThisChat(msg, null, true);
        } catch (e) {
          /* the post-reply pass is the last word */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }

  async function harvestReply(msgEl) {
    // Every source is cleaned of claude.ai's "not supported on your current
    // device" placeholders before it is judged or carried. Where the page
    // couldn't draw a block, the copy box copies that notice verbatim; the
    // prose around it is still the answer, but the shells say nothing and must
    // not travel to the next chat as material to work from.
    const rendered = W.stripPlaceholders(renderedText(msgEl));
    const copied = W.stripPlaceholders(await copyViaButton(msgEl));
    // The reply's prose with its controls' captions removed — what a faithful
    // copy must END with. On Cowork the copy control was seen handing back the
    // turn's TOOL PROMPTS instead of the answer: pages of the agent's scratch
    // work, with the report nowhere in it. That copy is long, so the length
    // test waves it through; only the reply's own ending can convict it.
    const prose = W.stripPlaceholders(stabilityText(msgEl));
    // Which test the copy failed, in words. The failure is INTERMITTENT — the
    // same control copies faithfully in one Cowork conversation and copies the
    // scratch work in the next — so the run's note is the only record of which
    // kind this step drew, and "gave nothing usable" told nobody anything.
    const copyWhy = !copied
      ? "the copy box gave nothing"
      : !W.plausibleCopy(copied, rendered)
      ? "the copy was too short to be the reply"
      : !W.copyCarriesEnd(copied, prose)
      ? "the copy did not carry the reply's ending — Cowork's copy control sometimes copies the turn's tool prompts instead of the answer"
      : "";

    // The copy box stays first choice — Claude's own markdown, minus the
    // thinking. Both sides of the length comparison are stripped, so a reply
    // that was largely unrenderable doesn't make an honest copy look suspect.
    if (!copyWhy) return { text: copied, via: "copy" };

    let api = "";
    const uuid = conversationUuid();
    if (uuid) {
      const conv = await fetchConversation(uuid);
      api = W.stripPlaceholders(
        /^cse_/.test(uuid) ? W.coworkReplyText(conv) : W.lastAssistantText(conv)
      );
    }
    if (api) return { text: api, via: "api", copyWhy: copyWhy };

    // Whichever survivor says the most. A copy that failed the ending test is
    // not a survivor: it is KNOWN to be something other than the reply, and
    // being long — which is what got it here — must not win it the fallback.
    // The page's candidate is the PROSE, never the raw text: raw textContent
    // carries the tool pills' captions, doubled by their nesting, and a
    // hand-off opening "Ran 14 commands, used a skill · 1 noteRan 14
    // commands…" reached a live run's next chat as material to work from.
    const best = [
      { text: copied && W.copyCarriesEnd(copied, prose) ? copied : "", via: "copy" },
      { text: prose, via: "dom" },
    ]
      .filter((c) => c.text)
      .sort((a, b) => a.text.length - b.text.length)
      .pop();
    if (best) return { text: best.text, via: best.via, copyWhy: copyWhy };
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
      // Cowork settles somewhere else entirely — /cowork/cse_<id>, no /chat/ in
      // it and no uuid either. Without this arm the wait always runs its full
      // timeout and every Cowork step pays fifteen seconds for nothing.
      if (/\/cowork\/cse_[A-Za-z0-9_-]+/.test(location.pathname)) return location.href;
      await C.sleep(500);
    }
    return location.href;
  }

  // ---- standing down ------------------------------------------------------
  //
  // Pause is a decision about the RUN, not about the tab it was pressed in. A
  // wave is three conversations working at once, and leaving the other two to
  // finish is leaving two long answers to be paid for and thrown away.
  //
  // So while a step is in this tab's hands, the tab watches the run's own
  // storage key and acts the moment it changes — rather than at the next poll,
  // which for a step that is mid-upload is no moment at all:
  //
  //   the message hasn't gone yet  → it doesn't go. Every slow phase of the
  //     send asks, so a pause during a twenty-exhibit upload stops it there.
  //   the message has gone and Claude is writing  → press Stop. The rest of
  //     that answer is being paid for and, if the pause was because the prompt
  //     was wrong, is worth nothing.
  let halted = null; // "paused" | "canceled" | "gone", once the run says so
  let haltWatch = null;

  function watchForHalt(runId) {
    halted = null;
    const key = W.runKey(runId);
    const onChange = (changes, area) => {
      if (area !== "local" || !changes[key]) return;
      const why = W.runHalted(changes[key].newValue);
      if (!why || halted) return;
      halted = why;
      // Immediately, and from here rather than from the worker: this tab is the
      // one with the conversation in it.
      try {
        C.stopGenerating();
      } catch (e) {
        /* the step still stands down; only the turn keeps its tokens */
      }
    };
    try {
      chrome.storage.onChanged.addListener(onChange);
      haltWatch = () => {
        try {
          chrome.storage.onChanged.removeListener(onChange);
        } catch (e) {
          /* ignore */
        }
        haltWatch = null;
      };
    } catch (e) {
      haltWatch = null;
    }
    // Whatever it already said, before the listener existed.
    readRun(runId).then((r) => {
      const why = W.runHalted(r);
      if (why && !halted) halted = why;
    });
    return () => {
      if (haltWatch) haltWatch();
    };
  }

  // A step can take the better part of an hour (uploads, then a long turn). The
  // background worker treats a quiet run as abandoned and takes it over, so the
  // whole time a step is in this tab's hands it says so — otherwise a worker
  // restart mid-step would re-send the message and double-post it.
  function startHeartbeat(runId) {
    // A timestamp under its own key, not a rewrite of the run. Writing the run
    // here would mean posting a copy read up to 20 seconds ago — enough to undo
    // a pause or a cancel the worker set in between.
    // A loop on C.sleep rather than setInterval, because this tab is hidden by
    // design and a hidden page's timers are throttled to about one wake-up a
    // minute — which would let the beat lapse and invite the worker to take
    // over a step this tab is in the middle of. C.sleep borrows the worker's
    // clock when the page is hidden; see the note in src/composer.js.
    let alive = true;
    const beat = () => storageSet({ [W.beatKey(runId)]: Date.now() });
    beat();
    (async () => {
      while (alive) {
        await C.sleep(HEARTBEAT_MS);
        if (alive) beat();
      }
    })();
    return () => {
      alive = false;
    };
  }

  // Wait for a reply that wasn't there before this step's message went out, and
  // for it to finish. `before` is { count, text } sampled just before sending —
  // the transcript can hold only the newest turn in the DOM, so a grown count is
  // one signal for "something new arrived", not the only one.
  // Keep the transcript at the bottom. claude.ai unmounts messages that scroll
  // out of view, so a long turn can finish with its reply nowhere in the DOM —
  // which is what "23 chars, NOT recognised as new" means when the stream has
  // already closed. A person watching would have scrolled down.
  //
  // ONLY while the tab is hidden. The pin stands in for the person a hidden
  // tab doesn't have; in a tab someone is actually looking at, the scroll bar
  // is theirs, and re-pinning it every poll yanks them away from whatever they
  // scrolled up to read. A visible tab losing the pin costs nothing the run
  // depends on — the conversation API, not the DOM, is the record of whether a
  // reply arrived.
  function keepAtBottom(el) {
    try {
      if (document.visibilityState !== "hidden") return;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "end" });
      const sc = document.scrollingElement || document.documentElement;
      if (sc) sc.scrollTop = sc.scrollHeight;
    } catch (e) {
      /* ignore */
    }
  }

  async function waitForReply(runId, before, timeoutMs, sentAt, marker) {
    const startedAt = Date.now();
    // Finished replies that weren't what this step is for, so the diagnostics
    // can say "it answered, three times, but never with the ruling".
    const skipped = new Set();
    // How often to ask the conversation API, and when we last did.
    const API_EVERY_MS = 12000;
    let lastApiAt = 0;
    // …and how often to look at the meter. A step waiting on a reply that can
    // never come because the window emptied should stop, not sit out its hour.
    const USAGE_EVERY_MS = 20000;
    let lastUsageAt = Date.now();
    let deadline = startedAt + (timeoutMs || W.STEP_TIMEOUT_MS);
    let since = typeof sentAt === "number" ? sentAt : startedAt;
    // null rather than "": the FIRST text this loop sees is not a change, it is
    // the baseline. Treating it as a change would count "there was already a
    // reply here" as evidence that one just arrived.
    let lastText = null;
    let lastChangeAt = Date.now();
    let stablePolls = 0;
    // Did anything happen while we watched — a turn mounting, or text moving?
    // Stillness we did not watch become still is not a finished answer; it is
    // whatever was on screen when we got here. See CUMWorkflow.settleReason.
    let watched = false;
    const watchedCount = assistantMessages().length;
    // The conversation has replies in it that the page hasn't drawn. Anything
    // that mounts from here is HISTORY arriving, not an answer — so growth
    // proves nothing while this holds, and only the text actually moving, or
    // the conversation API (which is comparing against its own baseline), can
    // say a new reply came. Without this, a tab still rendering a long chat
    // hands the step whatever was already at the bottom of it.
    const domBlind = !!(before && before.apiText && !watchedCount);
    // The last thing this loop saw, so a timeout can say what it was looking at
    // rather than only that it gave up. Two objects, not one: the DOM's story is
    // rebuilt from scratch every poll, and merging the conversation's into it
    // meant every API reading was overwritten a few lines later — which made the
    // timeout report "the conversation was never readable" even when it had been
    // answering all along, and pointed diagnosis at the wrong half of the code.
    let last = { fresh: false, noMessage: true };
    let api = {};
    // A reply that matches the marker but may still be growing. The marker is
    // the ruling's FIRST line, so seeing it proves the ruling has started, not
    // that it has finished — see CUMWorkflow.rulingReady.
    let candidate = null;
    let candidateAt = 0;
    // Whether this step has already asked the chat to carry on. Once, and only
    // once: a chat told twice what to produce isn't going to be argued into it.
    let nudged = false;

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

    // Is the turn still being written? Either signal is enough, and neither is
    // trusted on its own: the page's Stop control can linger, and a completion
    // stream that closed for a tool call reopens.
    const stillGoing = () => {
      let generating = false;
      try {
        generating = C.isGenerating() || busyIn(lastAssistant());
      } catch (e) {
        /* the stream below is the fallback */
      }
      return generating || (streamStartedAt > streamDoneAt && streamStartedAt > since);
    };

    // A reply that matches the marker, held until it stops moving. Returns true
    // when it has been quiet long enough to be the finished thing.
    const settledOnMarker = (text, now) => {
      if (text !== candidate) {
        candidate = text;
        candidateAt = now;
      }
      return W.rulingReady({
        generating: stillGoing(),
        unchangedMs: now - candidateAt,
      });
    };

    // Ask the chat to carry on. The commonest reason a step's reply isn't the
    // ruling is the turn ending at the tool-use limit part-way through it, and
    // the fix for that is a sentence. Once per step: after that the run pauses
    // and says so, rather than paying for a third turn that will read like the
    // second.
    const nudge = async () => {
      nudged = true;
      let sent = { ok: false };
      try {
        sent = await C.sendMessage({ text: W.continuePrompt(marker), stop: () => halted });
      } catch (e) {
        sent = { ok: false, error: String((e && e.message) || e) };
      }
      if (!sent || !sent.ok) return false;
      // A new turn, so everything measured about the last one is history: its
      // stream signals, its text, and the clock this step is running against.
      since = Date.now();
      deadline = Math.max(deadline, since + (timeoutMs || W.STEP_TIMEOUT_MS));
      candidate = null;
      candidateAt = 0;
      lastText = null;
      lastChangeAt = since;
      stablePolls = 0;
      return true;
    };

    try {
      while (Date.now() < deadline) {
        // The watcher sees a pause the instant it is written and has already
        // pressed Stop on the answer; this is the same news, read here so the
        // loop lets go rather than waiting out its poll.
        if (halted) return { el: null, canceled: true, halted: halted };
        const run = await readRun(runId);
        // Paused counts as "let go" too — the run keeps its place and its
        // phase, so resuming waits for this reply rather than re-sending.
        const why = W.runHalted(run);
        if (why) return { el: null, canceled: true, halted: why };
        const now = Date.now();
        const list = assistantMessages();
        const el = list.length ? list[list.length - 1] : null;
        keepAtBottom(el);

        // Ask the conversation itself. The DOM is a convenience here, not the
        // record: it can stop showing the newest turn altogether, and then no
        // amount of waiting will surface it. Only once the stream for this
        // message has closed, or the DOM has been unhelpful for a while.
        const streamClosed = streamDoneAt > since && streamDoneAt >= streamStartedAt;
        if (
          now - lastApiAt > API_EVERY_MS &&
          (streamClosed || now - startedAt > 90000)
        ) {
          lastApiAt = now;
          const uuid = conversationUuid();
          if (!uuid) {
            // No conversation id anywhere in the URL, so the authoritative
            // source can't be asked at all. Worth naming: it's the difference
            // between "the API said nothing new" and "the API was never
            // consulted", and only one of those is a claude.ai problem.
            api = { noConvId: true, path: location.pathname };
          } else {
            // A Cowork session is asked too, now. Refusing to ask it cost a
            // live step: the reply finished an hour before the timeout, the
            // DOM never showed it, and everything else is dead on Cowork —
            // no stream events, no page state worth reading. The parse is
            // defensive (W.coworkReplyText), and when the session answers in
            // a shape nothing recognises, the report carries that shape so
            // it can be wired in from one paste.
            const cse = /^cse_/.test(uuid);
            const conv = await fetchConversation(uuid, 20000);
            const apiText = W.stripPlaceholders(
              cse ? W.coworkReplyText(conv) : W.lastAssistantText(conv)
            );
            if (cse && !apiText) {
              // The session answered in a shape nothing recognised (or not at
              // all). Say so and let the DOM watch below keep its turn — the
              // page is still a candidate answer.
              api = conv
                ? { apiAnswered: true, coworkShape: W.payloadShape(conv) }
                : { apiFailed: true };
            } else {
              const fresh = apiText && apiText !== (before.apiText || "");
              api = { apiChars: apiText.length, apiAnswered: !!conv };
              if (fresh && W.looksInterrupted(apiText)) {
                // Cut off part-way. Where a ruling is expected this is the exact
                // case a Continue fixes, so ask before giving up on it.
                if (marker && !nudged && (await nudge())) {
                  before = Object.assign({}, before, { apiText: apiText });
                  await C.sleep(POLL_MS);
                  continue;
                }
                return { el: null, canceled: false, interrupted: true };
              }
              if (fresh && !marker)
                return { el: el, apiText: apiText, canceled: false, via: "api" };
              if (fresh && W.hasMarker(apiText, marker)) {
                // The marker is the ruling's first line, so this may be a ruling
                // that is still being written. Wait for it to hold still.
                if (settledOnMarker(apiText, now))
                  return { el: el, apiText: apiText, canceled: false, via: "api" };
                api = Object.assign({}, api, { holding: "waiting for the ruling to finish" });
              } else if (fresh && !skipped.has(apiText)) {
                // A finished reply that isn't the one being waited for. Ask it to
                // carry on, once; a second one that still isn't the ruling is a
                // judgement call, and the run pauses for you to make it.
                skipped.add(apiText);
                before = Object.assign({}, before, { apiText: apiText });
                api = Object.assign({}, api, { skipped: skipped.size, marker: marker });
                if (!nudged) {
                  await nudge();
                } else {
                  return {
                    el: null,
                    canceled: false,
                    noRuling: true,
                    skipped: skipped.size,
                    marker: marker,
                  };
                }
              }
            }
          }
        }
        // Out of usage, and Claude isn't mid-answer. A turn already running is
        // paid for and finishes; it's the reply that hasn't started that will
        // never arrive.
        if (now - lastUsageAt > USAGE_EVERY_MS) {
          lastUsageAt = now;
          const generatingNow = C.isGenerating() || streamStartedAt > streamDoneAt;
          if (!generatingNow) {
            const meter = (await C.storageGet("cum_state")).cum_state;
            if (W.usageBlocked(meter, Date.now()))
              return { el: null, canceled: false, outOfUsage: true, backAt: W.usageBackAt(meter) };
          }
        }

        if (el) {
          const text = stabilityText(el);
          // Has anything happened since we started watching? A new turn
          // mounting, or the text moving. Either is evidence that what we are
          // looking at is THIS step's answer arriving; neither, and it is
          // whatever was on screen when we got here.
          if (!domBlind && list.length > watchedCount) watched = true;
          // A cut-off reply, whatever cut it off. What's on screen is a
          // fragment, and the rest of the run would build on it without ever
          // saying so — but where a ruling is expected, a fragment is usually
          // a turn that hit the tool-use limit mid-ruling, and a Continue is
          // all it wants. Ask once, then stop.
          if (interruptedAt(el)) {
            if (marker && !nudged && (await nudge())) {
              before = { count: list.length, text: text };
              await C.sleep(POLL_MS);
              continue;
            }
            return { el, canceled: false, interrupted: true };
          }
          if (text !== lastText) {
            if (lastText !== null) watched = true; // it moved while we watched
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
          const generating = streaming(el) || busyIn(el);
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
            // Nothing about the network is knowable on this surface, so
            // stillness is the whole of the argument and has to be a much
            // longer one — see settleReason. Cowork runs tools between
            // sentences, and on Manually approve it sits still on purpose.
            noNetworkSignal: !anyStreamSeen && !anyFrameSeen,
            stalledMs: STALLED_MS,
            // Stillness only counts as a finished answer if we watched it
            // become still — EXCEPT where the caller has already decided that
            // whatever is on screen is the answer. That is what the -1 baseline
            // means: re-attaching to a message whose reply is already sitting
            // there, and re-reading a chat on purpose. Requiring a change there
            // would be waiting out the hour for an answer that arrived before
            // anyone was looking.
            watched: watched || before.count === -1,
          });
          last = { fresh, generating, streamDone, chars: text.length, stablePolls, marker };
          // The turn is over and nothing new can be read. Waiting out the rest
          // of the hour cannot change that: the stream for THIS message closed,
          // the page is idle, and the text hasn't moved in fifteen minutes.
          // Stop and say what actually happened, rather than reporting a
          // timeout for something that was never one. Held back while replies
          // are being skipped for a missing marker — that's a live
          // back-and-forth, and auto-continue may still be working it.
          if (streamDone && !generating && !fresh && !skipped.size && now - lastChangeAt >= STALLED_MS)
            return {
              el: null,
              canceled: false,
              timedOut: true,
              unreadable: true,
              state: Object.assign({}, api, last),
            };
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
              // Back to a baseline, not to "seen nothing": this reply IS the
              // thing to beat now, and the next one has to arrive on top of it.
              lastText = null;
              lastChangeAt = now;
              stablePolls = 0;
              // Ask it to carry on, once. Twice told and still not the ruling
              // is not a misunderstanding this can talk its way out of.
              if (!nudged) await nudge();
              else
                return {
                  el: null,
                  canceled: false,
                  noRuling: true,
                  skipped: skipped.size,
                  marker: marker,
                };
              await C.sleep(POLL_MS);
              continue;
            }
            // Settled AND it says what it was meant to say — but the marker is
            // the ruling's first line, so give the rest of it room to arrive
            // before taking this as the finished thing.
            if (marker && !settledOnMarker(text, now)) {
              last.holding = "waiting for the ruling to finish";
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
      return { el: null, canceled: false, timedOut: true, state: Object.assign({}, api, last) };
    } finally {
      try {
        if (onVisible) document.removeEventListener("visibilitychange", onVisible);
      } catch (e) {
        /* ignore */
      }
    }
  }

  // Fold the text documents of a step into a single labelled file, leaving
  // anything binary (a PDF, a Word file) to go up on its own. Twenty
  // attachments is where claude.ai starts showing Claude fewer than were sent;
  // one file is either there or it isn't.
  // ---- one step ----------------------------------------------------------
  // The step this tab is driving right now, published for the pill. A run's
  // pill matches by conversation URL, and a FIRST send sits at /new for its
  // whole upload — the phase most worth pausing, and the one where the Pause
  // was missing because there was no address to match yet.
  let activeStep = null;
  window.CUMWfStep = { current: () => activeStep };

  async function runStep(msg) {
    const stop = startHeartbeat(msg.runId);
    // Watched for the whole life of the step, so a Pause pressed in ANY of the
    // run's chats reaches this one at once rather than at its next poll.
    const unwatch = watchForHalt(msg.runId);
    activeStep = { runId: msg.runId, chatId: msg.chatId || null };
    try {
      return await runStepInner(msg);
    } finally {
      activeStep = null;
      unwatch();
      stop();
    }
  }

  // A step running alongside others writes to a key of its own rather than to
  // the run: three tabs doing read-modify-write on one record lose whichever
  // write lands second, and what would be lost is a reply that cost a whole
  // Claude turn. The worker collects these and writes the run once.
  async function memberSet(msg, fields) {
    if (!msg.waveKey) return;
    const had = (await C.storageGet(msg.waveKey))[msg.waveKey] || {};
    await storageSet({ [msg.waveKey]: Object.assign({}, had, fields) });
  }

  // What a step that stood down reports back. Paused rather than failed: the run
  // keeps its place and its phase, so Resume picks up from exactly here.
  //
  // The note says how far it got, because that is the difference between the
  // two things Resume can do. Stopped before the message went out, there is
  // nothing in the chat and the step sends afresh. Stopped after, the message is
  // in the chat and the answer under it is a FRAGMENT — Stop was pressed on it —
  // so the chat is worth reading before carrying on.
  async function standDown(runId, why, when, notes) {
    const list = (notes || []).slice();
    list.push(when);
    const note = "paused — " + when;
    try {
      await updateRun(runId, (r) => Object.assign({}, r, { note: note }));
    } catch (e) {
      /* the pause itself is already recorded; this is only the wording */
    }
    if (why === "canceled" || why === "gone")
      return { ok: false, canceled: true, error: "canceled " + when, note: list.join("; ") };
    return { ok: false, paused: true, error: note, note: list.join("; ") };
  }

  async function runStepInner(msg) {
    const runId = msg.runId;
    const run = await readRun(runId);
    if (!run) return { ok: false, error: "run not found" };
    const already = W.runHalted(run);
    if (already)
      return already === "paused"
        ? { ok: false, paused: true, error: "paused before this step began" }
        : { ok: false, canceled: true, error: already };
    // Is this step still the one the run is on? A member of a wave never sits
    // at run.stepIndex — its wave does — so it asks about the wave instead.
    const at = typeof msg.waveStart === "number" ? msg.waveStart : msg.stepIndex;
    if (typeof at === "number" && at !== run.stepIndex)
      return { ok: false, error: "step already moved on" };

    const notes = [];
    // When this step's message went out — the line after which a closing
    // response stream belongs to THIS turn and not the one before it.
    let sentAt = Date.now();

    // Let the conversation RENDER before reading it. The baseline taken here is
    // what says "the reply we end up with can't be the one that was already on
    // screen" — and a baseline read from a tab that hasn't drawn the transcript
    // yet says the chat was empty. Everything already in it then looks new, and
    // a step re-run in a chat that already holds replies settles on the old one
    // within seconds. Restart a run at an earlier step and every step after it
    // does the same, one after another, in a few seconds each.
    //
    // Only where the URL names a conversation: a chat being opened fresh has
    // nothing to wait for, and waiting anyway would cost every first step ten
    // seconds for nothing.
    await C.waitFor(C.findEditor, 20000);
    if (conversationUuid()) {
      const until = Date.now() + 10000;
      while (Date.now() < until && !assistantMessages().length) await C.sleep(400);
      // ...and a moment more, so a transcript mid-mount isn't sampled halfway.
      await C.sleep(600);
    }
    // What the transcript looked like BEFORE we sent, so the reply we take can't
    // be the one that was already on screen.
    const priorList = assistantMessages();
    let before = {
      count: priorList.length,
      text: priorList.length ? renderedText(priorList[priorList.length - 1]) : "",
      // What the conversation itself says is the latest reply, right now. The
      // DOM can go blind to new turns in a long chat; this is the comparison
      // that still works when it does.
      apiText: "",
    };
    const priorUuid = conversationUuid();
    if (priorUuid) {
      // The same parser the wait loop will use, or the baseline and the poll
      // compare different readings of the same conversation: a Cowork session
      // parsed only at poll time would read its PREVIOUS reply as fresh.
      const conv = await fetchConversation(priorUuid, 15000);
      before.apiText = W.stripPlaceholders(
        /^cse_/.test(priorUuid) ? W.coworkReplyText(conv) : W.lastAssistantText(conv)
      );
    }

    if (!msg.awaitOnly) {
      // Whatever this step was told to upload, uploaded as-is. Text documents
      // are combined into one file by the worker before the run starts, so by
      // the time a step is sending there is nothing left to decide.
      const { files, missing } = await C.filesFromStorage(msg.files || []);
      if (missing) return { ok: false, error: "missing document bytes: " + missing };
      const folded = (msg.files || []).filter((f) => f && f.bundled > 1);
      for (const f of folded)
        notes.push(f.bundled + " text documents went up as one combined file");
      if (halted)
        return await standDown(runId, halted, "stopped before this step's message went out", notes);
      const sent = await C.sendMessage({
        files,
        text: msg.text || "",
        model: msg.model || null,
        codeRepo: msg.codeRepo || null,
        surface: msg.surface || null,
        approval: msg.approval || null,
        coworkProject: msg.coworkProject || null,
        stop: () => halted,
      });
      if (sent.notes && sent.notes.length) notes.push.apply(notes, sent.notes);
      if (sent.halted)
        return await standDown(
          runId,
          sent.halted,
          "stopped while this step's message was going out",
          notes
        );
      if (!sent.ok)
        return { ok: false, error: sent.error, note: notes.join("; ") || null };
      sentAt = Date.now();
      const url = await settledUrl(20000);
      if (msg.waveKey) await memberSet(msg, { sent: true, url: url, sentAt: sentAt });
      else
        await updateRun(runId, (r) =>
          W.markSent(r, { chatId: msg.chatId, url, now: sentAt })
        );
      // Name it, now the conversation exists — so it has a name even if this
      // step then fails. It gets named again once the reply is in; see below.
      await nameThisChat(msg, null);
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
        // Claude hasn't answered yet, so what the conversation shows NOW is the
        // previous reply — keep it as the thing to beat, or the step would take
        // the answer to the question before this one.
        before = {
          count: list.length,
          text: list.length ? renderedText(list[list.length - 1]) : "",
          apiText: before.apiText || "",
        };
        notes.push("waited for Claude to answer the message already in the chat");
      } else {
        // The answer is already sitting there: anything counts.
        before = { count: -1, text: null, apiText: "" };
      }
      // A chat this run opened may still be sitting unnamed: a worker that
      // died between send and reply died before the rename too, and the pass
      // that follows the reply could be an hour away. Check now, while the
      // reply is awaited, and name it only if nothing has yet — the title of a
      // chat the operator supplied never arrives in msg (see ownsChatName), so
      // this can only ever touch the run's own conversations.
      await nameThisChat(msg, notes, true);
      // The message went out before this tab took the step over; anything the
      // stream signals from here on is fair game. A wave member's own record
      // says when, since the run's single sentAt describes whichever member
      // wrote it last.
      sentAt = msg.waveKey
        ? typeof msg.sentAtKnown === "number"
          ? msg.sentAtKnown
          : 0
        : typeof run.sentAt === "number"
        ? run.sentAt
        : 0;
    }

    // While the reply is written, keep the run's name on the chat — claude.ai
    // auto-titles early, and waiting for the reply to correct that left the
    // chat under the wrong name for the length of the turn.
    const stopNaming = keepNaming(msg);
    let waited;
    try {
      waited = await waitForReply(
        runId,
        before,
        W.STEP_TIMEOUT_MS,
        sentAt,
        msg.marker || null
      );
    } finally {
      stopNaming();
    }
    const {
      el,
      apiText,
      canceled,
      halted: haltedWhileWaiting,
      timedOut,
      interrupted,
      unreadable,
      outOfUsage,
      backAt,
      noRuling,
      skipped: skippedCount,
      marker: wantedMarker,
      via: settledVia,
      state,
    } = waited;
    if (haltedWhileWaiting)
      return await standDown(
        runId,
        haltedWhileWaiting,
        msg.awaitOnly
          ? "stopped while waiting for the answer — read the chat before resuming"
          : "stopped while Claude was answering — the reply in the chat is a fragment",
        notes
      );
    if (canceled) return { ok: false, canceled: true, error: "canceled" };
    // Pause rather than fail: the message went out, the reply is a fragment, and
    // what happens next is a judgement call. The run keeps its place and its
    // phase, so Resume waits for a fresh reply instead of sending again.
    // The message went out and the window emptied before it was answered. Pause
    // with the phase intact, so Resume waits for the reply rather than sending
    // the same message into a second turn.
    if (outOfUsage) {
      await updateRun(runId, (r) =>
        Object.assign({}, W.markPausedForUsage(r, Date.now(), backAt), {
          note:
            "paused at step " + (msg.label || r.stepIndex + 1) + " — your Claude usage ran out while waiting. " +
            (backAt
              ? "Carrying on by itself when it returns at " + new Date(backAt).toLocaleTimeString() + ". "
              : "Carrying on by itself when it returns. ") +
            "The message is already in the chat, so it waits for the answer rather than sending again.",
        })
      );
      return { ok: false, paused: true, error: "out of usage while waiting for the reply" };
    }
    // It answered, it was asked to carry on, and it answered again — and
    // neither reply was the ruling. Everything after this step is written on
    // top of what this one produced, so going on would mean the rest of the run
    // quietly building on something that isn't there. Pause with the phase
    // intact: Resume waits for a fresh reply rather than sending again, so
    // whatever you say to the chat yourself is the reply it takes.
    if (noRuling) {
      await updateRun(runId, (r) =>
        Object.assign({}, W.markPaused(r, Date.now()), {
          note:
            "paused at step " + (msg.label || r.stepIndex + 1) + " — " +
            (skippedCount || 2) + " replies, and none of them contained “" +
            (wantedMarker || W.DEFAULT_OUTPUT_MARKER) + "”. It was asked once to carry on " +
            "and still didn't produce it. Read the chat: finish the ruling there, then Resume.",
        })
      );
      return {
        ok: false,
        paused: true,
        error:
          "no ruling after " + (skippedCount || 2) + " replies — never contained “" +
          (wantedMarker || W.DEFAULT_OUTPUT_MARKER) + "”",
      };
    }
    if (interrupted) {
      await updateRun(runId, (r) =>
        Object.assign({}, W.markPaused(r, Date.now()), {
          note:
            "paused at step " + (msg.label || r.stepIndex + 1) +
            " — Claude's response was interrupted, so the reply is only part of one. " +
            "Read the chat, then Resume (or ask Claude to continue there first).",
        })
      );
      return { ok: false, paused: true, error: "Claude's response was interrupted" };
    }
    if (!el && !apiText) {
      // Say what the wait was actually looking at. "Did not finish in time" on
      // its own is unactionable, and this step costs a whole Claude turn to
      // retry.
      const s = state || {};
      const seen = s.noMessage
        ? "no assistant message ever appeared"
        : (s.chars || 0) + " chars, " +
          (s.fresh ? "recognised as new" : "NOT recognised as new (same as before the send)") + ", " +
          (s.generating ? "page still says generating (" + stopDescription() + ")" : "page says idle") + ", " +
          (s.streamDone ? "response stream closed" : anyStreamSeen ? "no completion stream seen for this turn" : "no stream events at all") +
          (typeof s.apiChars === "number"
            ? ", the conversation itself last showed " + s.apiChars + " chars" +
              (s.apiAnswered ? "" : " (it never answered)")
            : s.coworkShape
            ? ", the Cowork session answered but no reply was recognised in its payload (" +
              s.coworkShape + ") — paste this so the shape can be wired in"
            : s.apiFailed
            ? ", the Cowork session API was asked and didn't answer"
            : s.noConvId
            ? ", and this tab's URL (" + s.path + ") holds no conversation id, so the " +
              "conversation itself was never asked"
            : ", the conversation was never asked") +
          (s.skipped
            ? ' — and ' + s.skipped + " finished repl" + (s.skipped === 1 ? "y" : "ies") +
              ' never contained “' + s.marker + '”, so nothing was handed on'
            : "");
      return {
        ok: false,
        error:
          (unreadable
            ? "Claude finished replying, but the reply could not be read"
            : timedOut
            ? "Claude did not finish replying in time"
            : "no reply found") +
          " — " + seen,
        note: notes.join("; ") || null,
      };
    }
    if (settledVia && settledVia !== "stream" && settledVia !== "api")
      notes.push(
        settledVia === "stalled"
          ? "took the reply after a long stretch unchanged (the page still claimed it was generating — " +
            stopDescription() + ")"
          : anyFrameSeen
          ? "turn end judged from the response socket going quiet (no completion stream in this surface)"
          : "turn end judged from the text holding still — this surface shows the page no " +
            "network signal at all (no event-stream, no socket frames)"
      );

    // The conversation itself answered — no need to go back to the page for a
    // copy of what we already have, and in the case that got us here the page
    // doesn't have it.
    const { text, via, reason, copyWhy } = apiText
      ? { text: apiText, via: "api" }
      : await harvestReply(el);
    if (!text)
      return {
        ok: false,
        error: "could not read Claude's reply" + (reason ? " — " + reason : ""),
        note: notes.join("; ") || null,
      };
    if (via !== "copy")
      notes.push(
        "reply read from the " + (via === "api" ? "conversation API" : "page") +
          " (" + (copyWhy || "the copy box gave nothing usable") + ")"
      );

    const url = location.href;
    // Now the answer is in, claude.ai has done its own auto-titling — so this
    // is the rename that survives.
    await nameThisChat(msg, notes);
    // The meter as it stands now the step has landed. Read here rather than in
    // the worker because this is a claude.ai tab: its own content script keeps
    // the reading current, and by the time the worker hears about the step the
    // reply has been sitting there for a moment already.
    // A member of a wave reports and stops there. Its reply goes to its own
    // key, the worker folds the wave's replies together once they're all in,
    // and the run is advanced exactly once — by the worker, past the whole
    // wave.
    if (msg.waveKey) {
      await memberSet(msg, {
        reply: text,
        chars: text.length,
        url: url,
        at: Date.now(),
        docs: (msg.files || []).length,
      });
      return {
        ok: true,
        url,
        text: text,
        chars: text.length,
        note: notes.join("; ") || null,
      };
    }

    const usageNow = W.usageSample((await C.storageGet("cum_state")).cum_state);
    // …and who else was using Claude while this step ran. The meter is
    // browser-wide, so a step that shared the window with another chat — yours,
    // a scheduled send, another run — can't be measured, and says so rather
    // than reporting somebody else's work as its own.
    const activity = (await C.storageGet("cum_activity")).cum_activity || null;
    const updated = await updateRun(runId, (r) => {
      // This conversation, plus the run's other chats — they're idle while this
      // step runs, and a run must not be able to contaminate itself.
      const mine = [W.conversationKey(location.href)].concat(
        Object.keys(r.chats || {})
          .map((cid) => (r.chats[cid] || {}).url)
          .filter(Boolean)
          .map(W.conversationKey)
      );
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
        usage: usageNow,
        usageClean: W.soleActor(activity, {
          from: r.stepStartedAt,
          to: Date.now(),
          conv: mine,
        }),
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
    // The halt flag is TAB-global, and a Pause or Cancel that reached this tab
    // hours ago — for a step, or for another run entirely — was still standing
    // when Fix & continue asked this tab to re-read its own chat: the harvest
    // answered "canceled" without looking at anything, and the resume recorded
    // that as the run's error. Watching the run resets the flag to what THIS
    // run's record actually says, exactly as a step does on its way in.
    const unwatch = msg.runId ? watchForHalt(msg.runId) : () => {};
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
      unwatch();
      stop();
    }
  }

  // Pressing claude.ai's OWN Stop in a run's conversation pauses the run (the
  // owner's rule): stopping the turn by hand is a decision about the work, and
  // the run finding out a poll later — or not at all, between steps — left it
  // marching on past a stop the operator had already pressed. TRUSTED clicks
  // only: the extension's own Stop presses are dispatched events, so a pause
  // the run itself performs can never echo back as the operator's.
  function pauseRunFor(runId) {
    if (!runId) return;
    try {
      chrome.runtime.sendMessage({ type: "cum-wf-pause", runId: runId }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* the interrupted-reply path still catches it at the next poll */
    }
  }
  async function runOfThisConversation() {
    const J = window.CUMJobs;
    if (!J) return null;
    const ids = (await C.storageGet(W.RUN_IDS_KEY))[W.RUN_IDS_KEY] || [];
    if (!ids.length) return null;
    const store = await C.storageGet(ids.map(W.runKey));
    for (const id of ids) {
      const run = store[W.runKey(id)];
      if (!run || !W.isRunActive(run)) continue;
      for (const cid of Object.keys(run.chats || {})) {
        const url = (run.chats[cid] || {}).url;
        try {
          if (url && J.sameConversationUrl(url, location.href)) return run.id;
        } catch (e) {
          /* try the next chat */
        }
      }
    }
    return null;
  }
  try {
    document.addEventListener(
      "click",
      (e) => {
        if (!e.isTrusted) return;
        let stop = null;
        try {
          stop = C.findStop();
        } catch (err) {
          return;
        }
        if (!stop) return;
        if (e.target !== stop && !(stop.contains && stop.contains(e.target))) return;
        // The step this tab is driving names its run outright; a run's
        // conversation between steps is matched by address, like the pill.
        if (activeStep && activeStep.runId) return pauseRunFor(activeStep.runId);
        runOfThisConversation().then(pauseRunFor);
      },
      true
    );
  } catch (e) {
    /* the interrupted-reply path still pauses mid-step stops */
  }

  chrome.runtime?.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    // Pause was pressed somewhere in this run. Whether or not this tab is
    // mid-step, if Claude is writing in it the rest of that answer is being
    // paid for and thrown away.
    if (msg.type === "cum-wf-stop-generating") {
      if (!halted) halted = "paused";
      let stopped = false;
      try {
        stopped = C.stopGenerating();
      } catch (e) {
        /* ignore */
      }
      sendResponse({ ok: true, stopped: stopped });
      return true;
    }
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
