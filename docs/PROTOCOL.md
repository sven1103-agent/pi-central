# RPC surface Pi Central depends on

Reference for the Pi RPC API Pi Central consumes. Verified against Pi `1.4.0`.
Canonical upstream docs: `docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md`,
`docs/rpc-extension-ui.md` in the installed package.

## Invocation

```
pi --mode rpc [--no-session | --session <path|id> | --continue | --session-id <id>]
              [--session-dir <dir>] [--name <name>]
              [--provider <p>] [--model <m>] [--thinking <level>]
              [--tools ...] [--approve|--no-approve]
```

- `@file` prompt arguments are **rejected** in RPC mode; prompts go through the `prompt`
  command.
- Project trust cannot prompt in RPC. Without `--approve`, `--no-approve`, a saved
  decision, or an extension handler, `defaultProjectTrust: "always"` loads project
  resources and `"ask"`/`"never"` skip them.

## Record families

| Direction | Record | Purpose |
|---|---|---|
| stdin | command | prompt, inspect state, configure, manage session |
| stdout | `response` | one command's outcome (`id` echoed) |
| stdout | session event | streaming run/message/tool/queue/compaction/retry activity |
| both | extension UI | dialogs and notifications |

## Commands used by Pi Central

### Resuming a session whose working directory is gone

Pi behaves differently by mode. Verified in `dist/main.js:558`: if a session's recorded
`cwd` no longer exists, **interactive** mode prompts ("continue in current cwd" / cancel)
while **print, JSON, and RPC** modes print `MissingSessionCwdError` to stderr and
**`process.exit(1)`**.

Pi Central drives Pi in RPC mode, so it gets the exit, not the prompt. **Validate the
recorded cwd before spawning** and offer the choice in the UI. This case is common: a
finished git worktree, an unmounted volume, or a moved checkout all leave a session
pointing at a directory that no longer exists. See
[US-5](USER-STORIES.md#us-5--continue-a-past-session).

Relevant helpers, both exported: `switch_session` accepts a `cwdOverride`, and
`SessionManager.forkFrom(sourcePath, targetCwd, …)` copies history into a session whose
header carries the new cwd.

### Lifecycle and identity

| Command | Use |
|---|---|
| `get_state` | rail status: model, `thinkingLevel`, `isStreaming`, `sessionFile`, `sessionId`, `sessionName`, `messageCount`, `pendingMessageCount` |
| `get_session_stats` | context usage, tokens, cost — the "how full is this session" indicator |
| `set_session_name` | rename from the UI (`--name` sets it at spawn) |

### Prompting

| Command | Use |
|---|---|
| `prompt` | send user input; `data.disposition` is `started` \| `queued` \| `handled` |
| `steer` | redirect mid-run (delivered after current turn's tools) |
| `follow_up` | queue work for after the run finishes |
| `abort` | stop and wait for idle |
| `clear_queue` | Esc semantics: returns queued text for the client editor, then `abort` |

During streaming, `prompt` **requires** `streamingBehavior: "steer" | "followUp"` or it
errors. Extension commands (`/foo`) execute immediately even while streaming.

### Session management

| Command | Use |
|---|---|
| `new_session` | fresh session (`data.cancelled` if an extension vetoed) |
| `switch_session` | load another session **file**; cwd follows the header (C2) |
| `fork` / `clone` | branch from an entry / duplicate the active branch |
| `get_entries` | durable `since` cursor over the append-only tree |
| `get_tree` | full entry tree + `leafId` |
| `get_messages` | conversation for the transcript |
| `get_fork_messages` | user messages eligible for fork |
| `get_last_assistant_text` | cheap "what did it last say" |

### Model and context

| Command | Use |
|---|---|
| `get_available_models` | model picker |
| `set_model` / `cycle_model` | switch model |
| `get_available_thinking_levels` | constrain the level picker per model |
| `set_thinking_level` / `cycle_thinking_level` | thinking controls |
| `compact` | manual compaction |
| `set_auto_compaction` | toggle |
| `set_auto_retry` / `abort_retry` | retry controls |
| `set_steering_mode` / `set_follow_up_mode` | queue semantics |

### Bash and discovery

| Command | Use |
|---|---|
| `bash` / `abort_bash` | run a shell command (streams `bash_execution_update`, `id`-correlated) |
| `get_commands` | discoverable extension commands, prompt templates, skills |
| `export_html` | export a session |

## Events consumed

| Event | Pi Central reaction |
|---|---|
| `agent_start` | `starting` → `streaming` |
| `turn_start` / `turn_end` | transcript turn boundaries |
| `message_start` / `message_update` / `message_end` | live transcript; deltas then authoritative replace |
| `tool_execution_start` / `_update` / `_end` | tool timeline; correlate by `toolCallId` |
| `agent_end` | run ended — **do not** mark idle (C8) |
| `agent_settled` | `→ idle`; this is the completion gate |
| `queue_update` | show pending steering/follow-up |
| `compaction_start` / `compaction_end` | context pressure indicator |
| `auto_retry_start` / `auto_retry_end` | retry banner |
| `summarization_retry_*` | compaction retry indicator |
| `session_info_changed` | reflect renames |
| `thinking_level_changed` | reflect level changes |
| `entry_appended` | custom entries from extensions |
| `bash_execution_update` | streamed bash output (`id`-correlated) |
| `extension_error` | surface extension faults (RPC-only) |

### Streaming reconstruction

`message_update` is **delta-only** on the wire. Rules:

- Buffer `delta` for live display.
- Replace buffers with authoritative `content` at `text_end` / `thinking_end` /
  `toolcall_end`.
- Replace the whole message with `message_end.message`.
- Use `contentIndex` to address blocks.

## Extension UI subprotocol

The approval surface, and the reason a dashboard is worth building.

**Dialogs** (emit `extension_ui_request`, block for `extension_ui_response`):

| Method | Response field |
|---|---|
| `select` | `value` (or `cancelled`) |
| `confirm` | `confirmed` (or `cancelled`) |
| `input` | `value` (or `cancelled`) |
| `editor` | `value` (or `cancelled`) |

Dialog requests may carry `timeout` (ms); Pi auto-resolves with a default, so the client
does **not** track timeouts.

**Fire-and-forget** (no response): `notify` (`info`/`warning`/`error`), `setStatus`,
`setWidget`, `setTitle`, `set_editor_text`.

### Degraded in RPC (must not be relied on)

`custom()` → `undefined`; `onTerminalInput()` → no-op;
`setTheme()` → `{ success: false }`; `getAllThemes()` → `[]`;
`setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`,
`setHiddenThinkingLabel`, `setFooter`, `setHeader`, `addAutocompleteProvider`,
`setEditorComponent`, `setToolsExpanded` → no-ops; `getEditorText()` → `""`;
`getToolsExpanded()` → `false`.

`ctx.mode === "rpc"` and `ctx.hasUI === true` — dialogs and fire-and-forget work. Guard
TUI-only features with `ctx.mode === "tui"`.

## Client library

`RpcClient` (exported from `@earendil-works/pi-coding-agent`) is the typed wrapper:
`start()`, `stop()`, `onEvent()`, `prompt()`, `promptAndWait()`, `waitForIdle()`,
`getState()`, `switchSession()`, `getEntries()`, `getTree()`, `bash()`, … and
`getStderr()` for diagnosing spawn failures.

Options: `cliPath`, `cwd`, `env`, `provider`, `model`, `args`. It spawns
`node <cliPath> --mode rpc …` with `stdio: ["pipe","pipe","pipe"]`.

**For sandboxed sessions, Pi Central should not let `RpcClient` spawn `pi` directly** —
it must spawn `safehouse -- pi …`. Either point `cliPath` at a launcher shim that execs
safehouse, or do the spawn in the supervisor and drive the protocol directly. See
[SANDBOX.md](SANDBOX.md#integration-with-rpcclient).

`RpcClient` requires a runnable CLI. Installed path here:

```
/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
```

## Framing rules (C7)

- One JSON object per record, terminated by `LF`.
- Strip an optional preceding `CR`.
- Never use Node `readline` — it also splits on `U+2028` / `U+2029`, which are legal
  inside JSON strings.
- Read stdout continuously; honor stdin backpressure.
- Stdout is protocol-only. Never parse stderr as protocol.

## Shutdown

Close the child's stdin for an orderly shutdown; Pi disposes the runtime before exiting.
Still handle signals and unexpected exits. Pi Central kills the process **group** so
sandboxed grandchildren cannot outlive the supervisor.
