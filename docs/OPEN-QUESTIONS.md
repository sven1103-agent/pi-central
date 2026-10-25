# Open questions

Unresolved decisions. Each has a working default so planning is not blocked, but the
default is not yet ratified.

## Q1 — Where does the orchestrator run?

The orchestrator must be **outside** any sandbox (C1). Options:

| Option | Pros | Cons |
|---|---|---|
| Foreground CLI/TUI you start in a terminal | simple, obvious lifetime | tied to a terminal; dies with the shell |
| Background daemon via `launchd` user agent | survives terminals, restarts cleanly | install/plumbing; a persistent local attack surface |
| Started on demand by the UI | no install | needs a bootstrap path; races on first connect |

**Working default:** foreground CLI for Phase 1–2, `launchd` user agent for Phase 3+.

**Decision needed:** is a persistent background daemon acceptable, given it is
deliberately *not* sandboxed?

**Note:** the transport question that used to sit alongside this is now resolved —
WebSocket over loopback, per [ADR-0005](decisions/0005-typescript-stack.md). What remains
open is only the process lifetime: foreground vs `launchd`.

## Q2 — What is the UI surface?

**Resolved:** browser app. React + Vite, served by the orchestrator, WebSocket over
loopback. See [ADR-0005](decisions/0005-typescript-stack.md).

This is a reversal of the earlier "working default", which was not yet ratified. Markdown
rendering, syntax highlighting, and rich approval dialogs are the deciding factors; a
terminal TUI would render all three poorly. The cost is accepted and mitigated: a browser
means an HTML surface for untrusted content, which makes sanitization and CSP mandatory
rather than optional ([ADR-0006](decisions/0006-untrusted-markdown-rendering.md)).

## Q3 — `RpcClient` vs a custom supervisor

**Resolved:** custom supervisor. See [ADR-0003](decisions/0003-custom-supervisor.md).
`RpcClient` spawns Pi itself, which conflicts with spawning through `safehouse`; its
protocol types and correlation patterns are reused instead.

## Q4 — Session discovery scope

Show **all** sessions across all working directories, or a curated set?

- All: discovery returns everything; the rail could be huge.
- Curated: a user-defined project list, with a "show all" escape hatch.

**Working default:** curated list of *projects* (directories) with all their sessions,
plus a global search.

**Decision needed:** is the unit a session or a project in the rail?

## Q5 — Credentials and `--env-pass`

Safehouse sanitizes the environment (C4). Which variables must reach each session?

- Provider keys (`ANTHROPIC_API_KEY`, …) if Pi reads them from env.
- Anything a project's tooling needs.

**Working default:** an explicit per-orchestrator allowlist passed via
`--env-pass`/`--env=FILE`, never the full host environment.

**Decision needed:** confirm Pi here authenticates via a store (`~/.pi/agent/auth.json`)
rather than env, which would minimize what must be passed through.

## Q6 — Approval policy when nobody is watching

Extension dialogs in RPC may carry a `timeout`, and Pi auto-resolves with a default when
the client does not answer. Pi Central must decide what it wants to happen then:

- **Fail closed:** never answer; let Pi's timeout apply. Safest, but blocks work.
- **Fail open:** auto-confirm. Unsafe.
- **Policy engine:** per-project rules (e.g. auto-deny `bash`, auto-allow `read`).

**Working default:** fail closed for `confirm` (deny on timeout), and surface an
`awaiting-approval` badge that persists until answered.

**Decision needed:** is a policy engine in scope for v1, or a later phase?

## Q7 — Persistence of Pi Central's own state

Does Pi Central store anything durable (window layout, project list, approval audit log)?
If so, where — and it must be outside `~/.pi` to avoid entangling with Pi's own config.

**Working default:** `~/.config/pi-central/`, JSON, no secrets.

**Decision needed:** confirm the location, and whether an approval audit log is in scope
for v1 (it interacts with Q6).

## Q9 — File navigation scope

**Resolved:** per project (one tree per workdir), accessed **directly at the user's UID**,
with file operations in scope and content editing out of scope. See
[ADR-0007](decisions/0007-filesystem-access-model.md).

An earlier "working default" proposed routing reads through a sandbox sidecar. That was
over-engineered: Safehouse confines the **agents**, which is the boundary that matters. The
orchestrator is a user-level app acting for the user, at the user's UID, and is
deliberately unsandboxed so it can spawn sandboxed sessions at all (C1).

## Q8 — Naming and packaging

Repo `pi-central` under the `sven1103-agent` org, MIT, matching `pi-metrics`
conventions. Unresolved:

- npm package name: `@sven1103-agent/pi-central`?
- Is it a `pi install`-able package (extensions only) or a standalone app? The
  orchestrator is **not** a Pi extension (C1), so it cannot be a package that loads
  inside Pi. It is a *peer* application.

**Working default:** standalone app in the org, published to npm only if it ships an
optional Pi-side companion extension (e.g. an approval-policy extension).

**Decision needed:** confirm it is a peer app, not a Pi package.
