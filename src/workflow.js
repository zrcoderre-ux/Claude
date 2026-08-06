/**
 * Claude Usage Meter — multi-chat workflow model (pure, testable).
 *
 * A "workflow" runs one piece of work through SEVERAL claude.ai conversations
 * that hand their output back and forth, so each chat criticises or improves
 * what the other produced. The pre-built example: chat A drafts a tentative
 * ruling from the uploaded papers, chat B attacks it with the devil's-advocate
 * skill, A revises, B attacks again — three passes — then A does a final edit
 * and a ruling-style pass.
 *
 * The pieces:
 *   chats  — the conversations worked between (2 in the example). Each has its
 *            own destination (new chat / a Project / Claude Code) and model.
 *   docs   — files stored once per workflow, each assigned to the chats that
 *            should receive them. A chat's documents attach to its FIRST step.
 *   steps  — the ordered sequence. Each step names the chat it runs in, its
 *            prompt, and whether to carry the previous step's reply into it
 *            (the "copy this into the other chat" hand-off).
 *
 * A "run" is one execution of a workflow: which step it's on, the reply it is
 * carrying, and the conversation URL each chat ended up at. Runs are scheduled
 * with the same triggers as a scheduled send (now / at a time / when usage
 * resets), and the background worker drives them a step at a time.
 *
 * Everything here is pure (no chrome/DOM), so it unit-tests under Node.
 */
(function (root) {
  "use strict";

  const WORKFLOWS_KEY = "cum_workflows";
  const RUNS_KEY = "cum_wf_runs";
  const MAX_CHATS = 6;
  // A single step is one whole Claude turn: a long ruling with three tool calls
  // is normal, so this is generous. Past it the step fails loudly rather than
  // leaving the run parked forever.
  const STEP_TIMEOUT_MS = 45 * 60 * 1000;
  // No heartbeat for this long means whoever was driving the step is gone (the
  // tab was closed, the worker died mid-await) — the watchdog takes it back.
  const STALE_MS = 3 * 60 * 1000;

  const LETTERS = "ABCDEF";

  function str(v) {
    return typeof v === "string" ? v : "";
  }
  function trimmed(v) {
    return str(v).trim();
  }

  // ---- chats --------------------------------------------------------------

  function defaultChatName(index) {
    return "Chat " + (LETTERS[index] || String(index + 1));
  }

  // One conversation slot. `target` mirrors a scheduled send's destination
  // fields, so CUMJobs.targetUrl() can resolve it unchanged.
  function newChatSlot(fields, id, index) {
    const f = fields || {};
    return {
      id: id,
      name: trimmed(f.name) || defaultChatName(index || 0),
      target: {
        projectUuid: f.projectUuid || (f.target && f.target.projectUuid) || null,
        projectName: f.projectName || (f.target && f.target.projectName) || null,
        projectHref: f.projectHref || (f.target && f.target.projectHref) || null,
        codeRepo: trimmed(f.codeRepo || (f.target && f.target.codeRepo)) || null,
      },
      model: trimmed(f.model) || null,
    };
  }

  function getChat(wf, chatId) {
    return ((wf && wf.chats) || []).find((c) => c && c.id === chatId) || null;
  }

  function chatName(wf, chatId) {
    const c = getChat(wf, chatId);
    return c ? c.name : "(missing chat)";
  }

  // ---- steps --------------------------------------------------------------

  function newStep(fields, id) {
    const f = fields || {};
    return {
      id: id,
      chatId: f.chatId || null,
      prompt: str(f.prompt),
      // Paste the previous step's reply under this prompt — the hand-off that
      // makes the chats talk to each other. Ignored on the first step (there is
      // nothing to carry yet).
      carry: f.carry !== false,
      carryLabel: trimmed(f.carryLabel) || "",
    };
  }

  // ---- documents ----------------------------------------------------------

  // A file stored under cum_file_<id>, plus the chats that should receive it.
  function newDoc(fields, id) {
    const f = fields || {};
    return {
      id: id,
      name: trimmed(f.name) || "file",
      type: str(f.type),
      size: typeof f.size === "number" ? f.size : 0,
      chats: Array.isArray(f.chats) ? f.chats.slice() : [],
    };
  }

  function docsForChat(wf, chatId) {
    return ((wf && wf.docs) || []).filter(
      (d) => d && Array.isArray(d.chats) && d.chats.indexOf(chatId) !== -1
    );
  }

  // ---- workflow -----------------------------------------------------------

  function newWorkflow(fields, id, now) {
    const f = fields || {};
    const wf = {
      id: id,
      name: trimmed(f.name) || "Untitled workflow",
      description: trimmed(f.description),
      builtin: !!f.builtin,
      chats: (f.chats || []).map((c, i) => newChatSlot(c, c && c.id, i)),
      docs: (f.docs || []).map((d) => newDoc(d, d && d.id)),
      steps: (f.steps || []).map((s) => newStep(s, s && s.id)),
      createdAt: typeof f.createdAt === "number" ? f.createdAt : now,
      updatedAt: now,
    };
    return normalize(wf);
  }

  // Drop references to chats that no longer exist, and keep the first step's
  // carry flag honest. Cheap enough to run on every save.
  function normalize(wf) {
    if (!wf) return wf;
    const ids = new Set((wf.chats || []).map((c) => c.id));
    const fallback = (wf.chats || []).length ? wf.chats[wf.chats.length - 1].id : null;
    wf.steps = (wf.steps || []).map((s, i) =>
      Object.assign({}, s, {
        // A step whose chat was deleted moves to the last remaining chat rather
        // than being thrown away — its prompt is the expensive part.
        chatId: ids.has(s.chatId) ? s.chatId : fallback,
        carry: i === 0 ? false : s.carry !== false,
      })
    );
    wf.docs = (wf.docs || []).map((d) =>
      Object.assign({}, d, { chats: (d.chats || []).filter((c) => ids.has(c)) })
    );
    return wf;
  }

  // Grow or shrink the number of conversations worked between. Steps and
  // document assignments pointing at removed chats are remapped by normalize().
  function setChatCount(wf, n, mkId) {
    const out = Object.assign({}, wf, { chats: (wf.chats || []).slice() });
    const want = Math.max(1, Math.min(MAX_CHATS, Math.floor(n) || 1));
    while (out.chats.length < want)
      out.chats.push(newChatSlot({}, mkId(), out.chats.length));
    if (out.chats.length > want) out.chats.length = want;
    out.steps = (wf.steps || []).slice();
    out.docs = (wf.docs || []).map((d) => Object.assign({}, d));
    return normalize(out);
  }

  function cloneWorkflow(wf, id, now, mkId) {
    const chatMap = {};
    const chats = (wf.chats || []).map((c, i) => {
      const nid = mkId();
      chatMap[c.id] = nid;
      return Object.assign({}, c, { id: nid, target: Object.assign({}, c.target) });
    });
    return normalize({
      id: id,
      name: (wf.name || "Workflow") + " (copy)",
      description: wf.description || "",
      builtin: false, // a copy is yours, however it started life
      chats: chats,
      // Documents keep their file ids: the bytes are shared, and deleting one
      // workflow only drops bytes no other workflow still references
      // (see fileIdsInUse).
      docs: (wf.docs || []).map((d) =>
        Object.assign({}, d, { chats: (d.chats || []).map((c) => chatMap[c]).filter(Boolean) })
      ),
      steps: (wf.steps || []).map((s) =>
        Object.assign({}, s, { id: mkId(), chatId: chatMap[s.chatId] || null })
      ),
      createdAt: now,
      updatedAt: now,
    });
  }

  function upsertWorkflow(list, wf) {
    const out = (list || []).slice();
    const i = out.findIndex((w) => w && w.id === wf.id);
    if (i === -1) out.push(wf);
    else out[i] = wf;
    return out;
  }

  function removeWorkflow(list, id) {
    return (list || []).filter((w) => w && w.id !== id);
  }

  function getWorkflow(list, id) {
    return (list || []).find((w) => w && w.id === id) || null;
  }

  // File ids still referenced by any workflow other than `exceptId` — deleting a
  // workflow must not take a copy's document bytes with it.
  function fileIdsInUse(list, exceptId) {
    const ids = new Set();
    for (const w of list || []) {
      if (!w || w.id === exceptId) continue;
      for (const d of w.docs || []) if (d && d.id) ids.add(d.id);
    }
    return ids;
  }

  // Problems that would make a run pointless or confusing. Returned as text so
  // the editor can show them verbatim.
  function validate(wf) {
    const problems = [];
    if (!wf || !trimmed(wf.name)) problems.push("Give the workflow a name.");
    if (!wf || !(wf.chats || []).length) problems.push("A workflow needs at least one chat.");
    if (!wf || !(wf.steps || []).length) problems.push("Add at least one step.");
    for (const s of (wf && wf.steps) || []) {
      if (!trimmed(s.prompt)) {
        problems.push("Every step needs a prompt.");
        break;
      }
    }
    const orphan = ((wf && wf.docs) || []).filter((d) => !(d.chats || []).length);
    if (orphan.length)
      problems.push(
        orphan.length + " document(s) aren't assigned to a chat — they won't be uploaded."
      );
    return problems;
  }

  // What each chat will actually receive, per chat. A workflow whose prompts
  // talk about "the attached papers" while nothing is assigned anywhere is the
  // failure this makes visible before you start rather than after.
  function uploadPlan(wf) {
    return ((wf && wf.chats) || []).map((c) => ({
      chatId: c.id,
      name: c.name,
      docs: docsForChat(wf, c.id).length,
    }));
  }

  function totalUploads(wf) {
    return uploadPlan(wf).reduce((n, c) => n + c.docs, 0);
  }

  function uploadSummary(wf) {
    const plan = uploadPlan(wf);
    if (!plan.length) return "no chats";
    const total = plan.reduce((n, c) => n + c.docs, 0);
    if (!total) return "no documents will be uploaded";
    return "uploads: " + plan.map((c) => c.name + " " + c.docs).join(" · ");
  }

  function summarize(wf) {
    const chats = (wf && wf.chats ? wf.chats.length : 0);
    const steps = (wf && wf.steps ? wf.steps.length : 0);
    const docs = (wf && wf.docs ? wf.docs.length : 0);
    const bits = [
      chats + " chat" + (chats === 1 ? "" : "s"),
      steps + " step" + (steps === 1 ? "" : "s"),
    ];
    if (docs) bits.push(docs + " document" + (docs === 1 ? "" : "s"));
    return bits.join(" · ");
  }

  // ---- the run plan -------------------------------------------------------

  // Expand a workflow into the ordered list the runner walks. Each entry knows
  // its chat, the text's hand-off, and which documents to attach — documents go
  // up on the chat's FIRST step, because that's the message that opens the
  // conversation.
  function planRun(wf) {
    const seen = new Set();
    return ((wf && wf.steps) || []).map((s, i) => {
      const firstInChat = !seen.has(s.chatId);
      seen.add(s.chatId);
      return {
        index: i,
        id: s.id,
        chatId: s.chatId,
        chatName: chatName(wf, s.chatId),
        prompt: str(s.prompt),
        carry: i > 0 && s.carry !== false,
        carryLabel: trimmed(s.carryLabel) || "material from the previous step",
        firstInChat: firstInChat,
        docIds: firstInChat ? docsForChat(wf, s.chatId).map((d) => d.id) : [],
      };
    });
  }

  // The message actually typed into the composer: the step's prompt, with the
  // previous chat's reply pasted underneath between markers. This is the
  // copy-and-paste the workflow automates, so the markers are explicit — Claude
  // needs to know where the quoted material starts and stops.
  function composeStepText(step, prevReply) {
    const prompt = str(step && step.prompt).trim();
    const reply = str(prevReply).trim();
    if (!step || !step.carry || !reply) return prompt;
    const label = (step.carryLabel || "material from the previous step").toUpperCase();
    return [
      prompt,
      "",
      "----- BEGIN " + label + " -----",
      reply,
      "----- END " + label + " -----",
    ].join("\n");
  }

  // ---- runs ---------------------------------------------------------------

  function newRun(wf, id, now, trigger) {
    const t = trigger || {};
    return {
      id: id,
      workflowId: wf ? wf.id : null,
      name: wf ? wf.name : "Workflow",
      totalSteps: wf && wf.steps ? wf.steps.length : 0,
      trigger:
        t.type === "time"
          ? { type: "time", at: t.at }
          : t.type === "reset"
          ? { type: "reset" }
          : { type: "now" },
      status: "pending", // pending | waiting | running | done | error | canceled
      stepIndex: 0,
      phase: "idle", // idle | sending | awaiting-reply
      chats: {}, // chatId -> { url }
      lastReply: "",
      transcript: [], // { stepIndex, chatId, chatName, at, chars }
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      lastProgressAt: now,
      error: null,
      note: null,
      heldSince: null,
      holdReason: null,
    };
  }

  function upsertRun(list, run) {
    const out = (list || []).slice();
    const i = out.findIndex((r) => r && r.id === run.id);
    if (i === -1) out.push(run);
    else out[i] = run;
    return out;
  }

  function removeRun(list, id) {
    return (list || []).filter((r) => r && r.id !== id);
  }

  function getRun(list, id) {
    return (list || []).find((r) => r && r.id === id) || null;
  }

  function isRunActive(run) {
    return (
      !!run &&
      (run.status === "pending" || run.status === "waiting" || run.status === "running")
    );
  }

  // Runs whose trigger has fired and are waiting only on the runner.
  function dueRuns(runs, now) {
    return (runs || []).filter(
      (r) =>
        r &&
        r.status === "pending" &&
        r.trigger &&
        (r.trigger.type === "now" ||
          (r.trigger.type === "time" &&
            typeof r.trigger.at === "number" &&
            r.trigger.at <= now))
    );
  }

  function pendingResetRuns(runs) {
    return (runs || []).filter(
      (r) => r && r.status === "pending" && r.trigger && r.trigger.type === "reset"
    );
  }

  function heldRuns(runs) {
    return (runs || []).filter((r) => r && r.status === "waiting");
  }

  // Runs a restarted worker should take over. A run sitting BETWEEN steps
  // (phase "idle") is always free to pick up — nobody is mid-step. A run whose
  // step is in flight is only picked up once its heartbeat has gone quiet, so a
  // worker restart can never re-send a message that is still on its way out.
  function pickupRuns(runs, now, staleMs) {
    return (runs || []).filter(
      (r) =>
        r &&
        r.status === "running" &&
        (r.phase === "idle" || !r.phase || isStale(r, now, staleMs))
    );
  }

  function isStale(run, now, staleMs) {
    const at = run && typeof run.lastProgressAt === "number" ? run.lastProgressAt : 0;
    return now - at > (staleMs || STALE_MS);
  }

  function nextRunTrigger(runs, now) {
    let soonest = null;
    for (const r of runs || []) {
      if (!r || r.status !== "pending" || !r.trigger || r.trigger.type !== "time") continue;
      if (typeof r.trigger.at !== "number") continue;
      if (soonest == null || r.trigger.at < soonest) soonest = r.trigger.at;
    }
    return soonest;
  }

  // --- run state transitions (the runner and the worker both go through
  // these, so a step can only ever move the run one way) ---

  function markStarted(run, now) {
    return Object.assign({}, run, {
      status: "running",
      startedAt: run.startedAt || now,
      lastProgressAt: now,
      error: null,
      heldSince: null,
      holdReason: null,
    });
  }

  // About to drive a step. Marked before the message is dispatched so a worker
  // restart mid-send sees "someone is on this" rather than sending it again.
  function markSending(run, now) {
    return Object.assign({}, run, { status: "running", phase: "sending", lastProgressAt: now });
  }

  // The step's message is on its way out; from here a retry must NOT re-send it
  // (that would double-post into the conversation) — it re-attaches a waiter.
  function markSent(run, info) {
    const i = info || {};
    const chats = Object.assign({}, run.chats);
    if (i.chatId && i.url) chats[i.chatId] = Object.assign({}, chats[i.chatId], { url: i.url });
    return Object.assign({}, run, {
      status: "running",
      phase: "awaiting-reply",
      chats: chats,
      sentAt: i.now,
      lastProgressAt: i.now,
    });
  }

  function heartbeat(run, now) {
    return Object.assign({}, run, { lastProgressAt: now });
  }

  // A step finished and gave us its reply: carry it forward, and finish the run
  // if that was the last step.
  function applyStepResult(run, info) {
    const i = info || {};
    if (!run) return run;
    // Ignore a result for a step we've already moved past (a duplicate response
    // from a retried step must not advance the run twice).
    if (typeof i.stepIndex === "number" && i.stepIndex !== run.stepIndex) return run;
    const chats = Object.assign({}, run.chats);
    if (i.chatId) chats[i.chatId] = Object.assign({}, chats[i.chatId], { url: i.url || (chats[i.chatId] || {}).url || null });
    const next = run.stepIndex + 1;
    const total = typeof i.total === "number" ? i.total : run.totalSteps;
    const reply = str(i.reply);
    const done = next >= total;
    return Object.assign({}, run, {
      status: done ? "done" : "running",
      phase: "idle",
      stepIndex: next,
      lastReply: reply,
      chats: chats,
      transcript: (run.transcript || []).concat([
        {
          stepIndex: run.stepIndex,
          chatId: i.chatId || null,
          chatName: i.chatName || null,
          at: i.now,
          chars: reply.length,
          // What went up with this step. Recorded even when it's zero: a step
          // that was meant to carry the papers and didn't must be visible after
          // the fact, not only in the moment.
          docs: typeof i.docs === "number" ? i.docs : 0,
        },
      ]),
      lastProgressAt: i.now,
      sentAt: null,
      finishedAt: done ? i.now : null,
      error: null,
    });
  }

  function markError(run, message, now) {
    return Object.assign({}, run, {
      status: "error",
      phase: "idle",
      error: str(message) || "unknown error",
      lastProgressAt: now,
      finishedAt: now,
    });
  }

  function markHeld(run, reason, now) {
    return Object.assign({}, run, {
      status: "waiting",
      phase: "idle",
      heldSince: typeof run.heldSince === "number" ? run.heldSince : now,
      holdReason: str(reason),
      lastProgressAt: now,
    });
  }

  function markCanceled(run, now) {
    return Object.assign({}, run, {
      status: "canceled",
      phase: "idle",
      lastProgressAt: now,
      finishedAt: now,
    });
  }

  function progressText(run, wf) {
    if (!run) return "";
    const total = run.totalSteps || (wf && wf.steps ? wf.steps.length : 0);
    if (run.status === "done") return "Finished all " + total + " steps";
    if (run.status === "canceled") return "Canceled at step " + (run.stepIndex + 1);
    if (run.status === "error") return "Failed at step " + (run.stepIndex + 1) + " of " + total;
    if (run.status === "pending") return "Queued · " + total + " steps";
    const plan = wf ? planRun(wf) : [];
    const step = plan[run.stepIndex];
    const where = step ? " · " + step.chatName : "";
    const verb = run.phase === "awaiting-reply" ? "waiting for Claude" : "sending";
    return "Step " + (run.stepIndex + 1) + " of " + total + where + " — " + verb;
  }

  // ---- reading Claude's reply --------------------------------------------

  // Pull the newest assistant message out of a conversation payload
  // (GET /api/organizations/{org}/chat_conversations/{uuid}). This is what gets
  // "copied" into the next chat, so we take the text blocks only — thinking and
  // tool-use blocks are Claude's scratch work, not its answer.
  function lastAssistantText(conv) {
    const msgs = conv && Array.isArray(conv.chat_messages) ? conv.chat_messages : null;
    if (!msgs || !msgs.length) return "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || typeof m !== "object") continue;
      const sender = str(m.sender || m.role).toLowerCase();
      if (sender !== "assistant") continue;
      const text = messageText(m);
      if (text) return text;
    }
    return "";
  }

  function messageText(m) {
    const parts = [];
    if (Array.isArray(m.content)) {
      for (const blk of m.content) {
        if (!blk || typeof blk !== "object") continue;
        const type = str(blk.type);
        if (type && type !== "text") continue; // skip thinking / tool_use / tool_result
        if (typeof blk.text === "string") parts.push(blk.text);
      }
    }
    const joined = parts.join("\n").trim();
    if (joined) return joined;
    return str(m.text).trim();
  }

  // The control under a finished reply that copies it. Claude's copy box hands
  // back the answer WITHOUT the thinking block, which is exactly what should be
  // pasted into the next chat — so the runner clicks it rather than scraping the
  // rendered message. Matched exactly, and never "Copy code": a code block has
  // its own copy button, and copying one fenced snippet instead of the ruling
  // would be a silent, plausible-looking wrong answer.
  const COPY_LABELS = ["copy", "copy message", "copy response", "copy to clipboard"];
  function isCopyLabel(text) {
    const s = str(text).replace(/\s+/g, " ").trim().toLowerCase().replace(/[.:]+$/, "");
    return COPY_LABELS.indexOf(s) !== -1;
  }

  // Guard on what the copy box handed back. A code block's own copy control
  // sits in the same message and yields a fragment; pasting that into the next
  // chat would look like a real answer while being nothing of the kind. If the
  // copied text is a small fraction of what's rendered on screen, distrust it
  // and let the caller fall back to the conversation payload.
  function plausibleCopy(copied, rendered) {
    const c = trimmed(copied);
    if (!c) return false;
    const r = trimmed(rendered);
    if (r.length < 200) return true; // too short to judge — take it
    return c.length >= r.length * 0.3;
  }

  // Is what's on screen now a NEW reply, rather than the one that was already
  // there when we sent? Counting rendered assistant turns is not enough on its
  // own: claude.ai's transcript can have only the newest turn in the DOM, so the
  // count sits at 1 however many replies arrive. Either the count growing or the
  // text differing from what was last there means a new answer — and a step that
  // waits on the count alone would hang until it timed out.
  function isNewReply(sample) {
    const s = sample || {};
    const text = trimmed(s.text);
    if (!text) return false;
    if ((s.count || 0) > (s.beforeCount == null ? 0 : s.beforeCount)) return true;
    return text !== trimmed(s.beforeText);
  }

  // Has this turn finished? Two ways to know, and they are not equally good.
  //
  // `streamDone` is the assistant's own response stream closing, reported from
  // the network layer. It cannot be faked by a pause mid-turn and does not care
  // whether the tab is focused or being rendered, so when it's there the DOM
  // only has to have caught up.
  //
  // Without it we fall back to the text holding still — and that reading is
  // weak in a background tab, where timers are throttled to about once a minute
  // and layout may not run at all. A single "it hasn't changed" observation
  // taken across a throttled gap says nothing, so several consecutive ones are
  // required. This is what stops a run from bolting to the next step the moment
  // you click into the tab and the poll loop speeds back up.
  // Why we believe the turn is over — "stream", "stable", "stalled", or null if
  // we don't yet. Returning the reason rather than a bare boolean means a run
  // can say which evidence it acted on, which is the difference between a
  // diagnosable failure and another round of guessing.
  function settleReason(sample) {
    const s = sample || {};
    if (!trimmed(s.text)) return null;
    const unchanged = s.unchangedMs || 0;

    // The response stream for THIS message closed. Authoritative, and
    // deliberately outranks the DOM: if a Stop control is still on screen after
    // the stream ended, the DOM is wrong, and waiting on it hangs the run.
    if (s.streamDone)
      return unchanged >= (typeof s.minSettleMs === "number" ? s.minSettleMs : 1200)
        ? "stream"
        : null;

    if (s.generating) {
      // The page says Claude is still going. Believe it — up to a point. A
      // reply that hasn't changed in minutes is finished whatever the Stop
      // button claims, and a step that waits 45 minutes to say nothing is worse
      // than one that moves on and says how it decided.
      const stalled = typeof s.stalledMs === "number" ? s.stalledMs : 180000;
      return unchanged >= stalled ? "stalled" : null;
    }

    return unchanged >= (typeof s.minStableMs === "number" ? s.minStableMs : 6000) &&
      (s.stablePolls || 0) >= (typeof s.minStablePolls === "number" ? s.minStablePolls : 3)
      ? "stable"
      : null;
  }

  function turnSettled(sample) {
    return !!settleReason(sample);
  }

  // ---- the pre-built workflow --------------------------------------------

  const DRAFT_PROMPT =
    "Use the tentative-ruling skill.\n\n" +
    "Draft a California civil tentative ruling on the attached motion package. " +
    "Cover every argument raised in the moving, opposing and reply papers, cite the " +
    "record for each fact you rely on, and write the ruling out in full as text in " +
    "this chat (no Word document).";

  const DA_PROMPT =
    "Use the devils-advocate skill.\n\n" +
    "Attack the merits of the draft tentative ruling below. Name each holding's " +
    "load-bearing premises and what happens if they fail, test whether every cited " +
    "authority actually holds what it is cited for, attack the inferential steps, " +
    "and give the best argument the losing party missed. Report only challenges " +
    "that survive the Court's obvious rebuttal.";

  const REVISE_PROMPT =
    "Revise the tentative ruling using the devil's advocate report below.\n\n" +
    "Fix what is genuinely wrong, shore up reasoning that is merely thin, and where " +
    "you disagree with a challenge, say so briefly and leave the ruling as it is. " +
    "Then output the complete revised ruling as text — not a diff, not a summary.";

  const FINAL_PROMPT =
    "Final substantive pass. Re-read the ruling as a whole now that it has been " +
    "through three rounds of criticism: check that the revisions still hang " +
    "together, that nothing contradicts an earlier section, that every argument in " +
    "the papers is still addressed, and that the disposition matches the analysis. " +
    "Output the complete ruling as text.";

  const STYLE_PROMPT =
    "Use the ruling-style skill.\n\n" +
    "Line-edit the ruling for voice, style and sentence craft only. Do not revisit " +
    "the holdings or the analysis; flag anything substantive you notice without " +
    "fixing it. Output the complete edited ruling as text.";

  const DA_PASSES = 3;

  // The worked example from the repo owner: two chats, three devil's-advocate
  // rounds, a final substantive edit, then a style pass.
  function builtinWorkflow(mkId, now) {
    const a = mkId();
    const b = mkId();
    const steps = [];
    const push = (chatId, prompt, carryLabel) =>
      steps.push({ id: mkId(), chatId, prompt, carry: steps.length > 0, carryLabel });

    push(a, DRAFT_PROMPT, "");
    for (let pass = 1; pass <= DA_PASSES; pass++) {
      push(b, DA_PROMPT, "draft tentative ruling");
      push(
        a,
        pass < DA_PASSES ? REVISE_PROMPT : REVISE_PROMPT + "\n\n(This is the third and final devil's advocate round.)",
        "devil's advocate report"
      );
    }
    push(a, FINAL_PROMPT, "");
    push(a, STYLE_PROMPT, "");
    // The A-chat steps after the first are already in that conversation, so they
    // only need what B sent back; the final and style passes carry nothing.
    steps[steps.length - 1].carry = false;
    steps[steps.length - 2].carry = false;

    return newWorkflow(
      {
        name: "Tentative ruling — 3× devil's advocate",
        description:
          "Chat A drafts the tentative from the uploaded papers; chat B attacks it with " +
          "the devil's-advocate skill; A revises. Three rounds, then a final substantive " +
          "edit and a ruling-style pass, both in A.",
        builtin: true,
        chats: [
          { id: a, name: "Drafting (A)" },
          { id: b, name: "Devil's advocate (B)" },
        ],
        docs: [],
        steps: steps,
      },
      mkId(),
      now
    );
  }

  const api = {
    WORKFLOWS_KEY,
    RUNS_KEY,
    MAX_CHATS,
    STEP_TIMEOUT_MS,
    STALE_MS,
    defaultChatName,
    newChatSlot,
    getChat,
    chatName,
    newStep,
    newDoc,
    docsForChat,
    newWorkflow,
    normalize,
    setChatCount,
    cloneWorkflow,
    upsertWorkflow,
    removeWorkflow,
    getWorkflow,
    fileIdsInUse,
    validate,
    summarize,
    uploadPlan,
    totalUploads,
    uploadSummary,
    planRun,
    composeStepText,
    newRun,
    upsertRun,
    removeRun,
    getRun,
    isRunActive,
    dueRuns,
    pendingResetRuns,
    heldRuns,
    pickupRuns,
    isStale,
    nextRunTrigger,
    markStarted,
    markSending,
    markSent,
    heartbeat,
    applyStepResult,
    markError,
    markHeld,
    markCanceled,
    progressText,
    lastAssistantText,
    isCopyLabel,
    COPY_LABELS,
    plausibleCopy,
    isNewReply,
    settleReason,
    turnSettled,
    builtinWorkflow,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMWorkflow = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
