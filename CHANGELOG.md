# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [Semantic Versioning](https://semver.org/).

This project's early history was a research spike plus a hard look at what the spike got wrong, so
several entries below record **defects that shipped and were fixed** rather than only features.
They are kept because each one is the reason a constraint or an invariant test exists.


## [Unreleased]

<!-- Empty at tag time: `scripts/check-version.mjs --release` refuses to release while this holds entries, so a release cannot silently ship undocumented changes. An HTML comment is exempt from that check, which is why this note is here rather than a paragraph. -->

### Added

- The directory sheet lists directories used before, one click each, derived from session history ([#149]).
- A project session offers "New session here", which starts an empty session in the same directory ([#149]).
- The sheet's recent list says "unreadable" rather than "missing" when a directory exists but cannot be read ([#196]).
- An unnamed session is labelled by its first prompt, so the rail shows the task instead of a handle ([#149]).
- A stopped session can be deleted from the rail and from History, behind a confirmation that names its directory ([#150]).
- History puts search, sort and a bulk delete in one action bar; the delete is disabled until rows are selected ([#150]).
- A selection can be cleared in one step, and its count is shown in the action bar ([#150]).
- A running session can be stopped from its rail row, so a refused deletion names a session you can reach ([#150]).
- The deletion refusal names the session, its directory and its state instead of only a handle ([#150]).
- History pages 25 rows at a time and sorts by newest, oldest, size or name ([#150]).
- The History pager appears at the top of the list as well as the bottom, and the session count states how many exist ([#150]).
- Deleting removes the session's transcript and its subagent sidecar; a sidecar that cannot be removed is reported ([#150]).

### Changed

- Each rail section is ordered by most recent activity, so the row that just changed is at the top ([#68]).

- Every rail row draws the context-usage bar, so pressure is compared across sessions by eye ([#13]).

### Fixed

- A stopped session can be resumed, forgotten or deleted from its rail row, instead of the row losing every control
  ([#89]).
- Hovering a rail row is visible, and idle rows no longer wear a bright grey stripe ([#89]).
- Rail rows are spaced 8px apart, so they read as separate blocks instead of merging into one ([#89]).

- Clicking a History session that is already running focuses it, instead of leaving the view on another session
  ([#150]).
- A resumed session is focused when it arrives, and an unrelated new session can no longer claim that focus ([#150]).

- Selecting a stopped session shows it, with a Resume control, instead of a dead end ([#89]).
- Rows that were named after their directory — several sessions all reading `data-manager` — now show the prompt or a
  unique short id ([#89]).

- History says a directory is unreadable when it exists but cannot be read, instead of calling it gone ([#196]).
- Discovery and resume share one directory classification, so the History chip and the refusal dialog agree ([#196]).
- The context-pressure threshold is one shared constant instead of three separate `80`s ([#13]).
- Both context gauges are sized from one token, so widening one widens the other ([#13]).

[#13]: https://github.com/sven1103-agent/pi-central/issues/13
[#68]: https://github.com/sven1103-agent/pi-central/issues/68
[#89]: https://github.com/sven1103-agent/pi-central/issues/89
[#149]: https://github.com/sven1103-agent/pi-central/issues/149
[#150]: https://github.com/sven1103-agent/pi-central/issues/150
[#196]: https://github.com/sven1103-agent/pi-central/issues/196
[#150]: https://github.com/sven1103-agent/pi-central/issues/150

## [0.8.0] — 2026-11-01

The release that makes updating stop costing you work. Two things every update used to break — the UI you were
looking at, and the sessions you had open — now survive it.

**No protocol change. `PROTOCOL_VERSION` stays at 5**, so a 0.7.0 UI and a 0.8.0 orchestrator still talk to each
other. That is a deliberate consequence of how the first fix is built: `InstallFacts.ui` is an *optional* field, and
the convention recorded on it is that an added optional field is not a wire change. The one bump-adjacent move is
`FileEntry.mtimeMs`, optional for the same reason.

The two defects were reported together and are independent. Neither was a caching bug, which is what both looked
like:

**The installed app never reloaded itself.** Clicking a dock icon *focuses* an installed window; it does not reload
it. So after `npm install` and a restart, the page still held the previous bundle, and the service-worker cache —
which `0.6.1` fixed and which is provably not the cause here — was blamed again. When the protocol had changed the
skew check fired correctly and advised "reload the UI", an action a standalone window has no affordance for.

**Sessions died with the process.** The supervisor held them in memory, so stopping to update emptied the rail. The
roster kept the *rows* (0.5.0), which is why the symptom was a list of stopped sessions rather than no list at all.

### Fixed

- An installed Pi Central reloads itself when its window is older than the served bundle ([#184]).
- `InstallFacts.ui` reports the fingerprinted entry chunk the orchestrator serves ([#184]).
- The stale-window comparison is silent when either side has nothing to report ([#184]).
- The reload is one-shot per target identity; a second verdict is a banner, not a loop ([#184]).
- A protocol skew takes the same path instead of a dismissible error strip ([#184]).
- Open sessions are reopened at the next start, in their recorded directories and modes ([#185]).
- `open-sessions.json` records each open session, written eagerly and removed only on an explicit stop ([#185]).
- Restore reuses the existing `resume` path, so a missing directory is refused and no cwd is retargeted
  (C2, ADR-0008) ([#185]).
- A session file that is gone is dropped from the list; a directory that is gone is kept ([#185]).
- Only the long-running server remembers sessions; the one-shot CLI opts out ([#185]).
- Sessions are keyed by canonical path, so one conversation cannot be listed twice (ADR-0004) ([#185]).
- A process that never started no longer makes shutdown wait forever ([#185]).
- Files created during a session appear in the tree and the `@` picker within five seconds ([#189]).
- Each listing carries entry mtimes, so a re-read that found nothing new does not re-render ([#189]).

[#184]: https://github.com/sven1103-agent/pi-central/issues/184
[#185]: https://github.com/sven1103-agent/pi-central/issues/185
[#189]: https://github.com/sven1103-agent/pi-central/issues/189

## [0.7.0] — 2026-11-01

Images, where the conversation puts them. A picture a tool read, a screenshot you paste, and a file your own prompt
names by path now all appear in the transcript — each in the place that matches what it is.

**One protocol change: `PROTOCOL_VERSION` 4 → 5.** Nothing new crosses the wire for *rendering* — the bytes were already
arriving in the `transcript` frame every client parses on connect, so drawing them costs a DOM node and a decode rather
than a transfer. What is new is sending: `Control.prompt` now carries optional `images`, and `ModelOption` carries
`input` so the composer only offers a paste where the model accepts one.

Pi Central ships as **one package with one version**, so a UI and an orchestrator cannot normally disagree — `npm install
pi-central@0.7.0` gives you both at 5, and upgrading is a single act. The handshake matters only in the development
layout, where an orchestrator from one checkout can serve a UI built from another; that pair refuses to connect rather
than letting a paste disappear silently.

The measured premise, from this machine's own session store: **447 image-bearing messages across 885 sessions, and
every single one is a tool result** — a `read` of a PNG. None was a paste. So the placement that had to work first was
the tool detail, not the composer; a UI that handled only pasted images would have looked correct and shown nothing.
Separately, **181 of 5 912 user prompts name an image file by path** (`@img_6.png shows…`), which rendered as literal
text until now.

### Added

- A stopped session can be deleted from the rail and from History, behind a confirmation that names its directory ([#150]).
- Deleting removes the session's transcript and its subagent sidecar; a sidecar that cannot be removed is reported ([#150]).


- **Images are shown in the transcript, where they belong in the conversation.** A tool that reads a
  picture (`read` on a PNG) now shows it above its output in the tool detail, and an image in a message
  is drawn inside the turn it belongs to. Before this the blocks were dropped on purpose, which was right
  while nothing could draw one and wrong once a screenshot could reach a session: an image-only message
  planned **no entry at all**, so the turn disappeared. Measured across 885 sessions on this machine, 447
  messages carry an image and **all of them are tool results** — so the tool path, not the composer, is
  the one that had to work.
- No extra transfer: Pi's `get_messages` already carries the base64 in the `transcript` frame every
  client parses on connect. What changed is that the block survives the parse.
- **Paste or drop an image into the composer, and send it with the prompt.** ⌘V on a pasted screenshot works with no
  permission prompt, on `127.0.0.1` (a secure context), and matches Pi's own `ctrl+v` binding so muscle memory carries
  over. Dropping a file on the composer works too, and it claims the drop before the browser navigates away and loses
  the draft. A screenshot with no words is a complete prompt — the image is the content — so `Enter` sends it without
  forcing filler text.
- **Images are downscaled in the browser before they leave it.** Downscaling is the only end that can do it: the
  orchestrator receives base64 and cannot re-encode without a decoder it should not grow. The target is Pi's own
  `inputLimits` default of 1568px on the longest edge, so nothing is lost that a model would have used — the difference
  is bytes, not information. A PNG stays PNG so transparency survives; everything else becomes JPEG.
- **Two limits, both stated before sending.** 3 MB per image decoded, and **6 MB encoded in total** for one prompt. The
  second exists because of a measurement: one image at the per-image cap encodes to 4.19 MB, comfortably inside the
  transport's 8 MB frame — and **four of them is 16.78 MB**, so `ws` closes the socket with 1009 and the client gets no
  reply at all. The composer would have emptied itself into a dead connection with no message. A limit on each part does
  not bound the whole.
- **The paste affordance only appears where the choice is real.** `ModelOption` now carries Pi's `input` list, so a model
  that reports `["text"]` does not offer an attachment the provider would reject. An ABSENT list means unknown rather
  than text-only — Pi omitting the field is not a claim — because `unknown → allowed` costs one provider error while
  `unknown → hidden` is a feature that silently does not exist.

- **An `@` in the composer completes file paths, including into subdirectories.** Typing `@` opens a picker of the session's
  files; choosing a directory keeps it open one level down, so `@assets/shot.png` is three keystrokes and two arrows rather
  than a path typed from memory. Accepting a file inserts it followed by a space; `Esc` dismisses the picker for that one
  mention without touching the draft. The listing is the SAME cache the file tree uses, so a directory already expanded in
  the panel costs one lookup rather than a second request.
- **The `@` picker floats above the composer instead of pushing it.** The first version rendered it in the composer's flex
  column, so opening it grew the composer by ~216px: the transcript shrank, everything below the field moved down, and —
  because it sat between the field and the chrome row — the `Enter to send` hint and the auto-follow toggle were pushed
  past the bottom edge of the window. A review named both as blockers. It now uses the same
  `position: absolute; bottom: calc(100% + 8px)` anchor the queue sheet already used, which is the convention that was
  already here. The trade is stated in the code: a floating panel covers the last few lines above it rather than shrinking
  the transcript, and that is better because `scrollTop` does not move — closing it returns the reader to exactly where
  they were.
- **The list scrolls itself to keep the selected row visible.** It is capped at six rows, and nothing tied the selection to
  the scroll — so arrowing past the sixth row moved the highlight to a row outside the box. The picker looked frozen while
  Down kept being pressed, and "what will Enter accept?" had no visible answer. The offset is computed in `mentions.ts` and
  assigned to the list's own `scrollTop`, deliberately NOT via `scrollIntoView`: that scrolls every scrollable ancestor,
  which here is the transcript, so a keystroke in a helper would jump the whole reading area. The row's position is
  measured in the LIST's coordinate space rather than taken from `offsetTop`, which is relative to the nearest positioned
  ancestor — the absolute panel, including its header. That offset cancelled going down and did not going up, which is why
  the first attempt appeared to work in one direction only.
- The `n images sent` note under the composer is gone. The chips vanishing already says the attachments left, and the message
  appears in the transcript with its images one line below — three confirmations for one fact, in permanent screen space. A
  REFUSAL still uses that strip, because a refusal is the one outcome the reader cannot see anywhere else.
- **A prompt sent while idle carried its images into the wrong argument.** The transport built the supervisor call with a
  positional spread — `...(behavior ? [behavior] : []), ...(images.length ? [images] : [])` — which is only correct when
  every earlier optional argument is present. On an idle session (the normal case) `behavior` is absent, so the images array
  shifted left into the `behavior` parameter, nothing reached Pi's `images`, and an empty message was sent: the transcript
  showed an empty Assistant box and the prompt looked like it had not been sent at all. The UI reported success because the
  frame did leave. Found by using it, not by CI — the test fake had been recording a shape that kept the broken call
  plausible, and now records real argument positions.
- The picker is capped at six rows with an internal scroll (eight made it taller than the field it belongs to), carries a
  border and shadow so it reads as a panel rather than the field growing a grey tail, and its header names the directory
  (`in docs`) instead of showing a bare `.`.
- `node_modules/`, `.git/` and `.svn/` are never offered. `.github/` and `.idea/` deliberately still are: the test for
  inclusion is "would a person ever type `@` and mean this", and a blanket hide-dotfiles rule would take the useful ones.
- **Directories are offered before images, which reverses the obvious order.** Measured against this repository's own root: a
  bare `@` offered eight images and not one directory, because the root holds dozens of `img_*.png` screenshots and the cap
  is eight — so `assets/` was unreachable in exactly the case the picker exists for. Images are the reason to FINISH a path,
  not the reason to start one.

### Changed
- A message whose only content is an image now produces a turn. Its blob URL is identified by
  `(session, message, block)` rather than by the planned entry, because the transcript re-plans on every
  streaming record — a URL rebuilt per render would be revoked and recreated dozens of times a second for
  an image that is not changing.
- **An image a message NAMES by path is previewed in that message.** 181 of the 5 912 user messages in this machine's
  store point at a screenshot — `@img_6.png shows the latest screenshot…` — and until now that rendered as literal text
  while the picture appeared only if the agent happened to `read` it later, inside a collapsed activity group. The
  reference and the referent were in different places with a disclosure between them. Detection is conservative (four
  extensions, relative paths only, no URLs, no `..`, at most three per message) and the bytes come from the
  orchestrator's existing confined `readFile`, so no new trust surface was added. A referenced image is capped at 12vh
  and expands on click: it is an annotation of a sentence, not content, and at turn size one `@` mention of a 4000px
  screenshot would push the next two turns off the screen.
- **A turn's images are budgeted, not just capped.** The first image of a message gets 40vh and every one after it 18vh,
  which turns five pasted screenshots from 2.2 screens into about 1.1. The flat 40vh per image was wrong in a way only
  arithmetic shows.
- `Turn` in the transcript is memoized by an explicit comparison. Its props included a freshly allocated
  entry object, so `memo` had never once short-circuited; that was invisible for headings and text, and
  is not invisible for images.
- An image type outside PNG/JPEG/GIF/WebP, or a payload with no data, is **stated** rather than omitted.
  "This view cannot draw a TIFF" and "this message held no picture" are different facts, and the transcript
  does not report the second while meaning the first.

### Fixed
- **A turn was left half-visible when an image arrived, until the agent started working.** Following ran in a
  per-render effect, and a render is not when an image gets its height: React writes the DOM, the browser lays out an
  `<img>` that is still decoding — zero height — and the follow scrolled to an end that was about to move down by 12vh.
  Nothing ran again until the first streaming delta, which is why the pane jumped to the bottom only once the assistant
  replied. A `ResizeObserver` on the transcript lane now follows any height that arrives after paint, which covers the
  same class for lazy images, expanding disclosures and asynchronously highlighted code.

### Protocol 4 → 5
- **`Control.prompt` carries optional `images`, and `ModelOption` carries `input`.** Both are ADDED FIELDS rather than new
  wire kinds, which means `packages/protocol/test/wire-surface.test.ts` does **not** fail for either — that test
  fingerprints kinds, not bodies. The bump is therefore not optional: a v5 UI against a v4 orchestrator would offer the
  paste affordance and every paste would arrive as a prompt with no image, with the model answering "I don't see any
  image" and no error anywhere.
- The wire spelling is `{ mediaType, data }` rather than Pi's `{ type, data, mimeType }`, because `type` is the
  discriminant of every record on this wire and reusing it inside a payload makes a log ambiguous. The supervisor maps
  one to the other at the single point where a control becomes Pi's stdin.

### Tooling
- `scripts/render-session-html.mjs` renders a real session's transcript to one self-contained HTML file, for review
  without an orchestrator, a browser automation harness, or a sandbox escape. It exists because the agent that wrote
  the image support could not run the product (C1 stops an orchestrator inside a sandbox, and a headless browser hits
  the same wall), which left the change with passing tests and nobody having seen it. `node
  scripts/render-session-html.mjs` picks the newest session containing an image; `--out` chooses the file.

## [0.6.1] — 2026-11-01

A PWA fix. If you installed Pi Central to the dock before this version, **it will need one clean start** to pick it
up — see below.

### Fixed

- **An installed Pi Central kept loading the old version after an upgrade.** The service worker cached every
  same-origin request that was not the app document, including `manifest.webmanifest` and the icons — all of which the
  server deliberately serves `no-cache` because they are not fingerprinted. It now caches only `/assets/`, the one kind
  of path whose name changes with its content, as an allow-list rather than a deny-list.
- The worker's cache is renamed, so an existing installation drops the stale entries on the next launch instead of
  carrying them forward. Editing the worker alone could not do this: the cleanup only removes caches whose name has
  changed.

**If your dock app still shows an old version after upgrading**, unregister the worker once from its devtools console
and reload:

```js
const regs = await navigator.serviceWorker.getRegistrations();
await Promise.all(regs.map((r) => r.unregister()));
const keys = await caches.keys();
await Promise.all(keys.filter((k) => k.startsWith("pi-central-")).map((k) => caches.delete(k)));
location.reload();
```

Quit and relaunch the dock app afterwards. This is needed only once, and only for installations created before 0.6.1 —
a cache written by the old worker cannot be repaired from the server side, because the old worker is what answers the
request for the new one.

## [0.6.0] — 2026-11-01

A workspace rework, driven by a series of screenshot reviews. The structure was right; the proportions and
the repeated chrome were not.

**No protocol change**, so a UI and an orchestrator from 0.5.0 still work together — but the workspace is
substantially different, and the notes below are worth reading even if you only ever use one session.

### Changed

- **One workspace header.** Session identity, a context meter (amber past 80%), cost, and the model pickers —
  where there were three full-width strips and a `Usage` disclosure that broke the row it lived in.
- **A session header that belongs to the transcript.** It docks beside the prose on a wide window and becomes
  a compact row when the container is narrow. A container query, not a viewport one: an open panel leaves a
  wide window holding a narrow transcript.
- **The transcript is centred, as one lane**, at a default measure of 80ch. Centring was tried before and
  reverted for five defects; the cause was centring each CHILD, so a tool marker and a paragraph landed on
  different centres. The lane is now one box that everything fills.
- **The composer is the transcript's foot**, sharing that lane and its left edge, with no band of its own.
  `auto-follow` is a switch in its chrome row, Enter sends, and the field is a fixed three lines that scrolls
  rather than growing into the conversation. The Steer/Follow-up strip is gone: the destination is the key
  (`Enter` steers, `Alt+Enter` queues for after the run).
- **Queued prompts are a bounded rail plus a sheet.** The rail shows at most one row per kind, so the dock's
  height no longer depends on the count; the sheet (`Alt+Q`) has the room. Steering and follow-up are told
  apart three ways — a `now`/`then` gutter, order with a ruled divider, and a solid vs dashed edge — because
  colour is never the only carrier.
- **A run of internal work is one activity group.** Thinking and tool calls between two spans of prose collapse
  into one disclosure with a ledger inside, instead of a bar per step under a repeated `Assistant` heading.
- **The trace is a panel tab**, not a strip between the transcript and the composer. Rows carry an index and an
  identifier that survives truncation; the detail pane has a fixed height the reader can drag, so traversing
  calls no longer resizes it; and the list is ordered by a control rather than by position.
- **The rail ranks instead of listing facts.** Selection is distinguishable from hover, New session is no
  longer the brightest surface in the window, and rows carry only what changes a decision.
- The README leads with what it does and who it is for, states its requirements, and puts Quick start above
  the explanation. The architecture diagram is now an SVG that follows the reader's theme and shows the
  sandboxes as separate frames; the nine principles moved to [docs/PRINCIPLES.md](docs/PRINCIPLES.md).

### Fixed

- The model picker no longer shows a standing note about when a change applies — it was true and unhelpful, and
  it sat in the header permanently for any streaming session.
- Choosing a model the first time shows the whole list instead of one placeholder entry. A native `<select>`
  builds its popup at mousedown and never re-renders it, so fetching then produced an empty list and the
  catalogue landed in the closed control; the picker now asks first and opens once there is something to show.
- A window narrower than the rail's breakpoint had no way to reach the session list at all. The workspace track
  could not shrink below its content, so the transcript was pushed off-screen and the narrow rules never
  applied; the rail is a drawer now, and the track is `minmax(0, 1fr)`.
- `Jump to latest` was drawn above the band reserved for it, so it floated over the last paragraph and the text
  wrapped around it.
- The composer's selected segment used `var(--accent-ink)`, a token nothing declared — about 2.4:1. Anything
  that sets a colour to an undefined token is now a test failure.
- A partially known queue discarded its known messages: the flag was all-or-nothing, so one message out of
  three rendered nothing.

## [0.5.0] — 2026-10-31

Increment 4, and the first release with a session roster that survives a restart.

**One protocol change.** `PROTOCOL_VERSION` 3 → 4. A UI and an orchestrator on different versions now refuse
cleanly instead of misbehaving, so **reload the page after upgrading** — an older UI will not offer actions the
newer orchestrator has, and vice versa.

### Added

- Retry a failed session from the rail ([#11]).
- The session roster survives a restart, an update, or a crash, and a stopped session resumes when you send to it ([#89]).
- Rename a session by double-clicking its name in the header ([#78], [#79]).
- Every install carries a provenance attestation, and the README says how to check it ([#157], [#158]).
- `npm audit signatures` in the install path, and `npx` marked as the unverifiable route ([#157], [#158]).

### Changed

- Tool output is inline in the transcript, with one bar per call ([#131]).
- A long transcript no longer slows switching or streaming; revisiting a session is instant ([#151]).

### Fixed

- The session you start or resume becomes the active one ([#144]).
- Thinking blocks say when they are still thinking, and show a one-line gist ([#143], [#146]).
- A tool call reads louder than the reasoning about it ([#144]).
- Settings: two panes, a preview that shows the setting, and a reset to defaults ([#142]).
- Following survives a session switch, and a restore only applies when you had scrolled away ([#141]).
- Resume works beyond the newest 500 sessions ([#153]).
- Session names follow one rule, so a restart does not rename them ([#89]).
- History shows a rename immediately, including for sessions over 256 KB ([#164]).
- The active provider is shown beside the model, not hidden in the dropdown ([#163]).

## [0.4.1] — 2026-10-29

A hotfix for one behaviour: **returning to a session you were following left you at the top of the
transcript.** Three mechanisms had to be corrected, and they were found in sequence rather than at once:

1. `decideOnSessionChange` restored a stale offset *and* the follow flag, so the offset won.
2. The scroll listener wrote the session's position on **mount**, when the pane has content but no position
   yet — overwriting the real offset with `scrollTop: 0`.
3. That same mount measurement set `pinnedRef = false`, overriding the decision to follow **before the follow
   effect ran**. This is the one the reporter confirmed fixes it.

The first two are defensible on their own mechanism and may be defence-in-depth rather than load-bearing;
the third is the one with a confirmed effect. Saying so is more useful than claiming all three were
necessary.

## [0.4.0] — 2026-10-29

Developer-loop fixes and the last of Increment 2.

### Fixed

- `~/.ssh` is denied wholesale, not by key name ([#46], [#47]).
- Images display: `img-src 'self'` does not cover `blob:` ([#111]), and `<img>` was rendered before it had a source ([#108]).
- The CSP comment claiming a blob URL counts as `'self'` was false, and is gone ([#111]).
- The dev loop can say which build is running ([#114]).
- The transcript and composer are held to one line without centring it ([#92], [#132], [#133]).
- A binary file refusal names the file's size ([#9]).
- The README said the package was not published; it has been on npm since 0.2.0 ([#127]).

### Changed

- A one-time warning when a session points at Pi Central's own installation ([#25]).
- The dev proxy no longer prints a stack trace for a normal disconnect ([#114]).

## [0.3.0] — 2026-10-27

Increment 2, mostly the transcript after being used in anger.

### Added

- Tool output opens inline in the transcript, with one bar per call ([#131], [#136], [#137], [#139]).
- The transcript can be told never to scroll itself, and following survives a session switch ([#86], [#141]).
- Reading position is kept per session, and sending a prompt re-arms following ([#86], [#141]).
- Your own prompts are distinguishable from the agent's prose at a glance ([#88]).
- The right panel is collapsed by default, and the panel width is yours ([#75]).

### Changed

- A colour-and-legibility sweep from looking at a screenshot ([#74]).
- The trace's nested scroll regions are marked as such ([#73]).

### Fixed

- The model picker painted over the `Thinking` label ([#96]).
- The `auto-follow` / `markers` toggles were unreadable in their inactive state ([#98], [#100]).
- The copy-path button said "Copy copy path changelog.md" ([#72]).
- The file viewer no longer forces long lines into a horizontal scrollbar ([#73]).
- A release design note claimed a registry guarantee that does not exist ([#66]).

### Removed

- The centred transcript measure from [#92], reverted after five downstream defects ([#132], [#133]).

## [0.2.0] — 2026-10-26

The first release you could install, and a product identity.

### Added

- Pi Central is a package, not only a checkout ([#52], ADR-0011).
- A release workflow with one version source, a tag, a GitHub Release and a provenance-attested publish ([#53]).
- Releases are staged, and a maintainer approves them ([#65]).
- A Settings surface: which build is running, and where it keeps things ([#58]).
- A read-only file tree confined to the session's working directory ([#8], ADR-0007).
- The transcript's text size and line length are the reader's to set ([#134]).
- A favicon, a topbar mark and a README banner ([#115]); the app installs to the dock as a standalone window ([#119]).
- A screenshot of the real dashboard in the README, with alt text describing what it shows ([#7]).
- Safari's Add to Dock uses the logo, not a screenshot — it ignores manifest icons ([#124]).
- Images open in the file browser: PNG, JPEG, GIF, WebP and SVG ([#106]).
- The orchestrator serves the built UI, so one process and one URL.
- The model picker ([#1]) and the thinking-level picker ([#2]), the latter constrained by the model.
- `steer`, follow-up, and Esc that returns what it cleared ([#3]).
- Fenced code is syntax-highlighted, lazily ([#4]).
- Compaction and retry banners ([#5]).
- A resume flow for a historical session, in its own recorded directory ([#10]).

### Changed

- The right pane became a panel with modes and a resizable edge.
- The rail orders by attention, and history lives in its own pane.
- The first publish is a manual bootstrap, and it is guarded ([#61]).

### Fixed

- Clicking a session in the rail did nothing ([#40]).
- The model picker truncated from the end, losing the identifying part of the name ([#42]).
- The quarantine legend described a hatch that no longer existed ([#43]).
- Agent commits were never signed ([#27]).
- The protocol version was not bumped when the wire changed ([#8], follow-up).

### Security

- The agent credential store is checked for usability at session start ([#28]).
- Sessions are sandboxed through a composed Safehouse profile, and the boundary is tested ([#46]).
- The Content-Security-Policy is sent as an HTTP header as well as a `<meta>` tag.
- The static handler refuses any request target resolving outside the served root, and allows `GET`/`HEAD`
  only, with `X-Content-Type-Options: nosniff` on every response.

## [0.1.0] — first iteration

The spike that answered whether this was worth building.

- A session orchestrator: discovery by parsing Pi's session files directly, and per-session Safehouse profiles.
- Agent credential identity: agents act as themselves, with an agent-owned keychain and git config (ADR-0010).
- A WebSocket transport over loopback, refusing to start inside a sandbox (C1).
- A UI: an attention-ordered session rail, live transcript reconstruction, and an approval dock.
- An untrusted-rendering pipeline: `markdown-it({ html: false })` → DOMPurify → React (ADR-0006).
- Documentation as a first-class artifact: constraints C1–C15, ADRs, and protocol notes.

### Fixed

- Denying `~/.pi/agent/auth.json` made every sandboxed session exit `1`, because Pi opens it at startup.
- The keychain grant derived from the agent tree rather than from the provider configuration.
- A resumed session rendered an empty transcript.
- One tool call produced two trace rows, colliding as React keys.
- A cached transcript was replayed on reconnect, overwriting a correct one with a stale copy.
- Tool calls were appended after the conversation instead of interleaved.
- A page size was shown as a session total, a process handle as Pi's session id, and a permission error as a
  missing directory.

### Known limitations

- No file navigation; `steer`, follow-up and Esc-clears-and-returns were added above.
- No syntax highlighting and no compaction or retry banners.
- macOS only — Safehouse has no Linux backend (C10).
- No screenshot of the running UI, because the author's environment cannot launch one (C1).

[#1]: https://github.com/sven1103-agent/pi-central/issues/1
[#2]: https://github.com/sven1103-agent/pi-central/issues/2
[#3]: https://github.com/sven1103-agent/pi-central/issues/3
[#4]: https://github.com/sven1103-agent/pi-central/issues/4
[#5]: https://github.com/sven1103-agent/pi-central/issues/5
[#7]: https://github.com/sven1103-agent/pi-central/issues/7
[#8]: https://github.com/sven1103-agent/pi-central/issues/8
[#9]: https://github.com/sven1103-agent/pi-central/issues/9
[#10]: https://github.com/sven1103-agent/pi-central/issues/10
[#11]: https://github.com/sven1103-agent/pi-central/issues/11
[#25]: https://github.com/sven1103-agent/pi-central/issues/25
[#27]: https://github.com/sven1103-agent/pi-central/issues/27
[#28]: https://github.com/sven1103-agent/pi-central/issues/28
[#40]: https://github.com/sven1103-agent/pi-central/issues/40
[#42]: https://github.com/sven1103-agent/pi-central/issues/42
[#43]: https://github.com/sven1103-agent/pi-central/issues/43
[#46]: https://github.com/sven1103-agent/pi-central/issues/46
[#47]: https://github.com/sven1103-agent/pi-central/pull/47
[#52]: https://github.com/sven1103-agent/pi-central/issues/52
[#53]: https://github.com/sven1103-agent/pi-central/issues/53
[#58]: https://github.com/sven1103-agent/pi-central/issues/58
[#61]: https://github.com/sven1103-agent/pi-central/issues/61
[#65]: https://github.com/sven1103-agent/pi-central/issues/65
[#66]: https://github.com/sven1103-agent/pi-central/issues/66
[#72]: https://github.com/sven1103-agent/pi-central/issues/72
[#73]: https://github.com/sven1103-agent/pi-central/issues/73
[#74]: https://github.com/sven1103-agent/pi-central/issues/74
[#75]: https://github.com/sven1103-agent/pi-central/issues/75
[#78]: https://github.com/sven1103-agent/pi-central/issues/78
[#79]: https://github.com/sven1103-agent/pi-central/issues/79
[#86]: https://github.com/sven1103-agent/pi-central/issues/86
[#88]: https://github.com/sven1103-agent/pi-central/issues/88
[#89]: https://github.com/sven1103-agent/pi-central/issues/89
[#92]: https://github.com/sven1103-agent/pi-central/issues/92
[#96]: https://github.com/sven1103-agent/pi-central/issues/96
[#98]: https://github.com/sven1103-agent/pi-central/issues/98
[#100]: https://github.com/sven1103-agent/pi-central/issues/100
[#106]: https://github.com/sven1103-agent/pi-central/issues/106
[#108]: https://github.com/sven1103-agent/pi-central/issues/108
[#111]: https://github.com/sven1103-agent/pi-central/issues/111
[#114]: https://github.com/sven1103-agent/pi-central/issues/114
[#115]: https://github.com/sven1103-agent/pi-central/issues/115
[#119]: https://github.com/sven1103-agent/pi-central/issues/119
[#124]: https://github.com/sven1103-agent/pi-central/issues/124
[#127]: https://github.com/sven1103-agent/pi-central/pull/127
[#131]: https://github.com/sven1103-agent/pi-central/issues/131
[#132]: https://github.com/sven1103-agent/pi-central/issues/132
[#133]: https://github.com/sven1103-agent/pi-central/pull/133
[#134]: https://github.com/sven1103-agent/pi-central/issues/134
[#136]: https://github.com/sven1103-agent/pi-central/issues/136
[#137]: https://github.com/sven1103-agent/pi-central/pull/137
[#139]: https://github.com/sven1103-agent/pi-central/pull/139
[#141]: https://github.com/sven1103-agent/pi-central/pull/141
[#142]: https://github.com/sven1103-agent/pi-central/issues/142
[#143]: https://github.com/sven1103-agent/pi-central/pull/143
[#144]: https://github.com/sven1103-agent/pi-central/issues/144
[#146]: https://github.com/sven1103-agent/pi-central/pull/146
[#151]: https://github.com/sven1103-agent/pi-central/issues/151
[#153]: https://github.com/sven1103-agent/pi-central/pull/153
[#157]: https://github.com/sven1103-agent/pi-central/pull/157
[#158]: https://github.com/sven1103-agent/pi-central/pull/158
[#163]: https://github.com/sven1103-agent/pi-central/issues/163
[#164]: https://github.com/sven1103-agent/pi-central/issues/164
