/**
 * An image in the file viewer (issue #106).
 *
 * Two properties matter more than the rendering:
 *
 *   1. **It is an `<img>` with a blob URL.** Not inline SVG, not `dangerouslySetInnerHTML`. That keeps
 *      ADR-0006's single insertion point at one, and it means the SVG safety property is the browser's
 *      (an image document cannot run script or load a `file://` subresource) rather than a promise
 *      about our own parser.
 *   2. **The type is the orchestrator's.** The component displays the type it is handed; it never
 *      sniffs, and never lets the browser decide what the bytes are.
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

// jsdom has no `URL.createObjectURL`; the component's effect runs in the browser, not in SSR, so a
// stub is enough to keep the module importable and to prove the component ASKS for a blob URL.
globalThis.URL.createObjectURL = globalThis.URL.createObjectURL ?? (() => "blob:stub");
globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL ?? (() => undefined);

let server;
let ImageViewer, FilePane;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ ImageViewer } = await server.ssrLoadModule("/src/components/ImageViewer.tsx"));
  ({ FilePane } = await server.ssrLoadModule("/src/components/FilePane.tsx"));
});

after(async () => {
  await server?.close();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("an image renders as an <img> with the filename as alt text", () => {
  // The alt text is the filename, not "image" — the latter describes nothing.
  const html = renderToString(createElement(ImageViewer, {
    path: "screenshots/idle.png",
    type: "image/png",
    base64: PNG.toString("base64"),
    bytes: PNG.length,
  }));
  assert.match(html, /<img[^>]*class="imagepane-img"/);
  assert.match(html, /alt="screenshots\/idle\.png"/);
  assert.match(html, /image\/png/, "the type is shown, and it is the one it was given");
});

test("an image is never inserted as markup", () => {
  // ADR-0006 keeps exactly ONE `dangerouslySetInnerHTML` in the whole UI (`Prose`). Inlining an SVG
  // would quietly make it two, which is why the component uses `<img src>` and nothing else.
  const source = readFileSync(new URL("../src/components/ImageViewer.tsx", import.meta.url), "utf8");
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.ok(!/dangerouslySetInnerHTML/.test(stripped), "an image must never be inserted as markup");
  assert.ok(!/<svg/.test(stripped), "and never inlined");
});

test("the blob URL is created in an effect and revoked on cleanup", () => {
  // A URL is a resource with a lifetime. Held in state it would be recreated on every render and never
  // released; eight 8 MB images would accumulate for as long as the tab is open.
  const source = readFileSync(new URL("../src/components/ImageViewer.tsx", import.meta.url), "utf8");
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.match(stripped, /URL\.createObjectURL/, "a blob URL, so no data: URI is built by hand");
  assert.match(stripped, /URL\.revokeObjectURL/, "…and it is released");
  assert.match(stripped, /return \(\) => URL\.revokeObjectURL/, "on cleanup, not on a timer");
});

test("an undecodable image says so rather than showing an empty box", () => {
  // An empty pane reads as "this file is empty", which is a different fact. Same rule as every other
  // refusal in this pane.
  const source = readFileSync(new URL("../src/components/ImageViewer.tsx", import.meta.url), "utf8");
  assert.match(source, /onError/, "a decode failure must be caught");
  assert.match(source, /Could not display/, "and stated");
});

test("the file viewer offers a text-only control only for text", () => {
  // The wrap toggle does nothing to an image, and a control that cannot do anything is a lie about
  // the state — the same rule the dotfile and panel toggles follow.
  const html = renderToString(createElement(FilePane, {
    path: "pixel.png",
    state: { status: "loaded", content: { kind: "image", type: "image/png", base64: PNG.toString("base64") }, bytes: PNG.length },
    wrapped: true,
    onToggleWrap() {},
    onClose() {},
  }));
  assert.ok(!/No wrap|Wrap lines/.test(html), "no wrap control on an image");
  assert.ok(!/line[s]? ·/.test(html), "and no line count: an image has no lines");
  assert.match(html, /image\/png|imagepane/, "but the image is there");

  const text = renderToString(createElement(FilePane, {
    path: "a.txt",
    state: { status: "loaded", content: { kind: "text", text: "hi\n" }, bytes: 3 },
    wrapped: true,
    onToggleWrap() {},
    onClose() {},
  }));
  assert.match(text, /No wrap/, "…and text still gets both");
  // `"hi\n`.split("\n")` is ["hi", ""] — a trailing newline starts an empty second line, so the
  // honest count is 2. My first expectation here said 1, and the test caught me rather than the code.
  assert.match(text, /2 lines/);
});
