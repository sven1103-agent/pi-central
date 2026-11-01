# Queued prompts and the steering choice — implementation plan

**Status:** Accepted. Decisions recorded below; implementation follows.
**Supersedes:** the `mode-strip` and the bare `queue-rows` in `packages/ui/src/components/Composer.tsx`.
**Grounding:** `DESIGN.md` §4 / §4.2 / §4.3, `packages/protocol/src/envelopes.ts`, `packages/ui/src/store.ts` (`queuedMessages`).

## The problem, stated precisely

Three complaints, with three different causes. Conflating them is what makes the fix look expensive.

| Complaint | Actual cause |
|---|---|
| "It changes the canvas of the transcript… it pushes the steering line to the top" | The dock's height is a function of **N**: every queued text adds a row and re-shrinks the scroller, so a reader pinned to the tail is moved repeatedly during a run. |
| "This steering / follow up bar is too much" | Three elements and 26px of permanent dock height to choose between two things, one of which is never used by most readers. |
| "Users have no idea which prompts are steering prompts and which are follow ups" | A **typographic** problem: bare `<li>` text under a count, with no group, no label and no order that means anything. |

The first is a **stability** problem, not a location problem. That distinction is what decides the strategy.

## Decisions

Four were open; these are the answers.

1. **Strategy 3 — a bounded rail in the dock, and a sheet for the full list.**
   The rail's height is a function of *how many groups are non-empty* (zero, one or two lines), never of how many messages are queued. The full list lives in a popover. **The dock is therefore the same height for 1 queued message and for 50.**
2. **The Steer / Follow-up choice is a keystroke, not a control.** `Enter` steers, `Alt+Enter` queues for after the run — both already implemented, and both Pi's own bindings. The mode strip is deleted.
3. **Double-Escape is accepted and documented.** With the sheet open, `Esc` closes the sheet only; `Esc` again stops the run and clears the queue. It is ladder-correct (DESIGN §4.3 step 2, which until now had no subscriber) and recoverable, because the cleared texts return to the composer.
4. **A popover, rendered properly.** Not a panel mode — but `QueuedPrompts` takes no position of its own, so promoting it to a `Queued` panel tab later is a ten-line change rather than a rewrite.

### Why not the companion the first instinct asked for

The instinct was right that the queue is *a thing you look at*, not a caption under an input, and that it deserves its own composed treatment with room. It is wrong about the **place**: the queue is the answer to a gesture made in the composer, and its most important content is one row — the next thing that will run. Three hundred pixels of column for a one-line answer, permanently docked, in a pane that defaults to hidden, is more surface than the information.

So the companion **component** is built. Its **position** stays undecided, which is what keeps the decision revisitable.

**Trade-off accepted:** the full text of every queued message is one explicit gesture away instead of always on screen.

## Layout

```
├──────────────────────────────────────────────────────────┤ ← dock height is
│ now   do sth else                             Show queue ›│   STABLE while
│ then  and more                                +4 more     │   streaming
│ ┌ composer-input (3 lines) ─────────────────────────────┐│
│ │ Steer this run…                                       ││
│ └───────────────────────────────────────────────────────┘│
│ Enter to steer · Alt+Enter to queue for after this run · Esc stops the run   (auto-follow on) │
└──────────────────────────────────────────────────────────┘

        ┌ 6 queued messages ─────────────────────────────────┐
        │ 1 steers this run; 5 run after it finishes.         │
        │                                                     │
        │ now  ▏do sth else                                   │
        │      Delivered when the current tool calls finish.  │
        │ ─────────────────────────────────────────────────── │
        │ then ▏and more                                      │
        │ then ▏update the README table                       │
        │      Starts after this run finishes.                │
        │                                                     │
        │ This list is read-only: Pi Central can clear the     │
        │ whole queue, not one message.                       │
        │ [ Clear queue and stop run ]           Esc closes   │
        └─────────────────────────────────────────────────────┘
```

The rail sits **between the scroller and the field**, inside the composer's dock.

## Visual language for steering vs follow-up

Two mechanisms, both meaning-bearing, neither decorative and neither colour:

1. **A time-word gutter.** Every queued item carries exactly one word at its left edge, mono at `--fs-2xs`, in a fixed 4ch column so the two groups align: **`now`** for steering, **`then`** for follow-up.
2. **Order plus a ruled divider, read as a timeline.** Steering first (it happens first), a hairline rule labelled `After this run finishes`, then follow-ups. The left edge reinforces it: **solid** for `now` (inside this run), **dashed** for `then` (not yet begun).

Rationale: the words survive grayscale, `forced-colors` and a screen reader; order and the divider are two more independent carriers. `steer` and `follow up` remain the vocabulary in the hint and the docs, so the wire terminology is still findable.

**No ordinals.** Nothing can be reordered or removed, so a number would be decoration in the one place the brief asks for less.

## States

| State | Rail (in dock) | Sheet |
|---|---|---|
| Idle, no run | not rendered | — |
| Streaming, empty queue | not rendered | — |
| Streaming, 1 now + 1 then | two rows + `Show queue ›` | two groups, divider with its label |
| 8 queued | **the same two rows** + `+6 more` | 8 rows, internally scrollable, `max-height: min(420px, 50vh)` |
| Texts unknown after reconnect | `2 queued before this page loaded  Show queue ›` | the honest paragraph, plus the useful fact: clearing returns them to the composer, where they can be read |
| Partially known (1 of 3) | one real row + `+2 more` | one real row, then `2 more were queued before this page loaded` |
| Very long item | one line, ellipsis, `title` = full text | wraps, clamped at 8 lines with `Show all (N lines)` |
| Empty / whitespace item | `(empty message)` in italic `--dim` | same; still counted; never a zero-height row |
| Queue non-empty but not streaming | rendered whenever `total > 0` | same — a queue that is not draining must not be invisible |

## Work

1. `src/queue.ts` — pure: `queueRail(queue)` returning at most two rows, `queueSummary(queue)` for the sheet's opening sentence, `escalation({ sheetOpen, streaming })` returning `"close-sheet" | "clear-and-stop" | "noop"`.
2. `components/QueuedPrompts.tsx` — the grouped list. **No position of its own**, so it can be re-hosted.
3. `components/QueueRail.tsx` — the two bounded rows and the `Show queue ›` trigger.
4. `components/QueueSheet.tsx` — the popover; `Esc` closes it and returns focus to the trigger.
5. `components/Composer.tsx` — delete `mode-strip` and the `behavior` state; new placeholder and hint; render the rail between the scroller and the field.
6. `styles.css` — replace `.mode-strip` / `.mode-choice` / `.mode-option` / `.queue-strip` / `.queue-*`; add the rail, the sheet and the gutter.
7. Tests and `DESIGN.md` §4, §4.2, §9 focus order, §11 inventory.

## Two bugs found while planning, fixed as part of this

- **`.mode-option-on` sets `color: var(--accent-ink)` — a token that does not exist in `:root`.** The selected segment inherits `--text` on `#4c9aff`, about **2.4:1**, below AA. Deleting the strip removes the reference; the contrast test gains an assertion that no rule sets a colour to an undefined token.
- **`textsKnown` discards KNOWN text.** `queuedMessages` reports `textsKnown: false` unless *every* text is accounted for, and the caller then hides all of them. With one known message out of three, the known one is thrown away. The partial state above is the fix.

## Acceptance criteria

1. While streaming, the composer dock's height is **identical** for 1 and for 50 queued messages.
2. Queue rows never occupy more than two lines in the dock, whatever the count or the text length.
3. Every queued row states `now` or `then` in text; removing colour loses no information.
4. No per-item control exists anywhere in the queue, and the sheet says why.
5. Exactly one queue-mutating action, `Clear queue and stop run`, inside the sheet, never in the rail.
6. `textsKnown === false` never renders invented text; a partially-known queue renders the known rows and names the remainder.
7. `Esc` with the sheet open closes only the sheet; the run and the queue are untouched.
8. The three-line field floor and `auto-follow` in the chrome row are unchanged; the existing `layout.test.mjs` guards still pass.
9. Nothing sets a colour to a token that does not exist.

## Guards to write

- `queue.test.ts` — `queueRail(q).rows.length <= 2` for every count 0–50 and every group split; `queueSummary` pluralisation; `escalation` precedence.
- `invariants.test.ts` — **the dock never enumerates the queue**: only `QueuedPrompts.tsx` may contain `.steering.map` / `.followUp.map`. This kills the reflow class at its source rather than testing its symptom.
- `components.test.mjs` — no `×` / `Remove` in queue markup (retarget the existing test); streaming markup contains no `mode-strip`; the rail renders the same element count for 1 and for 8; the unknown state renders the count sentence and no rows; the partial state renders one row and the remainder sentence.
- `affordance.test.mjs` — every `.queue-when` is exactly `now` or `then`, is not `aria-hidden`, and the row height is fixed so it cannot drift with content.
- `contrast.test.mjs` — `--dim` on the sheet's surface ≥ 4.5:1; no undefined colour tokens.
- `layout.test.mjs` — the sheet is positioned against the dock and never covers the field.
- **Rewrite, do not delete**, the three mode-strip assertions — they encode a decision being replaced, so the replacement must be asserted: `Enter to steer` and `Alt+Enter` in the hint.

## Risks

- **Destination by keystroke only.** A pointer-only reader cannot choose steer vs follow-up. Accepted: this is a desktop product on `127.0.0.1` (DESIGN §2), and both keys are already Pi's own bindings. The fallback — a chip in the chrome row stating the next destination — is additive if that judgement proves wrong.
- **`DESIGN.md` §4 must be edited, not left contradicting the code.** This repository treats doc/code divergence as a bug.
