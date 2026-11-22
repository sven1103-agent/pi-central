#!/usr/bin/env node
/**
 * Build two self-contained pages for LOOKING at ADR-0016, because a document cannot be seen.
 *
 *   node scripts/render-calm-preview.mjs
 *   open /tmp/pi-calm-anchor.html    # where the tail sits
 *   open /tmp/pi-calm-stream.html    # how text arrives
 *
 * ## Why this exists
 *
 * ADR-0016 decides two things a reader experiences and a test cannot judge: how far above the foot the newest
 * line sits, and whether streaming feels calm. The record is five commits of measurement and not one screenshot,
 * which its own author said was a gap. This is the screenshot.
 *
 * ## Why pages, not the app
 *
 * The orchestrator refuses to start inside a sandbox (C1), and a headless browser aborts under the same profile,
 * so the real dashboard cannot be opened from here. What CAN be done is what render-session-html.mjs already
 * does: render the REAL component with the REAL stylesheet over REAL message shapes, and write one file that
 * opens with no server, no build and no socket. Nothing here ships and nothing imports it.
 *
 * The two pages answer the two halves separately:
 *
 *   - **anchor** — the same transcript in three panes, toggled between the proposed 35vh padding, today's zero,
 *     and the rejected double. A probe states where the newest line sits relative to the scrollport's middle.
 *   - **stream** — one text, two arrival rates, played side by side over the same wall-clock duration. Every
 *     state is real renderMarkdown output: 269 token states against 120 frame states.
 *
 * ## Why the streaming page uses pre-rendered states
 *
 * The live alternative is a page that imports markdown.ts and re-parses per state, which means a browser build,
 * a bundler and a dev server for a review artefact. Pre-rendering every state buys a level comparison: both
 * sides are the real pipeline's output and the only difference is how often it is committed, which is exactly
 * the variable under review.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UI = join(ROOT, "packages", "ui");

const { JSDOM } = await import(join(ROOT, "node_modules", "jsdom", "lib", "api.js"));
const { createServer } = await import(join(ROOT, "node_modules", "vite", "dist", "node", "index.js"));
const { createElement } = await import(join(ROOT, "node_modules", "react", "index.js"));
const { renderToString } = await import(join(ROOT, "node_modules", "react-dom", "server.js"));

// jsdom before any module loads: DOMPurify binds to window at module-init time.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

const server = await createServer({
  root: UI,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { seedTranscript } = await server.ssrLoadModule("/src/transcript.ts");
const { TranscriptView } = await server.ssrLoadModule("/src/components/Transcript.tsx");
const { renderMarkdown } = await server.ssrLoadModule("/src/markdown.ts");
await server.close();

const FENCE = String.fromCharCode(96, 96, 96);
const css = readFileSync(join(UI, "src", "styles.css"), "utf8");

// A real assistant reply: prose, emphasis, inline code, a fence and a table.
const ANSWER = [
  "Two separate causes, and only one of them is about animation.",
  "",
  "**First, the anchor.** The newest line is pinned to the scroller's bottom edge, so following a run means your eyes travel to the foot of the window on every delta.",
  "",
  "**Second, the arrival rate.** Every message update is a state update, so the text grows by exactly the delta carried, one commit per token Pi emits.",
  "",
  FENCE + "ts",
  "const distance = current.scrollHeight - current.scrollTop - current.clientHeight;",
  "const grew = Math.max(0, current.scrollHeight - previous.scrollHeight);",
  "return distance - grew;",
  FENCE,
  "",
  "That rule is the whole fix for following, and it is **nine lines**.",
  "",
  "The cost was measured against message length, and it is the long answers that pay:",
  "",
  "| length | parses today | per frame | ratio |",
  "| --- | --- | --- | --- |",
  "| 800 | 198 | 60 | 3.2x |",
  "| 1500 | 372 | 60 | 6.3x |",
  "| 3000 | 748 | 60 | 12.5x |",
  "",
  "So the saving scales with the answer, which is exactly where a stutter hurts most: the reply you are reading as it is written.",
].join("\n");

const msg = (role, text) => ({ role, content: [{ type: "text", text }] });

// --- page 1: where the tail sits -------------------------------------------------------------

const transcript = seedTranscript([
  msg("user", "Why does the transcript end at the very bottom of the window, and why does the text arrive so harshly?"),
  msg("assistant", ANSWER),
  msg("user", "And what does a reader actually see while it streams?"),
  msg("assistant", "Prose that arrives in one piece per frame rather than per token, and a tail that sits where your eyes already are."),
]);

const transcriptHtml = renderToString(
  createElement(TranscriptView, {
    transcript,
    busy: false,
    sessionId: "preview",
    preview: () => {},
    sessionLabel: "preview",
    footer: createElement("textarea", {
      className: "composer-input",
      readOnly: true,
      defaultValue: "The composer sits here, so you can see how far the newest line is above it.",
    }),
  }),
);

const anchorCss = [
  ":root { --reading-size: 15px; --reading-measure: 80ch; --tail-anchor: min(35vh, 24rem); }",
  "body.anchor-middle .transcript-lane { padding-bottom: var(--tail-anchor); }",
  "body.anchor-foot .transcript-lane { padding-bottom: 0; }",
  "body.anchor-top .transcript-lane { padding-bottom: calc(var(--tail-anchor) * 2); }",
].join("\n");

const harness = [
  "html, body { height: 100%; margin: 0; }",
  "body { background: #0e1116; color: var(--text); display: flex; flex-direction: column; overflow: hidden; font: 12px/1.4 var(--sans); }",
  ".bar { flex: none; display: flex; align-items: center; gap: 12px; padding: 9px 14px; flex-wrap: wrap; border-bottom: 1px solid var(--line); background: var(--panel); }",
  ".bar strong { font-size: 13px; }",
  ".bar button { font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 5px; cursor: pointer; background: var(--panel-2); color: var(--text); border: 1px solid var(--line-strong); }",
  '.bar button[aria-pressed="true"] { background: var(--panel-3); border-color: var(--accent); color: var(--accent-text); }',
  ".bar .hint { color: var(--dim); }",
  ".bar .probe { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--accent-text); text-align: right; }",
  ".stage { flex: 1; min-height: 0; display: flex; }",
  ".pane { flex: 1; min-width: 0; display: flex; min-height: 0; }",
  ".pane[hidden] { display: none; }",
].join("\n");

const anchorScript = [
  'var panes = { middle: document.getElementById("p-middle"), foot: document.getElementById("p-foot"), top: document.getElementById("p-top") };',
  'var buttons = { middle: document.getElementById("b-middle"), foot: document.getElementById("b-foot"), top: document.getElementById("b-top") };',
  "// The other two panes are CLONES, so every pane renders identical markup.",
  "panes.foot.innerHTML = panes.middle.innerHTML;",
  "panes.top.innerHTML = panes.middle.innerHTML;",
  'Object.keys(panes).forEach(function (k) { panes[k].className = "pane " + panes[k].dataset.anchor; });',
  "function measure() {",
  '  var pane = document.querySelector(".pane:not([hidden])");',
  '  var scroller = pane.querySelector(".transcript");',
  '  var lane = pane.querySelector(".transcript-lane");',
  "  var kids = lane.children, last = null;",
  "  for (var i = kids.length - 1; i >= 0; i -= 1) {",
  "    if (kids[i].getBoundingClientRect().height > 0) { last = kids[i]; break; }",
  "  }",
  "  if (!scroller || !last) return;",
  "  scroller.scrollTop = scroller.scrollHeight;",
  "  var box = scroller.getBoundingClientRect();",
  "  var tail = last.getBoundingClientRect().bottom;",
  "  var footGap = Math.round(box.bottom - tail);",
  "  var vsMiddle = Math.round(box.top + box.height / 2 - tail);",
  '  var padding = getComputedStyle(lane).paddingBottom;',
  '  document.getElementById("probe").innerHTML =',
  '    "scrollport " + Math.round(box.height) + "px " + String.fromCharCode(183) + " lane padding " + padding + "<br>" +',
  '    "newest line: " + footGap + "px above the foot, " +',
  '    (vsMiddle >= 0 ? vsMiddle + "px ABOVE the middle" : (-vsMiddle) + "px BELOW the middle");',
  "}",
  "function show(which) {",
  "  Object.keys(panes).forEach(function (k) {",
  "    panes[k].hidden = k !== which;",
  '    buttons[k].setAttribute("aria-pressed", String(k === which));',
  "  });",
  "  requestAnimationFrame(function () { requestAnimationFrame(measure); });",
  "}",
  'document.getElementById("b-middle").addEventListener("click", function () { show("middle"); });',
  'document.getElementById("b-foot").addEventListener("click", function () { show("foot"); });',
  'document.getElementById("b-top").addEventListener("click", function () { show("top"); });',
  'window.addEventListener("resize", function () { requestAnimationFrame(measure); });',
  'window.addEventListener("load", function () { requestAnimationFrame(function () { requestAnimationFrame(measure); }); });',
].join("\n");

const anchorPage = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8">',
  "<title>Pi Central \u2014 ADR-0016: where the tail sits</title>",
  "<style>" + css + "</style>",
  "<style>" + anchorCss + "</style>",
  "<style>" + harness + "</style>",
  "</head><body>",
  '<div class="bar">',
  "  <strong>ADR-0016 \u2014 where the tail sits</strong>",
  '  <button id="b-middle" aria-pressed="true">middle (proposed)</button>',
  '  <button id="b-foot" aria-pressed="false">foot (today)</button>',
  '  <button id="b-top" aria-pressed="false">top (rejected)</button>',
  '  <span class="hint">Scroll to the bottom \u2014 it is pinned there for you. Then resize the window.</span>',
  '  <span class="probe" id="probe">measuring\u2026</span>',
  "</div>",
  '<div class="stage">',
  '  <div class="pane anchor-middle" id="p-middle" data-anchor="anchor-middle">' + transcriptHtml + "</div>",
  '  <div class="pane anchor-foot" id="p-foot" data-anchor="anchor-foot" hidden></div>',
  '  <div class="pane anchor-top" id="p-top" data-anchor="anchor-top" hidden></div>',
  "</div>",
  "<script>" + anchorScript + "</script>",
  "</body></html>",
].join("\n");

writeFileSync("/tmp/pi-calm-anchor.html", anchorPage);

// --- page 2: how text arrives ----------------------------------------------------------------

const tokenFrames = [];
for (let end = 4; end <= ANSWER.length; end += 4) tokenFrames.push(renderMarkdown(ANSWER.slice(0, end)));

const FRAMES = 120;
const frameFrames = [];
for (let i = 1; i <= FRAMES; i += 1) {
  frameFrames.push(renderMarkdown(ANSWER.slice(0, Math.max(1, Math.round((ANSWER.length * i) / FRAMES)))));
}

const streamHarness = [
  "html, body { height: 100%; margin: 0; }",
  "body { background: #0e1116; color: var(--text); display: flex; flex-direction: column; overflow: hidden; font: 12px/1.4 var(--sans); }",
  ".bar { flex: none; display: flex; align-items: center; gap: 12px; padding: 9px 14px; flex-wrap: wrap; border-bottom: 1px solid var(--line); background: var(--panel); }",
  ".bar strong { font-size: 13px; }",
  ".bar button { font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 5px; cursor: pointer; background: var(--panel-2); color: var(--text); border: 1px solid var(--line-strong); }",
  ".bar .hint { color: var(--dim); }",
  ".bar .clock { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--accent-text); }",
  ".stage { flex: 1; min-height: 0; display: flex; }",
  ".side { flex: 1; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--line); }",
  ".side:last-child { border-right: 0; }",
  ".side h2 { flex: none; margin: 0; padding: 8px 14px; font: 600 11px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--dim); border-bottom: 1px solid var(--line); }",
  ".side .col { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px; }",
  ".side .prose { font-size: 15px; line-height: 1.55; }",
  ".side .composer-input { width: 100%; height: calc(1.5em * 3 + 22px); background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-3); padding: 10px 12px; color: var(--dim); font: 15px/1.5 var(--sans); }",
  ".dock { flex: none; padding: 0 18px 8px; }",
].join("\n");

const streamScript = [
  "var TOKEN = " + JSON.stringify(tokenFrames) + ";",
  "var FRAME = " + JSON.stringify(frameFrames) + ";",
  'var left = document.getElementById("left"), right = document.getElementById("right");',
  'var leftCol = document.getElementById("left-col"), rightCol = document.getElementById("right-col");',
  'var clock = document.getElementById("clock"), running = null;',
  "var DURATION = 6000;",
  "function reset() {",
  "  if (running) { cancelAnimationFrame(running); running = null; }",
  '  left.innerHTML = ""; right.innerHTML = "";',
  "  leftCol.scrollTop = 0; rightCol.scrollTop = 0;",
  '  clock.textContent = "idle";',
  "}",
  "function play() {",
  "  reset();",
  "  var start = performance.now();",
  "  function step(now) {",
  "    var t = Math.min(1, (now - start) / DURATION);",
  "    var li = Math.min(TOKEN.length - 1, Math.floor(t * (TOKEN.length - 1)));",
  "    var ri = Math.min(FRAME.length - 1, Math.floor(t * (FRAME.length - 1)));",
  "    left.innerHTML = TOKEN[li];",
  "    right.innerHTML = FRAME[ri];",
  "    leftCol.scrollTop = leftCol.scrollHeight;",
  "    rightCol.scrollTop = rightCol.scrollHeight;",
  '    clock.textContent = Math.round(t * 100) + "% \u2014 token " + (li + 1) + "/" + TOKEN.length + ", frame " + (ri + 1) + "/" + FRAME.length;',
  "    if (t < 1) running = requestAnimationFrame(step);",
  '    else { running = null; clock.textContent = "done"; }',
  "  }",
  "  running = requestAnimationFrame(step);",
  "}",
  'document.getElementById("play").addEventListener("click", play);',
  'document.getElementById("reset").addEventListener("click", reset);',
].join("\n");

const streamPage = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8">',
  "<title>Pi Central \u2014 ADR-0016: how text arrives</title>",
  "<style>" + css + "</style>",
  "<style>" + streamHarness + "</style>",
  "</head><body>",
  '<div class="bar">',
  "  <strong>ADR-0016 \u2014 how text arrives</strong>",
  '  <button id="play">\u25b6 Play both</button>',
  '  <button id="reset">Reset</button>',
  '  <span class="hint">Same text, same wall-clock duration. Left commits per token, right once per frame.</span>',
  '  <span class="clock" id="clock">idle</span>',
  "</div>",
  '<div class="stage">',
  '  <div class="side"><h2>Today \u2014 one commit per token (' + tokenFrames.length + ' states)</h2>',
  '    <div class="col" id="left-col"><div class="prose" id="left"></div></div>',
  '    <div class="dock"><textarea class="composer-input" readonly>Composer</textarea></div></div>',
  '  <div class="side"><h2>Proposed \u2014 one commit per frame (' + frameFrames.length + ' states)</h2>',
  '    <div class="col" id="right-col"><div class="prose" id="right"></div></div>',
  '    <div class="dock"><textarea class="composer-input" readonly>Composer</textarea></div></div>',
  "</div>",
  "<script>" + streamScript + "</script>",
  "</body></html>",
].join("\n");

writeFileSync("/tmp/pi-calm-stream.html", streamPage);

console.log("written /tmp/pi-calm-anchor.html  (" + Math.round(anchorPage.length / 1024) + " kB)");
console.log("written /tmp/pi-calm-stream.html  (" + Math.round(streamPage.length / 1024) + " kB)");
console.log("");
console.log("  open /tmp/pi-calm-anchor.html");
console.log("  open /tmp/pi-calm-stream.html");
