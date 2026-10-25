# Pi Central UI

A local dashboard for supervising sandboxed Pi sessions across working directories. React 19 +
Vite, rendering to the design in [DESIGN.md](DESIGN.md).

## Running it

Two processes. **Both must run from a plain terminal** — see the constraint below.

```bash
# terminal 1 — the orchestrator (unsandboxed, spawns sandboxed sessions)
npm run server

# terminal 2 — the UI dev server
npm run ui:dev
```

Then open <http://localhost:5173>.

The orchestrator listens on `127.0.0.1:8787` by default and the dev server proxies `/ws` to it,
so no configuration is needed. If you change the port, the orchestrator prints the exact
command to start the UI with.

## Why a plain terminal

Pi Central spawns every session through `safehouse`, which applies its policy with
`sandbox-exec`. **Seatbelt does not nest** (C1), so if the orchestrator is itself inside a
sandbox, `sandbox-exec` fails with EPERM and every session dies the moment it starts.

The orchestrator checks this before binding a port and refuses to start with an explanation,
rather than letting you discover it as a confusing spawn failure. If you try to run it from an
editor task, an agent harness, or an already-sandboxed shell, that is what you will see.

A session that fails this way also gets the diagnosis attached to its error in the UI, because
`pi exited (code=71)` on its own reads like a launcher bug.

## What you get

- **`New session` (⌘N)** starts a session in an app-owned scratch workspace. No directory to
  pick. This is the primary action, and the reason the UI is shaped the way it is.
- **`Open in a directory…` (⌘⇧O)** is the secondary path, for work that already has a home.
- **A rail ordered by attention**, so a session blocked on an approval is first.
- **An approval dock**: `confirm`, `select`, `input` and `editor` requests from *any* session
  are answerable without losing your place. This is the reason a dashboard beats a terminal.
- **Quarantined tool output**: a hatched frame marks tool results and file contents as data
  rather than instructions, and renders them as escaped text rather than Markdown.
- **History** searchable by content, with a clear refusal when a session's directory is gone.

## Keyboard

| Key | Action |
|---|---|
| `⌘N` / `Ctrl+N` | New scratch session |
| `⌘⇧O` | Open in a directory |
| `Enter` | Send, or queue while a run is in progress |
| `Shift+Enter` | Newline |
| `Esc` | Answer an open dialog → close a popover → stop the run. **Never clears your draft.** |

## Deliberately not here yet

- **Steer.** The protocol cannot express it: `Control` has no `steer`, and the supervisor
  hard-codes `followUp` while streaming. The composer's hint line says so rather than showing a
  button that cannot work.
- **Model / thinking pickers.** Both are displayed, neither is editable — the commands exist in
  Pi but no `Control` carries them yet, so a picker would need a protocol addition first.
- **Syntax highlighting.** Code renders in a styled `<pre>`; Shiki is deferred.
- **Compaction / retry banners.**

## Development

```bash
npm test              # from the repository root: all packages
npm run typecheck     # two configs — Node libs and DOM libs cannot share one
npm run ui:build      # production build
```

`src/markdown.ts` is the only module permitted to produce HTML from untrusted input, and
`src/components/Prose.tsx` is the only `dangerouslySetInnerHTML` site. Both are enforced by
`test/invariants.test.ts` rather than by review — see [ADR-0006](../../docs/decisions/0006-untrusted-markdown-rendering.md).
