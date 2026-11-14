import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

let React, ReactDOMClient, act, ShortcutSheet, server;
before(async () => {
  server = await createServer({ root: new URL("packages/ui", `file://${process.cwd()}/`).pathname, server: { middlewareMode: true }, appType: "custom", logLevel: "error", optimizeDeps: { noDiscovery: true, include: [] } });
  ({ ShortcutSheet } = await server.ssrLoadModule("/src/components/ShortcutSheet.tsx"));
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  act = React.act;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
after(async () => { await server?.close(); });

test("a re-render of the open sheet must not take focus again", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => root.render(React.createElement(ShortcutSheet, { onClose: () => {}, platform: "apple" })));
  assert.equal(document.activeElement?.textContent, "Close", "focus is inside on open");
  // The reader tabs/clicks elsewhere; the shell re-renders (a socket event), with a fresh inline onClose.
  act(() => document.body.focus());
  act(() => root.render(React.createElement(ShortcutSheet, { onClose: () => {}, platform: "apple" })));
  assert.notEqual(document.activeElement?.textContent, "Close", "focus was stolen back on a plain re-render");
  act(() => root.unmount());
});
