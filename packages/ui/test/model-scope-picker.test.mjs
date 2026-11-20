/**
 * The picker offers the models a reader uses, and the catalogue stays one affordance away (issue #265).
 *
 * ## The falsifications, in the order the issue states them
 *
 *   1. With a list of two, exactly those two render, and the full catalogue is one labelled control away. Revert the
 *      scoping and the picker renders all of them — measured at 406 while this landed, so the failure is not subtle.
 *   2. A model outside the list can still be CHOSEN from the full list, and `set_model` receives it. Implement scoping
 *      as a filter in the orchestrator and this test fails on the callback rather than on the markup.
 *   3. A stored entry naming a model Pi no longer reports is KEPT and MARKED. Prune it on read and the row is gone.
 *   4. An unparseable stored value yields no list and the whole catalogue — not zero options.
 *   5. An empty list renders the SAME `<select>` as before the feature existed, so nobody's list changes underneath
 *      them. The two renders are compared rather than describing the expectation by hand.
 *   6. Two sessions on one machine see one list: both pickers change together, because the state is the shell's.
 *   7. An empty catalogue still says "no models available", scope or no scope — the two empty states do not merge.
 *
 * ## Why the click tests are here rather than in a browser
 *
 * Requirement 2 is about what a click SENDS, and no amount of rendered markup proves that. jsdom plus React's own
 * `act` is the pattern `shortcuts-interactive.test.mjs` established: mount, click, assert on the callback — a real
 * component driven by real events.
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

let React, ReactDOMClient, act, ModelPicker, ModelListDialog, emptyScope, loadModelScope, server;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx"));
  ({ ModelListDialog } = await server.ssrLoadModule("/src/components/ModelListDialog.tsx"));
  ({ emptyScope, loadModelScope } = await server.ssrLoadModule("/src/model-scope.ts"));
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  act = React.act;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

after(async () => {
  await server?.close();
});

/** A live session, as the picker receives one. The defaults are an idle sandboxed session. */
function session(over = {}) {
  return {
    id: "s7", name: "s7", cwd: "/Users/x/git/project", state: "idle", mode: "sandboxed",
    isolation: "Safehouse workdir=/Users/x/git/project", command: "safehouse -- pi --mode rpc",
    scratch: false, messageCount: 0, pending: 0, contextPercent: null, tokensTotal: null,
    cost: null, dialogs: [], warnings: [], startedAt: 0, model: "gpt-5", provider: "openai", ...over,
  };
}

/**
 * Three models across two providers, with the same id offered twice — the case that makes the scope a `provider/id`
 * PAIR rather than a name (`PROTOCOL.md:309-311`).
 */
const CATALOGUE = [
  { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true },
  { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
  { provider: "anthropic", id: "claude-x", name: "Claude X" },
  { provider: "proxy", id: "gpt-5", name: "GPT-5 via proxy" },
];

const scoped = (...refs) => ({ models: refs.map(([provider, id]) => ({ provider, id })) });

function mount(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/**
 * The `<button>` whose label a reader or a screen reader would find.
 *
 * `title` is included because a model row's visible text is its name AND its provider, so its heading is what gets
 * asserted; the accessible name of a star is its `aria-label`, and those two are the ways this dialog says what a
 * control does.
 */
function button(container, wanted) {
  return [...container.querySelectorAll("button")].find(
    (el) =>
      (el.getAttribute("aria-label") ?? "") === wanted ||
      (el.getAttribute("title") ?? "") === wanted ||
      el.textContent.trim() === wanted,
  );
}

function selectOptions(container, index = 0) {
  return [...container.querySelectorAll("select")[index].querySelectorAll("option")].map((option) => ({
    value: option.value,
    text: option.textContent,
    disabled: option.disabled,
    group: option.parentElement.tagName === "OPTGROUP" ? option.parentElement.label : undefined,
  }));
}

/** Decode the entities React's SSR encoder emits, so assertions can compare text rather than escapes. */
function text(html) {
  return html
    .replaceAll("<!-- -->", "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

const pickerHtml = (over = {}) =>
  renderToString(
    createElement(ModelPicker, {
      session: session(),
      models: CATALOGUE,
      error: undefined,
      onRequest() {},
      onSelect() {},
      ...over,
    }),
  );

// --- 1. The list, and the affordance that widens it -----------------------------------------------

test("a scope of two models renders exactly those two, and the catalogue is one labelled control away", () => {
  const html = pickerHtml({ scope: scoped(["openai", "gpt-5"], ["anthropic", "claude-x"]), onManageModels() {} });
  const options = [...html.matchAll(/<option[^>]*value="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(options, ["openai/gpt-5", "anthropic/claude-x"], `the list, not the catalogue: ${html}`);
  assert.ok(!html.includes("openai/gpt-5-mini"), "an unscoped model is not in the picker's own list");

  // One explicit, LABELLED affordance — the count is the live catalogue's, never a stored number.
  const label = text(html).includes("All 4 models");
  assert.ok(label, `the widened list is one labelled control away: ${html}`);
  assert.match(html, /aria-haspopup="dialog"/, "and it says it opens something");
});

test("a control with nothing to open is not rendered at all", () => {
  // A control that cannot act is worse than no control — the rule the Retry button's comment states. This is why
  // `onManageModels` is optional: a host without the editor gets the picker, not a dead button.
  const html = pickerHtml();
  assert.ok(!/Choose my models/.test(html), "no editor, no scope control");
});

test("the labelled control asks the host to open the list, rather than rendering it here", () => {
  // The dialog is the SHELL's: `.transcript-shell` is `container-type: inline-size`, which makes it the containing
  // block for a fixed descendant — a backdrop rendered inside the picker would cover the conversation and claim a
  // modality it does not have over the rail and the panel. So the picker only reports the intent.
  let opened = 0;
  const view = mount(
    createElement(ModelPicker, {
      session: session(),
      models: CATALOGUE,
      error: undefined,
      onRequest() {},
      onSelect() {},
      scope: scoped(["openai", "gpt-5"]),
      onManageModels: () => opened++,
    }),
  );
  act(() => button(view.container, "All 4 models").click());
  assert.equal(opened, 1);
  assert.equal(view.container.querySelector(".modal-backdrop"), null, "and nothing modal is rendered inside the picker");
  view.unmount();
});

// --- 2. Scoping never blocks a selection ----------------------------------------------------------

test("a model outside the list is chosen from the full catalogue, and set_model receives it", () => {
  // 2, and the far side of it: scoping must not become a filter that refuses valid models. The row is in the catalogue
  // section, the click reaches `onSelect`, and the list is not touched by choosing a model.
  const selected = [];
  const scopes = [];
  const view = mount(
    createElement(ModelListDialog, {
      catalogue: CATALOGUE,
      scope: scoped(["openai", "gpt-5"]),
      currentKey: "openai/gpt-5",
      canSelect: true,
      onScopeChange: (next) => scopes.push(next),
      onSelect: (provider, modelId) => selected.push(`${provider}/${modelId}`),
      onClose() {},
    }),
  );
  const row = button(view.container, "Use Claude X");
  assert.ok(row, "the out-of-scope model must be in the opened catalogue");
  act(() => row.click());

  assert.deepEqual(selected, ["anthropic/claude-x"], "choosing from the full list still reaches the session");
  assert.deepEqual(scopes, [], "and choosing a model is NOT the same act as scoping it");
  view.unmount();
});

test("the star scopes a model and never changes the session's model", () => {
  const selected = [];
  const scopes = [];
  const view = mount(
    createElement(ModelListDialog, {
      catalogue: CATALOGUE,
      scope: scoped(["openai", "gpt-5"]),
      currentKey: "openai/gpt-5",
      canSelect: true,
      onScopeChange: (next) => scopes.push(next),
      onSelect: (provider, modelId) => selected.push(`${provider}/${modelId}`),
      onClose() {},
    }),
  );
  // The catalogue's star, not the list's: this model is not in the reader's list yet.
  const star = button(view.container, "Add Claude X to your models");
  assert.ok(star, "every catalogue row can be added without switching to it");
  act(() => star.click());

  assert.deepEqual(selected, [], "adding a model to the list must not send set_model");
  assert.deepEqual(
    scopes.at(-1).models.map((ref) => `${ref.provider}/${ref.id}`),
    ["openai/gpt-5", "anthropic/claude-x"],
    "and it appends to the end of the list",
  );
  view.unmount();
});

// --- 3. A stale entry is kept and marked, in both surfaces ----------------------------------------

test("a stored entry naming a model Pi no longer offers is kept, marked, and still removable", () => {
  const scope = scoped(["openai", "gpt-5"], ["openai", "retired-4"]);
  const html = pickerHtml({ scope });

  // The picker: the entry is there, in its own group, disabled — kept rather than pruned.
  assert.match(html, /<optgroup label="not available from Pi">/);
  assert.match(html, /value="openai\/retired-4" disabled/);
  assert.match(text(html), /1 model in your list is not available from Pi\./);

  // The list dialog: the same entry, marked in words, WITH the star that can remove it. A stale entry that could
  // only be deleted by deleting the whole list would be a dead end.
  const dialog = renderToString(
    createElement(ModelListDialog, {
      catalogue: CATALOGUE,
      scope,
      currentKey: "openai/gpt-5",
      canSelect: true,
      onScopeChange() {},
      onSelect() {},
      onClose() {},
    }),
  );
  assert.match(text(dialog), /retired-4/);
  assert.match(text(dialog), /openai · not available from Pi/);
  assert.match(dialog, /aria-label="Remove retired-4 from your models"/);
  assert.ok(!/aria-label="Use retired-4"/.test(dialog), "Pi does not offer it, so there is nothing to choose");
});

// --- 4. A corrupt stored value is no list, not an empty one ---------------------------------------

test("an unparseable stored value yields no list AND the whole catalogue", () => {
  const broken = loadModelScope(() => '{"models":');
  assert.deepEqual(broken, emptyScope());
  const html = pickerHtml({ scope: broken });
  for (const id of ["openai/gpt-5", "openai/gpt-5-mini", "anthropic/claude-x"]) {
    assert.ok(html.includes(`value="${id}"`), `${id} must still be offered: ${html}`);
  }
  assert.ok(!/not available from Pi/.test(html), "and nothing is marked as missing");
});

// --- 5. An empty list changes nothing -------------------------------------------------------------

test("an empty list renders the SAME select as the picker did before the feature", () => {
  const before = pickerHtml();
  const after = pickerHtml({ scope: emptyScope(), onManageModels() {} });
  const selectOf = (html) => /<select[\s\S]*?<\/select>/.exec(html)[0];
  assert.equal(
    selectOf(after),
    selectOf(before),
    "the default path must be byte-identical: an empty list narrows nothing, hides nothing and reorders nothing",
  );
  // Opt-in, not always-on: the control only appears when there is a writer, and it explains itself in words.
  assert.match(text(after), /Choose my models/);
});

test("an empty catalogue says there are no models, exactly as before, scope or not", () => {
  // 7. "There are none" and "your list is empty" are different facts with different fixes. The catalogue's answer
  // wins, because it is the one that is actually about Pi.
  const html = pickerHtml({ models: [], scope: scoped(["openai", "gpt-5"]), onManageModels() {} });
  assert.match(html, /no models available/);
  assert.ok(!/not available from Pi/.test(html), "an empty catalogue is not a list of unavailable models");
  assert.ok(!/in your list/.test(html), "and it is not reported as a scope problem");
});

// --- 6. One machine, one list ---------------------------------------------------------------------

test("two sessions on one machine see one list, because the list is the shell's", () => {
  const { useState } = React;

  /*
   * A stand-in for the shell: ONE piece of state, TWO pickers — which is exactly how `App` holds it, and the reason
   * `ModelPicker` reads no storage of its own. Two readers would disagree the moment one of them wrote.
   */
  function TwoSessions() {
    const [scope, setScope] = useState(emptyScope());
    const [open, setOpen] = useState(false);
    const props = (id) => ({
      session: session({ id }),
      models: CATALOGUE,
      error: undefined,
      onRequest() {},
      onSelect() {},
      scope,
      onManageModels: () => setOpen(true),
    });
    return createElement(
      React.Fragment,
      null,
      createElement(ModelPicker, props("s1")),
      createElement(ModelPicker, props("s2")),
      open
        ? createElement(ModelListDialog, {
            catalogue: CATALOGUE,
            scope,
            currentKey: "openai/gpt-5",
            canSelect: true,
            onScopeChange: setScope,
            onSelect() {},
            onClose: () => setOpen(false),
          })
        : null,
    );
  }

  const view = mount(createElement(TwoSessions));
  const controls = [...view.container.querySelectorAll(".picker-scope")];
  assert.equal(controls.length, 2, "two pickers, one per session");

  act(() => controls[0].click());
  const star = button(view.container, "Add Claude X to your models");
  assert.ok(star, "the second session's picker must not be affected before the click");
  act(() => star.click());

  for (const [index, context] of [[0, "the session that made the change"], [1, "the other session"]]) {
    const options = selectOptions(view.container, index);
    assert.ok(
      options.some((option) => option.value === "anthropic/claude-x"),
      `${context} must show the shared list: ${JSON.stringify(options)}`,
    );
    assert.ok(
      !options.some((option) => option.value === "openai/gpt-5-mini"),
      `${context} must be narrowed to the shared list`,
    );
  }
  view.unmount();
});

test("the picker neither stores the list nor renders the dialog that edits it", () => {
  // 6, structurally: the preference is read and written in ONE place (the shell), and the picker only renders what it
  // is given. A `localStorage` call here would be a second reader that can disagree with the first.
  // Comments are stripped before matching: this file EXPLAINS that it does not touch storage, and a scan that read its
  // own documentation would pass after the code was deleted — the fifth time that lesson was worth applying here.
  const source = readFileSync(new URL("../src/components/ModelPicker.tsx", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  assert.ok(!/localStorage/.test(source), "the picker must not read or write storage directly");
  assert.ok(!/MODEL_SCOPE_KEY/.test(source), "and it must not know the key either");
  // And no modal: `.transcript-shell` is the containing block for a fixed descendant, so a backdrop here would cover
  // the conversation while claiming to be modal over the window. The shell renders the dialog (see `App`).
  assert.ok(!/modal-backdrop/.test(source), "the list dialog must not be rendered inside the picker");
});

// --- The list dialog's own behaviour ---------------------------------------------------------------

test("the filter narrows both sections, and 'everything is in your list' is not 'nothing matches'", () => {
  const all = renderToString(
    createElement(ModelListDialog, {
      catalogue: CATALOGUE,
      scope: scoped(["openai", "gpt-5"], ["openai", "gpt-5-mini"], ["anthropic", "claude-x"], ["proxy", "gpt-5"]),
      currentKey: "openai/gpt-5",
      canSelect: true,
      onScopeChange() {},
      onSelect() {},
      onClose() {},
    }),
  );
  assert.match(text(all), /Every model Pi reports is in your list\./, "a finished state says it is finished");

  const view = mount(
    createElement(ModelListDialog, {
      catalogue: CATALOGUE,
      scope: emptyScope(),
      currentKey: "openai/gpt-5",
      canSelect: true,
      onScopeChange() {},
      onSelect() {},
      onClose() {},
    }),
  );
  const search = view.container.querySelector('input[type="search"]');
  assert.ok(search, "406 rows need a filter, and this one is labelled");
  assert.equal(search.getAttribute("aria-label"), "Filter models");

  const type = (value) => {
    // React tracks the DOM value through its own setter, so the native one has to be used for the change to register.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    act(() => {
      setter.call(search, value);
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };

  type("claude");
  const rows = [...view.container.querySelectorAll(".model-row")];
  assert.equal(rows.length, 1, `one match narrows the list to one row: ${view.container.innerHTML}`);
  assert.match(rows[0].textContent, /Claude X/);

  type("no-such-model");
  assert.equal(view.container.querySelectorAll(".model-row").length, 0);
  assert.match(text(view.container.innerHTML), /No model matches/);
  view.unmount();
});

test("focus follows a star into the section the row moves to", () => {
  // Pressing a star REPARENTS the row: the sections are exclusive, so the old star is unmounted and a new one is
  // created. Without the restore, React drops focus to `<body>` and a keyboard reader must tab in from the top of the
  // page after every press — on a list whose whole job is marking several models in a row.
  const { useState } = React;

  function Editor() {
    const [scope, setScope] = useState(emptyScope());
    return createElement(ModelListDialog, {
      catalogue: CATALOGUE,
      scope,
      currentKey: "openai/gpt-5",
      canSelect: true,
      onScopeChange: setScope,
      onSelect() {},
      onClose() {},
    });
  }

  const view = mount(createElement(Editor));
  act(() => button(view.container, "Add Claude X to your models").click());

  const moved = button(view.container, "Remove Claude X from your models");
  assert.ok(moved, "the row moved into 'Your models'");
  // Compared as a boolean on purpose: `assert.equal` on two DOM nodes makes the failure path INSPECT a jsdom element,
  // whose object graph is large enough to run the test runner out of memory instead of printing the assertion.
  assert.ok(document.activeElement === moved, "focus went with it rather than falling back to <body>");

  // And back: removing it returns the row to the catalogue, and focus follows again.
  act(() => moved.click());
  const returned = button(view.container, "Add Claude X to your models");
  assert.ok(returned);
  assert.ok(document.activeElement === returned, "the same rule in the other direction");
  view.unmount();
});

test("the shell stands the keyboard down while the list editor is open", () => {
  // A chord that acted on the session behind the backdrop would be a keystroke aimed at a surface the reader is not
  // looking at — the rule the delete confirmation already follows. Both places that ask "is a modal in front?" have to
  // know about this one, or `⌘.` stops a run the reader never mentioned.
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(app, /modalOpen=\{[^}]*modelListOpen/, "the rail's own binding must stand down");
  assert.match(app, /modalOpen: pendingDelete !== undefined[^,]*modelListOpen/, "and so must the shortcut ladder");
});

test("Escape closes the list, so a surface opened from the keyboard is closable from it", () => {
  let closed = 0;
  const view = mount(
    createElement(ModelListDialog, {
      catalogue: CATALOGUE,
      scope: emptyScope(),
      currentKey: "openai/gpt-5",
      canSelect: false,
      onScopeChange() {},
      onSelect() {},
      onClose: () => closed++,
    }),
  );
  act(() => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  assert.equal(closed, 1);
  view.unmount();
});
