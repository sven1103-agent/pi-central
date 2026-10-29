/**
 * One alignment rule for the transcript, and one left edge for the composer (issue #129).
 *
 * ## Two defects, both from #92, both visible in a screenshot
 *
 * **The flicker.** `.tool-marker` is a `<button>` — inline-level — so `max-width: 72ch` clamped it but
 * nothing centred it. The turns are blocks with `margin-inline: auto` and *are* centred. So the
 * transcript alternated centred-prose / left-flush-marker, and because a marker re-renders on every tool
 * event it visibly jumped as tools fired: *"it flickers left and centred."*
 *
 * **Three left edges.** `.composer` used `align-items: center`, which centres each child on ITS OWN
 * width. The mode strip shrink-wraps, the composer row fills the measure, the hint is shorter again — so
 * one stack had three different left edges, which is exactly what the screenshot shows.
 *
 * Both are the same mistake in different places: **alignment applied per element instead of per
 * container.** So the assertions are about consistency rather than about any single declaration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
}

test("every measured child of the transcript centres, including the tool marker", () => {
  // The flicker, pinned. The three classes that alternate down the column must agree on alignment; if
  // they are declared individually, they will drift individually — which is how this happened.
  const shared = rule(".measure, .tool-marker, .run-notices") ?? rule(".measure,\n.tool-marker,\n.run-notices");
  assert.ok(shared, "the transcript's measured children must share ONE rule");
  assert.match(shared, /max-width:\s*var\(--measure\)/, "on the measure");
  assert.match(shared, /margin-inline:\s*auto/, "…and centred, which is what the marker was missing");
  assert.match(shared, /width:\s*100%/, "a flex child must claim the width before `max-width` can clamp it");
});

test("the tool marker no longer declares its own alignment", () => {
  // A second source of truth for the same decision is how the marker ended up capped-but-not-centred
  // while the turns were centred-and-capped.
  const marker = rule(".tool-marker");
  assert.ok(marker, ".tool-marker must have a rule");
  assert.ok(!/max-width/.test(marker), "the cap belongs to the shared rule, not to the marker");
  assert.ok(!/margin-inline/.test(marker), "and so does the centring");
});

test("the composer aligns children by the CONTAINER, not by each child's width", () => {
  // `align-items: center` is the bug: it centres each child on its own width, so a shrink-wrapped mode
  // strip and a full-width row get different left edges.
  const composer = rule(".composer");
  assert.ok(composer, ".composer must have a rule");
  assert.match(composer, /align-items:\s*stretch/, "the column is the reference, not each child");
  assert.ok(!/align-items:\s*center/.test(composer), "`center` here is what produced three left edges");

  const child = rule(".composer > *");
  assert.ok(child, "the composer's children must be capped");
  assert.match(child, /max-width:\s*var\(--measure\)/, "on the same measure as the transcript");
  assert.match(child, /margin-inline:\s*auto/, "and centred here, once, instead of per child");
});

test("the send button cannot overflow the field's right edge", () => {
  // The row is capped and holds `textarea (flex:1) + button (flex:none)`, so the field ends before the
  // row does and the button occupies the remainder — which reads as "the button is outside the field".
  // The textarea must be allowed to shrink, or it forces the row past the measure on a narrow window.
  const textarea = rule(".composer-row textarea");
  assert.ok(textarea, "the textarea needs its own rule inside the row");
  assert.match(textarea, /min-width:\s*0/, "a flex child with `min-width: auto` cannot shrink");
});
