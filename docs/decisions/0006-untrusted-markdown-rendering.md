# ADR-0006 — Untrusted content rendering in a browser UI

- **Status:** Accepted
- **Date:** 2026-06-24
- **Supersedes:** none

## Context

Pi Central's UI displays content it did not author: assistant output, tool results, and
file contents. That text is **attacker-influenced** — it routinely includes text from
repository files, fetched web pages, command output, dependency sources, and issue
bodies. None of it is trustworthy.

[ADR-0005](0005-typescript-stack.md) chose a **browser** UI, which means that text can
become live HTML. This creates a hazard a terminal UI does not have.

The hazard is not cosmetic. The UI runs in an origin that **holds a WebSocket to the
orchestrator and can issue control commands** — `prompt`, `abort`, `set_model`,
`switch_session`, and every other command in [PROTOCOL.md](../PROTOCOL.md). Script
executing in that origin is not "an XSS bug"; it is remote control of every supervised
session, with the user's own privileges.

Requested features that bring this hazard to the foreground: **Markdown rendering** and
**syntax highlighting**.

### Verified facts

- Pi's own highlighter cannot be reused: it is `highlight.js` `10.7.3` rendering **ANSI**
  through `Theme`/`ThemeColor`, and `pi-tui`'s `Marked` wrapper is terminal-oriented.
- `pi-tui` exports terminal components (`Markdown`, `Box`, `ScrollView`) with no browser
  rendering path.

## Decision

Treat every displayed string as **inert text**, and make HTML generation a single,
auditable step.

### Rendering pipeline

Strict ordering; the order is the safety property:

```
RPC event / file content (untrusted string)
  → buffer deltas (throttled re-render, not per delta)
  → markdown-it with { html: false }
  → DOMPurify
  → React children          ← the ONLY insertion point
```

- **`html: false`.** Model output and project files have no legitimate need to emit raw
  HTML. Genuine HTML in a Markdown file renders as escaped source, which is correct and
  safe.
- **DOMPurify** as defence in depth, even with HTML disabled.
- **No `dangerouslySetInnerHTML`** outside the single sanitized merge point. Enforce with
  a lint rule.

### Content Security Policy

Strict CSP on the UI origin: no `unsafe-inline`, no `unsafe-eval`, no remote script
origins, `connect-src 'self'`. A compromised render cannot reach the network.

### Links

Render link targets as inert text with copy affordances. Do not auto-open. On explicit
click, show the full URL before navigating, and reject `javascript:`, `data:`, and
`file:` schemes.

### Syntax highlighting

**Shiki**, with grammars loaded **lazily** on first encounter of a language. Shiki is
browser-oriented and produces HTML that flows through the same sanitize step.

### Streaming

`message_update` is delta-only and arrives rapidly; re-parsing the whole document per delta
is wasteful and janky.

- Buffer deltas; re-render on an animation-frame throttle.
- On `text_end` / `message_end`, re-render from authoritative content and drop buffers
  (per [PROTOCOL.md](../PROTOCOL.md)).
- Keep the streaming tail as plain text; parse complete blocks only.

## Consequences

**Positive**

- Transcript rendering is XSS-resistant by construction (no HTML) *and* by defence in
  depth (CSP + DOMPurify).
- A compromised transcript cannot reach the network or issue control commands.
- One insertion point makes the safety property reviewable in one place.

**Negative**

- HTML in Markdown files renders as source rather than a preview. Correct-and-safe beats
  faithful-and-dangerous; a rendered preview through the same sanitized pipeline is
  backlog.
- Shiki grammars and DOMPurify add bundle weight, mitigated by lazy loading.
- The animation-frame throttle adds a small amount of UI state.

## Verification

Feed a transcript and a browsed `.md` file containing `<script>`, `<img src=x
onerror=...>`, and a `javascript:` link. Assert no execution, no raw HTML output, and no
navigation.

## Related

Filesystem access and path handling are a separate concern, decided in
[ADR-0007](0007-filesystem-access-model.md).
