/**
 * Auto-download probe — paste into the claude.ai DevTools console.
 *
 * Depends on nothing: not the extension, not its modules. Open the
 * conversation with the file in it, paste this at the console prompt, and put
 * your pointer over the file card while it counts down. It prints — and copies
 * — a description of the newest reply: every control with its attributes, every
 * short piece of text, and a stripped-down copy of the markup.
 *
 * The pointer matters. A card's download control is commonly revealed by CSS
 * `:hover`, which no synthetic event can trigger: the extension can find a
 * button sitting at zero opacity, but one the page only ADDS under a real
 * pointer isn't in the DOM at all until there is one. That is the difference
 * between what this sees and what the extension's own "What can it see?"
 * button sees, and it is the reason this exists.
 */
(function (delaySeconds) {
  "use strict";

  const WAIT = typeof delaySeconds === "number" ? delaySeconds : 5;
  const MAX_HTML = 8000;
  const MAX_REPORT = 30000;

  const ASSISTANT = [
    '[data-testid="assistant-message"]',
    ".font-claude-response",
    ".font-claude-message",
    "[data-is-streaming]",
  ];
  const CONTROLS = 'button,[role="button"],a,[role="menuitem"],[tabindex="0"]';
  const cls = (el) => (el.className && el.className.baseVal != null ? el.className.baseVal : el.className) || "";
  const ours = (el) => /(^|\s)cum-/.test(String(cls(el))) || String(el.id || "").indexOf("cum-") === 0;
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  function messages() {
    for (const sel of ASSISTANT) {
      const found = Array.from(document.querySelectorAll(sel)).filter((el) => !ours(el));
      if (found.length) return { sel: sel, list: found };
    }
    return { sel: null, list: [] };
  }

  // One step out from the element claude.ai marks as the message, while the
  // ancestor still holds this reply and no other — a file card is often drawn
  // beside the prose rather than inside it.
  function widen(el, sel) {
    let scope = el;
    for (let i = 0; i < 4; i++) {
      const p = scope.parentElement;
      if (!p || p === document.body) break;
      if (p.querySelectorAll(sel).length > 1) break;
      scope = p;
    }
    return scope;
  }

  function describe(el) {
    const bits = [el.tagName.toLowerCase()];
    for (const a of ["aria-label", "title", "data-testid", "data-test-id", "role", "download", "type"]) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v != null && v !== "") bits.push(a + "=" + JSON.stringify(v));
    }
    const href = el.getAttribute && el.getAttribute("href");
    if (href) bits.push("href=" + JSON.stringify(href.slice(0, 60)));
    const text = norm(el.textContent).slice(0, 50);
    bits.push(text ? "text=" + JSON.stringify(text) : "(no text)");
    // Whether it can be SEEN matters for reading the report, though the
    // extension deliberately clicks controls it can't see.
    try {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const hidden = [];
      if (s.display === "none") hidden.push("display:none");
      if (s.visibility === "hidden") hidden.push("visibility:hidden");
      if (parseFloat(s.opacity) === 0) hidden.push("opacity:0");
      if (!r.width || !r.height) hidden.push("zero-size");
      bits.push(hidden.length ? "[" + hidden.join(",") + "]" : "[visible]");
    } catch (e) {
      /* ignore */
    }
    const c = norm(cls(el));
    if (c) bits.push("class=" + JSON.stringify(c.slice(0, 70)));
    return bits.join(" ");
  }

  // The markup, with the noise taken out: Tailwind class strings run to
  // hundreds of characters and would bury the part that identifies the card.
  function skeleton(root) {
    let copy;
    try {
      copy = root.cloneNode(true);
    } catch (e) {
      return "(couldn't clone)";
    }
    const all = [copy].concat(Array.from(copy.querySelectorAll("*")));
    for (const el of all) {
      try {
        el.removeAttribute("style");
        const c = norm(cls(el));
        if (c) el.setAttribute("class", c.slice(0, 60));
        for (const a of Array.from(el.attributes || [])) {
          if (/^(class|id|role|href|download|type|tabindex)$/.test(a.name)) continue;
          if (/^(aria|data)-/.test(a.name)) continue;
          el.removeAttribute(a.name);
        }
        // SVG paths are long and say nothing about which button is which.
        if (el.tagName && el.tagName.toLowerCase() === "svg") el.innerHTML = "";
      } catch (e) {
        /* ignore */
      }
    }
    return copy.outerHTML.replace(/>\s+</g, "><").slice(0, MAX_HTML);
  }

  // Where the pointer is. The single most useful thing in the report, because
  // it removes every question of which element we are talking about — the first
  // run of this probe described a project-content panel that happened to render
  // after the conversation, and nobody could tell from the report that it had.
  let at = null;
  document.addEventListener("mousemove", (e) => (at = { x: e.clientX, y: e.clientY }), true);

  function underPointer(say) {
    say("");
    say("--- under your pointer ---");
    if (!at) return say("  (the pointer never moved — put it on the file card and run this again)");
    let el = document.elementFromPoint(at.x, at.y);
    if (!el) return say("  (nothing there)");
    // Climb to something that looks like a whole card rather than the label
    // inside it: a testid, or the first ancestor carrying a control.
    let card = el;
    for (let i = 0; i < 6; i++) {
      const p = card.parentElement;
      if (!p || p === document.body) break;
      if (card.getAttribute("data-testid")) break;
      if (norm(card.textContent).length > 200) break;
      card = p;
    }
    say("  innermost: " + describe(el));
    say("  card: " + describe(card));
    const ctrls = Array.from(card.querySelectorAll(CONTROLS)).filter((e) => !ours(e));
    say("  controls on it: " + (ctrls.length || "none"));
    for (const c of ctrls.slice(0, 20)) say("    " + describe(c));
    say("  markup:");
    say(skeleton(card));
  }

  function dump() {
    const out = [];
    const say = (s) => out.push(s);
    say("=== auto-download probe · " + location.pathname + " ===");

    const { sel, list } = messages();
    say("assistant messages: " + list.length + (sel ? " (matched " + sel + ")" : " — NO SELECTOR MATCHED"));
    // Every candidate, not just the last. A selector that also matches page
    // furniture is invisible in a report that only ever describes one element,
    // and the furniture is often what renders last.
    list.forEach((el, i) => {
      const inLink = el.closest('a[href],button,[role="button"],[data-testid="file-thumbnail"]');
      say(
        "  [" + i + "] " + JSON.stringify(norm(el.textContent).slice(0, 60)) +
          (inLink ? "  <- inside a " + inLink.tagName.toLowerCase() + ", so NOT a reply" : "")
      );
    });
    if (!list.length) {
      say("That is already the bug: nothing on this page reads as an assistant message.");
      underPointer(say);
      return finish(out);
    }

    const real = list.filter((el) => !el.closest('a[href],button,[role="button"],[data-testid="file-thumbnail"]'));
    const msg = (real.length ? real : list)[(real.length ? real : list).length - 1];
    const scope = widen(msg, sel);
    say("newest reply opens: " + JSON.stringify(norm(msg.textContent).slice(0, 90)));
    say("scope: " + (scope === msg ? "the message element itself" : scope.tagName.toLowerCase() + " above it"));

    say("");
    say("--- controls in that reply ---");
    const ctrls = Array.from(scope.querySelectorAll(CONTROLS)).filter((el) => !ours(el));
    if (!ctrls.length) say("  (none)");
    for (const el of ctrls.slice(0, 60)) say("  " + describe(el));

    say("");
    say("--- short pieces of text in that reply ---");
    let n = 0;
    for (const el of scope.querySelectorAll("*")) {
      if (ours(el) || el.children.length) continue;
      const t = norm(el.textContent);
      if (!t || t.length > 70) continue;
      if (n++ >= 40) break;
      say("  " + el.tagName.toLowerCase() + ": " + JSON.stringify(t));
    }
    if (!n) say("  (none)");

    underPointer(say);

    say("");
    say("--- markup of the whole reply (classes trimmed, svg emptied) ---");
    say(skeleton(scope));
    return finish(out);
  }

  function finish(lines) {
    const text = lines.join("\n").slice(0, MAX_REPORT);
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

  if (!WAIT) return dump();
  console.log("Put your pointer over the file card now — reading in " + WAIT + "s…");
  let left = WAIT;
  const timer = setInterval(() => {
    left--;
    if (left > 0) return console.log(left + "…");
    clearInterval(timer);
    dump();
  }, 1000);
})(5);
