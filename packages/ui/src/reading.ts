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

/**
 * WHERE THE NEWEST LINE SITS (ADR-0017).
 *
 * The report: *"the newest line is pinned to the window's foot; I want it in the upper or middle half."* A
 * transcript that ends flush with the composer makes the reader hunt for the newest line at the bottom edge of a
 * tall window, while their eyes rest near the middle of the screen.
 *
 * `"foot"` is exactly the behaviour that shipped, so the choice is reversible by the reader without a build.
 */
export const READING_TAIL_MIDDLE = "middle";
export const READING_TAIL_FOOT = "foot";
export type ReadingTail = typeof READING_TAIL_MIDDLE | typeof READING_TAIL_FOOT;

/**
 * The default, and the reason it is not the shipped behaviour.
 *
 * ADR-0017 answers the stated requirement: the tail is held above the scroller's foot. `"foot"` stays available
 * because the padding below the last line is visible space, and on a short window it can read as a rendering bug
 * rather than as breathing room — the escape hatch is why the default is safe to take.
 */
export const READING_TAIL_DEFAULT: ReadingTail = READING_TAIL_MIDDLE;

/**
 * How much room follows the last line when `tail` is `"middle"`.
 *
 * NOT MEASURED. ADR-0017 states this plainly: the capture it needs could not be taken in this environment, so this
 * is a starting number to be corrected from one screenshot, not a settled one. `min(35vh, 24rem)` holds the anchor
 * to a fraction of a short window instead of letting it swallow the viewport, and `24rem` stops it from growing
 * without limit on a tall display.
 */
export const READING_TAIL_SPACE = "min(35vh, 24rem)";

export interface ReadingPrefs {
  sizePx: number;
  /** A `ch` value, or `fill` for the column's full width. */
  measure: number | typeof READING_MEASURE_FILL;
  /** Where the newest line sits relative to the scroller's foot. */
  tail: ReadingTail;
}

export const READING_PREFS_KEY = "pi-central.reading";

export function defaultReadingPrefs(): ReadingPrefs {
  /*
   * Size and measure are exactly what shipped, so a reader who never opens Settings sees no change in the
   * typography — the acceptance criterion for #134.
   *
   * `tail` is the one default that DOES change what a reader sees, and deliberately: the anchor is the answer to
   * a stated requirement (ADR-0017). It is listed here rather than omitted so the departure is visible.
   */
  return { sizePx: READING_SIZE_DEFAULT, measure: READING_MEASURE_DEFAULT, tail: READING_TAIL_DEFAULT };
}

/** Validate a stored tail, degrading to the default rather than to a broken transcript. */
export function clampReadingTail(tail: unknown): ReadingTail {
  return tail === READING_TAIL_FOOT || tail === READING_TAIL_MIDDLE ? tail : READING_TAIL_DEFAULT;
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
    tail: clampReadingTail(record["tail"]),
  };
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
    ...laneTracks(prefs.measure),
    /*
     * The anchor, as one custom property rather than a padding declaration.
     *
     * ADR-0017 decided padding on `.transcript-lane` and NOT a spacer element: a spacer is a new child of the lane,
     * and the lane's own child-count rules then become correct-for-N (C20). Padding adds height without changing
     * what any child-count rule counts, and it sits above the end sentinel so "scroll to maximum" still lands below
     * the last line.
     *
     * Deliberately NOT part of `laneTracks`: that function decides the horizontal composition from the measure, and
     * the anchor is vertical and independent of it. Putting it there would have scoped the anchor to whichever
     * branch a future composition edit happened to leave behind, and it was in fact first merged into the wrong
     * branch — one of the two, so `fill` silently lost its anchor.
     *
     * `0px` for `"foot"` rather than removing the property, so exactly one code path decides the anchor and the
     * stylesheet never needs a conditional.
     */
    "--tail-space": prefs.tail === READING_TAIL_FOOT ? "0px" : READING_TAIL_SPACE,
  };
}

/**
 * The three grid tracks the wide layout puts around the prose lane.
 *
 * ## The defect these exist to make impossible
 *
 * The composition used to be `display: flex; justify-content: center` over TWO boxes — prose and a 340px companion — so
 * what was centred was the PAIR. The prose's own centre is therefore half a companion to the left of the pair's, which
 * is invisible while the rail shares the void and obvious the moment it does not: reported as *"without the session
 * list, the transcript is not centered anymore"*.
 *
 * A `max-width` item cannot be positioned inside its own flex track — the remainder belongs to the container — so the
 * lane needs a TRACK of its own, and the centring has to be arithmetic: equal space on each side.
 *
 * ## Why the two margins are ONE function and not two declarations
 *
 * The first attempt at this wrote `minmax(0, 1fr)` for the leading track and the companion's literal width for the
 * trailing one, with a comment claiming symmetry. One flexible track takes ALL of the free space, so the prose was
 * pushed to the right edge — a worse defect than the one being fixed, and one a reading of the code should have caught.
 * Both margins now come from `laneTracks`, so they cannot disagree, and `reading.test.ts` asserts the template names
 * the same token twice rather than checking a literal.
 *
 * ## Why `fill` is the asymmetric case
 *
 * `fill` means "use the column's width", i.e. everything the companion does not need — so its leading margin collapses
 * and the trailing track is exactly the companion. That is deliberately NOT centred: a reader who asked for the full
 * width asked for it on the left, not for a symmetric void on both sides.
 *
 * The lane is `minmax(0, 1fr)` under `fill` rather than `100%`: a `100%` track takes the whole row and pushes the
 * companion out of the grid entirely, which loses Stop, Resume, Rename and both pickers.
 */
function laneTracks(measure: ReadingPrefs["measure"]): Record<string, string> {
  if (measure === READING_MEASURE_FILL) {
    return {
      "--reading-leading": "0px",
      "--reading-lane": "minmax(0, 1fr)",
      "--reading-trailing": "var(--companion-width)",
      "--reading-trailing-max": "var(--companion-width)",
    };
  }
  /*
   * CENTRED: one flexible margin on each side, and the lane capped by the reader's measure. The two margins are the
   * same token because they must be the same width — that equality IS the centring.
   */
  return {
    "--reading-leading": "minmax(0, 1fr)",
    "--reading-lane": `minmax(0, ${measure}ch)`,
    "--reading-trailing": "minmax(0, 1fr)",
    "--reading-trailing-max": "1fr",
  };
}
