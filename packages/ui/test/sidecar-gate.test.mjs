/**
 * The browser gate: offered where it can work, absent where it cannot, off unless asked for.
 *
 * ADR-0015 §15. Three properties, and the third is the one a reader would notice:
 *
 *   1. With no browser configured, the toggle is NOT RENDERED. A switch that does nothing reads as a broken feature;
 *      an absent switch reads as an absent one, which is the truth.
 *   2. Where it is offered, it starts UNCHECKED. A browser is a process and a port per session, so it is asked for.
 *   3. The choice travels with the commit as an opt-IN, so a session started from a recent row carries the same
 *      answer as one started from the Open button.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

let server;
let OpenDirectorySheet, reduce, initialState;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ OpenDirectorySheet } = await server.ssrLoadModule("/src/components/OpenDirectorySheet.tsx"));
  ({ reduce, initialState } = await server.ssrLoadModule("/src/store.ts"));
});

after(async () => {
  await server?.close();
});

function render(props = {}) {
  return renderToString(
    createElement(OpenDirectorySheet, {
      installationRoot: "/somewhere/else",
      home: "/Users/x",
      onClose: () => {},
      onOpen: () => {},
      ...props,
    }),
  );
}

const TOGGLE = "Let it see my dev server";

test("with no browser configured, the toggle is not rendered at all", () => {
  // The failure this prevents is the specific one that reads worst: a control that is present and inert. A reader
  // who ticks it, opens a session and sees no browser concludes the feature is broken, not that the machine lacks
  // one -- and there is nothing on screen to correct them.
  for (const value of [undefined, false]) {
    assert.ok(!render({ sidecarOffered: value }).includes(TOGGLE), "the toggle must be absent when offering " + String(value));
  }
});

test("where it is offered, the toggle is present and unchecked", () => {
  const html = render({ sidecarOffered: true });
  assert.ok(html.includes(TOGGLE), "an offered browser must have a control");
  // `checked=""` is what a checked checkbox renders as. Asserting the absence of the attribute is asserting the
  // default, which is the property: the reader opts IN.
  assert.ok(!/type="checkbox"[^>]*checked/.test(html), "it must start unchecked");
});

test("the commit carries the answer, so Open and a recent row cannot disagree", () => {
  // Behavioural rather than visual: the sheet calls onOpen with the toggle value, and there is exactly ONE commit
  // path (the design decision the sheet documents). Rendering cannot show this, so it is asserted against the
  // source of the component -- the same approach the repo uses where a click needs a browser.
  const source = readComponent();
  assert.match(source, /onOpen\(effectivePath, sidecar\)/, "the Open button must pass the toggle");
  assert.match(source, /onChooseRecent=\{\(cwd\) => onOpen\(cwd, sidecar\)\}/, "a recent row must pass the toggle");
  // And it must never send the choice as a separate request.
  assert.ok(!/kind: "sidecar"/.test(source), "the choice belongs to the start request, not a control of its own");
});

function readComponent() {
  return readFileSync(new URL("../src/components/OpenDirectorySheet.tsx", import.meta.url), "utf8");
}

test("the store treats an orchestrator that does not report the capability as offering none", () => {
  // The absent case is a real state, not a gap: an orchestrator older than this field sends nothing, and a machine
  // with no browser sends nothing either. Both must read as "do not offer", because the alternative -- defaulting to
  // offering -- puts an inert control in front of a reader and blames the feature for the machine.
  const base = { live: [], history: [], historyTotal: 0, home: "/Users/x" };
  const absent = reduce(initialState(), { kind: "snapshot", ...base });
  assert.equal(absent.sidecarOffered, false, "an unreported capability must not be offered");
  const off = reduce(initialState(), { kind: "snapshot", ...base, sidecarOffered: false });
  assert.equal(off.sidecarOffered, false);
  const on = reduce(initialState(), { kind: "snapshot", ...base, sidecarOffered: true });
  assert.equal(on.sidecarOffered, true, "and a reported one must be");
});

test("the orchestrator reports the capability on the snapshot, so the UI has something to read", () => {
  // Source-level on purpose. The alternative is standing up a WebSocket server with a real Supervisor in a UI test,
  // which would test the transport rather than this fact. What must hold is that the snapshot CARRIES the field from
  // configuration: without it, a machine that offers a browser looks exactly like one that does not, and the toggle
  // never appears -- the failure mode is invisible rather than wrong.
  const source = readFileSync(new URL("../../orchestrator/src/transport.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /kind: "snapshot",[\s\S]{0,600}?sidecarOffered/,
    "the snapshot must carry sidecarOffered, from configuration",
  );
});
