/**
 * The rail as a set of reader preferences (issue #275).
 *
 * ## What this file is for
 *
 * `rail-prefs.test.ts` holds the pure rules — the clamps, the parsing, `showsRowMetrics`. This file holds the claims
 * that only exist once the component renders: that a folded section still says what is inside it, that the sections
 * that must never fold have no control for it, that the bulk-selection heading survives being folded, and that CALM
 * drops the metrics line in the DOM rather than merely styling it faint.
 *
 * ## The falsification behind the fold
 *
 * Folding `Idle`/`Stopped` is the one change here that could trade away a settled decision: #68, *"i now see directly
 * when sth has finished without scrolling"*. The rule that pays for it is that a folded section OPENS ITSELF when a row
 * arrives in it — so a session finishing is still a thing the reader sees. That behaviour cannot be asserted in static
 * markup (it is an effect over two renders), so it is driven here through React's `act`, the pattern
 * `shortcuts-interactive.test.mjs` established.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

let React, ReactDOMClient, act, SessionRail, defaultRailPrefs, server;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ SessionRail } = await server.ssrLoadModule("/src/components/SessionRail.tsx"));
  ({ defaultRailPrefs } = await server.ssrLoadModule("/src/rail-prefs.ts"));
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  act = React.act;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
after(async () => {
  await server?.close();
});

function mount(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => root.render(element));
  return { container, unmount: () => act(() => root.unmount()) };
}

function session(over = {}) {
  return {
    id: "s1",
    name: "work",
    cwd: "/x/work",
    state: "idle",
    mode: "sandboxed",
    isolation: "",
    command: "",
    scratch: false,
    messageCount: 1,
    pending: 0,
    contextPercent: 12,
    tokensTotal: null,
    cost: null,
    dialogs: [],
    warnings: [],
    startedAt: 0,
    sessionFile: "/s/work.jsonl",
    ...over,
  };
}

/** A live row for a session. */
function rowsOf(sessions) {
  return sessions.map((s) => ({
    entry: { path: s.sessionFile, cwd: s.cwd, name: s.name },
    session: s,
  }));
}

/** A row with no process: the shape `rosterRows` produces for a session that is not running. */
function stoppedRow(name, path = `/s/${name}.jsonl`) {
  return { entry: { path, cwd: "/x", name }, session: undefined };
}

const base = {
  focusedId: undefined,
  onFocusRow() {},
  onForgetRow() {},
  onRetryRow() {},
  retryAvailable: true,
  onStartSession() {},
  onOpenDirectory() {},
  home: undefined,
  historyTotal: 0,
};

/** A rail with every section populated, and the fold capability offered. */
function rail({ prefs, onToggleFolded = () => {}, rows } = {}) {
  return React.createElement(SessionRail, {
    ...base,
    rows:
      rows ??
      rowsOf([
        session({ id: "s-needs", state: "awaiting-approval", name: "blocked", dialogs: [{ id: "d", method: "confirm", message: "Allow?", receivedAt: 0 }] }),
        session({ id: "s-failed", state: "failed", name: "broken" }),
        session({ id: "s-running", state: "streaming", name: "running" }),
        session({ id: "s-idle", state: "idle", name: "idler" }),
      ]).concat([stoppedRow("finished")]),
    prefs: prefs ?? defaultRailPrefs(),
    onToggleFolded,
  });
}

const headings = (container) => [...container.querySelectorAll(".group-header")].map((h) => h.textContent);

test("only Idle and Stopped get a fold control", () => {
  /*
   * The constraint, at the surface where it is visible. `Needs you`, `Failed` and `Running` must not be foldable at
   * all: a session blocked on a dialog cannot progress without the reader, and a session that is spending money must
   * stay on screen. Falsified by rendering `group-fold` for every group — the three assertions below then report a
   * control that can hide the wrong thing.
   *
   * The assertion reads `aria-label`, not text: the button carries only the disclosure MARK, because a button whose
   * word was "Stopped" would have collided with the bulk-selection control in the same heading (they are two different
   * actions on one noun).
   */
  const { container, unmount } = mount(rail());
  const folds = [...container.querySelectorAll(".group-fold")].map((b) => b.getAttribute("aria-label"));
  assert.equal(folds.length, 2, "two foldable sections");
  assert.match(folds[0], /idle session/, "Idle");
  assert.match(folds[1], /stopped session/, "Stopped");
  for (const forbidden of ["needs you", "failed", "running"]) {
    assert.ok(!folds.some((label) => label.includes(forbidden)), `${forbidden} must not be foldable`);
  }
  unmount();
});

test("a fold control states the ACTION and the count, not a status", () => {
  // A control named by its state ("Idle, collapsed") is read as status and pressed twice — the rule `PanelToggle`
  // records. `aria-expanded` carries the state for assistive tech; the name and tooltip say what pressing does.
  const { container, unmount } = mount(rail());
  const idle = container.querySelector(".group-fold");
  assert.equal(idle.getAttribute("aria-expanded"), "true", "expanded while the rows are rendered");
  assert.equal(idle.getAttribute("aria-label"), "Hide 1 idle session");
  assert.equal(idle.title, "Hide 1 idle session", "the same words where a hovering reader reads them");
  unmount();
});

test("folding a section removes its rows and says so in words", () => {
  /*
   * A folded heading with a count but no word could be read as "there are none". The pill is what distinguishes
   * "11 idle sessions" from "11 idle sessions, not shown" — and that distinction is the whole reason the fold does not
   * hide the fleet. Falsified by removing the `group-fold-note` element: the rows would still disappear and nothing
   * would say they exist.
   */
  const prefs = { ...defaultRailPrefs(), collapsed: { idle: true, stopped: false } };
  const { container, unmount } = mount(rail({ prefs }));
  assert.ok(!container.textContent.includes("idler"), "the idle row is not rendered");
  assert.ok(container.textContent.includes("finished"), "and the stopped row still is");
  const idleHeading = [...container.querySelectorAll(".group-header")].find((h) => h.textContent.includes("Idle"));
  assert.match(idleHeading.textContent, /folded/, "the heading says the section is folded");
  assert.equal(idleHeading.querySelector(".group-fold").getAttribute("aria-expanded"), "false");
  assert.equal(idleHeading.querySelector(".group-fold").getAttribute("aria-label"), "Show 1 idle session");
  unmount();
});

test("the bulk-selection heading survives being folded", () => {
  /*
   * The reader clearing finished work is looking at the HEADING, not at the rows — so a fold must not take the bulk
   * action with it. This is also the reason the fold and the selection are two sibling buttons rather than one nested
   * in the other: nesting is invalid HTML, and a reader who learned "click Stopped to select the finished ones" must
   * not find that control has silently changed job.
   *
   * Falsified by rendering `group-select` only inside the `!folded` branch.
   */
  const selected = [];
  const prefs = { ...defaultRailPrefs(), collapsed: { idle: false, stopped: true } };
  const { container, unmount } = mount(
    React.createElement(SessionRail, {
      ...base,
      rows: rowsOf([session({ id: "s-idle", state: "idle" })]).concat([stoppedRow("finished")]),
      prefs,
      onToggleFolded() {},
      onSelectGroup: (rows) => selected.push(...rows.map((r) => r.entry.path)),
    }),
  );
  const control = container.querySelector(".group-select");
  assert.ok(control, "the bulk control is reachable while the section is folded");
  assert.equal(control.textContent, "Stopped", "and it still names the group");
  act(() => control.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  assert.deepEqual(selected, ["/s/finished.jsonl"]);
  unmount();
});

test("a folded section OPENS ITSELF when a session arrives in it", () => {
  /*
   * The test that pays for #68. *"i now see directly when sth has finished without scrolling"* is a claim about being
   * TOLD, and a heading whose number quietly goes from 0 to 1 does not tell anyone. So the fold yields when a row
   * arrives — once, and only on an arrival.
   *
   * Two renders, because the effect needs a previous snapshot to compare against: the first render would otherwise
   * open every folded section on load, which is the wall the fold exists to remove.
   *
   * Falsified by dropping the `previous[section.group] === undefined` guard (the section opens on first render) or by
   * comparing counts instead of keys (an arrival that coincides with a departure is missed).
   */
  const toggled = [];
  const prefs = { ...defaultRailPrefs(), collapsed: { idle: true, stopped: true } };
  const idleOnly = rowsOf([session({ id: "s-idle", state: "idle", name: "idler" })]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => root.render(rail({ prefs, rows: idleOnly, onToggleFolded: (g) => toggled.push(g) })));
  assert.deepEqual(toggled, [], "the first render does not open anything");

  /*
   * A session arrives in Stopped — and the section did not exist before at all, because `groupRows` filters empty
   * groups out. That is the ORDINARY shape of the event #68 is about: a session finishes and a group appears where
   * there was none. The first implementation treated "absent before" as "no arrival" and so missed exactly the case
   * the fold must keep visible; this test is what caught it.
   */
  act(() =>
    root.render(
      rail({
        prefs,
        rows: idleOnly.concat([stoppedRow("finished one")]),
        onToggleFolded: (g) => toggled.push(g),
      }),
    ),
  );
  assert.deepEqual(toggled, ["stopped"], "the arrival opened the section it arrived in");
  act(() => root.unmount());
  container.remove();
});

test("CALM drops the metrics line where there is nothing to act on, in the DOM", () => {
  /*
   * The screenshot's cost: eleven rows each carrying a gauge and a percentage nobody could act on. Asserted on the
   * RENDERED element rather than on the class, because a row that carries `.is-calm` and still renders the numbers
   * would pass a class check and fail the actual complaint.
   *
   * Both directions: a 3% idle row has no `.r3`, and a nearly-full one does. Falsified by making the condition
   * constant in either direction.
   */
  const calm = { ...defaultRailPrefs(), density: "calm" };
  const quiet = mount(rail({ prefs: calm, rows: rowsOf([session({ state: "idle", contextPercent: 3 })]) }));
  assert.equal(quiet.container.querySelector(".rail-row .r3"), null, "no metrics line on a row with nothing to do");
  assert.match(quiet.container.textContent, /work/, "the row is still there, and still named");
  quiet.unmount();

  const busy = mount(rail({ prefs: calm, rows: rowsOf([session({ state: "streaming", contextPercent: 94 })]) }));
  assert.ok(busy.container.querySelector(".rail-row .r3"), "a nearly-full context keeps its line");
  assert.match(busy.container.textContent, /ctx/, "with the percentage that says how full");
  busy.unmount();
});

test("FULL density is the default, and renders the metrics line for the same row", () => {
  // The acceptance criterion for every preference in this app: a reader who never opens Settings sees no change.
  // Falsified by defaulting `density` to `calm`.
  const { container, unmount } = mount(rail({ rows: rowsOf([session({ state: "idle", contextPercent: 3 })]) }));
  assert.ok(container.querySelector(".rail-row .r3"), "the metrics line is rendered by default");
  unmount();
});

test("a shell that cannot remember a fold does not offer one", () => {
  /*
   * The rule every capability in this rail follows: a control that cannot act is worse than none. Without
   * `onToggleFolded` the headings are plain text, so a rail rendered outside the shell (or by a test) is a working
   * list rather than a set of dead buttons.
   *
   * Falsified by rendering the fold button unconditionally — `foldable` then reports a control whose click is a no-op.
   */
  const { container, unmount } = mount(
    React.createElement(SessionRail, { ...base, rows: rowsOf([session({ state: "idle" })]) }),
  );
  assert.equal(container.querySelector(".group-fold"), null, "no fold control without the capability");
  assert.match(container.textContent, /Idle/, "but the heading is still a heading");
  unmount();
});
