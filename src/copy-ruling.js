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
 * **It copies the page, not the markdown.** The first version of this went
 * through claude.ai's own copy box — click it, catch what it wrote, cut the
 * ruling out of the markdown, put that back on the clipboard. Three things were
 * wrong with that, and they compounded:
 *
 * 1. The write happens after an `await`, and a clipboard write that lands
 *    outside the click's own turn can be refused. When it was, the clipboard
 *    still held what claude.ai had just put there — the whole reply — so the
 *    button appeared to copy everything.
 * 2. What it produced was plain markdown. Pasted into a minute order that is
 *    `**NATURE OF PROCEEDINGS**`, not a heading.
 * 3. A horizontal rule in markdown is three characters that have to be told
 *    apart from a setext underline and a row of dashes someone typed. On the
 *    page it is an `<hr>`. The page knows, and guessing was losing.
 *
 * So it now takes the ruling out of the **rendered message**: find the blocks
 * between the NATURE OF PROCEEDINGS heading and the rule after CONCLUSION, copy
 * those. The copy is a selection copy — the same thing as selecting exactly that
 * part of the answer and pressing ⌘C — which means it is **synchronous inside
 * the click** (nothing to be refused later), and it carries both the formatted
 * and the plain versions, so it pastes into Word as a ruling and into a text box
 * as text.
 *
 * The markdown route survives as a fallback for a message whose shape this
 * can't read. It is the only path that can leave the clipboard holding the
 * whole reply, and it says so when it does.
 *
 * It appears **only on a reply that has a ruling in it**, and not while one is
 * still being written: a second copy control under every answer in every chat
 * would be clutter, and one that did nothing when pressed would be worse.
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

  // ---- the ruling, out of the rendered message -----------------------------
  // The element the ruling starts at. Capped in length so the match is the
  // HEADING rather than some wrapper that contains the whole answer.
  const HEAD_SEL = "h1,h2,h3,h4,h5,h6,p,div,li,blockquote";
  const MAX_HEAD = 200;
  function findStartEl(msgEl) {
    let nodes;
    try {
      nodes = msgEl.querySelectorAll(HEAD_SEL);
    } catch (e) {
      return null;
    }
    for (const el of nodes) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > MAX_HEAD) continue;
      if (T.startsRuling(t)) return el;
    }
    return null;
  }

  // The level of the message the ruling's blocks sit at.
  //
  // An ancestor with an <hr> directly under it is the answer where there is
  // one: that is demonstrably the level Claude's own separators live at. Where
  // the reply has no rules at all — which happens, and is exactly the reply
  // that most needs this to work — fall back to the nearest ancestor holding
  // more than one block, since a wrapper holding a single child tells us
  // nothing about where the ruling begins and ends.
  function proseRoot(msgEl, startEl) {
    let el = startEl;
    let roomy = null;
    while (el && el.parentElement && el !== msgEl) {
      const p = el.parentElement;
      try {
        if (p.querySelector(":scope > hr")) return p;
      } catch (e) {
        /* :scope is well supported; if it isn't, keep climbing */
      }
      if (!roomy && p.children.length > 1) roomy = p;
      if (p === msgEl) break;
      el = p;
    }
    return roomy || msgEl;
  }

  const HEADING_TAGS = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };
  function describe(el) {
    return {
      text: el.textContent || "",
      rule: el.tagName === "HR",
      heading: !!HEADING_TAGS[el.tagName],
    };
  }

  // ---- what actually goes on the clipboard ---------------------------------
  // Both forms are written out here rather than left to the browser, because
  // the browser's own answer to both is wrong for a document you are going to
  // paste into a minute order.
  //
  // **Plain.** Left to itself the serialiser spaces blocks by their margins, so
  // a heading and the paragraph under it come back glued together where two
  // paragraphs come back with a blank line between them. Uneven spacing in a
  // ruling is the thing you then fix by hand, which is the work this button
  // exists to save. Every block is separated by exactly one blank line.
  //
  // **Formatted.** A clone taken from claude.ai's page carries claude.ai's
  // page with it — its classes, and whatever Chrome bakes in from the computed
  // style — so a paste arrives in the chat's fonts, the chat's line height and
  // the chat's margins rather than the document's. Every attribute is stripped,
  // and headings become bold paragraphs: an <h1> pasted into Word is Word's own
  // Heading style, blue and sans-serif, which is not what a section heading in
  // a minute order looks like. What survives is the structure and the emphasis
  // — the italics on a case name, which is the formatting that carries meaning.
  const LIST_TAGS = { UL: 1, OL: 1 };
  const BLOCK_TAGS = {
    P: 1, DIV: 1, LI: 1, UL: 1, OL: 1, BLOCKQUOTE: 1, PRE: 1, TABLE: 1, TR: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
  };

  // A block's text on one line — except where the page draws a line break, which
  // is a break the writer asked for. textContent would run the words on either
  // side of a <br> together into one.
  function flatText(el) {
    let s = "";
    for (const n of Array.from(el.childNodes || [])) {
      if (n.nodeType === 3) s += n.nodeValue || "";
      else if (n.nodeType === 1) s += n.tagName === "BR" ? "\n" : flatText(n);
    }
    return s
      .replace(/[ \t ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim();
  }

  // One entry per block, in order, however deeply the page has nested them.
  function plainBlocks(node, out) {
    const kids = Array.from(node.children || []).filter((k) => BLOCK_TAGS[k.tagName]);
    if (!kids.length) {
      const t = flatText(node);
      if (t) out.push(t);
      return;
    }
    // A list is one block, its items a line each: a blank line between every
    // bullet turns a four-item list into half a page.
    if (LIST_TAGS[node.tagName]) {
      const lines = [];
      let n = 1;
      for (const li of kids) {
        const t = flatText(li);
        if (t) lines.push((node.tagName === "OL" ? n++ + ". " : "• ") + t);
      }
      if (lines.length) out.push(lines.join("\n"));
      return;
    }
    for (const k of kids) plainBlocks(k, out);
  }

  function neutralize(holder) {
    for (const el of Array.from(holder.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes || [])) {
        if (attr.name !== "href") el.removeAttribute(attr.name);
      }
    }
    // Headings to bold paragraphs, so a paste lands in the document's own font.
    for (const h of Array.from(holder.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
      const p = document.createElement("p");
      const b = document.createElement("strong");
      b.innerHTML = h.innerHTML;
      p.appendChild(b);
      h.replaceWith(p);
    }
    return holder.innerHTML;
  }

  // Copy a run of blocks, synchronously, so the write belongs to the click that
  // asked for it. The blocks are cloned somewhere off-screen first, which is
  // what lets a rule INSIDE the ruling be dropped — a range over the live page
  // would have to take whatever sits between its ends.
  function copyBlocks(nodes) {
    const holder = document.createElement("div");
    holder.className = "cum-ruling-clip";
    for (const n of nodes) {
      if (n.tagName === "HR") continue;
      holder.appendChild(n.cloneNode(true));
    }
    try {
      for (const hr of holder.querySelectorAll("hr")) hr.remove();
      for (const own of holder.querySelectorAll(".cum-ruling-btn")) own.remove();
    } catch (e) {
      /* ignore */
    }
    if (!holder.childNodes.length) return { ok: false, text: "" };

    const parts = [];
    for (const child of Array.from(holder.children)) plainBlocks(child, parts);
    const text = parts.join("\n\n");
    if (!text) return { ok: false, text: "" };
    const html = neutralize(holder);

    // Off-screen rather than hidden: display:none can't be selected, and the
    // copy command needs a selection to consent to run at all. What it would
    // have copied is then replaced with the two forms above.
    holder.style.cssText =
      "position:fixed;left:-99999px;top:0;width:760px;user-select:text;" +
      "-webkit-user-select:text;pointer-events:none;";
    document.body.appendChild(holder);

    const sel = window.getSelection();
    const saved = [];
    try {
      for (let i = 0; i < sel.rangeCount; i++) saved.push(sel.getRangeAt(i));
    } catch (e) {
      /* ignore */
    }
    function onCopy(e) {
      try {
        e.preventDefault();
        e.clipboardData.setData("text/plain", text);
        e.clipboardData.setData("text/html", html);
      } catch (err) {
        /* let the selection's own content stand rather than copying nothing */
      }
    }
    let ok = false;
    try {
      const range = document.createRange();
      range.selectNodeContents(holder);
      sel.removeAllRanges();
      sel.addRange(range);
      document.addEventListener("copy", onCopy, true);
      ok = !!document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.removeEventListener("copy", onCopy, true);
    try {
      sel.removeAllRanges();
      for (const r of saved) sel.addRange(r); // put your own selection back
    } catch (e) {
      /* ignore */
    }
    holder.remove();
    return { ok, text };
  }

  // → { ok, reason } | null when the message's shape can't be read at all, which
  // is the caller's cue to fall back to the markdown route.
  function copyFromPage(msgEl) {
    const startEl = findStartEl(msgEl);
    if (!startEl) return null;
    const root = proseRoot(msgEl, startEl);
    const blocks = Array.from(root.children);
    if (blocks.length < 2) return null;
    const plan = T.planBlocks(blocks.map(describe));
    if (!plan.ok) return null;
    // The block the plan chose has to be the one actually holding the heading.
    // Two ways of finding the same thing agreeing is the check; where they
    // don't, the markdown route is a better answer than a confident wrong cut.
    const chosen = blocks[plan.start];
    if (!chosen || !(chosen === startEl || chosen.contains(startEl))) return null;
    const out = copyBlocks(blocks.slice(plan.start, plan.end + 1));
    if (!out.ok) return null;
    return { ok: true, reason: plan.reason };
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
    // The page first, and without awaiting anything on the way: this write has
    // to happen inside the click that asked for it.
    try {
      const page = copyFromPage(msgEl);
      if (page) {
        say(btn, page.reason ? "Copied (no CONCLUSION)" : "Ruling copied");
        return;
      }
    } catch (e) {
      /* fall through to the markdown route */
    }
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
        // The clipboard is still holding claude.ai's copy of the WHOLE reply,
        // and saying nothing here is how the last version of this button
        // appeared to copy everything.
        say(btn, "Couldn't copy — whole reply", true);
        return;
      }
      // A caveat is worth a moment of the label rather than a silent success.
      const caveat = cut.reason ? "no CONCLUSION" : "as text";
      say(btn, "Copied (" + caveat + ")");
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

  // Exposed for tests: the page is the only place this can be exercised, and a
  // button that silently falls back is a button that looks like it worked.
  window.CUMCopyRuling = { findStartEl, proseRoot, describe, copyBlocks, copyFromPage };

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
