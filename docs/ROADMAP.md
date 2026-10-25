# Roadmap

Phases are gated. Each phase answers a question that could invalidate the next one, so
later phases are not committed until earlier ones pass.

## Phase 0 — Prove the premise (spike) — ✅ PASSED

**Question:** can two sessions in different working directories hold independent Safehouse
profiles at the same time?

**Answer: yes.** 12/12 checks passed on macOS with Pi 1.4.0 and Safehouse 0.12.0. Each
session is confined to its own working directory, enforced by the OS, verified through the
model-facing `bash` tool path. Full evidence: [`spikes/phase-0/RESULT.md`](../spikes/phase-0/RESULT.md).

The Phase 0 harness was a spike script that imported the feasibility prototype; it was retired
with the prototype at v0.1.0. Its checks live on in `packages/orchestrator/verify-three.ts`, which
runs a strict superset — three sessions instead of two, plus the credential boundary — against the
real product code path. Run it **unsandboxed**; it refuses otherwise, because Seatbelt does not nest
and every check would be meaningless.

```bash
node packages/orchestrator/verify-three.ts
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

- [x] Session registry: discovered session files (ADR-0009) merged with live-process
      state. `registry.ts`, `supervisor.ts`
- [x] **Default workspace** (US-3): an app-owned directory for sessions started without a
      path, outside `$HOME` proper, `/tmp`, and `~/.pi` (D-5). `config.ts`, tested
- [x] Safehouse launcher: deterministic argv, per-session policy. `policy.ts`, tested; the
      only argv-assembly site (enforced). *Credential delivery is now
      [ADR-0010](decisions/0010-agent-credential-identity.md), superseding the earlier
      `--env-pass` plan: env vars cannot carry an SSH key, and `--env-pass` merges
      append-only so it cannot remove `SSH_AUTH_SOCK` (C4a).*
- [x] Process supervisor: spawn, JSONL line reader (LF-only, C7), `id` correlation,
      `agent_settled` gating (C8), process-group teardown. `rpc.ts`, `framing.ts`, `state.ts`
- [x] State machine: `registered → starting → idle ⇄ streaming → stopped/failed`.
      `state.ts` (pure), applied by `supervisor.ts`
- [x] Lifecycle commands: `get_state`, `get_session_stats`, `prompt`, `abort`,
      `set_session_name`
- [x] **Resume a historical session** (US-5), validating the recorded cwd *before* spawn
      and surfacing the missing-directory choice (D-4). Pi exits 1 in RPC mode here. The
      only choices are resume-in-place or cancel: Pi Central does not retarget a session
      ([ADR-0008](decisions/0008-no-mid-session-workdir-change.md)). `resume.ts`, tested
- [ ] Extension UI dialog relay (headless: log or auto-answer by policy). *Recorded as
      `awaiting-approval` and answerable; a headless policy is still open (Q6).*
- [ ] **Test: three sessions in three cwds, prompt each, confirm no cross-talk.** The
      isolation is proven for two sessions in [Phase 0](../spikes/phase-0/RESULT.md); the
      three-session supervisor-level test still needs a plain terminal.

**Deliverable:** `packages/orchestrator/` + a CLI smoke command. *Built; the two remaining
items need an unsandboxed run (C1).*

### Phase 1 follow-ups (from [ADR-0010](decisions/0010-agent-credential-identity.md))

- [x] **Session spawn no longer inherits `process.env`.** `env.ts` builds an explicit
      allowlist; `LaunchSpec.env` is **required**, so omitting it is now a type error rather
      than a silent leak. Verified: a planted `SSH_AUTH_SOCK` and `HF_TOKEN_STRICT` do not
      reach the session. `env.test.ts`
- [x] **`FORBIDDEN_ENABLE` now covers `ssh`, `keychain`, `cloud-credentials`,
      `cloud-storage`.** Verified by policy diff that `--enable=ssh` appends an SSH
      integration block and `keychain` grants keychain RW + `SecurityServer` mach-lookups.
- [x] **`--append-profile` implemented.** `fragment.ts` renders a deterministic,
      `HOME_DIR`-relative fragment. It denies the host's `~/.gitconfig`, `~/.config/gh`, the
      ssh-agent sockets, and `~/.ssh` private keys. `policy.ts` writes it `0600` and passes
      `--append-profile`; Safehouse write-protects the file.
- [x] **Agent credential store** with `managed`/`external` ownership, explicit re-import,
      and drift detection. `agent-store.ts`. Inspection is metadata-only: a planted token
      and private key do not appear anywhere in a snapshot or drift report.
- [ ] **Remove the `auth.json` deny and add the keychain grants**
      ([ADR-0010 Amendment 1](decisions/0010-agent-credential-identity.md#amendment-1--provider-credentials-are-a-capability-not-an-identity)).
      ✅ **Done** in `cd7b069` + the follow-up commit: `auth.json` is allowed, the keychain
      grant is derived from the provider configuration, and `~/.agent` is auto-adopted when it
      exists (so the hardening setup is imported, not duplicated).

### Verification performed for the above

The first live run of `verify-three.ts` **failed**, and that is the most valuable result so
far: it found a bug no policy-level check could see (C12). See
[ADR-0010 Amendment 1](decisions/0010-agent-credential-identity.md#amendment-1--provider-credentials-are-a-capability-not-an-identity).

- Composed policy parses as valid SBPL (`sandbox-exec` reports syntax errors *before*
  attempting to apply, so a parse check works even where C1 blocks execution). Negative
  control included — a deliberately broken fragment **does** report a syntax error.
- Our denies land at lines 1092–1110, **after** the base grants at 949/967: last-match-wins
  makes them authoritative.
- Safehouse emits `(deny file-write* (literal "<fragment>"))`, so a session cannot rewrite
  the rules confining it.

### Live verification (plain, unsandboxed terminal — C1)

**Run 2026-10-25: 39/39 checks passed**, three sessions across three directories:

- 3/3 sessions booted sandboxed with their own workdir and their own bespoke fragment.
- 12/12 cross-directory probes denied — each session reads only its own secret, and cannot
  read, write into, or even list a sibling's directory.
- The credential boundary: `SSH_AUTH_SOCK` absent (fake value **planted** in the parent, so
  "absent" is real evidence), an ambient token absent, `ssh-add -l` unreachable, host
  `.gitconfig` and `~/.config/gh` denied.
- Independent confirmation from **outside** every sandbox: no canary file appeared anywhere,
  and each session's own secret is intact.
- `auth.json` readable (not denied — the bug that made every session exit 1), the agent dir
  writable, and **426 models enumerated** across the three providers.
- Stopping one session did not disturb the others.

Fixtures were removed afterwards; no canary was left in the agent tree or the session store.

Two runs were needed, and both failures were informative: the first exposed the `auth.json`
defect (C12) **and** revealed that an `auth.json` deny protects nothing, since the file holds
`!command` indirections rather than keys. The second exposed a **stale assertion**: the harness
still demanded `auth.json` be denied, so a green run was impossible without reintroducing the
bug — a check that measures the bug as a success. That is worth remembering as a failure mode of
verification harnesses generally.

### Remaining checks

- A **live** login-keychain denial (the policy denies both login keychain files and the composed
  SBPL parses with correct ordering, but no session has been asked to try).
- A real model call, as opposed to provider enumeration (see the note in
  [ADR-0010](decisions/0010-agent-credential-identity.md#verification-this-amendment-requires)).
- Experiment 7 (`--enable=ssh` diff) is static only.

### Verification status

| Layer | State |
|---|---|
| Unit tests (`node --test`) | ✅ 140 passing |
| Typecheck (`tsc --noEmit`) | ✅ clean, tsc 5.9.3 |
| Architectural invariants | ✅ enforced by test (single argv site, no Pi runtime import, no `--add-dirs`, no write op on the credential store) |
| Discovery against the real store | ✅ 833 sessions, ~900 ms |
| Real sandboxed sessions, 3 cwds | ✅ live, 39/39 checks |
| Credential boundary from inside a session | ✅ live, with planted secrets as falsifiers |

## Phase 2 — Transport and UI shell

**Question:** can a person operate sessions comfortably from one place?

Stack is fixed: React + Vite UI, WebSocket over loopback, TypeScript orchestrator
([STACK.md](STACK.md)). The design is in [packages/ui/DESIGN.md](../packages/ui/DESIGN.md).

- [x] WebSocket server on `127.0.0.1` with typed control/event envelopes. **Not
      sandboxed** — and **refuses to start** if an inherited sandbox is detected, before
      binding a port (`sandbox-guard.ts`).
- [x] Session rail: name, cwd, model, thinking level, state, context usage, cost — ordered by
      **attention**, so a session blocked on a dialog is first.
- [x] Transcript pane: streaming reconstruction from the delta-only wire, tool timeline, and
      quarantined tool output.
- [x] Markdown pipeline: `markdown-it({ html: false })` → DOMPurify → React, with a strict CSP
      and exactly one audited `dangerouslySetInnerHTML` site ([ADR-0006](decisions/0006-untrusted-markdown-rendering.md)).
- [x] Composer: prompt / follow-up with honest mode labelling, queue visibility, and an Esc
      precedence ladder that never touches the draft. *Steer deferred* — see below.
- [x] Approvals: `confirm` / `select` / `input` / `editor` as real dialogs;
      `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text` as non-blocking.
- [x] Scratch-first start (`⌘N`, no path), with `Open in a directory…` as a secondary sheet
      (US-1, US-3).
- [x] History: content search, project, age, size, `cwdExists` badge, and a refusal with a way
      forward when the directory is gone (US-4, US-5).
- [x] Session switching = focus switch between live processes (C2).
- [ ] **Shiki syntax highlighting with lazy grammar loading.** Deferred: code renders in a
      styled `<pre>` today. Shiki adds ~200 kB plus its own lazy-loading path, so it is worth
      doing deliberately rather than tacked on — and it is the one Phase 2 item that is
      cosmetic rather than behavioural.
- [ ] **Model + thinking-level pickers driven by `get_available_*`.** Deferred: the rail shows
      both read-only. The commands are catalogued in [PROTOCOL.md](PROTOCOL.md) and wired in
      `verify-three.ts`, but no `Control` carries them yet, so a picker would need a protocol
      addition first.
- [ ] **Steer.** Blocked on the protocol, not the UI: `Control` has no `steer` and the
      supervisor hard-codes `followUp` when streaming. The hint line says so rather than
      showing a control that cannot work.
- [ ] Compaction / retry banners.

**Deliverable:** runnable dashboard. ✅ `npm run server` + `npm run ui:dev`.

### Verification status (Phase 2)

| Layer | State |
|---|---|
| Unit tests | ✅ 267 passing (protocol, orchestrator, UI) |
| Typechecks | ✅ two configs: Node libs and DOM libs cannot share one |
| Untrusted-rendering tests | ✅ parse the sanitized DOM: no live handler, no dangerous element, no executable scheme |
| Component tests | ✅ real components rendered through Vite's SSR transform |
| UI invariants | ✅ enforced by test: one insertion site, `html:false`, DOMPurify after markdown-it, no `agent_end` switch (C8), no cwd change (ADR-0008) |
| Production build | ✅ `vite build` |
| **Visual review in a browser** | ⏳ blocked by C1 from the development sandbox — Chromium cannot bind its profile socket here. Components are verified by rendered markup instead, which is stronger for behaviour and weaker for layout. |

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
