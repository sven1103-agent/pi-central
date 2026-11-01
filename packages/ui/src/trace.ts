/**
 * The trace panel's geometry: how tall the detail pane is, and which way the list runs.
 *
 * ## Why this is a plain module
 *
 * Same reason as `panel.ts`: drag arithmetic is where the sign and clamp bugs live, and this repository's component
 * tests render to static HTML, so they execute no pointer handlers. The arithmetic is pure and tested; the component
 * only wires events to it.
 *
 * ## The defect this exists to fix
 *
 * The detail pane was `flex: 0 1 auto`, so its height followed its CONTENT — a two-line `echo` result produced a short
 * box and a forty-line `ls` produced a tall one. Traversing the list with the arrow keys therefore resized the pane under
 * the reader at every step: the rows jumped, the scroll position shifted, and the thing being read moved. Reported as
 * "confusing and mentally exhausting while traversing", which is exactly what a layout that reflows on every keystroke
 * feels like.
 *
 * A FIXED default height that the reader can drag is the answer. The pane's size is then a property of the PANEL rather
 * than of whichever call happens to be selected, so moving through calls changes only what is inside it.
 */

/** The detail pane's height before anyone drags it. Tall enough for a short file listing, not half the panel. */
export const TRACE_DETAIL_DEFAULT_HEIGHT = 260;

/**
 * The floor.
 *
 * Below this the arguments summary and two lines of output stop fitting, and the pane becomes a scrollbar with a border.
 */
export const TRACE_DETAIL_MIN_HEIGHT = 120;

/**
 * The ceiling, as a fraction of the panel's own height.
 *
 * A fraction rather than a constant for the reason `panel.ts` gives for its width: the panel's height depends on the
 * window, and a fixed 900px cap would be most of a laptop screen and almost nothing on a large display. A third is the
 * point past which the list stops being a list — the reader has chosen to look at ONE call, and the pane may say so, but
 * it should not be able to hide the list entirely.
 */
export const TRACE_DETAIL_MAX_FRACTION = 0.7;

/** The smallest the pane may be, given the panel's height. */
export function traceDetailMaxHeight(panelHeight: number): number {
  if (!Number.isFinite(panelHeight) || panelHeight <= 0) return TRACE_DETAIL_DEFAULT_HEIGHT;
  // Never below the floor: a panel shorter than the minimum still gets a usable pane, and the LIST scrolls instead.
  return Math.max(TRACE_DETAIL_MIN_HEIGHT, Math.round(panelHeight * TRACE_DETAIL_MAX_FRACTION));
}

/**
 * Clamp a requested height to what this panel can give.
 *
 * A non-finite value is treated as "no opinion" rather than propagated: `NaN` in a flex basis silently collapses the
 * pane, and there is no error to notice — the same failure `clampPanelWidth` guards.
 */
export function clampTraceDetailHeight(height: number, panelHeight: number): number {
  if (!Number.isFinite(height)) return TRACE_DETAIL_DEFAULT_HEIGHT;
  const max = traceDetailMaxHeight(panelHeight);
  return Math.round(Math.min(max, Math.max(TRACE_DETAIL_MIN_HEIGHT, height)));
}

/**
 * The height after dragging the handle by `delta`.
 *
 * `delta` is positive DOWNWARD, and the handle sits on the detail pane's TOP edge — so dragging down makes the pane
 * SHORTER (it gives room to the list above it). Getting this sign wrong is the classic bug here, so it is inverted in
 * one place, here, rather than at the call site.
 */
export function resizeTraceDetailBy(current: number, delta: number, panelHeight: number): number {
  return clampTraceDetailHeight(current - delta, panelHeight);
}

/** The height after a keyboard nudge. `Home`/`End` jump to the extremes, as the slider convention has it. */
export function resizeTraceDetailTo(
  key: "ArrowUp" | "ArrowDown" | "Home" | "End",
  current: number,
  panelHeight: number,
): number {
  const step = 24;
  switch (key) {
    case "ArrowUp":
      // Up ENLARGES the pane: the handle is on its top edge.
      return clampTraceDetailHeight(current + step, panelHeight);
    case "ArrowDown":
      return clampTraceDetailHeight(current - step, panelHeight);
    case "Home":
      return clampTraceDetailHeight(TRACE_DETAIL_MIN_HEIGHT, panelHeight);
    case "End":
      return clampTraceDetailHeight(traceDetailMaxHeight(panelHeight), panelHeight);
  }
}

/** Which way the list runs. */
export type TraceOrder = "oldest" | "newest";

/** The storage key for the reader's chosen order. */
export const TRACE_ORDER_KEY = "pi-central.trace.order";

/**
 * A stored order is validated rather than trusted.
 *
 * `localStorage` outlives upgrades and is shared with whatever else runs on this origin, so a stored value may name
 * something that no longer exists. Anything unrecognised means the default, which is `oldest` — the order the calls
 * actually happened in.
 */
export function parseTraceOrder(raw: string | null): TraceOrder {
  return raw === "newest" ? "newest" : "oldest";
}

/**
 * Order the rows for display.
 *
 * The LIST is reversed, not the data: `ToolExecution[]` arrives in call order and every consumer that reasons about
 * causality wants it that way. Only what the reader sees is flipped, and each row keeps its real identity by
 * `toolCallId`, so selection and the detail pane are unaffected by the order.
 */
export function orderTools<T>(tools: readonly T[], order: TraceOrder): readonly T[] {
  return order === "newest" ? [...tools].reverse() : tools;
}
