/**
 * The arithmetic behind a smooth follow (ADR-0016).
 *
 * Three rules, and each one exists because a naive version produces a specific defect. The tests are grouped
 * by the defect rather than by the function, so a failure says what would break in the product rather than
 * which helper changed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FRAME_MS,
  READER_SCROLL_TOLERANCE_PX,
  TAIL_MAX_SPEED_PX_PER_SEC,
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
/*
 * The frame cap is generous because the RATE is low by design: at 140 px/sec a 900px arrival legitimately takes
 * ~400 frames. The first version capped at 200 and truncated that settle, which then read as "never converges" —
 * a false failure produced by the harness rather than the code.
 */
function glide(distance: number, frames = 2000): { step: number; remaining: number }[] {
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
  // The settle is now governed by a RATE, so a small distance takes proportionally longer than before. These
  // numbers are the rate’s arithmetic, not a target: the property is that a steady stream never accumulates a
  // backlog, which the second half asserts.
  let remaining = 1.5;
  let frames = 0;
  while (remaining !== 0 && frames < 20) { remaining -= tailStep(remaining); frames += 1; }
  assert.equal(remaining, 0, "1.5px of stream must settle");
  assert.ok(frames <= 8, `1.5px took ${frames} frames, which is long enough to lag the tail`);

  // And a steady trickle must never be clamped below what it asks for: the clamp is for bursts.
  for (const perFrame of [0.5, 1.5, 5]) {
    assert.ok(
      Math.abs(tailStep(perFrame)) <= perFrame,
      `a ${perFrame}px remaining distance must never be stepped PAST the target`,
    );
    // Was 0.3 of the distance, tuned for the old 0.35 ease. The gentler 0.18 covers at most 0.18 of it per frame,
    // which is still far more than a steady stream accumulates: at 4 chars/frame the arrival is ~1.2px, and the
    // step clears 0.2px of it, so the backlog stays under a pixel rather than growing.
    assert.ok(Math.abs(tailStep(perFrame)) > perFrame * 0.15, "nor fall so far behind that the tail lags");
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
  for (const distance of [0.7, 5, 60, 300, 900]) {
    const steps = glide(distance);
    assert.equal(steps.at(-1)?.remaining, 0, `${distance}px must settle exactly`);
    // Bound raised with the gentler rate: at 2.3px/frame a 900px settle legitimately takes ~400 frames, which is
    // the point of the change rather than a defect. What must hold is that it TERMINATES exactly.
    assert.ok(steps.length < 600, `${distance}px took ${steps.length} frames to settle`);
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
  /*
   * ANDREW: A LONG DISTANCE NOW GLIDES. This test used to require the opposite, and that requirement was the
   * bug: every arrival over a quarter of the scrollport — a code block, a table, a tool result — took the
   * instant path, which is what was reported as abrupt. With a correct RATE cap a long move is not a problem,
   * it is just longer, so what must be asserted is that the motion stays inside the comfortable band however
   * far it travels.
   */
  const long = glide(900);
  const perFrame = long.map((entry) => Math.abs(entry.step));
  const peakSpeed = (Math.max(...perFrame) / (FRAME_MS / 1000));
  assert.ok(
    peakSpeed <= TAIL_MAX_SPEED_PX_PER_SEC + 1,
    `a 900px arrival must never exceed the comfortable rate; peaked at ${peakSpeed.toFixed(0)} px/sec`,
  );
  assert.equal(long.at(-1)?.remaining, 0, "and it must arrive, however long it takes");
  assert.ok(long.length > 60, "900px at a readable rate takes real time — that IS the smoothing");
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
  assert.equal(shouldSettleInstantly(true), true, "even one pixel, when motion is reduced");
  assert.equal(shouldSettleInstantly(false), false, "a normal follow glides");
});

test("only the READER\u2019S OWN request is instant; content arriving always glides", () => {
  /*
   * This is the distinction the whole fix turns on, and it replaced a distance rule that got it wrong.
   *
   * The old predicate made anything past a quarter of the scrollport instant, reasoning that the reader "was not
   * looking at the tail anyway". That is true of a RESTORE and of the Jump to latest pill — both are the reader
   * asking to be somewhere — and false of a code block arriving while they read, which is the motion that was
   * reported as abrupt precisely because it took the instant path.
   *
   * So the decision moved to the CALL SITE, where it is knowable: two callers pass `instant`, and everything
   * else glides however far it moved.
   */
  assert.equal(shouldSettleInstantly(false), false, "content arriving glides, at any distance");
  assert.equal(shouldSettleInstantly(true), true, "reduced motion is always instant");

  const pane = readFileSync(new URL("../src/components/Transcript.tsx", import.meta.url), "utf8");
  const instants = [...pane.matchAll(/followTail\(\{[^}]*instant: true[^}]*\}\)/g)].length;
  assert.equal(
    instants,
    2,
    "exactly two callers ask to be instant — the restore on open, and the Jump to latest pill",
  );
  assert.ok(
    !/shouldSettleInstantly\([^)]*clientHeight/.test(pane),
    "no distance is passed to the predicate any more: distance decides how LONG, not whether",
  );
});

test("the motion NEVER exceeds the comfortable rate, which is what 'smooth' means here", () => {
  /*
   * THE TEST THAT WOULD HAVE CAUGHT THE REPORTED DEFECT, and the one the previous suite was missing.
   *
   * "When the transcript moves vertically, it is abrupt… the user's eye is lost." Measured against the old
   * implementation that was precise: an ease of 0.35 with a 28px/frame cap moved a 100px paragraph arrival at a
   * PEAK of 1680 px/sec — 24 times the top of comfortable reading. The old tests passed throughout, because every
   * one of them asserted a bound on the STEP or the FRAME COUNT and none asserted a bound on the SPEED.
   *
   * A per-frame bound cannot express this: 28px/frame IS 1680 px/sec. The unit was the bug, so the assertion is in
   * the unit that matters — px per second — and it holds for every distance, which is the property.
   */
  const SPEED = TAIL_MAX_SPEED_PX_PER_SEC;
  const peakOf = (distance: number): number => {
    const steps = glide(distance).map((entry) => Math.abs(entry.step));
    return Math.max(...steps) / (FRAME_MS / 1000);
  };

  for (const distance of [1.5, 12, 99, 233, 581, 900, 5000]) {
    const peak = peakOf(distance);
    assert.ok(
      peak <= SPEED + 1,
      `a ${distance}px arrival peaked at ${peak.toFixed(0)} px/sec, above the ${SPEED} px/sec budget`,
    );
  }

  /*
   * AND THE ASSERTION MUST BE ABLE TO FAIL ON THE EASE, which is the subtle half.
   *
   * Reverting the ease to 0.35 leaves every other test green, because above ~12px the CAP is the binding
   * constraint and the ease never gets to matter. Measured: at 20px both eases produce exactly the cap, so
   * probing there proves nothing about the curve.
   *
   * The ease is only observable BELOW the cap, where it decides the whole step. At 5px of remaining distance an
   * ease of 0.35 moves 1.75px in one frame (105 px/sec) against the gentler 0.18 at 0.9px (54 px/sec) - nearly
   * double, on the small arrivals that happen constantly during a steady stream. That is the band pinned here.
   */
  const easeBound = peakOf(5);
  const easeMessage = "a 5px arrival peaked at " + easeBound.toFixed(0) + " px/sec; the cap is " + SPEED +
    ", so this only passes when the EASE is gentle. A 0.35 ease gives about 105 px/sec here.";
  assert.ok(easeBound < SPEED * 0.6, easeMessage);
});