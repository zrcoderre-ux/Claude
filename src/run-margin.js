/**
 * Claude Usage Meter — the run console in the chat's left margin (ISOLATED
 * world content script).
 *
 * The owner's spec: the ENTIRE run controllable from inside a chat, without
 * the Options page. When the conversation you're looking at belongs to an
 * active run — or this tab is driving one — a console sits in the left
 * margin: under claude.ai's left sidebar panel when it is open, where that
 * panel would go when it is closed, about 1.75× the panel's width (the
 * geometry is src/panelbar.js's marginPlace, pure and tested).
 *
 * The controls are the Options page's own, speaking the same messages the
 * Options page speaks — Steps, Pause, Resume, Stay paused, Go anyway,
 * Fix & continue (the full form: pick the step, re-read the carry, mark the
 * message as already sent, repair chat links), Cancel, Open chats, and Save
 * as workflow. Edit run is the one control that still opens Options: it is a
 * full authoring form, and a cut-down copy that silently lacked half of it
 * would be worse than the trip.
 */
(function () {
  "use strict";

  const W = window.CUMWorkflow;
  const J = window.CUMJobs;
  const P = window.CUMPanelBar;
  if (!W || !J || !P) return;

  const ID = "cum-runmargin";
  const OPEN_KEY = "cum_runmargin_open";
  const STICKY_KEY = "cum_runmargin_sticky"; // the popup's checkbox
  const GEO_KEY = "cum_runmargin_geo"; // { left, top, width, height } when sticky
  const POLL_MS = 2500;
  const WORKFLOWS_KEY = "cum_workflows";

  let el = null;
  let open = true;
  let lastKey = "";
  let showSteps = false;
  let fixDraft = null; // { stepIndex, refetchCarry, sent, chats } while fixing
  let editDraft = null; // { name, steps } while editing the run in place
  let lastCore = "";
  let busyNote = "";
  // Where the operator dragged or resized it to, or null for the default
  // geometry. Sticky (the popup checkbox, off by default) decides whether this
  // survives: off, it lives in memory and a NEW RUN snaps back to default; on,
  // it is stored and every run opens where the last one was left.
  let custom = null;
  let sticky = false;
  let lastRunId = null;
  let applied = { w: 0, h: 0 }; // what position() last set, so a resize we made isn't read as one the operator made

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (e) {
        resolve({});
      }
    });
  }
  function storageSet(obj) {
    try {
      chrome.storage.local.set(obj);
    } catch (e) {
      /* ignore */
    }
  }
  function send(msg, done) {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        if (done) done(res);
      });
    } catch (e) {
      if (done) done(null);
    }
  }

  async function readRuns() {
    const ids = (await storageGet(W.RUN_IDS_KEY))[W.RUN_IDS_KEY] || [];
    if (!ids.length) return [];
    const store = await storageGet(ids.map(W.runKey));
    return ids.map((id) => store[W.runKey(id)]).filter(Boolean);
  }

  // The run this conversation belongs to — the pill's own rules: matched by
  // URL, or published by the tab driving a step, and holding on to a run that
  // has STOPPED here too (paused, errored), since those are exactly the ones
  // the console exists to fix.
  function findRun(runs, href) {
    for (const run of runs) {
      if (!run || run.status === "done" || run.status === "canceled") continue;
      for (const chatId of Object.keys(run.chats || {})) {
        const url = (run.chats[chatId] || {}).url;
        if (!url) continue;
        try {
          if (J.sameConversationUrl(url, href)) return run;
        } catch (e) {
          /* ignore */
        }
      }
    }
    try {
      const at = window.CUMWfStep && window.CUMWfStep.current();
      if (at) {
        const run = runs.find((r) => r && r.id === at.runId);
        if (run && run.status !== "done" && run.status !== "canceled") return run;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // ---- geometry -----------------------------------------------------------
  // claude.ai's left sidebar: a tall element hugging the left edge. Open is a
  // panel (~288 wide); closed is a slim rail or nothing.
  function sidebarRect() {
    let best = null;
    let list;
    try {
      list = document.querySelectorAll('nav, aside, [data-testid*="sidebar" i], [class*="sidebar" i]');
    } catch (e) {
      return null;
    }
    for (const s of list) {
      if (s.closest && s.closest("#" + ID)) continue;
      let r;
      try {
        r = s.getBoundingClientRect();
      } catch (e) {
        continue;
      }
      if (r.left > 40 || r.width < 40 || r.width > 420) continue;
      if (r.height < window.innerHeight * 0.3) continue;
      if (!best || r.width > best.width)
        best = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    }
    return best;
  }

  function position() {
    if (!el || el.hidden) return;
    if (custom) {
      // The operator's own spot, clamped on screen — a window that shrank must
      // not leave the console somewhere unreachable.
      const left = Math.min(Math.max(0, custom.left), Math.max(0, window.innerWidth - 120));
      const top = Math.min(Math.max(0, custom.top), Math.max(0, window.innerHeight - 80));
      el.style.left = left + "px";
      el.style.top = top + "px";
      if (custom.width) el.style.width = custom.width + "px";
      if (custom.height) el.style.height = custom.height + "px";
      el.style.maxHeight = Math.max(160, window.innerHeight - top - 12) + "px";
      applied = { w: el.offsetWidth, h: el.offsetHeight };
      return;
    }
    const at = P.marginPlace({ w: window.innerWidth, h: window.innerHeight }, sidebarRect());
    el.style.left = at.left + "px";
    el.style.top = at.top + "px";
    el.style.width = at.width + "px";
    el.style.height = "";
    el.style.maxHeight = Math.max(200, window.innerHeight - at.top - 16) + "px";
    applied = { w: el.offsetWidth, h: el.offsetHeight };
  }

  function keepGeo() {
    if (sticky && custom) storageSet({ [GEO_KEY]: custom });
  }

  // Dragging by the title bar. Buttons in the bar keep their clicks; a drag
  // under four pixels is a click, not a move.
  function wireDrag(head) {
    if (!head) return;
    let sx = 0, sy = 0, ox = 0, oy = 0, on = false, moved = false;
    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      try {
        if (e.target && e.target.closest && e.target.closest("button")) return;
      } catch (err) {
        /* ignore */
      }
      on = true;
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      try {
        head.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });
    head.addEventListener("pointermove", (e) => {
      if (!on) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      custom = Object.assign({}, custom || { width: el.offsetWidth, height: 0 }, {
        left: Math.round(ox + dx),
        top: Math.round(oy + dy),
      });
      position();
    });
    const end = (e) => {
      if (!on) return;
      on = false;
      if (moved) keepGeo();
      try {
        head.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  }

  // ---- rendering ----------------------------------------------------------
  const STATUS_LABEL = {
    pending: "Waiting to start",
    waiting: "Held",
    running: "Running",
    paused: "Paused",
    error: "Stopped",
    draft: "Draft",
  };

  function whenText(run) {
    const bits = [];
    if (run.startedAt || run.createdAt) {
      const t0 = run.startedAt || run.createdAt;
      bits.push("Started " + new Date(t0).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
      const end = run.finishedAt || Date.now();
      bits.push((run.finishedAt ? "finished " + new Date(run.finishedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + " · " : "") + W.formatMs(Math.max(0, end - t0)) + (run.finishedAt ? " end to end" : " so far"));
    }
    return bits.join(" · ");
  }

  function stepsHtml(run, wf) {
    const dir = W.runDirectory(run, wf);
    if (!dir.length) return `<div class="cum-rm-note">No steps to show.</div>`;
    return (
      `<div class="cum-rm-steps">` +
      dir
        .map(
          (s) =>
            `<a class="cum-rm-step${s.here ? " cum-rm-here" : ""}${s.done ? " cum-rm-done" : ""}"` +
            (s.url ? ` href="${esc(s.url)}"` : "") + ` data-i="${s.index}">` +
            `<span class="cum-rm-step-n">${esc(s.label)}</span>` +
            `<span class="cum-rm-step-main"><b>${esc(s.chatName)}</b> ${esc((s.prompt || "").replace(/\s+/g, " ").slice(0, 90))}</span>` +
            `<span class="cum-rm-step-mark">${s.done ? "✓" : s.here ? "▶" : ""}</span></a>`
        )
        .join("") +
      `</div>`
    );
  }

  function fixHtml(run, wf) {
    if (!fixDraft) return "";
    const source = W.runSource(run, wf);
    const plan = W.planRun(source);
    const src = W.carrySource(source, fixDraft.stepIndex);
    const opts = plan
      .filter((s) => s.index === s.waveStart && s.kind !== "pause")
      .map(
        (s) =>
          `<option value="${s.index}"${s.index === fixDraft.stepIndex ? " selected" : ""}>Step ${esc(s.label)} — ${esc(s.chatName)}</option>`
      )
      .join("");
    const chosen = plan[fixDraft.stepIndex];
    const chatRows = (source.chats || [])
      .map(
        (c) =>
          `<label class="cum-rm-fixchat"><span>${esc(c.name)}</span>` +
          `<input type="text" class="cum-rm-fixurl" data-chat="${esc(c.id)}" value="${esc(
            fixDraft.chats[c.id] || ""
          )}" placeholder="https://claude.ai/…" /></label>`
      )
      .join("");
    return (
      `<div class="cum-rm-fix">` +
      `<div class="cum-rm-row"><b>Continue from</b> <select class="cum-rm-fixstep">${opts}</select></div>` +
      (chosen ? `<pre class="cum-rm-prompt">${esc((chosen.prompt || "(no prompt)").slice(0, 600))}</pre>` : "") +
      (src.needed
        ? `<label class="cum-rm-check"><input type="checkbox" class="cum-rm-refetch"${
            fixDraft.refetchCarry ? " checked" : ""
          }/> Re-read <b>${esc(src.chatName)}</b>'s latest reply and carry it in</label>`
        : `<div class="cum-rm-note">This step carries nothing in — it just runs its own prompt.</div>`) +
      `<label class="cum-rm-check"><input type="checkbox" class="cum-rm-sent"${
        fixDraft.sent ? " checked" : ""
      }/> The message already went out — wait for the reply, don't re-send</label>` +
      `<div class="cum-rm-note">Conversations this run is using (edit if it lost track of one):</div>` +
      chatRows +
      `<div class="cum-rm-row"><button class="cum-rm-btn cum-rm-go" data-act="fix-go">Continue run</button>` +
      `<button class="cum-rm-btn" data-act="fix-cancel">Cancel</button></div>` +
      `</div>`
    );
  }

  // Editing the run IN PLACE (the owner's spec — no round trip to Options).
  // The worker's cum-wf-edit-run applies the same patch the Options editor
  // sends; this form covers the working set — the matter's name and each
  // step's chat, prompt, model, marker and carry, plus adding and removing
  // steps. Documents still go through Options: they are stored bytes, and a
  // form that silently couldn't take them would be worse than saying so.
  function editHtml(run, wf) {
    if (!editDraft) return "";
    const source = W.runSource(run, wf);
    const chats = source.chats || [];
    const chatOpts = (sel) =>
      chats
        .map((c) => `<option value="${esc(c.id)}"${c.id === sel ? " selected" : ""}>${esc(c.name)}</option>`)
        .join("");
    const rows = editDraft.steps
      .map((s, i) => {
        if (s.kind === "pause")
          return (
            `<div class="cum-rm-editstep" data-i="${i}"><div class="cum-rm-row">` +
            `<b>Step ${i + 1}</b> <span class="cum-rm-badge">pause</span>` +
            `<button class="cum-rm-btn cum-rm-danger" data-eact="del" data-i="${i}">✕</button></div></div>`
          );
        return (
          `<div class="cum-rm-editstep" data-i="${i}">` +
          `<div class="cum-rm-row"><b>Step ${i + 1}</b>` +
          `<select class="cum-rm-editchat" data-i="${i}">${chatOpts(s.chatId)}</select>` +
          `<label class="cum-rm-check" style="margin:0"><input type="checkbox" class="cum-rm-editcarry" data-i="${i}"${
            s.carry !== false ? " checked" : ""
          }/> carries in</label>` +
          `<button class="cum-rm-btn cum-rm-danger" data-eact="del" data-i="${i}" title="Remove this step">✕</button></div>` +
          `<textarea class="cum-rm-editprompt" data-i="${i}" rows="3">${esc(s.prompt || "")}</textarea>` +
          `<div class="cum-rm-row">` +
          `<input type="text" class="cum-rm-editmodel" data-i="${i}" placeholder="model (blank = chat's)" value="${esc(s.model || "")}"/>` +
          `<input type="text" class="cum-rm-editmarker" data-i="${i}" placeholder="reply must contain…" value="${esc(s.marker || "")}"/>` +
          `</div></div>`
        );
      })
      .join("");
    return (
      `<div class="cum-rm-fix">` +
      `<div class="cum-rm-row"><b>Matter</b> <input type="text" class="cum-rm-editname" value="${esc(
        editDraft.name || ""
      )}" placeholder="This run's name" style="flex:1 1 auto"/></div>` +
      rows +
      `<div class="cum-rm-row"><button class="cum-rm-btn" data-eact="add">+ Add step</button></div>` +
      `<div class="cum-rm-note">Documents and chat set-up still edit in Options — they carry stored files.</div>` +
      `<div class="cum-rm-row"><button class="cum-rm-btn cum-rm-go" data-eact="save">Save changes</button>` +
      `<button class="cum-rm-btn" data-eact="cancel">Cancel</button></div>` +
      `</div>`
    );
  }

  function wireEdit(run) {
    if (!editDraft) return;
    const upd = (sel, field, read) =>
      el.querySelectorAll(sel).forEach((i) =>
        i.addEventListener("input", () => {
          const at = parseInt(i.getAttribute("data-i"), 10);
          if (editDraft.steps[at]) editDraft.steps[at][field] = read(i);
        })
      );
    upd(".cum-rm-editprompt", "prompt", (i) => i.value);
    upd(".cum-rm-editmodel", "model", (i) => i.value.trim() || null);
    upd(".cum-rm-editmarker", "marker", (i) => i.value.trim() || null);
    el.querySelectorAll(".cum-rm-editchat").forEach((i) =>
      i.addEventListener("change", () => {
        const at = parseInt(i.getAttribute("data-i"), 10);
        if (editDraft.steps[at]) editDraft.steps[at].chatId = i.value;
      })
    );
    el.querySelectorAll(".cum-rm-editcarry").forEach((i) =>
      i.addEventListener("change", () => {
        const at = parseInt(i.getAttribute("data-i"), 10);
        if (editDraft.steps[at]) editDraft.steps[at].carry = i.checked;
      })
    );
    const name = el.querySelector(".cum-rm-editname");
    if (name) name.addEventListener("input", () => (editDraft.name = name.value));
    el.querySelectorAll("[data-eact]").forEach((b) =>
      b.addEventListener("click", () => {
        const act = b.getAttribute("data-eact");
        if (act === "del") {
          editDraft.steps.splice(parseInt(b.getAttribute("data-i"), 10), 1);
          lastKey = "";
          return tick();
        }
        if (act === "add") {
          const last = editDraft.steps[editDraft.steps.length - 1];
          editDraft.steps.push({ chatId: (last && last.chatId) || null, prompt: "", carry: true });
          lastKey = "";
          return tick();
        }
        if (act === "cancel") {
          editDraft = null;
          lastKey = "";
          return tick();
        }
        if (act === "save") {
          if (!editDraft.steps.length) return alert("A run needs at least one step.");
          b.disabled = true;
          busyNote = "Saving…";
          const patch = { name: editDraft.name, steps: editDraft.steps };
          editDraft = null;
          return send({ type: "cum-wf-edit-run", runId: run.id, patch }, (res) => {
            busyNote = res && res.ok ? "Saved." : "Could not save: " + ((res && res.error) || "no answer");
            lastKey = "";
            tick();
          });
        }
      })
    );
  }

  function render(run, wf) {
    build();
    const label = W.runLabel(run);
    const paused = run.status === "paused";
    const active = W.isRunActive(run);
    const canResume = run.status === "error" || run.status === "waiting" || paused;
    const canFix = !((active && run.status !== "waiting") || W.isDraft(run));

    const btns =
      `<button class="cum-rm-btn" data-act="steps">${showSteps ? "Hide steps" : "Steps"}</button>` +
      (canResume ? `<button class="cum-rm-btn cum-rm-go" data-act="resume">Resume</button>` : "") +
      (canFix ? `<button class="cum-rm-btn" data-act="fix">Fix &amp; continue</button>` : "") +
      (active ? `<button class="cum-rm-btn" data-act="pause">Pause</button>` : "") +
      (run.resumeOnUsage && paused
        ? `<button class="cum-rm-btn" data-act="hold" title="Don't pick it back up when usage returns">Stay paused</button>`
        : "") +
      (run.status === "waiting" && !run.ignoreOutage
        ? `<button class="cum-rm-btn cum-rm-go" data-act="anyway">Go anyway</button>`
        : "") +
      (run.status !== "running"
        ? `<button class="cum-rm-btn" data-act="edit" title="Change the matter's name, its steps and prompts — right here">Edit run</button>`
        : "") +
      (active || paused ? `<button class="cum-rm-btn cum-rm-danger" data-act="cancel">Cancel</button>` : "") +
      (Object.keys(run.chats || {}).length
        ? `<button class="cum-rm-btn" data-act="chats">Open chats</button>`
        : "") +
      `<button class="cum-rm-btn" data-act="save">Save as workflow</button>`;

    el.innerHTML =
      `<div class="cum-rm-head">` +
      `<span class="cum-rm-title">${esc(label.title)}</span>` +
      (label.template ? `<span class="cum-rm-badge">${esc(label.template)}</span>` : "") +
      `<span class="cum-rm-badge cum-rm-status-${esc(run.status)}">${esc(STATUS_LABEL[run.status] || run.status)}</span>` +
      `<button class="cum-rm-x" data-act="close" title="Hide (the Run controls tab brings it back)">✕</button>` +
      `</div>` +
      `<div class="cum-rm-btns">${btns}</div>` +
      `<div class="cum-rm-facts">` +
      `<b>${esc(W.progressText(run, wf))}</b>` +
      (run.docs && run.docs.length ? ` · ${run.docs.length} document${run.docs.length === 1 ? "" : "s"}` : "") +
      `<div>${esc(whenText(run))}</div>` +
      `</div>` +
      (run.error ? `<div class="cum-rm-err">${esc(run.error)}</div>` : "") +
      (run.note ? `<div class="cum-rm-note">${esc(run.note)}</div>` : "") +
      (busyNote ? `<div class="cum-rm-note">${esc(busyNote)}</div>` : "") +
      (showSteps ? stepsHtml(run, wf) : "") +
      fixHtml(run, wf) +
      editHtml(run, wf);

    wire(run, wf);
    wireEdit(run);
    wireDrag(el.querySelector(".cum-rm-head"));
    position();
  }

  function wire(run, wf) {
    el.querySelectorAll("[data-act]").forEach((b) => {
      b.addEventListener("click", (e) => {
        const act = b.getAttribute("data-act");
        if (act === "close") {
          open = false;
          storageSet({ [OPEN_KEY]: false });
          lastKey = "";
          return tick();
        }
        if (act === "steps") {
          showSteps = !showSteps;
          lastKey = "";
          return tick();
        }
        if (act === "resume") {
          b.disabled = true;
          busyNote = "Resuming…";
          return send({ type: "cum-wf-resume", runId: run.id }, after());
        }
        if (act === "pause") {
          b.disabled = true;
          busyNote = "Pausing at the next safe moment…";
          return send({ type: "cum-wf-pause", runId: run.id }, after());
        }
        if (act === "hold") {
          b.disabled = true;
          return send({ type: "cum-wf-hold-usage", runId: run.id }, after());
        }
        if (act === "anyway") {
          b.disabled = true;
          return send({ type: "cum-wf-ignore-outage", runId: run.id }, after());
        }
        if (act === "cancel") {
          if (!confirm("Cancel this run for good? Its place is lost.")) return;
          b.disabled = true;
          return send({ type: "cum-wf-cancel", runId: run.id }, after());
        }
        if (act === "chats") {
          b.disabled = true;
          return send({ type: "cum-wf-show-chats", runId: run.id }, after());
        }
        if (act === "edit") {
          if (editDraft) editDraft = null;
          else {
            const source = W.runSource(run, wf);
            editDraft = {
              name: run.name || "",
              steps: (source.steps || []).map((s) => Object.assign({}, s)),
            };
            fixDraft = null; // one form at a time
          }
          lastKey = "";
          return tick();
        }
        if (act === "save") {
          const name = prompt("Save this run's chats and steps as a new workflow, called:", W.runLabel(run).title);
          if (name === null) return;
          const made = W.workflowFromRun(
            Object.assign({}, run, { name: name.trim() || run.name }),
            wf,
            crypto.randomUUID(),
            Date.now(),
            () => crypto.randomUUID()
          );
          storageGet(WORKFLOWS_KEY).then((r) => {
            storageSet({ [WORKFLOWS_KEY]: W.upsertWorkflow(r[WORKFLOWS_KEY] || [], made) });
            busyNote = 'Saved as workflow "' + (made.name || "untitled") + '".';
            lastKey = "";
            tick();
          });
          return;
        }
        if (act === "fix") {
          if (fixDraft) fixDraft = null;
          else {
            const source = W.runSource(run, wf);
            const chats = {};
            for (const c of source.chats || []) chats[c.id] = (run.chats && run.chats[c.id] && run.chats[c.id].url) || "";
            fixDraft = {
              stepIndex: Math.min(run.stepIndex, Math.max(0, (run.totalSteps || 1) - 1)),
              refetchCarry: !!W.carrySource(source, run.stepIndex).needed,
              sent: run.phase === "awaiting-reply",
              chats,
            };
          }
          lastKey = "";
          return tick();
        }
        if (act === "fix-cancel") {
          fixDraft = null;
          lastKey = "";
          return tick();
        }
        if (act === "fix-go") {
          const chats = {};
          for (const cid of Object.keys(fixDraft.chats)) chats[cid] = { url: fixDraft.chats[cid] };
          const choice = W.exclusiveFix(fixDraft, "sent");
          const patch = {
            stepIndex: fixDraft.stepIndex,
            phase: choice.sent ? "awaiting-reply" : "idle",
            refetchCarry: choice.refetchCarry,
            chats,
          };
          b.disabled = true;
          busyNote = fixDraft.refetchCarry ? "Reading the other chat…" : "Continuing…";
          fixDraft = null;
          return send({ type: "cum-wf-resume", runId: run.id, patch }, (res) => {
            busyNote = res && res.ok ? res.note || "" : (res && res.error) || "no answer";
            lastKey = "";
            tick();
          });
        }
      });
    });
    const stepSel = el.querySelector(".cum-rm-fixstep");
    if (stepSel)
      stepSel.addEventListener("change", () => {
        fixDraft.stepIndex = parseInt(stepSel.value, 10) || 0;
        const source = W.runSource(run, wf);
        fixDraft.refetchCarry = !!W.carrySource(source, fixDraft.stepIndex).needed;
        fixDraft.sent = false;
        lastKey = "";
        tick();
      });
    const refetch = el.querySelector(".cum-rm-refetch");
    if (refetch)
      refetch.addEventListener("change", () => {
        fixDraft.refetchCarry = refetch.checked;
        Object.assign(fixDraft, W.exclusiveFix(fixDraft, "refetch"));
        lastKey = "";
        tick();
      });
    const sent = el.querySelector(".cum-rm-sent");
    if (sent)
      sent.addEventListener("change", () => {
        fixDraft.sent = sent.checked;
        Object.assign(fixDraft, W.exclusiveFix(fixDraft, "sent"));
        lastKey = "";
        tick();
      });
    el.querySelectorAll(".cum-rm-fixurl").forEach((i) =>
      i.addEventListener("input", () => (fixDraft.chats[i.getAttribute("data-chat")] = i.value.trim()))
    );
  }

  function after() {
    return () => {
      busyNote = "";
      lastKey = "";
      tick();
    };
  }

  function build() {
    if (el && el.isConnected) return el;
    el = document.getElementById(ID);
    if (!el) {
      el = document.createElement("div");
      el.id = ID;
    }
    (document.body || document.documentElement).appendChild(el);
    // The corner handle is the browser's own (CSS resize). A change position()
    // didn't make is the operator's, and becomes the custom size.
    try {
      new ResizeObserver(() => {
        if (!el || el.hidden) return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        if (Math.abs(w - applied.w) < 7 && Math.abs(h - applied.h) < 7) return;
        const r = el.getBoundingClientRect();
        custom = Object.assign({}, custom || {}, {
          left: custom ? custom.left : Math.round(r.left),
          top: custom ? custom.top : Math.round(r.top),
          width: w,
          height: h,
        });
        applied = { w, h };
        keepGeo();
      }).observe(el);
    } catch (e) {
      /* dragging still works; only the resize handle goes unremembered */
    }
    return el;
  }

  let tab = null;
  function showTab(showIt) {
    if (!tab && showIt) {
      tab = document.createElement("button");
      tab.id = "cum-runmargin-tab";
      tab.type = "button";
      tab.textContent = "Run controls";
      tab.addEventListener("click", () => {
        open = true;
        storageSet({ [OPEN_KEY]: true });
        lastKey = "";
        tick();
      });
      (document.body || document.documentElement).appendChild(tab);
    }
    if (tab) tab.hidden = !showIt;
  }

  function hideAll() {
    if (el) el.hidden = true;
    showTab(false);
  }

  async function tick() {
    let runs;
    try {
      runs = await readRuns();
    } catch (e) {
      return;
    }
    const run = findRun(runs, location.href);
    if (!run) return hideAll();
    // A NEW run returns to the default geometry — unless the popup's sticky
    // box is ticked, in which case where you put it is where it stays.
    if (run.id !== lastRunId) {
      lastRunId = run.id;
      if (!sticky) custom = null;
    }
    if (!open) {
      if (el) el.hidden = true;
      showTab(true);
      return;
    }
    showTab(false);
    const workflows = (await storageGet(WORKFLOWS_KEY))[WORKFLOWS_KEY] || [];
    const wf = W.getWorkflow(workflows, run.workflowId);
    build();
    el.hidden = false;
    // Redraw only when the run moved — the console holds forms, and a redraw
    // mid-typing would eat the keystrokes. While EITHER form is open, only a
    // change to the run's own core (its status, its step) may repaint; notes
    // and heartbeats may not pull the textarea out from under the operator.
    const core = [run.id, run.status, run.stepIndex, run.phase].join("|");
    const key = [core, run.note, run.error, showSteps, !!fixDraft, !!editDraft, busyNote].join("|");
    if (key === lastKey) return position();
    if ((fixDraft || editDraft) && core === lastCore) return position();
    lastCore = core;
    lastKey = key;
    render(run, wf);
  }

  // The console as a destination other buttons can open — the tray's Run
  // button toggles this now, rather than a smaller steps panel of its own.
  window.CUMRunMargin = {
    toggle: function () {
      open = !open;
      storageSet({ [OPEN_KEY]: open });
      lastKey = "";
      tick();
    },
    isOpen: function () {
      return !!(open && el && !el.hidden);
    },
  };

  storageGet([OPEN_KEY, STICKY_KEY, GEO_KEY]).then((r) => {
    if (r[OPEN_KEY] === false) open = false;
    sticky = !!r[STICKY_KEY];
    if (sticky && r[GEO_KEY]) custom = r[GEO_KEY];
    tick();
  });
  setInterval(tick, POLL_MS);
  setInterval(position, 1000);
  // Snap back on every page NAVIGATION too, unless persistence is ticked —
  // the owner's rule: an unticked box means the default spot, page after page,
  // not just run after run.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (!sticky && custom) {
      custom = null;
      position();
    }
  }, 800);
  window.addEventListener("resize", position);
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STICKY_KEY]) {
        sticky = !!changes[STICKY_KEY].newValue;
        // Turned off in the popup: snap back to the default now, not at the
        // next run — the checkbox says what the console does, immediately.
        if (!sticky) {
          custom = null;
          position();
        }
      }
      if (changes[GEO_KEY] && changes[GEO_KEY].newValue === null && !sticky) {
        custom = null;
        position();
      }
      if (Object.keys(changes).some((k) => k.indexOf("cum_wf_run") === 0 || k === W.RUN_IDS_KEY)) tick();
    });
  } catch (e) {
    /* the poll carries it */
  }
})();
