# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [Semantic Versioning](https://semver.org/).

This project's early history was a research spike plus a hard look at what the spike got wrong, so
several entries below record **defects that shipped and were fixed** rather than only features.
They are kept because each one is the reason a constraint or an invariant test exists.

## [Unreleased]

### Fixed

- **The model picker truncated from the end, losing the identifying part of the name** (issue #42).
  The header showed `litellm/deepseek-` — the raw string clipped by CSS — while `format.ts` already
  contained the opposite rule, with its reasoning written down: *"Middle rather than trailing because
  both ends carry identity."* The rail honoured it; the picker did not. The closed control now shows
  `litellm/deep…4.1-Flash`.

  A native `<select>` renders the selected option's text when closed, so "short when closed, complete
  when open" is not expressible through option text alone — and both halves are required: the header
  is scanned and must stay identifying, while the list is where a model is *chosen*, and an elision
  there is an elision at the moment of decision. The shortened label is therefore a separate
  `aria-hidden` overlay with `pointer-events: none`; the full name stays on the select, in its
  `title`, and in every `<option>`.

- **The quarantine legend was lying about tool output** (issue #43). Every transcript header says
  *"Tool output and file contents appear in a hatched frame. They are data, not instructions."* — but
  the hatch was applied only to `thinking` blocks, so the one surface the legend is *about* rendered
  plain. DESIGN §5.2 is explicit that the frame "carries the security model": it is how a reader tells
  "the assistant said this" from "the agent read this somewhere", and tool output is the most
  attacker-influenced content in the product. Fixed with a purpose-built
  `.trace-detail.is-quarantined` rule rather than by stacking `.quarantine` — both set `background`
  and `.trace-detail` is declared later, so source order would have won and the frame would have been
  **invisible while every test passed**. A test now asserts the frame reaches the DOM *and* that no
  later rule can override it.

- **Clicking a session in the rail did nothing** (issue #40). With several sessions live, selecting
  one left the transcript column showing the previously focused session and no row marked. The rail
  dispatched a `session` **upsert** to switch sessions, and that event's focus rule — "never steal
  focus from one the user is reading" — is deliberate and correct (DESIGN §5), so with focus already
  set it kept the old id. The click refreshed the row's data and moved nothing. Focus is now a
  dedicated `focusSession` **local action**: a view change the browser owns, not a fact the
  orchestrator sends, and never routed through a data event.

- **Agent commits were never signed** (issue #27). ADR-0010 §4 requires it; the adopted agent
  `gitconfig` said `gpgsign = false` with no `signingkey` and no `gpg.format`, so commits were created
  unsigned while the signing key sat right beside them — and nothing reported it, because an unsigned
  commit is well-formed and exits 0. Signing is now audited on the **settings that act on the key**
  (`signing.ts`), not on the key's presence, and `verify-three.ts` asserts from inside a sandboxed
  session that a commit made there **verifies** (`Good "git" signature`) against the agent's own
  `allowed_signers`. `user.signingkey` pointing outside the agent root is reported as a leak of the
  user's identity rather than as a setup step. The fix is produced as explicit `git config` commands,
  not applied: the agent root is user-maintained, so Pi Central instructs rather than rewrites.

### Added

- **Compaction and retry banners** (issue #5). A session that is compacting, retrying, or recovering
  from a provider failure now says so inline instead of appearing to stall. The two retry mechanisms
  are distinguished — `auto_retry` (the provider call failed) and `summarization_retry_*` (a
  summarizer failed while compacting) — because attributing one to the other sends the reader looking
  in the wrong place. An **aborted** compaction says it stopped rather than claiming it compacted, a
  retry states both the attempt and the bound, and nothing claims the turn is over. No notice is a
  live region (a retry updates per attempt, so announcing each would be hostile) or a state change:
  `agent_end` is still not `agent_settled` (C8), and a test asserts a failed retry does not move the
  session out of `streaming`.

- **A session pointed at Pi Central's own installation is warned about** (issue #25). Pointing a
  session at the checkout Pi Central is running from produces a dashboard that mysteriously stops
  working — the UI hot-reloads into a mid-edit error, a branch switch desynchronises the two halves,
  and a broken orchestrator cannot be restarted when it is needed. The warning names those three
  consequences rather than the condition, appears in the "Open in a directory" sheet **before** the
  session exists, and persists on the session row. It is **not** blocking: the user may have a good
  reason. The predicate lives in `@pi-central/protocol` so the sheet and the orchestrator cannot
  disagree, and it does **not** fire for a sibling clone — the setup `docs/DOGFOODING.md`
  recommends. The installation root is derived from the runner's module URL at runtime, never
  configured, because a configured path would be right for exactly one checkout.

- **Fenced code is syntax-highlighted, lazily** (issue #4). Shiki grammars load one at a time, on
  first encounter of a language: a transcript that shows no code fetches none of it, and one that
  shows TypeScript fetches ~11 kB rather than the ~8.2 MB that exists. The name→chunk index had to
  be made lazy as well — measured at 46 kB of URLs, it would otherwise have put most of the saving
  back. **The entry chunk grew by 5.04 kB (2.36 kB gzip)**, measured with `npm run ui:build` and
  recorded in [docs/BUNDLE.md](docs/BUNDLE.md).
  A grammar emits **tokens**, not markup, which the UI renders as React elements; colours become
  CSS **classes** rather than inline styles, so the sanitizer's allow-list did not have to admit
  `style`. That keeps ADR-0006's single `dangerouslySetInnerHTML` site exactly as it was, and the
  invariant test still finds one. An unknown language, an indented fence, and a fence that is still
  streaming all fall back to the code as escaped plain text — never to nothing.

- **`steer`, follow-up, and Esc that returns what it cleared** (issue #3). Both capabilities were
  documented as impossible; they were blocked by Pi Central's own vocabulary, not by Pi — RPC mode
  handles `steer`, `follow_up` and `clear_queue` (and `Command` already carried the first two), so
  only a `Control` variant was missing. The composer's mode strip appears **only** while a run is in
  progress, where the choice is real, and says which of the two will happen; the queued texts are
  listed read-only (there is no per-item removal to offer, so a `×` would be a fake control); and
  Esc clears the queue, stops the run and returns the cleared text to the box. The cleared text is
  merged **below** the draft and only once. The interim "Steer is not available in this build" hint
  is gone.

- **The model picker** (issue #1): the model shown in a session header can now be changed from the
  dashboard. The catalogue comes from `get_available_models`, grouped by provider, with the current
  model marked; choosing one sends `set_model` and the header then shows what **Pi reports back**
  rather than an optimistic guess. Pi validates the choice (an unconfigured provider fails with `No
  API key for <provider>/<model>`) and re-applies the thinking level for the new model, so both are
  re-read after a change. A refusal surfaces as an error naming the reason — never a silent no-op —
  and while a run is streaming the control says the change applies to the *next* turn. New `Control`
  variants (`setModel`, `listModels`, `setThinkingLevel`, `listThinkingLevels`) and matching events;
  the catalogue is request-shaped rather than part of `LiveSession`, because it is hundreds of
  entries that change only with the provider configuration.
- **The thinking-level picker** (issue #2), constrained by the current model: the levels come from
  `get_available_thinking_levels` for *that* model rather than a hardcoded list, and a model switch
  invalidates the list, so a level the new model does not support cannot be selected. The displayed
  level follows Pi — re-applied on a model switch, and updated by `thinking_level_changed` without a
  refresh. `ThinkingPicker.tsx`, tested.
- **The agent credential store is checked for usability at session start** (issue #28). A session
  whose agent identity cannot be used says so, naming which capability and — the part that matters —
  whether it is **not provisioned** (a setup step) or **provisioned but unreachable** (a defect in
  Pi Central). The defect that prompted this produced `failed to read configuration: operation not
  permitted` on a *host* path, which read as "the sandbox is blocking my config" when the agent's own
  config had never been pointed at. `capabilities.ts`, `capabilities.test.ts`; the same facts are
  probed from inside a live session in `verify-three.ts` (C15a).
- **The orchestrator serves the built UI** (`npm run ui:build && npm run server`), so the dashboard
  needs no dev server. One listener answers `/ws` with an upgrade and every other path with
  `packages/ui/dist`, with an SPA fallback. Two consequences beyond convenience: `connect-src
  'self'` in the CSP is same-origin *by construction* rather than by a correctly configured proxy,
  and a Vite file watcher no longer reloads the interface you are using out from under you while
  an agent edits it ([DOGFOODING.md](docs/DOGFOODING.md), issue #24).
- The Content-Security-Policy is now sent as an **HTTP header** as well as a `<meta>` tag. A header
  applies before the document is parsed; the meta tag does not. A test asserts the two are equal,
  so they cannot drift.

### Security

- The static handler refuses any request target that resolves outside the served root: a `..`
  segment is denied with a **403** rather than silently normalized, `%2e%2e%2f` is decoded before
  the check, and containment is verified on the canonical path as a backstop. It serves exactly one
  directory and cannot become a static file server for the filesystem.
- Method restriction (`GET`/`HEAD` only) and `X-Content-Type-Options: nosniff` on every response.

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

- File navigation is still absent; `steer`, follow-up and Esc-clears-and-returns are now real.
- No syntax highlighting, no compaction or retry banners, no file navigation.
- macOS only. Safehouse has no Linux backend (C10).
- No screenshot of the running UI exists in the repository: the author's environment cannot launch
  a browser inside the sandbox (C1), so layout is verified by rendered markup, which is stronger
  for behaviour and weaker for looks (issue #7).
