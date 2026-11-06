# ADR-0012 — The directory chooser: a placed browser instead of a native dialog

- **Status:** Accepted
- **Date:** 2026-11-05
- **Amends:** [ADR-0007](0007-filesystem-access-model.md) (a second filesystem capability, with its own boundary)
- **Closes the decision in:** issue #76

## Context

Opening a session in a target directory was the product's worst moment. Two rounds of work already
took the sharpest edges off it: the recent-directory list made a directory you had used before **one
click** (#149), and a directory that is gone or unreadable is now marked rather than hidden or
silently refused (#196). What was left is the case neither answers:

> A project I have **not** opened in Pi Central before, whose path I do not want to recite.

The original report is precise about the loop that costs: *"users need to manually remember and type
an absolute path, which forces user to open a terminal and navigate to the target directory in order
to get the path, which they then need to copy manually."* That loop survives for a new project. It is
not fixed by a longer recent list, because the directory has never been used.

### Why the browser cannot supply the path (the full answer is below)

The product is a **browser UI over a loopback WebSocket** ([ADR-0005](0005-typescript-stack.md)). A web
page *can* open the OS's own folder panel — that is what an upload dialog is — but it cannot learn the
absolute path of what was chosen. `webkitRelativePath` is relative to the chosen root by design, and
a `FileSystemDirectoryHandle` exposes no path at all. Since `cwd` must be absolute, the browser's
picker cannot answer this question at any price.

The server-side alternative (`osascript`) *does* work and is **rejected on cost, not feasibility** —
see [the alternatives](#alternatives-considered), where the reopening condition is also stated.

So the choice was never "native panel or not". It was: **build the capability in the orchestrator, or
leave the requirement unmet.**

## Decision

**The orchestrator reads directories for the chooser, in a second capability with its own boundary,
and the UI presents places — a fixed set of roots, one level at a time.**

Concretely:

- `packages/orchestrator/src/places.ts` lists the **directories** inside a path, and nothing else.
- Every request is resolved against the roots `placesFor(home)` derives from `$HOME`; a path inside
  none of them is refused, without touching the disk (`resolveInPlaces`).
- The roots are **computed, not configured**: `$HOME` plus `git`, `Projects`, `src`, `dev`, `Code`,
  `work`. Nothing to keep in step, nothing to migrate, and a root that does not exist is *reported*
  rather than hidden.
- The wire gains one control (`listPlaces`) and three events (`places`, `placeListing`,
  `placeError`) — protocol **8**. A UI that speaks an older version does not render the pane at all,
  which is the honest failure: an empty pane would claim the machine has no folders.
- The sheet keeps the text input, and completes it (`packages/ui/src/complete.ts`): a typed `~/git/pro`
  offers the directories with that prefix, from the recent list and from the listing already cached.
  `~` is expanded at submit and the expanded form is **shown** before submission.

### The boundary, stated as an addition rather than as an exception

This is a genuine capability increase over `files.ts`. `files.ts` is confined to a session's `cwd`,
and that confinement is the whole of #8's safety story; here, by construction, the reader is choosing
a directory **no session owns yet**. ADR-0007's reasoning still holds — the orchestrator acts at the
user's UID, for the person, and is not the thing executing model output — so this does not need a new
trust model. It needs a narrower one:

1. **Directories only, names only.** No file contents, no reading of files, no sizes, no spawning. There
   is no `readFile` in this module and adding one would be a different decision.
2. **A closed set of roots.** Not "any absolute path": a path outside the places is refused before any
   filesystem call, so the control cannot become an arbitrary-directory-listing service for any local
   process that can reach the socket (C5).
3. **One gatekeeper.** Containment is `resolveInPlaces`, called by `listPlace`, and both the resolver
   and the listing are tested as refusals. Containment is compared by **path segment**
   (`containsPath`'s rule), because `/Users/x/git` is not a prefix of `/Users/x/gitlab` — the exact bug
   this repository already shipped once (`own-installation.ts`, #25).

### What it is not

It is not a file dialog and must not be presented as one. It offers seven folders and their children.
A path outside them is typed, not browsed, and the text input remains the complete route — the chooser
is an accelerator over the same `onOpen`, so the orchestrator's own validation (existence, #25's
self-hosting hazard, #49's root check) stays the only answer to "may I work here".

## Consequences

**Positive**

- A project you have never opened is two or three clicks, with no terminal and no copy-paste.
- No new process, no new dependency, no desktop shell. The capability is ~200 lines over `node:fs`.
- One errno vocabulary (`fs-error.ts`), shared with `files.ts`, so `EACCES` says the same thing on
  both surfaces.
- A missing or unreadable folder is *stated* — the same distinction #196 fixed for History.

**Negative**

- **The orchestrator can enumerate the user's home tree.** It already could read it (ADR-0007), so the
  privilege is unchanged; what is new is an affordance that surfaces it to a browser tab. Any local
  process reaching the loopback socket could enumerate the same seven roots. That was already true of
  `listFiles` for any session's cwd; C5 says loopback is not a security boundary, and this does not
  pretend otherwise.
- One more surface to keep small. The guard is the shape of the module, not a review checklist: it
  imports `readdirSync`/`statSync`/`realpathSync` and nothing that writes.
- The roots are a guess about where people keep code. Someone whose projects live under `/Volumes` or
  `/opt` types the path — which is what they did before, so nothing regressed, but the chooser does not
  reach them.

## Alternatives considered

### The browser's own directory picker — tested, and it cannot work (verified 2026-11-06)

This is the obvious first choice, and it is worth stating *why* it fails rather than quoting a
principle, because the answer is narrower than "a web app may not do that".

**A native directory dialog can be opened from the page.** `<input type="file" webkitdirectory>`
opens the OS's own folder panel, and it is what ordinary web apps use for uploads. Any web app can do
that today. What a browser does not hand back is the one thing `cwd` needs:

| Route | What comes back | Why it cannot feed `cwd` |
|---|---|---|
| `<input webkitdirectory>` | `File` objects whose `webkitRelativePath` is **relative to the chosen root**, e.g. `proj/src/a.ts` | The root's own absolute path is never revealed — that is the fingerprinting defence, and it is not configurable. `cwd` needs the absolute path, or nothing. |
| `showDirectoryPicker()` | a `FileSystemDirectoryHandle` with `.name` and nothing else | Chromium-only; Firefox and Safari **oppose** it (Safari cites security), and it is absent from the Safari standalone window this project recommends (#119). The handle's path is withheld for the same reason. |
| `navigator.storage` / `launchQueue` `LaunchParams` | a handle, on Chromium + installed PWA only | Same opacity, plus an install requirement. A "file handler" is about *opening* a file, not about telling the server where it lives. |

So the picker is not missing from the web platform — **it is the one thing the platform deliberately
will not answer.** The workarounds are all the same workaround: upscale the *selected contents*, which
is an upload, and an upload cannot become a working directory.

### Server-side native panels — a decision, not a blocker

`osascript -e 'choose folder'` on macOS **does work**: it returns a POSIX path on stdout, and a cancel
is distinguishable from a failure (AE `-128`), which is the distinction C14 requires. Verified here
only to the extent this environment allows: in the agent sandbox it fails with
`Connection Invalid error for service com.apple.hiservices-xpcservice` (**C1** — no XPC access to the
GUI services), which is evidence about *this* shell and not about a user's terminal.

It is rejected on **cost**, not feasibility:

- It would be the product's **first OS-specific code path** — a platform dependency for a dialog, on a
  feature whose baseline already works in the recommended Safari window.
- It needs a blocking round trip on a transport that has none: a panel stays open until a human acts,
  so the request needs a timeout, a cancel path, and a distinct cancelled answer, or a dismissed panel
  leaves a browser waiting with no way to resolve it.
- It is untestable where this project's tests run (C1, both in CI and in an agent shell), so it can
  never be `verified/auto` — only a manual claim.
- `osascript` is a general AppleScript interpreter, so adopting it means adopting "interpret this
  script" as an orchestrator power, needing the same single-argv-site guard `policy.ts` has.

**Reversible, and the reopening condition is stated:** a native panel is worth its cost only if the
in-app chooser proves insufficient **in use** — which is a measurement, not a prediction. The natural
shape if it ever happens is an optional accelerator that is offered only where the platform can answer,
refuses loudly where it cannot, and passes its result through the same `start` control so nothing is
validated twice.

### Other shapes

**A desktop shell (Tauri/Electron).** Rejected: it supersedes ADR-0005's stack decision and
ADR-0011's "one npm artifact", for one dialog. The cost is a second runtime, a second updater, and a
second signing story.

**Drop the requirement.** Rejected as the outcome, and it is what the status quo amounts to. The
recent list is the right answer for a directory you have used; it is no answer at all for a new one,
and that is the case the report describes.

**A configurable project list (Q4's "curated projects").** Rejected *for this slice*: it introduces
state that must be kept valid (a list that can name directories that no longer exist) before the
simplest thing — read the folders that are actually there — has been tried. If a curated list is ever
wanted, it is a second source of roots for the same pane, not a different design.

**Fuzzy path matching for completions.** Rejected: it ranks `~/git/portfolio` above `~/git/project`
for `pro`. A prefix match on the entry name is what a filesystem path expects.

## Verification

- `places.test.ts` — the resolver refuses a prefix-named sibling, `/etc`, `/`, a relative path and a
  NUL byte; a listing offers directories only, sorted, dotfiles off by default; empty is a success and
  `ENOENT` is `not-found` with its code; `parent` is absent at a root; the most specific root wins.
- `complete.test.ts` — `~/git/` asks to look *inside* `git`; matching is on the entry name and is a
  prefix match; a recent directory under a different parent is not offered; duplicates collapse;
  suggestions are absolute or not offered at all.
- `transport.test.ts` — `listPlaces` reaches `places.ts` (an unlisted kind answers `bad control:
  unknown kind 'listPlaces'`); a refusal is `placeError` with the errno, never an empty listing; a path
  outside the places is refused by the route.
- `chooser.test.mjs` — the pane renders roots, states absent ones, appears between the recents and the
  input, shows the expansion of a `~` before submission, and is **absent** against an orchestrator that
  predates it.

Falsified by: removing `resolveInPlaces`' containment check (the `/etc` and sibling assertions fail),
and by reporting a failed listing as an empty one (the `placeError` routing test fails).

## Amendment 1 — the first chooser was not navigable (issue #76, after a screenshot review)

The decision above stands. What it produced did not, and the review's verdict was blunt: *"not fit to
be the only way to pick a directory — and the fix is restructuring, not restyling."* The full review is
[docs/ui-reviews/directory-chooser-review.md](../ui-reviews/directory-chooser-review.md); this records
what changed and why, because "we built a browser" was true of the version that failed.

**The shape was wrong.** A recent list, three root rows and a path field is not a browser: no parent
navigation, no filtering, no icons, no dates, no sort, and no way to tell that a click descends rather
than launches. It is now a **two-pane file dialog** — places rail, filterable listing — because that
layout exists precisely because this problem is hard.

**Every finding, answered:**

| Finding | Now |
|---|---|
| No up/back navigation | Crumb with every segment clickable, plus an explicit **Up** |
| No type-to-filter | A filter box over the listing, autofocused |
| No row affordance; a click's meaning is ambiguous | Folder icon, aligned age column, chevron, hover, and a separate primary button |
| No dates, no sorting | Relative age per row, and a Name/Recent toggle |
| A three-item menu is not a rail | A real places rail, with an icon per place |
| A used-before row launched an irreversible action on one click | Descending never starts anything; only "Use this folder" does |
| `git~/` on the right | `direction: rtl` removed — it reversed the line's run order |
| Two stacked scrollers in a narrow column | One scroller; the rail and the footer are fixed |

**Two things the review could not have asked for, and the reporter did:**

1. *"Don't let them start from the default again, pick up the last directory."* The chooser now resumes
   where it was left (`chooser-prefs.ts`, `localStorage`). It is **verified before use**: a remembered
   path under a place that is gone, or a directory that has itself been deleted, degrades to opening at
   `Places` rather than to a listing that errors before the reader touches anything. That second check
   was a bug — `$HOME` exists on every machine, so checking only the *place* let a deleted
   `~/Projects/notes` through.
2. **The metadata this needed** was not on the wire. `PlaceEntryInfo` gained `mtimeMs` and `isEmpty`,
   which is still metadata *about directories* and so still within ADR-0012's boundary — `files.ts`
   remains the only reader of file contents. Emptiness is one `readdir` of one entry, not a full scan.

**What this says about the process, since the project is explicit about it.** Every one of these was
found by a human looking at a screenshot after a green test suite. The tests asserted *content* — a row
exists, a class is present — and none asserted *geometry or affordance*, because Chromium cannot run in
the development sandbox (C1). That is the gap `verified/manual` exists to name, and this is now the
second time on this issue that looking at it found more than the suite did.

## Amendment 2 — one rail, and a dialog that fills the window

A second screenshot showed the two-pane version was still too small: a 720px-wide dialog whose right pane was
mostly empty, because the recents were a strip stacked *above* the browser, so three vertical regions shared
one column and the listing — the thing being browsed — got the leftovers. Four visible folders in a 900px
dialog.

The reporter proposed a rail with **Recent** and **File system** entries. That is the right shape and it is
what shipped, with one refinement: "file system" is not the second group, because ADR-0012 deliberately does
not browse the filesystem — it browses a closed set of **places**. So the rail's groups are *used before*
(a destination: clicking starts a session there, marked by a session count) and *places* (a location: clicking
browses it, marked by a chevron on its rows). Two kinds of move, one column, labelled.

Three consequences worth recording:

- **The dialog is now measured rather than shrink-wrapped**: `940px` wide and `680px` tall, both capped against
  the viewport. A file dialog is one of the few surfaces where "as large as the window allows" is correct —
  the reader is doing a spatial search, and every extra row is one fewer scroll.
- **The badge is `170×`, not `170 sessions`.** At 200px of rail the long form squeezed the folder name, which is
  the thing being scanned. The evidence is kept; the words are in the tooltip.
- **"Not on this machine: 3 places"** replaced a comma-separated list that wrapped to four lines and took a
  third of the rail. Stated, never hidden — the title still lists every absent place.

## Amendment 3 — one commit target, and why the two inputs competed

Reported from a third screenshot, as two observations that turned out to be one defect:

> *"the button to choose the directory selected in the directory picker is ill placed. Why not on the bottom right,
> like 'Open'. I am also worried about the competition of the manual path textfield and the selection, that users
> get confused."*

Both are right, and both came from **two independent commit paths** in one dialog:

| Control | Committed |
|---|---|
| `Use «folder»` (inside the listing) | the folder the browser had navigated to |
| `Open here` (a form submit) | the **text field** |

The consequences were not cosmetic:

1. **Enter did the wrong thing.** The field is autofocused and inside the `<form>`, so pressing Enter committed
   whatever it held — which, after browsing and not typing, was `""`. The button that reads as the dialog's OK
   button silently depended on having typed.
2. **"Open here" was false in the browse case.** It said "here" while meaning "the text field"; a reader who had
   selected a folder and pressed it was told to enter an absolute path.
3. **Two primaries, neither the dialog's outcome.** A filled control in the middle of the listing and a bare one at
   the bottom, both starting a session.

**The fix is a rule, not a restyle: the text field is an INPUT to one selection, not a competing source of truth.**

```
effectivePath = typed !== "" ? expand(typed) : (browsed ?? resumed)
```

Typed text wins — a reader who typed has explicitly overridden the browser — otherwise the browsed (or resumed)
folder. One `Open` commits `effectivePath`, at the **bottom right**, with `Cancel` to its left, which is where every
OS file dialog puts its outcome. Enter commits the same thing, because Enter submits the same form.

Two supporting changes, both about not making the reader infer the rule:

- **The dialog states what will be opened**, one line above the button (`Selected …` / `Opening …`, with the
  expanded path in mono). That line is the whole answer to "do these two inputs compete": they do not, and the
  dialog shows which one won.
- **A `Clear` control** appears when the field has text. Without it there is no way back from a typed override: a
  reader who typed and changed their mind would have to select and delete the text, and clicking a folder would look
  broken because it no longer changed what Open would use.

**One defect the tests caught while doing this**: the picker resumes *inside* the remembered folder, but the sheet's
selection was only set by navigation — so opening the sheet and pressing Open without moving gave a **disabled**
button while a folder was plainly on screen. The selection now falls back to `resumed`.

The "used before" rows in the rail still commit directly, and that is the one deliberate second path: a recent row
names its directory explicitly, so there is nothing for it to disagree with.

## Amendment 4 — nothing takes focus on open

> *"The textfield shall only be active when the user actively clicked into it, not by default when the dialog opens."*

Correct, and the autofocus was the last surviving piece of the design that caused Amendments 1–3.

A focused field is a claim about primacy: it says the caret belongs there, so this surface is for typing. It is not.
**Browsing is the primary act and the field is the alternative** for a path you already know — which is why its
placeholder reads *"Or type an absolute path"*. Two focus calls were removed:

| Was focused | Why it was wrong |
|---|---|
| The sheet's path field | Said "type here" about a dialog whose job is to be browsed — and it was the mechanism behind the Enter bug: an autofocused field inside a `<form>` means Enter commits it, so pressing Enter after browsing committed an empty string. |
| The listing's filter (at `Places`) | The same mistake in a second place. A filter is reached for when a folder is not already on screen; it does not deserve the caret before you have looked. |

What receives focus instead is **the dialog itself** (`tabIndex={-1}`): the focused element is the surface, not a
control in it. That keeps Escape working without a click, keeps a keyboard reader inside the dialog rather than at
the top of the document, and — because it is only ever focused programmatically — paints no ring.

Focus still moves to the **heading** when the reader navigates, which is a different case: there the content changed
under them, and announcing that is what a focus move is for.

## Amendment 5 — home is the default, and looking is not choosing

> *"Please make the users home folder the default one. I don't know from where this project folder is coming from."*

Both halves were the same bug, and it was mine, from Amendment 1.

**Where the folder came from.** `lastDirectory` was written whenever the reader **descended** — `onNavigated`, fired
on every row click. So *looking inside* `~/git/data-management` once made it the place the picker opened from, for
good. Nothing about looking at a folder says "start here", so the value could only ever appear from nowhere, which is
exactly how it read.

Fixed in two places, because there were two:

1. **The writer.** Persistence now happens in exactly one circumstance — `onOpenDirectory`, i.e. a session was
   actually started there. That is the only moment a preference about "where to begin next time" has been expressed,
   and the only moment a reader would be surprised to start somewhere else. `onNavigated` still exists, because the
   sheet needs the browsed folder as its *selection*, but it no longer persists anything.
2. **The value already stored.** Fixing the writer would leave the bad value in the reporter's `localStorage` — they
   would refresh, open the picker, and see the same unexplained folder. Stored preferences now carry a `version`; a
   versionless value was written by the buggy release, so its `lastDirectory` is **dropped** while `sort` and
   `showHidden` (never affected) migrate. Discarding those would punish the reader twice for one defect.

**What the default is now** (`openingDirectory`):

| Priority | Value | Why |
|---|---|---|
| 1 | the directory a session was last **started** in | the earlier requirement — *"pick up the last directory"* — and a stronger signal than home once it exists |
| 2 | **`$HOME`** | the reporter's ask, and the right default: the one root that exists on every machine and is never empty, so a first run lands somewhere useful instead of on a menu of seven names |
| 3 | `Places` | a machine whose `$HOME` is inside no place (a container with `HOME=/root`), where opening there would mean the first listing is refused |

The two requirements do not contradict each other: a fresh install has no history so it gets home, and once you have
opened a session somewhere, that is a considered choice worth honouring.

**The lesson, stated because this is the second time on this issue.** A preference was shipped without deciding *when*
it should be written, and the answer "on any navigation" was never examined — it was simply the callback that happened
to exist. A stored value the reader cannot account for is worse than no stored value.
