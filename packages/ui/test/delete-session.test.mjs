/**
 * Deleting from the History tab and the rail (issue #150).
 *
 * ## What these guard
 *
 * This is the only irreversible action in the app, so the properties worth asserting are the ones that stop a mistake
 * rather than the ones that confirm a success:
 *
 *   - the confirmation NAMES the session and its directory, and says the file is removed — a dialog that says
 *     "Delete?" is a dialog the reader cannot check;
 *   - it is a DIALOG, not a toast with undo: the file is unlinked, so an undo would be a lie;
 *   - the confirming button is not the focused one, so a stray `Enter` cannot delete;
 *   - Forget and Delete are distinguishable, because one is reversible and one is not.
 */
import { test, before, after } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

let server, ConfirmDelete, HistoryView, SessionRail;
before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ ConfirmDelete } = await server.ssrLoadModule("/src/components/ConfirmDelete.tsx"));
  ({ HistoryView } = await server.ssrLoadModule("/src/components/History.tsx"));
  ({ SessionRail } = await server.ssrLoadModule("/src/components/SessionRail.tsx"));
});
after(async () => {
  await server?.close();
});

const text = (html) => new JSDOM(`<body>${html}</body>`).window.document.body.textContent ?? "";

const confirm = (over = {}) =>
  renderToString(
    createElement(ConfirmDelete, {
      label: "\u201cFix the login redirect\u201d",
      cwd: "/Users/x/git/project",
      onCancel() {},
      onConfirm() {},
      ...over,
    }),
  );

test("the confirmation names the session AND its directory", () => {
  // Two tasks in one project is the intended workflow (#149), so the label alone is genuinely ambiguous here.
  const html = confirm();
  assert.match(text(html), /Fix the login redirect/);
  assert.match(text(html), /\/Users\/x\/git\/project/, "the directory, because the label can repeat");
});

test("it says the FILE is removed, not that the row is hidden", () => {
  // "Delete" alone reads as "remove from the list", which is #87 and reversible. The distinction is the whole reason
  // this needs its own confirmation rather than reusing Forget.
  const html = text(confirm());
  assert.match(html, /removed from disk/);
  assert.match(html, /cannot be undone/);
});

test("it is a dialog, not a toast with undo", () => {
  // The file is unlinked; an undo button would be a lie about what happened.
  const html = confirm();
  assert.match(html, /role="alertdialog"/);
  // Matched on the CONTROL, not on the word: "cannot be undone" is the sentence that says there is no recovery, and
  // a bare `/undo/` test flagged it — the assertion was wrong, not the dialog.
  assert.ok(!/<button[^>]*>[^<]*undo/i.test(html), "no undo button is offered");
  assert.match(text(html), /cannot be undone/, "and the absence of recovery is stated instead");
});

test("CANCEL takes focus, so a stray Enter does not delete", () => {
  // The reader may have been typing in the composer a moment ago. Focusing the destructive button turns muscle memory
  // into an irreversible mistake.
  const doc = new JSDOM(`<body>${confirm()}</body>`).window.document;
  const buttons = [...doc.querySelectorAll("button")];
  const keep = buttons.find((b) => /Keep it/.test(b.textContent));
  assert.ok(keep, "there is a keep-it control");
  // The focused element is decided by an effect, which SSR does not run — so assert the ORDER instead: the danger
  // button comes first in the DOM and the cancel second, matching `ConfirmStop`'s pattern.
  assert.ok(/Delete transcript/.test(buttons[0].textContent), "the destructive action leads the dialog, visibly");
  assert.ok(/Keep it/.test(buttons[1].textContent), "and the safe one is beside it");
});

test("a sidecar is mentioned only when one will be removed", () => {
  assert.match(text(confirm({ hasSidecar: true })), /subagent records/);
  assert.ok(!/subagent records/.test(text(confirm())), "no claim about a sidecar that does not exist");
});

/** A history row, for the two surface tests. */
const historical = (over = {}) => ({
  path: "/sessions/p/a.jsonl",
  id: "a",
  cwd: "/Users/x/git/project",
  created: "",
  modifiedMs: 0,
  bytes: 10,
  messageCount: 2,
  firstMessage: "hello",
  cwdExists: true,
  scratch: false,
  ...over,
});

test("History offers Delete per row when the orchestrator understands it", () => {
  const html = renderToString(
    createElement(HistoryView, {
      history: [historical()],
      historyTotal: 1,
      home: "/Users/x",
      onResume() {},
      onDelete() {},
    }),
  );
  assert.match(html, /history-delete/, "the control is rendered");
  // Named for its session, so ten rows do not all announce "Delete".
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const button = doc.querySelector(".history-delete");
  assert.match(button.getAttribute("aria-label"), /Delete the session/);
});

test("History owns NO dialog of its own — the shell renders exactly one (issue #150)", () => {
  // Reported from use: *"in the deletion prompt dialog, i need to click and confirm delete twice, until it actually
  // gets deleted."* The cause was two dialogs: History opened its own, whose confirm only called back, and the shell
  // then opened a second. So the second click was the one that mattered, and the first looked like it had failed.
  //
  // A rendered-HTML test cannot see this — History's dialog only appeared on click. So the assertion is structural: the
  // component must not contain a confirmation at all, which is what makes a second dialog impossible to reintroduce.
  const source = readFileSync(new URL("../src/components/History.tsx", import.meta.url), "utf8");
  assert.ok(!/ConfirmDelete/.test(source), "History must not render its own delete confirmation");
  assert.ok(!/deleting/.test(source), "nor hold state for one");
  // And it must still hand the request upward, so the shell's dialog is reachable.
  assert.match(source, /onDelete\?\.|onDelete\(session\)|onDelete\(/, "the row still asks the shell to confirm");
});

test("the shell renders the ONE dialog", () => {
  // The counterpart: App owns it, so the two surfaces share wording, focus handling and the single request.
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /<ConfirmDelete/, "App renders the confirmation");
  assert.match(source, /kind: "deleteSession"/, "and the confirm is what sends the request");
});

test("History offers NO Delete when the orchestrator cannot delete", () => {
  // An unknown control on the one irreversible action would appear to work and do nothing.
  const html = renderToString(
    createElement(HistoryView, { history: [historical()], historyTotal: 1, home: "/Users/x", onResume() {} }),
  );
  assert.ok(!/history-delete/.test(html), "withheld rather than shown-and-broken");
});

/** The rail's props, for the stopped-row tests. */
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

test("a stopped rail row offers Forget AND Delete, and they are distinguishable", () => {
  const html = renderToString(
    createElement(SessionRail, {
      ...railProps,
      rows: [{ entry: { path: "/sessions/p/a.jsonl", name: "old task", cwd: "/Users/x/git/project" } }],
      onDeleteRow() {},
    }),
  );
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const forget = doc.querySelector(".rail-row-forget:not(.rail-row-delete)");
  const del = doc.querySelector(".rail-row-delete");
  assert.ok(forget, "Forget is present");
  assert.ok(del, "Delete is present beside it");
  // The irreversibility is stated on the control, because the two sit next to each other.
  assert.match(del.title, /cannot be undone/);
  assert.match(forget.title, /not deleted/, "and Forget says the opposite, so neither is mistaken for the other");
});

test("a LIVE rail row offers neither, because a running transcript cannot be deleted", () => {
  const live = {
    id: "s1", name: "running", cwd: "/Users/x/git/project", state: "streaming", mode: "sandboxed",
    isolation: "", command: "", scratch: false, messageCount: 1, pending: 0, contextPercent: null,
    tokensTotal: null, cost: null, dialogs: [], warnings: [], startedAt: 0,
  };
  const html = renderToString(
    createElement(SessionRail, {
      ...railProps,
      rows: [{ entry: { path: "/sessions/p/a.jsonl", cwd: live.cwd, name: live.name }, session: live }],
      onDeleteRow() {},
    }),
  );
  assert.ok(!/rail-row-delete/.test(html), `no delete on a live row: ${html}`);
});
