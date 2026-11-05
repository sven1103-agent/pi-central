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

### Why a native OS panel is not available

The product is a **browser UI over a loopback WebSocket** ([ADR-0005](0005-typescript-stack.md)). No
desktop shell exists, and every browser-side route to a native directory panel fails for a different
reason:

| Route | Why it cannot work |
|---|---|
| `<input type="file" webkitdirectory>` | Yields `File` handles, not an absolute host path. `cwd` is a path. |
| `showDirectoryPicker()` (File System Access) | Chromium-only, returns an **opaque handle** rather than a path, and is unavailable in the Safari standalone window this project recommends installing (#119). |
| `osascript -e 'choose folder'` | Works on macOS and is exactly the shape of thing ADR-0007 exists to avoid: the orchestrator spawning an AppleScript to act on the user's behalf, on one platform only (C10). |

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

**A desktop shell (Tauri/Electron).** Rejected: it supersedes ADR-0005's stack decision and
ADR-0011's "one npm artifact", for one dialog. The cost is a second runtime, a second updater, and a
second signing story.

**An orchestrator round trip through a native panel (`osascript`, `zenity`).** Rejected for the reason
ADR-0007 gives: spawning a script to act on the user's behalf is the shape that decision avoids, it is
macOS-only (C10), and the panel's result would be a path the orchestrator must then re-validate
anyway — so it buys the picker and nothing else.

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
