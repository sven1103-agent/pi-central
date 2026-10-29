/**
 * The transcript column's measure, and where the send button sits (issue #92).
 *
 * The report, with the panel collapsed on a wide window:
 *
 * > *"the transcript looks lost, there is a lot of empty space right to the transcript… the prompt
 * > console is just stretched to the right, which makes it cumbersome to hit the send button."*
 *
 * Both come from one omission: `max-width: 72ch` was a property of PROSE, not of the column. So the text
 * sat at the left of a very wide column with all the emptiness on one side, and the composer — which had
 * no measure at all — stretched its send button to the far edge of a 1900px window.
 *
 * Asserted on the stylesheet because none of this is expressible in the markup the component tests
 * render: layout is the CSS.
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

test("the measure is a token, so the column and the composer cannot disagree about it", () => {
  // Two places need the same line length: the conversation and the prompt field under it. A literal in
  // each is two numbers to keep in step, which is how they drifted in the first place.
  assert.match(css, /:root\s*\{[^}]*--measure:\s*\d+ch/, "the measure is a custom property");
  const measure = /--measure:\s*(\d+ch)/.exec(css)?.[1];
  assert.ok(measure, "…and it is a ch value, so it scales with the prose font");
});

test("the measure CENTRES, so the empty space is not all on one side", () => {
  // This is the actual complaint. `max-width` alone pins the content to the left, which on a wide
  // collapsed-panel window reads as a broken layout rather than as a line-length limit.
  const measure = rule(".measure");
  assert.ok(measure, ".measure must have a rule");
  assert.match(measure, /max-width:\s*var\(--measure\)/, "derived from the token");
  assert.match(measure, /margin-inline:\s*auto/, "…and centred, which is the fix");
});

test("the composer's content is held to the same line as the transcript", () => {
  // A prompt field wider than the conversation above it is the second half of the report.
  const composer = rule(".composer > *");
  assert.ok(composer, "the composer's rows must be constrained");
  assert.match(composer, /max-width:\s*var\(--measure\)/, "the same measure as the prose");
  assert.match(composer, /width:\s*100%/, "…but still able to shrink on a narrow window");
});

test("the send button keeps its own width instead of stretching with the field", () => {
  // `cumbersome to hit` — the target moved to the far right of a wide window because the row stretched
  // and the button was the last thing in it.
  const button = rule(".composer-row .btn-send");
  assert.ok(button, "the send button must be pinned against stretching");
  assert.match(button, /flex:\s*none/, "it keeps its intrinsic width");
});

test("the transcript's own padding still lets the measure breathe on a narrow window", () => {
  // `margin-inline: auto` collapses to zero padding when the column is narrower than the measure, so the
  // scroller's own padding is what keeps the text off the edges there. Losing it would make a narrow
  // window worse than before the fix.
  const transcript = rule(".transcript");
  assert.ok(transcript, ".transcript must have a rule");
  assert.match(transcript, /padding:\s*var\(--sp-4\) 18px/, "horizontal breathing room survives");
});
