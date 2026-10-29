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
  assert.match(measure, /max-width:\s*72ch/, "a line-length cap, in ch so it scales with the prose font");
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

test("the send button does not shrink below its label", () => {
  // Kept from #92, with a corrected reason: a flex item defaults to `flex: 0 1 auto` and could never grow,
  // so this only prevents SHRINKING. It is harmless and mildly useful on a narrow window — it did not fix
  // "cumbersome to hit", which was the composer spanning 1900px.
  const button = rule(".composer-row .btn-send");
  assert.ok(button, "the send button needs a rule");
  assert.match(button, /flex:\s*none/, "`0 0 auto`: no shrinking, which is all this ever did");
});

test("the transcript keeps its own horizontal padding", () => {
  // Independent of the centring, and the only thing keeping text off the edges on a narrow window.
  const transcript = rule(".transcript");
  assert.ok(transcript, ".transcript must have a rule");
  assert.match(transcript, /padding:\s*var\(--sp-4\) 18px/, "horizontal breathing room");
});
