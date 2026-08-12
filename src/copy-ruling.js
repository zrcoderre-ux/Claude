/**
 * Claude Usage Meter — Copy ruling (ISOLATED world content script).
 *
 * A second copy button in claude.ai's own action bar, beside the one that
 * copies the whole reply. This one copies **only the tentative ruling**: from
 * NATURE OF PROCEEDINGS through the end of the CONCLUSION, without the note
 * Claude wrote above it, the offer to revise underneath, or the horizontal
 * rules dividing them. What that means exactly, and why each boundary is where
 * it is, is src/tentative.js — this is the button around it.
 *
 * Three decisions worth stating:
 *
 * - **It only appears on a reply that has a ruling in it.** A second copy
 *   control under every answer in every chat would be clutter, and one that did
 *   nothing when pressed would be worse. Detection reads the page, which is
 *   enough to know whether the words are there.
 * - **The text comes from claude.ai's own copy box**, clicked and caught
 *   through src/replycopy.js. That is the only source that gives Claude's
 *   markdown — headings, emphasis, block quotes — as written. Reading the
 *   rendered page instead would hand back something that looks the same and
 *   pastes flat, and the rules that mark the ruling's boundaries would not be
 *   in it at all.
 * - **It never leaves the clipboard holding the wrong thing.** Getting the text
 *   means letting claude.ai copy the whole reply first; if the ruling can't
 *   then be cut out of it, the button says so and puts the clipboard back to
 *   what it held before, rather than leaving you to paste the lot into a minute
 *   order without knowing.
 */
(function () {
  "use strict";

  const C = window.CUMComposer;
  const RC = window.CUMReplyCopy;
  const T = window.CUMTentative;
  if (!C || !RC || !T) return;

  const CLASS = "cum-ruling-btn";
  const PLACE_MS = 1500;
  const HOVER_MS = 400; // floor between hover-driven placement passes
  const FEEDBACK_MS = 2200;

  const ASSISTANT_SELECTORS = [
    '[data-testid="assistant-message"]',
    ".font-claude-response",
    ".font-claude-message",
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

  function streaming(el) {
    try {
      if (el.closest('[data-is-streaming="true"]')) return true;
      if (el.getAttribute("data-is-streaming") === "true") return true;
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  // ---- the clipboard -------------------------------------------------------
  async function write(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      /* a page that isn't focused refuses this — fall through */
    }
    // The old way, which a user gesture still buys us where the async API
    // declines. Off-screen rather than hidden: display:none can't be selected.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-2000px;left:-2000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  // ---- the button ----------------------------------------------------------
  function say(btn, text, bad) {
    btn.classList.toggle("cum-ruling-bad", !!bad);
    btn.querySelector(".cum-ruling-txt").textContent = text;
    clearTimeout(btn._cumTimer);
    btn._cumTimer = setTimeout(() => {
      btn.classList.remove("cum-ruling-bad");
      const label = btn.querySelector(".cum-ruling-txt");
      if (label) label.textContent = "Ruling";
    }, FEEDBACK_MS);
  }

  async function copyRuling(btn, msgEl) {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      // claude.ai's copy box holds the whole reply for a moment on the way past.
      // Whatever it held before is put back if the ruling can't be found.
      const whole = await RC.copyViaButton(msgEl);
      // Falling back to the page is worth saying so about. What's rendered has
      // no `---` in it — a horizontal rule draws as a line and reads as
      // nothing — so the end of the ruling has to be guessed at, and Claude's
      // closing remark can ride along.
      const source = whole || msgEl.innerText || "";
      const cut = T.extractRuling(source);
      if (!cut.ok) {
        if (whole) await write(whole); // leave the clipboard as claude.ai left it
        say(btn, "No ruling found", true);
        return;
      }
      if (!(await write(cut.text))) {
        say(btn, "Couldn't copy", true);
        return;
      }
      // A caveat is worth a moment of the label rather than a silent success.
      const caveat = !whole ? "from the page" : cut.reason ? "no CONCLUSION" : "";
      say(btn, caveat ? "Copied (" + caveat + ")" : "Ruling copied");
    } catch (e) {
      say(btn, "Couldn't copy", true);
    } finally {
      btn.disabled = false;
    }
  }

  function build(msgEl) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = CLASS;
    btn.title =
      "Copy just the tentative ruling — NATURE OF PROCEEDINGS through the end " +
      "of the CONCLUSION, without the horizontal rules or anything either side";
    btn.setAttribute("aria-label", "Copy the tentative ruling only");
    btn.innerHTML =
      '<span class="cum-ruling-ico">§</span><span class="cum-ruling-txt">Ruling</span>';
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyRuling(btn, msgEl);
    });
    return btn;
  }

  // Beside the copy box, in claude.ai's own action bar. Placed there rather
  // than floated anywhere of our own: this is a copy control, and the place a
  // copy control is looked for is next to the other one.
  function place() {
    for (const msgEl of assistantMessages()) {
      // Asked first because it is the cheap question, and because on most
      // replies the answer is no: only where there is actually a ruling to
      // copy, and not while the answer is still being written — half a ruling
      // pasted into a minute order is worse than none, and the heading shows up
      // early in the stream.
      const wanted = T.mentionsRuling(msgEl.textContent) && !streaming(msgEl);
      const bar = RC.findCopyButton(msgEl);
      if (!bar) continue; // the action bar can be hover-revealed; try again later
      const row = bar.parentElement;
      if (!row) continue;
      const has = row.querySelector("." + CLASS);
      if (!wanted) {
        if (has) has.remove();
        continue;
      }
      if (has) continue;
      try {
        row.insertBefore(build(msgEl), bar.nextSibling);
      } catch (e) {
        /* a row that won't take it is a button we simply don't offer */
      }
    }
  }

  setInterval(place, PLACE_MS);

  // claude.ai reveals the action bar on hover and rebuilds it as it goes, so
  // waiting out the interval would mean hovering an old reply and watching the
  // button turn up a second and a half later — long enough to have moved on.
  let lastHover = 0;
  document.addEventListener(
    "pointerover",
    () => {
      const now = Date.now();
      if (now - lastHover < HOVER_MS) return;
      lastHover = now;
      place();
    },
    true
  );

  place();
})();
