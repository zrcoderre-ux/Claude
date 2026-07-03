# Claude Usage Meter

A Chrome extension that shows your **current Claude session usage** and a live
**countdown to the next limit reset** in a floating button pinned to the
bottom-left corner of [claude.ai](https://claude.ai).

![Extension icon](icons/icon128.png)

## What it does

- Adds a small floating pill in the bottom-left of every claude.ai page.
- Shows a progress ring (percent of your session limit used), the usage figure
  (e.g. `12 / 45` or `33 left`), and `resets in 2h 14m`.
- Click the pill to expand a panel with the full breakdown.
- The ring turns amber at 75% and red at 90% so you get a heads-up before you
  hit the wall.
- A toolbar popup mirrors the same data and lets you clear stored values.

## How it reads usage

Claude.ai does not expose a documented "usage" API, so the extension observes
(and replays) the network the web app already uses. A page-context script
(`src/inject.js`) wraps `fetch`/`XMLHttpRequest`, and for `/api/` requests it
scans response **headers** (`anthropic-ratelimit-*`, `retry-after`) and
**JSON/SSE bodies** for anything shaped like a limit, a remaining/used count,
or a reset timestamp (`src/harvest.js`). Findings are forwarded to the content
script, persisted in `chrome.storage.local`, and rendered.

To avoid an empty "no data" state, it establishes a **baseline** three ways,
in order of preference:

1. **Self-learning (primary).** When you open **Settings → Usage**, the app
   fetches your usage — the interceptor harvests it *and remembers that URL*.
   On every later page load (and every 5 minutes) the extension re-fetches that
   same URL in the background, so the meter shows a live baseline with no
   interaction. Open the Usage page once and you're set.
2. **Discovery (best-effort).** On first load, before any URL is learned, it
   probes `/api/bootstrap` to find your organization and tries candidate usage
   endpoints.
3. **Manual pin (optional).** Paste the exact Usage request URL (from your
   browser's Network tab) into the toolbar popup to pin it.

Passive interception still updates the numbers live as you send messages.

> Note: this is a best-effort reader. If Anthropic changes their response
> shape, the broad harvesting heuristics in `src/harvest.js` are easy to adjust
> and are covered by the test suite.

## Development / tests

```bash
npm test        # unit tests for the usage-parsing heuristics (src/harvest.js)
npm run icons   # regenerate the PNG icons
```

The parsing logic lives in `src/harvest.js` (no DOM/chrome deps) so it can be
unit-tested directly under Node. `test/harvest.test.js` covers Anthropic-style
rate-limit headers, SSE `resets_at` payloads, and the false-positive guards
(e.g. `max_tokens` and `input_tokens` must **not** be read as session quota).

## Install (developer / unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select this folder.
5. Open [claude.ai](https://claude.ai) and send a message — the meter appears
   in the bottom-left corner.

## Project layout

```
manifest.json          MV3 manifest
src/harvest.js         Pure usage-parsing logic (shared by ext + tests)
src/inject.js          MAIN-world interceptor + proactive baseline fetch
src/content.js         ISOLATED-world UI + state + live countdown
src/content.css        Floating-button styles (light + dark)
src/popup.html/js/css  Toolbar popup (status + manual endpoint)
test/harvest.test.js   Unit tests for the parsing heuristics
icons/                 Generated PNG icons (16/48/128)
scripts/make_icons.py  Regenerates the icons with the Python stdlib only
```

## Privacy

Everything runs locally in your browser. No data is sent anywhere; the only
storage used is `chrome.storage.local` on your machine. The extension requests
access to `claude.ai` only.

## Regenerating icons

```bash
python3 scripts/make_icons.py
```
