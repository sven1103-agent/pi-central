# ADR-0015 — Reloading a session's resources goes through Pi Central's own extension

- **Status:** Accepted
- **Date:** 2026-11-21
- **Supersedes:** none

## Context

A running session cannot pick up a tool, skill, prompt template or MCP server added after it started. Pi
discovered its resources once, at startup, and Pi Central knew nothing about a session's toolset at all — so it
could neither reload one nor say that one was stale ([#274]).

Pi **has** the capability. `/reload` reloads extensions, skills, prompts, themes and context files, applies tools
newly added to `defaultTools`, and `ctx.reload()` runs the same flow. The capability is not what is missing.

What is missing is a way for a **subprocess RPC client** to reach it:

| Fact | Consequence |
|---|---|
| `/reload` is a **built-in TUI command** | Pi excludes built-ins from `get_commands` because they "are handled only in interactive mode and would not execute if sent via `prompt`". Sending the text `/reload` delivers it to the MODEL as a user message. |
| Pi's RPC command surface has **no** `reload` | There is nothing to send. |
| Pi Central's model of that surface has no `reload` either | Nothing to call. |
| **Extension commands** `are` in `get_commands` and `do` run via `prompt` with a `/` prefix | An extension-registered command is the one reachable route to `ctx.reload()`. |

Measured, against Pi 1.6.0, before this was designed: an extension registering a command whose handler awaits
`ctx.reload()` reports `{ success: true, disposition: "handled" }` for `prompt("/<name>")`, and a resource added
between two `get_commands` calls appears after it.

## Decision

**Pi Central provisions one minimal extension of its own and invokes its command.** It is written to
`<agentDir>/pi-central/extensions/reload.js` at 0600 in a 0700 directory on every spawn, and loaded with
`--extension`.

- **Not `prompt("/reload")`.** It would reach the model, not the reload.
- **Not auto-discovery into `~/.pi/agent/extensions/`.** Pi Central's file would be indistinguishable from the
  reader's, listed by their tools, and removable by an action meant for their own.
- **Not an `extensions` entry in `settings.json`.** That is dropped by `--no-extensions`; `--extension` is not.
  A reload control that answers "not loaded" because of a flag nobody remembers is a control that fails on one
  machine only.
- **Namespaced `pi-central:reload`.** Pi keeps the FIRST registration of a name, so a plain `reload` would give
  precedence to a reader's own command and this one would never run.

The wire gains `reload` (with `interrupt`), `toolset`, and the `toolset`/`toolsetError` events; `PROTOCOL_VERSION`
moves to **12**.

**The reload is explicit, never automatic.** No watcher, no timer, no poll reloads a session: the orchestrator's
only clocks are command deadlines, and `invariants.test.ts` asserts that. The staleness CHECK is a plain `fs`
read of directory mtimes answered on request, and it is deliberately three-valued — `changed`, `unchanged`,
`unknown` — with `unwatched` and `unreadable` travelling beside it. `unchanged` is a claim about the watched
locations only, because MCP servers can arrive from an installed package and extensions can be enabled from a path
in someone else's `settings.json`.

## Consequences

**Positive**

- The session keeps its transcript, its cwd and its handle: `ctx.reload()` does not respawn, so there is no new
  session row, no branch point in the history (C9) and no cost to the run. This is why the route was chosen over
  anything resembling [#264]'s re-spawn.
- Pi's own refusal is surfaced verbatim. A reload during a run is refused by Pi, so the UI asks first and names the
  run — a reload that aborts a three-minute tool sequence without saying so is worse than no reload.
- A failed reload is reported as a failure. Pi answers `success: true, disposition: "handled"` **even when the
  command handler threw** (measured: a throwing handler emits `extension_error` and still answers success), so the
  `extension_error` seen during the call is what decides. Without that, a session that lost its extensions would
  report a working reload.

**Negative, and they are real**

- **This is a trusted-code installation inside every session.** An extension runs in the Pi process with Pi's OS
  permissions, so Pi Central now writes a file that is executed — the one step in this product that crosses that
  line. It is recorded in [`docs/SECURITY.md`](../SECURITY.md), and the file is a constant in
  `packages/orchestrator/src/reload-extension.ts` rather than anything derived from a prompt, a session or a
  working directory.
- **It depends on `ctx.reload()` staying public.** Pi's own documentation describes it as supported, and the
  failure if it is removed is contained: the command throws, the throw reaches the reader as a failed reload, and
  the session is untouched.
- **An `external` agent tree may not be writable.** Provisioning is best-effort and returns `undefined`; the
  session still starts, and the reload control reports that Pi Central's command is not loaded (the `disposition`
  check) rather than pretending.
- **The staleness check cannot be complete.** It reads directory mtimes. It cannot see an extension enabled by path
  in the agent's `settings.json`, or an MCP server from a package — `unwatched` says so on the payload, so a
  surface cannot render "current" over a check that never covered the question.

## Where this should end up

An **RPC `reload` command upstream**. It would remove the installed file entirely and make this ADR obsolete, and
it is what this slice would do if the command existed. Until it does, the extension is the only mechanism that
works, and the two must not both be built: one mechanism, one path, stated here so a later reader does not
re-litigate it.

## Alternatives considered

- **Ship both routes, gated on the Pi version.** Rejected: two mechanisms that must agree about a session's state,
  for a capability only one of them can provide today.
- **Re-spawn the session so it re-reads at startup.** Rejected: a new process means a new handle, a new
  `session_start`, a lost run, and — because a resumed session appends to the same file — a real risk of the branch
  point C9 describes. `ctx.reload()` exists precisely to avoid that.
- **Install into the reader's own extensions directory and let auto-discovery find it.** Rejected above: they would
  own a file they did not write, and cleaning up "stray" files would silently remove the control.
- **Reload automatically when a watched file changes.** Rejected: a reload rebinds Pi's extension instances, so an
  editor save would abort whatever the session was doing. The issue forbids it explicitly, and
  `invariants.test.ts` now holds that line.

[#274]: https://github.com/sven1103-agent/pi-central/issues/274
[#264]: https://github.com/sven1103-agent/pi-central/issues/264
