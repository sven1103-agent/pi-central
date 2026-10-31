/**
 * The transcript's measure: capped, NOT centred (reverted from #92).
 *
 * ## What this file used to be, and why it changed
 *
 * #92 answered *"the transcript looks lost, there is a lot of empty space right to the transcript"* by
 * centring a 590px column inside a 1330px one. That made the emptiness **more** obvious, and it produced
 * five downstream defects, each fix finding the previous fix's bug:
 *
 *   1. tool markers were capped but not centred → the transcript **flickered** left/centre as tools ran;
 *   2. the composer's `align-items: center` centred each child on its own width → **three left edges**;
 *   3. a `margin` shorthand silently cancelled the centring → the fix appeared not to work at all;
 *   4. trace text was inset from the column edge → **30px right** of the prose;
 *   5. and `.tool-detail` inherited the same inset problem.
 *
 * All reverted. The original complaint was more likely about text SIZE on a 27" display than about
 * alignment, and the assertions below now describe what the layout actually does.
 *
 * ## What is still asserted
 *
 * The two things from #92 that were independently true: the measure is a CAP, and the Send button does not
 * shrink below its label.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/**
 * The declarations of the LAST rule whose selector matches.
 *
 * Last, because CSS resolves equal-specificity conflicts by source order — the last one is what the element
 * gets. First-match reading has twice described CSS with no effect.
 *
 * Selectors are matched on normalised whitespace, because a selector list is formatted across lines.
 */
function rule(selector) {
  const normalised = css.replace(/\s+/g, " ");
  const wanted = selector.replace(/\s+/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...normalised.matchAll(new RegExp(`${wanted} ?\\{([^}]*)\\}`, "g"))];
  return all.length > 0 ? all[all.length - 1][1] : undefined;
}

test("the prose is CAPPED, which is the readability limit that matters", () => {
  const measure = rule(".measure");
  assert.ok(measure, ".measure must have a rule");
  // The cap is now the READER's token (#134), defaulting to 72ch. Asserting the literal would fail on the
  // feature that makes it configurable — the property is "a cap in ch", not "the number 72".
  assert.match(measure, /max-width:\s*var\(--reading-measure\)/, "the reader's measure token");
  const root = /:root\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1] ?? "";
  assert.match(root, /--reading-measure:\s*72ch/, "…which defaults to the 72ch that shipped");
});

test("the prose is NOT centred", () => {
  // The revert, pinned. If `margin-inline: auto` comes back, the five defects above come back with it —
  // and the flicker is the one a reader notices immediately.
  const measure = rule(".measure");
  assert.ok(
    !/margin-inline:\s*auto/.test(measure),
    "centring was reverted: it made the emptiness more obvious and produced five downstream defects",
  );
});

test("the composer spans the column instead of being individually centred", () => {
  // `align-items: center` was the three-left-edges bug: it centres each child on its own width, so a
  // shrink-wrapped mode strip and a full-width row get different edges.
  const composer = rule(".composer");
  assert.ok(composer, ".composer must have a rule");
  assert.ok(!/align-items:\s*center/.test(composer), "per-child centring is the bug");
  assert.ok(!/align-items:\s*stretch/.test(composer), "…and the patch for it is gone too, with the cap");
});

/*
 * "The send button does not shrink below its label" lived here. The button is gone — Enter submits — so the rule it
 * guarded no longer exists, and a `skip` would have been a guard that silently stopped guarding. The DECISION (no
 * button, Enter sends) is asserted in `components.test.mjs`, where the composer's markup is readable.
 */

test("the transcript keeps its own horizontal padding, and centres ONE lane", () => {
  /*
   * Two properties, and the second is a deliberate reversal of #92 with a different mechanism.
   *
   * #92 centred the transcript by putting `margin-inline: auto` on each CHILD. A tool marker is narrower than a
   * paragraph, so each child was centred on its own width, the centres disagreed, and the column visibly flickered
   * as tools ran. It was reverted, and the note in `.transcript` says centring is "the thing that failed".
   *
   * What actually failed was per-child centring. The review asked twice for a centred column, so it is centred ONCE,
   * on a single lane wrapper that every entry fills: there is exactly one centre, so nothing can disagree about it.
   * That is the property asserted here — one lane, one auto margin — rather than the presence or absence of centring.
   */
  // Read the BASE rule directly: `rule()` returns the LAST match, and the container-query override also sets
  // `.transcript`, so the helper handed back `grid-row: 2`.
  const source = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const transcript = /(?:^|\n)\.transcript\s*\{([^}]*)\}/.exec(source)?.[1] ?? "";
  assert.ok(transcript, ".transcript must have a rule");
  assert.match(
    transcript,
    /padding:\s*var\(--sp-4\) 18px var\(--sp-4\) 18px/,
    `18px on both sides, so the scrollbar sits at the column's edge; got: ${transcript}`,
  );

  const lane = rule(".transcript-lane");
  assert.ok(lane, ".transcript-lane must exist — it is the one thing that is centred");
  assert.match(lane, /margin-inline:\s*auto/, "the lane is centred");
  assert.match(lane, /max-width:\s*var\(--reading-measure\)/, "…at the reader's measure, like the prose and composer");

  // The guard that makes this safe: nothing else in the transcript may centre itself.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const centred = [...css.matchAll(/([^{}]+)\{([^}]*margin-inline:\s*auto[^}]*)\}/g)]
    .map((m) => m[1].trim())
    .filter((selector) => selector.includes("turn") || selector.includes("measure") || selector.includes("activity"));
  assert.deepEqual(
    centred,
    [],
    `per-child centring is #92's defect: a narrower child gets a different centre. Found: ${centred.join(", ")}`,
  );
});
test("the companion sits to the RIGHT of the prose, and the pair is centred", () => {
  /*
   * Two properties, and the first was wrong twice.
   *
   * The companion is the first child in the DOM, which is correct for reading and tab order — a screen reader should
   * meet the session's identity before its conversation. In a flex ROW that put it on the LEFT, so the layout was
   * `[companion][conversation]` (`img_32.png`) while every description of the design, and the review that asked for
   * it, says the box is to the right of the prose.
   *
   * `order` is the one tool that separates visual order from source order, and this is a legitimate use: both orders
   * are correct, they simply differ. The guard is that the swap exists in the row form and is neutralised when the
   * layout stacks, because there the companion must be on top.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const rowOrder = /\.transcript-wrap\.has-header \.transcript-main\s*\{\s*order:\s*(\d+)/.exec(css)?.[1];
  const boxOrder = /\.transcript-wrap\.has-header \.transcript-header\s*\{\s*order:\s*(\d+)/.exec(css)?.[1];
  assert.ok(rowOrder !== undefined && boxOrder !== undefined, "both boxes must declare their visual order");
  assert.ok(
    Number(boxOrder) > Number(rowOrder),
    `the companion must come after the prose visually, got main=${rowOrder} header=${boxOrder}`,
  );

  const pair = /\.transcript-wrap\.has-header\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(pair, /justify-content:\s*center/, "the pair is centred as a unit");

  // Stacked, the swap must be neutralised or the companion would be reordered below the conversation it labels.
  const stacked = /@container transcript[^{]*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.match(stacked, /order:\s*0/, "the visual-order swap is row-only");
});
