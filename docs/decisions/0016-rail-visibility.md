# ADR-0016 — The rail is a set of reader preferences, not a layout rule

- **Status:** Accepted
- **Date:** 2026-11-21
- **Opened by:** issue [#275]
- **Related:** ADR-0004 (a session is a file), ADR-0009 (discovery), the panel's collapse decision in issue #75 and
  `panel.ts`, the reading preferences of issue #134 and `reading.ts`

## Context

Pi Central's session rail has always been a **layout constant**: a 288px track in `.panes`, permanently beside the
transcript above 1024px and a summoned overlay below it. The rail *is* the fleet view, and that was the design.

A report from use at **twelve sessions** made the cost measurable in one screenshot: eleven rows of three lines each —
`Needs you`/`Failed` empty, `Running 2`, `Idle 9`, four scratch sessions — beside a transcript reading *"No messages
yet."* The complaint was *"it becomes distracting if you see it all the time"*.

Three costs are stacked into that one column, and they are separable:

| Cost | Measured where |
| --- | --- |
| **Presence** — 288px permanently reserved, never a reader choice | `styles.css`, the `.panes` track definition |
| **Row volume** — every roster entry rendered, all five sections expanded | `SessionRail.tsx`'s group list; `roster.ts` allows up to 200 entries |
| **Row weight** — a 120px gauge plus `ctx N%` on every row carrying a live session | the row's third line; the screenshot shows 0 %, 3 %, 0 %, 5 %, 25 %, 47 %, 28 % |

The third is the one the screenshot makes obvious and the issue only half-covers. After #89 removed `model · thinking ·
cost` from each row, what remains is a gauge and a number that is near-identical across rows. A column of gauges that
only matters when one of them is *nearly full* is not information, it is texture.

## Decision

**Rail visibility, width, density and which sections are folded are stored reader preferences** — the same shape
`panel.ts` established for the panel's width and collapse (issue #75) and `reading.ts` for the transcript's measure
(issue #134). The breakpoint survives only as a **floor**: below 1024px the drawer is the only shape that fits,
whatever the preference says.

Concretely:

1. **`rail-prefs.ts`** holds four preferences under one `localStorage` key: `width` (220–480, capped at 40 % of the
   window), `density` (`full` | `calm`), `hidden`, and `collapsed` for the two foldable sections. Every field is
   validated on read; a corrupt record degrades to the **open, full** default rather than to a folded one.
2. **The rail is resizable**, by drag and by keyboard, with the panel's resizer's three properties (a 7px hit area over
   a 1px gutter, `role="separator"` with a spoken value, commit on gesture end). The drag sign is the panel's mirror:
   positive delta *grows* the rail.
3. **`Idle` and `Stopped` may fold; `Needs you`, `Failed` and `Running` may not.** The type says so, and
   `isFolded` refuses a forged record as well. A session blocked on a dialog cannot progress without the reader, and a
   session that is spending money must never be hidden by a *layout choice*.
4. **A folded section opens itself when a row arrives in it**, once. This is how #68 is paid for — see below.
5. **`calm` density shows the metrics line only when it can change a decision**: a nearly-full context, queued work, or
   a failure. `full` is the default, so a reader who never opens Settings sees no change.
6. **The rail can be hidden above the breakpoint**, and the left activity bar's `☰` is the control that both hides and
   restores it — the rule `PanelToggle` records, applied to the other column.
7. **A large roster starts folded, once.** The one place the app chooses for the reader: above four rows on disk, and
   only when no preference is stored, `Idle` and `Stopped` start folded.

## Amendment — reading focus, and why the mode is not a second decision

The report behind #275 was about the rail. The screenshot that followed it asked a larger question, and the Llama UI
answered it: with the fleet list away, the **window** should be the conversation — a centred column, per-message actions
and one composer, no bands.

That is the same decision, one level up, so it is settled here rather than in a new record. The rail's presence and the
window's chrome are one preference family — "how much of this screen is the fleet and how much is the
conversation" — and separating them into two ADRs would invite two answers to one question.

**`focus` is a stored boolean, off by default.** On, and the surfaces that DESCRIBE the fleet or the session step
aside: the topbar keeps its mark and the connection dot and loses the fleet counts; the activity bars narrow from 48px
to 36px; the session header's 340px companion leaves the reading row, so the prose gets its width; the composer's
permanent hint line folds away, with the same two facts stated on the field's own `title`. The key is `⌘⇧.` — the Shift
is the point, because `⌘.` stops the run.

Four boundaries define the mode, and each is a test in `focus-mode.test.mjs` rather than a style choice:

1. **Chrome only.** Nothing that IS the conversation is governed by the mode. No rule here touches the lane, the
   measure, the scroller or the composer's field — a mode that narrowed the column in the mode named after it would be
   the opposite of its purpose.
2. **Not a trap.** What is hidden must exist elsewhere. The session's identity, model, thinking level, meter, cost and
   controls are all stated in the Session panel, which the mode does not touch; the activity bars narrow rather than
   disappear, because they are the way back to everything.
3. **Nothing consequential goes.** Warnings, dialog docks, the queue rail and the error strip stay. They are decisions,
   not descriptions — the same line the rail's foldable sections follow (`Needs you` and `Running` do not fold).
4. **Stated once, not dropped.** The keys the hint row carried move to the field's `title`, in the same words. Trading a
   line of chrome for a piece of discoverability is not a trade worth making.

## Amendment 2 — the details peek, and why the conversation's width is not negotiable

The screenshot that followed the first amendment showed the session's details still holding a 340px column beside the
conversation, in the one mode whose purpose is to give that width back — and the report was two-fold: *"we see the current
transactions detail panel, when the conversation has the window. First, i dont know what this means. Maybe for the reader
mode, we can show the details when hovering a minimal version of the detail panel, and have an option to pin it open
manually"*.

So reading focus frames the SAME details content differently:

1. **Resting, it is a tab.** ~28px on the conversation's trailing edge, carrying the word "Details", the session's state
   and its context percentage. The proportions matter: what the report needed was not a smaller panel but a **name**, and
   "idle · ctx 37%" is both the name and the one number that changes a decision. A generic mark would have left the reader
   exactly where they were.
2. **Open, it is an OVERLAY.** Hover, focus, or pin reveals it over the trailing edge. An overlay and not a track,
   because a track that widened on hover would reflow every line of prose under the cursor — the failure `roster.ts`
   already records for row order, one level up.
3. **Pinning is a remembered state** (`peekPinned`), and Escape unpins. A reader comparing a model against a transcript
   needs the details present without holding the pointer still, and a hover-only surface is unusable by keyboard and
   touch — so the tab is a `<button>` with `aria-expanded`, it opens on focus, and the same key that dismisses a dialog
   dismisses it.

**One content element, two frames.** The transcript receives the details as *content* and chooses the frame from
`focusMode`; the shell owns the preference. That is deliberate: the alternative — two renderings — is how a fact arrives
in the column and not the tab. `session-peek.test.mjs` asserts that the identical node is rendered in exactly two
branches and never both.

**The hazard an overlay introduces, stated because it is the one thing an overlay must get right:** a closed 340px panel
sits over the prose, and a box that swallows clicks there reads as "the app is broken", not as a layout bug. The rail and
the panel are `pointer-events: none` until the tab arms them, and `inert` in the markup agrees with the CSS.

**Deliberately not in this amendment:** frame-less windows, hiding the product mark, a separate composer layout, or moving
the model pickers INTO the composer. Each is defensible and none is required by "the conversation has the window" — and a
mode that ships small enough to press twice is worth more than one that argues about its own edges.

## What #68 still means, and how folding pays for it

The settled decision is quoted verbatim in the code: *"i now see directly when sth has finished without scrolling"*.
Any option that hides `Stopped` has to argue with that sentence rather than ignore it.

The sentence is about **being told**, not about seeing every finished row. Three properties keep it while a section is
folded, and each one is load-bearing:

1. **The heading carries the count**, and a state-coloured mark says what kind of rows are behind it.
2. **A section that changes opens itself.** A session finishing while `Stopped` is folded is *precisely* the event the
   decision was about, so the fold yields for it — and it is an arrival, compared over row keys, not a count: one
   session finishing while another is dismissed keeps the count identical.
3. **A fold is a reader choice, remembered.** Nothing folds on its own after the first render, so the rail never moves
   while it is being aimed at.

## Alternatives considered

| Option | Why rejected |
| --- | --- |
| **A. Keep the rail, collapse its sections** (chosen, with D) | The smallest change that addresses the measured cost, and it does not move anything. It was rejected *alone* because the screenshot's rows also carry a metrics line that says nothing — see D. |
| **B. A drawer at every width** | Falsifiable and probably false: twelve open sessions is *monitoring*, not driving one. A drawer makes the primary job a click and puts Stop and the bulk-select behind a summon. Adopted **as an option** (`hidden`), never as the default. |
| **C. A thin always-on attention strip plus the full rail** | Two list surfaces that must agree about which sessions need attention, which is the defect `DESIGN.md` §6 records for history-in-the-rail ("two orderings in one scrolling column cannot both be legible"). A collapsed heading with a count already gives the same fact in ~24px. |
| **D. Density modes** (chosen, with A) | Adopted as a preference, but the issue's version — "drop the third line" — was not: the third line is what *changes the decision about this row*. The rule chosen instead is "show it when it can change a decision", which keeps every reason to act and drops the ones where the answer is "nothing to do here". |
| **E. Auto-quiet** — the rail dims or collapses when nothing needs attention | A layout that moves on its own is the failure `roster.ts` already rejected for row ordering (*"a row that jumps while you aim at it is the original complaint"*), and a column appearing or collapsing under the cursor is the same defect one level up. |

## Consequences

**Positive**

- One number, one preference store, one module — the shape the panel and the transcript already have, so a reader who
  has learned one of these surfaces has learned all three.
- The transcript can gain width by a reader's choice, which is the only option in the issue that adds reading room
  rather than re-arranging what competes for it.
- A twelve-session roster can cost ~5 lines of chrome instead of ~33, without hiding a session that is running, failed,
  waiting, or newly finished.
- The metrics line improves for **every** reader, not only those who find the density control: at 3 % context it is
  noise whether or not you opened Settings.

**Negative**

- **Four preferences is more surface than one decision.** Mitigated by defaults that reproduce the shipped app exactly,
  a "Reset to defaults" control beside them, and the transcript's own precedent that a preference is the honest answer
  when there is no single right number.
- **The roster-size default is a guess.** Four rows is a measurement from one report, not a distribution. It is applied
  once, never to a reader who has chosen, and it is stated in `initialRailPrefs` rather than buried.
- **Folding `Stopped` is a real trade.** If a reader with a folded `Stopped` cannot tell that a session finished
  without expanding it, the default must revert to open — stated as the falsification below.
- **A second resizer is a second place for a drag sign to be wrong.** Mitigated by the arithmetic living in
  `rail-prefs.ts`, tested directly, because the component tests run no pointer events.

## What would prove this wrong

- **Folding:** a screenshot or recording in which a reader with `Stopped` folded does not notice a session finishing.
  Then #68 was traded away and the default must go back to open.
- **Calm density:** a reader missing a context that is about to compact. Then the metrics line was load-bearing and the
  conditional version is the trap the issue warned about.
- **The drawer:** a reader whose normal mode turns out to be monitoring several sessions, for whom the default now costs
  a click a session. Then `hidden` must stay off by default *and* the width preference must be emphasised instead.
- **The resizer:** a drag that moves the column in the wrong direction, or a half-placed rail after a window resize. Both
  are asserted in `rail-prefs.test.ts` and `rail-layout.test.mjs`; a real failure there means the arithmetic, not the
  decision.

[#275]: https://github.com/sven1103-agent/pi-central/issues/275
