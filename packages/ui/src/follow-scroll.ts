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
 * THE CEILING, and it is the one constant that decides whether this feels smooth.
 *
 * One line of prose per frame. A transcript line is about 23px, so this is ~1400 px/sec at 60Hz — the speed at
 * which scrolling text reads as MOVEMENT rather than as a jump. Every earlier version bounded something else
 * (per-second rate, total settle time, a burst fraction) and each let a single frame move 15 lines, which the
 * eye sees as a teleport no matter how brief the total settle is.
 *
 * The cost is stated where it is paid: a 2000px arrival takes 1.45 seconds, and a 5000px one about 3.6. That is
 * correct — a long arrival is a long slide — and it is why large arrivals are the case to watch for in review.
 */
export const TAIL_MAX_STEP_PX = 23.25;

/**
 * The gentle fraction, for the shape of a SMALL movement.
 *
 * Below `TAIL_RAMP_SPAN_PX` this decides the step and the ceiling never engages, so a steady stream (~1.2px of
 * new content per frame) moves in sub-pixel increments that read as text scrolling.
 */
export const TAIL_EASE = 0.22;

/**
 * The brisk fraction, for the shape of a LARGE movement.
 *
 * Reaches the ceiling quickly, so a burst covers ground at the maximum rate the eye allows rather than easing
 * into it — the ceiling is what makes it safe, not the fraction.
 */
export const TAIL_BURST_FRACTION = 0.9;

/** The distance over which the fraction ramps from gentle to brisk. */
export const TAIL_RAMP_SPAN_PX = 28;

/** One frame at 60Hz, for stating settle times in milliseconds. */
export const FRAME_MS = 1000 / 60;

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
  // ONE CURVE, AND A HARD PER-FRAME CEILING.
  //
  // Four versions failed here and the sequence is the argument, because each one looked right:
  //
  //   1. a 28px PER-FRAME cap -- 1680 px/sec, six lines per frame, violent;
  //   2. a 140 px/sec RATE cap -- a 581px arrival crawled for 4.2 seconds over content already rendered;
  //   3. a burst fraction with an ease fallback -- the regimes met at a seam, and the last 36px of a 581px
  //      arrival took twenty frames to crawl through it;
  //   4. a distance-ramped fraction with a settle BUDGET -- the budget bounded the total, so the FIRST frame
  //      moved 360px of a 581px arrival. Measured from the harness probe as 21613 px/sec, and reported as
  //      "bursty and huge are constantly red". The probe was right.
  //
  // The mistake common to 3 and 4 was bounding the DURATION and assuming that made every frame small. It does
  // not: a fast settle necessarily contains fast frames. The bound that matters perceptually is per FRAME, and
  // the settle time is then a CONSEQUENCE rather than a target.
  //
  // One line of prose per frame is the ceiling, which is what scrolling at reading speed looks like:
  //
  //   arrival    frames   settle
  //     99px        5      0.08s
  //    233px       11      0.18s
  //    581px       25      0.42s
  //   1163px       51      0.85s
  //   2000px       87      1.45s
  //
  // A long arrival therefore takes longer, and that is the correct trade: it is a slide the eye can follow
  // rather than a jump it cannot. The fraction below governs how the movement SHAPES itself inside that
  // ceiling -- gentle at small distances, brisk at large ones -- while the ceiling guarantees no frame is ever
  // a teleport.
  //
  const ramp = Math.min(1, distance / TAIL_RAMP_SPAN_PX);
  const shaped = remaining * (TAIL_EASE + (TAIL_BURST_FRACTION - TAIL_EASE) * ramp);
  return Math.max(-TAIL_MAX_STEP_PX, Math.min(TAIL_MAX_STEP_PX, shaped));
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
