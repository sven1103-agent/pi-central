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

/**
 * The rule whose SELECTOR IS EXACTLY `selector`, anchored at the start of a line.
 *
 * `rule()` above matches anywhere, which is wrong when a compound selector *ends* in the one being looked for:
 * `.rail-row:hover .context-bar { ... }` also matches `/\.context-bar ?\{/`, so a "what is the base track colour"
 * question answered itself with the override. Found by this test failing for that reason.
 */
function ruleExact(selector) {
  const wanted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`^${wanted} ?\\{([^}]*)\\}`, "gm"))];
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

test("each state keeps its own stripe colour, so the left edge means something", () => {
  // The stripe is the row's state channel. `idle` is `--dim` — which was briefly changed to a neutral grey and then
  // changed back, because the rail's appearance as a whole was preferred: "i liked the old design better".
  const expected = {
    ".state-idle": "--dim",
    ".state-stopped": "--line-strong",
    ".state-streaming": "--ok",
    ".state-awaiting-approval": "--warn",
    ".state-failed": "--danger",
  };
  for (const [selector, token] of Object.entries(expected)) {
    assert.match(
      rule(selector) ?? "",
      new RegExp(`border-left-color:\\s*var\\(${token}\\)`),
      `${selector} should be ${token}`,
    );
  }
});

test("rows are flush, and SELECTION is the accent tint", () => {
  // The rail's appearance is the original one: no gap, no hairline separator, hover is `--panel-3`, and the idle stripe
  // is `--dim`. Three rounds of trying to separate rows another way (8px gap, 1px hairline, a quietened stripe) were
  // all rejected from looking at them: "i liked the old design better".
  //
  // Exactly one thing survives from that round — SELECTION. It used to share `--panel-2` with hover, which is one step
  // from the `--panel-3` wash, so a selected row and a hovered row looked nearly the same. The accent tint cannot be
  // confused with either.
  assert.equal(rule(".rail-row + .rail-row"), undefined, "no gap and no separator between rows");
  assert.match(rule(".rail-row:hover") ?? "", /background:\s*var\(--panel-3\)/, "hover is the original light wash");
});

test("selection is a RIGHT-edge bar, not a wash, so the row's contents keep their contrast", () => {
  // The tint was applied to the whole row, including the context gauge — which then sat on a blue-grey that its own
  // fill could barely differ from. Reported as: "you cant see the progress bar anymore."
  //
  // The rail uses two channels by convention, and this finishes it: the LEFT edge is STATE, the RIGHT edge is SELECTION.
  const selected = rule('.rail-row[aria-current="true"]') ?? "";
  assert.match(selected, /box-shadow:\s*inset -3px 0 0 var\(--accent\)/, "a bar on the right, in the accent");
  // And the surface is a plain panel colour, not a tint — a tint is what washed the contents out.
  assert.match(selected, /background:\s*var\(--panel-2\)/, `a solid surface, got ${JSON.stringify(selected)}`);
  assert.doesNotMatch(selected, /var\(--accent-tint\)/, "no wash");
});

test("the gauge renders as it always has: one track colour, no per-state override", () => {
  // Two attempts to keep the gauge visible on a filled row were rejected, because both changed the rendering instead of
  // the row: a global `--bg` track ("the rail for the progress bar looked better before"), then a per-state override
  // ("now you are doing the bar rendering that i did not want in the selected session").
  //
  // It holds up without either: selection is `--panel-2`, DARKER than the `--panel-3` track, so the track reads
  // against it. The only surface the track matches is the `--panel-3` hover wash — transient, and not worth
  // compromising every row for.
  const track = ruleExact(".context-bar") ?? "";
  assert.match(track, /background:\s*var\(--panel-3\)/, `the original track, got ${JSON.stringify(track)}`);
  assert.match(track, /box-shadow:\s*inset 0 0 0 1px var\(--line\)/, "and the original hairline");

  // No override may reintroduce a different track on ANY row state.
  //
  // Scanned across every rule rather than by one known selector: the first version asserted a single combined selector
  // string, so adding `.rail-row[aria-current="true"] .context-bar { background: ... }` — exactly the thing this
  // guards — left it green. Found by falsifying it.
  const overrides = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selector]) => selector.includes(".rail-row") && selector.includes(".context-bar"))
    .filter(([, , body]) => /background\s*:/.test(body));
  assert.deepEqual(
    overrides.map(([, selector]) => selector.trim().slice(0, 60)),
    [],
    "the gauge must not be restyled per row state",
  );

  // Selection stays: a plain surface plus the bar on the right edge.
  const selected = rule('.rail-row[aria-current="true"]') ?? "";
  assert.match(selected, /background:\s*var\(--panel-2\)/, "the original background change is kept");
  assert.match(selected, /box-shadow:\s*inset -3px 0 0 var\(--accent\)/, "and the selection bar on the right");
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

test("hover and SELECTION are distinguishable, which is the point of the tint", () => {
  // They were once the same fill, so the focused session could not be told from whatever the mouse was over. Hover is
  // the original light wash; selection is the accent tint. Asserted as a DIFFERENCE, so the specific tokens can change
  // without the invariant silently disappearing.
  const hover = /background:\s*var\((--[\w-]+)\)/.exec(rule(".rail-row:hover") ?? "")?.[1];
  const selected = /background:\s*var\((--[\w-]+)\)/.exec(rule('.rail-row[aria-current="true"]') ?? "")?.[1];
  assert.ok(hover && selected, `both fills must exist, got ${hover} / ${selected}`);
  assert.notEqual(hover, selected, "hover and selection must not share a fill");
});
