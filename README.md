# Pi Central

> The central station where Pi sessions come together and are orchestrated.

Pi Central is a local dashboard for running, watching, and switching between multiple
[Pi](https://pi.dev) coding-agent sessions that live in **different working directories**, while
keeping every session inside its own **Agent Safehouse** sandbox.

The name is the design brief: a central station is where independent lines arrive, are dispatched,
and are kept apart from one another. Pi Central does the same for agent sessions.

**Status: v0.1.0 — works end to end, verified.** Not yet published; there is no released artifact.

## The problem

Pi has no fleet concept. One `pi` process owns one session and one working directory:

- Sessions are JSONL files grouped by working directory under `~/.pi/agent/sessions/`.
- RPC mode (`pi --mode rpc`) is a long-lived child process speaking JSONL over stdio.
- There is **no daemon, no attach protocol, no socket registry, and no port**. Each RPC process
  privately owns its own stdin/stdout.

So working on three repositories means three terminals, three scrollbacks, and no single place to
see what is running, what is waiting for approval, or how much context each session has burned.

## The non-obvious constraint

macOS Seatbelt sandboxing does **not nest**. A process already inside `sandbox-exec` cannot apply a
second profile — `sandbox_init` returns `EPERM`. Safehouse's own profile documents this as not
fixable with additional allow rules.

This single fact rules out the obvious design (a Pi extension that hosts other sessions in-process)
and dictates the architecture: **the orchestrator must live outside any sandbox, and each session
must be its own `safehouse` invocation.** See [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md).

It also means Pi Central must run from a **plain terminal** — not from an editor task, a sandboxed
shell, or an agent harness. It checks this before binding a port and refuses to start with an
explanation rather than failing confusingly later.

## Design in one picture

```
┌──────────────────────────────┐
│  Pi Central UI (localhost)   │  session rail · transcript · approvals · tool trace
│  React + Vite, TypeScript    │  Markdown rendered inert (ADR-0006)
└──────────────┬───────────────┘
               │  WebSocket over loopback (typed envelopes)
┌──────────────▼───────────────┐
│  Orchestrator (unsandboxed)  │  session registry · process supervision
│  TypeScript on Node          │  · one sandboxed pi process per session
└──────────────┬───────────────┘
               │  spawn: safehouse --workdir <cwd> -- pi --mode rpc
     ┌─────────┼─────────┐
     ▼         ▼         ▼
  ┌──────┐  ┌──────┐  ┌──────┐
  │ pi   │  │ pi   │  │ pi   │   one sandbox per working directory
  │ /a   │  │ /b   │  │ /c   │   isolation preserved per session
  └──────┘  └──────┘  └──────┘
```

Each session gets a correctly composed Safehouse profile for its own workdir. The orchestrator
never runs untrusted content, so being outside the sandbox is safe by construction.

## Quick start

**One process.** The orchestrator serves the built UI and the WebSocket from the same origin, so
there is no dev server to start and no port to coordinate. It must run from a plain terminal (see
the constraint above).

```bash
npm install
npm run ui:build      # once, and after any UI change
npm run server        # the orchestrator, which also serves the UI
```

Then open <http://127.0.0.1:8787> — the URL the server prints.

Serving the UI from the orchestrator is not only convenience. A Vite dev server watches
`packages/ui/src`, so an agent editing a component reloads the interface you are using out from
under you, mid-edit, into a syntax-error overlay. A built UI removes the watcher. It also makes
the `connect-src 'self'` in the CSP truthful by construction: the socket really is same-origin with
the document. See [docs/DOGFOODING.md](docs/DOGFOODING.md).

### Working on the UI

For hot reload while editing components, run the dev server instead — it proxies `/ws` to the
orchestrator and still needs no configuration:

```bash
npm run server -- --no-ui   # terminal 1 — socket only
npm run ui:dev              # terminal 2 — Vite, on http://localhost:5173
```

| Key | Action |
|---|---|
| `⌘N` | New session in an app-owned scratch workspace — no directory to choose |
| `⌘⇧O` | Open in a directory (the secondary path) |
| `Enter` | Send, or queue while a run is in progress |
| `Esc` | Answer an open dialog → close a popover → stop the run. Never clears your draft |

## What works, and what does not

Stated plainly, because a dashboard that overstates itself is worse than one that does less.

**Works:** multiple sandboxed sessions in different directories with verified isolation; live
transcripts reconstructed from Pi's delta-only stream; the approval dock (`confirm` / `select` /
`input` / `editor`) answerable for any session; a bounded tool trace with full traversal; history
searchable by content, with a clear refusal when a session's directory is gone; agent-scoped
credentials with the host's own credentials denied, and commits signed as the agent when the store is
configured to sign.

**Not yet:** no file navigation. It is an issue rather than a wish — see below.

## Working on this project

Work is organised as **increments** (GitHub milestones) containing **slices** (issues). A slice is
sized to land in one pull request and to be verifiable on its own.

- [docs/INCREMENTS.md](docs/INCREMENTS.md) — what each increment delivers and why it is ordered
  that way
- Issues — the slices, with acceptance criteria
- [docs/ROADMAP.md](docs/ROADMAP.md) — the long view, including what is deliberately out of scope

```bash
npm test           # unit + component tests, all packages
npm run typecheck  # two configs: Node libs and DOM libs cannot share one
npm run check:docs # every reference in every Markdown file resolves
npm run ui:build   # production build of the UI
```

The `check:docs` step exists because this repository is docs-driven, and a reference to a deleted
file still *looks* authoritative. It has caught real rot more than once.

## Documentation

| Document | What it covers |
|---|---|
| [docs/USER-STORIES.md](docs/USER-STORIES.md) | What users need, and the constraints those needs create |
| [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) | The Seatbelt nesting limit and its consequences (C1–C15c) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, trust boundaries, lifecycle |
| [docs/STACK.md](docs/STACK.md) | TypeScript/Node orchestrator, React UI, rendering pipeline |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | The Pi RPC surface Pi Central depends on |
| [docs/SANDBOX.md](docs/SANDBOX.md) | How safehouse is invoked per session, and what the composed policy denies |
| [docs/AGENT-SETUP.md](docs/AGENT-SETUP.md) | Creating the agent identity a session runs as: SSH key, gitconfig, signing, `gh` |
| [docs/INCREMENTS.md](docs/INCREMENTS.md) | Increments, slices, and how work is sequenced |
| [docs/DOGFOODING.md](docs/DOGFOODING.md) | Using Pi Central to develop Pi Central, and what breaks if you run it from the checkout you edit |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases, verification status, and out-of-scope items |
| [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | Unresolved decisions |
| [docs/decisions/](docs/decisions/) | Architecture decision records |
| [packages/ui/DESIGN.md](packages/ui/DESIGN.md) | The UI design system, as implemented |

## Principles

1. **Isolation is the feature.** Never trade per-session sandboxing for convenience.
2. **The orchestrator is the trust boundary.** It stays local, holds no untrusted content, and
   never executes model output.
3. **Pi is the source of truth.** Do not re-implement session semantics; consume RPC and the
   persisted session tree.
4. **Additive, not a replacement.** Pi Central supervises `pi`; it does not fork it.
5. **Local first.** No telemetry, no network egress beyond providers Pi already calls.
6. **Untrusted content is inert.** Transcripts and file contents are strings to display, never
   markup to execute — see [ADR-0006](docs/decisions/0006-untrusted-markdown-rendering.md).
7. **Confine the agents, not the user.** Safehouse constrains model-generated actions in a workdir.
   The orchestrator is a user-level app acting as the user, on the user's files — see
   [ADR-0007](docs/decisions/0007-filesystem-access-model.md).
8. **Never state something false.** A displayed value that is wrong is a defect, not a cosmetic
   issue: this project has shipped misleading counts, a mislabelled session id, and a permission
   error reported as a missing directory, and treats each as a bug.
9. **A peer, not a configurator.** Pi Central does not write into a user's Pi environment — no
   skills, no extensions, no settings. It reads what exists and writes only its own state. A
   defense does not require a new artifact in the environment it defends, and any setup a session
   needs is a documented action the user takes (see [docs/AGENT-SETUP.md](docs/AGENT-SETUP.md)).

## License

MIT — see [LICENSE](LICENSE).
