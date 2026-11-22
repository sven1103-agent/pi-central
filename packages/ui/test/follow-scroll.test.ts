/**
 * The arithmetic behind a smooth follow (ADR-0016).
 *
 * Three rules, and each one exists because a naive version produces a specific defect. The tests are grouped
 * by the defect rather than by the function, so a failure says what would break in the product rather than
 * which helper changed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  READER_SCROLL_TOLERANCE_PX,
  TAIL_GLIDE_LIMIT_RATIO,
  TAIL_MAX_STEP_PX,
  TAIL_SNAP_PX,
  readerMoved,
  shouldSettleInstantly,
  tailStep,
} from "../src/follow-scroll.ts";

/**
 * The distance after gliding to the tail, frame by frame.
 *
 * Bounded so a broken rule fails a test instead of hanging the suite — a rule that never converges is a defect
 * worth reporting, not a reason to wait.
 */
function glide(distance: number, frames = 200): { step: number; remaining: number }[] {
  const trace: { step: number; remaining: number }[] = [];
  let remaining = distance;
  for (let frame = 0; frame < frames && remaining !== 0; frame += 1) {
    const step = tailStep(remaining);
    remaining -= step;
    trace.push({ step, remaining });
  }
  return trace;
}

test("a steady stream keeps up: the tail is never left behind the text", () => {
  /*
   * The case that must not regress. A 3000-character answer over ten seconds moves the scroller about 1.5px per
   * frame, and the eased step for 1.5px of remaining distance is 0.52px — so the tail follows within a frame or
   * two rather than lagging behind.
   *
   * What matters is not that the step EQUALS the distance (an easing function deliberately does not) but that
   * repeated frames converge fast enough that the lag is imperceptible. Asserted as the property, not the
   * arithmetic, because the arithmetic is what a later change is allowed to tune.
   */
  let remaining = 1.5;
  for (let frame = 0; frame < 4 && remaining !== 0; frame += 1) remaining -= tailStep(remaining);
  assert.equal(remaining, 0, "1.5px of stream must be caught within four frames");

  // And a steady trickle must never be clamped below what it asks for: the clamp is for bursts.
  for (const perFrame of [0.5, 1.5, 5]) {
    assert.ok(
      Math.abs(tailStep(perFrame)) <= perFrame,
      `a ${perFrame}px remaining distance must never be stepped PAST the target`,
    );
    assert.ok(Math.abs(tailStep(perFrame)) > perFrame * 0.3, "nor fall so far behind that the tail lags");
  }
});

test("a BURST becomes a glide rather than a teleport", () => {
  /*
   * The reported symptom. One paragraph arriving at once is 200-400px of new content; moved whole in a single
   * frame the eye sees a hop. Each frame must move at most the bound, and the whole distance must still be
   * covered in a handful of frames.
   *
   * Revert tailStep to `return remaining` and this fails on the first step: 300px in one frame.
   */
  const steps = glide(300);
  assert.ok(steps.length > 6, `300px must take more than one frame to settle; took ${steps.length}`);
  for (const [index, { step }] of steps.entries()) {
    assert.ok(
      Math.abs(step) <= TAIL_MAX_STEP_PX + 1e-9,
      `frame ${index} moved ${step}px, above the ${TAIL_MAX_STEP_PX}px bound`,
    );
  }
  assert.equal(steps.at(-1)?.remaining, 0, "and it must actually arrive, not approach forever");
});

test("gliding always terminates, and terminates quickly", () => {
  /*
   * An easing function that multiplies by a fraction NEVER reaches zero on its own — it halves forever. Without
   * the snap, the animation would run for as long as the transcript is open, writing sub-pixel scroll positions
   * every frame, which is a CPU leak that looks like a busy idle page.
   *
   * Remove the TAIL_SNAP_PX branch and this fails: the loop runs to its frame limit with a non-zero remainder.
   */
  // Distances a glide is actually asked to cover. Anything past a quarter of a scrollport is routed to
  // shouldSettleInstantly and never reaches this loop, which the next test covers.
  for (const distance of [0.7, 5, 60, 300]) {
    const steps = glide(distance);
    assert.equal(steps.at(-1)?.remaining, 0, `${distance}px must settle exactly`);
    assert.ok(steps.length < 120, `${distance}px took ${steps.length} frames to settle`);
  }
});

test("the glide is bounded by distance, not by a frame count", () => {
  /*
   * The two requirements collide and this test states the resolution rather than pretending they do not: a
   * 900px move cannot be BOTH smooth and quick. At the 28px burst bound it takes half a second; to take less it
   * has to hop visibly.
   *
   * So the glide is limited to distances where gliding is genuinely better — a quarter of the scrollport — and
   * anything larger is routed to shouldSettleInstantly instead. The first version of this test asserted that
   * `tailStep` alone bounded 20000px to 40 frames, which forced the step bound to grow with the distance and
   * reintroduced the hop it was meant to remove. Two rules cannot both be satisfied by one number.
   */
  assert.ok(glide(300).length < 30, "a paragraph-sized burst settles in well under half a second");
  assert.ok(
    shouldSettleInstantly(20000, 900, false),
    "20000px does not glide at all: past a quarter of a scrollport it simply arrives",
  );
});

test("a negative distance (content above the target) mirrors exactly", () => {
  // The same rule has to work in both directions, because a container can shrink as well as grow — a collapsed
  // trace, a session switch. A sign-handling bug here would move the reader the wrong way.
  const up = glide(-300).map((entry) => entry.step);
  const down = glide(300).map((entry) => entry.step);
  assert.deepEqual(up, down.map((step) => -step), "the upward glide is the downward one, negated");
});

test("a non-finite distance moves nothing, rather than sending the reader to the top", () => {
  // `scrollTop = NaN` is treated as 0 by browsers: the reader would land at the START of the transcript, which
  // is the #141 symptom arriving through a different door.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(tailStep(bad), 0, `${bad} must not move the scroller`);
  }
});

test("our own scroll is not mistaken for the reader's — the #86 distinction", () => {
  /*
   * The defect that made this change forbidden the first time. #86 removed smooth scrolling because the
   * animation emitted intermediate positions, and an intermediate position was read as "the reader scrolled
   * away", so the pane un-pinned itself and stopped following.
   *
   * The rule: what the browser reports is compared with what we last wrote. Ours matches within a rounding
   * tolerance; the reader's does not.
   *
   * Delete the tolerance and return `reported !== lastWritten` and this fails on the first case, because a
   * clamped scrollTop legitimately differs by a fraction.
   */
  assert.equal(readerMoved(100, 100), false, "the exact position we wrote is ours");
  assert.equal(
    readerMoved(100.4, 100),
    false,
    `a sub-pixel difference is rounding, not a reader (tolerance ${READER_SCROLL_TOLERANCE_PX}px)`,
  );
  assert.equal(readerMoved(100 + READER_SCROLL_TOLERANCE_PX + 1, 100), true, "beyond the tolerance is the reader");
  assert.equal(readerMoved(60, 100), true, "a wheel notch upward is unmistakably the reader");
});

test("nothing written yet means the position is the reader's", () => {
  // On mount there is no previous write, so an offset already present is genuinely theirs — the restored
  // position from #141. Calling it ours would start the animation by tugging them somewhere.
  assert.equal(readerMoved(412, null), false, "an unwritten position is not a movement to correct");
});

test("a non-finite reported position does not read as the reader moving", () => {
  assert.equal(readerMoved(Number.NaN, 100), false);
  assert.equal(readerMoved(100, Number.NaN), false);
});

test("reduced motion settles instantly, and that is not optional", () => {
  /*
   * The stylesheet honours this preference in three places already (ADR-0016, constraint 1). The follow scroll
   * is written from JavaScript, so it cannot be gated in CSS — this is the only place the gate can exist, and a
   * change that dropped it would animate for exactly the readers who asked it not to.
   */
  assert.equal(shouldSettleInstantly(5, 900, true), true, "even one pixel, when motion is reduced");
  assert.equal(shouldSettleInstantly(5, 900, false), false, "a normal follow glides");
});

test("a distance bigger than the scrollport arrives instead of gliding", () => {
  /*
   * The reader was not looking at the tail — a session opened at the end, a jump from the pill. Gliding over a
   * screenful is slower than arriving and the animation would be the only thing they saw. The scrollport height
   * is the natural boundary: past it, nothing is being tracked.
   */
  assert.equal(shouldSettleInstantly(900 * TAIL_GLIDE_LIMIT_RATIO, 900, false), false, "a quarter of a scrollport is still a follow");
  assert.equal(shouldSettleInstantly(900 * TAIL_GLIDE_LIMIT_RATIO + 1, 900, false), true, "past a quarter of a scrollport, just arrive");
  assert.equal(shouldSettleInstantly(0, 900, false), false, "nothing to cover is trivially instant, either way");
});
