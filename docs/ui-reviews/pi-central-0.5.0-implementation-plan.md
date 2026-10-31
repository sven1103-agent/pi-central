# Pi Central — focused workspace implementation plan

**Status:** Proposed; no implementation is included in this document.
**Baseline:** Pi Central 0.5.0 screenshots and the current checkout inspected during planning. The checkout may contain fixes newer than the screenshots.
**Inputs:** [UI review](pi-central-0.5.0-review.md), [overall layout](../../img_17.png), [tool/thinking sequence](../../img_18.png).
**Scope:** A staged frontend refactor within `packages/ui/`, not a server, protocol, or session-engine rewrite.

## 1. Outcome and governing decisions

Make the focused conversation the primary surface, session context secondary, and execution evidence available on demand. A reader should quickly identify the selected session, what is happening, whether intervention is needed, and where to continue the conversation.

The refactor must solve two distinct problems:

1. **Transcript fragmentation:** thinking-only messages and tool groups produce a repeated Assistant → Thinking → tool sequence, even when every disclosure is collapsed.
2. **Workspace composition:** narrow messages, a much wider composer, distant configuration controls, and several persistent status strips do not form one coherent working area.

### Decisions carried into implementation

- Preserve the session rail, persistent composer, resizable optional panel, dark palette, and system/monospace typography. Do not introduce a component library or a new visual theme.
- Group consecutive internal activity, not individual event rows. Do not hide actual assistant prose just because it appears between tool calls.
- Preserve execution evidence and available thinking content; change its presentation, not the stored transcript.
- Keep approvals, unresolved failures, connection problems, and isolation warnings prominent. Removing decorative strips does not mean hiding consequential state.
- Use one layout contract for conversation, activity summaries, and composer. Do not independently center each component.
- Preserve reading preferences, including the existing line-length `fill` option.
- Keep the initial delivery frontend-only. Defer features that would require inferred task outcomes, generated progress summaries, or new protocol facts.

## 2. Code findings that determine the approach

| Existing area | Finding | Consequence |
|---|---|---|
| `packages/ui/src/transcript.ts` | `hasProse()` returns true for nonempty thinking as well as text; `planTranscript()` flushes tool groups at each such message. | The distraction has a concrete presentation-layer cause. Do not attempt to fix it only with CSS. |
| `packages/ui/src/components/Transcript.tsx` | `Turn` emits an Assistant label and thinking disclosures; `ToolMarker` renders each planned tool group separately. | Replace the render-plan vocabulary and activity renderer while preserving the scroll container and message rendering pipeline. |
| `packages/ui/src/transcript.ts` | Tools already have `toolCallId`, `afterMessage`, running/error/unfinished state, and correlated results. | Reuse these facts; no second tool store or correlation mechanism is needed. |
| `packages/ui/src/App.tsx` | `SessionView` composes the header, metrics, notices, legend, transcript, trace, and composer. | Most workspace changes are component composition and CSS rather than application-state changes. |
| `packages/ui/src/components/SessionRail.tsx` | Selected rows already receive `is-focused` and `aria-current`. | Strengthen existing selection styling; do not introduce competing selection state. |
| `packages/ui/src/reading.ts` | Reading size and measure are persisted separately from general UI text size. | Preserve that separation when aligning the composer and transcript. |
| `packages/ui/test/layout.test.mjs` | Earlier transcript centering was reverted after flicker and alignment regressions; tests explicitly encode the revert. | A coherent layout prototype and browser verification are prerequisites to revisiting placement. |
| `packages/ui/src/panel.ts` | The panel already supports width persistence, collapse, Session/Files modes, and one-time Files widening. | Reuse it; adding a Trace mode is a separate change, not a prerequisite for grouping activity. |
| `packages/ui/src/components/Transcript.tsx` | Scroll memory is owned above the session-remount boundary; native disclosures currently preserve state during rerenders. | Keep these guarantees when introducing activity groups and changing their keys. |

Existing design documentation sometimes describes older behavior. Use the current components and tests as the implementation baseline, and update the relevant sections of [the UI design document](../../packages/ui/DESIGN.md) as each new design decision ships.

## 3. Scope boundaries and invariants

### In scope

- A pure conversation/activity presentation planner.
- Compact activity groups with inspectable tools and thinking.
- Shared conversation/composer geometry and a compact session header.
- Stronger sidebar selection and less dominant creation/metadata chrome.
- Clearer utility labels, accessible disclosures, and readable secondary information.
- Tests, representative browser captures, and documentation of the changed behavior.

### Not in the core delivery

- Changes to RPC, transcript files, the orchestrator, sandboxing, or session lifecycle.
- AI-generated activity summaries, task-completion percentages, or inferred retry relationships.
- Full transcript virtualization, a routing rewrite, theme replacement, or a mobile product redesign.
- A generic CSS/module reorganization unrelated to the touched layout rules.
- Moving the full trace into the panel; this is an optional fourth delivery below.

### Non-negotiable behavior

1. **Pi remains the source of truth.** Preserve [C8](../CONSTRAINTS.md#c8--agent_end-is-not-completion): `agent_end` does not mean the session finished. Use existing authoritative session state, not a new UI lifecycle machine.
2. **No lost content.** Preserve user text, assistant text, tool calls/results, available thinking, interrupted output, and failure messages. Grouping changes visibility, not retention.
3. **No invented success.** A later successful tool call does not prove an earlier failed call was recovered. Recorded activity is not proof that the user's task succeeded.
4. **No focus theft.** Background work must not switch sessions or focus. Opening/closing a disclosure must not take focus from the composer unexpectedly.
5. **No draft or queue loss.** Keep Send, Steer, Follow-up, restored queue text, resume-on-send, and Escape precedence intact.
6. **Untrusted content stays inert.** Preserve the sanitized prose pipeline and escaped tool/thinking output. Keep provenance labels even if the full-width legend disappears.
7. **No streaming announcement spam.** Preserve the stable transcript region, `aria-busy`, and absence of per-delta live announcements.
8. **No preference reset.** Preserve reading size/measure, panel size/mode/collapse, and meaningful existing activity visibility preferences.

## 4. Target interaction and layout

### 4.1 Default reading flow

```text
User request
Assistant's meaningful update, if one exists
▸ Activity · Running read · 1 earlier call failed
Assistant response
Composer
```

This is an illustrative structure, not text to fabricate from a screenshot. The activity wording must come from recorded facts. A real assistant update creates a legitimate boundary; a thinking-only message does not.

The default view has no top-level Thinking preview bars, byte counts, or empty Assistant headings. Expanding Activity reveals its steps; tool arguments/output and available thinking remain explicitly inspectable.

### 4.2 Target shell

```text
┌ Navigation / sessions ┬ Focused session header ───────────────────┐
│ Pi Central           │ Name · status   Model / Thinking   Details│
│ Sessions / History   ├───────────────────────────────────────────┤
│ New session          │ Important notice or approval, when needed │
│ Open in a directory  │                                           │
│ Filter               │ Conversation + compact activity           │
│                      │                                           │
│ ▌ Selected session   │                                           │
│   Other sessions     │                                           │
│                      │ Reserved transcript-navigation space      │
│ Fleet / connection   ├───────────────────────────────────────────┤
│ Settings             │ Composer, using the same reading lane     │
└──────────────────────┴───────────────────────────────────────────┘
                                  Optional resizable panel →
```

This defines region ownership, not final pixel dimensions. With the panel closed, do not reserve an invisible panel column. With it open, shrink the available workspace rather than letting the panel cover it at supported desktop widths.

- **Sidebar:** global navigation, creation, session triage, fleet attention, connection, Settings.
- **Session header:** identity/location, current status, readable model/thinking controls, compact context/usage disclosure, Details access.
- **Conversation:** user-facing content and compact activity; one primary vertical scroll region.
- **Composer:** persistent, aligned with the conversation lane; its mode, queue, textarea, Send, and hints share those bounds.
- **Panel:** session facts and files; optionally full trace later.
- **Exceptional rows:** isolation/connection warnings, errors, and approvals get actual layout space. They are not absolutely positioned over content.

### 4.3 Placement decision gate

Do not silently reintroduce the old centering change. Compare two complete compositions with the same content and preferences:

- **A — aligned-left shared lane:** conversation and composer share bounded geometry, with wider detail inspection available separately.
- **B — centered shared lane:** the same complete lane is centered within the available workspace; messages, activity, navigation, and composer move together.

Use the current default reading settings, a larger reading size, `fill`, and panel-open states in both comparisons. The safe baseline is A; B is adopted only after explicit visual acceptance. Do not add an alignment preference to avoid making the design decision.

## 5. Delivery 0 — fixtures, baseline, and design checkpoint

**Effort:** Small. **Dependencies:** None. **Purpose:** Prevent another series of isolated screenshot fixes.

### Work

1. Record the current branch/revision and existing working-tree changes. Do not overwrite unrelated work.
2. Establish the current typecheck/test/build baseline and record unrelated failures separately.
3. Add deterministic, sanitized transcript fixtures through the existing test conventions. Do not copy private session transcripts into the repository.
4. Include: the alternating sequence from `img_18.png`, the expanded-output layout from `img_17.png`, mixed prose/thinking, concurrent tools, failure followed by continued work, interrupted history, and a long tool-heavy session.
5. Capture the current layout at the browser sizes in section 10. For layout proposals, render the entire shell—not isolated centered message bubbles.
6. Review A versus B and choose the lane placement before Delivery 2. Also confirm the navigation relocation and compact model-control approach.

### Acceptance

- A reproducible fixture represents the reported distraction without requiring live model calls.
- Baseline screenshots and test results are recorded.
- The chosen composition has one shared alignment contract, including composer mode/queue states.
- Any design deviation from this proposal is recorded before implementation, not hidden in CSS.

## 6. Delivery 1 — conversation/activity grouping

**Effort:** Medium. **Dependencies:** Baseline fixtures; independent of the shell redesign.
**Primary files:** `packages/ui/src/transcript.ts`, `packages/ui/src/components/Transcript.tsx`, `packages/ui/src/components/ToolDetail.tsx`, `packages/ui/src/styles.css`.
**Suggested additions:** a pure `activity.ts` module under `packages/ui/src/`, an `ActivityGroup.tsx` component under its `components/` directory, and focused planner/component tests under `packages/ui/test/`. These names are proposed new files, not existing dependencies.

### 6.1 Introduce a presentation projection, not another reducer

Keep `Transcript` and event ingestion authoritative. Build a pure projection with two top-level entry kinds:

```ts
// Sketch of responsibilities; finalize exact types against the existing model.
type ConversationEntry =
  | { kind: "message"; id: string; messageId: string; blockIndexes: number[] }
  | { kind: "activity"; id: string; items: ActivityReference[] };

type ActivityReference =
  | { kind: "thinking"; messageId: string; blockIndex: number }
  | { kind: "tool"; toolCallId: string };
```

References point back to the canonical transcript; do not copy potentially large result strings into an independent state store. Keep status derivation separate from chronological planning so status changes do not change entry identity.

### 6.2 Define grouping and ordering precisely

1. Use the original block indexes and tool `afterMessage` positions to build the sequence. Preserve the source ordering the model actually records; do not reconstruct history by sorting synthetic `startedAt` timestamps.
2. User text and nonempty assistant text are conversation boundaries. Preserve assistant updates verbatim; do not guess whether a sentence is important enough to show.
3. Consecutive thinking/tool references between those boundaries form one activity group, including activity spanning several thinking-only assistant messages.
4. A thinking-only message creates no Assistant heading. A tool-only message creates no empty conversation turn.
5. Preserve mixed-content order: if a message has text, thinking, and more text, retain the relative order. Use contiguous text spans rather than moving all thinking before all prose. Do not split a contiguous Markdown text block arbitrarily.
6. Emit each execution once by `toolCallId`. Do not count a request block and its correlated execution as two tools. Keep leading tools and calls without recorded results visible.
7. An empty but actively streaming thinking block can support a current-activity indicator. Empty completed blocks need not create empty disclosures.
8. Preserve the current linear traversal approach: index tools once, then walk messages/blocks. Do not reintroduce a tools-array scan for every message or delta.
9. Keep run notices in their existing dedicated path initially. They lack a reliable persisted position within historical activity groups; do not pretend they can be retrospectively attached to a specific group.

Replace ambiguous `hasProse()` usage with explicit predicates for visible text versus inspectable activity. Merely excluding thinking from that function would hide content without providing a replacement view; that is not the implementation.

### 6.3 Stable identity and disclosure state

- Derive activity identity from its first stable source item, not rendered array index, tool count, status, or preview text.
- Keep a thinking group's identity when tools are appended and when the assistant later starts writing a response.
- Keep message/span identity tied to original message and block identity; avoid remounting earlier prose on each delta.
- Store explicit open/closed choices above the session-remount boundary, keyed by session and activity identity. Keep these in memory initially; do not persist transcript-derived identifiers across browser reloads without a proven identity contract.
- Preserve user-opened details when work finishes. Default groups are collapsed; completion must not forcibly collapse something the user is reading.
- On a full history replacement, retain disclosure state only where identity can be matched reliably. Never transfer an open state to an unrelated group at the same array position; document and test the reset fallback.
- Prune stale presentation-state entries when sessions are forgotten or their transcript generation is replaced.

### 6.4 Status and copy contract

| Evidence | Permitted summary | Avoid |
|---|---|---|
| One execution has `running: true` | `Running read` or a bounded description based on known arguments | Guessing the operation's eventual outcome |
| Several executions are running | `2 tools running` | Showing only the most recently started tool as if it were the only work |
| Current message has active thinking | `Thinking…` within the single activity summary | A new top-level preview bar per thinking block |
| Session is active but no detailed operation is available | `Working…` at the active tail/header | Invented progress percentages or task labels |
| Recorded tool failure followed by more work | `Running bash · 1 earlier call failed` | `Recovered` without explicit evidence |
| Finished historical tool records | `4 tool calls recorded` | `Task completed successfully` |
| Missing recorded result | `1 call has no recorded result` | An indefinitely running spinner or a success tick |
| Connection lost / session interrupted | Existing authoritative disconnected/interrupted state | Claiming streaming is live simply because an old block remains incomplete |

Keep aggregate failure/no-result information discoverable in collapsed summaries. Explicit retry notices may report recovery for that retry mechanism, but must not retroactively mark unrelated failed tools as recovered.

Prefer short deterministic labels such as `Reading <path>` when arguments support them. For unknown tools or incomplete arguments, show the actual tool name. Do not parse arbitrary shell commands into confident semantic claims or add a model call to generate summaries. Hide payload byte counts from the collapsed default view.

### 6.5 Activity details and accessibility

- Use a semantic disclosure with a readable summary and a keyboard-operable hit area; keep the disclosure control outside any nested action buttons.
- In its expanded body, show ordered tool steps and a secondary, explicitly labeled disclosure for available thinking content. No full-thinking tooltip or automatic preview on hover.
- Reuse `ToolDetail` for arguments/output and retain its bounded preview, full-output access, copy behavior, and provenance treatment.
- Mount expensive detail bodies on demand. Preserve memoized prose and avoid repainting all historical output for every streaming update.
- Keep focus stable when the summary text changes. Use status words in addition to color; honor reduced motion and forced colors.
- Retain the pure-reading preference: map existing marker visibility to activity visibility. Hiding routine activity must not hide failures, missing-result warnings, approvals, or the current session's status.

### Acceptance and tests

- The fixture equivalent to `img_18.png` produces one collapsed activity group when there is no intervening user-facing prose—not four tool rows and three Assistant/Thinking pairs.
- All thinking/tool content remains reachable; each tool execution appears once in the group's detail sequence.
- Real user messages and assistant updates remain chronological and readable.
- Streaming thinking → tools → prose does not remount the preceding activity group or reset its open state.
- Concurrent tools, failures, interruption, empty results, missing results, reload/history seeding, and unknown tool names have truthful representations.
- The planner is linear in source items; include an operation-count or equivalent deterministic regression test, not a flaky wall-clock threshold.
- Add planner and mounted-component tests; extend existing transcript tests without weakening tool-correlation, history, failure, or sanitization coverage.

## 7. Delivery 2 — coherent workspace geometry and compact chrome

**Effort:** Medium. **Dependencies:** Delivery 0 placement decision; integrate with Delivery 1's activity renderer.
**Primary files:** `packages/ui/src/App.tsx`, `packages/ui/src/styles.css`, `packages/ui/src/components/Composer.tsx`, `packages/ui/src/components/Transcript.tsx`, `packages/ui/src/components/SessionRail.tsx`, `packages/ui/src/components/ModelPicker.tsx`, `packages/ui/src/components/ThinkingPicker.tsx`.
**Suggested additions:** small shell/session-header components only where they clarify ownership. Do not split every existing element into a new abstraction.

### 7.1 Give each region explicit ownership

- Refactor the shell into navigation, workspace, and optional panel. Keep transport commands and orchestration callbacks owned by `App`.
- Use explicit auto-sized rows for global warnings/errors and a remaining-height row for the workspace. Do not keep a fixed two-row assumption when exceptional rows are present.
- Within the workspace, use header → conditional notices/dialogs → scrollable transcript → composer. The transcript gets the remaining height; the composer is not a floating overlay.
- Keep `min-width: 0` and `min-height: 0` at grid/flex boundaries so content can shrink and scroll instead of overflowing.
- Do not relocate or remount the transcript scroll root merely to change horizontal alignment. Preserve the existing reserved space for Jump to latest.

### 7.2 Establish one reading-lane contract

- Apply the same lane bounds and inset to message content, activity summaries, composer mode/queue strips, textarea/actions, hints, and transcript navigation.
- Compute `ch`-based width using the same reference font and reading size. A monospace activity label or fixed-size composer must not calculate a different width from the prose.
- Keep reading-size changes scoped to reading content; deriving shared geometry must not accidentally resize all buttons and form fields.
- Handle `fill` explicitly. The stored `none` measure is not a length that can be placed inside arbitrary CSS `calc()` expressions.
- Preserve all accepted reading sizes/measures; do not overwrite existing settings to make the prototype look better.
- Allow code/output to use a deliberate wider inspection surface. Do not stretch normal prose across the entire window or allow one long command to widen the page.
- Keep Send attached to the input group and visible at narrower widths. The textarea must be shrinkable; mode and helper rows must wrap without clipping.

### 7.3 Consolidate the header and utilities

- Present session name/state/location as one identity block; preserve inline rename and scratch/isolation cues.
- Keep a readable current-model identifier and Thinking level in the same session context. Reuse the current pickers' loading, errors, discovery, and next-turn semantics rather than rebuilding model selection.
- If the controls cannot fit, wrap a coherent control group or use an accessible configuration disclosure. Do not truncate away the model's distinguishing part to preserve a single line at any cost.
- Keep context pressure and pending/attention state visible. Put detailed tokens, cost, and message count in a labeled Usage disclosure using existing formatters and honest unknown values.
- Replace the permanent full-width tool legend with contextual provenance help available from activity/details; preserve the actual Tool output labels and colored edge.
- Put auto-follow and trace access in a small, clearly labeled utility area rather than another permanently tall information strip.
- During the core delivery, keep the existing full trace available behind this access point. It may occupy a bounded drawer when explicitly opened; its collapsed state must not recreate the old full-width strip. Preserve saved visibility choices where meaningful.

### 7.4 Move global navigation without losing access

- Move the brand, Sessions/History navigation, fleet attention summary, connection status, and Settings into the rail shell; keep the session list as its own independently scrollable area.
- Settings remains a labeled control and returns keyboard focus to its invoking trigger after close.
- Preserve fleet needs-attention counts. Do not trade multi-session supervision for a chat-only surface.
- The current rail hides below its desktop breakpoint. Before moving global controls into it, provide a visible compact navigation entry point at those widths and verify keyboard access to Sessions, History, Settings, connection, and session switching.
- A compact navigation drawer needs a close action, correct focus handling, and Escape behavior. Do not assume a CSS `.open` class alone constitutes a working drawer.
- Preserve reachable panel access in History and no-session states as well as in an active conversation.

### 7.5 CSS change discipline

Edit or replace the owning layout rules rather than appending another override at the end of the shared stylesheet. Remove obsolete declarations for the changed surfaces and update their comments. Do not mix a repository-wide stylesheet cleanup into this delivery.

### Acceptance and tests

- Conversation, activity, and composer have the same intended edges in the chosen composition; tool/prose updates do not switch alignment.
- The panel closes without an empty reserved track; opening/resizing it keeps both content and controls usable.
- Ordinary use has one compact session header, not separate permanent metrics and legend rows.
- Errors, isolation warnings, and approvals remain visible without covering messages or inputs.
- A long prompt, queue, Steer/Follow-up controls, long model/title, and larger text do not clip Send or help text.
- Session switching preserves draft, follow behavior, and remembered scroll position.
- Replace obsolete source-text layout assertions with tests of the new contract; keep the old regression cases as browser scenarios.

## 8. Delivery 3 — hierarchy, legibility, and integration polish

**Effort:** Small to medium. **Dependencies:** Deliveries 1–2.
**Primary files:** `packages/ui/src/components/SessionRail.tsx`, `packages/ui/src/components/PanelToggle.tsx`, `packages/ui/src/components/FollowToggle.tsx`, `packages/ui/src/styles.css`, and the updated shell/header.

### Work

1. Strengthen `.is-focused` using a persistent background/shape distinction plus the existing `aria-current`. Keep selection distinct from hover, keyboard focus, and lifecycle state; do not reuse a state-colored border for a second meaning without redesigning that vocabulary.
2. Reduce the oversized New session treatment while retaining scratch-first creation, its label, explanatory access, and shortcut. Do not replace it with an unexplained plus icon.
3. Prioritize session title, meaningful state, and directory/approval context. Remove routine model/thinking/cost repetition from every row; keep those facts in the session header/Usage/Details. Preserve pending counts, context warnings, approval asks, and previous failure evidence when relevant.
4. Keep Settings and disconnection/attention information reachable at the bottom of the rail without making users scroll through the entire session list.
5. Replace generic `Show panel` wording with consistent `Show details` / `Hide details` and label the panel accordingly. Keep Files access understandable inside that surface.
6. Clarify auto-follow as an interactive preference, distinct from whether the reader is currently at the live tail. Preserve the valid case where auto-follow is enabled but manual scrollback pauses following; Jump to latest explicitly resumes it.
7. Use the existing system font/token family. Increase important technical/control readability locally rather than globally enlarging every token or making all secondary text equally bright.
8. Measure text and control contrast against actual rendered backgrounds; do not claim a failure solely from the screenshots. Target AA text contrast and visible non-color state distinctions.
9. Verify comfortable keyboard/pointer targets, focus-visible, reduced-motion behavior, and forced-colors output.
10. Update the affected sections of `packages/ui/DESIGN.md` and add release notes under an appropriate unreleased heading, without rewriting released history.

### Acceptance

- The selected session is identifiable without matching the header text manually.
- New session is discoverable but does not visually outweigh the ongoing conversation.
- Repeated metadata is reduced without hiding work that needs attention in another session.
- Utility controls clearly communicate their function and state; accessible names agree with visible labels.
- The before/after captures demonstrate less fragmentation and stronger hierarchy, not merely different padding.

## 9. Optional delivery 4 — full trace as a Details mode

**Effort:** Medium. **Dependencies:** Core layout accepted. **Not required to ship the initial improvement.**

Move the full trace only if review confirms that its on-demand drawer still competes with the conversation. Do not migrate it in the same change that establishes activity grouping.

### Changes

- Add a `trace` mode to `PanelMode`, parsing/serialization in `packages/ui/src/panel.ts`, and the mode inventory in `packages/ui/src/components/Panel.tsx`.
- Reuse `ToolTrace` and canonical tool data; provide a panel variant that fills the panel instead of carrying the old drawer header, collapse control, and height assumptions.
- An explicit `Inspect in trace` action from activity details opens Details → Trace and selects the exact `toolCallId`. It does not send any server control.
- Lift selected-tool state above the current `SessionView` remount boundary, scoped by session. Preserve selection when the panel is hidden and shown; never leak one session's selection into another.
- Preserve width, user-sized behavior, and Session/Files preferences. Trace must not trigger Files' automatic widening policy.
- Define fallback for old/invalid persisted modes and how legacy trace-collapse preferences are retired. Do not unexpectedly open the panel on upgrade.
- Verify panel switching behavior rather than relying on comments claiming children remain mounted; preserve relevant view state explicitly where unmounting occurs.
- Maintain keyboard traversal and full output access; ensure the selected tool can be brought into view without constantly pulling the reader to the latest call.

### Acceptance

All prior trace data and interactions remain reachable, no persistent trace row remains between reading and writing, panel preference tests cover the new mode, and no-session/History states have an honest empty/disabled Trace surface.

## 10. Validation strategy

### 10.1 Automated tests

Use the existing Node test runner, pure TypeScript tests, and Vite/jsdom mounted-component setup. Add focused test files rather than continuing to append every case to the large shared component test file.

| Area | Existing coverage to retain or adapt | New assertions |
|---|---|---|
| Transcript projection | `packages/ui/test/transcript.test.ts` | Group across thinking-only turns; preserve mixed-block order; retain every tool; stable keys; linear traversal. |
| Rendered messages/activity | `packages/ui/test/turns.test.mjs`, `packages/ui/test/tool-detail.test.mjs`, `packages/ui/test/disclosure-register.test.mjs` | No empty Assistant headings; collapsed compact group; reachable details; focus/open state survives streaming. |
| Thinking previews | `packages/ui/test/transcript-gist.test.mjs` | Remove only requirements for top-level previews; retain utility tests if the formatter remains used in diagnostics. |
| Scrolling | `packages/ui/test/scroll.test.ts`, `packages/ui/test/transcript-scroll.test.mjs`, `packages/ui/test/nested-scroll.test.mjs` | Group expansion/streaming while pinned and scrolled back; panel resize; session switch; unchanged Jump-to-latest semantics. |
| Geometry/preferences | `packages/ui/test/layout.test.mjs`, `packages/ui/test/reading.test.ts`, `packages/ui/test/panel.test.ts` | Shared lane, `fill`, larger text, no separate centering; persistence remains compatible. |
| App/rail/composer | `packages/ui/test/components.test.mjs`, `packages/ui/test/roster.test.ts`, `packages/ui/test/inline-rename.test.mjs` | Navigation relocation, selection, model controls, queue/steering, rename, approval and failure states. |
| Security/accessibility | `packages/ui/test/invariants.test.ts`, `packages/ui/test/contrast.test.mjs` | Same sanitization boundary, inert tool/thinking output, provenance, no per-delta live announcements. |

Some invariants currently assert implementation names such as `ToolMarker`, or that formatters appear directly in `App.tsx`. Update those assertions to follow the new responsible components while retaining the protected behavior. Do not delete architectural invariants merely because files move.

### 10.2 Browser verification

The inspected package configuration does not provide a Playwright script/dependency. Node/jsdom tests do not validate actual geometry. Use recorded manual browser checks initially, or explicitly add a small browser harness as a separately scoped test-infrastructure change. Do not report screenshot checks as automated unless they actually ran.

**Viewport matrix:** 1540×950 for comparison with the supplied image; 1280×800 and 1024×768 for desktop constraints; 1920×1080 for wide layouts; a sub-1024 window and 200% zoom as navigation/reflow smoke checks, not a promise of a new mobile layout.

For each main viewport, cover panel closed/open, default and larger reading size, and `fill`. Inspect:

- Idle conversation, streaming text, thinking-only activity, and a long sequence of tools.
- One running tool, parallel tools, failed-then-continuing work, missing results, and interrupted/failed sessions.
- Collapsed/expanded activity and long tool output, including horizontal code scrolling.
- Manual scrollback, auto-follow off/on, Jump to latest, group expansion, and panel resizing.
- Composer with multiple lines, queue, Steer/Follow-up, and restored text after stop.
- Long session/model identifiers, no selected session, empty history/filter results, and Settings focus return.
- An approval in the focused session and an approval in a background session.
- Direct-mode banner, disconnected state, context pressure, and simultaneous notice rows.
- Keyboard-only navigation and visible focus; reduced motion and forced colors.

Capture before/after images with the same fixtures and window sizes. Review the whole composition, not only whether components fit. At minimum, validate Chromium and the browser used for the supplied desktop capture; record the actual browsers/versions used.

### 10.3 Commands

Run focused tests during each delivery, then the UI suite and full repository verification before merge:

```sh
node --test "packages/ui/test/**/*.test.ts" "packages/ui/test/**/*.test.mjs"
npm run verify
npm run ui:build
```

For documentation-only updates to this plan:

```sh
npm run check:docs
```

These are planned implementation checks. They are not a claim that the refactor or its tests have already been executed.

## 11. Delivery order, risk, and rollback

| Change | Reviewable unit | Main risk | Release gate |
|---|---|---|---|
| Baseline/design checkpoint | Fixtures and accepted composition | Repeating an already rejected layout | Compare complete A/B layouts with real states. |
| PR 1 | Activity planner + compact renderer + tests | Lost chronology, remounting, misleading status | Grouping/data retention and live-stream checks pass. |
| PR 2 | Workspace geometry + compact header/navigation + tests | Scroll, overflow, and inaccessible moved controls | Browser matrix and composer/approval regression checks pass. |
| PR 3 | Sidebar hierarchy + readability + integration/docs | Hiding attention state or weakening accessibility | Screenshot acceptance and full verification pass. |
| Optional PR 4 | Trace panel mode + migration/tests | Lost selection/preferences or duplicated trace UI | Full trace remains reachable in all relevant states. |

Each core PR should be independently reviewable and runnable. Include its tests and documentation with the behavior change, not in a final cleanup-only PR. No protocol/schema migration is expected for the core deliveries; reverting a UI commit should not require modifying stored sessions.

The largest uncertainty is regression testing around streaming, disclosure identity, and scroll anchoring—not the number of JSX elements moved. Treat this as a medium frontend refactor with three core delivery slices, rather than a quick styling patch or an application rewrite.

## 12. Definition of done

- [ ] The `img_18.png` pattern is a single inspectable activity sequence unless real user-facing content creates a boundary.
- [ ] All original conversation and execution evidence remains reachable and correctly ordered.
- [ ] Current activity, historical failure evidence, and required intervention are distinguishable without guessing.
- [ ] Conversation, activity summaries, navigation, and composer share the approved geometry at all tested widths/preferences.
- [ ] Permanent metadata strips are reduced; exceptional warnings and approvals retain real space and prominence.
- [ ] Selected session, model identity, creation, Settings, History, and Details are obvious and keyboard accessible.
- [ ] Drafts, queues, session focus, panel preferences, scroll memory, and user-opened details behave correctly.
- [ ] Security, lifecycle, contrast, and accessibility invariants remain protected by tests.
- [ ] Full verification/build pass, with unrelated pre-existing failures explicitly distinguished if present.
- [ ] Before/after captures are reviewed and the affected design documentation matches the shipped behavior.
