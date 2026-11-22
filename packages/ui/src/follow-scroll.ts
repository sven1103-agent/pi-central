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
 *   3. `shouldSettleInstantly` says when to skip the animation entirely — reduced motion, and a distance so
 *      large that gliding would be slower than simply arriving.
 */

/**
 * The fraction of the remaining distance covered per frame, before clamping.
 *
 * 0.35 leaves ~7% after six frames and under 1% after twelve, so a normal burst settles in about 100–200ms —
 * long enough for the eye to track, short enough that it does not read as a separate animation the reader has
 * to wait for.
 */
export const TAIL_EASE = 0.35;

/**
 * The most one frame may move, in px.
 *
 * This is the constant that turns a teleport into a glide. A paragraph arriving at once is 200–400px of new
 * content; moved whole in one frame it is a hop the eye cannot follow, and moved at 28px/frame it is a ~150ms
 * slide that reads as the page settling.
 *
 * It is deliberately far above the ~1.5px/frame a normal stream produces (a 3000-character answer over ten
 * seconds), so **steady streaming is not clamped at all** — the clamp exists only for bursts, and applying it
 * to the common case would lag the tail behind the text for no reason.
 */
export const TAIL_MAX_STEP_PX = 28;

/**
 * The largest distance that is GLIDED rather than simply arriving, as a fraction of the scrollport.
 *
 * This constant exists because two requirements collide and there is no step size that satisfies both. A 900px
 * move cannot be both smooth and quick: at the burst bound it takes half a second, and at half a second it has
 * to take hops large enough to see. So the glide is limited to distances where a glide is actually better, and
 * anything larger is handled by `shouldSettleInstantly` — the reader was not tracking the tail anyway, so
 * arriving is the honest thing to show them.
 *
 * A quarter of the scrollport: past that, the reader is looking at a different part of the conversation than
 * the one that moved.
 */
export const TAIL_GLIDE_LIMIT_RATIO = 0.25;

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
  // At or past the target: snap, so the loop terminates instead of easing forever by fractions of a pixel.
  if (Math.abs(remaining) <= TAIL_SNAP_PX) return remaining;
  // Eased, then bounded. The bound is unconditional: a step larger than this is a hop, whatever produced it, and
  // distances big enough for that to matter are routed to `shouldSettleInstantly` instead of being glided badly.
  const eased = remaining * TAIL_EASE;
  return Math.max(-TAIL_MAX_STEP_PX, Math.min(TAIL_MAX_STEP_PX, eased));
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
 * Two cases, and both are about not showing the reader an animation they did not ask for:
 *
 *   - **Reduced motion.** The preference is already honoured in three places in the stylesheet; an animation
 *     that ignored it here would be a regression rather than a comfort. This is the fourth, and it is the one
 *     that cannot be expressed in CSS because the movement is written from JavaScript.
 *   - **Nothing to track.** A distance larger than the scrollport means the reader was not looking at the tail
 *     at all — a session opened at the end, a jump from the pill. Gliding across a screenful is slower than
 *     arriving, and the animation would be the only thing they saw.
 */
export function shouldSettleInstantly(remaining: number, viewportHeight: number, reducedMotion: boolean): boolean {
  if (reducedMotion) return true;
  if (!Number.isFinite(remaining) || !Number.isFinite(viewportHeight)) return false;
  if (viewportHeight <= 0) return true;
  return Math.abs(remaining) > viewportHeight * TAIL_GLIDE_LIMIT_RATIO;
}
