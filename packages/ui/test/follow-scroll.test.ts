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
  TAIL_BURST_FRACTION,
  TAIL_MAX_STEP_PX,
  TAIL_EASE,
  TAIL_RAMP_SPAN_PX,
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

test("NO frame ever moves more than one line, at any distance", () => {
  /*
   * THE ASSERTION THAT WOULD HAVE SAVED FOUR ROUNDS, and the one every earlier version lacked.
   *
   * Each previous fix bounded something else — per-second rate, total settle time, a burst fraction — and each
   * let a SINGLE frame move 15 lines. Bounding the duration of a settle does not bound its frames: a fast settle
   * necessarily contains fast frames. Reported from the harness as "bursty and huge are constantly red", with the
   * probe measuring 21613 px/sec on the first frame of a 581px arrival.
   *
   * So the assertion is per frame, at every distance, because that is the unit the eye actually sees. The settle
   * TIME is a consequence and is deliberately not asserted as a target.
   */
  for (const distance of [2, 12, 99, 233, 581, 1163, 2000]) {
    const steps = glide(distance);
    for (const [index, entry] of steps.entries()) {
      assert.ok(
        Math.abs(entry.step) <= TAIL_MAX_STEP_PX + 0.01,
        `${distance}px arrival moved ${Math.abs(entry.step).toFixed(1)}px on frame ${index}` +
          `, above the ${TAIL_MAX_STEP_PX}px (one line) ceiling`,
      );
    }
    assert.equal(steps.at(-1)?.remaining, 0, `${distance}px must still arrive exactly`);
  }
});

test("a BURST takes longer than a trickle, which is the correct tradeoff", () => {
  /*
   * The consequence, asserted so it is not mistaken for a regression later: keeping every frame under a line
   * means a large arrival takes real time. 581px is ~25 frames (0.4s) and 2000px is ~90 (1.5s).
   *
   * That is a deliberate choice between two bad options, and the reason is stated where the constant is: a jump
   * the eye cannot follow, or a slide it can. The slide wins, and the cost is paid in time rather than in
   * comprehension.
   */
  const small = glide(12).length;
  const large = glide(2000).length;
  assert.ok(large > small * 10, `2000px must take far longer than 12px; got ${large} vs ${small} frames`);
  assert.ok(
    large < 120,
    `2000px took ${large} frames (${(large * FRAME_MS / 1000).toFixed(1)}s), which is a drag rather than a slide`,
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

