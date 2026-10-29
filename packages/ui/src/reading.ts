/**
 * The reader's transcript settings (issue #134).
 *
 * ## Why this exists
 *
 * *"The transcript looks lost on bigger screens"* was answered once by centring the column (#92), which
 * produced five defects and was reverted (#132, #133). The honest reading was that this is a **preference**:
 * 72ch at 15px is comfortable on a 13" laptop and cramped on a 27" display, and there is no single right
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
export const READING_MEASURE_DEFAULT = 72;

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
  };
}
