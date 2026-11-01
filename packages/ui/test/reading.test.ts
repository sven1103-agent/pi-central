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
  clampReadingMeasure,
  clampReadingSize,
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
  assert.deepEqual(defaultReadingPrefs(), { sizePx: 15, measure: 80 });
  assert.equal(READING_SIZE_DEFAULT, 15);
  assert.equal(READING_MEASURE_DEFAULT, 80);
});

test("the defaults turn into the CSS that was hard-coded before", () => {
  // The other half of "no change for a reader who does not touch it": the tokens must resolve to the same
  // declarations the stylesheet used to carry.
  assert.deepEqual(readingStyle(defaultReadingPrefs()), {
    "--reading-size": "15px",
    "--reading-measure": "80ch",
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
  assert.equal(readingStyle({ sizePx: 15, measure: READING_MEASURE_FILL })["--reading-measure"], "none");
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
  assert.deepEqual(parseReadingPrefs(JSON.stringify({ sizePx: 17, measure: 88 })), { sizePx: 17, measure: 88 });
  // A partial value keeps the CURRENT default for the rest — a reader who stored only a size when the default was 72
  // gets the new default measure, which is what "the rest is my default" means. Asserted against the constant so a
  // future change to the default does not read as a regression here.
  assert.deepEqual(parseReadingPrefs(JSON.stringify({ sizePx: 17 })), {
    sizePx: 17,
    measure: READING_MEASURE_DEFAULT,
  });
  assert.deepEqual(parseReadingPrefs(JSON.stringify({ measure: "fill" })), { sizePx: 15, measure: "fill" });
});

test("the stored form round-trips", () => {
  for (const prefs of [
    { sizePx: 15, measure: 72 },
    { sizePx: 13, measure: 50 },
    { sizePx: 18, measure: READING_MEASURE_FILL },
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
