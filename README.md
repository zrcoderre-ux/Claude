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
  then a final pass. Editable, copyable, deletable, with one pre-built. Each run
  is timed and measured against your usage, and **Usage → Workflows** shows what
  share of your weekly usage they account for. See [Workflows](#workflows).

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
  repo) and its own **model**, which is the default every step in it inherits and
  can override. Reducing the count moves any orphaned steps to the last remaining
  chat rather than throwing their prompts away.
- **Starting in a conversation you already have** — paste its link into a chat
  and the run picks up there instead of opening a fresh one, which is how a
  workflow continues work you began by hand. It's matter-specific like the
  documents, so Start hands it to the run and clears it from the template; the
  next matter can't inherit the last one's chat. (A chat resumed this way keeps
  whatever model it's on — a chat's own model setting applies only to a
  conversation the run opens, since changing the model of one you didn't open
  would reach into work that was already there. A **step** that names a model
  still switches it: that's an instruction about this step, not an assumption
  about the chat.)
- **That chat as step 0** — tick it and the conversation stands in for the steps
  that would have produced it: its **latest reply becomes the opening hand-off**,
  and the run begins at the first step that isn't in that chat. Point chat A at a
  draft you wrote by hand and the pre-built workflow starts at step 2, carrying
  that draft into the devil's advocate chat, exactly as though it had drafted it
  itself. The reply is read **when the run goes**, not when you press Start, so a
  run scheduled for the small hours takes whatever is in that chat by then.
- **Documents** — dropped in once, with a tick per chat saying **who gets them**.
  They default to **every chat**: a chat that has the papers can ignore them,
  where a chat that needed them and didn't get them answers from nothing. Each
  chat also has an **All / Clear** toggle across every document, because doing
  five papers by three chats a box at a time is fifteen clicks and an easy one to
  miscount. A chat's documents upload with its **first** message, the one that
  opens the conversation; a document assigned to nobody isn't uploaded, and the
  editor says so. The count of what will actually go up, per chat, is shown on
  the **run's** row until it starts — that's where there's still something to be
  done about it. A workflow's row doesn't show it at all: a template's papers
  belong to whatever matter is next, and warning that one will upload nothing is
  warning about a run that doesn't exist yet.
- **Combine text documents into one labelled file** (optional) — twenty separate
  attachments is where claude.ai starts showing Claude fewer than were sent. One
  file, listing its contents at the top and marking where each document begins
  and ends, either arrives or doesn't. Only real text is folded in; PDFs and Word
  files still go up on their own. This is deliberately **not** a zip: claude.ai
  makes no promise to read inside an archive, and one attachment it silently
  ignores is worse than several it might.

  The combining happens **once, in the background worker, before the run opens a
  single tab** — not at upload time and not per step. Your documents are stored
  as you dropped them; when the run starts, the worker reads them, writes the
  combined files, and rewrites the run's own document list to point at them.
  Everything downstream then just uploads what it's told, which keeps a piece of
  ordinary string work out of the one place where failure is expensive — mid-run,
  between opening a conversation and uploading to it. A document that can't be
  read is a run that hasn't started yet.

  What goes *in* a combined file is decided per upload, because that's what the
  ticks mean: which chat it's for (the chats can get different papers) and when
  it arrived (papers added mid-run ride a later step, so they form their own
  batch). But chats that would receive **exactly the same file share one** —
  documents default to every chat, so identical sets are the ordinary case, and a
  six-chat workflow building six byte-identical files would be six times the work
  and the storage for nothing. One file ticked for six chats is what a document
  ticked for six chats already does. Chats whose papers genuinely differ still get
  their own. Before a run starts, its row says what it will come to: `uploads: A 3
  · B 3 · 5 text documents combine into 2 files`.

  It never becomes a precondition. A document that can't be decoded, or a
  combination that comes out empty, leaves that group alone and the papers go up
  as they are.
- **Steps** — ordered, each naming the chat it runs in and the prompt to send. A
  step can **carry the previous step's reply** under its prompt (this is the
  hand-off; it's the copy-and-paste the workflow exists to automate), with a
  label so the pasted material is announced — `----- BEGIN DEVIL'S ADVOCATE
  REPORT -----`. Two steps **in the same chat never carry**: that conversation
  already has the material, and pasting it back wastes the context it's holding.
  The editor says so rather than offering a tick that would do nothing.
- **Reordering** — drag a step by the **grip** on its card. The ↑↓ arrows stay
  for a one-notch nudge, but nine steps is enough that moving one from the end to
  the middle was six clicks, each re-rendering the list under the cursor.
  Nothing moves until you let go: the card you would land above is marked
  instead, so the list doesn't rearrange itself while you're still looking for
  the gap you want.

  A reorder also **gives back a hand-off that only position had suppressed**. A
  step is offered no carry tick at all while it's first, or while it sits
  directly after another step in the same chat — so a `false` there was never a
  decision, and dragging it somewhere neither reason applies restores the default
  rather than silently dropping the paste. A no you actually made travels with
  the step.
- **A model per step** — each step has its own model picker, defaulting to
  *whatever the chat is on*. Set one and the run switches that conversation to it
  before sending, and **leaves it there** for the steps after it, exactly as
  though you'd picked it from claude.ai's own menu. So one chat can draft on
  Opus, be criticised on Sonnet, and be revised back on Opus — the point being
  that you can try combinations without building a chat per model. A step already
  on the right model doesn't touch the picker at all. A workflow that switches
  models says so on its row (`Opus 4.1 → Sonnet 4.5`), and **Steps** names the
  model each step answers on, marking the ones that differ from their chat.
- **"Its output is a tentative ruling"** — a chat can insist that its reply
  contain a phrase (`NATURE OF PROCEEDINGS` by default, editable) before it may
  be handed to another chat. Claude's first answer is often a clarifying
  question, a note that a paper is missing, or an offer to continue; those are
  real replies, and none of them is the ruling the next chat is meant to attack.
  A reply without the phrase is left where it is and the step keeps waiting — so
  the answer that arrives after auto-continue clicks **Continue** is the one that
  travels. The check applies **only where something is pasted onward**: a step
  whose reply stays in its own chat can say anything at all.

### A workflow is a template

The same workflow runs many matters, so it isn't meant to keep any one of them.
The editor has two names for that reason:

- **Workflow name** — the template's own, and durable. It keeps this one.
- **Run name** — the matter in front of you, and only that. It does **not**
  default to the workflow's name: a run that borrowed it would sit in the runs
  list looking like a second copy of the workflows list, telling you nothing
  about which matter is which. An unnamed run shows *Untitled run* in grey,
  which is a prompt rather than a name.

Either way the run **keeps the workflow it came from**, shown as a badge beside
its own name and recorded on the run itself — so it survives the template being
renamed for the next matter, rewritten, or deleted outright.

**Create run**, next to Edit and Copy, is how a matter starts. Press it and a run
appears immediately at the top of the **Runs** section — with no trigger, so
nothing can pick it up — and opens for editing: the matter's name, its papers,
any tweak to the steps, and at the bottom **when it starts**.

- **Not yet** leaves it set up and waiting at the top of the list, marked *Not
  started*. This is the default, and choosing it on a run that was already queued
  un-schedules it without cancelling it.
- **Run now**, **When usage resets** or **At a set time** start it as you save.

Nothing about a matter ever occupies a workflow's row: a workflow has no trigger
and no Start of its own. And because the run owns its copy of the papers,
re-arming the template — or deleting it — can't disturb a run in flight; stored
files are only discarded once nothing, run or workflow, still points at them.

### Running one

**Run now**, **When usage resets**, or **At a set time** — the same three triggers
a scheduled send has, sharing the same alarms. They're set at the bottom of the
run's editor, and repeated on the **run's own row** (*Start* on one not yet armed,
*Change* on one already queued) so a matter can be moved to a different time,
switched to the next usage reset, or sent straight away without opening it. Once
a run has started its trigger is history, and **Pause** is the
tool instead. The run then walks its steps: open (or return to) the step's
chat, attach that chat's documents if it's the chat's first message, type the
composed prompt, send, **wait for Claude to finish** — up to **an hour** per
step, since one step can be a long ruling with several tool calls — take the
reply, and carry it into the next step. Progress, the conversation links, and any failure show up
under **Runs**, where a run can be **cancelled** or **resumed** from the step it
stopped on.

**How the reply is read.** The way you would do it: the **copy box** under the
finished answer (an icon-only button, `aria-label="Copy"`, in the action bar
beside Read aloud / Retry), which copies the answer *without* the thinking. The
extension clicks it and captures what the page writes to the clipboard, hooked in
`src/inject.js` — so it needs no clipboard permission, works in a background tab,
and gets Claude's own markdown. All three write paths are hooked
(`Clipboard.prototype.write` with a ClipboardItem, which is the one claude.ai
uses today; `writeText`; and the `copy` event), on the prototype rather than the
`navigator.clipboard` instance, because which one the app reaches for is not ours
to rely on.

**Unrenderable blocks are stripped, never carried.** Where claude.ai can't draw
part of a reply it renders *"This block is not supported on your current device
yet"*, and the copy box copies that notice verbatim. Every source is cleaned of
those blocks before it is judged or carried, so a reply that is part prose and
part unrenderable travels as its prose — handing the shells to the next chat as
the report to revise would produce confident work built on nothing.

The copy is rejected outright if it comes back **implausibly short**, which
usually means a code block's own Copy button answered instead of the message's.
It then falls back to the conversation payload from claude.ai's API, which takes
the prose **and any artifacts** (an artifact is a tool call whose payload is the
answer; a report written into one would otherwise be dropped). Thinking and tool
results stay out. The rendered message text is the last resort, and if every
source is nothing but placeholder, the step **fails** and says so. **The run does not
depend on the copy box working**: if the hook never fires, harvesting falls
through to the API and the workflow still completes.

**The conversation is the record, not the page.** In a long chat claude.ai
unmounts messages that scroll out of view, so a reply can finish with nothing
about it in the DOM at all — the step then waits out its hour watching an element
that never changes, while the answer sits in the conversation the whole time. So
once the response stream has closed (or the page has been unhelpful for ninety
seconds) the run **asks claude.ai's API directly**, comparing what the
conversation says is the latest reply against what it said before the message
went out. That comparison works whether or not the page is showing anything. The
transcript is also kept scrolled to the bottom, which is what a person watching
would do and keeps the DOM path working for longer.

**Knowing the turn is over.** The signal that counts is the assistant's response
stream closing, reported from the network layer (`inject.js` finishes reading the
`text/event-stream` body exactly when the turn ends). That can't be faked by a
pause mid-answer and doesn't care whether the tab is focused, rendered or
throttled. Only a stream from the **completion** endpoint counts, and only one
that closed *after* this step's message went out — so neither an unrelated SSE
nor a leftover signal from the previous turn can release the next step. When it
arrives it **outranks the page**: a Stop control the UI never takes down would
otherwise park a step until it times out.

Failing everything else, a reply that hasn't changed **in fifteen minutes** is
treated as finished whatever the page claims, and the run says that's what it
did — a step that waits out the whole hour to report nothing is worse than one
that moves on and tells you how it decided. That backstop is **suppressed while a
response stream is open**, because then the turn demonstrably hasn't finished:
text standing still means a tool call or a long search, and a skill that verifies
authority by live retrieval can sit silent for many minutes without being stalled
at all.

Failing that, it falls back to the reply text holding still — and that reading is
weak in a background tab, where Chrome throttles timers to about once a minute
and may not run layout at all. So the fallback needs the text unchanged across
several **consecutive** looks, not just a long-looking gap, and **clicking into
the tab resets the window**: everything measured while the tab was hidden was
measured across minute-wide gaps, and cashing that in the moment the poll loop
speeds back up is exactly how a run steps on a half-written answer. The text
itself is read with `textContent` rather than `innerText`, because `innerText`
is computed from layout, and an unrendered tab makes a still-growing reply look
frozen.

A reply also has to differ from what was on screen before the step's message went
out — the transcript can hold just the newest turn in the DOM, so counting
rendered messages is not on its own enough to know a new answer arrived.

### Watching one from inside the chat

A conversation a run is driving carries a small pill saying which run, which step
of how many, which chat, whether it's waiting on Claude, and how long the current
step has been going — updating as the run moves.

It **docks onto the usage meter**, in the same stack as the outage warning and
the context alarm, so it rides along wherever you've dragged the meter and the
corner holds one thing rather than two. (The meter builds on its own schedule; a
run pill that arrives first stands at the bottom left and moves in as soon as the
meter appears.) The meter's panel now opens **clear of that stack** instead of
under it, so opening it doesn't bury the Pause you were reaching for.

Beside it is **Pause**. That's the point of it: when something goes wrong you
notice it *here*, in the chat — a prompt in the wrong place, an answer going
sideways, papers that didn't attach — and stopping it shouldn't mean hunting for
the tab that can. Pausing takes effect at the next step boundary and keeps the
run's place, so **Resume** (from the same pill, or the Options page) carries on
rather than starting over. Clicking the pill's text opens Options, where the rest
of the run's controls are.

### Changing a run while it's going

A run carries **its own copy** of the chats, steps and documents it was started
with. The template can be re-armed for the next matter, edited, or deleted
without changing what a run in flight does — and the run itself can be changed
without touching every future run.

A run **pauses itself** if claude.ai reports that *"Claude's response was
interrupted"*. Whatever cut the reply off, what's on screen is a fragment, and
carrying it onward would have the rest of the run build on half a ruling —
convincingly. The run keeps its place and its phase, so once you've looked at the
chat (and asked Claude to continue there, if that's what it needs), **Resume**
waits for a fresh reply rather than sending the message again.

**Pause** stops it at the next step boundary, keeping its place, what it's
carrying, and which conversations it's in. A step already in flight is allowed to
finish; pausing is not cancelling. **Edit run** then opens the same editor the
workflow uses, on the run's own copy: insert a step, reword a prompt, rename a
chat, add documents. **Resume** picks up from exactly where it stopped.

Documents added to a run already under way can't ride a chat's opening message —
that having been sent — so they go up with the **next step in each of their
chats**. Add a reply brief for both chats at step 4 of nine and it attaches to
whichever step comes next in each, not at the start and not at the end.

**Save as workflow** turns a run back into a template. A run that was edited
mid-flight — or whose workflow has since been re-armed, rewritten or deleted — is
the only record of how that work was actually done, so this is how a good
improvised run becomes the way you do it next time. It takes the chats and steps,
with fresh ids so the new template stands alone, and no documents: those papers
belonged to that matter.

**Steps** just reads them out. Every step of the run as it actually stands —
number, chat, what it carries in, how many documents ride with it, whether it has
to see a marker before handing on, and the prompt in full — with the ones already
done marked as such and the next one up marked `next`. It opens nothing and
changes nothing, so a paused or stopped run can be looked over before deciding
whether it needs fixing at all; the editor is for when it does. Pressing **Fix &
continue** closes it — reading the prompts is what you do *before* deciding to
fix, and once you have, they're a wall of text between you and the panel.

### How long steps take

Every finished step records its own time, split into the two things that can be
slow: **sending** (composing the message, getting its documents up) and
**waiting** (Claude answering, which is where the hours go). The chips under a
run show each step's total, hover gives the split, **Steps** spells it out per
step, and the run's row carries the whole: total working time, the **typical**
step, and the longest with its number. Median rather than mean, because one step
that stalled for an hour shouldn't get to describe the other eight. The in-chat
pill counts the current step up as it goes.

The clock **stops when the run does**. A step paused overnight, or held through
an outage, or stopped on an error and fixed the next morning, spent that time
stopped — not working — and the figure says so, with the excluded time shown
separately where it's more than a moment. A step the run never sent itself (one
you told it had already gone out) has no honest moment to measure from, so it
reports what it can — the wait — and nothing where it would be guessing. Re-doing
a step times the attempt that produced the reply, not every attempt stacked up.

### What a run costs

Each step is also measured against the **usage meter**: the reading before it
goes out, and again when its reply lands. The difference is in **percentage
points of the weekly limit** — the same units as Daily Usage, so it divides
cleanly into the totals there.

- Each step's cost shows in **Steps**, beside its time.
- Each **run** carries its total on its row: `4.6% of weekly used`. If some steps
  couldn't be measured it says how many were, because a total quietly missing
  three steps would read as a cheap matter.
- Each **workflow** carries the **average across its runs**: `~5.1% of weekly per
  run (over 4 runs, last 4.8%)` — what to expect before you start another one.
  Only runs measured end to end are averaged in. It's measured rather than
  authored, so editing a workflow keeps it.
- **Usage → Workflows** puts the two ledgers together: what share of your weekly
  usage over the last 7 days went through runs rather than chats you drove
  yourself, plus an all-time breakdown by workflow.

**A step is only measured when it had Claude to itself.** claude.ai publishes no
per-conversation cost, so the only instrument available is a browser-wide meter —
which means a step that ran while you were working in another chat would be
credited with your work as well as its own. So every claude.ai tab records the
**span of each assistant turn** it sees, by conversation, and a step that
overlapped a turn in any other conversation is **left out entirely**: not
estimated, not apportioned, not recorded as zero. Yours, a scheduled send,
another run — all the same. Steps under a run's own idle chats are its own and
don't count against it.

The other refusal: a step whose usage window **reset part-way through** can't be
differenced at all (the meter went back to zero and what it had counted is gone),
so it's left out too. The weekly window is the one reported for exactly that
reason — it rolls over once a week, where the 5-hour session window can roll over
twice inside a single run.

Both refusals push the same way, which is the direction that can't mislead you:
every figure here is a **floor**. Runs cost at least this much, workflows account
for at least this share. Where a run has steps it couldn't measure, its row says
how many — and a run with any such step stays out of its workflow's average
rather than dragging it down for a reason nothing on the row explains.

### Fixing a partial run

A ten-step run that stops at step six shouldn't have to start again. **Fix &
continue** on the run's row opens a small panel:

- **Continue from** — any step, not only the one it stopped on. Go back a step to
  redo one that went badly, or forward to skip one you've handled by hand.
- **Re-read the previous chat's latest reply** — the conversation the step before
  ran in is still open, and its last answer *is* the hand-off. Ticking this reads
  it fresh (through the same copy box) and carries it into the step being
  resumed, so nothing has to be copied across by hand. That's true even though
  producing that reply was the tail end of the earlier step: what matters is
  what's in the chat now, not what the run last managed to capture.
- **This step's message already went out** — for a step that sent but never got
  its reply back, or for a message you pasted into the chat yourself. Resuming
  then *waits* rather than posting the same message a second time. It's ticked
  automatically when the run stopped that way, because stopping deliberately
  remembers it.

  Waiting here means waiting. Claude counts as **still working** if a Stop
  control is on screen or a response stream is open — neither of which depends on
  guessing at markup — or, failing those, if the chat's last turn is still the
  **human's**. In any of those cases the step sits until a genuinely new reply
  arrives, however long that takes. Only when an answer is already sitting under
  that message does it read what's there. Getting this wrong the other way would
  hand the *previous* question's answer to the next chat and call the step a
  success.
- **Conversations this run is using** — each chat's link, editable, for when a
  run lost track of one (a first step that never settled to a `/chat/` URL, say).

Those first two boxes are **alternatives**, and behave like radio buttons: a
message that has already gone out carries whatever it carries, so re-reading the
other chat would only compose text nobody is going to send. Ticking either one
clears the other. Where the run stopped waiting on a reply, that's the box that
opens ticked — it's an observation about the chat rather than a preference about
it.

Plain **Resume** does the same thing with the defaults, which is usually what you
want. Neither is confused by other open chats: a run addresses a conversation by
its URL, so unrelated claude.ai tabs — including other workflows' — are invisible
to it.

**When things go wrong.** A run is driven through the real UI, so it needs your
browser open and logged in. If Claude is down it **waits mid-workflow** and picks
up where it left off (same gate, same 6-hour ceiling as a scheduled send). If the
service worker dies mid-step — which MV3 does routinely — the page keeps going
and writes the result to storage, and the worker takes the run back within 30
seconds. A step whose message has already gone out is **re-attached to, never
re-sent**, so nothing is ever posted twice. A run that can't finish fails loudly
(a notification, and the error on the row) rather than going quiet.

### A run gets its own window

Each run opens **its own Chrome window**, **maximized** but **unfocused**,
containing only that run's chats. The size is not cosmetic: claude.ai is
responsive, and below its breakpoint it serves a compact client that can't render
every block type, substituting *"This block is not supported on your current
device"* where the content should be. The copy box then copies that notice, and
the shell travels to the next chat as the material to work from. Filling the
screen puts the layout as far from that breakpoint as the display allows, and a
run window left smaller is maximized again before a step uses it. Maximizing
doesn't focus a window, so this stays out of your way. Nothing is ever activated or brought forward, so a nine-step
workflow can grind away for an hour while you work in your own windows — the run
never takes the screen, and its tabs never pile into whatever you're using.

The window also gets **Options, pinned at its left edge**, opened on the
Workflows section — the run's controls in the window where you watch it happen,
rather than a tab away in whatever window you were in when you started it. Steps,
Pause, Edit run and Fix & continue are all there. It opens unfocused like
everything else, so the chat stays in front; close it and it stays closed, since
a window a run reopens later only puts its **chats** back.

### Running several at once

Two runs going together stay out of each other's way, deliberately and at every
level:

- **Windows and tabs.** Each run has its own window, and a step looks for its
  conversation **only inside that window**. A chat you happen to have open
  elsewhere is yours; driving a message into a tab you're reading would be a
  nasty surprise.
- **Conversations.** A run addresses chats by URL, so even the same conversation
  open twice can't confuse it.
- **Signals.** The response-stream and clipboard hooks are page-scoped — a turn
  finishing in one run's tab can't release a step in another's.
- **Storage.** Each run is written under **its own key**, with its heartbeat
  under another. They were once a single shared array that every writer — the
  worker, each run's page, the options page — rewrote whole; with two runs going
  that's hundreds of chances for one to post a copy read a moment earlier and
  undo the other's progress. Separate keys can't collide, and a heartbeat can
  never carry a stale run back over a pause.

Runs started together are driven **concurrently**, not one after another, since
a run is hours long and the second matter shouldn't wait for the first. What
they do share is your Claude usage: two nine-step workflows are eighteen turns
against the same limit, and if it runs out mid-run the outage gate parks them
both until it resets.

If you close a run's window mid-run, the next step opens a fresh one rather than
scattering tabs into the window in front of you. When a run finishes its window
stays — the conversations are the point — and **Close window** on the run's row
disposes of it when you've read them.

**Open chats** brings a run's conversations back: it raises that run's window if
it still has one (adding back any tab you closed), and reopens all of them in a
new window if you'd closed the lot. A run that adopts a new window this way keeps
using it for later steps. This is the only place a run's window is given focus —
everywhere else it stays behind what you're doing.

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
