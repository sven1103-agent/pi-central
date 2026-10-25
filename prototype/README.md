# Pi Central — feasibility prototype

A minimal, runnable proof that the architecture in [`../docs/`](../docs/) works: **one
dashboard orchestrating multiple Pi sessions in different working directories, each in its
own Safehouse sandbox.**

This is a spike, not the product. It exists to answer "does this actually work?" before
more design work. Expect rough edges; do not expect tests, packaging, or polish.

## Run it

```bash
cd prototype
npm install
npm start          # -> http://127.0.0.1:4319
```

Then open the URL, enter a working directory, and start a session.

### Important: run it unsandboxed

**Do not launch this with `safehouse`.** Seatbelt does not nest
([C1](../docs/CONSTRAINTS.md#c1--macos-seatbelt-does-not-nest)), so a sandboxed
orchestrator cannot spawn sandboxed sessions. The server detects an inherited sandbox at
startup and warns, and `sandboxed` mode will fail with
`sandbox-exec: sandbox_apply: Operation not permitted`.

```bash
# correct
node src/server.ts

# incorrect — sandboxed sessions will fail to start
safehouse -- node src/server.ts
```

## What to look at

| Feature | Where |
|---|---|
| Session rail with live state | left panel |
| Start a session in any working directory | left panel form |
| Safehouse vs Direct isolation, shown per session | radio group, then the green/amber banner |
| Exact launch command (auditable) | grey monospace line under the session header |
| Streamed transcript with Markdown | main pane, left |
| Fenced code with highlighting | send a prompt asking for a code block |
| Tool calls inline | send a prompt asking to read a file |
| File navigation of the session's workdir | main pane, right |
| Approval dialogs | appears automatically when an extension asks |
| Recent sessions on disk | left panel, bottom (read-only history) |

## What is verified

Everything below was **executed**, not assumed.

| Claim | Evidence |
|---|---|
| RPC protocol works end-to-end | Real session, real model, streamed `PI CENTRAL OK.` + Markdown + fenced block |
| Event relay is complete | 10 event types observed: `agent_start/end/settled`, `turn_start/end`, `message_start/end/update`, `entry_appended`, `extension_ui_request` |
| Delta reconstruction works | `text_delta` accumulation produced the exact expected string |
| File navigation works | Listed 46 entries of a real repository |
| Path escape is refused | `../../..` → `path escapes the session working directory` |
| Absolute-path escape is refused | `/etc` → refused |
| Sandboxed mode composes the right command | `safehouse --workdir <cwd> -- pi --mode rpc --no-session` |
| C1 confirmed live | sandboxed mode fails with `sandbox_apply: Operation not permitted` |
| Sandbox self-check works | Server detected it is itself inside a sandbox and warned |
| Markdown sanitization works | `<script>`, `<img onerror>`, `javascript:` URL, `<iframe>` all neutralized; bold/code still render |
| Session discovery works | 40 historical sessions read from `~/.pi/agent/sessions/`, headers parsed |
| LF-only framing | Buffer-based split on `0x0a`; no `readline` anywhere |

### Not verified

- **No screenshot.** Chromium cannot launch inside this development sandbox, so the visual
  layout is unconfirmed. Run it and look.
- **No sandboxed session actually ran.** This dev environment is itself sandboxed, so only
  `direct` mode could be exercised. The sandboxed path is verified only as far as command
  composition and the expected `EPERM`.
- No tests, no type-checking, no packaging.

## Deliberate simplifications

Each of these is a known gap, not an oversight:

| Simplification | Production answer |
|---|---|
| `--no-session` for every session | resume real sessions, using the header's `cwd` for the policy (ADR-0004) |
| Transcript rebuilt from events only | seed from `get_history`/`get_entries` on attach |
| No persistence | `~/.config/pi-central/` for layout and project list (Q7) |
| Custom regex highlighter in `app.js` | Shiki with lazy grammars (ADR-0005) |
| Plain `innerHTML` after DOMPurify | React; keep the single sanitized merge point |
| No auth on the WebSocket | loopback + explicit check (C5) |
| Direct mode exists at all | delete it once real sandboxing is available |

`direct` mode is present **only** because this prototype was developed inside a sandbox
where `safehouse` cannot nest. It is labelled `NONE — pi runs unsandboxed…` in the UI and
`NO ISOLATION` in the rail so it cannot be mistaken for the real thing.

## Findings that should feed back into the design

1. **Pi emits a burst of `extension_ui_request` records at startup.** Many `notify` and
   `setStatus` records arrive before the first prompt. The UI must treat non-dialog
   methods as non-blocking from the very first record, or it will render spurious
   approval prompts. (This prototype filters to `select`/`confirm`/`input`/`editor`.)
2. **`get_state` can succeed before the session is fully ready.** Priming state
   immediately after spawn works, but `model` and `sessionFile` may be briefly absent.
3. **stderr is the only diagnostic channel for a failed launch.** The `EPERM` from
   `sandbox-exec` appears on stderr and the process exits `71`. Losing stderr means a
   failed session is indistinguishable from a hung one, so the supervisor must retain a
   stderr tail per session.
4. **Process-group teardown matters.** `detached: true` plus `kill(-pid)` is needed so a
   sandboxed tree cannot outlive the dashboard.
5. **`contextUsage.percent` is `null` until a fresh assistant response** — expected per the
   docs, and it means the context indicator must tolerate `null` at session start.

## Layout

```
prototype/
├── src/
│   ├── server.ts     # HTTP + WebSocket, static serving, file navigation
│   ├── fleet.ts      # session state machine, approval dialogs
│   ├── rpc.ts        # LF-only JSONL client, process-group teardown
│   ├── policy.ts     # THE single place Safehouse argv is assembled
│   └── registry.ts   # discovery of persisted sessions on disk
└── public/
    ├── index.html
    ├── app.js        # rendering, sanitized Markdown pipeline, file browser
    └── style.css
```

`policy.ts` is the file to read first: it is where
[ADR-0001](../docs/decisions/0001-out-of-process-orchestration.md),
[ADR-0002](../docs/decisions/0002-per-session-sandbox.md) and
[ADR-0007](../docs/decisions/0007-filesystem-access-model.md) become actual code.
