/**
 * Following the tail SMOOTHLY, and the one thing that makes that safe (ADR-0016).
 *
 * ## The report this answers
 *
 * *"producing the tokens is not the issue, it is how smooth the scrolling happens"*. Measured against that
 * reading, every follow path in the transcript was a **teleport**: `scrollTop = scrollHeight`,
 * `scrollIntoView({ block: "end" })` and the `ResizeObserver` assignment are each an instant jump to a new
 * position, once per commit, with no interpolation. Coalescing deltas changes how OFTEN that happens and
 * nothing about how each one looks.
 *
 * So the scroll interpolates. This module is the arithmetic, with no DOM in it, because a rule asserted only
 * through its caller is a rule that can be changed in the caller.
 *
 * ## Why this was forbidden before, and why the prohibition was too broad
 *
 * `scroll-behavior: smooth` was removed in #86 because it made the pane **un-pin itself**: the animation
 * emitted a run of intermediate positions, and an intermediate position is indistinguishable from the reader
 * scrolling up — so the follow switched itself off a few frames in and the transcript stopped following the
 * moment output outran it.
 *
 * That diagnosis was correct. The conclusion was too broad. The defect was **measuring `pinned` from scroll
 * events during a programmatic animation**, not the animation. So this module ships with three rules that
 * together make the animation safe, and each one is a function here rather than a comment:
 *
 *   1. `tailStep` bounds how far one frame may move, so a burst becomes a glide.
 *   2. `readerMoved` distinguishes the reader's scroll from ours, by comparing what the browser reports with
 *      what we last wrote. A programmatic scroll never looks like a reader scroll, so it never un-pins.
 *   3. `shouldSettleInstantly` says when to skip the animation entirely — reduced motion, and a movement the
 *      reader ASKED for, such as a restore or the jump pill.
 */

/**
 * The two limits on a follow, and why BOTH are needed.
 *
 * This module has now been corrected twice on the same question, so the reasoning is stated once, precisely.
 *
 * ## What was wrong the first time: the unit
 *
 * The original bound was 28px *per frame*. That sounds smooth and is 1680 px/sec — 24 times the top of
 * comfortable reading. A per-frame bound cannot express a velocity, so the number looked reasonable and felt
 * violent. The fix was to state the bound as a RATE.
 *
 * ## What was still wrong the second time: a rate alone crawls
 *
 * A pure rate cap fixes small arrivals and ruins large ones. Content does not arrive at a steady pace: a tool
 * result or a code block lands in ONE commit, hundreds of pixels of it, already rendered and already visible
 * below the fold. A 581px arrival then takes **4.2 seconds** to bring the viewport down — and during those four
 * seconds the text is simply THERE, sliding slowly past. The eye is not tracking anything; it is waiting.
 *
 * That is what "bursty and huge still teleport" describes, and it is the opposite of a jump: it is a crawl over
 * content that has already appeared. Reported from the harness, and it is correct.
 *
 * ## What was wrong the third time: two regimes crawl at the seam
 *
 * A rate for small moves and a fixed fraction for large ones sounded like the resolution. It was not, because the
 * regime is chosen from the REMAINING distance on every frame: a 581px arrival covered 545px in seven frames and
 * then switched to the gentle fraction for the last 36px, which took twenty more. A 450ms settle whose tail is
 * exactly the crawl it was meant to remove.
 *
 * ## The resolution: one curve, ramped by distance
 *
 * `TAIL_EASE` and `TAIL_BURST_FRACTION` are now the ENDS of a single continuous curve rather than two regimes,
 * blended over `TAIL_RAMP_SPAN_PX`. There is no seam, so nothing can crawl through one. Every arrival from 2px
 * to 5000px settles in 83-267ms: slow enough at the small end to be read as text scrolling rather than as a
 * flick, and bounded at the large end so the eye never tracks a travelling blur.
 *
 * The tradeoff is real and is resolved in favour of DURATION for large moves, because a large arrival has already
 * happened in the DOM: the reader is not reading it as it slides, they read it once the viewport stops.
 */

/**
 * The gentle fraction, which governs moves small enough that the reader is following them line by line.
 *
 * A steady stream produces about 1.2px of new content per frame, and this moves it in sub-pixel steps: 83ms to
 * settle a 2px gap, 133ms for 5px. 0.22 rather than the 0.18 tried before, because the ramp (see `tailStep`)
 * already softens small distances and the gentler ease pushed the settle past the budget.
 */
export const TAIL_EASE = 0.22;

/**
 * The fraction a LARGE arrival uses, where the content is already on screen and the reader is waiting.
 *
 * Deliberately about three times the gentle fraction. A large arrival has already happened in the DOM: being
 * slow to bring the viewport to it buys nothing, because the text is read once the motion stops rather than
 * while it moves.
 */
export const TAIL_BURST_FRACTION = 0.62;

/**
 * The distance over which the fraction ramps from gentle to burst.
 *
 * The two constants above are the ENDS of one continuous curve rather than two regimes, which is what the third
 * failed version got wrong: switching regimes mid-settle left the last 36px of a 581px arrival to the gentle
 * ease, which then crawled for 20 frames. 28px is where the ramp completes, so nothing above it still uses the
 * gentle fraction.
 */
export const TAIL_RAMP_SPAN_PX = 28;

/** One frame at 60Hz, for stating settle times in milliseconds. */
export const FRAME_MS = 1000 / 60;

/**
 * The settle budget, which is what "watchable" means here.
 *
 * Every arrival from 2px to 5000px settles in 83-267ms. That range IS the requirement: below it the motion is a
 * flick, above it the eye starts tracking a travelling blur instead of reading text.
 */
export const TAIL_SETTLE_BUDGET_MS = 267;

/**
 * WHETHER A LONG DISTANCE GLIDES — and it does, which reverses an earlier decision in this same module.
 *
 * The first version refused to glide anything past a quarter of the scrollport, on the argument that a 900px
 * move "cannot be both smooth and quick". That argument was measuring the wrong thing: with a correct RATE cap a
 * long move is not a problem, it is just longer. At 140 px/sec a 600px arrival takes 4.3 seconds, which is
 * exactly what "smooth" means — the reader sees the content slide rather than appearing.
 *
 * The operator reported the consequence of the old rule: "it is abrupt… the user's eye is lost". Every arrival
 * over ~230px — a code block, a table, a tool result — took the instant path. So there is no distance limit any
 * more; the only reasons to arrive instantly are the two in `shouldSettleInstantly`.
 *
 * The cost is real and is stated rather than hidden: opening a session at the end, or pressing the pill, now
 * animates over several seconds. That is why those two cases pass `instant`: they are the reader ASKING to be
 * somewhere, not content arriving underneath them.
 */

/** Closer than this and the movement is a rounding artefact; snap, or it never converges. */
export const TAIL_SNAP_PX = 0.6;

/**
 * How far the browser will report a programmatic scroll differing from what was written.
 *
 * `scrollTop` is clamped to the scrollable range and may be rounded to a device pixel, so "what I wrote" and
 * "what it reports" can differ by a fraction with no reader involved. A reader's movement is at least a wheel
 * notch or a keypress, which is far larger — so the gap between the two is what tells them apart.
 */
export const READER_SCROLL_TOLERANCE_PX = 1.5;

/**
 * How far to move toward the tail on this frame.
 *
 * Takes the remaining distance and returns the movement for one frame: eased, bounded, and snapped when it is
 * within a rounding artefact of the target.
 *
 * A non-finite input returns 0 rather than propagating `NaN` into `scrollTop`, which browsers treat as 0 and
 * would send the reader to the top of the transcript.
 */
export function tailStep(remaining: number): number {
  if (!Number.isFinite(remaining)) return 0;
  const distance = Math.abs(remaining);

  // At or past the target: snap, so the loop terminates instead of decaying forever.
  if (distance <= TAIL_SNAP_PX) return remaining;

  //
  // ONE CURVE, NO REGIME SWITCH.
  //
  // Three earlier versions failed here, each reported from the harness, and the sequence is the argument:
  //
  //   1. a 28px PER-FRAME cap is 1680 px/sec at 60Hz -- violent, and the unit hid it;
  //   2. a 140 px/sec RATE cap made a 581px arrival crawl for 4.2 seconds over content already rendered;
  //   3. a burst fraction with an ease fallback SWITCHED REGIMES mid-settle: the burst covered 545px in 7
  //      frames and the gentle ease then took 20 more to cross the last 36px, so a 581px settle was 450ms and
  //      its tail was exactly the crawl this was meant to remove.
  //
  // A stateless function cannot know how large the original arrival was, so the regime cannot be chosen at the
  // start. What works is a fraction that RAMPS WITH THE REMAINING DISTANCE: the gentle ease is its limit as the
  // distance goes to zero, the burst fraction is its limit as it grows, and every settle time falls out of one
  // curve with no discontinuity to crawl through:
  //
  //   distance     settle
  //     2px         83ms
  //    12px        167ms
  //    36px        183ms
  //    99px        200ms
  //   581px        233ms
  //  1163px        250ms
  //  5000px        267ms
  //
  // Small moves stay slow enough to read -- a 5px step is 133ms, not a flick -- and large ones finish without a
  // crawl at the end. The fraction at the current distance is all the state this needs.
  //
  const ramp = Math.min(1, distance / TAIL_RAMP_SPAN_PX);
  return remaining * (TAIL_EASE + (TAIL_BURST_FRACTION - TAIL_EASE) * ramp);
}

/**
 * Did the reader move the scroller, rather than us?
 *
 * The whole safety argument of ADR-0016 rests on this one comparison. #86 was caused by treating a
 * programmatic intermediate position as a reader scroll; this is the same distinction, made explicit.
 *
 * `lastWritten` is what the animation assigned on the previous frame (read back AFTER assignment, so a clamp
 * by the browser is accounted for). A `null` means nothing has been written yet, and the position is the
 * reader's by definition.
 */
export function readerMoved(
  reported: number,
  lastWritten: number | null,
  tolerance = READER_SCROLL_TOLERANCE_PX,
): boolean {
  if (lastWritten === null) return false;
  if (!Number.isFinite(reported) || !Number.isFinite(lastWritten)) return false;
  return Math.abs(reported - lastWritten) > tolerance;
}

/**
 * Should this follow arrive instantly instead of gliding?
 *
 * Two reasons, and BOTH are about whose movement it is — not about how far.
 *
 *   - **Reduced motion.** Honoured in three places in the stylesheet already; this is the fourth, and the one that
 *     cannot live in CSS because the movement is written from JavaScript.
 *   - **The reader asked to be somewhere** — a restore on open, or the "Jump to latest" pill. Those pass
 *     `instant` from the call site, because animating a request is showing the reader a delay they did not ask
 *     for. Content arriving underneath them is the opposite case and always glides, however far it moved.
 *
 * There is deliberately no distance test here any more. A long arrival takes longer; that is the point.
 */
export function shouldSettleInstantly(reducedMotion: boolean): boolean {
  return reducedMotion;
}
