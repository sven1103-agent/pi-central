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
permanent hint line folds away, with the same two facts stated on the field's own `title`. The keys are `⌘⇧.` — where
the Shift is the point, because `⌘.` stops the run — and `⌥⇧Z` beside it (amendment 5).

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

## Amendment 3 — `hidden` is a two-state column, and the label is the second half of an icon

Two reports from use, one cause each.

**"Why is the roster rendered as a modal?"** It was, and the modal was the *return path*. The overlay was gated on
`railSummonable = railIsDrawer || railPrefs.hidden`, and `railDocked` was `!railSummonable` — so above the breakpoint a
hidden rail had exactly one way back: the overlay. `☰` could hide the column and could not restore it; Settings’ checkbox
was the only route to the column again, which made the panel’s own copy (“Hidden — open it from ☰ in the left bar”)
untrue.

The two facts were folded together because they are the same shape *below* the breakpoint and only by accident: there
the window genuinely cannot fit a column, so the drawer is the only form the list can take. Above it the column fits, and
the reader’s choice is simply whether it is there. So they are separated:

| Value | Condition | Meaning |
| --- | --- | --- |
| `railDocked` | sessions page, `!railIsDrawer`, `!hidden` | the column, which is what the preference switches |
| `railOverlay` | sessions page, `railIsDrawer`, `railOpen` | the drawer, which is what the window forces |

`☰` therefore has two rungs, split by width: below the breakpoint it opens and closes the drawer; above it, one toggle of
one preference, so the column comes back **as a column**. The backdrop and the dim layer follow `railOverlay`, so above the
breakpoint there is nothing dim to dismiss — which is the whole of “not a modal”.

**"Users don’t remember what the icons mean. Icons + label brings the better UX."** True, and the bar’s own design note
said why that was accepted: a 48px bar of two-word labels is a sidebar, the surface the bar exists to avoid being.

The resolution is that a label costs nothing at rest and something while it is being read. Each item carries its word in
the DOM always, revealed on hover **and `:focus-visible`** — the keyboard reader tabbing the bar is exactly the reader who
cannot guess a glyph, and the OS tooltip they would fall back on is pointer-only. The reveal is a transformed
absolutely-positioned box, never a width: animating `width` moves the glyph it belongs to and reflows the bar, which is
the failure the details peek recorded for a track that widened under the pointer. The bar stays 48px, the transcript stays
where it was, and nothing appears over the conversation.

That keeps the calm rule intact — a surface that appears under the pointer and must then be dismissed is what that rule
forbids; a label inside a control the reader is already pointing at is not a new surface. A **hover-revealed roster** was
offered and rejected for the same reason: it would appear where the pointer already is, must stay once the pointer moves
onto it, and so is a pin with extra failure modes plus 288px of transcript covered.

## Amendment 4 — a destination is not a toggle, and the mark that says so is the rule

Reported from use: *"the navigation hierarchy is broken. The session icon becomes the target of the navigation steps:
when navigating back from e.g. history or settings, users need to click it to see the transcript (which is the actual
navigation target). But it is also the target to toggle the sidebar session roster."*

That was exact, and it was structural rather than cosmetic. The `Sessions` item did both jobs in one handler:

```ts
if (tab !== "sessions") setTab("sessions");
if (railIsDrawer) { setRailOpen(!railOpen); return; }
setRailPrefsAndPersist((current) => ({ ...current, hidden: !current.hidden }));
```

So one press from History meant two things, and the second depended on state the reader could not see — the rail's
visibility below a breakpoint they were not looking at. The bar's own promise is the thing that was broken: the left
bar chooses a PAGE, the right bar offers views of the OPEN CONTEXT (`ActivityBar` says so in its own header). A destination
that also rearranges the layout it navigates to is not a destination.

The amendment is a rule and a placement:

1. **A page item changes only the page.** `Sessions` is idempotent — from anywhere it lands on the same picture,
   whatever the roster is doing. The same holds for `History`.
2. **A control of a REGION is not in the page group.** The roster toggle lives in `ActivityBar`'s `header` slot: above
   the pages and behind `.navrail-rule`. That slot already existed for exactly this — the right bar's panel toggle sits
   in it, with a note explaining that it is "a different KIND of control from the items below: those select a view,
   this shows or hides the region the views live in". The left bar had no such control until the roster needed one;
   now both bars say the same thing the same way.
3. **Structure is not enough if the two look alike.** Two identical 40px squares in a 48px column read as one family
   however far apart they are, so the header's controls are drawn in `--dim` without the page family's hover tint. The
   separation the rule states in SPACE, the weight states visually.
4. **The marks are now distinct.** `☰` belongs to the roster toggle, where "a list" is what it means, and `Sessions`
   takes `◪` (U+25EA) as the session's own mark. `components.test.mjs` already refused one glyph for two destinations;
   it now also refuses one glyph in two bars.

What was NOT changed: the toggle's ladder. Below the breakpoint it opens and closes the drawer, above it toggles
`hidden`, so the thing that hides the list is still the thing that brings it back (amendment 3). Splitting the
hierarchy moved the control; it did not change what the control does.

### Correction, the same day — the toggle acts on the PAGE, not on the preference

Splitting the two jobs (above) left the toggle sizing itself on `railPrefs.hidden`. Reported immediately: *"the toggle
for the roster becomes a noop when in history"*. It was worse than a no-op.
The roster is the **Sessions page's list**, so `railShown` is false on History whatever the preference says. A reader on
History pressed "Show the session list", `hidden` flipped, and nothing on screen changed — a preference moved invisibly,
and pressing it again moved it back. Two presses, no feedback, no way to tell it had done anything at all.

The switch is now `railShown`, which is the thing the button's own label is about, and the width chooses only the
**mechanism** inside each rung:

| Rung | Above the breakpoint | Below it |
| --- | --- | --- |
| **hide** (`railShown`) | `hidden: true`, the column goes | `railOpen = false`, the drawer closes |
| **show** | the page that has the list, then `hidden: false` | the page, then `railOpen = true` |

Showing it from another page therefore goes to that page. That is not the defect amendment 4 fixed: that was a
**destination** with a hidden side effect on the layout, so one press meant two things. This is a **toggle whose one
visible effect is the thing it names** — the reader presses "show the session list" and sees the session list, which is
the whole of what the label promised. The distinction is worth stating because "a control changed the page" is not
automatically wrong: it is wrong when the control did not say so.

Both rungs also STATE the state they want (`hidden: true` / `hidden: false`) rather than flipping it. A flip is what made
the no-op invisible — it was a change with no reference to what was on screen, so it had nothing to be wrong about.

## Amendment 5 — the mode has a popular name, and a chord that needs `code`

Two things arrived together, and the second is a defect rather than a preference.

**The name.** *"Many apps call it Zen Mode"* — so the mode is offered as **Zen mode (reading focus)**: the reader's word
first, the app's own after. Two names for one thing is worse than either name alone, and the surface a reader meets
(Settings, and the shortcut sheet) states both.

**The chord.** `⌥⇧Z` joins `⌘⇧.`, and neither replaces the other. `⌘⇧.` stays because it is the pair with `⌘.`, which
**stops a run** — removing it would send every reader who learned it next to the most consequential keystroke in the app,
and the Shift is the whole of what keeps those two apart. `keys` has always been a list; the sheet already renders
alternatives with the word *or* between them.

### The defect the chord exposed

`alt+shift+z` **could not fire on macOS**, and would have shipped as a documented, listed, dead key — the same class of
failure this registry already records for `⌘/` on a German layout.

Option is a **dead key for letters** on macOS: `⌥Z` reports `key: "Ω"` on a US layout, `⌥⇧Z` reports `"¸"`, and other
layouts report other things. So `chordOf` composed `alt+shift+¸`, no binding matched it, and the mode stayed
pointer-only. Nothing about the key choice was wrong; the chord *reader* was.

**The fix is a `code` fallback, scoped to Option, and it has to run FIRST.** `code` is the physical key — `KeyZ` — and
it is the same on every layout and under every dead-key substitution:

```ts
const fromCode = alt && !mod ? letterFromCode(event.code) : undefined;
```

### The first attempt was still dead, because of guard ORDER

Shipped, and reported as plainly as a defect can be: *"no shortcut toggled zen mode"*.

Option+letter does not produce one shape, it produces three, and the fallback had been placed after two guards that
rejected two of them before `code` was ever read:

| What macOS reports | Why it was rejected | |
| --- | --- | --- |
| `key: "Dead"` — the composed character is itself a dead key (`¸`, cedilla) | `"dead"` is in `MODIFIER_KEYS` | ← what `⌥⇧Z` actually sends |
| `key: ""` | `"".length === 0` fails the empty-key check | |
| `key: "¸"`, `"Ω"` — the composed character | nothing; the fallback caught it | |
| `key: "z"` | nothing; the fallback caught it | |

The test passed because **it only exercised the third and fourth shapes**. That is the lesson worth keeping: a
platform-behaviour test must enumerate the shapes the platform is documented to produce, not the one the developer saw.
The `code` lookup now runs before any judgement about `key`, and `MODIFIER_KEYS` is consulted only when `code` did not
answer — so holding Option on its own is still not a chord.
### And still dead, because `code` is a POSITION, not a letter

Second report on the same key: *"it still does not work"*. It was right on a US keyboard and still dead on the
reader's, because `code` names a physical position — `KeyZ` is *the key in the Z position of a US keyboard* — and this
repository already has two other reports from German QWERTZ layouts, where the key **labelled** `Z` reports
`code: "KeyY"`:

| Pressed | `code` | Composed before the fix | Result |
| --- | --- | --- | --- |
| the key labelled Z (QWERTZ) | `KeyY` | `alt+shift+y` | no binding, nothing happens |
| the key labelled Q (AZERTY) | `KeyA` | `alt+q` on AZERTY | `⌥Q` was dead there too |

So the physical key is now read **through the reader's own layout**. `navigator.keyboard.getLayoutMap()` is the
browser's answer to "what does this key type on this machine", read once at start (`setKeyLayout`, from `App.tsx`) so no
keystroke pays for it. Without the Keyboard API the US arrangement stands — the behaviour every reader with letters in
those positions already had. Entries that are not a single letter are dropped, because this map turns physical keys back
into letters and `"ShiftLeft" → "Shift"` must not become the letter "s".

The lesson, now stated twice in this record because it bit twice: **a chord that reads a physical key must be tested on a
layout that is not the one it was written on.** The first fix was verified against four event SHAPES and still failed,
because every shape was collected on one ARRANGEMENT.
### And a third time, because the layout could not be ASKED for

Third report, and the one that named the requirement: *"ah, with Y it works. So on a QWERTZ layout, it wont work!"*

That observation is a precise diagnosis. On QWERTZ the key **labelled Z** sits in the US position of Y, so it reports
`code: "KeyY"`; the key **labelled Y** sits where the US has Z. Reading the physical key as US letters therefore made the
key labelled *Y* toggle the mode — which is exactly what the reader saw. The layout map would have fixed it, and did not:
`navigator.keyboard.getLayoutMap()` is **CDP-gated in Electron**, so `setKeyLayout` never ran and the US letter was used.

The mistake worth naming is that the previous two fixes each made the chord depend on something that could be absent —
a particular `key` string, then a particular browser API. A binding that works only when a probe succeeds is a binding
that fails on the machines that cannot answer.

**So the physical key now yields CANDIDATES, and the binding decides.** `chordsOf(event)` returns every chord the
keystroke could mean; `resolveShortcut` and `matchesChord` try each in order and the first match wins. Two letters can sit
at one physical position, and offering both is enough — nothing has to be known about the machine.

| Source of the candidate | When |
| --- | --- |
| The letter the reader's layout puts there | whenever a map is available (`getLayoutMap`) |
| The US letter at that position | always |
| The swapped letter for the known QWERTZ/AZERTY pairs | when no map is available |

The third row is the part that makes this work without the API. Only the positions real layouts actually **swap** are
tabulated — QWERTZ Z/Y, AZERTY Q/A — because those are the arrangements where a letter sits at another letter's US
position, which is the one situation the candidate list exists to survive. Ordering keeps the reader's own letter first,
so a future `⌥⇧Y` binding would win on the key labelled Y rather than being shadowed by the US spelling.

Both keys now toggle the mode on QWERTZ, and that is deliberate rather than sloppy: they are the two keys a reader could
reasonably press for "Z", nothing else is bound to `alt+shift+y`, and refusing one of them is what produced all three
reports. The falsification to watch is a second binding on a swapped pair — then the ordering, not the candidate list,
has to carry the meaning.



Three boundaries, and each is a test:

| Boundary | Why |
| --- | --- |
| **Only with `⌥`** | `⌘` chords must follow the LAYOUT. On QWERTZ, `⌘Z` produces `key: "y"`, and a reader there means the key labelled Z — reading `code` would bind the wrong physical key. |
| **Only letters** | Digits and punctuation are where a layout's arrangement genuinely differs (`Digit1` prints `1` on QWERTY and `&` on AZERTY). This survives dead-key substitution; it does not overrule a layout. |
| **Produced key wins elsewhere** | With no Option, or with `⌘`, the character the reader sees is what they pressed. |

### The same defect, already shipped

`⌥Q` — *"Show what is queued"* — was declared in the registry **and** implemented separately in `Composer.tsx` as
`event.altKey && event.key === "q"`. Two copies of one fact, and the copy in the component was the dead one: the sheet
listed a key that had never worked on macOS. It now uses `matchesChord` against a `QUEUE_CHORD` read from the registry,
which is the rule this file states in its own header — handlers switch on ids, never on keys.

What would prove this wrong: a reader on a US or DE layout who presses `⌥⇧Z` and gets nothing, or one on QWERTZ who finds
`⌘Z` acting on the wrong key. The first means the fallback is too narrow; the second means it is too wide.

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
- **The two-rung ladder (amendment 3):** a reader above the breakpoint who cannot find the list again after pressing `☰`.
  Then the column's return is not discoverable, and it needs a second visible control rather than a remembered toggle.
- **The toggle's rungs (amendment 4):** a reader on another page who expected the toggle to leave the page alone, or
  one who cannot tell whether the list is hidden or merely on another page. The second means `hidden` and "this page has
  no list" need different words in the tooltip, not a different handler.
- **The split (amendment 4):** a reader who presses `Sessions` expecting the roster to come back, or who
  presses the roster toggle expecting to change page. Either means the two controls are still one concept to the reader,
  and the words — not the placement — are what has to change next.
- **The hover label (amendment 3):** a reader who still asks what an icon means, or a label mistaken for a tooltip that
  failed to appear. Then the words belong in the bar permanently, and the 48px width is the thing to revisit.

[#275]: https://github.com/sven1103-agent/pi-central/issues/275
