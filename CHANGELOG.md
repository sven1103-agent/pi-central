# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [Semantic Versioning](https://semver.org/).

This project's early history was a research spike plus a hard look at what the spike got wrong, so
several entries below record **defects that shipped and were fixed** rather than only features.
They are kept because each one is the reason a constraint or an invariant test exists.

## [Unreleased]

<!-- Empty at tag time: `scripts/check-version.mjs --release` refuses to release while this holds entries, so a release cannot silently ship undocumented changes. An HTML comment is exempt from that check, which is why this note is here rather than a paragraph. -->

### Added

- Retry a failed session from the rail (#11).
- The session roster survives a restart, an update, or a crash, and a stopped session resumes when you send to it (#89).
- Rename a session by double-clicking its name in the header (#78, #79).
- Every install carries a provenance attestation, and the README says how to check it (#157, #158).
- `npm audit signatures` in the install path, and `npx` marked as the unverifiable route (#157, #158).

### Changed

- Tool output is inline in the transcript, with one bar per call (#131).
- A long transcript no longer slows switching or streaming; revisiting a session is instant (#151).

### Fixed

- The session you start or resume becomes the active one (#144).
- Thinking blocks say when they are still thinking, and show a one-line gist (#143, #146).
- A tool call reads louder than the reasoning about it (#144).
- Settings: two panes, a preview that shows the setting, and a reset to defaults (#142).
- Following survives a session switch, and a restore only applies when you had scrolled away (#141).
- Resume works beyond the newest 500 sessions (#153).
- Session names follow one rule, so a restart does not rename them (#89).
- History shows a rename immediately, including for sessions over 256 KB (#164).
- The active provider is shown beside the model, not hidden in the dropdown (#163).

## [0.4.1] — 2026-10-29

A hotfix for one behaviour: **returning to a session you were following left you at the top of the
transcript.** Three mechanisms had to be corrected, and they were found in sequence rather than at once:

1. `decideOnSessionChange` restored a stale offset *and* the follow flag, so the offset won.
2. The scroll listener wrote the session's position on **mount**, when the pane has content but no position
   yet — overwriting the real offset with `scrollTop: 0`.
3. That same mount measurement set `pinnedRef = false`, overriding the decision to follow **before the follow
   effect ran**. This is the one the reporter confirmed fixes it.

The first two are defensible on their own mechanism and may be defence-in-depth rather than load-bearing;
the third is the one with a confirmed effect. Saying so is more useful than claiming all three were
necessary.

## [0.4.0] — 2026-10-29

Developer-loop fixes and the last of Increment 2.

### Fixed

- `~/.ssh` is denied wholesale, not by key name (#46, #47).
- Images display: `img-src 'self'` does not cover `blob:` (#111), and `<img>` was rendered before it had a source (#108).
- The CSP comment claiming a blob URL counts as `'self'` was false, and is gone (#111).
- The dev loop can say which build is running (#114).
- The transcript and composer are held to one line without centring it (#92, #132, #133).
- A binary file refusal names the file's size (#9).
- The README said the package was not published; it has been on npm since 0.2.0 (#127).

### Changed

- A one-time warning when a session points at Pi Central's own installation (#25).
- The dev proxy no longer prints a stack trace for a normal disconnect (#114).

## [0.3.0] — 2026-10-27

Increment 2, mostly the transcript after being used in anger.

### Added

- Tool output opens inline in the transcript, with one bar per call (#131, #136, #137, #139).
- The transcript can be told never to scroll itself, and following survives a session switch (#86, #141).
- Reading position is kept per session, and sending a prompt re-arms following (#86, #141).
- Your own prompts are distinguishable from the agent's prose at a glance (#88).
- The right panel is collapsed by default, and the panel width is yours (#75).

### Changed

- A colour-and-legibility sweep from looking at a screenshot (#74).
- The trace's nested scroll regions are marked as such (#73).

### Fixed

- The model picker painted over the `Thinking` label (#96).
- The `auto-follow` / `markers` toggles were unreadable in their inactive state (#98, #100).
- The copy-path button said "Copy copy path changelog.md" (#72).
- The file viewer no longer forces long lines into a horizontal scrollbar (#73).
- A release design note claimed a registry guarantee that does not exist (#66).

### Removed

- The centred transcript measure from #92, reverted after five downstream defects (#132, #133).

## [0.2.0] — 2026-10-26

The first release you could install, and a product identity.

### Added

- Pi Central is a package, not only a checkout (#52, ADR-0011).
- A release workflow with one version source, a tag, a GitHub Release and a provenance-attested publish (#53).
- Releases are staged, and a maintainer approves them (#65).
- A Settings surface: which build is running, and where it keeps things (#58).
- A read-only file tree confined to the session's working directory (#8, ADR-0007).
- The transcript's text size and line length are the reader's to set (#134).
- A favicon, a topbar mark and a README banner (#115); the app installs to the dock as a standalone window (#119).
- A screenshot of the real dashboard in the README, with alt text describing what it shows (#7).
- Safari's Add to Dock uses the logo, not a screenshot — it ignores manifest icons (#124).
- Images open in the file browser: PNG, JPEG, GIF, WebP and SVG (#106).
- The orchestrator serves the built UI, so one process and one URL.
- The model picker (#1) and the thinking-level picker (#2), the latter constrained by the model.
- `steer`, follow-up, and Esc that returns what it cleared (#3).
- Fenced code is syntax-highlighted, lazily (#4).
- Compaction and retry banners (#5).
- A resume flow for a historical session, in its own recorded directory (#10).

### Changed

- The right pane became a panel with modes and a resizable edge.
- The rail orders by attention, and history lives in its own pane.
- The first publish is a manual bootstrap, and it is guarded (#61).

### Fixed

- Clicking a session in the rail did nothing (#40).
- The model picker truncated from the end, losing the identifying part of the name (#42).
- The quarantine legend described a hatch that no longer existed (#43).
- Agent commits were never signed (#27).
- The protocol version was not bumped when the wire changed (#8, follow-up).

### Security

- The agent credential store is checked for usability at session start (#28).
- Sessions are sandboxed through a composed Safehouse profile, and the boundary is tested (#46).
- The Content-Security-Policy is sent as an HTTP header as well as a `<meta>` tag.
- The static handler refuses any request target resolving outside the served root, and allows `GET`/`HEAD`
  only, with `X-Content-Type-Options: nosniff` on every response.

## [0.1.0] — first iteration

The spike that answered whether this was worth building.

- A session orchestrator: discovery by parsing Pi's session files directly, and per-session Safehouse profiles.
- Agent credential identity: agents act as themselves, with an agent-owned keychain and git config (ADR-0010).
- A WebSocket transport over loopback, refusing to start inside a sandbox (C1).
- A UI: an attention-ordered session rail, live transcript reconstruction, and an approval dock.
- An untrusted-rendering pipeline: `markdown-it({ html: false })` → DOMPurify → React (ADR-0006).
- Documentation as a first-class artifact: constraints C1–C15, ADRs, and protocol notes.

### Fixed

- Denying `~/.pi/agent/auth.json` made every sandboxed session exit `1`, because Pi opens it at startup.
- The keychain grant derived from the agent tree rather than from the provider configuration.
- A resumed session rendered an empty transcript.
- One tool call produced two trace rows, colliding as React keys.
- A cached transcript was replayed on reconnect, overwriting a correct one with a stale copy.
- Tool calls were appended after the conversation instead of interleaved.
- A page size was shown as a session total, a process handle as Pi's session id, and a permission error as a
  missing directory.

### Known limitations

- No file navigation; `steer`, follow-up and Esc-clears-and-returns were added above.
- No syntax highlighting and no compaction or retry banners.
- macOS only — Safehouse has no Linux backend (C10).
- No screenshot of the running UI, because the author's environment cannot launch one (C1).

