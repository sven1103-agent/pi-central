# Pi Central UI

A local dashboard for supervising sandboxed Pi sessions across working directories. React 19 +
Vite, rendering to the design in [DESIGN.md](DESIGN.md).

## Running it

One process. The orchestrator serves the built UI and the WebSocket from the same origin.
**It must run from a plain terminal** — see the constraint below.

```bash
npm run ui:build     # once, and after any UI change
npm run server
```

Then open <http://127.0.0.1:8787>. The server prints the URL, and says so explicitly when the UI
has not been built yet rather than serving a blank page.

### Developing the UI

For hot reload, run the dev server against a socket-only orchestrator. No configuration is needed:
the dev server proxies `/ws` to `127.0.0.1:8787` by default, and the orchestrator prints the exact
`PI_CENTRAL_WS=…` command if you changed the port.

```bash
npm run server -- --no-ui   # terminal 1
npm run ui:dev              # terminal 2 — Vite, on http://localhost:5173
```

The built-UI path exists for a specific reason: Vite watches `packages/ui/src`, so an agent editing
a component reloads the interface you are using out from under you, mid-edit, into a syntax-error
overlay. Serving a build removes the watcher, which is what makes Pi Central usable to develop Pi
Central ([DOGFOODING.md](../../docs/DOGFOODING.md)). It also makes the CSP's `connect-src 'self'`
truthful by construction rather than by a proxy that happens to be configured correctly.

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
- **A file tree** (issue #8) of the focused session's working directory, lazily expanded, with a
  dotfile toggle and a text viewer. Confined to the session's `cwd` — the state lives in
  `src/files.ts` and the confinement in the orchestrator (ADR-0007). Every refusal states its reason: too large, binary,
  permission, or outside the directory. A refusal is never rendered as an empty directory.

## Keyboard

| Key | Action |
|---|---|
| `⌘N` / `Ctrl+N` | New scratch session |
| `⌘⇧O` | Open in a directory |
| `Enter` | Send, or queue while a run is in progress |
| `Shift+Enter` | Newline |
| `Esc` | Answer an open dialog → close a popover → **stop the run and return the queue to the box.** Never clears your draft: the queue is merged in below it, not over it. |
| `Alt+Enter` (mid-run) | Queue a follow-up instead of steering. |

## Deliberately not here yet

- **File editing and file operations.** Reading and listing only (issue #8). Create, rename, move and
  delete are issue #10, and each destructive one will be confirmed explicitly.

## Development

```bash
npm test              # from the repository root: all packages
npm run typecheck     # two configs — Node libs and DOM libs cannot share one
npm run ui:build      # production build
```

`src/markdown.ts` is the only module permitted to produce HTML from untrusted input, and
`src/components/Prose.tsx` is the only `dangerouslySetInnerHTML` site. Both are enforced by
`test/invariants.test.ts` rather than by review — see [ADR-0006](../../docs/decisions/0006-untrusted-markdown-rendering.md).
