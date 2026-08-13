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
  - **Context window** — **on Claude Code only**, where claude.ai computes the
    figure itself and the meter reads the real one out of its usage panel
    (`70% · 696.1k / 1.0M`, marked `actual`). A Home chat gets no context row
    and no context alarm: see [Context is a Code
    figure](#context-is-a-code-figure).
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
- **Auto-download files Claude produces** (opt-in, separate toggle) — when a
  reply hands you a file, its **Download** button is clicked for you once the
  answer has finished, so a produced document lands in your Downloads folder
  without you going back for it. **New files only** — it saves out of replies it
  watched arrive, never out of a chat's backlog. See
  [Auto-downloading what Claude produces](#auto-downloading-what-claude-produces).
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
- **Incognito recovery** — claude.ai doesn't save an incognito chat, so closing
  the tab takes the work with it. While one is open the extension keeps a running
  copy, kept for **three days** and then deleted. See
  [Incognito recovery](#incognito-recovery).
- **Save chat** — a button in claude.ai's own header, in with the file and share
  controls, that saves the whole conversation as a **Markdown file** you can hand
  to the next chat. See [Saving a chat](#saving-a-chat).
- **Copy ruling** — a second copy button in claude.ai's own action bar, beside
  the one that copies the whole reply. It copies **only the tentative ruling**:
  NATURE OF PROCEEDINGS through the end of the CONCLUSION, without the note
  Claude wrote above it, the offer to revise underneath, or the horizontal rules
  between. See [Copying just the ruling](#copying-just-the-ruling).
- **Table of contents** — a floating list of **your own messages** in the
  conversation you're reading, so a long chat is navigable instead of a scroll
  bar. Each entry carries the time it was sent and, where a workflow sent it,
  **which step it was**. Opens from a `☰` button beside Save; starts minimized,
  draggable, and it remembers where you put it. See
  [Table of contents](#table-of-contents).
- **A workflow's own contents** — in a conversation a run owns, a second `⇄`
  button beside the contents one indexes **the run**: every step, in every chat,
  in order. Click one and you land on it, whichever conversation it happened in.
  Works after the run has finished, which is when you mostly want it. See
  [The workflow's own contents](#the-workflows-own-contents).
- **The time under every turn** — claude.ai shows one relative time per
  conversation and keeps the real one behind a hover. Every turn, yours and
  Claude's, gets a line under it: the clock time it was sent, and how long after
  the turn before it landed. See [Timestamps](#timestamps).
- **Workflows** — run one piece of work through **several chats that hand it
  back and forth**: A drafts, B attacks the draft, A revises, round and round,
  then a final pass. Editable, copyable, deletable, with one pre-built. Each run
  is timed and measured against your usage, and **Usage → Workflows** shows what
  share of your weekly usage they account for. See [Workflows](#workflows).

## Auto-downloading what Claude produces

A workflow step can already be told to save whatever its reply offers. This is
the same thing for the chats you drive yourself: turn it on in the popup and a
file Claude produces is saved as soon as the answer it came with is finished.

**Off by default, with its own switch**, like every other clicker here — it
writes to your disk, and that isn't a decision an extension gets to make on your
behalf.

**It is real-time only, and that is a rule rather than a hope.** A file is saved
out of a reply this page *watched being written*, and out of nothing else. Open
a chat with forty files in it and none of them is saved — not because they look
old, but because no answer arrived while anyone was watching. Turn the toggle on
mid-conversation and the answer already on screen isn't saved either; the next
one is. (A reply still being *written* when you flick the switch counts as the
next one — it lands in front of the watcher, which is the whole test.)

The signal is the one a workflow step trusts: `src/inject.js` reports when the
assistant's `text/event-stream` opens and when its body finishes reading, which
is the turn genuinely ending and doesn't care whether the tab is in front. The
page's own **Stop** control is the fallback where that hook never fires. And a
turn ending is not on its own enough — the answer has to actually be *on the
page*, differing from the one that was newest when the turn began, because the
end-of-turn signal can beat claude.ai's rendering of the answer, and acting on
it then would mark the **previous** reply as the live one. That reply is old,
and its files are precisely the backlog this must never touch.

What it will and won't do besides:

- **Only files a reply offers directly** — the download control on a file card
  inside the message. An **artifact** you would download from its own side
  panel is not one of these: that control lives outside the message, behind a
  menu, and reaching into it is a different feature with different ways to go
  wrong.
- **Only once the turn has finished.** A file card can appear while Claude is
  still writing, and a save dialog landing mid-answer is exactly the
  interruption this exists to spare you.
- **A census as well.** Whatever is on the page when the watcher starts — when
  you open a conversation, or turn the toggle on while reading one — is recorded
  as already handled without being clicked. That is belt to the braces above:
  the two rules fail in different directions, and a backlog saved by accident is
  the failure worth paying twice to avoid.
- **Buttons, and links that carry a `download` attribute.** A plain link
  captioned *"Download …"* navigates, and being taken away from the conversation
  you're reading is a worse accident than a file that didn't save.
- **The card is found by its filename**, not by its button. See
  [finding the button](#finding-the-button) — this is what made the first
  version of the feature do nothing at all.
- **Ceilings in both directions** — at most **6 files from any one reply**, and
  **20 per page load** (adjustable in the popup), so a pathological message
  can't fill a folder. They're paced rather than fired in a burst, since each
  one may raise a Save-as dialog.

### Finding the button

The first version looked for a control captioned `Download`, and on the real
page it found nothing — so the feature sat there doing nothing, silently, which
is the worst way for it to fail. Two reasons, and both are now the other way
round.

**A card's control is often unlabelled and often not there yet.** claude.ai
draws what Claude produced as a small card with the filename on it and an icon
to save it; the icon may carry no caption at all, and it may not exist in the
page until the pointer is over the card. So the card is found by the **filename**
— the part that doesn't change when the markup does — and the button is looked
for inside it: an `a[download]` or a blob link first, then a `data-testid`
naming a download, then a caption that says download or save, and failing all of
those, the only control on a card that plainly holds a file. A card with nothing
on it is **hovered** first, since a button drawn only under the pointer can't be
found by looking.

**And "visible" was the wrong test.** A control revealed on hover sits at zero
opacity until then, so insisting on seeing it meant waiting forever for a button
that was right there and clicks perfectly well. Being disabled still counts;
being invisible no longer does.

Widened, too: the search covers the **turn's own wrapper**, not just the prose
element, climbing while the ancestor holds this reply and no other — an
attachment is often drawn beside the answer rather than inside it.

Eight card shapes are driven through a whole turn in Chromium, from the page's
events rather than the extension's internals: a labelled button, an unlabelled
icon, a button added to the page on hover, a button at zero opacity until hover,
a blob link, a `data-testid` with no caption, a card outside the message
element, and a reply with no file in it, which must produce no click at all.

### When it says it isn't working

"It isn't working" is three faults with one symptom: the turn wasn't seen to
land, no file was found in it, or one was found and held back. The popup now
says which, under the toggle — `1 offered · saving · 1 reply watched`, or
`0 offered · nothing new · 0 replies watched · census open`. It's written only
when the reading changes, so an idle tab writes nothing.

It watches only the newest reply or two, which is what makes scrolling cheap as
well as safe: claude.ai unmounts messages that scroll out of view and mounts
them again when you scroll back, so a watcher reading the whole transcript would
be re-examining a chat's entire history every time you scrolled up.

One thing it deliberately does **not** do is reset itself when a new chat
acquires its URL. claude.ai renames a conversation from `/new` to
`/chat/{uuid}` part-way through its first answer, and a watcher that took a
fresh census at that moment would file that answer's file under history — which
is both the commonest way to ask Claude for a file and the one case where
getting it wrong is most obvious.

The decisions live in `src/autodl.js` (no DOM/`chrome` deps) and are unit-tested
in `test/autodl.test.js`; the DOM around them is `src/autodownload.js`.

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
- **Documents** — **on the run, not on the workflow.** Papers are a matter's, and
  a template that held them would hand the last matter's exhibits to the next
  one; so the workflow editor has no documents field at all, and a run's does.
  Dropped in, or **pasted**: text pasted anywhere in the run's editor
  that isn't a box you were typing in becomes a `.txt` document, the way
  claude.ai turns a large paste into an attachment. It's named from its own first
  line — `Opposition to Motion to Compel.txt` tells you what it is in the list
  where `Pasted text 3` only tells you when you pasted it — with heading marks
  and characters a filename can't hold stripped off, and a number where there's
  no usable title or the name is already taken. There's no length threshold to
  guess at: unlike a chat composer, there's nowhere else here for pasted text to
  go, so pasting it onto the documents field is itself the instruction. Files on
  the clipboard are added as files, not wrapped in one.

  Documents come with a tick per chat saying **who gets them**.
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
- **Combine text documents into one labelled file** (on by default) — twenty
  separate attachments is where claude.ai starts showing Claude fewer than were
  sent, and a batch that arrives incomplete is a worse default than one file. One
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
- **Name each conversation after the run** — a run leaves several chats behind,
  and untitled they are three sidebar rows saying the same thing. Ticked (the
  default), each conversation the run **opens** is titled
  `8.11.26 Motion to Compel Arbitration: Drafting (A)` — the matter, then that
  chat's job within it, then `(Run 2)` on a re-run's. Only conversations the run opens itself: a chat you
  pointed it at keeps the name it has, because retitling work you started is not
  the extension's business. A title that won't take is a note on the run, never a
  failed step. It is applied **twice** — once the conversation exists, so it has a
  name even if that step then fails, and again once the reply is in, because
  claude.ai titles a new conversation itself a moment after the first answer
  lands and would otherwise write over it.

- **Files a reply produces** are no longer a workflow's business. A run used to
  have its own switch for clicking whatever a reply offered for download; that is
  now [Auto-download files Claude
  produces](#auto-downloading-what-claude-produces), which does the same thing
  for every chat rather than only for a run's, and does it better — it finds the
  card by its filename rather than by a caption. Two switches for one job meant
  a run saving files while an ordinary chat didn't, for no reason either could
  explain. A file in a reply still doesn't disturb a run: the copy box is matched
  against an exact list of labels, so `Download` can never be taken for it, and a
  file card's own controls sit inside the message where the copy-box search never
  looks.

- **Completing a prompt you've written before** — the same prompts recur, and
  retyping one is a chance to get it subtly different from the version that
  works. Type the start of a prompt used in this workflow or any other and it's
  offered back in a bar under the box: **Enter** takes it, **Escape** dismisses
  it, **↑↓** pick among candidates when there's more than one. Enter is an
  ordinary newline the rest of the time — it only completes while something is
  actually being offered.

  It matches on the **prefix** and nothing cleverer. A fuzzy match that offers a
  prompt you didn't mean is worse than no offer at all, because accepting is one
  keystroke and the wrong prompt looks like the right one until the run has spent
  a turn on it. It also only offers while you're typing at the end of the box, so
  a caret parked in the middle can't have the rest rewritten under it. Where a
  prompt has been written in several places, the most-used comes first.

- **Steps that run at the same time** — press `⇉` on a step and you get another
  one *beside* it rather than after it: `2A`, `2B`, `2C`. They are all handed the
  same thing (step 1's reply), each works in its own chat, none of them sees the
  others, and step 3 is handed **all three replies at once**. Three
  devil's-advocate reports written in parallel and then read against each other,
  in the time one of them used to take. See
  [Steps that run at the same time](#steps-that-run-at-the-same-time).

- **Adding a step where you want it** — every step's card carries a `＋` beside
  its `✕`, which puts a new step directly below that one and drops the cursor in
  its empty prompt. `+ Add step` at the bottom still adds to the end. Building a
  workflow is mostly noticing a step is missing *between* two you already have,
  and adding it at the bottom and dragging it up five places is the same act with
  more steps in it. A step inserted mid-list takes the chat the alternation calls
  for — the one after the step it follows — exactly as one added at the end does.

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
- **"Its output is a tentative ruling"** — a **step** can insist that its reply
  contain a phrase (`NATURE OF PROCEEDINGS` by default, editable) before it may
  be handed to another chat. Claude's first answer is often a clarifying
  question, a note that a paper is missing, or an offer to continue; those are
  real replies, and none of them is the ruling the next chat is meant to attack.
  A reply without the phrase is left where it is and the step keeps waiting — so
  the answer that arrives after auto-continue clicks **Continue** is the one that
  travels. The check applies **only where something is pasted onward**: a step
  whose reply stays in its own chat can say anything at all.

  It sits on the step rather than on the chat because a chat does more than one
  thing. The drafting conversation writes the ruling, then revises it, then takes
  a style pass over it — and "must this reply be a ruling" has a different answer
  for each. Asked of the chat, one answer had to cover them all.

### Steps that run at the same time

Some work fans out. Three devil's-advocate passes over one draft don't need to
know about each other — they need to be *independent*, so that where they agree
is worth something and where they differ is worth more. Run one after another,
that's three long turns end to end; run together, it's one.

Press `⇉` on a step to add another **beside** it. The pair becomes a **wave**,
numbered `2A`, `2B`, `2C`, drawn joined down the side in the editor:

- every member is handed **the same thing** — the reply from the step before the
  wave, exactly as a lone step 2 would have been;
- each works in **its own chat**, and none of them ever sees the others. The
  editor gives a new member a free chat automatically, adding one if it has to,
  and a workflow whose parallel steps share a conversation won't save: they would
  post into it together and each would read the other's answer as its own;
- **the step after the wave gets all of their replies**, folded into one hand-off
  with each labelled by the chat it came from — which is what makes "see if they
  differ" a thing you can ask for in the next prompt;
- **step 3 waits for every one of them.** A wave lands as a unit or not at all.

`⇉ at once` on a card says what a step runs beside; clicking it takes that step
back out of the wave. `＋` on a wave member adds a step *after the whole wave*,
not into the middle of it — a step dropped between two members would split them,
and adjacency is half of what defines a wave (dragging one out is the other half,
and does exactly that on purpose).

**How it runs.** The worker opens each member's chat, sends all of them, and
waits for all of them. Each page reports to a key of its own and never writes the
run: three tabs doing read-modify-write on one record would lose whichever write
landed second, and what would be lost is a reply that cost a full Claude turn.
The worker collects them and writes once, past the whole wave. A member that has
already answered is **not asked again** when a wave is resumed — its reply is
kept and only the missing ones are re-sent.

**What it costs.** Each member is timed separately, and the wave takes as long as
its *slowest* — adding them up would report the saving as a cost. Usage can't be
split: three chats answering at once move one meter, so the figure is recorded
against the wave rather than divided between its members, and the others say why
they're blank.

**One honest caveat.** Chrome throttles timers in tabs that aren't in front, so
the members you aren't looking at may notice their replies a minute or so late.
Nothing is lost and the run doesn't stall — but three at once is not quite three
times faster in the way the arithmetic suggests.

**Every switch the workflow carries is the run's too**, and carried the same
way: only an explicit *off* is off. A setting that failed to travel would be a
run quietly doing something other than what the template you set up says, so
`newRun` is checked against the list rather than trusted to remember.

Workflows saved before any of this are **carried forward once**, in storage: the
two switches that changed default are turned on, the one that went away is
dropped, and the ruling marker is moved from each chat onto that chat's steps.
A stored record holds what it was given rather than what it meant — a
`bundleText: false` from last month is the old default written down, not a
decision — so it is done once and then left alone. After that a *false* is a
decision.

### A workflow is a template

The same workflow runs many matters, so it isn't meant to keep any one of them.
There are two names for that reason, and **each editor shows only its own**:

- **Workflow name** — the template's own, and durable. It keeps this one. Editing
  a workflow is where it can be changed; a run's editor doesn't offer it, because
  renaming the workflow from inside one of its matters would rename it for every
  other matter too.
- **Run name** — the matter in front of you, and only that. Editing a run is
  where it can be changed; a template's editor doesn't offer it, because a
  template holding a matter's name is a template that hands it to the next
  matter. It does **not** default to the workflow's name either: a run that
  borrowed it would sit in the runs list looking like a second copy of the
  workflows list, telling you nothing about which matter is which. An unnamed run
  shows *Untitled run* in grey, which is a prompt rather than a name.

The same split runs through the rest of the editor. **What it does** — the one
line describing the workflow — is the template's, so a run's editor doesn't show
it: a run is one use of a workflow, not a place to redescribe it. **Documents**
are the matter's, so only a run's editor has them. What the two share are the
switches, which the template sets and every run inherits.

And a run that already has its papers **stops asking for them**: the row reads
*3 documents ready — start it when you are* rather than *add this matter's
papers, then start it*, which read as though they hadn't arrived.

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

**Pause stops it now, in every chat**, keeping its place, what it's carrying,
and which conversations it's in. It is a decision about the **run**, not about
the tab you pressed it in — a wave is three conversations working at once, and
leaving the other two to finish is two long answers paid for and thrown away.

What "now" means depends on where each chat had got to:

- **The message hasn't gone yet** — it doesn't go. Every slow phase of a send
  asks first, so a pause pressed while twenty exhibits are uploading stops it
  there rather than being noticed a minute later, after it has gone.
- **The message has gone and Claude is writing** — the answer is **stopped**.
  The page's own Stop control, and Escape after it, which claude.ai treats the
  same way and which covers a Stop we failed to find. The rest of that answer is
  being paid for, and a run paused because the prompt was wrong is exactly when
  it is worth nothing.

Every tab a run is driving watches the run's own record and acts the moment it
changes, rather than at its next poll — which for a step mid-upload is no moment
at all. The worker also presses Stop across the run's whole window, which covers
a tab whose step has already handed back but whose reply is still being written.
**Cancel** does the same, and more so.

The run's row then says how far each chat got, because that is the difference
between the two things **Resume** can do: stopped before the message went out,
there is nothing in the chat and the step sends afresh; stopped after, the
message is in the chat and the answer under it is a **fragment** — so the chat is
worth reading first.

**Edit run** opens the same editor the workflow uses, on the run's own copy:
insert a step, reword a prompt, rename a chat, add documents. **Resume** picks up
from exactly where it stopped.

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

The run's row also says **when it ran**: `Started Aug 8, 9:14 AM · finished 4:02
PM · 6h 48m end to end`, with the date repeated on the finish only when the run
crossed a day — which is exactly when you want to be told. A run still going
reads `2h 10m so far`. That figure is the wall clock and the one beside it is
working time; they disagree by however long the run spent paused, held or
waiting on you, and hovering says how much that was. Both are worth having,
because "it took seven hours" and "it did forty minutes of work" are answers to
different questions.

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

### Running one again

**Offer to run a finished run again**, on the workflow, is on unless you turn it
off: a run you never re-run costs a button you don't press, where a run you do
want again and can't costs the whole thing.

The workflow also holds **the answers**, because for most workflows
they're the same every time. Each run keeps its own copy of those answers as well
as of the switch, so one matter can differ without touching the template — and
**Re-run still asks**, so you can change your mind for a single run. A run made
before the workflow had any answers, or from a workflow that has none, falls back
to the same defaults rather than losing the button.

**Start re-run** on a finished row asks three things and then **goes** — it opens
its own window and begins as you press it. A re-run is the same matter again;
there is nothing left to set up, which is the point of it being one press rather
than Create run and a trip through the editor.

**Which step to start at** — **step 1 unless the workflow says otherwise**, with
that step's prompt shown as you pick. A workflow that opens by producing the
thing the rest of it works on has nothing to produce the second time, and says so
on the template so that every one of its runs inherits the answer; a workflow
that has said nothing means the whole thing, again, from the top.

**Whether to use fresh conversations.** The two answers differ in what the chats
already hold:

- **Carry on in this run's chats** (the default). They still have the papers and
  the work, so nothing is re-uploaded and nothing has to be carried in. Cheapest,
  and the right answer when you want the second pass to build on the first.
- **Fresh conversations.** A clean context, which is the point — but it means the
  papers must ride the first step that actually runs rather than one this re-run
  skips. It also offers to **paste the first run's final reply into that step**,
  since otherwise the new chat begins knowing nothing of what came before —
  offered only where the step you chose takes a hand-off at all; where it
  doesn't, the panel says so rather than showing a tick that would do nothing.

**Whether the new conversations get the documents**, which only arises when
they're fresh. On by default, because that's what "the same run, again" means: it
re-stamps each document so it rides the first step that actually *runs* in its
chat, rather than one this re-run skips, where it would never arrive at all. Turn
it off for a re-run that only needs the hand-off, where sending twenty exhibits up
again would waste the turn. The documents stay on the run either way — the record
of what the matter had doesn't change, they simply don't go up.

What you get is a **run already going**, at the top of the list, named
`8.11.26 MSJ (Run 2)` — counted the way you'd say it out loud, the original being
Run 1. A third pass is `(Run 3)`, not `(Run 2) (Run 2)`: the old suffix is
stripped before the new one is added. **Pause** is there if you want it back —
it stops every chat at once and stops the answer being written.

Its **conversations** are named the same way, with the number **at the end**:
`8.11.26 MSJ: Drafting (A)` for the first run and
`8.11.26 MSJ: Drafting (A) (Run 2)` for the next, so a re-run's chats read beside
the ones they repeat instead of the number splitting the matter from the chat it
names. Where the whole thing is too long, the matter is shortened and both the
chat's name and the run number survive — they're what tell one conversation from
another.

### Fixing a partial run

A ten-step run that stops at step six shouldn't have to start again. **Fix &
continue** on the run's row opens a small panel:

- **Continue from** — any step, not only the one it stopped on. Go back a step to
  redo one that went badly, or forward to skip one you've handled by hand. The
  step you pick is **spelled out underneath** — its prompt in full, plus which
  chat and model, what it carries in, its documents, and any marker it has to see
  — and changes as you change the pick. `Step 4 — Drafting` is not enough to
  choose by when the thing you're actually choosing is which prompt goes out
  next.
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

**Running out of usage pauses the run.** Before each step, and every twenty
seconds while one waits, the run reads the meter it already keeps. At 100% of
either window — the 5-hour session or the 7-day week, since a weekly limit blocks
a fresh session just as firmly — it **pauses**, keeping its place, and says when
usage comes back.

It reads the **meter**, never the page. A reply that discusses running out of
usage must not be able to pause a healthy run, and the message text is the one
place that sentence is likely to turn up.

**And it picks itself back up when usage returns.** Nothing about a usage pause
needs deciding — the run stopped because the window was empty, and the window
refills on a schedule — so the pause carries the time it expects to be able to
go again and lifts itself then. The row says so while it waits: *carrying on by
itself when it returns at 3:14 PM*.

The **meter** decides that too, never the clock. The reset time a run recorded
when it stopped is only what the alarm is set by; a window can reopen early,
late, or at a time the meter had wrong, so a wake-up that arrives while usage is
still gone does nothing and leaves the run where it is. Every meter reading is
another chance, which is sooner and more reliable than any alarm.

Two consequences of that worth stating, because both are ways this could sit
there doing nothing:

- **A reading that has outlived its own window doesn't count as "you are out".**
  Usage is read by claude.ai's own pages, so a browser with no claude.ai tab open
  refreshes nothing. A run that ran out overnight would otherwise wait forever on
  a number that cannot change. A reading whose own reset time has passed, or one
  older than the window it measures, is treated as saying nothing rather than as
  saying no.
- **The gate and the resume ask the same question.** If the run's own check
  paused on a reading the resume then treated as expired, the two would take
  turns forever and never open a tab to find out. One predicate answers both.

**Stay paused**, on the run's row, is how you tell it not to. The run stays
exactly where it is and waits for you instead of for the meter — which is the
answer when a nine-step afternoon's work resuming itself at 3am is not what you
want. Pausing a run by hand means the same thing: a pause you asked for is never
lifted by anything but you.

Where the message had already gone out, the pause keeps the phase — so resuming,
by itself or by hand, waits for that answer rather than sending the same message
into a second turn. A turn already generating is left to finish; it's paid for.
What will never arrive is the reply that hasn't started.

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
screen puts the layout as far from that breakpoint as the display allows.

It is sized **once, when the run opens it**, maximized at creation where Chrome
will take that. Afterwards it is left alone unless it is genuinely too narrow for
the full client, because *sizing a window is a request to the window manager, and
window managers raise the windows they are asked to resize*. That is not what the
API documentation implies and it is what actually happens — a size check that ran
before every step put the run's window in front of whatever you were doing, over
and over, for the length of a run. The check now costs nothing on a window that
is already wide enough, and every call that can still raise one is bracketed:
note which window had the screen, and put it back if it moved. (Only when Chrome
had it. If you were in another application, "restoring" focus to a Chrome window
would be the very theft that guard exists to prevent.)

Nothing is ever activated or brought forward, so a nine-step workflow can grind
away for an hour while you work in your own windows — the run never takes the
screen, and its tabs never pile into whatever you're using.

**A run's tabs borrow the worker's clock.** Chrome throttles timers in a page
that isn't on screen: after a few minutes hidden, `setTimeout` is held to about
one wake-up a minute. A run's tabs are hidden by design, so every wait in the
send path — each of them a fraction of a second — was becoming a minute, and a
step looked like it was waiting for you to come and watch it. (It was masked for
a while by the window being re-maximized before each step, which raised it, which
un-hid the tab — the focus theft above.) So a hidden page asks the background
worker to time its waits: the worker is not a page and is not throttled. Capped
at 25 seconds a time and raced against the page's own timer, so a worker
restarted mid-wait costs a slow step rather than a stuck one. The step heartbeat
runs on the same clock, since a lapsed beat invites the worker to take over a
step that is still going.

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

## Incognito recovery

claude.ai doesn't save an incognito chat — that's the point of one — so closing
the tab takes the work with it. While such a chat is open the extension keeps a
running copy, against exactly that accident. **Options → Incognito** lists them,
and each can be saved as Markdown through the same exporter the Save button uses.

**Kept for three days, then deleted.** A permanent record of a conversation you
asked not to be recorded isn't a recovery feature, it's a filing cabinet nobody
asked for. The sweep runs in the background worker rather than in a page, so it
happens whether or not you go back to claude.ai, and a record with no timestamp
at all is treated as stale rather than as immortal — "keep it if unsure" is the
wrong way for this particular doubt to fall. **Delete all now** empties it
immediately.

**Only incognito chats.** An ordinary chat is already saved by claude.ai, and
copying it here would duplicate what it holds. A chat is taken as incognito from
its URL — claude.ai writes the key bare, `/new?incognito=`, so what's checked is
whether it was explicitly turned *off* rather than whether it was turned on — or
from an `Incognito` / `Temporary` badge in the header — the **word**, not an
exact caption, since betting on one wording is how a fallback stops falling back.
That's safe because of what it's matched against rather than what it matches: a
leaf node, badge-sized, and **not inside a message**. Text in a message is what
someone *said* about incognito mode, which is not the same as being in it.

That flag rides the **composer** URL, and claude.ai navigates away from it the
moment the chat exists — so the answer is **sticky for the tab**: seen once, this
tab is on an incognito chat until it plainly isn't. Losing the mode at the exact
moment the first reply lands would make this miss the only thing it exists for.
Sticky isn't blind: a tab taken to a *different* conversation, with no flag and
no badge, stops being recorded. And the record is keyed to the **tab**, not the
conversation, because an incognito chat starts at `/new` with no id and acquires
one when it's created — a record keyed on that would split in two at exactly the
moment the first reply arrived.

It reads the rendered page, because there's nowhere else to read it from: the
conversation API has no record of a chat that was never saved. **Read, not
clicked** — this is a conversation you're driving by hand, and a script reaching
for the copy box under your cursor would be its own kind of accident. A reply
still being written is left until it's finished, and a turn caught twice replaces
itself rather than appearing twice.

A record that outgrows 2 MB drops its oldest turns and **says so in the saved
file**, rather than either refusing to grow or quietly looking complete.

## Saving a chat

**Save** sits in claude.ai's header beside Share, and writes the conversation to
a Markdown file — `2026-08-08 Smith v. Jones — MSJ.md`, dated first so a folder
of them falls into order on its own. The point is the *next* chat: a file it can
read is the whole of what the last one worked out, where a summary is whatever
you remembered to include.

It saves the conversation **payload**, not the page. claude.ai unmounts messages
that scroll out of view, so anything read from the DOM would save whichever part
you happened to be looking at.

Three decisions about what goes in, and the file states them so it can't
quietly claim to be more than it is:

- **Thinking blocks are left out.** They're Claude's scratch work rather than
  its answer, and a chat's worth of them would spend the next conversation's
  context on reasoning the conclusions below it already superseded.
- **Artifacts are included.** In this work they're often where the substance
  actually is — a ruling written into a document rather than into the reply —
  and they're fenced in backticks long enough to survive their own contents.
- **Attachments are named, not embedded.** Their bytes aren't in the payload,
  and a file the next chat can't see is better named than silently absent.

Where it goes is [the header slot](#the-header-slot), which it shares with the
table of contents' toggle.

## Copying just the ruling

A reply that contains a tentative ruling usually contains other things too: a
note about what was assumed, a question about a missing paper, an offer to
revise. Claude separates those from the ruling with a horizontal rule — which
you can't select on the page, but which the copy box copies as `---`, along with
everything on either side of it. What goes into a minute order is the ruling and
nothing else, so copying the reply means pasting it somewhere and then deleting
the bits around it, every time.

**Ruling** sits in claude.ai's action bar beside its own Copy control and copies
the ruling alone: from **NATURE OF PROCEEDINGS** through the end of the
**CONCLUSION**, with the rules themselves dropped — including any *inside* the
ruling, since the point is text you can paste straight in. It copies the
**formatted** ruling as well as the plain text, so it lands in Word as a ruling
rather than as `**NATURE OF PROCEEDINGS**` — see [what lands on the
clipboard](#what-lands-on-the-clipboard).

It appears **only on a reply that has a ruling in it**, and not while one is
still being written. A second copy control under every answer in every chat
would be clutter, and half a ruling pasted into a minute order is worse than
none.

**It reads the page, not the markdown.** On the page a horizontal rule is an
`<hr>` — an element, which is why you can't select it. In text it's three
characters that have to be told apart from a setext underline, a table border
and a row of dashes someone typed. The page knows, so the cut is made there,
and the copy is a **selection copy**: the same thing as selecting exactly that
part of the answer and pressing ⌘C. That also means the write happens inside the
click that asked for it, which is what makes it reliable — see
[why it copied everything once](#why-it-copied-everything-once).

Where the boundaries come from, and why each is where it is:

- **The start is the heading**, not the top of the reply. Anything Claude says
  before the ruling is commentary, whether or not a rule separates it.
- **The end is the first rule after CONCLUSION.** Not the first rule after the
  start: a ruling of any length may well be ruled off between its own sections,
  and ending at the first one would hand back the first section alone. Not the
  last rule in the reply either, which would take the commentary with it.
- **Failing a rule, the first heading after CONCLUSION.** Claude doesn't always
  draw the line, and a ruling has no section after its conclusion — so a heading
  there belongs to whatever was written underneath.
- **CONCLUSION is looked for after the start**, so a "Conclusion" in Claude's
  own remarks underneath can't be mistaken for the ruling's.
- **A rule directly under a line of text is left alone.** In Markdown that's a
  setext heading rather than a break — `CONCLUSION` with `---` under it *is* the
  conclusion heading, and reading it as the end would cut off the disposition,
  which is the one line that has to travel.
- **The heading is matched however it was decorated** — `## NATURE OF
  PROCEEDINGS`, `**NATURE OF PROCEEDINGS**`, `NATURE OF PROCEEDINGS:`, or the
  words sharing a line with something else. claude.ai's wording varies and none
  of them is wrong.

### What lands on the clipboard

Both forms of it are written out deliberately, because the browser's own answer
to each is wrong for a document you are about to paste into a minute order.

**As text**, every block is separated by **exactly one blank line**. Left to
itself the browser spaces blocks by their margins, so a heading and the
paragraph under it come back glued together where two paragraphs come back with
a line between them — and uneven spacing is the thing you then fix by hand,
which is the work this button exists to save. A **list** is one block, its items
a line each: a blank line between every bullet turns a four-item list into half
a page. A **hard line break** inside a paragraph survives as a line break, rather
than welding the words on either side of it together.

**As formatted text**, every block carries **one thing of its own**: a bottom
margin, so the paragraphs stay separated. Stripping claude.ai's styling takes
its paragraph margins with it, and a target whose own paragraph style has no
space after it — which a pleading template usually hasn't, being double-spaced
and indented instead — would then run every paragraph of the ruling into the one
below it. NATURE OF PROCEEDINGS is not the first line of the paragraph under it.

Otherwise it arrives in the document's own font. A clone taken off
claude.ai's page carries claude.ai's page with it — its classes, and whatever
Chrome bakes in from the computed style — so a paste would otherwise land in the
chat's fonts, line height and margins. Every attribute is stripped, and headings
become **bold paragraphs**: an `<h2>` pasted into Word is Word's own Heading
style, blue and sans-serif, which is not what a section heading in a minute
order looks like. What survives is the structure and the emphasis — the italics
on a case name, which is the formatting that carries meaning.

Nothing else is rewritten on the way: the words, the citations and the emphasis
are exactly as Claude wrote them.

### Why it copied everything once

The first version of this went through claude.ai's own copy box: click it, catch
what it wrote, cut the ruling out of the markdown, put that back on the
clipboard. Three things were wrong with that, and they compounded.

**The write happened after an `await`.** A clipboard write that lands outside
its own click can be refused, and when it was, the clipboard still held what
claude.ai had just put there — the whole reply. So the button looked like it
copied everything, which is exactly what it had done.

**What it produced was plain markdown.** Pasted into a minute order that is
`**NATURE OF PROCEEDINGS**`, not a heading.

**And it had to guess at the rules.** A run of underscores directly under a line
of text was being read as a setext underline rather than a break, so the end of
the ruling was missed and the material below it came too.

All three are gone: the cut is made on the page, and the copy is synchronous
inside the click. The markdown route survives only as a fallback for a message
whose shape can't be read — it is the one path that can leave the clipboard
holding the whole reply, and it now says `Couldn't copy — whole reply` when it
does, rather than reporting success.

The five shapes it is checked against, in a real browser with a sentinel on the
clipboard so a stale copy can't pass for a fresh one: rules either side of the
ruling; no rules at all; the ruling wrapped a level deeper than expected; a rule
inside the ruling as well; and a reply with no ruling in it, which offers no
button.

Two edges remain, and the button says both out loud rather than leaving you to
find them:

- A ruling with **no CONCLUSION heading** is copied to the end of its block and
  the button says `Copied (no CONCLUSION)` — it may have picked up a sentence
  Claude added underneath.
- Where the ruling **can't be found**, it says `No ruling found` rather than
  copying something else.

The boundary rules live in `src/tentative.js` (no DOM/`chrome` deps) and are
unit-tested in `test/tentative.test.js`; the button is `src/copy-ruling.js`.

## Table of contents

A nine-step run leaves a conversation you'll want to read back through, and a
long chat offers nothing to navigate by but its scroll bar. The panel lists
**your own messages** — the questions, not the answers — and jumping to one puts
the **end** of that prompt near the top of the view, which is where Claude's
answer to it begins. That's the position you actually want when you're reading
back through what a conversation did.

Each entry also carries **when it was sent**, and — where a **workflow** sent it
— **which step it was**: `Step 2B` beside the time, with the run's name on hover.
A run's message is its step's prompt with the carried material pasted under it,
so a turn that begins with a step's prompt is that step; steps are claimed in the
order they ran, so a chat asked the same thing twice gives the second occurrence
to the second step rather than both to the first. Messages you typed yourself
keep their place in the numbering and are simply unmarked. That answers the
question you actually have when reading back through a nine-step run — *which one
is the second devil's advocate pass* — where the prompts on their own all look
alike.

It **starts minimized**: a chat you're only reading shouldn't have a panel over
it. Its `☰` toggle sits in [the header slot](#the-header-slot) beside **Save**,
carrying the number of messages in the chat; the panel it opens free-floats, is
dragged by its own header, and remembers where you put it — the same treatment
the meter gets, for the same reason. Whichever entry you jump to is briefly
outlined, since landing silently in a wall of text leaves you wondering whether
the click did anything.

Two details in the labelling, both about a list that would otherwise distinguish
nothing:

- **An opening every prompt shares is stepped over.** A workflow's prompts all
  begin `Use the devils-advocate skill.`, and a list of nine identical rows is
  no list at all — so the label is the first line that says something
  particular, unless the shared opening is all there is.
- **Markdown decoration isn't part of what a line says**, so headings, bullets,
  quotes and emphasis are stripped before labelling, and a long line is cut at a
  word rather than through one.

**The list is the conversation, not the page.** claude.ai unmounts messages that
scroll a long way out of view, so a list rebuilt from what's rendered loses
entries behind you as you scroll — the exact opposite of what a table of contents
is for. So it's built from the conversation payload, the same one
[Save](#saving-a-chat) writes out, and re-read when a prompt appears that the
list doesn't know about, which is how a message you just sent joins it.

Where there's no conversation to read — an incognito chat is never saved — the
page is all there is. Those views are **merged** rather than replacing one
another: what's mounted is a contiguous window onto the chat, so each new window
either sits inside what's already listed or overlaps one of its ends, and the
union is recoverable either way. A chat that repeats itself ("continue", twenty
times) can align ambiguously, which costs a duplicated entry at worst — where
rebuilding costs entries for certain.

Because the list outlives what's rendered, **an entry you click may not exist on
the page**, so there's nothing to scroll to. It's aimed instead: scroll to about
where that entry should be, see which message actually turned up, and correct
from there — a few passes, each landing closer, then the usual jump to the end of
the prompt once the real message is mounted.

## The workflow's own contents

The contents list indexes the conversation you are in. In a chat a **run** owns,
a second button beside it — `⇄` — indexes **the run**: every step of it, in
order, across all of its chats.

That is the thing a multi-chat workflow otherwise makes hard. *"What did the
advocate actually say about this paragraph"* is a different tab, and finding it
by hand means remembering which one. Here it is a click: the step you pick is
opened **and scrolled to**, not merely opened.

Each row is a step — its number (`2B` where steps ran at once), the first line of
its prompt that says something, the chat it ran in, and when it landed. The step
you're reading is marked, and so is the one the run is currently on; those are
different facts, and the panel says both. A step whose chat the run hasn't opened
yet has nowhere to send you and says so rather than doing nothing.

**Moving between chats** is the worker's job, since it owns the tabs: it finds
the conversation that step ran in, brings it forward, and tells it which message
to scroll to — retrying, because a tab that has only just opened has no content
script listening yet and no page to scroll. This is the one place a run's window
is deliberately given focus. You clicked a step in order to go and read it;
leaving you where you were would be the bug.

**It works after the run has finished**, which is when you mostly want it —
nothing here asks whether the run is still going. The one difference: a
conversation that has since been closed is reopened **in the run's own window**
while the run is live, keeping its chats together, and **beside whatever you're
reading** once it isn't, because by then it's ordinary browsing. Runs are kept
until you delete them, so the index outlives the work.

## Timestamps

claude.ai shows one relative time per conversation — *"1 hour ago"* — and keeps
the real one behind a hover. Reading back through a day's work that is the least
useful form of the fact. So every turn, yours and Claude's, carries a line under
it:

```
2:31 PM · 17m later
```

The clock time it was sent, and **how long after the previous turn it landed** —
which is how long that turn actually took, visible without doing arithmetic on
two hover tooltips. The date appears only where it says something: on a turn that
crossed a day, and on the first turn of a conversation that didn't happen today.

The times come from the **conversation payload**, not the page — the page doesn't
hold them in any form worth parsing. Two consequences worth stating: a chat
claude.ai has no record of (an incognito one) gets no stamps, because the honest
alternative would be inventing them; and a turn is only stamped where the payload
and the page agree about what that turn is, matched on its text with the mounted
window's offset breaking ties, exactly as the contents list does it. A time under
the wrong message would be worse than no time.

The payload is fetched **once and shared** (`src/conv.js`): the contents list
wants the same thing, and two copies asking separately is two fetches of one
conversation every few seconds.

## The header slot

**Save** and the contents `☰` both belong in claude.ai's own header, in with the
file and share controls, so they live in one slot the two of them share
(`src/headerslot.js`) rather than each hunting for its own anchor and finding a
different one.

Three rules, each of them the answer to a way this went wrong.

**Only claude.ai's own controls count.** Other extensions put buttons on this
page too, and they attach them to `<body>` rather than into claude.ai's app
root — so the search is scoped to that root and their buttons stop being
candidates at all. Anchoring to another extension's button is how ours ended up
travelling with it, wherever it went.

**Name first, shape second.** `Share` is the one control here worth matching on
what it is called, and where it is found there is nothing left to infer: the slot
joins the run of controls that touch it. Only when it isn't found does this fall
back to the picture — a tight cluster at the top right, found by walking left
from the rightmost control while they keep touching, so a gap ends the cluster
before it can swallow the *chat dropdown* (which is what an earlier selector list
matched, and why the buttons once sat well to the left of where they belong). The
slot goes in at the cluster's left end, as a sibling of the controls as they were
laid out rather than wedged inside one button's own wrapper. Where neither a
Share button nor a cluster of at least two can be found, it places nothing at
all — a half-rendered page offers a lone button somewhere, and a guess made in
the first second would be lived with, because of the third rule.

**Once placed, it stays.** The check runs every second and a half, and
recomputing the anchor each time meant any flicker in the page — a control that
hadn't rendered yet, another extension arriving late — moved the buttons. A slot
sitting in a row that is still in the document and still visible is now left
exactly where it is, and the second button to ask can't move the first one. It
re-anchors when the row genuinely goes, which is what a navigation does.

**Inserted and visible are different things.** A container that clips, or a flex
row with no room left, puts a button in the page and nowhere on the screen —
which is how a button goes *missing* rather than moving. So every insertion is
measured afterwards, and one that can't be seen is taken back out. The row that
rejected it is remembered, or the header would take the button, fail the check,
hand it back and be offered it again on the next pass — a button flickering
between two places forever. The SPA builds a new header on every navigation, so
that memory clears itself.

Failing all of that, the buttons dock into the meter's own indicator stack, which
is the extension's and so can't be sitting on top of anything of claude.ai's, and
failing even that they float at the bottom left. Never loose at the top right:
that's where Share lives, and a Save button covering Share is worse than no Save
button at all.

## Outage detection

The background worker polls
[`status.claude.com/api/v2/summary.json`](https://status.claude.com/api) — an
Atlassian Statuspage, so the schema is the documented v2 one — every 5 minutes,
and every minute while something is wrong. The reading drives two things:

- **A status line in the pill's panel**, **always shown**: a coloured dot plus the status page's own wording — green
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
derive anything finer).

### Context is a Code figure

The context meter appears on **Claude Code only**.

There, claude.ai computes the number itself and puts it in its own usage menu,
so what the meter shows is a **real token count** read out of the page — worth
having, and the reason the scraping below exists at all.

On a Home chat there is no such number anywhere: the web app exposes no token
count in its API and draws none in its UI. The only thing that could be shown is
our own count of characters divided by four — which can't see the system prompt,
the tools, or what an attachment actually costs. Drawn as a meter with a
percentage under it, an estimate like that gets read as a measurement. A figure
that looks precise and isn't is worse than no figure, so a chat has neither the
context row in the panel nor the context alarm pill.

The estimate is still *made*. It's a parse of a payload the page fetches anyway,
and it's what teaches the model weights behind [Daily
Usage](#what-a-run-costs)'s split. It simply isn't shown to you as though it
were the context window.

**Estimate decimals (experimental, opt-in).** With the toggle on, the session
meter adds an estimated tenths place (`48.3%`). Since usage only climbs within a
fixed window, it learns "tokens per 1%" from the integer jumps it sees, then
divides the tokens consumed since the last jump by that rate. It always snaps to
the authoritative server integer and caps the fraction below the next whole
number, so it only ever affects the tenths place. It's an estimate — the
per-turn cost is itself the text-length estimate (claude.ai exposes no token
counts — see [Context is a Code figure](#context-is-a-code-figure)), it can't
see usage from other tabs/devices/the API, and the per-model
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

The **context figure on Claude Code** is read out of claude.ai's own usage panel
— the web app tokenizes client-side and publishes the result nowhere else. A
**chat's** context is only ever estimated from the conversation payload
(`GET /api/organizations/{uuid}/chat_conversations/{uuid}?…`), which carries each
message's text but no token counts, so it approximates tokens as characters ÷ 4;
that estimate feeds the model weights and is [not shown as a
meter](#context-is-a-code-figure). The **extra-usage** line, when enabled, reads
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
src/autodl.js          Which files a reply offers, and whether to save (pure)
src/autodownload.js    Clicks the download on a file Claude just produced
src/incognito.js       Incognito recovery records (pure)
src/incognito-watch.js Keeps a copy while an incognito chat is open
src/mdexport.js        A conversation as Markdown (pure)
src/headerslot.js      Finds the file/share cluster and puts our buttons in it
src/save-chat.js       The Save button in claude.ai's header
src/replycopy.js       claude.ai's copy box: where it is, and what it wrote
src/tentative.js       The tentative ruling out of a reply (pure)
src/copy-ruling.js     The Copy-ruling button, beside claude.ai's own Copy
src/toc.js             Table-of-contents labelling (pure)
src/stamp.js           When each turn happened, and the gap between (pure)
src/stamps.js          Puts that time under every turn on the page
src/conv.js            The conversation payload, fetched once and shared
src/toc-panel.js       The floating table of contents itself
src/run-panel.js       The workflow's own contents — every step, every chat
src/popup.html/js/css  Toolbar popup (status + toggles + manual endpoint)
test/harvest.test.js   Unit tests for the parsing heuristics
test/estimate.test.js  Unit tests for the tenths-place calibrator
test/status.test.js    Unit tests for the status model + hold decisions
test/workflow.test.js  Unit tests for the workflow model + run transitions
test/toc.test.js       Unit tests for the table-of-contents labelling
test/stamp.test.js     Unit tests for turn times and the gaps between them
test/mdexport.test.js  Unit tests for the Markdown export
test/incognito.test.js Unit tests for incognito recovery + expiry
test/autocontinue.test.js  Unit tests for the button-label predicates
test/autodl.test.js    Unit tests for the auto-download ledger + ceilings
test/tentative.test.js Unit tests for the ruling's start and end boundaries
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
