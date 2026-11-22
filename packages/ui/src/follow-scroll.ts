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
 * The most content may move per second, in px — and this is the constant that decides whether it FEELS smooth.
 *
 * ## Why this replaced a per-frame clamp
 *
 * The first version bounded each frame at 28px, which sounds smooth and measured as nothing of the kind. An
 * exponential ease at 0.35 covers 35% of the distance in its first frame, so a 100px paragraph arrival peaked at
 * **1680 px/sec — 24 times the top of comfortable reading.** That is not a glide the eye can track; it is a
 * teleport that happens to take six frames, which is exactly what was reported: "it is abrupt… the user's eye is
 * lost".
 *
 * A per-frame bound cannot express that, because the quantity that matters is a RATE. 28px/frame IS 1680 px/sec,
 * which is why the bound looked reasonable per frame and was violent per second. The unit was the bug.
 *
 * ## The number
 *
 * Comfortable reading scroll runs at roughly 1–3 lines per second; a transcript line is ~23px, so 23–70 px/sec.
 * 140 px/sec is six lines/sec: fast enough that the tail keeps up with a paragraph arriving every three-quarters
 * of a second, slow enough that text is legible WHILE it moves rather than only after it stops.
 *
 * It sits above what a steady stream produces (240 chars/sec is ~70 px/sec, so that is not clamped at all), so
 * the cap only ever governs a BURST — which is the motion that was objectionable.
 */
export const TAIL_MAX_SPEED_PX_PER_SEC = 140;

/**
 * One frame at 60Hz, for converting the rate into a per-frame budget.
 *
 * Named rather than inlined, because the two are used together everywhere and a stray `60` elsewhere is how a
 * velocity rule quietly becomes a per-frame rule again.
 */
export const FRAME_MS = 1000 / 60;

/** The most one frame may move at that rate: about 2.3px. */
export const TAIL_MAX_STEP_PX = (TAIL_MAX_SPEED_PX_PER_SEC * FRAME_MS) / 1000;

/**
 * The fraction of the remaining distance covered per frame, before the rate is applied.
 *
 * Lowered from 0.35 to 0.18. The ease exists to stop the motion ending on a linear crawl that looks stuck — not
 * to cover ground quickly, which is the rate cap's job. A gentler curve keeps the slope across the whole settle
 * inside the comfortable band instead of spiking at its start.
 */
export const TAIL_EASE = 0.18;

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
  // At or past the target: snap, so the loop terminates instead of easing forever by fractions of a pixel.
  if (Math.abs(remaining) <= TAIL_SNAP_PX) return remaining;
  // Eased, then bounded by the RATE. The bound is unconditional now: a step larger than this is a hop, whatever
  // produced it, and bounding it is what makes a long arrival take longer rather than jump.
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
