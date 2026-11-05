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
  const LINKS_CLASS = "cum-ruling-links";
  const PAIR_CLASS = "cum-ruling-pair"; // Ruling and Links, placed as one
  const PLACE_MS = 1500;
  const HOVER_MS = 400; // floor between hover-driven placement passes
  const FEEDBACK_MS = 2200;

  // Which elements are replies is written down once, in src/replycopy.js.
  const assistantMessages = RC.assistantMessages;

  function streaming(el) {
    try {
      if (el.closest('[data-is-streaming="true"]')) return true;
      if (el.getAttribute("data-is-streaming") === "true") return true;
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  // ---- what the page does not show ------------------------------------------
  // claude.ai labels each reply for screen readers — "Claude responded: " and
  // the reply's first line — in an element clipped to nothing. textContent reads
  // it like any other text, and a clone with its attributes stripped (see
  // neutralize) draws it, so a reply that opened with the ruling copied as
  // "Claude responded: NATURE OF PROCEEDINGS: ..." over the ruling proper. What
  // the page does not show is not the ruling: it is skipped when looking for the
  // heading, when reading a block's lines, and when copying.
  const UNSEEN_CLASS = /(?:^|\s)(?:sr-only|visually-hidden|screen-reader-only)(?:\s|$)/;
  const CLIPPED = /rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)/;
  function unseen(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.hidden) return true;
      if (UNSEEN_CLASS.test(el.getAttribute("class") || "")) return true;
      const cs = window.getComputedStyle(el);
      if (!cs) return false;
      if (cs.display === "none") return true;
      // The screen-reader recipe under any class name: out of the flow, and
      // clipped or shrunk to nothing.
      if (cs.position !== "absolute" && cs.position !== "fixed") return false;
      if (CLIPPED.test(cs.clip || "") || /inset\(\s*50%/.test(cs.clipPath || "")) return true;
      return parseFloat(cs.width) <= 1 && parseFloat(cs.height) <= 1 && cs.overflow === "hidden";
    } catch (e) {
      return false;
    }
  }
  function unseenWithin(el, stop) {
    for (let n = el; n && n !== stop; n = n.parentElement) if (unseen(n)) return true;
    return unseen(stop);
  }

  // ---- the ruling, out of the rendered message -----------------------------
  // The element the ruling starts at. Capped in length so the match is the
  // HEADING rather than some wrapper that contains the whole answer. One that
  // starts with the heading beats one where the heading shares its line with
  // something ahead of it, as in T.planBlocks — which has to pick the same
  // block, or copyFromPage stands down.
  const HEAD_SEL = "h1,h2,h3,h4,h5,h6,p,div,li,blockquote";
  const MAX_HEAD = 200;
  function findStartEl(msgEl) {
    let nodes;
    try {
      nodes = msgEl.querySelectorAll(HEAD_SEL);
    } catch (e) {
      return null;
    }
    let shared = null;
    for (const el of nodes) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > MAX_HEAD) continue;
      const how = T.rulingStart(t);
      if (!how || unseenWithin(el, msgEl)) continue;
      if (how === 2) return el;
      if (!shared) shared = el;
    }
    return shared;
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
  const LINE_TAGS = {
    P: 1, DIV: 1, LI: 1, UL: 1, OL: 1, BLOCKQUOTE: 1, PRE: 1, TABLE: 1, TR: 1, HR: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
  };

  // A block's lines, where the page draws them, each with whether it is set
  // wholly in bold. textContent has no line breaks: a <br> contributes nothing
  // and React puts no whitespace between sibling blocks, so `CONCLUSION` over a
  // one-sentence disposition came back as "CONCLUSIONThe hearing ..." — a
  // conclusion heading nothing could see, and a button saying "no CONCLUSION"
  // over a ruling that plainly had one. cutLines walks the same way, so a line
  // number from here is a line number there.
  const BOLD_TAGS = { STRONG: 1, B: 1 };
  function readLines(el) {
    const lines = [{ text: "", all: 0, bold: 0 }];
    const brk = () => lines.push({ text: "", all: 0, bold: 0 });
    (function go(node, inBold) {
      for (const n of Array.from(node.childNodes || [])) {
        if (unseen(n)) continue;
        if (n.nodeType === 3) {
          const v = n.nodeValue || "";
          const cur = lines[lines.length - 1];
          const k = v.replace(/\s+/g, "").length;
          cur.text += v;
          cur.all += k;
          if (inBold) cur.bold += k;
        } else if (n.nodeType !== 1) {
          continue;
        } else if (n.tagName === "BR") {
          brk();
        } else if (LINE_TAGS[n.tagName]) {
          brk();
          go(n, inBold || !!BOLD_TAGS[n.tagName]);
          brk();
        } else {
          go(n, inBold || !!BOLD_TAGS[n.tagName]);
        }
      }
    })(el, false);
    return lines.map((l) => ({ text: l.text, bold: l.all > 0 && l.bold === l.all }));
  }

  // Keep the first `keep` lines of a (cloned) block and drop the rest: the
  // commentary Claude wrote on the lines under the conclusion, inside the same
  // paragraph.
  function cutLines(root, keep) {
    let line = 0;
    const STOP = {};
    function dropFrom(node, inclusive) {
      let cur = node;
      let first = true;
      while (cur && cur !== root) {
        let sib = cur.nextSibling;
        while (sib) {
          const next = sib.nextSibling;
          sib.remove();
          sib = next;
        }
        const parent = cur.parentNode;
        if (first && inclusive) cur.remove();
        first = false;
        cur = parent;
      }
    }
    function brk(node, inclusive) {
      line++;
      if (line === keep) {
        dropFrom(node, inclusive);
        throw STOP;
      }
    }
    function go(node) {
      for (const n of Array.from(node.childNodes || [])) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "BR") brk(n, true);
        else if (LINE_TAGS[n.tagName]) {
          brk(n, true);
          go(n);
          brk(n, false);
        } else go(n);
      }
    }
    try {
      go(root);
    } catch (e) {
      if (e !== STOP) throw e;
    }
    // A <br> left dangling at the end draws an empty line under the ruling.
    for (let last = root.lastChild; last; last = root.lastChild) {
      if (last.nodeType === 1 && last.tagName === "BR") last.remove();
      else if (last.nodeType === 3 && !last.nodeValue.trim()) last.remove();
      else break;
    }
    return root;
  }

  // Is every word of the block inside <strong>/<b>? That is how Claude sets a
  // heading it didn't write as one ("**Change report**").
  function allBold(el) {
    const whole = (el.textContent || "").replace(/\s+/g, "");
    if (!whole) return false;
    let bold = "";
    try {
      for (const b of el.querySelectorAll("strong,b")) {
        const outer = b.parentElement && b.parentElement.closest("strong,b");
        if (outer && el.contains(outer)) continue; // counted with the bold around it
        bold += (b.textContent || "").replace(/\s+/g, "");
      }
    } catch (e) {
      return false;
    }
    return bold === whole;
  }

  function describe(el) {
    if (unseen(el)) return { text: "", lines: [], rule: false, heading: false, bold: false };
    const lines = readLines(el);
    return {
      text: lines.map((l) => l.text).join("\n"),
      lines,
      rule: el.tagName === "HR",
      heading: !!HEADING_TAGS[el.tagName],
      bold: allBold(el),
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

  // The one thing the formatted form states for itself. Stripping claude.ai's
  // styling takes its paragraph margins with it, and a target whose own
  // paragraph style has no space after it — which a pleading template usually
  // hasn't, being double-spaced and indented instead — then runs every
  // paragraph of the ruling into the one below it. Separation is what the
  // document is FOR: NATURE OF PROCEEDINGS is not the first line of the
  // paragraph under it. So it is carried explicitly, and it is the only thing
  // carried: no font, no size, no line height, no colour.
  const BLOCK_GAP = "margin:0 0 1em 0";

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
    for (const el of Array.from(holder.querySelectorAll("p,ul,ol,blockquote,pre,table"))) {
      if (!el.closest("li")) el.setAttribute("style", BLOCK_GAP);
    }
    return holder.innerHTML;
  }

  // Take out of a clone whatever its original does not show. The question has
  // to be asked of the ORIGINAL, where the page's styles apply; a clone and its
  // original list their elements in the same order. Done before cutLines, so
  // the lines it counts are the ones readLines counted.
  function dropUnseen(live, copy) {
    let a, b;
    try {
      a = live.querySelectorAll("*");
      b = copy.querySelectorAll("*");
    } catch (e) {
      return copy;
    }
    if (a.length !== b.length) return copy;
    const drop = [];
    for (let i = 0; i < a.length; i++) if (unseen(a[i])) drop.push(b[i]);
    for (const el of drop) el.remove();
    return copy;
  }

  // Copy a run of blocks, synchronously, so the write belongs to the click that
  // asked for it. The blocks are cloned somewhere off-screen first, which is
  // what lets a rule INSIDE the ruling be dropped — a range over the live page
  // would have to take whatever sits between its ends.
  // `endLine`, where it is not -1, is how many lines of the LAST node are the
  // ruling's (see planBlocks).
  function copyBlocks(nodes, endLine) {
    const holder = document.createElement("div");
    holder.className = "cum-ruling-clip";
    nodes.forEach((n, i) => {
      if (n.tagName === "HR" || unseen(n)) return;
      const copy = dropUnseen(n, n.cloneNode(true));
      if (i === nodes.length - 1 && endLine > 0) cutLines(copy, endLine);
      holder.appendChild(copy);
    });
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
  // The ruling's blocks on the page — { startEl, blocks, plan } — or null.
  function rulingCut(msgEl) {
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
    return { startEl, blocks: blocks.slice(plan.start, plan.end + 1), plan };
  }

  function copyFromPage(msgEl) {
    const cut = rulingCut(msgEl);
    if (!cut) return null;
    const plan = cut.plan;
    const out = copyBlocks(cut.blocks, plan.endLine);
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
  function say(btn, text, bad, rest) {
    btn.classList.toggle("cum-ruling-bad", !!bad);
    btn.querySelector(".cum-ruling-txt").textContent = text;
    clearTimeout(btn._cumTimer);
    btn._cumTimer = setTimeout(() => {
      btn._cumTimer = null;
      btn.classList.remove("cum-ruling-bad");
      const label = btn.querySelector(".cum-ruling-txt");
      if (label) label.textContent = btn._rest || rest || "Ruling";
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

  function build(msgEl, forLatest) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = CLASS + (forLatest ? " cum-ruling-latest" : "");
    btn.title = forLatest
      ? "Copy the most recent tentative ruling in this chat (from an earlier " +
        "reply) — NATURE OF PROCEEDINGS through the end of the CONCLUSION"
      : "Copy just the tentative ruling — NATURE OF PROCEEDINGS through the end " +
        "of the CONCLUSION, without the horizontal rules or anything either side";
    btn.setAttribute(
      "aria-label",
      forLatest ? "Copy the most recent tentative ruling in this chat" : "Copy the tentative ruling only"
    );
    btn.innerHTML =
      '<span class="cum-ruling-ico">§</span><span class="cum-ruling-txt">Ruling</span>';
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (forLatest) copyLatest(btn);
      else copyRuling(btn, msgEl);
    });
    // Its partner, Links: every hyperlink in the same ruling (the pdf viewer
    // links each record cite to its page), opened in tabs with one click.
    const links = document.createElement("button");
    links.type = "button";
    links.className = CLASS + " " + LINKS_CLASS;
    links.title = forLatest
      ? "Open every link in the most recent tentative ruling in this chat, each in its own tab"
      : "Open every link in this tentative ruling, each in its own tab";
    links.setAttribute("aria-label", links.title);
    links.innerHTML = '<span class="cum-ruling-ico">↗</span><span class="cum-ruling-txt">Links</span>';
    links.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLinks(links, forLatest ? null : msgEl);
    });
    const pair = document.createElement("span");
    pair.className = PAIR_CLASS;
    pair.append(btn, links);
    return pair;
  }

  // ---- Links ----------------------------------------------------------------
  // Every link in the ruling, opened the way the pdf viewer's Shift+Space
  // opens a selection's (T.orderLinks): cases first, then the code sections
  // and everything else, so the cases land as one run of tabs on the left.
  //
  // The pdf viewer does not put its links IN the reply. It paints them as
  // strips in a layer of its own over the page (#__cl_overlay), each carrying
  // its kind (data-kind), and only for the citations on screen. So the
  // viewer is asked for its whole inventory first (viewerInventory); a viewer
  // without that hook is handled by scrolling the ruling through, half a screen
  // at a time, gathering the strips lying over its blocks as they are painted,
  // and putting the scroll back after. Ordinary links inside the ruling's
  // blocks count either way.
  const OVERLAY_SEL = "a.cl-citation-link";
  const STEP_MS = 160; // long enough for the viewer to repaint after a scroll
  const MAX_STEPS = 80;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function scrollerOf(el) {
    for (let p = el && el.parentElement; p; p = p.parentElement) {
      try {
        if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 20) return p;
      } catch (e) {
        /* keep looking */
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  // Remember where the view is, by what is in it rather than by number: a
  // ruling loading or unloading above the view changes every number below it
  // (and Chrome's scroll anchoring moves the view to suit). → restore(), which
  // puts the bottom back at the bottom, or the same reply at the same height,
  // and looks again once claude.ai has finished loading and unloading.
  function holdView(sc, anchorEl) {
    const atBottom = sc.scrollHeight - sc.clientHeight - sc.scrollTop < 60;
    const top = anchorEl ? anchorEl.getBoundingClientRect().top : 0;
    const back = sc.scrollTop;
    const put = () => {
      try {
        if (atBottom) sc.scrollTop = sc.scrollHeight;
        else if (anchorEl && anchorEl.isConnected) sc.scrollTop += anchorEl.getBoundingClientRect().top - top;
        else sc.scrollTop = back;
      } catch (e) {
        /* ignore */
      }
    };
    return () => {
      put();
      setTimeout(put, 250);
      setTimeout(put, 800);
    };
  }

  function viewOf(sc) {
    const whole = { top: 0, bottom: window.innerHeight };
    if (sc === document.scrollingElement || sc === document.documentElement) return whole;
    const r = sc.getBoundingClientRect();
    return { top: Math.max(0, r.top), bottom: Math.min(window.innerHeight, r.bottom) };
  }

  function rulingBlocksOf(msgEl) {
    const cut = rulingCut(msgEl);
    return cut ? cut.blocks : [msgEl];
  }

  // One look: the links over or in the ruling's blocks right now, measured
  // from the top of its first block so looks at different scrolls compare.
  function gather(blocks, into) {
    const frame = blocks[0].getBoundingClientRect();
    const boxes = blocks.map((b) => b.getBoundingClientRect());
    const over = (r) => {
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return boxes.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
    };
    const add = (a, url) => {
      const r = a.getBoundingClientRect();
      into.push({ url: url, kind: a.getAttribute("data-kind"), top: r.top - frame.top, left: r.left - frame.left });
    };
    for (const a of document.querySelectorAll(OVERLAY_SEL)) {
      const r = a.getBoundingClientRect();
      if (r.width >= 1 && r.height >= 1 && over(r)) add(a, a.href);
    }
    for (const b of blocks) {
      const own = b.matches && b.matches("a[href]") ? [b] : [];
      for (const a of own.concat(Array.from(b.querySelectorAll("a[href]")))) {
        if (a.closest("." + PAIR_CLASS) || unseenWithin(a, b)) continue;
        add(a, a.getAttribute("href"));
      }
    }
  }

  // The pdf viewer's whole inventory, asked for over a DOM event (its
  // content/claude-citations.js answers "cl-citations-request" at once with
  // "cl-citations", a JSON string: every citation in the loaded text, drawn or
  // not, with its kind and where it sits). → the citations, or null where no
  // viewer answered (not installed, or a version without the hook).
  function viewerInventory() {
    let got = null;
    const take = (ev) => {
      if (typeof ev.detail === "string") got = ev.detail;
    };
    try {
      document.addEventListener("cl-citations", take);
      document.dispatchEvent(new CustomEvent("cl-citations-request"));
    } catch (e) {
      got = null;
    } finally {
      document.removeEventListener("cl-citations", take);
    }
    if (got === null) return null;
    try {
      const data = JSON.parse(got);
      return data && Array.isArray(data.citations) ? data.citations : null;
    } catch (e) {
      return null;
    }
  }

  // From the inventory: the citations lying over the ruling's blocks, and the
  // ordinary links inside them. No scrolling — the inventory is the whole
  // loaded ruling. → the URLs in order, or null to fall back to scrolling.
  function linksFromInventory(msgEl) {
    const inv = viewerInventory();
    if (!inv) return null;
    const blocks = rulingBlocksOf(msgEl);
    const frame = blocks[0].getBoundingClientRect();
    const boxes = blocks.map((b) => b.getBoundingClientRect());
    const hits = [];
    for (const c of inv) {
      const r = c && Array.isArray(c.rects) ? c.rects[0] : null;
      if (!r || typeof c.url !== "string") continue;
      const x = (r.left + r.right) / 2;
      const y = (r.top + r.bottom) / 2;
      if (!boxes.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)) continue;
      hits.push({ url: c.url, kind: c.kind, top: r.top - frame.top, left: r.left - frame.left });
    }
    // The page's own links in the ruling (the inventory is the viewer's only).
    for (const b of blocks) {
      const own = b.matches && b.matches("a[href]") ? [b] : [];
      for (const a of own.concat(Array.from(b.querySelectorAll("a[href]")))) {
        if (a.closest("." + PAIR_CLASS) || unseenWithin(a, b)) continue;
        const r = a.getBoundingClientRect();
        hits.push({ url: a.getAttribute("href"), kind: a.getAttribute("data-kind"), top: r.top - frame.top, left: r.left - frame.left });
      }
    }
    return T.orderLinks(hits, location.href);
  }

  // → the URLs to open, in order: from the viewer's inventory where it
  // answers, else by scrolling the ruling through the view and gathering the
  // painted strips as it goes. The view is put back where it was.
  async function harvestLinks(msgEl) {
    try {
      const quick = linksFromInventory(msgEl);
      if (quick) return quick;
    } catch (e) {
      /* the scroll below */
    }
    const hits = [];
    const sc = scrollerOf(msgEl);
    const restore = holdView(sc, msgEl);
    try {
      const blocks = rulingBlocksOf(msgEl);
      gather(blocks, hits);
      let v = viewOf(sc);
      const first = blocks[0].getBoundingClientRect();
      if (first.top < v.top || first.top > v.bottom - 40) {
        sc.scrollTop += first.top - v.top - 40;
        await wait(STEP_MS);
      }
      for (let i = 0; i < MAX_STEPS && msgEl.isConnected; i++) {
        gather(blocks, hits);
        v = viewOf(sc);
        const height = v.bottom - v.top;
        // Done once the ruling's end has been in the upper part of the view —
        // the viewer paints nothing under the composer at the bottom.
        if (blocks[blocks.length - 1].getBoundingClientRect().bottom <= v.bottom - height * 0.35) break;
        const before = sc.scrollTop;
        sc.scrollTop = before + Math.max(120, height * 0.5);
        if (sc.scrollTop === before) break;
        await wait(STEP_MS);
      }
    } finally {
      restore();
    }
    return T.orderLinks(hits, location.href);
  }

  // ---- Links on the most recent ruling only ---------------------------------
  // Every reply with a ruling keeps its Ruling button, but Links sits only on
  // the chat's most recent ruling (owner, November 2026) — and on the bottom
  // pair, which acts on that same ruling. The most recent is the one the
  // bottom button remembers (latest.state.rulingSig); before it knows one, the
  // last reply on the page carrying a Ruling button.
  const LABEL_MS = 3000;
  let lastLabelPass = 0;
  function showLinksOnLatest(msgs) {
    const sig = latest.state && latest.state.rulingSig;
    let lastWithPair = null;
    for (const el of msgs) if (placed.get(el)) lastWithPair = el;
    const refresh = Date.now() - lastLabelPass >= LABEL_MS;
    if (refresh) lastLabelPass = Date.now();
    for (const el of msgs) {
      const pair = placed.get(el);
      const links = pair && pair.querySelector ? pair.querySelector("." + LINKS_CLASS) : null;
      if (!links) continue;
      let show = false;
      try {
        show = sig ? sigOf(el) === sig : el === lastWithPair;
      } catch (e) {
        show = el === lastWithPair;
      }
      links.style.display = show ? "" : "none";
      if (show && refresh && !links.disabled) refreshLinksLabel(links, el);
    }
    const bottom = extra && extra.btn && extra.btn.querySelector ? extra.btn.querySelector("." + LINKS_CLASS) : null;
    if (bottom && refresh && !bottom.disabled) refreshLinksLabel(bottom, null);
  }

  // ---- open, and press again to close -----------------------------------
  // The tabs a press opened are remembered by the worker under a key naming
  // the chat and the ruling, so the next press of either Links button for the
  // same ruling closes them (only those still open). The ruling is named by
  // T.textKey of claude.ai's own text — the page's, the kept copy's and the
  // payload's all agree on it.
  function rulingIdOf(msgEl) {
    if (msgEl) return T.textKey(plainOf(msgEl));
    const live = liveRuling();
    if (live) return T.textKey(plainOf(live));
    if (latest.copy) return T.textKey(latest.copy.textContent || "");
    return latest.api ? latest.api.key : "";
  }
  function setKeyOf(msgEl) {
    const id = rulingIdOf(msgEl);
    return id ? location.pathname + "|" + id : "";
  }

  function ask(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch (e) {
        resolve(null); // the extension was reloaded under this page
      }
    });
  }

  // The label at rest: "Close links" while this ruling's tabs are open.
  function restLabel(btn, open) {
    btn._rest = open ? "Close links" : "Links";
    btn.classList.toggle("cum-ruling-open", !!open);
    if (!btn._cumTimer && !btn.disabled) btn.querySelector(".cum-ruling-txt").textContent = btn._rest;
  }

  async function refreshLinksLabel(btn, msgEl) {
    const key = setKeyOf(msgEl);
    if (!key) return restLabel(btn, false);
    const res = await ask({ type: "cum-links-state", key: key });
    restLabel(btn, !!(res && res.open));
  }

  function sendOpen(btn, urls, key) {
    const done = (res) => {
      btn.disabled = false;
      const n = res && typeof res.opened === "number" ? res.opened : 0;
      if (!res || !res.ok || !n) return say(btn, "Couldn't open", true, btn._rest || "Links");
      restLabel(btn, true);
      say(btn, n < urls.length ? "Opened " + n + " of " + urls.length : "Opened " + n, false, "Close links");
    };
    try {
      // The group is named for the chat as the tab shows it.
      const group = T.linksGroupTitle(document.title);
      chrome.runtime.sendMessage({ type: "cum-open-links", urls: urls, key: key || "", group: group }, (res) => {
        void chrome.runtime.lastError;
        done(res);
      });
    } catch (e) {
      done(null); // the extension was reloaded under this page: reload the tab
    }
  }

  // ---- Links for a ruling that is not on the page ---------------------------
  // The bottom Links button with the ruling scrolled far away and unloaded.
  // Scrolling up to it is slow and can miss; the button already HAS the
  // ruling's text — the kept copy, or claude.ai's own copy of the
  // conversation — so the pdf viewer is handed that text instead
  // ("cl-citations-in-text", answered at once with "cl-citations-in-text-
  // result": every citation it finds, with its kind and where it sits in the
  // text). No answer (a viewer without the hook) falls back to the trip up.

  // The kept ruling's text: the kept copy put on the page out of sight, read,
  // and cut to NATURE OF PROCEEDINGS through the CONCLUSION.
  function keptRulingText() {
    if (latest.copy) {
      const box = document.createElement("div");
      box.setAttribute("aria-hidden", "true");
      box.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;opacity:0;pointer-events:none";
      const el = latest.copy.cloneNode(true);
      box.appendChild(el);
      document.body.appendChild(box);
      try {
        const cut = T.extractRuling(el.innerText || "");
        if (cut.ok) return cut.text;
      } catch (e) {
        /* the payload's copy, below */
      } finally {
        box.remove();
      }
    }
    if (latest.api && latest.api.text) {
      const cut = T.extractRuling(latest.api.text);
      if (cut.ok) return cut.text;
    }
    return "";
  }

  // → the URLs to open, in order, or null where the viewer did not answer.
  function linksFromText(text) {
    if (!text) return null;
    let got = null;
    const take = (ev) => {
      if (typeof ev.detail === "string") got = ev.detail;
    };
    try {
      document.addEventListener("cl-citations-in-text-result", take);
      document.dispatchEvent(new CustomEvent("cl-citations-in-text", { detail: JSON.stringify({ text: text }) }));
    } catch (e) {
      got = null;
    } finally {
      document.removeEventListener("cl-citations-in-text-result", take);
    }
    if (got === null) return null;
    let list;
    try {
      const data = JSON.parse(got);
      list = data && Array.isArray(data.citations) ? data.citations : null;
    } catch (e) {
      list = null;
    }
    if (!list) return null;
    // Reading order is the text's: an offset stands in for a position.
    return T.orderLinks(
      list.map((c) => ({ url: c && c.url, kind: c && c.kind, top: Number(c && c.start) || 0, left: 0 })),
      location.href
    );
  }

  async function openLinks(btn, msgEl) {
    if (btn.disabled) return;
    btn.disabled = true;
    // Already open: this press closes them.
    const key = setKeyOf(msgEl);
    if (key) {
      const state = await ask({ type: "cum-links-state", key: key });
      if (state && state.open) {
        const res = await ask({ type: "cum-close-links", key: key });
        btn.disabled = false;
        restLabel(btn, false);
        const n = res && typeof res.closed === "number" ? res.closed : 0;
        return say(btn, n ? "Closed " + n : "Couldn't close", !n, "Links");
      }
    }
    btn.querySelector(".cum-ruling-txt").textContent = "Finding links…";
    let target = msgEl;
    let restore = null;
    try {
      if (!target) {
        const live = liveRuling();
        if (live) target = live;
        else {
          // Not on the page: from its text, when the viewer will read one.
          let urls = null;
          try {
            urls = linksFromText(keptRulingText());
          } catch (e) {
            urls = null;
          }
          if (urls) {
            if (!urls.length) {
              btn.disabled = false;
              return say(btn, "No links found", true, btn._rest || "Links");
            }
            btn.querySelector(".cum-ruling-txt").textContent = "Opening " + urls.length + "…";
            return sendOpen(btn, urls, key);
          }
          const found = await rulingForLatest();
          target = found.el;
          restore = found.restore;
        }
      }
      if (!target) {
        btn.disabled = false;
        return say(btn, "No ruling found", true, btn._rest || "Links");
      }
      const urls = await harvestLinks(target);
      if (restore) restore();
      if (!urls.length) {
        btn.disabled = false;
        return say(btn, "No links found", true, btn._rest || "Links");
      }
      btn.querySelector(".cum-ruling-txt").textContent = "Opening " + urls.length + "…";
      sendOpen(btn, urls, key);
    } catch (e) {
      if (restore) restore();
      btn.disabled = false;
      say(btn, "Couldn't open", true, btn._rest || "Links");
    }
  }

  // Beside the copy box, in claude.ai's own action bar, where there is one: this
  // is a copy control, and the place a copy control is looked for is next to
  // the other one. Where there isn't — the merged Chat/Cowork page drew no bar
  // this could find, and the button simply never appeared — it goes in a row
  // of its own under the reply. T.rulingSpot makes the call.
  const placed = new WeakMap(); // reply → our button
  const wantedSince = new WeakMap(); // reply → when it first wanted one
  // Every button this script drew — taken down on a page that offers none.
  function removeAll() {
    for (const el of document.querySelectorAll(".cum-ruling-row,." + PAIR_CLASS + ",." + CLASS)) el.remove();
  }

  function place() {
    if (!T.rulingPage(location.pathname)) {
      if (document.querySelector("." + CLASS)) removeAll();
      return;
    }
    const now = Date.now();
    const msgs = Array.from(assistantMessages());
    for (const msgEl of msgs) {
      // Asked first because it is the cheap question, and because on most
      // replies the answer is no: only where there is actually a ruling to
      // copy, and not while the answer is still being written — half a ruling
      // pasted into a minute order is worse than none, and the heading shows up
      // early in the stream.
      const hasRuling = T.mentionsRuling(msgEl.textContent);
      const wanted = hasRuling && !streaming(msgEl);
      let mine = placed.get(msgEl) || null;
      // claude.ai rebuilds its action bar on hover, taking our button with it.
      if (mine && !mine.isConnected) {
        placed.delete(msgEl);
        mine = null;
      }
      if (!wanted) wantedSince.delete(msgEl);
      else if (!wantedSince.has(msgEl)) wantedSince.set(msgEl, now);
      const bar = wanted && !mine ? RC.findCopyButton(msgEl) : null;
      const spot = T.rulingSpot({
        wanted,
        placed: !!mine,
        bar: !!(bar && bar.parentElement),
        waitedMs: wanted ? now - wantedSince.get(msgEl) : 0,
      });
      try {
        if (spot === "remove") {
          const row = mine.closest(".cum-ruling-row");
          (row || mine).remove();
          placed.delete(msgEl);
        } else if (spot === "bar") {
          const btn = build(msgEl);
          bar.parentElement.insertBefore(btn, bar.nextSibling);
          placed.set(msgEl, btn);
        } else if (spot === "below" && msgEl.parentElement) {
          const row = document.createElement("div");
          row.className = "cum-ruling-row";
          const btn = build(msgEl);
          row.appendChild(btn);
          msgEl.parentElement.insertBefore(row, msgEl.nextSibling);
          placed.set(msgEl, btn);
        }
      } catch (e) {
        /* a page that won't take it is a button we simply don't offer */
      }
    }
    placeExtra(msgs);
    showLinksOnLatest(msgs);
    // A row under a reply claude.ai has since unloaded is left behind on its
    // own: nothing to copy from, so it goes too.
    try {
      const live = new Set(msgs);
      for (const row of document.querySelectorAll(".cum-ruling-row")) {
        if (!live.has(row.previousElementSibling)) row.remove();
      }
    } catch (e) {
      /* ignore */
    }
  }

  // ---- the second button: the latest ruling, from the bottom of the chat ----
  // A ruling followed by more back-and-forth used to mean scrolling back up to
  // its own button. The newest reply gets a second one that copies the most
  // recent ruling above it, placed the same way as the first: in the newest
  // reply's action bar, else in a row under it. Only ever one.
  //
  // Only a reply with a ruling in it counts here (holdsRuling) — a reply that
  // merely talks about NATURE OF PROCEEDINGS is not one, and a chat with no
  // ruling gets no button.
  //
  // claude.ai unloads replies scrolled far out of view, so the ruling is
  // remembered (T.latestRulingCopy keeps the state) and a copy of it is kept
  // off the page: the button stays put until a new response comes in, and
  // copies the remembered ruling when its reply is no longer loaded.
  const SIG_SKIP = ".cum-ruling-btn,.cum-ruling-row,.cum-ruling-pair";
  const V = window.CUMPseudoView || null;
  function sigOf(el) {
    let text = "";
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const p = node.parentElement;
        if (p && p.closest(SIG_SKIP)) continue;
        // claude.ai's own text, not the translation: a reply must keep its
        // signature when the fakes toggle flips.
        text += V && V.nodeOriginal ? V.nodeOriginal(node) : node.nodeValue;
      }
    } catch (e) {
      text = el.textContent || "";
    }
    text = text.replace(/\s+/g, " ").trim();
    return text.length + "|" + text.slice(0, 160) + "|" + text.slice(-160);
  }

  // A reply that has a ruling in it, not one that talks about one: a block
  // that opens with NATURE OF PROCEEDINGS, or the all-caps heading sharing its
  // line with something else AND a block that opens with CONCLUSION (welded
  // to its sentence or not). Stricter
  // than the per-reply button's test on purpose — that one sits on the reply
  // itself, where a false alarm is one stray button; this one goes at the
  // bottom of every chat that merely mentions the words.
  function holdsRuling(msgEl) {
    if (!T.mentionsRuling(msgEl.textContent)) return false;
    const start = findStartEl(msgEl);
    if (!start) return false;
    const t = (start.textContent || "").replace(/\s+/g, " ").trim();
    if (T.rulingStart(t) === 2) return true;
    for (const el of msgEl.querySelectorAll(HEAD_SEL)) {
      const x = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (x && x.length <= MAX_HEAD && T.opensConclusion(x) && !unseenWithin(el, msgEl)) return true;
    }
    return false;
  }

  let latest = { conv: "", state: null, copy: null, copySig: "", api: null, apiAsked: "" };
  let extra = null; // { hostEl, btn }
  const everPlaced = new Set(); // host signatures the button has been on
  let extraHostEl = null;
  let extraWantedSince = 0;

  function removeExtra() {
    if (!extra) return;
    try {
      const row = extra.btn.closest(".cum-ruling-row");
      (row || extra.btn).remove();
    } catch (e) {
      /* already gone */
    }
    extra = null;
  }

  // The remembered ruling's reply as it is on the page now, or null.
  function liveRuling() {
    const sig = latest.state && latest.state.rulingSig;
    if (!sig) return null;
    for (const el of assistantMessages()) if (sigOf(el) === sig) return el;
    return null;
  }

  // Copy the remembered ruling whose reply is no longer on the page: its kept
  // copy is put on the page out of sight for the length of the copy.
  function copyKept(btn) {
    const kept = latest.copy;
    if (!kept) return say(btn, "No ruling found", true);
    const box = document.createElement("div");
    box.setAttribute("aria-hidden", "true");
    box.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;opacity:0;pointer-events:none";
    const el = kept.cloneNode(true);
    box.appendChild(el);
    document.body.appendChild(box);
    try {
      // Kept as claude.ai wrote it; shown as the page shows names right now.
      if (V && V.showLike) V.showLike(el);
      const page = copyFromPage(el);
      if (page) return say(btn, page.reason ? "Copied (no CONCLUSION)" : "Ruling copied");
      const cut = T.extractRuling(el.innerText || "");
      if (!cut.ok) return say(btn, "No ruling found", true);
      write(cut.text).then((ok) =>
        ok ? say(btn, "Copied (" + (cut.reason ? "no CONCLUSION" : "as text") + ")") : say(btn, "Couldn't copy", true)
      );
    } catch (e) {
      say(btn, "Couldn't copy", true);
    } finally {
      box.remove();
    }
  }

  // ---- a ruling the page has not shown this visit -------------------------
  // Open an old chat and go straight to the bottom, and the ruling higher up
  // may never be loaded at all. The conversation payload says whether there
  // is one (T.holdsRulingText over claude.ai's own copy of each reply), and
  // the bottom buttons go up on its word. Pressed, they scroll up to it,
  // let claude.ai load it, act on it, and put the view back.
  const SEEK_MS = 350; // claude.ai can take a moment to load what scrolls in
  const MAX_SEEK = 80;
  const Cv = window.CUMConv || null;
  const Md = window.CUMMdExport || null;
  const Wf = window.CUMWorkflow || null;

  function plainOf(el) {
    try {
      return V && V.plainText ? V.plainText(el) : el.textContent || "";
    } catch (e) {
      return el.textContent || "";
    }
  }

  function checkApi(hostSig) {
    if (!Cv || !Md || !Wf || !Wf.conversationId) return;
    const uuid = Wf.conversationId(location.pathname);
    if (!uuid) return;
    const ask = uuid + "|" + (hostSig || "");
    if (latest.apiAsked === ask) return; // once per newest reply
    latest.apiAsked = ask;
    const conv = latest.conv;
    Cv.get(uuid)
      .then((data) => {
        if (!data || latest.conv !== conv) return;
        const replies = Md.messagesOf(data)
          .filter((m) => String((m && (m.sender || m.role)) || "").toLowerCase() === "assistant")
          .map((m) => Md.parts(m).text || "");
        let i = -1;
        for (let k = replies.length - 1; k >= 0; k--) {
          if (T.holdsRulingText(replies[k])) {
            i = k;
            break;
          }
        }
        latest.api =
          i === -1
            ? null
            : {
                i: i,
                n: replies.length,
                key: T.textKey(replies[i]),
                keys: replies.map(T.textKey),
                newest: T.textKey(replies[replies.length - 1]),
                text: replies[i],
              };
      })
      .catch(() => {
        /* no word from the payload: the page alone decides, as before */
      });
  }

  // Scroll until the latest ruling is on the page. → the reply, or null.
  async function seekRuling(sc) {
    const api = latest.api;
    let jumped = false;
    let dir = -1; // up first: the latest ruling is above the newest reply
    let turned = false;
    for (let t = 0; t < MAX_SEEK; t++) {
      const msgs = Array.from(assistantMessages());
      const keys = msgs.map((el) => T.textKey(plainOf(el)));
      let nearest = null;
      for (let k = msgs.length - 1; k >= 0; k--) {
        if (!holdsRuling(msgs[k])) continue;
        nearest = nearest || msgs[k];
        // The payload names the one wanted; without it, the first found going
        // up from the bottom is the latest.
        if (!api || !api.key || sameKey(keys[k], api.key)) return msgs[k];
      }
      const height = sc.clientHeight || window.innerHeight;
      const span = Math.max(0, sc.scrollHeight - sc.clientHeight);
      let delta = dir * height * 0.8;
      if (api && api.n) {
        let j = -1;
        for (let k = 0; k < keys.length && j === -1; k++) j = api.keys.findIndex((x) => sameKey(x, keys[k]));
        if (j !== -1) {
          const est = (span * (api.i - j)) / api.n;
          delta = api.i < j ? Math.min(-height * 0.6, est) : Math.max(height * 0.6, est);
        } else if (!jumped) {
          jumped = true;
          sc.scrollTop = (span * api.i) / api.n;
          await wait(SEEK_MS);
          continue;
        }
      }
      const before = sc.scrollTop;
      sc.scrollTop = before + delta;
      if (sc.scrollTop === before) {
        // At the end of the chat with a ruling on the page and none matching
        // the payload exactly: the one on the page is the one there is.
        if (nearest) return nearest;
        // An estimate that overshot leaves it past the ruling: go back the
        // other way, once, a screen at a time.
        if (turned) return null;
        turned = true;
        dir = -dir;
        jumped = true;
        continue;
      }
      await wait(SEEK_MS);
    }
    return null;
  }

  // Two sightings of one reply: their openings agree. The full key can part
  // late on (a table, a markdown construct the page draws differently).
  function sameKey(a, b) {
    return !!a && !!b && (a === b || a.slice(0, 40) === b.slice(0, 40));
  }

  // The latest ruling's reply for the bottom buttons: on the page, or scrolled
  // to. → { el, restore } — restore() puts the view back where it was.
  async function rulingForLatest() {
    const live = liveRuling();
    if (live) return { el: live, restore: null };
    const anchor = (extra && extra.hostEl) || assistantMessages()[0];
    if (!anchor) return { el: null, restore: null };
    const sc = scrollerOf(anchor);
    const restore = holdView(sc, anchor);
    let el = null;
    try {
      el = await seekRuling(sc);
    } catch (e) {
      el = null;
    }
    if (!el) {
      restore();
      return { el: null, restore: null };
    }
    // Remember it now, so the next press needs no trip up.
    try {
      latest.state = Object.assign({}, latest.state, { rulingSig: sigOf(el) });
      latest.copy = V && V.originalClone ? V.originalClone(el) : el.cloneNode(true);
      latest.copySig = sigOf(el);
    } catch (e) {
      /* found is enough for this press */
    }
    return { el: el, restore: restore };
  }

  async function copyLatest(btn) {
    const live = liveRuling();
    if (live) return copyRuling(btn, live);
    if (latest.copy) return copyKept(btn);
    if (btn.disabled) return;
    btn.disabled = true;
    btn.querySelector(".cum-ruling-txt").textContent = "Finding ruling…";
    const found = await rulingForLatest();
    btn.disabled = false;
    if (!found.el) return say(btn, "No ruling found", true);
    // A copy needs the click that asked for it, and the trip up may have
    // outlasted it: then the ruling is remembered and the next click copies.
    const fresh = !navigator.userActivation || navigator.userActivation.isActive;
    if (fresh) {
      try {
        const page = copyFromPage(found.el);
        if (found.restore) found.restore();
        if (page) return say(btn, page.reason ? "Copied (no CONCLUSION)" : "Ruling copied");
      } catch (e) {
        /* fall through */
      }
    }
    if (found.restore) found.restore();
    say(btn, "Found — click again to copy");
  }

  function placeExtra(msgs) {
    const conv = location.pathname;
    if (latest.conv !== conv) {
      removeExtra();
      latest = { conv: conv, state: null, copy: null, copySig: "", api: null, apiAsked: "" };
      everPlaced.clear();
    }
    const mounted = msgs.map((el) => {
      const busy = streaming(el);
      let ruling = false;
      try {
        ruling = !busy && holdsRuling(el);
      } catch (e) {
        ruling = false;
      }
      return { sig: sigOf(el), ruling: ruling, streaming: busy };
    });
    let atBottom = false;
    try {
      const lastEl = msgs[msgs.length - 1];
      atBottom = !!lastEl && lastEl.getBoundingClientRect().bottom <= window.innerHeight;
    } catch (e) {
      atBottom = false;
    }
    // Nothing on the page this visit: ask the payload whether there is a
    // ruling above the newest reply.
    const seen = !!(latest.state && latest.state.rulingSig) || mounted.some((m) => m.ruling);
    const last = msgs[msgs.length - 1];
    if (!seen && last && !mounted[mounted.length - 1].streaming) checkApi(mounted[mounted.length - 1].sig);
    let unseenRuling = false;
    if (!seen && latest.api && last) {
      // Not when the newest reply IS that ruling: its own buttons are there.
      unseenRuling = T.textKey(plainOf(last)) !== latest.api.key;
    }
    const pick = T.latestRulingCopy(latest.state, mounted, { atBottom: atBottom, unseenRuling: unseenRuling });
    latest.state = pick.state;
    // Keep a copy of the ruling while it is on the page, for when it is not.
    const keepSig = pick.from !== -1 ? mounted[pick.from].sig : "";
    if (pick.from !== -1 && latest.copySig !== keepSig) {
      try {
        latest.copy = V && V.originalClone ? V.originalClone(msgs[pick.from]) : msgs[pick.from].cloneNode(true);
        latest.copySig = keepSig;
      } catch (e) {
        /* the live reply is copied when it is back */
      }
    }
    const host = pick.host !== -1 ? msgs[pick.host] : null;
    if (extra && (extra.hostEl !== host || !extra.btn.isConnected)) removeExtra();
    if (!host || extra) return;
    if (extraHostEl !== host) {
      extraHostEl = host;
      extraWantedSince = Date.now();
    }
    const hostSig = mounted[pick.host].sig;
    const bar = RC.findCopyButton(host);
    const spot = T.rulingSpot({
      wanted: true,
      placed: false,
      bar: !!(bar && bar.parentElement),
      // Back on a reply it was already on (claude.ai re-drew it): no grace.
      waitedMs: everPlaced.has(hostSig) ? T.BELOW_AFTER_MS : Date.now() - extraWantedSince,
    });
    try {
      if (spot === "bar") {
        const btn = build(null, true);
        bar.parentElement.insertBefore(btn, bar.nextSibling);
        extra = { hostEl: host, btn: btn };
      } else if (spot === "below" && host.parentElement) {
        const row = document.createElement("div");
        row.className = "cum-ruling-row";
        const btn = build(null, true);
        row.appendChild(btn);
        host.parentElement.insertBefore(row, host.nextSibling);
        extra = { hostEl: host, btn: btn };
      }
      if (extra) everPlaced.add(hostSig);
    } catch (e) {
      /* a page that won't take it is a button we simply don't offer */
    }
  }

  // Exposed for tests: the page is the only place this can be exercised, and a
  // button that silently falls back is a button that looks like it worked.
  window.CUMCopyRuling = {
    findStartEl, proseRoot, describe, readLines, cutLines, copyBlocks, copyFromPage, unseen,
  };

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
