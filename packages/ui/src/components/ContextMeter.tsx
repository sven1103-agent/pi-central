/**
 * Context usage, as a bar with the number beside it.
 *
 * ## Why this exists
 *
 * The header used to hold a `Usage` button that opened a second row of four numbers — and on a real window
 * (`img_23.png`) that row pushed Provider/Model/Thinking onto their own lines and left the button stranded at the
 * far right of a header that had become four rows tall. A disclosure that BREAKS the row it lives in is worse than
 * the density it was meant to relieve.
 *
 * Context usage is the one telemetry value that changes what a reader should do — near the limit the session is
 * about to compact, and anything queued will run against a thinned history. So it is shown, not disclosed: a bar,
 * the percentage, and a word when it is high. Cost is the other number worth a permanent place, because it is what
 * the run is spending; tokens and message count are lookups, and they live in the Session panel where they already
 * were.
 *
 * ## The rules this follows, and why each is explicit
 *
 * - **Never colour alone.** The bar's fill goes amber past the threshold, and the text beside it says
 *   `ctx 84% full`. `forced-colors` drops the fill; the words survive (DESIGN §9).
 * - **Never a fabricated zero.** `contextPercent === null` means Pi has not reported usage yet — that renders
 *   `ctx —` with NO bar. A 0%-full bar would be a false statement about a window nobody has measured, which is the
 *   same rule `formatContext` follows.
 * - **`role="meter"`, not a div with a fill.** A meter is a gauge inside a known range, which is exactly what this
 *   is; the value is exposed to assistive tech once, by the element, rather than inferred from a width.
 */
import { formatContext } from "../format.ts";

/**
 * Where the bar turns amber.
 *
 * 80% is where compaction becomes likely within the next turn or two, so it is the point at which the number
 * stops being trivia and starts being a warning. The same threshold `formatContext` uses for the word `full`,
 * so the bar and its label can never disagree.
 */
export const CONTEXT_PRESSURE_PERCENT = 80;

export function ContextMeter({
  percent,
  /** Shown beside the bar. `false` when the meter renders somewhere the label is already obvious. */
  showLabel = true,
}: {
  percent: number | null;
  showLabel?: boolean;
}) {
  /*
   * Unreported is NOT zero. A meter with an empty fill would say "you have a whole window free", which is a claim
   * about a measurement Pi has not made — and the reader would then be surprised by a compaction.
   */
  if (percent === null || !Number.isFinite(percent)) {
    return <span className="context-meter is-unknown">{formatContext(null)}</span>;
  }

  const clamped = Math.max(0, Math.min(100, percent));
  const full = clamped >= CONTEXT_PRESSURE_PERCENT;

  return (
    <span className={`context-meter${full ? " is-full" : ""}`}>
      <span
        className="context-meter-track"
        role="meter"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Context usage"
        /*
         * The fill is a child rather than a gradient on the track: a background on the meter element itself would
         * be replaced by `forced-colors`, and the reader would lose the shape as well as the colour.
         */
      >
        <span className="context-meter-fill" style={{ width: `${clamped}%` }} />
      </span>
      {showLabel && <span className="context-meter-label mono">{formatContext(clamped)}</span>}
    </span>
  );
}
