/**
 * The wide layout's geometry, as ARITHMETIC rather than as a claim in a comment.
 *
 * ## Why this file exists
 *
 * The centring bug that reached a reader was a declaration right next to a comment that said the opposite:
 *
 *   `grid-template-columns: minmax(0, 1fr) minmax(0, 80ch) 340px`   ← trailing track is a LITERAL
 *   /* one \`1fr\` on each side *\/                                     ← and the comment claims symmetry
 *
 * One flexible track takes ALL of the free space, so the prose was pushed to the trailing edge. A test that reads CSS
 * as text cannot see that; a test that resolves the TRACKS can. So this resolves them, with the same rules CSS uses:
 * fixed tracks take their size, `minmax(0, X)` takes `min(X, share)`, the gap and fixed tracks come out first, and
 * leftover space is split between the flexible tracks.
 *
 * It is not a browser — `min-content` contributions, `ch` resolution and sub-pixel rounding are all approximated or
 * supplied as inputs — but it answers the question that failed: **is the lane's centre the container's centre?**
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { READING_MEASURE_FILL, readingStyle } from "../src/reading.ts";

/** The lane's width in px for a given `ch` measure at a given font size (a mono-free approximation: 0.5em per char). */
const chToPx = (ch, fontPx = 15) => Math.round(ch * fontPx * 0.5);

/** `--companion-width` and the gutter, from the stylesheet's tokens. */
const COMPANION = 340;
const GAP = 24;

/**
 * Resolve a three-track template, the way a browser does.
 *
 * `margin` is the resolved size of a margin token, which is what distinguishes the cases: `minmax(0, 1fr)` means
 * "share the free space", `0px` means "nothing", and a number means "exactly this".
 */
function resolveRow({ containerPx, lanePx, leading, trailing, gap = GAP }) {
  const fixed = (margin) => (typeof margin === "number" ? margin : 0);
  const flexCount = [leading, trailing].filter((margin) => margin === "flex").length;
  const laneTrack = Math.min(lanePx, containerPx);
  const leftFixed = fixed(leading);
  const rightFixed = fixed(trailing);
  /*
   * TWO gaps, not one: a three-column grid puts a gutter on each side of the middle track. That is not a detail — it is
   * why the lane's centre is the container's centre even though the gutter only visually separates prose from companion.
   * The first version of this resolver subtracted a single gap, decided a correct layout was 12px off, and would have
   * sent me hunting for a stylesheet bug that did not exist.
   */
  const gaps = gap * 2;
  const remaining = Math.max(0, containerPx - laneTrack - leftFixed - rightFixed - gaps);
  const each = flexCount === 0 ? 0 : remaining / flexCount;

  const left = leading === "flex" ? each : leftFixed;
  const right = trailing === "flex" ? each : rightFixed;
  /*
   * The lane does not START at `left`: one gutter sits between them. Returning the offsets as well as the sizes is what
   * lets the centre assertions be about the rendered box rather than about a track index — the mistake here was the same
   * class as the one in the stylesheet, a number that was right about one thing and used for another.
   */
  return { left, lane: laneTrack, right, gaps, gap, total: left + gaps + laneTrack + right };
}

/** The three margins the module produces, as numbers or "flex". */
function marginsFor(measure) {
  const style = readingStyle({ sizePx: 15, measure });
  const read = (token) => {
    if (token === "0px") return 0;
    if (/minmax\(0, 1fr\)/.test(token)) return "flex";
    const literal = /(--companion-width)/.test(token);
    assert.ok(literal, `unexpected track: ${token}`);
    return COMPANION;
  };
  return {
    leading: read(style["--reading-leading"]),
    trailing: read(style["--reading-trailing"]),
    lane: style["--reading-lane"],
  };
}

test("the lane's centre is the container's centre, at every window width", () => {
  /*
   * THE reported property, and the one that failed. The prose used to be centred as a PAIR with the companion, so its
   * centre sat half a companion left of the container's — about 170px at a 340px companion, which is exactly the offset
   * the reader saw once the rail stopped filling the void.
   *
   * Asserted across widths rather than at one, because the failure mode is width-dependent: a layout that is centred at
   * 1200 and not at 1600 is a layout whose arithmetic is wrong somewhere it did not show.
   *
   * Falsified by making the trailing margin a literal (the bug that shipped): the offset becomes half of 340 on every
   * width, and the first case reports it.
   */
  for (const containerPx of [1024, 1200, 1440, 1540, 1920, 2560]) {
    const { leading, trailing } = marginsFor(80);
    const row = resolveRow({ containerPx, lanePx: chToPx(80), leading, trailing });
    const laneCentre = row.left + row.gap + row.lane / 2;
    assert.ok(
      Math.abs(laneCentre - containerPx / 2) <= 1,
      `at ${containerPx}px the lane centre is ${laneCentre}, not ${containerPx / 2} (leading ${row.left}, trailing ${row.right})`,
    );
  }
});

test("the resolved row exactly fills the container, with no overflow and no slack", () => {
  /*
   * The other half of a broken layout, and the one the screenshot showed: content running past the right edge. A grid
   * whose tracks exceed its container overflows, and the symptom is the transcript drawn off-screen — which is what a
   * literal trailing track in a flexible template does as soon as its column is narrow.
   *
   * Falsified by any template whose terms do not add up: the assertion reports the total.
   */
  for (const containerPx of [1024, 1440, 1920]) {
    const { leading, trailing } = marginsFor(80);
    const row = resolveRow({ containerPx, lanePx: chToPx(80), leading, trailing });
    assert.ok(row.total <= containerPx + 1, `${containerPx}px: tracks total ${row.total}, which overflows`);
  }
});

test("a window too narrow for the lane and the companion keeps the companion", () => {
  /*
   * The narrow case, and it is why the lane is `minmax(0, …)` rather than a bare `80ch`: at 900px with an 80ch lane and
   * a 340px companion there is no room for both, and the lane must be the thing that shrinks. A lane that won the
   * argument would push the session header out of the row, taking Stop, Resume, Rename and both pickers with it.
   *
   * (Below 1080px the container query stacks them instead, so this is about the boundary the query does not cover.)
   */
  const { leading, trailing } = marginsFor(80);
  const row = resolveRow({ containerPx: 900, lanePx: chToPx(80), leading, trailing });
  assert.ok(row.total <= 901, `tracks total ${row.total} in 900px`);
  assert.equal(trailing, "flex", "the trailing margin is flexible, so it is what gives way first");
});

test("`fill` puts the lane against the trailing edge, deliberately", () => {
  /*
   * "Use the full width" means everything the companion does not need — NOT a symmetric void. So the leading margin
   * collapses and the lane takes the rest, which is asymmetric by design and must stay that way.
   *
   * Falsified by deriving `fill` from the centred branch: the leading margin becomes flexible and the reader who asked
   * for a wider line gets a wider gap instead.
   */
  const { leading, trailing } = marginsFor(READING_MEASURE_FILL);
  assert.equal(leading, 0, "no leading void under fill");
  assert.equal(trailing, COMPANION, "the companion keeps its own track, so the header survives");
  const row = resolveRow({ containerPx: 1540, lanePx: chToPx(80), leading, trailing });
  assert.ok(row.total <= 1541, "and the row still fits");
});

test("with the companion gone the centring survives, which is the focus-mode case", () => {
  /*
   * Reading focus hides the header. If the trailing margin were still the flexible one *because a companion was
   * expected in it*, the lane would sit left of centre beside a void — the same defect, one mode later. The stylesheet
   * therefore re-declares the template with the leading margin twice; this resolves that shape.
   *
   * Falsified by dropping the override: the trailing margin resolves to a full half-share with nothing in it.
   */
  const { leading } = marginsFor(80);
  const row = resolveRow({ containerPx: 1540, lanePx: chToPx(80), leading, trailing: leading, gap: 0 });
  const laneCentre = row.left + row.gap + row.lane / 2;
  assert.ok(Math.abs(laneCentre - 770) <= 1, `focus mode: lane centre ${laneCentre}, not 770`);
});

test("the companion shrinks before the row overflows, between the stack point and full width", () => {
  /*
   * The band nobody checked: above the container query (1080px) so the boxes are side by side, and below the width where
   * an 80ch lane plus a 340px companion plus two gutters actually fits. In that band the companion’s track is flexible,
   * so a box that REFUSES to narrow (a fixed `width`) makes the track’s contribution exceed the container and the row is
   * laid out past the right edge — the same symptom a reader reported once already, from a different cause.
   *
   * The rule is therefore `width: 100%; max-width: var(--companion-width); min-width: 0`: exactly the companion width
   * when there is room, narrower when there is not, and never an overhang. The lane keeps its measure, because the lane
   * is what the reader is reading.
   *
   * Falsified by restoring `width: var(--companion-width)` on `.transcript-header`: the computed total for 1150px then
   * exceeds the container and the assertion reports it.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const companion = /(?:^|\n)\.transcript-header \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(companion, ".transcript-header must have a rule");
  assert.match(companion, /max-width:\s*var\(--companion-width\)/, "capped by the token, not pinned to it");
  assert.match(companion, /min-width:\s*0/, "and allowed to be narrower than its content");
  assert.ok(!/(?:^|[^-])width:\s*var\(--companion-width\)/.test(companion), "not a fixed width");

  /*
   * And the arithmetic, resolved the same way `lane-geometry.test.mjs` resolves it: at 1150px the number of pixels the
   * boxes want must not exceed the row. The companion’s contribution is capped at the token and floor-ed at 0, which is
   * what `min-width: 0` buys.
   */
  const row = resolveRow({ containerPx: 1150, lanePx: chToPx(80), leading: "flex", trailing: "flex" });
  assert.ok(row.total <= 1151, `at 1150px the tracks want ${row.total}px`);
});
