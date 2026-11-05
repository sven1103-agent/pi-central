/**
 * Recovering a stopped session from the rail (prio A, reported from use).
 *
 * ## The report
 *
 * *"i could not recover a session, because i think the session roster is not loading properly from the history by
 * session-id, but by name. We have several sessions named data-manager, but they are distinct sessions. That leaves
 * user in a deadlock to select the right session."*
 *
 * Two defects, and both are asserted here:
 *
 *   1. **The dead end.** Clicking a stopped row set `focusedId` to a roster PATH, and `focusedSession` searched only
 *      `state.live` — so the main column fell through to "No session selected". `queuePrompt`/`pendingPrompt` existed
 *      in the store and were dispatched by nothing, so the "resume-on-send" #89 describes was never wired. There was
 *      no control anywhere that could start a stopped session again.
 *   2. **Indistinguishable rows.** `rosterEntryFor` persisted `entry.name`, and until #195 an unnamed project session
 *      was named after its DIRECTORY. So N distinct sessions rendered as N rows called `data-manager`, all with the
 *      same cwd line — no way to tell them apart even if clicking had worked.
 *
 * The identity model itself was never wrong: every join in the codebase is by path or uuid. What was wrong is that
 * the *label* came from a stale directory-derived name, and that the click resolved to nothing.
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

// `.mjs`, like every other test that renders components (`components.test.mjs`, `context-meter.test.mjs`): these drive
// the REAL components through Vite's SSR loader, whose return type is `any`, so a `.ts` version would need casts that
// assert nothing. The types that matter are enforced where the components are used, in `App.tsx`.
let server, store, roster, StoppedSession, SessionRail;
before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  store = await server.ssrLoadModule("/src/store.ts");
  roster = await server.ssrLoadModule("/src/roster.ts");
  ({ StoppedSession } = await server.ssrLoadModule("/src/components/StoppedSession.tsx"));
  ({ SessionRail } = await server.ssrLoadModule("/src/components/SessionRail.tsx"));
});
after(async () => {
  await server?.close();
});

/** Two entries that the old code made indistinguishable: same name, same directory, different files. */
const twinEntries = [
  {
    path: "/Users/x/.pi/agent/sessions/--Users-x-git-data-manager--/2026-06-29T11-55-55-038Z_019f133c-6d1e-736f-83e4-b63ddf8ba396.jsonl",
    name: "data-manager",
    cwd: "/Users/x/git/data-manager",
  },
  {
    path: "/Users/x/.pi/agent/sessions/--Users-x-git-data-manager--/2026-07-01T09-00-00-000Z_01a0c2b4-1835-7418-9186-dd1a7b1e16cc.jsonl",
    name: "data-manager",
    cwd: "/Users/x/git/data-manager",
  },
];

test("clicking a stopped row resolves to a row, not to nothing", () => {
  // The dead end, exactly: before `focusedStoppedRow` existed, this returned undefined and the column went blank.
  let state = store.initialState();
  state = store.reduce(state, { kind: "loadRoster", entries: twinEntries });
  state = store.reduce(state, { kind: "focusRow", key: twinEntries[0].path });

  assert.equal(store.focusedSession(state), undefined, "it is not live — that is the whole point");
  const row = store.focusedStoppedRow(state);
  assert.ok(row, "but it IS a focused row, and now something can be rendered for it");
  assert.equal(row.entry.path, twinEntries[0].path, "the one that was clicked, by PATH");
});

test("a live handle still wins, so one session never gets two views", () => {
  // Honest note: this passes with the guard removed, because a live handle (`s1`) can never equal a roster path (an
  // absolute `.jsonl` path). It is asserted as the CONTRACT — the two branches render different components, so only one
  // may claim a focus — not as evidence that the guard is load-bearing today.
  const live = {
    id: "s1", name: "x", cwd: "/p", state: "idle", mode: "sandboxed", isolation: "", command: "",
    scratch: false, messageCount: 0, pending: 0, contextPercent: null, tokensTotal: null, cost: null,
    dialogs: [], warnings: [], startedAt: 0, sessionFile: twinEntries[0].path,
  };
  let state = store.initialState();
  state = store.reduce(state, { kind: "loadRoster", entries: twinEntries });
  state = { ...state, live: [live] };
  state = store.reduce(state, { kind: "focusRow", key: "s1" });
  assert.ok(store.focusedSession(state), "resolved as live");
  assert.equal(store.focusedStoppedRow(state), undefined, "and NOT also as a stopped row");
});

test("a focus naming neither a live session nor a roster entry resolves to nothing", () => {
  let state = store.initialState();
  state = store.reduce(state, { kind: "loadRoster", entries: twinEntries });
  // `focusRow` refuses unknown keys, so this can only arrive from an error path — the guard is that it cannot
  // produce a view for a session nobody has.
  state = store.reduce(state, { kind: "focusRow", key: "/nope.jsonl" });
  assert.equal(store.focusedStoppedRow(state), undefined);
});

// --- The labels, which are the second half of the deadlock ---------------------------------------

test("a directory-derived name is NOT treated as a title", () => {
  // `data-manager` for a session working in `~/git/data-manager` is the directory naming itself. Showing it twice in
  // one list is what made two distinct sessions look like one.
  const label = roster.rosterLabel(twinEntries[0]);
  assert.notEqual(label, "data-manager", "the stale default is not shown as a name");
  // With no prompt loaded, the fallback is the session's own file: unique by construction.
  assert.match(label, /2026-06-29/, "the date is legible");
  assert.match(label, /019f133c/, "and the uuid segment distinguishes two sessions from the same day");
});

test("two twins get DIFFERENT labels, which is the whole complaint", () => {
  const a = roster.rosterLabel(twinEntries[0]);
  const b = roster.rosterLabel(twinEntries[1]);
  assert.notEqual(a, b, `the two must be tellable apart, got ${JSON.stringify([a, b])}`);
});

test("the first prompt wins over the filename, because it is what the reader recognises", () => {
  const label = roster.rosterLabel(twinEntries[0], "For the data manager app, we want to now tackle images");
  assert.match(label, /data manager app/);
});

test("a name the reader actually CHOSE is still shown", () => {
  const chosen = { ...twinEntries[0], name: "Heavy Lifting" };
  assert.equal(roster.rosterLabel(chosen), "Heavy Lifting");
});

test("a scratch session keeps its group label rather than borrowing a prompt", () => {
  const scratch = { ...twinEntries[0], name: "s7", scratch: true, cwd: "/x/workspaces/s7" };
  assert.equal(roster.rosterLabel(scratch, "do a thing"), "Scratch session");
});

test("the rail uses the same rule, so a stopped row is distinguishable there too", () => {
  const html = renderToString(
    createElement(SessionRail, {
      rows: twinEntries.map((entry) => ({ entry })),
      focusedId: undefined,
      onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true,
      onStartSession() {}, onOpenDirectory() {}, home: "/Users/x", historyTotal: 0,
      openAsDrawer: false, onCloseDrawer() {},
    }),
  );
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const names = [...doc.querySelectorAll(".rail-row .name")].map((n) => n.textContent ?? "");
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1], `two distinct sessions must have distinct labels, got ${JSON.stringify(names)}`);
  assert.ok(!names.includes("data-manager"), "and neither shows the stale directory name as if it were a title");
});

// --- The view that closes the deadlock ------------------------------------------------------------

const stoppedView = (over = {}) =>
  renderToString(
    createElement(StoppedSession, {
      row: { entry: twinEntries[0] },
      history: undefined,
      home: "/Users/x",
      onResume() {},
      onForget() {},
      ...over,
    }),
  );

test("the stopped-session view offers Resume — the control that did not exist", () => {
  const doc = new JSDOM(`<body>${stoppedView()}</body>`).window.document;
  const resume = [...doc.querySelectorAll("button")].find((b) => /Resume session/.test(b.textContent));
  assert.ok(resume, "there is a way to start it again");
  assert.equal(resume.disabled, false, "enabled when the directory is usable");
});

test("the view shows the full PATH, because the label can legitimately repeat", () => {
  // ADR-0004: the path is the identity. A reader confirming "this is the one I meant" needs it.
  assert.match(stoppedView(), new RegExp(twinEntries[0].path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Resume is disabled, with the reason, when the directory is gone", () => {
  // RPC-mode Pi exits 1 on a missing directory rather than prompting (C2), so the button must not pretend.
  const html = stoppedView({
    history: { path: twinEntries[0].path, id: "a", cwd: "/mnt/gone", created: "", modifiedMs: 0, bytes: 1,
      messageCount: 1, firstMessage: "x", cwdExists: false, scratch: false },
  });
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const resume = [...doc.querySelectorAll("button")].find((b) => /Resume session/.test(b.textContent));
  assert.equal(resume.disabled, true, "cannot resume a session whose directory is gone");
  assert.match(doc.body.textContent ?? "", /directory is gone/, "and it says why");
});

test("Delete is offered only when the orchestrator can delete", () => {
  assert.ok(!/Delete transcript/.test(stoppedView()), "no delete control without the capability");
  assert.match(stoppedView({ onDelete() {} }), /Delete transcript/, "and one with it");
});

// --- The view must be STYLED (from a screenshot: "now the old stoped sessions look weird") --------------

test("every class this view renders has a rule in the stylesheet", () => {
  // The component was written as `<div className="empty stopped-session">` and never looked at. `.empty` is the CENTRING
  // placeholder for "nothing is selected", so a stopped session rendered as centred prose with an unstyled <dl> and
  // three loose buttons — the recovery view looked less finished than the screen it replaced.
  //
  // This is a guard against the whole class of defect, not just this instance: a component that names a class nobody
  // styles renders as unstyled markup, and nothing else in the suite notices.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const html = renderToString(
    createElement(StoppedSession, {
      row: { entry: twinEntries[0] },
      history: { path: twinEntries[0].path, id: "a", cwd: "/x/git/p", created: "", modifiedMs: 1_700_000_000_000,
        bytes: 9800, messageCount: 26, firstMessage: "a question", cwdExists: true, scratch: false },
      home: "/x",
      onResume() {},
      onForget() {},
      onDelete() {},
    }),
  );
  const classes = new Set(
    [...new JSDOM(`<body>${html}</body>`).window.document.querySelectorAll("[class]")].flatMap((el) =>
      el.className.split(" ").filter((c) => c.length > 0),
    ),
  );
  const styled = Object.fromEntries(
    [...classes].map((cls) => [cls, new RegExp(`\\.${cls}(?![\\w-])`).test(css)]),
  );
  assert.deepEqual(
    Object.entries(styled).filter(([, ok]) => !ok).map(([cls]) => cls),
    [],
    "a class with no rule renders as unstyled markup",
  );
  // And specifically NOT the centring placeholder: this is a record with actions, not a welcome screen.
  assert.ok(!classes.has("empty"), "must not borrow the empty-state layout");
});

test("the transcript path is one ellipsised line, not four wrapped ones", () => {
  // It was four lines of mono above everything else, pushing the actions below the fold for no benefit.
  const rule = /\.stopped-path\s*\{([^}]*)\}/.exec(
    readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
  )?.[1];
  assert.ok(rule, ".stopped-path has a rule");
  assert.match(rule, /text-overflow:\s*ellipsis/);
  assert.match(rule, /white-space:\s*nowrap/);
});
