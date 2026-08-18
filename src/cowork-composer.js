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
 *   - the approval control's FINDERS (findApprovalTrigger/currentApproval —
 *     the label read is also part of surface evidence); the SWITCHING lives
 *     here, with a why on every exit, after a live run failed it with a bare
 *     "(failed)" that said nothing about which step died,
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

  // The box the editor lives in. The editor's near ancestors are PROVED too
  // narrow on this UI — a live dump showed ed.parentElement.parentElement
  // holding zero buttons, with no <form> and no class*="composer" anywhere
  // above it — so walk up until the box actually contains composer furniture
  // (a button, or the file input), and fall back to the whole body rather
  // than to a box that holds nothing.
  function scopeOf() {
    const ed = C.findEditor();
    if (!ed) return document.body || document;
    let el = ed.parentElement;
    for (let i = 0; el && i < 8; i++) {
      try {
        if (el.querySelector('button,input[type="file"]')) return el;
      } catch (e) {
        break;
      }
      el = el.parentElement;
    }
    return document.body || document;
  }

  // Chip-ish markup, counted page-wide minus our own UI. Chat's counter looks
  // inside a composer scope this UI does not have; the baseline delta taken in
  // attachFiles is what keeps page-wide counting honest — only chips that
  // APPEAR during the attach vouch for it.
  function pageChips() {
    const counts = [0];
    for (const sel of [
      '[data-testid="file-thumbnail"]',
      '[data-testid*="attachment" i]',
      '[data-testid*="file-chip" i]',
      "button h3",
    ]) {
      let n = 0;
      try {
        for (const el of document.querySelectorAll(sel)) if (!C.isOurs(el)) n++;
      } catch (e) {
        continue;
      }
      counts.push(n);
    }
    return Math.max.apply(null, counts);
  }

  // How many of these files' names the page is visibly carrying, counted on
  // leaf nodes anywhere except our own UI. Page-wide, deliberately: the live
  // run that forced this reported "0 filename(s)" on a composer the operator
  // could SEE holding the file — Cowork renders its chips outside every
  // container the editor anchors, so a scan scoped to the editor's box misses
  // them. The baseline delta (taken before the attach) keeps anything already
  // on the page — a project knowledge file, a note in our own pill — from
  // vouching for a new attachment. Truncation-tolerant: see CUMCowork.nameSeen.
  function namedCount(files) {
    let els;
    try {
      els = document.querySelectorAll("button,h3,span,div,[title]");
    } catch (e) {
      return 0;
    }
    // Chip containers, read WHOLE. A chip can spread its caption across
    // sibling spans (a truncation component renders the start and the end as
    // separate leaves), and then no single leaf carries enough of the name to
    // vouch for it.
    let chips;
    try {
      chips = document.querySelectorAll(
        '[data-testid="file-thumbnail"],[data-testid*="attachment" i],[data-testid*="file-chip" i],button'
      );
    } catch (e) {
      chips = [];
    }
    let n = 0;
    for (const f of files) {
      if (!f || !f.name) continue;
      let hit = false;
      for (const el of els) {
        if (el.children && el.children.length) continue; // leaves carry the caption
        if (C.isOurs(el)) continue;
        const title = (el.getAttribute && el.getAttribute("title")) || "";
        if (K.nameSeen(el.textContent || "", f.name) || K.nameSeen(title, f.name)) {
          hit = true;
          break;
        }
      }
      for (const el of hit ? [] : chips) {
        if (C.isOurs(el)) continue;
        if (K.nameSeen(el.textContent || "", f.name)) {
          hit = true;
          break;
        }
      }
      if (hit) n++;
    }
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

  // The send control. Cowork's composer starts a TASK: its button reads
  // "Start Task" where Chat's reads "Send message" — named by the operator
  // off the live page, after a run found nothing wearing any of Chat's
  // labels. Captions are judged by CUMCowork.isSendCaption (letters alone,
  // prefix-anchored, so "Restart task" can never press as sending), on the
  // aria-label and the visible text both, in the composer's box first and
  // page-wide after; Chat's shapes stay in the cascade for the day the two
  // surfaces converge.
  function findSendControl(scope) {
    const byCaption = (root) => {
      let list;
      try {
        list = (root || document).querySelectorAll('button,[role="button"]');
      } catch (e) {
        return null;
      }
      for (const el of list) {
        if (C.isOurs(el) || !C.isVisible(el)) continue;
        const aria = (el.getAttribute && el.getAttribute("aria-label")) || "";
        if (K.isSendCaption(aria) || K.isSendCaption(el.textContent)) return el;
      }
      return null;
    };
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
      byCaption(scope) ||
      byCaption(document) ||
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
    // A stored name can carry an old scrape's debris ("…Toggle chats for …");
    // matching forgives that, but the FILTER doesn't — typing the corrupted
    // string filters the list down to nothing. So the cleaned name is what
    // gets typed, matched, and reported. See K.wantedProjectName.
    name = K.wantedProjectName(name);
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

  // ---- the approval mode ---------------------------------------------------

  /**
   * Put Cowork's approval control on `mode`, saying WHY on every exit. The
   * old switcher answered a live failure with a bare "(failed)" — three
   * different failures wearing one face: the menu not opening, the row not
   * matching, and the click not verifiably taking are different problems with
   * different fixes, and the report is the only witness an unattended run has.
   *
   * Two other lessons applied here: a dispatched click is untrusted and does
   * not run activation behaviour everywhere (the toggle taught that — #170),
   * so the method click is the fallback; and a hidden Cowork tab renders LATE,
   * so the old two-second verification window could time out on a switch that
   * had actually taken — the windows here are longer, the row marking itself
   * checked counts as the page's word too, and there is one last look after
   * the menu closes. Returns { ok, why }.
   */
  async function selectApproval(mode) {
    const wanted = K.modeFromLabel(mode);
    if (!wanted) return { ok: true, why: "nothing asked for" };
    if (C.currentApproval() === wanted) return { ok: true, why: "already on it" };
    const trigger = C.findApprovalTrigger();
    if (!trigger) return { ok: false, why: "no approval control on this page" };

    const trouble = await C.openMenu(trigger, C.menuItems());
    if (trouble) {
      C.closeMenu();
      return { ok: false, why: "the menu: " + trouble };
    }

    const rowFor = () =>
      C.menuItems().find((el) => !C.isOurs(el) && K.rowIsMode(el.textContent, wanted)) || null;
    let row = rowFor();
    for (let i = 0; i < 12 && !row; i++) {
      await sleep(200);
      row = rowFor();
    }
    if (!row) {
      const saw = C.menuItems()
        .map((el) => norm(el.textContent).slice(0, 32))
        .filter(Boolean)
        .join(" | ");
      C.closeMenu();
      return {
        ok: false,
        why: "no row for " + K.labelForMode(wanted) + " — saw " + JSON.stringify(saw),
      };
    }

    const took = async (tries) => {
      for (let i = 0; i < tries; i++) {
        await sleep(400);
        const t = C.findApprovalTrigger();
        let checked = false;
        try {
          checked =
            row.getAttribute("aria-checked") === "true" ||
            row.getAttribute("data-state") === "checked";
        } catch (e) {
          /* a detached row answers nothing; the trigger still can */
        }
        if (
          K.approvalTook(
            { triggerLabel: t && t.getAttribute("aria-label"), rowChecked: checked },
            wanted
          )
        )
          return true;
      }
      return false;
    };

    C.robustClick(row);
    if (await took(8)) {
      C.closeMenu();
      return { ok: true, why: "clicked the row" };
    }
    try {
      if (typeof row.click === "function") row.click();
    } catch (e) {
      /* the final report says what the trigger reads */
    }
    if (await took(8)) {
      C.closeMenu();
      return { ok: true, why: "clicked the row (el.click())" };
    }
    C.closeMenu();
    // One last look. A switch that took after the window closed is still a
    // switch that took, and failing the send over a slow re-render would stop
    // a run whose page is in exactly the state it asked for.
    await sleep(600);
    const t = C.findApprovalTrigger();
    if (K.approvalTook({ triggerLabel: t && t.getAttribute("aria-label") }, wanted))
      return { ok: true, why: "took after the menu closed" };
    return {
      ok: false,
      why:
        "clicked the row both ways and the trigger still reads " +
        JSON.stringify((t && t.getAttribute("aria-label")) || "nothing"),
    };
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
    const baseChips = pageChips();
    const baseNamed = namedCount(files);
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
      const evidence = () =>
        K.attachOutcome({
          expected: files.length,
          uploads: uploads,
          chips: pageChips() - baseChips,
          named: namedCount(files) - baseNamed,
        });
      const watch = async (ms) => {
        // The first look is polite, not instant — chips render behind the
        // attach, and markup that already happens to match must not wave the
        // files through in the first moment.
        const until = Date.now() + ms;
        await sleep(2000);
        let v = evidence();
        while (!v.ok && Date.now() < until) {
          await sleep(700);
          v = evidence();
        }
        return v;
      };

      // The input first, then a drop ON TOP of it — never one or the other.
      // Cowork has been seen taking files from the input and has also been
      // seen ignoring it; a present-but-dead input must not use up the whole
      // deadline, so it gets a short watch and the drop gets the rest.
      const input = C.findFileInput();
      let how = "";
      let verdict = { ok: false, why: "no way in was tried" };
      if (input) {
        try {
          C.setFiles(input, files);
          how = "file input";
          verdict = await watch(20000);
        } catch (e) {
          how = "file input (threw)";
        }
      }
      if (!verdict.ok) {
        const scope = scopeOf();
        C.dropFiles(scope === document ? document.body : scope, files);
        how = how ? how + ", then drop" : "drop";
        // Scaled like Chat's: twenty papers need more than two minutes.
        verdict = await watch(Math.max(timeoutMs || 120000, files.length * 15000));
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
  async function confirmSent(hadText, humanBefore, pathBefore, hadButton) {
    for (let i = 0; i < 24; i++) {
      await sleep(400);
      const ed = C.findEditor();
      const btn = findSendControl(scopeOf());
      const ev = K.sentEvidence({
        becameSession: !!K.sessionId(location.pathname) && location.pathname !== pathBefore,
        humanGrew: humanTurns() > humanBefore,
        cleared: !!hadText && !!ed && (ed.textContent || "").trim() === "",
        // Only a control that was STANDING before the press can stand down.
        // With no control ever found this is vacuously true from the first
        // look, and would confirm an Enter that sent nothing.
        sendStoodDown: !!hadButton && (!btn || C.sendDisabled(btn)),
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
          r = await selectApproval(j.approval);
        } catch (e) {
          r = { ok: false, why: String((e && e.message) || e) };
        }
        if (!r.ok)
          return fail(
            "could not set approval to " + K.describeMode(j.approval) + " — " + r.why +
              " — not sent: the mode is remembered account-wide, and sending under one nobody chose is worse than waiting"
          );
        say("approval", K.describeMode(j.approval) + " (" + r.why + ")");
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
        // No control found is NOT the end: Enter in the editor is the
        // composer's own send and needs no button at all. The run that
        // taught this got everything right — project, attach, prompt — and
        // then died here without ever pressing the one key that would have
        // finished the job.
        if (btn && !C.sendDisabled(btn)) {
          C.robustClick(btn);
          const ev = await confirmSent(hadText, humanBefore, pathBefore, true);
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
        const ev2 = await confirmSent(hadText, humanBefore, pathBefore, !!btn);
        if (ev2) {
          say("send", ev2 + " (via Enter)");
          notes.push(story());
          const left = surfaceWas ? K.surfaceLeftNote(surfaceWas, false) : "";
          if (left) notes.push(left);
          return { ok: true, notes: notes };
        }
        return fail(
          !btn
            ? "no send control matched any known shape, and Enter sent nothing"
            : C.sendDisabled(btn)
            ? "the send control never enabled (uploads may still be processing, or the composer rejected the message), and Enter sent nothing"
            : "pressed send, then Enter, and nothing showed the message leaving"
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
