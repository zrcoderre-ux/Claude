# Project workflow

## Finish the loop — always merge (standing instruction from the repo owner)

**When the work for a task is done, don't stop at a pushed branch.** Carry it all
the way to `main` automatically, without waiting to be asked:

1. Commit and push the working branch.
2. Open a pull request into `main`.
3. **Squash merge** it (keeps `main` linear — one commit per task).

Do this on every task going forward, not only when merging is requested. A branch
left sitting unmerged is not a finished task: the owner is loading this extension
unpacked from a checkout of `main`, so work that hasn't landed there is work they
cannot actually use.

The one exception is a change the owner has said they want to review first, or
one that is genuinely incomplete — in which case say so explicitly rather than
leaving a pushed branch to speak for itself.

## Before you push

`npm test` must pass. The tests are plain `node --test` over the pure modules
(no DOM, no `chrome`), so they run anywhere with Node and take under a second —
there is no excuse for pushing red.

Every new pure module gets a test file, and it gets added to the `test` script in
`package.json` (the script names each file explicitly; a test file that isn't
listed there never runs).

# Orientation

An MV3 Chrome extension that reads your claude.ai usage and shows it in a
floating pill. `README.md` is the real documentation — what each surface does,
how usage is harvested, and why the context figure is an estimate. Read it before
changing behaviour.

The layout that matters for testing: logic with no DOM/`chrome` dependency lives
in its own module under `src/` and is `require`-able from `test/`
(`harvest.js`, `estimate.js`, `log.js`, `predict.js`, `daily.js`, `usagewarn.js`, `weights.js`,
`split.js`, `jobstore.js`, `status.js`, `workflow.js`, `wfusage.js`, `wfexport.js`, `dropdir.js`, `folderup.js`, `toc.js`, `mdexport.js`, `incognito.js`, `cowork.js`, `xlsxread.js`, `pseudo.js`). Everything
else — `content.js`,
`background.js`, `inject.js`, `options.js`, `popup.js` — is wiring around them.
When adding a decision worth testing, put the decision in a pure module rather
than inline in the wiring.

## Things that keep biting

- **Creating a `chrome.alarms` alarm RESETS its countdown.** The auto-continue
  keepalive restarts the service worker every 30 seconds, so any top-level
  `alarms.create` re-arms on every restart and a period longer than that will
  never fire. Check `alarms.get` first and only create when it's missing or on the
  wrong cadence (see `ensureStatusAlarm`).
- **An automation that fails to act must fail LOUDLY, not silently.** A scheduled
  send that quietly never leaves is worse than one that errors. Every gate that
  can hold a job needs a ceiling, a manual override, and a fail-open path when
  its own input is unavailable (see `src/status.js`).
- **Opt-in, default off, for anything that acts on the user's behalf.** Every
  clicker and every automation in here starts off, with its own switch — never
  folded into an existing toggle, because the toggles carry different risks.
  Permission prompts especially: only ever click the narrowest grant
  (`Allow once`), never one that outlives the prompt.
- **claude.ai's DOM and API shapes are unversioned.** Match button labels exactly,
  guard every parse, and keep the heuristics in a tested pure module so a shape
  change is a small edit rather than an investigation.
- **Cowork is not Chat with a different address (standing instruction from the
  repo owner).** Never assume plumbing built for Chat works on Cowork — build
  parallel Cowork paths unless a piece has been CONFIRMED working on both
  surfaces. Confirmed so far: the Chat/Cowork toggle, the approval menu, the
  model menu, and generic mechanics (clicks, menu open/close, hidden-tab
  sleeps). Confirmed broken on Cowork: upload confirmations (its traffic runs
  in a worker no page hook sees), the event-stream and socket hooks, Chat's
  chip selectors, the `/chat/` URL tests, and the reply's copy control —
  seen returning the turn's TOOL PROMPTS instead of the answer, so a copy
  is only believed when it carries the reply's own ending
  (`copyCarriesEnd`). Cowork sends go through
  `src/cowork-composer.js`; its decisions live in `src/cowork.js`.
