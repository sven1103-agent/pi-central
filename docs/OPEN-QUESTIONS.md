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

**Resolved** by [ADR-0010](decisions/0010-agent-credential-identity.md).

Credentials are no longer an env-pass question, because `--env-pass`/`--env=FILE` cannot be
the mechanism: Safehouse's sanitized allowlist already passes `SSH_AUTH_SOCK`, and both flags
merge **append-only**, so they can add a variable but never remove one (C4a).

The decision:

- Sessions are spawned with an **explicit allowlist** built by the orchestrator, never
  `process.env`. This is the sanitization boundary (C11).
- The agent gets its **own** credentials from a per-agent store, delivered by the mechanism
  that can carry them: env values sourced from that store for provider keys and HTTPS
  `GH_TOKEN`; `GH_CONFIG_DIR`/`GIT_CONFIG_GLOBAL` for identity routing; a key file for SSH
  push and signing (env cannot carry a private key).
- `~/.pi/agent/auth.json` is the **host user's** credentials and must be denied in the
  appended policy fragment (C6).
- The achievable property is "the agent has its own credentials and not the user's" — not
  "the agent cannot exfiltrate a credential it holds", since egress is unrestricted by
  design (C5).

Remaining open sub-question: whether provider keys are delivered purely by env, or via Pi's
`auth.json` `"key": "!command"` indirection reading the agent keychain. Both are in scope;
the choice is per-agent configuration, not a fork in the design.

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

**Working default:** `~/.config/pi-central/`, JSON, **no secrets**.

**Amended** by [ADR-0010](decisions/0010-agent-credential-identity.md). The "no secrets" rule
now has a precise meaning, because credential state exists:

- `~/.config/pi-central/` holds **references and non-secret configuration only** — the agent
  root path, the ownership mode (`managed`/`external`), the agent's non-secret identity
  (login, email, `user.name`), and which secret each provider maps to.
- Secret **values** live in the per-agent store (`<state>/agents/<id>/`, `0700`; keychain or
  `0600` files), never in `config.json`.
- This honours Q7's intent: config stays shareable and diffable, and rotating a secret never
  touches it.

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

### How should Pi Central be *configurable*? (deferred 2026-10-26)

A related question, raised while fixing the `~/.ssh` boundary (issue #46) and **deliberately
deferred**: should Pi Central provision Pi-side resources for its sessions — skills, prompt
templates, settings, or packages?

Considered and **not** adopted now:

- **Shipping a skill** (e.g. the `github-cli` skill) into every user's Pi environment. Rejected as
  scope creep for a hardening slice: it mutates a user's Pi environment, and nothing needs it — a
  user's own skills are already discovered through `~/.pi`, which every session can read (C6), and
  the agent's `gh` token works without any skill at all.
- **Shipping an extension.** Still rejected, for the architectural reason already recorded: an
  extension is executable code that would live *inside* the sandboxed session, which
  [ARCHITECTURE.md](ARCHITECTURE.md#trust-boundaries) puts on the **untrusted** side. Shipping one
  means authoring untrusted code installed into every session. This is why Pi Central relays
  dialogs rather than originating them.

Note the distinction if this is ever revisited: a **skill** is Markdown guidance the model may load,
while an **extension** is code that executes. They are not interchangeable, and only the first is
plausibly shippable — but "plausibly" is not "decided".

**Decision needed:** does Pi Central ever write to a Pi environment (its own agent dir, the user's,
or a session-scoped one), or does it stay a pure peer that reads what exists? Until this is answered,
sessions inherit whatever the user has configured.
