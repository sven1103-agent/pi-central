/**
 * The context meter, and the header it sits in.
 *
 * ## Why these exist
 *
 * The header's telemetry went through three shapes in two reviews. First a metrics strip; then a `Usage`
 * disclosure that, when opened, pushed the pickers onto two more lines and stranded its own button at the far right
 * of a four-row header (`img_23.png`); now a meter and a cost, always visible.
 *
 * The properties worth guarding are the ones a future tidy-up would break silently:
 *
 *   1. **unreported is not zero** — an empty bar would claim a measurement Pi has not made;
 *   2. **the threshold changes the bar AND the words**, so pressure never depends on colour;
 *   3. **the header states no number the panel also states** — one value, one place, one format.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

let server, ContextMeter, CONTEXT_PRESSURE_PERCENT;

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/**
 * The rule whose SELECTOR IS EXACTLY `selector`.
 *
 * Anchored at the start of a line, and that anchor is load-bearing: a compound selector that *ends* in the same class
 * matches a loose pattern. `.rail-row:hover .context-bar { ... }` satisfied `/\\.context-bar ?\\{/`, so a question
 * about the BASE track answered itself with a state override and this test failed for a reason that had nothing to do
 * with the gauge. Found when a hover override was added to the rail; the selector is the subject, so it is matched as
 * one.
 *
 * The LAST match still wins, because source order decides equal specificity.
 */
function rule(selector) {
  const wanted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`^${wanted} ?\\{([^}]*)\\}`, "gm"))];
  return all.length > 0 ? all[all.length - 1][1] : undefined;
}

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ ContextMeter, CONTEXT_PRESSURE_PERCENT } = await server.ssrLoadModule("/src/components/ContextMeter.tsx"));
});

after(async () => {
  await server?.close();
});

const render = (percent) => renderToString(createElement(ContextMeter, { percent }));

test("a measured value renders a meter with the number beside it", () => {
  const html = render(42);
  assert.match(html, /role="meter"/, "a gauge in a known range, not a decorated div");
  assert.match(html, /aria-valuenow="42"/, "the value is exposed once, by the element");
  assert.match(html, /aria-valuemin="0"/);
  assert.match(html, /aria-valuemax="100"/);
  assert.match(html, /width:42%/, "the fill is the value");
  assert.match(html, /ctx 42%/, "…and the number is readable without the bar");
});

test("an unreported value is NOT an empty bar", () => {
  /*
   * `contextPercent === null` means Pi has not reported usage yet. A 0%-full bar would say "you have a whole window
   * free", which is a claim about a measurement nobody made — and the reader would then be surprised by a
   * compaction. This is the same rule `formatContext` follows for the text.
   */
  const html = render(null);
  assert.ok(!/role="meter"/.test(html), "no meter, because there is nothing to gauge");
  assert.ok(!/width:/.test(html), "and no fill at all");
  assert.match(html, /ctx —/, "the honest label");
});

test("past the threshold the bar AND the words change, so colour is never alone", () => {
  const under = render(CONTEXT_PRESSURE_PERCENT - 1);
  assert.ok(!/is-full/.test(under), "below the threshold is not marked");
  assert.match(under, /ctx 79%/, `the label is the plain reading`);

  const at = render(CONTEXT_PRESSURE_PERCENT);
  assert.match(at, /is-full/, "at the threshold the meter is marked");
  assert.match(at, /ctx 80% full/, "…and the word `full` appears, which survives forced-colors");
});

test("the fill goes amber rather than red, because pressure is not failure", () => {
  // `--warn`, not `--danger`: a nearly-full context is a warning about what happens next, not a fault. Red is this
  // project's colour for a failed run, and using it here would make two different facts look the same.
  const full = rule(".context-meter.is-full .context-meter-fill") ?? "";
  assert.match(full, /background:\s*var\(--warn\)/, "amber fill");
  assert.ok(!/--danger/.test(full), "not the failure colour");
  const label = rule(".context-meter.is-full .context-meter-label") ?? "";
  assert.match(label, /var\(--warn-text\)/, "the text uses the lightened sibling, so it stays AA on the header");
});

test("the header shows context and cost, and NOT the lookups", () => {
  /*
   * The rule from `img_23.png`: a disclosure offering a second copy of what the Session panel already lists is
   * density without a decision, and opening it broke the row. Tokens and message count stay in the panel.
   */
  const header = readFileSync(new URL("../src/components/SessionHeader.tsx", import.meta.url), "utf8");
  assert.match(header, /<ContextMeter/, "context usage is shown");
  assert.match(header, /formatCost/, "…so is cost");
  assert.ok(!/formatTokens/.test(header), "tokens are a lookup, and the panel has them");
  assert.ok(!/messageCount/.test(header), "…as is the message count");
  assert.ok(!/aria-expanded/.test(header), "no disclosure in the header: that is what broke the row");
});

test("the header cannot scatter into four rows", () => {
  // The defect: one extra element was enough to push the pickers onto two more lines and strand a button.
  //
  // The header is now a floating COMPANION inside the transcript rather than a full-width band, and inside the
  // narrow-container query it deliberately wraps — a compact row has to. `nowrap` is therefore the base rule, and
  // the guarded property is that the CONTROL GROUPS never shrink into their own labels, which is what broke.
  const header = /(?:^|\n)\.session-header\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(header, /flex-wrap:\s*nowrap/, "the row does not wrap freely in its wide, floating form");
  // Identity shrinks, the control groups do not — a clipped CONTROL label is a defect, a truncated name is not.
  /*
   * The header is a companion box now, not a row: `.picker-grid` keeps `flex: none` for the row layout it still uses
   * in the narrow-container form, and the box's own width is what bounds it in the wide form. What must hold in both
   * is that no group shrinks into its own label.
   */
  const picker = /(?:^|\n)\.picker-grid\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(picker, /flex:\s*none|grid-template-columns|flex-direction:\s*column/,
    `the picker group keeps its own width; got ${picker}`);
  // Read with a direct regex rather than `rule()`: that helper stops at the first `}`, and this rule's doc comment
  // contains braces, so it returned a fragment. A guard that reads half a rule can pass for the wrong reason.
  const stats = /(?:^|\n)\.header-stats\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(stats, /flex:\s*none/, `…and so does the stats group; got ${stats}`);
  // The base `.session-header` rule must still refuse to wrap; the narrow-container query is the one place it may.
  const base = /(?:^|\n)\.session-header\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(base, /flex-wrap:\s*nowrap/, "the wide form does not wrap freely");
});

// --- The gauge's width is one value, wherever it is drawn (issue #13) -----------------------------

/**
 * The `:root` custom property, read out of the stylesheet.
 *
 * These two surfaces are the same gauge at two sizes, and they had two independent widths — the rail's
 * `max-width: 120px` beside the header's `width: 76px`. Widening one and not the other is exactly what a
 * maintainer asked for after seeing them together, which is the point: nothing failed, so nothing stopped it.
 * Prose claiming "same gauge" is not a mechanism; this is.
 */
function token(name) {
  const declared = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  assert.ok(declared, `${name} must be declared in :root`);
  return declared[1].trim();
}

test("both gauges are sized from ONE token, so neither can be widened alone", () => {
  const width = token("--gauge-width");
  assert.match(width, /^\d+px$/, `--gauge-width should be a concrete length, got ${width}`);

  // The header meter takes the token directly.
  assert.match(rule(".context-meter-track"), /width:\s*var\(--gauge-width\)/);

  /*
   * The rail bar FILLS its track rather than carrying the token itself.
   *
   * It used to be `flex: 1; max-width: var(--gauge-width)`, which made its length depend on how much room its own
   * label needed — so no two rows shared a gauge length and the `ctx` labels below them started at different x. The
   * roster reported exactly that raggedness.
   *
   * The width now comes from the rail's grid track (`grid-template-columns: var(--gauge-width) auto`), so the token is
   * still the ONE source: it is declared on the track instead of on the bar. The bar takes `width: 100%` of it.
   */
  assert.match(rule(".context-bar"), /width:\s*100%/, "the bar fills its track");
  assert.doesNotMatch(rule(".context-bar"), /max-width:/, "…and does not cap itself independently");

  /*
   * The LAST `.rail-row .r3` rule, not the first: the file declares it twice — once with the shared type
   * (`font-family`, `overflow`) and once with the layout. `RegExp.exec` returns the first match, and the first one has
   * no `grid-template-columns`, so a naive lookup reads the wrong rule and the assertion fails for the wrong reason.
   */
  const railRow = [...css.matchAll(/\.rail-row \.r3\s*\{([^}]*)\}/g)].map((m) => m[1]).at(-1) ?? "";
  assert.match(
    railRow,
    /grid-template-columns:\s*var\(--gauge-width\)/,
    "the rail's gauge track is the token, so all rows share one gauge length",
  );

  // Neither may reintroduce a literal of its own. Matched as a DECLARATION, i.e. after `;`/start — a bare
  // `width: \d+px` pattern also matches inside `min-width`, which is a legitimate floor rather than a fixed size.
  const barWidth = /(?:^|;)\s*width:\s*\d+px/.exec(rule(".context-bar"));
  assert.equal(barWidth, null, `the bar's width comes from its track, not a literal (found ${barWidth?.[0]?.trim()})`);
  assert.doesNotMatch(rule(".context-meter-track"), /max-width:/, "the header meter takes the token without a cap");
});
