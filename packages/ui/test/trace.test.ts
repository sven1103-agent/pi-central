/**
 * The trace panel's geometry and order.
 *
 * Two reported problems, both about the panel changing under the reader:
 *
 *   1. the detail pane's height followed its CONTENT, so traversing with the arrow keys resized it at every step and the
 *      rows jumped — "confusing and mentally exhausting";
 *   2. the rows carried index NUMBERS so they could be told apart, which earned a leading column for a value nobody
 *      thinks in, when what was actually wanted was a choice of DIRECTION.
 *
 * The arithmetic is here rather than in the component for the reason `panel.ts` records: this repository's component
 * tests render to static HTML and execute no pointer handlers, so drag arithmetic in a component is arithmetic no test
 * can reach.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampTraceDetailHeight,
  orderTools,
  parseTraceOrder,
  resizeTraceDetailBy,
  resizeTraceDetailTo,
  traceDetailMaxHeight,
  TRACE_DETAIL_DEFAULT_HEIGHT,
  TRACE_DETAIL_MAX_FRACTION,
  TRACE_DETAIL_MIN_HEIGHT,
} from "../src/trace.ts";

test("the default height is a sensible fraction of nothing in particular", () => {
  // A property rather than a literal: the pane must be smaller than a typical panel and bigger than its own floor, or
  // the default is wrong whatever the number.
  assert.ok(TRACE_DETAIL_DEFAULT_HEIGHT > TRACE_DETAIL_MIN_HEIGHT, "the default exceeds the floor");
  assert.ok(TRACE_DETAIL_DEFAULT_HEIGHT < 900 * TRACE_DETAIL_MAX_FRACTION, "…and fits inside a 900px panel");
});

test("a requested height is clamped into what the panel can give", () => {
  const panel = 900;
  assert.equal(clampTraceDetailHeight(1, panel), TRACE_DETAIL_MIN_HEIGHT, "below the floor");
  assert.equal(clampTraceDetailHeight(100_000, panel), traceDetailMaxHeight(panel), "above the ceiling");
  assert.equal(clampTraceDetailHeight(TRACE_DETAIL_DEFAULT_HEIGHT, panel), TRACE_DETAIL_DEFAULT_HEIGHT);
});

test("a non-finite height falls back to the default instead of collapsing the pane", () => {
  // `NaN` in a flex basis silently collapses a pane and there is no error to notice — the failure `clampPanelWidth`
  // guards for the panel's width.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const result = clampTraceDetailHeight(bad, 900);
    assert.ok(Number.isFinite(result), `${bad} must produce a finite height, got ${result}`);
    assert.ok(result >= TRACE_DETAIL_MIN_HEIGHT);
  }
});

test("an unmeasured panel still yields a usable height", () => {
  // The panel's height is read at drag time; before layout it is 0. Dividing by it must not produce 0 or NaN.
  for (const height of [0, -10, Number.NaN]) {
    assert.ok(traceDetailMaxHeight(height) >= TRACE_DETAIL_MIN_HEIGHT, `panel height ${height}`);
  }
});

test("dragging DOWN makes the pane SHORTER, because the handle is on its top edge", () => {
  // The classic sign bug in this kind of control, and the reason the inversion lives in one function rather than at the
  // call site.
  const panel = 900;
  const start = 260;
  assert.ok(resizeTraceDetailBy(start, 40, panel) < start, "dragging down gives room to the list above");
  assert.ok(resizeTraceDetailBy(start, -40, panel) > start, "dragging up enlarges the pane");
  assert.equal(resizeTraceDetailBy(start, 0, panel), start, "no movement, no change");
});

test("a drag is clamped by the same bounds as any other height", () => {
  const panel = 900;
  assert.equal(resizeTraceDetailBy(TRACE_DETAIL_MIN_HEIGHT, 10_000, panel), TRACE_DETAIL_MIN_HEIGHT);
  assert.equal(resizeTraceDetailBy(TRACE_DETAIL_MIN_HEIGHT, -10_000, panel), traceDetailMaxHeight(panel));
});

test("the keyboard nudges by a step, and Home/End jump to the extremes", () => {
  const panel = 900;
  const start = 260;
  assert.equal(resizeTraceDetailTo("ArrowUp", start, panel), start + 24, "up enlarges");
  assert.equal(resizeTraceDetailTo("ArrowDown", start, panel), start - 24, "down shrinks");
  assert.equal(resizeTraceDetailTo("Home", start, panel), TRACE_DETAIL_MIN_HEIGHT);
  assert.equal(resizeTraceDetailTo("End", start, panel), traceDetailMaxHeight(panel));
  // …and the keys cannot escape the bounds either.
  assert.equal(resizeTraceDetailTo("ArrowUp", traceDetailMaxHeight(panel), panel), traceDetailMaxHeight(panel));
});

test("a stored order is validated, and anything unrecognised means oldest", () => {
  // `localStorage` outlives upgrades and is shared with this origin, so every one of these is reachable rather than
  // hypothetical. `oldest` is the default because it is the order the calls actually happened in.
  assert.equal(parseTraceOrder("newest"), "newest");
  assert.equal(parseTraceOrder("oldest"), "oldest");
  for (const bad of [null, "", "NEWEST", "sideways", "{}", "[]"]) {
    assert.equal(parseTraceOrder(bad), "oldest", JSON.stringify(bad));
  }
});

test("ordering the list does not mutate the data", () => {
  // The transcript and the detail pane both reason about call order; only what the reader SEES is flipped.
  const tools = ["a", "b", "c"];
  const before = [...tools];
  assert.deepEqual(orderTools(tools, "oldest"), ["a", "b", "c"]);
  assert.deepEqual(orderTools(tools, "newest"), ["c", "b", "a"]);
  assert.deepEqual(tools, before, "the input array is untouched");
});

test("ordering returns the SAME array for oldest, so nothing re-renders needlessly", () => {
  const tools = ["a", "b"];
  assert.equal(orderTools(tools, "oldest"), tools, "oldest is the identity, not a copy");
});
