/**
 * Cowork probe — paste into the claude.ai DevTools console.
 *
 * Depends on nothing: not the extension, not its modules. It answers the one
 * question the extension can't answer from here — what Cowork mode actually
 * looks like in the DOM — so workflows and scheduled sends can drive it the way
 * they already drive Chat.
 *
 * Unlike a snapshot, this WATCHES. The Chat/Cowork toggle, the Project menu and
 * the approval menu are all transient: a menu opens in a portal, and closes the
 * moment you click the thing that would tell us what it was. So this installs
 * listeners, you drive the UI by hand, and it remembers everything it saw.
 *
 *   1. Paste this at the console prompt on claude.ai (Home tab, still in Chat).
 *   2. Toggle Chat -> Cowork.
 *   3. Open the Project menu, pick a project, then re-open it.
 *   4. Open the approval menu and hover each of the three choices; pick one.
 *   5. Send one short message ("hi" will do) and let the reply start.
 *   6. Run: __cowork.report()
 *
 * It prints — and copies — the URL at every step, every menu that opened with
 * every item in it, every control you clicked, and whether the selectors the
 * extension already uses for the composer, the send button and the model picker
 * still match in Cowork mode.
 */
(function () {
  "use strict";

  const MAX_REPORT = 60000;
  const MAX_ITEMS = 40;
  const MAX_MENUS = 24;
  const MAX_CLICKS = 40;

  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const cls = (el) =>
    (el && el.className && el.className.baseVal != null ? el.className.baseVal : el && el.className) || "";
  const ours = (el) => /(^|\s)cum-/.test(String(cls(el))) || String((el && el.id) || "").indexOf("cum-") === 0;

  // Attributes worth carrying: the ones a selector could be built out of, plus
  // the ones that say which choice is currently in force. Radix (which claude.ai
  // uses) marks the live one with data-state / aria-checked rather than a class.
  const ATTRS = [
    "data-testid",
    "data-test-id",
    "aria-label",
    "aria-labelledby",
    "role",
    "type",
    "name",
    "value",
    "title",
    "placeholder",
    "aria-checked",
    "aria-selected",
    "aria-pressed",
    "aria-expanded",
    "aria-haspopup",
    "aria-current",
    "aria-disabled",
    "data-state",
    "data-value",
    "data-active",
    "data-selected",
    "data-disabled",
    "data-highlighted",
    "contenteditable",
  ];

  function describe(el) {
    if (!el || !el.tagName) return "(nothing)";
    const bits = [el.tagName.toLowerCase()];
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v != null && v !== "") bits.push(a + "=" + JSON.stringify(String(v).slice(0, 80)));
    }
    const href = el.getAttribute && el.getAttribute("href");
    if (href) bits.push("href=" + JSON.stringify(href.slice(0, 80)));
    const text = norm(el.textContent).slice(0, 60);
    bits.push(text ? "text=" + JSON.stringify(text) : "(no text)");
    const c = norm(cls(el));
    if (c) bits.push("class=" + JSON.stringify(c.slice(0, 60)));
    return bits.join(" ");
  }

  // The trail of testids above an element. When nothing on the control itself is
  // stable enough to select on, the container usually is.
  function trail(el) {
    const out = [];
    let node = el;
    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      const id = node.getAttribute && (node.getAttribute("data-testid") || node.getAttribute("data-test-id"));
      const role = node.getAttribute && node.getAttribute("role");
      if (id) out.push("[data-testid=" + JSON.stringify(id) + "]");
      else if (role) out.push("[role=" + JSON.stringify(role) + "]");
      node = node.parentElement;
    }
    return out.length ? out.join(" < ") : "(no testid/role above it)";
  }

  const seen = { urls: [], menus: [], clicks: [], typed: null };
  const menuKeys = new Set();

  function noteUrl(why) {
    const at = location.pathname + location.search;
    const last = seen.urls[seen.urls.length - 1];
    if (last && last.at === at) return;
    seen.urls.push({ at: at, why: why, n: seen.urls.length });
  }

  // --- menus -------------------------------------------------------------
  // Anything that opens and carries choices. Radix renders these into a portal
  // at the end of <body>, so they arrive as added nodes rather than as
  // descendants of the button that opened them.
  const MENUISH =
    '[role="menu"],[role="listbox"],[role="dialog"],[role="radiogroup"],[data-radix-popper-content-wrapper],[data-radix-menu-content]';
  const ITEMISH =
    '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[role="radio"],button,a[href]';

  function recordMenu(root, why) {
    if (!root || ours(root)) return;
    const items = Array.from(root.querySelectorAll(ITEMISH)).filter((el) => !ours(el));
    if (!items.length) return;
    // Same menu re-opened twice is worth seeing once, unless its marked state
    // changed — which is exactly what tells us how a choice is recorded.
    const key =
      norm(root.getAttribute("role") || "") +
      "|" +
      items
        .slice(0, MAX_ITEMS)
        .map((el) => norm(el.textContent).slice(0, 40) + ":" + (el.getAttribute("data-state") || el.getAttribute("aria-checked") || ""))
        .join("~");
    if (menuKeys.has(key)) return;
    menuKeys.add(key);
    if (seen.menus.length >= MAX_MENUS) return;
    seen.menus.push({
      why: why,
      at: location.pathname,
      container: describe(root),
      trail: trail(root),
      items: items.slice(0, MAX_ITEMS).map((el) => ({ d: describe(el), t: trail(el.parentElement) })),
      more: Math.max(0, items.length - MAX_ITEMS),
    });
  }

  const obs = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of Array.from(r.addedNodes || [])) {
        if (!node || node.nodeType !== 1 || ours(node)) continue;
        if (node.matches && node.matches(MENUISH)) recordMenu(node, "opened");
        if (node.querySelectorAll) {
          for (const inner of Array.from(node.querySelectorAll(MENUISH)).slice(0, 4)) recordMenu(inner, "opened");
        }
      }
      // A menu that was already in the DOM and merely re-marked (the choice
      // changed) shows up as an attribute change, not an added node.
      if (r.type === "attributes" && r.target && r.target.closest) {
        const menu = r.target.closest(MENUISH);
        if (menu) recordMenu(menu, "re-marked (" + r.attributeName + ")");
      }
    }
  });
  obs.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state", "aria-checked", "aria-selected", "aria-expanded", "aria-pressed"],
  });

  // --- clicks ------------------------------------------------------------
  document.addEventListener(
    "click",
    (e) => {
      try {
        const t = e.target;
        if (!t || !t.closest || ours(t)) return;
        const ctrl = t.closest('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="tab"],[role="switch"],a[href],label') || t;
        if (seen.clicks.length >= MAX_CLICKS) return;
        seen.clicks.push({ n: seen.clicks.length, at: location.pathname, d: describe(ctrl), t: trail(ctrl) });
        // What the control looks like a beat later: a toggle flips its own
        // aria-* after the click, and that is the state we would have to read.
        setTimeout(() => {
          try {
            if (ctrl.isConnected) seen.clicks[seen.clicks.length - 1].after = describe(ctrl);
          } catch (err) {
            /* ignore */
          }
          noteUrl("after clicking " + JSON.stringify(norm(ctrl.textContent).slice(0, 40)));
        }, 700);
      } catch (err) {
        /* ignore */
      }
    },
    true
  );

  // --- url ---------------------------------------------------------------
  noteUrl("where the probe started");
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function () {
      const r = orig.apply(this, arguments);
      setTimeout(() => noteUrl("history." + m), 0);
      return r;
    };
  }
  window.addEventListener("popstate", () => setTimeout(() => noteUrl("popstate"), 0));

  // --- what the extension already looks for ------------------------------
  // If these still match in Cowork mode, the send path needs no change and only
  // the mode/project/approval controls are new work. If they don't, say so
  // loudly: that is the difference between a small edit and a second driver.
  const KNOWN = [
    ["composer editor", 'div[data-testid="chat-input"]'],
    ["composer editor (fallback)", 'div.ProseMirror[contenteditable="true"], .tiptap[contenteditable="true"]'],
    ["file input", 'input[data-testid="file-upload"]'],
    ["send button", 'button[aria-label="Send message"]'],
    ["send button (variants)", '[data-testid="send-button"], button[aria-label="Send"], button[aria-label*="Send message" i]'],
    ["stop button", 'button[aria-label*="Stop" i], [data-testid="stop-button"]'],
    ["model picker", 'button[data-testid="model-selector-dropdown"], button[aria-label^="Model:" i]'],
    ["assistant message", '[data-testid="assistant-message"], .font-claude-response'],
    ["user message", '[data-testid="user-message"], [data-testid="human-message"]'],
  ];

  // --- controls we can find by their words, before anything is clicked ----
  const WORDS = [
    ["chat / cowork toggle", /^(chat|cowork|co-work|co work)$/i],
    ["approval choices", /^(manually approve|automatically approve|skip all approvals)$/i],
    ["approval trigger", /approv/i],
    ["project", /^(project|projects|select a project|no project)$/i],
  ];

  function hunt(re) {
    const out = [];
    const all = document.querySelectorAll('button,[role="button"],[role="tab"],[role="switch"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="combobox"],a[href],label,span,div');
    for (const el of all) {
      if (ours(el) || out.length >= 12) continue;
      const t = norm(el.textContent);
      if (!t || t.length > 60) continue;
      const label = norm(el.getAttribute("aria-label") || "");
      if (!re.test(t) && !re.test(label)) continue;
      // The innermost element carrying the word; its parent is usually the
      // control, so both go in.
      if (el.querySelector && Array.from(el.querySelectorAll("*")).some((c) => re.test(norm(c.textContent)))) continue;
      out.push(el);
    }
    return out;
  }

  function report() {
    const out = [];
    const say = (s) => out.push(s);

    say("=== cowork probe · " + location.pathname + " ===");
    say("");
    say("--- urls, in the order they happened ---");
    for (const u of seen.urls) say("  [" + u.n + "] " + u.at + "   <- " + u.why);
    if (seen.urls.length < 2) say("  (only one url — did the Cowork toggle change the address at all?)");

    // Two live assumptions ride on the shape of that address, and both are
    // cheap to answer here and expensive to discover later.
    say("");
    say("--- what those urls mean for code that already exists ---");
    const landed = seen.urls[seen.urls.length - 1].at;
    say("  last url: " + landed);
    say(
      "  contains /chat/ : " +
        (/\/chat\//.test(landed) ? "yes — confirmSent and settledUrl still recognise a send landing" : "NO — composer.js:334 and workflow-run.js:349 lose their signal here")
    );
    const paths = seen.urls.map((u) => u.at.split("?")[0]);
    const varied = paths.some((p) => p !== paths[0]);
    const queried = seen.urls.some((u) => /\?/.test(u.at));
    say(
      "  mode lives in: " +
        (varied ? "the path (fine — tab reuse compares pathname)" : queried ? "a QUERY PARAM — jobstore.sameConversationUrl ignores it, so a Cowork job would reuse a Chat tab" : "neither the path nor the query — it is page state, so it must be set after arriving")
    );

    say("");
    say("--- does Cowork keep the composer the extension already drives? ---");
    for (const [name, sel] of KNOWN) {
      let n = 0;
      try {
        n = document.querySelectorAll(sel).length;
      } catch (e) {
        n = -1;
      }
      const first = n > 0 ? document.querySelector(sel) : null;
      say("  " + (n ? "MATCH " : "NONE  ") + name + "  (" + n + ")  " + sel);
      if (first) say("        " + describe(first));
    }

    say("");
    say("--- controls found by their words, right now ---");
    for (const [name, re] of WORDS) {
      const found = hunt(re);
      say("  " + name + ": " + (found.length || "none"));
      for (const el of found) {
        const ctrl = el.closest('button,[role="button"],[role="tab"],[role="switch"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="combobox"],a[href]') || el;
        say("    " + describe(ctrl));
        say("      in: " + trail(ctrl));
      }
    }

    say("");
    say("--- menus that opened while you drove ---");
    if (!seen.menus.length) say("  (none — open the Project menu and the approval menu, then run this again)");
    seen.menus.forEach((m, i) => {
      say("  [" + i + "] " + m.why + " on " + m.at);
      say("      container: " + m.container);
      say("      in: " + m.trail);
      for (const it of m.items) say("        · " + it.d);
      if (m.more) say("        (+" + m.more + " more items)");
    });

    say("");
    say("--- what you clicked ---");
    if (!seen.clicks.length) say("  (nothing)");
    for (const c of seen.clicks) {
      say("  [" + c.n + "] on " + c.at + ": " + c.d);
      if (c.after && c.after !== c.d) say("        became: " + c.after);
      say("        in: " + c.t);
    }

    say("");
    say("--- storage keys that mention mode, project or approval ---");
    let any = 0;
    for (const store of [
      ["localStorage", window.localStorage],
      ["sessionStorage", window.sessionStorage],
    ]) {
      try {
        for (let i = 0; i < store[1].length; i++) {
          const k = store[1].key(i);
          if (!/cowork|approv|mode|project|composer/i.test(k)) continue;
          say("  " + store[0] + "[" + JSON.stringify(k) + "] = " + JSON.stringify(String(store[1].getItem(k)).slice(0, 200)));
          if (++any > 30) break;
        }
      } catch (e) {
        say("  (" + store[0] + " unreadable)");
      }
    }
    if (!any) say("  (none — so the mode is probably in the url or on the server, not in storage)");

    const text = out.join("\n").slice(0, MAX_REPORT);
    console.log(text);
    try {
      // `copy` is the DevTools console's own, and is the reliable one here —
      // the clipboard API refuses while the console has focus.
      // eslint-disable-next-line no-undef
      copy(text);
      console.log("\n(copied to clipboard — paste it back)");
    } catch (e) {
      console.log("\n(select the block above and copy it by hand)");
    }
    return text;
  }

  window.__cowork = { report: report, seen: seen, describe: describe, stop: () => obs.disconnect() };
  console.log(
    [
      "cowork probe is watching.",
      "  1. toggle Chat -> Cowork",
      "  2. open the Project menu, pick a project, re-open it",
      "  3. open the approval menu, then pick one of the three",
      "  4. send one short message and let the reply start",
      "  5. run: __cowork.report()",
    ].join("\n")
  );
})();
