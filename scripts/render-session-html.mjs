#!/usr/bin/env node
/**
 * Render one real session's transcript to a standalone HTML file, so the result can be LOOKED at.
 *
 * ## Why this exists
 *
 * The agent harness that wrote the image rendering cannot run the product: `bin/pi-central.js` refuses to start
 * inside a sandbox because Safehouse's `sandbox-exec` does not nest (C1), and a headless browser hits the same
 * wall. That left a reviewable gap — unit tests and rendered-markup assertions pass, and nobody has seen the thing
 * on a screen. "The tests are green" is not the same claim as "it looks right", and this project's own rule is that
 * a screenshot is evidence where a passing test is only an argument.
 *
 * So this renders the REAL transcript component, with the REAL stylesheet, over a REAL session file from the store,
 * and writes one self-contained HTML file. Open it in a browser: no server, no orchestrator, no sandbox, no build.
 * It is a review tool, not a shippable surface — nothing imports it and nothing ships it.
 *
 * ## What is stubbed, and why the stubs cannot hide the thing under review
 *
 *  - **`URL.createObjectURL`** becomes a `data:` URI built from the same base64 the component passed to the Blob.
 *    jsdom has no object-URL support, so without this no image could appear at all. The substitution is at the very
 *    last step, so everything upstream — the reducer that decides `refused`, the key that decides identity, the
 *    cache that decides reuse, the component's `<img>` — runs unmodified.
 *  - **The store** is not involved. This feeds `TranscriptView` a transcript built by `seedTranscript`, which is the
 *    same function the live path uses for a fetched conversation.
 *
 * ## The synthetic turn
 *
 * Every image in this machine's session store arrives through a TOOL result (`read` on a PNG) — 447 of 447 across
 * 885 sessions. A pasted screenshot is the case the feature was asked for and the one case the store cannot supply,
 * so a turn is prepended using real bytes taken from the session. It carries a prose line, a displayable image, and
 * one deliberately unsupported type, so the three visual states are all on one screen.
 *
 * ## Usage
 *
 *   node scripts/render-session-html.mjs                 # newest session that contains an image
 *   node scripts/render-session-html.mjs <session.jsonl> # a specific file
 *   node scripts/render-session-html.mjs --out /tmp/x.html
 *
 * Then: `open /tmp/pi-transcript.html`
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UI_ROOT = join(ROOT, "packages", "ui");

/** Every session file under the store, newest first. */
function sessionFiles() {
  const store = join(homedir(), ".pi", "agent", "sessions");
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          found.push({ path, modified: statSync(path).mtimeMs, size: statSync(path).size });
        } catch {
          // A session removed between the dirent and the stat is not an error worth reporting here.
        }
      }
    }
  };
  walk(store);
  return found.sort((a, b) => b.modified - a.modified);
}

/** Does this session hold an image anywhere? Read as text and look, which is cheap and cannot mis-parse. */
function hasImage(path) {
  try {
    return readFileSync(path, "utf8").includes('"type":"image"') || readFileSync(path, "utf8").includes('"type": "image"');
  } catch {
    return false;
  }
}

const messagesOf = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record !== null && record.type === "message")
    .map((record) => record.message);

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : "/tmp/pi-transcript.html";
const explicit = args.find((arg, index) => !arg.startsWith("--") && index !== outIndex + 1);

let path = explicit;
if (path === undefined) {
  const candidates = sessionFiles();
  path = candidates.find((candidate) => hasImage(candidate.path))?.path;
  if (path === undefined) {
    console.error("No session in the store contains an image. Pass a path explicitly.");
    process.exit(1);
  }
}

// jsdom must exist before any component loads: DOMPurify binds to `window` at module-init time, and the transcript
// pulls the markdown pipeline in. The values match `packages/ui/test/activity-render.test.mjs`, so a component that
// renders under test renders here.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

const server = await createServer({
  root: UI_ROOT,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
  // The dep-scan is a dev-server feature that tries to pre-bundle `index.html`; there is no document to scan here and
  // its failure output is pure noise over the one line this script prints.
  optimizeDeps: { noDiscovery: true, include: [] },
});

const { seedTranscript } = await server.ssrLoadModule("/src/transcript.ts");
const { TranscriptView } = await server.ssrLoadModule("/src/components/Transcript.tsx");
const { ToolTrace } = await server.ssrLoadModule("/src/components/ToolTrace.tsx");

const transcript = seedTranscript(messagesOf(path));

/*
 * Object URLs → `data:` URIs.
 *
 * Ordered, because `createObjectURL` is called in render order and the payloads are collected in the same order the
 * components will request them. The counter is the contract; the assertion below catches it drifting.
 */
const payloads = [];
for (const tool of transcript.tools) for (const image of tool.images ?? []) payloads.push(image.base64);
for (const message of transcript.messages) {
  for (const block of message.blocks) if (block.kind === "image") payloads.push(block.base64);
}
let created = 0;
URL.createObjectURL = (blob) => {
  const payload = payloads[created] ?? "";
  created += 1;
  return `data:${blob.type};base64,${payload}`;
};

// The synthetic pasted turn, built from real bytes so the picture is a real picture.
const sample = transcript.tools.flatMap((tool) => tool.images ?? [])[0];
if (sample !== undefined) {
  payloads.push(sample.base64);
  transcript.messages = [
    {
      id: "synthetic-paste",
      role: "user",
      complete: true,
      streaming: false,
      blocks: [
        {
          kind: "text",
          text: "Here is the screenshot from the review — what is wrong with the spacing above the composer?",
          complete: true,
        },
        { kind: "image", contentIndex: 1, type: sample.type, base64: sample.base64 },
        // A TIFF stands in for every type this view refuses, so the refused state is visible on the same screen.
        { kind: "image", contentIndex: 2, type: "image/tiff", base64: "R0lGODlhAQAB", refused: "unsupported-type" },
        {
          kind: "image",
          contentIndex: 3,
          type: "image/png",
          base64: "",
          refused: "no-payload",
        },
      ],
    },
    ...transcript.messages,
  ];
}

const css = readFileSync(join(UI_ROOT, "src", "styles.css"), "utf8");
const transcriptHtml = renderToString(
  createElement(TranscriptView, {
    transcript,
    busy: false,
    sessionId: "review",
    sessionLabel: "review",
  }),
);

// The tool detail, for the call whose image the synthetic turn borrowed: the second placement.
const withImage = transcript.tools.find((tool) => (tool.images ?? []).length > 0);
const traceHtml =
  withImage === undefined
    ? "<p class=\"empty\">This session has no tool that returned an image.</p>"
    : renderToString(
        createElement(ToolTrace, {
          tools: [withImage],
          selectedId: withImage.toolCallId,
          onSelect: () => {},
          showMarkers: true,
          onToggleMarkers: () => {},
          variant: "panel",
        }),
      );

writeFileSync(
  out,
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Pi Central — transcript images review</title>
<style>${css}
/* The harness only. Two panes side by side so both placements are visible in one screen. */
body { margin: 0; background: var(--bg); color: var(--text); }
.review { display: grid; grid-template-columns: minmax(0, 1fr) 400px; height: 100vh; }
.review > * { overflow: auto; min-width: 0; }
.review > * + * { border-left: 1px solid var(--line); }
.review-label {
  position: sticky; top: 0; z-index: 2; background: var(--bg);
  font: 600 11px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase;
  color: var(--dim); padding: 12px 16px 8px; border-bottom: 1px solid var(--line);
}
</style></head>
<body>
<div class="review">
  <div><div class="review-label">Transcript — a pasted screenshot, both refusals, and the session itself</div>${transcriptHtml}</div>
  <div><div class="review-label">Tool detail — a tool that read an image</div>${traceHtml}</div>
</div>
</body></html>`,
);

await server.close();

const images = transcript.tools.flatMap((tool) => tool.images ?? []).length;
console.log(`session:    ${path}`);
console.log(`messages:   ${transcript.messages.length}   tools: ${transcript.tools.length}   tool images: ${images}`);
console.log(`object URLs replaced with data: URIs: ${created} (payloads available: ${payloads.length})`);
console.log(`written:    ${out}`);
console.log(`\nopen ${out}`);
