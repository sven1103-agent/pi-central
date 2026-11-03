/**
 * A stopped session's row must stay usable (reported from use).
 *
 * ## The report
 *
 * *"the session roster can stop sessions, but then you cant resume them or remove them from the roster. Also the
 * highlighting of session elements in the roster is weird: in idle, they all show a gray bar on the left and on hover
 * they dont do anything noticeable."*
 *
 * ## Why stopping was a one-way door
 *
 * The controls were gated on `session === undefined` — "this row has no live session object". But `stopped` is a
 * STATE, not an absence (C3): the supervisor keeps the session, so after Stop the row still had a session, the
 * not-running block never rendered, and the Stop control itself no longer applied either (`stopped` is not stoppable).
 * The row ended up with no controls at all.
 *
 * ## The visual half
 *
 * `idle` painted `--dim` — an AA-bright text grey — as the state stripe, so five idle rows showed five loud grey bars
 * that read as "disabled" rather than "quiet". And hover stepped `--panel` → `--panel-3`, six units on a dark screen:
 * present in the CSS, invisible to a reader moving a pointer down a list.
 *
 * Both are asserted against the STYLESHEET, because they are pure style outcomes — the markup was right in both cases.
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

/** The LAST rule for a selector: source order decides equal specificity, so the first match can be stale. */
function rule(selector) {
  const normalised = css.replace(/\s+/g, " ");
  const wanted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...normalised.matchAll(new RegExp(`(?<![\\w-])${wanted} ?\\{([^}]*)\\}`, "g"))];
  return all.length > 0 ? all[all.length - 1][1] : undefined;
}

/** A custom property's value, so a test can compare tokens rather than literals. */
function token(name) {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
}

let server, SessionRail;
before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ SessionRail } = await server.ssrLoadModule("/src/components/SessionRail.tsx"));
});
after(async () => {
  await server?.close();
});

const FILE = "/sessions/p/a.jsonl";

function session(state) {
  return {
    id: "s3",
    name: "data manager work",
    cwd: "/Users/x/git/data-manager",
    state,
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
  };
}

const railProps = {
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
};

/** The rail with ONE row in the given state. */
const railWith = (state, handlers = {}) =>
  renderToString(
    createElement(SessionRail, {
      ...railProps,
      ...handlers,
      rows: [{ entry: { path: FILE, cwd: "/Users/x/git/data-manager", name: "data manager work" }, session: session(state) }],
    }),
  );

/** The control labels rendered in the row's action strip. */
function controls(html) {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  // `.rail-row-actions` covers every action strip: the failed row's Retry, the running row's Stop (which also carries
  // `rail-row-stop`), and the not-running row's Resume/Forget/Delete (which also carries `rail-row-stopped-actions`).
  return [...doc.querySelectorAll(".rail-row-actions button")].map((b) => (b.textContent ?? "").trim());
}

test("a STOPPED session offers Resume, Forget and Delete — not an empty row", () => {
  // The reported bug: after Stop the row had a session object, so `session === undefined` was false and this whole
  // block disappeared. The session could be stopped and then never restarted or removed.
  const html = railWith("stopped", { onResumeRow() {}, onDeleteRow() {}, onStopRow() {} });
  const labels = controls(html);
  assert.ok(labels.includes("Resume"), `Resume must be offered, got ${JSON.stringify(labels)}`);
  assert.ok(labels.includes("Forget"), "and Forget");
  assert.ok(labels.includes("Delete"), "and Delete");
  assert.ok(!labels.includes("Stop"), "Stop is not offered for something already stopped");
});

test("a RUNNING session offers Stop, and no Resume — it is already going", () => {
  const labels = controls(railWith("streaming", { onResumeRow() {}, onDeleteRow() {}, onStopRow() {} }));
  assert.ok(labels.includes("Stop"), `Stop must be offered, got ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes("Resume"), "resuming a running session is not a thing");
  assert.ok(!labels.includes("Delete"), "and its transcript is open, so it cannot be deleted");
});

test("an IDLE session is running: Stop, not Resume", () => {
  // `idle` means idle-and-alive. Treating it as "not running" would offer Resume beside a live process.
  const labels = controls(railWith("idle", { onResumeRow() {}, onDeleteRow() {}, onStopRow() {} }));
  assert.ok(labels.includes("Stop"), `got ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes("Resume"), "a live idle session is not resumed, it is prompted");
});

test("a failed session keeps Retry rather than gaining Resume", () => {
  // `failed` is deliberately not "not running": it has its own control, and folding it in would lose that.
  const labels = controls(railWith("failed", { onResumeRow() {}, onDeleteRow() {}, onStopRow() {} }));
  assert.ok(labels.includes("Retry"), `got ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes("Resume"), "Retry is the right control for a failure");
});

test("Resume says what it does NOT do, since it spends a spawn", () => {
  const html = railWith("stopped", { onResumeRow() {} });
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const resume = [...doc.querySelectorAll(".rail-row-stopped-actions button")].find((b) => /Resume/.test(b.textContent));
  assert.match(resume.title, /same directory/, "the directory is preserved");
  assert.match(resume.title, /transcript continues/, "and the conversation is continued, not restarted");
});

// --- The highlighting ---------------------------------------------------------------------------

test("an idle row's stripe is the quiet line colour, not a bright text grey", () => {
  // Five idle rows each showed a `--dim` bar — an AA-bright grey that reads as "disabled".
  const idle = rule(".state-idle");
  assert.ok(idle, ".state-idle must have a rule");
  assert.match(idle, /border-left-color:\s*var\(--line\)/, `got ${JSON.stringify(idle)}`);
  assert.doesNotMatch(idle, /var\(--dim\)/, "a text colour is not a quiet stripe");
});

test("attention states keep their HUE, so the stripe still means something", () => {
  // Stepping the quiet ones back must not flatten the loud ones — that is the stripe's whole job.
  for (const [selector, expected] of [
    [".state-streaming", "--ok"],
    [".state-awaiting-approval", "--warn"],
    [".state-failed", "--danger"],
  ]) {
    assert.match(rule(selector) ?? "", new RegExp(`border-left-color:\\s*var\\(${expected}\\)`), selector);
  }
});

test("hover is a visible step, not six units of near-black", () => {
  // `--panel` → `--panel-3` was present in the CSS and invisible in practice.
  const hover = rule(".rail-row:hover");
  assert.ok(hover, "the hover rule exists");
  const background = /background:\s*var\((--[\w-]+)\)/.exec(hover)?.[1];
  assert.equal(background, "--panel-2", `hover should be the lighter surface, got ${background}`);
  assert.notEqual(background, "--panel-3", "the old, too-subtle step");
  // And a second channel, so the row answers the pointer where the fill is hard to see.
  assert.match(hover, /box-shadow/, "hover also changes the edge");
});

test("hover and SELECTION stay visually distinct", () => {
  // They were once the same fill, which made the focused session indistinguishable from whatever the mouse was over.
  const hover = /background:\s*var\((--[\w-]+)\)/.exec(rule(".rail-row:hover"))?.[1];
  const focused = /background:\s*var\((--[\w-]+)\)/.exec(rule('.rail-row[aria-current="true"]'))?.[1];
  assert.notEqual(hover, focused, `hover and selection must not share a fill, got ${hover} for both`);
  assert.match(focused, /--accent-tint/, "selection is the accent wash");
});
