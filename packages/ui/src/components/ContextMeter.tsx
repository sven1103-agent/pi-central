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
import { CONTEXT_PRESSURE_PERCENT, formatContext } from "../format.ts";

/**
 * Where the bar turns amber.
 *
 * Re-exported from `format.ts` rather than declared here: it used to be a private `CONTEXT_PRESSURE_PERCENT = 80`
 * beside `formatContext`'s own `80`, and the comment claimed the two "can never disagree". They were two literals in
 * two files, so nothing would have failed if one moved. There are three consumers now — the bar's fill, the label's
 * word `full`, and the rail's compact bar (#13) — and they share one value.
 */
export { CONTEXT_PRESSURE_PERCENT } from "../format.ts";

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

/**
 * The same gauge, sized for a rail row (issue #13).
 *
 * ## Why a bar here and not the number
 *
 * The rail already prints `ctx 84% full` per row, and it was the thing the reader had to *read* to compare ten
 * sessions. A bar is magnitude: two rows whose fills differ by a third are distinguishable without reading either
 * number, and the comparison is what a fleet list is for.
 *
 * ## What changes, and what does not
 *
 * Only the SIZE. It is the same gauge — same clamp, same unknown case, same threshold from
 * `CONTEXT_PRESSURE_PERCENT`, same `role="meter"` with the value exposed once by the element — so the bar in the rail
 * and the bar in the header cannot disagree about how full a context is. The label is dropped because the percentage
 * is already on the row's own metrics line, and printing it twice in one row would be the density this rail was
 * cleared of in review.
 *
 * ## Why the accessibility name is per-row
 *
 * `aria-label="Context usage"` is right in a header with one meter. In a list of ten, ten identically-named meters
 * are indistinguishable to a screen-reader user tabbing through them, so the caller passes the session's name and
 * the element announces *whose* context it is.
 */
export function ContextBar({ percent, label }: { percent: number | null; label: string }) {
  /*
   * Unreported renders NOTHING, rather than an empty track.
   *
   * This is the one place the rail differs from the header, and the difference is about what the space means. In the
   * header, `ctx —` occupies the meter's slot so the surrounding chrome does not shift when a number arrives. In a
   * row, an empty track would read as "0% used" for a session nobody has measured — the fabricated zero the parent
   * component refuses — and a row per unmeasured session would each draw a bar that means nothing.
   */
  if (percent === null || !Number.isFinite(percent)) return null;

  const clamped = Math.max(0, Math.min(100, percent));
  const full = clamped >= CONTEXT_PRESSURE_PERCENT;

  return (
    <span
      className={`context-bar${full ? " is-full" : ""}`}
      role="meter"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Context usage for ${label}`}
    >
      <span className="context-bar-fill" style={{ width: `${clamped}%` }} />
    </span>
  );
}
