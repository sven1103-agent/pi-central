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
