/**
 * Claude Usage Meter — the copy box under a reply (ISOLATED world).
 *
 * claude.ai puts an icon-only Copy control in the action bar below each answer,
 * and clicking it is the best way to get that answer as Claude wrote it: the
 * markdown, without the thinking, without the tool calls. src/inject.js reports
 * every clipboard write, so what the page copies can be read back with no
 * clipboard permission and no need for the tab to be in front.
 *
 * It lives here rather than in one of its callers because two of them need to
 * agree about it: the workflow runner clicks it to carry a reply to the next
 * chat, and the Copy-ruling button sits down beside it. claude.ai's markup is
 * unversioned, so where the copy box is should be written down once.
 */
(function (root) {
  "use strict";

  const C = root.CUMComposer;
  const W = root.CUMWorkflow;
  if (!C || !W) return;

  const COPY_WAIT_MS = 4000;

  function copyish(b) {
    if (!b || C.isOurs(b)) return false;
    // Never a control that saves a file. isCopyLabel is an exact allow-list so
    // "Download" can't match it anyway — this is the belt to that's braces,
    // because clicking the wrong one downloads something and returns no text.
    if (
      W.isDownloadLabel(b.getAttribute("aria-label")) ||
      W.isDownloadLabel(b.getAttribute("title")) ||
      W.isDownloadLabel(b.textContent)
    )
      return false;
    if (b.getAttribute("data-testid") === "action-bar-copy") return true;
    return (
      W.isCopyLabel(b.getAttribute("aria-label")) ||
      W.isCopyLabel(b.getAttribute("title")) ||
      W.isCopyLabel(b.textContent)
    );
  }
  // The copy control for a message lives in the action bar BELOW it, outside the
  // rendered message (confirmed live: an icon-only button whose only label is
  // aria-label="Copy", a sibling of Read aloud / Good response / Retry).
  // Searching outward from the message and never inside it keeps a code block's
  // own Copy button out of the running; preferring one that FOLLOWS the message
  // in document order keeps the preceding user message's Copy out of it too,
  // for the widths of scope where both are in view.
  //
  // The walk climbs, and what it finds four levels up is no longer certainly
  // the reply's own bar. A live run copied an open verification report — a .md
  // file in Cowork's document pane, which has a Copy control of its own — and
  // handed that to the next chat as though Claude had said it. So a candidate
  // is VOUCHED FOR by its neighbours: the reply's bar carries Retry, the rating
  // controls, Read aloud; a document pane's toolbar carries none of them. A
  // vouched control anywhere in the walk beats an unvouched one nearer the
  // message, and the unvouched pass still runs afterwards, because a surface
  // whose bar has no other captions must still be copyable.
  function inReplyActionBar(btn) {
    let scope = btn && btn.parentElement;
    for (let i = 0; i < 3 && scope; i++) {
      let near;
      try {
        near = Array.from(scope.querySelectorAll('button,[role="button"]'));
      } catch (e) {
        return false;
      }
      for (const b of near) {
        if (b === btn || C.isOurs(b)) continue;
        for (const v of [b.getAttribute("aria-label"), b.getAttribute("title"), b.textContent])
          if (W.isReplyActionLabel(v) && !W.isCopyLabel(v)) return true;
      }
      scope = scope.parentElement;
    }
    return false;
  }

  function searchOut(msgEl, vouchedOnly) {
    let scope = msgEl.parentElement;
    for (let i = 0; i < 4 && scope; i++) {
      let btns = Array.from(scope.querySelectorAll('button,[role="button"]')).filter(
        (b) => !msgEl.contains(b) && copyish(b)
      );
      if (vouchedOnly) btns = btns.filter(inReplyActionBar);
      if (btns.length) {
        const following = btns.find(
          (b) =>
            msgEl.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
        );
        return following || btns[0];
      }
      scope = scope.parentElement;
    }
    return null;
  }

  function findCopyButton(msgEl) {
    if (!msgEl) return null;
    return searchOut(msgEl, true) || searchOut(msgEl, false);
  }
  // The action bar can be hover-revealed; nudge the message first.
  function hover(el) {
    for (const type of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
      try {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch (e) {
        /* ignore */
      }
    }
  }

  // Click the copy control and catch what the page writes to the clipboard
  // (inject.js reports every clipboard write over the channel).
  function copyViaButton(msgEl) {
    return new Promise((resolve) => {
      let btn = findCopyButton(msgEl);
      if (!btn) {
        hover(msgEl);
        btn = findCopyButton(msgEl);
      }
      if (!btn) return resolve("");
      let settled = false;
      const finish = (text) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve(text || "");
      };
      function onMsg(event) {
        if (event.source !== window) return;
        const m = event.data;
        const p = m && m.__channel === C.CHANNEL ? m.payload : null;
        if (p && p.clipboardWrite && typeof p.clipboardWrite.text === "string")
          finish(p.clipboardWrite.text);
      }
      window.addEventListener("message", onMsg);
      const timer = setTimeout(() => finish(""), COPY_WAIT_MS);
      try {
        C.robustClick(btn);
      } catch (e) {
        finish("");
      }
    });
  }


  root.CUMReplyCopy = { copyish, inReplyActionBar, findCopyButton, hover, copyViaButton, COPY_WAIT_MS };
})(typeof globalThis !== "undefined" ? globalThis : this);
