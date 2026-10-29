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

/**
 * The declarations of the LAST rule whose selector matches.
 *
 * The LAST, because CSS resolves equal-specificity conflicts by source order — so the last one is the one
 * that wins, and it is what the element actually gets. Reading the first match found a *partial* fragment
 * (a rule with one declaration) and the assertion then described CSS that had no effect. Third time in this
 * slice that a text-scanning helper read the wrong thing.
 *
 * Selectors are matched on normalised whitespace, because a selector list is formatted across lines.
 */
function rule(selector) {
  const normalised = css.replace(/\s+/g, " ");
  const wanted = selector.replace(/\s+/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...normalised.matchAll(new RegExp(`${wanted} ?\\{([^}]*)\\}`, "g"))];
  return all.length > 0 ? all[all.length - 1][1] : undefined;
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

test("NO later rule can override the shared alignment", () => {
  // The bug that made this fix appear not to work, and the assertion that would have caught it.
  //
  // `.tool-marker` also has its own rule, declared LATER in the stylesheet at equal specificity. Its
  // `margin: 2px 0 <x>` SHORTHAND set `margin-left/right: 0` and silently cancelled the
  // `margin-inline: auto` from the shared rule. The fix was correct, in the file, and never reached the
  // element — so a test asserting "the shared rule contains margin-inline: auto" passed while the marker
  // stayed flush left.
  //
  // A test that only checks a declaration checks the CODE. This checks the outcome: for each class the
  // shared rule covers, nothing it declares for horizontal placement may be clobbered by a later rule.
  const normalised = css.replace(/\s+/g, " ");
  const rules = [...normalised.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
    at: m.index,
  }));
  const shared = rules.find((r) => r.selector === ".measure, .tool-marker, .run-notices");
  assert.ok(shared, "the shared rule must exist");

  for (const cls of [".tool-marker", ".run-notices"]) {
    const later = rules.filter((r) => r.at > shared.at && r.selector.split(",").map((s) => s.trim()).includes(cls));
    for (const rule of later) {
      for (const decl of rule.body.split(";")) {
        // A margin SHORTHAND resets all four sides, including the `auto` that centres. So does
        // `margin-left`/`margin-right` and a bare `width`.
        assert.ok(
          !/^\s*margin\s*:/.test(decl),
          `${cls} is re-declared later with \`${decl.trim()}\` — a margin shorthand resets margin-inline, ` +
            `cancelling the centring even though the shared rule still contains it`,
        );
        assert.ok(
          !/^\s*margin-(left|right)\s*:/.test(decl),
          `${cls} is re-declared later with \`${decl.trim()}\`, which overrides the centring`,
        );
      }
    }
  }
});

test("the tool marker no longer declares its own alignment", () => {
  // A second source of truth for the same decision is how the marker ended up capped-but-not-centred
  // while the turns were centred-and-capped.
  const marker = rule(".tool-marker");
  assert.ok(marker, ".tool-marker must have a rule");
  assert.ok(!/max-width/.test(marker), "the cap belongs to the shared rule, not to the marker");
  assert.ok(!/margin-inline/.test(marker), "and so does the centring");
  assert.ok(!/(^|;)\s*margin\s*:/.test(marker), "a margin SHORTHAND here would reset the centring");
  assert.match(marker, /margin-block:/, "vertical rhythm is set with margin-block");
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

// --- The trace lines up with the transcript (issue #129, second report) -------------------------

test("the trace's TEXT shares the transcript's left edge, not the column's", () => {
  // Reported from the fixed version: *"the tool output is padded right and not aligned with the transcript
  // content."* The trace is a full-width sibling of the transcript, and its body used `padding: … 18px`
  // measured from the COLUMN edge — while the prose above is centred at `--measure`. Two references, one
  // column, so the tool output sat 30px right of every paragraph.
  //
  // Capping the trace entirely would be wrong: its header genuinely uses the full width (`latest 5 shown ·
  // ↑↓ to traverse` is hard right). Only the text-bearing surfaces take the measure.
  const list = rule(".trace-list");
  assert.ok(list, ".trace-list must have a rule");
  assert.match(list, /max-width:\s*var\(--measure\)/, "rows on the measure");
  assert.match(list, /margin-inline:\s*auto/, "…centred like the prose");

  for (const sel of [".trace-args", ".trace-output"]) {
    const body = rule(sel);
    assert.ok(body, `${sel} must have a rule`);
    assert.match(
      body,
      /padding:\s*var\(--sp-2\)\s*max\(18px,\s*calc\(\(100% - var\(--measure\)\) \/ 2\)\)/,
      `${sel} must inset to the measure, not to 18px from the column edge`,
    );
  }
});

test("no trace rule uses a padding SHORTHAND that would reset the measure inset", () => {
  // Same class of bug as the margin shorthand that made #130 appear not to work: a shorthand declared
  // anywhere in the same rule silently wins over the longhand beside it. `.trace-detail-head` had exactly
  // that — `padding: 4px 18px` — and it took a second pass to notice.
  const head = rule(".trace-detail-head");
  assert.ok(head, ".trace-detail-head must have a rule");
  assert.ok(!/(^|;)\s*padding\s*:/.test(head), "a padding shorthand here resets the inline inset");
  assert.match(head, /padding-inline:/, "the inline inset is set explicitly");
  assert.match(head, /padding-block:/, "…and the vertical one separately");
});
