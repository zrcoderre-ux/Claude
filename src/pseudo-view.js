/**
 * Claude Usage Meter — pseudonym translation on claude.ai (ISOLATED world).
 *
 * The decisions live in src/pseudo.js (pure, tested); this is the wiring.
 * Three jobs, one key:
 *
 *   1. DISPLAY translation. In a conversation a pseudonym key is attached to
 *      (through the popup, or riding a workflow run), every fake in the
 *      rendered messages — and in the chat's own TITLE, in the header, in the
 *      sidebar and on the tab — is swapped for its real value — READ side
 *      only. The stored title stays the fake claude.ai was given: the swap is
 *      this tab's rendering, and everything that NAMES something from the
 *      title (Save chat's filename, the scheduler's "this chat") reads it
 *      back through CUMPseudoView.docTitle, which answers what claude.ai
 *      wrote.
 *
 *      Claude's own state is untouched: the swap edits text nodes in message
 *      turns and titles, never the composer. The KEY BUTTON beside Save
 *      (src/key-panel.js) says translation is on and counts the swaps, so what
 *      you see is never silently different from what Claude sees — this module
 *      publishes state()/clean()/setPaused()/subscribe() for it and draws no
 *      furniture of its own beyond the two warnings. While a run is moving,
 *      the MESSAGES stand down to the fakes and the titles do not — a hand-off
 *      can fall back to a rendered message, and nothing reads a title off the
 *      screen at all.
 *
 *   2. The COMPOSER warning. While a key is attached, the draft message is
 *      watched for REAL values from the key; each one found gets a loud
 *      banner naming the fake to use instead. Warn, never rewrite — the
 *      composer belongs to the user.
 *
 *      Anything else on the page you can TYPE INTO is the composer for this
 *      purpose, and Claude's draft-email card is the case that raised it: it
 *      renders inside the reply but is editable in place, so what it holds is
 *      what would be sent. Translating it would put the real names into the
 *      thing that leaves — back through Claude and out to a recipient — which
 *      is precisely what the key exists to prevent. So it stays in the fakes,
 *      and that is a deliberate limitation the repo owner has accepted rather
 *      than a gap to close (skippable() below is what holds it). Do not make
 *      an editable surface translate.
 *
 *   3. The KEY-UPLOAD guard, active on every claude.ai page whether or not a
 *      key is attached anywhere. The key spreadsheet is the whole real↔fake
 *      map, so it must never ride an upload into a chat by accident: a file
 *      picked, dropped or pasted that is pseudonym_key*.xlsx by name — or any
 *      .xlsx whose sheets carry the key's header fingerprint — is held back
 *      and only goes through on an affirmative "Upload anyway". Other files
 *      in the same batch pass through untouched.
 *
 * Cowork note (see CLAUDE.md): the guard intercepts the page's file-chooser,
 * drop and paste events, which are generic DOM mechanics — but it is CONFIRMED
 * only on Chat. Cowork's upload traffic runs in a worker no page hook sees, so
 * treat the guard there as best-effort until seen working.
 */
(function () {
  "use strict";

  const P = window.CUMPseudo;
  const X = window.CUMXlsx;
  const M = window.CUMMasterKey;
  if (!P || !X) return;

  const KEYS_KEY = "cum_pseudo_keys"; // id -> parsed key (see popup.js)
  const CHATS_KEY = "cum_pseudo_chats"; // conversation key -> key id
  const MASTER_KEY = "cum_pseudo_master"; // the last 20 cases (see masterkey.js)
  // The id the master key answers to. Not a library id — nothing is stored
  // under it — so every lookup into `keys` has to go through masterOr().
  const MASTER_ID = "cum-master-key";

  const MSG_SEL =
    '[data-testid="user-message"],[data-testid="assistant-message"],' +
    ".font-user-message,.font-claude-response,.font-claude-message";

  // Where a chat's NAME is written. The header one is this conversation's; the
  // links are other conversations, each of which gets its own chat's key
  // rather than this one's. Text nodes only, never attributes: the Cowork
  // rename confirms itself by reading the title control's aria-label, and that
  // label has to keep saying what claude.ai stored — the fake.
  const HEAD_TITLE_SEL =
    '[data-testid="chat-menu-trigger"],[data-testid="conversation-title"],' +
    '[data-testid="chat-title"],header h1,header h2,' +
    '[aria-label*="rename session" i]';
  const CONV_LINK_SEL = 'a[href*="/chat/"],a[href*="/cowork/"],a[href*="/code/"]';

  // ---- which key this conversation gets -----------------------------------

  let keys = {}; // the stored key library
  let chatMap = {}; // conversation -> key id
  let runsCache = { at: 0, runs: [], groups: [], beats: {} };
  const RUNS_TTL_MS = 20000;

  let active = null; // { id, key, compiled, compiledReals, via }
  let lastConv = null;

  function convKey() {
    const W = window.CUMWorkflow;
    return W && W.conversationKey
      ? W.conversationKey(location.href)
      : P.conversationKeyFromUrl(location.href);
  }

  function storageGet(what) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(what, (r) => resolve(r || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  // The runs, their groups, and the heartbeats of the ones claiming to be
  // moving — the hold below reads its ceiling off those. Beats are fetched only
  // for running runs: the key is rewritten every 20 seconds, and carrying it for
  // runs that finished last week would be a read per tab for nothing.
  async function refreshRuns(force) {
    const W = window.CUMWorkflow;
    if (!W || !W.RUN_IDS_KEY) return runsCache;
    if (!force && Date.now() - runsCache.at < RUNS_TTL_MS) return runsCache;
    const idsRes = await storageGet([W.RUN_IDS_KEY, "cum_run_groups"]);
    const ids = idsRes[W.RUN_IDS_KEY] || [];
    const runs = [];
    if (ids.length) {
      const res = await storageGet(ids.map((id) => W.RUN_PREFIX + id));
      for (const id of ids) if (res[W.RUN_PREFIX + id]) runs.push(res[W.RUN_PREFIX + id]);
    }
    const beats = {};
    const live = runs.filter((r) => r && r.status === "running");
    if (live.length && W.beatKey) {
      const res = await storageGet(live.map((r) => W.beatKey(r.id)));
      for (const r of live) beats[r.id] = res[W.beatKey(r.id)] || 0;
    }
    runsCache = {
      at: Date.now(),
      runs: runs,
      groups: idsRes.cum_run_groups || [],
      beats: beats,
    };
    return runsCache;
  }

  // A run carries its key the way it carries its documents — on the run. Any
  // run whose recorded chats include this conversation attaches its key here
  // without the popup being involved — and a run with no key of its own
  // answers to its GROUP's: related runs are one matter, and one matter has
  // one key (W.runPseudoKey settles whose wins).
  async function runKeyFor(conv) {
    const W = window.CUMWorkflow;
    if (!W || !W.RUN_IDS_KEY) return null;
    await refreshRuns(false);
    return runKeyIdSync(conv);
  }

  // The same answer off the runs already in hand. The title sweep asks it once
  // per conversation on screen, and a storage read per row per sweep is not a
  // thing to do to a sidebar.
  function runKeyIdSync(conv) {
    const W = window.CUMWorkflow;
    if (!W || !W.RUN_IDS_KEY || !conv) return null;
    for (const run of runsCache.runs) {
      if (!run) continue;
      const chats = run.chats || {};
      for (const cid of Object.keys(chats)) {
        const url = chats[cid] && chats[cid].url;
        if (url && P.conversationKeyFromUrl(url) === conv) {
          const id = W.runPseudoKey
            ? W.runPseudoKey(run, runsCache.runs, runsCache.groups || [])
            : run.pseudoKeyId;
          if (id) return id;
        }
      }
    }
    return null;
  }

  async function resolveActive(force) {
    const conv = convKey();
    // With a key active, only a navigation matters; without one, keep looking —
    // a run records this conversation's URL a beat after opening it.
    if (!force && conv === lastConv && active) return;
    if (conv !== lastConv) {
      // A different chat: the peek, and the key the badge was naming for the
      // titles, both belonged to the one we left.
      paused = false;
      titleKeyId = null;
      restoreDocTitle();
    }
    lastConv = conv;
    let id = conv ? chatMap[conv] : null;
    let via = "chat";
    if (!id && conv) {
      id = await runKeyFor(conv);
      via = "run";
    }
    const key = id ? keys[id] : null;
    if (!key) {
      if (active) {
        active = null;
        setHold(null);
        render();
      }
      return;
    }
    // Same key object, same chat → nothing to rebuild. A RELOADED key is a new
    // object under the same id, so it falls through and recompiles.
    if (active && active.id === id && active.conv === conv && active.key === key) return;
    active = {
      id: id,
      conv: conv,
      key: key,
      compiled: P.compile(key),
      compiledReals: P.compileReals(key),
      // real → fake, for the badge's cleaner box.
      forward: P.compileForward(key),
      // the as-you-type prompt's entries (press → to swap).
      ahead: P.compileTypeahead(key),
      via: via,
    };
    // Out with the old map's work before the memo that explains it is dropped:
    // a swap nothing can put back is a real name stranded on screen under a
    // key that no longer says why.
    restoreFakes();
    swapped = new WeakMap();
    titleClaim = new WeakMap();
    shown = 0;
    paused = false; // a peek never outlives its chat
    // A different key means a different map, and a cleaner still holding the
    // last case's answer would be worse than an empty one. The panel clears
    // its own boxes off the key id in the state below — this side no longer
    // knows what the cleaner looks like, which is the point of the seam.
    render();
    sweepSoon();
    // The hold belongs to the RUN rather than to the tab, so a chat arrived at
    // mid-run is held from the first sweep — not from the next run write.
    refreshHold(true);
  }

  async function loadState() {
    const res = await storageGet([KEYS_KEY, CHATS_KEY, MASTER_KEY]);
    // A key loaded, replaced or attached elsewhere changes what every title on
    // this page should read. Put back what we wrote under the old library
    // before adopting the new one — a swap left standing under a map that no
    // longer explains it is exactly the silent difference the badge promises
    // there isn't.
    restoreFakes();
    swapped = new WeakMap();
    compiledLib = null;
    fwdById = new Map();
    realsById = new Map();
    titleClaim = new WeakMap();
    keys = res[KEYS_KEY] || {};
    chatMap = res[CHATS_KEY] || {};
    setMaster(res[MASTER_KEY]);
    await resolveActive(true);
  }

  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch[KEYS_KEY] || ch[CHATS_KEY] || ch[MASTER_KEY]) loadState();
      else if (
        ch.cum_run_groups ||
        Object.keys(ch).some((k) => k.indexOf("cum_wf_run") === 0)
      ) {
        // Every run write lands here — including the one that starts a run and
        // the one that pauses, fails or finishes it. This is what makes the
        // hold immediate in both directions rather than something a poll
        // catches up with a step later.
        runsCache.at = 0;
        // A run can be what attaches a key to a chat, so the claims the titles
        // made under the old run state are asked again.
        titleClaim = new WeakMap();
        resolveActive(true).then(() => refreshHold(true));
      }
    });
  } catch (e) {
    /* translation stays off */
  }

  // ---- display translation --------------------------------------------------

  // node -> the text this script last wrote there, so re-observing our own
  // write (or React writing the same fake back mid-stream) never loops.
  let swapped = new WeakMap();
  let shown = 0; // occurrences currently swapped, for the badge
  let sweepTimer = null;

  function skippable(el) {
    if (!el) return true;
    if (el.closest('[contenteditable="true"],input,textarea,script,style')) return true;
    if (el.closest('[class*="cum-pseudo"]')) return true;
    // The extension's own furniture — the pill, the panels, the run list —
    // says what it says; it is not claude.ai's rendering to translate.
    if (el.closest('[id^="cum-"],[class*="cum-"]')) return true;
    return false;
  }

  // ---- one element's text nodes ---------------------------------------------
  //
  // The memo is per NODE and carries three things: what we wrote, what
  // claude.ai wrote, and how many swaps that was. Re-observing our own write
  // (or React writing the same fake back mid-stream) is then a no-op rather
  // than a loop, the peek has the original to put back, and a node that
  // matched nothing is remembered too so a long conversation isn't re-scanned
  // node by node on every streaming tick.
  /**
   * A text walker that can REJECT a whole subtree in one question rather than
   * asking the same one of every text node inside it.
   *
   * That difference is what makes a page-wide pass affordable: skippable()
   * costs three closest() calls, and a conversation is mostly text nodes but
   * comparatively few branches worth pruning.
   */
  function textWalker(root, prune) {
    if (!prune) return document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    return document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (n) =>
          n.nodeType === 1
            ? prune(n)
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_SKIP
            : NodeFilter.FILTER_ACCEPT,
      }
    );
  }

  function swapIn(el, compiled) {
    if (!el || !compiled || !compiled.rx) return 0;
    let total = 0;
    const walker = textWalker(el);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      if (!text || text.length < 2) continue;
      const prior = swapped.get(node);
      if (prior && prior.text === text) {
        total += prior.count;
        continue;
      }
      if (skippable(node.parentElement)) continue;
      const r = P.translate(compiled, text);
      if (r.count > 0) {
        node.nodeValue = r.text;
        swapped.set(node, { text: r.text, orig: text, count: r.count });
        total += r.count;
      } else {
        swapped.set(node, { text: text, orig: text, count: 0 });
      }
    }
    return total;
  }

  function restoreIn(el, prune) {
    if (!el) return;
    const walker = textWalker(el, prune);
    let node;
    while ((node = walker.nextNode())) {
      const p = swapped.get(node);
      if (p && p.count > 0 && node.nodeValue === p.text) {
        node.nodeValue = p.orig;
        swapped.delete(node);
      }
    }
  }

  // What claude.ai wrote in this element, whatever this tab is showing — the
  // memo's originals where we have swapped, the live text where we haven't.
  // Every question about WHOSE title this is has to be asked of the fake: ask
  // it of a translated title and the key that translated it no longer
  // recognises its own work.
  function originalText(el) {
    let out = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const p = swapped.get(node);
      out += p && p.text === node.nodeValue ? p.orig : node.nodeValue;
    }
    return out;
  }

  // Paused = "let me peek at what claude.ai is actually showing": the fakes
  // are put back and no new text is translated until resumed. Per-tab and
  // deliberately NOT persisted — a peek that silently outlived the visit
  // would be a translation quietly off. The composer warning, the typeahead
  // and the upload guard stay on: they are safety, not display.
  let paused = false;

  // The other way the display stands down, and this one is not the user's
  // choice: while a workflow run is MOVING through this chat (or through this
  // chat's matter), the MESSAGES show the fakes, because a run's hand-off can
  // fall back to the rendered message and the rendered message is what we
  // rewrite — see P.runTranslationHold, which owns the decision. It covers the
  // messages and nothing else (see translationOff/titlesOff below). Held is a
  // reading of the run's status rather than a switch: pause the run, or let it
  // fail, hold or finish, and the real names come back on their own.
  let hold = null; // { runId, name, via } or null

  // The MESSAGES stand down for either reason. The TITLES stand down only for
  // the peek, and the difference is the whole point of the run's hold: it
  // exists because a run's hand-off can fall back to the RENDERED MESSAGE and
  // paste it into the next chat. Nothing reads a title that way — the Chat
  // rename asks the conversation API what it is called, the Cowork one reads
  // the control's aria-label (never translated), and the title a run WRITES is
  // its own name run through the key by the worker (background.js,
  // chatTitleFor). So there is nothing for a real name in a title to ride, and
  // holding it only cost the reader the one line telling them which case they
  // are looking at, at exactly the moment a run is moving through it.
  function translationOff() {
    return paused || !!hold;
  }

  function titlesOff() {
    return paused; // the peek is a choice about the display; a run's hold isn't
  }

  // Put back the fakes exactly as claude.ai rendered them.
  function restoreMessages() {
    for (const turn of document.querySelectorAll(MSG_SEL)) restoreIn(turn);
    shown = 0;
  }

  function restoreTitles() {
    for (const t of titleTargets()) restoreIn(t.el);
    restoreLoose();
    restoreDocTitle();
    titleShown = 0;
  }

  // Everything, for the moments when the MAP changes rather than the display:
  // a swap whose memo is about to be dropped has to go back first.
  function restoreFakes() {
    restoreMessages();
    restoreTitles();
  }

  function applyTranslationState() {
    if (translationOff()) restoreMessages();
    if (titlesOff()) restoreTitles();
    else sweepSoon();
    render();
  }

  function setPaused(on) {
    // A peek is a choice about the display; the run's hold is not one to make.
    if (hold) return;
    paused = !!on;
    applyTranslationState();
  }

  function setHold(next) {
    const before = hold ? hold.runId + "|" + hold.via : "";
    const after = next ? next.runId + "|" + next.via : "";
    if (before === after) return;
    hold = next || null;
    applyTranslationState();
  }

  // Recomputed from the runs themselves — on every run write (the storage
  // listener), and on a timer WHILE HELD so the ceiling can end a hold whose
  // driver died without one.
  async function refreshHold(force) {
    const mine = active;
    if (!mine) return setHold(null);
    const W = window.CUMWorkflow;
    if (!W || !W.RUN_IDS_KEY) return setHold(null);
    // The TTL does the pacing while held — forcing a re-read on every tick
    // would be a storage read a second, per tab, for a ceiling measured in
    // minutes.
    await refreshRuns(!!force);
    // Navigated (or the key changed) while we were reading: this answer is
    // about a chat that isn't on screen any more, and applying it would hold
    // the wrong one.
    if (active !== mine) return;
    setHold(
      P.runTranslationHold(runsCache.runs, {
        conv: mine.conv,
        keyId: mine.id,
        beats: runsCache.beats,
        keyIdFor: (r) =>
          W.runPseudoKey ? W.runPseudoKey(r, runsCache.runs, runsCache.groups || []) : r.pseudoKeyId,
      })
    );
  }

  function sweep() {
    sweepTimer = null;
    let total = 0;
    if (active && !translationOff()) {
      for (const turn of document.querySelectorAll(MSG_SEL)) total += swapIn(turn, active.compiled);
    }
    const titles = titlesOff() ? 0 : sweepTitles();
    if (total !== shown || titles !== titleShown) {
      shown = total;
      titleShown = titles;
      render();
    }
  }

  // ---- the titles ------------------------------------------------------------
  //
  // Every chat's name the page is showing, each translated by ITS OWN chat's
  // key: the one attached to that conversation, or — where nothing is attached
  // — the one key in the library that claims the title (P.titleKeyFor). A title
  // no key claims, or one two keys claim differently, keeps the fake.
  //
  // This runs whether or not THIS chat has a key: the sidebar is where a case
  // is found, and a list of fakes is a list you cannot navigate. The badge
  // follows — it appears for titles alone and counts them — so a real name on
  // screen still always has something on screen saying why.

  let titleShown = 0; // title occurrences currently swapped, for the badge
  let titleKeyId = null; // whose key did that, for the badge's label
  let compiledLib = null; // [{ id, compiled }] — every key in the library
  let fwdById = new Map(); // key id -> forward matcher, for the cleaner
  let titleClaim = new WeakMap(); // element -> { text, id } — the last claim it made
  let docMemo = null; // { wrote, orig, count, id } while the TAB title is ours

  function libEntries() {
    if (!compiledLib) {
      compiledLib = Object.keys(keys).map((id) => ({ id: id, compiled: P.compile(keys[id]) }));
    }
    return compiledLib;
  }

  // ---- the master key --------------------------------------------------------
  //
  // The last 20 cases, distilled to what a chat title needs and kept up to
  // date by the worker off the library's own writes (src/masterkey.js). It is
  // what makes Recents readable once a case's spreadsheet is no longer in the
  // library — the case it names is a case whose key you loaded once, for
  // anything, and never had to keep.
  //
  // Strictly a LAST resort, and strictly for TITLES:
  //
  //   Last resort, because a distilled key knows the caption and nothing else.
  //   Where a real key claims the row it wins outright, so adding this can
  //   never take a translation away or change one — only supply one where
  //   there wasn't one.
  //
  //   Titles only, because those are the two properties a message doesn't
  //   have. A caption is short enough to come out all-or-nothing; a brief run
  //   through a key that knows four names comes out half in one language and
  //   half in the other, with nothing on screen saying which half you are
  //   reading. The message sweep never sees this.
  let masterKey = null; // the synthetic pseudonym key, or null for an empty one
  let masterEntry = null; // { id, compiled } — built on first use

  function setMaster(stored) {
    masterKey = M ? M.asKey(stored) : null;
    masterEntry = null;
  }

  function masterFor() {
    if (!masterKey) return null;
    if (!masterEntry) masterEntry = { id: MASTER_ID, compiled: P.compile(masterKey) };
    return masterEntry && masterEntry.compiled.rx ? masterEntry : null;
  }

  /** The key behind an id, master included — nothing is STORED under MASTER_ID. */
  function masterOr(id) {
    if (id === MASTER_ID) return masterKey;
    return id ? keys[id] : null;
  }

  function attachedKeyId(conv) {
    if (!conv) return null;
    return chatMap[conv] || runKeyIdSync(conv);
  }

  // The compiled key one title gets, or null for "leave the fake". Memoised
  // per element against the fake it was asked about, since the answer only
  // changes when the title does.
  function titleKeyEntry(el, conv, text) {
    const cached = el && titleClaim.get(el);
    let id;
    if (cached && cached.text === text) id = cached.id;
    else {
      const pick = P.titleKeyFor({
        attachedId: attachedKeyId(conv),
        entries: libEntries(),
        text: text,
      });
      id = pick ? pick.id : null;
      // Nothing in the library claimed it. The master key answers here and
      // only here, under the same one-claimant rule the library is held to —
      // P.claimsTitle, so a short fake matching by coincidence still gets
      // nothing. It is asked LAST so it can never override a real key.
      if (!id) {
        const master = masterFor();
        if (master && P.claimsTitle(P.matchedValues(master.compiled, text))) id = MASTER_ID;
      }
      if (el) titleClaim.set(el, { text: text, id: id });
    }
    if (!id || !masterOr(id)) return null;
    if (id === MASTER_ID) return masterFor();
    const entry = libEntries().find((e) => e.id === id);
    return entry && entry.compiled.rx ? entry : null;
  }

  /**
   * The open conversation's name as CLAUDE.AI wrote it, from the one place it
   * is always written: the tab. Our own swap is unwound first, since the whole
   * point of asking is to get the fake back.
   */
  function nameOnTab() {
    const raw = docMemo && document.title === docMemo.wrote ? docMemo.orig : document.title;
    return P.docTitleParts(raw).name.trim();
  }

  const squash = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

  /**
   * The header element carrying THIS conversation's name, where none of the
   * hooks above found it.
   *
   * Cowork's title control announces itself — aria-label="<name>, rename
   * session" — and HEAD_TITLE_SEL catches it. A CHAT's does not, and the
   * data-testids above are shapes claude.ai has been seen using rather than a
   * rule it keeps: when it stopped using them the chat header quietly stopped
   * translating, so a Cowork session read back in the real names and a chat
   * sat there in the fakes, which is exactly the sort of silent half-working
   * this feature cannot afford.
   *
   * So the fallback anchors on claude.ai's own data instead of its markup: it
   * writes the conversation's name into the TAB, and an element whose WHOLE
   * text is exactly that name is that name on the page. Whole-text equality
   * and nothing looser — an element that merely CONTAINS the title is the
   * header, or the page, and translating those would drag in text belonging to
   * no conversation at all. Links are left out: a sidebar row is another
   * conversation's title and gets its own key below.
   */
  const HEAD_FALLBACK_SEL = 'h1,h2,button,[role="heading"]';
  function headTitleFallback() {
    const want = squash(nameOnTab());
    if (want.length < 2) return null;
    let best = null;
    for (const el of document.querySelectorAll(HEAD_FALLBACK_SEL)) {
      // Cheap first, since this runs over every button on the page each sweep:
      // a title is about as long as the title, and anything wildly longer is a
      // container that happens to hold one. Only what survives that is worth
      // walking text node by text node.
      const len = el.textContent ? el.textContent.length : 0;
      if (!len || len > want.length * 4 + 20) continue;
      if (skippable(el) || el.closest(MSG_SEL) || el.closest("a[href]")) continue;
      if (squash(originalText(el)) !== want) continue;
      // The deepest one: an element and its wrapper both read as the title,
      // and the wrapper carries whatever else sits beside it.
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  function titleTargets() {
    const found = [];
    const here = convKey();
    if (here) {
      for (const el of document.querySelectorAll(HEAD_TITLE_SEL)) found.push({ el: el, conv: here });
      // Always, not only where the hooks above found nothing: one of them
      // landing says a header heading exists, not that it is this
      // conversation's name. A duplicate is dropped below.
      const el = headTitleFallback();
      if (el && !found.some((t) => t.el === el)) found.push({ el: el, conv: here });
    }
    for (const a of document.querySelectorAll(CONV_LINK_SEL)) {
      // A link to a chat INSIDE a message is part of the message — Claude
      // writes them — and it belongs to the message sweep, under this chat's
      // key. Left in here it would be a title target with another chat's
      // identity, and the two sweeps would take turns undoing each other.
      if (a.closest(MSG_SEL)) continue;
      // The href PROPERTY, which is absolute — the same shape convKey() reads
      // off location, so a sidebar row and the chat it opens are one identity.
      const conv = P.conversationKeyFromUrl(a.href || "");
      if (conv) found.push({ el: a, conv: conv });
    }
    // One title, once. Two of these selectors can land on nested elements —
    // a row's link around a heading — and the outer one already carries the
    // inner one's text nodes, so counting both would double every swap on the
    // badge.
    return found.filter(
      (t, i) =>
        found.findIndex((o) => o.el === t.el) === i &&
        !found.some((o, j) => j !== i && o.el !== t.el && o.el.contains(t.el))
    );
  }

  // ---- everywhere else a case's name is written ------------------------------
  //
  // titleTargets() above finds a title by being told where one is: the header
  // controls, and links whose href IS a conversation. That covers the chat
  // you are in and a sidebar row that happens to be an anchor, and it misses
  // every list claude.ai builds some other way — the Recents page, a project's
  // own page, the Chats and Tasks margin, where a row is a button, a div with
  // a click handler, or a link to somewhere that is not /chat/. Those are
  // exactly the lists a case gets FOUND in, and they were the ones still
  // reading in the fakes.
  //
  // Naming those shapes would be guessing at unversioned markup and would go
  // stale the same way. So the rest of the page is swept as a whole, with the
  // MASTER KEY, which is the one matcher that does not need to know which row
  // belongs to which case — it holds all twenty at once, so each row comes out
  // in its own case's real name from a single pass.
  //
  // Four limits keep a page-wide pass honest:
  //
  //   ONE CLAIMANT PER ROW. The targeted pass gets that from P.titleKeyFor;
  //   here it is asked of each text node, which in a list IS a row. Without
  //   it a case binding the fake "Doe" would rename a chat called "Doe hours"
  //   that has nothing to do with the matter — a wrong case name over a chat
  //   being worse than the pseudonym it replaced, on this path as on that one.
  //
  //   RENDERED TURNS ARE PRUNED. A message belongs to the message sweep, under
  //   this chat's own full key. A distilled key must never touch one (see
  //   src/masterkey.js) and it never gets the chance.
  //
  //   TITLE-LENGTH TEXT ONLY. A chat title is capped at 100 characters; a
  //   paragraph is not. The ceiling is what keeps this about names in lists
  //   rather than prose that a turn selector happened to miss.
  //
  //   IT STANDS DOWN WITH THE MESSAGES, not with the titles. The per-target
  //   pass keeps translating through a run's hold because those targets are
  //   PROVABLY titles — a header control, an href that is a conversation.
  //   This pass believes it has a title; and while a run is moving, something
  //   we merely believe is a title is something a hand-off might read.
  //
  // The library is not merged in beside the master key, and does not need to
  // be: the worker folds every library key INTO the master key already, so
  // the twenty cases here are the library's own cases plus the ones whose
  // spreadsheets have since gone. Merging twenty full keys would put every
  // declarant and address in one matcher, which is the merged library
  // src/masterkey.js exists to avoid being.
  const LOOSE_PRUNE_SEL =
    MSG_SEL +
    ',[contenteditable="true"],input,textarea,script,style,svg,' +
    '[id^="cum-"],[class*="cum-"]';
  const LOOSE_MAX = 160; // a title, with room for the "· 2 days ago" beside it

  function loosePrune(el) {
    try {
      return el.matches(LOOSE_PRUNE_SEL);
    } catch (e) {
      return true; // unreadable is not walked into
    }
  }

  function looseRoot() {
    return document.body || document.documentElement || null;
  }

  function sweepLoose() {
    if (translationOff()) return 0;
    const master = masterFor();
    const root = looseRoot();
    if (!master || !root) return 0;
    let total = 0;
    const walker = textWalker(root, loosePrune);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      if (!text || text.length < 2 || text.length > LOOSE_MAX) continue;
      const prior = swapped.get(node);
      if (prior && prior.text === text) {
        total += prior.count;
        continue;
      }
      // The one-claimant rule, asked of each TEXT NODE — which in a list is a
      // row. It is what the targeted pass gets from P.titleKeyFor and what a
      // whole-page pass would otherwise have thrown away: a key binding "Doe"
      // would rename a chat called "Doe hours" that has nothing to do with the
      // case. A distinctive fake claims a row; a short one has to bring a
      // second fake from the same case with it.
      const r = P.claimsTitle(P.matchedValues(master.compiled, text))
        ? P.translate(master.compiled, text)
        : { text: text, count: 0 };
      if (r.count > 0) {
        node.nodeValue = r.text;
        swapped.set(node, { text: r.text, orig: text, count: r.count });
        total += r.count;
      } else {
        swapped.set(node, { text: text, orig: text, count: 0 });
      }
    }
    return total;
  }

  function restoreLoose() {
    const root = looseRoot();
    if (root) restoreIn(root, loosePrune);
  }

  function sweepTitles() {
    const master = masterFor();
    // An empty LIBRARY is not an empty map any more: the master key is the
    // whole point of a case whose spreadsheet is no longer loaded, and this
    // guard was refusing to sweep anything at all for exactly that operator.
    if (!Object.keys(keys).length && !master) return 0;
    let claimed = 0;
    let owner = null;
    for (const t of titleTargets()) {
      const fake = originalText(t.el);
      if (!fake || fake.length < 2) continue;
      const entry = titleKeyEntry(t.el, t.conv, fake);
      if (!entry) {
        restoreIn(t.el);
        continue;
      }
      const n = swapIn(t.el, entry.compiled);
      if (n) {
        claimed += n;
        owner = owner || entry.id;
      }
    }
    // Then the rest of the page. This runs SECOND so a real key always gets
    // first refusal on a title it knows — the master key fills in behind it
    // and can never overwrite it, since a node already swapped comes back off
    // the memo untouched.
    const loose = sweepLoose();
    // ...and that memo is why `loose` is the page's whole count rather than a
    // second one to add: it re-walks what the pass above just swapped and
    // counts it from the memo. Adding the two would double every sidebar row.
    let total = loose || claimed;
    if (!owner && loose) owner = MASTER_ID;
    const doc = sweepDocTitle();
    total += doc;
    if (doc && !owner) owner = docMemo && docMemo.id;
    if (owner) titleKeyId = owner;
    return total;
  }

  // The tab, which is a title like any other — claude.ai's own tail ("… -
  // Claude") left exactly as written, and the swap held in a memo so our own
  // write is never mistaken for the site's and CUMPseudoView.docTitle below
  // can still answer with what the site wrote.
  function sweepDocTitle() {
    const cur = document.title;
    if (docMemo && cur === docMemo.wrote) return docMemo.count;
    const parts = P.docTitleParts(cur);
    const conv = convKey();
    if (!parts.name.trim()) {
      docMemo = null;
      return 0;
    }
    const entry = titleKeyEntry(null, conv, parts.name);
    if (!entry) {
      docMemo = null;
      return 0;
    }
    const r = P.translate(entry.compiled, parts.name);
    if (!r.count) {
      docMemo = null;
      return 0;
    }
    docMemo = { wrote: r.text + parts.tail, orig: cur, count: r.count, id: entry.id };
    document.title = docMemo.wrote;
    return r.count;
  }

  function restoreDocTitle() {
    if (docMemo && document.title === docMemo.wrote) document.title = docMemo.orig;
    docMemo = null;
  }

  // The tab title as CLAUDE.AI wrote it — the fake — whatever this tab is
  // showing. Anything that reads the title to NAME something (Save chat's
  // filename, the scheduler's "this chat") reads it through here, so a swap
  // made for the eyes never becomes a name that leaves the browser.
  //
  // plainText is the same answer for an ELEMENT: what claude.ai rendered
  // inside it, with this tab's swaps taken back out. Save chat's incognito
  // fallback reads the mounted turns off the page when there is no
  // conversation record to fetch, and a file on disk is not display.
  window.CUMPseudoView = {
    docTitle: function () {
      return docMemo && document.title === docMemo.wrote ? docMemo.orig : document.title;
    },
    plainText: function (el) {
      return el ? originalText(el) : "";
    },
    // ---- what the key button in the tray renders from ----------------------
    // This module owns the keys, the sweep and the peek; src/key-panel.js owns
    // the button and its panel. The seam is deliberately data and verbs, not
    // DOM: nothing about how it looks lives on this side of it.
    state: function () {
      return viewState();
    },
    clean: function (text) {
      return clean(text);
    },
    setPaused: function (on) {
      setPaused(on);
    },
    /** Called on every render with the new state; answers an unsubscribe. */
    subscribe: function (fn) {
      if (typeof fn !== "function") return function () {};
      watchers.push(fn);
      try {
        fn(viewState());
      } catch (e) {
        /* the next render will try it again */
      }
      return function () {
        const i = watchers.indexOf(fn);
        if (i !== -1) watchers.splice(i, 1);
      };
    },
  };

  function sweepSoon() {
    if (sweepTimer) return;
    sweepTimer = setTimeout(sweep, 180);
  }

  const mo = new MutationObserver(() => {
    // Titles are translated with or without a key on THIS chat, so the sweep
    // runs whenever there is anything at all to translate with — the master
    // key included. Asking only the LIBRARY was the same mistake sweepTitles
    // made: an operator whose cases are all in the master key and whose
    // library is empty got no sweep at all, on any page.
    if (active || Object.keys(keys).length || masterFor()) sweepSoon();
  });

  // ---- what the key button shows, and the composer warning -------------------
  //
  // There is no floating badge any more. It said the right things — which case
  // this tab is translating, how many swaps are showing, whether a run is
  // holding the messages — and it said them from a draggable lozenge sitting
  // over claude.ai's page, which is one more thing to move out of the way.
  // Everything it said now belongs to the key button in the tray
  // (src/key-panel.js), beside Save.
  //
  // The invariant it existed for is untouched, and is the reason the button
  // carries a live count rather than only opening a panel: a real name on
  // screen must always have something on screen saying why. A closed panel
  // would break that; a button reading "🔑 12" does not.
  //
  // So this module keeps the machinery and publishes it. state() is what the
  // badge used to render, as data; clean() is the cleaner's translation;
  // subscribe() fires on every render so the button follows the sweep without
  // polling it.

  let warnBox = null;
  const watchers = [];

  // The key this tab is translating WITH, for the badge and the cleaner: the
  // chat's own where one is attached, and otherwise whichever key is doing the
  // title swaps. A sidebar read in real names is still translation, and the
  // badge is the thing that says so.
  function displayKey() {
    if (active) return { id: active.id, key: active.key, forward: active.forward };
    const key = masterOr(titleKeyId);
    if (!key) return null;
    if (!key.master && !fwdById.has(titleKeyId))
      fwdById.set(titleKeyId, P.compileForward(key));
    // The CLEANER is a write-side tool — you type a paragraph and paste what
    // comes back into a chat — so it may only ever run on a key that knows the
    // whole case. The master key knows a caption: it would swap the parties,
    // hand back everything else verbatim, and it would LOOK cleaned. That is
    // the one direction a distilled key must not be pointed in, so it labels
    // the badge and translates the titles and offers no cleaner at all.
    return {
      id: titleKeyId,
      key: key,
      forward: key.master ? null : fwdById.get(titleKeyId),
    };
  }

  /**
   * What the key button shows. The badge's own sentence, taken apart into the
   * pieces that made it, so the button can show a count and its panel can show
   * the whole thing.
   */
  function viewState() {
    const disp = displayKey();
    if (!disp) return { on: false, names: 0, titles: 0, paused: paused, hold: null };
    return {
      on: true,
      id: disp.id,
      // What this key is CALLED (P.keyTitle): the case folder it was picked
      // from where there is one, the case hint where there isn't. With two
      // cases open in two tabs, every key file is named pseudonym_key.xlsx and
      // the button has to say WHICH case this tab is translating. (The tab
      // already shows the real names — the label reveals nothing the
      // translation doesn't.)
      name: P.keyTitle ? P.keyTitle(disp.key) : disp.key.name || "pseudonym key",
      master: !!disp.key.master,
      caseCount: disp.key.caseCount || 0,
      names: shown,
      titles: titleShown,
      paused: paused,
      hold: hold ? { name: hold.name || "", via: hold.via || "" } : null,
      // A distilled key must never be pointed at the write side (see
      // displayKey), so the panel is told whether there is a cleaner at all
      // rather than being left to work it out.
      canClean: !!disp.forward,
    };
  }

  function render() {
    const st = viewState();
    if (!st.on) {
      if (warnBox) {
        warnBox.remove();
        warnBox = null;
      }
      hideTip();
    }
    for (const fn of watchers) {
      try {
        fn(st);
      } catch (e) {
        /* one bad watcher must not stop the rest, or the sweep */
      }
    }
  }

  // ---- the cleaner: type real names, read out fakes --------------------------
  //
  // The ReAnonymize direction — longest real first, keeps left verbatim,
  // common English never touched. It writes nothing into the composer: pasting
  // the cleaned text is deliberately the user's own move, and it is the key
  // button's panel that shows the boxes now.
  //
  // Only ever run on a key that knows the WHOLE case (see displayKey): a
  // distilled master key would swap the parties, hand back everything else
  // verbatim, and look cleaned.

  function clean(text) {
    const disp = displayKey();
    const src = String(text == null ? "" : text);
    if (!disp || !disp.forward) return { text: src, count: 0, can: false };
    const r = P.translate(disp.forward, src);
    return { text: r.text, count: r.count, can: true };
  }

  function warnHtmlFor(hits) {
    const bits = hits.slice(0, 4).map((h) => {
      const real = document.createElement("b");
      real.textContent = "“" + h.real + "”";
      const fake = document.createElement("b");
      fake.textContent = "“" + h.fake + "”";
      const line = document.createElement("div");
      line.className = "cum-pseudo-warn-line";
      line.append(real, " is a real value — the chat should say ", fake, ".");
      return line;
    });
    return bits;
  }

  function checkComposer() {
    if (!active || !active.compiledReals.rx) {
      if (warnBox) warnBox.hidden = true;
      return;
    }
    const C = window.CUMComposer;
    const ed =
      (C && C.findEditor && C.findEditor()) ||
      document.querySelector('div[contenteditable="true"]');
    const text = ed ? ed.innerText || ed.textContent || "" : "";
    // A draft opening with the PINCITE CHECK header is the operator pasting
    // official-reporter pincites out of Lexis — published citations, declared
    // safe. The warning stands down for that draft (P.isPincitePaste).
    const hits = (
      text && !P.isPincitePaste(text) ? P.findReals(active.compiledReals, text) : []
    ).filter(
      // The value the caret prompt is offering right now is being handled —
      // the banner covers everything the caret is NOT on.
      (h) => !(tipHit && tipEl && !tipEl.hidden && P.fold(h.real) === P.fold(tipHit.real))
    );
    if (!hits.length) {
      if (warnBox) warnBox.hidden = true;
      return;
    }
    if (!warnBox) {
      warnBox = document.createElement("div");
      warnBox.className = "cum-pseudo-warn";
      document.documentElement.appendChild(warnBox);
    }
    warnBox.hidden = false;
    warnBox.textContent = "";
    const head = document.createElement("div");
    head.className = "cum-pseudo-warn-head";
    head.textContent = "⚠ Real name in your draft";
    warnBox.appendChild(head);
    for (const line of warnHtmlFor(hits)) warnBox.appendChild(line);
    if (hits.length > 4) {
      const more = document.createElement("div");
      more.className = "cum-pseudo-warn-line";
      more.textContent = "…and " + (hits.length - 4) + " more.";
      warnBox.appendChild(more);
    }
  }

  // ---- a copy that carries the real names ------------------------------------
  //
  // Every copy on the page, not just the extension's own button. The rule the
  // README states — what LEAVES the page reads claude.ai's own state, which
  // still holds the fakes — has one exception, and the exception has grown:
  // Copy ruling copies the RENDERED message now, so it takes the real names;
  // and ⌘C, right-click Copy and claude.ai's own selection copies always did.
  // Usually that is exactly right, since a tentative ruling is pasted into a
  // minute order and a minute order says the parties' real names. It is
  // catastrophic in one direction only — back into a chat — and on the
  // clipboard the two are indistinguishable. So the copy says what it carried.
  //
  // Read off the SELECTION rather than the clipboard: at capture time a copy
  // event's clipboardData is empty (the browser fills it afterwards), and a
  // handler that writes its own — src/copy-ruling.js does, off an off-screen
  // holder holding the rendered blocks — has not run yet. The selection is
  // what both of them are about to copy, so it is what both are judged on.
  //
  // Warn, never rewrite. The clipboard is the user's, exactly as the composer
  // is: this names what went onto it and gets out of the way.

  let copyBox = null;
  let realsById = new Map(); // key id -> compiled reals, built on demand

  const COPY_SCAN_MAX = 200000; // a whole conversation's worth, and no further

  /**
   * The keys whose REAL values could be on this page: the one translating the
   * messages, and the one translating the titles. Not the whole library — a
   * name belonging to a case this tab is not showing is not on the clipboard
   * because of anything we did, and warning about it would be crying wolf
   * about every chat that happens to mention a common surname.
   */
  function realMatchers() {
    const out = [];
    const add = (id, key) => {
      if (!id || !key || out.some((e) => e.id === id)) return;
      if (!realsById.has(id)) realsById.set(id, P.compileReals(key));
      const compiled = realsById.get(id);
      if (compiled && compiled.rx) out.push({ id: id, key: key, compiled: compiled });
    };
    if (active) add(active.id, active.key);
    if (titleKeyId) add(titleKeyId, masterOr(titleKeyId));
    return out;
  }

  function closeCopyBox() {
    if (copyBox) copyBox.remove();
    copyBox = null;
  }

  function onCopy() {
    // A peek is the user asking to see exactly what claude.ai renders. Nothing
    // is swapped, so nothing swapped can be on the clipboard.
    if (paused) return closeCopyBox();
    let text = "";
    try {
      text = String(window.getSelection() || "");
    } catch (e) {
      return;
    }
    if (!text) return closeCopyBox();
    if (text.length > COPY_SCAN_MAX) text = text.slice(0, COPY_SCAN_MAX);
    let hits = [];
    let owner = null;
    for (const m of realMatchers()) {
      const found = P.findReals(m.compiled, text);
      if (!found.length) continue;
      owner = owner || m.key;
      hits = hits.concat(found);
    }
    const warn = P.copyWarning(hits, {
      // The master key is twenty cases at once, so it cannot name the one this
      // value belongs to — and "for master key · 3 recent cases" would be a
      // worse sentence than no name at all.
      caseName: owner && !owner.master && P.keyTitle ? P.keyTitle(owner) : "",
    });
    if (!warn) return closeCopyBox();
    showCopyWarning(warn);
  }

  function showCopyWarning(warn) {
    closeCopyBox();
    copyBox = document.createElement("div");
    copyBox.className = "cum-pseudo-copy";
    const x = document.createElement("button");
    x.className = "cum-pseudo-copy-x";
    x.type = "button";
    x.textContent = "✕";
    x.title = "Dismiss";
    x.addEventListener("click", closeCopyBox);
    copyBox.appendChild(x);
    const head = document.createElement("div");
    head.className = "cum-pseudo-warn-head";
    head.textContent = warn.head;
    copyBox.appendChild(head);
    for (const n of warn.names) {
      const line = document.createElement("div");
      line.className = "cum-pseudo-warn-line";
      const real = document.createElement("b");
      real.textContent = "“" + n.real + "”";
      line.append(real, n.fake ? " — the chat says “" + n.fake + "”." : ".");
      copyBox.appendChild(line);
    }
    if (warn.more) {
      const more = document.createElement("div");
      more.className = "cum-pseudo-warn-line";
      more.textContent = "…and " + warn.more + " more.";
      copyBox.appendChild(more);
    }
    const body = document.createElement("div");
    body.className = "cum-pseudo-copy-body";
    body.textContent = warn.body;
    copyBox.appendChild(body);
    document.documentElement.appendChild(copyBox);
  }

  // Capture, so it is seen before a handler that calls preventDefault and
  // writes its own clipboard data — which is what Copy ruling does.
  try {
    document.addEventListener("copy", onCopy, true);
  } catch (e) {
    /* the translation still works; only the warning is missing */
  }

  // ---- the as-you-type prompt: finish a real name, press → for the fake -----
  //
  // The moment the caret sits at the end of a just-typed REAL value, a small
  // prompt appears at the caret offering the pseudonym; ArrowRight swaps it
  // in place (via the selection + insertText, which ProseMirror handles as
  // ordinary typing), Escape dismisses for that spot, and any other typing
  // moves the caret past the word and the prompt goes on its own. The
  // banner below stays as the net for everything the caret is NOT on —
  // pasted text, a dismissed prompt — but never doubles the value currently
  // being offered.

  let tipEl = null;
  let tipHit = null; // { real, fake, matched, at } while showing
  let tipDismissed = null; // "at|real" the user Escaped, until the text moves
  let tipTimer = null;

  function editorEl() {
    const C = window.CUMComposer;
    return (
      (C && C.findEditor && C.findEditor()) ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  // The caret's position as an offset into the editor's own text, plus that
  // text up to the caret — null when the selection isn't a caret in the
  // editor.
  function caretContext(ed) {
    const sel = window.getSelection();
    if (!ed || !sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!ed.contains(r.startContainer)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(ed);
    pre.setEnd(r.startContainer, r.startOffset);
    return { textBefore: pre.toString(), range: r };
  }

  function hideTip() {
    tipHit = null;
    if (tipEl) tipEl.hidden = true;
  }

  function updateTip() {
    tipTimer = null;
    if (!active || !active.ahead || !active.ahead.length) return hideTip();
    const ed = editorEl();
    const ctx = ed && caretContext(ed);
    const hit = ctx && P.endingReal(active.ahead, ctx.textBefore);
    if (!hit) return hideTip();
    const sig = ctx.textBefore.length + "|" + P.fold(hit.real);
    if (tipDismissed === sig) return hideTip();
    tipHit = { real: hit.real, fake: hit.fake, matched: hit.matched, sig: sig };
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "cum-pseudo-tip";
      document.documentElement.appendChild(tipEl);
    }
    tipEl.textContent = "";
    const swap = document.createElement("b");
    swap.textContent = hit.matched + " → " + P.mirrorCase(hit.matched, hit.fake);
    const how = document.createElement("span");
    how.className = "cum-pseudo-tip-how";
    how.textContent = "  press → to swap · Esc to keep";
    tipEl.append(swap, how);
    tipEl.hidden = false;
    // At the caret, just above the line; a collapsed caret still has a rect.
    let rect = ctx.range.getBoundingClientRect();
    if (!rect || (!rect.top && !rect.left)) rect = ed.getBoundingClientRect();
    tipEl.style.left = Math.min(rect.left, window.innerWidth - 340) + "px";
    tipEl.style.top = Math.max(6, rect.top - 34) + "px";
  }

  function tipSoon() {
    if (tipTimer) return;
    tipTimer = setTimeout(updateTip, 80);
  }

  function swapAtCaret() {
    const ed = editorEl();
    const ctx = ed && caretContext(ed);
    const hit = ctx && P.endingReal(active.ahead, ctx.textBefore);
    // Confirm against what's showing — the caret may have moved since.
    if (!hit || !tipHit || P.fold(hit.real) !== P.fold(tipHit.real)) return false;
    const sel = window.getSelection();
    for (let i = 0; i < hit.matched.length; i++) sel.modify("extend", "backward", "character");
    ed.focus();
    // The same door composer.js types through — ProseMirror treats it as
    // ordinary input, so undo (Ctrl+Z) brings the real name back if wanted.
    document.execCommand("insertText", false, P.mirrorCase(hit.matched, hit.fake));
    hideTip();
    return true;
  }

  window.addEventListener(
    "keydown",
    (ev) => {
      if (!tipHit || !tipEl || tipEl.hidden) return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      if (ev.key === "ArrowRight") {
        if (swapAtCaret()) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
        }
      } else if (ev.key === "Escape") {
        tipDismissed = tipHit.sig;
        hideTip();
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    },
    true
  );

  document.addEventListener("selectionchange", () => {
    if (active) tipSoon();
  });

  // ---- the key-upload guard ---------------------------------------------------
  //
  // Always on. Interception is capture-phase on window, so it runs before any
  // page handler; a batch with a suspect file is swallowed whole, vetted
  // asynchronously (name first, then the sheet fingerprint for any .xlsx), and
  // re-dispatched with everything the user let through. `passing` marks our own
  // re-dispatch so it sails past this same listener.

  let passing = false;

  function suspectName(name) {
    return P.isKeyFileName(name) || /\.xlsx$/i.test(String(name || ""));
  }

  async function isKeyFile(file) {
    if (P.isKeyFileName(file.name)) return true;
    if (!/\.xlsx$/i.test(file.name || "")) return false;
    try {
      const wb = await X.parseXlsx(await file.arrayBuffer());
      return P.sheetsLookLikeKey(wb.sheets);
    } catch (e) {
      return false; // unreadable spreadsheets are not silently blocked
    }
  }

  function guardDialog(keyNames, otherCount) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "cum-pseudo-guard";
      const box = document.createElement("div");
      box.className = "cum-pseudo-guard-box";
      const h = document.createElement("div");
      h.className = "cum-pseudo-guard-head";
      h.textContent = "That looks like your pseudonym key";
      const p = document.createElement("p");
      p.textContent =
        keyNames.join(", ") +
        " is the real↔fake map. Uploading it into a chat hands Claude every real " +
        "name the pseudonymization exists to withhold." +
        (otherCount ? " The other " + otherCount + " file(s) will still go through." : "");
      const row = document.createElement("div");
      row.className = "cum-pseudo-guard-row";
      const keep = document.createElement("button");
      keep.className = "cum-pseudo-guard-keep";
      keep.textContent = "Keep it out";
      const send = document.createElement("button");
      send.className = "cum-pseudo-guard-send";
      send.textContent = "Upload anyway";
      row.append(keep, send);
      box.append(h, p, row);
      overlay.appendChild(box);
      const done = (ok) => {
        overlay.remove();
        resolve(ok);
      };
      keep.addEventListener("click", () => done(false));
      send.addEventListener("click", () => done(true));
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) done(false);
      });
      document.documentElement.appendChild(overlay);
      keep.focus();
    });
  }

  async function vet(files) {
    const keyFiles = [];
    const clean = [];
    for (const f of files) {
      if (await isKeyFile(f)) keyFiles.push(f);
      else clean.push(f);
    }
    if (!keyFiles.length) return files;
    const ok = await guardDialog(keyFiles.map((f) => f.name), clean.length);
    return ok ? files : clean;
  }

  function fileList(files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    return dt;
  }

  window.addEventListener(
    "change",
    (ev) => {
      if (passing) return;
      const input = ev.target;
      if (!input || input.type !== "file" || !input.files || !input.files.length) return;
      // Our OWN pickers are not uploads. The folder button's picker reads a case
      // folder locally — the key it finds there is parsed into the library and
      // never handed to claude.ai — and a dialog asking whether to upload it
      // would be asking about something that isn't happening. The guard still
      // covers what that button then attaches: those files go through
      // claude.ai's own input, which is not ours.
      const C = window.CUMComposer;
      if (C && C.isOurs && C.isOurs(input)) return;
      const files = Array.from(input.files);
      if (!files.some((f) => suspectName(f.name))) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      input.value = "";
      vet(files).then((release) => {
        if (!release.length) return;
        try {
          input.files = fileList(release).files;
          passing = true;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } finally {
          passing = false;
        }
      });
    },
    true
  );

  window.addEventListener(
    "drop",
    (ev) => {
      if (passing) return;
      const dt = ev.dataTransfer;
      const files = dt && dt.files ? Array.from(dt.files) : [];
      if (!files.length || !files.some((f) => suspectName(f.name))) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      const target = ev.target;
      vet(files).then((release) => {
        if (!release.length) return;
        const C = window.CUMComposer;
        const el =
          (target && target.isConnected && target) ||
          (C && C.findEditor && C.findEditor()) ||
          document.body;
        try {
          passing = true;
          if (C && C.dropFiles) C.dropFiles(el, release);
          else {
            const r = new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer: fileList(release),
            });
            el.dispatchEvent(r);
          }
        } finally {
          passing = false;
        }
      });
    },
    true
  );

  window.addEventListener(
    "paste",
    (ev) => {
      if (passing) return;
      const dt = ev.clipboardData;
      const files = dt && dt.files ? Array.from(dt.files) : [];
      if (!files.length || !files.some((f) => suspectName(f.name))) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      const target = ev.target;
      vet(files).then((release) => {
        if (!release.length) return;
        const el = (target && target.isConnected && target) || document.body;
        try {
          passing = true;
          el.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: fileList(release),
            })
          );
        } finally {
          passing = false;
        }
      });
    },
    true
  );

  // ---- start ------------------------------------------------------------------

  loadState().then(() => {
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    setInterval(() => {
      resolveActive(false); // SPA navigation
      checkComposer();
      // Only while held, and rate-limited inside refreshRuns: a run write of
      // any kind wakes the listener above, so the one thing left to poll for is
      // a hold whose run stopped saying anything at all.
      if (hold) refreshHold(false);
    }, 900);
  });
})();
