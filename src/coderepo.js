/**
 * Which repo a Claude Code session is on — the decisions behind the Recents
 * toggle.
 *
 * Recents on claude.ai/code is a list of TITLES. A title is what the session
 * was about; it is not what the session TOUCHED, and "which conversation last
 * edited this repo" is a question the list cannot answer no matter how long
 * you read it. So the list gets a switch: press it and every row says its
 * repo instead of its name, press it again and the names come back.
 *
 * The whole feature turns on knowing a session's repo, and there is no
 * documented place to read one from. Three sources, in the order they are
 * trusted:
 *
 *   1. THE PAGE'S OWN API. claude.ai loads its session list as JSON, and
 *      src/inject.js already watches that traffic for usage and projects.
 *      A session record carries its repo under SOME key; which key is not
 *      ours to know, so extractSessions() looks for a record that has both
 *      an id and something repo-shaped rather than for a shape we named.
 *   2. A SESSION YOU OPENED. Its repo is on screen in the repo control, so
 *      every session you visit teaches its own row.
 *   3. THE ROW'S OWN TEXT — and only when it names a repo we already know.
 *      This is the source that must not be trusted on its face: a Claude
 *      Code branch is `claude/some-slug`, which is exactly the shape of
 *      `owner/name`, and a row labelled with its BRANCH under a "repo"
 *      toggle would be a wrong answer that looks like a right one. A bare
 *      token is therefore believed only when it matches a repo already in
 *      the picker's harvested list (`cum_repos`) or in the map the first
 *      two sources built. A full github.com URL is believed outright — a
 *      branch never appears as one.
 *
 * A row whose repo none of the three can supply KEEPS ITS TITLE and is dimmed.
 * Blanking it, or guessing, would make the list say something untrue about
 * which conversation touched what; the dim row says "no repo known for this
 * one" and stays navigable.
 *
 * Pure: no DOM, no chrome. The button and the swapping are
 * src/code-recents.js.
 */
(function (root) {
  "use strict";

  // owner/name, and nothing else: no leading slash, no third segment, no
  // spaces. The shape a repo is written in everywhere claude.ai writes one.
  const BARE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const HOSTS = "(?:github|gitlab|bitbucket)\\.com";
  const URL_RE = new RegExp("(?:https?://)?(?:www\\.)?" + HOSTS + "/[A-Za-z0-9._/-]+", "gi");
  const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*/g;
  const MAX_LEN = 200;

  /**
   * A repo, canonical, or null. Accepts `owner/name`, a github/gitlab/
   * bitbucket URL (with or without scheme, `.git`, extra path or query), and
   * an ssh remote. Everything else — a path, a date, a branch with no owner,
   * a sentence — is null, because a wrong repo on a row is worse than none.
   */
  function normRepo(value) {
    if (typeof value !== "string") return null;
    let s = value.trim();
    if (!s || s.length > MAX_LEN) return null;
    let fromUrl = false;
    let m = s.match(/^(?:git\+)?(?:ssh:\/\/)?git@[\w.-]+[:/]([^?#\s]+)$/i);
    if (m) {
      s = m[1];
      fromUrl = true;
    } else {
      m = s.match(new RegExp("^(?:https?://)?(?:www\\.)?" + HOSTS + "/([^?#\\s]+)$", "i"));
      if (m) {
        s = m[1];
        fromUrl = true;
      }
    }
    s = s.split("?")[0].split("#")[0].replace(/\.git$/i, "").replace(/\/+$/, "");
    if (fromUrl) {
      // A repo URL can carry a whole tree behind it (/tree/main/src/...).
      // The repo is the first two segments; the rest is a place inside it.
      const parts = s.split("/").filter(Boolean);
      if (parts.length < 2) return null;
      s = parts[0] + "/" + parts[1];
    }
    if (!BARE.test(s)) return null;
    if (!/[A-Za-z]/.test(s)) return null; // 12/25 is a date, not a repo
    const parts = s.split("/");
    if (parts[0].length > 100 || parts[1].length > 100) return null;
    return s;
  }

  /** The known repos, lowercased, from any mix of list and id→record map. */
  function knownSet(known) {
    const set = new Set();
    const add = (v) => {
      const r = normRepo(v);
      if (r) set.add(r.toLowerCase());
    };
    const eat = (k) => {
      if (!k) return;
      if (Array.isArray(k)) k.forEach(add);
      else if (typeof k === "object")
        for (const id of Object.keys(k)) {
          const v = k[id];
          add(v && typeof v === "object" ? v.repo : v);
        }
      else add(k);
    };
    if (Array.isArray(known) && known.some((k) => k && typeof k === "object" && !Array.isArray(k)))
      known.forEach(eat);
    else eat(known);
    return set;
  }

  /**
   * The repo named in a row's text, or null. A full URL is believed on sight;
   * a bare `a/b` token only when it is a repo we already know, because the
   * branch a Claude Code session runs on has the very same shape.
   */
  function repoInText(text, known) {
    if (typeof text !== "string" || !text) return null;
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(text))) {
      const r = normRepo(m[0]);
      if (r) return r;
    }
    const set = knownSet(known);
    if (!set.size) return null;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) {
      const r = normRepo(m[0]);
      if (r && set.has(r.toLowerCase())) return r;
    }
    return null;
  }

  /**
   * The repo named in a control claude.ai has LABELLED as the repository. A
   * bare token is believed here where it is not believed in a row: the label
   * is what says the text is a repo, and a repo picker does not show branches.
   */
  function repoInLabelled(text) {
    if (typeof text !== "string" || !text || text.length > 300) return null;
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(text))) {
      const r = normRepo(m[0]);
      if (r) return r;
    }
    return null;
  }

  // ---- which session a row is ---------------------------------------------

  // /code/new is a composer, not a session; the rest are pages that could
  // exist beside the list without being rows in it.
  const NOT_A_SESSION = new Set(["new", "sessions", "session", "recents", "settings", "index", "all"]);

  /** The session id in a Claude Code href, or null. */
  function sessionId(href) {
    if (typeof href !== "string" || !href) return null;
    const m = href.match(/\/code\/([A-Za-z0-9_-]+)(?:[/?#]|$)/);
    if (!m) return null;
    const id = m[1];
    if (NOT_A_SESSION.has(id.toLowerCase())) return null;
    if (/^session_[A-Za-z0-9_-]{4,}$/i.test(id)) return id;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
    return id.length >= 10 ? id : null;
  }

  /** A Claude Code page — where a session's own repo can be read off screen. */
  function isCodePath(path) {
    return typeof path === "string" && /^\/code(\/|$)/.test(path);
  }

  // ---- the page's own session list ----------------------------------------

  /**
   * Worth parsing as a session list. Cheap and deliberately loose: the cost of
   * a miss is the feature not working, and the cost of a false positive is one
   * JSON.parse that yields nothing.
   */
  function looksLikeSessionsUrl(url) {
    return (
      typeof url === "string" &&
      /\/api\//.test(url) &&
      /(session|\/code(s)?(\/|\?|$))/i.test(url)
    );
  }

  // Keys that MEAN a repo, and keys that merely might carry one. The strong
  // ones win, so a record with both `repo` and some unrelated `url` is read
  // the way it was written.
  const STRONG = [
    "repo", "repos", "repository", "repositories", "reponame", "repositoryname",
    "repofullname", "repositoryfullname", "fullname", "gitrepo", "githubrepo",
    "repourl", "repositoryurl",
  ];
  const WEAK = ["source", "sources", "sourceurl", "remoteurl", "cloneurl", "giturl", "htmlurl", "url", "git", "origin"];
  const ID_KEYS = ["uuid", "id", "sessionid", "sessionuuid", "session"];

  const key = (k) => String(k).toLowerCase().replace(/[^a-z]/g, "");

  function idOf(obj) {
    for (const k of Object.keys(obj)) {
      if (ID_KEYS.indexOf(key(k)) === -1) continue;
      const v = obj[k];
      if (typeof v !== "string") continue;
      const id = sessionId("/code/" + v);
      if (id) return id;
    }
    return null;
  }

  /** A repo anywhere in (or one or two levels under) a record. */
  function repoOf(obj, keys, depth) {
    if (!obj || typeof obj !== "object" || depth > 2) return null;
    const entries = Array.isArray(obj)
      ? obj.map((v) => ["", v])
      : Object.keys(obj).map((k) => [key(k), obj[k]]);
    // Strings under a naming key first...
    for (const [k, v] of entries) {
      if (typeof v !== "string") continue;
      if (keys.indexOf(k) === -1 && k !== "") continue;
      const r = normRepo(v);
      if (r) return r;
    }
    // ...then inside whatever those keys hold instead of a string.
    for (const [k, v] of entries) {
      if (!v || typeof v !== "object") continue;
      if (keys.indexOf(k) === -1 && k !== "" && depth > 0) continue;
      const r = repoOf(v, keys.concat(["name", "fullname", "path", "url"]), depth + 1);
      if (r) return r;
    }
    return null;
  }

  /**
   * Every {id, repo} a parsed API body can be made to yield. Nothing is
   * required of the response's SHAPE: a record counts when it has a session id
   * and something repo-shaped near it, which is the only pair this feature
   * needs and the pair least likely to be renamed out from under it.
   */
  function extractSessions(json) {
    const out = [];
    const seen = new Set();
    let budget = 4000;
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 8 || budget-- <= 0) return;
      if (Array.isArray(node)) {
        for (const v of node) walk(v, depth + 1);
        return;
      }
      const id = idOf(node);
      if (id && !seen.has(id)) {
        const repo = repoOf(node, STRONG, 0) || repoOf(node, WEAK, 0);
        if (repo) {
          seen.add(id);
          out.push({ id: id, repo: repo });
        }
      }
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    };
    walk(json, 0);
    return out;
  }

  // ---- the map the rows are read from -------------------------------------

  const CAP = 500; // sessions remembered; the oldest go first

  /**
   * Fold freshly-learned repos into the stored map, or null when nothing
   * changed — a write nobody needs is storage churn on every list render.
   */
  function mergeRepos(existing, found, now, cap) {
    if (!Array.isArray(found) || !found.length) return null;
    const limit = cap || CAP;
    const at = now || Date.now();
    const next = {};
    for (const id of Object.keys(existing || {})) {
      const v = existing[id];
      if (!v) continue;
      const repo = normRepo(typeof v === "string" ? v : v.repo);
      if (repo) next[id] = { repo: repo, at: (typeof v === "object" && v.at) || 0 };
    }
    let changed = false;
    for (const f of found) {
      if (!f || !f.id) continue;
      const repo = normRepo(f.repo);
      if (!repo) continue;
      const prev = next[f.id];
      if (!prev || prev.repo !== repo) changed = true;
      next[f.id] = { repo: repo, at: at };
    }
    if (!changed) return null;
    const ids = Object.keys(next);
    if (ids.length > limit) {
      ids.sort((a, b) => (next[b].at || 0) - (next[a].at || 0));
      for (const id of ids.slice(limit)) delete next[id];
    }
    return next;
  }

  /** The repo stored for a session id, or null. */
  function repoFor(map, id) {
    if (!map || !id) return null;
    const v = map[id];
    if (!v) return null;
    return normRepo(typeof v === "string" ? v : v.repo);
  }

  // ---- what a row says -----------------------------------------------------

  // Chrome that shares a row with the title: a status chip, a relative time, a
  // count. None of them is ever the name of a session.
  const CHROME = new Set([
    "recents", "recent", "new", "new session", "view all", "see all", "all",
    "open", "resume", "running", "queued", "pending", "done", "completed",
    "failed", "error", "archived", "active", "draft", "review", "merged",
    "closed", "now", "just now", "today", "yesterday",
  ]);

  /** Could this text be a session's name? */
  function isTitleish(text) {
    const t = String(text == null ? "" : text).trim();
    if (t.length < 2 || t.length > 160) return false;
    if (!/[A-Za-z0-9]/.test(t)) return false;
    if (CHROME.has(t.toLowerCase())) return false;
    if (/^\d+\s*(s|m|h|d|w|mo|y|sec|min|hr|hour|hours|day|days|week|weeks|month|months|year|years)$/i.test(t))
      return false;
    if (/^(about\s+)?\d+\s*\w*\s*ago$/i.test(t)) return false;
    if (/^\d{1,4}[/.-]\d{1,2}([/.-]\d{1,4})?$/.test(t)) return false; // a date
    if (normRepo(t)) return false; // already a repo — swapping it says nothing
    return true;
  }

  /**
   * Which of a row's texts is its name: the FIRST that could be one. Rows put
   * the name first and the furniture after it, and picking the longest instead
   * would hand the swap to a preview snippet.
   */
  function pickTitle(texts) {
    if (!Array.isArray(texts)) return -1;
    for (let i = 0; i < texts.length; i++) if (isTitleish(texts[i])) return i;
    return -1;
  }

  /**
   * The button. The word names the STATE — what the list is showing right now
   * — the way the fakes toggle's does, so what is under it reads without
   * pressing it.
   */
  function buttonState(on, unknown) {
    const missing = Math.max(0, unknown | 0);
    return {
      on: !!on,
      lit: !!on,
      label: on ? "Repos" : "Titles",
      title: on
        ? "Recents is showing each session's repo." +
          (missing
            ? " " + missing + " row" + (missing === 1 ? " has" : "s have") +
              " no repo known yet — those keep their titles, dimmed."
            : "") +
          " Click to go back to the names."
        : "Recents is showing each session's name. Click to show the repo each one is on.",
    };
  }

  const api = {
    normRepo: normRepo,
    knownSet: knownSet,
    repoInText: repoInText,
    repoInLabelled: repoInLabelled,
    sessionId: sessionId,
    isCodePath: isCodePath,
    looksLikeSessionsUrl: looksLikeSessionsUrl,
    extractSessions: extractSessions,
    mergeRepos: mergeRepos,
    repoFor: repoFor,
    isTitleish: isTitleish,
    pickTitle: pickTitle,
    buttonState: buttonState,
    CAP: CAP,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CUMCodeRepo = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
