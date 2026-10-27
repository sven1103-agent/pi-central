/**
 * The trace's scroll regions are marked as such (issue #73).
 *
 * ## The decision this file encodes
 *
 * The transcript column has two scroll regions — the transcript, and the trace list — and a reviewer
 * could not tell them apart: *"the inner thumb is easy to mistake for the outer one"*.
 *
 * Two ways out, and the one NOT taken matters as much as the one that was:
 *
 *   - **Remove the nesting**: rejected. The trace's bounded height is a stated design choice (*"the
 *     trace never grows with the number of calls"*), so without a bound the list pushes the composer
 *     off screen — and windowing the rows instead would put calls out of reach of the ↑↓ traversal
 *     that already exists for exactly that purpose.
 *   - **Keep it and mark it**: taken. A distinct scrollbar and a recessed viewport, so the bounded
 *     area reads as a surface of its own.
 *
 * Neither the hierarchy nor the wheel behaviour was ever wrong: a browser chains the wheel from a
 * finished inner scroller to the outer one. What was missing was a signal a glance could use — the
 * words were already there (`latest 5 shown · … · ↑↓ to traverse`) and were not enough.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

const css = stripComments(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"));

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
}

test("both inner scrollers carry their own scrollbar, not the platform default", () => {
  // The signal: a thumb this column's other scrollbar does not have. `--line-strong` rather than the
  // platform default, and wider, so the two are distinguishable at a glance.
  for (const selector of [".trace-list", ".trace-detail"]) {
    const body = rule(selector);
    assert.ok(body, `${selector} must have a rule`);
    assert.match(body, /overflow-y:\s*auto/, `${selector} is a scroller`);
    assert.match(body, /scrollbar-color:\s*var\(--line-strong\)/, `${selector} must tint its own scrollbar`);
    assert.ok(
      new RegExp(`${selector.replace(/\./g, "\\.")}::-webkit-scrollbar\\s*\\{[^}]*width:\\s*9px`).test(css),
      `${selector} must size its own scrollbar, or it matches the outer one`,
    );
  }
});

test("the trace list reads as a bounded viewport rather than more of the page", () => {
  // A recessed `--bg` inside the trace's `--panel`: the bounded area looks like a surface of its own.
  const list = rule(".trace-list");
  assert.match(list, /background:\s*var\(--bg\)/, "a recessed viewport, distinct from .trace's --panel");
  const trace = rule(".trace");
  assert.ok(trace, ".trace must have a rule");
  assert.match(trace, /background:\s*var\(--panel\)/, "…and the two must differ");
});

test("the bounds that make the nesting necessary are still in place", () => {
  // If these ever go, the nesting could be removed — and this test is the reminder to reconsider it
  // rather than to keep marking a problem that no longer exists.
  assert.match(rule(".trace-list"), /max-height:\s*108px/, "the list stays bounded by row count");
  assert.match(rule(".trace-detail"), /max-height:\s*34vh/, "the detail stays bounded so it cannot squeeze the transcript");
});
