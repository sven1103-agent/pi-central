# ADR-0017 — A followed transcript keeps its newest line above the window's foot, and glides rather than teleporting

- **Status:** Accepted. The anchor and the follow scroll are implemented. The coalescing in (b) is a separate
  slice and is not — `affectsTranscript` still has no caller. The paced reveal is demoted in the decision, not
  deferred.
- **Date:** 2026-11-22
- **Amends:** [ADR-0006](0006-untrusted-markdown-rendering.md) in nothing; cites it. Amends the reading
  preferences of #134 by adding a third setting, and holds #92's revert intact.
- **Opened by:** a reader who follows a live run — [#279]

## Context

Two complaints, one verdict, and the verdict is the requirement:

> The transcripts text is produced very harsh. Token per token, line by line, no smoothing animation. This
> becomes very tiring for users that actively follow the sessions output.
>
> Pi Central treats end of the transcript in the bottom of the window… for following, it is too far down.
> Users' displays are usually adjusted that the eyes are leveled on the middle of the screen.
>
> **The verdict is: the transcript generation must be calm for users' eyes to read and follow.**

Read as two mechanisms, and only one of them is about motion:

1. **Where the tail sits.** Today the newest line is pinned to the scroller's bottom edge
   (`.transcript` is a column scroller, the lane is only as tall as its content). The only thing reserved
   below the text is `--jump-strip`, for the pill.
2. **How text arrives.** Every `message_update` is a state update, so the text grows by exactly the delta
   carried — one commit per delta Pi emits, at whatever rate Pi emits it.

Both are policy with a reversal risk, which is why this is a record and not a slice. #92 tried to fix "the
transcript looks lost" by centring the column and produced five defects before it was reverted; #86 tried to
smooth the scroll and broke following. The readings below are what keeps this record out of that family.

### What is true today, verified rather than assumed

**Nothing coalesces, throttles or paces anything.** `grep -n 'requestAnimationFrame|throttle|debounce|startTransition'`
over `packages/ui/src` returns three hits, all unrelated (a composer caret placement and two comments
about the socket). The one `requestAnimationFrame` in the composer moves a caret.

**Each delta costs a full re-parse, so a message is parsed hundreds of times.** `Prose` memoizes on the
text, and streaming changes the text, so `Prose` calls `renderMarkdown` on the WHOLE accumulated message
once per delta.

**The saving is real, but it is NOT "an order of magnitude" — and that claim came from a misleading sample.**
Measured at sizes held EXACTLY fixed, on markdown-dense prose built to length, so a row means the same thing
on any machine and on every run:

| message length | parses today | parses per frame | ratio, across three runs |
|---|---|---|---|
| 800 chars | 198 | 60 | **3.2 – 4.6×** |
| 1500 chars | 372 | 60 | **6.3 – 6.6×** |
| 2000 chars | 498 | 60 | **7.7 – 8.1×** |
| 3000 chars | 748 | 60 | **11.5 – 12.9×** |

The parse counts are exact — `N/4` deltas, 60 frames — and the ratio's spread is the timing noise, which
narrows as the message grows because the denominator does. **Nothing else scales, so the ratio is a function
of length:** per-delta cost is `N²/8` character-parses while per-frame cost is fixed at 60, so the gain grows
with `N` — roughly fourfold at 800 characters and twelvefold at 3000. A single "order of magnitude" figure was
therefore wrong for most messages, and quoting it from a 2669-character sample was quoting a best case as if
it were the typical one.

**And the typical message is short.** Across ~1300 assistant text blocks in 91 real sessions, excluding the
session that ran the measurement:

| message length | share of messages | share of total parse work |
|---|---|---|
| under 200 chars | **78%** | 0.4% |
| 200–600 | 6% | 0.2% |
| 600–1500 | 1% | 0.7% |
| 1500–2500 | 6% | 11.5% |
| 2500–4000 | 6% | 27% |
| 4000+ | 3% | **60%** |

That table has now been computed on four separate runs of the script and moved by less than a percentage
point per band, so it is the most stable number in this record. The median assistant message is ~110
characters and 78% are under 200. Below ~200 characters the coalescer saves almost nothing — there are only
~50 deltas to fold into ~30 frames, and the work is already small. **Roughly 88% of all parse work sits in
the 9% of messages over 2500 characters.**

That shape is the strongest argument FOR the coalescer rather than against it: the cost is concentrated in
exactly the long answers a reader is most likely to be following, and a message that takes ten seconds to
stream is the one where a stutter is unbearable. It is not an argument that every message gets ten times
faster.

Those timings are jsdom + DOMPurify in Node, not a browser, so the **absolute** milliseconds are not a
browser measurement and are not claimed as one. The table above is the only set of timings quoted, because
it is the only one whose rows are reproducible: the corpus-sampled timings it replaces moved between 3.3× and
13.6× for the *same row* on different runs, since the message being sampled changed with the sample.

**Four earlier drafts of this section were wrong, in ways worth recording.** The first sampled "the first
matching message in the newest 150 sessions" — which is the session running the command, so the "prose
message" was a previous reply written by this very conversation, and its length changed every time the
script was discussed. The second fixed that but kept the "order of magnitude" claim, which the 800-character
row shows is false for the median message. The third replaced the rows with fixed sizes but claimed they were
"held fixed by construction" while two were still sampled from the corpus and still drifted between runs. The
fourth claimed a `3.2×` at 800 characters from a single run, where three runs give `3.2–4.6×` — the smallest
denominator is the least stable, which is the same lesson as the `N/8` rows below.
All four are recorded rather than quietly renumbered, because a measurement revised five times is more
informative with the history than without it.

**Why the total is quadratic in message length, stated correctly.** An earlier draft of this record said the
cost *per parse* was superlinear, on the strength of two one-shot timings (0.46 ms at 300 chars, 1.44 ms at
2989). That was noise, and measuring it properly inverted the claim: batched across 40 distinct documents per
size, per-parse cost grows **7.1× while the text grows 16×** — it is *sub*linear, about 0.45× per character,
which is what a parser with fixed per-call overhead should do.

The quadratic total has a different cause, and it is exact rather than approximate: **the number of parses
grows with the message.** A 4-character stride performs `N/4` parses whose average input is `N/2`
characters, so the characters processed are about `N²/8` against `N` for a single final parse — a ratio of
`N/8`. Measured against one final parse of the same text, **both sizes straddle the prediction badly enough that
neither confirms it**: six repeats at 3000 characters gave 378–404× on one run and 167–482× on another, against
a predicted 375; at 1500 characters they gave 178–245× against a predicted 188. The prediction is the right
*order*, and the arithmetic is exact — but the measurement cannot distinguish a ratio of 375 from a ratio of 170
without far more repetitions than this needs, because the denominator (one parse, hundreds of microseconds) is
dominated by JIT and GC jitter. It ranged from 0.87 ms to 16.8 ms across runs at the small size.

So the `N/8` figure is presented as arithmetic that the timings are *consistent with*, not as something they
prove. The claim the decision rests on does not need them: the number of parses per message grows with the
message, and a coalescer removes that growth. The script now labels an unstable denominator itself rather than
leaving a reader to notice — this paragraph exists because its own output did exactly that on the next run.

So the defect is not that parsing is slow, it is that **the same text is parsed hundreds of times**, and it
gets worse the longer the answer runs.

One consequence worth naming: this is also why `CACHE_MAX_SOURCE` is 20 000 characters in `markdown.ts`.
Above that a message is not cached at all — the streaming text would churn the cache — so a very long
message pays the full quadratic cost with no help from the cache in either direction.

**Revealing N source characters shows markdown as literal punctuation, and the rate is not marginal.** For
every 2nd prefix of a real message, graded on the *rendered text* (what the reader sees, not on the markup),
counting a prefix as literal when the reader is shown a `**`, an unclosed backtick, or a bare `]`:

| message | rate per message, fastest to slowest | median | range |
|---|---|---|---|
| prose with `**` | 5, 11, 12, 12, 13, 16, 17, 21, 24, 32, 36, 40 % | **17%** | 5–40% |
| with fences | 3, 9, 13, 13, 14, 14, 15, 15, 16, 16, 28, 32 % | **15%** | 3–32% |
| with tables | 12, 12, 13, 18 % (tables are the rarer shape) | **13%** | — |

The per-message rates are listed rather than summarised because the sample size is not fixed — it is whatever
this machine's newest 150 sessions hold, and it grew from three table messages to four between two runs of the
script. A median over a moving sample is a band, not a constant.

**These are rates across a sample, not one message's figure, and the distinction is the point.** An earlier
draft of this record cited exact percentages from a single message each (16%, 14%, 16%, and a 19% from a
per-character pass), which reads as a measurement of the phenomenon and is a measurement of three arbitrary
messages — it also does not reproduce, because the sample is "the newest 150 sessions" and that set changes
as sessions are created. The band does not: **every qualifying message tested shows literal syntax at some
prefix, the first occurrence between character 58 and character 266, and the spread is 5–40%** with a median
near a sixth. That survives the sample moving, and it is what the decision needs: on no message tested is the
naive reveal clean, and on some it is wrong for two reveal positions in five.

The first occurrences also move with the sample (char 38 to char 266 across runs), which is why they are
given as a range. Three block-signature counts were single-message figures and are stated as such — they
establish that restructuring happens, not how often it happens.

The one-line demonstration is in [`scripts/verify-calm-transcript.mjs`](../../scripts/verify-calm-transcript.mjs),
which reproduces both halves of this section on real sessions: `The **root ` renders as
`<p>The **root</p>`, so the reader watches punctuation appear and then be eaten.

**Blocks also restructure, counted by block signature.** The sequence of block-level tags changes 12 times
for one prose message (13 distinct signatures), 15 times for a message with fences (16 signatures), and 4
times for a table (5). Two specific flips, measured on minimal inputs:

- `p` → `p>pre` at the **opening** fence. The code block appears empty and then the code grows inside it.
- `p` → `p>table` at the **delimiter row**. The pipe-delimited rows are visible as a paragraph of literal
  `| a | b |` text, and then become a table.

**One claim in the issue does not reproduce, and it matters.** [#279] states that "an unclosed fence flips a
paragraph into a code block and the layout jumps". It cannot, in stream order: the closing fence is emitted
*before* any prose that follows the block, so a prefix can never contain post-block prose and lack the
closing fence. Measured directly — splicing a message so a prefix holds post-block prose without its closing
fence renders `<pre>`, and that prefix is **unreachable** by truncation. The real, reachable flips are the
two above (a block appearing or changing kind), and the literal-syntax census. This is corrected here rather
than inherited, because the wrong example points at a failure mode that source-slicing does not produce, and
the right ones are worse and more common.

### The constraints that bear on it

1. **`prefers-reduced-motion: reduce` is already honoured in three places** in `packages/ui/src/styles.css`.
   A reveal animation that ignores it is a regression, not a comfort.
2. **Follow semantics are load-bearing and hard-won.** `FOLLOW_THRESHOLD_PX = 80` measures distance from the
   scroller's **bottom**; `readerDistanceFromTail` discounts content growth because a scroll event arrives
   after the paint; `shouldFollow` refuses to move a reader who scrolled up (#86); `decideOnSessionChange`
   re-arms following only for a session the reader was following (#141).
3. **One streaming block is cheap to re-render; the whole transcript is not.** `Turn` is memoised with a
   hand-written comparison (#151), and the `ResizeObserver` on the lane exists because height arrives after
   paint. Per-frame work must stay inside the streaming turn.
4. **The settled text must equal the streamed text.** Deltas are followed by an authoritative replace on
   `text_end` and `message_end`. Anything that shows text slower than it is received will visibly fight
   that replace unless it flushes on it.
5. **`rAF` does not fire in a hidden or backgrounded window.** This app *does* receive events while hidden.
   Anything that paces on the frame loop needs a non-frame fallback or it freezes mid-sentence.
6. **C20** — a CSS rule is correct for the number of children it has, and silently wrong at N+1. The
   transcript has already been bitten; `.transcript-lane > .turn-user:first-child` and
   `.prose > :first-child/:last-child` are live child-count rules in the two elements an anchor would touch.

## Decision

**Two changes, and they are independent: the anchor is space inside the content, and the pacing is one
commit per frame with no animation.**

### (a) The anchor is padding on the lane, and it is a preference with a new default

1. **The newest line is held above the scroller's foot by padding on `.transcript-lane`**, sized from a new
   reading preference. Content stays top-aligned; nothing moves except how much room follows the tail.
2. **Padding, not a spacer element.** C20 is why: a spacer is a new child of the lane, and
   `.transcript-lane > .turn-user:first-child` and the lane's own layout then become correct-for-N. Padding
   adds height without changing what any child-count rule counts.
3. **The spacer must not stack with `--jump-strip`.** `--jump-strip` is reserved on
   `.transcript-viewport`, outside the scroller, for the pill. The anchor is inside the scroller, for the
   text. Two reservations, two different jobs, and the arithmetic must be stated so neither is rediscovered.
4. **The end sentinel stays the LAST child of the scroller.** Both follow paths are "go to maximum scroll" —
   `endRef.scrollIntoView({block:"end"})` and `container.scrollTop = container.scrollHeight` — and both
   respect the padding only because the padding is part of the content above the sentinel. A sentinel moved
   after the spacer would anchor to the spacer's end and reproduce the complaint exactly.
5. **`FOLLOW_THRESHOLD_PX` does not change, and neither does what "following" means.** The threshold
   measures the distance from the scroller's bottom, which the padding does not redefine: at maximum scroll
   that distance is 0, growth is discounted as it already is, and a reader who scrolls up is honoured as they
   already are. There is no dead band to cross — scrolling up shortens the space under the last line rather
   than traversing it.
6. **The setting is `tail`, in `pi-central.reading`, beside size and measure, with two values:
   `"middle"` (default) and `"foot"`.** `"foot"` is exactly today's behaviour, so the change is
   reversible by the reader without a build. It is exposed the way the other two are: `readingStyle`
   returns the custom property, so the mapping stays a pure function tested without a DOM, and the panel
   writes it through the same one writer.
7. **`"top"` is deliberately not offered.** It would double the space under the tail for a complaint nobody
   made, and a three-value control whose extreme is the one that reads as a rendering bug invites exactly the
   report this record exists to prevent.
8. **`min(35vh, 24rem)` is a starting constant, not a settled number, and this record does not claim it.**
   It was not measured, because the capture it needs could not be taken here — see
   [What could not be measured](#what-could-not-be-measured). The mechanism and the default *disposition* are
   the decision; the number is tuned from one screenshot at the reporter's window size, and the falsifier for
   getting it wrong is stated below.

### (b) Text arrives once per animation frame, with no reveal animation

1. **Rendered transcript records are coalesced between the socket and the reducer.** A batch carries several
   records and is folded through `applyRecord` in order, in **one** transition, so there is one re-render
   per frame instead of one per delta. `affectsTranscript` in `store.ts` — the predicate that already
   names which records carry transcript content, and currently has no caller — becomes the buffer's test.
2. **Only transcript records are ever buffered.** A `snapshot`, a `session` upsert, a `transcript`
   replacement, a control's answer — each flushes the buffer **first** and then applies. A snapshot applied
   after records it does not describe is the one way this can produce a wrong transcript rather than a late
   one, and it is forbidden rather than tolerated.
3. **A flush happens at the first of: the next frame, a bounded timer, any non-buffered event, or the page
   going away.** Four triggers, and the timer is not an optimisation — constraint 5 makes it the only thing
   that keeps a hidden window from showing text frozen mid-sentence. The timer's number is a latency ceiling,
   not a frame rate: one or two frames' worth.
4. **No animation, no opacity ramp, no height transition, and nothing is held back.** The coalescer removes
   *burstiness* by batching commits; it does not add delay. The text that has been received is the text on
   screen at the end of every frame, which is what makes constraint 4 free: there is nothing to fight the
   authoritative replace.
### (c) The scrollbar goes, and the scroll moves smoothly rather than teleporting

**This section exists because looking at the rendered preview overturned the recommendation above**, which is
what a preview is for. It records three findings, in the order they arrived.

1. **The scrollbar is not a scrollbar problem, it is the wrong instrument.** Viewed at 1512×982 with a 370px
   tail anchor, the transcript's thumb spanned most of a 909px scrollport and read as a second unowned vertical
   edge beside the prose. Making it thinner had already been tried and did not help, because the fault is not
   its weight: **a following reader is at the end by construction**, so a position indicator answers a question
   they do not have. It is **removed** (`scrollbar-width: none`, plus the webkit path), and replaced with a
   **fade at each end of the column** — top when `scrollTop > 0`, bottom when the reader is not at the end —
   which answers the only two questions they do have. Both fades are `aria-hidden` and `pointer-events: none`:
   they are decoration, and the words "Jump to latest" already state the same fact for anyone who cannot see a
   gradient.

2. **Coalescing commits is invisible, and this record sold it as comfort.** The stream preview was built to
   show per-token against per-frame, and the operator reported no difference — correctly, because both sides
   committed inside the same `requestAnimationFrame` and the browser painted them at identical moments. That is
   not a flaw in the demo, it is arithmetic about displays: two commit rates above the refresh rate are
   unwatchable as a difference, and below it there is nothing to batch. Measured: at 75 tokens/s a
   3000-character message costs 608 ms of main-thread parsing today and 428 ms coalesced — **6% of a core
   against 4%** — and the longest single re-parse of the whole message is ~4.9 ms against a 16.7 ms frame, so
   even at 400 tokens/s the work fits. **The coalescer is kept, and its justification is narrowed to CPU
   headroom.** It is not, and must not be described as, a comfort improvement.

3. **The stutter is in the SCROLL, not the text, and nothing above addresses it.** The operator's correction,
   and it is the important one: *"producing the tokens is not the issue, it is how smooth the scrolling
   happens"*. Measured against that reading, every follow path in `Transcript.tsx` is a **teleport**:
   `container.scrollTop = container.scrollHeight`, `endRef.scrollIntoView({ block: "end" })`, and the
   `ResizeObserver` assignment — each an instant jump to a new position, once per commit, with no interpolation.
   Coalescing reduces how OFTEN that happens; it does nothing about how each one looks.

   So: **the follow scroll animates, and it is allowed to.** The standing prohibition comes from #86, where
   `scroll-behavior: smooth` made the pane un-pin itself — the animation emitted intermediate positions, and an
   intermediate position is indistinguishable from the reader scrolling up. That diagnosis was right and its
   conclusion was too broad. The defect was **measuring `pinned` from scroll events during a programmatic
   animation, not the animation**. The rule is therefore:

   - the follow scroll interpolates toward the tail, re-targeting each frame as new content arrives;
   - **`pinned` is decided from reader input only** — wheel, touch, key, scrollbar drag — and a
     programmatic scroll is excluded from the measurement, which is what #86 should have said;
   - a reader's own input **cancels** an in-flight animation immediately, so the pane never fights them;
   - `prefers-reduced-motion: reduce` makes it instant, which is the existing three-place pattern in this
     stylesheet and not a new gate;
   - the gap is **clamped per frame**, so a 300-character burst does not produce a 60px hop and a slow trickle
     does not produce sub-pixel creep that scrolls so slowly it looks stuck.

   **Implemented, and where the design had to change to fit reality.** `packages/ui/src/follow-scroll.ts` holds
   the arithmetic and `Transcript.tsx` routes all four movement paths through one `followTail`. Three things the
   prose above did not anticipate:

   - **Two of those rules conflict, and only one can win.** A bounded per-frame step and a bounded settle TIME
     cannot both hold for a large distance: 900px at 28px/frame is half a second, and covering it faster means
     hopping visibly. The resolution is that the glide is limited to a quarter of the scrollport and anything
     larger simply arrives — past that the reader was not tracking the tail anyway. A first attempt made the
     bound grow with the distance, which reintroduced the hop it existed to prevent; the test that asserted it
     was rewritten rather than kept.
   - **`scrollIntoView` is gone from every path, including the deliberate jump.** It can move an ANCESTOR scroll
     port, and — more importantly — it writes a scroll position this component did not set, which would defeat
     the `readerMoved` comparison outright. The jump now uses the same glide, which it previously did not: its
     `behavior: "smooth"` was immediately overridden by a direct assignment, so it never actually animated.
     That is an incidental defect this change removes.
   - **The old tests were asserting the bug.** Three of them required an instant landing, and two required
     `scrollTop === scrollHeight` — a value a real browser clamps, so they passed only because the stub does not
     clamp. Each was rewritten against the behaviour rather than the implementation, and `scroll.test.ts`'s
     "the follow scrolls instantly" test now asserts the opposite, with its subject (`scroll-behavior: smooth`
     is still refused) intact.

   Four falsifications, and each was run by reverting the rule that makes it true (see
   `packages/ui/src/follow-scroll.ts`): remove the step clamp and a burst hops again; remove the snap and the
   glide never converges; remove the rounding tolerance and our own animation un-pins the reader — #86 exactly;
   ignore `prefers-reduced-motion` and the readers who asked for stillness get motion.

   **A second correction, from watching it: the unit was wrong.** The implementation above bounded each frame at
   28px, which sounds smooth and measured as nothing of the kind. An exponential ease at 0.35 covers 35% of the
   distance in its first frame, so a 100px paragraph arrival peaked at **1680 px/sec — 24 times the top of
   comfortable reading** (1–3 lines/sec, where a line is about 23px). That is not a glide the eye can track; it
   is a teleport that happens to take six frames. Reported exactly as it felt: *"it is abrupt… the user's eye is
   lost"*.

   A per-frame bound cannot express that, because the quantity that matters is a RATE — 28px/frame *is* 1680
   px/sec. The bound looked reasonable per frame and was violent per second. **The unit was the bug.** So the cap
   is now `TAIL_MAX_SPEED_PX_PER_SEC = 140`: six lines/sec, fast enough to keep up with a paragraph arriving
   every three-quarters of a second, slow enough that the text is legible while it moves rather than only after
   it stops. Every distance now settles at that ceiling instead of spiking and decaying:

   | arrival today | before | after |
   |---|---|---|
   | 99px (a paragraph) | peak 1680 px/sec, 0.2s | peak 140 px/sec, 0.9s |
   | 581px (a table) | **instant teleport** | peak 140 px/sec, 4.3s |
   | 900px (a code block) | **instant teleport** | peak 140 px/sec, 6.6s |

   And **the distance limit is gone**. The previous rule refused to glide anything past a quarter of the
   scrollport, on the argument that a long move "cannot be both smooth and quick". That argument measured the
   wrong thing: with a correct rate cap a long move is not a problem, it is just longer — which is what smooth
   means. The consequence of the old rule was that every arrival over ~230px took the instant path, and a code
   block or a table is routinely larger, so the abrupt moves the report describes were the *guaranteed* ones.

   `shouldSettleInstantly` therefore no longer takes a distance. It takes reduced motion only, and the two cases
   where the READER asked to be somewhere (a restore on open, the Jump to latest pill) pass `instant` from the
   call site — where it is knowable — rather than being inferred from a number.

   This is the change that answers the report. The anchor moves where the tail sits; the pacing in (b) is a CPU
   saving; **the scroll is the part the reader actually watches**, and it was the one part missing from this
   record.

**What this reorders.** The slicing is now: the anchor (a) and the scrollbar (1) together, since both are CSS
plus one measurement and both change what the surface looks like; then the follow scroll (3), which is the
comfort fix; then the coalescer (b), which is a CPU fix and can ship whenever. **The paced reveal (5) is
demoted rather than deferred** — with the scroll smooth, a deliberate text pacing is no longer obviously wanted,
and it should be revisited only if the scroll alone does not answer the complaint.

## Consequences

**Positive**

- The followed tail sits where the reader's eyes are, and the reader who disagrees gets a setting instead of a
  revert. The complaint that #92 and #132/#133 chased is answered without touching alignment, which is what
  produced five defects both times.
- Streaming costs less main-thread work, by an amount that scales with the answer: roughly 4× on an
  800-character message and 12× on a 3000-character one, because the per-delta re-parse grows with the square of
  the length while a per-frame flush does not. The work no longer grows with the message at all, so the
  benefit is largest exactly where a stutter hurts most — a long answer being followed live. On a typical
  110-character message it is a small win, and this record does not claim otherwise.
- Nothing animates, so `prefers-reduced-motion` cannot be regressed by this change, and the "settled text
  fights the animation" defect is impossible rather than avoided.
- The two halves are independently revertible: the anchor is CSS plus one preference, the pacing is one
  buffer. Either can ship without the other.

**Negative, stated**

- **A visible empty band sits between the newest line and the composer while following.** That is the point,
  and it is also the failure mode: at `35vh` on a short window it can read as a rendering bug rather than as
  breathing room. The cap and the falsifier below are the mitigation, and `tail: foot` is the escape.
- **This breaks the "invisible to a reader who never opens Settings" rule** that #134 set for size and
  measure, deliberately: here the complaint *is* the default position, so a default that changed nothing
  would be a record that decided nothing. A reader who wants the old behaviour must now find a setting.
- **Text can be up to one frame plus a timer behind the wire.** Unobservable at stream rates and observable in
  a pathological case — a single delta delivered to a hidden window — where the timer bounds it and nothing
  hides it.
- **The buffer is a new ordering surface.** Every future event kind must be classified as "buffered" or
  "flushes first", and a kind added without that classification is a wrong transcript, not a slow one. That is
  a permanent obligation on this store, and it is why the falsifiers below are about ordering rather than
  about speed.

## Alternatives considered

- **A1 alone (spacer, not a preference).** Rejected as the whole answer: "where the eyes rest" is a
  disposition, and this repository already treats reading geometry as a preference (#134) after learning that
  a single invented number is wrong on somebody's display. A1 *is* the mechanism, and it is what the
  preference writes to.
- **A3, reversing the column (`justify-content: flex-end`).** Rejected and recorded so it is not
  re-proposed: it pins the tail to the bottom edge — the behaviour being complained about — and makes a short
  transcript hang from the foot of the window.
- **A4, leave the anchor alone.** Rejected: it forgoes the stated requirement, and is only defensible if the
  reader is expected to scroll deliberately, which they have said they are not doing.
- **B2/B3 as the default — a steady reveal with catch-up.** Rejected *for now*, on the measurement rather than
  on taste: pacing slows the arrival of text the reader could already be reading, and the naive implementation
  is measurably worse than the stream (16–19% of reveal positions show literal markdown). It stays available
  behind a preference once the pacing is done without slicing source, which is a larger change than this
  record needs.
- **B4, CSS transitions on appended nodes with no change to arrival.** Rejected as a substitute and kept as a
  component of B2/B3 if that ever lands: it smooths the *appearance* of jumps without changing their pacing,
  which at token rate reads as flicker rather than as calm.
- **Coalescing inside the component (`Prose`/`Transcript`) rather than before the reducer.** Rejected: the
  expensive part is not only the parse, it is `applyRecord` cloning the transcript per record. Buffering in
  the component would leave hundreds of reducer commits and hundreds of re-renders per message, and would put
  the ordering rule in a React effect where it is harder to test than a pure fold over a batch.

## Verification

Each of these is a test, and each can fail.

**The anchor**

- `readingStyle` emits the tail property for both values, and a corrupt stored `tail` degrades to
  `middle` rather than to a broken transcript — the same rule `parseReadingPrefs` already holds for size and
  measure, tested without a DOM.
- The lane carries the anchor padding and `.transcript-viewport` still carries `--jump-strip`, asserted as
  two separate reservations. Remove the lane padding → the anchor test fails.
- The end sentinel is the last child of the scroller, asserted structurally — this is the C20-shaped guard, and
  it is the one that catches a future spacer element.
- No rule in `.transcript-lane` or `.prose` gains a child-count dependency, asserted the way
  `layout.test.mjs` already asserts the centring revert.

**The pacing**

- A batch of N deltas folds to the same transcript as N single records — the folded result is compared to the
  unfolded one, so a botched ordering fails on content rather than on timing.
- A `snapshot` (or `session`/`transcript`) arriving between two buffered records flushes them first, so
  the snapshot is never applied over records it predates. Remove the flush → the test sees a stale transcript.
- A buffered record is flushed by the timer when no frame runs, so a hidden window does not freeze. Remove the
  timer → the test sees unapplied text.
- The render count for one streamed message is at most one per flush, asserted with a counting render, so a
  regression to per-delta commits fails the test rather than being felt.

**Falsifiers — what would turn this decision over rather than be fixed inside it:**

- **A reader who is following still finds the newest line at or below where it is today** → the padding is not
  being applied, or the sentinel moved past it. (Both are the anchor's own tests.)
- **The transcript floats with a void that reads as a rendering bug at short length** → the cap is wrong, and
  the answer is the cap or the default, not a revert of the mechanism.
- **Scroll position ever moves on its own while the reader has scrolled up** → constraint 2 was broken, and
  the anchor is not the cause; the follow rule is.
- **The settled message ever differs from what was streamed** → the batch is not folded in order, or a
  non-buffered event did not flush first.
- **Text is visibly behind the wire in a way the reader can see** → a flush trigger is missing, and the
  anchor half of this record is not implicated.

**Two slices land the outcome:** one for the anchor (preference + padding + the panel row), one for the
pacing (coalescer + the ordering rule + the render-count test). They do not share a file, so they may be
reviewed apart.

### What could not be measured

[#279] asks for one recording of a real streaming session at the reporter's window size before the default is
settled: *where the newest line sits relative to the vertical middle, and whether arrival is bursty or
steady*. **Half of that was taken and half was not.**

- **Arrival was measured**, and quantitatively: the parse-per-delta count and cost in the table above, on real
  messages out of this machine's session store. That is the evidence behind (b), and it does not depend on
  anyone's window.
- **The geometry was not.** A headless browser cannot start in this environment — Chromium aborts with
  `SIGSEGV` under the Seatbelt profile these sessions run in, which is [C1](../CONSTRAINTS.md#c1--macos-seatbelt-does-not-nest)
  making itself felt on a screenshot rather than on a session. So the anchor's *default* rests on the
  reporter's statement and on the arithmetic of what "maximum scroll" means, and the constant `35vh` is
  explicitly unverified. The capture is one command in an unsandboxed checkout, it belongs in
  [`docs/ui-reviews/`](../ui-reviews/), and it is the first thing the anchor slice should produce — before
  the constant is chosen, not after.

This is stated because the repository's norm is that a passing test is an argument and a screenshot is
evidence. The half that is evidence is labelled as such; the half that is not says so.

[#279]: https://github.com/sven1103-agent/pi-central/issues/279
