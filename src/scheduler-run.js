/**
 * Claude Usage Meter — scheduled-send executor (ISOLATED world content script).
 *
 * Runs on claude.ai. When the background worker opens a tab to the right
 * composer (/new or /cowork/project/<uuid>) and sends "cum-run-job", this
 * rebuilds the queued files from stored bytes and hands them, with the prompt,
 * to the shared composer driver (src/composer.js), which attaches them, waits
 * for the uploads, types the prompt and clicks Send. The result goes back to the
 * worker.
 *
 * It also keeps the scheduler's pickers stocked: project links, the model menu's
 * names, and Claude Code's repo list.
 */
(function () {
  "use strict";

  const JOBS_KEY = "cum_jobs";
  const C = window.CUMComposer;

  async function runJob(jobId) {
    const store = await C.storageGet([JOBS_KEY]);
    const jobs = store[JOBS_KEY] || [];
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return { ok: false, error: "job not found" };

    const { files, missing } = await C.filesFromStorage(job.files);
    if (missing) return { ok: false, error: "missing file bytes: " + missing };

    const res = await C.sendMessage({
      files,
      text: job.prompt || "",
      model: job.model || null,
      codeRepo: job.codeRepo || null,
      surface: job.surface || null,
      // A Cowork session's project is a menu on the composer, not an address,
      // so the name travels with the send rather than with the URL.
      coworkProject: job.surface === "cowork" ? job.projectName || null : null,
    });
    const note = res.notes && res.notes.length ? res.notes.join("; ") : null;
    if (!res.ok) return { ok: false, error: res.error, note };
    return { ok: true, note };
  }

  // Scrape the visible project links (for the options-page picker). Cleaned
  // as they come in: a row's textContent carries its own furniture ("Toggle
  // chats for <name>" from the chats expander), and a name stored dirty armed
  // a run that filtered the project menu down to nothing and failed.
  function scrapeProjects() {
    const J = window.CUMJobs;
    const out = [];
    document.querySelectorAll('a[href*="/project/"]').forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      const m = href.match(/\/project\/([0-9a-f-]{36})/i);
      if (!m) return;
      if (out.some((p) => p.uuid === m[1])) return;
      const raw = (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
      out.push({ uuid: m[1], href, name: (J && J.cleanProjectName(raw)) || raw });
    });
    return out;
  }

  // Zero-friction: whenever the user is naturally on claude.ai and project links
  // are present (the Projects page, or the sidebar), merge them into the cached
  // list so the options picker fills in without an explicit refresh.
  function autoScrapeProjects() {
    let found;
    try {
      found = scrapeProjects();
    } catch (e) {
      return;
    }
    if (!found.length) return;
    try {
      chrome.storage.local.get("cum_projects", (res) => {
        const existing = (res && res.cum_projects) || [];
        const byId = new Map(existing.map((p) => [p.uuid, p]));
        for (const p of found) byId.set(p.uuid, p);
        chrome.storage.local.set({ cum_projects: Array.from(byId.values()) });
      });
    } catch (e) {
      /* ignore */
    }
  }
  // SPA renders late; sample a few times after load.
  setTimeout(autoScrapeProjects, 2500);
  setTimeout(autoScrapeProjects, 6000);
  setTimeout(autoScrapeProjects, 15000);

  // Keep the scheduler's model list live: whenever the user opens the model
  // menu (regular chat only), harvest the visible names. Cheap — the selector
  // matches nothing unless a menu is actually open.
  setInterval(() => {
    try {
      if (!C.isCodePage() && document.querySelector('[role="menuitemradio"]')) C.harvestModels();
    } catch (e) {
      /* ignore */
    }
  }, 2500);

  // On Claude Code pages, keep the repo list live for the scheduler picker.
  setTimeout(() => C.harvestRepos(), 3000);
  setTimeout(() => C.harvestRepos(), 8000);
  setInterval(() => {
    try {
      C.harvestRepos();
    } catch (e) {
      /* ignore */
    }
  }, 6000);

  chrome.runtime?.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "cum-run-job") {
      runJob(msg.jobId)
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true; // async response
    }
    if (msg.type === "cum-discover-projects") {
      // Ask the MAIN-world interceptor to pull the project list from the API.
      try {
        window.postMessage(
          { __channel: C.CHANNEL, command: { type: "discoverProjects" } },
          window.location.origin
        );
      } catch (e) {
        /* ignore */
      }
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "cum-scrape-projects") {
      const projects = scrapeProjects();
      // The grid can virtualize (only visible cards live in the DOM), so nudge
      // the scroll position before the next scrape to reveal more cards.
      try {
        const doc = document.scrollingElement || document.documentElement;
        window.scrollTo(0, (doc.scrollTop || 0) + Math.round(window.innerHeight * 0.85));
      } catch (e) {
        /* ignore */
      }
      sendResponse({ projects });
      return false;
    }
  });
})();
