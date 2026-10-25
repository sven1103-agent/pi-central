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

## Q2 — What is the UI surface?

| Option | Pros | Cons |
|---|---|---|
| Browser app (localhost WS) | best transcript rendering, rich dialogs, easy approvals | web stack; loopback server is a surface |
| Terminal TUI | matches how Pi is already used | must build a TUI on the RPC stream; weaker for rich approvals |
| Both (transport shared, two clients) | maximally flexible | double the UI work |

**Working default:** browser app, because approval dialogs (`select`/`confirm`/`editor`)
and long transcripts are the differentiator.

**Decision needed:** confirm browser, TUI, or both.

## Q3 — `RpcClient` vs a custom supervisor

See [SANDBOX.md](SANDBOX.md#integration-with-rpcclient). `RpcClient` spawns Pi itself,
which conflicts with spawning through `safehouse`.

**Working default:** custom supervisor; reuse `RpcClient`'s protocol types and
correlation logic only. ADR-0003 records this.

**Decision needed:** confirm, or choose the launcher-shim approach for less code.

## Q4 — Session discovery scope

Show **all** sessions across all working directories, or a curated set?

- All: `SessionManager.listAll()` gives everything; the rail could be huge.
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
