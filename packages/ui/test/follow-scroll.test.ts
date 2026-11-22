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
  FOLLOW_DEFAULTS,
  followConfig,
  resetFollowConfig,
  setFollowConfig,
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

test("a steady stream keeps up: the lag converges instead of growing", () => {
  /*
   * WHAT "KEEPS UP" MEANS NOW, and why the old assertion was replaced rather than retuned.
   *
   * The previous version opened with "1.5px of remaining distance must settle within 8 frames". That is true of
   * a steep easing curve and false of a gentle one, so it was not measuring keeping-up — it was measuring gain.
   * The shipped curve is gentle on purpose (ease 0.035), so text glides instead of snapping, and a single
   * frame deliberately covers only a small part of the remaining distance.
   *
   * The property that actually matters is that the lag REACHES A FIXED POINT. If a steady arrival were outrunning
   * the tail, the backlog would grow without bound and the viewport would fall further behind every second until
   * it was held at a cap forever. If it converges, the newest line sits at a constant distance below the fold and
   * the motion is steady. Everything below is that, asserted as a fixed point rather than as a frame count.
   *
   * Falsified by raising the arrival rate above what the curve can absorb: at 1000 chars/frame the backlog grows
   * for as long as the loop runs and the assertion fails on the drift.
   */
  for (const charsPerFrame of [2, 4, 5, 8, 16]) {
    // ~80 characters to a prose line, one line ~23.25px.
    const arrivalPx = (charsPerFrame / 80) * 23.25;
    let remaining = 0;
    let atHalf = 0;
    for (let frame = 1; frame <= 1200; frame += 1) {
      remaining += arrivalPx;
      remaining -= tailStep(remaining);
      if (frame === 600) atHalf = remaining;
    }
    assert.ok(
      Math.abs(remaining - atHalf) < 0.01,
      `at ${charsPerFrame} chars/frame the lag drifted from ${atHalf.toFixed(2)}px to ` +
        `${remaining.toFixed(2)}px — the tail is falling behind, not following`,
    );
    /*
     * The lag grows with the arrival rate, which is expected: a proportional controller cannot have zero error
     * while its input keeps rising. So only CONVERGENCE is asserted at every rate, above.
     *
     * At 16 chars/frame (~960 chars/s) the fixed point is 71px, about three prose lines. That is the honest ceiling
     * of this curve, recorded rather than hidden: the tuning was confirmed good to ~300 chars/s, and a model
     * streaming three times that rate keeps the newest line further below the fold. Asserting two lines at every
     * rate would be asserting a number the curve does not produce.
     */
    if (charsPerFrame <= 5) {
      // ~300 chars/s is the fastest rate confirmed correct; its fixed point is 30px.
      assert.ok(
        remaining < 34.9,
        `at ${charsPerFrame} chars/frame the tail settles ${remaining.toFixed(1)}px behind, over 1.5 prose lines`,
      );
    }
  }

  // A step must never overshoot the target, at any distance: that would be a visible bounce.
  for (const perFrame of [0.5, 1.5, 5, 20, 23.25]) {
    assert.ok(
      Math.abs(tailStep(perFrame)) <= perFrame,
      `a ${perFrame}px remaining distance must never be stepped PAST the target`,
    );
  }
});

test("settle time is monotonic in arrival size, which is what makes the motion predictable", () => {
  /*
   * THE DEFECT THIS REPLACED A WEAKER CLAIM TO CATCH.
   *
   * The old assertion was "2000px must take more than 10x as long as 12px". That held for a curve whose settle
   * time was roughly proportional to distance, and it says nothing about whether the motion is PREDICTABLE.
   *
   * Monotonicity does. With the previously shipped constants (ease 0.22, burst 0.9, ramp 28px) a 26px arrival
   * settled in 133ms while a 25px arrival took 150ms: the fraction jumped as the ramp saturated, so a LARGER
   * arrival finished FASTER. No single step was large, so nothing looked broken frame by frame — the motion just
   * read as erratic, which is the complaint this whole ADR exists to answer. Reverting to those constants fails
   * this test on the 26px case.
   *
   * The bound is a consequence, not a target: the per-frame cap floors a large settle at distance/cap frames.
   */
  const sizes = [4, 8, 12, 20, 24, 25, 26, 28, 40, 99, 233, 581, 2000];
  let previous = 0;
  for (const size of sizes) {
    const frames = glide(size).length;
    assert.ok(
      frames >= previous,
      `a ${size}px arrival settles in ${frames} frames, faster than the smaller arrival before it ` +
        `(${previous}) — settle time must never invert`,
    );
    previous = frames;
  }

  /*
   * And a distance no real session produces still terminates in bounded time rather than grinding.
   *
   * 2000px is not an arrival this app has: a token stream delivers ~4 characters per frame. It is here as a
   * guard on the curve, and 300 frames (5s) is the point at which a glide would read as a drag.
   */
  assert.ok(
    glide(2000).length < 300,
    `2000px took ${(glide(2000).length * FRAME_MS / 1000).toFixed(1)}s, which is a drag rather than a slide`,
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


test("tuning is clamped, so a slider cannot break the scroller", () => {
  /*
   * The parameters are now settable at runtime, which is the point: four fixed curves were each reported wrong
   * from the harness, and the values are taste. But a slider is a source of nonsense — a zero ceiling divides the
   * settle by zero, and a NaN propagates into scrollTop where a browser reads it as 0 and sends the reader to the
   * TOP of the transcript.
   *
   * So the setter clamps rather than trusts, and the defaults are restored afterwards so the rest of the suite
   * sees the shipped values.
   */
  try {
    setFollowConfig({ maxStepPx: 0 });
    assert.ok(followConfig.maxStepPx > 0, "a zero ceiling must be refused");
    setFollowConfig({ maxStepPx: -5 });
    assert.ok(followConfig.maxStepPx > 0, "so must a negative one");
    setFollowConfig({ maxStepPx: Number.NaN });
    assert.ok(Number.isFinite(followConfig.maxStepPx), "and a NaN");
    setFollowConfig({ ease: 0 });
    assert.ok(followConfig.ease > 0, "a zero fraction would never move");
    setFollowConfig({ ease: 5 });
    assert.ok(followConfig.ease <= 1, "a fraction above 1 would overshoot the target");

    // A legal value IS applied, or the panel would be decoration.
    setFollowConfig({ maxStepPx: 40 });
    assert.equal(followConfig.maxStepPx, 40, "a legal value must be applied");
    assert.ok(Math.abs(tailStep(1000)) <= 40.01, "and the step must respect it immediately");
  } finally {
    resetFollowConfig();
  }
  assert.deepEqual({ ...followConfig }, { ...FOLLOW_DEFAULTS }, "reset restores every shipped value");
});