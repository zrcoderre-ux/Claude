# Claude Usage Meter

A Chrome extension that shows your **current Claude session usage** and a live
**countdown to the next limit reset** in a floating button pinned to the
bottom-right corner of [claude.ai](https://claude.ai).

![Extension icon](icons/icon128.png)

## What it does

- Adds a small floating pill in the bottom-right of every claude.ai page.
- The ring tracks your **5-hour session** usage; the label shows the percent
  and `resets in 2h 14m`. It turns amber at 75% and red at 90%.
- Click the pill for a detail panel with up to four meters:
  - **Session · 5 hr** and **Weekly · 7 day** rate-limit windows, each with its
    own reset.
  - **Context window** — an **estimate** of how full the current conversation
    is, e.g. `~64% · ~128k / 200k` (marked `est.`). claude.ai's web app does not
    expose token counts, so this is derived from the conversation's text length
    (≈4 chars/token) — approximate, and it can't see system prompt / tools /
    attachments.
  - **Extra usage** — your pay-as-you-go spend (`$0.00 / $30.00`), **opt-in**
    via the popup toggle (off by default).
- A toolbar popup mirrors the data, toggles extra usage, and can pin the
  endpoint or clear stored values.
- **Drag the pill** anywhere on the page — its position is remembered, and the
  detail panel opens toward whichever side has room.
- **Auto-click "Continue"** (opt-in) — when a long turn hits the tool-use /
  length limit, clicks Claude's Continue button for you, even in background tabs.
- **Usage log + CSV** (Options) — records when you hit 100% and the usage % at
  each 5-hour reset; export to a spreadsheet.
- **Scheduled sends** (Options) — queue files + an optional prompt to a new chat
  (optionally in a Project) to send at a set time or when usage next resets.

## Scheduled sends

Set up in **Options**. Each job stores your files inside the extension
(`chrome.storage`, `unlimitedStorage`) plus an optional prompt and a target
(a new chat, or a Project). Triggers:

- **When usage resets** — fires just after your 5-hour window rolls over (uses
  the reset time the meter already tracks).
- **At a set time** — a `chrome.alarms` timer.

At fire time the background worker opens a background claude.ai tab at the right
composer (`/new` or `/cowork/project/{uuid}`), and a content script attaches the
files (via the hidden `file-upload` input), waits for each upload to finish
(watching the `wiggle/upload-file` response), types the prompt into the
ProseMirror editor, and clicks **Send message** — all by driving the real UI, so
there's no token-harvesting or backend server.

**Limitation:** a job only fires while your **browser is running and logged into
claude.ai**. There's no headless/while-closed execution (that would require a
hosted backend). "When usage resets" is the common case and your browser is
usually open then; a specific time with the browser closed will fire the next
time it's open.

### A note on precision

The rate-limit windows come back as **whole-number percentages** (the server
rounds them — there are no `anthropic-ratelimit-*` headers on these calls to
derive anything finer). claude.ai's web app does **not** expose token counts
anywhere, so the **context meter is an estimate** (text length ÷ ~4), shown with
a `~` and an `est.` badge.

**Estimate decimals (experimental, opt-in).** With the toggle on, the session
meter adds an estimated tenths place (`48.3%`). Since usage only climbs within a
fixed window, it learns "tokens per 1%" from the integer jumps it sees, then
divides the tokens consumed since the last jump by that rate. It always snaps to
the authoritative server integer and caps the fraction below the next whole
number, so it only ever affects the tenths place. It's an estimate — the
per-turn cost is itself the text-length estimate (claude.ai exposes no token
counts), it can't see usage from other tabs/devices/the API, and the per-model
weighting isn't documented — which is why it's off by default and labelled
experimental. The calibration lives in `src/estimate.js` and is unit-tested.

## How it reads usage

Claude.ai does not expose a documented "usage" API, so the extension observes
(and replays) the network the web app already uses. A page-context script
(`src/inject.js`) wraps `fetch`/`XMLHttpRequest`, and for `/api/` requests it
scans response **headers** (`anthropic-ratelimit-*`, `retry-after`) and
**JSON/SSE bodies** for anything shaped like a limit, a remaining/used count,
or a reset timestamp (`src/harvest.js`). Findings are forwarded to the content
script, persisted in `chrome.storage.local`, and rendered.

The confirmed source is the same endpoint the Usage page itself loads:

```
GET /api/organizations/{org_uuid}/usage
→ { five_hour: { utilization: 48, resets_at: "…" },   // the "session"
    seven_day: { utilization: 43, resets_at: "…" },   // the weekly window
    limits: [ { kind, percent, resets_at, is_active } … ], spend: {…} }
```

`utilization`/`percent` are **0–100 percentages**, so the meter is percent-based:
the ring and the "Session · 5 hr" row track `five_hour`, and the panel also
shows the `seven_day` weekly window. `src/harvest.js` parses this shape
directly (`parseClaudeUsage`) and falls back to the generic header/SSE scanner
for anything else.

To avoid an empty "no data" state, the extension establishes a **baseline**
three ways, in order of preference:

1. **Discovery (primary).** On load it reads `/api/organizations` (and
   `/api/bootstrap`) to find your org uuid and fetches
   `/api/organizations/{uuid}/usage` directly — so the meter populates on its
   own, no interaction required.
2. **Self-learning.** Any usage URL the app itself calls is remembered and
   re-fetched on later loads and every 5 minutes, keeping the baseline fresh.
3. **Manual pin (optional).** Paste the exact usage request URL into the
   toolbar popup to override discovery.

The **context meter** is estimated from the conversation payload
(`GET /api/organizations/{uuid}/chat_conversations/{uuid}?…`), which contains
each message's text but no token counts — so it approximates tokens as
characters ÷ 4. The **extra-usage** line, when enabled, reads
`/api/organizations/{uuid}/overage_spend_limit` (credit amounts are minor units,
so `3000` → `$30.00`).

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
5. Open [claude.ai](https://claude.ai) — the meter appears in the bottom-right
   corner and populates within a few seconds.

## Project layout

```
manifest.json          MV3 manifest
src/harvest.js         Pure usage-parsing logic (shared by ext + tests)
src/estimate.js        Pure tenths-place calibrator (shared by ext + tests)
src/inject.js          MAIN-world interceptor + proactive baseline fetch
src/content.js         ISOLATED-world UI + state + live countdown
src/content.css        Floating-button styles (light + dark)
src/popup.html/js/css  Toolbar popup (status + toggles + manual endpoint)
test/harvest.test.js   Unit tests for the parsing heuristics
test/estimate.test.js  Unit tests for the tenths-place calibrator
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
