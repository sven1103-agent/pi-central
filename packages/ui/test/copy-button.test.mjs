/**
 * The copy button renders its label verbatim (issue #72).
 *
 * Reported as `Copy copy path changelog.md`, which is two faults in one line:
 *
 *   - the CALLER passed `Copy path ${path}` while the button prefixed its own `Copy`, so the word
 *     appeared twice;
 *   - the button lower-cased the label for display, so a **case-sensitive path** was shown as
 *     `changelog.md` while `CHANGELOG.md` was what actually got copied.
 *
 * The second is the one that matters: the visible text is what a reader checks against, and it was
 * misrepresenting the value.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

let server;
let CopyButton, FilePane;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ CopyButton } = await server.ssrLoadModule("/src/components/CopyButton.tsx"));
  ({ FilePane } = await server.ssrLoadModule("/src/components/FilePane.tsx"));
});

after(async () => {
  await server?.close();
});

test("the label is rendered verbatim, because a label may be a case-sensitive path", () => {
  const html = renderToString(createElement(CopyButton, { text: "CHANGELOG.md", label: "path CHANGELOG.md" }));
  assert.match(html, /Copy path CHANGELOG\.md/, "case preserved, and the prefix appears once");
  assert.ok(!/copy path changelog\.md/.test(html), "the label must not be lower-cased");
  // The title carries the same words, so hover and text agree.
  assert.match(html, /title="Copy path CHANGELOG\.md"/);
});

test("a plain noun label still reads as a sentence", () => {
  // The other callers pass a display-ready noun, so the visible text stays sentence case.
  const html = renderToString(createElement(CopyButton, { text: "/a/b", label: "path" }));
  assert.match(html, /Copy path</);
});

test("the file viewer names WHICH path, without saying Copy twice", () => {
  // The reported defect, end to end. The label has to name the path — a tree may hold several — and
  // the button supplies the verb, so the caller must not supply it too.
  const html = renderToString(createElement(FilePane, {
    path: "CHANGELOG.md",
    state: { status: "loaded", content: { kind: "text", text: "x\n" }, bytes: 2 },
    wrapped: true,
    onToggleWrap() {},
    onClose() {},
  }));
  const label = /class="copy"[^>]*>([^<]*)</.exec(html)?.[1];
  assert.equal(label, "Copy path CHANGELOG.md", `got ${JSON.stringify(label)}`);
  assert.ok(!/Copy copy/i.test(html), "the verb must appear once");
});
