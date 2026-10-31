/**
 * Renaming in place (issues #78, #79).
 *
 * Reported: *"renaming a session is not easy"* — the only path was Inspector → Actions → expand `Rename…` → type
 * → `Save name`, with the detail panel visible and a disclosure opened first. `DESIGN.md` §12 had specified
 * "double-click the header name → inline rename" all along; it was never built.
 *
 * These tests drive the component with React's own test surface rather than rendering to a string, because the
 * whole behaviour is interactive: a static render only proves the name is displayed, which it already was.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

let React, ReactDOMClient, act, InlineRename, server, container, root;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ InlineRename } = await server.ssrLoadModule("/src/components/InlineRename.tsx"));
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  act = React.act;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

after(async () => {
  root?.unmount();
  await server?.close();
});

/** Mount the component fresh, with its own container, and return helpers. */
function mount(props) {
  container = document.createElement("div");
  document.body.append(container);
  root = ReactDOMClient.createRoot(container);
  act(() => root.render(React.createElement(InlineRename, props)));
  return {
    text: () => container.textContent,
    doubleClick: () => {
      const target = container.querySelector("span");
      assert.ok(target, "the name must render before it can be edited");
      act(() => {
        target.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
      });
    },
    input: () => container.querySelector("input"),
    type: (value) => {
      const input = container.querySelector("input");
      assert.ok(input, "no input is open");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
    key: (key) => {
      const input = container.querySelector("input");
      assert.ok(input, "no input is open");
      act(() => {
        input.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    },
    blur: () => {
      const input = container.querySelector("input");
      assert.ok(input, "no input is open");
      act(() => {
        // React delegates `onBlur` to `focusout` (which bubbles); a raw `blur` event never reaches the handler.
        // Dispatching the wrong one is how a working blur-commit looks broken in a test.
        input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
      });
    },
  };
}

test("the name is plain text until it is double-clicked", () => {
  // Discoverability without chrome: no pencil, no dropdown. The double-click is the documented gesture.
  const ui = mount({ value: "s1", label: "Session name", onCommit() {} });
  assert.equal(ui.text(), "s1");
  assert.equal(ui.input(), null, "no field is shown until asked for");
});

test("double-clicking opens a field PREFILLED with the current name", () => {
  // The common case is "adjust this name", not "type a new one from scratch" — and an empty field would make
  // the reader retype what is already on screen.
  const ui = mount({ value: "refactor auth", label: "Session name", onCommit() {} });
  ui.doubleClick();
  assert.ok(ui.input(), "the field opens");
  assert.equal(ui.input().value, "refactor auth", "prefilled, so the rename is an edit");
});

test("Enter commits the trimmed name, and closes the field", () => {
  const committed = [];
  const ui = mount({ value: "s1", label: "Session name", onCommit: (name) => committed.push(name) });
  ui.doubleClick();
  ui.type("  Increment 4  ");
  ui.key("Enter");
  assert.deepEqual(committed, ["Increment 4"], "trimmed, and sent once");
  assert.equal(ui.input(), null, "the field closes on commit");
});

test("Escape cancels and commits nothing", () => {
  const committed = [];
  const ui = mount({ value: "s1", label: "Session name", onCommit: (name) => committed.push(name) });
  ui.doubleClick();
  ui.type("a name I regret");
  ui.key("Escape");
  assert.deepEqual(committed, [], "nothing is sent");
  assert.equal(ui.input(), null, "the field closes");
  assert.equal(ui.text(), "s1", "and the original name is intact");
});

test("blur COMMITS — clicking away must not lose a typed name", () => {
  // The alternative (blur cancels) loses work, which is the failure this issue is about. Losing a name you just
  // typed is worse than an unintended rename you can immediately undo by renaming again.
  const committed = [];
  const ui = mount({ value: "s1", label: "Session name", onCommit: (name) => committed.push(name) });
  ui.doubleClick();
  ui.type("named it");
  ui.blur();
  assert.deepEqual(committed, ["named it"]);
});

test("an EMPTY or UNCHANGED name never reaches the orchestrator", () => {
  // A rename that sends "" would blank a name the reader can see, and one that sends the same value is a write
  // for nothing. Both are refusals at the component, not at the orchestrator.
  const committed = [];
  const ui = mount({ value: "s1", label: "Session name", onCommit: (name) => committed.push(name) });
  ui.doubleClick();
  ui.type("   ");
  ui.key("Enter");
  assert.deepEqual(committed, [], "whitespace is not a name");

  const second = mount({ value: "s1", label: "Session name", onCommit: (name) => committed.push(name) });
  second.doubleClick();
  second.type("s1");
  second.key("Enter");
  assert.deepEqual(committed, [], "an unchanged name is not a rename");
});
