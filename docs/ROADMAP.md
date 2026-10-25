# Roadmap

Phases are gated. Each phase answers a question that could invalidate the next one, so
later phases are not committed until earlier ones pass.

## Phase 0 — Prove the premise (spike) — ✅ PASSED

**Question:** can two sessions in different working directories hold independent Safehouse
profiles at the same time?

**Answer: yes.** 12/12 checks passed on macOS with Pi 1.4.0 and Safehouse 0.12.0. Each
session is confined to its own working directory, enforced by the OS, verified through the
model-facing `bash` tool path. Full evidence: [`spikes/phase-0/RESULT.md`](../spikes/phase-0/RESULT.md).

Harness: [`spikes/phase-0/verify.ts`](../spikes/phase-0/verify.ts). Run it **unsandboxed**;
it refuses otherwise, because Seatbelt does not nest and every check would be meaningless.

```bash
node spikes/phase-0/verify.ts --dry-run   # compose + print policy, spawn nothing
node spikes/phase-0/verify.ts             # run the real probes
```

- [x] Spawn two `safehouse --workdir <X> -- pi --mode rpc` processes for two
      distinct directories.
- [x] Confirm each process's policy differs (different workdir grants).
- [x] Via RPC `bash` inside session A, read and write in B's workdir → **denied**.
- [x] Via RPC `bash` inside session B, read and write in A's workdir → **denied**.
- [x] Within each session, read and write its own workdir → **succeeded**.
- [x] Confirm from *outside* the sandbox that no denied write left a file behind.
- [x] Confirm a non-ancestor sibling's contents are unreadable (the decisive boundary).
- [x] Confirm `sandbox-exec` nesting fails from a child (C1) — documents *why* this works.

**Deliverables:** the harness and `RESULT.md` with captured evidence.

**Note:** fixtures must not live under `/tmp` or `/var/folders`, which the base profile
grants globally; a pass there would be a false pass. The harness places them in `$HOME`
(override with `PHASE0_ROOT`) and refuses to run from inside a sandbox.

## Phase 1 — Orchestrator core (headless)

**Question:** can we reliably supervise N sessions without a UI?

Informed by [USER-STORIES.md](USER-STORIES.md): starting work and resuming history are the
critical paths, so they are in scope here rather than deferred.

- [ ] Session registry: discovered session files (ADR-0009) merged with live-process
      state.
- [ ] **Default workspace** (US-3): an app-owned directory for sessions started without a
      path, outside `$HOME` proper, `/tmp`, and `~/.pi` (D-5).
- [ ] Safehouse launcher: deterministic argv, per-session policy, `--env-pass` config.
- [ ] Process supervisor: spawn, JSONL line reader (LF-only, C7), `id` correlation,
      `agent_settled` gating (C8), process-group teardown.
- [ ] State machine: `registered → starting → idle ⇄ streaming → stopped/failed`.
- [ ] Lifecycle commands: `get_state`, `get_session_stats`, `prompt`, `abort`,
      `set_session_name`.
- [ ] **Resume a historical session** (US-5), validating the recorded cwd *before* spawn
      and surfacing the missing-directory choice (D-4). Pi exits 1 in RPC mode here. The
      only choices are resume-in-place or cancel: Pi Central does not retarget a session
      ([ADR-0008](decisions/0008-no-mid-session-workdir-change.md)).
- [ ] Extension UI dialog relay (headless: log or auto-answer by policy).
- [ ] Test: three sessions in three cwds, prompt each, confirm no cross-talk.

**Deliverable:** `packages/orchestrator/` + a CLI smoke command.

## Phase 2 — Transport and UI shell

**Question:** can a person operate sessions comfortably from one place?

Stack is fixed: React + Vite UI, WebSocket over loopback, TypeScript orchestrator
([STACK.md](STACK.md)).

- [ ] WebSocket server on `127.0.0.1` with typed control/event envelopes. **Not
      sandboxed** — and refuse to start if an inherited sandbox is detected.
- [ ] Session rail: name, cwd, model, thinking level, state, context usage.
- [ ] Transcript pane: streaming render, tool timeline, compaction/retry banners.
- [ ] Markdown pipeline: `markdown-it({ html: false })` → DOMPurify → React, with a
      strict CSP and no `dangerouslySetInnerHTML` outside it ([ADR-0006](decisions/0006-untrusted-markdown-rendering.md)).
- [ ] Shiki syntax highlighting with lazy grammar loading.
- [ ] Composer: prompt / steer / follow-up, queue visibility, Esc = `clear_queue`+`abort`.
- [ ] Approvals: `confirm` / `select` / `input` / `editor` rendered as real dialogs;
      `notify` / `setStatus` / `setWidget` as non-blocking chrome.
- [ ] Model + thinking-level pickers driven by `get_available_*`.
- [ ] Session switching = focus switch between live processes (C2).

**Deliverable:** runnable dashboard.

## Phase 2.5 — File navigation and operations

**Question:** can a person browse and manage a session's project comfortably?

File access runs **directly at the user's UID** — no sidecar, no sandbox in this path
([ADR-0007](decisions/0007-filesystem-access-model.md)).

- [ ] List and read under the orchestrator's `fs`, confined to the session's `cwd`.
- [ ] Lazy directory expansion; hidden-file toggle; size caps; binary detection and refusal.
- [ ] Containment: canonicalize with `realpath`, then verify inside `cwd`. No string
      prefix checks; symlinks resolved before the check.
- [ ] File operations: create file/dir, rename, move, delete — destructive actions behind
      explicit confirmation, never an implicit recursive delete.
- [ ] Content editing stays out of scope; Pi mutates file contents from inside its sandbox.
- [ ] Tests: `..` escape refused, symlink escape refused, binary refused, recursive delete
      confirmed.

**Deliverable:** file tree + viewer + basic file operations, with the guardrail tests.

## Phase 3 — Fleet ergonomics

- [ ] Create a session in a new working directory from the UI.
- [ ] Resume a historical session: read its header `cwd`, compose a profile, spawn there.
- [ ] Fork / clone / rename from the rail.
- [ ] Bulk view: which sessions are streaming, which await approval, which are near
      context limits.
- [ ] Crash surfacing: stderr, exit code, manual retry (never silent auto-restart).
- [ ] Export (`export_html`) per session.

## Phase 4 — Hardening

- [ ] Loopback-only binding with an explicit access check (C5: loopback is not a control).
- [ ] Refuse to start when an inherited sandbox is detected (C1) — easy mistake in this
      environment, where `pi` is normally launched via `safehouse`.
- [ ] XSS regression suite: `<img onerror>`, `<script>`, `javascript:` links in transcripts
      and in browsed Markdown files.
- [ ] File-browser guardrail suite: containment, symlink escape, confirmation on delete.
- [ ] Never pass `--allow-workdir-config-writes` / `--allow-profile-writes`.
- [ ] Never enable `wide-read`; deny it in config validation.
- [ ] Verify per-session env: no credential leaks across sessions (C4).
- [ ] Process-group teardown verified under SIGKILL of the orchestrator.
- [ ] Document the `~/.pi` cross-transcript exposure as a known limitation (C6).
- [ ] Packaging: `pi install` package vs standalone app — decide and implement.

## Backlog / ideas

- Approval policy engine: auto-approve/deny rules per project, with an audit log.
- Cost and token rollup across sessions (`get_session_stats`).
- Desktop notifications when a session enters `awaiting-approval`.
- Session search across all projects (`SessionInfo.allMessagesText`).
- Diff review pane fed from `tool_execution_*` for edit/write calls.
- Multi-machine: agents on a remote host, orchestrator local (needs a remote launcher).
- Rendered-Markdown preview for browsed `.md` files (through the same sanitized
  pipeline), distinct from the escaped-source view.

## Explicitly out of scope

- Re-implementing the Pi TUI or transcript renderer.
- A hosted/multi-user service. Pi Central is local and single-user.
- Forking Pi or reimplementing session semantics.
- Relaxing sandboxing for convenience.
