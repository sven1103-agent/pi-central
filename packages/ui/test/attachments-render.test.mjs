/**
 * The attachment rail, rendered.
 *
 * The rules live in `attachments.ts` and are asserted there; this checks what a reader actually gets, because a correct
 * rule that never reaches the DOM is the failure mode these tests exist to catch.
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

let server, AttachmentRail;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ AttachmentRail } = await server.ssrLoadModule("/src/components/AttachmentRail.tsx"));
});

after(async () => {
  await server?.close();
});

/** A 1x1 PNG, real bytes so `atob` gets something valid. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhQGAWjR9awAAAABJRU5ErkJggg==";

const attachment = (overrides = {}) => ({
  id: "a1",
  mediaType: "image/png",
  data: PIXEL,
  bytes: 70,
  label: "pasted image",
  ...overrides,
});

function render(attachments) {
  return renderToString(createElement(AttachmentRail, { attachments, onRemove: () => {} }));
}

test("nothing renders when nothing is attached", () => {
  // An empty rail is a permanent empty row above the field. Absent is the honest rendering.
  assert.equal(render([]), "");
});

test("a chip shows the image, its label, and its DECODED size", () => {
  const created = [];
  const original = URL.createObjectURL;
  URL.createObjectURL = () => {
    created.push(true);
    return "blob:test/thumb";
  };
  try {
    const html = render([attachment()]);
    assert.match(html, /attach-thumb/, "a thumbnail");
    assert.match(html, /src="blob:test\/thumb"/, "from a blob URL");
    assert.match(html, /pasted image/, "the label, which is the only handle on what was attached");
    assert.match(html, /PNG/, "the format");
    assert.match(html, /70 B/, "and the decoded size, so a near-limit image is visibly near the limit");
    assert.equal(created.length, 1);
  } finally {
    URL.createObjectURL = original;
  }
});

test("each chip's remove control is named for WHAT it removes", () => {
  /*
   * Four buttons all labelled "Remove" tell a screen reader nothing about which image goes. This is the same
   * accessibility rule the codebase applies elsewhere: a control's label describes its target, not its verb.
   */
  const original = URL.createObjectURL;
  URL.createObjectURL = () => "blob:test/thumb";
  try {
    const html = render([
      attachment({ id: "a1", label: "shot-one.png" }),
      attachment({ id: "a2", label: "shot-two.png" }),
    ]);
    assert.match(html, /aria-label="Remove shot-one\.png"/);
    assert.match(html, /aria-label="Remove shot-two\.png"/);
    assert.equal([...html.matchAll(/class="attach-remove"/g)].length, 2, "one control per chip");
  } finally {
    URL.createObjectURL = original;
  }
});

test("the cap is stated where it is reached, as words rather than a disabled button", () => {
  const original = URL.createObjectURL;
  URL.createObjectURL = () => "blob:test/thumb";
  try {
    const four = Array.from({ length: 4 }, (_, index) => attachment({ id: `a${index}`, label: `s${index}.png` }));
    const atCap = render(four);
    assert.match(atCap, /attach-limit/, "the limit is announced");
    assert.match(atCap, /remove one to add another/, "with the action that is available");

    const underCap = render(four.slice(0, 3));
    assert.ok(!/attach-limit/.test(underCap), "and only when the cap is actually reached");
  } finally {
    URL.createObjectURL = original;
  }
});
