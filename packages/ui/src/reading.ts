/**
 * The reader's transcript settings (issue #134).
 *
 * ## Why this exists
 *
 * *"The transcript looks lost on bigger screens"* was answered once by centring the column (#92), which
 * produced five defects and was reverted (#132, #133). The honest reading was that this is a **preference**:
 * 80ch at 15px is comfortable on a 13" laptop and cramped on a 27" display, and there is no single right
 * number.
 *
 * So the number is not decided by the app. It is set by the reader and remembered.
 *
 * ## Two numbers, and why `ch` and `px` interact
 *
 * `--reading-size` is in px and `--reading-measure` in `ch`. `1ch` is the width of `"0"` in the element's
 * own font, so raising the text size **also widens the measure proportionally** — which is what "make the
 * text bigger" means to a person. Worth stating in the panel, because it is the opposite of how two
 * separate sliders usually behave.
 *
 * ## Deliberately NOT settable
 *
 * Alignment. Centring versus left is the thing that failed, and offering it as a toggle would invite the
 * same five defects back at every setting.
 */

/** The transcript's text size, in px. */
export const READING_SIZE_MIN = 13;
export const READING_SIZE_MAX = 18;
export const READING_SIZE_DEFAULT = 15;

/** The line length, in `ch`. `"fill"` is a deliberate option: some readers want the column's width. */
export const READING_MEASURE_MIN = 50;
export const READING_MEASURE_MAX = 100;
/**
 * 80, raised from 72.
 *
 * 72ch is the classic book measure and it is right for a page of prose with no other content. A transcript is not
 * that: it is dense with code, paths and tables, which read better on a wider line because wrapping is what makes
 * them hard to scan — and the column now has a companion beside it, so a wider lane uses space that was empty.
 *
 * Still a DEFAULT, not a decision: the reader can move it from 50 to 100, or set `fill`.
 */
export const READING_MEASURE_DEFAULT = 80;

/** A stored measure may also be this, which is not a number. */
export const READING_MEASURE_FILL = "fill";

export interface ReadingPrefs {
  sizePx: number;
  /** A `ch` value, or `fill` for the column's full width. */
  measure: number | typeof READING_MEASURE_FILL;
}

export const READING_PREFS_KEY = "pi-central.reading";

export function defaultReadingPrefs(): ReadingPrefs {
  // Exactly what shipped, so a reader who never opens Settings sees no change — the acceptance criterion.
  return { sizePx: READING_SIZE_DEFAULT, measure: READING_MEASURE_DEFAULT };
}

/** Clamp a size to the offered range, and to whole pixels. */
export function clampReadingSize(sizePx: number): number {
  if (!Number.isFinite(sizePx)) return READING_SIZE_DEFAULT;
  return Math.min(READING_SIZE_MAX, Math.max(READING_SIZE_MIN, Math.round(sizePx)));
}

/** Clamp a measure, preserving `fill`. */
export function clampReadingMeasure(measure: number | string): number | typeof READING_MEASURE_FILL {
  if (measure === READING_MEASURE_FILL) return READING_MEASURE_FILL;
  const value = Number(measure);
  if (!Number.isFinite(value)) return READING_MEASURE_DEFAULT;
  return Math.min(READING_MEASURE_MAX, Math.max(READING_MEASURE_MIN, Math.round(value)));
}

/**
 * Read remembered settings, discarding anything not recognised.
 *
 * Every field validated rather than trusted, for the reason `panel.ts` gives: `localStorage` outlives
 * upgrades and is shared with whatever else runs on this origin. A stored `"sizePx": "big"` is a reachable
 * value, not a hypothetical one, and a corrupt preference must degrade to the default rather than to a
 * broken transcript.
 */
export function parseReadingPrefs(raw: string | null): ReadingPrefs {
  const fallback = defaultReadingPrefs();
  if (raw === null || raw === "") return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;
  const record = parsed as Record<string, unknown>;
  return {
    sizePx: clampReadingSize(typeof record["sizePx"] === "number" ? record["sizePx"] : fallback.sizePx),
    measure: clampReadingMeasure(
      typeof record["measure"] === "number" || typeof record["measure"] === "string"
        ? (record["measure"] as number | string)
        : fallback.measure,
    ),
  };
}

/**
 * The width of the grid track the prose sits in, for a given measure.
 *
 * ## Why this is arithmetic and not `${measure}ch`
 *
 * A grid track must be a LENGTH, and the two settings are not the same expression:
 *
 *   - a `ch` measure is already a length, so the lane's track is exactly the prose's cap and the margin tracks beside
 *     it are equal — the prose is centred, which is the whole point;
 *   - `fill` means "the column's width", which is NOT the container's. Writing `100%` there makes the middle track take
 *     the entire row and **pushes the companion out of the grid** — a reachable state (the `fill` checkbox is in
 *     Settings; the companion holds Stop, Resume, Rename and the pickers) in which asking for a wider line loses the run
 *     controls.
 *
 * So `fill` reserves everything except the companion and the gutter. `--companion-width` and `--reading-gap` are the
 * same two terms the row's template uses, which is why they are tokens rather than literals.
 */
function laneWidth(measure: ReadingPrefs["measure"]): string {
  if (measure !== READING_MEASURE_FILL) return `${measure}ch`;
  return `calc(100% - var(--companion-width) - var(--reading-gap))`;
}

/**
 * The track that sits on each SIDE of the lane.
 *
 * ## Why this is a token and not a literal `1fr`
 *
 * Two equal tracks split the free space, and equal free space is what "centred" means here — that is the whole fix for
 * the reported defect. But under `fill` there IS no free space to split: the lane already occupies everything left of
 * the companion, so a flexible track on each side would resolve to zero-width *ideal* and then be given a share of the
 * row anyway, pushing the companion past the container's edge by however much they received.
 *
 * `minmax(0, 1fr)` (centred) and `0px` (filling) are therefore two different answers to the same question, and they
 * belong together with `laneWidth` — one place that decides the row's arithmetic, tested without a browser.
 */
function laneMargin(measure: ReadingPrefs["measure"]): string {
  return measure === READING_MEASURE_FILL ? "0px" : "minmax(0, 1fr)";
}

/** Serialize for `localStorage`. Beside `parseReadingPrefs` so the two cannot drift. */
export function serializeReadingPrefs(prefs: ReadingPrefs): string {
  return JSON.stringify(prefs);
}

/**
 * The CSS declarations a pref set turns into.
 *
 * Returned as data rather than applied here, so the mapping is testable without a DOM — and so there is one
 * place that decides what a size and a measure *mean* in CSS.
 */
export function readingStyle(prefs: ReadingPrefs): Record<string, string> {
  return {
    "--reading-size": `${prefs.sizePx}px`,
    "--reading-measure": prefs.measure === READING_MEASURE_FILL ? "none" : `${prefs.measure}ch`,
    /*
     * The SAME width for the layout that has to reserve room for the lane.
     *
     * `--reading-measure` is a `max-width` on the prose, which a flex row cannot use: an item narrower than its track
     * leaves the rest to `justify-content`, and that is exactly the "the pair is centred, the prose is not" defect
     * (the prose sat ~180px left of the window's centre with the rail away). A LENGTH is what makes the lane's track
     * measurable, so `[1fr] [lane] [1fr]` can put one `1fr` on each side of it.
     *
     * One preference, two declarations, both derived here — so the cap the prose obeys and the room the layout reserves
     * cannot disagree. Two numbers kept in step by hand is how `--reading-measure` and a literal drifted before.
     */
    "--reading-lane": laneWidth(prefs.measure),
    "--reading-margin": laneMargin(prefs.measure),
  };
}
