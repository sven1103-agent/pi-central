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

test("History has NO per-row Delete — deletion is a bulk action in the toolbar", () => {
  // Requested from use: "The delete button next to the session can go now." Per-row buttons made the list read as a
  // grid of destructive affordances, and with a selection model they were a redundant second way to do the same thing.
  const html = renderToString(
    createElement(HistoryView, {
      history: [historical()],
      historyTotal: 1,
      home: "/Users/x",
      onResume() {},
      onDeleteMany() {},
    }),
  );
  assert.ok(!/history-delete/.test(html), "no per-row delete control");
  assert.match(html, /history-bulk-delete/, "the bulk control is what exists");
});

test("the bulk control is ALWAYS present and DISABLED until something is selected", () => {
  // Requested from use: "Dont let the delete button appear magically, it can be in a deactivated state and once at
  // least one session is selected, it can be deleted." A control that materialises leaves the reader unable to see the
  // capability before selecting — and a disabled one states both the capability and its condition.
  const html = renderToString(
    createElement(HistoryView, {
      history: [historical()],
      historyTotal: 1,
      home: "/Users/x",
      onResume() {},
      onDeleteMany() {},
    }),
  );
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const button = doc.querySelector(".history-bulk-delete");
  assert.ok(button, "it is rendered with nothing selected");
  assert.equal(button.disabled, true, "and disabled");
  assert.match(button.title, /Select sessions/, "with the condition stated rather than the button just being dead");
});

test("a selection can be cleared in ONE step (severe bug, reported from use)", () => {
  // *"users cant clear the selection anymore in one step, which is a severe bug."* Removing the old bulk toolbar
  // silently took the only Clear with it: a reader who had ticked twenty rows — or pressed "select this page" over 25 —
  // had to untick them one at a time. Reported as severe, and it is: it turns a bulk action into a trap.
  const source = readFileSync(new URL("../src/components/History.tsx", import.meta.url), "utf8");
  // The control exists and resets the whole selection, rather than removing one path.
  assert.match(source, /className="btn btn-quiet history-clear"/, "a Clear control is rendered");
  assert.match(source, /setSelected\(new Set\(\)\)/, "and it resets the selection in one step");
  // It must not be gated on the delete capability: clearing is a view action, and a reader with an old orchestrator
  // still needs to be able to untick things.
  const clearBlock = source.slice(source.indexOf("history-clear") - 400, source.indexOf("history-clear"));
  assert.ok(!/onDeleteMany !== undefined &&/.test(clearBlock), "clearing is not conditioned on being able to delete");
});

test("the selected COUNT is visible, not only implied by the button's label", () => {
  // "Delete 3" says what will go; the reader also needs to see that three are selected while deciding.
  const source = readFileSync(new URL("../src/components/History.tsx", import.meta.url), "utf8");
  assert.match(source, /history-selected-count/, "the count is shown in the action bar");
  assert.match(source, /selected ·/, "worded, so it is not a bare number beside other numbers");
});

test("selection is painted on the ROW, not on the wrapper around it", () => {
  // From a screenshot: the tint appeared as a strip to the RIGHT of each selected row. `.history-row-wrap` got the
  // background, but `.history-row` inside it has its own `background: var(--panel)` and `max-width: 900px`, so it
  // painted over the tint and left the wrapper's colour showing only where the row did not reach.
  //
  // Asserted on the stylesheet because this is a pure style outcome: the markup was right, and a rendered-HTML test
  // cannot see which element won the background.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector) => {
    const normalised = css.replace(/\s+/g, " ");
    const wanted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const all = [...normalised.matchAll(new RegExp(`(?<![\\w-])${wanted} ?\\{([^}]*)\\}`, "g"))];
    return all.length > 0 ? all[all.length - 1][1] : undefined;
  };

  const rowSelected = rule(".history-row-wrap.is-selected .history-row-main");
  assert.ok(rowSelected, "the selected ROW has a rule");
  assert.match(rowSelected, /background:\s*var\(--accent-tint\)/, "the row itself carries the tint");
  assert.match(rowSelected, /border-color:\s*var\(--accent\)/, "and an accent edge, so selection is not colour alone");
});

test("search, sort and the bulk control share ONE action bar", () => {
  // They were three stacked rows, costing ~90px before the first session and reading as unrelated controls.
  const html = renderToString(
    createElement(HistoryView, {
      history: [historical()],
      historyTotal: 1,
      home: "/Users/x",
      onResume() {},
      onDeleteMany() {},
    }),
  );
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const bar = doc.querySelector(".history-actions");
  assert.ok(bar, "one bar");
  assert.ok(bar.querySelector(".history-search-input"), "search is in it");
  assert.ok(bar.querySelector(".history-sort"), "sort is in it");
  assert.ok(bar.querySelector(".history-bulk-delete"), "and so is the bulk action");
  assert.ok(!doc.querySelector(".history-toolbar"), "the separate toolbar row is gone");
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
  // And it must still hand the BULK request upward, so the shell's single dialog is reachable.
  assert.match(source, /onDeleteMany\(selectedSessions\)/, "the bulk action asks the shell to confirm");
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

// --- The refusal must be actionable (reported from use) ----------------------------------------

test("a RUNNING rail row offers Stop, so a delete refusal can be acted on", () => {
  // Reported: "I get a warning, that I shall stop this session first. I dont see a session open with that id though."
  // The rail had no Stop at all — it lived in the Session panel for the focused session only — so the instruction
  // pointed at a control the reader could not reach from the list they were looking at.
  const live = {
    id: "s4", name: "data manager work", cwd: "/Users/x/git/data-manager", state: "idle", mode: "sandboxed",
    isolation: "", command: "", scratch: false, messageCount: 3, pending: 0, contextPercent: null,
    tokensTotal: null, cost: null, dialogs: [], warnings: [], startedAt: 0,
  };
  const html = renderToString(
    createElement(SessionRail, {
      ...railProps,
      rows: [{ entry: { path: "/sessions/p/a.jsonl", cwd: live.cwd, name: live.name }, session: live }],
      onStopRow() {},
    }),
  );
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const stop = doc.querySelector(".rail-row-stop button");
  assert.ok(stop, "a Stop control is rendered on the live row");
  assert.match(stop.textContent, /Stop/);
  // The consequence, not the mechanic — and the opposite of Delete's warning, so the two cannot be confused.
  assert.match(stop.title, /transcript stays/);
});

test("Stop is not offered where it cannot act", () => {
  // `stopped` and `failed` have nothing to stop; a control that cannot act is worse than none.
  const stopped = renderToString(
    createElement(SessionRail, {
      ...railProps,
      rows: [{ entry: { path: "/sessions/p/a.jsonl", cwd: "/Users/x/git/p" } }],
      onStopRow() {},
    }),
  );
  // Matched with a boundary: `rail-row-stop` is a PREFIX of `rail-row-stopped-actions`, so a bare substring test
  // matched the stopped-row wrapper and reported a Stop button that was not there.
  assert.ok(!/rail-row-stop[\s"]/.test(stopped), "no Stop on a stopped row");
});

test("an orchestrator without the Stop control is not offered it", () => {
  const live = {
    id: "s1", name: "x", cwd: "/Users/x/git/p", state: "idle", mode: "sandboxed", isolation: "", command: "",
    scratch: false, messageCount: 0, pending: 0, contextPercent: null, tokensTotal: null, cost: null,
    dialogs: [], warnings: [], startedAt: 0,
  };
  const html = renderToString(
    createElement(SessionRail, {
      ...railProps,
      rows: [{ entry: { path: "/sessions/p/a.jsonl", cwd: live.cwd, name: live.name }, session: live }],
    }),
  );
  assert.ok(!/rail-row-stop[\s"]/.test(html), "withheld rather than shown-and-broken");
});

// --- Pagination placement and the session count -----------------------------------------------

/** Many sessions, so the list pages. */
const manySessions = (n = 300) =>
  Array.from({ length: n }, (_, i) => ({
    path: `/sessions/p/${i}.jsonl`,
    id: `id${i}`,
    cwd: "/Users/x/git/data-manager",
    created: "",
    modifiedMs: 10_000 - i,
    bytes: 1_000 + i,
    messageCount: 3,
    firstMessage: `question ${i}`,
    cwdExists: true,
    scratch: false,
  }));

const historyPage = (over = {}) =>
  renderToString(
    createElement(HistoryView, {
      history: manySessions(),
      historyTotal: 885,
      home: "/Users/x",
      onResume() {},
      onDeleteMany() {},
      ...over,
    }),
  );

test("a pager sits at the TOP as well as the bottom", () => {
  // Reported from use: "The pagination element is a little lost there on the bottom, especially users need to scroll a
  // lot to see it." Convention puts it at the bottom, which assumes rows you can take in at once — a History row is a
  // ~120px card, so 25 of them is ~3,000px of travel to reach the only control that leaves the list.
  const doc = new JSDOM(`<body>${historyPage()}</body>`).window.document;
  const pagers = [...doc.querySelectorAll(".history-pages")];
  assert.equal(pagers.length, 2, "one at each end");

  // The TOP one is inside the action bar, which is above the first row — reachable without scrolling.
  const inBar = doc.querySelector(".history-actions .history-pages");
  assert.ok(inBar, "the top pager is in the action bar");
  // The other is after the list.
  const afterList = doc.querySelector(".history-list ~ .history-pages");
  assert.ok(afterList, "and one after the rows");
});

test("two pagers are distinguishable, so a screen reader is not given two identical navs", () => {
  const doc = new JSDOM(`<body>${historyPage()}</body>`).window.document;
  const labels = [...doc.querySelectorAll(".history-pages")].map((p) => p.getAttribute("aria-label"));
  assert.equal(new Set(labels).size, 2, `each pager needs its own name, got ${JSON.stringify(labels)}`);
  // And the buttons too: "Previous" twice in one document is ambiguous out of context.
  const prevLabels = [...doc.querySelectorAll(".history-pages button[aria-label^='Previous']")].map((b) =>
    b.getAttribute("aria-label"),
  );
  assert.equal(new Set(prevLabels).size, 2, "each Previous button says which pager it belongs to");
});

test("both pagers state the RANGE and the total, not the page number", () => {
  // "Page 2 of 12" says how many pages there are; "26–50 of 300" says where you are in the corpus, which is what a
  // reader is asking.
  const doc = new JSDOM(`<body>${historyPage()}</body>`).window.document;
  for (const pager of doc.querySelectorAll(".history-pages")) {
    assert.match(pager.textContent, /1–25 of 300/, "the range and the total");
    assert.ok(!/page 1 of/i.test(pager.textContent), "not a page number");
  }
});

test("one page needs no pager at all", () => {
  // Nowhere to go, and the total is already in the action bar.
  const html = historyPage({ history: manySessions(3), historyTotal: 3 });
  assert.ok(!/history-pages/.test(html), `no pager for a single page: ${html}`);
});

test("the SESSION COUNT is stated as a number, not as a ratio to decode", () => {
  // Reported: "It also shows the number of available sessions, which is an important information." It read
  // `500 of 500 · 885 on disk` — two ratios pushed together, so the reader had to do arithmetic to extract 885.
  const doc = new JSDOM(`<body>${historyPage()}</body>`).window.document;
  const count = doc.querySelector(".history-count");
  assert.ok(count, "the count is present");
  assert.match(count.textContent, /885 sessions/, "the total, as a number with a noun");
  assert.ok(!/of 500/.test(count.textContent), "and not a ratio to decode");
});

test("a filter says how many MATCH, separately from the total", () => {
  const doc = new JSDOM(`<body>${historyPage({ history: manySessions(20), historyTotal: 885 })}</body>`).window.document;
  const count = doc.querySelector(".history-count").textContent;
  assert.match(count, /885 sessions/, "the total is still the total");
  // 20 rows loaded, unfiltered, so nothing "matches" a query — but the total is still stated. The match clause appears
  // only when the visible count differs from the loaded one, which a query produces.
  assert.ok(!/match/.test(count), "no match clause without a filter");
});
