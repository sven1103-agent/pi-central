/**
 * Two peer disclosures must share one register (issue #144).
 *
 * From a screenshot review of a real transcript: "Tool-call rows are visually weaker than the thinking
 * boxes — the actionable/expandable content is a thin muted line, while the non-actionable thinking blocks
 * get big filled containers. Hierarchy is inverted."
 *
 * The premise was half wrong — BOTH are `<details>` you can open — but the sizes DID disagree (10px vs 11px)
 * with different fills, and a 1px gap cannot read as a hierarchy. It reads as inconsistency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The LAST declaration of a property in the LAST rule for a selector — source order wins. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))];
  return matches.length === 0 ? undefined : matches[matches.length - 1][1];
}

test("the two disclosure heads share one text size", () => {
  // 10px next to 11px is not a scale — it is two numbers that happen to differ. The eye cannot rank them,
  // so the only thing the difference communicates is that nobody chose.
  const sizeOf = (selector) =>
    /font-size:\s*var\(--([a-z0-9-]+)\)/.exec(rule(selector) ?? "")?.[1] ?? "none";
  const thinking = sizeOf(".quarantine-head");
  const tools = sizeOf(".tool-marker-summary");
  assert.ok(thinking !== "none" && tools !== "none", `both heads must set a size: ${thinking} / ${tools}`);
  assert.equal(tools, thinking, `the two heads must agree, got ${tools} vs ${thinking}`);
});

test("both disclosure heads respond to hover the same way", () => {
  const hasHover = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\n)${escaped}:hover\\s*\\{`).test(css);
  };
  assert.ok(hasHover(".tool-marker-summary"), "the tool bar is a disclosure handle and must show it");
  // The thinking head had no hover at all while its peer did, which is the asymmetry that reads as
  // "one of these is interactive and the other is not". They are both `<details>`.
  assert.ok(hasHover(".quarantine-head"), "the thinking head is a disclosure handle too");
});

test("the tool bar's hover is not a no-op", () => {
  // The reported defect: `.tool-marker-summary:hover { background: var(--panel) }` — and `--panel` is
  // `.tool-marker`'s OWN background, so the background half did nothing. Only the colour changed, on a 10px
  // bar. Worse, a comment credited that hover with the decision to drop the hatch (#138), so the state that
  // carried the judgement was not the state that shipped.
  const markerBg = /background:\s*var\(--([a-z0-9-]+)\)/.exec(rule(".tool-marker") ?? "")?.[1];
  assert.ok(markerBg, "the marker must set a background for this comparison to mean anything");
  const hoverBg = /background:\s*var\(--([a-z0-9-]+)\)/.exec(rule(".tool-marker-summary:hover") ?? "")?.[1];
  assert.ok(hoverBg, "the hover must change the background, not only the text colour");
  assert.notEqual(hoverBg, markerBg, `hover background must differ from the marker's own (${markerBg})`);
});

test("NEITHER hover is a no-op against its own resting fill", () => {
  // This is the guard that matters most, because the fix nearly repeated the bug it was fixing. The thinking
  // head's resting background is already `--panel-2` — the token the TOOL bar hovers to. Reusing `--panel-2`
  // for the thinking hover would have produced a second invisible hover, in the same commit, one rule apart.
  //
  // Each hover must step AWAY from its own head's fill, whatever that fill is.
  const hovering = (headSel, hoverSel) => {
    const headBg = /background:\s*var\(--([a-z0-9-]+)\)/.exec(rule(headSel) ?? "")?.[1];
    const hoverBg = /background:\s*var\(--([a-z0-9-]+)\)/.exec(rule(hoverSel) ?? "")?.[1];
    assert.ok(headBg, `${headSel} must set a resting background`);
    assert.ok(hoverBg, `${hoverSel} must change the background`);
    assert.notEqual(hoverBg, headBg, `${hoverSel} must not hover to its own resting ${headBg}`);
  };
  hovering(".quarantine-head", ".quarantine-head:hover");
  hovering(".tool-marker", ".tool-marker-summary:hover");
});
