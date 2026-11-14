# Pi Central — the orchestrator takes bounded OS actions: slice plan

**Status:** Proposed. Nothing here is implemented.
**Baseline:** commit `15fd42d`, plus the uncommitted work described in §1.
**Governing record:** the ADR drafted in §7. It must be accepted before code is written — see §2.
**Scope:** one new orchestrator capability, one new control, one new event, one event handler, one file-tree affordance. Not a framework change, not a viewer change.

---

## 1. Working method — this must not disturb the other session

A second session holds uncommitted work in this checkout (§1.1). This slice shares exactly one
file with it, and that is stated below rather than discovered at merge time.

### 1.1 The constraint, as measured

```
 M CHANGELOG.md
 M packages/ui/DESIGN.md
 M packages/ui/src/App.tsx
 M packages/ui/src/components/ConfirmDelete.tsx
 M packages/ui/src/components/SessionRail.tsx
 M packages/ui/src/store.ts
 M packages/ui/src/styles.css
?? packages/ui/src/components/ShortcutSheet.tsx
?? packages/ui/src/shortcuts.ts
?? packages/ui/test/shortcuts-interactive.test.mjs
?? packages/ui/test/shortcuts.test.mjs
```

Those are another slice's keyboard-shortcut work (#253). This plan therefore does not edit files
in that list except where §6 says so explicitly, and the one exception is additive and four lines
long.

### 1.2 Rules for whoever implements this

1. **Work in a separate git worktree, not in this checkout.**

   ```
   git worktree add ../pi-central-osactions -b feat/os-actions main
   ```

   A worktree shares the object database and has none of the working tree. It is the only method
   here that cannot pollute: no stash, no revert, no branch switch in a dirty tree. Everything
   below happens in `../pi-central-osactions`. **The one-writer-per-directory rule in
   [DOGFOODING.md](DOGFOODING.md) applies to the running app too** — do not run Pi Central from
   the worktree while the other checkout is in use.

2. **Do not append to `CHANGELOG.md` in the worktree.** Its `Unreleased` section is the other
   session's in-flight text. The entry for this slice goes in the PR body (§9) and is added at
   merge time, after the other slice lands. The reasons are mechanical: [AGENTS.md](../AGENTS.md)
   requires a one-line entry with an issue reference, and `scripts/changelog-links.test.mjs`
   fails on a reference without a definition — so the entry needs the issue number, which is
   assigned when the issue is filed, not now.

3. **`packages/ui/src/App.tsx` is the only shared file.** This slice adds four lines to it
   (§6.6). Rebase onto `main` before opening the PR, and if the other slice has landed the
   conflict is one hunk inside `FilesPanel`'s props. Nothing else in this slice touches a file
   from §1.1.

4. **Nothing in §1.1 is read-only for the other session's benefit** — no `git checkout --`, no
   `git stash`, no reformat. If a file from that list needs changing, it is a signal that this
   slice has grown past its boundary.

---

## 2. Why this needs an ADR before code

[ADR-0007](decisions/0007-filesystem-access-model.md) confines **every** read to the session's
`cwd`, and the module that implements it says so at the top of the file:

> `files.ts` confines every path to a session's `cwd`; that confinement IS the feature

`resolveWithin` is that confinement. An action that runs `/usr/bin/open` on a resolved path cannot
escape a *correct* implementation — the path is inside the cwd by construction — **but the
capability is new in a second sense**: the orchestrator would begin *acting on the OS* out of a
process that until now has only read files and spawned fixed binaries.

This is the same situation as [ADR-0012](decisions/0012-directory-chooser.md), and that record is
the precedent to copy. The directory chooser reads directories no session owns, and its module says:

> That is a genuine capability increase over `files.ts`, and it is recorded as one: ADR-0012, which
> extends ADR-0007 rather than quietly widening it.

So §7 drafts the record. **The sequence is: file the decision issue, get the ADR accepted, then
file the slice issue, then implement.** Implementing first would make the ADR a description of code
that already exists, which is how a decision record stops being one.

---

## 3. The decision, in one paragraph

The orchestrator may take **one** kind of OS action — select a path in Finder — on a path it has
**already resolved and containment-checked**, in reply to an explicit control from a client, for a
session that exists. The action is a fixed binary with a fixed argv shape: no shell, no
application choice, no URL form, and no way for a client to name the binary, the flags or the
working directory.

### 3.1 Why not the Electron shell, which already has `showItemInFolder`

`packages/app/src/main.ts` already calls `shell.openPath` and `shell.showItemInFolder` for its own
log file. That path is rejected for this feature, and the reasons are structural rather than
stylistic:

| | Orchestrator-side | Shell-side |
|---|---|---|
| Works in a browser tab | yes | **no** — needs a preload + IPC |
| New privileged channel | none | the shell's **first** preload |
| Blocked by an existing guard | no | `auditWindowOptions` **fails the build** when `preload` is present |
| Serves PWA / plain browser clients | yes | no |
| Path containment | `resolveWithin`, already tested | must be re-implemented in the main process |

The shell is an optional, unpublished launcher ([ADR-0013](decisions/0013-application-shell.md):
installed by `scripts/install-app.mjs`, never the update target). Putting a capability there means
the capability exists only for readers who installed the shell, and it means removing a guard that
exists to keep the renderer unprivileged. The orchestrator is the process that already owns the
filesystem, already knows the session's `cwd`, and is reachable from every client.

### 3.2 Why the action is `reveal` and not `open`

`reveal` (`open -R`) selects the item in Finder; it hands the bytes to **no** application. `open`
(without `-R`) delegates to whatever application the OS has registered for the extension — dynamic
dispatch this app does not control, on a file that may have been written by the model. ADR-0007's
guardrail 5 is explicit:

> **No execution.** Nothing discovered by browsing is executed, sourced, or interpreted.

`reveal` keeps that sentence true. `open` would amend it, and the amendment is not obviously
correct: the argument that "the reader chose the application by choosing their file manager" is
plausible and unproven. So `open` is **out of scope** (§8) and gets its own decision, with its own
falsifier, if it is ever wanted. Space in Finder is one keystroke, and it is the reader's own OS
doing the opening.

---

## 4. The measured facts that shape the implementation

Run against `/usr/bin/open` on this machine. Each one changes a line of code, which is why they are
recorded rather than assumed.

### 4.1 `open` exits 0 without having acted

Every genuine failure measured — a missing path, a bundle identifier that does not resolve, an
invalid flag — exited **1** with a message:

```
$ open -R -- /nope-xyz            → exit 1, "The file /nope-xyz does not exist."
$ open -b com.apple.NoSuchXYZ -- f → exit 1, "LSCopyApplicationURLsForBundleIdentifier() failed …"
$ open -R -Z                      → exit 1, "open: invalid option -- Z"
```

What it will *also* do is return 0 having achieved nothing: it hands the request to `launchd` and
exits, and a dock that is slow, a Finder that is busy, or a reveal that is silently discarded all look
identical from the exit code. **So 0 means the request was accepted, never that anything was shown.**

**Consequence:** the refusal is decided **before** the spawn (`realpath`, containment, `lstat`, platform).
A non-zero exit is a *confirmed* failure and is reported; a zero exit is not reported as success. A
reveal that silently did nothing is a stated limitation (§7.6), not a claim that it worked.

### 4.2 The `--` separator is defence in depth, not the boundary

```
$ open -R -e                → exit=1, parsed as the TextEdit flag, not as a file named -e
$ open -R -- "-e"          → exit=0, the file named -e is revealed
```

**Consequence:** argv is exactly `["-g", "-R", "--", path]`. It is written down as a fixed shape
rather than as the thing that stops a filename selecting an application, because §4.5 already means
the argument is an absolute path: `-e` can never reach the argv through the real call path. The `--`
is kept so that a later change to §4.5 cannot turn a filename into an application choice, and the test
asserts the literal array so removing it fails. This is the same rule `policy.ts` documents for spawns:
a fixed binary and fixed argument shapes, with the path as the only free value.

### 4.3 A failure is immediate, so the spawn cannot block the event loop

```
$ time open -R -- /tmp/nope-xyz   → real 0.00s
```

`open` hands off to `launchd` and returns. So `spawn` must be used with `stdio: "ignore"` and
`detached`, **not** `spawnSync` — a synchronous spawn in the transport's message handler would
stall every other client for the duration of the launch, which for a cold Finder is seconds.

### 4.4 `-g` is required

Without `-g`, revealing steals focus from the window the reader is typing in. This UI treats focus
theft as a defect rather than a detail (the queued-prompts and transcript plans both state "no
focus theft"), and the reader is mid-sentence by construction — they clicked a file in a tree
beside a composer.

### 4.5 The reflected argument must be the resolved path, not the typed one

`resolveWithin` returns both the resolved real path and the normalised relative path. The child is
given the **resolved** one, so that the string handed to the OS is the same string the containment
check validated. Passing the client's spelling would pass an unvalidated string to a launcher even
when the resolved path was safe — the class of mismatch `own-installation.ts` shipped once
(issue #25).

---

## 5. Shape

```text
FileTree row (⤴ reveal)
      │  control { kind: "reveal", sessionId, path }
      ▼
transport.ts  ──►  supervisor.reveal(sessionId, path)
                        │  session lookup → cwd  (not-found if no session)
                        ▼
                   os-actions.ts  revealInFileManager(root, relative)
                        │  resolveWithin (ADV-0007, unchanged, reused)
                        │  lstat → is it still there?
                        │  platform check
                        ▼
                   spawn("/usr/bin/open", ["-g", "-R", "--", abs], { detached })
                        │
                        ├─ pre-spawn refusal ──► event { kind: "osActionError", action: "reveal", … }
                        └─ confirmed spawn failure ──► same event
```

No HTTP path, no preload, no IPC, no `file://` URL. The control and the answer travel on the socket
that already carries `readFile` and `fileError`.

---

## 6. Work, file by file

A backticked repository path is a claim that it resolves — `npm run check:docs` enforces that, and a
plan describing files it has not written yet must not fail its own gate. So the four files this
slice **creates** are listed in a plain fenced block, not in backticks:

```text
packages/orchestrator/src/os-actions.ts       new — the action, its refusals, no new containment
packages/orchestrator/test/os-actions.test.ts new — tests 1–7 of §9, against a fake binary
packages/ui/test/reveal.test.mjs              new — tests 9–10 and 12 of §9
docs/decisions/0014-os-actions.md             new — §7, extracted verbatim once accepted
```

Everything else below is an **edit to an existing file**, which is safe to write in backticks and is
how the rest of this document is written.

### 6.1 New module: `os-actions.ts` in the orchestrator's `src` (~90 lines)

A pure module over `node:fs`, `node:path` and `node:child_process`, mirroring `files.ts` in shape
so the two read as one capability rather than two.

Exports:

- `type OsAction = "reveal"`
- `type OsActionFailure = FileFailure | "unsupported-platform"`
- `interface OsActionResult { ok: true } | { ok: false, error: { reason, code?, message } }`
- `export function revealInFileManager(root, relative, options?): OsActionResult`

`options` carries `{ openPath?, platform? }` so a test can inject a fake binary and a fake platform
without touching the host — the same seam `probeSandbox(execPath)` uses in `sandbox-guard.ts`.

The body, in order, and the order is the security property:

1. `resolveWithin(root, relative)` — reused verbatim. Every refusal it produces (`invalid-path`,
   `absolute-path`, `escapes-cwd`, `not-found`, `permission`) keeps its existing meaning and
   message. **No new containment code is written.** That is the single most important sentence in
   this plan: two containment implementations is how the weaker one eventually wins.
2. `lstatSync(abs)` — a file deleted between listing and clicking is `not-found`, stated, rather
   than a spawn that produces the OS's own sentence about a path the reader did not type.
3. Platform check: `process.platform !== "darwin"` → `unsupported-platform`. The orchestrator runs
   on Linux in CI and C10 already makes macOS the only supported platform for the sandboxed mode;
   refusing with a reason is better than an `ENOENT` from `spawn` that reads as a missing file.
4. `spawn(options.openPath ?? "/usr/bin/open", ["-g", "-R", "--", abs], { stdio: "ignore", detached: true })`
   followed by `.unref()`. A **synchronous** spawn error cannot exist to catch: `spawn` reports
   `ENOENT`/`EACCES` on an asynchronous `error` event, so a refusal needs a listener, not a return
   check. A non-zero exit is a **confirmed** failure and is reported; a zero exit means `launchd`
   accepted the request, which is not a claim that Finder displayed anything.

A file header comment stating: why this is not reached from `places.ts` (that module's boundary is
"directories inside fixed roots, no contents"; this one is "one path inside a session's cwd, acted
on"); why the path is the resolved one (§4.5); and why `-R` and nothing else (§3.2).

### 6.2 `packages/orchestrator/src/supervisor.ts` (+~15 lines)

One method beside `readFile`, same shape, same session lookup, same `not-found` message pattern:

```ts
reveal(id: string, path: string): OsActionResult
```

The supervisor is the only component that knows a session's `cwd`, so this method exists for the
same reason `readFile` does: `cwd` has exactly one source.

### 6.3 `packages/protocol/src/envelopes.ts` (+~30 lines)

- `Control`: `{ kind: "reveal"; sessionId: string; path: string }` — placed beside `readFile`,
  with a comment naming why it is a separate kind rather than a flag on `readFile` (a flag would
  make one handler's authority depend on a boolean; that argument is already written for
  `listPlaces` and applies identically here).
- `Event`: `{ kind: "osActionError"; action: OsAction; sessionId: string; path: string; reason: OsActionFailure; code?: string; message: string }`
- `PROTOCOL_VERSION` → `10`, with a doc-comment entry in the existing `vN` chain.
- `REVEAL_SINCE_PROTOCOL = 10` and `supportsReveal(protocol)`.

**Why a new event rather than `fileError`.** `fileError` carries
`request: "list" | "read"`, and the client routes by that field into a cache: `list` → `filesFailed`,
`read` → `fileFailed`. A reveal refusal belongs to **no cache** — it is a statement about an
attempt, not about what is known. Reusing `fileError` would either add a third cache that does not
exist or write a refusal into the wrong one, which is the exact defect `request` was introduced to
prevent. A separate kind keeps that routing rule intact.

### 6.4 `packages/orchestrator/src/transport.ts` (+~18 lines)

A `case "reveal"` in the control switch, mirroring `readFile`: echo `path` **as the client sent
it** (the reason is already recorded for `readFile`), and on refusal broadcast `osActionError`.

### 6.5 `packages/ui/src/files.ts` (+~12 lines)

A `revealNote` record keyed by `fileKey(sessionId, path)`, plus three local actions:
`revealRequested` (clears any previous note — a second attempt must not display the first attempt's
refusal), `revealFailed`, and `forgetSession` cleanup. Pure, testable without a socket, which is
why it lives here and not in the component.

### 6.6 `packages/ui/src/components/FileTree.tsx`, `FilesPanel.tsx`, `App.tsx`

- `FileTree`: a `⤴` button per row with `aria-label={`Reveal ${name} in Finder`}` and
  `title="Show in Finder"`. **Separate `<button>`, not a modified row `<button>`** — the row's
  click opens or expands, and nesting one interactive element inside another is invalid HTML and
  unreachable by keyboard. The tree's disclosure mark is `aria-hidden`; this control is not.
- `FilesPanel`: pass `onReveal` and the per-path note through to the tree.
- `App.tsx`: **four lines** — an `onReveal` handler that sends the control and dispatches
  `revealRequested`, and the `osActionError` case in the event switch. This is the only change to a
  file from §1.1, and it is the insertion point §1.2 refers to.
- A refusal renders with the existing `FileErrorNote` (§6.7), under the row.

### 6.7 `packages/ui/src/components/FileErrorNote.tsx` (+2 lines)

One new case in `reasonLabel`: `"unsupported-platform"` → `"Cannot show in Finder here"`. The
existing cases are reused unchanged, so a refusal about an escaping path says *"Outside the working
directory"* — the sentence that names the fix.

Adding a `case` to a `switch` with a `default` is deliberately the cheap form; if the reason set
grows past two additions, `reasonLabel` should take the closed union rather than `string`, and that
is a note in the test rather than a refactor now.

### 6.8 `packages/ui/src/styles.css` — **conflict risk, see §1.2**

One rule for the new button (`.filetree-reveal`), matching `.filetree-kind`'s size and colour. It
is four lines, appended at the end of the `.filetree-*` block. It is listed as a separate item
because `styles.css` is dirty in the other session, and C20 is the constraint that says a new child
in a flex row changes every sibling's rule: `.filetree-row` uses `flex: 1` on `.filetree-name`, so
the added control shrinks the name and must be `flex: none`. That is the C20 reading, not a guess.

---

## 7. ADR draft — to be extracted into ADR-0014

> **ADR-0014 — The orchestrator may take one bounded OS action on a path it resolved**
>
> **Status:** Proposed. **Amends:** [ADR-0007](decisions/0007-filesystem-access-model.md).
>
> ### Context
>
> ADR-0007 confines file browsing to a session's `cwd` and states, as guardrail 5, that "nothing
> discovered by browsing is executed, sourced, or interpreted". It also states the orchestrator acts
> at the user's UID, on the user's files, for the user. Those two statements are compatible as long
> as browsing only *reads*.
>
> A product gap made the second one bite. The file pane renders text and images, and refuses
> everything else; PDFs, office documents, archives and video are refused as `binary`. The
> alternatives were to own a renderer per format (weeks, and a new dependency surface for each) or
> to hand the file to the OS (one call). The second is what a desktop application does, and the
> absence of it is why a local app behaves like a web page.
>
> ### Decision
>
> The orchestrator may perform **one** OS action: select a resolved path in the platform file
> manager. Concretely:
>
> 1. **One action, one binary, one argv shape.** `open` with `["-g", "-R", "--", path]`. No `-a`,
>    `-b`, `-t`, `-u`; no shell; no application name; no URL form. The `--` is defence in depth:
>    rule 2 already makes the argument absolute (§4.2).
> 2. **The path is the resolved one**, from `resolveWithin`. Never a client spelling.
> 3. **Containment is reused, not re-implemented.** The action takes `(root, relative)` and calls
>    `resolveWithin` exactly as a read does, so `escapes-cwd` and its siblings keep one meaning.
> 4. **The action is scoped to a session.** `sessionId` → `cwd` via the supervisor, the same single
>    source reads use.
> 5. **It reveals; it does not open.** Guardrail 5 stays true verbatim.
> 6. **The exit status reports the launch, not the reveal** (§4.1). Refusals happen before the spawn;
>    non-zero is a confirmed failure; zero is not a claim that anything was shown.
>
> ### Consequences
>
> **Positive.** Every format becomes reachable without a renderer, for every client including a
> plain browser tab, with no preload, no IPC and no `file://` URL. The long tail of "open this
> properly" stops being a per-format project.
>
> **Negative, stated.** The orchestrator now acts on the OS, not only reads. The blast radius is a
> Finder window — but the *category* changed, and a later action (`open`, `trash`, `copy path into
> another app`) would each be a new decision rather than a new case in a switch. This record exists
> so that the next one has to argue for itself.
>
> **Negative, measured.** A reveal that does nothing cannot be detected (§4.1). The UI can state a
> refusal it produced; it cannot state a success, and must not imply one.
>
> ### Alternatives rejected
>
> - **A preload + IPC in the Electron shell.** No preload exists by design, its absence is audited,
>   and the capability would serve only readers who installed the shell while removing a guard.
> - **A `file://` URL from the UI.** `externalTarget` allows only `http:`/`https:`; a `file:` URL is
>   dropped, correctly, and would be a new attack surface in a renderer.
> - **A per-format renderer for PDF / office / video.** Costed separately: weeks, plus a dependency
>   and a CSP directive each.
> - **`open` without `-R`.** Amends guardrail 5 and delegates to an application the app does not
>   choose.
> - **Routing through the agent's sandboxed `bash`.** ADR-0007 already rejected this for reads, with
>   the same reasoning.
>
> ### Falsifiers
>
> - A path that escapes the cwd can be revealed → the containment reuse is wrong.
> - An argv element can select an application → the fixed argv shape was not implemented.
> - The action works in the browser tab but the app stops working in the shell → the capability was
>   put in the wrong process.
> - `open -R` on a **deleted** file produces a misleading success → the pre-spawn `lstat` is
>   missing.

---

## 8. Explicitly out of scope

- **`open` (default application).** Its own decision, per §3.2. If it is ever accepted, the gate is
  a confirmation that names both the file and the application, which needs
  `LSCopyDefaultApplicationURLForURL` — macOS-native platform code, which `places.ts` declined to
  open once already.
- **Drag a file out of the window to another app.** Chromium `DownloadURL` from a blob; a different
  mechanism with a different failure mode.
- **Reveal for `places.ts` paths** (a directory no session owns yet). Different boundary,
  different argument; not needed by this slice.
- **Reveal for a transcript's referenced file** (the `@img_6.png` preview). Same capability,
  different surface; a follow-up, not a prerequisite.
- **Any file operation** (create, rename, delete — issue #10). Unrelated.
- **A `PI_CENTRAL_OPEN_BIN` environment override in production.** The injection seam is a *function
  parameter* for tests only, deliberately not an env var, because a configurable launcher path is a
  configurable command and the configuration slice (#223) states that the config file may not widen
  the sandbox.

---

## 9. Tests, each with its falsification

Every one of these must be able to fail. The repository's norm is to state the revert that makes it
fail, and that column is not optional.

| # | Test | File | Fails if you revert |
|---|---|---|---|
| 1 | an escaping relative path is refused with `escapes-cwd` and nothing is spawned | new `os-actions.test.ts` in the orchestrator's `test` | replace `resolveWithin` with `resolve(join(root, relative))` — the test must then see a spawn |
| 2 | a symlink pointing out of the tree is refused | same | drop the `realpath` containment pass |
| 3 | argv is exactly `["-g","-R","--",abs]`: no application flag, and the path is the resolved one | same (fake binary records argv) | remove `"--"`, add `-a`, or pass the client's spelling |
| 4 | a file whose name begins with `-` is revealed rather than parsed as a flag | same (fake binary records argv) | remove `"--"` from the argv array |
| 5 | a file deleted between listing and reveal is `not-found`, with no spawn | same | delete the pre-spawn `lstat` |
| 6 | a non-darwin platform is `unsupported-platform`, not an ENOENT | same (`platform: "linux"`) | remove the platform check |
| 7 | a spawn `ENOENT` (fake binary path) is a refusal, not a crash | same | drop the `error` listener and let it become an unhandled rejection |
| 8 | the transport echoes `path` as the client sent it, and broadcasts `osActionError` only on failure | `packages/orchestrator/test/*transport*.test.ts` | echo the resolved path |
| 9 | a second attempt clears the first refusal | `packages/ui/test/files.test.ts` | drop `revealRequested` |
| 10 | the tree renders a separate labelled button per row, not a nested one | `packages/ui/test/components.test.mjs` | render the control inside `.filetree-row` — the assertion counts `<button` per row |
| 11 | `PROTOCOL_VERSION` moves with the surface, in both directions | `packages/protocol/test/wire-surface.test.ts` | update `wire-surface.json` without the bump |
| 12 | `reasonLabel` states `unsupported-platform` in words | `packages/ui/test/components.test.mjs` | fall through to the `default` |

Two things worth stating about the test design:

- **Test 3 needs a fake binary, not `/usr/bin/open`.** A test that spawns Finder during `npm test`
  would be an unrequested OS action on a developer's machine and would open a window on every CI run
  that has a `HOME`. `revealInFileManager` therefore takes `openPath` as a parameter (§6.1), and the
  test passes a script that writes its argv to a temp file.
- **Test 10 is the C20 test.** It asserts the *composition*: one row, two buttons, and the reveal
  control outside the row's own `<button>`. An assertion about `.filetree-reveal`'s properties alone
  would pass with the button nested inside the row, which is the structurally valid-but-wrong
  version.

---

## 10. Documentation to update when this lands

- `docs/ROADMAP.md` — a bullet under the file-browser phase, and the note that the viewer's format
  coverage is deliberately delegated rather than rendered.
- `docs/ARCHITECTURE.md` — one line in the diagram's caption: the orchestrator reads **and takes one
  OS action**, because the diagram currently says it runs sandboxed sessions and relays.
- `docs/decisions/README.md` — the ADR-0014 row.
- `CHANGELOG.md` — one line under `Unreleased`, with its `[#254]` definition.
- A new constraint **C21**, if the measurement in §4.1 is judged to be a hard limit rather than an
  implementation note. Candidate wording: *"`open` returns 0 when `launchd` accepts a request, so a
  launcher's exit status reports acceptance and never that anything was displayed"* — the same shape
  as C17/C18. It is **not** in this change, and the ADR does not cite it.

---

## 11. PR body sketch (the reasoning that the changelog may not contain)

> The viewer could draw text and images and refused everything else, which meant PDFs, office
> documents, archives and video were all `binary`. Two ways out: own a renderer per format, or hand
> the file to the OS. The OS call is one line; the reason it was not already there is that the
> capability lives in the wrong place for it — the Electron shell has `showItemInFolder`, but it
> ships no preload by design, its absence is audited by `auditWindowOptions`, and it serves only
> readers who installed the shell.
>
> So the action goes where the filesystem already is. `resolveWithin` is reused rather than
> re-implemented — two containment implementations is how the weaker one eventually wins — and the
> argv is `-g -R --` for three reasons: `--` as defence in depth, so a filename can never be read as
> a flag if the path rule changes; `-g` because revealing must not steal focus from the composer; `-R`
> because `open` without it hands the bytes to an application this app does not choose, which would
> amend ADR-0007's guardrail 5 rather than extend ADR-0007.
>
> One measured trap is worth naming: every genuine failure exits **1**, so non-zero is a confirmed
> failure — but `open` also returns **0** when it has merely handed the request to `launchd`. So the
> refusal is decided before the spawn, a zero exit is never used to claim success, and a reveal that
> silently did nothing is a stated limitation rather than a claim. That is a candidate C21 if the
> constraint list grows one.

---

## 12. Order of work, and where it can go wrong

1. File the **decision** issue (§7 draft as the body). Nothing is implemented until it is accepted.
2. File the **slice** issue with §6's acceptance criteria and §9's evidence column.
3. `git worktree add` (§1.2), implement `os-actions.ts` + test 1–7. **These are the only tests that
   matter before the rest exists** — if containment reuse cannot be demonstrated, the slice stops
   here and the answer is "no".
4. Protocol: kind, event, version, `supportsReveal`, fixture. Test 11.
5. Transport + supervisor. Test 8.
6. UI: state, tree, panel, note. Tests 9, 10, 12.
7. Rebase onto `main`; add the four lines to `App.tsx`; resolve `styles.css` if the other slice has
   landed. `npm run verify`.
8. Update §10's documents. Add the changelog entry at merge.

### Where this can go wrong

- **The ADR is rejected on `reveal` being an action at all.** Then the fallback is a
  "copy absolute path" affordance, which needs no new capability — the UI already has `cwd` — and
  the reader pastes into Finder's ⌘⇧G. That is a worse product and a legitimate outcome; it should
  be decided by the ADR, not by whoever writes the code.
- **A reviewer wants `open` in the same slice.** It is refused for a stated reason (§3.2), not for
  effort. Folding it in converts "extend ADR-0007" into "amend its guardrail", which is a different
  decision with a different falsifier.
- **`spawn` detached leaves a zombie or a child that outlives the orchestrator.** `unref()` covers
  the orphan; a test asserts the parent can exit while the fake child runs.
- **The tree gains a second control and the row layout breaks.** That is C20 exactly, and it is
  test 10's job. Check `.filetree-row`'s `flex` distribution before adding the child, not after the
  screenshot.

---

## 13. Appendix — the two issue bodies, ready to file

Both follow the repository's issue templates (`.github/ISSUE_TEMPLATE/decision.yml` and
`slice.yml`). File the first, get the ADR accepted, then file the second.

### 13.1 Decision issue

```text
[decision] May the orchestrator take an OS action, or only read files?
```

**The question**

When the file viewer cannot draw a file — a PDF, an office document, an archive, a video — should it
(a) render the format itself, (b) hand the resolved path to the OS, or (c) say it cannot and point at
an affordance that copies the path for the reader to use?

**Options and their consequences**

- **(a) Render per format.** Keeps everything in-process and inside one CSP. Costs a dependency and
  a lazy chunk per format, plus a `frame-src`/`media-src` decision each, and the guardrail "nothing
  discovered by browsing is executed" survives only because we render rather than execute. Weeks,
  and it never ends: the long tail is the point of a file browser.
- **(b) Orchestrator-side OS action (`open -R`).** One call; every format reachable; works for a
  plain browser tab with no preload and no IPC. Costs a new *category* of capability in a process
  that has only read files, and makes exit status untrustworthy (measured: `open` exits 0 after
  failing).
- **(c) Copy the absolute path.** No new capability at all — the UI already holds `cwd`. Costs the
  reader a Finder navigation (⌘⇧G, paste) per file, and does nothing for "just show me this PDF".

**Constraints that bear on it**

[ADR-0007](decisions/0007-filesystem-access-model.md) guardrail 5 ("nothing discovered by browsing is
executed, sourced, or interpreted") and its containment rule (`realpath` + segment check, reused
rather than re-implemented). [ADR-0012](decisions/0012-directory-chooser.md) is the precedent for
recording a capability increase rather than quietly widening the first one. The shell's
`auditWindowOptions` refuses a preload, so (b) via Electron IPC is not available without removing a
guard. C10 makes macOS the only supported platform, which bounds the platform cost of (b).

**What would prove the chosen option wrong?**

For (b): a path that escapes the session `cwd` can be revealed; or a file whose name begins with `-`
selects an application; or the reader's focus is stolen from the composer. Each is a test, and each
turns the decision over rather than being fixed inside it.

### 13.2 Slice issue

```text
[slice] A file can be shown in Finder, for every format the viewer cannot draw
```

**Outcome**

A reader can select any file in the tree in Finder, including the formats the pane refuses to render.
No renderer is added, and the app still never executes or interprets what browsing discovers.

**Acceptance criteria**

- [ ] The tree offers *Show in Finder* per row, as its own labelled control — not nested inside the
      row's own button, so it is reachable by keyboard and by a screen reader.
- [ ] The action is confined by the **same** `resolveWithin` a read uses: an escaping path, an
      absolute path, a NUL byte and a symlink out of the tree are each refused with their existing
      reason, and no child process is spawned.
- [ ] The argv is exactly `-g -R -- <resolved path>`; a file named `-e` is revealed and does not open
      TextEdit.
- [ ] A path deleted between the listing and the click is reported as *not found*, not spawned.
- [ ] A refusal is stated in the UI with its reason, and a second attempt clears the first refusal.
- [ ] On a non-Darwin platform the control reports *cannot show in Finder here* rather than failing
      with an OS error.
- [ ] `PROTOCOL_VERSION` moves from 9 to 10, and the recorded wire surface moves with it.
- [ ] The reader's focus stays in the composer.

**Evidence**

Automated: `os-actions.test.ts` (refusals, argv shape, `--`, deleted file, platform, spawn `ENOENT`)
against a fake binary that records its argv, so no test opens a Finder window; a transport test that
the client's spelling is echoed and the refusal is broadcast; `wire-surface.test.ts` for the version;
`components.test.mjs` for one row = two buttons with the reveal control outside the row button.
Manual: reveal a source file, a PDF and a directory in Finder from the app, and from a plain browser
tab.

**Verification**

`verified/auto` for the refusals and the argv; `verified/manual` for the Finder window itself, which
cannot be asserted from a test process without taking an OS action the suite has no business taking.

**Governing constraints**

ADR-0007 (guardrail 5 and containment, both reused rather than restated), ADR-0012 (the precedent for
recording a capability increase), C10 (macOS-only), C20 (the row gains a child, so every sibling rule
in `.filetree-row` is re-read), and the new C21 if §4.1 is accepted as a hard limit.
