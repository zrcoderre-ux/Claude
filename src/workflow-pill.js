/**
 * Claude Usage Meter — workflow run pill (ISOLATED world content script).
 *
 * When the conversation you're looking at belongs to a workflow run, this puts
 * a small pill in the corner saying where that run is — which step, in which
 * chat, doing what — with a Pause beside it.
 *
 * The point is the Pause. A run drives this conversation on its own, and when
 * something goes wrong the place you notice is here, in the chat, not on the
 * Options page: a prompt landed in the wrong chat, an answer went sideways, the
 * papers didn't attach. Stopping it should not mean hunting for the tab that
 * can. Pausing takes effect at the next step boundary and keeps the run's
 * place, so Resume carries on rather than starting over.
 *
 * It sits bottom-LEFT because the usage pill owns the bottom-right (and is
 * draggable, so it may be anywhere along that edge).
 */
(function () {
  "use strict";

  const W = window.CUMWorkflow;
  const J = window.CUMJobs;
  const ID = "cum-wfpill";
  const POLL_MS = 2500;

  if (!W || !J) return;

  let el = null;
  let lastKey = ""; // what's rendered, so we don't rebuild on every tick

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  async function readRuns() {
    const ids = (await storageGet(W.RUN_IDS_KEY))[W.RUN_IDS_KEY] || [];
    if (!ids.length) return [];
    const store = await storageGet(ids.map(W.runKey));
    return ids.map((id) => store[W.runKey(id)]).filter(Boolean);
  }

  // The run this conversation belongs to, if any — matched by URL, so a chat
  // open in two places or a run whose workflow has changed still resolves.
  function findRun(runs, href) {
    for (const run of runs) {
      if (!run || (!W.isRunActive(run) && run.status !== "paused")) continue;
      for (const chatId of Object.keys(run.chats || {})) {
        const url = (run.chats[chatId] || {}).url;
        if (!url) continue;
        try {
          if (J.sameConversationUrl(url, href)) return { run, chatId };
        } catch (e) {
          /* ignore */
        }
      }
    }
    return null;
  }

  function build() {
    if (el) return el;
    el = document.createElement("div");
    el.id = ID;
    el.innerHTML =
      `<span class="cum-wfp-dot"></span>` +
      `<span class="cum-wfp-text"><b class="cum-wfp-name"></b><span class="cum-wfp-where"></span></span>` +
      `<button class="cum-wfp-btn" type="button"></button>`;
    (document.body || document.documentElement).appendChild(el);
    // The body opens Options, where the rest of the run's controls live.
    el.querySelector(".cum-wfp-text").addEventListener("click", () => {
      try {
        chrome.runtime.sendMessage({ type: "cum-open-options" });
      } catch (e) {
        /* ignore */
      }
    });
    return el;
  }

  function remove() {
    if (el) el.remove();
    el = null;
    lastKey = "";
  }

  function render(run, wf, chatId) {
    const paused = run.status === "paused";
    const node = build();
    const total = run.totalSteps || 0;
    const here = W.chatName(W.runSource(run, wf), chatId);
    const key = [run.id, run.status, run.stepIndex, run.phase, here].join("|");
    if (key === lastKey) return;
    lastKey = key;

    node.classList.toggle("cum-wfp-paused", paused);
    node.querySelector(".cum-wfp-name").textContent = run.name || "Workflow";
    node.querySelector(".cum-wfp-where").textContent = paused
      ? " · paused before step " + (run.stepIndex + 1) + " of " + total
      : " · step " + (run.stepIndex + 1) + " of " + total + " · " + here +
        (run.phase === "awaiting-reply" ? " · waiting for Claude" : "");

    const btn = node.querySelector(".cum-wfp-btn");
    btn.textContent = paused ? "Resume" : "Pause";
    btn.disabled = false;
    btn.onclick = () => {
      btn.disabled = true;
      btn.textContent = paused ? "Resuming…" : "Pausing…";
      try {
        chrome.runtime.sendMessage(
          { type: paused ? "cum-wf-resume" : "cum-wf-pause", runId: run.id },
          () => {
            void chrome.runtime.lastError;
            lastKey = ""; // force a redraw from whatever the run says now
            tick();
          }
        );
      } catch (e) {
        btn.disabled = false;
      }
    };
  }

  async function tick() {
    let runs;
    try {
      runs = await readRuns();
    } catch (e) {
      return;
    }
    const found = findRun(runs, location.href);
    if (!found) return remove();
    const workflows = (await storageGet("cum_workflows")).cum_workflows || [];
    render(found.run, W.getWorkflow(workflows, found.run.workflowId), found.chatId);
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      // Heartbeats tick every 20 seconds and say nothing worth redrawing for.
      const relevant = Object.keys(changes).some(
        (k) =>
          k === "cum_workflows" ||
          k === W.RUN_IDS_KEY ||
          (k.indexOf(W.RUN_PREFIX) === 0 && k.indexOf(W.BEAT_PREFIX) !== 0)
      );
      if (relevant) tick();
    });
  } catch (e) {
    /* ignore */
  }

  // The SPA changes conversation without reloading, so the pill has to notice
  // that this tab is now a different chat — or no longer one of the run's.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastKey = "";
    }
    tick();
  }, POLL_MS);
  tick();
})();
