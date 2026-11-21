/**
 * The transcript must SCROLL, which means every box between the window and it must be height-bounded.
 *
 * ## Why this file exists
 *
 * A regression reached the reader as *"i cant scroll"*: the grid row that places the prose lane and the companion was
 * given `align-items: start` (copied from the flex row it replaced, where `start` was needed for a sticky child). In a
 * grid, item alignment decides the ROW's height, so `.transcript-main` became content-height, `.transcript`
 * (`overflow-y: auto`) was handed a box as tall as its own content, and there was nothing to scroll — the pane simply
 * grew past the window.
 *
 * Neither fact is visible in a screenshot of a SHORT transcript, which is why this is asserted structurally.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every declaration set for a selector, MERGED in cascade order.
 *
 * Merged rather than "the last one", and the difference is a test that lied: `.transcript` is declared twice in this
 * stylesheet — the layout rule and a two-line scrollbar-colour rule — so taking the last match answered a question about
 * scrolling with `scrollbar-width: thin`. Merging answers what the element actually computes, which is what every
 * assertion here is about. (The earlier version of this file used last-match, borrowed from a helper that reads a rule
 * whose selector is declared once. Right tool, wrong file.)
 */
function rule(selector) {
  const wanted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`^${wanted}\\s*\\{([^}]*)\\}`, "gm"))];
  return all.length > 0 ? all.map((match) => match[1]).join("\n") : undefined;
}

test("the row does NOT size its items to their content (align-items: start breaks scrolling)", () => {
  /*
   * THE regression, pinned. `align-items: start` sizes each grid item to its content, so the reading column stops
   * filling its track and the scroller inside it has no bounded height.
   *
   * Falsified by restoring `align-items: start` — a one-word change that removes the reader's ability to scroll a long
   * transcript, and produces no error anywhere.
   */
  const row = rule(".transcript-wrap.has-header") ?? "";
  assert.ok(row, "the wide row must have a rule");
  assert.match(row, /align-items:\s*stretch/, "items fill the row, so the scroller has a bounded height");
  assert.ok(!/align-items:\s*start/.test(row), "content-sized items are the defect");
});

test("the sticky companion gets its room from ITSELF, not from the row", () => {
  /*
   * The reason `start` was there in the first place, and the correct place to express it: `position: sticky` needs an
   * item shorter than its containing block to have room to move. In a flex row that had to be the row's `align-items`;
   * in a grid it is the ITEM's `align-self`, which leaves the row free to stretch.
   *
   * Both halves are asserted, because either alone is a broken layout.
   */
  assert.match(rule(".transcript-header") ?? "", /align-self:\s*(start|flex-start)/, "the companion opts out on its own");
  assert.match(
    rule(".transcript-wrap.has-header") ?? "",
    /align-items:\s*stretch/,
    "while the row itself stretches — the two are not in conflict",
  );
});

test("the row's track absorbs the height, with a minmax floor", () => {
  /*
   * `grid-template-rows: minmax(0, 1fr)` and not a bare `1fr`: a bare `1fr` is `minmax(auto, 1fr)`, whose minimum is
   * the CONTENT's height, so a long transcript sizes the row to its own text and the scroller is handed a box as tall as
   * what it contains. That is the same trap as the columns' `minmax(0, …)` — the comment on `.panes` records the
   * horizontal version, and this is the vertical one.
   *
   * Falsified by writing `1fr` or `auto`, or by omitting the declaration (implicit rows are `auto`).
   */
  assert.match(
    rule(".transcript-wrap.has-header") ?? "",
    /grid-template-rows:\s*minmax\(0,\s*1fr\)/,
    "an explicit, height-absorbing row with a zero floor",
  );
});

test("every box between the window and the scroller can shrink", () => {
  /*
   * The chain the scroller depends on. A flex item's default `min-height` is `auto`, i.e. its content's height, so ONE
   * missing `min-height: 0` anywhere up the chain makes every descendant at least as tall as the transcript — and the
   * transcript is exactly the thing that must scroll inside a bounded box.
   *
   * Asserted as a list rather than one selector at a time: the failure is always "one link was forgotten", and a test
   * that names the chain is a test that says which link.
   */
  for (const selector of [".shell", ".column", ".transcript-shell", ".transcript-wrap", ".transcript-main", ".transcript-viewport"]) {
    const body = rule(selector) ?? "";
    assert.ok(body, `${selector} must have a rule`);
    assert.match(body, /min-height:\s*0/, `${selector} must be allowed to shrink below its content`);
  }
  assert.match(rule(".transcript") ?? "", /overflow-y:\s*auto/, "the transcript is the scroller");
  assert.match(rule(".transcript") ?? "", /min-height:\s*0/, "and it too is bounded");
});

test("the composer is OUTSIDE the scroller, so it cannot be pushed behind the text", () => {
  /*
   * The other half of the reported symptom. When the row was content-sized the reading column's children stacked at
   * their natural heights, so the composer ended up below the visible area. Structurally: the viewport (scroller + its
   * floating pill) and the footer (composer) are siblings, both children of the reading column, and only the viewport
   * scrolls.
   */
  const source = readFileSync(new URL("../src/components/Transcript.tsx", import.meta.url), "utf8");
  const main = source.slice(source.indexOf('className="transcript-main"'));
  const viewportAt = main.indexOf('className="transcript-viewport"');
  const footerAt = main.indexOf('className="transcript-footer"');
  assert.ok(viewportAt > -1, "the viewport exists inside the reading column");
  assert.ok(footerAt > -1, "and so does the footer");
  assert.ok(footerAt > viewportAt, "the footer follows the viewport, so the composer sits below the scroller");
});
