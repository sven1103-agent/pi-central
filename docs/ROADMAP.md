# Roadmap

Phases are gated. Each phase answers a question that could invalidate the next one, so
later phases are not committed until earlier ones pass.

## Phase 0 — Prove the premise (spike)

**Question:** can two sessions in different working directories hold independent Safehouse
profiles at the same time?

- [ ] Spawn two `safehouse --workdir <X> -- pi --mode rpc --no-session` processes for two
      distinct directories.
- [ ] Confirm each process's `--explain` output differs (different workdir grants).
- [ ] Via RPC `bash` in session A, read a path in B's workdir → **expect denial**.
- [ ] Via RPC `bash` in session B, read a path in A's workdir → **expect denial**.
- [ ] Within each session, read/write its own workdir → **expect success**.
- [ ] Confirm `~/.pi` is readable from both (C6) and recorded as a known limit.
- [ ] Confirm `sandbox-exec` nesting fails from a child (C1) — documents *why* this works.

**Fail condition:** if one session can reach another's workdir, the isolation premise is
false. Stop and redesign.

**Deliverable:** `spikes/phase-0/` with a script and captured transcripts.

## Phase 1 — Orchestrator core (headless)

**Question:** can we reliably supervise N sessions without a UI?

- [ ] Session registry: `SessionManager.listAll()` merged with live-process state.
- [ ] Safehouse launcher: deterministic argv, per-session policy, `--env-pass` config.
- [ ] Process supervisor: spawn, JSONL line reader (LF-only, C7), `id` correlation,
      `agent_settled` gating (C8), process-group teardown.
- [ ] State machine: `registered → starting → idle ⇄ streaming → stopped/failed`.
- [ ] Lifecycle commands: `get_state`, `get_session_stats`, `prompt`, `abort`,
      `set_session_name`.
- [ ] Extension UI dialog relay (headless: log or auto-answer by policy).
- [ ] Test: three sessions in three cwds, prompt each, confirm no cross-talk.

**Deliverable:** `packages/orchestrator/` + a CLI smoke command.

## Phase 2 — Transport and UI shell

**Question:** can a person operate sessions comfortably from one place?

- [ ] Local transport (WebSocket over loopback, or stdio for a TUI). **Not sandboxed.**
- [ ] Session rail: name, cwd, model, thinking level, state, context usage.
- [ ] Transcript pane: streaming render, tool timeline, compaction/retry banners.
- [ ] Composer: prompt / steer / follow-up, queue visibility, Esc = `clear_queue`+`abort`.
- [ ] Approvals: `confirm` / `select` / `input` / `editor` rendered as real dialogs;
      `notify` / `setStatus` / `setWidget` as non-blocking chrome.
- [ ] Model + thinking-level pickers driven by `get_available_*`.
- [ ] Session switching = focus switch between live processes (C2).

**Deliverable:** runnable dashboard.

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

## Explicitly out of scope

- Re-implementing the Pi TUI or transcript renderer.
- A hosted/multi-user service. Pi Central is local and single-user.
- Forking Pi or reimplementing session semantics.
- Relaxing sandboxing for convenience.
