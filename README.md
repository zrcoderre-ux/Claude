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
the network responses the web app already receives. A page-context script
(`src/inject.js`) wraps `fetch`/`XMLHttpRequest`, and for requests to Claude's
`/api/` endpoints it scans the response **headers** (`anthropic-ratelimit-*`,
`retry-after`) and **JSON/SSE bodies** for any fields that look like a limit,
a remaining/used count, or a reset timestamp. Whatever it finds is forwarded to
the content script, persisted in `chrome.storage.local`, and rendered.

Because the numbers come from Claude's own responses, **the meter populates
after you send a message** in a session. Until then it shows `No data yet`.

> Note: this is a best-effort reader. If Anthropic changes their response
> shape, the harvesting heuristics in `src/inject.js` may need updating — they
> are deliberately broad and easy to adjust.

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
src/inject.js          MAIN-world interceptor (harvests usage from responses)
src/content.js         ISOLATED-world UI + state + live countdown
src/content.css        Floating-button styles (light + dark)
src/popup.html/js/css  Toolbar popup
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
