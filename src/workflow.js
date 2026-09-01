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
  const RUNS_KEY = "cum_wf_runs"; // legacy single-array store, migrated on load
  // Each run lives under its OWN key, with a small list of ids beside it.
  // Everything writes runs: the worker at step boundaries, each run's page as
  // it works, the options page when you edit one. Sharing a single array means
  // read-modify-write from three contexts at once, and with two runs going
  // that's hundreds of chances for one to overwrite the other's progress with
  // a copy it read a moment earlier. Separate keys can't collide.
  const RUN_IDS_KEY = "cum_wf_run_ids";
  const RUN_PREFIX = "cum_wf_run_";
  const BEAT_PREFIX = "cum_wf_beat_";
  function runKey(id) {
    return RUN_PREFIX + id;
  }
  // A run's heartbeat is its own key too: it's written every 20 seconds by the
  // page, and it must never carry a stale copy of the run back over a status
  // the worker just set (a pause, say).
  function beatKey(id) {
    return BEAT_PREFIX + id;
  }
  // And a step running alongside others gets a key of its own, for the same
  // reason twice over: three tabs are working at once, and each has to be able
  // to say "mine went out" and "mine came back" without reading and rewriting
  // a record the other two are also holding. The worker collects them.
  const MEMBER_PREFIX = "cum_wf_wave_";
  function memberKey(runId, stepIndex) {
    return MEMBER_PREFIX + runId + "_" + stepIndex;
  }
  const MAX_CHATS = 6;
  // A single step is one whole Claude turn: a long ruling with three tool calls,
  // or a verification pass over four uploaded papers, so an hour of patience is
  // the point rather than the exception. Past it the step fails loudly rather
  // than leaving the run parked forever.
  const STEP_TIMEOUT_MS = 60 * 60 * 1000;
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
        // Which surface this chat opens on. It sits in `target` beside the
        // project because it is a fact about where the chat lives, and because
        // CUMJobs.targetUrl() reads these same names — a chat that says
        // "cowork" has to resolve to the composer home the way a job does.
        surface: trimmed(f.surface || (f.target && f.target.surface)) || null,
      },
      model: trimmed(f.model) || null,
      // Start this chat in a conversation that already exists, rather than
      // opening a fresh one. Matter-specific like the papers are, so Start
      // hands it to the run and clears it from the template.
      startUrl: trimmed(f.startUrl) || null,
      // ...and let that conversation stand in for the steps that would have
      // produced it. Its latest reply becomes the hand-off, and the run begins
      // at the first step that isn't in this chat — a step 0 that already
      // happened, by hand.
      seedFromLatest: !!f.seedFromLatest,
    };
  }

  // The phrase a step's reply must contain before it can travel. Only the real
  // thing carries it, which makes it a cheap and honest test.
  const DEFAULT_OUTPUT_MARKER = "NATURE OF PROCEEDINGS";
  function stepMarker(step) {
    if (!step || !step.expectsRuling) return null;
    return trimmed(step.outputMarker) || DEFAULT_OUTPUT_MARKER;
  }
  function hasMarker(text, marker) {
    const m = trimmed(marker).replace(/\s+/g, " ").toLowerCase();
    if (!m) return true;
    return str(text).replace(/\s+/g, " ").toLowerCase().indexOf(m) !== -1;
  }

  /**
   * The marker turning up is the START of the ruling, not the end of it.
   *
   * "NATURE OF PROCEEDINGS" is the first line a tentative ruling has. A step
   * that took the reply the moment it saw those words would be taking a heading
   * and whatever had been written under it in the second since — and a ruling
   * that verifies authority by live retrieval goes quiet for minutes at a time
   * in the middle, so "it stopped changing" is a weak reading on its own. Both
   * failures are silent: the rest of the run builds on half a ruling and reads
   * perfectly well doing it.
   *
   * So a matching reply has to go QUIET before it counts: nothing generating,
   * no completion stream open for this turn, and the text unmoved for a good
   * while. Much longer than the ordinary settle, because being early here costs
   * a whole run and being late costs a minute.
   */
  const RULING_QUIET_MS = 60000;
  function quietEnough(state, defaultQuietMs) {
    const s = state || {};
    if (s.generating || s.streamOpen) return false;
    const quiet = typeof s.quietMs === "number" ? s.quietMs : defaultQuietMs;
    return (s.unchangedMs || 0) >= quiet;
  }
  function rulingReady(state) {
    return quietEnough(state, RULING_QUIET_MS);
  }

  /**
   * The page's own mid-turn furniture — NOT a word Claude wrote to you.
   *
   * A collapsed thinking block shows a caption while it runs ("Thinking",
   * "Thought for 12s"), and a skill or tool call leaves a line behind it ("Used
   * a skill", "Ran skill: record-verification"). Read off the page, that IS the
   * whole of the turn's text for as long as the call takes — minutes, for a
   * skill that verifies authority by live retrieval — and it holds perfectly
   * still the entire time. A run that reads stillness as a finished answer then
   * takes the caption for a reply that came out wrong and tells the chat to
   * carry on, mid-turn, over the top of the work it is still doing.
   *
   * So the captions are matched and REMOVED rather than read line by line: the
   * page glues them together with no whitespace between ("Used a skillRan
   * skill: record-verification"), so there are no lines to read. What is left
   * once they are gone is the reply — and if nothing is left, there is no reply
   * here yet.
   *
   * Removal is also what makes this safe on real prose. Only text that is
   * ENTIRELY furniture qualifies; a reply that happens to mention a skill still
   * has all its other words, and they are what the length test sees.
   */
  const CHATTER_RES = [
    // A skill or tool call, with or without the name it ran under.
    /\b(?:used|using|ran|running)\s+(?:an?|the)?\s*(?:skill|tool|connector)s?\b\s*:?\s*[\w./-]*/gi,
    /\b(?:skill|tool)\s*:\s*[\w./-]+/gi,
    // The thinking block's caption, and the control that folds it away.
    /\bthinking\b/gi,
    /\bthought\s+for\s+[\d.]+\s*(?:s|sec|secs|seconds|m|min|mins|minutes)?\b/gi,
    /\b(?:show|hide)\s+(?:thinking|working|details|steps)\b/gi,
    // Search furniture, which reads the same way.
    /\b(?:searched|searching)\s+(?:the\s+)?(?:web|for)\b/gi,
    /\bweb\s+search\b/gi,
  ];
  // What may be left over and still count as nothing: the punctuation and the
  // counters the page hangs off these captions ("·", "3 steps", an ellipsis).
  const CHATTER_LEFTOVER_MAX = 12;
  // The page concatenates its captions with NOTHING between them, so the only
  // seam left is the case change where one ends and the next begins ("Used a
  // skillRan skill: …"). Put a break back at that seam before matching, or the
  // word boundary the patterns need never exists. Harmless on prose: it is only
  // ever counting what is left over.
  function unglue(text) {
    return str(text).replace(/([a-z0-9.)\]])([A-Z])/g, "$1\n$2");
  }
  function isToolChatter(text) {
    const t = unglue(stripPlaceholders(text));
    if (!trimmed(t)) return false; // nothing at all is not the same as furniture
    let rest = t;
    let matched = false;
    for (const re of CHATTER_RES) {
      re.lastIndex = 0;
      if (!re.test(rest)) continue;
      matched = true;
      re.lastIndex = 0;
      rest = rest.replace(re, " ");
    }
    if (!matched) return false;
    return rest.replace(/[^a-z0-9]/gi, "").length <= CHATTER_LEFTOVER_MAX;
  }

  /**
   * May this reply be told to carry on?
   *
   * The nudge costs a Claude turn and lands in the chat as a message, so being
   * early with it is expensive twice over: the turn it interrupts is still
   * being written, and the turn it buys is spent answering a question the chat
   * had already started answering. Two things have to be true first.
   *
   * There has to be a reply at all — page furniture is not one (isToolChatter),
   * and neither is a blank.
   *
   * And it has to have STOPPED: nothing generating, no completion stream open,
   * and the text unmoved for as long as a matching reply must hold still before
   * it counts as finished. The same standard, for the same reason — a turn that
   * has gone quiet to run a tool looks exactly like a turn that has ended, and
   * only time tells them apart.
   */
  const NUDGE_QUIET_MS = RULING_QUIET_MS;
  function nudgeReady(state) {
    const s = state || {};
    if (!trimmed(s.text)) return false;
    if (isToolChatter(s.text)) return false;
    return quietEnough(s, NUDGE_QUIET_MS);
  }

  /**
   * What to say to a chat that answered without producing the ruling.
   *
   * The commonest reason is the turn ending at the tool-use limit part-way
   * through — Claude has more to write and is waiting to be told to carry on.
   * Asked once, and only once: a chat that has now been told twice what to
   * produce and still hasn't is not going to be argued into it, and a run that
   * keeps nudging is a run quietly burning the usage the rest of it needs.
   */
  function continuePrompt(marker) {
    const m = trimmed(marker) || DEFAULT_OUTPUT_MARKER;
    return (
      "Continue from exactly where you stopped and output the complete text in " +
      "this reply — the whole of it, not a summary, not a diff, and not a " +
      "description of what you would write. It must contain “" + m + "”."
    );
  }

  // A claude.ai conversation link, near enough to warn about a wrong paste
  // without refusing a shape claude.ai might legitimately use.
  function looksLikeChatUrl(url) {
    const u = trimmed(url);
    if (!u) return false;
    return /^https?:\/\/claude\.ai\/(chat|code|cowork)\//i.test(u);
  }

  function getChat(wf, chatId) {
    return ((wf && wf.chats) || []).find((c) => c && c.id === chatId) || null;
  }

  function chatName(wf, chatId) {
    const c = getChat(wf, chatId);
    return c ? c.name : "(missing chat)";
  }

  // ---- steps --------------------------------------------------------------

  // Whole minutes, and never negative. Zero means indefinite — there is no
  // useful "pause for no time", so the falsy value takes the meaning that has
  // to be expressible.
  const PAUSE_MAX_MINUTES = 7 * 24 * 60; // a week; past that, Not yet is the answer
  function pauseMinutes(x) {
    const n = Math.floor(Number(x));
    if (!isFinite(n) || n <= 0) return 0;
    return Math.min(n, PAUSE_MAX_MINUTES);
  }
  function isPauseStep(step) {
    return !!(step && step.kind === "pause");
  }

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
      // Which model answers THIS step. Null means the chat's own choice, which
      // is what nearly every step wants; setting it lets one conversation be
      // drafted by one model and criticised by another, which is the whole
      // point of being able to try combinations.
      model: trimmed(f.model) || null,
      // Steps sharing a group id, and sitting next to each other, run at the
      // same time — see stepWaves.
      group: trimmed(f.group) || null,
      // A step that is a PAUSE rather than a prompt: the run stops here so what
      // it has produced can be read before the rest of it is built on top.
      //
      // Two kinds, and the difference is what happens when you aren't there.
      // Indefinite waits for Resume, which is right when reviewing the
      // intermediate output is the point. A timed one waits that long and then
      // carries on by itself — which is right when you would LIKE to look but
      // would rather the run finished than sat all night waiting for you.
      kind: f.kind === "pause" ? "pause" : "prompt",
      pauseMinutes: pauseMinutes(f.pauseMinutes),
      // This STEP is expected to produce a finished ruling, and a reply that
      // isn't one must not be handed on. Claude's first answer is often a
      // clarifying question, a note that a paper is missing, or a prompt to
      // continue — all perfectly good replies, and none of them the thing the
      // next chat is being asked to attack.
      //
      // It belongs to the step rather than the chat because a chat does more
      // than one thing: the drafting conversation writes the ruling, then
      // revises it, then takes a style pass over it, and the answer to "must
      // this reply be a ruling" differs between them. Asked of the chat, one
      // answer had to cover them all.
      expectsRuling: !!f.expectsRuling,
      outputMarker: trimmed(f.outputMarker) || null,
    };
  }

  // ---- parallel steps ------------------------------------------------------
  //
  // A WAVE is a run of adjacent steps that share a group id. They all take the
  // same hand-off from whatever came before the wave, none of them sees any of
  // the others, and the step after the wave takes ALL of their replies. Three
  // devil's-advocate reports written at once, then read side by side.
  //
  // Adjacency is half the definition, not decoration: dragging a step in
  // between two members splits them, which is the visible answer to "what did
  // that reorder just do" — an id acting at a distance would silently keep two
  // now-separated steps in lockstep.
  //
  // Every step belongs to a wave; most waves have one member, which is what an
  // ordinary linear workflow is.
  const WAVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  function stepWaves(steps) {
    const out = [];
    (steps || []).forEach((s, i) => {
      const group = trimmed(s && s.group);
      const last = out[out.length - 1];
      if (
        group &&
        last &&
        last.group === group &&
        last.members[last.members.length - 1] === i - 1
      ) {
        last.members.push(i);
        return;
      }
      out.push({ group: group || null, index: out.length, members: [i] });
    });
    return out;
  }

  // "1", "2A", "2B", "2C", "3" — what to call each step. A wave of one is just
  // its number: a letter on a step with no siblings would suggest there are
  // others somewhere.
  function stepLabels(steps) {
    const labels = [];
    stepWaves(steps).forEach((w) => {
      w.members.forEach((idx, mi) => {
        labels[idx] =
          String(w.index + 1) +
          (w.members.length > 1 ? WAVE_LETTERS[mi] || String(mi + 1) : "");
      });
    });
    return labels;
  }

  // The wave a step is in, and where that step sits within it.
  function waveOf(steps, index) {
    for (const w of stepWaves(steps)) {
      const at = w.members.indexOf(index);
      if (at !== -1) return Object.assign({}, w, { at: at });
    }
    return null;
  }

  // Several replies as one piece of text, each under a heading naming where it
  // came from. Fenced by a line rather than a Markdown heading because the
  // replies contain headings of their own, and the join has to survive being
  // read by something that only sees the text.
  function foldWave(parts) {
    const rows = (parts || []).filter((p) => p && trimmed(p.text));
    if (!rows.length) return "";
    if (rows.length === 1) return trimmed(rows[0].text);
    return rows
      .map((p, i) => {
        const name = trimmed(p.label) || "Reply " + (WAVE_LETTERS[i] || i + 1);
        return "===== " + name.toUpperCase() + " =====\n\n" + trimmed(p.text);
      })
      .join("\n\n");
  }

  // ---- documents ----------------------------------------------------------

  // A file stored under cum_file_<id>, plus the chats that should receive it.
  // `addedAt` marks a document handed to a run ALREADY UNDER WAY: it can't ride
  // the chat's opening message, that having been sent, so it goes up with the
  // next step in each of its chats from that point on.
  function newDoc(fields, id) {
    const f = fields || {};
    const doc = {
      id: id,
      name: trimmed(f.name) || "file",
      type: str(f.type),
      size: typeof f.size === "number" ? f.size : 0,
      chats: Array.isArray(f.chats) ? f.chats.slice() : [],
    };
    if (typeof f.addedAt === "number") doc.addedAt = f.addedAt;
    // How many documents were folded into this one. Only combined files carry
    // it, and it's what lets a run say "5 papers went up as 1 file" afterwards.
    if (typeof f.bundled === "number" && f.bundled > 1) doc.bundled = f.bundled;
    return doc;
  }

  // A workflow's own documents plus the ones belonging to the run in hand. A
  // workflow is a TEMPLATE: the papers are different every matter, so at Start
  // they move to the run and the template goes back to empty. The run then owns
  // them for its whole life, which is what lets the template be reused (or
  // re-armed for the next matter) while a run is still going.
  function allDocs(wf, extra) {
    // The runner's own read of the papers refuses a spreadsheet even from a
    // run stored before the bar existed — see allowedDocs.
    return allowedDocs(((wf && wf.docs) || []).concat(extra || []));
  }

  // Can this document be folded into a combined text upload? Only things that
  // ARE text — a PDF or a Word file has to go up on its own, and pretending
  // otherwise would deliver mojibake instead of a brief.
  const TEXT_NAME_RE = /\.(txt|md|markdown|csv|tsv|json|log|xml|ya?ml|htm|html)$/i;
  function isTextDoc(doc) {
    const type = str(doc && doc.type).toLowerCase();
    if (type) {
      if (type.indexOf("text/") === 0) return true;
      // Matched at the boundaries, not anywhere in the string: a .docx is
      // "application/vnd.openxmlformats-…", which contains "xml" and is not
      // remotely text. Folding one in would deliver mojibake as a brief.
      if (/^application\/(json|xml|yaml|x-yaml|csv|x-csv|x-ndjson)$/.test(type)) return true;
      if (/^application\/[\w.-]+\+(json|xml)$/.test(type)) return true;
      return false; // typed as something else — believe it
    }
    return TEXT_NAME_RE.test(str(doc && doc.name));
  }

  // Several text documents as one, each announced by name. claude.ai does not
  // promise to read inside an archive, and one attachment it silently ignores
  // is worse than several it might; a single labelled text file needs nothing
  // unpacked and can't half-arrive.
  // Which documents get folded into one file, and which uploads that file goes
  // to. Only groups of two or more real text documents — one file has nothing to
  // be combined with, and a PDF can't be concatenated at all.
  //
  // Worked out per chat first, because what a chat receives is what decides the
  // contents, and then MERGED across chats that would receive exactly the same
  // file. Documents default to every chat, so identical sets are the ordinary
  // case rather than a coincidence: a six-chat workflow would otherwise build
  // and store six byte-identical files. One file ticked for six chats is what a
  // document ticked for six chats already does.
  //
  // Chats whose sets differ still get their own — the point of the per-chat
  // ticks is that they can differ.
  function bundlePlan(wf) {
    if (!wf || !wf.bundleText) return [];
    const perChat = new Map();
    for (const d of allDocs(wf)) {
      if (!d || !isTextDoc(d)) continue;
      const when = typeof d.addedAt === "number" ? d.addedAt : null;
      for (const cid of d.chats || []) {
        const key = cid + "@" + (when == null ? "open" : when);
        if (!perChat.has(key))
          perChat.set(key, { chatId: cid, addedAt: when, docIds: [], names: [] });
        perChat.get(key).docIds.push(d.id);
        perChat.get(key).names.push(trimmed(d.name) || "untitled");
      }
    }

    const merged = new Map();
    for (const g of perChat.values()) {
      if (g.docIds.length < 2) continue;
      // Same documents, same arrival, so the same bytes. The lists are built by
      // walking allDocs in order, so equal sets give equal sequences and this
      // needs no sorting.
      const key = g.docIds.join("|") + "@" + (g.addedAt == null ? "open" : g.addedAt);
      if (!merged.has(key))
        merged.set(key, {
          key: key,
          chatIds: [],
          addedAt: g.addedAt,
          docIds: g.docIds,
          names: g.names,
        });
      merged.get(key).chatIds.push(g.chatId);
    }
    return Array.from(merged.values());
  }

  // Swap a group's documents for the combined file they were folded into. The
  // originals stay on the run — they may be ticked for a chat whose set differs,
  // and that chat gets its own bundle — they just stop being sent to the ones
  // this file covers. Applying it twice is a no-op: the members no longer name
  // those chats, so the group is gone.
  function foldBundle(docs, group, bundle) {
    const g = group || {};
    const ids = new Set(g.docIds || []);
    const chats = new Set(g.chatIds || []);
    const out = (docs || []).map((d) =>
      d && ids.has(d.id)
        ? Object.assign({}, d, { chats: (d.chats || []).filter((c) => !chats.has(c)) })
        : d
    );
    const fields = { chats: (g.chatIds || []).slice(), bundled: (g.docIds || []).length };
    if (typeof g.addedAt === "number") fields.addedAt = g.addedAt;
    return out.concat([newDoc(Object.assign({}, bundle, fields), bundle && bundle.id)]);
  }

  // The header is a real index — one numbered line per document, with its
  // length — rather than a prose sentence running the names together (the
  // owner's ask). The length is there so the reader can tell a two-page
  // declaration from a two-hundred-page exhibit before going looking for it.
  function bundleText(parts) {
    const list = (parts || []).filter((p) => p && trimmed(p.text));
    if (!list.length) return "";
    const words = (t) => str(t).trim().split(/\s+/).length;
    const head =
      "This file contains " + list.length + " document" + (list.length === 1 ? "" : "s") +
      ", one after another, each between its own BEGIN FILE and END FILE markers. " +
      "Index, in order:\n" +
      list
        .map((p, i) => {
          const n = words(p.text);
          return i + 1 + ". " + (trimmed(p.name) || "untitled") + " — " + n + " word" + (n === 1 ? "" : "s");
        })
        .join("\n");
    const body = list.map(
      (p) =>
        "===== BEGIN FILE: " + (trimmed(p.name) || "untitled") + " =====\n\n" +
        str(p.text).trim() +
        "\n\n===== END FILE: " + (trimmed(p.name) || "untitled") + " ====="
    );
    return [head].concat(body).join("\n\n");
  }

  function docsForChat(wf, chatId, extra) {
    return allDocs(wf, extra).filter(
      (d) => d && Array.isArray(d.chats) && d.chats.indexOf(chatId) !== -1
    );
  }

  // ---- workflow -----------------------------------------------------------

  // Put steps into the order named by a list of ids. Anything the list doesn't
  // name keeps its relative position, after the ones it does — a dropped card
  // that somehow isn't in the list must not take its prompt with it.
  //
  // Carrying is decided partly by position: the first step has nothing before it
  // to carry from, and a step directly after another in the SAME chat has no
  // reason to be handed material that conversation already holds. In both cases
  // the editor doesn't even offer the tick — so a `false` there was never a
  // choice, and taking it along to a position where neither reason applies would
  // silently drop a hand-off in the middle of a reshuffle. Reordering therefore
  // gives such a step its default back, and only carries a genuine no across.
  function positionForbidsCarry(list, i) {
    if (isPauseStep(list[i])) return true; // a gate carries nothing
    const wave = waveOf(list, i);
    const start = wave ? wave.members[0] : i;
    // A wave carries from what came before it, so what matters for every member
    // is the step before the FIRST of them — 2B's neighbour is 2A, but 2A is
    // not where 2B's material comes from.
    //
    // ...and a pause is not that step. It produces nothing and belongs to no
    // chat, so the question is asked of the last step that did something.
    let prev = start - 1;
    while (prev >= 0 && isPauseStep(list[prev])) prev--;
    return prev < 0 || !!(list[prev] && list[prev].chatId === list[i].chatId);
  }

  function reorderSteps(steps, ids) {
    const list = (steps || []).filter(Boolean);
    const chosen = new Map();
    list.forEach((s, i) =>
      chosen.set(str(s.id), positionForbidsCarry(list, i) ? true : s.carry !== false)
    );

    const by = new Map(list.map((s) => [str(s.id), s]));
    const out = [];
    for (const id of ids || []) {
      const s = by.get(str(id));
      if (s && out.indexOf(s) === -1) out.push(s);
    }
    // Anything the list doesn't name keeps its relative position, after the ones
    // it does — a card that somehow isn't in the order must not take its prompt
    // with it.
    for (const s of list) if (out.indexOf(s) === -1) out.push(s);

    return out.map((s, i) => {
      const want = chosen.has(str(s.id)) ? chosen.get(str(s.id)) : s.carry !== false;
      return Object.assign({}, s, { carry: positionForbidsCarry(out, i) ? false : want });
    });
  }

  // What to call text pasted straight into the documents field. Its own first
  // line where that reads like a title — "Opposition to Motion to Compel" tells
  // you what it is in the list, where "Pasted text 3" tells you when you pasted
  // it — and the fallback otherwise, numbered past whatever is already there so
  // two pastes never collide.
  const PASTE_NAME_MAX = 60;
  function pastedDocName(text, taken) {
    const used = new Set((taken || []).map((n) => str(n).toLowerCase()));
    const free = (name) => {
      if (!used.has(name.toLowerCase())) return name;
      const stem = name.replace(/\.txt$/i, "");
      for (let i = 2; i < 200; i++) {
        const next = stem + " (" + i + ").txt";
        if (!used.has(next.toLowerCase())) return next;
      }
      return name;
    };

    const first = str(text)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    // Markdown heading marks, list bullets and quotes are decoration on the
    // title, not part of it. Anything a filename can't hold becomes a space.
    const title = str(first)
      .replace(/^[#>*\-•\s]+/, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, PASTE_NAME_MAX)
      .replace(/[\s.]+$/, "");

    if (title.length >= 4) return free(title + ".txt");
    let n = 1;
    while (used.has(("pasted text " + n + ".txt").toLowerCase()) && n < 200) n++;
    return "Pasted text " + n + ".txt";
  }

  // ---- completing a prompt you've written before --------------------------
  //
  // The same prompts recur: every devil's advocate step in every workflow opens
  // the same way, and typing it out again is both tedious and a chance to get it
  // subtly different from the one that works.
  //
  // The pool is every step prompt already written, counted — a prompt used in
  // six places is more likely to be the one being typed than one used once.
  function promptPool(workflows, extraSteps) {
    const counts = new Map();
    const add = (text) => {
      const t = str(text).trim();
      if (t.length < MIN_POOLED) return;
      counts.set(t, (counts.get(t) || 0) + 1);
    };
    for (const wf of workflows || []) for (const s of (wf && wf.steps) || []) add(s && s.prompt);
    for (const s of extraSteps || []) add(s && s.prompt);
    return Array.from(counts.entries()).map(([text, uses]) => ({ text: text, uses: uses }));
  }

  const MIN_POOLED = 12; // a prompt too short to be worth completing to
  const MIN_TYPED = 4; // …and too little typed to guess from

  // What you might be typing, best first. A prefix match and nothing cleverer:
  // a fuzzy match that offers a prompt you didn't mean is worse than no offer,
  // because accepting is one keystroke and the wrong prompt looks like the
  // right one until the run has spent a turn on it.
  function promptSuggestions(pool, typed, limit) {
    const t = str(typed);
    if (t.trim().length < MIN_TYPED) return [];
    const q = t.toLowerCase();
    const out = [];
    for (const p of pool || []) {
      if (!p || typeof p.text !== "string") continue;
      const text = p.text;
      if (text.length <= t.length) continue; // nothing left to add
      if (text.toLowerCase().indexOf(q) !== 0) continue;
      out.push({ text: text, rest: text.slice(t.length), uses: p.uses || 1 });
    }
    // Most-used first; then the shortest, which is the least presumptuous
    // completion of what's been typed so far.
    out.sort((a, b) => b.uses - a.uses || a.text.length - b.text.length);
    return out.slice(0, typeof limit === "number" ? limit : 5);
  }

  // ---- carrying older workflows forward ------------------------------------
  //
  // Three of the settings above changed shape or default, and a stored workflow
  // records what it was given rather than what it meant. `bundleText: false` on
  // a workflow saved last month is the OLD DEFAULT written down, not a decision
  // to send twenty attachments — so leaving it alone would mean the new default
  // never reached the workflows anyone actually has. And the ruling marker
  // moved from the chat to the step, which is not a rename: without moving the
  // value with it, a workflow that checks its output would quietly stop.
  //
  // Marked with a version so it happens once. After that, a `false` is a
  // decision, and this leaves it alone.
  const SETTINGS_VERSION = 2;
  function migrateSettings(wf) {
    if (!wf || typeof wf !== "object") return wf;
    if (wf.sv >= SETTINGS_VERSION) return wf;
    const out = Object.assign({}, wf, { sv: SETTINGS_VERSION });
    // The two switches that are now on by default.
    if (!out.bundleText) out.bundleText = true;
    if (!out.allowRerun) out.allowRerun = true;
    // The one that went away, replaced by the extension-wide file saver.
    delete out.downloadFiles;
    // And the marker, onto every step of the chat that carried it. Every step,
    // because that is what the chat-level setting meant — the narrowing to
    // particular steps is the point of the move, and it is yours to make.
    const marked = {};
    for (const c of out.chats || []) {
      if (c && c.expectsRuling)
        marked[c.id] = trimmed(c.outputMarker) || DEFAULT_OUTPUT_MARKER;
    }
    if (Object.keys(marked).length) {
      out.steps = (out.steps || []).map((s) =>
        s && marked[s.chatId] && !s.expectsRuling
          ? Object.assign({}, s, { expectsRuling: true, outputMarker: marked[s.chatId] })
          : s
      );
    }
    out.chats = (out.chats || []).map((c) => {
      if (!c) return c;
      const copy = Object.assign({}, c);
      delete copy.expectsRuling;
      delete copy.outputMarker;
      return copy;
    });
    return out;
  }

  // The same for a run, which keeps its own copy of the chats and steps and so
  // carries its own copy of the marker. Deliberately narrower than the workflow
  // version: `bundleText` is left exactly as it is, because a run's documents
  // are bundled once when it starts and changing the answer underneath one
  // already in flight would decide something it has already done.
  function migrateRunSettings(run) {
    if (!run || typeof run !== "object") return run;
    if (run.sv >= SETTINGS_VERSION) return run;
    const shaped = migrateSettings({
      sv: 0,
      bundleText: true, // not read back — see above
      allowRerun: run.allowRerun,
      chats: (run.plan && run.plan.chats) || [],
      steps: (run.plan && run.plan.steps) || [],
    });
    const out = Object.assign({}, run, {
      sv: SETTINGS_VERSION,
      allowRerun: shaped.allowRerun,
      plan: { chats: shaped.chats, steps: shaped.steps },
    });
    delete out.downloadFiles;
    return out;
  }

  function newWorkflow(fields, id, now) {
    const f = fields || {};
    const wf = {
      id: id,
      name: trimmed(f.name) || "Untitled workflow",
      // What the name goes back to after a run starts. A workflow is named for
      // the matter in front of you while you set it up; this is the name it
      // wears at rest, so the next matter starts from a clean template rather
      // than the last one's title.
      templateName: trimmed(f.templateName) || trimmed(f.name) || "Untitled workflow",
      description: trimmed(f.description),
      builtin: !!f.builtin,
      // Send several text documents as one labelled file. claude.ai will accept
      // twenty attachments and quietly show Claude fewer; one file can't be
      // partly there. On unless turned off — a batch that arrives incomplete is
      // a worse default than one labelled file.
      bundleText: f.bundleText !== false,
      nameChats: f.nameChats !== false,
      // Offer to run a finished run again. On unless turned off; a run you
      // never re-run costs a button you don't press.
      allowRerun: f.allowRerun !== false,
      // Push on through an outage rather than waiting it out. Off by default —
      // the wait exists because a run driven through the real UI has nothing to
      // fall back on — but a minor outage often doesn't touch what a run does,
      // and this is how you say so in advance.
      ignoreOutage: !!f.ignoreOutage,
      // Open this run's chats in a window of their own. Off by default, and
      // off is the plain reading: a run puts tabs behind whatever you are
      // doing, and a second window is a thing you have to find, move and close
      // rather than a thing you asked for.
      //
      // On, it is the arrangement the run machinery was built around — the
      // run's chats sit together, its Options tab is pinned beside them, and
      // the window is maximized so claude.ai stays clear of the narrow layout
      // that renders "not supported on your current device" in place of some
      // blocks. Worth having; not worth being the default.
      newWindow: !!f.newWindow,
      rerun: rerunDefaults(f.rerun),
      chats: (f.chats || []).map((c, i) => newChatSlot(c, c && c.id, i)),
      docs: allowedDocs(f.docs).map((d) => newDoc(d, d && d.id)),
      // Which pseudonym key (popup's stored library, by id) rides this
      // matter's chats — attached, never uploaded. On the run like the
      // documents, because a key is a case's, not a template's.
      pseudoKeyId: f.pseudoKeyId || null,
      // The matter's date, canonically "YYYY-MM-DD". Written into the run's
      // name at the end by newRun/applyRunEdit (composeRunName).
      runDate: isoRunDate(f.runDate),
      steps: (f.steps || []).map((s) => newStep(s, s && s.id)),
      // What its runs have cost, averaged over them — measured, not authored,
      // so it survives an edit rather than being reset by one.
      usage: f.usage && f.usage.runs > 0 ? f.usage : null,
      // A workflow built here is already in the current shape.
      sv: SETTINGS_VERSION,
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
    // Chats first, since whether a step carries depends on the one before it
    // having been resolved.
    const placed = (wf.steps || []).map((s) =>
      isPauseStep(s)
        ? // A pause has no chat to lose. Handing it the fallback would put a
          // gate into a conversation and, worse, make the step after it look
          // like a second step in that chat and lose its hand-off.
          Object.assign({}, s, { chatId: null })
        : Object.assign({}, s, {
            // A step whose chat was deleted moves to the last remaining chat
            // rather than being thrown away — its prompt is the expensive part.
            chatId: ids.has(s.chatId) ? s.chatId : fallback,
          })
    );
    wf.steps = placed.map((s, i) =>
      Object.assign({}, s, {
        // Nothing to carry into the first step, and nothing to carry between
        // two steps in the SAME chat: that conversation already has it, and
        // pasting it back in wastes the context it's already holding. Measured
        // from the step before the WAVE, so steps that run at once are all
        // handed the same thing rather than each other's.
        carry: positionForbidsCarry(placed, i) ? false : s.carry !== false,
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
      pseudoKeyId: wf.pseudoKeyId || null,
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
    // What the runs cost is measured, not authored, and the editor has no field
    // for it — so an edit that doesn't mention it keeps what's already there
    // rather than erasing a dozen runs' worth of measurement.
    else out[i] = wf.usage || !out[i].usage ? wf : Object.assign({}, wf, { usage: out[i].usage });
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
    // A PAUSE is exempt, and has to be: a pause has no prompt by definition —
    // it is a gate between steps, not something anybody says to a chat — so a
    // rule that read it as an unfinished step made adding one to a run look
    // like an error and blocked the save.
    for (const s of (wf && wf.steps) || []) {
      if (!isPauseStep(s) && !trimmed(s.prompt)) {
        problems.push("Every step needs a prompt.");
        break;
      }
    }
    // ...and a run that is nothing but gates has nothing to gate.
    if (wf && (wf.steps || []).length && (wf.steps || []).every(isPauseStep))
      problems.push("A pause waits between steps — add a step for it to wait between.");
    // Steps that run at the same time cannot share a conversation: they would
    // be posting into it at once, and each would read the other's answer as its
    // own. Two chats is what makes them parallel rather than a queue.
    const labels = stepLabels((wf && wf.steps) || []);
    for (const w of stepWaves((wf && wf.steps) || [])) {
      if (w.members.length < 2) continue;
      // Pauses carry no chat, so two of them in one wave are not two steps
      // posting into one conversation — which is the only thing this is about.
      const chats = w.members
        .map((i) => wf.steps[i] || {})
        .filter((s) => !isPauseStep(s))
        .map((s) => s.chatId);
      const clash = chats.find((c, i) => chats.indexOf(c) !== i);
      if (clash) {
        const which = w.members.filter((i) => wf.steps[i].chatId === clash).map((i) => labels[i]);
        problems.push(
          "Steps " + which.join(" and ") + " run at the same time but in the same chat — " +
            "give each parallel step its own."
        );
        break;
      }
    }
    const orphan = ((wf && wf.docs) || []).filter((d) => !(d.chats || []).length);
    if (orphan.length)
      problems.push(
        orphan.length + " document(s) aren't assigned to a chat — they won't be uploaded."
      );
    for (const c of (wf && wf.chats) || []) {
      if (c.startUrl && !looksLikeChatUrl(c.startUrl)) {
        problems.push(
          "“" + c.name + "” starts in a link that doesn't look like a claude.ai conversation."
        );
        break;
      }
    }
    for (const c of (wf && wf.chats) || []) {
      if (!c.seedFromLatest) continue;
      if (!c.startUrl) {
        problems.push("“" + c.name + "” is set to start from its latest reply, but has no chat link.");
        break;
      }
      if (((wf && wf.steps) || []).every((s) => s.chatId === c.id)) {
        problems.push(
          "Every step runs in “" + c.name + "”, so starting from its latest reply leaves nothing to do."
        );
        break;
      }
    }
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
    const groups = bundlePlan(wf);
    const folding = groups.reduce((n, g) => n + g.docIds.length, 0);
    return (
      "uploads: " +
      plan.map((c) => c.name + " " + c.docs).join(" · ") +
      // Said before it happens, because "5 documents" and "1 attachment" are
      // both true and only one of them is what claude.ai will see.
      (groups.length
        ? " · " + folding + " text documents combine into " + groups.length +
          " file" + (groups.length === 1 ? "" : "s")
        : "")
    );
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
    // Worth saying on the row: a workflow that switches models part-way is doing
    // something you'd want to be reminded of before starting it again.
    const models = [];
    for (const s of planRun(wf))
      if (s.modelOn && models.indexOf(s.modelOn) === -1) models.push(s.modelOn);
    if (models.length > 1) bits.push(models.join(" → "));
    return bits.join(" · ");
  }

  // ---- the run plan -------------------------------------------------------

  // Expand a workflow into the ordered list the runner walks. Each entry knows
  // its chat, the text's hand-off, and which documents to attach — documents go
  // up on the chat's FIRST step, because that's the message that opens the
  // conversation.
  // Back to a blank template: the name it wears at rest, and no papers. Called
  // when a run starts and takes this matter's documents with it.
  function resetToTemplate(wf, now) {
    if (!wf) return wf;
    return Object.assign({}, wf, {
      name: trimmed(wf.templateName) || wf.name,
      docs: [],
      // The key and the date were this matter's exactly as the papers were.
      pseudoKeyId: null,
      runDate: null,
      // A conversation to start in belonged to that matter too — leaving it
      // behind would silently point the next matter's run at the last one's
      // chat, which is the kind of mistake you'd only notice afterwards.
      chats: (wf.chats || []).map((c) =>
        Object.assign({}, c, { startUrl: null, seedFromLatest: false })
      ),
      updatedAt: now,
    });
  }

  // The stored files a run is holding on its own account — the ones handed over
  // when it started. Nothing else may delete these while the run lives.
  function runFileIds(runs) {
    const ids = new Set();
    for (const r of runs || []) for (const d of (r && r.docs) || []) if (d && d.id) ids.add(d.id);
    return ids;
  }

  function planRun(wf, extraDocs) {
    const steps = (wf && wf.steps) || [];
    const docs = allDocs(wf, extraDocs);

    // Documents added mid-run ride the next step in each chat they're for,
    // counting from the step the run had reached when they arrived.
    const late = new Map(); // step index -> [docId]
    for (const d of docs) {
      if (!d || typeof d.addedAt !== "number") continue;
      for (const cid of d.chats || []) {
        for (let i = Math.max(0, d.addedAt); i < steps.length; i++) {
          if (steps[i].chatId !== cid) continue;
          if (!late.has(i)) late.set(i, []);
          if (late.get(i).indexOf(d.id) === -1) late.get(i).push(d.id);
          break;
        }
      }
    }

    // Which steps run together, so a step can tell its NEIGHBOUR from its
    // CONSUMER. In a wave, the step after 2A is 2B — which never reads it.
    const waves = stepWaves(steps);
    const labels = stepLabels(steps);
    const waveFor = [];
    for (const w of waves) for (const m of w.members) waveFor[m] = w;

    // A pause is a gate between steps, not a step anything talks to: the step
    // after one carries from the step before it, and the step before one hands
    // to the step after it. Reading the literal neighbour would have a pause
    // swallow the hand-off it sits in the middle of.
    const realBefore = (i) => {
      for (let k = i - 1; k >= 0; k--) if (!isPauseStep(steps[k])) return k;
      return -1;
    };
    const realAfter = (i) => {
      for (let k = i + 1; k < steps.length; k++) if (!isPauseStep(steps[k])) return k;
      return -1;
    };

    const seen = new Set();
    // What model each chat is currently on, so a step only has to switch when
    // it actually wants something different — and so a step that DOES switch
    // leaves the chat on that model for the steps after it, exactly as it would
    // if you had picked it yourself.
    const on = new Map();
    return steps.map((s, i) => {
      if (isPauseStep(s))
        return {
          index: i,
          id: s.id,
          kind: "pause",
          pauseMinutes: pauseMinutes(s.pauseMinutes),
          label: labels[i] || String(i + 1),
          chatId: null,
          chatName: "",
          prompt: "",
          wave: [i],
          waveIndex: i,
          waveStart: i,
          waveAt: 0,
          parallel: false,
          carry: false,
          carryLabel: "",
          firstInChat: false,
          model: null,
          modelOn: null,
          modelOverride: false,
          surface: null,
          docIds: [],
          handsOn: false,
          marker: null,
        };
      const firstInChat = !seen.has(s.chatId);
      seen.add(s.chatId);
      const chat = getChat(wf, s.chatId) || {};
      const model = trimmed(s.model) || (firstInChat ? trimmed(chat.model) : null) || null;
      const was = on.get(s.chatId) || null;
      if (model) on.set(s.chatId, model);
      const surface = trimmed((chat.target && chat.target.surface) || "") || null;
      // Does this step's reply get pasted into another chat? Only then is it
      // worth insisting on what the reply must be — a step whose answer stays
      // where it is can say anything it likes. In a wave, the step that reads
      // this one is the one after the WHOLE wave: 2B is not 2A's reader, it's
      // its sibling, and the two never see each other.
      const wave = waveFor[i] || { members: [i], index: i };
      const waveStart = wave.members[0];
      const consumerAt = realAfter(wave.members[wave.members.length - 1]);
      const consumer = consumerAt === -1 ? null : steps[consumerAt];
      const handsOn = !!(consumer && consumer.carry !== false && consumer.chatId !== s.chatId);
      const opening = firstInChat
        ? docs
            .filter(
              (d) =>
                d &&
                typeof d.addedAt !== "number" &&
                Array.isArray(d.chats) &&
                d.chats.indexOf(s.chatId) !== -1
            )
            .map((d) => d.id)
        : [];
      const added = (late.get(i) || []).filter((id) => opening.indexOf(id) === -1);
      return {
        index: i,
        id: s.id,
        kind: "prompt",
        pauseMinutes: 0,
        chatId: s.chatId,
        chatName: chatName(wf, s.chatId),
        prompt: str(s.prompt),
        // What to call it: "3" on its own, "2B" in a wave.
        label: labels[i] || String(i + 1),
        // The steps this one runs alongside, itself included, and where it sits
        // among them. A wave of one is an ordinary step.
        wave: wave.members.slice(),
        waveIndex: wave.index,
        waveStart: waveStart,
        waveAt: wave.members.indexOf(i),
        parallel: wave.members.length > 1,
        // Carrying is measured from the step before the WAVE. Every member gets
        // the same hand-off — that being what makes them parallel — so 2B does
        // not carry from 2A, it carries from 1 exactly as 2A does.
        carry: realBefore(waveStart) !== -1 && s.carry !== false,
        carryLabel: trimmed(s.carryLabel) || "material from the previous step",
        firstInChat: firstInChat,
        // The model to pick before sending. Null when the chat is already on the
        // right one — switching to the model you're on is a menu opened for
        // nothing, and one more thing to go wrong.
        model: model && model !== was ? model : null,
        // What it will answer on either way, for the surfaces that report it.
        modelOn: model || was || null,
        // The surface is the chat's, never a step's: a conversation cannot be
        // half in Cowork, and a step that changed it mid-run would be asking
        // for a different chat. Sent on every step so a resumed run lands the
        // right way up, which costs one already-there check.
        surface: surface,
        // A step that deliberately differs from its chat's own setting.
        modelOverride: !!trimmed(s.model),
        docIds: opening.concat(added),
        handsOn: handsOn,
        // The phrase this step's reply must contain before the run moves on.
        //
        // Not only where the reply travels to another chat. A drafting
        // conversation that writes the ruling and then revises it in the SAME
        // chat pastes nothing — but a second step sent on top of half a ruling
        // is still a second step working from half a ruling, and the run would
        // never say so. What the marker guards is the run moving on, which is
        // every step that expects one.
        marker: stepMarker(s),
      };
    });
  }

  // Where the text carried into `stepIndex` comes from: the chat the PREVIOUS
  // step ran in. Restarting a run mid-way doesn't need the operator to paste
  // anything — that conversation is still open, and its latest reply is the
  // hand-off, even though producing it was the tail end of the step before.
  function carrySource(wf, stepIndex) {
    const plan = planRun(wf);
    const step = plan[stepIndex];
    if (!step || !step.carry || step.waveStart <= 0)
      return { needed: false, chatId: null, chatName: null, label: null, sources: [] };
    // Everything the wave before this step produced — three chats where a
    // linear workflow has one. Each is named, because what comes back is
    // several answers to the same question and telling them apart is the point.
    const before = plan[step.waveStart - 1];
    const sources = before.wave.map((idx) => ({
      stepIndex: idx,
      chatId: plan[idx].chatId,
      chatName: plan[idx].chatName,
      label: plan[idx].chatName + " (" + plan[idx].label + ")",
    }));
    return {
      needed: true,
      // The first source, for the callers that only ever expect one. A linear
      // workflow has exactly one and this is it.
      chatId: sources[0].chatId,
      chatName: sources[0].chatName,
      sources: sources,
      label: step.carryLabel,
      fromStep: step.waveStart - 1,
    };
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

  // A chat standing in as "step 0": which chat to take the opening hand-off
  // from, and the step the run therefore starts at — the first one that isn't
  // in that chat, because the steps that are have already been done by hand.
  function seedPlan(wf) {
    const seeded = ((wf && wf.chats) || []).find((c) => c && c.startUrl && c.seedFromLatest);
    if (!seeded) return { seedFrom: null, stepIndex: 0 };
    const steps = (wf && wf.steps) || [];
    let i = 0;
    while (i < steps.length && steps[i] && steps[i].chatId === seeded.id) i++;
    // Never skip past the end: a workflow whose every step is in the seeded
    // chat has nothing left to do, and validate() says so.
    return { seedFrom: seeded.id, stepIndex: Math.min(i, Math.max(0, steps.length - 1)) };
  }

  function startChats(wf) {
    const map = {};
    for (const c of (wf && wf.chats) || []) {
      const url = trimmed(c && c.startUrl);
      if (url) map[c.id] = { url: url };
    }
    return map;
  }

  function newRun(wf, id, now, trigger, docs) {
    const t = trigger || {};
    const seed = seedPlan(wf);
    return {
      id: id,
      workflowId: wf ? wf.id : null,
      // This matter's name — and ONLY this matter's. A template sitting at its
      // resting name has nothing to say about the matter, so a run made from one
      // starts unnamed and asks; it does not inherit "Tentative ruling — 3×
      // devil's advocate" and then sit in the list pretending to be a template.
      // (A workflow armed the older way, by typing the matter's name onto it,
      // still hands that name over — that name IS the matter.)
      name: composeRunName(
        wf && trimmed(wf.name) !== trimmed(wf.templateName) ? wf.name : "",
        wf && wf.runDate
      ),
      // Where it came from, kept whatever later happens to the template: renamed
      // for another matter, rewritten, or deleted outright. A run always knows
      // which workflow it is a run OF.
      templateName: wf ? trimmed(wf.templateName) || trimmed(wf.name) : "",
      // This matter's papers, handed over at Start so the template can be
      // cleared and re-armed while this run is still going.
      docs: allowedDocs(docs || (wf && wf.docs) || []).map((d) => newDoc(d, d && d.id)),
      // The matter's date — already written into the name above, kept as a
      // field so the runs list can sort by it and the editor can show it.
      runDate: isoRunDate(wf && wf.runDate),
      // The matter's pseudonym key, attached the way the papers are — every
      // conversation this run opens shows real names to the reader while
      // Claude keeps seeing the fakes (see src/pseudo-view.js). Never a
      // document: the key must not ride an upload.
      pseudoKeyId: (wf && wf.pseudoKeyId) || null,
      // Every switch the workflow carries is the run's too, and carried the
      // same way: only an explicit "off" is off. A setting that failed to
      // travel would be a run quietly doing something other than what the
      // template you set up says.
      bundleText: !(wf && wf.bundleText === false),
      // Name each conversation this run opens after the run. Scoped to the ones
      // it opens, so it can never retitle a chat you pointed it at.
      nameChats: !(wf && wf.nameChats === false),
      allowRerun: !(wf && wf.allowRerun === false),
      ignoreOutage: !!(wf && wf.ignoreOutage),
      newWindow: !!(wf && wf.newWindow),
      // The workflow's answers, copied so this matter can differ from the next.
      rerun: rerunDefaults(wf && wf.rerun),
      // And its own copy of the chats and steps. A run executes THIS, not the
      // template — so the template can be edited, re-armed or deleted without
      // changing what a run in flight does, and so a run can be edited (a step
      // inserted, a prompt fixed) without touching every future run.
      plan: {
        chats: ((wf && wf.chats) || []).map((c, i) => newChatSlot(c, c && c.id, i)),
        steps: ((wf && wf.steps) || []).map((s) => newStep(s, s && s.id)),
      },
      totalSteps: wf && wf.steps ? wf.steps.length : 0,
      trigger:
        t.type === "time"
          ? { type: "time", at: t.at }
          : t.type === "reset"
          ? { type: "reset" }
          : t.type === "draft"
          ? { type: "draft" }
          : { type: "now" },
      // draft | pending | waiting | running | done | error | canceled | paused.
      // A draft is armed for a matter but has no trigger yet, so nothing picks
      // it up — every scheduler here gates on "pending".
      status: t.type === "draft" ? "draft" : "pending",
      // Normally 0. A chat standing in as step 0 starts the run past the steps
      // that chat has already done by hand.
      stepIndex: seed.stepIndex,
      // The chat whose latest reply is the opening hand-off, read just before
      // the first step runs (not now — the run may be scheduled for hours away,
      // and what matters is what's in that chat when it goes).
      seedFrom: seed.seedFrom,
      phase: "idle", // idle | sending | awaiting-reply
      // chatId -> { url }. Seeded from any chat told to start in a conversation
      // that already exists — the same field the run fills in as it goes, so
      // the first step simply finds itself already "returning" to that chat.
      chats: startChats(wf),
      // A run gets its own Chrome window, holding only its chats. Created
      // unfocused, so a run never takes the screen away from what you're doing.
      windowId: null,
      lastReply: "",
      // { stepIndex, chatId, chatName, at, chars, docs, ms, sendMs, replyMs, … }
      transcript: [],
      // The current step's clock — see startStepClock. Cleared as each step
      // lands its timing in the transcript.
      stepStartedAt: null,
      stepStoppedAt: null,
      stepStoppedMs: 0,
      // The meter as it stood when the current step began (see usageSample).
      stepUsage: null,
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

  // ---- running one again ---------------------------------------------------
  //
  // A finished run is often worth another pass, and rarely from the top: a
  // workflow that opens by drafting a tentative has nothing to draft the second
  // time, because the first run already did. So a re-run says where to start.
  //
  // Two shapes, and the difference is what the chats already hold:
  //   - CONTINUE in the same conversations. They still have the papers and the
  //     work, so nothing is re-uploaded and nothing has to be carried in.
  //   - FRESH conversations. They start empty, which is the point — a clean
  //     context — but it means the papers must ride the first step that
  //     actually runs rather than one this re-run skips, and the previous run's
  //     final reply is worth carrying in, since otherwise the new chat begins
  //     with no idea what came before.
  // The answers a re-run needs, which for most workflows are the same every
  // time: a nine-step ruling workflow re-run is always "start at step 2, fresh
  // conversations, carry the last ruling in". Held on the workflow so they're
  // answered once, copied onto each run so one matter can differ, and still
  // asked at the moment of pressing Re-run — a run made before the workflow had
  // an opinion, or from a workflow that has none, must still be re-runnable.
  // The workflow's standing answers for a re-run. `stepIndex` defaults to 0 —
  // step ONE — because the point of a re-run is that it is quick: press it and
  // the matter goes again from the top. A workflow whose first step produces
  // the thing the rest of it works on sets its own answer, and every run
  // inherits that; this is only what a workflow that has said nothing means.
  function rerunDefaults(x) {
    const d = x || {};
    let stepIndex = typeof d.stepIndex === "number" ? Math.floor(d.stepIndex) : 0;
    if (!(stepIndex >= 0)) stepIndex = 0;
    return {
      stepIndex: stepIndex,
      freshChats: !!d.freshChats,
      carryFinal: d.carryFinal !== false,
      // Fresh conversations start empty, so the papers go up again — that being
      // what "the same run, again" means. Off for a re-run that only needs the
      // hand-off, where re-uploading twenty exhibits is a waste of the turn.
      reuseDocs: d.reuseDocs !== false,
    };
  }

  // Those answers as they apply to THIS run: its own if it has them, and the
  // step clamped to a plan that may have been edited shorter since.
  function rerunSettings(run) {
    const d = rerunDefaults(run && run.rerun);
    const total = ((runSource(run, null).steps) || []).length;
    if (total > 0 && d.stepIndex > total - 1) d.stepIndex = total - 1;
    return d;
  }

  function canRerun(run) {
    return !!run && run.status === "done" && run.allowRerun !== false;
  }

  // Runs are numbered as you'd count them out loud: the original is Run 1, its
  // first re-run is Run 2. Stripped before appending, so a third pass is
  // "Smith (Run 3)" rather than "Smith (Run 2) (Run 2)". The older "(re-run N)"
  // spelling is stripped too, so runs made before this still re-run cleanly.
  const RUN_SUFFIX_RE = /\s*\((?:re-run|run)\s*\d*\)\s*$/i;
  function baseRunName(name) {
    return trimmed(str(name).replace(RUN_SUFFIX_RE, ""));
  }

  // Which run this is, counting the original as the first.
  function runNumber(run) {
    return ((run && run.rerunCount) || 0) + 1;
  }

  function rerunName(name, generation) {
    const base = baseRunName(name);
    return base ? base + " (Run " + (generation + 1) + ")" : "";
  }

  function rerunOf(run, opts, id, now) {
    if (!run) return null;
    const o = opts || {};
    const src = runSource(run, null);
    const total = (src.steps || []).length;
    let stepIndex = typeof o.stepIndex === "number" ? Math.floor(o.stepIndex) : 0;
    if (!(stepIndex >= 0)) stepIndex = 0;
    if (total > 0 && stepIndex > total - 1) stepIndex = total - 1;
    const fresh = !!o.freshChats;
    const reuseDocs = o.reuseDocs !== false;
    const generation = (run.rerunCount || 0) + 1;

    const docs = (run.docs || []).map((d) => {
      const doc = newDoc(d, d && d.id);
      // Papers that went up on a step this re-run skips would never be
      // uploaded at all — the plan puts them on a step that doesn't run. In a
      // fresh conversation that matters; in the old one they're already there.
      //
      // Left alone rather than dropped when they aren't wanted: the re-run
      // still says which papers the matter had, they just stay on the step
      // nothing runs and so never go up.
      if (fresh && reuseDocs)
        doc.addedAt = Math.max(typeof d.addedAt === "number" ? d.addedAt : 0, stepIndex);
      return doc;
    });

    const next = newRun(
      {
        id: run.workflowId,
        name: rerunName(run.name || run.templateName, generation),
        templateName: run.templateName,
        // Its own copy of the plan, as any run has. A chat told to start in an
        // existing conversation is a fact about the FIRST run — this one either
        // continues in the conversations that run ended up in, or opens new.
        chats: (src.chats || []).map((c) =>
          Object.assign({}, c, { startUrl: null, seedFromLatest: false })
        ),
        steps: src.steps || [],
        docs: docs,
        pseudoKeyId: run.pseudoKeyId,
        runDate: run.runDate,
        bundleText: run.bundleText,
        nameChats: run.nameChats,
        allowRerun: run.allowRerun,
        rerun: run.rerun,
        ignoreOutage: run.ignoreOutage,
      },
      id,
      now,
      // Straight away unless the caller wants it parked. A re-run is the same
      // matter again — there is nothing left to set up, which is the whole
      // reason it is one press rather than Create run and a trip through the
      // editor.
      o.start === false ? { type: "draft" } : { type: "now" },
      docs
    );

    return Object.assign({}, next, {
      stepIndex: stepIndex,
      seedFrom: null,
      chats: fresh ? {} : Object.assign({}, run.chats),
      // Carried into the first step it runs, if that step takes a hand-off.
      lastReply: o.carryFinal ? str(run.lastReply) : "",
      rerunOf: run.id,
      rerunCount: generation,
    });
  }

  // Would the step a re-run starts on actually paste the previous run's final
  // reply? Only a step that carries takes one, so offering the choice where it
  // can't be honoured would be a tick that does nothing.
  function rerunCarries(run, stepIndex) {
    const plan = planRun(runSource(run, null));
    const step = plan[stepIndex];
    return !!(step && step.carry);
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

  // Settings a stored plan may still carry from a build that had them. A run
  // does not go back through newChatSlot/newStep once it has started, so a run
  // paused — or a template last saved — under the older build comes back with
  // the old keys intact, and everything downstream would have to know a field
  // it no longer sets can still turn up.
  //
  // `approval` is the one so far. Cowork's approval mode is sticky: it stays
  // wherever the last person to touch it left it, so there was never anything
  // for a send to do but leave it alone, and a stored "skip" is now a promise
  // nothing keeps.
  const RETIRED_FIELDS = ["approval"];

  function withoutRetired(list) {
    return (list || []).map((o) => {
      if (!o || typeof o !== "object") return o;
      if (!RETIRED_FIELDS.some((k) => k in o)) return o; // the ordinary case: no copy
      const copy = Object.assign({}, o);
      for (const k of RETIRED_FIELDS) delete copy[k];
      return copy;
    });
  }

  // What a run is actually executing: its own snapshot if it has one, otherwise
  // the workflow (runs created before runs carried their own). Everything that
  // walks a run's steps goes through here, so a run edited mid-flight and a
  // template edited behind it can't be confused for each other — and so
  // retired settings are dropped at ONE door, the one a stored plan re-enters
  // through on a resume and on a re-run alike.
  function runSource(run, wf) {
    const plan = run && run.plan;
    if (plan && Array.isArray(plan.steps) && plan.steps.length)
      return {
        chats: withoutRetired(plan.chats || []),
        steps: withoutRetired(plan.steps),
        docs: (run && run.docs) || [],
      };
    return {
      chats: withoutRetired((wf && wf.chats) || []),
      steps: withoutRetired((wf && wf.steps) || []),
      docs: ((wf && wf.docs) || []).concat((run && run.docs) || []),
    };
  }

  // Turn a run back into a template. A run carries its own steps, so one that
  // was edited mid-flight — or whose workflow has since been re-armed, rewritten
  // or deleted — is the only remaining record of how that work was actually
  // done. Fresh ids throughout: the result is a new template, not a reference
  // back to whatever it came from. Documents are left out; the papers belonged
  // to that matter, and a template starts empty by design.
  function workflowFromRun(run, wf, id, now, mkId) {
    const src = runSource(run, wf);
    const mk = typeof mkId === "function" ? mkId : () => null;
    const chatMap = {};
    const chats = (src.chats || []).map((c, i) => {
      const nid = mk() || c.id;
      chatMap[c.id] = nid;
      return newChatSlot(c, nid, i);
    });
    const name = trimmed(run && run.name) || trimmed(run && run.templateName) || "Workflow from a run";
    return newWorkflow(
      {
        name: name,
        templateName: name,
        description: (wf && wf.description) || "",
        chats: chats,
        docs: [],
        steps: (src.steps || []).map((s) =>
          newStep(Object.assign({}, s, { chatId: chatMap[s.chatId] || null }), mk() || s.id)
        ),
      },
      id,
      now
    );
  }

  // Change when a queued run goes off. Only meaningful before it has started —
  // once a run is under way its trigger is history, and the thing you want then
  // is Pause or Fix & continue.
  // A run that exists but has never been armed: created from a workflow so this
  // matter's name, papers and tweaks live on the RUN rather than on the template,
  // which is a shared thing the next matter needs back clean. It sits at the top
  // of the runs list doing nothing until it's given a trigger.
  function isDraft(run) {
    return !!run && run.status === "draft";
  }

  // How a run is named on screen: the matter, and the workflow it's a run of.
  // A run set up but not yet named says so rather than borrowing the template's
  // name, which would make the runs list read like a second copy of the
  // workflows list.
  function runLabel(run) {
    const r = run || {};
    const name = trimmed(r.name);
    const template = trimmed(r.templateName);
    const title = name || template || "Untitled run";
    return {
      title: title,
      // Only worth showing beside the title when it isn't already the title.
      template: template && template !== title ? template : "",
      named: !!name,
    };
  }

  // Has it actually gone yet? A draft hasn't, and neither has a run still
  // waiting on its trigger — both can still be changed before anything is sent.
  function started(run) {
    return !!run && run.status !== "draft" && run.status !== "pending";
  }

  function canRetrigger(run) {
    return !!run && (run.status === "pending" || run.status === "draft");
  }

  // ---- what the run editor opens on, and what it asks before it goes -------
  //
  // A run set up and saved GOES. The editor used to open on whatever the run
  // was last left as, which for a run being set up is "draft" — so a matter
  // that had just been given its papers, its date and its steps still sat
  // there until somebody came back, chose Run now, and saved a second time.
  // That second gesture was the commonest way for a matter to be late, and it
  // told nobody anything: a draft looks exactly like a run that is waiting on
  // purpose.
  //
  // So the editor opens on "now" — and an ARRANGEMENT is kept, because a run
  // told to wait for a time or for the next usage reset was told that on
  // purpose and saving an edit is not changing your mind about it. "Not yet"
  // stays one click away in the same select, for the matter you really are
  // still setting up; it is a choice made per save rather than a state a run
  // sits in unasked.
  function editorTriggerType(run) {
    const t = (run && run.trigger) || {};
    return t.type === "time" || t.type === "reset" ? t.type : "now";
  }

  // The one question a start is worth stopping for: a run about to go out with
  // NOTHING to upload. With the editor now defaulting to "now", this is what
  // stands between a half-set-up matter and a first message sent with no
  // papers at all — so it distinguishes the two ways of having none, since
  // documents attached but not ticked for a chat is a fixable mistake rather
  // than a deliberately paperless run. Answers "" when there is nothing to
  // ask.
  function startWarning(run, wf) {
    if (totalUploads(runSource(run, wf))) return "";
    const stray = ((run && run.docs) || []).length;
    return stray
      ? "This run has " + stray + " document(s), but none are ticked for a chat — nothing will be " +
          "uploaded. Start it anyway?"
      : "This run has no documents attached — its first message goes out with nothing. Start it anyway?";
  }

  function retrigger(run, trigger, now) {
    if (!run) return run;
    const t = trigger || {};
    const next =
      t.type === "time"
        ? { type: "time", at: t.at }
        : t.type === "reset"
        ? { type: "reset" }
        : t.type === "draft"
        ? { type: "draft" }
        : { type: "now" };
    // Giving a draft a trigger is what starts it — up to that moment it's a
    // matter being set up, not a job in a queue. And taking the trigger back off
    // a queued run puts it there again, which is how a matter is un-scheduled
    // without being cancelled.
    return Object.assign({}, run, {
      trigger: next,
      status: next.type === "draft" ? "draft" : "pending",
      lastProgressAt: now,
    });
  }

  // Stop at the next step boundary, keeping everything else — where it is, what
  // it's carrying, which conversations it's in. A step already in flight is
  // allowed to finish; pausing is not cancelling.
  // Paused, and waiting for you. Any standing arrangement to pick itself back
  // up is dropped: pausing a run by hand is a decision that it should stay
  // where it is until you say otherwise.
  function markPaused(run, now) {
    return Object.assign({}, stopStepClock(run, now), {
      status: "paused",
      lastProgressAt: now,
      resumeOnUsage: false,
      resumeAt: null,
    });
  }

  // Paused, and waiting for the meter. A run that stopped only because the
  // window was empty is in a different position from one you stopped: nothing
  // needs deciding, and the thing it is waiting for arrives on a schedule. So
  // it carries the time it expects to be able to go again and picks itself up
  // then — which is what `usageWaitingRuns` below is for.
  //
  // The old behaviour was to wait for a person, on the reasoning that a run
  // resuming itself at 3am starts an afternoon's work with nobody watching.
  // That reasoning is still true; it is now the user's call rather than this
  // module's, and `Stay paused` on the run's row is how it is made.
  function markPausedForUsage(run, now, backAt) {
    return Object.assign({}, markPaused(run, now), {
      resumeOnUsage: true,
      resumeAt: typeof backAt === "number" && backAt > 0 ? backAt : null,
    });
  }

  // Stop it lifting its own pause, without cancelling it or starting it now.
  function holdPaused(run) {
    if (!run) return run;
    return Object.assign({}, run, { resumeOnUsage: false, resumeAt: null });
  }

  // Stopped by a pause step. The run has already stepped PAST the pause — it is
  // done, the way any step is done once it has happened — so Resume, whether
  // yours or the clock's, carries straight on with the step after it.
  //
  // `resumeAt` is the clock's; without one it waits for you.
  function markPausedForStep(run, now, atMs) {
    return Object.assign({}, markPaused(run, now), {
      pausedByStep: true,
      resumeAt: typeof atMs === "number" && atMs > 0 ? atMs : null,
    });
  }

  // Runs a timed pause step is holding, and whose time is up. The meter has
  // nothing to do with these — they are waiting on a clock and nothing else.
  function clockWaitingRuns(runs, now) {
    const t = typeof now === "number" ? now : Date.now();
    return (runs || []).filter(
      (r) =>
        r &&
        r.status === "paused" &&
        !r.resumeOnUsage &&
        typeof r.resumeAt === "number" &&
        r.resumeAt > 0 &&
        r.resumeAt <= t
    );
  }

  // When the first of them is due, for the alarm that wakes the worker.
  function nextClockResume(runs, now) {
    const t = typeof now === "number" ? now : Date.now();
    const times = (runs || [])
      .filter((r) => r && r.status === "paused" && !r.resumeOnUsage)
      .map((r) => r.resumeAt)
      .filter((at) => typeof at === "number" && at > t);
    return times.length ? Math.min.apply(null, times) : null;
  }

  // Runs waiting on the meter rather than on you.
  function usageWaitingRuns(runs) {
    return (runs || []).filter((r) => r && r.status === "paused" && r.resumeOnUsage);
  }

  // When the first of them expects to be able to go again, for the alarm that
  // wakes the worker. Null where none of them knows — the meter is asked again
  // on every reading either way, so a run with no time on it is not lost, it
  // just isn't what the alarm is set by.
  function nextUsageResume(runs) {
    const times = usageWaitingRuns(runs)
      .map((r) => r.resumeAt)
      .filter((t) => typeof t === "number" && t > 0);
    return times.length ? Math.min.apply(null, times) : null;
  }

  // Apply an edit to a run in progress: steps inserted or reworded, chats
  // renamed, documents added. Documents new to the run are marked with the step
  // it has reached, so they go up with the next step in their chats rather than
  // trying to ride an opening message that has already been sent.
  function applyRunEdit(run, patch, now) {
    if (!run) return run;
    const p = patch || {};
    const prior = new Set(((run.docs || []).map((d) => d && d.id)).filter(Boolean));
    const src = runSource(run, null);
    const shaped = normalize({
      chats: (Array.isArray(p.chats) ? p.chats : src.chats).map((c, i) =>
        newChatSlot(c, c && c.id, i)
      ),
      steps: (Array.isArray(p.steps) ? p.steps : src.steps).map((s) => newStep(s, s && s.id)),
      docs: allowedDocs(Array.isArray(p.docs) ? p.docs : src.docs).map((d) => {
        const doc = newDoc(d, d && d.id);
        // Stamped with where the run has reached, so it rides the next step in
        // each of its chats rather than an opening message that may already have
        // gone. On a run that hasn't started this is step 0, which is that
        // chat's opening message — the same place it would have gone anyway.
        if (!prior.has(doc.id) && typeof doc.addedAt !== "number") doc.addedAt = run.stepIndex;
        return doc;
      }),
    });
    // The switches are a run's own too, not only the template's — the editor
    // shows them on a run, and until they were carried here it showed them
    // doing nothing.
    const flag = (k) => (typeof p[k] === "boolean" ? p[k] : run[k]);
    // The date first, because the name is composed FROM it: the matter as
    // typed (or as it stood), with the current date label on the end — never
    // two labels, and clearing the date really clears it.
    const runDate =
      typeof p.runDate !== "undefined" ? isoRunDate(p.runDate) : isoRunDate(run.runDate);
    return Object.assign({}, run, {
      name: composeRunName(trimmed(p.name) || run.name, runDate),
      runDate: runDate,
      plan: { chats: shaped.chats, steps: shaped.steps },
      docs: shaped.docs,
      totalSteps: shaped.steps.length,
      bundleText: flag("bundleText"),
      nameChats: flag("nameChats"),
      allowRerun: flag("allowRerun"),
      ignoreOutage: flag("ignoreOutage"),
      // The run's own window, like the rest of them: the editor shows this
      // switch on a run, and until it was carried here it showed it doing
      // nothing.
      newWindow: flag("newWindow"),
      pseudoKeyId:
        typeof p.pseudoKeyId !== "undefined" ? p.pseudoKeyId || null : run.pseudoKeyId || null,
      rerun: p.rerun ? rerunDefaults(p.rerun) : run.rerun,
      lastProgressAt: now,
      updatedAt: now,
    });
  }

  // ---- run dates, related-run groups, and the runs list's orders -----------

  // A run's optional DATE — the hearing or due date the matter is known by.
  // Stored canonically as "YYYY-MM-DD" (what a calendar input yields), entered
  // by hand as mm/dd/yy, and shown — including inside the run's name — as
  // m/d/yy.
  const RUN_DATE_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const RUN_DATE_TAIL_RE = /\s*\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2}(?:\d{2})?$/;

  // A run's name comes apart into three pieces: the matter, the date label
  // the date box wrote onto the end, and the "(Run N)" suffix a re-run wears.
  // One splitter, so composing and stripping can never disagree about where
  // the date sits — after the matter, before the run number.
  function splitRunName(name) {
    let s = trimmed(str(name));
    const sufM = s.match(RUN_SUFFIX_RE);
    const suffix = sufM ? trimmed(sufM[0]) : "";
    if (sufM) s = trimmed(s.slice(0, sufM.index));
    const dateM = s.match(RUN_DATE_TAIL_RE);
    const date = dateM ? trimmed(dateM[0]) : "";
    if (dateM) s = trimmed(s.slice(0, dateM.index));
    return { base: s, date: date, suffix: suffix };
  }

  // What the editor's name box shows: the matter alone. The date lives in its
  // own box, so the name field must not echo it back — retyping would double
  // it, and clearing the date box could never remove it.
  function runBaseName(name) {
    return splitRunName(name).base;
  }

  /** mm/dd/yy (also m/d/yyyy, dots or dashes, and ISO) → "YYYY-MM-DD" or null. */
  function parseRunDate(text) {
    const s = trimmed(str(text));
    if (!s) return null;
    let y, m, d;
    let match = s.match(RUN_DATE_ISO_RE);
    if (match) {
      y = +match[1];
      m = +match[2];
      d = +match[3];
    } else {
      match = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}(?:\d{2})?)$/);
      if (!match) return null;
      m = +match[1];
      d = +match[2];
      y = +match[3] + (match[3].length === 2 ? 2000 : 0);
    }
    // A real calendar day, not merely the right shape — 2/30 must not become
    // a run's name.
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    const p2 = (n) => String(n).padStart(2, "0");
    return y + "-" + p2(m) + "-" + p2(d);
  }

  // A stored value however it arrived: ISO passes through, anything else gets
  // one chance to parse, and garbage is null rather than a lie in a name.
  function isoRunDate(v) {
    const s = trimmed(str(v));
    if (!s) return null;
    return RUN_DATE_ISO_RE.test(s) ? s : parseRunDate(s);
  }

  function runDateLabel(iso) {
    const m = str(iso).match(RUN_DATE_ISO_RE);
    if (!m) return "";
    return +m[2] + "/" + +m[3] + "/" + String(+m[1] % 100).padStart(2, "0");
  }

  // The run's display name with its date written in: matter, date, run
  // number, in that order. Composing strips any date label already on the
  // end first, so re-saving never stacks a second one and clearing the date
  // box really removes it. (The cost, stated: a name deliberately ENDING in a
  // bare date-shaped token now belongs to the date box.)
  function composeRunName(name, iso) {
    const parts = splitRunName(name);
    const label = runDateLabel(isoRunDate(iso));
    return trimmed(
      parts.base + (label ? " " + label : "") + (parts.suffix ? " " + parts.suffix : "")
    );
  }

  // Related runs: one matter across several runs. A group is a set of run ids
  // in cum_run_groups; a run belongs to at most one group, which is what lets
  // "check some runs off and save" MOVE a run rather than fork it. A group
  // that falls under two members isn't a group and dissolves.
  function groupOf(groups, runId) {
    for (const g of groups || []) {
      if (g && Array.isArray(g.runIds) && g.runIds.indexOf(runId) !== -1) return g.id;
    }
    return null;
  }

  function assignGroup(groups, ids, newId) {
    const pick = new Set((ids || []).filter(Boolean));
    const out = [];
    for (const g of groups || []) {
      const left = (g && g.runIds ? g.runIds : []).filter((id) => !pick.has(id));
      if (left.length >= 2) out.push({ id: g.id, runIds: left });
    }
    if (pick.size >= 2) out.push({ id: newId, runIds: Array.from(pick) });
    return out;
  }

  // Taking runs OUT is the same removal assigning them elsewhere starts with.
  function ungroupRuns(groups, ids) {
    const gone = new Set((ids || []).filter(Boolean));
    const out = [];
    for (const g of groups || []) {
      const left = (g && g.runIds ? g.runIds : []).filter((id) => !gone.has(id));
      if (left.length >= 2) out.push({ id: g.id, runIds: left });
    }
    return out;
  }

  // Deleted runs must not haunt their groups.
  function pruneGroups(groups, runs) {
    const alive = new Set((runs || []).map((r) => r && r.id).filter(Boolean));
    const out = [];
    let changed = false;
    for (const g of groups || []) {
      const left = (g && g.runIds ? g.runIds : []).filter((id) => alive.has(id));
      if (left.length >= 2) {
        if (left.length !== (g.runIds || []).length) changed = true;
        out.push({ id: g.id, runIds: left });
      } else changed = true;
    }
    return { groups: out, changed: changed };
  }

  // Which distinct pseudonym keys a set of runs names. Runs are per CASE, so
  // a group of related runs is one case and never legitimately names more
  // than one key — this is what the group-save guard asks before letting a
  // grouping stand, so the mixed state is refused at the door rather than
  // reconciled after the fact.
  function distinctPseudoKeys(runs, ids) {
    const pick = new Set((ids || []).filter(Boolean));
    const out = [];
    for (const r of runs || []) {
      if (!r || !pick.has(r.id) || !r.pseudoKeyId) continue;
      if (out.indexOf(r.pseudoKeyId) === -1) out.push(r.pseudoKeyId);
    }
    return out;
  }

  // The pseudonym key a run answers to: its own, else the one a related run
  // carries — a group is one matter, and one matter has one key. The guard
  // above keeps a group from ever naming two; the earliest-created-mate
  // order below only decides a legacy or hand-edited mixed state, so the
  // answer never flickers with edit order even then.
  function runPseudoKey(run, runs, groups) {
    if (!run) return null;
    if (run.pseudoKeyId) return run.pseudoKeyId;
    const gid = groupOf(groups, run.id);
    if (!gid) return null;
    const mates = (runs || []).filter(
      (r) => r && r.id !== run.id && r.pseudoKeyId && groupOf(groups, r.id) === gid
    );
    mates.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return mates.length ? mates[0].pseudoKeyId : null;
  }

  /**
   * What a group is CALLED: the same way the key library labels a case — the
   * key's hint (the real name that case's exports used most), else the key
   * file's name, else the earliest-created member's own matter name. Empty
   * means the caller falls back to a numbered label; a group is one case,
   * so whichever member names the key names the group.
   */
  function groupLabel(group, runs, keys) {
    const byId = new Map((runs || []).map((r) => [r && r.id, r]));
    const members = ((group && group.runIds) || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (const m of members) {
      const key = m.pseudoKeyId && keys ? keys[m.pseudoKeyId] : null;
      // The order P.keyTitle uses, restated here because this module has no
      // dependencies: the case FOLDER the key was picked from, then the case
      // hint, then the file's own name.
      if (key) return trimmed(key.folder) || trimmed(key.hint) || trimmed(key.name);
    }
    for (const m of members) if (trimmed(m.name)) return runBaseName(m.name);
    return "";
  }

  // What a run's TAB GROUP is called and colored. Named like everything else
  // now is — for the case: the key's own label first (the case folder it was
  // picked from, else its hint), then the matter's own name, then the
  // template's. Chrome truncates long group titles ungracefully, so
  // this cuts them itself. The color seed is the run's KEY where it has one,
  // so every run of a case — and every run in its group, which shares the
  // key — wears the same color; a keyless run falls back to its own id.
  const TAB_GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

  function tabGroupTitle(run, keys) {
    const key = run && run.pseudoKeyId && keys ? keys[run.pseudoKeyId] : null;
    const name =
      (key && (trimmed(key.folder) || trimmed(key.hint))) ||
      runBaseName(run && run.name) ||
      trimmed(run && run.templateName) ||
      "run";
    return name.length > 24 ? name.slice(0, 23) + "…" : name;
  }

  function tabGroupColor(seed) {
    const s = str(seed);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return TAB_GROUP_COLORS[h % TAB_GROUP_COLORS.length];
  }

  /**
   * Updating the CASE's key from anywhere updates it everywhere the case
   * lives. Given the conversation the change was made in (or a run id), the
   * plan names every run to rewrite — the run(s) that own the conversation
   * plus every member of their groups, a group being one case — and every
   * conversation an existing CHAT-level attachment might be shadowing.
   * Empty runIds means the conversation belongs to no run, and the caller
   * falls back to a plain chat attachment.
   */
  function rekeyPlan(runs, groups, opts) {
    const o = opts || {};
    const primaries = new Set();
    for (const r of runs || []) {
      if (!r) continue;
      if (o.runId && r.id === o.runId) primaries.add(r.id);
      if (o.conv) {
        const chats = r.chats || {};
        for (const cid of Object.keys(chats)) {
          const url = chats[cid] && chats[cid].url;
          if (url && conversationKey(url) === o.conv) primaries.add(r.id);
        }
      }
    }
    if (!primaries.size) return { runIds: [], convs: [] };
    const runIds = new Set(primaries);
    for (const id of Array.from(primaries)) {
      const gid = groupOf(groups, id);
      if (!gid) continue;
      for (const g of groups || []) {
        if (g && g.id === gid) for (const m of g.runIds || []) runIds.add(m);
      }
    }
    const byId = new Map((runs || []).map((r) => [r && r.id, r]));
    const convs = new Set();
    for (const id of runIds) {
      const r = byId.get(id);
      const chats = (r && r.chats) || {};
      for (const cid of Object.keys(chats)) {
        const url = chats[cid] && chats[cid].url;
        if (url) convs.add(conversationKey(url));
      }
    }
    return { runIds: Array.from(runIds), convs: Array.from(convs) };
  }

  // The runs list's default order: runs still being set up first (they're the
  // ones waiting on you), then newest first. The other two orders build on it.
  function createdOrder(a, b) {
    return (
      (isDraft(b) ? 1 : 0) - (isDraft(a) ? 1 : 0) || ((b && b.createdAt) || 0) - ((a && a.createdAt) || 0)
    );
  }

  /**
   * The runs list in one of its three orders:
   *   "created" — the default above.
   *   "date"    — dated runs first, soonest run date first (a docket reads
   *               forward); runs without a date follow in the default order.
   *   "group"   — the default order, with each group's members pulled
   *               together at the position of the group's first-appearing
   *               member, members in default order among themselves.
   */
  function sortRuns(runs, mode, groups) {
    const list = (runs || []).filter(Boolean).slice();
    if (mode === "date") {
      return list.sort((a, b) => {
        const da = (a && a.runDate) || "";
        const db = (b && b.runDate) || "";
        if (da && db && da !== db) return da < db ? -1 : 1;
        if (!da !== !db) return da ? -1 : 1;
        return createdOrder(a, b);
      });
    }
    if (mode === "group") {
      const order = list.sort(createdOrder);
      const out = [];
      const done = new Set();
      for (const r of order) {
        if (done.has(r.id)) continue;
        const gid = groupOf(groups, r.id);
        if (!gid) {
          out.push(r);
          done.add(r.id);
          continue;
        }
        for (const m of order) {
          if (!done.has(m.id) && groupOf(groups, m.id) === gid) {
            out.push(m);
            done.add(m.id);
          }
        }
      }
      return out;
    }
    return list.sort(createdOrder);
  }

  // A SPREADSHEET never rides a run's uploads — the pseudonym key is an
  // .xlsx, and "the key picked up with the exhibits" is exactly the accident
  // that must be impossible rather than unlikely. The bar is structural:
  // every path that shapes a run's documents filters through this, and the
  // runner's own document read (allDocs) refuses them too, so a run stored
  // before the rule existed still cannot upload one.
  const DOC_BARRED_RE = /\.(xlsx|xlsm|xltx|xls)$/i;
  function docBarred(name) {
    return DOC_BARRED_RE.test(trimmed(name));
  }
  function allowedDocs(list) {
    return (list || []).filter((d) => d && !docBarred(d.name));
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

  // Which model the step about to run will answer on.
  //
  // The step's own choice, then the chat's, then your default — because a
  // workflow that names no model isn't using "no model", it is using whatever
  // claude.ai is set to, and an outage confined to that one still stops it.
  // planRun has already resolved the first two into modelOn.
  function stepModel(run, wf, fallback) {
    const src = runSource(run, wf);
    const plan = planRun(src);
    const step = plan[run && run.stepIndex] || null;
    return trimmed(step && step.modelOn) || trimmed(fallback) || null;
  }

  // Should this run wait out an outage at all? A workflow can say it would
  // rather push on — a minor outage often doesn't touch what a run is doing,
  // and a run that waits six hours for something that never affected it has
  // cost you the afternoon for nothing.
  function ignoresOutage(run) {
    return !!(run && run.ignoreOutage);
  }

  // Has this run been told to stop? One definition, asked by every page a run
  // is driving and at every point a step could stand down — before it sends,
  // while it is sending, and while it waits for the answer.
  //
  // It has to be run-wide rather than per-chat. A wave is three conversations
  // working at once, and Pause pressed in one of them is a decision about the
  // run, not about the tab it was pressed in: leaving the other two to finish
  // is leaving two long answers to be paid for and thrown away.
  function runHalted(run) {
    if (!run) return "gone";
    if (run.status === "canceled") return "canceled";
    if (run.status === "paused") return "paused";
    return null;
  }

  function heldRuns(runs) {
    return (runs || []).filter((r) => r && r.status === "waiting");
  }

  // Runs a restarted worker should take over. A run sitting BETWEEN steps
  // (phase "idle") is always free to pick up — nobody is mid-step. A run whose
  // step is in flight is only picked up once its heartbeat has gone quiet, so a
  // worker restart can never re-send a message that is still on its way out.
  // Everything that OUGHT to be moving right now with nobody moving it. Two
  // kinds, and the second is the one that bites:
  //
  //   - RUNNING but nobody on it: idle between steps, or gone quiet past the
  //     ceiling because the page or the worker driving it died mid-step.
  //   - PENDING and DUE: armed to go now, or past the time it was set for, and
  //     never picked up. A run is normally driven by the in-process call made
  //     the moment it is armed — and a service worker is allowed to die in the
  //     middle of that. Nothing else was looking for these: the time alarm is
  //     only ever set from a "time" trigger (nextRunTrigger below), so a run
  //     told to go NOW that missed its own call sat at Not started until the
  //     browser was restarted or someone pressed Start by hand. Which is to
  //     say: the automation failed to act, and did it silently.
  //
  // The keepalive watchdog asks this every thirty seconds, so a run that was
  // told to go starts within thirty seconds of being told, whatever happened to
  // the worker that was told. Driving one already being driven is a no-op —
  // driveRun holds a set of the runs it has in hand.
  function pickupRuns(runs, now, staleMs, beats) {
    const beat = (id) => (beats && typeof beats[id] === "number" ? beats[id] : 0);
    const stalled = (runs || []).filter(
      (r) =>
        r &&
        r.status === "running" &&
        (r.phase === "idle" || !r.phase || isStale(r, now, staleMs, beat(r.id)))
    );
    // Disjoint by status, so there is nothing to de-duplicate.
    return stalled.concat(dueRuns(runs, now));
  }

  // `beatAt` is the run's own heartbeat key — the page saying "still mine".
  // Either signal being recent means someone is on it.
  function isStale(run, now, staleMs, beatAt) {
    const at = Math.max(
      run && typeof run.lastProgressAt === "number" ? run.lastProgressAt : 0,
      typeof beatAt === "number" ? beatAt : 0
    );
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
  // ---- how long a step took ----------------------------------------------
  //
  // Wall clock alone lies about a run: a step that sat overnight in an outage
  // hold, or over a weekend paused, would read as a fourteen-hour step. So the
  // step's clock stops whenever the run itself stops and starts again when it's
  // picked back up, and every finished step records both figures — the time it
  // spent working and the time it spent stopped — rather than one number that
  // silently mixes them.
  //
  // The clock is only ever *started* by sending: a run resumed from an earlier
  // version of itself, or one told its message already went out, has no start to
  // resume, and a step that reports null is better than one that reports a
  // duration measured from the wrong moment.
  function startStepClock(run, now) {
    return Object.assign({}, run, { stepStartedAt: now, stepStoppedAt: null, stepStoppedMs: 0 });
  }

  function stopStepClock(run, now) {
    if (!run || typeof run.stepStartedAt !== "number") return run;
    if (typeof run.stepStoppedAt === "number") return run; // already stopped
    return Object.assign({}, run, { stepStoppedAt: now });
  }

  function resumeStepClock(run, now) {
    if (!run || typeof run.stepStoppedAt !== "number") return run;
    return Object.assign({}, run, {
      stepStoppedAt: null,
      stepStoppedMs: (run.stepStoppedMs || 0) + Math.max(0, now - run.stepStoppedAt),
    });
  }

  function clearStepClock(run) {
    return Object.assign({}, run, {
      stepStartedAt: null,
      stepStoppedAt: null,
      stepStoppedMs: 0,
      stepUsage: null,
    });
  }

  // The three legs of a step, any of which can be unknown:
  //   sendMs  — composing the message and getting its documents up
  //   replyMs — Claude answering, which is where the hours actually go
  //   ms      — the two together, stopped time excluded
  // Stopped time is charged to the reply leg, since that's where a pause lands
  // in practice, which keeps ms exactly sendMs + replyMs.
  function stepTiming(run, endedAt) {
    const r = run || {};
    const started = typeof r.stepStartedAt === "number" ? r.stepStartedAt : null;
    const sent = typeof r.sentAt === "number" ? r.sentAt : null;
    const end = typeof endedAt === "number" ? endedAt : null;
    let stopped = Math.max(0, r.stepStoppedMs || 0);
    if (typeof r.stepStoppedAt === "number" && end != null)
      stopped += Math.max(0, end - r.stepStoppedAt);
    return {
      startedAt: started,
      sentAt: sent,
      endedAt: end,
      stoppedMs: stopped,
      ms: started != null && end != null ? Math.max(0, end - started - stopped) : null,
      sendMs: started != null && sent != null ? Math.max(0, sent - started) : null,
      replyMs: sent != null && end != null ? Math.max(0, end - sent - stopped) : null,
    };
  }

  // A short, readable duration. Minutes matter here and milliseconds don't:
  // these are steps that take a quarter of an hour.
  function formatMs(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 ? m + "m " + (s % 60) + "s" : m + "m";
    const h = Math.floor(m / 60);
    return m % 60 ? h + "h " + (m % 60) + "m" : h + "h";
  }

  // What a run's finished steps add up to. `median` rather than mean because one
  // step that stalled for an hour shouldn't be allowed to describe the rest.
  function timingSummary(run) {
    const rows = ((run && run.transcript) || []).filter(
      (t) => t && typeof t.ms === "number" && t.ms >= 0
    );
    if (!rows.length) return { steps: 0, totalMs: null, medianMs: null, longestMs: null, longest: null };
    const ms = rows.map((t) => t.ms).sort((a, b) => a - b);
    const mid = Math.floor(ms.length / 2);
    let longest = rows[0];
    for (const t of rows) if (t.ms > longest.ms) longest = t;
    return {
      steps: rows.length,
      totalMs: rows.reduce((a, t) => a + t.ms, 0),
      medianMs: ms.length % 2 ? ms[mid] : Math.round((ms[mid - 1] + ms[mid]) / 2),
      longestMs: longest.ms,
      longest: longest,
    };
  }

  // Is this conversation one of the run's? Asked by a page that knows only
  // which chat it is looking at, so it can find the run it belongs to without
  // reading every run's plan.
  function runHasConversation(run, convId) {
    if (!run || !convId) return null;
    const chats = run.chats || {};
    for (const cid of Object.keys(chats)) {
      const url = trimmed(chats[cid] && chats[cid].url);
      if (url && conversationId(url) === convId) return cid;
    }
    return null;
  }

  /**
   * Every step of a run as one list you can move around by: what it is, which
   * conversation it happened in, whether it has happened yet, and where to find
   * it.
   *
   * A run is several conversations, and the thing you actually want while
   * reading one of them is the other one — "what did the advocate say about
   * this" is a different chat, and finding it by hand means remembering which
   * tab. This is the index that makes that a click.
   */
  function runDirectory(run, wf) {
    if (!run) return [];
    const plan = planRun(runSource(run, wf));
    const done = {};
    for (const t of run.transcript || []) if (t) done[t.stepIndex] = t;
    const finished = run.status === "done";
    return plan.map((s) => {
      const chat = (run.chats || {})[s.chatId] || {};
      const t = done[s.index] || null;
      return {
        index: s.index,
        label: s.label,
        chatId: s.chatId,
        chatName: s.chatName,
        // Null until the run has actually opened that conversation — a step
        // that hasn't run yet has nowhere to send you.
        url: trimmed(chat.url) || null,
        prompt: s.prompt,
        parallel: s.parallel,
        wave: s.wave.slice(),
        done: !!t,
        // Where the run is now. The whole wave is "here", since all of it is
        // what the run is doing.
        here: !finished && s.wave.indexOf(run.stepIndex) !== -1,
        at: t ? t.at : null,
        chars: t ? t.chars : null,
        ms: t ? t.ms : null,
      };
    });
  }

  // When a run began, when it ended, and how long that was in real time.
  //
  // Deliberately separate from timingSummary, which counts only what the steps
  // spent WORKING. Both are true and they answer different questions: the
  // summary says what the work cost, this says when the thing happened and how
  // long you waited for it. A run that started at four and finished at nine took
  // five hours whatever its steps were doing in between — the gap is the run
  // sitting paused, held out of an outage, or waiting on you.
  function runTiming(run, now) {
    const r = run || {};
    const started = typeof r.startedAt === "number" ? r.startedAt : null;
    const finished = typeof r.finishedAt === "number" ? r.finishedAt : null;
    // A run still going is measured to this moment, so "so far" means something.
    const end = finished != null ? finished : typeof now === "number" ? now : null;
    const work = timingSummary(r);
    const elapsed = started != null && end != null ? Math.max(0, end - started) : null;
    return {
      startedAt: started,
      finishedAt: finished,
      running: started != null && finished == null,
      elapsedMs: elapsed,
      workingMs: work.totalMs,
      // Everything that wasn't a step working. Named rather than left for the
      // reader to subtract, because "5h end to end" next to "40m of work" is
      // the first thing anyone asks about.
      idleMs:
        elapsed != null && typeof work.totalMs === "number"
          ? Math.max(0, elapsed - work.totalMs)
          : null,
    };
  }

  // Is there any usage left to send into? Read from the meter rather than from
  // anything on the page: a reply that DISCUSSES running out of usage must not
  // be able to pause a healthy run, and message text is the one place that
  // sentence is likely to appear.
  //
  // 0.995 rather than 1 because the endpoint reports whole percents — a window
  // reading 99.6% has nothing left worth spending a step on. Either window
  // counts: a weekly limit blocks a fresh 5-hour session just as firmly.
  const USAGE_FULL = 0.995;
  function usageExhausted(state) {
    const s = state || {};
    const at = (v) => typeof v === "number" && isFinite(v) && v >= USAGE_FULL;
    return at(s.percent) || at(s.weeklyPercent);
  }

  // Is the meter's reading still describing NOW?
  //
  // It stops doing so in two ways. The window it describes may since have
  // reset, in which case its own resets_at is in the past and the percent it
  // carries belongs to a window that has ended. Or the reading may simply be
  // old: usage is read by claude.ai's own pages, so a browser with no claude.ai
  // tab open refreshes nothing, and a run that ran out overnight would sit
  // watching a number that cannot change. Either way the honest answer is "this
  // doesn't say", not "this says you are out".
  //
  // Six hours because the shorter window is five: a reading older than the
  // window it measures has outlived the thing it was measuring.
  const USAGE_STALE_MS = 6 * 60 * 60 * 1000;
  function usageReadingCurrent(state, now) {
    const s = state || {};
    const t = typeof now === "number" ? now : Date.now();
    const back = usageBackAt(s);
    if (typeof back === "number" && back > 0 && back <= t) return false; // window has since rolled over
    const at = typeof s.updatedAt === "number" ? s.updatedAt : 0;
    if (!at || t - at > USAGE_STALE_MS) return false;
    return true;
  }

  // Is there nothing to send into, as far as anyone can currently tell?
  //
  // This is the question both the run's own gate and its resume ask, and they
  // have to ask the same one. Asking `usageExhausted` alone would have the gate
  // pause a run on a stale reading that the resume then treats as expired —
  // resume, re-pause, resume, forever, and never a tab opened to find out.
  function usageBlocked(state, now) {
    return usageExhausted(state) && usageReadingCurrent(state, now);
  }

  // When it comes back, so a paused run can say. Null when the meter doesn't
  // know — better to say nothing than to name a time we're guessing at.
  function usageBackAt(state) {
    const s = state || {};
    const session = typeof s.percent === "number" && s.percent >= USAGE_FULL ? s.resetAt : null;
    const weekly =
      typeof s.weeklyPercent === "number" && s.weeklyPercent >= USAGE_FULL ? s.weeklyResetAt : null;
    // Whichever runs out latest is when work can actually resume.
    const times = [session, weekly].filter((t) => typeof t === "number" && t > 0);
    return times.length ? Math.max.apply(null, times) : null;
  }

  // ---- what a run costs ---------------------------------------------------
  //
  // claude.ai publishes no per-conversation cost, so this is the meter's own
  // reading taken before a step and again after it: what your usage did while
  // the run was working. Anything else you did in another tab lands in the same
  // number, which is why it's usage *during* a run rather than usage *by* one —
  // and why the figures are described that way everywhere they're shown.
  //
  // The weekly window is the one worth reporting. It rolls over once a week,
  // where the 5-hour session window rolls over perhaps twice during a nine-step
  // run, and a window that resets between two readings takes the difference
  // with it.
  function usageSample(state) {
    const s = state || {};
    const pct = (v) => (typeof v === "number" && isFinite(v) ? Math.max(0, v * 100) : null);
    return {
      at: typeof s.updatedAt === "number" ? s.updatedAt : null,
      session: pct(s.percent),
      sessionResetAt: typeof s.resetAt === "number" ? s.resetAt : null,
      weekly: pct(s.weeklyPercent),
      weeklyResetAt: typeof s.weeklyResetAt === "number" ? s.weeklyResetAt : null,
    };
  }

  function windowCost(before, after, key, resetKey) {
    if (!before || !after) return null;
    const a = before[key];
    const b = after[key];
    if (typeof a !== "number" || typeof b !== "number") return null;
    // A window that reset between the readings can't be differenced: the meter
    // went back to zero and what it had counted is gone. Reporting `after` alone
    // would understate the step by however much it had already spent.
    if (before[resetKey] !== after[resetKey]) return null;
    const d = b - a;
    if (d < 0 || d > 100) return null; // a drop is a reset we didn't see
    return Math.round(d * 100) / 100;
  }

  function usageCost(before, after) {
    return {
      session: windowCost(before, after, "session", "sessionResetAt"),
      weekly: windowCost(before, after, "weekly", "weeklyResetAt"),
    };
  }

  // Which conversation a claude.ai URL is. The uuid where there is one; the path
  // otherwise, so /new and the Code surface are still distinguishable from each
  // other. Shared with content.js's activity recorder, which has to agree with
  // this exactly or a run would fail to recognise its own turns.
  // What a run's conversation should be called in your sidebar: the matter,
  // then the chat's job within it —
  //   "8.11.26 Motion to Compel Arbitration: Drafting (A)"
  // A run leaves several conversations behind and they are worth telling apart
  // months later, when "Motion to Compel Arbitration" three times over says
  // nothing about which one holds the ruling.
  const MAX_CHAT_TITLE = 100;

  // When an UNNAMED run was created, in the spelling the run names themselves
  // use ("8.11.26 MSJ" leads with its date) — "8.18.26 3:42 PM". A run nobody
  // named still needs its conversations telling apart months later, and the
  // template's name can't do it: it is the same for every matter the workflow
  // ever runs. The one fact every run carries that its siblings don't is when
  // it was made.
  function runStamp(run) {
    const t = run && run.createdAt;
    if (typeof t !== "number" || !isFinite(t) || t <= 0) return "";
    const d = new Date(t);
    const h24 = d.getHours();
    const h = h24 % 12 || 12;
    const mm = ("0" + d.getMinutes()).slice(-2);
    const yy = ("0" + (d.getFullYear() % 100)).slice(-2);
    return (
      d.getMonth() + 1 + "." + d.getDate() + "." + yy +
      " " + h + ":" + mm + " " + (h24 >= 12 ? "PM" : "AM")
    );
  }

  // Every name this run can write into a chat TITLE, which is every name of
  // its that leaves this browser: the matter's own, the template's (which
  // stands in for the matter on a run nobody named) and each chat's. What the
  // case-number gate reads — see P.caseNumberGate.
  function titleNames(run, src) {
    const out = [];
    const push = (v) => {
      const t = trimmed(v);
      if (t && out.indexOf(t) === -1) out.push(t);
    };
    push(run && run.name);
    push(run && run.templateName);
    for (const c of (src && src.chats) || []) push(c && c.name);
    return out;
  }

  // `clean` (optional) is P.nameCleaner for the run's pseudonym key: the matter
  // and the chat's own name go through it before anything is composed, so what
  // reaches claude.ai's sidebar is the case's FAKE name. A title is not display
  // — claude.ai stores it and syncs it — so a run named for the matter would
  // otherwise hand over the one thing every paper it uploads has had scrubbed
  // out of it. Cleaned before the length trim, never after: the fakes are a
  // different length from the reals, and a title trimmed to fit the real name
  // would fit the fake one badly.
  function chatTitle(run, name, clean) {
    // The run's own names, not runLabel's — "Untitled run" is a placeholder for
    // a row on the Options page, and writing it into your sidebar would be
    // taking a gap in the UI for a fact about the matter.
    //
    // An untitled run's matter is its creation stamp, with the template's name
    // riding along where there is one — "8.18.26 3:42 PM Tentative ruling:
    // Drafting (A)". The stamp says which matter, the template says what kind
    // of work; the template alone said only the second, so every unnamed
    // matter's chats read identically in the sidebar.
    //
    // The matter WITHOUT its run number, and the number put back at the end:
    // a re-run's conversations should sort and read beside the originals they
    // repeat — "MSJ: Drafting (A)" then "MSJ: Drafting (A) (Run 2)" — rather
    // than the number splitting the matter from the chat it names.
    const r = run || {};
    const wash = typeof clean === "function" ? (s) => trimmed(clean(s)) : (s) => s;
    const named = baseRunName(r.name);
    const stamp = named ? "" : runStamp(r);
    const template = baseRunName(r.templateName);
    const matter = wash(
      named || (stamp && template ? stamp + " " + template : stamp || template)
    );
    const chat = wash(trimmed(name));
    const n = runNumber(r);
    const tail = (chat ? chat : "") + (n > 1 ? " (Run " + n + ")" : "");
    if (!chat) return matter ? matter + (n > 1 ? " (Run " + n + ")" : "") : "";
    if (!matter) return tail;
    const full = matter + ": " + tail;
    if (full.length <= MAX_CHAT_TITLE) return full;
    // Too long: shorten the MATTER, never the rest. The chat's name is the half
    // that tells this run's conversations apart, and it's the short half — and
    // the run number is the half that tells this run from the one it repeats.
    const room = MAX_CHAT_TITLE - tail.length - 3;
    if (room < 8) return tail.slice(0, MAX_CHAT_TITLE);
    return matter.slice(0, room).trim() + "…: " + tail;
  }

  // The conversation a claude.ai URL is showing, or null. This is what the
  // conversation API — the authority on whether a reply arrived — is asked
  // about, so being too strict here doesn't cause a wrong answer, it causes no
  // answer at all: insisting on a literal /chat/ segment left the authority
  // silently unavailable on every other surface claude.ai serves a conversation
  // from. A /chat/ id still wins where there is one; otherwise the LAST id in
  // the path, since /project/<project-id>/… names the container first and the
  // conversation after it.
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  // The conversation an API call was about, from its URL. claude.ai's completion
  // request names it — /api/organizations/<org>/chat_conversations/<id>/completion
  // — which is the one source that works wherever the conversation is being
  // shown from. In a Project the address bar never holds the conversation's id
  // at all, only the project's, so the path alone leaves the run blind.
  function conversationIdFromApiUrl(url) {
    const m = str(url).match(
      /chat_conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    );
    return m ? m[1] : null;
  }

  // ---- which stream is this conversation's ---------------------------------
  //
  // A turn ending is reported by inject.js when a text/event-stream closes, and
  // claude.ai streams plenty besides the assistant's answer — so the URL is
  // filtered, or an unrelated stream closing releases a step whose reply is
  // still being written.
  //
  // The words below are Chat's and Claude Code's. Cowork's completion address
  // carries none of them, so a Cowork run fell back to watching the text hold
  // still: slower, and a weaker claim than the network's.
  //
  // What a Cowork stream does carry is the session's own id, which is in the
  // page's address too. A stream naming THIS conversation is this
  // conversation's, whatever verb it is spelled with — which is a narrower test
  // than any list of words, not a looser one.
  const COMPLETION_RE = /completion|\/retry|\/messages(\?|$)/i;
  const SESSION_IN_PATH = /\/cowork\/(cse_[A-Za-z0-9_-]+)/;

  function looksLikeCompletionUrl(url, pathname) {
    const u = str(url);
    if (!u) return false;
    if (COMPLETION_RE.test(u)) return true;
    const m = SESSION_IN_PATH.exec(str(pathname));
    return !!m && u.indexOf(m[1]) !== -1;
  }

  function conversationId(href) {
    let path = str(href);
    try {
      path = new URL(path).pathname;
    } catch (e) {
      /* not absolute — treat what we were given as the path */
    }
    const chat = path.match(/\/chat\/([0-9a-f-]{36})/i);
    if (chat) return chat[1];
    // A Cowork session's id is not a uuid (cse_011f5HCzaWWJ2hm19v6NuQmN), so
    // the uuid sweep below would walk straight past it and report no
    // conversation at all — which reads to a run as "the send never landed".
    const cowork = path.match(/\/cowork\/(cse_[A-Za-z0-9_-]+)/);
    if (cowork) return cowork[1];
    const all = path.match(new RegExp(UUID_RE.source, "gi"));
    return all && all.length ? all[all.length - 1] : null;
  }

  function conversationKey(href) {
    const s = str(href);
    const m = s.match(UUID_RE);
    if (m) return m[0];
    try {
      return new URL(s).pathname;
    } catch (e) {
      return s;
    }
  }

  // Was this step the ONLY thing happening in Claude while it ran?
  //
  // Measuring a step by the movement of a browser-wide meter is only worth
  // anything when nothing else moved it. Every claude.ai tab records the span of
  // each assistant turn it sees (see the activity ledger in content.js); if any
  // conversation other than this step's own overlapped the step's window, the
  // difference is somebody else's work as much as this step's, and the honest
  // answer is that we don't know.
  //
  // Defaults to false, in every direction: no window, no ledger, a turn still
  // running when we looked — all of them mean "can't say", and can't say must
  // not be recorded as a measurement.
  function soleActor(activity, win) {
    const w = win || {};
    if (typeof w.from !== "number" || typeof w.to !== "number") return false;
    const a = activity && typeof activity === "object" ? activity : null;
    if (!a) return false;
    // This step's own conversation, and the run's other chats: a run takes one
    // step at a time, so its own idle conversations are never the thing that
    // moved the meter, and counting them would make a run contaminate itself.
    const mine = (Array.isArray(w.conv) ? w.conv : [w.conv]).filter(Boolean);
    for (const key of Object.keys(a)) {
      if (mine.indexOf(key) !== -1) continue;
      const t = a[key] || {};
      const start = typeof t.start === "number" ? t.start : null;
      if (start == null) continue;
      // A turn with no end is still going, so it reaches to the end of the
      // window rather than stopping at the moment it began.
      const end = typeof t.end === "number" ? t.end : w.to;
      if (end >= w.from && start <= w.to) return false;
    }
    return true;
  }

  // A run's total, and how much of it was actually measured — a total that
  // quietly skipped three steps would read as a cheap run.
  function runUsage(run) {
    const rows = ((run && run.transcript) || []).filter(Boolean);
    let weekly = 0;
    let session = 0;
    let measured = 0;
    let sessionMeasured = 0;
    for (const t of rows) {
      if (typeof t.usedWeekly === "number") {
        weekly += t.usedWeekly;
        measured++;
      }
      if (typeof t.usedSession === "number") {
        session += t.usedSession;
        sessionMeasured++;
      }
    }
    return {
      steps: rows.length,
      measured: measured,
      weekly: measured ? Math.round(weekly * 100) / 100 : null,
      session: sessionMeasured ? Math.round(session * 100) / 100 : null,
      complete: rows.length > 0 && measured === rows.length,
    };
  }

  // Fold a finished run into its workflow's running average, so a workflow can
  // say what it typically costs before you start another one. Only runs whose
  // every step was measured: a run with three unmeasured steps would drag the
  // average down and there'd be nothing on the face of it to say why.
  function noteRunUsage(wf, run) {
    if (!wf || !run) return wf;
    const u = runUsage(run);
    if (!u.complete || u.weekly == null) return wf;
    const prev = wf.usage && wf.usage.runs > 0 ? wf.usage : { runs: 0, weekly: 0 };
    const runs = prev.runs + 1;
    return Object.assign({}, wf, {
      usage: {
        runs: runs,
        weekly: Math.round(((prev.weekly * prev.runs + u.weekly) / runs) * 100) / 100,
        lastWeekly: u.weekly,
      },
    });
  }

  // Percentage points of a usage window, as they're shown everywhere: two
  // decimals is noise on a figure this approximate, and a bare "0%" for a step
  // that plainly did work would be a lie the format tells.
  function formatPct(n) {
    if (typeof n !== "number" || !isFinite(n)) return "";
    if (n > 0 && n < 0.1) return "<0.1%";
    return (Math.round(n * 10) / 10) + "%";
  }

  function markSending(run, now, usage) {
    // Re-attaching to a step whose message already went out is not the start of
    // that step. Its clock is left exactly as it is, and — more importantly —
    // so is the phase: "awaiting-reply" is the only record that the message has
    // gone, and overwriting it with "sending" would let a worker that died
    // mid-wait come back and post the same message a second time.
    if (run && run.phase === "awaiting-reply")
      return Object.assign({}, run, { status: "running", lastProgressAt: now });
    // Otherwise a step starts its clock when its message starts going out.
    // Re-sending a step that went wrong starts a fresh one: what's being timed
    // is the attempt that produced the reply, not every attempt stacked up.
    return Object.assign({}, startStepClock(run, now), {
      status: "running",
      phase: "sending",
      lastProgressAt: now,
      // The meter as it stood before this step. What it reads when the step
      // lands, less this, is what the step cost.
      stepUsage: usage || null,
    });
  }

  // The step's message is on its way out; from here a retry must NOT re-send it
  // (that would double-post into the conversation) — it re-attaches a waiter.
  function markSent(run, info) {
    const i = info || {};
    const chats = Object.assign({}, run.chats);
    // `opened` marks a conversation THIS RUN opened: the record had no url
    // until the run's own send put one there. A chat the operator pasted in
    // arrives with its url already set, so it can never earn the flag — which
    // is what keeps renaming scoped to conversations the run itself started,
    // even on a resume (see ownsChatName).
    if (i.chatId && i.url) {
      const had = chats[i.chatId] || {};
      chats[i.chatId] = Object.assign({}, had, {
        url: i.url,
        opened: !!(had.opened || !had.url),
      });
    }
    return Object.assign({}, run, {
      status: "running",
      phase: "awaiting-reply",
      chats: chats,
      sentAt: i.now,
      lastProgressAt: i.now,
    });
  }

  /**
   * Whether this run may (re)name this conversation — `saved` being the run's
   * own record for the chat (run.chats[chatId]).
   *
   * No record, or a record with no url, means the run is about to open the
   * conversation itself: the name is the run's to give. A url the run's own
   * send put there (`opened`, from markSent) keeps it the run's — which is
   * what lets a step resumed after a worker restart catch up a rename the
   * send-time pass never made. A url that arrived any other way is a chat the
   * operator pointed the run at, and retitling their work is never the
   * extension's business. Records from before `opened` existed fall on that
   * safe side too: no flag, no rename.
   */
  function ownsChatName(saved) {
    if (!saved || !saved.url) return true;
    return !!saved.opened;
  }

  function heartbeat(run, now) {
    return Object.assign({}, run, { lastProgressAt: now });
  }

  // Remember which window this run's chats live in. Null when the window has
  // gone (the operator closed it) — the next step opens a fresh one rather than
  // scattering tabs into whatever window happens to be in front.
  function withWindow(run, windowId) {
    return Object.assign({}, run, {
      windowId: typeof windowId === "number" ? windowId : null,
    });
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
    if (i.chatId) {
      const had = chats[i.chatId] || {};
      chats[i.chatId] = Object.assign({}, had, {
        url: i.url || had.url || null,
        // The same "this run opened it" bookkeeping as markSent, for the path
        // where a step lands without markSent having recorded the url first.
        opened: !!(had.opened || (i.url && !had.url)),
      });
    }
    const next = run.stepIndex + 1;
    const total = typeof i.total === "number" ? i.total : run.totalSteps;
    const reply = str(i.reply);
    const done = next >= total;
    const timing = stepTiming(run, i.now);
    // A step that shared the browser with other Claude work isn't measurable —
    // see soleActor. Recorded as a refusal, not as a zero.
    const shared = i.usageClean === false;
    const cost = shared ? { session: null, weekly: null } : usageCost(run.stepUsage, i.usage);
    return Object.assign({}, clearStepClock(run), {
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
          // How long it took, split into getting the message out and waiting for
          // the answer. Nulls where the run can't honestly say (a step it was
          // told had already been sent has no start of its own).
          ms: timing.ms,
          sendMs: timing.sendMs,
          replyMs: timing.replyMs,
          stoppedMs: timing.stoppedMs,
          startedAt: timing.startedAt,
          sentAt: timing.sentAt,
          // And what your usage did while it ran, in percentage points of each
          // window. Null where a window reset in the middle and the difference
          // stopped meaning anything.
          usedWeekly: cost.weekly,
          usedSession: cost.session,
          // Why it's blank, when it is: other Claude chats were busy at the same
          // time, so the meter's movement isn't this step's to claim.
          usageShared: shared,
        },
      ]),
      lastProgressAt: i.now,
      sentAt: null,
      finishedAt: done ? i.now : null,
      error: null,
    });
  }

  // A whole wave finished: every member has answered, so their replies are
  // folded into one hand-off and the run moves past all of them at once.
  //
  // The worker does this, not the pages — three tabs each rewriting the same run
  // record would lose whichever write landed second, and losing one is losing a
  // reply that cost a full turn to produce. Each member reports back and this
  // writes once.
  function applyWaveResult(run, info) {
    const i = info || {};
    if (!run) return run;
    const members = (i.members || []).filter(Boolean);
    if (!members.length) return run;
    const chats = Object.assign({}, run.chats);
    for (const m of members)
      if (m.chatId) {
        const had = chats[m.chatId] || {};
        chats[m.chatId] = Object.assign({}, had, {
          url: m.url || had.url || null,
          opened: !!(had.opened || (m.url && !had.url)),
        });
      }

    const next = members[members.length - 1].stepIndex + 1;
    const total = typeof i.total === "number" ? i.total : run.totalSteps;
    const done = next >= total;
    const timing = stepTiming(run, i.now);
    const shared = i.usageClean === false;
    const cost = shared ? { session: null, weekly: null } : usageCost(run.stepUsage, i.usage);

    return Object.assign({}, clearStepClock(run), {
      status: done ? "done" : "running",
      phase: "idle",
      stepIndex: next,
      // All of them, labelled, as one piece of text. Which is the whole point:
      // the step after a wave is there to read the answers against each other.
      lastReply: foldWave(members.map((m) => ({ label: m.label, text: m.reply }))),
      chats: chats,
      transcript: (run.transcript || []).concat(
        members.map((m, at) => ({
          stepIndex: m.stepIndex,
          chatId: m.chatId || null,
          chatName: m.chatName || null,
          at: i.now,
          chars: str(m.reply).length,
          docs: typeof m.docs === "number" ? m.docs : 0,
          // Each member's own time, measured by the worker while it waited on
          // all of them. The wave's elapsed time is the LONGEST of these, not
          // their sum — which is the entire reason for running them at once, so
          // adding them up would report the saving as a cost.
          ms: typeof m.ms === "number" ? m.ms : null,
          sendMs: typeof m.sendMs === "number" ? m.sendMs : null,
          replyMs: typeof m.replyMs === "number" ? m.replyMs : null,
          stoppedMs: at === 0 ? timing.stoppedMs : 0,
          startedAt: typeof m.startedAt === "number" ? m.startedAt : null,
          sentAt: typeof m.sentAt === "number" ? m.sentAt : null,
          parallel: true,
          // Usage belongs to the wave, not to any one member: three chats
          // answering at once move one meter, and there is no honest way to
          // split that. It is recorded once, against the first member, and the
          // others say why they're blank.
          usedWeekly: at === 0 ? cost.weekly : null,
          usedSession: at === 0 ? cost.session : null,
          usageShared: at === 0 ? shared : true,
          usageWave: at === 0 && members.length > 1,
        }))
      ),
      lastProgressAt: i.now,
      sentAt: null,
      finishedAt: done ? i.now : null,
      error: null,
    });
  }

  // Stopping keeps `phase` and `sentAt` deliberately. A step that failed AFTER
  // its message went out (the reply never came back, the tab went quiet) must
  // not be resumed by posting the same message again — the conversation would
  // carry it twice. The phase is the only record that it already went out.
  function markError(run, message, now) {
    // The clock stops here too. A step that failed at midnight and was fixed the
    // next morning spent the night stopped, not working.
    return Object.assign({}, stopStepClock(run, now), {
      status: "error",
      error: str(message) || "unknown error",
      lastProgressAt: now,
      finishedAt: now,
    });
  }

  // What resuming this run would do, in the words a person needs to decide:
  // which step, and whether that step's message still has to be sent.
  function resumePlan(run) {
    const sent = !!run && run.phase === "awaiting-reply";
    return {
      stepIndex: run ? run.stepIndex : 0,
      alreadySent: sent,
      action: sent ? "read Claude's reply to the message already sent" : "send this step's message",
    };
  }

  // "Re-read the previous chat's reply" and "this step's message already went
  // out" describe states that cannot both be true. If the message has gone,
  // whatever it was going to carry is already in it, and re-reading would only
  // compose a message nobody is going to send. So the two behave like radio
  // buttons: ticking one clears the other. `changed` names the box the operator
  // just touched, so their click is the one that wins; with nothing named — the
  // panel's own opening defaults — "already sent" wins, because that is an
  // observation about the chat rather than a preference about it.
  function exclusiveFix(draft, changed) {
    const d = draft || {};
    const refetchCarry = !!d.refetchCarry;
    const sent = !!d.sent;
    if (!(refetchCarry && sent)) return { refetchCarry: refetchCarry, sent: sent };
    if (changed === "refetch") return { refetchCarry: true, sent: false };
    return { refetchCarry: false, sent: true };
  }

  // Fix a partial run and point it at where to carry on. Everything here is
  // something only the operator can know: which step to pick up from, whether
  // the message for it is already sitting in the chat, what text should travel
  // into it, and which conversation each chat actually ended up in.
  function reviseRun(run, patch, now) {
    if (!run) return run;
    const p = patch || {};
    const total = run.totalSteps || 0;
    let stepIndex = typeof p.stepIndex === "number" ? Math.floor(p.stepIndex) : run.stepIndex;
    if (!(stepIndex >= 0)) stepIndex = 0;
    if (total > 0 && stepIndex > total - 1) stepIndex = total - 1;
    // Restarting inside a wave restarts the wave. Its members all take the same
    // hand-off and run together; beginning at the second of them would leave the
    // step that follows waiting for a reply nothing was going to produce.
    const startedWave = waveOf((runSource(run, null) || {}).steps || [], stepIndex);
    if (startedWave) stepIndex = startedWave.members[0];
    const phase = p.phase === "awaiting-reply" ? "awaiting-reply" : "idle";

    const chats = Object.assign({}, run.chats);
    if (p.chats && typeof p.chats === "object") {
      for (const id of Object.keys(p.chats)) {
        const url = trimmed(p.chats[id] && p.chats[id].url);
        if (url) chats[id] = Object.assign({}, chats[id] || {}, { url: url });
        else if (chats[id]) chats[id] = Object.assign({}, chats[id], { url: null });
      }
    }

    // Picking the run back up restarts the clock where it stopped: the pause
    // itself is charged to stopped time, not to the step. A step being redone
    // from the top gets a fresh clock from markSending a moment later anyway.
    return Object.assign({}, resumeStepClock(run, now), {
      status: "running",
      phase: phase,
      stepIndex: stepIndex,
      lastReply: typeof p.lastReply === "string" ? p.lastReply : run.lastReply,
      chats: chats,
      // Steps from the resume point on have not happened (again) yet, so their
      // history would misreport what this run did.
      transcript: (run.transcript || []).filter((t) => t && t.stepIndex < stepIndex),
      // Only meaningful while we're waiting on a message that already went out.
      sentAt: phase === "awaiting-reply" ? (typeof run.sentAt === "number" ? run.sentAt : now) : null,
      error: null,
      finishedAt: null,
      lastProgressAt: now,
      heldSince: null,
      holdReason: null,
    });
  }

  function markHeld(run, reason, now) {
    return Object.assign({}, stopStepClock(run, now), {
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
    const src = runSource(run, wf);
    const total = run.totalSteps || src.steps.length;
    // "2A" rather than "2" wherever a wave is involved, since that is what the
    // editor and the Steps list call it.
    const labels = stepLabels(src.steps || []);
    const at = labels[run.stepIndex] || String(run.stepIndex + 1);
    if (run.status === "done") return "Finished all " + total + " steps";
    if (run.status === "canceled") return "Canceled at step " + at;
    if (run.status === "paused")
      return (
        "Paused before step " + at + " of " + total +
        // A pause the workflow asked for, with a time on it, is a different
        // thing from one waiting on you — and the row is where you find out
        // which without opening anything.
        (run.pausedByStep && typeof run.resumeAt === "number" && run.resumeAt > Date.now()
          ? " · carries on by itself in " + formatMs(run.resumeAt - Date.now())
          : "")
      );
    if (run.status === "error") return "Failed at step " + at + " of " + total;
    if (run.status === "draft") {
      // Asking for the papers is only useful while there aren't any. A run set
      // up with its exhibits already on it, still being told to add them, reads
      // as though they hadn't arrived.
      const docs = (run.docs || []).length;
      return (
        "Not started · " + total + " step" + (total === 1 ? "" : "s") + " · " +
        (docs
          ? docs + " document" + (docs === 1 ? "" : "s") + " ready — start it when you are"
          : "add this matter's papers, then start it")
      );
    }
    if (run.status === "pending") return "Queued · " + total + " steps";
    const plan = planRun(src);
    const step = plan[run.stepIndex];
    const verb = run.phase === "awaiting-reply" ? "waiting for Claude" : "sending";
    if (step && step.parallel) {
      // A wave is one thing happening, in several chats at once — reporting it
      // as "step 2A" would suggest the other two are still to come.
      const names = step.wave.map((i) => plan[i].chatName).join(", ");
      return (
        "Steps " +
        step.wave.map((i) => plan[i].label).join("/") +
        " of " + total + " · " + names + " — " + verb + ", together"
      );
    }
    const where = step ? " · " + step.chatName : "";
    return "Step " + at + " of " + total + where + " — " + verb;
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

  /**
   * The newest assistant text out of a COWORK session payload
   * (GET /api/organizations/{org}/conversations/cse_{id}).
   *
   * Until now the runner refused to ask this endpoint at all — its shape had
   * never been seen to answer with messages, and an authority verdict from a
   * non-authority is worse than silence. A live step then showed the cost:
   * the reply finished an hour before the timeout, the DOM never showed it,
   * and every other signal is dead on Cowork (no stream events, no readable
   * page state). So now the session IS asked, and read defensively: the chat
   * shape first (the collections may simply agree), then the arrays a session
   * payload plausibly keeps its turns in — top-level or one level down — each
   * entry read with the same message reader as chat, and only entries that
   * NAME an assistant sender are taken (an unattributed entry could as easily
   * be the prompt, and handing the prompt on as the reply is the failure this
   * whole pipeline exists to prevent). When nothing parses, the caller
   * reports the payload's SHAPE (payloadShape) so the real one can be wired
   * in from a single paste instead of another lost run.
   */
  function coworkReplyText(conv) {
    if (!conv || typeof conv !== "object") return "";
    const fromChat = lastAssistantText(conv);
    if (fromChat) return fromChat;
    const roots = [conv, conv.session, conv.conversation, conv.chat, conv.data].filter(
      (o) => o && typeof o === "object"
    );
    for (const root of roots) {
      for (const key of ["chat_messages", "messages", "events", "turns", "entries"]) {
        const arr = Array.isArray(root[key]) ? root[key] : null;
        if (!arr) continue;
        for (let i = arr.length - 1; i >= 0; i--) {
          const m = arr[i];
          if (!m || typeof m !== "object") continue;
          const sender = str(m.sender || m.role || m.author).toLowerCase();
          if (sender !== "assistant") continue;
          const text = messageText(m);
          if (text) return text;
        }
      }
    }
    return "";
  }

  /**
   * A payload's shape in one reportable line: its top-level keys, and the
   * first object element's keys of the likeliest array. This is what turns
   * "the API can't be read on this surface" into a paste that fixes it.
   */
  function payloadShape(conv) {
    if (!conv || typeof conv !== "object") return "no payload";
    const keys = Object.keys(conv).slice(0, 14);
    let arrBit = "";
    for (const k of keys) {
      const v = conv[k];
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object") {
        arrBit = "; " + k + "[0]: " + Object.keys(v[0]).slice(0, 10).join(",");
        break;
      }
    }
    return "keys: " + keys.join(",") + arrBit;
  }

  // Split a message into the prose Claude wrote and the artifacts it produced.
  // Thinking and tool RESULTS are scratch work and stay out — but an artifact is
  // a tool call whose payload IS the answer, and a report written into one would
  // otherwise be dropped on the floor.
  function messageParts(m) {
    const text = [];
    const artifacts = [];
    if (Array.isArray(m.content)) {
      for (const blk of m.content) {
        if (!blk || typeof blk !== "object") continue;
        const type = str(blk.type);
        if (!type || type === "text") {
          if (typeof blk.text === "string") text.push(blk.text);
          continue;
        }
        if (type === "tool_use" && blk.input && typeof blk.input.content === "string") {
          const body = blk.input.content.trim();
          if (body) artifacts.push(body);
        }
      }
    }
    return { text: text.join("\n").trim() || str(m.text).trim(), artifacts: artifacts };
  }

  function messageText(m) {
    const parts = messageParts(m);
    // Only append an artifact the prose doesn't already contain, so a reply that
    // quotes its own artifact isn't delivered twice.
    const extra = parts.artifacts.filter(
      (a) => !parts.text || parts.text.indexOf(a.slice(0, 80)) === -1
    );
    return [parts.text].concat(extra).filter(Boolean).join("\n\n").trim();
  }

  // claude.ai renders a placeholder where it can't draw a block — which the copy
  // box then dutifully copies. Pasting THAT into the next chat hands Claude
  // three empty shells and asks it to revise them, and the result looks like
  // work. Text that is mostly placeholder is not a reply.
  const UNSUPPORTED_RE = /this block is not supported on your current device(?: yet)?\.?/gi;
  // The same placeholder wrapped in the code fence the copy box puts round it.
  const UNSUPPORTED_FENCE_RE =
    /```[a-z]*[ \t]*\r?\n?[ \t]*this block is not supported on your current device(?: yet)?\.?[ \t]*\r?\n?[ \t]*```/gi;

  function hasUnsupportedBlocks(text) {
    UNSUPPORTED_RE.lastIndex = 0;
    return UNSUPPORTED_RE.test(str(text));
  }

  // Take the placeholders out and keep everything else. A reply is often part
  // prose and part blocks this page couldn't draw — the prose is the answer and
  // should travel; the shells say nothing and must not.
  function stripPlaceholders(text) {
    UNSUPPORTED_FENCE_RE.lastIndex = 0;
    UNSUPPORTED_RE.lastIndex = 0;
    return str(text)
      .replace(UNSUPPORTED_FENCE_RE, "")
      .replace(UNSUPPORTED_RE, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // What's left once the placeholders are taken out — the part that actually
  // says something.
  function usableLength(text) {
    return stripPlaceholders(text).replace(/\s+/g, " ").trim().length;
  }
  function isMostlyPlaceholder(text) {
    if (!hasUnsupportedBlocks(text)) return false;
    return usableLength(text) < 200;
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

  // A control that saves a file rather than copying one, used to keep it out of
  // the running when the copy box is being looked for: a click on the wrong one
  // downloads something AND returns no text. (Finding such a control on purpose
  // is src/autodl.js's job now, for every chat rather than only a run's.)
  //
  // "Download" alone, or leading a filename ("Download ruling.docx"). Not
  // anywhere in a string: a button captioned with a sentence isn't this.
  function isDownloadLabel(text) {
    const s = str(text).replace(/\s+/g, " ").trim().toLowerCase().replace(/[.:]+$/, "");
    if (!s || s.length > 80) return false;
    return s === "save" || s === "download" || /^download\b/.test(s);
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

  // Letters and digits alone — the comparison that survives markdown syntax,
  // punctuation, and the invisible characters claude.ai's markup carries.
  const lettersOf = (v) => str(v).toLowerCase().replace(/[^a-z0-9]+/g, "");

  /**
   * Whether a copy actually carries the END of the reply it claims to be.
   *
   * plausibleCopy guards against a copy that is too SHORT — a code block's own
   * copy button. Cowork's copy control failed the other way: it handed back
   * the turn's TOOL PROMPTS — the agent's scratch work, pages of it, with the
   * actual answer nowhere inside — and a length test waves a long wrong copy
   * straight through. The end is the part that proves it: a faithful copy of a
   * finished reply ends where the reply ends, however its markdown differs
   * from the rendered text. Letters and digits only, so formatting differences
   * can't fail an honest copy; `renderedProse` should come with the reply's
   * controls stripped, since their captions are never in a copy.
   */
  function copyCarriesEnd(copied, renderedProse) {
    const c = lettersOf(copied);
    const r = lettersOf(renderedProse);
    if (!c) return false;
    const tail = r.slice(-80);
    // Nothing rendered at all — every block was one this page couldn't draw.
    // There is no reply text to compare against, so this test has nothing to
    // say and plausibleCopy's length comparison is the guard that stands.
    if (!tail) return true;
    // However LITTLE was rendered, the copy has to carry it. The old floor here
    // — fewer than twenty letters and the copy was believed — is the hole a
    // whole document walked through: a Cowork turn whose answer is a file it
    // just wrote renders a line or two of prose, and the copy control handed
    // back the open file instead of the reply. A run carried the verification
    // report to the next chat as though Claude had said it. A copy that carries
    // none of the reply's own words is not a copy of the reply.
    return c.indexOf(tail) !== -1;
  }

  // The other controls that sit in a reply's action bar. Nothing here is
  // clicked: they are how the RIGHT Copy is told from a stranger. An icon-only
  // Copy is unidentifiable on its own, and the run that made this worth writing
  // copied an open .md file — the file viewer has a Copy too, and the walk
  // outward from the message found it. The reply's own bar has these beside it;
  // a document pane's toolbar has Download and Share and no opinion on whether
  // the answer was any good.
  const REPLY_ACTION_LABELS = [
    "retry",
    "good response",
    "bad response",
    "read aloud",
    "copy",
    "copy message",
    "copy response",
  ];
  function isReplyActionLabel(text) {
    const t = str(text).replace(/\s+/g, " ").trim().toLowerCase().replace(/[.:]+$/, "");
    if (!t || t.length > 40) return false;
    if (REPLY_ACTION_LABELS.indexOf(t) !== -1) return true;
    // The rating controls are captioned both ways in the wild.
    return /^(thumbs\s+(up|down)|(like|dislike) (this )?response|regenerate)$/.test(t);
  }

  // Is what's on screen now a NEW reply, rather than the one that was already
  // there when we sent? Counting rendered assistant turns is not enough on its
  // own: claude.ai's transcript can have only the newest turn in the DOM, so the
  // count sits at 1 however many replies arrive. Either the count growing or the
  // text differing from what was last there means a new answer — and a step that
  // waits on the count alone would hang until it timed out.
  /**
   * Why a conversation read came back with nothing, in the words a run's report
   * can carry. The page-world fetch (src/inject.js) answers with an error and a
   * list of what it tried; both halves matter, and neither used to survive the
   * trip: the runner kept `payload.data || null` and threw the rest away, so
   * every failure — a 403, a 404 on the wrong org, a body that wasn't JSON, a
   * network error, a round trip that never came back — reached the user as the
   * single sentence "asked and didn't answer". The live step that made this
   * worth fixing waited out two hours on a Cowork session whose reply had
   * landed an hour before, with nothing in the report to say which of those
   * five it was.
   */
  function conversationFetchWhy(payload) {
    const p = payload || {};
    const parts = [];
    const err = str(p.error).trim();
    if (err) parts.push(err);
    const tried = Array.isArray(p.tried) ? p.tried.map(str).filter(Boolean) : [];
    // Four is enough to see a pattern; an account in a dozen orgs would
    // otherwise bury the error under its own address book.
    if (tried.length)
      parts.push(
        "tried " + tried.slice(0, 4).join("; ") +
          (tried.length > 4 ? " (+" + (tried.length - 4) + " more)" : "")
      );
    return parts.join(" — ") || "no reason given";
  }

  function isNewReply(sample) {
    const s = sample || {};
    const text = trimmed(s.text);
    if (!text) return false;
    if ((s.count || 0) > (s.beforeCount == null ? 0 : s.beforeCount)) return true;
    return text !== trimmed(s.beforeText);
  }

  // claude.ai's notice that a reply was cut off part-way. Whatever caused it,
  // the answer on screen is a fragment — handing it to the next chat means the
  // rest of the run builds on half a ruling, convincingly.
  const INTERRUPTED_RE = /(claude['’`]?s\s+)?response\s+was\s+interrupted/i;
  function looksInterrupted(text) {
    return INTERRUPTED_RE.test(str(text).replace(/\s+/g, " "));
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
    // The page's mid-turn furniture, holding still while a skill runs. Stillness
    // is the whole argument in every branch below, and here it is an argument
    // about a caption rather than about an answer — so there is nothing to
    // settle on, however long it sits there.
    if (isToolChatter(s.text)) return null;
    const unchanged = s.unchangedMs || 0;

    // The response stream for THIS message closed. Authoritative, and
    // deliberately outranks the DOM: if a Stop control is still on screen after
    // the stream ended, the DOM is wrong, and waiting on it hangs the run.
    if (s.streamDone)
      return unchanged >= (typeof s.minSettleMs === "number" ? s.minSettleMs : 1200)
        ? "stream"
        : null;

    if (s.generating) {
      // The page says Claude is still going. If a response stream is open, that
      // isn't a guess — it IS still going, and text standing still means a tool
      // call or a long search, not a finished answer. Wait for the stream to
      // close; it will, and then we'll know.
      if (s.streamOpen) return null;
      // With no stream to consult, believe the page up to a point: a reply that
      // hasn't changed in a long while is finished whatever a lingering Stop
      // control claims. Long, because research pauses are long — a skill that
      // verifies authority by live retrieval can sit silent for many minutes —
      // and being early here means handing on half an answer.
      //
      // Longer still where the network says nothing. This ceiling exists to
      // stop a run hanging on a Stop control that never goes away, and it is
      // the LAST thing holding a Cowork turn: everything above it is either
      // absent there or already spent. A tool call that takes twenty minutes is
      // a slow tool call, not a stuck page, and the surface that runs tools
      // between sentences is exactly the one where that happens.
      const stalled = typeof s.stalledMs === "number" ? s.stalledMs : 900000;
      const ceiling = s.noNetworkSignal ? Math.max(stalled, 1800000) : stalled;
      return unchanged >= ceiling ? "stalled" : null;
    }

    // Nothing has been watched to arrive. Text that was ALREADY THERE when the
    // wait began and never moved is not a finished answer — it is the previous
    // answer, sitting where it always was. Without this, a step re-run in a
    // chat that already holds replies settles on the old one within seconds,
    // and the run walks through the rest of itself taking each stale reply in
    // turn. `streamDone` above is the other, better, way to know; this branch
    // is what happens when there is no stream to consult.
    if (s.watched === false) return null;

    // Stillness is ALL there is on a surface that shows the page no network
    // signal, and six seconds of it is not much of an argument there.
    //
    // In Chat the open stream carries this: text standing still during a tool
    // call is provably not a finished answer, because the stream says the turn
    // is still running. Cowork opens no stream, so that proof is gone — and
    // Cowork is the surface that runs tools constantly and, on Manually
    // approve, is SUPPOSED to sit still indefinitely waiting to be let on.
    //
    // So where nothing about the network is knowable, the text has to hold
    // still for a good deal longer before it counts as an answer. The cost is
    // seconds on a step that takes minutes. The cost of being wrong is half an
    // answer handed to the next chat as though it were whole.
    const stableMs =
      typeof s.minStableMs === "number" ? s.minStableMs : 6000;
    const stablePolls =
      typeof s.minStablePolls === "number" ? s.minStablePolls : 3;
    const blind = !!s.noNetworkSignal;
    return unchanged >= (blind ? Math.max(stableMs, 30000) : stableMs) &&
      (s.stablePolls || 0) >= (blind ? Math.max(stablePolls, 12) : stablePolls)
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

  /**
   * Which run the in-conversation console shows, from candidates
   * [{ run, matched, driving }] — `matched` meaning this conversation is one
   * of the run's chats, `driving` meaning this tab is publishing a step for
   * it. A LIVE run wins: matched first, then driving. But a FINISHED run
   * keeps its console too — Edit run, Save as workflow, Steps and
   * Fix & continue all outlive the run (the owner's rule), and skipping
   * done/canceled outright left the tray's Run button visible and its click
   * doing nothing at all. Among finished runs the newest wins: a
   * conversation is re-used by later runs of the same workflow, and the one
   * on screen is the latest.
   */
  function consoleRun(cands) {
    const list = (cands || []).filter((c) => c && c.run);
    const ended = (r) => r.status === "done" || r.status === "canceled";
    for (const c of list) if (!ended(c.run) && c.matched) return c.run;
    for (const c of list) if (!ended(c.run) && c.driving) return c.run;
    let done = null;
    const at = (r) => r.startedAt || r.createdAt || 0;
    for (const c of list)
      if (ended(c.run) && c.matched && (!done || at(c.run) > at(done))) done = c.run;
    return done;
  }

  /**
   * Whether the run console should repaint this tick. The console holds
   * forms (Fix & continue, Edit run), and a redraw mid-typing eats the
   * keystrokes — so while a form is open, only a change to the run's own
   * core may repaint. But the operator's OWN clicks on the console (opening
   * a form, picking a step, adding a row) must always paint: `asked` is that
   * signal, and it wins outright. Without it the anti-repaint guard blocks
   * the form's own first paint — the button appears to do nothing.
   *
   * s: { asked, key, lastKey, core, lastCore, formOpen } → boolean.
   */
  function consoleRedraw(s) {
    const o = s || {};
    if (o.asked) return true;
    if (o.key === o.lastKey) return false;
    if (o.formOpen && o.core === o.lastCore) return false;
    return true;
  }

  const api = {
    distinctPseudoKeys,
    rekeyPlan,
    groupLabel,
    tabGroupTitle,
    tabGroupColor,
    parseRunDate,
    isoRunDate,
    runDateLabel,
    composeRunName,
    runBaseName,
    splitRunName,
    sortRuns,
    groupOf,
    assignGroup,
    ungroupRuns,
    pruneGroups,
    runPseudoKey,
    docBarred,
    allowedDocs,
    WORKFLOWS_KEY,
    RUNS_KEY,
    RUN_IDS_KEY,
    RUN_PREFIX,
    BEAT_PREFIX,
    runKey,
    beatKey,
    memberKey,
    MAX_CHATS,
    STEP_TIMEOUT_MS,
    STALE_MS,
    defaultChatName,
    newChatSlot,
    looksLikeChatUrl,
    stepMarker,
    migrateSettings,
    migrateRunSettings,
    SETTINGS_VERSION,
    hasMarker,
    rulingReady,
    isToolChatter,
    nudgeReady,
    continuePrompt,
    RULING_QUIET_MS,
    NUDGE_QUIET_MS,
    DEFAULT_OUTPUT_MARKER,
    startChats,
    seedPlan,
    getChat,
    chatName,
    newStep,
    isPauseStep,
    pauseMinutes,
    PAUSE_MAX_MINUTES,
    newDoc,
    docsForChat,
    newWorkflow,
    reorderSteps,
    pastedDocName,
    promptPool,
    promptSuggestions,
    normalize,
    setChatCount,
    cloneWorkflow,
    upsertWorkflow,
    removeWorkflow,
    getWorkflow,
    fileIdsInUse,
    resetToTemplate,
    runFileIds,
    allDocs,
    isTextDoc,
    bundleText,
    bundlePlan,
    foldBundle,
    validate,
    summarize,
    uploadPlan,
    totalUploads,
    uploadSummary,
    planRun,
    carrySource,
    composeStepText,
    newRun,
    upsertRun,
    removeRun,
    getRun,
    isRunActive,
    dueRuns,
    pendingResetRuns,
    heldRuns,
    runHalted,
    stepModel,
    ignoresOutage,
    usageWaitingRuns,
    nextUsageResume,
    pickupRuns,
    isStale,
    nextRunTrigger,
    markStarted,
    markSending,
    stepTiming,
    timingSummary,
    runTiming,
    runDirectory,
    runHasConversation,
    formatMs,
    usageExhausted,
    usageBackAt,
    usageReadingCurrent,
    usageBlocked,
    USAGE_STALE_MS,
    usageSample,
    usageCost,
    conversationKey,
    conversationId,
    looksLikeCompletionUrl,
    conversationIdFromApiUrl,
    chatTitle,
    titleNames,
    runStamp,
    soleActor,
    runUsage,
    noteRunUsage,
    formatPct,
    markSent,
    ownsChatName,
    heartbeat,
    withWindow,
    applyStepResult,
    applyWaveResult,
    stepWaves,
    stepLabels,
    waveOf,
    foldWave,
    markError,
    resumePlan,
    exclusiveFix,
    reviseRun,
    runSource,
    canRetrigger,
    editorTriggerType,
    startWarning,
    retrigger,
    isDraft,
    canRerun,
    runNumber,
    rerunDefaults,
    rerunSettings,
    rerunOf,
    rerunName,
    rerunCarries,
    started,
    runLabel,
    workflowFromRun,
    markPaused,
    markPausedForUsage,
    markPausedForStep,
    clockWaitingRuns,
    nextClockResume,
    holdPaused,
    applyRunEdit,
    markHeld,
    markCanceled,
    progressText,
    lastAssistantText,
    coworkReplyText,
    payloadShape,
    messageParts,
    hasUnsupportedBlocks,
    isMostlyPlaceholder,
    stripPlaceholders,
    looksInterrupted,
    usableLength,
    isCopyLabel,
    COPY_LABELS,
    isDownloadLabel,
    plausibleCopy,
    copyCarriesEnd,
    isReplyActionLabel,
    isNewReply,
    conversationFetchWhy,
    settleReason,
    turnSettled,
    consoleRun,
    consoleRedraw,
    builtinWorkflow,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMWorkflow = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
