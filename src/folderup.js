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
 *   CREATE — /new, the home composer, a project's own composer, and the same
 *   again on Cowork. A conversation that already exists is somebody's work:
 *   attaching a matter's papers to it uninvited is not what was asked for.
 *
 *   WHICH SURFACE THE PICK IS ON, which decides everything done afterwards.
 *   Cowork is not Chat with a different address (CLAUDE.md): its uploads run
 *   in a worker no page hook sees, so they are confirmed by what the composer
 *   visibly carries rather than by upload responses, and its sessions are
 *   renamed by driving the header's own control rather than through the API a
 *   chat is renamed with. So a pick reads the surface first — and where the
 *   page will not say which it is, the answer is COWORK, whose evidence
 *   ladder starts with Chat's own upload confirmations and keeps going.
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
   * Yes: the home composer ("/"), "/new" (which is where a Cowork session is
   * composed too — toggling the surface leaves the address alone), a PROJECT's
   * own page, and Cowork's own two, /cowork and /cowork/project/<uuid>.
   *
   * No: a conversation that already exists, chat or session; a Claude Code
   * session, which this has no path for at all; and every page that is a list
   * rather than a composer.
   */
  function isNewChatPath(href) {
    const path = pathOf(href);
    if (/^\/code(\/|$)/.test(path)) return false;
    if (/^\/chat\//.test(path)) return false;
    if (/^\/cowork\/cse_/.test(path)) return false; // a session, not a composer
    if (path === "/" || /^\/new(\/|$)/.test(path)) return true;
    if (path === "/cowork") return true;
    // A project's own page — /project/<uuid>, or Cowork's — but never the
    // projects LIST, and never a conversation living inside one.
    return /^(\/cowork)?\/project\/[0-9a-f-]{36}$/i.test(path);
  }

  /**
   * Which surface a pick made on this page goes out on: "chat" or "cowork".
   *
   * `toggle` is what the page's own Chat/Cowork control says (C.currentSurface,
   * which is confirmed working on both) — "" where the page has no control to
   * read, which is what a project page looks like.
   *
   * A Cowork ADDRESS settles it whatever the toggle says. Where nothing says,
   * the answer is Cowork rather than Chat: guessing that way costs a couple of
   * seconds of slower confirmation, and guessing the other way reports a
   * perfectly good upload as having failed.
   */
  function pickSurface(href, toggle) {
    if (/^\/cowork(\/|$)/.test(pathOf(href))) return "cowork";
    return norm(toggle).toLowerCase() === "chat" ? "chat" : "cowork";
  }

  /**
   * The conversation this address IS, once one exists: { id, surface }, or
   * { id: "", surface: "" } for an address that is not one yet.
   *
   * The surface travels with the id because everything done to a conversation
   * afterwards differs by it — a chat is renamed through the API, a Cowork
   * session by driving the control its header carries. A session's id is not a
   * uuid (cse_011f5HCzaWWJ2hm19v6NuQmN), which is why it needs its own arm
   * rather than a wider pattern that would also swallow a project's.
   */
  function startedConversation(href) {
    const path = pathOf(href);
    const chat = path.match(/^\/chat\/([0-9a-f-]{36})/i);
    if (chat) return { id: chat[1], surface: "chat" };
    const cowork = path.match(/^\/cowork\/(cse_[A-Za-z0-9_-]+)/);
    if (cowork) return { id: cowork[1], surface: "cowork" };
    return { id: "", surface: "" };
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
   * From the address bar the two are identical on both surfaces: /chat/<uuid>
   * or /cowork/cse_<id>, arrived at from a composer either way. The difference
   * matters more than anything else this button does, because the wrong answer
   * renames somebody's open work and hangs a matter's key on it. So the
   * evidence is taken in order of strength and the first kind that answers
   * wins — the same ladder Cowork's own attach confirmation climbs:
   *
   *   THE CONVERSATION ITSELF, where it can be read back. A chat answers with
   *   its turns and its stamp, and both have to agree: the first send and its
   *   reply are two messages, and a conversation this button started cannot be
   *   older than the minutes since the folder was picked.
   *
   *   THE PAGE, where it cannot. A Cowork session's payload is not the shape a
   *   chat's is and may carry neither — so what is left is that this tab was
   *   sitting on the composer when the address became this conversation, that
   *   the conversation holds one turn, and that the pick was recent. Three
   *   weak signals that agree, said plainly as the weaker evidence it is.
   *
   * Answers { ok, why }: ok true, false, or null for "nothing could be read",
   * which a caller must treat as a refusal rather than a yes — after it has
   * given the page a moment to settle.
   */
  const FRESH_MS = 15 * 60 * 1000;

  /**
   * How long a pick may sit on the composer before it stops claiming the next
   * conversation to appear.
   *
   * Not FRESH_MS, and the difference is the difference between two questions.
   * FRESH_MS asks how old the CONVERSATION is, which is evidence about whether
   * this is the one the send created. This asks how long ago the FOLDER was
   * picked, which is not evidence about that at all — it is a measure of how
   * long the operator took to write their first message, and on a case folder
   * that is reading the papers, which is the work. Fifteen minutes said that a
   * folder attached before lunch could not name the chat it was attached to,
   * and said it by silently declining to rename anything.
   *
   * What guards the pick is not this clock but the composer: `watched` says the
   * tab was sitting on a composer moments before this conversation appeared,
   * and a tab that leaves the composer for anything that is not a conversation
   * drops the pick outright (the stray count in src/folder-upload.js). So this
   * is only a backstop against a tab left open overnight on a composer whose
   * folder nobody remembers picking.
   */
  const PICK_MS = 8 * 60 * 60 * 1000;

  // How far ahead of this browser's clock a server stamp may sit and still be
  // read as "just now". Two machines' clocks differ by seconds; this is the
  // slack for that, and nothing else.
  const SKEW_MS = 2 * 60 * 1000;

  /**
   * When claude.ai says something happened, in ms — or null where it didn't
   * say anything readable.
   *
   * A DATE-TIME WITH NO ZONE IS LOCAL TIME to Date.parse, and claude.ai's
   * payloads have been seen carrying stamps both ways: "...T18:59:56Z" and the
   * same instant written "...T18:59:56.123456" with no zone at all. A server
   * stamp read as local is wrong by the whole of the browser's offset — seven
   * hours in California — so the conversation the send created a moment ago
   * reads as seven hours in the FUTURE, the gate below calls it somebody
   * else's work, and the button refuses to name the very chat it started.
   * That is the shape of a bug that only ever appears away from UTC, which is
   * everywhere anyone actually works.
   *
   * So a stamp with no zone is read as UTC, which is what a server stamp is.
   * One with a zone is left exactly as written.
   */
  const NAIVE_STAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
  function stampMs(raw) {
    if (typeof raw === "number") return isFinite(raw) ? raw : null;
    const s = str(raw).trim();
    if (!s) return null;
    const t = Date.parse(NAIVE_STAMP_RE.test(s) ? s.replace(" ", "T") + "Z" : s);
    return isFinite(t) ? t : null;
  }

  function conversationFresh(ev) {
    const e = ev || {};
    const now = typeof e.now === "number" ? e.now : Date.now();
    const conv = e.conv && typeof e.conv === "object" ? e.conv : null;
    const msgs = conv && Array.isArray(conv.chat_messages) ? conv.chat_messages : null;
    if (msgs && msgs.length > 2)
      return { ok: false, why: "that conversation already holds " + msgs.length + " messages" };
    // The conversation's own stamp where it has one, and the newest TURN's
    // where it doesn't — claude.ai's shapes are unversioned, a Cowork
    // session's is not a chat's, and a message carries a time in every shape
    // this has been seen in (src/stamp.js reads the same fields). The stamp is
    // asked for on its own rather than only alongside the turns, because a
    // session's payload may answer with one and not the other.
    let at = conv ? stampMs(conv.created_at) : null;
    if (at === null && msgs) {
      for (const m of msgs) {
        const t = stampMs(m && (m.created_at || m.createdAt || m.updated_at));
        if (t !== null && (at === null || t > at)) at = t;
      }
    }
    if (at !== null) {
      const age = now - at;
      if (age > FRESH_MS)
        return { ok: false, why: "that conversation was started " + minutes(age) + " ago" };
      if (age >= -SKEW_MS)
        return { ok: true, why: "it was started " + minutes(age) + " ago" };
      // Further AHEAD of this browser's clock than two machines ever drift.
      // That is a disagreement about what time it is, and a disagreement about
      // the time says nothing whatever about WHICH conversation this is — so
      // it falls through to the rest of the evidence rather than refusing on
      // it. Refusing on it was how a stamp with no zone (see stampMs) turned
      // every rename outside UTC into a silent no.
    }
    if (msgs) return { ok: true, why: "it holds only the first turn (no time to read on it)" };
    // Nothing readable came back. The page is what is left, and it is three
    // signals that have to agree rather than one.
    const turns = typeof e.turns === "number" ? e.turns : null;
    if (turns !== null && turns > 1)
      return { ok: false, why: "the page shows " + turns + " turns in it already" };
    if (!e.watched)
      return {
        ok: null,
        why:
          "this tab did not watch the composer become this conversation, and the conversation " +
          "could not be read back",
      };
    const since = typeof e.pickedAt === "number" ? now - e.pickedAt : 0;
    if (since > PICK_MS)
      return { ok: false, why: "the folder was picked " + minutes(since) + " ago" };
    // Zero turns counted is not "no turns" — a conversation that exists has at
    // least one — it is a page whose turn markup this could not read, which is
    // said rather than counted as agreement.
    return {
      ok: true,
      why:
        "this tab watched the composer become it, " +
        (turns ? "and it holds one turn" : "and nothing on the page contradicted that") +
        " — the page's word, not the conversation's",
    };
  }

  function minutes(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    return m < 1 ? "under a minute" : m === 1 ? "a minute" : m + " minutes";
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
        " and attached to this conversation, never uploaded."
      );
    return (
      "No pseudonym key in " +
      root_ +
      " — nothing will translate this conversation, and its name cannot go over pseudonymized."
    );
  }

  /** What the conversation will be called, or why it will not be named. */
  function describeTitle(decision) {
    const d = decision || {};
    if (d.title) return 'This conversation will be named "' + d.title + '" once you send.';
    return "This conversation will not be named: " + (d.why || "no name was worked out") + ".";
  }

  /**
   * What BECAME of that name, once the conversation has been asked for it and
   * then read back.
   *
   * Asking is not the same as being named, and this button had been reporting
   * the ask: it said 'Named it "X"' on an HTTP 200, having just written three
   * paragraphs about how claude.ai titles a new conversation ITSELF moments
   * into the first answer and lands on top of exactly this rename. So the
   * operator was told the name had taken at the one moment it reliably had
   * not, and when the auto-title won there was nothing on screen that ever
   * said so. A name is reported now only when the conversation has been read
   * back carrying it.
   *
   * `state`:
   *   title    the name that was asked for
   *   took     true  read back carrying it
   *            false read back carrying something else
   *            null  could not be read back at all
   *   error    why the ATTEMPT failed, where it failed outright
   *   settled  the re-stamping is over — this is the last word rather than a
   *            progress report, and a name that is not on it by now is not
   *            going to be
   */
  function describeNamed(state) {
    const s = state || {};
    const title = norm(s.title);
    if (!title) return "";
    const named = 'Named it "' + title + '".';
    if (s.took === true) return named;
    const hand = " Rename it by hand.";
    if (s.error)
      return s.settled
        ? 'Could not name it "' + title + '" (' + s.error + ") — it keeps whatever claude.ai " +
            "called it." + hand
        : 'Could not name it "' + title + '" yet (' + s.error + ") — still trying.";
    if (s.took === false)
      return s.settled
        ? 'The name "' + title + '" would not stay on this conversation — claude.ai\'s own ' +
            "title kept winning." + hand
        : 'Asked for the name "' + title + '"; claude.ai\'s own title is on it at the moment ' +
            "— still trying.";
    return s.settled
      ? 'Asked for the name "' + title + '", and what this conversation ended up called could ' +
          "not be read back — check it."
      : 'Asked for the name "' + title + '" — waiting to see it stick.';
  }

  const api = {
    BUNDLE_NAME,
    MAX_TITLE,
    isSpreadsheet,
    stampMs,
    isNewChatPath,
    startedConversation,
    pickSurface,
    uploadPlan,
    keyForFolder,
    FRESH_MS,
    PICK_MS,
    SKEW_MS,
    conversationFresh,
    chatTitleFor,
    describeUpload,
    describeKey,
    describeTitle,
    describeNamed,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMFolderUp = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
