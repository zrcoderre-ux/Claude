/**
 * Claude Usage Meter — Cowork send driver (ISOLATED world content script).
 *
 * Cowork gets its own send path, parallel to the Chat one in src/composer.js.
 * The standing rule: nothing built for Chat is assumed to work on Cowork until
 * it has been SEEN working on Cowork. The run that taught this switched its
 * model and then silently did nothing else — the project was never chosen and
 * the message never left, because everything after the model menu was Chat
 * plumbing being trusted on a surface that had never confirmed it.
 *
 * What this driver borrows from src/composer.js is only what is either
 * surface-agnostic mechanics (sleep, robustClick, menu open/close, visibility)
 * or has been confirmed working on Cowork itself:
 *   - the Chat/Cowork toggle (selectSurface — built for and proved on Cowork),
 *   - the approval menu (selectApproval — the control only exists on Cowork),
 *   - the model menu (selectModel — seen switching models on a live Cowork run).
 * Everything else — choosing the project, attaching files, confirming the
 * attachments, typing the prompt, pressing send, and proving the message left —
 * is done here, with Cowork's own evidence, and reported phase by phase so a
 * run that stops says exactly WHERE it stopped instead of stopping silently.
 *
 * The decisions (which phases apply, what counts as an attachment landing,
 * what counts as a message leaving) live in src/cowork.js, pure and tested.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  const K = window.CUMCowork;
  if (!C || !K) return;

  const sleep = C.sleep;
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

  /**
   * Should this driver take the send? Yes when the job asks for Cowork, when
   * the page is a Cowork address, or when the composer in front of us is on
   * Cowork and the job expressed no preference. A job that asks for Chat is
   * never ours — the Chat driver flips the toggle itself.
   */
  function applies(o) {
    const j = o || {};
    const want = K.surfaceFromLabel(j.surface || "");
    if (want === "chat") return false;
    if (want === "cowork") return true;
    if (K.isCoworkUrl(location.href)) return true;
    try {
      return C.currentSurface() === "cowork";
    } catch (e) {
      return false;
    }
  }

  // ---- Cowork's composer ---------------------------------------------------

  // The box the editor lives in — the scope chips, filenames and the send
  // control are looked for in, so a project's knowledge files elsewhere on the
  // page can't stand in for an attachment.
  function scopeOf() {
    const ed = C.findEditor();
    if (!ed) return document;
    return (
      ed.closest("form") ||
      ed.closest('[class*="composer" i]') ||
      (ed.parentElement && ed.parentElement.parentElement) ||
      document
    );
  }

  // How many of these files' names the composer is visibly carrying. Cowork's
  // chip markup is unconfirmed, so the filenames themselves are the evidence
  // of last resort — a name like "combined-documents.txt" does not appear in a
  // composer by coincidence. Truncation-tolerant: see CUMCowork.nameSeen.
  function namesVisible(scope, files) {
    let n = 0;
    let text = "";
    try {
      text = (scope || document).textContent || "";
    } catch (e) {
      return 0;
    }
    for (const f of files) if (f && K.nameSeen(text, f.name)) n++;
    return n;
  }

  function humanTurns() {
    let n = 0;
    for (const sel of [
      '[data-testid="user-message"]',
      ".font-user-message",
      '[data-testid="human-message"]',
    ]) {
      try {
        n = Math.max(n, document.querySelectorAll(sel).length);
      } catch (e) {
        /* try the next shape */
      }
    }
    return n;
  }

  // The send control, looked for inside the composer first. Cowork has not
  // confirmed Chat's exact labels, so the cascade is wider here — but only
  // inside the composer's own box, where "send" can't mean anything else.
  function findSendControl(scope) {
    const inScope = (sel) => {
      let list;
      try {
        list = (scope || document).querySelectorAll(sel);
      } catch (e) {
        return null;
      }
      for (const el of list) if (!C.isOurs(el) && C.isVisible(el)) return el;
      return null;
    };
    return (
      inScope('button[aria-label*="send" i]') ||
      inScope('[data-testid="send-button"]') ||
      inScope('button[type="submit"]') ||
      C.findSend()
    );
  }

  // ---- choosing the project ------------------------------------------------

  /**
   * Choose a project from Cowork's menu, the wide way. The Chat driver's
   * version looked at literal <button> elements only; when claude.ai stops
   * rendering one, that version reports an empty page and the job sails on
   * without its project. Here anything that behaves like a menu trigger
   * counts — button, [role="button"], [role="combobox"] — and a failure names
   * the captions that WERE on the page, so the next shape change is a small
   * edit rather than an investigation.
   *
   * The rows that navigate away ("Create new project", "View all projects")
   * stay excluded by name; during an unattended send a click that navigates is
   * not a near miss, it is the end of the run. Returns { ok, why }.
   */
  async function selectProject(name) {
    const caption = (b) =>
      norm(b.textContent) || norm(b.getAttribute && b.getAttribute("aria-label"));
    const opensAMenu = (b) =>
      (b.hasAttribute &&
        (b.hasAttribute("aria-haspopup") ||
          b.hasAttribute("aria-expanded") ||
          b.hasAttribute("aria-controls"))) ||
      (b.getAttribute && String(b.getAttribute("role")).toLowerCase() === "combobox");
    const candidates = Array.from(
      document.querySelectorAll('button,[role="button"],[role="combobox"]')
    ).filter((b) => !C.isOurs(b) && C.isVisible(b) && opensAMenu(b));

    let trigger = candidates.find((b) => K.projectTriggerIs(caption(b), name));
    if (trigger) return { ok: true, why: "the trigger already reads " + JSON.stringify(name) };
    trigger = candidates.find((b) => K.isProjectTriggerCaption(caption(b)));
    if (!trigger)
      return {
        ok: false,
        why:
          "no project menu — none of the " + candidates.length +
          " menu controls on the page is captioned like one (saw " +
          JSON.stringify(candidates.map(caption).filter(Boolean).slice(0, 12).join(" | ")) +
          ")",
      };

    const trouble = await C.openMenu(trigger, C.menuItems());
    if (trouble) {
      C.closeMenu();
      return { ok: false, why: trouble };
    }

    // Only ever inside the menu — falling back to the document would find the
    // composer's own editor and type the project's name into the prompt.
    const rows = C.menuItems();
    const holder = (el) => el && rows.some((r) => el.contains(r));
    const box =
      Array.from(
        document.querySelectorAll('[role="listbox"],[role="menu"],[role="dialog"]')
      ).find(holder) || null;
    if (!box) {
      C.closeMenu();
      return { ok: false, why: "rows opened but nothing recognisable holds them" };
    }
    // A long list renders only what fits, so the filter isn't a nicety: a
    // project far down it is not in the page to be clicked until typing brings
    // it there.
    const filter = box.querySelector('input:not([type="hidden"]), [contenteditable="true"]');
    if (filter) {
      try {
        filter.focus();
        const typed = document.execCommand && document.execCommand("insertText", false, name);
        if (!typed && "value" in filter) {
          filter.value = name;
          filter.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } catch (e) {
        /* an unfiltered list is still a list */
      }
      await sleep(700);
    }

    let lastSeen = [];
    const rowOf = () => {
      const seen = [];
      for (const el of box.querySelectorAll(
        '[role="option"],[role="menuitem"],[role="menuitemradio"]'
      )) {
        if (C.isOurs(el)) continue;
        const t = el.textContent || "";
        if (!K.isProjectRow(t)) continue; // never "Create new project" — it navigates
        seen.push(norm(t).slice(0, 40));
        if (K.projectRowMatches(t, name)) return el;
      }
      lastSeen = seen;
      return null;
    };
    let row = rowOf();
    for (let i = 0; i < 12 && !row; i++) {
      await sleep(200);
      row = rowOf();
    }
    if (!row) {
      C.closeMenu();
      return {
        ok: false,
        why:
          "no row named " + JSON.stringify(name) + " among " +
          JSON.stringify(lastSeen.join(" | ")) +
          (filter ? " (filtered)" : " (no filter box found)"),
      };
    }
    C.robustClick(row);

    // Believed only when a trigger comes round to reading the name — a menu
    // that closed is not a project that was chosen.
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      const live = Array.from(
        document.querySelectorAll('button,[role="button"],[role="combobox"]')
      ).filter((b) => !C.isOurs(b));
      if (live.some((b) => K.projectTriggerIs(caption(b), name)))
        return { ok: true, why: "chose it from the menu" };
    }
    C.closeMenu();
    return { ok: false, why: "clicked the row but no control came to read " + JSON.stringify(name) };
  }

  // ---- attaching, with Cowork's evidence -----------------------------------

  /**
   * Attach `files` and confirm they landed. Chat's confirmation leans on the
   * upload responses inject.js sees; Cowork's uploads run inside its worker
   * where no hook reaches, so here the confirmations are welcome when they
   * arrive and never waited on: the composer visibly carrying the files —
   * chips, or the filenames themselves — is the evidence that exists. See
   * CUMCowork.attachOutcome for the decision.
   */
  async function attachFiles(files, timeoutMs) {
    const scope = scopeOf();
    const baseChips = C.countChips();
    const baseNamed = namesVisible(scope, files);
    let uploads = 0;
    const onMsg = (event) => {
      if (event.source !== window) return;
      const m = event.data;
      if (m && m.__channel === C.CHANNEL && m.payload && m.payload.upload && m.payload.upload.success)
        uploads++;
    };
    try {
      window.addEventListener("message", onMsg);
    } catch (e) {
      /* uploads stays 0; the visible evidence still counts */
    }
    try {
      const input = C.findFileInput();
      let how;
      if (input) {
        C.setFiles(input, files);
        how = "file input";
      } else {
        C.dropFiles(scope === document ? document.body : scope, files);
        how = "drop";
      }
      // Scaled like Chat's: twenty papers need more than two minutes.
      const deadline = Date.now() + Math.max(timeoutMs || 120000, files.length * 15000);
      // The first look is polite, not instant — chips render behind the
      // attach, and markup that already happens to match must not wave the
      // files through in the first moment.
      await sleep(2000);
      let verdict = K.attachOutcome({ expected: files.length, uploads: uploads, chips: 0, named: 0 });
      while (Date.now() < deadline) {
        verdict = K.attachOutcome({
          expected: files.length,
          uploads: uploads,
          chips: C.countChips() - baseChips,
          named: namesVisible(scopeOf(), files) - baseNamed,
        });
        if (verdict.ok) break;
        await sleep(500);
      }
      // A moment more, so the send can't beat the last chip onto the composer.
      if (verdict.ok) await sleep(1500);
      return { ok: verdict.ok, how: how, why: verdict.why };
    } finally {
      try {
        window.removeEventListener("message", onMsg);
      } catch (e) {
        /* ignore */
      }
    }
  }

  // ---- the send itself -----------------------------------------------------

  // Watch for the message leaving, with Cowork's evidence — see
  // CUMCowork.sentEvidence for what counts and in what order of strength.
  async function confirmSent(hadText, humanBefore, pathBefore) {
    for (let i = 0; i < 24; i++) {
      await sleep(400);
      const ed = C.findEditor();
      const btn = findSendControl(scopeOf());
      const ev = K.sentEvidence({
        becameSession: !!K.sessionId(location.pathname) && location.pathname !== pathBefore,
        humanGrew: humanTurns() > humanBefore,
        cleared: !!hadText && !!ed && (ed.textContent || "").trim() === "",
        sendStoodDown: !btn || C.sendDisabled(btn),
      });
      if (ev) return ev;
    }
    return "";
  }

  /**
   * One composed Cowork message, end to end. Same contract as the Chat
   * driver's sendMessage — { ok, error?, halted?, notes } — but every phase
   * reports, and a phase that fails fails the SEND, loudly, rather than
   * leaving a note and sailing on: a message sent into the wrong project, or
   * under an approval mode nobody chose, is worse than one that waits.
   */
  async function send(o) {
    const j = o || {};
    const notes = [];
    const trail = [];
    const say = (phase, outcome) => trail.push(phase + ": " + outcome);
    const story = () => "cowork send — " + trail.join("; ");
    const fail = (error) => ({ ok: false, error: error + " [" + story() + "]", notes: notes });
    const halted = () => {
      try {
        return typeof j.stop === "function" ? j.stop() : null;
      } catch (e) {
        return null;
      }
    };
    const standDown = (why) => ({ ok: false, halted: why, error: "stopped — " + why, notes: notes });

    const files = j.files || [];
    if (!j.text && !files.length) return { ok: false, error: "nothing to send", notes: notes };
    let why = halted();
    if (why) return standDown(why);

    // A Cowork page keeps booting well past document-complete; give the
    // composer real time before concluding it isn't there.
    let editor = await C.waitFor(C.findEditor, 25000);
    if (!editor) return fail("no prompt editor on this Cowork page");
    say("editor", "found");

    // The toggle only exists on the composer home; inside a conversation there
    // is no surface to choose and no project menu to open.
    const onHome = !!C.findSurfaceGroup();
    const phases = K.coworkPhases({
      onSession: !onHome,
      approval: !!j.approval,
      project: !!j.coworkProject,
      model: !!j.model,
      files: !!files.length,
      text: !!j.text,
    });
    if (!onHome && j.coworkProject)
      notes.push("project not chosen — this page is already inside a conversation");

    // What the toggle was on before we touched it, for the note a changed
    // account-wide preference owes the user.
    let surfaceWas = "";

    for (const phase of phases) {
      why = halted();
      if (why) return standDown(why);

      if (phase === "surface") {
        try {
          surfaceWas = C.currentSurface();
        } catch (e) {
          surfaceWas = "";
        }
        const r = await C.selectSurface("cowork");
        if (r !== "ok")
          return fail("could not put the composer on Cowork (" + C.surfaceWhy() + ")");
        if (surfaceWas === "cowork") surfaceWas = "";
        say("surface", surfaceWas ? "switched from " + surfaceWas : "on Cowork");
        // Switching re-renders the composer; a handle held across it is stale.
        editor = (await C.waitFor(C.findEditor, 15000)) || editor;
      } else if (phase === "approval") {
        let r;
        try {
          r = await C.selectApproval(j.approval);
        } catch (e) {
          r = "failed";
        }
        if (r !== "ok" && r !== "inherit")
          return fail(
            "could not set approval to " + K.describeMode(j.approval) + " (" + r +
              ") — not sent: the mode is remembered account-wide, and sending under one nobody chose is worse than waiting"
          );
        say("approval", K.describeMode(j.approval));
      } else if (phase === "project") {
        const r = await selectProject(j.coworkProject);
        if (!r.ok)
          return fail(
            'project "' + j.coworkProject + '" not chosen — ' + r.why +
              " — not sent: a message that lands outside its project is worse than one that waits"
          );
        say("project", JSON.stringify(j.coworkProject) + " (" + r.why + ")");
      } else if (phase === "model") {
        let r;
        try {
          r = await C.selectModel(j.model);
        } catch (e) {
          r = "failed";
        }
        if (r === "ok") say("model", j.model);
        else {
          // Survivable, like on Chat: the send goes on the model the page is
          // on, and the note says so.
          notes.push('model "' + j.model + '" not selected (' + r + ") — sent on the current one");
          say("model", "not selected (" + r + ")");
        }
      } else if (phase === "attach") {
        const att = await attachFiles(files, j.uploadTimeoutMs);
        if (!att.ok)
          return fail(
            "could not confirm " + files.length + " attachment(s) landed via " + att.how +
              " — " + att.why
          );
        say("attach", files.length + " file(s) via " + att.how + " (" + att.why + ")");
        notes.push("attached " + files.length + " document(s) via " + att.how + " (" + att.why + ")");
        await sleep(600);
      } else if (phase === "prompt") {
        // Menus re-render the composer; never type into a stale handle.
        editor = C.findEditor() || editor;
        C.insertPrompt(editor, j.text);
        await sleep(400);
        const holds =
          (((C.findEditor() || editor).textContent) || "").indexOf(j.text.trim().slice(0, 8)) !== -1;
        if (!holds) return fail("typed the prompt but the editor never took it");
        say("prompt", j.text.length + " chars in the editor");
      } else if (phase === "send") {
        why = halted();
        if (why) return standDown(why);
        const scope = scopeOf();
        const humanBefore = humanTurns();
        const pathBefore = location.pathname;
        const hadText = (((C.findEditor() || editor).textContent) || "").trim();

        // claude.ai holds the control disabled until its uploads finish, which
        // is the upload gate Cowork's hidden traffic denies us — so this wait
        // is doing real work, not politeness.
        let btn = null;
        const untilEnabled = Date.now() + 30000;
        while (Date.now() < untilEnabled) {
          btn = findSendControl(scope);
          if (btn && !C.sendDisabled(btn)) break;
          await sleep(300);
        }
        if (!btn) return fail("no send control found in the Cowork composer");

        if (!C.sendDisabled(btn)) {
          C.robustClick(btn);
          const ev = await confirmSent(hadText, humanBefore, pathBefore);
          if (ev) {
            say("send", ev);
            notes.push(story());
            const left = surfaceWas ? K.surfaceLeftNote(surfaceWas, false) : "";
            if (left) notes.push(left);
            return { ok: true, notes: notes };
          }
        }
        // Enter in the editor, which claude.ai also sends on.
        const ed = C.findEditor() || editor;
        try {
          ed.focus();
          for (const t of ["keydown", "keypress", "keyup"])
            ed.dispatchEvent(
              new KeyboardEvent(t, {
                bubbles: true,
                cancelable: true,
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
              })
            );
        } catch (e) {
          /* the report below says what was observed */
        }
        const ev2 = await confirmSent(hadText, humanBefore, pathBefore);
        if (ev2) {
          say("send", ev2 + " (via Enter)");
          notes.push(story());
          const left = surfaceWas ? K.surfaceLeftNote(surfaceWas, false) : "";
          if (left) notes.push(left);
          return { ok: true, notes: notes };
        }
        return fail(
          C.sendDisabled(btn)
            ? "the send control never enabled (uploads may still be processing, or the composer rejected the message)"
            : "pressed send but nothing showed the message leaving"
        );
      }
    }
    // Every phase list ends in "send", so this line is unreachable — kept so a
    // future edit that breaks that invariant fails loudly instead of returning
    // undefined.
    return fail("send phase never ran");
  }

  window.CUMCoworkSend = { applies: applies, send: send, selectProject: selectProject };
})();
