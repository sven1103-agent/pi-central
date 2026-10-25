# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [Semantic Versioning](https://semver.org/).

This project's early history was a research spike plus a hard look at what the spike got wrong, so
several entries below record **defects that shipped and were fixed** rather than only features.
They are kept because each one is the reason a constraint or an invariant test exists.

## [0.1.0] — first iteration

The premise is proven and the first three layers work end to end. Verified by 342 automated tests,
a live three-session isolation run, and a replay of real session files.

### Added

- **Orchestrator** — session discovery by parsing Pi's session files directly, per-session Safehouse
  policy composition, process supervision, and a custom RPC supervisor with LF-only JSONL framing.
- **Agent credential identity** — agents act as themselves: an agent-owned keychain, git config,
  GitHub config and SSH key, while the host's own git config, GitHub config, ssh-agent and login
  keychain are denied. Provider credentials are treated as a *capability* rather than an identity,
  because Pi resolves them through `!command` indirections.
- **WebSocket transport** over loopback, with a guard that refuses to start inside a sandbox and
  says why.
- **UI** — a session rail ordered by attention, live transcript reconstruction, an approval dock
  that answers any session's dialogs, a bounded and traversable tool trace, and history searchable
  by content.
- **Untrusted-rendering pipeline** — `markdown-it({ html: false })` → DOMPurify → React, with
  exactly one audited insertion point, enforced by test.
- **Documentation as a first-class artifact** — constraints C1–C14, ten ADRs, protocol notes,
  user stories, and an increment plan. `npm run check:docs` verifies every reference resolves.

### Fixed

- Denying `~/.pi/agent/auth.json` made **every** sandboxed session exit `1`, because Pi opens it at
  startup and a policy denial is not the same as absence. The file holds `!command` indirections
  rather than secrets, so the denial protected nothing and broke everything.
- The keychain grant was derived from the agent tree rather than from the provider configuration,
  so a session could start, report idle, and be unable to reach a model.
- A resumed session rendered an **empty transcript**: Pi loads history into the model's context but
  never re-emits it as events.
- One tool call produced **two trace rows**, and the duplicates collided as React keys.
- A cached transcript was replayed on reconnect, **overwriting** a correct one with a stale copy,
  after which a once-only guard prevented recovery.
- Tool calls were appended after the conversation instead of interleaved, burying the agent's
  output under a thousand frames.
- Several values were displayed but not true: a page size shown as a session total, a process
  handle labelled as Pi's session id, idle sessions counted as running, and a permission error
  reported as a missing directory.

### Known limitations

- Model and thinking level are displayed but cannot be changed from the UI.
- `steer` is unavailable: the RPC surface Pi Central uses cannot express it, and the composer says
  so rather than showing a control that cannot work.
- No syntax highlighting, no compaction or retry banners, no file navigation.
- macOS only. Safehouse has no Linux backend (C10).
