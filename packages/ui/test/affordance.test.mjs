/**
 * Affordance and legibility at rest (issue #74).
 *
 * Three small things found by looking at a screenshot while every test was green. Each is asserted
 * against the stylesheet or a source constant, because none of them is expressible in the markup this
 * repository's component tests render (they use `renderToStaticMarkup`, which runs no CSS).
 *
 * ## Why this is a separate file from `components.test.mjs`
 *
 * That file is ~1,700 lines and every UI slice appends to its END, so any two open pull requests
 * conflict there — it cost four rebases before this file existed, and twice git's conflict region cut
 * a test in half, leaving `SyntaxError: Unexpected end of input` pointing at the far end of the file
 * with no conflict marker in sight. New UI assertions go in their own file now.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const modelPicker = readFileSync(new URL("../src/components/ModelPicker.tsx", import.meta.url), "utf8");

/** The declarations of the first rule whose selector matches, or `undefined`. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1];
}

// --- The markers toggle (1 of 3) ------------------------------------------------------------------

test("the markers toggle has an affordance at rest, unlike the collapse toggle beside it", () => {
  // It is a real button — `onClick` plus `aria-pressed` — and it rendered as plain bold text with a
  // background only on hover. So it read as a status readout, and a control that reveals itself only
  // on hover is the one thing this design forbids (§5.1).
  //
  // Asserted on `[aria-pressed]` rather than on the class, deliberately: styling `.trace-toggle`
  // would box the collapse toggle too (`▾ Tool trace`, which already reads as a control because it
  // carries a glyph) and turn the trace header into a toolbar.
  const toggle = rule('.trace-toggle[aria-pressed]');
  assert.ok(toggle, "the pressed-state toggle must have its own rule");
  assert.match(toggle, /border:\s*1px solid/, "a border is what makes it read as a control");
  assert.match(toggle, /border-radius:\s*var\(--r-pill\)/, "…and a rounded one reads as a chip, not a field");

  // The distinction has to be real: the collapse toggle must NOT be boxed.
  const collapse = rule(".trace-toggle");
  assert.ok(collapse, ".trace-toggle must have a rule");
  assert.ok(!/border:\s*1px/.test(collapse), "the collapse toggle must stay unboxed");

  // And the on-state must be visible without relying on colour alone — the words carry it.
  const on = rule('.trace-toggle[aria-pressed="true"]');
  assert.ok(on, "the on-state must be styled");
  assert.match(on, /background:\s*var\(--accent-tint\)/);
});

// --- The model label (2 of 3) ---------------------------------------------------------------------

test("the model label is capped to fit the header, and the cap and the CSS agree", () => {
  // The two numbers are a documented pairing: a `max-width` smaller than the character cap means CSS
  // cuts a string that was already shortened, which produces a trailing cut instead of the elision
  // `truncateMiddle` chose (issue #42's bug). So they are asserted equal here rather than trusted to
  // stay in step.
  const constant = /const LABEL_MAX = (\d+);/.exec(modelPicker);
  assert.ok(constant, "ModelPicker must define LABEL_MAX");
  const cap = Number(constant[1]);

  const select = rule(".picker-select");
  assert.ok(select, ".picker-select must have a rule");
  const width = /max-width:\s*(\d+)ch/.exec(select);
  assert.ok(width, ".picker-select must cap its width in ch");
  assert.equal(Number(width[1]), cap, "the character cap and the CSS width must be the same number");
});

test("the cap leaves room for a provider-qualified model name", () => {
  // The reported defect: `openrouter/d_4.1-f…` while empty space sat beside it. The model drives cost
  // attribution, so losing the variant is expensive, and the cap only has to fit the HEADER — not a
  // rail row, which is where the shorter limit came from.
  const cap = Number(/const LABEL_MAX = (\d+);/.exec(modelPicker)[1]);
  assert.ok(cap > 22, `the cap must exceed the old 22 characters, got ${cap}`);
  // A realistic name, to keep the assertion tied to a real case rather than to a bare number.
  const example = "openrouter/deepseek-v4-flash";
  assert.ok(cap >= 26, `a provider-qualified name needs room: ${example}`);
});

// --- The metric strip (3 of 3) --------------------------------------------------------------------

test("the metric strip separates its facts instead of running them together", () => {
  // `ctx 29% 313.7M tok $30.17 644 msgs` in one dim weight reads as a sentence. The separator is a
  // pseudo-element so it is presentation: it should not be read aloud, and it should not be copied
  // with the numbers.
  const separator = rule(".metrics > span + span::before");
  assert.ok(separator, "the strip must have a separator rule");
  assert.match(separator, /content:\s*"·"/, "a middot, which does not compete with the values");

  // The flex gap is off, or the separator would sit unevenly between two sources of space.
  const metrics = rule(".metrics");
  assert.ok(metrics, ".metrics must have a rule");
  assert.match(metrics, /gap:\s*0\b/, "spacing comes from the separator, not from both");
  assert.match(separator, /margin:\s*0 10px/, "…evenly, on both sides");
});
