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
    estimateDecimals: document.getElementById("estimate-decimals"),
    autoContinue: document.getElementById("auto-continue"),
    allowOnce: document.getElementById("allow-once"),
    acMax: document.getElementById("ac-max"),
    autoDownload: document.getElementById("auto-download"),
    dlMax: document.getElementById("dl-max"),
    dlSeen: document.getElementById("dl-seen"),
    openLog: document.getElementById("open-log"),
    svcStatus: document.getElementById("svc-status"),
    svcDetail: document.getElementById("svc-detail"),
    statusWarn: document.getElementById("status-warn"),
    statusHold: document.getElementById("status-hold"),
    statusModel: document.getElementById("status-model"),
    dlProbe: document.getElementById("dl-probe"),
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
  let dlCfg = { enabled: false, max: 20 };
  let statusCfg = { warn: true, holdSends: true, defaultModel: "" };

  chrome.storage.local.get(
    [
      STORAGE_KEY,
      MANUAL_URL_KEY,
      OVERAGE_KEY,
      ESTIMATE_KEY,
      AUTOCONTINUE_KEY,
      AUTODOWNLOAD_KEY,
      AUTODOWNLOAD_SEEN_KEY,
      STATUS_KEY,
      STATUS_CFG_KEY,
    ],
    (res) => {
      render(res && res[STORAGE_KEY]);
      if (res && res[MANUAL_URL_KEY]) el.endpoint.value = res[MANUAL_URL_KEY];
      el.showOverage.checked = !!(res && res[OVERAGE_KEY]);
      el.estimateDecimals.checked = !!(res && res[ESTIMATE_KEY]);
      acCfg = Object.assign(acCfg, (res && res[AUTOCONTINUE_KEY]) || {});
      el.autoContinue.checked = !!acCfg.enabled;
      el.allowOnce.checked = !!acCfg.allowOnce;
      el.acMax.value = acCfg.max;
      dlCfg = Object.assign(dlCfg, (res && res[AUTODOWNLOAD_KEY]) || {});
      el.autoDownload.checked = !!dlCfg.enabled;
      el.dlMax.value = dlCfg.max;
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
      renderStatus((res && res[STATUS_KEY]) || null);
      askStatus(false); // and refresh it if the worker's reading has gone stale
    }
  );

  el.statusWarn.addEventListener("change", () => {
    statusCfg.warn = el.statusWarn.checked;
    saveStatusCfg(statusCfg, statusCfg.warn ? "Outage warnings on" : "Outage warnings off");
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
  function runProbe() {
    el.dlProbe.disabled = true;
    el.dlProbe.textContent = "Looking…";
    const done = (text) => {
      el.dlProbe.disabled = false;
      el.dlProbe.textContent = "What can it see?";
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
        chrome.tabs.sendMessage(tab.id, "cum-dl-probe", (res) => {
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

  if (el.dlProbe) el.dlProbe.addEventListener("click", runProbe);
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

  el.dlMax.addEventListener("change", () => {
    let n = parseInt(el.dlMax.value, 10);
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > 200) n = 200;
    el.dlMax.value = n;
    dlCfg.max = n;
    saveDl("Saved");
  });

  el.showOverage.addEventListener("change", () => {
    chrome.storage.local.set({ [OVERAGE_KEY]: el.showOverage.checked }, () =>
      flash(el.showOverage.checked ? "Extra usage on" : "Extra usage off")
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
})();
