# Transcript UI Review — Pi Central Agent Orchestrator

**Date:** 2026-10-29  
**Source:** Screenshot `img_11.png`  
**Reviewed by:** ui-review subagent + analysis

---

## 1. What the Screenshot Shows

### Overall Layout

A dark-themed three-zone desktop app (near-black `#0b0b0f` canvas, panel backgrounds `#14141a`):

| Zone | Description |
|------|-------------|
| **Top bar** | "Pi Central" with Sessions/History nav tabs; right side shows counters ("1 session", "1 scrat…") — the right counter is clipped at the viewport edge. |
| **Left sidebar (~270px)** | "New session" blue card, "Open in a directory…" shortcut, "Filter sessions" input, one selected "Demo" session card with `scratch` + `idle` badges, model name ellipsized (`deepseek…-1017`). Footer: "864 sessions on disk — see the History tab." |
| **Main transcript panel** | Session header (name, badges, path breadcrumb, stats), trust notice, then a stacked feed of message turns, ending with a floating "↓ Jump to latest" pill, a "Tool trace" strip, and a composer input clipped at the bottom. |

### Transcript Content (visible area)

The feed shows ~6 assistant turns in a repeating pattern:

1. **Unlabeled opening paragraph** — white prose: *"Let me dig into the `signal` code properly — I want to verify a few things I suspect are real defects before touching anything."* (No speaker label — reads like agent speech, ambiguous whether user or assistant.)

2. **Collapsed tool-call rows** — thin colored left-edge bar, label like **"2 tools"** + green/muted chips (`bash`, `read`), right-aligned byte sizes (`202 B`, `47 B`, `3,7 KB`), `▾` expand chevron.

3. **"Assistant" caption** — tiny muted label above each thinking block.

4. **Thinking blocks** — full-width rounded dark containers with hairline border, containing only the word **"Thinking"**. All four consecutive blocks look **identical** — no preview text, no duration, no topic hint. They are visually heavier (large filled containers) than the actionable tool rows (thin muted lines).

5. **Assistant statements** — white text summarizing findings: *"Found real defects. Let me pin down each one precisely before fixing."*, etc.

6. **No separators or turn numbers** between these repeating units.

### Bottom Area

- Floating **"↓ Jump to latest"** pill overlapping transcript content.
- **"Tool trace  59 calls  latest: bash · bash · bash"** — redundant triple repetition.
- **Composer** — large rounded input, "Send a prompt…" placeholder, **clipped at the bottom** (no send button or model controls visible).

---

## 2. Issues Found

| Severity | Issue |
|----------|-------|
| 🔴 Critical | **Composer clipped at bottom** — send button and model/effort controls are below the fold; looks broken rather than scrollable. |
| 🔴 Critical | **Header text clipped** — model name on right edge ("titelll…") and top-right counter ("1 scrat…") are truncated with no tooltip. |
| 🟠 High | **Identical "Thinking" boxes** — every collapsed thinking block shows only the word "Thinking", no preview, no duration. They form a uniform wall with zero scannability. |
| 🟠 High | **Tool rows visually weaker than thinking blocks** — actionable, expandable content (tools) gets a thin muted line; non-actionable thinking blocks get large filled containers. Visual hierarchy is inverted. |
| 🟠 High | **No speaker label on opening message** — the first white paragraph has no label, making it ambiguous whether it's user or assistant speech (wording "Let me dig into…" reads like agent speech). |
| 🟠 High | **Low-contrast metadata** — `deepseek…-1017`, `929.2k tok`, `59 calls` in small muted gray on near-black; likely below WCAG AA. |
| 🟡 Medium | **"Jump to latest" pill overlaps content** — sits on top of the last assistant row, competing with the tool-trace strip beneath it. |
| 🟡 Medium | **Trust notice is easily overlooked** — one line of small gray text explaining the colored-edge convention for tool output. |
| 🟡 Medium | **Sidebar model name ellipsized** — "deepseek…-1017" loses the model family. |
| 🔵 Low | **Duplicate identity** — "Demo" + `scratch` + `idle` badges appear in both sidebar card and main header. |
| 🔵 Low | **"latest: bash · bash · bash"** — redundant triple repetition, no useful progress signal. |

---

## 3. Transcript UI Improvement Recommendations

The core tension: users need to **quickly scan conversation flow** while retaining the ability to **drill into tool calls and thinking details** when needed. The current UI makes both hard — tool calls are too subtle and thinking blocks are indistinguishable walls.

### 3.1 Make Thinking Blocks Scannable (Highest Impact)

**Problem:** Four consecutive "Thinking" containers look identical. Users can't tell which is relevant, how long the agent thought, or what it thought about.

**Recommendations:**

| # | Change | Benefit |
|---|--------|---------|
| 3.1a | **Add a one-line preview** — display the first sentence or inferred topic (e.g., *"Thinking about signal code defects…"*) when collapsed. | Instant scanning — users can skip irrelevant thinking blocks or find the one they care about. |
| 3.1b | **Show duration badge** — e.g., *"Thought for 4s"* or a relative timer. | Users can gauge thinking depth at a glance; short blocks are skippable, long ones worth inspecting. |
| 3.1c | **Use progressive truncation** — show first ~80 chars, then "…". Full content on expand. | No loss of detail, just better collapsed state. |
| 3.1d | **Visually de-emphasize collapsed thinking** — thinner, more compact than expanded tool results. | Fixes the inverted hierarchy: actionable tool output should have more visual weight than collapsed thoughts. |

### 3.2 Improve Tool-Call Visibility & Hierarchy

**Problem:** Tool calls (the most actionable content) are thin muted rows. Users who want to inspect tool calls have to hunt for them.

**Recommendations:**

| # | Change | Benefit |
|---|--------|---------|
| 3.2a | **Visually group tool calls with their thinking context** — a single turn should read as: user message → [thinking preview] → [N tool calls expanded/collapsed] → assistant response. | Clear narrative thread per turn. |
| 3.2b | **Make tool rows more prominent** — slightly more padding, clearer expand chevron, distinct left-edge color per tool category (bash=green, file=blue, search=amber, etc.). | Users quickly identify tool types before expanding. |
| 3.2c | **Show tool duration and result summary in collapsed state** — e.g., *"bash (0.3s) → exit 0, 47 B"*. | Users know if a tool call succeeded without expanding. |
| 3.2d | **Add expand-all / collapse-all per turn** — a small toggle on each assistant turn to show/hide all tool calls and thinking at once. | Power users can inspect everything in one click. |

### 3.3 Add Clear Speaker Identification

**Problem:** The first message in the transcript has no label, making user/assistant attribution ambiguous.

**Recommendations:**

| # | Change | Benefit |
|---|--------|---------|
| 3.3a | **Label every top-level message** with speaker + optional timestamp. E.g., a small `You` / `Assistant` badge or avatar. | Zero-ambiguity attribution. |
| 3.3b | **Differentiate visual treatment** — user messages on a slightly different background shade, or left-aligned vs. left-aligned with subtle indent difference. | Quick visual parsing without reading labels. |
| 3.3c | **Consider avatar/initials** — small `U` / `A` circle, or model icon for assistant. | Familiar chat pattern; low implementation cost. |

### 3.4 Turn Separation & Navigation

**Problem:** Six turns flow as one continuous scroll with no boundaries, making it hard to orient within a long session.

**Recommendations:**

| # | Change | Benefit |
|---|--------|---------|
| 3.4a | **Add subtle horizontal rules or spacing between turns** — a thin divider or increased margin between assistant-response and next-user-message. | Clear turn boundaries without visual noise. |
| 3.4b | **Turn numbers or timestamps** — small, muted turn counter (e.g., `Turn 4`) or relative timestamp (`2m ago`). | Navigation anchor for users who want to reference a specific turn. |
| 3.4c | **Collapsible turns** — allow collapsing an entire turn (user prompt → thinking → tools → response) into a one-line summary. | Long sessions become skimmable timelines. |
| 3.4d | **Mini-map or scroll bar markers** — marks on the scrollbar for tool calls, thinking blocks, user messages. | Quick spatial orientation in very long transcripts. |

### 3.5 Progressive Disclosure Architecture

**Design principle:** Show the narrative at the top level, let users drill down for details.

```
Turn 4 — 2m ago
│
├─ You: "What defects did you find in the signal code?"
│
├─ Assistant: "Found real defects. Let me pin down each one..."
│   │
│   ├─ ▸ Thought for 4s — "Let me verify signal code defects..."
│   ├─ ▸ 2 tools (bash · read) — 249 B total, all passed
│   └─ ▸ Thought for 2s — "Confirmed four real defects..."
│
└─ (next turn)
```

This structure:
- **Top level:** just the conversation narrative (user → assistant → user → assistant)
- **Second level (expand one):** thinking previews + tool summaries
- **Third level (expand deeper):** full thinking text or full tool output

### 3.6 Fix Compositor & Edge Clipping

| # | Change | Benefit |
|---|--------|---------|
| 3.6a | **Fix the composer clipping** — ensure the full composer (input + send button + model picker + effort slider) fits above the fold, or use a sticky-bottom layout. | Functional parity — users can actually send messages. |
| 3.6b | **Wrap or tooltip clipped text** — model name in header and sidebar should truncate with an ellipsis that reveals full text on hover. | Users can read model name and identifiers. |
| 3.6c | **Remove redundant "latest: bash · bash · bash"** — replace with a concise summary like *"Last: 3 bash calls (all ok)"* or remove entirely and rely on the visible turn. | Less noise, more signal. |

---

## 4. Prioritized Action Plan

### Quick Wins (low effort, high impact)

1. Add a one-line preview to collapsed thinking blocks (3.1a)
2. Label all messages with speaker (3.3a)
3. Fix composer clipping (3.6a)
4. Fix header text clipping with hover tooltips (3.6b)
5. Replace "latest: bash · bash · bash" with useful summary (3.6c)

### Medium Effort (meaningful improvement)

6. Add duration badges to thinking blocks (3.1b)
7. Group tool calls + thinking under each assistant turn (3.2a)
8. Show tool result summaries in collapsed state (3.2c)
9. Add turn separators and turn numbering (3.4a, 3.4b)

### Longer-Term (progressive enhancement)

10. Collapsible turns with one-line summaries (3.4c)
11. Scrollbar markers / mini-map for long sessions (3.4d)
12. Expand-all / collapse-all per turn (3.2d)
13. Color-coded tool categories (3.2b)

---

## 5. Design Principles for Transcript UI

1. **Narrative first, details on demand.** The conversation between human and agent is the primary content. Tool calls and thinking are supporting evidence.

2. **Scannability without sacrifice.** Collapsed states must carry enough information (preview, duration, outcome) that users rarely need to expand unless investigating.

3. **Clear ownership.** Every piece of content must be attributable: user, assistant, tool, or system.

4. **Consistent visual hierarchy.** More important / more actionable content should have more visual weight. Currently inverted.

5. **Accessible metadata.** Model names, token counts, timestamps should be readable at normal viewing distance and at least WCAG AA contrast.
