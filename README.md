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
- **Auto-click "Continue" / "Try again"** (opt-in) — clicks Claude's Continue
  button when a long turn hits the tool-use / length limit, and clicks
  **Try again** once your usage resets after hitting a limit (it waits for the
  reset). Works on claude.ai and **Claude Code**, even in background tabs.
- **Auto-click "Allow once"** (opt-in, separate toggle) — clicks Claude's
  **Allow once** button the moment a permission prompt appears, so an agentic run
  doesn't stall. It matches **only** `Allow once` — never *Allow always* or
  *Allow for this chat* — so nothing is granted beyond the single call in front of
  it. You are approving those calls sight-unseen, which is why it's off by
  default and has its own switch rather than riding on auto-continue's.
- **Outage warnings** — watches
  [status.claude.com](https://status.claude.com/) and warns on the pill when
  Claude is degraded, down, or under maintenance. A **scheduled send waits out an
  outage** instead of firing into it. See [Outage detection](#outage-detection).
- **Usage log + CSV** (Options) — records when you hit 100% and the usage % at
  each 5-hour reset; export to a spreadsheet.
- **Scheduled sends** — queue files (pick individually or **a whole folder**) +
  an optional prompt to a **new chat, a Project, or the chat you're currently
  in**, to send at a set time or when usage next resets. Set them up from the
  Options page or the **＋ Schedule a send** button in the pill's panel.
- **Workflows** — run one piece of work through **several chats that hand it
  back and forth**: A drafts, B attacks the draft, A revises, round and round,
  then a final pass. Editable, copyable, deletable, with one pre-built. See
  [Workflows](#workflows).

## Scheduled sends

Set up from **Options** or the **＋ Schedule a send** button in the pill's
detail panel (which opens the same form as a modal — a shared module,
`src/jobform.js`). Add files by **dragging them (or a whole folder) onto the
drop zone**, or via the Choose files / Choose folder buttons; selections show as
removable chips and are snapshotted at queue time. Pick a **target**: a new
chat, a Project, or — when opened from the pill while viewing a conversation —
**this chat**. Each job stores your files inside the extension
(`chrome.storage`, `unlimitedStorage`) plus an optional prompt. Triggers:

- **When usage resets** — fires just after your 5-hour window rolls over (uses
  the reset time the meter already tracks).
- **At a set time** — a `chrome.alarms` timer.

If Claude is down when a trigger fires, the job **waits** rather than sending
into the outage — see [Outage detection](#outage-detection).

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

## Workflows

A scheduled send fires one message into one chat. A **workflow** runs a piece of
work through **several chats that talk to each other**, because a second
conversation criticising the first one's output is worth more than asking the
first one to check its own work.

The pre-built example — the one this was built for — is
**Tentative ruling — 3× devil's advocate**:

1. **Chat A** gets the motion papers and drafts the tentative ruling
   (`tentative-ruling` skill).
2. The draft goes to **chat B**, which attacks it (`devils-advocate` skill).
3. The report goes back to **A**, which revises.
4. Steps 2–3 again, and again — **three devil's advocate passes**.
5. **A** does a final substantive pass over the whole thing.
6. **A** runs the `ruling-style` pass over it.

Nine steps, two conversations, no copying and pasting by hand.

### Building your own

**Options → Workflows → New workflow.** Everything is editable, and any workflow
can be **copied** (a copy is yours — the pre-built one is not special) or
**deleted**.

- **Chats worked between** — 1 to 6. Each is its own claude.ai conversation with
  its own destination (new chat, a **Project**, or a **Claude Code** session on a
  repo) and its own **model**. Reducing the count moves any orphaned steps to the
  last remaining chat rather than throwing their prompts away.
- **Documents** — dropped in once, with a tick per chat saying **who gets them**.
  A chat's documents upload with its **first** message, which is the one that
  opens the conversation. A document assigned to nobody isn't uploaded, and the
  editor says so.
- **Steps** — ordered, each naming the chat it runs in and the prompt to send. A
  step can **carry the previous step's reply** under its prompt (this is the
  hand-off; it's the copy-and-paste the workflow exists to automate), with a
  label so the pasted material is announced — `----- BEGIN DEVIL'S ADVOCATE
  REPORT -----`. Steps returning to a chat that already has the material usually
  don't need to carry anything: the conversation still remembers it.

### Running one

Pick **Run now**, **When usage resets**, or **At a set time** on the workflow's
row and press **Start** — the same three triggers a scheduled send has, sharing
the same alarms. The run then walks its steps: open (or return to) the step's
chat, attach that chat's documents if it's the chat's first message, type the
composed prompt, send, **wait for Claude to finish**, take the reply, and carry
it into the next step. Progress, the conversation links, and any failure show up
under **Runs**, where a run can be **cancelled** or **resumed** from the step it
stopped on.

**How the reply is read.** The way you would do it: the **copy box** under the
finished answer, which copies the answer *without* the thinking. The extension
clicks it and captures what the page writes to the clipboard (hooked in
`src/inject.js`) — so it needs no clipboard permission, works in a background
tab, and gets Claude's own markdown. If that comes back implausibly short (a code
block has its own copy button) it falls back to the conversation payload from
claude.ai's API, text blocks only, and finally to the rendered message text.
A step is only read once Claude has stopped generating **and** the text has held
still for a few seconds, so a half-streamed answer never travels.

**When things go wrong.** A run is driven through the real UI, so it needs your
browser open and logged in. If Claude is down it **waits mid-workflow** and picks
up where it left off (same gate, same 6-hour ceiling as a scheduled send). If the
service worker dies mid-step — which MV3 does routinely — the page keeps going
and writes the result to storage, and the worker takes the run back within 30
seconds. A step whose message has already gone out is **re-attached to, never
re-sent**, so nothing is ever posted twice. A run that can't finish fails loudly
(a notification, and the error on the row) rather than going quiet.

Each chat's tab is left open when the run finishes — the conversations are the
point.

## Outage detection

The background worker polls
[`status.claude.com/api/v2/summary.json`](https://status.claude.com/api) — an
Atlassian Statuspage, so the schema is the documented v2 one — every 5 minutes,
and every minute while something is wrong. The reading drives two things:

- **A status line in the pill's panel**, directly under the Context bar and
  **always shown**: a coloured dot plus the status page's own wording — green
  `All Systems Operational` on a normal day, amber when degraded, red during an
  outage, blue for maintenance, grey when the check itself couldn't complete.
  Green is reserved for a check that came back clean, never one that failed, so
  the row can't quietly imply all-clear. Click it to open the status page. The
  popup mirrors it.
- **A warning pill** above the meter, showing what's affected (`Claude.ai major
  outage`, `Elevated errors on message send`) and linking to the status page.
  Unlike the panel row this appears *only* while Claude is actually degraded or
  down — the panel is where you deliberately went to look, the pill is what
  interrupts you.
- **Scheduled sends wait.** A job whose trigger fires during an outage goes to
  **Waiting** instead of running, and sends itself once Claude recovers (within a
  minute of it clearing). Nothing is lost — the files and prompt stay queued.

Two calls decide what counts:

**Whose outage is it.** The page's blended `status.indicator` covers surfaces this
extension never touches — Bedrock, Vertex, the developer console — so relevance
is judged per component. A Bedrock-only outage neither warns nor holds. The page
indicator is trusted only when our own components look clean *and* nothing
excluded explains it, so a schema change can never read as "all clear".
`api.anthropic.com` is deliberately **not** excluded: claude.ai rides the same
serving layer, and waiting through a model outage is the recoverable mistake.

**Warn vs hold.** *Degraded performance* and low-impact incidents **warn only** —
Claude still answers, so blocking a send would cost more than it saves. *Partial
outage*, *major outage* and *under maintenance* **hold**, because a send driven
through the real UI has nothing to fall back on.

And the escape hatches, because a queued send that never leaves is its own
failure:

- After **6 hours** of waiting a job sends anyway, with a note saying how long it
  waited and why.
- **Run now** (Options) always overrides the wait.
- A status page we *can't reach* holds nothing — the reading degrades to
  `unknown` and the send goes out. A remembered outage does survive up to 15
  minutes of failed polls, so one blip can't release a hold prematurely.
- Both behaviours have popup toggles (on by default).

The parsing and the gate live in `src/status.js` (no DOM/chrome deps) and are
unit-tested in `test/status.test.js`.

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
src/status.js          Pure status.claude.com model + the scheduled-send gate
src/jobstore.js        Pure scheduled-send job model
src/workflow.js        Pure multi-chat workflow model, run state + pre-built
src/inject.js          MAIN-world interceptor + proactive baseline fetch
src/content.js         ISOLATED-world UI + state + live countdown
src/content.css        Floating-button styles (light + dark)
src/composer.js        The one place that drives claude.ai's composer DOM
src/scheduler-run.js   Sends a queued job through the composer
src/workflow-run.js    Runs one workflow step and reads Claude's reply
src/jobform.js         Shared scheduled-send form (options page + pill modal)
src/workflowform.js    Workflow editor (options page)
src/popup.html/js/css  Toolbar popup (status + toggles + manual endpoint)
test/harvest.test.js   Unit tests for the parsing heuristics
test/estimate.test.js  Unit tests for the tenths-place calibrator
test/status.test.js    Unit tests for the status model + hold decisions
test/workflow.test.js  Unit tests for the workflow model + run transitions
test/autocontinue.test.js  Unit tests for the button-label predicates
icons/                 Generated PNG icons (16/48/128)
scripts/make_icons.py  Regenerates the icons with the Python stdlib only
```

## Privacy

Everything runs locally in your browser. No data is sent anywhere; the only
storage used is `chrome.storage.local` on your machine. The extension requests
access to `claude.ai` and — for the outage check — `status.claude.com`, which is
a public, unauthenticated status page: the request carries nothing about you.

## Regenerating icons

```bash
python3 scripts/make_icons.py
```
