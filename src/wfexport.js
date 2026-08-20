/**
 * Claude Usage Meter — workflows out of one browser and into another (pure).
 *
 * A workflow is half an hour of writing prompts and wiring chats together, and
 * it lived in one browser profile's storage. This is the file that carries it:
 * export writes a small JSON bundle, import folds it back in.
 *
 * WHAT TRAVELS IS THE TEMPLATE, NOT THE MATTER. The repo's rule is that a
 * workflow is a template and a matter's things belong to the run, so a bundle
 * carries the chats, the steps, the prompts and the behaviour switches — and
 * leaves behind every part that is about one case in one browser:
 *
 *   documents      the matter's papers. They're the run's, they can be
 *                  hundreds of megabytes, and a template mailed with a
 *                  client's brief inside it is a leak by file transfer.
 *   pseudonym key  an id into THIS browser's key library; on another machine
 *                  it points at nothing, or worse, at a different case.
 *   run date, and the name the template is currently armed under — both are
 *                  this matter's, so the bundle carries the resting name.
 *   start URLs     "start in this existing chat" is arming for a matter.
 *   usage figures  measured on the machine that measured them.
 *
 * Ids ride along, so re-importing an edited workflow UPDATES the one it came
 * from instead of leaving two near-identical rows behind. That's the whole
 * point on a second laptop: export, import, work, export back.
 *
 * The same rule governs the receiving end. An import replaces the TEMPLATE
 * parts of a workflow and leaves alone whatever matter is already set up on it
 * here — its papers, its key, its date, its armed name and the conversations it
 * was pointed at. Bringing your prompts up to date is not a reason to lose the
 * case you had waiting (see keepMatter).
 *
 * Pure: no chrome, no DOM, no file I/O — the caller does the download and the
 * read. Shape questions go to CUMWorkflow, which owns the shape.
 */
(function (root) {
  "use strict";

  const KIND = "claude-usage-meter/workflows";
  const VERSION = 1;

  // workflow.js owns what a workflow IS; this module owns the envelope around
  // it. Resolved on use rather than at load: in the browser both are plain
  // <script>s and load order is the manifest's business, and under Node a test
  // may require this file on its own.
  function W() {
    if (root.CUMWorkflow) return root.CUMWorkflow;
    if (typeof require === "function") return require("./workflow.js");
    return null;
  }

  function str(v) {
    return typeof v === "string" ? v : "";
  }

  /**
   * One workflow as it travels: the template, with everything this-matter and
   * this-browser left behind. Runs through newWorkflow() at both ends, which
   * is a whitelist — a field nothing here knows about can't ride along, and a
   * hand-edited bundle can't smuggle one in.
   */
  function portable(wf) {
    const Wm = W();
    if (!wf || !Wm) return null;
    const resting = str(wf.templateName).trim() || str(wf.name).trim() || "Untitled workflow";
    const clean = Wm.newWorkflow(
      Object.assign({}, wf, {
        name: resting, // it arrives at rest, ready to be named for a matter
        templateName: resting,
        docs: [],
        pseudoKeyId: null,
        runDate: null,
        usage: null,
        chats: (wf.chats || []).map((c) => Object.assign({}, c, { startUrl: null })),
      }),
      wf.id,
      typeof wf.createdAt === "number" ? wf.createdAt : 0
    );
    // newWorkflow stamps updatedAt with `now`; the bundle carries when the
    // workflow was actually last edited, so the far end can say which copy is
    // newer without trusting the clock the export ran on.
    clean.updatedAt = typeof wf.updatedAt === "number" ? wf.updatedAt : clean.updatedAt;
    return clean;
  }

  /** How many of this workflow's parts are being left behind, for the notice. */
  function leftBehind(wf) {
    const docs = ((wf && wf.docs) || []).length;
    const armed = ((wf && wf.chats) || []).filter((c) => c && c.startUrl).length;
    return { docs: docs, armed: armed, key: !!(wf && wf.pseudoKeyId) };
  }

  /** The bundle: a version, a stamp, and the workflows. */
  function buildExport(list, now) {
    const workflows = (list || []).map(portable).filter(Boolean);
    return {
      kind: KIND,
      v: VERSION,
      exportedAt: typeof now === "number" ? now : 0,
      count: workflows.length,
      workflows: workflows,
    };
  }

  // Filenames a folder of exports stays readable in: what it holds, then when.
  function slug(s) {
    return str(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
  }

  function fileName(list, dateStr) {
    const l = list || [];
    const date = str(dateStr) || "";
    const tail = (date ? "-" + date : "") + ".json";
    if (l.length === 1) {
      const s = slug(l[0] && (l[0].templateName || l[0].name));
      return "claude-workflow-" + (s || "untitled") + tail;
    }
    return "claude-workflows-" + l.length + tail;
  }

  // Enough of a workflow to be one: something to run, or somewhere to run it.
  function looksLikeWorkflow(x) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return false;
    return Array.isArray(x.steps) || Array.isArray(x.chats);
  }

  /**
   * Read a bundle. Generous about the wrapper — a bundle, a bare array, or a
   * single workflow all read — and strict about the contents: anything that
   * isn't a workflow is counted in `skipped` rather than being waved through
   * to fail later as an empty row.
   *
   * A bundle from a LATER version is refused outright. Reading half of a shape
   * this build doesn't know is how you get a workflow that looks imported and
   * runs wrong.
   */
  function parseBundle(text) {
    let data;
    try {
      data = JSON.parse(String(text == null ? "" : text));
    } catch (e) {
      return { ok: false, error: "That isn't a workflow file — it isn't JSON at all." };
    }
    let raw = null;
    if (Array.isArray(data)) raw = data;
    else if (data && Array.isArray(data.workflows)) {
      if (data.kind && data.kind !== KIND)
        return { ok: false, error: "That JSON file isn't a workflow export." };
      const v = typeof data.v === "number" ? data.v : 1;
      if (v > VERSION)
        return {
          ok: false,
          error:
            "That file was written by a newer version of the extension (format " +
            v +
            "; this one reads " +
            VERSION +
            "). Update the extension on this machine first.",
        };
      raw = data.workflows;
    } else if (looksLikeWorkflow(data)) raw = [data];
    if (!raw) return { ok: false, error: "That JSON file isn't a workflow export." };

    const workflows = [];
    let skipped = 0;
    for (const x of raw) {
      if (looksLikeWorkflow(x)) workflows.push(x);
      else skipped++;
    }
    if (!workflows.length)
      return { ok: false, error: "That file holds no workflows.", skipped: skipped };
    return { ok: true, workflows: workflows, skipped: skipped };
  }

  /**
   * Which existing workflow an incoming one is a new copy OF.
   *
   * By id, which is what makes export→edit→export→import an update rather than
   * a pile of near-duplicates. Failing that, the pre-built one matches the
   * pre-built one: its id is minted fresh in each browser, so two machines'
   * copies of the SAME starting template never share one, and without this
   * every import would leave a second row badged Pre-built.
   */
  function matchFor(existing, inc) {
    const list = existing || [];
    for (const w of list) if (w && w.id && inc && w.id === inc.id) return w;
    if (inc && inc.builtin) {
      for (const w of list) if (w && w.builtin) return w;
    }
    return null;
  }

  /**
   * What importing this bundle would do, before it does it — so the dialog can
   * name what it's about to overwrite. `sameName` is the softer warning: a
   * different workflow that happens to share a name, which imports as a second
   * row and would otherwise look like a failed update.
   */
  function importPlan(existing, incoming) {
    const list = existing || [];
    const add = [];
    const replace = [];
    const sameName = [];
    const claimed = new Set();
    for (const inc of incoming || []) {
      const hit = matchFor(list, inc);
      if (hit && !claimed.has(hit.id)) {
        claimed.add(hit.id);
        // `to` is the name the row will actually END UP with, not the
        // incoming template's: a row armed for a matter keeps the matter's
        // name (keepMatter), so promising a rename here would be a promise
        // the import doesn't keep.
        const armed = str(hit.name).trim() && str(hit.name).trim() !== str(hit.templateName).trim();
        replace.push({
          id: hit.id,
          from: hit.name || hit.templateName || "",
          to: armed ? hit.name : nameOf(inc),
        });
        continue;
      }
      add.push(nameOf(inc));
      const n = fold(nameOf(inc));
      if (n && list.some((w) => fold(w.templateName || w.name) === n)) sameName.push(nameOf(inc));
    }
    return { add: add, replace: replace, sameName: sameName, total: add.length + replace.length };
  }

  function nameOf(wf) {
    return str(wf && (wf.templateName || wf.name)).trim() || "Untitled workflow";
  }
  function fold(s) {
    return str(s).trim().toLowerCase();
  }

  /**
   * The matter that is ALREADY HERE, put back on top of an imported template.
   *
   * The rule that governs the export governs the import: what travels is the
   * template, not the matter — so the matter waiting on this machine survives
   * being updated from another one. A workflow armed for a case, with that
   * case's papers on it, keeps its papers, its key, its date, its armed name
   * and the chats it was pointed at; the prompts and the wiring are the
   * imported copy's.
   *
   * Chats are re-armed by id, which round-trips exactly when the workflow is
   * the same one. When the far end changed its chats, the arming is dropped
   * rather than guessed at by position — pointing a run at the wrong existing
   * conversation is worse than pointing it at none.
   */
  function keepMatter(made, local) {
    const Wm = W();
    if (!made || !local) return made;
    const armed = str(local.name).trim() && str(local.name).trim() !== str(local.templateName).trim();
    if (armed) made.name = local.name; // still set up for this case
    made.docs = ((local.docs || []).map((d) => Object.assign({}, d)));
    made.pseudoKeyId = local.pseudoKeyId || null;
    made.runDate = local.runDate || null;
    made.usage = local.usage || null; // measured here, about this machine
    const was = new Map(
      (local.chats || []).filter((c) => c && c.startUrl).map((c) => [c.id, c.startUrl])
    );
    if (was.size)
      made.chats = (made.chats || []).map((c) =>
        was.has(c.id) ? Object.assign({}, c, { startUrl: was.get(c.id) }) : c
      );
    // Documents name the chats they go to; normalize drops any naming a chat
    // the imported copy no longer has.
    return Wm ? Wm.normalize(made) : made;
  }

  /**
   * Fold the bundle into the stored list. Every incoming workflow is rebuilt
   * through newWorkflow() — the same whitelist the export ran through, so a
   * file that has been edited by hand can only carry fields this build knows.
   *
   * A replaced workflow keeps its own id and its place in the list; a new one
   * keeps the bundle's id unless that id is somehow already taken here, in
   * which case it gets a fresh one rather than colliding.
   */
  function applyImport(existing, incoming, now, mkId) {
    const Wm = W();
    const list = (existing || []).slice();
    if (!Wm) return { list: list, added: 0, replaced: 0 };
    const at = typeof now === "number" ? now : 0;
    const taken = new Set(list.map((w) => w && w.id).filter(Boolean));
    let added = 0;
    let replaced = 0;
    for (const inc of incoming || []) {
      const hit = matchFor(list, inc);
      if (hit) {
        const at_ = list.indexOf(hit);
        // Its id and its place stay; everything else is the imported copy.
        // createdAt stays the local one — this row has been here since it has.
        const made = keepMatter(
          portable(Object.assign({}, inc, { id: hit.id, createdAt: hit.createdAt })),
          hit
        );
        if (!made) continue;
        made.updatedAt = at;
        list[at_] = made;
        replaced++;
        continue;
      }
      let id = str(inc && inc.id);
      if (!id || taken.has(id)) id = mkId ? mkId() : id || String(at) + "-" + list.length;
      const made = portable(Object.assign({}, inc, { id: id }));
      if (!made) continue;
      made.updatedAt = at;
      taken.add(id);
      list.push(made);
      added++;
    }
    return { list: list, added: added, replaced: replaced };
  }

  const api = {
    KIND,
    VERSION,
    portable,
    keepMatter,
    leftBehind,
    buildExport,
    fileName,
    parseBundle,
    matchFor,
    importPlan,
    applyImport,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMWfExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
