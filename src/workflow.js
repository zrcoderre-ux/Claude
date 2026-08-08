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
      // This chat is expected to produce a finished ruling, and a reply that
      // isn't one must not be handed on. Claude's first answer is often a
      // clarifying question, a note that a paper is missing, or a prompt to
      // continue — all perfectly good replies, and none of them the thing the
      // next chat is being asked to attack.
      expectsRuling: !!f.expectsRuling,
      outputMarker: trimmed(f.outputMarker) || null,
    };
  }

  // The phrase a chat's output must contain before it can travel. Only the
  // real thing carries it, which makes it a cheap and honest test.
  const DEFAULT_OUTPUT_MARKER = "NATURE OF PROCEEDINGS";
  function chatMarker(chat) {
    if (!chat || !chat.expectsRuling) return null;
    return trimmed(chat.outputMarker) || DEFAULT_OUTPUT_MARKER;
  }
  function hasMarker(text, marker) {
    const m = trimmed(marker).replace(/\s+/g, " ").toLowerCase();
    if (!m) return true;
    return str(text).replace(/\s+/g, " ").toLowerCase().indexOf(m) !== -1;
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
    };
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
    return ((wf && wf.docs) || []).concat(extra || []);
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

  function bundleText(parts) {
    const list = (parts || []).filter((p) => p && trimmed(p.text));
    if (!list.length) return "";
    const head =
      "This file contains " + list.length + " documents, one after another. " +
      "They are, in order: " + list.map((p) => trimmed(p.name) || "untitled").join(", ") + ".";
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
    return i === 0 || !!(list[i - 1] && list[i - 1].chatId === list[i].chatId);
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
      // partly there.
      bundleText: !!f.bundleText,
      chats: (f.chats || []).map((c, i) => newChatSlot(c, c && c.id, i)),
      docs: (f.docs || []).map((d) => newDoc(d, d && d.id)),
      steps: (f.steps || []).map((s) => newStep(s, s && s.id)),
      // What its runs have cost, averaged over them — measured, not authored,
      // so it survives an edit rather than being reset by one.
      usage: f.usage && f.usage.runs > 0 ? f.usage : null,
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
      Object.assign({}, s, {
        // A step whose chat was deleted moves to the last remaining chat rather
        // than being thrown away — its prompt is the expensive part.
        chatId: ids.has(s.chatId) ? s.chatId : fallback,
      })
    );
    wf.steps = placed.map((s, i) =>
      Object.assign({}, s, {
        // Nothing to carry into the first step, and nothing to carry between
        // two steps in the SAME chat: that conversation already has it, and
        // pasting it back in wastes the context it's already holding.
        carry:
          i === 0 || (placed[i - 1] && placed[i - 1].chatId === s.chatId)
            ? false
            : s.carry !== false,
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

    const seen = new Set();
    // What model each chat is currently on, so a step only has to switch when
    // it actually wants something different — and so a step that DOES switch
    // leaves the chat on that model for the steps after it, exactly as it would
    // if you had picked it yourself.
    const on = new Map();
    return steps.map((s, i) => {
      const firstInChat = !seen.has(s.chatId);
      seen.add(s.chatId);
      const chat = getChat(wf, s.chatId) || {};
      const model = trimmed(s.model) || (firstInChat ? trimmed(chat.model) : null) || null;
      const was = on.get(s.chatId) || null;
      if (model) on.set(s.chatId, model);
      // Does this step's reply get pasted into another chat? Only then is it
      // worth insisting on what the reply must be — a step whose answer stays
      // where it is can say anything it likes.
      const next = steps[i + 1];
      const handsOn = !!(next && next.carry !== false && next.chatId !== s.chatId);
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
        chatId: s.chatId,
        chatName: chatName(wf, s.chatId),
        prompt: str(s.prompt),
        carry: i > 0 && s.carry !== false,
        carryLabel: trimmed(s.carryLabel) || "material from the previous step",
        firstInChat: firstInChat,
        // The model to pick before sending. Null when the chat is already on the
        // right one — switching to the model you're on is a menu opened for
        // nothing, and one more thing to go wrong.
        model: model && model !== was ? model : null,
        // What it will answer on either way, for the surfaces that report it.
        modelOn: model || was || null,
        // A step that deliberately differs from its chat's own setting.
        modelOverride: !!trimmed(s.model),
        docIds: opening.concat(added),
        handsOn: handsOn,
        // The phrase this step's reply must contain before it can be handed on.
        marker: handsOn ? chatMarker(getChat(wf, s.chatId)) : null,
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
    if (!step || !step.carry || stepIndex <= 0)
      return { needed: false, chatId: null, chatName: null, label: null };
    const prev = plan[stepIndex - 1];
    return {
      needed: true,
      chatId: prev.chatId,
      chatName: prev.chatName,
      label: step.carryLabel,
      fromStep: stepIndex - 1,
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
      name: wf && trimmed(wf.name) !== trimmed(wf.templateName) ? wf.name : "",
      // Where it came from, kept whatever later happens to the template: renamed
      // for another matter, rewritten, or deleted outright. A run always knows
      // which workflow it is a run OF.
      templateName: wf ? trimmed(wf.templateName) || trimmed(wf.name) : "",
      // This matter's papers, handed over at Start so the template can be
      // cleared and re-armed while this run is still going.
      docs: (docs || (wf && wf.docs) || []).map((d) => newDoc(d, d && d.id)),
      bundleText: !!(wf && wf.bundleText),
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

  // What a run is actually executing: its own snapshot if it has one, otherwise
  // the workflow (runs created before runs carried their own). Everything that
  // walks a run's steps goes through here, so a run edited mid-flight and a
  // template edited behind it can't be confused for each other.
  function runSource(run, wf) {
    const plan = run && run.plan;
    if (plan && Array.isArray(plan.steps) && plan.steps.length)
      return { chats: plan.chats || [], steps: plan.steps, docs: (run && run.docs) || [] };
    return {
      chats: (wf && wf.chats) || [],
      steps: (wf && wf.steps) || [],
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
  function markPaused(run, now) {
    return Object.assign({}, stopStepClock(run, now), { status: "paused", lastProgressAt: now });
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
      docs: (Array.isArray(p.docs) ? p.docs : src.docs).map((d) => {
        const doc = newDoc(d, d && d.id);
        // Stamped with where the run has reached, so it rides the next step in
        // each of its chats rather than an opening message that may already have
        // gone. On a run that hasn't started this is step 0, which is that
        // chat's opening message — the same place it would have gone anyway.
        if (!prior.has(doc.id) && typeof doc.addedAt !== "number") doc.addedAt = run.stepIndex;
        return doc;
      }),
    });
    return Object.assign({}, run, {
      name: trimmed(p.name) || run.name,
      plan: { chats: shaped.chats, steps: shaped.steps },
      docs: shaped.docs,
      totalSteps: shaped.steps.length,
      lastProgressAt: now,
      updatedAt: now,
    });
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
  function pickupRuns(runs, now, staleMs, beats) {
    const beat = (id) => (beats && typeof beats[id] === "number" ? beats[id] : 0);
    return (runs || []).filter(
      (r) =>
        r &&
        r.status === "running" &&
        (r.phase === "idle" || !r.phase || isStale(r, now, staleMs, beat(r.id)))
    );
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
  function conversationKey(href) {
    const s = str(href);
    const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
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
    if (i.chatId) chats[i.chatId] = Object.assign({}, chats[i.chatId], { url: i.url || (chats[i.chatId] || {}).url || null });
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
    if (run.status === "done") return "Finished all " + total + " steps";
    if (run.status === "canceled") return "Canceled at step " + (run.stepIndex + 1);
    if (run.status === "paused") return "Paused before step " + (run.stepIndex + 1) + " of " + total;
    if (run.status === "error") return "Failed at step " + (run.stepIndex + 1) + " of " + total;
    if (run.status === "draft")
      return "Not started · " + total + " step" + (total === 1 ? "" : "s") +
        " · add this matter's papers, then start it";
    if (run.status === "pending") return "Queued · " + total + " steps";
    const plan = planRun(src);
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
      const stalled = typeof s.stalledMs === "number" ? s.stalledMs : 900000;
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
    RUN_IDS_KEY,
    RUN_PREFIX,
    BEAT_PREFIX,
    runKey,
    beatKey,
    MAX_CHATS,
    STEP_TIMEOUT_MS,
    STALE_MS,
    defaultChatName,
    newChatSlot,
    looksLikeChatUrl,
    chatMarker,
    hasMarker,
    DEFAULT_OUTPUT_MARKER,
    startChats,
    seedPlan,
    getChat,
    chatName,
    newStep,
    newDoc,
    docsForChat,
    newWorkflow,
    reorderSteps,
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
    pickupRuns,
    isStale,
    nextRunTrigger,
    markStarted,
    markSending,
    stepTiming,
    timingSummary,
    formatMs,
    usageSample,
    usageCost,
    conversationKey,
    soleActor,
    runUsage,
    noteRunUsage,
    formatPct,
    markSent,
    heartbeat,
    withWindow,
    applyStepResult,
    markError,
    resumePlan,
    exclusiveFix,
    reviseRun,
    runSource,
    canRetrigger,
    retrigger,
    isDraft,
    started,
    runLabel,
    workflowFromRun,
    markPaused,
    applyRunEdit,
    markHeld,
    markCanceled,
    progressText,
    lastAssistantText,
    messageParts,
    hasUnsupportedBlocks,
    isMostlyPlaceholder,
    stripPlaceholders,
    looksInterrupted,
    usableLength,
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
