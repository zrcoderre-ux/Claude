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
 *      turns and titles, never the composer, and everything the extension
 *      sends or copies out of a chat reads claude.ai's API/state, not this
 *      DOM. A badge says translation is on and how many swaps are showing, so
 *      what you see is never silently different from what Claude sees. While a
 *      run is moving, the MESSAGES stand down to the fakes and the titles do
 *      not — a hand-off can fall back to a rendered message, and nothing
 *      reads a title off the screen at all.
 *
 *   2. The COMPOSER warning. While a key is attached, the draft message is
 *      watched for REAL values from the key; each one found gets a loud
 *      banner naming the fake to use instead. Warn, never rewrite — the
 *      composer belongs to the user.
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
  if (!P || !X) return;

  const KEYS_KEY = "cum_pseudo_keys"; // id -> parsed key (see popup.js)
  const CHATS_KEY = "cum_pseudo_chats"; // conversation key -> key id
  const POS_KEY = "cum_pseudo_pos"; // where the user dragged the badge { left, top }

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
    // A different key means a different map — a cleaner left open would keep
    // showing the last case's title over this one's swaps.
    closeCleaner();
    render();
    sweepSoon();
    // The hold belongs to the RUN rather than to the tab, so a chat arrived at
    // mid-run is held from the first sweep — not from the next run write.
    refreshHold(true);
  }

  async function loadState() {
    const res = await storageGet([KEYS_KEY, CHATS_KEY, POS_KEY]);
    // A key loaded, replaced or attached elsewhere changes what every title on
    // this page should read. Put back what we wrote under the old library
    // before adopting the new one — a swap left standing under a map that no
    // longer explains it is exactly the silent difference the badge promises
    // there isn't.
    restoreFakes();
    swapped = new WeakMap();
    compiledLib = null;
    fwdById = new Map();
    titleClaim = new WeakMap();
    keys = res[KEYS_KEY] || {};
    chatMap = res[CHATS_KEY] || {};
    const p = res[POS_KEY];
    if (p && typeof p.left === "number" && typeof p.top === "number") badgePos = p;
    await resolveActive(true);
  }

  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch[POS_KEY]) {
        // Dragged in another tab: the badge is one control in as many tabs as
        // are open, and having to move it in each of them would be worse than
        // it moving under you here.
        const np = ch[POS_KEY].newValue;
        if (np && typeof np.left === "number" && typeof np.top === "number") {
          badgePos = np;
          placeBadge(false);
        }
      }
      if (ch[KEYS_KEY] || ch[CHATS_KEY]) loadState();
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
  function swapIn(el, compiled) {
    if (!el || !compiled || !compiled.rx) return 0;
    let total = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
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

  function restoreIn(el) {
    if (!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
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
      if (el) titleClaim.set(el, { text: text, id: id });
    }
    if (!id || !keys[id]) return null;
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

  function sweepTitles() {
    if (!Object.keys(keys).length) return 0;
    let total = 0;
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
        total += n;
        owner = owner || entry.id;
      }
    }
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
  };

  function sweepSoon() {
    if (sweepTimer) return;
    sweepTimer = setTimeout(sweep, 180);
  }

  const mo = new MutationObserver(() => {
    // Titles are translated with or without a key on THIS chat, so the sweep
    // runs whenever the library has anything to translate with.
    if (active || Object.keys(keys).length) sweepSoon();
  });

  // ---- the badge and the composer warning ------------------------------------

  let badge = null;
  let warnBox = null;
  let badgePos = null; // { left, top } once dragged; null = its default corner
  let badgeDragged = false; // set through a drag so the click that ends it isn't a tap

  // ---- dragging the badge ---------------------------------------------------
  // The same contract as the usage meter's own pill, because it's the same kind
  // of object: a small fixed thing sitting over someone else's page, which is
  // going to be over the wrong part of it sooner or later. Position is clamped
  // to the viewport, remembered across tabs and reloads, and a drag never counts
  // as the click that opens the cleaner.

  function clampBadge(left, top) {
    const r = badge.getBoundingClientRect();
    return {
      left: Math.min(Math.max(0, left), Math.max(0, window.innerWidth - r.width)),
      top: Math.min(Math.max(0, top), Math.max(0, window.innerHeight - r.height)),
    };
  }

  // Switch the badge from its default left/bottom corner to explicit left/top.
  // Called on every render and on resize, so a window narrowed since the drag
  // brings the badge back on screen instead of stranding it past the edge.
  function placeBadge(persist) {
    if (!badge || !badgePos) return;
    const c = clampBadge(badgePos.left, badgePos.top);
    badge.style.left = c.left + "px";
    badge.style.top = c.top + "px";
    badge.style.right = "auto";
    badge.style.bottom = "auto";
    badgePos = c;
    placeCleaner();
    if (persist) {
      try {
        chrome.storage?.local.set({ [POS_KEY]: c });
      } catch (e) {
        /* a position we couldn't store is still the position on screen */
      }
    }
  }

  // The cleaner opens off the badge, so it goes wherever the badge went — above
  // it where there's room for it, below it where there isn't.
  function placeCleaner() {
    if (!cleaner || !badge) return;
    if (!badgePos) {
      cleaner.style.left = "";
      cleaner.style.top = "";
      cleaner.style.bottom = "";
      return;
    }
    const b = badge.getBoundingClientRect();
    const h = cleaner.offsetHeight || 260;
    const w = cleaner.offsetWidth || 420;
    const above = b.top - 8 - h;
    const top = above >= 8 ? above : Math.min(b.bottom + 8, Math.max(8, window.innerHeight - h - 8));
    cleaner.style.left = Math.max(8, Math.min(b.left, window.innerWidth - w - 8)) + "px";
    cleaner.style.top = top + "px";
    cleaner.style.bottom = "auto";
  }

  function setupBadgeDrag(el) {
    let startX = 0, startY = 0, originLeft = 0, originTop = 0, moved = false, dragging = false;

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      // Cleared here rather than in the click handler: a drag that ends in a
      // pointercancel produces no click to consume the flag, and a stale one
      // would swallow the next real press.
      badgeDragged = false;
      startX = e.clientX;
      startY = e.clientY;
      const r = el.getBoundingClientRect();
      originLeft = r.left;
      originTop = r.top;
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });

    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return; // ignore tiny jitters
      moved = true;
      badgePos = { left: originLeft + dx, top: originTop + dy };
      placeBadge(false);
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      if (moved) {
        badgeDragged = true; // the click that follows this drag is not a tap
        placeBadge(true);
      }
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  window.addEventListener("resize", () => {
    placeBadge(false);
  });

  // The key this tab is translating WITH, for the badge and the cleaner: the
  // chat's own where one is attached, and otherwise whichever key is doing the
  // title swaps. A sidebar read in real names is still translation, and the
  // badge is the thing that says so.
  function displayKey() {
    if (active) return { id: active.id, key: active.key, forward: active.forward };
    const key = titleKeyId ? keys[titleKeyId] : null;
    if (!key) return null;
    if (!fwdById.has(titleKeyId)) fwdById.set(titleKeyId, P.compileForward(key));
    return { id: titleKeyId, key: key, forward: fwdById.get(titleKeyId) };
  }

  function render() {
    const disp = displayKey();
    if (!disp) {
      if (badge) {
        badge.remove();
        badge = null;
      }
      if (warnBox) {
        warnBox.remove();
        warnBox = null;
      }
      closeCleaner();
      hideTip();
      return;
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "cum-pseudo-badge";
      badge.title =
        "Display only: this tab swaps the pseudonyms back to the real names for YOU. " +
        "Claude still holds — and only ever sees — the fakes. Sends, copies and " +
        "exports read claude.ai's own data, not this view. " +
        "Click to open the cleaner: type text with real names, copy out the fakes. " +
        "Drag it anywhere — where you put it is where it stays. " +
        "Chat titles are translated too — the header, the sidebar and the tab — " +
        "each by its own chat's key; the title claude.ai stores stays the fake. " +
        "While a workflow run is working this matter the MESSAGES stand down on " +
        "their own and show the fakes, so nothing a run carries to the next chat " +
        "can be a real name; a run that pauses, fails or finishes brings them " +
        "back. The titles keep their real names throughout — nothing a run does " +
        "reads a title off the screen.";
      badge.addEventListener("click", () => {
        if (badgeDragged) return; // this click is the end of a drag, not a tap
        toggleCleaner();
      });
      setupBadgeDrag(badge);
      document.documentElement.appendChild(badge);
      placeBadge(false); // a position from an earlier visit, applied on arrival
    }
    // What this key is CALLED (P.keyTitle): the case folder it was picked from
    // where there is one, the case hint where there isn't. With two cases open
    // in two tabs, every key file is named pseudonym_key.xlsx and the badge has
    // to say WHICH case this tab is translating. (The tab already shows the
    // real names — the label reveals nothing the translation doesn't.)
    const name = P.keyTitle ? P.keyTitle(disp.key) : disp.key.name || "pseudonym key";
    const bits = [];
    if (shown) bits.push(shown + " name" + (shown === 1 ? "" : "s"));
    if (titleShown) bits.push(titleShown + " title" + (titleShown === 1 ? "" : "s"));
    // Held is now a HALF stand-down — the messages show the fakes, the titles
    // still read in the real name — so the badge says which is which rather
    // than "showing the fakes" over a title that plainly isn't.
    const titles = titleShown
      ? " · " + titleShown + " title" + (titleShown === 1 ? "" : "s") + " still real"
      : "";
    badge.textContent = hold
      ? "🔑 " + name + " — ⏸ a run is working · the messages show the fakes" + titles
      : paused
      ? "🔑 " + name + " — ⏸ showing the fakes"
      : "🔑 " + name + (bits.length ? " — " + bits.join(" · ") + " restored" : "");
    badge.classList.toggle("cum-pseudo-paused", translationOff());
    badge.classList.toggle("cum-pseudo-held", !!hold);
    const tog = cleaner && cleaner.querySelector(".cum-pseudo-clean-toggle");
    if (tog) styleToggle(tog);
  }

  // What the peek toggle says and whether it can be pressed at all. A run
  // moving through this chat owns the display until it stops, and the button
  // says which run and how to get the names back — pausing the run is one
  // click, and pausing the run is exactly what the rule is waiting for.
  function styleToggle(tog) {
    if (hold) {
      tog.textContent = "⏸ Messages held while a run works";
      tog.disabled = true;
      tog.title =
        "This chat's MESSAGES show the fakes while " +
        (hold.name ? "“" + hold.name + "”" : "a run") +
        " is running" +
        (hold.via === "key" ? " on this matter" : "") +
        ". A run's hand-off can fall back to the text on screen, so real names " +
        "in a message could reach the next chat. Pause the run — or let it " +
        "finish, hold or fail — and the real names come back by themselves. " +
        "The chat titles are not held: nothing a run does reads a title off " +
        "the screen, so they keep their real names throughout.";
      return;
    }
    tog.textContent = paused ? "▶ Show real names" : "⏸ Show the fakes";
    tog.disabled = false;
    tog.title =
      "Pause or resume this chat's translation — messages AND titles, since a peek " +
      "is for seeing the page exactly as claude.ai renders it: the fakes. This tab " +
      "only, and never remembered.";
  }

  // ---- the cleaner: type real names, paste out fakes -------------------------
  //
  // Opens from the badge. Whatever is typed is pseudonymized LIVE with the
  // attached key — the ReAnonymize direction, longest real first, keeps left
  // verbatim, common English never touched — into a read-only box beside it,
  // with Copy. It writes nothing into the composer: pasting the cleaned text
  // is deliberately the user's own move.

  let cleaner = null;

  function closeCleaner() {
    if (cleaner) {
      cleaner.remove();
      cleaner = null;
    }
  }

  function runCleaner() {
    const disp = cleaner && displayKey();
    if (!disp) return;
    const src = cleaner.querySelector(".cum-pseudo-clean-in").value;
    const out = cleaner.querySelector(".cum-pseudo-clean-out");
    const note = cleaner.querySelector(".cum-pseudo-clean-note");
    const r = P.translate(disp.forward, src);
    out.value = r.text;
    note.textContent = src
      ? r.count + " value" + (r.count === 1 ? "" : "s") + " swapped. Only values the key " +
        "knows are swapped — read it before pasting."
      : "";
  }

  function toggleCleaner() {
    if (cleaner) return closeCleaner();
    const disp = displayKey();
    if (!disp) return;
    cleaner = document.createElement("div");
    cleaner.className = "cum-pseudo-clean";
    const head = document.createElement("div");
    head.className = "cum-pseudo-clean-head";
    const title = document.createElement("span");
    title.textContent = "Pseudonymize for pasting — " + (disp.key.name || "key");
    const x = document.createElement("button");
    x.className = "cum-pseudo-clean-x";
    x.textContent = "✕";
    x.title = "Close";
    x.addEventListener("click", closeCleaner);
    head.append(title, x);

    const input = document.createElement("textarea");
    input.className = "cum-pseudo-clean-in";
    input.placeholder = "Type or paste text with real names…";
    input.addEventListener("input", runCleaner);

    const out = document.createElement("textarea");
    out.className = "cum-pseudo-clean-out";
    out.readOnly = true;
    out.placeholder = "The cleaned version appears here.";

    const foot = document.createElement("div");
    foot.className = "cum-pseudo-clean-foot";
    // The peek toggle: pause the in-chat translation to see exactly what
    // claude.ai is showing (the fakes), then bring the real names back.
    const toggle = document.createElement("button");
    toggle.className = "cum-pseudo-clean-toggle";
    styleToggle(toggle);
    toggle.addEventListener("click", () => setPaused(!paused));
    const note = document.createElement("span");
    note.className = "cum-pseudo-clean-note";
    const copy = document.createElement("button");
    copy.className = "cum-pseudo-clean-copy";
    copy.textContent = "Copy cleaned";
    copy.addEventListener("click", () => {
      const text = out.value;
      if (!text) return;
      const flash = (ok) => {
        copy.textContent = ok ? "Copied ✓" : "Select it and copy by hand";
        setTimeout(() => {
          copy.textContent = "Copy cleaned";
        }, 1600);
      };
      try {
        navigator.clipboard.writeText(text).then(
          () => flash(true),
          () => {
            out.select();
            flash(document.execCommand("copy"));
          }
        );
      } catch (e) {
        out.select();
        flash(document.execCommand("copy"));
      }
    });
    foot.append(toggle, note, copy);

    cleaner.append(head, input, out, foot);
    document.documentElement.appendChild(cleaner);
    placeCleaner(); // it opens off the badge, wherever the badge has been put
    input.focus();
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
