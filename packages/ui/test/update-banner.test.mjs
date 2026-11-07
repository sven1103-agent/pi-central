/**
 * The stale-page banner's recovery (issues #184, #213).
 *
 * ## Why this renders the component instead of asserting on `App.tsx`
 *
 * #184 shipped a banner with two faults that no automated check could see, and both were only found by
 * reading the screen:
 *
 *   - the Reload button and the advice beside it described the same action twice ("Reload now" next to
 *     "quit the app and reopen"), so the banner offered a button and then implied it would not work;
 *   - nothing rendered a banner at all in the one state that matters most — a page that came back into
 *     view after its orchestrator had been replaced — because the only trigger was a socket snapshot,
 *     and a hidden window receives none.
 *
 * Rendering the real component makes the first assertable. The second is a decision (`reloadOnReturn`)
 * and is asserted in `update-check.test.ts`; what is asserted here is that the banner cannot be built
 * in a state that offers a button the guard would refuse.
 *
 * `.mjs` for the reason `stopped-session.test.mjs` gives: components are loaded through Vite's SSR
 * transform, whose return type is `any`.
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

let server, UpdateBanner, BLOCKED_RELOAD_MESSAGE;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ UpdateBanner } = await server.ssrLoadModule("/src/components/UpdateBanner.tsx"));
  ({ BLOCKED_RELOAD_MESSAGE } = await server.ssrLoadModule("/src/update-check.ts"));
});

after(async () => {
  await server?.close();
});

/** Render with a spy `onReload`, so "the button is wired" is a fact rather than a markup coincidence. */
function render(props) {
  const calls = [];
  const html = renderToString(
    createElement(UpdateBanner, { onReload: () => calls.push("reload"), ...props }),
  );
  return { html, calls };
}

test("the banner offers a Reload control and says so in the markup", () => {
  const { html } = render({ message: "Pi Central was updated while this window was open." });
  assert.match(html, /role="alert"/);
  assert.match(html, /<button[^>]*type="button"[^>]*>Reload now<\/button>/);
  // The heading names the condition; the sentence comes from the verdict, not from this component.
  assert.match(html, /Update available/);
  assert.match(html, /was updated while this window was open/);
});

test("the Reload button actually calls the handler", () => {
  /*
   * Static markup cannot show a click handler — React renders none into HTML — so the wiring is read
   * off the element tree the component returns. That is the assertion this feature cannot skip: a
   * button that renders and is not wired is exactly the failure #184 shipped, because a standalone
   * window has no other way to reload.
   */
  const calls = [];
  const tree = UpdateBanner({ message: "stale", onReload: () => calls.push("reload") });
  const button = tree.props.children.find((child) => child?.type === "button");
  assert.ok(button, "the banner renders a button");
  button.props.onClick();
  assert.deepEqual(calls, ["reload"]);

  // And the blocked case renders no button at all, from the same props shape.
  const blocked = UpdateBanner({ message: "stale", blockedMessage: BLOCKED_RELOAD_MESSAGE, onReload: () => {} });
  assert.equal(blocked.props.children.find((child) => child?.type === "button"), undefined);
});

test("a blocked reload withholds the button instead of offering one that will be refused", () => {
  const { html } = render({ message: "stale", blockedMessage: BLOCKED_RELOAD_MESSAGE });
  // The guard's sentence replaces the verdict, because the verdict's advice ("press Reload") is
  // precisely what is being withheld.
  assert.match(html, /discard/);
  assert.doesNotMatch(html, /Reload now/);
  // Still announced: this is a condition the reader has to know about, not a silent deferral.
  assert.match(html, /role="alert"/);
});

test("the banner reports the window, not a session, so it carries no session affordance", () => {
  const { html } = render({ message: "stale" });
  // A dismiss control would let the reader clear the only evidence that their window is old, and the
  // next snapshot would put it straight back.
  assert.doesNotMatch(html, /Dismiss/);
  assert.doesNotMatch(html, /aria-label="Close/);
});
