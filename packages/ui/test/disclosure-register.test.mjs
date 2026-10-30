/**
 * The hierarchy: the work ranks above the reasoning (issue #144).
 *
 * From a screenshot review, and confirmed by the reader: "The tool call is the more important signal to the
 * user than the thinking."
 *
 * The FIRST attempt at this fix got the principle wrong. It found the two heads 1px apart with different
 * fills, called that an inconsistency, and made them EQUAL. Equal does not fix an inversion — it removes the
 * means of telling them apart, which is the same failure with a tidier table. These tests assert ORDER.
 *
 *   1. the reader's words and the assistant's prose  — --text on --bg
 *   2. the work: a tool call                         — --text names, filled --panel, quarantine gutter
 *   3. the reasoning about to be done                — --dim, flat, no fill, no gutter
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

/** The LAST rule for a selector: source order wins, so the first match can be a stale earlier draft. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))];
  return matches.length === 0 ? undefined : matches[matches.length - 1][1];
}
const prop = (selector, name) =>
  new RegExp(`(?:^|;|\\s)${name}:\\s*([^;]+)`).exec(rule(selector) ?? "")?.[1]?.trim();

/** WCAG relative luminance, for the contrast claim rather than a colour name comparison. */
const lum = (hex) => {
  const ch = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const token = (name) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(raw)?.[1];

test("the tool names are more legible than the thinking label", () => {
  // This is the inversion, measured. The tool names inherited `--quarantine` at 2.71:1 while the thinking
  // label sat at `--dim`, 5.62:1 — so the row showing WHAT RAN was less than half as legible as the row
  // saying something was being thought about. A pixel comparison would not have caught this; contrast does.
  const names = prop(".tool-marker .m-names", "color");
  const thinkingLabel = prop(".quarantine-head", "color");
  assert.ok(names && thinkingLabel, `both must declare a colour: ${names} / ${thinkingLabel}`);

  const resolve = (v) => token(/^var\(--([a-z0-9-]+)\)$/.exec(v)?.[1] ?? "");
  const bg = token("panel");
  assert.ok(bg, "need --panel to measure against");

  const workContrast = contrast(resolve(names), bg);
  const thinkContrast = contrast(resolve(thinkingLabel), bg);
  assert.ok(
    workContrast > thinkContrast,
    `the work must out-rank the reasoning: names ${workContrast.toFixed(2)}:1 vs thinking ${thinkContrast.toFixed(2)}:1`,
  );
  assert.ok(workContrast >= 4.5, `the tool names must be AA-readable, got ${workContrast.toFixed(2)}:1`);
});

test("only the work carries a resting fill", () => {
  // The "big filled container" the review saw was on the THINKING block — content the reader is usually
  // skipping. A fill is what makes a row read as a record; it belongs to the row that records something.
  const thinkingBg = prop(".quarantine-head", "background");
  assert.equal(thinkingBg, "none", `the thinking head must be flat, got ${thinkingBg}`);
  assert.ok(prop(".tool-marker", "background"), "the tool marker keeps its fill");
});

test("both are still disclosures, and both answer the mouse", () => {
  // Demotion is not removal. Thinking still opens, still carries its gist (#143), and must still show that
  // it is operable — otherwise the fix trades an inverted hierarchy for a hidden control.
  const hover = (sel) => rule(`${sel}:hover`);
  assert.ok(hover(".tool-marker-summary"), "the tool bar shows its affordance");
  assert.ok(hover(".quarantine-head"), "the thinking head is a disclosure too");

  // Each hover must CHANGE the background relative to its own resting state. The original bug was
  // `background: var(--panel)` on a marker already on `--panel` — an invisible hover, credited in a comment
  // with a design decision (#138) that therefore rested on a state nobody could see.
  //
  // A first version compared the hover against the resting background and PASSED when the hover was emptied
  // to `none` — because `none` is also different from the resting value. "Differs from" is not "is visible":
  // the hover must name a FILL. That is the assertion that fails when the hover is deleted, which is what a
  // guard has to do.
  const hoverBg = (sel) => prop(`${sel}:hover`, "background");
  const restBg = (sel) => prop(sel, "background") ?? "none";
  for (const [hover, rest, label] of [
    [".quarantine-head", ".quarantine-head", "thinking"],
    [".tool-marker-summary", ".tool-marker", "tool"],
  ]) {
    const bg = hoverBg(hover);
    assert.ok(bg && bg !== "none", `${label} hover must name a fill, got ${bg}`);
    assert.notEqual(bg, restBg(rest), `${label} hover must differ from its own resting fill`);
  }
});
