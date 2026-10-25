# ADR-0006 — Rendering untrusted Markdown safely, and sandbox-consistent file navigation

- **Status:** Accepted
- **Date:** 2026-06-24
- **Supersedes:** none

## Context

Two requested features — Markdown rendering with syntax highlighting, and file
navigation — both mean the UI displays **content Pi Central did not author**:

- Assistant output and tool results from the RPC event stream.
- File contents read from a session's working directory.

Combined with ADR-0005's browser UI, this creates two distinct hazards that a terminal UI
would not have.

**Hazard 1 — XSS from untrusted Markdown.** Session transcripts routinely contain
attacker-influenced text: repository files, web page content via fetches, command output,
dependency sources. If any of that becomes live HTML, script executes in the Pi Central
origin — an origin that is **connected to the orchestrator over WebSocket and able to issue
control commands** (`prompt`, `abort`, `set_model`, …). An XSS is therefore not a
cosmetic bug; it is remote control of every supervised session.

**Hazard 2 — File navigation bypassing the sandbox.** The orchestrator runs as the user,
outside any sandbox (ADR-0002). If it reads files directly with `fs`, its file browser can
display paths that the *session* is denied — `~/Documents`, other projects' workdirs, other
sessions' transcripts (C6). The UI would then misrepresent the sandbox: it would show a
file the agent cannot actually open, and it would leak across projects.

### Verified facts that shape the solution

- Pi exposes **no generic tool-invoke RPC command**. The commands are fixed
  (`PROTOCOL.md`); the only command that can read a file is `bash`.
- `bash` accepts `excludeFromContext: true`, which stores output in the session but omits it
  from the model context — so a file read need not pollute the conversation.
- Pi's own highlighter is terminal-only: `highlight.js` `10.7.3` rendering ANSI via
  `Theme`/`ThemeColor`, and `pi-tui`'s `Marked` wrapper is terminal-oriented. Not reusable
  in a browser.

## Decision

### Markdown and highlighting

- Render Markdown with `markdown-it`, code blocks with **Shiki**.
- **Disable raw HTML entirely** in `markdown-it` (`html: false`). Model output has no
  legitimate need to emit HTML.
- Sanitize the rendered result with **DOMPurify** as defence in depth, even with HTML
  disabled.
- Enforce a **strict CSP** on the UI origin: no `unsafe-inline`, no `unsafe-eval`, no
  remote script origins. Prefer `connect-src 'self'` so a compromised page cannot reach
  the network.
- Render **fenced code** and **link targets** as inert text with copy affordances. Do not
  auto-open links; require an explicit click that shows the full URL first, and reject
  `javascript:`, `data:`, and `file:` schemes.
- Never use `dangerouslySetInnerHTML` (or equivalent) with unsanitized input. The single
  sanitized merge point is the only one allowed.
- Load Shiki grammars **lazily**, on first encounter of a language.

### File navigation

File reads **must resolve through the session's own sandbox**, never through the
orchestrator's `fs`. Two acceptable mechanisms:

**Preferred — sandboxed sidecar.** The orchestrator spawns a small read-only helper under
the same policy as the session:

```
safehouse --workdir <cwd> [same policy argv] -- node file-helper.js
```

The helper serves directory listings and file contents on a private channel to the
orchestrator. It is subject to the identical policy, so what the UI shows is exactly what
the session can see. One helper per supervised workdir, reused.

**Acceptable — the session's own `bash`.** Issue reads through the session's RPC `bash`
command with `excludeFromContext: true`. Correct by construction, but each read is a shell
round-trip with output truncation, which is slow and awkward for a file tree.

Both are preferred over orchestrator `fs` reads, which are **rejected** for policy
consistency.

### Additional file-browser rules

- Resolve every path against the session's `cwd` and **reject anything that escapes** it
  after canonicalization (symlink-aware). Do not rely on string prefix checks.
- Treat all content as untrusted: text-only, size-capped, binary-detected and refused.
- Do not render files as HTML. Markdown preview happens through the sanitized pipeline
  above.
- Never execute, source, or interpret anything discovered by browsing.

## Consequences

**Positive**

- The file browser cannot show a path the sandbox denies, so the UI is an honest view of
  the session's capability.
- Transcript rendering is XSS-resistant by construction (no HTML) and by defence in depth
  (CSP + DOMPurify).
- A compromised transcript cannot reach the network or issue control commands.

**Negative**

- File browsing costs a sandboxed process per workdir (sidecar) or a round-trip per read
  (`bash`). Browsing large trees needs caching and lazy expansion.
- Shiki grammars plus DOMPurify add bundle weight and require lazy loading.
- The `html: false` choice means genuine HTML in a Markdown file renders as escaped source
  rather than a preview. Acceptable: correct and safe beats faithful-and-dangerous.
- The sidecar is another process to supervise, and a second place where the policy argv
  must be assembled consistently. Extract policy assembly into one function.

## Streaming render strategy

`message_update` is delta-only and arrives rapidly. Re-parsing the full Markdown on every
`text_delta` is wasteful and janky.

- Buffer deltas and re-render on an animation-frame throttle, not per delta.
- On `text_end` / `message_end`, re-render from the authoritative content and drop buffers
  (per PROTOCOL.md's reconstruction rules).
- Keep the streaming tail as plain text; parse complete blocks only.

## Verification

- Feed a transcript containing `<img src=x onerror=...>`, a `javascript:` link, and an
  inline `<script>`; assert no execution and no raw HTML output.
- Assert the file browser **fails** to list a path outside the workdir that the
  orchestrator itself could read — the strongest test that reads are sandbox-routed.
- Assert a symlink out of the workdir is refused.
