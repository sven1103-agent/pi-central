# Architecture Decision Records

Decisions that shape Pi Central, with the constraints that forced them. Each record states
the context, the decision, its consequences, and the alternatives rejected — so a future
reader can tell whether a decision still holds.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-out-of-process-orchestration.md) | Orchestrate out-of-process rather than in-process (SDK) | Accepted |
| [0002](0002-per-session-sandbox.md) | One sandbox per session; never a multi-workdir orchestrator sandbox | Accepted |
| [0003](0003-custom-supervisor.md) | Custom process supervisor instead of `RpcClient` | Accepted |
| [0004](0004-session-identity.md) | A session is identified by (session file, working directory) | Accepted |
| [0005](0005-typescript-stack.md) | TypeScript + Node orchestrator, TypeScript + React UI | Accepted |
| [0006](0006-untrusted-markdown-rendering.md) | Untrusted content rendering in a browser UI | Accepted |
| [0007](0007-filesystem-access-model.md) | Filesystem access: orchestrator at user UID | Accepted |
| [0008](0008-no-mid-session-workdir-change.md) | No mid-session working-directory change | Accepted |
| [0009](0009-direct-session-discovery.md) | Discovery parses session files directly; no Pi agent core at runtime | Accepted |
| [0010](0010-agent-credential-identity.md) | Agent credential identity: agent-owned secrets, delivered per session | Accepted |

## Format

Each ADR is a single Markdown file named `NNNN-kebab-title.md` with:

- **Status** — Proposed, Accepted, Superseded, Deprecated.
- **Context** — the forces at play, with evidence where possible.
- **Decision** — what was chosen.
- **Consequences** — positive and negative, stated honestly.
- **Alternatives considered** — and why each was rejected.

Superseding an ADR means marking the old one `Superseded by ADR-NNNN` and writing a new
record. Do not rewrite history in place.

## Constraint references

ADRs cite the hard limits in [../CONSTRAINTS.md](../CONSTRAINTS.md) as `C1`–`C11`. Those
limits were verified against Pi `1.4.0` and Agent Safehouse `0.12.0`; re-verify them when
either is upgraded, since an ADR's premises can expire.
