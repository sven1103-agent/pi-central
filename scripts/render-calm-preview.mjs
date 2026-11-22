#!/usr/bin/env node
/**
 * Build two self-contained pages for LOOKING at ADR-0017, because a document cannot be seen.
 *
 *   node scripts/render-calm-preview.mjs
 *   open /tmp/pi-calm-anchor.html    # where the tail sits
 *   open /tmp/pi-calm-stream.html    # how text arrives
 *
 * ## Why this exists
 *
 * ADR-0017 decides two things a reader experiences and a test cannot judge: how far above the foot the newest
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

/*
 * THE ANCHOR RULE, scoped to the PANE and not to the body.
 *
 * The first version wrote `body.anchor-middle .transcript-lane`, and every pane carried its class on the pane
 * element instead — so no selector matched, all three states rendered identically, and the page looked like
 * proof that the padding makes no difference. Found in use, by looking at it, which is what the page exists for.
 */
const anchorCss = [
  ":root { --reading-size: 15px; --reading-measure: 80ch; --tail-anchor: min(35vh, 24rem); }",
  ".anchor-middle .transcript-lane { padding-bottom: var(--tail-anchor); }",
  ".anchor-foot .transcript-lane { padding-bottom: 0; }",
  ".anchor-top .transcript-lane { padding-bottom: calc(var(--tail-anchor) * 2); }",
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
  /*
   * SET `data-overflow` THE WAY THE REAL HANDLER DOES, and that is the whole reason this function exists.
   *
   * The first version of this page was a static SSR render, so the component's scroll handler never ran,
   * `data-overflow` stayed empty, and every fade sat at `opacity: 0` — the operator reported "I cannot see any
   * fade", correctly, because no code path in the page could ever show one. A preview of a RUNTIME state has to
   * run the runtime logic; rendering the markup and hoping is how a review tool lies.
   *
   * The rule is mirrored from Transcript.tsx deliberately rather than approximated: `up` is any scroll at all,
   * `down` is "not at the end" with the same 2px tolerance the component uses for the exact-bottom case. If the
   * two ever disagree, the PREVIEW is wrong and not the component, so they are kept trivially readable.
   */
  "function setOverflow(scroller) {",
  '  var viewport = scroller.parentElement;',
  "  if (!viewport) return;",
  "  var atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;",
  '  var marks = [];',
  '  if (scroller.scrollTop > 1) marks.push("up");',
  '  if (!atEnd) marks.push("down");',
  '  viewport.setAttribute("data-overflow", marks.join(" "));',
  '  return marks;',
  "}",
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
  "  setOverflow(scroller);",
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
  "/*",
  " * The scroller must update its own fades AS THE READER SCROLLS, exactly as the component does, or the fades",
  " * only ever describe the moment the page loaded. This is the same passive listener the component attaches.",
  " */",
  'Object.keys(panes).forEach(function (k) {',
  '  var scroller = panes[k].querySelector(".transcript");',
  '  if (!scroller) return;',
  '  scroller.addEventListener("scroll", function () { setOverflow(scroller); }, { passive: true });',
  '});',
  "/*",
  " * And a control that PARKS the reader mid-history, because that is the only state in which the lower fade has",
  " * anything to say. Without it the page always sits at the end and the fade can only be believed, not seen.",
  " */",
  'document.getElementById("b-park").addEventListener("click", function () {',
  '  var pane = document.querySelector(".pane:not([hidden])");',
  '  var scroller = pane.querySelector(".transcript");',
  "  scroller.scrollTop = Math.round(scroller.scrollHeight * 0.35);",
  "  setOverflow(scroller);",
  "});",
].join("\n");

const anchorPage = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8">',
  "<title>Pi Central \u2014 ADR-0017: where the tail sits</title>",
  "<style>" + css + "</style>",
  "<style>" + anchorCss + "</style>",
  "<style>" + harness + "</style>",
  "</head><body>",
  '<div class="bar">',
  "  <strong>ADR-0017 \u2014 where the tail sits</strong>",
  '  <button id="b-middle" aria-pressed="true">middle (proposed)</button>',
  '  <button id="b-foot" aria-pressed="false">foot (today)</button>',
  '  <button id="b-top" aria-pressed="false">top (rejected)</button>',
  '  <button id="b-park">park mid-history (shows the lower fade)</button>',
  '  <span class="hint">Scroll to the bottom \u2014 it is pinned there for you. Drag or scroll to see the end-fades, which replace the scrollbar.</span>',
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

/*
 * A CORRECTION, and the most useful thing this preview produced.
 *
 * The first version put "one commit per token" beside "one commit per frame" and played both at once. The
 * operator reported no visible difference, and that was not a bug in the page — it was the page telling the
 * truth about a claim the ADR was making badly.
 *
 * Both sides committed inside the SAME requestAnimationFrame callback, so the browser painted them at identical
 * moments. That is not an artefact of the demo: a display refreshes 60 times a second, so any two commit rates
 * above 60/s are literally unwatchable as a difference, and below 60/s there is nothing to batch. Coalescing
 * per-token commits into per-frame commits is therefore INVISIBLE BY CONSTRUCTION on a 60Hz display. Its benefit
 * is main-thread CPU — measured at 550 ms against 57 ms for a 3000-character message — which a reader
 * experiences as "the window does not stutter", not as "the text arrives differently".
 *
 * So this page shows the question the complaint is actually about, which is a DIFFERENT decision: raw stream on
 * the left, deliberately paced reveal on the right. The reveal steps in units chosen so no step ends
 * mid-markdown, because slicing source characters shows the reader literal syntax — the census in ADR-0017 puts
 * that at 3-40% of all reveal positions.
 */

/*
 * REVEAL UNITS, chosen so no unit ends inside markdown syntax.
 *
 * A fenced block or a table is atomic: half a fence is a paragraph and half a table is pipes. Prose splits at a
 * sentence end, so a step never stops between `**` and its closing pair. This is the whole reason a naive
 * typewriter looks broken and this does not.
 */
function revealUnits(text) {
  const units = [];
  let cursor = 0;
  for (const block of text.split(/\n\n+/)) {
    const start = text.indexOf(block, cursor);
    if (start < 0) continue;
    const end = start + block.length;
    cursor = end;
    if (block.startsWith(FENCE) || block.startsWith("|")) {
      units.push(end);
      continue;
    }
    let from = 0;
    for (const match of block.matchAll(/[.!?:](?=\s|$)/g)) {
      const stop = match.index + 1;
      if (stop > from) {
        units.push(start + stop);
        from = stop;
      }
    }
    if (from < block.length) units.push(end);
  }
  return units;
}

const REVEAL_UNITS = revealUnits(ANSWER);
const REVEAL_STATES = REVEAL_UNITS.map((end) => renderMarkdown(ANSWER.slice(0, end)));

// The raw side: every 4-character delta, exactly what the wire carries today.
const RAW_STATES = [];
for (let end = 4; end <= ANSWER.length; end += 4) RAW_STATES.push(renderMarkdown(ANSWER.slice(0, end)));

const streamHarness = [
  "html, body { height: 100%; margin: 0; }",
  "body { background: #0e1116; color: var(--text); display: flex; flex-direction: column; overflow: hidden; font: 12px/1.4 var(--sans); }",
  ".bar { flex: none; display: flex; align-items: center; gap: 12px; padding: 9px 14px; flex-wrap: wrap; border-bottom: 1px solid var(--line); background: var(--panel); }",
  ".bar strong { font-size: 13px; }",
  ".bar button { font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 5px; cursor: pointer; background: var(--panel-2); color: var(--text); border: 1px solid var(--line-strong); }",
  ".bar .hint { color: var(--dim); max-width: 52ch; line-height: 1.5; }",
  ".bar .clock { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--accent-text); text-align: right; }",
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
  "var RAW = " + JSON.stringify(RAW_STATES) + ";",
  "var PACED = " + JSON.stringify(REVEAL_STATES) + ";",
  'var left = document.getElementById("left"), right = document.getElementById("right");',
  'var leftCol = document.getElementById("left-col"), rightCol = document.getElementById("right-col");',
  'var clock = document.getElementById("clock"), running = null;',
  "var DURATION = 8000;",
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
  "    var li = Math.min(RAW.length - 1, Math.floor(t * (RAW.length - 1)));",
  "    var ri = Math.min(PACED.length - 1, Math.floor(t * (PACED.length - 1)));",
  "    left.innerHTML = RAW[li];",
  "    right.innerHTML = PACED[ri];",
  "    leftCol.scrollTop = leftCol.scrollHeight;",
  "    rightCol.scrollTop = rightCol.scrollHeight;",
  '    clock.textContent = Math.round(t * 100) + "% \u2014 raw " + (li + 1) + "/" + RAW.length + ", reveal " + (ri + 1) + "/" + PACED.length;',
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
  "<title>Pi Central \u2014 ADR-0017: how text arrives</title>",
  "<style>" + css + "</style>",
  "<style>" + streamHarness + "</style>",
  "</head><body>",
  '<div class="bar">',
  "  <strong>ADR-0017 \u2014 how text arrives</strong>",
  '  <button id="play">\u25b6 Play both</button>',
  '  <button id="reset">Reset</button>',
  '  <span class="hint">Raw stream vs a paced reveal \u2014 a SEPARATE decision from coalescing, which is invisible on a 60Hz display. See the note in scripts/render-calm-preview.mjs.</span>',
  '  <span class="clock" id="clock">idle</span>',
  "</div>",
  '<div class="stage">',
  '  <div class="side"><h2>Raw stream \u2014 as the wire carries it (' + RAW_STATES.length + ' states)</h2>',
  '    <div class="col" id="left-col"><div class="prose" id="left"></div></div>',
  '    <div class="dock"><textarea class="composer-input" readonly>Composer</textarea></div></div>',
  '  <div class="side"><h2>Paced reveal \u2014 whole units, never mid-markdown (' + REVEAL_UNITS.length + ' steps)</h2>',
  '    <div class="col" id="right-col"><div class="prose" id="right"></div></div>',
  '    <div class="dock"><textarea class="composer-input" readonly>Composer</textarea></div></div>',
  "</div>",
  "<script>" + streamScript + "</script>",
  "</body></html>",
].join("\n");

writeFileSync("/tmp/pi-calm-stream.html", streamPage);

console.log("written /tmp/pi-calm-anchor.html  (" + Math.round(anchorPage.length / 1024) + " kB)");
console.log("written /tmp/pi-calm-stream.html  (" + Math.round(streamPage.length / 1024) + " kB)");
console.log("  raw states: " + RAW_STATES.length + ", reveal steps: " + REVEAL_UNITS.length);
console.log("");
console.log("  open /tmp/pi-calm-anchor.html");
console.log("  open /tmp/pi-calm-stream.html");
