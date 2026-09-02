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
- **Approvals on Cowork sends** — the approval mode every Cowork send applies
  when its job or step names none, because Cowork does not keep the mode between
  sessions. Leave as-is by default. See [Cowork](#cowork).
- **Borrow focus to load a Cowork project list** (opt-in, separate toggle) —
  lets a Cowork send bring its own window in front for a bounded time when its
  project list will not load in a tab that is merely visible, and give the
  screen back afterwards. Off by default because it takes the screen. See
  [Cowork](#cowork).
- **Auto-download files Claude produces** (opt-in, separate toggle) — when a
  reply hands you a file, its **Download** button is clicked for you once the
  answer has finished, so a produced document lands in your Downloads folder
  without you going back for it. **New files only** — it saves out of replies it
  watched arrive, never out of a chat's backlog. See
  [Auto-downloading what Claude produces](#auto-downloading-what-claude-produces).
- **Outage warnings** — watches
  [status.claude.com](https://status.claude.com/) and warns on the pill when
  Claude is degraded, down, or under maintenance. A **scheduled send waits out an
  outage** instead of firing into it — unless the outage is confined to models
  it isn't using, or you tell it to press on. See
  [Outage detection](#outage-detection).
- **Usage-pace warnings** — a warning pill (and a desktop notification) each time
  a day crosses **its share of the weekly limit**, and once each as the week
  passes **50%, 75% and 90%**. On by default, with its own switch and an
  adjustable daily share in the popup. See
  [Usage-pace warnings](#usage-pace-warnings).
- **Recents, by repo** — a **Repos** toggle beside **Recents** on Claude Code.
  Pressed, every row in the list says the **repo that session is on** in place
  of its title, so "which session last touched this repo" is a glance instead
  of a hunt through names. Off by default, remembered, and it never guesses: a
  row whose repo isn't known keeps its title, dimmed, and the owner the list is
  mostly on is left off the rows that are on it. See
  [Recents, by repo](#recents-by-repo).
- **Where your usage goes** (Options) — a pie of your weekly usage across
  **Chat**, **Cowork** and **Claude Code**. See
  [Where your usage goes](#where-your-usage-goes-chat-cowork-code).
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
- **Files you uploaded** — claude.ai gives a file *you* sent it no download
  control at all, so when the local copy goes the chat is holding the only copy
  and holding it away from you. A **Files** button in the tray beside Save lists
  what you uploaded to this conversation and downloads any of it again — never a
  thumbnail dressed as the original, never a PDF's extracted text pretending to
  be the PDF, and never a failure that doesn't say which URLs were tried. See
  [Getting back a file you uploaded](#getting-back-a-file-you-uploaded).
- **Upload folder** — on a conversation that doesn't exist yet, chat **or
  Cowork**, a button that takes a **case folder** apart into it: the
  pseudonymized text under `Text Files` goes up as **one combined file**, the
  `pseudonym_key.xlsx` beside it is loaded into the extension and attached to
  the conversation (never uploaded), and a conversation this button's own send
  creates takes the folder's name — pseudonymized. In a chat that already
  exists the papers still go up and the key is still attached, but the chat
  keeps its name. Nothing is typed and nothing is sent; that half stays yours.
  See [Uploading a case folder into a chat](#uploading-a-case-folder-into-a-chat).
- **A folder marked `LEAKS` never uploads** — put a spreadsheet called `LEAKS`
  in a folder and nothing from it goes up, through any door: the Upload folder
  button, a scheduled send's files, a workflow's documents. The whole folder,
  refused out loud, whatever the marker is buried under. See [A folder marked
  LEAKS never uploads](#a-folder-marked-leaks-never-uploads).
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
  share of your weekly usage they account for. **Export them to a file** and
  import them on another computer, so a workflow built once doesn't have to be
  rebuilt there. See [Workflows](#workflows) and [Carrying workflows to another
  computer](#carrying-workflows-to-another-computer).
- **Pseudonym translation** — load a case's `pseudonym_key.xlsx` (the real↔fake
  map PDF-Linker writes) into the popup and attach it to a chat, or to a
  workflow run. That conversation then shows **you** the real names while
  Claude keeps seeing only the fakes — display-only, and the chat **titles**
  read back in the real case name and number too, in the header, the sidebar
  and the tab, while the title claude.ai stores stays the fake — a warning
  fires if you
  type a **real** value into the composer, and the key file itself is **blocked
  from being uploaded** into any chat unless you expressly override. See
  [Pseudonym translation](#pseudonym-translation).

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
- **Several files in one reply save one at a time, in the order offered.** A
  save runs for as long as ten seconds — a menu to chase, a panel to wait for,
  then several rounds of asking whether anything reached the disk — and a
  second one starting in the middle of that used to break both: the first
  save's deferred *Escape* shut the second's menu, and each one's arrival check
  could see the other's download and claim it. One press is outstanding at a
  time now, and the page isn't touched at all while it is.
- **A save is announced only once a file has arrived, matched by name.** The
  toast used to fire the instant something was pressed, which is a claim the
  code was in no position to make — the control may have opened a menu it then
  failed to find a Download in, and it said *"Saved"* regardless. It now asks
  the worker for the recent downloads and looks for **the name it pressed
  for** (Chrome's own `ruling (1).docx` de-duplication folded back first), and
  says which of three things happened: it saved, it pressed a Download and nothing arrived, or
  it found no Download in what opened. A save that didn't happen doesn't count
  against the per-page ceiling either. Where your downloads can't be read at all
  the answer is *"couldn't check"* — never *"saved"*.
- **Never anywhere but your disk.** Cowork draws a file's controls as a
  pull-down — `More ways to open` — listing **Google Drive** first and
  **Download** second. A control naming a destination is not a save control by
  any of the readings here, however plainly it says "save", so the Drive row is
  never the one pressed. The disclosure itself is recognised and opened, and
  then the ordinary rule applies: take a census first, and press only what has
  appeared since and names itself a download.
- **Only once the turn has finished.** A file card can appear while Claude is
  still writing, and a save dialog landing mid-answer is exactly the
  interruption this exists to spare you.
- **A dozen files per reply, twenty per page load.** The page ceiling is the one
  that stops a runaway; the per-reply one only has to sit above what a reply
  plausibly hands over, and a reply handing back a set of documents is the
  ordinary case rather than the pathological one. Where either binds it **says
  so** — a batch that quietly saved the first few and went silent reads exactly
  like the feature failing.
- **A census as well.** Whatever is on the page when the watcher starts — when
  you open a conversation, or turn the toggle on while reading one — is recorded
  as already handled without being clicked. That is belt to the braces above:
  the two rules fail in different directions, and a backlog saved by accident is
  the failure worth paying twice to avoid.
- **Buttons, and links that carry a `download` attribute.** A plain link
  captioned *"Download …"* navigates, and being taken away from the conversation
  you're reading is a worse accident than a file that didn't save.
- **The card is found by what it says**, not by its button. See
  [finding the button](#finding-the-button) — this is what made the first
  version of the feature do nothing at all.
- **Catching up on what's further back** — a second switch, off by default, and
  its own switch because it does the one thing the rule above forbids: saving
  out of a conversation's **backlog**. See
  [catching up](#catching-up-on-files-further-back).
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
attachment is drawn beside the answer rather than inside it, and so is the
reply's own action bar.

**"No other reply" means another *message*, not another matching element.**
claude.ai nests a `.font-claude-response` inside a `.font-claude-response`, so
counting raw selector matches read every turn as two replies — which doubled the
count and made the inner one impossible to widen at all, since the very first
ancestor it tried already "held another reply": its own outer half. The symptom
was a reply reporting **no controls whatsoever**, on a page where every reply has
Copy and Retry sitting directly under it. Only the outermost match is a message
now.

**A card whose name has no extension.** `ruling.docx` is easy; `Tentative
Ruling` with a small `DOCX` beside it is the same card saying the same thing in
a way a filename match can't see. So a **file-type chip** is a second way in —
but only where it is the *whole* of a piece of text, never a word inside one,
because `I've attached the **PDF**` is a sentence and climbing out of it to
press the nearest button would press **Copy**. Cards found that way are held to
a stricter rule: only a control that *names itself* a download is pressed on
one. The looser "press the only control on the card" applies solely to a card
that carried a real filename.

**Not every `.font-claude-response` is a reply.** `[data-testid="assistant-message"]`
is gone from claude.ai, so the cascade now falls through to the response font —
and a **project's title in the content panel** is drawn in that font too, inside
an `<a href="/project/…">`. That panel renders *after* the conversation, so "the
newest reply" was the panel, and everything downstream was reading the wrong
part of the page: the wrong signature, the wrong turn, the wrong file cards. A
reply is never inside a link, a button, or a file thumbnail, and that is the
whole of the rule now applied.

**A card's only button is often the card.** claude.ai wraps a file thumbnail in
a single `<button aria-label="ruling.docx, docx, 117 lines">`, and pressing it
**opens a preview** — it saves nothing. Pressing that and then closing what it
opened is precisely the shape "it doesn't even attempt to download" takes. It's
still worth pressing, because the Download usually lives *inside* what it opens,
but it is an **entry** rather than the thing itself.

**So what a click opens is chased.** A press does one of three things — saves
the file, opens a menu with Download in it, or opens a preview panel with
Download in it — and rather than guess which container claude.ai is calling
what this month, a census of every control on the page is taken *before* the
click and compared with what is there after. A **new** control that names itself
a download is pressed, wherever it turned up; the strict reading only, since a
sweep of the whole document is not the inside of a card, and a new control that
doesn't say what it does could be Delete. Twice — a menu draws in a frame, a
preview panel takes longer.

**And the card is hovered first, always.** The thumbnail's action slot is empty
markup until the pointer arrives — claude.ai renders the per-file buttons on
mouse-enter — so looking before hovering finds the card's own preview button and
settles for it when a real Download was one event away.

Card shapes are driven through a whole turn in Chromium, from the page's events
rather than the extension's internals: a labelled button, an unlabelled icon, a
button added to the page on hover, a button at zero opacity until hover, a blob
link, a `data-testid` with no caption, a card outside the message element, an
extensionless name with a type chip, an overflow menu holding the real control,
and a reply with no file in it, which must produce no click at all.

### Catching up on files further back

The real-time rule is deliberately absolute, and it costs you the ordinary case:
a file produced ten minutes ago, in the tab you're in, that never got saved
because you'd reloaded, or had the toggle off, or the turn signal missed it. So
there is a second switch — **Also catch up on files further back** — that lifts
exactly that restriction.

**"Further back" means ten minutes by default, not the whole chat** — and the
number is a setting in the popup, anywhere from 1 minute to a full day. Catch-up
is bounded by the clock, and the clock is the turn's own — the time in the conversation
payload, not when you happened to open the page. So opening a chat you worked on
last week saves nothing from it: those turns are hours or days old, and no
amount of scrolling makes them recent. A count of replies was the old bound and
was no measure of age at all; twelve replies is an afternoon in one chat and a
fortnight in another.

A turn whose time can't be read is treated as **old**, not as new. If the
conversation payload is unavailable the popup line says so — *"turn times
unread — nothing older than now can be caught up"* — and catch-up simply stands
still. The failure worth avoiding is the other one.

None of this bounds the live path. A reply watched arriving is saved whatever
the clock says about it: it happened in front of you, which is a better fact
than any timestamp.

It is safe to lift because catch-up can *check*. It reads your **Downloads
folder** (the `downloads` permission, names only — never paths) and skips
anything already there. Two normalisations make that comparison mean anything at
all, because the name on the card and the name on disk are rarely the same
string:

- **Chrome's `(1)` renaming, undone.** A second copy of `ruling.docx` is filed
  as `ruling (1).docx`; without this it reads as a file you don't have and earns
  a third. A number that's part of the name survives — `24STCV83325 (Smith).docx`
  stays itself.
- **The characters a filesystem refuses, folded.** A title like `Verification
  Report: 24STCV83325 Motion for Attorney Fees 8.13.2026.md` reaches disk as
  `Verification Report_ …`, because Chrome rewrites the colon. Compared
  literally the two never match and *every* such file is saved again — so `:`
  `*` `?` `"` `<` `>` `|` `_` all fold to a space on both sides before
  comparing. (The filename pattern had the same blind spot from the other
  direction: it stopped at the colon, so it read the name as beginning after
  it.)

Two things it refuses on principle:

- **A card with no name on it is never caught up.** There is nothing to check it
  against, so saving it would be acting on no information at all — and a chat's
  backlog is exactly where that goes wrong at scale.
- **Nothing is caught up while the check is unavailable.** An unread download
  history is `null`, not an empty list: "I don't know" is not "you don't have
  it", and treating the two the same would save every file in the conversation.
  The popup line says which — `catch-up on, 214 files already in Downloads`, or
  `download history unread`.

It looks back about a dozen replies rather than the whole chat, keeps every
other ceiling (a dozen per reply, twenty per page load, one save at a time, wait
for the turn to end), and does **not** change the census for anything it wouldn't take:
a file you already have is still adopted as handled, exactly as before.

It's its own switch rather than folded into the first because the two carry
different risks, and one of them can write a conversation's backlog to your
disk.

**The check is on catch-up only, and that is the point.** A file produced in
front of you *just now* is saved whatever its name — it is new output, and
claude.ai reuses a title every time you ask for the same report twice. Ask for a
verification report, act on it, ask for it again, and the second one is a
different document wearing the first one's name; skipping it on a name match
would leave you holding the superseded copy and not the corrected one. What the
check exists for is the other case: a file already in the conversation that you
already saved. When a live save does collide with a name you have, the toast
says so — *"you already had one of that name, so this is a second copy"* — which
is only knowable while catch-up has the history read.

### When it says it isn't working

"It isn't working" is three faults with one symptom: the turn wasn't seen to
land, no file was found in it, or one was found and held back. The popup now
says which, under the toggle — `1 offered · saving · 1 reply watched`, or
`0 offered · nothing new · 0 replies watched · census open`. It's written only
when the reading changes, so an idle tab writes nothing.

**Save this reply's files** — in the popup, and **Download the newest reply's
files** in the pill's panel — presses the download on **every file the reply
offers**, in the conversation you're looking at, this second, with **every gate
off**: no census, no live rule, no waiting for a turn to land. It searches the
**whole conversation**, newest answer first, rather than only the last one or
two: the file you want is often several replies back, under whatever was said
after it. Those gates exist so a chat's backlog is never saved unasked; you
asking for these files, on this reply, in front of you, is not unasked.

**The whole reply, not the first file on it.** A reply that hands back a set of
documents — a ruling and its exhibits, a pseudonymised bundle, a run's output —
is one act, and collecting it a button-press at a time is a chance to lose one
each time. The batch saves **one file at a time**, in the order the reply offers
them, each waiting for the one before it to settle; the report says what it is
about to take, each file toasts as it lands, and the tally is written back when
the last one has finished. A reply with a single file on it behaves exactly as
it always did.

**"The same reply" is a different question on each surface, so it is asked
twice.** On Chat the cards are *inside* the message, so the batch is what that
message contains. On Cowork a turn's files sit **outside** it, in artifact
blocks that follow the reply and precede the next one — so there the batch is a
question of position, and the newest reply that produced any files is the one
taken. (The standing rule: Cowork is not Chat with a different address.) Both
paths were driven end to end against a page of several files, on each surface. It runs the *same* finding and clicking the automatic path runs, which
is what makes it a diagnosis as well as a button: if it saves the file, the
finding and the clicking work and a gate was what held it; if it doesn't, it
names the step that failed — no card found, a card with no control on it,
nothing left to press.

The report also says whether a turn has run in this tab at all — how many
assistant streams it saw, how many it recognised as a completion, and whether
the page's Stop control ever appeared. `0 replies watched` on a conversation you
merely opened is correct and expected; the same line on a tab that has been
answering all along is a broken turn signal, and until this those two read
identically.

And when that isn't enough, **What can it see?** in the popup asks the
conversation you're looking at to write down what it actually found: every
control in the newest reply with its caption, `aria-label`, `data-testid` and
`href`; every piece of text that reads as a filename or a file-type chip; which
of them it took for a card and what control it would press on each; and which
gate is currently holding it. **Copy report** puts the lot on the clipboard.

That button exists because this feature has now failed three times on guesses
about markup that can't be inspected from where the code is written — claude.ai
is behind a login. A report that can be pasted turns the next round from a
guess into a fix — the first one run in anger found two bugs in a minute: the
project panel being mistaken for the newest reply, and the card's only button
being a preview trigger.

`scripts/dl-probe.js` is the same thing to paste at the **DevTools console**,
depending on neither the extension nor its modules — useful when the question
is whether the extension is running at all. It sees one thing the in-page
button can't: it counts down first so you can put your **pointer** over the
card, and a control the page only *adds* under a real pointer isn't in the DOM
for anything else to find. (A control merely *revealed* by hover is a different
matter — it is in the DOM the whole time, at zero opacity, and the extension
clicks it happily. The report says which of the two you have.) It also describes
**what is under the pointer** — the element, the card around it, its controls
and its markup — which is what settles the question of *which* thing on the page
everyone is talking about, and lists **every** message candidate rather than
only the one it picked, so a selector matching page furniture is visible in the
report instead of silently changing the answer.

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
removable chips and are snapshotted at queue time. A folder hands over the files
inside it and not the folder — see [Dropping a folder](#dropping-a-folder) for
what the walk skips and where it stops. Pick a **target**: a new
chat, a Project, or — when opened from the pill while viewing a conversation —
**this chat**. Pick a **surface** — Chat or Cowork — and, in Cowork, how much
Claude may do unattended; see [Cowork](#cowork). Each job stores your files inside the extension
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

## Cowork

Cowork is the other half of claude.ai's composer — the **Chat / Cowork** toggle
on the home screen, which swaps in a Project menu and a control saying how much
Claude may do without asking: **Manually approve**, **Automatically approve**,
**Skip all approvals**. A scheduled send and a workflow chat can each name a
surface, and a Cowork one can name an approval mode.

**The approval mode is set because Cowork does not keep it.** It was removed as
a setting once, on the belief that the control was sticky — that a new tab came
up on whatever was last chosen by hand. The owner's finding is that it is not
kept between sessions, so a send that says nothing lands on whatever claude.ai
chose. So it is back: a job or a workflow step can name its mode, and the
popup's **Approvals on Cowork sends** is the default every Cowork send applies
when its job names none (a job that chose still wins). Set that to **Skip all
approvals** and every unattended session runs with the brakes off. The switch
is made on the composer home before the message goes, verified off the
control's own label, and a switch that cannot be verified **fails the send**
rather than posting under a mode nobody chose.

Three things about it shape how this works, and none of them is obvious:

- **Nothing in the address says which surface you're on.** Toggling to Cowork
  leaves `/new` as `/new`. A send only lands somewhere distinctive *after* it
  goes — `/cowork/cse_…`, whose id isn't a uuid, so `conversationId` has its own
  arm for it and `settledUrl` its own test. Reading the surface off the DOM is
  the only honest answer, and the page gives one: the approval control's own
  `aria-label` **is** the mode in force.
- **The choice is remembered for the whole account, not the tab.** Set Cowork in
  one window and the next window you open comes up in Cowork, whatever else is
  already open. So a 3am job that switches surfaces changes what you find in the
  morning. A send that moves the toggle **puts it back** once the message has
  gone — and where it can't (the toggle lives on the composer home, which the
  send navigates away from), it says so in the job's note rather than leaving
  you to notice.
- **A Cowork job goes to `/new`, even when it has a Project.** The toggle, the
  approval control and the project menu all live on the composer home. Arriving
  at `/cowork/project/{uuid}` instead would mean arriving with no way to set any
  of the three, so `targetUrl` sends a Cowork job to `/new` and the project is
  chosen from the menu there, by name.
- **An open project menu is not a loaded one.** The list comes off the server,
  and Cowork mounts skeleton rows captioned *Loading* while it waits — no rows
  to match, and not even a search box, because that mounts with the list. A run
  that read the menu in that moment stood down with `no row named "Draft
  Tentative Rulings" among ""` while the menu's own text was `Loading` twelve
  times over. So the driver waits for the placeholders to clear before it looks
  for anything, and a menu that never clears is reported as a list that never
  arrived rather than as a project that isn't there.
- **…and it only ever loads in a tab you can see.** That honest report came back
  a day later saying *still placeholders after 33s*, which answered the
  question: the list arrives when the tab is in front and never while it is
  behind, so waiting is the one remedy that cannot work. The driver now asks the
  worker to make its tab **the visible one in its own window** — a window that
  isn't focused still has a visible tab, so nothing you are looking at moves —
  and then opens the menu again, because a query that never started does not
  start just because the tab woke up. Where the tab is in **the window you are
  working in**, switching your tab out from under you is still not the
  extension's to do — so the worker **moves the tab out into a window of its
  own**, unfocused, behind yours. Your window keeps its tab; the send's tab
  becomes visible somewhere else. (The first version of this fix refused here,
  and the send stood down with *the tab was in the background and could not be
  brought forward*.)
- **…and sometimes only in a tab that has focus.** The report after that was
  the owner's: the list comes when the tab is focused. Focus takes the screen,
  so it is the ladder's last rung and an **opt-in** one — the popup's **Borrow
  focus to load a Cowork project list**, off by default. With it on, a tab that
  is on screen and still showing placeholders asks the worker for the screen
  for up to 25 seconds; the menu is closed and opened again with focus; and
  focus is **given back** the moment the project phase ends (by the page), or
  when the loan's ceiling passes (by the worker, for a page that died
  mid-phase). It never switches the tab of the window you are working in, and
  it is never taken back from something you have since clicked into. With the
  switch off, the send says exactly that in its note rather than failing
  silently: *borrowing focus was not done: off — the popup's switch is not on*.

Both fields default to **leave as-is**, the same contract the model picker has:
a job that never mentions the surface never touches it, so nothing that predates
this behaves differently. And a mode asked for on a page with no approval
control is **not** quietly treated as satisfied — the send reports that it was
ignored, because "it must have worked" is exactly the assumption that gets a
message sent under a mode nobody chose.

In a workflow the surface belongs to the **chat** (a conversation can't be half
in Cowork) and the approval mode works like the model: set on the chat, and
overridable **per step**, leaving the conversation on it for the steps after —
so one chat can research with the brakes off and then edit a filing with them on.

[Upload folder](#uploading-a-case-folder-into-a-chat) works on a new Cowork
session too, on Cowork's own terms — it borrows this driver's attachment
evidence and renames the session through its header control.

### Cowork sends run on their own driver

Cowork is **not Chat with a different address**, and nothing built for Chat is
assumed to work there until it has been *seen* working there. The run that made
this a rule switched its model and then silently did nothing else — no project
chosen, no message sent — because everything after the model menu was Chat
plumbing being trusted on a surface that had never confirmed it. The specific
break: Cowork's uploads run inside a worker the page's hooks can't see, so
Chat's "wait for the upload responses" confirmation can never fire, and Chat's
chip selectors counted zero on a composer that was visibly holding the files.

So a Cowork send goes through `src/cowork-composer.js`, a parallel driver that
borrows from the Chat one only what is surface-agnostic mechanics (clicks,
menus, sleeping in a hidden tab) or has been confirmed on Cowork itself (the
Chat/Cowork toggle, the approval menu, the model menu). Everything else is its
own: choosing the project (a wider net than literal `<button>`s, with the
navigating rows still excluded by name), confirming attachments by what the
composer **visibly carries** — chips or the filenames themselves, truncation
tolerated — and proving the send by Cowork's own evidence (the address becoming
`/cowork/cse_…`, a new human turn, the editor emptying). Every phase reports,
and a phase that fails **fails the send loudly** — a message posted into the
wrong project, or under an approval mode nobody chose, is worse than one that
waits. The decisions live in `src/cowork.js`, pure and tested; the driver holds
only the wiring.

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
  Dropped in — **including a whole folder**, see [Dropping a
  folder](#dropping-a-folder) — picked with **Choose files…** or **Choose
  folder…** (a folder whose name carries a case number hands over only its
  `Text Files` and its key, see [A case folder is taken apart, not
  uploaded](#a-case-folder-is-taken-apart-not-uploaded)), or **pasted**: text pasted anywhere in the run's editor
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
  chat's job within it, then `(Run 2)` on a re-run's. A run nobody named uses
  **when it was created** as the matter — `8.18.26 3:42 PM Tentative ruling:
  Drafting (A)` — because the workflow's name alone is the same for every matter
  it ever runs, and would leave an untitled run's chats indistinguishable from
  the last one's. Only conversations the run opens itself: a chat you
  pointed it at keeps the name it has, because retitling work you started is not
  the extension's business. A title that won't take is a note on the run, never a
  failed step. It is applied **twice** — once the conversation exists, so it has a
  name even if that step then fails, and again once the reply is in, because
  claude.ai titles a new conversation itself a moment after the first answer
  lands and would otherwise write over it. **With a pseudonym key on the run,
  the title goes over in the fake name** — see [The title goes over
  pseudonymized](#the-title-goes-over-pseudonymized).

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

- **Keep going during a claude.ai outage** (off by default) — a run normally
  holds while [status.claude.com](https://status.claude.com/) reports an outage,
  and picks itself back up when it clears. Most outages are partial, so a run
  that never touches the broken part can lose an afternoon waiting for nothing.
  Ticked, this one presses on regardless. Its runs inherit the answer and can
  differ from it, and a run already **Waiting** has a **Go anyway** button that
  sets the same switch. You rarely need either: an outage that names models
  already spares a run on a different one — see
  [Outage detection](#outage-detection).

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

- **A pause, built into the workflow** — `+ Add pause` puts a gate between two
  steps: the run stops there so you can read what it has produced before the
  rest of it is built on top. It has no chat, no prompt and no model, because it
  isn't a conversation with anything; it's a stop.

  Two kinds, and the difference is what happens when you *aren't* there.
  **Indefinite** waits for **Resume**, however long that takes — the answer when
  reviewing the intermediate output is the point of putting it there.
  **Timed** waits the number of minutes you give it and then carries on by
  itself, with Resume going sooner if you're at your desk. That's the answer for
  work you would *like* to look over but would rather not have sitting all night
  waiting for you: a run that pauses forty minutes after the draft lands is one
  you can catch if you're there and which finishes if you're not.

  A pause doesn't disturb the hand-off it sits in the middle of. The step after
  one carries from the last step that actually produced something, and the step
  before one hands to the next that actually reads — so dropping a pause between
  two chats changes when they talk, not whether. Two steps in the *same* chat
  still don't carry across a pause between them, for the same reason they don't
  without one: that conversation already has the material.

  The run steps **past** the gate before stopping, the way any step is done once
  it has happened, so Resume carries on with what follows rather than stopping on
  the same gate again. The row says which kind it is and, for a timed one, how
  long is left.

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
  contain a phrase (`NATURE OF PROCEEDINGS` by default, editable) before the run
  **moves to the next step**. Claude's first answer is often a clarifying
  question, a note that a paper is missing, or a turn cut off at the tool-use
  limit part-way through; those are real replies, and none of them is the ruling.

  It guards *moving on*, not only pasting onward. A drafting conversation that
  writes the ruling and then revises it in the **same chat** hands nothing over —
  but a second step sent on top of half a ruling is still a second step working
  from half a ruling, and nothing in the run would ever say so.

  **A reply that isn't the ruling gets one request to carry on.** The commonest
  reason for one is the turn ending at the tool-use limit mid-ruling, and the fix
  for that is a sentence: *"Continue from exactly where you stopped and output the
  complete text in this reply…"*, naming the phrase it must contain. Once, and
  only once — a chat that has now been told twice what to produce is not going to
  be argued into it, and a run that keeps nudging is quietly burning the usage the
  rest of it needs. If the next reply still isn't the ruling the run **pauses**,
  with its phase intact, so Resume waits for a fresh reply rather than re-sending:
  finish the ruling in the chat yourself and that is the reply it takes.

  **The request waits until the reply has actually stopped.** A turn that has
  gone quiet to run a skill looks, from the page, exactly like a finished reply
  that forgot to write the ruling: the only text the turn is showing is the
  block's own caption — *Used a skill*, *Ran skill: record-verification* — and it
  holds perfectly still for as long as the call takes. Nudging there spends a
  turn interrupting work that was going perfectly well — which is what it had
  been doing. So two things have to be true before the sentence goes out. The reply has to *be* a reply:
  the page's thinking and tool captions are furniture, and a turn showing nothing
  but furniture has not answered yet — it can't settle, it isn't skipped, and it
  is never handed to the next chat. And it has to have stopped: nothing
  generating, no completion stream open, and the text unmoved for **a minute** —
  the same window a matching reply must prove before it counts as finished, for
  the same reason. A clarifying question therefore gets its nudge a minute later
  than it used to, which is the whole cost.

  **And finding the phrase does not end the wait.** `NATURE OF PROCEEDINGS` is a
  ruling's *first line*. A step that took the reply the moment it saw those words
  would be taking a heading and whatever had been written in the second since. So
  a matching reply then has to go quiet — nothing generating, no completion stream
  open, and the text unmoved for **a minute** — before it counts as finished. Much
  longer than the ordinary settle, because a ruling that verifies authority by
  live retrieval goes silent for minutes in the middle, and being early here costs
  a whole run where being late costs a minute.

  It sits on the step rather than on the chat because a chat does more than one
  thing. The drafting conversation writes the ruling, then revises it, then takes
  a style pass over it — and "must this reply be a ruling" has a different answer
  for each. Asked of the chat, one answer had to cover them all.

  **None of this is stored, so all of it is retroactive.** The gate is computed
  from the plan every time a step is dispatched, never written into a workflow or
  a run — so a workflow saved months ago behaves by today's rule, and so does a
  run already in flight, including one paused halfway through. There is nothing
  to migrate and nothing to re-create. (A workflow that predates the step-level
  switch had the marker on the *chat*; that one moved onto every step of that
  chat when it was migrated, which is what the chat-level setting meant.)

### Dropping a folder

Drag a folder onto a run's documents area and the files
*inside* it are added — never the folder itself, which as a "document" would
be a row that uploads nothing. So a matter's papers and the
`pseudonym_key.xlsx` sitting beside them go in **one gesture**: select both,
drop them together, the folder is walked and the key is
[recognised on its way past](#pseudonym-translation) and attached rather than
uploaded.

A run's documents field has **two buttons and a drop zone**: **Choose files…**
for the papers themselves, **Choose folder…** for a whole folder, and the drop
zone, which takes files and folders together in one gesture. (⌥/Alt-clicking
Choose files… still opens the folder picker, as it did when there was one
button.) Everything lands in the same walk, so the rules below hold whichever
route you used, and a `pseudonym_key.xlsx` among the files is
[recognised and attached](#pseudonym-translation) whether it came in loose, in
the folder, or in the same gesture as one. Four things the walk decides, in
`src/dropdir.js`:

- **Subfolders are descended**, and files come in the order the folder reads
  in, numbers sorted as numbers — `exhibit-2` before `exhibit-10` — because
  that's the order they upload in and, when they're text, are combined in.
- **What nobody meant to upload is left out**: every dotfile (`.DS_Store`
  beside every Mac folder, and `.env`, which really shouldn't ride along) plus
  `Thumbs.db` and `desktop.ini`. Each would otherwise cost an attachment slot
  and tell Claude nothing.
- **A file already in the list isn't added twice** — same name and same size —
  so dropping the folder again after adding one more paper doesn't double it.
- **The caps are said out loud.** 300 files and eight levels deep; a folder
  bigger than that is taken as far as the cap and the editor says the rest
  were left out, because a truncation nobody mentions is the failure worth
  designing against.

#### A case folder is taken apart, not uploaded

A matter's folder is not a folder of documents. It holds the **originals** — the
filings as they were served, the exhibits, the correspondence — every one of
them in the real names. What is safe to send sits in one subfolder,
**`Text Files`**, holding the pseudonymized text, with the
`pseudonym_key.xlsx` beside it. Handing that whole folder to an uploader sends
the originals, which is the one mistake this feature exists to make impossible.

So a folder whose **name carries a case number** —
`23STCV12345 Smith v. Jones`, `BC123456 Rasho` — is taken apart rather than
walked:

- **Only what is under `Text Files` becomes a document.** Any depth under it,
  in the folder's own order. Typed `Text Files`, `text files`, `Text_Files` or
  `TextFiles`, it is the same folder; `Texts` and `Text Files Old` are not.
- **The pseudonym key is attached, not uploaded** — the same diversion a
  loose key gets, so it lands in the **Pseudonym key** picker below and never
  in a chat. Any spreadsheet in the pick is read as a candidate, wherever it
  sits: inside the case folder, in a subfolder of it, or dropped loose beside
  it in the same gesture.
- **Everything else is left where it is**, and the count is said out loud —
  *"Left 143 other files in the case folder alone."* No folder is uploaded and
  no original is.
- **The run takes the folder's name**, since the folder is the matter — unless
  you have already typed a run name, which always wins.
- **So does the key.** The key it attaches is called by the folder's name from
  then on, wherever keys are listed — so the picker, the runs list, the tab
  group and the key button in the chat all say the same matter.
- **A case folder with no `Text Files` in it adds nothing** and says so. It is
  still a case folder, which is exactly why the rest of it does not go instead.

The same folder goes into a chat you drive yourself through the **Upload
folder** button — same split, same key diversion, same refusals. See
[Uploading a case folder into a chat](#uploading-a-case-folder-into-a-chat).

A folder holding a spreadsheet called **`LEAKS`** is refused whole, before any
of this runs — see [A folder marked LEAKS never
uploads](#a-folder-marked-leaks-never-uploads).

This is **gated on the name and only on the name**. A folder whose name carries
no case number is handed over whole, exactly as it always was — the rules in
this section, nothing removed. And the gate is the same reader the
[case-number gate](#a-case-number-stops-the-run) uses, so a folder taken apart
this way names a run that will be held to having a key covering that number
before it goes anywhere.

The scan behind it is deliberately much bigger than the upload cap: `Text Files`
has to be *reached*, and 300 files into a matter's originals is not far enough
in. Up to 2000 files are looked at; the 300-file cap then applies to what is
actually taken.

A folder over 100 files comes back **whole**, which is worth stating because
the browser API hands folder contents back a hundred at a time and expects to
be asked again — read once, a folder of 140 papers silently becomes 100. The
scheduled-send form's drop zone runs the same module and the same rules.

### A folder marked LEAKS never uploads

Some folders hold papers that must not reach claude.ai at all — not
pseudonymized, not under `Text Files`, not as one combined file. **Put a
spreadsheet called `LEAKS` in the folder and nothing from it goes up**, through
any door this extension owns: the **Upload folder** button on a chat or a Cowork
session, a scheduled send's files, a workflow's documents.

- **The marker is a spreadsheet named `LEAKS`** — `LEAKS.xlsx`, `LEAKS.csv`,
  `LEAKS.ods`, any case. A copy of it still marks the folder (`LEAKS (1).xlsx`,
  `LEAKS copy.xlsx`, `LEAKS 2024.xlsx`), because a marker that stopped working
  the moment the folder was duplicated would be a bar that failed silently.
  `LEAKS.txt` marks nothing, and neither does `leaks-analysis.xlsx`.
- **It bars the whole picked folder**, not the subfolder it happens to sit in.
  A marker four levels down bars everything at the top: marking a matter's
  discovery folder is marking the matter.
- **Nothing from it is taken** — not the `Text Files`, not one paper. A gate
  that lets most of a folder through is not a gate.
- **Each folder is judged on its own.** Drop two folders and a marker in one is
  not a bar on the other. A marker dropped *loose* bars the loose files it came
  with, which is the same rule with the drop itself as the folder.
- **The refusal is loud and it names things** — *"Nothing was uploaded from
  Smith v. Jones: it holds LEAKS.xlsx, and a folder marked LEAKS never uploads.
  14 files were held back."* An operator who has to work out why a pick did
  nothing will pick it again.
- **If the gate itself is not loaded, the pick is refused** rather than allowed.
  A bar against papers reaching claude.ai that fails open is not a bar; the cost
  of failing closed is one reload.

It bars **uploads**, and only uploads. Loading a **pseudonym key** out of a
marked folder still works from [the key button](#the-key-button) — the key is
parsed into the extension and attached, and the `.xlsx` itself never reaches a
composer. That is the whole point of a key: to make the papers that *do* go up
unreadable.

The bar is applied **when the folder is picked**, which is the only moment the
folder is still known — a run holds files, not the folder they came out of. A
run built before you marked a folder is holding files that were allowed in at
the time; delete them from the run.

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
nothing can pick it up — and opens for editing. The editor reads in the order the
work is done: the matter's **name**, its **run date**, then its **documents** and
**pseudonym key** — those four are what the matter *is* — and only then how the
workflow is worked (chats, switches, steps), with **when it starts** at the
bottom.

**Saving a run starts it.** The trigger opens on **Run now**, so setting a matter
up and pressing **Save and start this run** is one gesture rather than two — the
second one, coming back later to press Start, is how a matter ends up late, and a
run parked at *Not started* looks exactly like one that is waiting on purpose.
The save and the start are **one message to the worker**, which saves the edit
and arms the run in the same handler: two messages to a service worker that is
allowed to die between them is a run that saves and then quietly never goes. If
it saves and still can't start — the [case-number gate](#a-case-number-stops-the-run),
a time that has passed — it **says so on the spot** instead of leaving you to
notice.

- **Run now** is the default, and the button says so. **When usage resets** and
  **At a set time** start it as you save, at their moment.
- **Not yet** is still in the same select for the matter you really are still
  setting up: it leaves the run at the top of the list marked *Not started*, and
  choosing it on a run that was already queued un-schedules it without cancelling
  it.
- **A run kept for a time, or for the next usage reset, keeps it.** Re-opening
  such a run shows the arrangement it was given rather than *Run now* — an edit
  is not a change of mind about when it goes.
- **With nothing to upload it asks first.** A run about to start with no
  documents ticked for a chat puts the question before it goes — separately for
  *no documents at all* and for *documents attached but ticked for nobody*, which
  are different mistakes. Answer no and the run stays exactly as it was.

Nothing about a matter ever occupies a workflow's row: a workflow has no trigger
and no Start of its own. And because the run owns its copy of the papers,
re-arming the template — or deleting it — can't disturb a run in flight; stored
files are only discarded once nothing, run or workflow, still points at them.

### Carrying workflows to another computer

A workflow is half an hour of writing prompts and wiring chats together, and it
lived in one browser profile's storage. **Options → Workflows** has the two
buttons that get it out: **Export all…** writes every workflow to a JSON file,
and **Export** on a single row writes just that one. **Import…** reads such a
file back on the other machine.

**What travels is the template, not the matter.** This is the same rule the rest
of the section runs on, applied to a file:

| Travels | Stays behind (at both ends) |
| --- | --- |
| Chats, their destinations and models | The matter's **documents** |
| Every step: prompt, chat, hand-off, skill, pause | The attached **pseudonym key** |
| What it does, and the resting name | The **run date** and the armed name |
| The switches — bundling, naming, re-run, outage, window | **Start-in-this-chat** links |
| | What its runs **cost** here |

Documents are the biggest of those and the reason for the rule twice over: they
belong to the run rather than the template, and a template mailed with a client's
brief inside it is a leak by file transfer. The pseudonym key is worse — an id
into *this* browser's key library, which on another machine points at nothing, or
at a different case. Both are said out loud after each export and import rather
than left to be discovered by a run that uploads nothing.

**Re-importing updates rather than duplicates.** Ids ride along in the file, so
export → edit on the laptop → export back → import lands on the workflow it came
from and leaves one row, not two. The dialog names what it is about to overwrite
before it does, and a file whose workflow shares only a *name* with one here
imports as a second row and says so — a different id is a different workflow.

**And the matter waiting here survives it.** The rule that governs the export
governs the import: an update replaces the *template* parts and leaves alone
whatever case is already set up on that workflow on this machine — its papers,
its key, its run date, the name it's armed under, and the conversations it was
pointed at. Bringing your prompts up to date is not a reason to lose the matter
you had waiting. (Chats are re-armed by id, so that round-trips exactly when it
is the same workflow; if the far end changed its chats, the arming is dropped
rather than guessed at, because a run pointed at the wrong existing conversation
is worse than one pointed at none.)

The pre-built workflow is the one exception to matching by id, since each browser
mints its own id for it: an imported pre-built one lands on the pre-built one
that's already here, rather than leaving a second row badged *Pre-built*.

**A file that isn't one says so.** The bundle carries a format version and is
refused outright if it was written by a newer build than the one reading it —
half-reading a shape this build doesn't know is how you get a workflow that looks
imported and runs wrong. Anything in the file that isn't a workflow is counted
and ignored, and every workflow that comes in is rebuilt through the same
constructor a new one is, so a hand-edited file can only carry fields this build
knows about.

**Runs don't travel.** They're a matter in flight, tied to conversations, files
and alarms in the browser they started in. Export the template; start the matter
where you're working.

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
usually means a code block's own Copy button answered instead of the message's —
and it is rejected just as firmly if it comes back **not carrying the reply's own
ending**, which is how a long wrong copy is caught. Cowork's copy control has
been seen handing back the turn's *tool prompts*, and a run has been seen
carrying an **open .md document** — a verification report in Cowork's file pane,
which has a Copy control of its own — into the next chat as though Claude had
said it. Two guards, both of them written down once: the copy control is
identified by **the company it keeps** (the reply's action bar carries Retry and
the rating controls; a document pane's toolbar carries none of them), and
whatever comes back has to contain the last of what the page actually rendered,
however little that is. A reply that renders one line above a file it just wrote
is exactly the case the old *"too short to judge, believe it"* rule waved
through.
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
went out. That comparison works whether or not the page is showing anything — and when it
**can't** be made, the failure says which way it failed: the org list refused,
an HTTP status from each org that was asked, a body that wasn't JSON, or a round
trip that never came back. It used to say only *"the Cowork session API was
asked and didn't answer"*, which covers all four and points at none of them; a
step that waited out two hours on a session whose reply had landed an hour
earlier is what that sentence cost. The timeout report also counts the turns on
the page — assistant turns now against at the send, and your own — which
separates *the page never drew the answer* from *the page never took the
message*. The
transcript is also kept scrolled to the bottom — but **only while the tab is
hidden**. The pin stands in for the person a hidden tab doesn't have, keeping
the newest reply mounted; in a tab you are actually looking at, the scroll bar
is yours, and re-pinning it every few seconds would yank you away from whatever
you scrolled up to read. A visible tab losing the pin costs the run nothing —
the conversation API, not the DOM, is the record of whether a reply arrived.

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

### Related runs, run dates, and the list's order

The runs list on the Options page can be read three ways, from the **Sort**
control beside its heading (the choice is remembered):

- **Creation order** — the default, and what the list always did: runs still
  being set up first, then newest first.
- **Run date** — dated runs first, soonest date first (a docket reads
  forward); runs without a date follow in creation order.
- **Related runs** — each group's members pulled together, at the spot where
  the group's first member would have appeared.

**The run date** is a box in the run's editor, beside its name: type it as
`mm/dd/yy` or pick it from the calendar button. A run that has one gets the
date written onto the **end of its name automatically** — `MSJ Rasho 8/12/26`
— after whatever you typed; change the date and the label follows, clear it
and the label goes. (The date lives in its own box, so a name deliberately
*ending* in a bare date-shaped token now belongs there.)

**Related runs** are grouped from the list itself: **Group related runs…**,
check off the runs that belong together, **Save group**. A run belongs to at
most one group — checking it into a new set moves it — and a group that falls
under two members dissolves. Members wear a `⛓` badge **named for the case,
the way the key library names it**: the group's key's hint (`⛓ Rasho`), else
the key's file name, else the earliest member's own matter name — a number
only as the last resort for a keyless, nameless group. **Ungroup checked**
takes runs back out. Grouping also switches the sort to Related runs, since
that's what saving a group is asking to see.

**Updating the key anywhere updates it everywhere the case lives.** Two
kinds of update, both covered. *Refreshing the key's content* (re-loading
`pseudonym_key.xlsx` after a re-run) lands on the same library entry, so
every chat and run attached to it recompiles on the spot — nothing to
re-attach. *Switching which key* from any chat a run owns (the popup's
Attach/Detach) — or from the run's own editor — rewrites the run, **every
run in its group, and their chats** in one move, including any chat-level
attachment that would otherwise shadow the change. A chat no run owns still
attaches and detaches on its own.

**A group has one pseudonym key, because runs are per case.** A group of
related runs is one case, and one case has one key — so setting the key on
any member covers the whole group, and a member never needs (or gets) a
second one. **Save group refuses a mix**: checking off runs that already
carry two different keys is either two cases in one group or one run keyed
wrong, and it says so instead of quietly translating chats with the wrong
case's map. Fix the odd run's key (Edit run), then group.

**A spreadsheet never rides a run's uploads.** The bar is structural, not a
warning: every path that shapes a run's documents drops an Excel file
(`.xlsx`/`.xlsm`/`.xltx`/`.xls`), and the runner's own read of the papers
refuses one, so even a run stored before the rule existed cannot upload it.
Dropping a **pseudonym key** into the documents field gets a better answer
than a refusal: it is parsed and attached **as the run's key** — which is
where it was headed — and never becomes an upload. Any other spreadsheet is
refused by name, out loud.

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

**A step never settles on an answer it didn't watch arrive.** The reply a step
takes has to be one that appeared while it was looking: either the response
stream for *this* message closed, or the text on screen moved, or a turn mounted
after the baseline was read. Text that was already there and never moved is the
*previous* answer sitting where it always was.

That rule earns its place on the one path that used to break without it.
Restart a run at an earlier step and every chat after that point already holds
replies — so a baseline read before the page had drawn the transcript made each
old reply look new, and each step settled on it about six seconds after sending,
one after another, without waiting for anything. So the baseline is now taken
only once the conversation has actually rendered (and only where the URL names
one — a chat being opened fresh has nothing to wait for), and while the page is
still behind the conversation, messages mounting count as history arriving
rather than as an answer.

The exception is deliberate and narrow: re-attaching to a message whose reply is
already sitting there, and re-reading a chat on purpose, both say *whatever is on
screen is the answer* — and requiring a change there would be waiting out the
hour for something that arrived before anyone was looking.

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
seconds. **The same watchdog covers a run that was told to go and never got
going**: arming a run drives it there and then, and a worker that dies in the
middle of *that* used to leave the run sitting at *Not started* with nothing
looking for it — a run set for a time has an alarm, a run set for **now** had
only the call that died. Now it is picked up on the next thirty-second sweep,
so being told to start and starting are the same thing. A step whose message has
already gone out is **re-attached to, never re-sent**, so nothing is ever posted
twice. A run that can't finish fails loudly (a notification, and the error on the
row) rather than going quiet.

### A run's window

**Off by default: a run opens its chats as background tabs in the window you
already have.** That is the plain reading of what a run is — work put behind
whatever you're doing — and a second window is something to find, move and close
rather than something you asked for. **Open this run in a window of its own** is
a workflow setting like every other, so a run inherits it and can change it for
that matter alone.

**A run's chats sit in a tab group**, whichever window they open in — at run
start, as each step opens its conversation, and again when **Open chats**
brings them back. The group is named and colored **for the case**, the way
everything else is now: the key's own label titles it — the case folder it was
picked from, else its hint (`Rasho`) — the color seeds on
the run's key so **every run of one case wears the same color** (a keyless run
seeds on its own id), and a keyless run titles by its matter name. The
grouping is stateless — the run's next tab joins wherever its other chats
already sit, so a browser restart or a group you closed by hand just starts a
fresh one — a tab you grouped yourself is respected, the pinned Options tab is
never grouped, and any grouping failure is swallowed: it's furniture, and a
run never fails over furniture.

**A Cowork step is more patient, because it has to be.** A step normally settles
on a reply once the text has held still for six seconds — safe in Chat, where an
open response stream *proves* that a pause is a tool call rather than a finished
answer. Cowork shows the page no stream at all, so that proof is gone on exactly
the surface that runs tools between sentences and, on **Manually approve**, sits
still on purpose while it waits for you. Where nothing about the network is
knowable, the text has to hold still for **thirty seconds across twelve looks**
instead. The cost is seconds on a step that takes minutes; the cost of being
wrong is half an answer handed to the next chat as though it were whole.

The other end moves too. While the page still shows its **Stop** control, a step
waits out a silence for fifteen minutes before deciding the control is simply
stuck — **thirty in Cowork**, because there it is the last thing holding the
turn, everything stronger being absent, and a twenty-minute tool call is a slow
tool call rather than a stuck page.

**A Cowork session is renamed through its own menu.** There is no API for it —
renaming one by hand makes no HTTP request at all, on a page that renames a
regular chat with a plain `PUT` — so a run does what you do: opens the menu on
the session's name — `More options for <its current name>` — chooses **Rename**,
types into the box and confirms. That label is also how the rename is *checked*:
it carries the session's name, so when it comes round to reading the new one the
rename demonstrably took. A dialog closing would only have said the dialog
closed, which is as true of Cancel. Nothing unnamed is ever clicked; a menu with
no Rename in it is closed again and the run says which items it saw. A conversation inside a Cowork *project* is an ordinary
chat with an ordinary uuid and still uses the API, which is better where it
works — no menus, nothing to mis-click.

**A resumed step checks the name it owes.** Naming a conversation normally
happens twice — once when the send opens it, once after the reply lands, so
claude.ai's own auto-title doesn't win. A worker restart between send and reply
used to skip both: the resume payload no longer carried the title, and the chat
sat unnamed for however long the reply took. Now a chat the **run itself
opened** stays the run's to name across a resume (`ownsChatName` — the record
carries an `opened` flag the run's own send set), and a re-attached step checks
while it waits: if the conversation hasn't yet been given the run's name, it is
named right there, not an hour later. A chat you pasted in can never earn that
flag, so your own conversations are never retitled — including records written
before the flag existed, which fall on the safe side.

In a borrowed window a run gives up everything the isolated one provided for
free, and gives it up deliberately: nothing is resized (the window is yours), no
Options tab is pinned into it, **Close window** isn't offered — those tabs were
never the run's to tidy away — and Pause presses Stop only in the conversations
the run actually owns rather than in every tab, since most of them are yours. A
step also never reuses a tab unless it holds a conversation this run already
owns: a first step's address is `/new`, and matching *that* would hand the step
whatever new chat you happened to have open.

With the switch on, each run opens **its own Chrome window**, **maximized** but
**unfocused**, containing only that run's chats. The size is not cosmetic: claude.ai is
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

- **Windows and tabs.** A run with its own window keeps its chats there, and a step looks for its
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

## Getting back a file you uploaded

claude.ai hands you back a file it *produced* — every such reply carries a
download control, and [Auto-downloading what Claude
produces](#auto-downloading-what-claude-produces) exists to press it for you. A
file **you** uploaded has no control at all: the chip in your own message opens
a preview and that is the end of it. When the local copy is the one that has
gone — a folder cleared, a laptop swapped, a case worked on from somewhere else
— the chat is holding the only copy and holding it away from you.

**Files** sits in the tray beside Save. It lists what you uploaded to this
conversation, with a count on the button so you can see the chat is holding
files without opening anything, and gives each one the download claude.ai
never did.

The list is built from the conversation **payload**, not the page: claude.ai
unmounts messages that scroll out of view, so a list read from the DOM would
cover the last few turns and quietly shorten as you scrolled.

Three things it will not do, each of them a way of *appearing* to work:

- **It never hands over a thumbnail as your file.** claude.ai publishes a small
  copy beside the real one; saved under the uploaded name, that is a fraction of
  the picture you sent wearing its label. Thumbnails are excluded as a source —
  they are read only for what they reveal about where the full asset lives, one
  path segment away.
- **It never calls an extract the original.** A text file (`.txt`, `.md`,
  `.csv`) is stored with its text, and that text *is* the file. A PDF's or a
  `.docx`'s extracted content is not: it is the words with the document thrown
  away. Those come back as `brief.pdf.txt`, labelled in the row as extracted
  text, because a `brief.pdf` that no PDF reader will open is worse than an
  honest `.txt`.
- **It never fails quietly.** claude.ai's asset URLs are unversioned and move,
  so each file carries several candidates, tried in order; a row that couldn't
  be fetched says which URLs were tried and what each answered. What comes back
  is checked before anything is written — an HTML page returned with a cheerful
  `200` is the app saying "no such thing", and would otherwise land on your disk
  as a PDF. Where the bytes won't come but claude.ai kept the text, the row
  offers that instead rather than leaving you with a button that does nothing.

**Download all** takes the batch in order, spaced so the browser keeps up, and
says how many landed. Names are made unique across the whole batch — the same
document uploaded to two turns is the ordinary case, and two files called
`brief.pdf` is one file plus a rename you have to open to identify.

The fetch itself runs in the page's own context (`src/inject.js`), because it is
your claude.ai session that is allowed to read the asset; the bytes come back to
the extension to be written. Only claude.ai's own URLs are ever requested: a URL
that arrived inside a JSON payload is not somewhere the session's cookies may be
sent just because the payload put it there.

Two limits worth knowing:

- **An incognito chat has nothing to fetch from.** claude.ai never saved it, so
  the panel says that rather than showing an empty list as "you uploaded
  nothing".
- **Cowork is not confirmed.** Cowork keeps its uploads somewhere this has not
  been confirmed to read, so on a Cowork session an empty list says so out loud
  instead of claiming you sent nothing.

## Uploading a case folder into a chat

A run takes a case folder apart ([A case folder is taken apart, not
uploaded](#a-case-folder-is-taken-apart-not-uploaded)) and then does everything
else too — types the prompt, sends it, waits, hands the reply on. Most work
isn't a run. **Upload folder** is the first half of that on its own, for the
chats you drive yourself.

A folder holding a spreadsheet called **`LEAKS`** is refused whole here too,
before the folder is taken apart and before its key is read — see [A folder
marked LEAKS never uploads](#a-folder-marked-leaks-never-uploads).

It sits **in claude.ai's own composer row**, wherever there is a composer to put
papers into:

- **To the right of Skip all approvals** on Cowork.
- **To the right of the Chat/Cowork toggle** on the composer home.
- **To the left of Send** in an ordinary chat conversation, which carries
  neither of those controls.

That covers a conversation that **does not exist yet** — `/new`, the home
composer, a project's own composer, and the same three on Cowork — **and one
that already does**, chat or Cowork session. Never Claude Code, and never a page
that is a list rather than a place you type. (A composer showing none of those
three anchors falls back to [the tray](#the-header-slot) with Save, the contents
list and Run.)

**Inside a conversation that already exists, two things differ and only two** —
the papers are the same papers:

- **It keeps its name.** Renaming a chat somebody has been working in is not
  what "upload this folder" asked for, and a title is not display: claude.ai
  stores it, syncs it to every signed-in device and searches it.
- **It keeps any key already on it.** A conversation with no key gets this
  folder's — that is the point of bringing the matter into it. One already on
  *this* case needs nothing. One already on a *different* case is left alone:
  swapping a key out from under an open chat re-reads every message in it under
  another matter's map, and a wrong real name over a fake is worse than the
  fake. The [key button](#the-key-button) switches it in one click for anyone
  who meant to.

Both are said out loud in the card rather than left to be noticed.

Everything it has to say goes in a small card, which hangs **above the button**
while you are still on the composer and stands on its own at the bottom of the
window once the send has navigated off it — because the naming happens after
that, and a report swept away by the navigation that caused it is no report.

Press it, pick the matter's folder, and:

- **Only what is under `Text Files` goes up.** The originals beside it — the
  filings as served, in the real names — are left exactly where they are, and
  the count is said out loud: *"Left 143 other files in the case folder alone."*
- **The text files go up as ONE combined file**, `combined-documents.txt`, with
  a numbered index at the top and each document between its own `BEGIN FILE` /
  `END FILE` markers — byte for byte the file a run builds (`W.bundleText`).
  Twelve attachments are twelve things claude.ai may or may not read; one
  labelled file is one. What isn't text — a PDF, a Word file — can't be
  concatenated and goes up on its own beside it, and a single text file is
  already one upload, so nothing is combined with itself.
- **The `pseudonym_key.xlsx` is loaded, never uploaded.** It is parsed into the
  extension's key library under the case folder's name — the same entry the run
  editor's picker and the popup show — and attached to the conversation once it
  exists, so the chat [reads back in the real
  names](#pseudonym-translation). The spreadsheet itself never reaches the
  composer: it is barred from the upload twice over, by the plan and again by
  the list handed to claude.ai. A folder you have picked before finds the key
  it already loaded, without the `.xlsx` having to be sitting there again.
- **Nothing is typed and nothing is sent.** The prompt is yours to write and
  yours to send, which is the whole reason this is a button rather than a run.
- **The chat takes the folder's name when you send it** — through the matter's
  own key first, so `23STCV12345 Smith v. Jones` reaches claude.ai's sidebar as
  `24STCV99999 Marchetti v. Okonkwo`. A title is not display: claude.ai stores
  it, syncs it to every signed-in device and searches it, so the same rule the
  run's titles are held to applies here ([The title goes over
  pseudonymized](#the-title-goes-over-pseudonymized)). claude.ai auto-titles a
  new conversation itself, early, so the name is stamped again on a backoff over
  the first few minutes — and only where claude.ai's own has won. On your screen
  the sidebar still reads `23STCV12345 Smith v. Jones`: the key this button just
  attached translates the title back [for you](#the-titles-read-back-in-the-real-name),
  while the title claude.ai stores stays the fake.

**Where the name can't go over pseudonymized, no name goes.** Not the real one
as a fallback — the note says which of these it was, and the chat keeps
claude.ai's own title:

| What happened | Why it holds |
| --- | --- |
| No pseudonym key came with the folder | There are no fakes to use, and a case folder's own name is the matter's real one |
| The key doesn't replace the case number | A case number is the whole case — unique, public, searchable — whatever the names were changed to ([A case number stops the run](#a-case-number-stops-the-run)) |
| The key library wouldn't read | "Couldn't tell" is not "there is nothing to protect" |
| The key that named this matter has left the library | Same answer: the swap can't be made |

Two more refusals, for the same reason each time — a conversation wrongly named
is worse than one left unnamed:

- **A conversation that was already going is never renamed.** From the address
  bar, one your send just created and one you clicked in the sidebar look
  identical on both surfaces, so the evidence is taken in order of strength and
  the first kind that answers wins: the conversation itself where it reads back
  (its turns and its stamp), and the page where it doesn't (this tab watched the
  composer become it, it holds one turn, the pick was recent). Anything short of
  a clear yes gets neither the name nor the key, and says so — including a
  conversation nothing could read back at all.
- **A folder whose name carries no case number is refused outright** — that is
  not a case folder, and this button will not take an ordinary folder apart on
  a guess.

### Chat and Cowork, by two paths rather than one assumption

[Cowork is not Chat with a different address](#cowork-sends-run-on-their-own-driver),
so the button reads the **surface** before it does anything and then uses that
surface's own plumbing. A Cowork address settles it; otherwise the page's own
Chat/Cowork toggle does; and where neither says — inside a project, say — the
answer is **Cowork**, because its confirmation covers both and Chat's would call
a perfectly good Cowork upload a failure.

| | Chat | Cowork |
| --- | --- | --- |
| Confirming the upload | the upload responses `src/inject.js` sees, chips behind them | what the composer **visibly carries** — chips or the filenames themselves — borrowed from the Cowork send driver rather than written again |
| Naming the conversation | the rename API, the way a run names a chat | the header's own rename control, driven (`C.renameCoworkSession`), retried while the session's page is still building |
| Confirming it's the right conversation | the conversation payload: its turns and its stamp | the same where the payload answers; **the page** where it doesn't — this tab watched the composer become it, it holds one turn, the pick was recent — and the note says when that weaker evidence is what carried it |

What is the same on both: the split, the combined file, the key, the title rule,
and every refusal above.

The decisions are `src/folderup.js` (no DOM, no `chrome`), tested in
`test/folderup.test.js`; the button, the picker and the wait around them are
`src/folder-upload.js`.

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

Because it reads the page, it copies **what the page is showing** — so on a
chat with a [pseudonym key](#pseudonym-translation) attached, the ruling
reaches the clipboard in the **real names**, ready for a minute order. That is
worth knowing before you paste it anywhere else, and the extension says so
every time: [A copy that carries the real
names](#a-copy-that-carries-the-real-names).

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

## Pseudonym translation

PDF-Linker scrubs a case's filings and writes `pseudonym_key.xlsx`, the
real↔fake map; the exports that reach Claude carry only the fakes. This
feature closes the reading gap: the person who knows the case by its real
names shouldn't have to keep the key open in Excel to follow a draft.

**Loading a key.** From the [key button](#the-key-button), **Load key from case
folder…** picks the *matter's folder* and takes only the `pseudonym_key.xlsx`
out of it. Nothing else in that folder is opened, uploaded or looked at — the
papers are the [Folder button](#uploading-a-case-folder-into-a-chat)'s business
— and picking the folder rather than the file is the whole point: every case's
key is named `pseudonym_key.xlsx`, so the *file* can't say which matter it is
and the *folder around it* can. The key is called by that folder's name from
then on, everywhere a key is named. The popup's **Load pseudonym_key.xlsx…**
still takes a loose file, for a key that has no folder.

Either way it is parsed in the extension (`src/xlsxread.js` reads the workbook,
`src/pseudo.js` reads the map) and only the parsed rows are stored in
`chrome.storage.local`. Loading is not uploading — the file goes nowhere. The key is read the way
`DeAnonymize.bas` reads it: columns found by **header name**, never position;
an operator keep (`no`, `never`, `[bracketed]`, `{braced}`) in the Replacement
cell is an instruction, not a pseudonym, and is skipped; an **alt spelling**
row is forward-only (its real still warns, its fake belongs to the canonical
row); a fake claimed by two canonical reals is **retired from reversal rather
than guessed at** — the macro's own fail-safe; and the pinned
"(never in text)" sheet rides along for the warning side, since a pinned
party's real name is exactly what must not be typed. **A possessive is the
same party** (PDF-Linker's own rule): a bare row covers the possessive —
`Zachary → John` turns `Zachary's` into `John's`, the `'s` riding across as
typed, straight or typographic apostrophe alike — and a possessive row
derives its bare form, so `Zachary's → John's` also maps `Zachary` to
`John`. This holds in every direction: display, the composer warning, the
typeahead swap (which offers `John's` when you typed `Zachary's`), and the
cleaner.

**A picker offers the three most recent**, newest first — plus whatever is
already attached to this chat (or carried by this run), however old, since a
select that can't represent its own current value silently reports a different
one the moment anything reads it back. The rest aren't gone: the library never
evicts, the count is said out loud (`… 9 older keys not shown`), and any of them
is one folder-pick away from being recent again. Reading an old case back needs
none of this — that's what the [master key](#the-master-key-every-case-distilled)
is for.

**Keys are case-specific, and several live side by side.** Every attachment
is per-conversation, and every tab resolves its own chat's key — so two chats
(or two tabs) can run two different cases' keys at once, each translating,
warning, and cleaning with its own map. Because every case's key file is
named `pseudonym_key.xlsx`, the library's identity comes from **content, not
filename**: loading a second case's key creates its own entry beside the
first, while re-loading the *same* case's key after a re-run (a key only ever
grows) lands on its existing entry, so every chat and run attached to it
follows onto the new rows.

**What a key is called** is the same answer everywhere it appears — the popup,
the run editor's picker, the key button in the chat, the tab group, the runs list:

1. **The case folder it came out of** — `23STCV12345 Smith v. Jones` — when it
   was picked as part of one ([A case folder is taken apart, not
   uploaded](#a-case-folder-is-taken-apart-not-uploaded)). That is the matter's
   own name in your own filing, and it is what the **run** is named after too,
   so the key in the picker reads as the same thing as the run in the list.
2. **The case hint** — the real value its exports used most — where no folder
   named it, which is what told two `pseudonym_key.xlsx` files apart before.

A key **keeps** the folder that named it: re-loading the same case's key from
the popup a week later refreshes the rows and leaves the name alone, because
the file itself has no way of knowing which folder it came out of. Picking it
out of a different case folder renames it to that one. All of it is local UI —
none of these labels is ever sent.

**A key attaches to a CONVERSATION, and only to one.** `/chat/<uuid>` and
`/cowork/cse_<id>` — never `/new`, `/cowork`, `/recents`, `/projects`, or a
project's own page (whose address carries a uuid that makes it look exactly like
a chat's; the path is what tells them apart). The identity the rest of the
extension uses falls back to a page's *path*, which is right for saying which
page you are on and wrong for attaching to: a key filed under `/new` is a key
every new page comes up wearing, so the next matter's blank composer arrives
carrying the last one's names. Both attach controls now decide it the same way,
and any attachment already stored against a page rather than a conversation is
swept on the next extension start.

**Attaching it.** Three ways, matching where work happens:

- **A chat** — open the conversation, open the popup, **Attach to this chat**.
- **Out of the case folder itself** — [Upload folder](#uploading-a-case-folder-into-a-chat)
  loads the key sitting beside the papers and attaches it: to the conversation
  the send creates on a new chat, or to the open one you pressed it in, so the
  matter arrives with its own key already on it. A conversation already reading
  in another case keeps that one.
- **A run** — the run editor (where the documents field is) has a
  **Pseudonym key** picker. The key is the matter's, like the papers, so it
  lives on the run: every conversation the run opens or returns to gets the
  translation, a re-run keeps it, and starting the template for the next
  matter clears it. It is *attached*, never uploaded — deliberately not a
  documents-field entry. Dropping the key file into the documents field
  **diverts** it here instead of refusing it (see
  [Related runs, run dates, and the list's order](#related-runs-run-dates-and-the-lists-order)
  — a spreadsheet can't be a run document at all). And a run in a
  **related-runs group** with no key of its own inherits a group-mate's. While
  that run is actually moving, its chats' **messages** show the fakes rather
  than the real names — see [While a run is working, the messages show the
  fakes](#while-a-run-is-working-the-messages-show-the-fakes); their **titles**
  keep reading in the real names throughout, while the title the run *sends*
  goes over in the fake name ([The title goes over
  pseudonymized](#the-title-goes-over-pseudonymized)). A run whose name carries
  a **case number** the key doesn't replace does not go out at all ([A case
  number stops the run](#a-case-number-stops-the-run)).

**What an attached key does.**

1. **Shows you the real names.** Every fake in the rendered messages is
   swapped for its real value — longest first, whole words only,
   case-insensitively, **and in the case the fake was written in** rather than
   the case the key happens to store: `John Doe` → `Zachary Coderre`,
   `JOHN DOE` → `ZACHARY CODERRE`, `john doe` → `zachary coderre`. See [Case
   comes across with the name](#case-comes-across-with-the-name). The **key button** beside Save names
   the key and counts the swaps, so what you see is never silently different
   from what Claude sees — see [The key button](#the-key-button).
   **Display-only, and the boundary is structural**: the swap edits what this
   tab *renders*; everything that leaves the page — sends, workflow hand-offs,
   Save chat — reads claude.ai's own state or API, which still holds the fakes.
   **The clipboard is the exception**, and it is a wider one than it used to
   be: text you select and copy by hand carries what you are looking at, and so
   does [Copy ruling](#copying-just-the-ruling), which copies the *rendered* message rather
   than the markdown. That is usually exactly right — a tentative ruling is
   pasted into a minute order, and a minute order says the parties' real names
   — and it is catastrophic in one direction only, back into a chat. So a copy
   that carried real values **says so**: see [A copy that carries the real
   names](#a-copy-that-carries-the-real-names). The chat's **title** is translated the same
   way, in the header, the sidebar and the tab — see [The titles read back in
   the real name](#the-titles-read-back-in-the-real-name).
2. **Catches a real name as you type it — press → to swap.** The moment the
   caret finishes typing one of the key's real values, a small prompt appears
   at the caret (`Rasho → Strangeways — press → to swap · Esc to keep`).
   **ArrowRight** swaps the just-typed name for its pseudonym in place —
   longest match first, so a full name swaps whole; casing mirrored, so
   `HELEN RASHO` becomes `INGRID STRANGEWAYS`; and it goes through the
   composer's own typing path, so **Ctrl+Z brings the real name back**.
   Escape keeps the real name and stops asking at that spot; typing on
   simply moves past it. The red **banner stays as the net** for everything
   the caret is *not* on — pasted text, a dismissed prompt — without ever
   doubling the value currently being offered. Nothing is rewritten without
   the keypress: the composer is yours. One declared exception: a draft that
   **begins** `PINCITE CHECK — OFFICIAL REPORTER PAGE BREAKS` is the operator
   pasting pincites out of Lexis — published citations, always safe — and the
   warning stands down for that draft. And **ordinary English is never
   flagged**: a key row binding a bare "as"/"and"/"was" (a stray token, a
   one-word short form) is left out of the warning — and out of the cleaner
   below — because those words are what normal writing is made of. Multi-word
   values keep warning even when their words are ordinary ("Cross River
   Bank").
3. **Cleans text for pasting.** Open the [key button](#the-key-button) and
   type or paste text with real names into the top box; the bottom box
   shows it pseudonymized live — the same map run forward (real → fake),
   longest name first, alt spellings covered, keeps left verbatim — with a
   **Copy cleaned** button, so what lands in the chat is the cleaned version.
   It only swaps values the key knows, and says so; it never writes into the
   composer itself — pasting is your move, and the composer warning is still
   watching either way. The same panel holds the **peek toggle** —
   **Show the fakes / Show the real names** — which pauses this page's
   translation so you can see it exactly as claude.ai renders it, then puts the
   real names back. This tab only, never remembered (a peek that silently
   outlived the visit would be translation quietly off), and the button says
   plainly when it's paused. The composer warning, the
   typeahead and the upload guard stay on while paused — they're safety,
   not display. The same switch is also a **one-click button in the composer
   row**, with no panel to open — see [The fakes
   toggle](#the-fakes-toggle-beside-upload-folder).

**The key never rides an upload.** Independent of any attachment, on every
claude.ai page: a file picked, dropped, or pasted into a chat is checked, and
one that is `pseudonym_key*.xlsx` by name — or **any** `.xlsx` whose sheets
carry the key's Real Value / Replacement fingerprint, so a renamed copy is
still caught — is held back behind a dialog that defaults to **Keep it out**.
Uploading it takes the affirmative **Upload anyway**; other files in the same
batch pass through untouched. The check reads the file locally and decides
before claude.ai's own handlers ever see the event. The extension's **own**
pickers are not uploads and are not asked about — [Upload
folder](#uploading-a-case-folder-into-a-chat) reads a case folder locally
and parses the key into the library — but what that button then hands to
claude.ai goes through this guard like anything else.

### The titles read back in the real name

The title that went out is the fake, and it stays the fake — that is the whole
point of [The title goes over pseudonymized](#the-title-goes-over-pseudonymized):
claude.ai stores a title, syncs it to every signed-in device and searches it. But
a sidebar of `8.11.26 Strangeways MSJ` is a list you cannot navigate, so the
title is translated back **for you**, the same way the messages are and with the
same map:

- **The chat's own title** in the header of the conversation you're in.
- **Every chat in the sidebar**, in recents, and in search results.
- **The Recents page, a project's own page, and the Chats and Tasks margin** —
  the lists a case actually gets *found* in. Those rows are not always links to
  a conversation (a row can be a button, or a div with a click handler), so
  they are reached by a different route: see [Lists reached the other
  way](#lists-reached-the-other-way).
- **The browser tab**, with claude.ai's own ` - Claude` tail left as written.

Nothing is written back to claude.ai. The swap is this tab's rendering, exactly
like the message translation — and the two places the extension *reads* a title
to **name** something (**Save chat**'s filename, the scheduler's "This chat")
read what claude.ai wrote rather than what you are looking at, so a display swap
never becomes a name that leaves the browser. The one thing it does reach that
the message swap doesn't is the **browser's own tab title**, which means your
local history and a bookmark of that page pick up the real name — the same
trade the translation already makes with the screen itself.

**Each title is translated by its own chat's key**, not by whichever key this
tab happens to be showing. The sidebar is a list of *different matters*:

1. **A key attached to that chat** — through the popup, or riding a run — wins
   outright. It's you saying which case that conversation is.
2. **Otherwise, the one key in the library that claims the title.** A key
   claims it by having a *distinctive* fake standing in it: a full name, a case
   number, or an invented surname long enough not to read as an ordinary word —
   or two of its shorter fakes at once, which is a caption rather than a
   coincidence. A bare `Park` is a pseudonym in someone's key and also a word a
   chat can be called, so on its own it claims nothing.
3. **Two keys claiming it differently gets neither**, and the title keeps the
   fake. A *wrong* case name over a chat is worse than the pseudonym it
   replaced.
4. **Failing all of those, the [master key](#the-master-key-every-case-distilled)** —
   every case, distilled automatically out of every key you have ever
   loaded, so a case whose spreadsheet is no longer in the library still reads
   back by name.

The key button counts titles beside names, and **lights up for titles alone**
on a page where no chat has a key attached — a sidebar reading in real names is
still translation, and it never happens without something on screen saying so. The peek toggle puts the fakes
back in the titles too — a peek is for seeing the page exactly as claude.ai
renders it. **A run working the matter does not**: while a run is moving, its
chats' *messages* show the fakes and their **titles keep their real names**.
The hold below exists because a hand-off can fall back to a rendered message,
and no hand-off has ever read a title off the screen — so holding the titles
bought nothing and cost you the one line naming the case, in the very minutes a
run was working it.

### The fakes toggle, beside Upload folder

The peek is a switch used **mid-read** — *am I looking at the real names, or at
what claude.ai actually holds?* — and reaching it in the panel is a click to
open, a click to throw and a click to close. So it has a second home: a
one-click button in claude.ai's own composer row, immediately **to the right of
[Upload folder](#uploading-a-case-folder-into-a-chat)**, with no panel of its
own.

It is the *same switch*, not a second one — one `paused` flag — so pressing
either moves both and the two can never disagree about which way the page is
being read.

It says which way that is, in a word, and keeps the key button's rules because
they are claims about the same page:

| The button | What is on screen |
| --- | --- |
| **Real names**, lit | The key's real values, in place of the fakes |
| **Fakes**, italic | Exactly what claude.ai renders |
| **Held**, italic, unpressable | The fakes, because [a run is working](#while-a-run-is-working-the-messages-show-the-fakes) — pause the run, not this |

**Lit if and only if real names are on screen**, in the key button's own colour:
a peek and a run's hold are monochrome, because in both of them the page *is*
showing the fakes, and they are told apart by the word rather than by a second
colour that would dilute the first.

It appears only where there is a switch to throw — a key translating this page,
or a peek to come back from — and it **follows the Folder button** rather than
claude.ai's furniture, so "to the right of Folder" holds in all three of that
button's homes and stays one edit in one file. Where the row has no room to
show it, it stays out rather than sitting in the page and nowhere on the screen;
the peek is still in the panel, where it has always been.

And what it does **not** switch is in its tooltip, because a control that looks
like it turns the feature off has to say so: the composer warning, the typeahead
swap and the upload guard stay on either way. Faking is display.

The decision — the word, the colour, whether it may be pressed — is
`src/faking.js`, pure and tested; `src/fake-toggle.js` is the button and the
docking.

### The master key: every case, distilled

Rule 2 above needs the case's `pseudonym_key.xlsx` to be **in the library right
now**, and rule 3 gets stricter the more keys are in it. Neither holds for long:
keys get replaced, cleared out, and left behind on the machine you loaded them
on. So underneath both sits a standing digest.

Every pseudonym key that passes through the extension — loaded from the popup,
picked in the run editor, or found beside the papers by [Upload
folder](#uploading-a-case-folder-into-a-chat) — is **automatically distilled
down to what a title needs**: the case's real **case number** and its
**parties**, and nothing else. **Every case is kept**, newest first, filed by
real case number; none ever falls off, and a case leaves only when you forget
it or empty the store. (It used to keep just the last twenty, because
generated fakes could collide across cases and every extra case made the
matcher likelier to retire a name two matters disagreed about. Fakes are now
minted **unique across cases**, so the collision the cap guarded against
cannot happen on new keys and the cap only ever threw real case names away.)
There is nothing to upload and nothing to download: load a case's key **once,
for anything**, and its chats read back by name in Recents from then on.

Filed by the **case number** because that is what makes two cases two cases —
the folder gets renamed and the parties get spelled three ways, but the number
does not. A key with no case number anywhere in it is not filed at all; it has
nothing to be unique by.

Three deliberate limits, and each one is why this can be switched on without
taking anything away:

- **Titles only, never messages** — but *every* title, including the list rows
  that aren't links at all ([Lists reached the other
  way](#lists-reached-the-other-way)). A distilled key knows four names out of a
  key that had hundreds. Run over a brief it would swap the caption and leave
  every declarant, witness and address in the fakes — a document half in one
  language and half in the other, with nothing on screen saying which half you
  are reading. A caption is short enough to come out all-or-nothing, and that
  is the only place this is allowed to speak.
- **Last, never instead.** Where a real key claims a title it wins outright, so
  adding this can only ever *supply* a translation, never change one. And the
  same one-claimant rule applies here: a fake that isn't distinctive still
  claims nothing.
- **No cleaner behind it.** The cleaner is a write-side tool — you type a
  paragraph and paste back what it hands you — so it only ever runs on a key
  that knows the whole case. A distilled key would swap the parties, return
  everything else verbatim, and *look* cleaned. The key button says so and
  offers no cleaner at all.

**It outlives the keys it came from**, which is the point — and which means real
case names sit in this browser's storage after the spreadsheet is gone. So the
popup shows what it holds and has one control, **Empty the master key**. That
emptying **sticks**: the library those cases came from is still sitting there,
and a store that quietly refilled itself on the next restart would be a button
that appeared to work. Loading a case's key again after emptying is you asking
for that case back, and brings it back.

### The key button

Everything the pseudonym feature does on the page is behind one control: a
**key**, first in the button row beside claude.ai's own sidebar toggle, to the
**left of Save**. It is an alternative to reaching for the extension popup, not
a replacement — the popup keeps all of it, and is where you go when the page
itself won't load.

It replaced the floating badge outright. That badge said the right things and
said them from a draggable lozenge sitting over claude.ai's page: one more
thing to move out of the way of the thing you were reading.

**The button carries the count**, and that is not decoration. The badge existed
for one invariant — *a real name on screen always has something on screen
saying why* — and a panel that has to be opened would have quietly ended it. So
the button shows how many values are restored right now, goes quiet when
nothing on the page is translated, and says `held` or `fakes` when a run or a
peek has the display standing down. Its tooltip is the whole sentence.

**And it is lit if and only if real names are on screen** — black and white the
rest of the time. That is the same invariant turned into something you don't
have to read: colour means this page is *not* saying what claude.ai says. A
[peek](#pseudonym-translation) and a [run's
hold](#while-a-run-is-working-the-messages-show-the-fakes) are monochrome like
the off state, because in both of them the page is showing the fakes; they are
told apart by the word on the button, not by a second colour that would dilute
the first.

**A key that is merely *available* lights nothing.** Two things light the
button — this conversation having a key **attached**, or real names being on
screen **now** — and the [master key](#the-master-key-every-case-distilled)
standing by is neither. It stands by on every page in the browser, so a blank
composer, which has no conversation to attach a key to at all, was lighting
both this button and the [fakes toggle](#the-fakes-toggle-beside-upload-folder)
and naming a case, while the panel one click away said *this page is not a
conversation*. Both statements were true and together they were a
contradiction; the button is the half people read.

So: nothing translated and nothing attached is **quiet**, whatever keys the
library holds. And where the master key *is* reading the chat names in the
lists back — which is real names on screen, and lights the button properly —
the button says `(not attached here)` and the tooltips say **no key is attached
to this page**, because a key on this conversation and a key on the names in a
list are different facts and only one of them can be true on a page that is not
a conversation.

The panel under it holds, in order:

- **What is translating, and what it is doing** — the case this page is being
  read in, how many names and titles are restored, and the **peek toggle**.
  Where a run is holding the messages the toggle is disabled and says which run
  and what ends it ([While a run is working](#while-a-run-is-working-the-messages-show-the-fakes)).
- **This conversation** — attach a key to it, or detach. Attaching in a chat
  that belongs to a **run** re-keys the whole case, exactly as the popup does:
  the run, its group, and their chats all follow.
- **The key library** — load a key by picking the **case folder** it lives in
  (only the `pseudonym_key.xlsx` is read; parsed here, never uploaded — and the
  [upload guard](#pseudonym-translation) leaves this one picker alone, since it
  is the door keys come in by), or forget one, which detaches it everywhere it
  was attached. The picker offers the **three most recent** keys and says how
  many older ones it isn't showing.
- **The master key** — what its [cases](#the-master-key-every-case-distilled)
  are, and the one control that empties it.
- **The cleaner** — type real names, read out the fakes, **Copy cleaned**. It
  appears only where the key knows the whole case: a distilled master key would
  swap the parties, hand back everything else verbatim, and look cleaned.

The decisions it renders live where they always did. `src/pseudo-view.js` owns
the keys, the sweep and the peek and publishes them; `src/pseudo.js` owns what a
key is; `src/masterkey.js` owns the distilled cases. The panel is the button and
the storage writes, written against the same keys the popup writes, so a change
made in one is the same change as a change made in the other.

### A copy that carries the real names

On the clipboard, the real names and the fakes are indistinguishable — and
every copy off a translated page takes the real ones: ⌘C, right-click Copy,
and [Copy ruling](#copying-just-the-ruling), which copies the rendered message rather than
the markdown. Pasted into a minute order that is what you want. Pasted back
into a chat it is the one thing the pseudonymization exists to prevent.

So a copy that carried real values raises a banner naming them, the case they
belong to, and which direction the copy is safe in. It is read off the
**selection** rather than the clipboard — at that moment a copy event's
clipboard data is still empty, and a handler about to write its own hasn't run
— so the extension's own button and a plain ⌘C are judged on exactly the same
thing.

**Warn, never rewrite.** The clipboard is yours, the same way the composer is:
the banner says what went onto it and gets out of the way. It replaces itself
on the next copy, clears when you copy something with no real names in it, and
has a ✕. A [peek](#pseudonym-translation) stands it down — nothing is swapped,
so nothing swapped can be on the clipboard — and so does a run's hold, for the
messages it covers.

### Lists reached the other way

The four rules above find a title by being **told where one is**: the header
controls, and links whose `href` *is* a conversation. That covers the chat
you're in and a sidebar row that happens to be an anchor — and it misses every
list claude.ai builds some other way. The **Recents** page, a **project's own
page**, the **Chats and Tasks margin**: a row there can be a button, a div with
a click handler, or a link to somewhere that isn't `/chat/`. Those are exactly
the lists a case gets found in, and they were the ones still reading in the
fakes.

Naming those shapes would be guessing at unversioned markup and would go stale
the same way. So the **rest of the page is swept as a whole**, with the
[master key](#the-master-key-every-case-distilled) — which is the one matcher that
doesn't need to know which row belongs to which case, because it holds every
case at once and each row comes out in its own case's real name from a single
pass.

Four limits keep a page-wide pass honest:

- **One claimant per row.** The targeted rules get that from the key library;
  here it is asked of each **text node**, which in a list *is* a row. Without
  it a case binding the fake `Doe` would rename a chat called `Doe hours` that
  has nothing to do with the matter.
- **Rendered turns are pruned.** A message belongs to the message sweep under
  that chat's own full key; a distilled key never gets near one.
- **Title-length text only.** A chat title is capped at 100 characters and a
  paragraph is not, so the ceiling keeps this about names in lists rather than
  prose a turn selector happened to miss.
- **It stands down with the messages, not with the titles.** The targeted rules
  keep translating through a run's hold because their targets are *provably*
  titles. This pass *believes* it has a title — and while a run is moving,
  something merely believed to be a title is something a hand-off might read.

The library isn't merged in beside the master key, and doesn't need to be:
every key you load is folded **into** the master key already, so the
cases here are the library's own plus the ones whose spreadsheets have since
gone.

### While a run is working, the messages show the fakes

A workflow run drives a conversation by machine: it sends, waits for the answer,
takes the reply and pastes it into the next chat. It takes that reply from
claude.ai's own copy control wherever it can — but where the copy control gives
nothing usable, its fallback is **the rendered message**, and the rendered
message is exactly what the translation above rewrites. Left on, the run's
hand-off could carry a real name into the next chat, which is the one thing the
pseudonymization exists to prevent.

So the message translation stands down by itself while a run is **moving**, and
the conversation shows the fakes exactly as claude.ai wrote them. Two things are
held, because a run reaches further than the URLs it has written down so far:

- **The chats the run names** — the conversations it is driving.
- **Every chat on the run's key** — a run is a *matter* and a matter has one
  key, so the chat a run opened a beat ago and hasn't recorded yet is held too.
  Another matter's chat, in the next tab, keeps its real names.

**The chat titles are not held**, in either arm. The hold is about what a
hand-off can *pick up*, and a title is the one thing on the page nothing reads:
the Chat rename asks the conversation API what a chat is called, the Cowork one
reads its control's `aria-label` (which is never translated), and the title a
run *writes* is its own name run through the key before it is sent ([The title
goes over pseudonymized](#the-title-goes-over-pseudonymized)). So a run working
this matter leaves you the one line saying which case you're looking at, and
the [title translation](#the-titles-read-back-in-the-real-name) carries on
underneath it.

**A pause or a failure brings them straight back**, without anything being
switched on again: whether the display translates is only ever a *reading* of
the run's own status, so a run that you pause, that an outage holds, that fails,
that is canceled, or that finishes, is a run showing you the real names again a
moment later. There is no stored "off" that could be left behind — and if the
run starts moving again, the fakes come back with it.

**And the hold can't outlive the automation that asked for it.** A run still
claiming to be running whose driver has gone quiet — tab closed, worker died
mid-step — is a failure like any other: past **five minutes** with no heartbeat
and no progress, the real names return. A run genuinely waiting an hour for a
long answer keeps beating every twenty seconds, so it keeps its hold.

The key button says which state it is in, and while a run holds the messages
the **peek toggle** is disabled and says why —
pausing the run is one click, and pausing the run is exactly what this rule is
waiting for. Everything that is *safety* rather than display stays on
throughout: the composer warning, the typeahead swap, the upload guard, and the
cleaner box.

### The title goes over pseudonymized

A run is named for its matter, because that is what tells one run's chats from a
year of others' — and a matter is named for the case, in the real names. A chat's
title is **not** display: claude.ai stores it, shows it in the sidebar, syncs it
to every device that account is signed in on, and searches it. So a run that
titled its first conversation `8.11.26 Rasho MSJ` would have handed Claude the
real case name in the very run whose every uploaded paper was scrubbed of it.

So where the run has a [pseudonym key](#pseudonym-translation) — its own, or its
related-runs group's, a group being one matter and one matter having one key —
**the title is run through that key before it is sent**, in the cleaner's own
direction (real → fake), and the case comes across in the case it was typed in:

| The run is called | The chat is titled |
| --- | --- |
| `8.11.26 Rasho MSJ` | `8.11.26 Strangeways MSJ: Drafting (A)` |
| `8.11.26 RASHO MSJ` | `8.11.26 STRANGEWAYS MSJ: Drafting (A)` |
| `Cross River Bank, LLC demurrer` | `Zenith Holdings, LLC demurrer: Drafting (A)` |

The chat's own name goes through it too — a step called `Rasho depo (B)` is as
much of a leak as the matter is — and the swap happens **before** the title is
cut to fit, since the fakes are a different length from the reals and a title
trimmed around a real name would fit the fake one badly.

**Only what the key knows is swapped**, which is the same promise the cleaner
box makes: a party the key has never heard of passes through as typed. And where
the matter has **no** key, nothing is swapped — there are no fakes to use, and
there is nothing there to protect.

**Where it can't be done, the chat is left unnamed and the run says so.** If the
matter has a key but the swap can't be made — the key library wouldn't read, the
key isn't in it any more — the run does not fall back to the real name. It sends
no title at all and writes the reason into its notes, so a conversation sitting
under claude.ai's own auto-title is never mistaken for the naming switch being
off. A title that quietly went over with the real name in it is the one outcome
this must not have.

### A case number stops the run

A party's name reaching claude.ai is a leak. A **case number** is the whole
case: unique, public and searchable, so one of them turns a pseudonymized draft
back into the matter it came from whatever the names were changed to. It is the
one value worth refusing to run over.

So before a run goes out — and again at every step, since a run's name can be
edited mid-flight — the names it could write into a chat title are read for a
case number: **the matter's own name, the template's** (which stands in for the
matter on a run nobody named) **and each chat's**. Two shapes are recognised:

| Shape | Example | What it is |
| --- | --- | --- |
| `NN` + location + case type + `NNNNN` | `23STCV12345`, `22SMCV01234`, `24STLC00987` | The modern LASC number: filing year, court location code, case-type code, sequential number |
| Two letters + six digits | `BC123456`, `EC098765` | The pre-2018 numbers the court still carries |

**Finding one makes the key mandatory.** The run goes out only if the matter's
[pseudonym key](#pseudonym-translation) — its own or its group's — actually
**replaces that number**. Not "mentions it somewhere": the test is the swap
itself, run through the same cleaner the title goes through, so a key row
reading `Case No. 23STCV12345` (which would not replace the bare number, and
would not replace it in the title either) does not satisfy the gate. A number
the key covers passes and is titled in its fake, like any other value.

Anything else stops the run **before it opens a tab**: no key attached, a key
that doesn't carry the number, or a key library that wouldn't read. "Couldn't
tell" is not "the key carries it" — the point of the gate is that nothing goes
out on an assumption.

**It refuses; it never waits.** A run stopped here says so where it lives — an
error on the run and a notification — and the message names the number and both
ways out: *load a key that carries that number, or take it out of the run's
name*. Pressing Start on a run that would be stopped tells you at the door
rather than an hour later; a **queued** run is left alone at creation on
purpose, because a run's key is attached in the run editor after the run
exists — the gate still stops it when its moment comes.

A name with no case number in it is not this gate's business at all: the
[title cleaner](#the-title-goes-over-pseudonymized) handles names, and a matter
with no key and no case number in its name runs exactly as it always did.

### Case comes across with the name

A key stores its real values the way they were typed into a spreadsheet — often
shouted, because that is how a caption reads: `ZACHARY CODERRE`. That is not how
the name should read in the middle of a sentence, and the fake standing there is
what says so. **The case of the text wins**, every time: the shape is read off
the fake as it appears and written onto the real name that replaces it.

| In the chat | The key holds | You see |
| --- | --- | --- |
| `John Doe filed a motion.` | `ZACHARY CODERRE` | `Zachary Coderre filed a motion.` |
| `JOHN DOE, Plaintiff,` | `ZACHARY CODERRE` | `ZACHARY CODERRE, Plaintiff,` |
| `john doe` | `ZACHARY CODERRE` | `zachary coderre` |
| `John Doe's motion` | `ZACHARY CODERRE` | `Zachary Coderre's motion` |
| `JOHN DOE'S MOTION` | `ZACHARY CODERRE` | `ZACHARY CODERRE'S MOTION` |

Both directions run the same rule — the display swap and the cleaner's real→fake
pass are one engine — so typing `ZACHARY CODERRE` into the composer offers
`JOHN DOE`, and typing it in a sentence offers `John Doe`.

**What titling leaves alone is what was written deliberately.** Shouting and
quieting a name are unambiguous; putting one back into ordinary prose is where
capitals can be destroyed, so three things survive it:

- **Internal capitals** — `McDonald`, `OneWest`, `d'Angelo`. Authored, and no
  title pass overwrites them.
- **A capital standing in a value that is otherwise ordinary text** —
  `Cross River Bank, LLC`, `IBM Credit Corp`. It was chosen against that
  backdrop, so there is nothing to guess about.
- **Abbreviations inside a value that is all-caps throughout**, which is the only
  place there's nothing to read: one- and two-letter words (an initial, `JR`,
  `PC`), short words with no vowel in them (`LLC`, `LLP`, `LTD`, `DDS`), and a
  short list of the ones that carry a vowel and would otherwise come out as
  words (`USA`, `INC`, `ESQ`, `IRS`, `FBI`, `IBM`…). So
  `JOHN A DOE, DDS` reads `John A Doe, DDS` and `CROSS RIVER BANK, LLC` reads
  `Cross River Bank, LLC`.

The list is the one soft edge: a real value that is a **bare acronym with a vowel
in it and isn't on the list** — stored all-caps, standing alone — comes back
title-cased. Adding it to `KEEP_UPPER` in `src/pseudo.js` fixes it for good, and
so does storing it in the key with any lowercase beside it (`Acme AOL Group`),
which makes its capitals deliberate.

The `'s` is cased with the sentence rather than read as part of the name, which
is why `JOHN DOE'S` is one shout and `John Doe's` is ordinary prose — never
`John Doe'S`.

**Cowork caveat** (the standing rule): the translation and the composer
warning are generic DOM mechanics and should hold on both surfaces, but the
upload guard is **confirmed on Chat only** — Cowork's upload traffic runs in a
worker no page hook sees, so treat the guard there as best-effort until it has
been seen working.

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

## Recents, by repo

Recents on Claude Code is a list of **titles**. A title says what a session was
about; it does not say what it **touched**, and *which conversation last edited
this repo* is a question that list cannot answer however long you read it.

So the list gets a switch. Beside claude.ai's own **Recents** heading sits a
small **Repos** button:

- **Off** (the default) — the list is claude.ai's, untouched. The button reads
  `Titles`, because the word names what is on screen rather than what pressing
  it would do.
- **On** — every row says its **repo** (`owner/name`) in place of its title.
  The button reads `Repos` and is coloured, the way the fakes toggle is
  coloured: colour means this page is not saying what claude.ai says.

The switch is remembered across pages and tabs, and nothing is written back to
claude.ai — this is your tab's rendering of a list, like the pseudonym
translation, and the titles come back the moment you press it again.

### The owner it leaves off

A dozen rows on `zrcoderre-ux/…` spend their first eleven characters saying
nothing, a dozen times. So the owner **the list is mostly on comes off**, and
those rows read `Claude`, `notes`, `usage-meter`. A row on any *other* owner
keeps its owner (`anthropics/claude-code`) — that is the row you need to see is
different, and hiding what makes it different would be the one thing this
switch must not do.

Two rules keep it from being arbitrary: an owner has to hold **at least two**
rows to be dropped (one repo has no repetition to hide), and a **tie is left
alone** rather than settled by whichever came first, so the list does not read
differently on each render. The button's tooltip names what came off — `Rows on
zrcoderre-ux/ are shown by name alone` — so a bare `Claude` never leaves you
wondering whose.

### Where the button appears

Not at an address — on **evidence**: a `Recents` heading with at least one
Claude Code session link (`/code/<id>`) under it. claude.ai moving that list
somewhere else keeps working, and a Recents heading with no sessions in it
(Home's own) never gets the button. Rows that aren't links have no session to
name and are left exactly as drawn.

**Recents is a disclosure**, and the word is the label of its caret — so a
button beside the word is a button inside the control that collapses the list,
and pressing it hid the very thing it was for. Two answers, both in place: the
button is put **after** that control rather than inside it wherever that still
leaves it on the same line as the word, and the press is taken at the **top of
the event path**, so nothing in the page sees it however the collapse is
wired — a handler in the capture phase included, which fires before anything
on the button itself could stop it. claude.ai's own caret still collapses
Recents exactly as it did.

### How a session's repo is known

There is no documented place to read one from, so three sources are tried, in
the order they are trusted:

1. **The page's own API.** claude.ai fetches its session list as JSON, and the
   MAIN-world interceptor already watches that traffic for usage and projects.
   A record counts when it has a **session id and a repo *named* beside it** —
   under a key that says repo (`repo`, `repository`, `full_name`, an
   `owner`+`name` pair), or a github address under a key that merely might
   carry one. Keys that name a **branch** are refused at any depth, even inside
   the repo's own object.
2. **A session you opened.** Its repo is on screen — a github link, or the
   control claude.ai labels as the repository (never one that mentions a
   branch) — so every session you visit teaches its own row, and the map fills
   as you work.
3. **The row's own text**, and only where it names a repo **already learned**
   by the first two.

What each source learns goes into one map of session → repo, capped at 500 and
oldest-out, and a list render that learns nothing writes nothing.

### The trap this feature is built around

A Claude Code branch is `claude/some-slug`, which is **exactly** the shape of
`owner/name`. A row labelled with its *branch* under a toggle that says *repo*
is a wrong answer wearing a right answer's clothes — and worse than no answer,
because you would act on it.

**The shape of a value never says what it is; only where it came from does.**
That one rule is written in three places, because it was got wrong twice and
rows came back named after the branch they were running on:

- The **API reader** takes a repo only from keys that name one, and refuses
  branch keys wherever they appear. A key that merely *might* carry a repo has
  to prove it with a github address; a bare `a/b` under one is not evidence.
- The **row-text fallback** recognises nothing it has not already learned some
  other way. It used to also trust the scheduler's harvested repo list
  (`cum_repos`) — which is filled by a scraper that sweeps a Claude Code page
  for anything shaped like `owner/name`, **branch chips included**. A list of
  "known repos" that cannot tell a branch from a repo is not knowledge, it is
  the same guess one step removed, and it is no longer consulted here.
- A full `github.com` URL is believed outright, since a branch never appears as
  one, and a control claude.ai has **labelled** as the repository is believed
  on its own text — unless the label mentions a branch, in which case it is
  evidence about a branch.

The stored map was versioned along with that fix (`cum_code_repos_v2`): there
is no telling from the outside which entries the old reader had been talked
into, so the old ones are dropped rather than carried forward, and the map
fills again in a page or two.

### A row it cannot name

**Keeps its title, and is dimmed.** Blanking it would cost you the row; naming
a repo it doesn't know would make the list say something untrue about which
session touched what. The button's tooltip counts them (`2 rows have no repo
known yet`), so a list that is mostly dim is a fact you can see rather than a
mystery — open one of those sessions once and its row is named from then on.

## Where your usage goes: Chat, Cowork, Code

**Options → Chat vs Cowork vs Claude Code** is a pie of which surface your weekly
usage was spent on. Three buckets, because Cowork is a surface of its own and not
a flavour of chat — a Cowork session costs what it costs, and folding it into
Home hid that.

**Live readings are attributed to the surface you're on**, which the tab can read
directly. Code is the one an address settles (`/code`). Cowork mostly isn't:
a session lands on `/cowork/cse_<id>`, but the composer home stays `/new`
whichever surface it's set to, and the setting is sticky across tabs — so the URL
answers where it can, and where it can't the page's own **Chat/Cowork toggle**
does (one of the few pieces confirmed to work on both surfaces). A `/chat/`
conversation is Chat whatever the account-wide toggle was last left on.

**A gap is where the evidence runs out.** When usage rises with no tab watching
— your phone, another browser, a tab that was closed — the extension asks
`chat_conversations_v2` which Home chats were touched during the gap, and how
much content they grew by, and gives the chats their measured share. Neither a
Cowork session nor a Code session appears in that listing (a Cowork session lives
under `/conversations`), so **what's left over is Cowork-or-Code with nothing to
tell them apart**.

That remainder is divided in the proportion those two have been seen **live** —
readings where the surface was read off the page rather than inferred. Two
properties matter about that rule:

- It **never invents Cowork out of nothing**. An account that has never had a
  Cowork reading gets the whole remainder as Code, which is exactly what this did
  before Cowork was a bucket.
- The evidence counters are fed **only by live readings**, never by a gap's own
  attribution, so the division can't drift off feeding on its own guesses.

## Usage-pace warnings

The meter tells you where you are; this tells you when where you are is a
problem. Two warnings, both **on by default** and both switched off together by
**Warn me when I'm outpacing my usage** in the popup:

- **A day past its share of the weekly limit.** The weekly limit is a week's
  worth of usage, so spent evenly it's **an even seventh a day — 14.3%** of the
  weekly meter. The first time a day's own consumption crosses that, you're
  told. If it's a heavy day you're told again at each further whole multiple
  (2×, 3×, …), because a day that spends triple its share is worth hearing about
  more than once; a single day can warn at most **10 times**, which is the guard
  against a hand-set share small enough to fire on every reading.
- **The week at 50%, 75% and 90%.** Once each per weekly window. Crossing two at
  once — a big reading after a gap — says the higher one and spends both, rather
  than stacking notifications.

**A day's usage is the per-day figure the Options page already charts**: the rise
in the weekly meter since the last reading, attributed to the calendar day it
happened on (`src/daily.js`). So both halves of this are in one unit throughout —
percentage points **of the weekly limit** — and the panel prints today's against
the share (`today / share · 16.2% / 14.3%`) so a warning always has a number on
screen to check it against.

**On the day the week resets** (Tuesday morning) a date's usage spans two weekly
windows, because the per-day tally counts calendar days and the limit doesn't.
The daily warning reads that whole day, which is the right answer to "am I
spending faster than a seventh of a week a day" and an overstatement of what this
week's budget has taken — the milestones above are the figure to go by that
morning.

**The share is adjustable.** An even seventh is the default, not a claim about
how you work; if your week is really five days, set the share to 20% in the
popup and the warnings move with it. A value outside 0–100 is refused rather than
stored, and anything under 1% is treated as 1% for the multiples.

**The pill behaves like the context alarm, not like the outage warning.** At 75%
of the week and above it stays up, because that's the stretch where every message
costs you something. Below that — a 50% crossing, or a day past its share — it
appears for twenty seconds, flashes, and gets out of the way. It's an indicator
only: it never takes a click, and it rides in the same stack as the outage and
context pills, between them, so an outage warning never moves out from under your
cursor when this one appears.

**One warning, not one per tab.** The decision is made in the background worker,
not in the page: every open claude.ai tab reports its reading, and the worker —
which owns the fired-state (`cum_warn`) — answers only the first one across a
threshold. Three tabs crossing 90% together produce one notification. A tab that
opens onto an already-crossed threshold is told nothing: the warning was given
when it happened.

**Re-arming.** The weekly marks re-arm when the weekly window rolls — either
because the reset time changed, or because the meter itself has fallen well below
a mark it had crossed, which is a window that rolled without our having read its
new reset yet. The daily one re-arms on the date, which is what "every time I
cross my daily share" means: at minimum once a day, however the week is going.

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

**Which models is it.** Plenty of outages are one model — "Elevated errors for
Claude Opus 4.5" — and a run on a different one has nothing to wait for. The
status page has no component per model (its components are *surfaces*: Claude.ai,
Claude Code, api.anthropic.com), so the models are read out of what the incidents
**say**: their titles and their updates, matching `Opus`/`Sonnet`/`Haiku`/`Fable`
with or without a version, in prose (`Opus 4.5`) or as an api id
(`claude-opus-4-5`).

The narrowing only ever *releases* a hold, and only on a positive statement:

- If **any** blocking incident names no model, the outage is about everything and
  every run waits, exactly as before. That's also what a bare component outage
  (`Claude.ai: major outage`) means — a surface going red is *how* a model
  incident shows, so it is never read as "model-specific".
- A family named without a version (`Sonnet is degraded`) covers every version of
  it.
- A run whose model can't be established waits. The failure mode of this parser
  is a run that waits when it needn't, never one that sends into an outage.

The model a run is compared against is the **step's** model, or failing that the
**chat's**, or failing that **the model your account is normally on** — a
workflow that names no model isn't using "no model", it's using whatever
claude.ai is set to. That default is `Opus 5`, editable in the popup under the
outage toggles.

And the escape hatches, because a queued send that never leaves is its own
failure:

- **Keep going during a claude.ai outage** — a per-workflow switch (off by
  default), inherited by its runs and editable on a run of its own. Ticked, that
  run never waits one out.
- **Go anyway** appears on a run that is already **Waiting**: the answer to "this
  outage doesn't touch what I'm doing". It carries on immediately and, being the
  same switch, doesn't ask again for the rest of the run.

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
src/usagewarn.js       Daily-share + weekly-milestone warnings (pure)
src/split.js           Chat vs Cowork vs Code attribution, incl. gaps (pure)
src/daily.js           Per-day attribution of weekly-limit usage (pure)
src/jobstore.js        Pure scheduled-send job model
src/workflow.js        Pure multi-chat workflow model, run state + pre-built
src/wfexport.js        Workflow export/import bundles: what travels (pure)
src/dropdir.js         A dropped folder, taken apart: walk, skips, caps, case folders (pure)
src/cowork.js          Chat/Cowork surface + approval modes (pure)
src/inject.js          MAIN-world interceptor + proactive baseline fetch
src/content.js         ISOLATED-world UI + state + live countdown
src/content.css        Floating-button styles (light + dark)
src/composer.js        Drives claude.ai's CHAT composer DOM (+ shared mechanics)
src/cowork-composer.js Parallel Cowork send driver — Cowork's own evidence
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
src/panelbar.js        Tray, console and card geometry on claude.ai's page (pure)
src/tray.js            The Save/Bookmark/Run tray, panels opening in line
src/save-chat.js       The Save button in claude.ai's header
src/upfiles.js         The files you uploaded: whose, where the bytes are, what's honest (pure)
src/up-files.js        The Files button and panel — downloads them again
src/folderup.js        A case folder into a new chat: what goes up, what it's called (pure)
src/folder-upload.js   The Upload folder button on a new conversation
src/replycopy.js       claude.ai's copy box: where it is, and what it wrote
src/tentative.js       The tentative ruling out of a reply (pure)
src/copy-ruling.js     The Copy-ruling button, beside claude.ai's own Copy
src/toc.js             Table-of-contents labelling (pure)
src/stamp.js           When each turn happened, and the gap between (pure)
src/stamps.js          Puts that time under every turn on the page
src/conv.js            The conversation payload, fetched once and shared
src/toc-panel.js       The floating table of contents itself
src/run-panel.js       The workflow's own contents — every step, every chat
src/xlsxread.js        Minimal .xlsx reader — enough for the pseudonym key (pure)
src/pseudo.js          Pseudonym key: parsing, translation, warnings, guards, run hold, chat titles, case-number gate (pure)
src/pseudo-view.js     Shows real names for the fakes — messages and chat titles — warns, guards the key file
src/faking.js          The fakes toggle: its word, its colour, whether it may be pressed (pure)
src/coderepo.js        Which repo a Claude Code session is on: what counts as evidence (pure)
src/code-recents.js    The Repos toggle beside Recents, and the swap it makes
src/fake-toggle.js     That toggle in the composer row, to the right of Folder
src/popup.html/js/css  Toolbar popup (status + toggles + manual endpoint)
test/harvest.test.js   Unit tests for the parsing heuristics
test/estimate.test.js  Unit tests for the tenths-place calibrator
test/status.test.js    Unit tests for the status model + hold decisions
test/usagewarn.test.js Unit tests for the pace warnings + their re-arming
test/split.test.js     Unit tests for surface attribution and gap splitting
test/workflow.test.js  Unit tests for the workflow model + run transitions
test/toc.test.js       Unit tests for the table-of-contents labelling
test/stamp.test.js     Unit tests for turn times and the gaps between them
test/mdexport.test.js  Unit tests for the Markdown export
test/incognito.test.js Unit tests for incognito recovery + expiry
test/autocontinue.test.js  Unit tests for the button-label predicates
test/autodl.test.js    Unit tests for the auto-download ledger + ceilings
test/tentative.test.js Unit tests for the ruling's start and end boundaries
test/xlsxread.test.js  Unit tests for the .xlsx reader (zip + sheet XML)
test/pseudo.test.js    Unit tests for the pseudonym key logic
test/folderup.test.js  Unit tests for the case folder taken into a new chat
test/upfiles.test.js   Unit tests for getting an uploaded file back
test/coderepo.test.js  Unit tests for the repo behind a Recents row (branch traps included)
icons/                 Generated PNG icons (16/48/128)
scripts/make_icons.py  Regenerates the icons with the Python stdlib only
scripts/dl-probe.js    Paste at the DevTools console: what a reply really holds
```

## Privacy

Everything runs locally in your browser. No data is sent anywhere; the only
storage used is `chrome.storage.local` on your machine. The extension requests
access to `claude.ai` and — for the outage check — `status.claude.com`, which is
a public, unauthenticated status page: the request carries nothing about you.

It also asks for `downloads`, used for one thing: reading the **names** of your
recent downloads so [catch-up](#catching-up-on-files-further-back) can skip a
file you already have. The worker strips the directory before the names ever
reach the page — where your files live is nothing to do with clicking a download
button — and nothing is written to the history, only read from it. Turn catch-up
off and it is never read at all.

## Regenerating icons

```bash
python3 scripts/make_icons.py
```
