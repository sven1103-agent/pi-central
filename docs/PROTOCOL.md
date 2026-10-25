# RPC surface Pi Central depends on

Reference for the Pi RPC API Pi Central consumes. Verified against Pi `1.4.0`.
Canonical upstream references are Pi's own `rpc.md`, `rpc-commands.md`, `json.md`,
`message-types.md` and `rpc-extension-ui.md`, which ship inside the installed
`@earendil-works/pi-coding-agent` package under its `docs/` directory. They are named without
paths here on purpose: they are **not** files in this repository, and writing them as bare
`docs/...` invited exactly that misreading.

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

### Startup emits a burst of non-blocking extension UI requests

**Verified by execution** against Pi `1.4.0`. Within the first seconds of a session, Pi emits
about nine `extension_ui_request` records — in one observed run: five `notify`, three
`setStatus`, one `setWidget`.

None is a dialog. Every one carries an `id` (so a naive "has an id → is a dialog" rule would
misfire).

**Both families are documented and closed for Pi `1.4.0`** — five fire-and-forget
(`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) and four dialogs
(`select`, `confirm`, `input`, `editor`). Five plus four is exactly the nine observed in the
startup burst.

**Consequence:** a component that treats an unexpected `extension_ui_request` as blocking
wedges the session on a prompt no human will ever answer — at startup, before the user has
done anything.

### The unknown-method default is "blocking", and that is deliberate

Since both families are enumerable, either could be the allowlist. Pi Central enumerates the
**non-dialogs** (`FIRE_AND_FORGET_UI_METHODS` in `packages/protocol/src/pi.ts`), and the choice
decides how an unrecognized method fails:

| Enumerate | Unknown method | Failure mode |
|---|---|---|
| Dialogs | ignored | Pi waits forever for a response nobody knows to send. **Silent, permanent, unrecoverable** without restarting the session. |
| Non-dialogs (**chosen**) | treated as a dialog | The user sees it and can cancel. **Costs a click; cannot cost the session.** |

The recoverable direction wins. This is the same lesson as C12 and C13 in a different place: a
silent, plausible-looking non-failure is worse than a visible annoyance. Concretely, the UI
renders a Cancel for any method it does not recognize, so an unfamiliar dialog can always be
dismissed.

The supervisor classifies by method, and `state.ts` has tests asserting that
`notify`/`setStatus`/`setWidget` change neither state nor dialog list **and** that an unknown
method does open one.

### Resuming a session: Pi does NOT re-emit the history

**Verified against a real session** (2205 message records, `01a171ff-…`). This is the single
most important behaviour to know when resuming, and it is not obvious from the RPC docs.

Pi loads a resumed session's history into the model's **context**, but does not re-emit those
messages as session events. A client built only from the event stream therefore shows an
*empty* transcript for a session with hundreds of messages — which is exactly the case
[US-5](USER-STORIES.md#us-5--continue-a-past-session) exists to serve.

**A client must explicitly fetch the history:**

| Command | What it returns | Use |
|---|---|---|
| `get_messages` | the conversation, as `AgentMessage[]` | the transcript |
| `get_entries` | the full append-only tree, **including pre-compaction history and abandoned branches** | a complete audit view |

`get_messages` is what Pi Central loads on start and resume. Prefer `get_entries` when
pre-compaction history matters.

The supervisor re-emits the fetched messages as a `transcript` event, kept separate from `record`
so the client knows whether to append (live) or replace (history).

### The message shapes a transcript must handle

These are the **actual** shapes found in a real session file, and three of them differ from what
the streaming events suggest:

| Shape | Count in one session | Note |
|---|---|---|
| `{ type: "toolCall" }` | 1121 | **camelCase.** Not `tool_use` or `tool_call` |
| `{ role: "toolResult" }` | 1120 | a separate **message role**, not a content block |
| `content: "a plain string"` | 2 | a user message's content need not be an array |
| `{ type: "image" }` | 3 | base64; skip it rather than render garbage |
| `content: []` + `stopReason: "error"` | 10 | a provider failure — must not render as a blank turn |

The tool-call payload is named `arguments`, not `input`.

Getting any of these wrong fails **silently**: the transcript is merely shorter than it should
be, which is indistinguishable from a quiet session.

### One tool call arrives by two routes — deduplicate by `toolCallId`

A single tool call reaches a client **twice**, and both routes are legitimate:

| Route | Carries | Lacks |
|---|---|---|
| live `tool_execution_start` / `_update` / `_end` | `args`, `durationMs`, live status | — |
| persisted `toolResult` **message** | `content`, `isError`, `toolCallId` | **`args`** |

Measured on a real session: the file held one `bash` and one `write` tool result, and the trace
showed **four** rows — with the two extras sharing a `toolCallId`, which also collides as a React
key. Two consequences worth designing around:

1. **Merge on `toolCallId`, do not append.** Neither route is complete, and which arrives first
   depends on whether history was loaded before or after the call ran.
2. **Recover `args` from the assistant's `toolCall` block**, keyed by the same id. Training a
   trace row to say only "bash" is the least useful thing a trace row can be, and the arguments
   are in the same conversation.

Also: a call can exist with **no result at all**. A real session had 1188 calls and 1187 results —
one interrupted run. Surface it as "no result recorded" rather than omitting it, since "it tried
this and we never saw the outcome" is exactly what someone opens a trace to find.

### A reconnecting client needs the transcript re-FETCHED, never replayed

The `transcript` event fires **once**, when a session starts. A browser reload creates a new client
that receives only a `snapshot`, so a connecting client must be given the conversation.

**Fetch it. Do not cache it.** A cached conversation is stale the moment it is taken, and this is
not hypothetical: an earlier version cached the fetch from session start — which for a session
created moments ago is *empty* — and replayed it on every reconnect. The reconnect therefore
**replaced** a correct transcript with an empty one, and a once-only guard meant it could never
recover. The UI showed "Loading this session's history…" indefinitely, because Pi reported
`messageCount: 11` while the client held nothing.

The cost of being right is one sub-millisecond `get_messages` round trip per live session per
connection.

### A failed read is not an empty conversation

`transcriptError` is a separate event from `transcript`, because the two mean opposite things: an
empty conversation is a fact about the session, and a failed read is a fact about the attempt.
Folded together, the UI asserted that work was in progress when none was.

### `send` takes the closed `Command` union

The `Command` union is binding, not decorative: `rpc.send` accepts it and nothing looser. It was
previously `{ type: string } & Record<string, unknown>`, so a mistyped command compiled cleanly
and failed at runtime as a `success: false` response the caller might not check. Making it
binding immediately revealed **two** commands in active use that the union never listed —
`get_messages` and `get_available_models`.

### Responses are usually sub-millisecond, but the timeout path matters

`get_state` and `get_session_stats` answered in 0–3 ms in practice. The timeout is therefore
rarely exercised against Pi and must be tested against a stand-in (see
`packages/orchestrator/test/rpc.test.ts`, which uses `/bin/cat`). An unknown command is
rejected by Pi with `success: false` and `error: "Unknown command: …"`, so the supervisor's
rejection path is real and not merely defensive.

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

Because Pi Central does not retarget a session (ADR-0008), the offered choice is **resume
in the recorded directory** or **cancel** — never "continue in another directory".

Relevant helper: `SessionManager.forkFrom(sourcePath, targetCwd, …)` copies history into
a session whose header carries the new cwd. It is **not** used to move a running session;
Pi Central does not change a session's working directory (ADR-0008). Note also that
`cwdOverride` is **not** available over RPC — it exists only in the interactive TUI
(`dist/modes/interactive/interactive-mode.js`), and the RPC `switch_session` handler passes
no options (`dist/modes/rpc/rpc-mode.js`). Do not plan around it.

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
| `set_model` / `cycle_model` | switch model. `set_model` requires **both** `provider` and `modelId`, and can fail: an unconfigured provider returns `No API key for <provider>/<model>` |
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
