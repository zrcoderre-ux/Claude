/* Claude Usage Meter — popup logic */
(function () {
  "use strict";

  const STORAGE_KEY = "cum_state";
  const MANUAL_URL_KEY = "cum_manual_url";
  const OVERAGE_KEY = "cum_show_overage";
  const ESTIMATE_KEY = "cum_estimate_decimals";
  const AUTOCONTINUE_KEY = "cum_autocontinue";
  const AUTODOWNLOAD_KEY = "cum_autodownload";
  const AUTODOWNLOAD_SEEN_KEY = "cum_autodownload_last";
  const STATUS_KEY = "cum_status";
  const STATUS_CFG_KEY = "cum_status_cfg";
  const WARN_CFG_KEY = "cum_warn_cfg";

  const S = window.CUMStatus;

  const el = {
    session: document.getElementById("session"),
    sessionReset: document.getElementById("session-reset"),
    weekly: document.getElementById("weekly"),
    weeklyReset: document.getElementById("weekly-reset"),
    updated: document.getElementById("updated"),
    clear: document.getElementById("clear"),
    endpoint: document.getElementById("endpoint"),
    save: document.getElementById("save"),
    status: document.getElementById("status"),
    showOverage: document.getElementById("show-overage"),
    hideNags: document.getElementById("hide-nags"),
    runConsoleSticky: document.getElementById("run-console-sticky"),
    estimateDecimals: document.getElementById("estimate-decimals"),
    autoContinue: document.getElementById("auto-continue"),
    allowOnce: document.getElementById("allow-once"),
    acMax: document.getElementById("ac-max"),
    autoDownload: document.getElementById("auto-download"),
    dlMax: document.getElementById("dl-max"),
    dlLookback: document.getElementById("dl-lookback"),
    dlSeen: document.getElementById("dl-seen"),
    dlCatchUp: document.getElementById("dl-catchup"),
    openLog: document.getElementById("open-log"),
    svcStatus: document.getElementById("svc-status"),
    svcDetail: document.getElementById("svc-detail"),
    statusWarn: document.getElementById("status-warn"),
    usageWarn: document.getElementById("usage-warn"),
    usageShare: document.getElementById("usage-share"),
    statusHold: document.getElementById("status-hold"),
    statusModel: document.getElementById("status-model"),
    dlProbe: document.getElementById("dl-probe"),
    dlTry: document.getElementById("dl-try"),
    dlCopy: document.getElementById("dl-copy"),
    dlProbeOut: document.getElementById("dl-probe-out"),
  };

  function flash(text) {
    el.status.textContent = text;
    el.status.hidden = false;
    setTimeout(() => {
      el.status.hidden = true;
    }, 1800);
  }

  function fmtCountdown(ms) {
    if (ms == null || ms <= 0) return "—";
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  }

  function pctText(p) {
    return p != null ? `${Math.round(p * 100)}%` : "—";
  }

  function resetText(ms) {
    const remain = ms != null ? ms - Date.now() : null;
    return remain != null && remain > 0 ? fmtCountdown(remain) : "—";
  }

  function render(state) {
    state = state || {};
    // Session: prefer the utilization percent; fall back to a count ratio.
    let session = state.percent;
    if (session == null && state.limit && state.used != null)
      session = state.used / state.limit;
    el.session.textContent = pctText(session);
    el.sessionReset.textContent = resetText(state.resetAt);
    el.weekly.textContent = pctText(state.weeklyPercent);
    el.weeklyReset.textContent = resetText(state.weeklyResetAt);
    el.updated.textContent = state.updatedAt
      ? `Updated ${timeAgo(state.updatedAt)}`
      : "No data observed yet";
  }

  // ---- Claude service status --------------------------------------------
  // Unlike the pill (which stays out of the way until something is wrong), the
  // popup always shows the current reading — it's the one place to confirm the
  // check is actually working.
  const SVC_CLASSES = ["svc-minor", "svc-maintenance", "svc-major", "svc-critical"];

  function renderStatus(snap) {
    if (!el.svcStatus) return;
    const label = S ? S.shortLabel(snap) : "—";
    el.svcStatus.textContent = snap ? label : "Checking…";
    const level = snap && snap.ok ? snap.level : "unknown";
    for (const c of SVC_CLASSES) {
      el.svcStatus.classList.toggle(c, c === "svc-" + level);
    }
    const lines = snap && S ? S.detailLines(snap) : [];
    // A snapshot with both `ok` and `error` is a remembered reading we couldn't
    // refresh — say how old it is rather than pass it off as current.
    if (snap && snap.ok && snap.error) lines.push("last checked " + timeAgo(snap.fetchedAt));
    const detail = lines.slice(0, 3).join(" · ");
    el.svcDetail.textContent = detail;
    el.svcDetail.hidden = !detail;
  }

  function askStatus(force) {
    chrome.runtime.sendMessage({ type: "cum-status", force: !!force }, (res) => {
      void chrome.runtime.lastError;
      if (res && res.status) renderStatus(res.status);
    });
  }

  function saveStatusCfg(cfg, msg) {
    chrome.storage.local.set({ [STATUS_CFG_KEY]: cfg }, () => msg && flash(msg));
  }

  let acCfg = { enabled: false, max: 50, allowOnce: false };
  let dlCfg = { enabled: false, max: 20, catchUp: false, lookbackMin: 10 };
  let statusCfg = { warn: true, holdSends: true, defaultModel: "" };
  let warnCfg = { enabled: true, dailyShare: null };

  function saveWarnCfg(msg) {
    chrome.storage.local.set({ [WARN_CFG_KEY]: warnCfg }, () => msg && flash(msg));
  }

  chrome.storage.local.get(
    [
      STORAGE_KEY,
      MANUAL_URL_KEY,
      OVERAGE_KEY,
      "cum_runmargin_sticky",
      "cum_hide_nags",
      ESTIMATE_KEY,
      AUTOCONTINUE_KEY,
      AUTODOWNLOAD_KEY,
      AUTODOWNLOAD_SEEN_KEY,
      STATUS_KEY,
      STATUS_CFG_KEY,
      WARN_CFG_KEY,
    ],
    (res) => {
      render(res && res[STORAGE_KEY]);
      if (res && res[MANUAL_URL_KEY]) el.endpoint.value = res[MANUAL_URL_KEY];
      el.showOverage.checked = !!(res && res[OVERAGE_KEY]);
      el.runConsoleSticky.checked = !!(res && res.cum_runmargin_sticky);
      el.hideNags.checked = !!(res && res.cum_hide_nags);
      el.estimateDecimals.checked = !!(res && res[ESTIMATE_KEY]);
      acCfg = Object.assign(acCfg, (res && res[AUTOCONTINUE_KEY]) || {});
      el.autoContinue.checked = !!acCfg.enabled;
      el.allowOnce.checked = !!acCfg.allowOnce;
      el.acMax.value = acCfg.max;
      dlCfg = Object.assign(dlCfg, (res && res[AUTODOWNLOAD_KEY]) || {});
      el.autoDownload.checked = !!dlCfg.enabled;
      el.dlMax.value = dlCfg.max;
      if (el.dlLookback) el.dlLookback.value = lookbackOf(dlCfg.lookbackMin);
      el.dlCatchUp.checked = !!dlCfg.catchUp;
      renderDlSeen(res && res[AUTODOWNLOAD_SEEN_KEY]);
      // Both status toggles default ON, so only an explicit false turns them off.
      const sc = (res && res[STATUS_CFG_KEY]) || {};
      statusCfg = {
        warn: sc.warn !== false,
        holdSends: sc.holdSends !== false,
        // Blank means "whatever the worker's default is", which the
        // placeholder already says — storing "Opus 5" here would freeze
        // today's default into the settings.
        defaultModel: typeof sc.defaultModel === "string" ? sc.defaultModel : "",
      };
      el.statusWarn.checked = statusCfg.warn;
      el.statusHold.checked = statusCfg.holdSends;
      el.statusModel.value = statusCfg.defaultModel;
      // On by default, like the outage warning — only an explicit false is off.
      const wc = (res && res[WARN_CFG_KEY]) || {};
      warnCfg = {
        enabled: wc.enabled !== false,
        dailyShare: typeof wc.dailyShare === "number" ? wc.dailyShare : null,
      };
      el.usageWarn.checked = warnCfg.enabled;
      // Blank means the even seventh, which the placeholder already names.
      el.usageShare.value = warnCfg.dailyShare == null ? "" : String(warnCfg.dailyShare);
      renderStatus((res && res[STATUS_KEY]) || null);
      askStatus(false); // and refresh it if the worker's reading has gone stale
    }
  );

  el.statusWarn.addEventListener("change", () => {
    statusCfg.warn = el.statusWarn.checked;
    saveStatusCfg(statusCfg, statusCfg.warn ? "Outage warnings on" : "Outage warnings off");
  });

  el.usageWarn.addEventListener("change", () => {
    warnCfg.enabled = el.usageWarn.checked;
    saveWarnCfg(warnCfg.enabled ? "Usage-pace warnings on" : "Usage-pace warnings off");
  });

  el.usageShare.addEventListener("change", () => {
    const raw = el.usageShare.value.trim().replace(/%$/, "");
    const v = raw === "" ? null : Number(raw);
    if (v != null && (!isFinite(v) || !(v > 0) || v > 100)) {
      // A share the warnings would ignore anyway isn't stored: say so and put
      // the field back, rather than leaving a number on screen that does nothing.
      el.usageShare.value = warnCfg.dailyShare == null ? "" : String(warnCfg.dailyShare);
      return flash("A daily share is between 0 and 100%");
    }
    warnCfg.dailyShare = v;
    saveWarnCfg(v == null ? "Back to an even seventh a day" : "Daily share: " + v + "%");
  });

  el.statusHold.addEventListener("change", () => {
    statusCfg.holdSends = el.statusHold.checked;
    saveStatusCfg(
      statusCfg,
      statusCfg.holdSends ? "Sends will wait out an outage" : "Sends will fire regardless"
    );
  });

  el.statusModel.addEventListener("change", () => {
    statusCfg.defaultModel = el.statusModel.value.trim();
    saveStatusCfg(
      statusCfg,
      statusCfg.defaultModel
        ? "Assuming " + statusCfg.defaultModel
        : "Back to the built-in default"
    );
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STATUS_KEY]) renderStatus(changes[STATUS_KEY].newValue);
    if (changes[AUTODOWNLOAD_SEEN_KEY]) renderDlSeen(changes[AUTODOWNLOAD_SEEN_KEY].newValue);
  });

  function saveAc(msg) {
    chrome.storage.local.set({ [AUTOCONTINUE_KEY]: acCfg }, () => msg && flash(msg));
  }

  el.autoContinue.addEventListener("change", () => {
    acCfg.enabled = el.autoContinue.checked;
    saveAc(acCfg.enabled ? "Auto-continue on" : "Auto-continue off");
  });

  el.allowOnce.addEventListener("change", () => {
    acCfg.allowOnce = el.allowOnce.checked;
    saveAc(acCfg.allowOnce ? 'Auto-clicking "Allow once"' : "Auto-allow off");
  });

  el.acMax.addEventListener("change", () => {
    let n = parseInt(el.acMax.value, 10);
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > 999) n = 999;
    el.acMax.value = n;
    acCfg.max = n;
    saveAc("Saved");
  });

  // What the watcher last saw. Three faults share the symptom "it isn't
  // working" — the turn wasn't seen to land, no file was found in it, or one was
  // found and held back — and this is the line that tells them apart.
  function renderDlSeen(snap) {
    if (!el.dlSeen) return;
    const show = !!(snap && snap.line && dlCfg.enabled);
    el.dlSeen.hidden = !show;
    if (show) el.dlSeen.textContent = "Last seen " + timeAgo(snap.at) + ": " + snap.line;
  }

  // Ask the claude.ai tab you are looking at what it can actually see. The
  // popup has to name the tab itself: the content script is per-page, and the
  // answer is only meaningful for the conversation with the file in it.
  let probeText = "";
  function runProbe(what) {
    const btn = what === "try" ? el.dlTry : el.dlProbe;
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = what === "try" ? "Saving…" : "Looking…";
    const done = (text) => {
      btn.disabled = false;
      btn.textContent = was;
      probeText = text || "";
      el.dlProbeOut.hidden = !probeText;
      el.dlProbeOut.textContent = probeText;
      el.dlCopy.hidden = !probeText;
    };
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = (tabs || [])[0];
        if (!tab || !/^https:\/\/claude\.ai\//.test(tab.url || ""))
          return done("Open the claude.ai conversation with the file in it, then press this again.");
        chrome.tabs.sendMessage(tab.id, what === "try" ? "cum-dl-try" : "cum-dl-probe", (res) => {
          if (chrome.runtime.lastError)
            return done(
              "That tab didn't answer — " + chrome.runtime.lastError.message +
                "\nReload the conversation and try again."
            );
          done((res && res.text) || "The page answered, but said nothing.");
        });
      });
    } catch (e) {
      done("Couldn't reach the tab: " + String((e && e.message) || e));
    }
  }

  // The saver writes its finished tally to storage when the last file of a
  // batch has settled — after the message it answered has already been replied
  // to. Without this the popup would show "saving 3 files" and never what
  // became of them.
  const PROBE_KEY = "cum_autodownload_probe";
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[PROBE_KEY] || !el.dlProbeOut) return;
      const text = ((changes[PROBE_KEY].newValue || {}).text || "").trim();
      if (!text) return;
      probeText = text;
      el.dlProbeOut.textContent = text;
      el.dlProbeOut.hidden = false;
      if (el.dlCopy) el.dlCopy.hidden = false;
    });
  } catch (e) {
    /* ignore */
  }

  if (el.dlProbe) el.dlProbe.addEventListener("click", () => runProbe("see"));
  if (el.dlTry) el.dlTry.addEventListener("click", () => runProbe("try"));
  if (el.dlCopy)
    el.dlCopy.addEventListener("click", () => {
      try {
        navigator.clipboard.writeText(probeText).then(
          () => flash("Report copied"),
          () => flash("Couldn't copy — select it and copy by hand")
        );
      } catch (e) {
        flash("Couldn't copy — select it and copy by hand");
      }
    });

  function saveDl(msg) {
    chrome.storage.local.set({ [AUTODOWNLOAD_KEY]: dlCfg }, () => msg && flash(msg));
  }

  el.autoDownload.addEventListener("change", () => {
    dlCfg.enabled = el.autoDownload.checked;
    if (!dlCfg.enabled && el.dlSeen) el.dlSeen.hidden = true;
    saveDl(dlCfg.enabled ? "Saving files Claude produces" : "Auto-download off");
  });

  el.dlCatchUp.addEventListener("change", () => {
    dlCfg.catchUp = el.dlCatchUp.checked;
    saveDl(
      dlCfg.catchUp
        ? "Catching up on files you don't already have"
        : "Only files that arrive while you're watching"
    );
  });

  el.dlMax.addEventListener("change", () => {
    let n = parseInt(el.dlMax.value, 10);
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > 200) n = 200;
    el.dlMax.value = n;
    dlCfg.max = n;
    saveDl("Saved");
  });

  // One clamp, in CUMAutoDl, so this page and the clicker that reads the
  // setting can never disagree about what a stored number means. The fallback
  // is only for a popup whose script didn't load, and repeats the same bounds.
  function lookbackOf(value) {
    const A = window.CUMAutoDl;
    if (A) return A.lookbackMinutes(value);
    const n = parseInt(String(value == null ? "" : value).trim(), 10);
    if (!Number.isFinite(n)) return 10;
    return Math.min(1440, Math.max(1, Math.round(n)));
  }

  if (el.dlLookback)
    el.dlLookback.addEventListener("change", () => {
      const n = lookbackOf(el.dlLookback.value);
      el.dlLookback.value = n;
      dlCfg.lookbackMin = n;
      saveDl(
        n === 1 ? "Catching up on the last minute" : "Catching up on the last " + n + " minutes"
      );
    });

  el.showOverage.addEventListener("change", () => {
    chrome.storage.local.set({ [OVERAGE_KEY]: el.showOverage.checked }, () =>
      flash(el.showOverage.checked ? "Extra usage on" : "Extra usage off")
    );
  });

  el.hideNags.addEventListener("change", () => {
    chrome.storage.local.set({ cum_hide_nags: el.hideNags.checked }, () =>
      flash(el.hideNags.checked ? "Hiding claude.ai's usage banners" : "claude.ai's banners shown again")
    );
  });

  el.runConsoleSticky.addEventListener("change", () => {
    const on = el.runConsoleSticky.checked;
    // Turning it off also forgets the stored spot, so the console snaps back
    // to its default rather than remembering a preference that is now off.
    const write = on
      ? { cum_runmargin_sticky: true }
      : { cum_runmargin_sticky: false, cum_runmargin_geo: null };
    chrome.storage.local.set(write, () =>
      flash(on ? "Run console remembers where you put it" : "Run console snaps back to default")
    );
  });

  el.estimateDecimals.addEventListener("change", () => {
    chrome.storage.local.set({ [ESTIMATE_KEY]: el.estimateDecimals.checked }, () =>
      flash(el.estimateDecimals.checked ? "Estimating decimals" : "Whole numbers")
    );
  });

  el.save.addEventListener("click", () => {
    const raw = el.endpoint.value.trim();
    // Accept a full URL or a same-origin path; normalise to a path.
    let value = raw;
    if (raw) {
      try {
        if (/^https?:\/\//i.test(raw)) value = new URL(raw).pathname + new URL(raw).search;
      } catch (e) {
        flash("Invalid URL");
        return;
      }
      if (!value.includes("/api/")) {
        flash("Must be an /api/ URL");
        return;
      }
    }
    chrome.storage.local.set({ [MANUAL_URL_KEY]: value }, () =>
      flash(value ? "Saved — reload claude.ai" : "Cleared endpoint")
    );
  });

  el.clear.addEventListener("click", () => {
    const cleared = {
      percent: null,
      resetAt: null,
      weeklyPercent: null,
      weeklyResetAt: null,
      remaining: null,
      limit: null,
      used: null,
      updatedAt: null,
    };
    chrome.storage.local.set({ [STORAGE_KEY]: cleared }, () => {
      render(cleared);
      flash("Cleared");
    });
  });

  el.openLog.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // ---- Pseudonym key ------------------------------------------------------
  //
  // Loading the key here PARSES it (src/xlsxread.js + src/pseudo.js) and stores
  // only the map — the file itself is never uploaded anywhere. Attach binds the
  // key to the conversation in the active tab; the content script
  // (pseudo-view.js) does the display translation and the composer warning.
  (function pseudoSection() {
    const P = window.CUMPseudo;
    const X = window.CUMXlsx;
    const KEYS_KEY = "cum_pseudo_keys";
    const CHATS_KEY = "cum_pseudo_chats";
    const ui = {
      here: document.getElementById("pseudo-here"),
      chat: document.getElementById("pseudo-chat"),
      select: document.getElementById("pseudo-select"),
      attach: document.getElementById("pseudo-attach"),
      detach: document.getElementById("pseudo-detach"),
      load: document.getElementById("pseudo-load"),
      forget: document.getElementById("pseudo-forget"),
      file: document.getElementById("pseudo-file"),
      status: document.getElementById("pseudo-status"),
    };
    if (!ui.load || !P || !X) return;

    let keys = {};
    let chats = {};
    let tabConv = null; // conversation key of the active tab, if it's a chat
    let tabTitle = "";

    function say(text) {
      ui.status.textContent = text;
      ui.status.hidden = false;
      setTimeout(() => {
        ui.status.hidden = true;
      }, 2600);
    }

    // Every case's key file is named pseudonym_key.xlsx, so the label is the
    // case FOLDER it was picked from where there is one, and the case HINT
    // (the real value its exports used most) where there isn't — P.keyLabel
    // owns that order, so the popup, the run editor's picker and the badge in
    // the chat all call a key the same thing. Local UI only.
    function keyLabel(k) {
      return P.keyLabel ? P.keyLabel(k) : (k.name || "key") + " · " + k.rows + " rows";
    }

    function renderPseudo() {
      const ids = Object.keys(keys);
      ui.select.hidden = ids.length < 2;
      ui.select.innerHTML = "";
      for (const id of ids) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = keyLabel(keys[id]);
        ui.select.appendChild(opt);
      }
      ui.forget.hidden = !ids.length;
      const attachedId = tabConv ? chats[tabConv] : null;
      ui.here.textContent =
        attachedId && keys[attachedId]
          ? keyLabel(keys[attachedId])
          : ids.length
          ? "loaded, not attached here"
          : "none loaded";
      ui.chat.textContent = tabConv
        ? (attachedId ? "attached to: " : "this chat: ") + (tabTitle || tabConv)
        : "open a claude.ai conversation to attach";
      ui.attach.disabled = !tabConv || !ids.length;
      ui.detach.hidden = !attachedId;
      if (attachedId && keys[attachedId]) ui.select.value = attachedId;
    }

    function loadPseudoState() {
      chrome.storage.local.get([KEYS_KEY, CHATS_KEY], (res) => {
        keys = (res && res[KEYS_KEY]) || {};
        chats = (res && res[CHATS_KEY]) || {};
        renderPseudo();
      });
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = (tabs || [])[0];
      if (tab && /^https:\/\/claude\.ai\//.test(tab.url || "")) {
        const conv = P.conversationKeyFromUrl(tab.url);
        if (conv && conv !== "/new" && conv !== "/") {
          tabConv = conv;
          tabTitle = tab.title || "";
        }
      }
      loadPseudoState();
    });

    ui.load.addEventListener("click", () => ui.file.click());

    ui.file.addEventListener("change", async () => {
      const f = ui.file.files && ui.file.files[0];
      ui.file.value = "";
      if (!f) return;
      try {
        const wb = await X.parseXlsx(await f.arrayBuffer());
        if (!P.sheetsLookLikeKey(wb.sheets)) {
          say("That workbook has no Real Value / Replacement sheet — not a pseudonym key.");
          return;
        }
        const key = P.parseKey(wb.sheets, f.name);
        if (!key.rows) {
          say("The key parsed but holds no usable rows.");
          return;
        }
        // Content decides identity, never the filename — every case's key is
        // named pseudonym_key.xlsx. The same case's refreshed key lands on
        // its existing entry (attachments follow onto the new rows); a
        // different case's key gets its own entry beside it.
        const where = P.libraryIdFor(keys, key);
        key.savedAt = Date.now();
        // The file cannot know which case FOLDER named this key, so a refresh
        // from here keeps what the entry already learned (P.keepKeyFacts).
        keys[where.id] = P.keepKeyFacts ? P.keepKeyFacts(keys[where.id], key) : key;
        chrome.storage.local.set({ [KEYS_KEY]: keys }, () => {
          renderPseudo();
          ui.select.value = where.id;
          const d = key.dropped || {};
          say(
            (where.refreshed ? "Refreshed " : "Loaded ") + keyLabel(key) +
              (d.keeps ? " · " + d.keeps + " keep rows skipped" : "") +
              (d.ambiguous ? " · " + d.ambiguous + " ambiguous fakes retired" : "")
          );
        });
      } catch (e) {
        say("Couldn't read that file: " + String((e && e.message) || e));
      }
    });

    // Attaching (or switching) a key in a chat that belongs to a RUN updates
    // the whole case: the run, every run in its group, and their chats —
    // runs are per case, one case one key. The background owns that write
    // (cum-pseudo-rekey); only a chat no run owns gets a plain chat-level
    // attachment here.
    function rekeyOrChat(keyId, saidRun, saidChat) {
      chrome.runtime.sendMessage(
        { type: "cum-pseudo-rekey", conv: tabConv, keyId: keyId },
        (res) => {
          void chrome.runtime.lastError; // background gone: fall back below
          if (res && res.ok && res.runs) {
            renderPseudo();
            say(saidRun.replace("%n", res.runs));
            return;
          }
          if (keyId) chats[tabConv] = keyId;
          else delete chats[tabConv];
          chrome.storage.local.set({ [CHATS_KEY]: chats }, () => {
            renderPseudo();
            say(saidChat);
          });
        }
      );
    }

    ui.attach.addEventListener("click", () => {
      const ids = Object.keys(keys);
      if (!tabConv || !ids.length) return;
      const id = ui.select.hidden ? ids[0] : ui.select.value || ids[0];
      rekeyOrChat(
        id,
        "Attached to this case — %n run(s) and all their chats follow.",
        "Attached — that chat now shows real names (display only)."
      );
    });

    ui.detach.addEventListener("click", () => {
      if (!tabConv) return;
      rekeyOrChat(
        null,
        "Detached from this case — %n run(s) and all their chats follow.",
        "Detached — reload the chat to see the fakes again."
      );
    });

    ui.forget.addEventListener("click", () => {
      const ids = Object.keys(keys);
      if (!ids.length) return;
      const id = ui.select.hidden ? ids[0] : ui.select.value || ids[0];
      delete keys[id];
      for (const conv of Object.keys(chats)) if (chats[conv] === id) delete chats[conv];
      chrome.storage.local.set({ [KEYS_KEY]: keys, [CHATS_KEY]: chats }, () => {
        renderPseudo();
        say("Forgotten, and detached everywhere it was attached.");
      });
    });
  })();
})();
