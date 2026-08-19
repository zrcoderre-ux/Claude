/**
 * Claude Usage Meter — table of contents for a conversation (pure module).
 *
 * A long chat is a scroll bar and nothing else. This turns CLAUDE'S REPLIES
 * into a list you can jump between (the owner's spec — the replies are where
 * the work product is; the prompts were tracked first and asked for less
 * often) — the same job a table of authorities does in a brief, so the shape
 * of a conversation is visible without reading it. Each entry also carries
 * the key of the prompt it ANSWERS, which is how a workflow step — identified
 * by its prompt — still finds its place in the list.
 *
 * Only the labelling and list-building live here. Finding the messages and
 * scrolling to them is DOM work and belongs in src/toc-panel.js; this is the
 * part worth testing, because a label that says nothing makes the list useless
 * and a label that lies makes it worse than useless.
 */
(function (root) {
  "use strict";

  const MAX_LABEL = 80;

  function str(x) {
    return typeof x === "string" ? x : x == null ? "" : String(x);
  }

  // The first line that carries any meaning. A prompt often opens with a skill
  // invocation — "Use the devils-advocate skill." — and if every entry in the
  // list said that, the list would distinguish nothing. So a first line that is
  // only an instruction to Claude is stepped over in favour of the next one,
  // unless it's all there is.
  const BOILERPLATE = /^(use the [\w-]+ skill|continue|go on|thanks?|ok(ay)?)\b[.!]?$/i;

  function meaningfulLines(text) {
    return str(text)
      .split("\n")
      .map((l) =>
        l
          // Markdown decoration is not part of what the line says.
          .replace(/^[\s>#*\-•\d.)\]]+/, "")
          .replace(/[*_`]+/g, "")
          .trim()
      )
      .filter((l) => l.length > 0);
  }

  // A label for one message. Cut on a word boundary where there is one — a
  // label ending mid-word reads as though the text is missing rather than
  // shortened.
  function tocLabel(text, max) {
    const cap = typeof max === "number" && max > 8 ? max : MAX_LABEL;
    const lines = meaningfulLines(text);
    if (!lines.length) return "";
    let line = lines.find((l) => !BOILERPLATE.test(l)) || lines[0];
    if (line.length <= cap) return line;
    const cut = line.slice(0, cap);
    const space = cut.lastIndexOf(" ");
    return (space > cap * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:—-]+$/, "") + "…";
  }

  // The list itself. Numbered from 1 in the order they were sent, because the
  // number is what you actually navigate by ("the third thing I asked"), and
  // it's the one part of an entry that can't be ambiguous.
  //
  // Messages with nothing to label — an upload with no words, say — still get
  // an entry: they happened, they take up room in the chat, and a list that
  // skipped them would put entry 4 where the fifth message is.
  function tocEntries(messages) {
    const out = [];
    for (const m of messages || []) {
      if (!m) continue;
      const text = typeof m === "string" ? m : str(m.text);
      const label = tocLabel(text);
      out.push({
        n: out.length + 1,
        id: (typeof m === "object" && m.id) || null,
        key: entryKey(text),
        // The message this one ANSWERS — the preceding prompt's key, where the
        // caller knows it. The list tracks Claude's replies now (the owner's
        // spec), but a workflow's steps are still identified by their PROMPTS,
        // so the prompt each reply answers is how a step finds its reply.
        prevKey: typeof m === "object" && m.prev != null ? entryKey(m.prev) : "",
        label: label || "(no text)",
        empty: !label,
        chars: text.length,
        // When it was sent, where that's known. The page can't say — only the
        // conversation payload carries times — so this is null for a list built
        // from what's rendered.
        at: (typeof m === "object" && typeof m.at === "number" && m.at) || null,
      });
    }
    return out;
  }

  // What makes two sightings of a message the same message. Deliberately loose:
  // the same text arrives from the conversation payload and from the rendered
  // page, and the page's copy picks up whatever whitespace the layout put in it.
  // Case and spacing are dropped, and only the opening is compared, because
  // that's the part both sources agree on.
  const KEY_CHARS = 120;
  function entryKey(text) {
    return str(text).replace(/\s+/g, " ").trim().toLowerCase().slice(0, KEY_CHARS);
  }

  function renumber(list) {
    return list.map((e, i) => Object.assign({}, e, { n: i + 1 }));
  }

  function sameBlock(host, part, offset) {
    for (let i = 0; i < part.length; i++) {
      if (!host[offset + i] || host[offset + i].key !== part[i].key) return false;
    }
    return true;
  }

  /**
   * Two views of the same conversation, joined into one.
   *
   * claude.ai unmounts messages that scroll out of view, so what the page holds
   * is a WINDOW onto the chat — and a list rebuilt from it drops entries as you
   * scroll, which is the opposite of what a table of contents is for. A window
   * is contiguous, though, so a new one either sits inside what's already known
   * or overlaps one of its ends, and either way the union is recoverable.
   *
   * Repeated prompts make the overlap ambiguous — the first alignment that fits
   * wins, which can be the wrong one in a chat that says "continue" twenty
   * times. It costs a duplicated entry at worst, where the alternative is losing
   * entries for certain.
   */
  function mergeWindows(known, seen) {
    const a = (known || []).filter(Boolean);
    const b = (seen || []).filter(Boolean);
    if (!a.length) return renumber(b);
    if (!b.length) return renumber(a);

    // The new window inside what we know: the ordinary case while scrolling
    // around a chat already listed. Its entries replace ours, so an edited
    // message updates rather than doubling.
    for (let o = 0; o + b.length <= a.length; o++) {
      if (sameBlock(a, b, o)) {
        const merged = a.slice();
        for (let i = 0; i < b.length; i++) merged[o + i] = b[i];
        return renumber(merged);
      }
    }
    // What we know inside the new window — a fuller list arriving, typically the
    // conversation payload after a page-built stub.
    for (let o = 0; o + a.length <= b.length; o++) if (sameBlock(b, a, o)) return renumber(b);

    // Overlapping ends: scrolled far enough that the windows only share a
    // margin. The longest shared margin wins.
    for (let k = Math.min(a.length, b.length) - 1; k > 0; k--) {
      if (sameBlock(a, b.slice(0, k), a.length - k))
        return renumber(a.slice(0, a.length - k).concat(b));
      if (sameBlock(b, a.slice(0, k), b.length - k))
        return renumber(b.slice(0, b.length - k).concat(a));
    }
    // Nothing in common. A jump that far can only be new messages below.
    return renumber(a.concat(b));
  }

  /**
   * How far to scroll to get from the message you can see to the one you want.
   *
   * A guess, refined by repeating: the entry you're after may not be mounted,
   * so there's nothing to measure and nothing to scroll to. Messages differ in
   * length, so one step lands near rather than on — hence the caller loops,
   * measuring where it actually got to each time.
   */
  /**
   * Which of these messages a workflow sent, and as which step.
   *
   * A run's message is its step's prompt with the carried material pasted under
   * it, so the rendered turn BEGINS with the prompt — which is what this matches
   * on. Steps are taken in order and each claims the first message after the one
   * before it claimed: a chat that was asked the same thing twice gets the
   * second occurrence for the second step, rather than both steps pointing at
   * the first.
   *
   * `steps` are the run's steps that ran in THIS conversation, in order, each
   * with the label to show ("2B") and the prompt that was sent.
   */
  const MIN_PREFIX = 12;
  // A prompt long enough to be distinctive is matched as a prefix, since the
  // message carries material after it. A short one — "Continue" — has to match
  // outright, or it would claim the first message that happened to start with
  // the same word.
  function promptMatches(key, want) {
    const k = str(key);
    return want.length >= MIN_PREFIX ? k.indexOf(want) === 0 : k === want;
  }
  // The key a step's prompt is matched against. A reply entry carries the
  // preceding prompt's key (`prevKey`) and is claimed through it — the reply
  // ANSWERING a step is that step's entry; an entry without one (the old
  // prompt-built lists, and tests that build them) is matched on its own key.
  function promptKeyOf(entry) {
    return str(entry.prevKey || entry.key);
  }
  function stepMarks(entries, steps) {
    const out = (entries || []).map((e) => Object.assign({}, e));
    let from = 0;
    for (const s of steps || []) {
      const want = entryKey(s && s.prompt);
      if (!want) continue;
      let hit = -1;
      for (let i = from; i < out.length; i++) {
        if (out[i].step) continue;
        if (promptMatches(promptKeyOf(out[i]), want)) {
          hit = i;
          break;
        }
      }
      if (hit === -1) continue;
      out[hit] = Object.assign({}, out[hit], { step: s.label, run: s.runName || null });
      from = hit + 1;
    }
    return out;
  }

  /**
   * The entry a prompt leads to — for the workflow index's jump. With the list
   * tracking replies, the entry a step's prompt finds is the REPLY to that
   * step, which is where reading back through a run actually wants to land.
   */
  function findByPrompt(entries, prompt) {
    const want = entryKey(prompt);
    if (!want) return -1;
    return (entries || []).findIndex((e) => e && promptMatches(promptKeyOf(e), want));
  }

  function seekDelta(fromIndex, toIndex, span, count) {
    const n = Number(count);
    if (!n || n < 1) return 0;
    return Math.round(((Number(toIndex) - Number(fromIndex)) * Number(span || 0)) / n);
  }

  const api = {
    tocLabel,
    tocEntries,
    entryKey,
    mergeWindows,
    stepMarks,
    findByPrompt,
    seekDelta,
    MAX_LABEL,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMToc = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
