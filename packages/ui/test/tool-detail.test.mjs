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
  // The bar now carries an `Open in trace` link (issue #136), so an `onClick` is expected — but it must
  // not also toggle the disclosure, or a request for the full view would just open the preview.
  assert.match(marker, /stopPropagation\(\)/, "the trace link must not toggle the disclosure");
  assert.ok(
    !/onSelect|setOpenTool/.test(marker),
    "and nothing on the bar changes a selection elsewhere — the disclosure is the primary action",
  );
  assert.match(marker, /<ToolDetail/, "…and each call renders the detail component in place");
  // `Open in trace` moved ONTO the bar in issue #136, rather than sitting in a second header bar inside
  // `ToolDetail`. That is the point of the change: one bar, so the reader can close what they opened
  // without moving the mouse.
  assert.match(marker, /Open in trace/, "the escape hatch is on the same bar as the disclosure");
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
  const frame = /\.tool-detail\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(frame, /border-left:\s*3px solid var\(--quarantine\)/, "the hatched gutter");
  // Scoped to THIS rule, not to the stylesheet: `.quarantine` also has a hatch, so a whole-file search
  // passed even with the gradient removed from `.tool-detail`. Found by falsifying it.
  assert.match(frame, /repeating-linear-gradient/, "…and the hatch itself, inside this rule");

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
