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
import { createRoot } from "react-dom/client";
import { act } from "react";

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

/**
 * Mount for real, so effects run.
 *
 * `renderToStaticMarkup` runs no effects — which is precisely why the `<img src={undefined}>` bug
 * shipped: the component's first frame looks fine in static markup either way. Only a mounted render
 * exercises the blob-URL effect.
 */
function mount(element) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { html: host.innerHTML, unmount: () => act(() => root.unmount()) };
}

test("an image renders as an <img> with the filename as alt text", () => {
  // The alt text is the filename, not "image" — the latter describes nothing. Mounted, because the
  // `<img>` only exists once the blob URL does.
  const { html, unmount } = mount(createElement(ImageViewer, {
    path: "screenshots/idle.png",
    type: "image/png",
    base64: PNG.toString("base64"),
    bytes: PNG.length,
  }));
  assert.match(html, /<img[^>]*class="imagepane-img"/);
  assert.match(html, /alt="screenshots\/idle\.png"/);
  assert.match(html, /image\/png/, "the type is shown, and it is the one it was given");
  unmount();
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
  const { html, unmount } = mount(createElement(FilePane, {
    path: "pixel.png",
    state: { status: "loaded", content: { kind: "image", type: "image/png", base64: PNG.toString("base64") }, bytes: PNG.length },
    wrapped: true,
    onToggleWrap() {},
    onClose() {},
  }));
  assert.ok(!/No wrap|Wrap lines/.test(html), "no wrap control on an image");
  assert.ok(!/line[s]? ·/.test(html), "and no line count: an image has no lines");
  assert.match(html, /image\/png|imagepane/, "but the image is there");
  unmount();

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

// --- The bug this shipped with (issue #108) -------------------------------------------------------

test("an <img> is never rendered before it has a source", () => {
  // `<img src={undefined}>` renders an `<img>` with no `src`, and a browser fires **`error`** for that.
  // The handler set `broken` on the very first frame, so the component showed its failure note and
  // never displayed the real image once the blob URL arrived — permanently, for every image, while the
  // orchestrator's bytes were perfectly good.
  //
  // Asserted on the render: with no URL there must be no `<img>` at all, not merely no `src` this test
  // can detect. jsdom cannot fire the real error, which is exactly why this shipped.
  // STATIC markup, because it is the closest thing to "the frame before any effect ran" — and it is
  // also what the first version of this test used, which is why it did NOT fail when the bug was put
  // back. `renderToStaticMarkup` omits a `src` attribute entirely rather than writing `src=""`, so a
  // regex looking for an empty src was satisfied by markup that a browser would have errored on.
  //
  // The assertion that actually bites is structural: the component must RETURN NOTHING without a URL.
  // Asserted on the source, because the behaviour is a guard clause rather than a rendered artefact.
  const staticHtml = renderToString(createElement(ImageViewer, {
    path: "img_5.png",
    type: "image/png",
    base64: PNG.toString("base64"),
    bytes: PNG.length,
  }));
  assert.equal(staticHtml, "", "nothing renders before the blob URL exists");

  const source = readFileSync(new URL("../src/components/ImageViewer.tsx", import.meta.url), "utf8");
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.match(
    stripped,
    /if \(url === undefined\) return null;/,
    "an <img> must never be rendered without a source: the browser fires `error` for one, which set `broken` on the first frame",
  );

  // And mounted, the real image must appear — which is the outcome the bug prevented.
  const { html, unmount } = mount(createElement(ImageViewer, {
    path: "img_5.png",
    type: "image/png",
    base64: PNG.toString("base64"),
    bytes: PNG.length,
  }));
  assert.match(html, /<img/, "once the URL exists, the image renders");
  assert.ok(!/Could not display/.test(html), "and it does not claim failure");
  unmount();
});

test("the failure message is grammatical and does not over-claim", () => {
  // The shipped text read "The bytes of img_5.png are a image/png header, but the browser could not
  // decode the image." Two faults: "a image/png", and an implication that the whole file was a valid
  // header. What is actually known is narrower — the leading bytes were recognised, the decode failed.
  const source = readFileSync(new URL("../src/components/ImageViewer.tsx", import.meta.url), "utf8");
  assert.ok(!/are a \{type\}/.test(source), "no 'are a image/png'");
  assert.match(source, /leading bytes are a valid \{type\} header/, "the accurate claim");
  assert.match(source, /truncated or corrupt/, "…and the likely cause, stated as likely");
});
