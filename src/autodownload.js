/**
 * Claude Usage Meter — Auto-download files Claude produces (ISOLATED world).
 *
 * With the (opt-in, default-off) toggle on, a reply that hands you a file has
 * that file saved for you: the extension clicks the reply's own download
 * control once the turn has finished. The decisions — what counts as a save
 * control, what has already been saved, and the ceilings — live in the pure
 * module src/autodl.js; this is the DOM around them.
 *
 * Its own switch, off by default, like every other clicker in here: this one
 * writes to your disk, which is not a decision an extension gets to make for
 * you. Three narrower guards on top of that:
 *
 * - **Only the newest reply or two.** claude.ai unmounts messages that scroll
 *   out of view and mounts them again when you scroll back, so a watcher
 *   looking at the whole transcript would see a chat's entire history arrive as
 *   "new" every time you scrolled up. The files you want are in the answer that
 *   just landed.
 * - **Only buttons, and links that carry a `download` attribute.** A plain
 *   `<a>` captioned "Download …" navigates, and navigating away from the
 *   conversation you are reading would be a far worse accident than a file not
 *   saved.
 * - **A census on arrival.** Whatever is on the page when this starts — or when
 *   you turn the toggle on, or when you open another conversation — is recorded
 *   as already handled. Opening a chat never re-saves what is in it.
 */
(function () {
  "use strict";

  const A = window.CUMAutoDl;
  const C = window.CUMComposer;
  const CFG_KEY = "cum_autodownload"; // { enabled, max }
  const SELF_POLL_MS = 2000;
  const ESCAPE_MS = 700; // let a click land before dismissing any menu it opened

  let cfg = { enabled: false, max: A ? A.MAX_PER_PAGE : 20 };
  let seen = []; // keys handled this page load (saved, or adopted by the census)
  let count = 0; // files actually saved this page load
  let lastAt = 0;
  let baselined = false;
  let where = ""; // the conversation this ledger belongs to
  let toldCap = false;

  // Assistant turns, newest last — the same cascade src/workflow-run.js walks,
  // because claude.ai's markup is unversioned and one of these matches.
  const ASSISTANT_SELECTORS = [
    '[data-testid="assistant-message"]',
    ".font-claude-response",
    ".font-claude-message",
    "[data-is-streaming]",
  ];
  function assistantMessages() {
    for (const sel of ASSISTANT_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      const list = Array.from(nodes).filter((el) => !C.isOurs(el));
      if (list.length) return list;
    }
    return [];
  }

  // A filename near a control that didn't name one. The card usually says what
  // the file is called even where the button only says "Download".
  const FILENAME_RE = /([\w][\w \-()[\]]{0,60}\.[a-z0-9]{1,8})\b/i;
  function cardName(node) {
    let el = node;
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 160) continue;
      const m = FILENAME_RE.exec(t);
      if (m) return m[1].trim();
    }
    return "";
  }

  // Clickable right now. A control that fails this still keeps its place in
  // the list (see offersIn) — it is only barred from being the one clicked.
  function ready(el) {
    if (!el) return false;
    if (el.getAttribute && el.getAttribute("data-cum-dl")) return false; // saved already
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return false;
    try {
      return C.isVisible(el);
    } catch (e) {
      return false;
    }
  }

  // Every file this reply is offering. Document order, and everything that
  // matched — including what can't be clicked yet — because that order is what
  // the keys are numbered against where a control carries no filename, and a
  // list that dropped its clicked entries would renumber the rest.
  function offersIn(msgEl) {
    const found = [];
    const nodes = new Set();
    try {
      for (const a of msgEl.querySelectorAll("a[download]")) {
        if (nodes.has(a) || C.isOurs(a)) continue;
        nodes.add(a);
        const attr = (a.getAttribute("download") || "").trim();
        found.push({
          node: a,
          name: attr || A.fileName(a.textContent) || cardName(a),
          ready: ready(a),
        });
      }
      // Buttons only. A bare link would navigate rather than save.
      for (const b of msgEl.querySelectorAll('button, [role="button"]')) {
        if (nodes.has(b) || C.isOurs(b)) continue;
        const label =
          b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent;
        if (!A.isSaveLabel(label)) continue;
        nodes.add(b);
        found.push({ node: b, name: A.fileName(label) || cardName(b), ready: ready(b) });
      }
    } catch (e) {
      return [];
    }
    return found;
  }

  function collect() {
    // The newest reply, plus the one before it so a missed poll can't lose a
    // file — and no further back, or scrolling would resurrect the whole chat.
    const recent = assistantMessages().slice(-2);
    const offers = [];
    for (const m of recent) {
      const found = offersIn(m);
      if (!found.length) continue;
      const keys = A.offerKeys(
        A.turnSignature(m.textContent),
        found.map((f) => f.name)
      );
      found.forEach((f, i) =>
        offers.push({ key: keys[i], name: f.name, node: f.node, ready: f.ready })
      );
    }
    return offers;
  }

  function save(offer) {
    lastAt = Date.now();
    count++;
    try {
      offer.node.setAttribute("data-cum-dl", "1");
    } catch (e) {
      /* the ledger key is the real guard; this is the belt to its braces */
    }
    try {
      offer.node.click();
    } catch (e) {
      return; // one that won't click is a file not saved, and nothing more
    }
    // A control that opens a menu instead of saving leaves it open, and a stray
    // popup would sit over the conversation you're reading.
    setTimeout(() => {
      try {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
      } catch (e) {
        /* ignore */
      }
    }, ESCAPE_MS);
    const cap = cfg.max > 0 ? cfg.max : A.MAX_PER_PAGE;
    toast(`Saved ${offer.name || "a file"} (${count} / ${cap})`);
  }

  function tick() {
    // Off is the default, and the default must cost nothing: no scanning the
    // page every two seconds on the strength of a toggle nobody turned on.
    if (!A || !C || !cfg.enabled) return;
    // A different conversation is a different ledger — and a fresh census, so
    // the chat you just opened isn't mistaken for output that just arrived.
    // The tally is deliberately NOT reset: the ceiling is per page load, and an
    // SPA navigation is not one. A runaway must not be able to walk around it
    // by moving to the next chat.
    const here = location.pathname;
    if (here !== where) {
      where = here;
      seen = [];
      lastAt = 0;
      baselined = false;
    }

    let generating = false;
    try {
      generating = C.isGenerating();
    } catch (e) {
      generating = false;
    }

    const res = A.plan(collect(), {
      enabled: cfg.enabled,
      generating,
      baselined,
      seen,
      count,
      max: cfg.max,
      now: Date.now(),
      lastAt,
    });

    for (const k of res.adopt) if (seen.indexOf(k) === -1) seen.push(k);
    if (res.hold === "baseline") {
      baselined = true;
      return;
    }
    if (!res.take) {
      if (res.hold === "cap" && !toldCap) {
        toldCap = true;
        toast(`Auto-download paused — saved ${count}. Reload to save more.`);
      }
      return;
    }
    save(res.take);
  }

  // ---- Toast -------------------------------------------------------------
  let toastEl = null;
  let toastTimer = null;
  function toast(msg) {
    try {
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.id = "cum-dl-toast";
        (document.body || document.documentElement).appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.classList.add("cum-ac-show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("cum-ac-show"), 2600);
    } catch (e) {
      /* ignore */
    }
  }

  // ---- Config ------------------------------------------------------------
  function applyCfg(value) {
    const prev = cfg.enabled;
    cfg = Object.assign({ enabled: false, max: A ? A.MAX_PER_PAGE : 20 }, value || {});
    // Turning it back on clears the cap, and re-takes the census: the files on
    // screen while it was off are ones you chose not to have saved.
    if (cfg.enabled && !prev) {
      count = 0;
      toldCap = false;
      baselined = false;
    }
  }

  function loadCfg() {
    try {
      chrome.storage?.local.get([CFG_KEY], (res) => applyCfg(res && res[CFG_KEY]));
    } catch (e) {
      /* ignore */
    }
  }

  try {
    chrome.storage?.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[CFG_KEY]) applyCfg(changes[CFG_KEY].newValue);
    });
  } catch (e) {
    /* ignore */
  }

  // The worker nudges every claude.ai tab on the same channel the other
  // clickers use, so this keeps working in a tab that isn't in front.
  try {
    chrome.runtime?.onMessage.addListener((msg) => {
      if (msg === "cum-ac-poll") tick();
    });
  } catch (e) {
    /* ignore */
  }

  loadCfg();
  setInterval(tick, SELF_POLL_MS);
})();
