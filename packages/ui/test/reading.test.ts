/**
 * The reader's transcript settings (issue #134).
 *
 * The whole point of this slice is that the number is **not decided by the app**. Two things therefore have
 * to be true and are asserted here rather than trusted:
 *
 *   1. the defaults are exactly what shipped, so a reader who never opens Settings sees no change;
 *   2. a corrupt stored value degrades to those defaults, never to a broken transcript.
 */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  READING_MEASURE_DEFAULT,
  READING_MEASURE_FILL,
  READING_MEASURE_MAX,
  READING_MEASURE_MIN,
  READING_SIZE_DEFAULT,
  READING_SIZE_MAX,
  READING_SIZE_MIN,
  READING_TAIL_DEFAULT,
  READING_TAIL_FOOT,
  READING_TAIL_MIDDLE,
  READING_TAIL_SPACE,
  clampReadingMeasure,
  clampReadingSize,
  clampReadingTail,
  defaultReadingPrefs,
  parseReadingPrefs,
  readingStyle,
  serializeReadingPrefs,
} from "../src/reading.ts";

test("the defaults are the shipped look", () => {
  /*
   * The acceptance criterion: a reader who touches nothing gets the designed default, not a surprise.
   *
   * The measure was 72ch — the classic book measure — and was raised to 80 when the transcript gained a companion
   * column. 72 is right for a page of prose; a transcript is dense with code, paths and tables, where wrapping is
   * what makes it hard to scan, so a wider line reads better and the space beside it is no longer empty.
   *
   * The assertion names the CURRENT number rather than a variable, because "the default is X" is the claim; the
   * range and clamping tests below cover the behaviour of the setting itself.
   */
  assert.deepEqual(defaultReadingPrefs(), { sizePx: 15, measure: 80, tail: READING_TAIL_MIDDLE });
  assert.equal(READING_SIZE_DEFAULT, 15);
  assert.equal(READING_MEASURE_DEFAULT, 80);
  /*
   * The tail default is the ONE that deliberately departs from what shipped, and it is asserted in its own test
   * below rather than folded in here — a reader of this test should not have to work out which of three values is
   * the surprise. Everything in this block is "the typography is unchanged".
   */
});

test("the defaults turn into the CSS that was hard-coded before", () => {
  // The other half of "no change for a reader who does not touch it": the tokens must resolve to the same
  // declarations the stylesheet used to carry.
  assert.deepEqual(readingStyle(defaultReadingPrefs()), {
    "--reading-size": "15px",
    "--reading-measure": "80ch",
    /*
     * And the wide layout's three tracks (issue #275 follow-up). Asserted here rather than in the stylesheet because
     * they are DERIVED from the reader's one `measure` setting: the cap the prose obeys and the room the layout reserves
     * for it are the same number, which is what stops them drifting.
     */
    "--reading-leading": "minmax(0, 1fr)",
    "--reading-lane": "minmax(0, 80ch)",
    "--reading-trailing": "minmax(0, 1fr)",
    /*
     * The CEILING of the peek panel's track when it is open. `1fr` while centred, so the margin keeps absorbing space and
     * the lane does not move when there is room for the panel; under `fill` the margin is already a fixed track.
     */
    "--reading-trailing-max": "1fr",
    // Not hard-coded before: this is the ADR-0017 anchor, and the default holds the tail above the foot.
    "--tail-space": READING_TAIL_SPACE,
  });
});

test("a size outside the range is clamped, not accepted", () => {
  // A slider cannot produce these, but a hand-edited `localStorage` can — and a 200px transcript is a
  // broken app. Clamped rather than refused, because a preference is not worth an error dialog.
  assert.equal(clampReadingSize(1), READING_SIZE_MIN);
  assert.equal(clampReadingSize(999), READING_SIZE_MAX);
  assert.equal(clampReadingSize(Number.NaN), READING_SIZE_DEFAULT);
  assert.equal(clampReadingSize(15.6), 16, "whole pixels only");
});

test("a measure outside the range is clamped, and `fill` survives", () => {
  assert.equal(clampReadingMeasure(1), READING_MEASURE_MIN);
  assert.equal(clampReadingMeasure(999), READING_MEASURE_MAX);
  assert.equal(clampReadingMeasure(Number.NaN), READING_MEASURE_DEFAULT);
  // `fill` is a deliberate choice, not a number — it must pass through untouched.
  assert.equal(clampReadingMeasure(READING_MEASURE_FILL), READING_MEASURE_FILL);
});

test("`fill` means the column's width, which is `none` rather than a huge number", () => {
  // `none` lets the block take its container's width. A large `ch` value would look almost right and then be
  // wrong on a narrow window, where it would overflow instead of shrinking.
  assert.equal(
    readingStyle({ sizePx: 15, measure: READING_MEASURE_FILL, tail: READING_TAIL_DEFAULT })["--reading-measure"],
    "none",
  );
});

test("a corrupt stored value falls back to the defaults", () => {
  // `localStorage` outlives upgrades and is shared with whatever else runs on this origin, so each of these
  // is reachable rather than hypothetical.
  for (const raw of [
    null,
    "",
    "not json",
    "[]",
    "null",
    JSON.stringify({ sizePx: "big", measure: [] }),
    JSON.stringify({ sizePx: null, measure: null }),
    JSON.stringify({ unrelated: true }),
  ]) {
    assert.deepEqual(parseReadingPrefs(raw), defaultReadingPrefs(), `for ${JSON.stringify(raw)}`);
  }
});

test("a stored value is honoured, and a partial one keeps the default for the rest", () => {
  assert.deepEqual(parseReadingPrefs(JSON.stringify({ sizePx: 17, measure: 88 })), {
    sizePx: 17,
    measure: 88,
    tail: READING_TAIL_MIDDLE,
  });
  // A partial value keeps the CURRENT default for the rest — a reader who stored only a size when the default was 72
  // gets the new default measure, which is what "the rest is my default" means. Asserted against the constant so a
  // future change to the default does not read as a regression here.
  assert.deepEqual(parseReadingPrefs(JSON.stringify({ sizePx: 17 })), {
    sizePx: 17,
    measure: READING_MEASURE_DEFAULT,
    tail: READING_TAIL_DEFAULT,
  });
  assert.deepEqual(parseReadingPrefs(JSON.stringify({ measure: "fill" })), {
    sizePx: 15,
    measure: "fill",
    tail: READING_TAIL_DEFAULT,
  });
  /*
   * A stored preference from BEFORE this field existed has no `tail`, and gets the new default. That is the
   * upgrade path for every reader who has ever opened Settings, so it is asserted rather than assumed.
   */
  assert.equal(parseReadingPrefs(JSON.stringify({ sizePx: 13 })).tail, READING_TAIL_MIDDLE);
});

test("the stored form round-trips", () => {
  for (const prefs of [
    { sizePx: 15, measure: 72, tail: READING_TAIL_MIDDLE },
    { sizePx: 13, measure: 50, tail: READING_TAIL_FOOT },
    { sizePx: 18, measure: READING_MEASURE_FILL, tail: READING_TAIL_DEFAULT },
  ] as const) {
    assert.deepEqual(parseReadingPrefs(serializeReadingPrefs(prefs)), prefs);
  }
});

test("the stylesheet reads the tokens rather than the constants", () => {
  // A future hard-coding would silently ignore the setting — the control would move and nothing would
  // change. Asserted on the source, because that is where the decision lives.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = (sel: string) =>
    new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(css)?.[1] ?? "";
  assert.match(rule(".prose"), /font-size:\s*var\(--reading-size\)/, "the prose reads the size token");
  assert.match(rule(".measure"), /max-width:\s*var\(--reading-measure\)/, "the measure reads the token");
  // And `--fs-md` must NOT be the reading size: it is used by headings, dialogs and the composer, so the
  // preference would resize the whole application.
  assert.ok(!/--fs-md:\s*var\(--reading-size\)/.test(css), "the reading size must not drive --fs-md");
});

test("the newest line is held above the foot by padding on the lane (ADR-0016)", () => {
  /*
   * THE ANCHOR, AS THREE SEPARATE CLAIMS, because each one fails differently.
   *
   * Reported: "the tail is still foot, not middle". The preference existed in the ADR and in no code, so nothing
   * moved. These assertions are the mechanism, and they are the ones that would have caught its absence.
   *
   * Falsified by each of the three: remove `padding-bottom` from `.transcript-lane` and the first fails; move the
   * sentinel inside the lane and the second fails; replace the padding with a spacer div and the third fails.
   */
  const dir = new URL("../", import.meta.url);
  const css = readFileSync(new URL("src/styles.css", dir), "utf8");

  /*
   * 1. PADDING, not margin and not a spacer.
   *
   * Margin at the end of a scroll container collapses and leaves the space OUTSIDE the scrollable area, which is
   * indistinguishable from no space at all — the tail would still sit at the foot. A spacer element would be a new
   * child of the lane, and the lane's child-count rules would be correct for N and wrong at N+1 (C20).
   */
  const lane = /\.transcript-lane \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(lane.length > 0, ".transcript-lane has a rule");
  assert.match(
    lane,
    /padding-bottom:\s*var\(--tail-space/,
    "the lane reserves the anchor as PADDING — margin would collapse out of the scrollable area",
  );
  assert.ok(!/margin-bottom/.test(lane), "and never as margin, for the reason above");

  /*
   * 2. The end sentinel is the LAST CHILD OF THE SCROLLER, after the lane.
   *
   * Both follow paths are "go to maximum scroll", and that lands below the padding only because the padding is
   * content ABOVE the sentinel. A sentinel placed inside the lane would anchor to the padding's own end and
   * reproduce the complaint exactly.
   */
  const component = readFileSync(new URL("src/components/Transcript.tsx", dir), "utf8");
  const laneOpen = component.indexOf('<div className="transcript-lane"');
  const sentinel = component.indexOf("<div ref={endRef} />");
  assert.ok(laneOpen > 0, "the lane is rendered");
  assert.ok(sentinel > 0, "the end sentinel is rendered");

  /*
   * Walk forward from the lane's opening tag counting `<div` and `</div>`. When the depth returns to zero we are at
   * the lane's OWN closing tag, however deeply its children nest. The sentinel must come after that.
   *
   * A search for the nearest preceding `</div>` was tried first and is not a check: the sentinel's own indent makes
   * several closing tags equidistant, so moving the sentinel inside the lane still "passed". This version fails when
   * it is moved, which is the only reason to keep it.
   */
  let depth = 0;
  let laneClose = -1;
  for (let index = laneOpen; index < component.length; index += 1) {
    if (component.startsWith("<div", index)) depth += 1;
    else if (component.startsWith("</div>", index)) {
      depth -= 1;
      if (depth === 0) {
        laneClose = index;
        break;
      }
    }
  }
  assert.ok(laneClose > 0, "the lane's closing tag can be located");
  assert.ok(
    sentinel > laneClose,
    "the sentinel follows the lane's closing tag: it is the last child of the SCROLLER, not of the lane",
  );

  /*
   * 3. The space is driven by a preference, and `foot` turns it off without removing the mechanism.
   *
   * One code path decides the anchor, so the stylesheet never needs a conditional and `foot` cannot drift into a
   * second definition of "no anchor".
   */
  assert.equal(readingStyle({ sizePx: 15, measure: 80, tail: READING_TAIL_FOOT })["--tail-space"], "0px");
  assert.equal(
    readingStyle({ sizePx: 15, measure: 80, tail: READING_TAIL_MIDDLE })["--tail-space"],
    READING_TAIL_SPACE,
  );
  // And the stylesheet has a fallback, so the anchor holds before the preference is read on first paint.
  assert.match(css, /--tail-space:\s*min\(35vh, 24rem\)/, "the token defaults in the stylesheet too");
});