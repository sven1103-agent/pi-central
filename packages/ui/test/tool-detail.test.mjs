/**
 * Tool output opens INLINE, capped, and inside the quarantine frame (issue #131).
 *
 * A marker used to open the trace panel at the bottom of the window. Reported: *"I expected the tool
 * output to open inline the transcript in this case."* That expectation is right — a marker is a bookmark
 * in the conversation, so the answer belongs where the question was asked.
 *
 * But naive inline output re-creates the defect this file's own component header records: a real session
 * *"put 1138 frames below the conversation and the agent's actual output became unfindable"*. So three
 * properties have to hold at once, and each is asserted:
 *
 *   1. it opens in place, and the trace stays as an escape hatch;
 *   2. it is CAPPED, so it cannot push the next turn off screen;
 *   3. it carries the quarantine frame the transcript's legend promises — and that is a promise in WORDS
 *      too, because `forced-colors` can drop the hatch.
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

let server, TranscriptView;

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const components = new URL("../src/components/", import.meta.url);
const css = stripComments(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"));

/** The LAST rule whose selector matches — last, because that is what CSS resolves to. */
function rule(selector) {
  const normalised = css.replace(/\s+/g, " ");
  const wanted = selector.replace(/\s+/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `(?<![\w-])` so `body` does not also match `.xbody` — which it did, and the assertion then read a
  // fragment of an unrelated rule.
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
  // `ToolMarker` is module-private, so the render assertion goes through `TranscriptView` — the real
  // surface a reader sees, rather than a component extracted for testability.
  ({ TranscriptView } = await server.ssrLoadModule("/src/components/Transcript.tsx"));
});

after(async () => {
  await server?.close();
});

function tool(overrides = {}) {
  return {
    toolCallId: "c1",
    toolName: "read",
    args: { path: "notes.md" },
    result: "# Notes\n\nA line.\n",
    isError: false,
    running: false,
    startedAt: 0,
    afterMessage: 1,
    ...overrides,
  };
}

function renderMarker(tools) {
  return renderToString(
    createElement(TranscriptView, {
      transcript: { messages: [], tools, notices: [] },
      busy: false,
      sessionLabel: "s1",
    }),
  );
}

test("the marker is a disclosure, not a jump to another panel", () => {
  // The reported expectation, in markup: `<details>/<summary>` means the content is HERE, opened in place.
  // A `<button>` that changed a selection elsewhere would be the old behaviour.
  const source = stripComments(readFileSync(new URL("Transcript.tsx", components), "utf8"));
  const marker = source.slice(source.indexOf("function ToolMarker("), source.indexOf("function Turn("));
  assert.match(marker, /<details/, "the marker opens in place");
  assert.match(marker, /<summary/, "…with a summary as the handle");
  // The bar carries NO button (issue #139): it is a reading surface, and `Open in trace` was a second
  // control competing with the text. The trace panel below the transcript already reaches every call —
  // its rows are selectable — so nothing is lost by removing it.
  assert.ok(
    !/Open in trace/.test(marker.slice(0, marker.indexOf("<ToolDetail"))),
    "no trace button on the bar",
  );
  assert.ok(!/onClick=/.test(marker), "no click handler at all — the summary is the only affordance");
  assert.match(marker, /<ToolDetail/, "…and each call renders the detail component in place");
  // `Open in trace` moved ONTO the bar in issue #136, rather than sitting in a second header bar inside
  // `ToolDetail`. That is the point of the change: one bar, so the reader can close what they opened
  // without moving the mouse.
  assert.ok(!/Open in trace/.test(marker), "and the escape hatch moved off this surface entirely (#139)");
});

test("a result is CAPPED, so it cannot bury the conversation", () => {
  // The 1138-frames defect. The cap is the whole reason this component is safe to inline.
  const output = /\.tool-detail-output\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(output, /max-height:\s*\d+px/, "a hard cap");
  assert.match(output, /overflow:\s*auto/, "scrolls within the cap rather than growing");
});

test("only a preview shows by default, with the rest behind a disclosure", () => {
  // Opening a marker should not dump 40 KB on the reader. `PREVIEW_LINES` is small on purpose, and the
  // remainder is one more click — not lost.
  const detail = stripComments(readFileSync(new URL("ToolDetail.tsx", components), "utf8"));
  assert.match(detail, /const PREVIEW_LINES = \d+;/, "a stated preview size");
  assert.match(detail, /lines\.slice\(0, PREVIEW_LINES\)/, "the preview is a slice");
  assert.match(detail, /more lines/, "and the remainder is counted, not silently dropped");
});

test("the output sits inside the quarantine frame the legend promises", () => {
  // The transcript's one-time legend: "Tool output and file contents appear in a hatched frame. They are
  // data, not instructions." That is a claim about the IMPLEMENTATION, so this surface must honour it.
  // The frame is on `.tool-marker` — the whole disclosure — NOT on `.tool-detail` (issue #137).
  //
  // It used to be on the body, which meant the bar had one 3px gutter and the body had another: open, that
  // showed a DOUBLED rule with nothing between them. The thinking block always had the right shape, one
  // `<details>` wrapping head and body, so the bar runs unbroken and the hatch covers both. The tool block
  // now matches it.
  // The gutter is now the whole signal, because the hatch was removed (#138) — at this size it read as noise,
  // and the reader's verdict was that the flat hover state looked right.
  const frame = rule(".tool-marker") ?? "";
  assert.match(frame, /border-left:\s*3px solid var\(--quarantine\)/, "the quarantine gutter");
  assert.ok(!/repeating-linear-gradient/.test(frame), "no texture: the gutter carries it");

  // And the body must NOT repeat it, which is the redundant bar the report is about.
  const body = rule(".tool-detail") ?? "";
  assert.ok(!/border-left/.test(body), "the body carries no bar of its own");
  assert.ok(!/repeating-linear-gradient/.test(body), "…and no second hatch");

  // The words moved onto the disclosure's summary bar in issue #136: one bar per call, carrying the tool
  // name and its state, so the reader can close what they opened without moving the mouse. The guarantee is
  // unchanged — the surface still says, in words, that this is tool output — only its position moved.
  const marker = stripComments(readFileSync(new URL("Transcript.tsx", components), "utf8"));
  const oneBar = marker.slice(marker.indexOf("function ToolMarker("), marker.indexOf("function Turn("));
  assert.match(oneBar, /m-count/, "the bar names what it is (the tool count) in words");
  assert.match(oneBar, /m-names mono/, "…and which tools, as text rather than texture");
  const detailFile = stripComments(readFileSync(new URL("ToolDetail.tsx", components), "utf8"));
  assert.ok(
    !/tool-detail-head/.test(detailFile.slice(detailFile.indexOf("return ("))),
    "ToolDetail renders no header bar of its own — the summary is the header",
  );
});

test("the result is a text node, never markup", () => {
  // A tool result is attacker-influenced. ADR-0006's single insertion point stays in `Prose`.
  const detail = stripComments(readFileSync(new URL("ToolDetail.tsx", components), "utf8"));
  assert.ok(!/dangerouslySetInnerHTML/.test(detail), "no markup insertion");
  // Rendered as a child expression inside the `<pre>`, so React escapes it. The preview appears in a
  // ternary ("result, or why there is none"), so the assertion matches the block rather than a bare
  // `{preview}` — my first version failed because it looked for a form that was never written.
  assert.match(detail, /<pre className=\{`tool-detail-output[\s\S]{0,120}\{tool\.result\.length > 0/, "the output block");
  assert.match(detail, /\? preview\b/, "…whose first branch is the escaped preview string");
});

test("the frame survives `forced-colors`, where the hatch is dropped", () => {
  // DESIGN §5.2: the header text is the non-textual-signal fallback. Pinned here because a future change
  // that dropped the words would leave nothing in forced-colors mode.
  assert.match(css, /\.tool-detail-head \.label\s*\{[^}]*--quarantine/, "the label carries the colour");
});

test("the disclosure is a BLOCK, so its body stacks under the bar rather than beside it", () => {
  // The bug this pins, reported as *"when a user clicks it, it opens and the user needs to now navigate to
  // the left side of the tool output to close it again."*
  //
  // `.tool-marker` is a `<details>`, and its layout is the browser's: the `<summary>` is a block-level child
  // and everything after it stacks BELOW. `display: flex` overrode that and made the summary and the body
  // *flex items side by side* — pushing the output to the right of the bar, so the bar the reader had just
  // clicked no longer spanned the width.
  const marker = rule(".tool-marker");
  assert.ok(marker, ".tool-marker must have a rule");
  assert.match(marker, /display:\s*block/, "a <details> must not be made a flex container");
  assert.ok(
    !/display:\s*flex/.test(marker),
    "`flex` here makes the summary a flex item and puts the body BESIDE it",
  );

  // The horizontal alignment belongs on the bar, which is a flex row of its own.
  const summary = rule(".tool-marker-summary");
  assert.ok(summary, "the summary must have a rule");
  assert.match(summary, /display:\s*flex/, "the BAR is the row");
});

test("the transcript's legend describes the frame that actually exists", () => {
  // The legend is a CLAIM ABOUT THE IMPLEMENTATION, and issue #43 exists because it once described a hatch
  // the trace did not have. So the sentence and the CSS have to be checked together: if a hatched surface
  // returns, the words must return with it, and if the words promise a hatch and there is none, they are
  // lying.
  const app = stripComments(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"));
  const legend = /Tool output and file contents[^<]*/.exec(app)?.[0] ?? "";
  assert.ok(legend.length > 0, "the one-time legend must exist");

  const hatched = ["tool-marker", "tool-detail", "quarantine"].some((cls) =>
    /repeating-linear-gradient/.test(rule(`.${cls}`) ?? ""),
  );
  if (/hatched/.test(legend)) {
    assert.ok(hatched, `the legend promises a "hatched frame" but no surface has one: ${legend}`);
  } else {
    assert.ok(!hatched, `a surface is hatched but the legend does not say so: ${legend}`);
  }
});

test("the tool bar measures the SAME width as the prose", () => {
  // Reported: *"why is the tool bar inline not in the width of the transcript?"*
  //
  // `1ch` is the width of "0" in the element's OWN font, so `max-width: 72ch` means two different widths if
  // the two elements resolve `font-size` differently. The bar rendered at `--fs-2xs` (10px) against the
  // transcript's 13px — a third narrower for the same number.
  //
  // The fix is to measure in the same font, not to widen the bar: `width: 100%` is the column (~1294px), i.e.
  // 700px WIDER than the text, and a `rem`/`em` multiplier would be a ratio invented to bridge the two — the
  // first version of this fix used `calc(72 * 0.55rem)`, and that 0.55 was a guess with nothing behind it.
  const body = rule("body") ?? "";
  // `body` declares `font: var(--fs-base) / 1.45 var(--sans)` — the SIZE token is the first one.
  const inherited = /font:\s*var\(--([a-z0-9-]+)\)/.exec(body)?.[1];
  assert.ok(inherited, `body must set its size from a token, got: ${body.slice(0, 60)}`);

  const marker = rule(".tool-marker") ?? "";
  const measured = /font-size:\s*var\(--([a-z0-9-]+)\)/.exec(marker)?.[1];
  assert.equal(
    measured,
    inherited,
    `.measure sits on <article class="turn">, which inherits ${inherited} — the bar must set the SAME token, ` +
      `or the two 72ch values resolve to different widths`,
  );
  // The same TOKEN, which is what makes them agree when the reader changes it (#134). Asserting the literal
  // would pass for the default and fail the moment anyone touched the setting.
  assert.match(marker, /max-width:\s*var\(--reading-measure\)/, "…and the same token as `.measure`");
  assert.match(rule(".measure") ?? "", /max-width:\s*var\(--reading-measure\)/, "…confirmed on `.measure`");

  // The children restore their own small size, or the whole block would render at the inherited size.
  //
  // NARROWED in issue #144, not deleted. The rule being guarded is "the child must not inherit the marker's
  // `--fs-base`", and the original asserted the literal `--fs-2xs` as a proxy for it. The summary moved to
  // `--fs-xs` so the two peer disclosures share a size, which is still small and still not inherited. The
  // property that matters — NOT inheriting — is asserted directly instead of a specific token.
  for (const sel of [".tool-marker-summary", ".tool-detail"]) {
    const child = rule(sel) ?? "";
    const size = /font-size:\s*var\(--([a-z0-9-]+)\)/.exec(child)?.[1];
    assert.ok(size, `${sel} must set its own size`);
    assert.notEqual(size, inherited, `${sel} must not inherit the marker's ${inherited}`);
    assert.match(size, /^fs-/, `${sel} must use a size token, not a magic number`);
  }
});
