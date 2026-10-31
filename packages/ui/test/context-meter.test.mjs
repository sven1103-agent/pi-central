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

/** The LAST rule for a selector: source order decides equal specificity, so the first match can be stale. */
function rule(selector) {
  const normalised = css.replace(/\s+/g, " ");
  const wanted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...normalised.matchAll(new RegExp(`(?<![\\w-])${wanted} ?\\{([^}]*)\\}`, "g"))];
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
  const header = rule(".session-header") ?? "";
  assert.match(header, /flex-wrap:\s*nowrap/, "the row does not wrap freely; each group keeps its place");
  // Identity shrinks, the control groups do not — a clipped CONTROL label is a defect, a truncated name is not.
  const picker = rule(".picker-grid") ?? "";
  assert.match(picker, /flex:\s*none/, "the picker group never shrinks into its own label");
  const stats = rule(".header-stats") ?? "";
  assert.match(stats, /flex:\s*none/, "…and neither does the stats group");
});
