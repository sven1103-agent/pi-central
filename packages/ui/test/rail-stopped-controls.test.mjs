/**
 * A session's controls, in the companion panel beside the transcript.
 *
 * ## The report, and the two designs it killed
 *
 * *"noboday can hit the right controls in the stopped session card"* — Resume, Forget and Delete were three inline
 * buttons pinned to a row's corner in a 288px column; they overlapped the row's text, spilled past its edge and could
 * not be clicked.
 *
 * Then a `⋯` menu in the same corner: *"i dont like the approach, the menu is very tiny. Maybe we introduce these as
 * session control actions in the session companion next to the transcript?"*
 *
 * So the controls live in the panel — full-size buttons with labels, in the place that already held Rename and Stop.
 * The rail row carries none. This file pins the RULES, which are the part that can be got wrong:
 *
 *   - a running session offers Stop and nothing destructive;
 *   - a stopped one offers Resume plus the housekeeping;
 *   - a failed one offers Retry, and states why when it cannot;
 *   - the irreversible action is last and carries the danger colour.
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

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The rule whose SELECTOR IS EXACTLY `selector`, anchored at the start of a line.
 *
 * Anchored because a loose pattern matches a compound selector that ENDS in the same class — `.rail-row:hover
 * .context-bar { }` satisfied `/\.context-bar ?\{/` — so a question about a base rule answered itself with an override.
 * Found when an override was added; the selector is the subject, so it is matched as one.
 */
function ruleExact(selector) {
  const wanted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`^${wanted} ?\\{([^}]*)\\}`, "gm"))];
  return all.length > 0 ? all[all.length - 1][1] : undefined;
}

let server, sessionControlsFor, Inspector, SessionRail;
before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ sessionControlsFor, Inspector } = await server.ssrLoadModule("/src/components/Inspector.tsx"));
  ({ SessionRail } = await server.ssrLoadModule("/src/components/SessionRail.tsx"));
});
after(async () => {
  await server?.close();
});

const FILE = "/sessions/p/a.jsonl";

function session(over = {}) {
  return {
    id: "s3",
    name: "data manager work",
    cwd: "/Users/x/git/data-manager",
    state: "stopped",
    mode: "sandboxed",
    isolation: "",
    command: "",
    scratch: false,
    messageCount: 4,
    pending: 0,
    contextPercent: 40,
    tokensTotal: null,
    cost: null,
    dialogs: [],
    warnings: [],
    startedAt: 0,
    sessionFile: FILE,
    ...over,
  };
}

/** Every callback, so a test's assertion is about the RULE rather than about which hooks the caller passed. */
const allCaps = {
  onStop() {},
  onResume() {},
  onRetry() {},
  retryAvailable: true,
  onForget() {},
  onDelete() {},
};

const labels = (state, caps = allCaps) => sessionControlsFor(session({ state }), caps).map((c) => c.label);

test("a STOPPED session offers Resume, Forget and Delete", () => {
  // The reported dead end: after Stop there was no way to resume, forget or delete. Resume comes first because it is
  // the one that continues the work.
  assert.deepEqual(labels("stopped"), ["Resume session", "Forget", "Delete transcript"]);
});

test("a RUNNING session offers Stop, and nothing destructive", () => {
  // A process holds the transcript open: deleting it would leave a file being written to after it was unlinked.
  for (const state of ["idle", "streaming", "starting", "awaiting-approval"]) {
    assert.deepEqual(labels(state), ["Stop session"], `${state} offers only Stop`);
  }
});

test("a FAILED session offers Retry plus the housekeeping", () => {
  assert.deepEqual(labels("failed"), ["Retry", "Forget", "Delete transcript"]);
});

test("Retry is stated as unavailable, not offered, against an older orchestrator", () => {
  // A button that fails when pressed is worse than an explanation where the button would be.
  const controls = sessionControlsFor(session({ state: "failed" }), { ...allCaps, retryAvailable: false });
  const retry = controls.find((c) => c.key === "retry");
  assert.equal(retry, undefined, "no Retry control");
  const unavailable = controls.find((c) => c.key === "retry-unavailable");
  assert.ok(unavailable, "the absence is stated");
  assert.equal(unavailable.disabled, true);
  assert.match(unavailable.title, /restart the orchestrator/i);
});

test("the irreversible action is LAST and carries the danger colour", () => {
  // A destructive control should never be the first thing under the pointer.
  for (const state of ["stopped", "failed"]) {
    const controls = sessionControlsFor(session({ state }), allCaps);
    assert.equal(controls.at(-1).key, "delete", `${state}: Delete is last`);
    assert.equal(controls.at(-1).danger, true, `${state}: and only Delete is a danger action`);
    assert.ok(!controls.slice(0, -1).some((c) => c.danger === true), `${state}: nothing else is destructive`);
  }
});

test("Forget and Delete cannot be mistaken for each other", () => {
  const controls = sessionControlsFor(session({ state: "stopped" }), allCaps);
  assert.match(controls.find((c) => c.key === "forget").title, /not deleted/);
  assert.match(controls.find((c) => c.key === "delete").title, /cannot be undone/);
});

test("Resume says what it does NOT do, because it spends a spawn", () => {
  const resume = sessionControlsFor(session({ state: "stopped" }), allCaps).find((c) => c.key === "resume");
  assert.match(resume.title, /same directory/, "the directory is preserved");
  assert.match(resume.title, /transcript continues/, "and the conversation is continued");
});

test("a control is only offered when the shell can carry it out", () => {
  // The list is derived from what the caller passes, so an action the shell cannot perform never appears.
  assert.deepEqual(labels("stopped", { retryAvailable: true }), [], "no callbacks, no controls");
});

// --- Rendered: the panel and the rail -----------------------------------------------------------

test("the panel renders the controls as full-size buttons", () => {
  // The whole point of moving them: room for labels instead of a 22px glyph in a 288px column.
  const html = renderToString(
    createElement(Inspector, {
      session: session({ state: "stopped" }),
      home: "/Users/x",
      onStop() {},
      onRename() {},
      onResume() {},
      onForget() {},
      onDelete() {},
      retryAvailable: true,
    }),
  );
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const section = [...doc.querySelectorAll("section")].find((s) => /Actions/.test(s.textContent ?? ""));
  assert.ok(section, "there is an Actions section");
  const buttons = [...section.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
  for (const label of ["Resume session", "Forget", "Delete transcript"]) {
    assert.ok(buttons.includes(label), `${label} is a button, got ${JSON.stringify(buttons)}`);
  }
  // Delete is the only one in the danger style.
  const danger = [...section.querySelectorAll(".btn-danger")].map((b) => (b.textContent ?? "").trim());
  assert.deepEqual(danger, ["Delete transcript"]);
});

test("the RAIL ROW carries no actions at all", () => {
  // Two cramped attempts live in this file's header; the row is a view of the session, not a control surface.
  const html = renderToString(
    createElement(SessionRail, {
      rows: [{ entry: { path: FILE, cwd: "/Users/x/git/data-manager", name: "data manager work" }, session: session({ state: "stopped" }) }],
      focusedId: undefined,
      onFocusRow() {},
      onForgetRow() {},
      onRetryRow() {},
      retryAvailable: true,
      onStartSession() {},
      onOpenDirectory() {},
      home: "/Users/x",
      historyTotal: 0,
      openAsDrawer: false,
      onCloseDrawer() {},
    }),
  );
  for (const gone of ["rail-row-menu", "rail-row-forget", "rail-row-retry", "rail-row-stop", "rail-row-delete"]) {
    assert.ok(!html.includes(gone), `the row must not carry ${gone}`);
  }
});
