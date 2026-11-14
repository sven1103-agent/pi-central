# ADR-0014 — The orchestrator may take one bounded OS action on a path it resolved

- **Status:** Proposed
- **Date:** 2026-11-14
- **Amends:** [ADR-0007](0007-filesystem-access-model.md) (a third filesystem-adjacent capability, with its own boundary)
- **Opened by:** the file viewer's format gap — see [Context](#context)

## Context

The file viewer can draw two things: text with line numbers, and images whose type the orchestrator
sniffed from magic numbers. Everything else is refused as `binary` and stated with its size
([ADR-0007](0007-filesystem-access-model.md), issue #8). That refusal is honest, and it is also where
the product stops feeling like an application. A PDF, a spreadsheet, a video and an archive are all
*"not a text file, 2.4 MB"* — four different objects with three different natural renderers, one
sentence.

Two ways out, and they are not close in cost:

1. **Render each format.** A dependency and a lazy chunk per format, plus a CSP directive for each
   that embeds (`frame-src` for PDF, `media-src` for video), plus the decision of whether a rendered
   HTML file is untrusted content. The first two are weeks; the third is an
   [ADR-0006](0006-untrusted-markdown-rendering.md) re-open. It also never ends, because the long tail
   *is* the reason a file browser exists.
2. **Hand the file to the OS.** One call. The application the reader already trusts for that format
   does the rendering, and this project's rendering surface stays exactly as wide as it is today.

The second is what every desktop application does, and the honest reading of the complaint is that
Pi Central behaves like a web page precisely here.

### Why the capability is not in the shell that already has it

The Electron shell (`packages/app/src/main.ts`) already calls `shell.openPath` and
`shell.showItemInFolder` — for its own log file. Reaching that from the UI is not a small step:

- The shell ships **no preload and no IPC**, deliberately, and `auditWindowOptions` reports a preload
  as a violation, so the build fails if one appears.
- The shell is an optional launcher installed by a local script
  ([ADR-0013](0013-application-shell.md)); it is not a distributable, not the update target, and not
  everyone runs it. A capability placed there exists only for readers who did.
- The renderer holds no absolute path: the file tree speaks paths relative to the session's `cwd`, and
  a `file:` URL is dropped by `externalTarget` — correctly, since handing `file:` to an OS opener is a
  new attack surface in a renderer.

The orchestrator, by contrast, already owns the filesystem, already knows every session's `cwd`, and is
reachable from a plain browser tab. It is the process where this capability belongs, and it is the same
conclusion [ADR-0012](0012-directory-chooser.md) reached for the directory chooser.

### The measured facts that shaped the decision

Verified against `/usr/bin/open` on macOS, because each one changes a line of code:

- **`open` exits 0 after failing.** `open -R` on an argument it rejects emitted
  `LSCopyApplicationURLsForBundleIdentifier() failed …` and returned 0. Exit status is therefore **not
  evidence** that anything happened.
- **Without `--`, a filename is parsed as flags.** `open -R -- -e` selects a file named `-e`;
  `open -R -e` opens TextEdit. A *filename* would be choosing an application.
- **A failure is immediate** (`real 0.00s`), so the spawn must not be synchronous: `open` hands off and
  returns, and a synchronous spawn inside the transport would stall every client during a cold launch.
- **`-g` is required**, or revealing steals focus from the window the reader is typing in.

## Decision

**The orchestrator may perform exactly one OS action — select a resolved path in the platform file
manager — and it may perform it only on a path it has already resolved and containment-checked.**

Concretely:

1. **One action, one binary, one argv shape.** `open` with `["-g", "-R", "--", path]`. No `-a`, `-b`,
   `-t`, `-u`; no shell; no application name; no URL form. The only free value is the path.
2. **The path given to the OS is the resolved one** returned by `resolveWithin` — never the client's
   spelling, so the string handed to the launcher is the string the containment check validated.
3. **Containment is reused, not re-implemented.** The action takes `(root, relative)` and calls
   `resolveWithin` exactly as a read does. Two containment implementations is how the weaker one
   eventually wins, and `escapes-cwd` and its siblings keep one meaning.
4. **The action is scoped to a session.** `sessionId` → `cwd` through the supervisor, the same single
   source reads use.
5. **It reveals; it does not open.** `-R` selects the item in Finder. It hands the bytes to no
   application, so ADR-0007's guardrail 5 — *"nothing discovered by browsing is executed, sourced, or
   interpreted"* — stays true verbatim rather than by amendment.
6. **The exit status is not evidence.** Refusals are decided before the spawn (`resolveWithin`, `lstat`,
   platform). A child's non-zero exit is reported as a *confirmed* failure; a zero exit is not reported
   as success, and a reveal that silently did nothing is a stated limitation rather than a claim.
7. **It does not steal focus.** `-g`, because the reader is mid-sentence by construction: they clicked a
   file in a tree beside a composer.

## Consequences

**Positive**

- Every format becomes reachable — PDF, office documents, archives, video — without a renderer, a
  dependency, or a CSP directive, for every client including a plain browser tab.
- The rendering surface does not widen: no new `dangerouslySetInnerHTML` site, no `frame-src`, no
  embedded document.
- The long tail of "open this properly" stops being a per-format project.

**Negative, stated**

- The orchestrator now *acts on the OS*, not only reads. The blast radius of this action is a Finder
  window, but the **category** changed. A later action — open-with, trash, reveal-in-another-app —
  is each a new decision with its own record, not a new arm in a switch.
- A reveal that does nothing cannot be detected (measured above). The UI can state a refusal it
  produced; it must not imply a success it cannot see.
- The action is macOS-shaped. Off Darwin the orchestrator refuses with a reason rather than failing
  with an OS error, which is a small permanent branch — acceptable because
  [C10](../CONSTRAINTS.md#c10--safehouse-is-macos-only) already makes macOS the only supported
  platform and the orchestrator runs on Linux in CI.

## Alternatives considered

- **A preload and IPC in the Electron shell.** Rejected: it removes a guard that exists to keep the
  renderer unprivileged, and it serves only readers who installed the shell.
- **A `file://` URL from the UI.** Rejected: `externalTarget` allows only `http:`/`https:`, and widening
  it would let a renderer ask the OS to open anything it can name.
- **An `osascript` invocation.** Rejected on cost, exactly as
  [ADR-0012](0012-directory-chooser.md#alternatives-considered) rejected it: this product's first
  OS-scripting path, in exchange for a capability a fixed binary already provides.
- **Rendering each format in-app.** Rejected on cost and on surface: weeks, plus a dependency and a
  policy directive each, plus an ADR-0006 re-open for HTML.
- **`open` without `-R` (the default application).** Rejected *for this record*: it delegates to an
  application the app does not choose, which amends guardrail 5 rather than extending it. The argument
  for it — "the reader picked that application by picking their file manager" — is plausible and
  unproven, so it needs its own decision and its own falsifier. Space in Finder is one keystroke.
- **Routing through the agent's sandboxed `bash`.** Rejected in ADR-0007 for reads, for the same three
  reasons: no generic tool-invoke command exists, it is slower for no gain, and it conflates the agent's
  reach with the reader's own tools.

## Verification

Each of these is a test, and each can fail:

- A path that escapes the cwd, an absolute path, a NUL byte, and a symlink pointing out of the tree are
  refused with their existing reason **and no child process is spawned**.
- A file named `-e` is revealed, not opened: the argv contains `--` and no application flag.
- A path deleted between the listing and the click is `not-found`, with no spawn.
- A non-Darwin platform is refused as unsupported rather than surfaced as an OS error.
- A spawn failure (`ENOENT` on the binary) is a refusal, not an unhandled rejection.
- The wire surface and its version move together, by the repository's existing guard.

**Falsifiers — what would turn this decision over rather than be fixed inside it:**

- A path outside the session's `cwd` can be revealed → the containment reuse is wrong.
- A filename can select an application → the `--` rule was not implemented.
- The action is unavailable from a plain browser tab → the capability was put in the wrong process.
- Revealing a deleted file reports success → the pre-spawn `lstat` is missing.
