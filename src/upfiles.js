/**
 * Claude Usage Meter — the files YOU uploaded, and how to get them back (pure).
 *
 * claude.ai will hand you back a file it PRODUCED — every such reply carries a
 * download control, and src/autodl.js exists to press it for you. A file you
 * uploaded has no control at all: the chip in your own message opens a preview
 * and that is the end of it, so the copy you sent is somewhere you cannot
 * reach it. When the local copy is the one that has been lost — a folder
 * cleared, a laptop swapped, a case worked on from somewhere else — the chat
 * is holding the only copy and holding it away from you.
 *
 * This is the decision half of getting it back. It reads the conversation
 * PAYLOAD rather than the page (claude.ai unmounts messages that scroll out of
 * view, so a list built from the DOM would be a list of whatever you happened
 * to be looking at) and answers three questions per upload:
 *
 *   - **Is it yours?** Only attachments on YOUR turns. A file in a reply is
 *     Claude's output and already has its own button; listing it here would be
 *     a second, worse download control for something that isn't missing.
 *   - **Can the original bytes be fetched, and from where?** claude.ai names
 *     its own asset URLs in the payload, under half a dozen keys that have not
 *     been stable. Every one of them is collected, ordered best-first, and the
 *     caller tries them in turn — a list that survives one key being renamed,
 *     which a single hard-coded URL would not.
 *   - **Failing that, is there anything left of it?** A text document uploaded
 *     to a chat is stored with its `extracted_content`, and for a file that WAS
 *     text (.txt, .md, .csv) that extraction is the file. For a PDF or a .docx
 *     it is emphatically not — it is the words with the document thrown away —
 *     and this says which of the two it is handing over rather than letting a
 *     "report.pdf" land that is nothing of the kind.
 *
 * Two rules the rest of the extension already lives by apply with particular
 * force here:
 *
 * - **Never a thumbnail dressed as the original.** claude.ai publishes a
 *   thumbnail URL beside the real one; fetching it would put a file on your
 *   disk under the uploaded name that is a fraction of the picture you sent.
 *   Thumbnails are excluded as a SOURCE and used only as a hint about where
 *   the full asset lives (see siblingUrls).
 * - **Only claude.ai's own URLs.** These get fetched with the session's
 *   cookies. A URL that arrived inside a JSON payload is not automatically
 *   somewhere those may be sent, so anything not same-origin or claude.ai is
 *   dropped here rather than guarded for downstream.
 *
 * The DOM, the fetching and the panel are in src/up-files.js.
 */
(function (root) {
  "use strict";

  const MAX_NAME = 120; // characters of filename kept
  const MAX_FILES = 300; // uploads listed for one conversation
  // A ceiling for the caller's fetch, because the bytes cross between the page
  // and the extension as one object: an upload larger than this is refused out
  // loud rather than hanging the tab trying to copy it.
  const MAX_BYTES = 80 * 1024 * 1024;

  const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const trimmed = (v) => str(v).trim();

  function numeric(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
    return null;
  }

  // ---- whose message is this ------------------------------------------------
  // Both spellings, because both have been seen: the conversation payload says
  // "human", a message built from the page says "user".
  function isYours(msg) {
    const who = trimmed(msg && (msg.sender || msg.role)).toLowerCase();
    return who === "human" || who === "user";
  }

  // A conversation's messages, oldest first. src/mdexport.js owns this reading
  // and is loaded before this module on the page; the inline copy is for a test
  // that loads this file on its own, and is the same two names.
  function messagesOf(conv) {
    const M = root && root.CUMMdExport;
    if (M && typeof M.messagesOf === "function") return M.messagesOf(conv);
    const list = conv && (conv.chat_messages || conv.messages);
    return Array.isArray(list) ? list.filter((m) => m && typeof m === "object") : [];
  }

  // ---- URLs -----------------------------------------------------------------

  /**
   * A URL we are willing to send the session's cookies to, or "".
   *
   * Same-origin paths and claude.ai itself, and nothing else — not because a
   * payload is expected to carry a hostile URL, but because the cost of being
   * wrong about that is the session cookie leaving for someone else's server,
   * and the cost of the rule is nothing.
   */
  function safeUrl(u) {
    const s = trimmed(u);
    if (!s) return "";
    if (s.slice(0, 2) === "//") return ""; // protocol-relative: another host
    if (s.charAt(0) === "/") return s; // same-origin path
    if (/^https:\/\/(?:[a-z0-9-]+\.)*claude\.ai(?:[/?#]|$)/i.test(s)) return s;
    return "";
  }

  const isThumbUrl = (u) => /\/thumbnail(?:[/?#]|$)/i.test(str(u));

  /**
   * The other assets that live beside this one.
   *
   * claude.ai serves an upload's pieces off one path —
   * `/api/<org>/files/<uuid>/preview`, `/thumbnail`, `/document` — so a payload
   * that named only the thumbnail still tells us exactly where the full file
   * is. Derived from a URL claude.ai itself gave us rather than invented: an
   * endpoint nobody has seen answer anything is a guess, and a guess that 404s
   * looks identical to the feature being broken.
   */
  const SIBLINGS = ["document", "original", "preview"]; // best first; never thumbnail
  function siblingUrls(u) {
    const s = safeUrl(u);
    const m = /^(.*\/files\/[^/?#]+\/)([A-Za-z0-9_-]+)((?:[?#].*)?)$/.exec(s);
    if (!m) return [];
    const out = [];
    for (const kind of SIBLINGS) {
      if (kind === m[2]) continue;
      out.push(m[1] + kind + m[3]);
    }
    return out;
  }

  // Where a single entry says its bytes are, best first. Ordered by what each
  // URL is FOR: the document asset is the upload itself, a preview is the
  // full-size render of it (and for an image, is the upload), and the loose
  // `url`/`file_url` keys are whatever a shape change left behind.
  const ASSET_KEYS = [
    ["document_asset", "the document asset"],
    ["preview_asset", "the preview asset"],
    ["original_asset", "the original asset"],
  ];
  const FLAT_KEYS = [
    ["preview_url", "the preview url"],
    ["url", "the file's url"],
    ["file_url", "the file url"],
    ["download_url", "the download url"],
  ];

  function sourcesOf(raw) {
    const out = [];
    const seen = new Set();
    const add = (u, why) => {
      const url = safeUrl(u);
      if (!url || isThumbUrl(url) || seen.has(url)) return;
      seen.add(url);
      out.push({ url: url, why: why });
    };
    if (!raw || typeof raw !== "object") return out;
    for (const pair of ASSET_KEYS) {
      const a = raw[pair[0]];
      if (a && typeof a === "object") add(a.url, pair[1]);
      else if (typeof a === "string") add(a, pair[1]);
    }
    for (const pair of FLAT_KEYS) add(raw[pair[0]], pair[1]);
    // Only now the thumbnails, and only for what they reveal about the path.
    const hints = [raw.thumbnail_url, raw.thumbnail_asset && raw.thumbnail_asset.url];
    const known = out
      .map((s) => s.url)
      .concat(hints.map((h) => safeUrl(h)).filter(Boolean));
    for (const from of known)
      for (const sib of siblingUrls(from)) add(sib, "beside " + brief(from));
    return out;
  }

  /** A URL short enough to print in a failure line. */
  function brief(u) {
    const s = str(u).split("?")[0];
    const bits = s.split("/").filter(Boolean);
    return bits.length > 2 ? ".../" + bits.slice(-2).join("/") : s;
  }

  // ---- names ----------------------------------------------------------------

  /** A filename safe to hand to a download, whatever claude.ai called it. */
  function safeName(name) {
    let s = trimmed(name).replace(/[\\/]+/g, "-"); // never a path
    // Control characters, and a leading dot: a name that begins "." is
    // hidden on every unix desktop, which is the one place a file being
    // rescued must not land.
    s = s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "");
    s = s.replace(/[<>:"|?*]/g, "-").trim();
    if (!s) s = "file";
    if (s.length > MAX_NAME) {
      const dot = s.lastIndexOf(".");
      const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : "";
      s = s.slice(0, MAX_NAME - ext.length) + ext;
    }
    return s;
  }

  /** `report.pdf` → `report (2).pdf`, given the names already spoken for. */
  function uniqueName(name, taken) {
    const used = new Set((taken || []).map((n) => str(n).toLowerCase()));
    const base = safeName(name);
    if (!used.has(base.toLowerCase())) return base;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    for (let n = 2; n < 500; n++) {
      const cand = stem + " (" + n + ")" + ext;
      if (!used.has(cand.toLowerCase())) return cand;
    }
    return stem + " (" + Date.now() + ")" + ext;
  }

  /**
   * The name for a file being recovered from its extracted text.
   *
   * A .txt comes back as itself. A .pdf does not: what is being saved is the
   * words claude.ai read out of it, and calling that "brief.pdf" would put a
   * file on disk that no PDF reader will open and that claims to be the
   * original. `.txt` is appended to the WHOLE name, extension included, so it
   * still says which document it came out of.
   */
  function textFileName(name, original) {
    const s = safeName(name);
    if (original) return s;
    return /\.txt$/i.test(s) ? s : s + ".txt";
  }

  // Was the uploaded file itself text — so that its extraction IS the file,
  // byte for byte? src/workflow.js owns what counts as a text document and is
  // loaded before this one; without it, only the plainest names qualify, which
  // errs towards calling a recovery an extract rather than the other way round.
  function isTextOriginal(name, type) {
    const W = root && root.CUMWorkflow;
    if (W && typeof W.isTextDoc === "function") return !!W.isTextDoc({ name: name, type: type });
    return /\.(txt|md|markdown|csv|tsv|json|log|xml|ya?ml|htm|html)$/i.test(str(name));
  }

  // ---- reading the payload --------------------------------------------------

  const LIST_KEYS = ["attachments", "files", "files_v2"];

  function entryFrom(raw, turn) {
    if (!raw || typeof raw !== "object") return null;
    const name = trimmed(
      raw.file_name || raw.name || raw.sanitized_name || raw.title || raw.document_name
    );
    const uuid = trimmed(raw.file_uuid || raw.uuid || raw.id || raw.file_id);
    const size = numeric(raw.file_size != null ? raw.file_size : raw.size);
    const type = trimmed(raw.file_type || raw.mime_type || raw.type);
    const text = typeof raw.extracted_content === "string" ? raw.extracted_content : "";
    const urls = sourcesOf(raw);
    // A row with no name, no id, no bytes and no text is not an upload — it is
    // some other object that happened to be in the list.
    if (!name && !uuid && !urls.length && !text) return null;
    return {
      name: name || (uuid ? "file-" + uuid.slice(0, 8) : "file"),
      named: !!name,
      uuid: uuid,
      size: size,
      type: type,
      kind: trimmed(raw.file_kind),
      turn: turn,
      urls: urls,
      text: text,
      textIsOriginal: !!text && isTextOriginal(name, type),
    };
  }

  // Two rows are the same upload when they carry the same id, or — for a
  // payload shape that gives no id — the same name and the same byte count.
  function keyOf(e) {
    if (e.uuid) return "id:" + e.uuid;
    return "nm:" + e.name.toLowerCase() + "|" + (e.size == null ? "?" : e.size);
  }

  // A second sighting of the same upload contributes whatever the first was
  // missing: one row with an asset url and one with the extracted text are one
  // recoverable file, not two half-recoverable ones.
  function merge(into, extra) {
    if (!into.urls.length && extra.urls.length) into.urls = extra.urls;
    if (!into.text && extra.text) {
      into.text = extra.text;
      into.textIsOriginal = extra.textIsOriginal;
    }
    if (into.size == null && extra.size != null) into.size = extra.size;
    if (!into.type && extra.type) into.type = extra.type;
    if (!into.named && extra.named) {
      into.name = extra.name;
      into.named = true;
    }
    return into;
  }

  /**
   * Everything you uploaded to this conversation, oldest first.
   *
   * Your turns only. A conversation with no record — an incognito chat is never
   * saved — gives an empty list, which the caller must say out loud rather than
   * showing as "nothing uploaded".
   */
  function uploadsOf(conv) {
    const out = [];
    const at = new Map();
    let turn = 0;
    for (const msg of messagesOf(conv)) {
      if (!isYours(msg)) continue;
      turn++;
      for (const key of LIST_KEYS) {
        const list = msg[key];
        if (!Array.isArray(list)) continue;
        for (const raw of list) {
          const e = entryFrom(raw, turn);
          if (!e) continue;
          const k = keyOf(e);
          const had = at.get(k);
          if (had) {
            merge(had, e);
            continue;
          }
          if (out.length >= MAX_FILES) return out;
          e.key = k;
          at.set(k, e);
          out.push(e);
        }
      }
    }
    return out;
  }

  // ---- what can be done with each -------------------------------------------

  /**
   * How this upload can be got back:
   *   "file"    — the original, fetched from claude.ai's own asset
   *   "text"    — it WAS a text file and claude.ai kept the text: same thing
   *   "extract" — the words claude.ai read out of it, and not the document
   *   "none"    — nothing here but the name
   */
  function recovery(e) {
    if (!e) return "none";
    if (e.urls && e.urls.length) return "file";
    if (e.text) return e.textIsOriginal ? "text" : "extract";
    return "none";
  }

  const RECOVERY_NOTE = {
    file: "the file as you uploaded it",
    text: "the file as you uploaded it — claude.ai kept its text",
    extract: "the TEXT claude.ai read out of it, not the document itself",
    none: "claude.ai's record of this upload is a name and nothing else",
  };
  const note = (e) => RECOVERY_NOTE[recovery(e)];

  /** 1.4 MB, 812 KB, 96 bytes — or "" for a size claude.ai didn't record. */
  function sizeLabel(bytes) {
    const n = numeric(bytes);
    if (n == null || n < 0) return "";
    if (n < 1024) return n + (n === 1 ? " byte" : " bytes");
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  }

  /**
   * The batch, with the name each download will land under.
   *
   * Names are made unique ACROSS the batch rather than per file, because the
   * same document uploaded to two turns is the ordinary case and two files
   * called brief.pdf is one file plus a "brief (1).pdf" you have to open to
   * identify. An entry nothing can be done with is kept in the list, with
   * `how: "none"` — the panel says why rather than quietly listing fewer files
   * than the chat plainly contains.
   */
  function planDownloads(entries) {
    const taken = [];
    const out = [];
    for (const e of entries || []) {
      const how = recovery(e);
      const wanted = how === "file" ? safeName(e.name) : textFileName(e.name, how === "text");
      const name = how === "none" ? "" : uniqueName(wanted, taken);
      if (name) taken.push(name);
      out.push({
        key: e.key || keyOf(e),
        entry: e,
        how: how,
        saveAs: name,
        urls: how === "file" ? e.urls.slice() : [],
        text: how === "file" ? "" : e.text,
        note: note(e),
      });
    }
    return out;
  }

  /** What the panel says over the list. */
  function describe(entries) {
    const list = entries || [];
    if (!list.length) return "No files were uploaded to this conversation.";
    const n = { file: 0, text: 0, extract: 0, none: 0 };
    for (const e of list) n[recovery(e)]++;
    const whole = n.file + n.text;
    const bits = [];
    if (whole) bits.push(whole + " can be downloaded as uploaded");
    if (n.extract)
      bits.push(
        n.extract + " only as the text claude.ai read out of " + (n.extract === 1 ? "it" : "them")
      );
    if (n.none) bits.push(n.none + " not at all — claude.ai kept only the name");
    return (
      list.length +
      (list.length === 1 ? " file you uploaded" : " files you uploaded") +
      (bits.length ? ": " + bits.join(", ") + "." : ".")
    );
  }

  /**
   * A failure the operator can act on: which URLs were tried and what each
   * said. A download that silently does nothing is the failure this extension
   * refuses to have, and "couldn't download" is the same thing with a label.
   */
  function describeFailure(name, tried) {
    const lines = (tried || []).map(
      (t) => brief(t && t.url) + " → " + (t && t.what ? t.what : "no answer")
    );
    return (
      'Couldn\'t get "' +
      str(name) +
      '" back' +
      (lines.length
        ? " — tried " + lines.join("; ")
        : " — claude.ai named nowhere to fetch it from") +
      "."
    );
  }

  /** Is what came back plausibly the file, rather than claude.ai's own page? */
  function looksLikeFile(res) {
    const r = res || {};
    if (!r.ok) return false;
    const bytes = numeric(r.bytes);
    if (bytes == null || bytes <= 0) return false;
    if (bytes > MAX_BYTES) return false;
    // An HTML answer to a request for a PDF is the SPA saying "no such thing"
    // with a 200 — the one failure that would otherwise land on disk as a file.
    if (/^text\/html/.test(trimmed(r.type).toLowerCase())) return false;
    return true;
  }

  const api = {
    MAX_NAME,
    MAX_FILES,
    MAX_BYTES,
    isYours,
    messagesOf,
    safeUrl,
    siblingUrls,
    sourcesOf,
    brief,
    safeName,
    uniqueName,
    textFileName,
    isTextOriginal,
    uploadsOf,
    recovery,
    note,
    sizeLabel,
    planDownloads,
    describe,
    describeFailure,
    looksLikeFile,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMUpFiles = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
