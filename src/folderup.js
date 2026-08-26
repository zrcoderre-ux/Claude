/**
 * Claude Usage Meter — a case folder taken into a NEW conversation (pure).
 *
 * The run editor already takes a case folder apart (src/dropdir.js): only what
 * sits under `Text Files` becomes a document, the `pseudonym_key.xlsx` beside
 * them is attached rather than uploaded, and the matter's originals are left
 * exactly where they are. This module is the same gesture aimed at a chat you
 * are about to type in yourself — the Upload folder button on a new
 * conversation (src/folder-upload.js).
 *
 * What it decides, and why each decision is here rather than in the button:
 *
 *   WHERE THE BUTTON BELONGS. A new conversation is an address a send would
 *   CREATE — /new, the home composer, a project's own composer. A chat that
 *   already exists is somebody's work: attaching a matter's papers to it
 *   uninvited is not what was asked for. And /cowork is not Chat — nothing
 *   built for Chat is assumed to work there (CLAUDE.md), so this button does
 *   not offer itself on it.
 *
 *   WHAT GOES UP. The run combines a chat's text documents into ONE labelled
 *   file (W.bundleText) because twelve attachments are twelve things claude.ai
 *   may or may not read. Same rule here, and the same two exceptions: a file
 *   that is not text can't be concatenated, and a spreadsheet never rides an
 *   upload at all — the key is an .xlsx, and "the key went up with the
 *   exhibits" has to be impossible rather than unlikely.
 *
 *   WHAT THE CHAT IS CALLED. A case folder is named in the REAL names —
 *   "23STCV12345 Smith v. Jones" — and a chat title is not display: claude.ai
 *   stores it, syncs it to every signed-in device and searches it. So the name
 *   goes through the matter's own key first (real → fake), and where it can't
 *   be — no key, a key that doesn't cover the case number, a library that
 *   wouldn't read — NO title goes and the button says why. A title that
 *   quietly went over carrying the real case name is the one outcome this must
 *   not have, which is the same rule the run's own titles are held to.
 *
 * Pure: no DOM, no chrome. It reads two other pure modules through the globals
 * they publish (CUMWorkflow for what counts as text, CUMPseudo for the key's
 * decisions) exactly as src/jobstore.js reads CUMCowork, so a test requires
 * those two first and gets the real answers rather than a fake's.
 */
(function (root) {
  "use strict";

  const str = (v) => (v == null ? "" : String(v));
  const norm = (v) => str(v).replace(/\s+/g, " ").trim();

  const W = () => root.CUMWorkflow || null;
  const P = () => root.CUMPseudo || null;

  // The name a run's combined upload carries, so a chat started by hand and a
  // chat started by a run hold the same file under the same name.
  const BUNDLE_NAME = "combined-documents.txt";

  // W.MAX_CHAT_TITLE, which isn't exported. A title longer than this is
  // claude.ai's to truncate, and it would truncate the half that says which
  // matter this is.
  const MAX_TITLE = 100;

  // Mirrors W.docBarred rather than calling it, and deliberately: this is the
  // rule that keeps the pseudonym key out of an upload, and it has to hold even
  // in the seconds before workflow.js has loaded. A duplicated regex is a small
  // price for a bar that cannot be absent.
  const SPREADSHEET_RE = /\.(xlsx|xlsm|xltx|xls)$/i;
  function isSpreadsheet(name) {
    return SPREADSHEET_RE.test(norm(name));
  }

  // ---- where this button belongs -------------------------------------------

  function pathOf(href) {
    let path = str(href);
    try {
      path = new URL(path).pathname;
    } catch (e) {
      /* not absolute — what we were given is the path */
    }
    return path.replace(/\/+$/, "") || "/";
  }

  /**
   * Is this address a conversation that does not exist yet — one the next send
   * would create?
   *
   * Yes: the home composer ("/"), "/new", and a PROJECT's own page, whose
   * composer starts a new chat inside that project. No: a conversation that
   * already exists (/chat/…), a Cowork session or project (Cowork is not Chat,
   * and this button has never been seen working there), a Claude Code session,
   * and every page that is a list rather than a composer.
   */
  function isNewChatPath(href) {
    const path = pathOf(href);
    if (/^\/cowork(\/|$)/.test(path)) return false; // not Chat, and not claimed to be
    if (/^\/code(\/|$)/.test(path)) return false;
    if (/^\/chat\//.test(path)) return false;
    if (path === "/" || /^\/new(\/|$)/.test(path)) return true;
    // A project's own page — /project/<uuid> — but not the projects LIST, and
    // not a conversation living inside a project.
    return /^\/project\/[0-9a-f-]{36}$/i.test(path);
  }

  /**
   * The uuid of the conversation this address IS, once one exists — and only
   * for an ordinary chat. A Cowork session's id (cse_…) is deliberately not
   * answered: it is renamed by driving a menu rather than by the API this
   * feature uses, which is a different path that has not been built here.
   */
  function startedConversation(href) {
    const m = pathOf(href).match(/^\/chat\/([0-9a-f-]{36})/i);
    return m ? m[1] : "";
  }

  // ---- what goes up ---------------------------------------------------------

  /** A picked entry ({file, path} or a plain file) as { name, type }. */
  function docOf(entry) {
    const f = (entry && entry.file) || entry || {};
    return { name: norm(f.name), type: norm(f.type) };
  }

  function isTextDoc(doc) {
    const w = W();
    if (w && w.isTextDoc) return w.isTextDoc(doc);
    // Without workflow.js there is no answer worth guessing at: a file wrongly
    // called text is mojibake where a brief should be, so nothing is combined
    // and every file goes up as itself.
    return false;
  }

  /**
   * Split the documents a case folder yielded into what gets combined, what
   * goes up as it is, and what never goes up at all.
   *
   * Two or more text files become one — one file has nothing to be combined
   * with, and a lone text document is already the single upload the combining
   * is for. Everything else (a PDF, a Word file) goes on its own, because
   * concatenating it would deliver mojibake instead of a brief.
   */
  function uploadPlan(docs) {
    const out = { bundle: [], singles: [], barred: [] };
    for (const entry of docs || []) {
      const d = docOf(entry);
      if (!d.name) continue;
      if (isSpreadsheet(d.name)) out.barred.push(entry);
      else if (isTextDoc(d)) out.bundle.push(entry);
      else out.singles.push(entry);
    }
    if (out.bundle.length < 2) {
      out.singles = out.bundle.concat(out.singles);
      out.bundle = [];
    }
    return out;
  }

  /**
   * The library entry this case folder already has, if any.
   *
   * A key remembers the case folder it was picked out of (P.keepKeyFacts keeps
   * it), so a folder picked a second time — after the key was loaded from the
   * popup, or by an earlier run — finds its own key without the .xlsx having
   * to be sitting in the pick. Matched on the folder name and nothing else:
   * two matters are two folders, and a key that never named a folder claims
   * none. `keys` is the stored library, id -> parsed key.
   */
  function keyForFolder(keys, folder) {
    const want = norm(folder).toLowerCase();
    if (!want) return "";
    const lib = keys || {};
    for (const id of Object.keys(lib)) {
      const k = lib[id];
      if (k && norm(k.folder).toLowerCase() === want) return id;
    }
    return "";
  }

  // ---- what the chat gets called --------------------------------------------

  /**
   * The title this conversation may be given, or the reason it may not have
   * one. `state` is what the caller read out of storage:
   *
   *   folder  the case folder's own name — the matter, in the real names
   *   looked  the key library answered at all (not the same as "no key")
   *   keyId   the key this folder's own pseudonym_key.xlsx landed on
   *   key     that key, parsed
   *
   * The decision is P.titlePlan's, so this and a run's titles cannot drift
   * apart; only the wording is local, because "the run's name" is not what is
   * being weighed here. On top of it sits the case-number test, which is the
   * swap itself rather than a lookup: a key row reading "Case No. 23STCV12345"
   * does not replace the bare number, and a title carrying one is the whole
   * case — unique, public, searchable — however the names were changed.
   */
  function chatTitleFor(state) {
    const s = state || {};
    const folder = norm(s.folder);
    const held = (why) => ({ title: "", why: why });
    if (!folder) return held("that folder has no name to take");
    const p = P();
    if (!p)
      return held(
        "the pseudonym module is not loaded, and a case folder's own name is the matter's real one"
      );
    const plan = p.titlePlan({ looked: s.looked, keyId: s.keyId, key: !!s.key });
    if (plan.mode === "hold")
      return held(
        s.looked
          ? "that folder's pseudonym key is not in the key library any more, so its name " +
              "could not be pseudonymized"
          : "the pseudonym key library would not read, so the folder's name could not be " +
              "checked against it"
      );
    const uncovered = p.uncoveredCaseNumbers(s.key, [folder]);
    if (uncovered.length)
      return held(
        "that folder's name carries the case number " +
          uncovered.join(", ") +
          ", and " +
          (s.key ? "its pseudonym key does not replace it" : "no pseudonym key came with it") +
          " — a real case number is the whole case, and it does not go into a chat title " +
          "claude.ai stores and syncs. Load a key that carries that number."
      );
    const clean = plan.mode === "clean" ? p.nameCleaner(s.key) : (v) => v;
    const title = norm(clean(folder)).slice(0, MAX_TITLE).trim();
    return title ? { title: title, why: "" } : held("its name pseudonymized to nothing");
  }

  /**
   * Is this conversation the one the send just created — or one you clicked in
   * the sidebar?
   *
   * From the address bar the two are identical: both are /chat/<uuid> arrived
   * at from the composer. The difference matters more than anything else this
   * button does, because the wrong answer renames somebody's open work and
   * hangs a matter's key on it. So the conversation itself is asked, and only
   * a conversation that is both SHORT and NEW counts: the first send and its
   * reply are two messages, and a chat this button started cannot be older
   * than the minutes since the folder was picked.
   *
   * Answers null for "can't tell" — no payload at all — which the caller must
   * treat as a refusal rather than a yes. Nothing here is worth guessing at.
   */
  const FRESH_MS = 15 * 60 * 1000;
  function isFreshConversation(conv, nowMs) {
    if (!conv || typeof conv !== "object") return null;
    const msgs = conv.chat_messages;
    if (!Array.isArray(msgs)) return null;
    if (msgs.length > 2) return false;
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    // The conversation's own stamp where it has one, and the newest TURN's
    // where it doesn't — claude.ai's shapes are unversioned, and a message
    // carries a time in every shape this has been seen in (src/stamp.js reads
    // the same fields).
    let at = Date.parse(str(conv.created_at));
    if (!isFinite(at)) {
      for (const m of msgs) {
        const t = Date.parse(str(m && (m.created_at || m.createdAt || m.updated_at)));
        if (isFinite(t) && (!isFinite(at) || t > at)) at = t;
      }
    }
    // No usable stamp anywhere: the message count is all there is. It is a
    // weaker answer than the clock, and it is the one the caller gets rather
    // than a refusal — a conversation of one turn is what a fresh send makes.
    if (!isFinite(at)) return true;
    return now - at <= FRESH_MS && at - now <= FRESH_MS;
  }

  // ---- what the button says -------------------------------------------------

  function count(n, one, many) {
    return n + " " + (n === 1 ? one : many || one + "s");
  }

  /**
   * What the pick did with the folder's files, in one sentence. Every part of
   * it is something the operator would otherwise have to count: what is going
   * up, what was deliberately left behind, and whether anything was cut off.
   */
  function describeUpload(res) {
    const r = res || {};
    const root_ = norm(r.root) || "that folder";
    const bundled = (r.bundle && r.bundle.length) || 0;
    const singles = (r.singles && r.singles.length) || 0;
    if (!bundled && !singles) return "No Text Files folder in " + root_ + " — nothing was attached.";
    const head = bundled
      ? "Attaching " +
        count(bundled, "text file") +
        " from " +
        root_ +
        "/Text Files as one combined file" +
        (singles ? ", plus " + count(singles, "file") + " that can't be combined" : "") +
        "."
      : "Attaching " + count(singles, "file") + " from " + root_ + "/Text Files.";
    const left = r.left
      ? " Left " +
        count(r.left, "other file") +
        " in the case folder alone — a matter's originals never upload."
      : "";
    const cap = r.capped
      ? " That Text Files folder holds more than were taken, and the rest were left out."
      : "";
    return head + left + cap;
  }

  /** What became of the key that came with the folder. */
  function describeKey(res) {
    const r = res || {};
    const root_ = norm(r.root) || "that folder";
    if (r.keyName)
      return (
        norm(r.keyName) +
        " is the pseudonym key — " +
        (r.already
          ? "already in the extension from an earlier pick"
          : "loaded into the extension") +
        " and attached to this chat, never uploaded."
      );
    return (
      "No pseudonym key in " +
      root_ +
      " — nothing will translate this chat, and its name cannot go over pseudonymized."
    );
  }

  /** What the conversation will be called, or why it will not be named. */
  function describeTitle(decision) {
    const d = decision || {};
    if (d.title) return 'This chat will be named "' + d.title + '" once you send.';
    return "This chat will not be named: " + (d.why || "no name was worked out") + ".";
  }

  const api = {
    BUNDLE_NAME,
    MAX_TITLE,
    isSpreadsheet,
    isNewChatPath,
    startedConversation,
    uploadPlan,
    keyForFolder,
    FRESH_MS,
    isFreshConversation,
    chatTitleFor,
    describeUpload,
    describeKey,
    describeTitle,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMFolderUp = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
