# UI review — the focused-workspace layout

**Next step:** [Detailed implementation plan](focused-workspace-plan.md) — staged delivery, code boundaries, acceptance criteria, and regression coverage.

**References:** [`img_17.png`](../../img_17.png), desktop workspace with inspector hidden; [`img_18.png`](../../img_18.png), a close-up of successive tool calls and thinking summaries. Both reviewed directly.
**Scope:** Screenshot-based evaluation using the `ui-review` rubric. This replaces the earlier draft that mixed older captures into the findings. No source-code diagnosis or interaction testing is implied; older error banners, modals, and inspector states are deliberately excluded.

## 1. What I see

In `img_17.png`, a global navigation bar sits above a left session sidebar and the main workspace. The sidebar contains a prominent blue New session action, directory and filter controls, and two idle sessions. The workspace stacks session identity/model controls, usage statistics, a tool-output notice, the conversation, a Tool trace strip, and the prompt composer. Messages and an expanded tool result occupy a narrow, left-aligned column, while the composer spans almost the entire workspace; a large dark area remains to the conversation’s right.

In `img_18.png`, four tool-group rows alternate with three “Assistant” labels and three “Thinking” bars. The first tool group reports “1 failed”; the last reports “running”. Thinking previews are truncated, tool rows carry byte counts, and no substantive user-facing answer appears in this crop.

## 2. Putting the discomfort into words

> “The screen feels simultaneously cramped and empty. The conversation is squeezed into one side, while its controls spread across the window. Technical details dominate the reading area, but it is hard to see which session is selected or what deserves attention.”

The main problem is **spatial hierarchy**, not the dark palette or a lack of decoration. Different regions appear to use different layout rules: narrow conversation, wide composer, distant model controls, full-width status strips. The result feels like several useful components assembled together rather than one deliberately composed workspace.

## 3. Issues found

Severity: 🟠 should fix · 🟡 nice to fix. No blocking UI defect is established by these captures.

- **🟠 Conversation — constrained content beside unused space.** The user message, assistant reply, and expanded tool block stop well before the workspace’s right edge. Yet command text wraps densely within the tool block. This makes the interface feel space-starved despite the available room. **Direction:** establish an intentional reading column within the available workspace; keep prose comfortably bounded, but let code/output expand or open in an inspector. Do not simply stretch prose edge to edge.

- **🟠 Composer — disconnected from the reading column.** Its left edge aligns with the messages, but the input extends far beyond them and Send sits at the far right. The writing surface and reading surface do not feel like the same conversation. **Direction:** give messages and composer a shared container, with Send belonging visibly to that container; allow wider technical content as an explicit exception.

- **🟠 Workspace chrome — too many horizontal layers.** Global navigation, session header, statistics, and the explanatory notice all precede the conversation; Tool trace adds another strip above the composer. The repeated separators give secondary information nearly the same structural weight as the task itself. **Direction:** combine identity, essential status, and model configuration into a compact session toolbar; move detailed telemetry and explanatory help into disclosure. Preserve the meaning of tool-data markers without requiring a permanent full-width explanation.

- **🟠 Expanded tool result — implementation detail dominates the conversation.** Raw command JSON and file contents occupy more of the visible reading area than the assistant’s explanation. The terse headings “2 tools bash” and “3 tools bash · read” describe mechanism, not purpose. **Direction:** lead with a useful operation summary and outcome, then expose arguments and output on demand. Keep failures discoverable and retain easy access to raw evidence. This capture does not establish whether expansion was automatic or user-selected.

- **🟠 Session sidebar — the current selection is not visually obvious.** Both rows have similar backgrounds and idle pills. The header identifies `pi-central-dev`, but the sidebar requires matching that title rather than showing an unmistakable selected row. **Direction:** use a persistent selected background or edge marker, separate from running/idle status and keyboard focus. Users should locate their current session at a glance.

- **🟠 Header — model configuration is distant and compressed.** Session identity is at the left; Provider, Model, and Thinking are packed against the right edge. The model identifier is visibly truncated despite abundant space elsewhere. **Direction:** present a readable model summary near the session context, with configuration available from it. Prioritize the identifying part of the model name; make the full identifier available on focus as well as hover.

- **🟠 Typography — useful secondary information is visually fragile.** Paths, usage figures, tool headers, command text, and shortcut hints are small and muted. This is not merely decorative metadata: some of it is necessary to understand what ran and where. **Direction:** distinguish readable technical content from quiet annotation through a deliberate type scale and contrast. Contrast ratios cannot be certified from this visual review.

- **🟡 Sidebar — creating a session outweighs working in one.** New session is the largest, brightest filled control, while the current session has little emphasis. The list also repeats paths, models, context, cost, and idle status, although related information appears in the workspace. **Direction:** retain an easy-to-find creation action but reduce its visual dominance; make session title, selection, and actionable status the first scan, with secondary metadata more restrained.

- **🟡 Scrolling — navigation cues belong to different visual regions.** The expanded output has its own scrollbar, the transcript has another at the far right, and Jump to latest is centered in the wider workspace rather than the narrow message column. This makes the scrolling context less obvious. **Direction:** align transcript navigation with the conversation container and consider a dedicated output viewer for long results. Nested scrolling is visible; scroll trapping or covered message text is not established here.

- **🟡 Utility controls — purpose and state require interpretation.** “Show panel” does not identify what the panel contains, while “auto-follow on” and “markers on” look like small status badges rather than clearly interactive controls. Auto-follow on also coexists with Jump to latest; that may be valid, but the relationship is unclear. **Direction:** name the panel by function, distinguish controls from indicators, and clarify following versus paused states. Verify the actual behavior before treating this as a defect.

## 4. Tool calls and thinking — why `img_18.png` is distracting

**Diagnosis: an execution log is being presented with the visual grammar of a conversation.** Every internal step becomes another thing to read, although most steps do not change what the user needs to know. Collapsing each event individually has not solved the problem: the collapsed rows themselves now constitute the clutter.

- **🟠 Repeated “Assistant” labels create false conversational starts.** Each label suggests a new response, but is followed by a Thinking strip and another tool row. The reader repeatedly checks for an answer and instead encounters process. **Direction:** group successive internal steps into one work phase; reserve conversational authorship for actual user-facing messages.
- **🟠 Thinking previews demand attention without delivering a complete message.** Each bar gives a clipped fragment about retries or reviewing the wrong scope. The large gap between “Thinking” and its preview also separates the label from its content. The reader must inspect several incomplete thoughts to infer progress. **Direction:** show one concise, user-facing current-activity summary, not a succession of intermediate thinking excerpts. Make available thinking summaries opt-in within diagnostics, rather than persistent conversation entries.
- **🟠 The repeated bars create visual stutter.** Thin tool and Thinking strips share similar backgrounds and edge treatments, separated by recurring labels and gaps. Everything looks equally small and equally important; there is no dominant result or stable progress anchor. **Direction:** use one activity container with one heading and one current status. Reveal its chronological steps only when expanded.
- **🟠 Failure and running states lack a visible relationship.** The red “1 failed” and green “running” markers coexist, but the crop does not explain whether the failure is recovered, still relevant, or blocking. **Direction:** summarize the work phase’s actual state and explicitly distinguish a recovered attempt from an unresolved failure. Keep blocked work, approval requests, and consequential failures prominent; grouping must not hide them.
- **🟡 Tool names and byte counts describe plumbing rather than progress.** Repeated `subagent`, `read`, and payload sizes help debug transport but do not tell the user whether the review is advancing. **Direction:** use truthful operation labels such as “Reading review output”, with tool names and payload sizes in expanded details. Do not invent percentages or completion claims.

**Recommended default:** user request → optional meaningful assistant update → one compact activity group → substantive answer. While running, update the group's current activity in place; after completion, leave a collapsed summary with an explicit outcome. Expansion reveals tool chronology, failures/recoveries, and available diagnostics. Important questions or scope changes remain normal conversation messages, not buried trace entries. Keep one underlying trace accessible from the activity group or Tool trace, rather than requiring users to follow two competing histories.

**Important distinction:** the previews also expose real workflow problems: a retry after a bad option and reviews covering more images than requested. Better presentation does not fix those problems. Surface their user-relevant consequences and recovery honestly; do not merely hide evidence of unnecessary work.

## 5. Recommended order of improvement

1. **Regroup activity before restyling its rows.** Replace the repeated Assistant → Thinking → tool sequence with one progressively inspectable work phase. This is the highest-impact fix for the distraction in `img_18.png`; smaller fonts or tighter gaps would merely compress the noise.
2. **Unify the workspace geometry.** Prototype a shared conversation/composer column that rebalances when the inspector opens. Let technical output use more space deliberately. This addresses the overall imbalance in `img_17.png`.
3. **Simplify the surrounding chrome.** Consolidate session context and reduce persistent notice/telemetry strips. Keep the conversation, not its instrumentation, as the dominant region.
4. **Strengthen orientation and legibility.** Add an unmistakable selected session, readable model identity, clearer text levels, and understandable utility controls.

## 6. What to look into

- Test narrower windows, larger text, long session/model names, and inspector-open layouts. One desktop capture cannot establish responsive behavior.
- Check keyboard focus, selected-state semantics, accessible names, actual hit areas, and measured text/control contrast. Hover and focus states are not shown.
- Exercise wheel/trackpad and keyboard scrolling inside expanded output; verify auto-follow, manual scrollback, Jump to latest, and whether floating controls ever obscure content.
- Compare collapsed/expanded tool activity, running sessions, actionable failures, empty conversations, and long prompts. Do not infer these states from older screenshots of different builds.
- Watch a long tool sequence live: check row insertion, scroll movement, focus retention, and whether a reader's expanded details remain open. The static crop establishes repetition, not animation or scrolling defects.
- Test recovered versus unresolved failures and concurrent tools. Can the reader identify the current activity and whether intervention is needed without opening the trace? Ensure live announcements do not narrate every internal event.

## 7. Overall impression

The foundation is useful: stable session navigation, readable assistant prose, visible execution evidence, and a persistent composer. What is missing is a clear hierarchy between **the conversation**, **the session context**, and **the debugging detail**. `img_18.png` makes the central issue especially clear: the user should be able to follow the work without reading the machinery. Group internal activity first, then fix the spatial relationships; preserve inspectable evidence without allowing it to become the main conversation.
