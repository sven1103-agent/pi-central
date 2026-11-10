/**
 * Component rendering tests.
 *
 * These render the real components to HTML and assert on the markup. That is a stronger check
 * than a screenshot for the properties that matter here: presence of an aria attribute,
 * correct grouping, and — most importantly — that a NON-BLOCKING extension UI request renders
 * NOTHING.
 *
 * The components are loaded through Vite's SSR transform, since Node cannot import `.tsx`.
 * React is imported directly from Node, because it is a real ESM package and only the
 * components need transforming.
 *
 * jsdom must be installed before any component loads: DOMPurify binds to `window` at
 * module-init time. It is jsdom rather than happy-dom because under happy-dom DOMPurify
 * silently strips every tag, which would make the markdown assertions vacuous (see
 * `markdown.test.ts`).
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

let server;
let ErrorStrip, SessionRail, ToolTrace, DialogDock, TranscriptView, HistoryView, Composer, FileTree, FilePane, Panel, PanelToggle, FilesPanel, Settings, initialState, ActivityBar, PANEL_MODES;

before(async () => {
  // `root` must be the UI package, not the process CWD: Vite resolves the `/src/...` specifiers
  // below against its root, and the test runner starts from the repository root.
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ ErrorStrip } = await server.ssrLoadModule("/src/App.tsx"));
  ({ SessionRail } = await server.ssrLoadModule("/src/components/SessionRail.tsx"));
  ({ ActivityBar } = await server.ssrLoadModule("/src/components/ActivityBar.tsx"));
  ({ PANEL_MODES } = await server.ssrLoadModule("/src/panel.ts"));
  ({ ToolTrace } = await server.ssrLoadModule("/src/components/ToolTrace.tsx"));
  ({ DialogDock } = await server.ssrLoadModule("/src/components/DialogDock.tsx"));
  ({ TranscriptView } = await server.ssrLoadModule("/src/components/Transcript.tsx"));
  ({ HistoryView } = await server.ssrLoadModule("/src/components/History.tsx"));
  // Loaded here rather than inside a test body: a test that assigned these made every later test
  // depend on it having run, which breaks the moment `--test-name-pattern` selects a subset.
  ({ Composer } = await server.ssrLoadModule("/src/components/Composer.tsx"));
  ({ FileTree } = await server.ssrLoadModule("/src/components/FileTree.tsx"));
  ({ FilePane } = await server.ssrLoadModule("/src/components/FilePane.tsx"));
  ({ Panel } = await server.ssrLoadModule("/src/components/Panel.tsx"));
  ({ FilesPanel } = await server.ssrLoadModule("/src/components/FilesPanel.tsx"));
  ({ Settings } = await server.ssrLoadModule("/src/components/Settings.tsx"));
  ({ PanelToggle } = await server.ssrLoadModule("/src/components/PanelToggle.tsx"));
  ({ initialState } = await server.ssrLoadModule("/src/store.ts"));
});

after(async () => {
  await server?.close();
});

/**
 * React's SSR output separates adjacent text nodes with `<!-- -->`, and escapes characters such as
 * the apostrophe. Assertions here are about what the markup SAYS, not its byte layout, so both are
 * normalised once rather than escaped into every pattern — which is how an assertion on
 * "the current turn's tools" first failed against `turn&#x27;s`.
 */
function text(html) {
  return html
    .replaceAll("<!-- -->", "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function tool(over = {}) {
  return {
    toolCallId: "c", toolName: "bash", args: { command: "ls" }, result: "",
    isError: false, running: false, durationMs: 12, startedAt: 0, afterMessage: 1, ...over,
  };
}

function session(over = {}) {
  return {
    id: "s7", name: "s7", cwd: "/Users/x/git/project", state: "idle", mode: "sandboxed",
    isolation: "Safehouse workdir=/Users/x/git/project", command: "safehouse -- pi --mode rpc",
    scratch: false, messageCount: 0, pending: 0, contextPercent: null, tokensTotal: null,
    cost: null, dialogs: [], warnings: [], startedAt: 0, ...over,
  };
}


/**
 * Rows for the rail from a list of live sessions.
 *
 * The rail takes `RosterRow[]` now (issue #89) — `{entry, session?}` — but every rail test is about a LIVE
 * session's presentation, so the join is done here once rather than in eight call sites. A row with no session
 * is a separate concern and is asserted directly in the roster tests.
 */
const rowsOf = (sessions) =>
  sessions.map((s) => ({ entry: { path: s.sessionFile ?? `live:${s.id}`, cwd: s.cwd, name: s.name }, session: s }));

// --- The rail: attention ordering and honest labels (US-1, US-3) ------------------------------

test("the primary action is first and mentions no directory", () => {
  // The governing decision: starting a session must not require choosing a path (US-1).
  const html = renderToString(createElement(SessionRail, {
    rows: [], focusedId: undefined, onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyTotal: 0,
  }));
  assert.match(html, /class="btn-primary"/);
  assert.match(html, /New session/);
  assert.match(html, /runs in a scratch workspace/);
  // The directory affordance exists but is secondary — and no text input is present.
  assert.match(html, /Open in a directory/);
  assert.ok(!/<input[^>]*type="text"/.test(html), "the primary rail must not contain a path field");
});

test("sessions needing an answer are grouped first", () => {
  // A session blocked on a dialog cannot progress; an idle one can wait.
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([
      session({ id: "idle", state: "idle" }),
      session({ id: "blocked", state: "awaiting-approval", dialogs: [{ id: "d", method: "confirm", message: "Allow?", receivedAt: 0 }] }),
    ]),
    focusedId: undefined, onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyTotal: 0,
  }));
  assert.ok(html.indexOf("Needs you") < html.indexOf("Idle"), "the blocked group must come first");
});

test("a scratch session shows a label, not its internal workspace path", () => {
  // The workspace path is an implementation detail (US-3).
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([session({ scratch: true, cwd: "/Users/x/.local/share/pi-central/workspaces/s7" })]),
    focusedId: "s7", onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyTotal: 0,
  }));
  assert.match(html, /Scratch session/);
  assert.match(html, /scratch · s7/);
  // The full path stays in `title`, where a hover or a screen reader can reach it: hiding it
  // from the scan line is not the same as hiding it from the user.
  assert.match(html, /title="[^"]*workspaces\/s7"/, "the full path should remain available on hover");
  assert.ok(!/>[^<]*workspaces\/s7</.test(html), "the internal path must not be visible text");
});

test("the rail states the TRUE total on disk, not the number loaded", () => {
  // Observed: "500 sessions on disk" while 1115 existed, because the page size was presented as
  // a total. Presenting a page as a total is the kind of confident lie this UI must not tell.
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([session()]), focusedId: "s7", onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {},
    home: "/Users/x", historyTotal: 1115,
  }));
  assert.match(html, /1115 sessions on disk/);
  assert.ok(!html.includes("500 sessions"), "the page size must not be shown as the total");
});

test("a row carries what changes the decision, and not the header's whole metric set", () => {
  /*
   * The rail's third line used to carry `model · thinking · ctx · cost` on every row — four values the workspace
   * header already states for the session being looked at, repeated down the list. A review found that dense
   * without making selection clearer.
   *
   * The defect this test was written for still matters, though, and is the reason it is not simply deleted: a
   * long model name used to eat the line (`deepseek-ai/DeepSeek-V4.1-Flash  high  ct…`), cutting off the values a
   * reader scans for. Dropping the model from the row fixes the cause rather than shortening the symptom — so the
   * assertion is that the SCANNED values survive and the per-row duplicate of the header does not appear.
   */
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([session({ model: "deepseek-ai/DeepSeek-V4.1-Flash", contextPercent: 62, cost: 0.0142 })]),
    focusedId: "s7", onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {}, home: "/Users/x", historyTotal: 0,
  }));
  assert.ok(!html.includes("deepseek-ai/DeepSeek-V4.1-Flash"), "no per-row copy of the model in the rail");
  assert.match(html, /ctx 62%/, "pressure, which changes what the reader should do, stays");
  assert.ok(!/\$0\.0142/.test(html), "cost is a lookup, not a decision: it lives in the header and panel");
});

test("the rail abbreviates HOME, so rows are scannable", () => {
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([session({ cwd: "/Users/x/git/api-gateway", scratch: false })]),
    focusedId: "s7", onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {}, home: "/Users/x", historyTotal: 0,
  }));
  assert.match(html, /~\/git\/api-gateway/);
  assert.ok(!html.includes(">/Users/x/git"), "the home prefix should be abbreviated away");
});

test("the rail states an unknown cost as an em dash, never $0.0000", () => {
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([session({ cost: null })]),
    focusedId: "s7", onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyTotal: 0,
  }));
  assert.ok(html.includes("—"), "expected an em dash for unknown values");
  assert.ok(!html.includes("$0.0000"), "an unknown cost must not read as free");
});

test("a dialog's ask replaces the path line, because that is what the row is for", () => {
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([session({ state: "awaiting-approval", dialogs: [{ id: "d", method: "confirm", message: "Allow running npm test?", receivedAt: 0 }] })]),
    focusedId: "s7", onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyTotal: 0,
  }));
  assert.match(html, /Allow running npm test\?/);
});

// --- The approval dock: the reason the dashboard exists --------------------------------------

test("a blocking confirm renders real actions", () => {
  const html = renderToString(createElement(DialogDock, {
    dialogs: [{ id: "d1", method: "confirm", message: "Allow running npm test?", receivedAt: 0 }],
    onAnswer() {},
  }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /Allow once/);
  assert.match(html, /Deny/);
  assert.match(html, /Cancel request/);
});

test("a select renders each option as a button", () => {
  const html = renderToString(createElement(DialogDock, {
    dialogs: [{ id: "d1", method: "select", message: "Which manager?", options: ["npm", "pnpm", "bun"], receivedAt: 0 }],
    onAnswer() {},
  }));
  for (const option of ["npm", "pnpm", "bun"]) assert.ok(html.includes(option), `missing option ${option}`);
});

test("an editor renders a textarea, not a single-line input", () => {
  const html = renderToString(createElement(DialogDock, {
    dialogs: [{ id: "d1", method: "editor", message: "Edit the file", prefill: "content", receivedAt: 0 }],
    onAnswer() {},
  }));
  assert.match(html, /<textarea/);
});

test("a NON-BLOCKING notify renders NOTHING", () => {
  // THE critical protocol property. Pi emits ~9 non-blocking requests at startup (notify,
  // setStatus, setWidget), each carrying an id. Rendering one as a blocking dialog would wedge
  // the session on a prompt no human will ever answer -- before the user has done anything.
  for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
    const html = renderToString(createElement(DialogDock, {
      dialogs: [{ id: "n1", method, message: "startup noise", receivedAt: 0 }],
      onAnswer() {},
    }));
    assert.equal(html, "", `${method} must not render a dialog (it is not blocking)`);
  }
});

test("an unknown dialog method still offers a way out", () => {
  // A dialog the user cannot dismiss would block the agent forever. This is why the
  // unknown-method default is "blocking" rather than "noise": an unanswerable request that Pi
  // is waiting on hangs the session with no visible cause.
  const html = renderToString(createElement(DialogDock, {
    dialogs: [{ id: "d1", method: "somethingNew", message: "?", receivedAt: 0 }],
    onAnswer() {},
  }));
  assert.match(html, /Cancel request/);
});

test("only one dialog is shown at a time", () => {
  // The agent is blocked on the first anyway; stacking adds no agency.
  const html = renderToString(createElement(DialogDock, {
    dialogs: [
      { id: "d1", method: "confirm", message: "First question", receivedAt: 0 },
      { id: "d2", method: "confirm", message: "Second question", receivedAt: 1 },
    ],
    onAnswer() {},
  }));
  assert.ok(html.includes("First question"));
  assert.ok(!html.includes("Second question"));
});

// --- Quarantine: provenance is visible --------------------------------------------------------

test("the trace shows the latest tools and marks the one running now", () => {
  // The window is BOUNDED on purpose. A real session produced 1138 tool calls; showing them all
  // during a run is the mental load this panel exists to remove.
  const tools = Array.from({ length: 12 }, (_, i) => tool({ toolCallId: `c${i}`, toolName: i % 2 ? "read" : "bash" }));
  tools.push(tool({ toolCallId: "live", toolName: "write", running: true }));
  const html = renderToString(createElement(ToolTrace, {
    tools, selectedId: undefined, onSelect() {}, collapsed: false, onToggleCollapsed() {},
  }));

  assert.match(html, /Tool trace/);
  assert.match(html, /13 calls/);
  assert.match(html, /write running/);
  // The DRAWER states its own economy rather than silently hiding the rest. The panel variant does not: it shows
  // the whole list, so "latest 5 shown" would be false there (see the `variant` tests).
  assert.match(html, /latest 5 shown/);
  // Every call is reachable for debugging: the list is the whole trace, not only the latest 5.
  // Asserted by ROW COUNT rather than by id, because the id is a React key and never reaches the
  // markup -- an assertion on it would pass for the wrong reason or fail for none.
  const rows = html.split('class="trace-row').length - 1;
  assert.equal(rows, 13, `every call must be traversable, found ${rows} rows for 13 calls`);
  // `recent` marks the latest five, so "now" is findable without reading the whole list. Counted
  // by regex because the class list order varies (`trace-row running recent`), which a substring
  // count would miss.
  const recent = [...html.matchAll(/class="trace-row[^"]*\brecent\b/g)].length;
  assert.equal(recent, 5, `expected exactly the latest 5 marked as recent, found ${recent}`);
});

test("the trace renders nothing at all when there are no tool calls", () => {
  const html = renderToString(createElement(ToolTrace, {
    tools: [], selectedId: undefined, onSelect() {}, collapsed: false, onToggleCollapsed() {},
  }));
  assert.equal(html, "", "an always-present empty panel would be permanent chrome");
});

test("tool output is quarantined, preformatted, and shown only for the selected call", () => {
  const tools = [
    tool({ toolCallId: "c1", toolName: "bash", result: "output *one*" }),
    tool({ toolCallId: "c2", toolName: "read", result: "output two" }),
  ];
  const html = renderToString(createElement(ToolTrace, {
    tools, selectedId: "c1", onSelect() {}, collapsed: false, onToggleCollapsed() {},
  }));
  assert.match(html, /Tool output/);
  assert.match(html, /output \*one\*/, "the selected call's output is shown verbatim");
  assert.ok(!html.includes("<em>"), "tool output must not be interpreted as Markdown");
  // Only the selected call's output is rendered; rendering 1138 of them is the original defect.
  assert.ok(!/trace-output[^>]*>[^<]*output two/.test(html), "an unselected call's output must not render");
});

test("the tool output panel carries the QUARANTINE frame, not merely the words", () => {
  // The mismatch this exists for (issue #43): the transcript's legend promises "Tool output and file
  // contents appear in a hatched frame", and the hatch was applied only to `thinking` blocks, so the
  // one surface the legend is about rendered plain.
  //
  // This test previously matched on the string "Tool output" alone, which is a HEADER, not a frame —
  // so it passed for a year's worth of commits while the promise was unkept. Asserting the class on
  // the CONTAINER is what makes it a test of the frame.
  const html = renderToString(createElement(ToolTrace, {
    tools: [tool({ toolCallId: "c1", toolName: "bash", result: "hello" })],
    selectedId: "c1", onSelect() {}, collapsed: false, onToggleCollapsed() {},
  }));
  const panel = /<div class="([^"]*trace-detail[^"]*)"/.exec(html);
  assert.ok(panel, "the output panel must render");
  assert.match(panel[1], /\bis-quarantined\b/, `the frame class must be on the panel, got "${panel[1]}"`);
  // The class is only meaningful if a rule draws something, so it is asserted against the stylesheet
  // rather than the class name — a class with no rule is exactly the state #43 was in.
  //
  // WHAT CHANGED (#138): the 45° hatch was removed everywhere. At this size it read as visual noise
  // rather than as a signal, and the reader's verdict on the flat state was that it looked right. The
  // frame is now the **gutter** — a mark, not a texture — which is what DESIGN §5.2 calls the
  // load-bearing signal anyway, and it is the half that survives `forced-colors`.
  const css = readCss();
  const rule = /\.trace-detail\.is-quarantined\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "a .trace-detail.is-quarantined rule must exist");
  assert.match(rule[1], /border-left:\s*3px solid var\(--quarantine\)/, "the rule must draw the gutter");
  assert.match(rule[1], /var\(--quarantine\)/, "the frame colour must come from the quarantine token");
});

test("the quarantine FRAME is not defeated by cascade order", () => {
  // Found while fixing #43: `.quarantine` and `.trace-detail` both set `background`, and `.trace-detail`
  // is declared LATER, so stacking both classes let the plain background win on source order — markup
  // correct, frame invisible.
  //
  // The frame is now the GUTTER rather than a background (#138), so the property to protect changed with
  // it: every later rule that sets `border-left` on a bare `.trace-detail` would win, because `border`
  // resets all four sides.
  const css = readCss();
  const frameAt = css.indexOf(".trace-detail.is-quarantined {");
  assert.ok(frameAt > 0);
  const after = css.slice(frameAt);
  const laterReset = /\.trace-detail\s*\{[^}]*border\s*:/.exec(after);
  assert.equal(laterReset, null, "a later `.trace-detail` border shorthand would reset the gutter");
});

test("a collapsed trace shows a preview instead of the full list", () => {
  const tools = [tool({ toolCallId: "c1", toolName: "bash" }), tool({ toolCallId: "c2", toolName: "edit" })];
  const html = renderToString(createElement(ToolTrace, {
    tools, selectedId: undefined, onSelect() {}, collapsed: true, onToggleCollapsed() {},
  }));
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /latest: bash · edit/);
  assert.ok(!html.includes("trace-list"), "a collapsed trace must not render the rows");
});

test("a call with no recorded result says so rather than claiming success", () => {
  const html = renderToString(createElement(ToolTrace, {
    tools: [tool({ toolCallId: "c1", toolName: "bash", unfinished: true, result: "" })],
    selectedId: undefined, onSelect() {}, collapsed: false, onToggleCollapsed() {},
  }));
  assert.match(html, /no result/, "an interrupted call must not read as done");
});

test("a failed tool is marked in the trace, not silently shown as done", () => {
  const html = renderToString(createElement(ToolTrace, {
    tools: [tool({ toolCallId: "c1", toolName: "bash", isError: true, result: "boom" })],
    selectedId: undefined, onSelect() {}, collapsed: false, onToggleCollapsed() {},
  }));
  assert.match(html, /failed/);
});

// --- Transcript: the accessibility trade --------------------------------------------------------

test("the transcript region declares aria-busy while streaming and is not a live region", () => {
  // A per-delta live region would emit hundreds of utterances per turn. `aria-busy` is the
  // honest trade, and DESIGN.md §9 records it so it is not "fixed" into the bug later.
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [], tools: [] },
    busy: true,
    sessionLabel: "s7",
  }));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="region"/);
  assert.ok(!html.includes("aria-live"), "the streaming transcript must not be a live region");
});

test("a failed history read says so instead of loading forever", () => {
  // The reported symptom: "i only see that it is loading, but the messages and tool trace never
  // appears". An error is not a pending state, and rendering it as one tells the reader to wait
  // for something that is never coming.
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [], tools: [] }, busy: false, sessionLabel: "s1",
    expectedCount: 11, historyError: "session is not running",
  }));
  assert.match(html, /Could not load this session&#x27;s history/);
  assert.match(html, /session is not running/, "the reason must be shown, not hidden");
  assert.ok(!html.includes("Loading this session"), "a failure must not claim to be loading");
  assert.match(html, /11 messages/, "it should say what it knows: the messages exist");
});

test("while a load is genuinely pending it says loading, not an error", () => {
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [], tools: [] }, busy: false, sessionLabel: "s1", expectedCount: 11,
  }));
  assert.match(html, /Loading this session&#x27;s history/);
});

test("an empty transcript explains where the session works", () => {
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [], tools: [] },
    busy: false,
    sessionLabel: "s7",
  }));
  assert.match(html, /No messages yet/);
  assert.match(html, /scratch workspace/);
});

// --- History: resumability is honest ------------------------------------------------------------

test("a session whose directory is gone is marked before it is clicked", () => {
  // Pi exits 1 on a missing directory in RPC mode, so a resume must be refused, not attempted.
  const html = renderToString(createElement(HistoryView, {
    history: [{
      path: "/s.jsonl", id: "h", cwd: "/Volumes/archive/gone", created: "", modifiedMs: 0, bytes: 10,
      messageCount: 1, firstMessage: "hello", cwdExists: false, scratch: false,
    }],
    onResume() {}, home: undefined,
  }));
  assert.match(html, /directory is gone/);
});

test("a session whose directory merely cannot be READ says so, instead of 'gone' (issue #196)", () => {
  // The defect: History reported 274 of 500 sessions as "directory is gone" on a real machine, and half of those
  // were present-but-unreadable (`EPERM`, an unmounted volume, macOS denying ~/Downloads). A permissions problem is
  // often fixable right now; "gone" tells the reader to stop looking and restore something that is already there.
  //
  // The two cases must be distinguishable from the CHIP alone, because the chip is what the reader scans.
  const unreadable = renderToString(createElement(HistoryView, {
    history: [{
      path: "/s.jsonl", id: "h", cwd: "/Users/x/Downloads", created: "", modifiedMs: 0, bytes: 10,
      messageCount: 1, firstMessage: "hello", cwdExists: false, cwdMissing: "unreadable", cwdError: "EPERM",
      scratch: false,
    }],
    onResume() {}, home: undefined,
  }));
  assert.match(unreadable, /directory unreadable/, "the words say which problem it is");
  assert.ok(!/directory is gone/.test(unreadable), "and not the wrong one");
  assert.match(unreadable, /EPERM/, "the OS code reaches the title, so the reader can act on it");
});

test("a session whose directory is GENUINELY gone still reads as gone", () => {
  // The counterpart, so the new branch cannot swallow the old one.
  const html = renderToString(createElement(HistoryView, {
    history: [{
      path: "/s.jsonl", id: "h", cwd: "/Volumes/archive/gone", created: "", modifiedMs: 0, bytes: 10,
      messageCount: 1, firstMessage: "hello", cwdExists: false, cwdMissing: "missing", cwdError: "ENOENT",
      scratch: false,
    }],
    onResume() {}, home: undefined,
  }));
  assert.match(html, /directory is gone/);
  assert.ok(!/directory unreadable/.test(html));
});

test("a page from an OLDER orchestrator keeps the vaguer wording rather than guessing", () => {
  // `cwdMissing` is optional and absent for a page produced before it existed. Guessing "unreadable" from a bare
  // `cwdExists: false` would be inventing a cause; the old wording is what is actually known.
  const html = renderToString(createElement(HistoryView, {
    history: [{
      path: "/s.jsonl", id: "h", cwd: "/Volumes/archive/gone", created: "", modifiedMs: 0, bytes: 10,
      messageCount: 1, firstMessage: "hello", cwdExists: false, scratch: false,
    }],
    onResume() {}, home: undefined,
  }));
  assert.match(html, /directory is gone/);
});

test("history search is present, since searching by content is the point (US-4)", () => {
  const html = renderToString(createElement(HistoryView, { history: [], onResume() {}, home: undefined }));
  assert.match(html, /type="search"/);
  assert.match(html, /Search sessions by content/);
});

test("no history explains where it would come from", () => {
  const html = renderToString(createElement(HistoryView, { history: [], onResume() {}, home: undefined }));
  assert.match(html, /No sessions on disk yet/);
  assert.match(html, /~\/.pi\/agent\/sessions/);
});

// --- Isolation honesty -------------------------------------------------------------------------

test("the direct-mode banner is rendered, not just styled", () => {
  // The CSS for `.direct-banner` existed from the start but NOTHING rendered it, so `--direct`
  // mode was signalled only by a chip inside the inspector. Running unsandboxed is the single
  // most important fact about a session and deserves top-of-window prominence.
  const css = readCss();
  assert.match(css, /\.direct-banner/, "the class should still be defined");

  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /className="direct-banner"/, "the class must actually be used");
  assert.match(app, /Direct mode: sessions are not sandboxed/, "the copy must be present");
});

// --- The model picker (issue #1) -----------------------------------------------------------------

test("the picker groups models by provider and marks the current one", async () => {
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: "gpt-5", provider: "openai" }),
    models: [
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true },
      { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
      { provider: "anthropic", id: "claude-x", name: "Claude X" },
    ],
    error: undefined,
    onRequest() {},
    onSelect() {},
  }));
  // One optgroup per provider, and the providers appear as labels.
  assert.match(html, /<optgroup label="openai">/);
  assert.match(html, /<optgroup label="anthropic">/);
  // The current model is the select's value — compared with provider AND id.
  assert.match(html, /value="openai\/gpt-5" selected/);
  // A reasoning model is marked, so the thinking-level relationship is visible where the choice is made.
  assert.match(text(html), /GPT-5 · thinking/);
});

test("the picker shows the session's real model before the catalogue arrives", async () => {
  // Absent catalogue means "not asked yet", which must not render as "no models": the current model
  // is known from get_state and is what the control should display.
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: "gpt-5", provider: "openai" }),
    models: undefined,
    error: undefined,
    onRequest() {},
    onSelect() {},
  }));
  assert.match(html, /openai\/gpt-5/);
  assert.ok(!/no models available/.test(html), "an unasked catalogue must not claim there are none");
});

test("a catalogue that failed renders the reason and a Retry, never an empty list", async () => {
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: "gpt-5", provider: "openai" }),
    models: undefined,
    error: "session is not running",
    onRequest() {},
    onSelect() {},
  }));
  assert.match(text(html), /Could not read the model list: session is not running/);
  assert.match(html, /Retry/);
  assert.ok(!/no models available/.test(html), "a failed read must not be reported as an empty catalogue");
});

test("an empty catalogue IS shown as empty, because that is a real answer", async () => {
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: undefined, provider: undefined }),
    models: [],
    error: undefined,
    onRequest() {},
    onSelect() {},
  }));
  assert.match(html, /no models available/);
});

test("the picker does NOT carry a standing note about when a change applies", async () => {
  // REVERSED deliberately. The original asserted a note under the picker, "Applies to the next turn; this run is
  // already using the current model", on the reasoning that a change is not immediate and a control that looked
  // immediate would claim something false.
  //
  // That reasoning still holds — the note was TRUE. It was also on screen permanently for any streaming session,
  // which someone using the app described as distracting: the header is scanned, and a sentence that never
  // changes stops being read and starts being noise.
  //
  // What replaces it: the composer already refuses a model change mid-run in the only way that matters, and the
  // popup closes on selection. A fact that is always true does not need saying every second.
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ state: "streaming", model: "gpt-5", provider: "openai" }),
    models: [{ provider: "openai", id: "gpt-5" }],
    error: undefined,
    onRequest() {},
    onSelect() {},
  }));
  assert.ok(
    !/Applies to the next turn/.test(html),
    `no standing note: ${html}`,
  );
  assert.ok(!/picker-note/.test(html), "and no other standing note either");
});

test("a stopping or failed session's picker is disabled rather than silently inert", async () => {
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  for (const state of ["stopped", "failed", "starting"]) {
    const html = renderToString(createElement(ModelPicker, {
      session: session({ state, model: "gpt-5", provider: "openai" }),
      models: [{ provider: "openai", id: "gpt-5" }],
      error: undefined,
      onRequest() {},
      onSelect() {},
    }));
    assert.match(html, /disabled/, `a ${state} session's picker must be disabled`);
  }
});

test("the picker is not a controlled component that invents the value", () => {
  // The shown value must come from the session (Pi's report), so a refused change leaves the
  // control where it was. Reading the source is the honest check for "no local model state".
  const source = readFileSync(new URL("../src/components/ModelPicker.tsx", import.meta.url), "utf8");
  assert.ok(!/useState<string/.test(source), "the picker must not hold the selected model in local state");
});

// --- The thinking-level picker (issue #2) ---------------------------------------------------------

test("the levels offered are the ones Pi reported for THIS model, not a hardcoded list", async () => {
  const { ThinkingPicker } = await server.ssrLoadModule("/src/components/ThinkingPicker.tsx");
  const html = renderToString(createElement(ThinkingPicker, {
    session: session({ model: "m", provider: "p", thinkingLevel: "low" }),
    levels: ["off", "low", "high"],
    error: undefined,
    onRequest() {},
    onSelect() {},
  }));
  // Every reported level is an option, and nothing else is.
  for (const level of ["off", "low", "high"]) assert.match(html, new RegExp(`value="${level}"`));
  assert.ok(!/value="medium"/.test(html), "a level Pi did not report must not be offered");
});

test("an unread level list is not presented as 'no levels'", async () => {
  const { ThinkingPicker } = await server.ssrLoadModule("/src/components/ThinkingPicker.tsx");
  const html = renderToString(createElement(ThinkingPicker, {
    session: session({ model: "m", provider: "p", thinkingLevel: "medium" }),
    levels: undefined,
    error: undefined,
    onRequest() {},
    onSelect() {},
  }));
  assert.match(html, /reading the levels/);
  // The current level is still shown, because it is known from get_state.
  assert.match(html, /value="" selected/);
  assert.match(html, /medium/);
});

test("the picker shows the session's level, so a level Pi changed is reflected", async () => {
  // Pi re-applies the thinking level on a model switch, so the displayed value must follow Pi
  // (LiveSession.thinkingLevel, set from get_state and thinking_level_changed) rather than the last
  // request this component made.
  const { ThinkingPicker } = await server.ssrLoadModule("/src/components/ThinkingPicker.tsx");
  const html = renderToString(createElement(ThinkingPicker, {
    session: session({ model: "m", provider: "p", thinkingLevel: "high" }),
    levels: ["off", "low", "high"],
    error: undefined,
    onRequest() {},
    onSelect() {},
  }));
  assert.match(html, /value="high" selected/);
});

test("a level the current model does not support is not left selected", async () => {
  // The narrowing case: the model changed and 'high' is no longer available. The control must not
  // show a level that is not in the list — that would offer a value Pi cannot accept.
  const { ThinkingPicker } = await server.ssrLoadModule("/src/components/ThinkingPicker.tsx");
  const html = renderToString(createElement(ThinkingPicker, {
    session: session({ model: "small", provider: "p", thinkingLevel: "high" }),
    levels: ["off", "low"],
    error: undefined,
    onRequest() {},
    onSelect() {},
  }));
  assert.ok(!/value="high" selected/.test(html), "an unsupported level must not remain selected");
  // It is still DISPLAYED, so the value is not silently lost — as the fallback entry. Asserted as
  // the selected option's TEXT rather than an exact attribute spelling, since React renders
  // `selected=""` and the point is which option is chosen, not how the marker is written.
  assert.match(html, /<option value="" selected[^>]*>high<\/option>/);
});

test("a failed level read names the reason rather than looking like an empty list", async () => {
  const { ThinkingPicker } = await server.ssrLoadModule("/src/components/ThinkingPicker.tsx");
  const html = renderToString(createElement(ThinkingPicker, {
    session: session({ model: "m", provider: "p", thinkingLevel: "low" }),
    levels: undefined,
    error: "session is not running",
    onRequest() {},
    onSelect() {},
  }));
  assert.match(text(html), /Could not read the levels: session is not running/);
  assert.match(html, /Retry/);
});

test("a stopped session's thinking picker is disabled", async () => {
  const { ThinkingPicker } = await server.ssrLoadModule("/src/components/ThinkingPicker.tsx");
  const html = renderToString(createElement(ThinkingPicker, {
    session: session({ state: "stopped", model: "m", provider: "p", thinkingLevel: "low" }),
    levels: ["off", "low"],
    error: undefined,
    onRequest() {},
    onSelect() {},
  }));
  assert.match(html, /disabled/);
});

test("the level list is keyed on the model AND the level, so a switch invalidates it", async () => {
  // This is the mechanism behind "a level that no longer exists cannot be selected": the identity
  // changes when Pi's reported level changes, which happens on a model switch because Pi re-applies
  // the level. A key of the model alone would miss that.
  const { thinkingLevelsFor } = await server.ssrLoadModule("/src/components/ThinkingPicker.tsx");
  const base = session({ model: "a", provider: "p", thinkingLevel: "low" });
  const differentModel = session({ model: "b", provider: "p", thinkingLevel: "low" });
  const differentLevel = session({ model: "a", provider: "p", thinkingLevel: "high" });
  assert.notEqual(thinkingLevelsFor(base), thinkingLevelsFor(differentModel));
  assert.notEqual(thinkingLevelsFor(base), thinkingLevelsFor(differentLevel));
  assert.equal(thinkingLevelsFor(base), thinkingLevelsFor(session({ model: "a", provider: "p", thinkingLevel: "low" })));
});

// --- The composer's mode strip and Esc (issue #3) ------------------------------------------------

test("there is no mode strip: the destination is a key, not a control", async () => {
  /*
   * The strip is deleted, and this asserts the DECISION rather than the absence of a class name.
   *
   * Three elements and 26px of permanent dock height existed to choose between two things, and the choice was already
   * expressible as Pi's own keys: `Enter` steers, `Alt+Enter` queues for after the run. The reader's complaint was that
   * the bar was "too much", and it was.
   */
  const streaming = renderToString(createElement(Composer, {
    session: session({ state: "streaming" }), state: initialState(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "", onDraftChange() {},
  }));
  assert.ok(!/mode-strip|mode-choice|mode-option/.test(streaming), "no segmented control");
  const plainStreaming = streaming.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, "");
  // …and both destinations are still stated, which is what the strip was FOR.
  assert.match(plainStreaming, /Enter steers/, "the hint names the steering key");
  assert.match(plainStreaming, /Alt\+Enter queues for after this run/, "…and the follow-up key");
  assert.match(plainStreaming, /Esc stops the run/, "…and the escape hatch");

  // The placeholder states one promise at a time, which is what the caption used to do badly.
  assert.match(streaming, /Steer this run/, "the field says what Enter will do");

  const idle = renderToString(createElement(Composer, {
    session: session({ state: "idle" }), state: initialState(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "", onDraftChange() {},
  }));
  assert.ok(!/mode-strip/.test(idle), "an idle composer offers no destination choice");
  assert.match(idle, /Send a prompt/, "…and says what Enter does when there is only one thing");
});

test("the interim 'steer is not available' copy is gone", async () => {
  // The whole point of the slice: the capability is real now, so the hedge must not survive.
  const html = renderToString(createElement(Composer, {
    session: session({ state: "streaming" }), state: initialState(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "", onDraftChange() {},
  }));
  assert.ok(!/not available/i.test(html), "the interim capability hint must be removed");
  // The hint names the ESC action. It used to add "and returns the queue to this box" — a sentence long enough to wrap
  // under the field, describing feedback the reader already sees (the text reappears in the box).
  assert.match(text(html), /Esc<\/kbd> stops the run/);
});

test("the composer names the action the selected mode will take, and offers no button", async () => {
  /** Rendered text without React's comment separators (which split adjacent text nodes). */
  const plain = (html) => html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, "");

  /*
   * The Send button is gone: Enter submits, which is the natural way to send a prompt and already worked. A second
   * affordance for the same action sat OUTSIDE the input's box and was what dragged the control's width away from
   * the prose's.
   *
   * The distinction the button carried still matters, though — "Send", "Send steer" and "Queue follow-up" are
   * different promises — so it is stated in the placeholder and the hint instead of being lost with the control.
   */
  const steer = renderToString(createElement(Composer, {
    session: session({ state: "streaming" }), state: initialState(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "hello", onDraftChange() {},
  }));
  /*
   * The label is gone with the button, and with the strip. What remains is the HINT, which is where a keyboard
   * destination belongs — and the placeholder, which states the one promise the next Enter will keep.
   */
  assert.match(plain(steer), /Enter steers/, "the hint says which key does what");
  assert.match(steer, /Steer this run/, "…and the field states the promise");
  assert.ok(!/btn-send/.test(steer), "no submit button");
  assert.ok(!/<button[^>]*>\s*Send/.test(steer), "…and no control that looks like one");

  const idle = renderToString(createElement(Composer, {
    session: session({ state: "idle" }), state: initialState(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "hello", onDraftChange() {},
  }));
  assert.match(plain(idle), /Enter to send/, "Enter is named as the way to send");
  assert.ok(!/btn-send/.test(idle), "no submit button when idle either");
});

test("the queue renders as a bounded rail, and offers no per-item control", async () => {
  /*
   * Rows are read-only because Pi Central has no per-item removal, so a `\u00d7` would be a fake control. The one real action
   * is `Clear queue and stop run`, inside the sheet, which says why.
   *
   * The rail is BOUNDED: one row per KIND, never one per message. That is the fix for "it changes the canvas of the
   * transcript" — the dock's height no longer depends on how much is queued.
   */
  const state = { ...initialState(), queues: { s7: { steering: ["do this instead"], followUp: ["and then"] } } };
  const html = renderToString(createElement(Composer, {
    session: session({ state: "streaming", pending: 2 }), state,
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "", onDraftChange() {},
  }));
  const plain = html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, "");

  // Both representatives are there, with their time-words.
  assert.match(plain, /do this instead/);
  assert.match(plain, /and then/);
  assert.match(plain, /now/, "the steering row carries its time-word");
  assert.match(plain, /then/, "…and the follow-up row carries the other");

  // Exactly two rows, whatever is queued. Counted by KIND rather than by the shared class: an `is-unknown` row (for
  // texts that never arrived) is a third kind of row and belongs to a different test.
  const rows = [...html.matchAll(/class="queue-rail-row is-(steer|followUp)/g)].length;
  assert.equal(rows, 2, `one row per kind, got ${rows}`);

  assert.ok(!/\u00d7|Remove|remove/.test(html), "no per-item removal control may be offered");
  assert.match(plain, /Show queue/, "there is a way to the full list");
});

test("a queue count with no texts says so instead of inventing rows", async () => {
  // After a reconnect the count is known and the texts are not, because records are not replayed.
  const html = renderToString(createElement(Composer, {
    session: session({ state: "streaming", pending: 1 }), state: initialState(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "", onDraftChange() {},
  }));
  /*
   * The rail cannot show an invented row, so it says what it knows — the COUNT — in its own words. The sheet adds the
   * useful half: clearing returns the text to the box, where it can be read.
   */
  const plain = html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, "");
  assert.match(plain, /1 queued before this page loaded/);
  // Never a fabricated row: a placeholder would be a claim about what the reader asked for.
  assert.equal([...html.matchAll(/class="queue-rail-row is-steer|class="queue-rail-row is-followUp/g)].length, 0);
});

test("a stopped run says the run stopped rather than claiming text was discarded", async () => {
  // The old copy said the queue "was discarded", which is no longer true: it is returned. The
  // notice must not outlive the transition it describes, so it is transient by construction.
  const source = readFileSync(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.ok(!/was discarded/.test(source), "the discard claim must be gone now the queue is returned");
});

// --- Jump to latest in the SSR markup (issue #6) -------------------------------------------------

test("the jump control is absent from the initial render, because a fresh pane is pinned", () => {
  // The rule is that it appears only while the view is unpinned. At rest the pane starts pinned,
  // so the initial markup has no control — and there is a behaviour test (transcript-scroll) for
  // the interactive half, which `renderToString` cannot reach.
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [], tools: [] }, busy: false, sessionLabel: "s7",
  }));
  assert.ok(!/jump-latest/.test(html), "a pinned pane must not offer a jump control");
});

test("the transcript scroller and the jump control are siblings, so the control cannot scroll away", () => {
  // An absolutely-positioned button inside the scrolling container moves with the content, which
  // is precisely when it is needed. Asserted structurally because it is a layout invariant that a
  // later refactor could break invisibly.
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [], tools: [] }, busy: false, sessionLabel: "s7",
  }));
  assert.match(html, /class="transcript-wrap"/);
  assert.match(html, /class="transcript"/);
});

// --- Fenced code: prose path vs a block (issue #4) -----------------------------------------------

let MessageBody;

test("a message with no code still takes the plain Prose path", async () => {
  // The common case must be byte-for-byte the previous behaviour: one sanitized insertion, no
  // wrapper, no extra element.
  ({ MessageBody } = await server.ssrLoadModule("/src/components/MessageBody.tsx"));
  const html = renderToString(createElement(MessageBody, { text: "Just **prose**." }));
  assert.match(html, /class="prose"/);
  assert.ok(!/data-has-code/.test(html), "a code-free message must not claim to have code");
  assert.ok(!/code-block/.test(html), "no code block for prose");
});

test("a fenced block renders its code as escaped text, never as nothing", async () => {
  // On the first render the grammar has not loaded, so this is the fallback path — and the fallback
  // must show the code. A block that rendered empty would be the worst possible degradation.
  const html = renderToString(createElement(MessageBody, {
    text: "Before\n\n```ts\nconst x = 1;\n```\n\nAfter",
  }));
  assert.match(html, /code-block/);
  assert.match(html, /class="code-lang"[^>]*>ts</);
  assert.match(text(html), /const x = 1;/);
  assert.match(text(html), /Before/);
  assert.match(text(html), /After/);
  assert.match(html, /data-has-code="true"/);
});

test("an unknown language is labelled and still shows its code", async () => {
  // An unknown language falls back to plain text rather than rendering nothing. The label says so,
  // so the reader is not left wondering why this block has no colours.
  const html = renderToString(createElement(MessageBody, {
    text: "```klingon\nnuqneH\n```",
  }));
  assert.match(text(html), /nuqneH/);
  assert.match(html, /class="code-lang"[^>]*>klingon</);
});

test("a fence with no language renders no language label", async () => {
  const html = renderToString(createElement(MessageBody, {
    text: "```\nplain text\n```",
  }));
  assert.match(text(html), /plain text/);
  assert.ok(!/code-lang/.test(html), "a fence naming no language has nothing to label");
});

test("code text is escaped, so a fence cannot inject markup", async () => {
  // React escapes the text, so this is structural rather than a property of the highlighter.
  const html = renderToString(createElement(MessageBody, {
    text: "```ts\nconst s = \"<img src=x onerror=alert(1)>\";\n```",
  }));
  assert.ok(!/<img/.test(html), "code content must never become markup");
  assert.ok(text(html).includes("<img src=x onerror=alert(1)>"), "but it must be VISIBLE as text");
});

// --- Recent directories and "new session here" (issue #149) --------------------------------------
//
// "Same project, new task" is the PRIMARY use case for #149 — one task per session, many sessions per directory —
// so both affordances are asserted as rendered output: the list must be one click per directory, and a directory
// that no longer exists must be VISIBLE and unclickable rather than hidden.

const sampleRecent = [
  { cwd: "/Users/x/git/project", sessions: 4, lastUsedMs: 900, cwdExists: true },
  { cwd: "/mnt/unmounted", sessions: 2, lastUsedMs: 500, cwdExists: false, cwdMissing: "missing" },
  { cwd: "/Users/x/Downloads", sessions: 1, lastUsedMs: 400, cwdExists: false, cwdMissing: "unreadable" },
];

async function sheetWith(recent) {
  const { OpenDirectorySheet } = await server.ssrLoadModule("/src/components/OpenDirectorySheet.tsx");
  /*
   * A places state is REQUIRED for the rail to exist (issue #76): with none, the chooser is withheld on the grounds
   * that an empty pane would claim the machine has no folders — so a test about recent rows must supply one, or it
   * asserts against a sheet that deliberately does not render them.
   */
  const { reducePlaces, initialPlacesState } = await server.ssrLoadModule("/src/places.ts");
  const places = reducePlaces(initialPlacesState(), {
    kind: "placesLoaded",
    home: "/Users/x",
    places: [{ id: "home", label: "Home", path: "/Users/x", exists: true }],
  });
  return renderToString(createElement(OpenDirectorySheet, {
    installationRoot: undefined,
    home: "/Users/x",
    recent,
    places,
    onListPlaces() {},
    onClose() {},
    onOpen() {},
  }));
}

test("used directories are one click each, most recent first, with the count", async () => {
  // They live in the chooser's RAIL now, beside the places (issue #76). That is what let the dialog stop being three
  // stacked regions fighting over one column — the listing was the third thing down and always got the leftovers.
  const html = await sheetWith(sampleRecent);
  assert.match(text(html), /Used before/, "the group is named for what it is");
  assert.match(html, /~/ && /project/, "the row shows the name and the tooltip carries the path");
  assert.match(text(html), /4 sessions/, "a directory says how many sessions ran there");
  assert.equal((html.match(/class="chooser-place chooser-recent"/g) ?? []).length, 3, "one row per directory");
  // Order: the recent one precedes the missing one — the derivation's order is preserved into the rail.
  assert.ok(html.indexOf("project") < html.indexOf("unmounted"), "most recently used comes first");
});

test("a directory that no longer exists is shown, DISABLED, and says why", async () => {
  // Hidden would read as "Pi Central forgot my project" for a volume that is merely unmounted; allowed would
  // spend a spawn on a directory that cannot work, because RPC-mode Pi exits 1 rather than prompting (C2).
  const html = await sheetWith(sampleRecent);
  // The ROW, not a character window around it: the name sits between the icon and the badge, so a fixed-width slice
  // either side of the name reads the wrong elements (and did, after the rail moved the badge to the right).
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const missing = [...doc.querySelectorAll(".chooser-recent")].find((row) => row.textContent.includes("unmounted"));
  assert.ok(missing, "the row exists");
  assert.ok(missing.disabled, "the button cannot be pressed");
  assert.match(missing.textContent, /missing/, "and it states the reason rather than looking broken");
  assert.match(missing.title, /no longer exists/, "the title carries the full path and the reason");
});

test("the sheet distinguishes a MISSING directory from an UNREADABLE one (issue #196)", async () => {
  // Both rows are disabled, but they are different problems: one needs the directory restored, the other needs
  // access granted — and the second is often fixable right now. Saying "missing" for both is what History did.
  const html = await sheetWith(sampleRecent);
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const rows = [...doc.querySelectorAll(".chooser-recent")];

  const gone = rows.find((row) => row.textContent.includes("unmounted"));
  assert.ok(gone?.disabled, "a genuinely missing directory is disabled");
  assert.match(gone.textContent, /missing/, "and says so");
  assert.match(gone.title, /no longer exists/);

  const unreadable = rows.find((row) => row.textContent.includes("Downloads"));
  assert.ok(unreadable?.disabled, "an unreadable directory is also disabled — it cannot be entered either");
  assert.match(unreadable.textContent, /unreadable/, "but it does NOT claim to be missing");
  assert.match(unreadable.title, /cannot be read/, "the title states the recoverable problem");
});

test("the sheet is fed by the REAL derivation, so an unreadable directory survives the trip", async () => {
  // Found by falsifying the previous test: it passed `recent` rows directly, so disabling the aggregation in
  // `recentDirectories` left it green. That is the seam that matters — history in, rows out — because it is where
  // `cwdMissing` could be dropped on the way from the orchestrator's session records to the sheet.
  const { recentDirectories } = await server.ssrLoadModule("/src/recent.ts");
  const base = { created: "", bytes: 10, messageCount: 1, firstMessage: "x", scratch: false, cwdExists: false };
  const history = [
    { ...base, path: "/s/a.jsonl", id: "a", cwd: "/Users/x/Downloads", modifiedMs: 900, cwdMissing: "unreadable", cwdError: "EPERM" },
    { ...base, path: "/s/b.jsonl", id: "b", cwd: "/Volumes/old", modifiedMs: 800, cwdMissing: "missing", cwdError: "ENOENT" },
  ];
  const html = await sheetWith(recentDirectories(history));
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const rows = [...doc.querySelectorAll(".chooser-recent")];
  assert.match(rows[0].textContent, /unreadable/, "the unreadable directory keeps its reason end to end");
  assert.match(rows[1].textContent, /missing/, "and the missing one keeps its own");
});

test("no recent directories means no empty list furniture", async () => {
  // A first run has no history, and a heading over nothing is noise on the one screen a new user sees.
  const html = await sheetWith([]);
  assert.ok(!/Used before/.test(html), "no heading with nothing under it");
  assert.match(text(html), /Open in a directory/, "and the sheet is still the sheet");
});

test("a project session offers one click to a new task in the SAME directory", async () => {
  const { SessionHeader } = await server.ssrLoadModule("/src/components/SessionHeader.tsx");
  const html = renderToString(createElement(SessionHeader, {
    session: session({ cwd: "/Users/x/git/project", scratch: false }),
    home: "/Users/x",
    models: [],
    modelError: undefined,
    onRequestModels() {}, onSelectModel() {},
    thinking: { levels: undefined, error: undefined },
    onRequestThinkingLevels() {}, onSelectThinkingLevel() {},
    onRename() {},
    onNewInDirectory() {},
  }));
  assert.match(text(html), /New session here/, "the frequent action is visible, not in an overflow menu");
});

test("the action shares a ROW with the path, never a block below it", async () => {
  // Reported from a screenshot: "New session here" rendered as a full-width block under the path, looking like a
  // text input and pushing the meter and cost onto another line. `.title` is a flex COLUMN, so a button placed as
  // its next child is a second row — visually a field, because a block on its own line at that width is exactly
  // what a field looks like.
  //
  // Asserted structurally rather than by class name alone: the button must be inside the element that also holds
  // `.where`, so that a future change to the wrapper cannot silently restore the block.
  const { SessionHeader } = await server.ssrLoadModule("/src/components/SessionHeader.tsx");
  const html = renderToString(createElement(SessionHeader, {
    session: session({ cwd: "/Users/x/git/project", scratch: false }),
    home: "/Users/x",
    models: [],
    modelError: undefined,
    onRequestModels() {}, onSelectModel() {},
    thinking: { levels: undefined, error: undefined },
    onRequestThinkingLevels() {}, onSelectThinkingLevel() {},
    onRename() {},
    onNewInDirectory() {},
  }));
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const button = doc.querySelector(".new-in-dir");
  assert.ok(button, "the affordance renders");
  const row = button.closest(".where-row");
  assert.ok(row, "it sits in the location row, not directly in the column");
  assert.ok(row.querySelector(".where"), "and that row is the one holding the path it acts on");
  // It must not be a direct child of the column, which is what made it a block.
  assert.notEqual(button.parentElement?.className, "title", "a direct child of .title becomes its own row");
});

test("its accessible name carries the directory, since the label alone is ambiguous", async () => {
  // "New session here" is unambiguous NEXT TO a path. As an accessible name it needs the directory, and the button
  // announces on its own.
  const { SessionHeader } = await server.ssrLoadModule("/src/components/SessionHeader.tsx");
  const html = renderToString(createElement(SessionHeader, {
    session: session({ cwd: "/Users/x/git/project", scratch: false }),
    home: "/Users/x",
    models: [],
    modelError: undefined,
    onRequestModels() {}, onSelectModel() {},
    thinking: { levels: undefined, error: undefined },
    onRequestThinkingLevels() {}, onSelectThinkingLevel() {},
    onRename() {},
    onNewInDirectory() {},
  }));
  assert.match(html, /aria-label="New session in \/Users\/x\/git\/project"/);
});

test("the action LOOKS like a control at rest, not like the path beside it", async () => {
  // Reported from a screenshot: the button rendered as `~/git/data-manager   New session here`, which reads as one
  // sentence. Stripping the border to keep it quiet removed the only thing saying "this half is clickable" — and
  // DESIGN §5.1 says "nothing depends on hover to be discoverable", which applies most of all to the affordance
  // whose purpose is being noticed.
  //
  // Asserted on the stylesheet, because the defect is a STYLE outcome: the markup was correct both times, and a
  // rendered-HTML assertion cannot see a missing border.
  const css = readCss();
  const rule = (selector) => {
    const normalised = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    const wanted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const all = [...normalised.matchAll(new RegExp(`(?<![\\w-])${wanted} ?\\{([^}]*)\\}`, "g"))];
    return all.length > 0 ? all[all.length - 1][1] : undefined;
  };

  const resting = rule(".new-in-dir");
  assert.ok(resting, ".new-in-dir must have a rule");
  // A visible border at REST. `transparent` or `none` is the defect.
  const border = /border:\s*([^;]+);/.exec(resting)?.[1] ?? "";
  assert.ok(border.length > 0, "the button declares a border");
  assert.ok(!/transparent|none/.test(border), `the resting border must be visible, got "${border}"`);
  // And a background, so it reads as a surface rather than as bare text.
  assert.ok(/(?:^|;)\s*background:\s*var\(--panel-\d\)/.test(resting), "it has a resting surface");
});

test("a SCRATCH session does not offer it — its directory belongs to that one session", async () => {
  // Offering it would start a session in the app-owned workspace of a different session, which is not a project
  // the reader recognises, and would pile up workspaces named s7, s8, s9.
  const { SessionHeader } = await server.ssrLoadModule("/src/components/SessionHeader.tsx");
  const html = renderToString(createElement(SessionHeader, {
    session: session({ cwd: "/Users/x/.local/share/pi-central/workspaces/s7", scratch: true }),
    home: "/Users/x",
    models: [],
    modelError: undefined,
    onRequestModels() {}, onSelectModel() {},
    thinking: { levels: undefined, error: undefined },
    onRequestThinkingLevels() {}, onSelectThinkingLevel() {},
    onRename() {},
    onNewInDirectory() {},
  }));
  assert.ok(!/New session here/.test(html), `no affordance for a scratch session: ${html}`);
});

// --- The self-hosting hazard in the sheet (issue #25) --------------------------------------------

test("the directory sheet warns when the path is Pi Central's own installation", async () => {
  // The warning must appear BEFORE a session exists, while the path is being typed — that is the
  // point at which it can still change the decision.
  const { OpenDirectorySheet } = await server.ssrLoadModule("/src/components/OpenDirectorySheet.tsx");
  const html = renderToString(createElement(OpenDirectorySheet, {
    installationRoot: "/Users/x/git/pi-central",
    initialPath: "/Users/x/git/pi-central/packages/ui",
    onClose() {},
    onOpen() {},
  }));
  assert.match(html, /hazard/);
  assert.match(text(html), /hot-reload/);
  assert.match(text(html), /desynchronise/);
  assert.match(text(html), /separate clone/);
});

test("the warning does not make submission impossible, and is not an error", async () => {
  // Non-blocking is an explicit requirement: the user may have a good reason, and refusing would be
  // worse than warning. The Open button must stay enabled and the notice must not be role="alert",
  // which would interrupt a screen reader on every keystroke as the path is typed.
  const { OpenDirectorySheet } = await server.ssrLoadModule("/src/components/OpenDirectorySheet.tsx");
  const html = renderToString(createElement(OpenDirectorySheet, {
    installationRoot: "/Users/x/git/pi-central",
    initialPath: "/Users/x/git/pi-central/packages/ui",
    onClose() {},
    onOpen() {},
  }));
  assert.ok(!/disabled/.test(html), "the hazard must not disable the Open button");
  assert.match(html, /role="status"/);
  assert.ok(!/role="alert"/.test(html), "a live-typed advisory must not be an alert");
});

test("a separate clone is NOT warned about — the recommended setup must be quiet", async () => {
  // `docs/DOGFOODING.md` recommends running from one checkout and working in a sibling clone.
  // Warning there would train the user to dismiss the warning, which is worse than none at all.
  const { OpenDirectorySheet } = await server.ssrLoadModule("/src/components/OpenDirectorySheet.tsx");
  const html = renderToString(createElement(OpenDirectorySheet, {
    installationRoot: "/Users/x/git/pi-central",
    initialPath: "/Users/x/git/pi-central-dev",
    onClose() {},
    onOpen() {},
  }));
  assert.ok(!/hazard/.test(html), "a sibling clone must not be nagged about");
});

test("the sheet says nothing when the installation root is unknown", async () => {
  // Unknown is reported as unknown, not as safe — but a warning that could not be evaluated must not
  // be invented either. The startup banner reports the unidentifiable root once, where that is
  // actionable; the sheet stays quiet.
  const { OpenDirectorySheet } = await server.ssrLoadModule("/src/components/OpenDirectorySheet.tsx");
  const html = renderToString(createElement(OpenDirectorySheet, {
    installationRoot: undefined,
    initialPath: "/Users/x/git/anything",
    onClose() {},
    onOpen() {},
  }));
  assert.ok(!/hazard/.test(html));
});

// --- Compaction and retry banners (issue #5) -----------------------------------------------------

async function notices(records) {
  const { applyRecord, emptyTranscript } = await server.ssrLoadModule("/src/transcript.ts");
  return records.reduce((t, r) => applyRecord(t, r), emptyTranscript()).notices;
}

test("a running compaction says so, and is not a live region", async () => {
  // A still transcript reads as "Pi Central has stopped doing anything". The banner exists to say
  // what Pi is doing instead — and it must not be announced per delta (DESIGN.md §9).
  const { RunNotices } = await server.ssrLoadModule("/src/components/RunNotices.tsx");
  const html = renderToString(createElement(RunNotices, {
    notices: await notices([{ type: "compaction_start", reason: "overflow" }]),
  }));
  assert.match(text(html), /Compacting context/);
  assert.match(text(html), /the context was full/, "the reason changes what the reader expects");
  assert.ok(!/aria-live/.test(html), "a banner that updates per attempt must not be a live region");
  assert.ok(!/role="alert"/.test(html), "an alert would interrupt a screen reader on every attempt");
});

test("a completed compaction reports the token drop, and never claims the turn is over", async () => {
  const { RunNotices } = await server.ssrLoadModule("/src/components/RunNotices.tsx");
  const html = renderToString(createElement(RunNotices, {
    notices: await notices([
      { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, result: { tokensBefore: 118000, tokensAfter: 41000 } },
    ]),
  }));
  assert.match(text(html), /118\.0k → 41\.0k tokens/);
  // The banner describes the compaction, not the run. "Done" would claim the session finished.
  assert.ok(!/\bdone\b/i.test(text(html)), "a banner must not claim completion");
});

test("an ABORTED compaction does not read as a success", async () => {
  // The distinction that matters most: reporting a failure with the success sentence is the kind of
  // lie this project treats as worse than a missing feature.
  const { RunNotices } = await server.ssrLoadModule("/src/components/RunNotices.tsx");
  const html = renderToString(createElement(RunNotices, {
    notices: await notices([
      { type: "compaction_start", reason: "manual" },
      { type: "compaction_end", reason: "manual", aborted: true, willRetry: false, result: undefined },
    ]),
  }));
  assert.match(text(html), /compaction stopped/);
  assert.ok(!/compacted/i.test(text(html)), "an aborted compaction must not say it compacted");
});

test("a retry banner includes the attempt number AND the bound", async () => {
  const { RunNotices } = await server.ssrLoadModule("/src/components/RunNotices.tsx");
  const html = renderToString(createElement(RunNotices, {
    notices: await notices([{ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: "provider returned 529" }]),
  }));
  const body = text(html);
  assert.match(body, /Retrying \(2\/3\)/);
  assert.match(body, /4s/);
  // Without the bound, "retrying" reads as an unbounded loop and the reader cannot tell whether to
  // wait.
  assert.match(body, /provider returned 529/);
});

test("a retry that succeeded and one that gave up are different sentences", async () => {
  const { RunNotices } = await server.ssrLoadModule("/src/components/RunNotices.tsx");
  const recovered = renderToString(createElement(RunNotices, {
    notices: await notices([
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "529" },
      { type: "auto_retry_end", success: true, attempt: 1 },
    ]),
  }));
  assert.match(text(recovered), /Recovered after 1 retry/);

  const gaveUp = renderToString(createElement(RunNotices, {
    notices: await notices([
      { type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 1000, errorMessage: "529" },
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "provider unavailable" },
    ]),
  }));
  assert.match(text(gaveUp), /Gave up after 3 attempts/);
  assert.match(text(gaveUp), /provider unavailable/);
  assert.ok(!/Recovered/.test(text(gaveUp)), "a failure must not be described as a recovery");
});

test("a summarization retry is attributed to the summarizer, not to the provider", async () => {
  // A different mechanism: nothing was wrong with the provider, and saying there was would send the
  // reader looking in the wrong place.
  const { RunNotices } = await server.ssrLoadModule("/src/components/RunNotices.tsx");
  const html = renderToString(createElement(RunNotices, {
    notices: await notices([
      { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 500, errorMessage: "timeout" },
      { type: "summarization_retry_attempt_start", source: "compaction", reason: "overflow" },
    ]),
  }));
  assert.match(text(html), /context summary/);
  assert.ok(!/provider/i.test(text(html)), "a summarizer failure is not a provider failure");
});

test("no notices renders nothing at all", async () => {
  // The overwhelmingly common case must add no element and no whitespace to the transcript.
  const { RunNotices } = await server.ssrLoadModule("/src/components/RunNotices.tsx");
  assert.equal(renderToString(createElement(RunNotices, { notices: [] })), "");
});

test("the transcript renders the notices it is given, above the tail sentinel", async () => {
  const html = renderToString(createElement(TranscriptView, {
    transcript: {
      messages: [], tools: [],
      notices: [{ kind: "retry", attempt: 1, maxAttempts: 2, delayMs: 1000, errorMessage: "529" }],
    },
    busy: true,
    sessionLabel: "s1",
  }));
  assert.match(text(html), /Retrying \(1\/2\)/);
});

test("a transcript with no notices is unchanged in the markup", async () => {
  // A guard on the common path: adding the feature must not alter a transcript that has no notices.
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [], tools: [], notices: [] },
    busy: false,
    sessionLabel: "s1",
  }));
  assert.ok(!/run-notice/.test(html));
});

// --- Clicking a session in the rail actually focuses it ------------------------------------------
//
// The bug this exists for was NOT in the rail's markup — the rail rendered correct buttons with the
// right handler, and its tests all passed. The bug was in what the handler WAS WIRED TO: `App.tsx`
// dispatched a `session` event, and that event's focus rule is "never steal focus from a session the
// user is reading", so with focus already set it kept the old id and the click was a no-op.
//
// So these tests exercise the WIRING, not the component in isolation. A test that passed an `onFocus`
// spy to `SessionRail` would have passed before the fix and after it, which is exactly the kind of
// test that let this ship.

test("clicking a rail row dispatches a dedicated focus change, not a session upsert", async () => {
  // The load-bearing assertion: the action kind. A `session` event here is the bug.
  const { reduce, initialState: blank, focusedSession } = await server.ssrLoadModule("/src/store.ts");

  // Reproduce App.tsx's onFocus wiring, then assert the outcome a user would see.
  const focus = (state, key) => reduce(state, { kind: "focusRow", key });

  let state = blank();
  state = reduce(state, { kind: "session", session: session({ id: "s1" }) });
  state = reduce(state, { kind: "session", session: session({ id: "s2" }) });
  assert.equal(focusedSession(state).id, "s1");

  state = focus(state, "s2");
  assert.equal(focusedSession(state).id, "s2", "the session the user clicked must become focused");

  // And back, since alternating is the actual use: the rail is for moving between sessions.
  state = focus(state, "s1");
  assert.equal(focusedSession(state).id, "s1");
});

test("the rail's row handler receives the session it belongs to", async () => {
  // Guards the other half of the wiring: a handler closed over the wrong index would focus a
  // neighbouring row, which reads as "clicking does something random" rather than "nothing happens".
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([session({ id: "s1", name: "first" }), session({ id: "s2", name: "second" })]),
    focusedId: "s1", onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {},
    home: undefined, historyTotal: 0,
  }));
  // The row is a `<div>` holding a `<button class="rail-row-main">` (issue #89): it can also carry a Forget
  // action, and nesting buttons is invalid HTML that browsers resolve by breaking the inner one.
  const rows = html.match(/class="rail-row state-/g) ?? [];
  assert.equal(rows.length, 2, "both sessions must render a row");
  // Each row is still a real button, so it is reachable and activatable by keyboard as well.
  assert.equal((html.match(/<button[^>]*rail-row-main/g) ?? []).length, 2);
});

test("focus is marked with aria-current so the focus is not colour-only", async () => {
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([session({ id: "s1" }), session({ id: "s2" })]),
    focusedId: "s2", onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {},
    home: undefined, historyTotal: 0,
  }));
  const rows = html.match(/<button[^>]*rail-row-main[^>]*>/g) ?? [];
  const marked = rows.filter((row) => row.includes('aria-current="true"'));
  assert.equal(marked.length, 1, "exactly one row is current");
  // The second session renders after the first, and it is the one that must be marked.
  assert.ok(rows[1].includes('aria-current="true"'), "the focused session must be the marked one");
});

// --- The model label is shortened well, not clipped (issue #42) ----------------------------------

test("the closed model control shows a MIDDLE-elided name, not a trailing cut", async () => {
  // The screenshot's symptom: `litellm/deepseek-`, which is the raw string clipped by CSS. Both ends
  // of a model name carry identity — the provider says where it runs, the tail distinguishes variants
  // — so a trailing cut throws away the part a reader scans for.
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  // Long enough to be elided at the CURRENT cap. The cap has moved twice (22 → 30 → 44), and each time the old
  // fixture stopped being elided at all — which made the assertions below pass vacuously rather than fail.
  const cap = Number(/const LABEL_MAX = (\d+);/.exec(
    readFileSync(new URL("../src/components/ModelPicker.tsx", import.meta.url), "utf8"))[1]);
  const model = `litellm/${"deepseek-v4-flash-vision-".repeat(3)}experimental`;
  assert.ok(model.length > cap, `the fixture must exceed the ${cap}ch cap, got ${model.length}`);
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model, provider: "litellm" }),
    models: undefined, error: undefined, onRequest() {}, onSelect() {},
  }));
  const shown = /class="picker-display[^"]*"[^>]*>([^<]*)</.exec(html)?.[1];
  // Asserted as PROPERTIES, not as a literal: the cap moved once already (#74) and a hard-coded
  // string made a change of width look like a change of behaviour. What the test is about is that an
  // elision keeps both ends.
  assert.ok(shown.startsWith("litellm/"), `the provider must survive (it says where it runs), got ${JSON.stringify(shown)}`);
  assert.ok(shown.endsWith(model.slice(-12)), `the variant tail must survive, got ${JSON.stringify(shown)}`);
  assert.ok(!shown.endsWith("-"), "a trailing cut is the bug: it loses the identifying tail");
  assert.ok(shown.includes("…"), "an elision must be marked as one");
  assert.ok(shown.length <= cap, `the label must fit the control (${cap}ch), got ${shown.length}`);
});

test("the full model name is always available, so an elision is never the only answer", async () => {
  // Truncation may not be the only way to learn which model is in use. `title` gives a pointer the
  // full name, and the select keeps the complete option text for assistive technology.
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: "deepseek-V4.1-Flash", provider: "litellm" }),
    models: undefined, error: undefined, onRequest() {}, onSelect() {},
  }));
  assert.match(html, /title="litellm\/deepseek-V4\.1-Flash"/, "the full name must be on the control");
  // NARROWED in issue #163. The option used to carry `provider/id` as well; it now carries the model alone,
  // because the provider is its own field and repeating it there put it on two lines. The rule this guards — "an
  // elision is never the only answer" — is still satisfied: the full identity is on `title`, and the provider is
  // readable as text beside the field rather than only on hover.
  assert.match(html, /<option value=""[^>]*>deepseek-V4\.1-Flash</, "the option still carries the model");
  assert.match(html, /class="picker-provider mono"[^>]*>litellm</, "and the provider is visible, not hover-only");
});

test("the shortened overlay is hidden from assistive technology", async () => {
  // It is a visual restatement of the select's own value. Announcing it would read the model twice,
  // and read the SHORTENED version — so the one surface a screen reader gets would be the elision.
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: "gpt-5", provider: "openai" }),
    models: undefined, error: undefined, onRequest() {}, onSelect() {},
  }));
  assert.match(html, /class="picker-display[^"]*"[^>]*aria-hidden="true"/);
});

test("the OPTIONS are never truncated, because that is where the choice is made", async () => {
  // The counterpart to the first test, and the reason an overlay exists at all: a native <select>
  // renders the selected option's text when closed, so a shortened closed label and full list entries
  // cannot both come from option text. If this ever regresses, picking a model becomes guesswork.
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  // Long enough to be elided at the CURRENT cap: at 22 characters the shorter name below was elided
  // for the wrong reason, and at 30 it would not be elided at all, leaving the second half of this
  // test asserting nothing.
  // Derived from the CURRENT cap, so raising it cannot silently make this test assert nothing — which it did when
  // the cap moved from 30 to 44: the "long" name below was no longer long enough to be elided at all.
  const cap = Number(/const LABEL_MAX = (\d+);/.exec(
    readFileSync(new URL("../src/components/ModelPicker.tsx", import.meta.url), "utf8"))[1]);
  const long = `${"DeepSeek V4 Flash ".repeat(3)}Vision Experimental`;
  assert.ok(long.length > cap, `the fixture must exceed the ${cap}ch cap, got ${long.length}`);
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: "deepseek-v4-flash-vision-exp", provider: "litellm" }),
    models: [{ provider: "litellm", id: "deepseek-v4-flash-vision-exp", name: long }],
    error: undefined, onRequest() {}, onSelect() {},
  }));
  assert.ok(html.includes(`>${long}<`) || html.includes(`>${long}<!-- -->`),
    "the option must carry the full name");
  const shown = /class="picker-display[^"]*"[^>]*>([^<]*)</.exec(html)?.[1];
  assert.notEqual(shown, long, "and the closed label must still be shortened");
  // The overlay must shorten the FRIENDLY name, not the raw id. Asserting only that it differs from
  // the long name is too weak: shortening the raw id also differs, while showing a different string
  // from the option the user is actually on. The tail is what proves which one it read.
  assert.ok(shown.endsWith("Experimental"), `the overlay must elide the option's name, got ${JSON.stringify(shown)}`);
});

test("the label shortens with the shared helper, so surfaces cannot drift", async () => {
  // `format.ts` exists so one value has one convention. Asserted against the helper itself rather
  // than against a literal, because this bug WAS the picker not using it.
  const { truncateMiddle } = await server.ssrLoadModule("/src/format.ts");
  const name = "deepseek-v4-flash-vision-exp";
  // 22 characters exactly, keeping the head (the provider-prefixed family) and the tail (the
  // variant). Asserted with the length so a future change to the split is caught here rather than
  // discovered as a trailing cut.
  assert.equal(truncateMiddle(name, 22), "deepseek-v4-…ision-exp");
  assert.equal(truncateMiddle(name, 22).length, 22);
  assert.equal(truncateMiddle("openai/gpt-5", 22), "openai/gpt-5", "a name that fits is untouched");
});

test("a short model name is left alone rather than elided for no reason", async () => {
  // NARROWED in issue #163, not deleted. The rule being guarded is "do not elide what fits"; the original asserted
  // the text `openai/gpt-5` in the model field, which was the model and the provider concatenated. The provider is
  // its own field now, so that string no longer exists — the rule is asserted against the field that remains.
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: "gpt-5", provider: "openai" }),
    models: undefined, error: undefined, onRequest() {}, onSelect() {},
  }));
  assert.match(html, /class="picker-display[^"]*"[^>]*>gpt-5</, "the model alone, unelided");
  assert.ok(!/gpt-5[^<]*…/.test(html), "a name that fits must not be elided");
});

test("the provider is shown as its own field, not hidden in the dropdown (issue #163)", async () => {
  // The complaint: with the same model configured on two providers, the header named the model and hid the half
  // that decides cost and routing. And wherever a catalogue name is absent the model label fell back to
  // `provider/id`, which put the provider on both lines.
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: "gpt-5", provider: "litellm" }),
    models: undefined, error: undefined, onRequest() {}, onSelect() {},
  }));
  // The label now carries `data-picker-row` so the grid can place it; matching the exact old attribute string
  // would fail on the added attribute rather than on anything about the provider.
  assert.match(html, /class="picker-label"[^>]*>Provider</, "it has its own label");
  assert.match(html, /class="picker-provider mono"[^>]*>litellm</, "and its own value, in mono like the model id");
  // The VISIBLE text of the model line must not repeat it. `title` attributes and the placeholder `<option>` still
  // carry `provider/id`, and both are legitimate: the option is what a `<select>` needs to display a value it has no
  // catalogue entry for yet, and the title is the full identity for a pointer. Asserting a bare count would have
  // failed on those, which is why this checks rendered text rather than occurrences.
  const visible = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  assert.equal(
    (visible.match(/litellm/g) ?? []).length,
    1,
    `the provider must appear once as visible text: ${visible}`,
  );
});

test("an unknown provider is an em dash, never a blank or a guess", async () => {
  // Pi reports the provider after `get_state`, so a session can be shown before it is known. A blank field reads as
  // "there is no provider"; an em dash is the established way this UI says "not known" (see the metrics strip).
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: "gpt-5", provider: undefined }),
    models: undefined, error: undefined, onRequest() {}, onSelect() {},
  }));
  assert.match(html, /class="picker-provider mono"[^>]*>—</);
});

test("the disabled overlay is marked, so it does not look actionable when the select is not", async () => {
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ state: "stopped", model: "gpt-5", provider: "openai" }),
    models: undefined, error: undefined, onRequest() {}, onSelect() {},
  }));
  assert.match(html, /class="picker-display[^"]*is-disabled/);
});

test("the overlay cannot swallow the click that opens the select", async () => {
  // The overlay covers the select, so without `pointer-events: none` the control would stop opening —
  // a fix for a cosmetic bug that breaks the interaction. Asserted against the stylesheet because the
  // markup cannot express it, and because this is invisible to any rendering test.
  const css = readCss();
  const rule = /\.picker-display\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "the overlay must have a rule");
  assert.match(rule[1], /pointer-events:\s*none/, "the overlay must not intercept clicks");
  // And the label must be positioned over the closed control, or it would render as a second field.
  assert.match(rule[1], /position:\s*absolute/);
});

// --- The file tree (issue #8) --------------------------------------------------------------------

/** A FilesState with one directory loaded. Built directly, since the reducer's own tests cover it. */
async function filesState(directories = {}, extra = {}) {
  const { initialFilesState } = await server.ssrLoadModule("/src/files.ts");
  return {
    ...initialFilesState(),
    directories,
    ...extra,
  };
}

test("an unloaded directory says it is not loaded, rather than rendering as empty", async () => {
  // The distinction the whole file-tree state module exists to protect. "Not asked" and "empty" are
  // different facts, and rendering the first as the second is a claim about the disk nobody made.
  const state = await filesState();
  const html = renderToString(createElement(FileTree, {
    sessionId: "s1", state, cwd: "/work",
    onExpand() {}, onCollapse() {}, onToggleHidden() {}, onOpenFile() {},
  }));
  assert.match(html, /Not loaded yet/);
  assert.ok(!/is empty/i.test(html), "an unloaded directory must not claim to be empty");
});

test("a loaded-but-empty directory says it is empty, and is NOT an error", async () => {
  const state = await filesState({ "s1\u0000": { status: "loaded", entries: [], truncated: false } });
  const html = renderToString(createElement(FileTree, {
    sessionId: "s1", state, cwd: "/work",
    onExpand() {}, onCollapse() {}, onToggleHidden() {}, onOpenFile() {},
  }));
  assert.match(html, /This directory is empty/);
  assert.ok(!/filetree-error/.test(html), "an empty directory is not a refusal");
});

test("a REFUSED listing states the reason, and never reads as empty", async () => {
  // The claim this slice is built around. A refusal rendered as an empty directory would tell the
  // user a directory is empty when the request was denied.
  const state = await filesState({
    "s1\u0000../secret": { status: "error", reason: "escapes-cwd", message: '"../secret" resolves outside the working directory' },
  });
  // Root loaded and expanded so the error node for `../secret` is reachable in the markup.
  state.directories["s1\u0000"] = { status: "loaded", entries: [{ name: "secret-link", kind: "directory", hidden: false }], truncated: false };
  state.expanded["s1\u0000secret-link"] = true;
  state.directories["s1\u0000secret-link"] = { status: "error", reason: "escapes-cwd", message: '"secret-link" resolves outside the working directory' };

  const html = renderToString(createElement(FileTree, {
    sessionId: "s1", state, cwd: "/work",
    onExpand() {}, onCollapse() {}, onToggleHidden() {}, onOpenFile() {},
  }));
  assert.match(html, /Outside the working directory/, "the reason must be stated in words");
  assert.ok(!/is empty/i.test(html), "a refusal must never be rendered as an empty directory");
});

test("a too-large refusal names both sizes, because the reader has to judge", async () => {
  const state = await filesState();
  const html = renderToString(createElement(FilePane, {
    path: "big.log",
    state: { status: "error", reason: "too-large", message: '"big.log" is 4.2 MB, above the 256.0 KB limit and was not read' },
    wrapped: true, onToggleWrap() {}, onClose() {},
  }));
  assert.match(html, /Too large to read/);
  assert.match(html, /4\.2 MB/);
  assert.match(html, /256\.0 KB/);
});

test("a truncated listing says so, so it cannot be read as complete", async () => {
  const state = await filesState({
    "s1\u0000": { status: "loaded", entries: [{ name: "a", kind: "file", hidden: false }], truncated: true },
  });
  const html = renderToString(createElement(FileTree, {
    sessionId: "s1", state, cwd: "/work",
    onExpand() {}, onCollapse() {}, onToggleHidden() {}, onOpenFile() {},
  }));
  assert.match(html, /Showing the first entries only/);
});

test("a nested truncated directory says so too, not only the root", async () => {
  // The root's notice speaks for the root. A capped NESTED directory that ended silently would read
  // as complete — the same false claim one level down.
  const state = await filesState();
  state.directories["s1\u0000"] = { status: "loaded", entries: [{ name: "big", kind: "directory", hidden: false }], truncated: false };
  state.directories["s1\u0000big"] = { status: "loaded", entries: [{ name: "a", kind: "file", hidden: false }], truncated: true };
  state.expanded["s1\u0000big"] = true;

  const html = renderToString(createElement(FileTree, {
    sessionId: "s1", state, cwd: "/work",
    onExpand() {}, onCollapse() {}, onToggleHidden() {}, onOpenFile() {},
  }));
  assert.match(html, /Showing the first entries only/, "the nested cap must be stated where it applies");
});

test("file contents are rendered as text, never as markup", async () => {
  // ADR-0006: file content is untrusted for the same reason a transcript is — it may have been
  // written by the agent, by a dependency, or by whoever sent the repository.
  const state = await filesState();
  const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const html = renderToString(createElement(FilePane, {
    path: "x.txt",
    state: { status: "loaded", content: { kind: "text", text: payload }, bytes: payload.length },
    wrapped: true, onToggleWrap() {}, onClose() {},
  }));
  assert.ok(!/<img/i.test(html) && !/<script>alert/i.test(html), `markup must be escaped, got: ${html}`);
  assert.match(html, /&lt;img/);
});

test("the tree is labelled by SCOPE, not as the agent's view", async () => {
  // ADR-0007: the browser reads at the user's UID and can reach files the agent cannot. Presenting it
  // as the agent's view would be a false claim the moment anything browses wider than the workdir.
  const state = await filesState({ "s1\u0000": { status: "loaded", entries: [], truncated: false } });
  const html = renderToString(createElement(FileTree, {
    sessionId: "s1", state, cwd: "/work",
    onExpand() {}, onCollapse() {}, onToggleHidden() {}, onOpenFile() {},
  }));
  assert.match(html, /Working directory/);
  assert.ok(!/agent.s view|what the agent/i.test(html), "must not imply the sandboxed agent's view");
});

test("the dotfile toggle's label states the ACTION, not the current state", async () => {
  // A button labelled by its state is read as a status and then clicked twice by anyone who takes it
  // for one. With dotfiles hidden it must therefore offer to SHOW them.
  const state = await filesState({ "s1\u0000": { status: "loaded", entries: [], truncated: false } });
  const html = renderToString(createElement(FileTree, {
    sessionId: "s1", state, cwd: "/work",
    onExpand() {}, onCollapse() {}, onToggleHidden() {}, onOpenFile() {},
  }));
  assert.match(html, /Show dotfiles/);
  assert.match(html, /aria-pressed="false"/);
});


/**
 * The stylesheet with comments removed.
 *
 * Assertions about CSS must not be satisfiable by PROSE. A falsification caught this: removing
 * `container-type: inline-size` still passed, because the same phrase appears in the explanatory
 * comment above the rule. Comments are documentation, and a test that a comment can satisfy is not
 * testing the stylesheet.
 */
function readCss() {
  return readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

// --- The panel region and its modes (issue #8, reworked) ------------------------------------------

/** The minimum a Panel needs. Width and handlers are supplied per test. */
function panelProps(extra = {}) {
  return {
    mode: "session", onMode() {}, width: 360, onWidth() {}, viewportWidth: 1600,
    ...extra,
  };
}

test("the context bar offers every panel mode, and marks the active one", async () => {
  /*
   * The modes moved OUT of the panel and onto the window's right edge, so they are asserted where they
   * live now. The first version of this change had a bar in both places, which produced two elements with
   * the same id — so this test also pins that there is exactly ONE of each.
   *
   * `Panel` still owns `aria-controls`/`role=tabpanel`; the bar owns the tabs.
   */
  const html = renderToString(createElement(ActivityBar, {
    side: "right",
    as: "tablist",
    label: "Session view",
    items: PANEL_MODES.map(({ mode, label, glyph }) => ({
      id: `session-view-${mode}`,
      label,
      glyph,
      active: mode === "session",
      onSelect() {},
    })),
  }));
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-orientation="vertical"/, "the bar is a column, so it says so");
  // Session, Files, Trace — the trace moved here from a drawer under the transcript, so there are three.
  assert.equal((html.match(/role="tab"/g) ?? []).length, 3, "Session, Files and Trace");
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.match(html, /aria-selected="true"[^>]*aria-label="Session"/);
  assert.match(html, /aria-label="Trace"/, "the trace is reachable as a mode rather than a strip");
  // One element per mode, so the ids are unique in the document.
  for (const mode of ["session", "files", "trace"]) {
    assert.equal((html.match(new RegExp(`id="session-view-${mode}"`, "g")) ?? []).length, 1, `one ${mode} item`);
  }
});

test("the panel is a body and a resizer, with no mode bar of its own", () => {
  // The bar is one element at the window's right edge, not one per panes-with-a-panel. Asserted as an
  // absence because the failure mode was a second copy that looked correct in isolation.
  const html = renderToString(createElement(Panel, panelProps(), createElement("p", null, "body")));
  assert.ok(!/role="tablist"/.test(html), "the panel must not render its own mode tabs");
  assert.ok(!/class="activity/.test(html), "nor its own activity bar");
  assert.match(html, /class="panel-body"/, "…it renders the body");
});

test("only the selected ITEM is in the tab order (roving tabindex)", () => {
  // Scoped to the tabs on purpose: the resize separator is also tabbable, and counting every
  // `tabindex="0"` conflated the two — which is how the first version of this test passed for the wrong
  // reason. Now the bar is asserted in isolation, so only its own items can appear.
  const html = renderToString(createElement(ActivityBar, {
    side: "right",
    as: "tablist",
    label: "Session view",
    items: PANEL_MODES.map(({ mode, label, glyph }) => ({
      id: `session-view-${mode}`, label, glyph, active: mode === "files", onSelect() {},
    })),
  }));
  const tabs = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
  assert.equal(tabs.length, 3, "expected three tabs");
  const selected = tabs.filter((t) => t.includes('aria-selected="true"'));
  const other = tabs.filter((t) => t.includes('aria-selected="false"'));
  assert.equal(selected.length, 1);
  assert.equal(other.length, 2, "every unselected tab is skipped, not just the first");
  assert.match(selected[0], /tabindex="0"/, "the selected tab must be reachable by Tab");
  for (const tab of other) assert.match(tab, /tabindex="-1"/, "the unselected tabs must be skipped");
});

test("the body is tied to the control that selects it", () => {
  // `aria-labelledby` on the tabpanel is what makes the region announce as "Files, tab panel" rather
  // than as an unlabelled group. The id it names belongs to the context bar, which is outside the panel
  // — `aria-labelledby` deliberately spans the document.
  const html = renderToString(createElement(Panel, panelProps({ mode: "files" }), createElement("p", null, "body")));
  assert.match(html, /id="panel-body-files"[^>]*aria-labelledby="session-view-files"/);
});

test("the resize handle is an operable separator with its bounds stated", () => {
  // The bounds are what make it a separator a screen reader can act on rather than a decorative
  // line. `aria-valuetext` carries the unit, because "512" alone says nothing.
  const html = renderToString(createElement(Panel, panelProps({ width: 512 }), createElement("p", null, "body")));
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /aria-valuenow="512"/);
  assert.match(html, /aria-valuemin="280"/);
  assert.match(html, /aria-valuetext="512 pixels"/);
  assert.match(html, /tabindex="0"/);
});

test("the handle is absent when there is no edge to drag", () => {
  // Below 1440px the panel is a sheet over the transcript; a separator that does nothing is a lie.
  const html = renderToString(createElement(Panel, panelProps({ resizable: false }), createElement("p", null, "body")));
  assert.ok(!/role="separator"/.test(html), "a non-resizable panel must not offer a separator");
});

test("Files mode shows the tree, and Session mode does NOT", () => {
  // THE regression guard for the defect that prompted this rework: the file browser was inside the
  // inspector, which is a list of session facts. If it creeps back, this fails.
  const files = { directories: { "s1\u0000": { status: "loaded", entries: [], truncated: false } }, files: {}, expanded: {}, openFile: {}, showHidden: {} };
  const inFiles = renderToString(createElement(FilesPanel, {
    sessionId: "s1", files, cwd: "/work",
    onExpand() {}, onCollapse() {}, onToggleHidden() {}, onOpenFile() {}, onCloseFile() {},
  }));
  assert.match(inFiles, /filetree/, "Files mode must render the tree");

  const { Inspector } = { Inspector: null };
  // The Inspector is asserted by source, not by render: it takes a LiveSession, and building a
  // faithful one here would test the fixture rather than the placement.
  const source = readFileSync(new URL("../src/components/Inspector.tsx", import.meta.url), "utf8");
  assert.ok(!/FileTree|FilePane|filetree/.test(source), "the Inspector must not contain the file browser");
});

test("the document gets its own scroll, and is not capped inside the panel", () => {
  // The nested-scroll defect: a `max-height` on the document inside an already-scrolling panel gives
  // two scrollbars competing for one wheel. Asserted on the stylesheet because no render can see it.
  const css = readCss();
  const lines = /\.filepane-lines\s*\{([^}]*)\}/.exec(css);
  assert.ok(lines, "the document body must have a rule");
  assert.ok(!/max-height/.test(lines[1]), "the document must not cap its own height");
  assert.match(lines[1], /list-style:\s*none/);
  // And the scrolling container is the document pane, which is a grid area rather than a block in a
  // shared column.
  const doc = /\.files-doc\s*\{([^}]*)\}/.exec(css);
  assert.ok(doc && /overflow:\s*auto/.test(doc[1]), "the document pane must own the scrolling");
});

test("the panel is a named query container, and the split query targets that name", () => {
  // The panel is resizable, so the window can be 2560px while the panel is 300px. A viewport media
  // query would answer the wrong question and split the pane at the wrong moment.
  //
  // Asserted as the PAIRING rather than by extracting `.panel`'s rule body: `String.match` returns
  // the first match, and a `@media` block later in the file also declares `.panel`, so a rule-body
  // regex silently reads the wrong one. A `@container NAME` query can only match an element that
  // declares `container-name: NAME`, so asserting both — with the same name — is the real property.
  const css = readCss();
  assert.match(css, /container-type:\s*inline-size/, "the panel must be a size container");
  assert.match(css, /container-name:\s*panel\b/, "the container must be named");
  assert.match(css, /@container panel \(min-width: 560px\)/, "the split must query that name");
  /*
   * And the container is `.panel-content`, not `.panel` — a deliberate move when the mode bar became a
   * vertical column inside the panel. An inline-size container cannot be queried by content laid out
   * beside it: `@container panel (min-width: 560px)` would then measure the panel INCLUDING the 48px
   * bar, and split the file view 48px early. Measured in the figure work: at a 560px panel that is the
   * difference between a readable document and a clipped one.
   */
  const content = /\.panel-content\s*\{([^}]*)\}/.exec(css);
  assert.ok(content, "the panel must have a content column");
  assert.match(content[1], /container-type:\s*inline-size/, "the content column is the query container");
  assert.match(content[1], /container-name:\s*panel\b/, "…with the same name, so the queries still match");
  /*
   * The panel is a COLUMN and holds no bar. An earlier version of this assertion required
   * `flex-direction: row` — it was describing the implementation I had just written, including the bug in
   * it, rather than the property that matters. A test can hold a defect in place.
   */
  const panel = /\.panel\s*\{([^}]*)\}/.exec(css);
  assert.match(panel?.[1] ?? "", /flex-direction:\s*column/, "the panel is a column: content above, resizer overlay");
  const rendered = renderToString(createElement(Panel, panelProps(), createElement("p", null, "body")));
  assert.ok(!/class="activity/.test(rendered), "and no bar is rendered inside it");
});

test("the panel column is sized by a custom property, so only one thing writes the width", () => {
  const css = readCss();
  const panes = /\.panes\s*\{([^}]*)\}/.exec(css);
  assert.ok(panes, "the shell grid must have a rule");
  assert.match(panes[1], /grid-template-columns:[^;]*var\(--panel-width/);
});

test("no viewport rule hides the panel", () => {
  // It used to be `display: none` below 1440px, which was defensible while the panel held only
  // reference material. It now hosts the file browser, so an unreachable pane is worse than a narrow
  // one. The overlay that briefly replaced it was worse still — it covered the transcript with no way
  // to dismiss it — so the panel is simply never hidden, and the resizer is how you make room.
  const css = readCss();
  assert.ok(!/\.panel\s*\{[^}]*display:\s*none/.test(css), "the panel must not be hidden outright");
  assert.ok(!/\.inspector\s*\{[^}]*display:\s*none/.test(css), "nor may the inspector be hidden");
  // And the shell grid still reserves a column for it at every width.
  assert.ok(!/@media \(max-width: 1439px\)\s*\{[^}]*\.panes\s*\{[^}]*grid-template-columns:\s*288px 1fr;/.test(css),
    "the panel column must not be dropped at narrow widths");
});

// --- Settings: this installation (issue #58) -----------------------------------------------------

/** Facts shaped like the snapshot's, with values deliberately unlike the real ones. */
function installFacts(overrides = {}) {
  return {
    version: "9.9.9-witness",
    protocol: 4242,
    sessionsRoot: "/sessions-root-witness",
    workspaceRoot: "/workspace-root-witness",
    agentRoot: "/agent-root-witness",
    agentRootManaged: true,
    ...overrides,
  };
}

test("Settings shows the version the SNAPSHOT carried, never one it knows itself", async () => {
  // The provenance assertion. Nothing in the UI bundle can know the orchestrator's version, so the
  // value must come from the event — and the fixture is deliberately unlike any real version, so a
  // hardcoded number in the component cannot pass this.
  const html = renderToString(createElement(Settings, { install: installFacts(), ready: true, onClose() {}, initialSection: "about" }));
  assert.match(html, /9\.9\.9-witness/);
  assert.ok(!/0\.\d+\.\d+/.test(html.replace(/4242/g, "")), `no real-looking version may appear: ${html}`);
});

test("Settings says 'not reported' rather than showing a blank or a zero", async () => {
  // The state an orchestrator older than this field produces, and the state before the first
  // snapshot. A blank where a version belongs reads as a bug in the surface; "not reported" is a
  // fact. This is the case that let the protocol add the field without a version bump.
  const html = renderToString(createElement(Settings, { install: undefined, ready: true, onClose() {}, initialSection: "about" }));
  assert.match(html, /not reported/);
  assert.ok(!/0\.0\.0|unknown version|v0\b/.test(html), `must not invent a version: ${html}`);
});

test("Settings shows where things live, copyable", async () => {
  const html = renderToString(createElement(Settings, { install: installFacts(), ready: true, onClose() {}, initialSection: "about" }));
  for (const path of ["/sessions-root-witness", "/workspace-root-witness", "/agent-root-witness"]) {
    assert.ok(html.includes(path), `the path ${path} must be shown`);
  }
  // Copyable, because the reason to look a path up is to paste it somewhere. Asserted as one copy
  // button PER path rather than "a button exists": the failure worth catching is a path added
  // without one, which a presence check would wave through.
  assert.match(html, /title="Copy sessions"/);
  assert.match(html, /title="Copy workspaces"/);
  assert.match(html, /title="Copy agent root"/);
  assert.equal((html.match(/class="copy"/g) ?? []).length, 3, "every path needs its own copy button");
});

test("an external agent root is distinguished from a managed one", async () => {
  // Not cosmetic: "managed" means Pi Central will create and write it; "external" means it will not,
  // and a user who assumes the wrong one is surprised either way.
  const managed = renderToString(createElement(Settings, { install: installFacts(), ready: true, onClose() {}, initialSection: "about" }));
  assert.match(managed, /managed by Pi Central/);

  const external = renderToString(
    createElement(Settings, { install: installFacts({ agentRootManaged: false }), ready: true, onClose() {}, initialSection: "about" }),
  );
  assert.match(external, /external/);
  assert.ok(!/managed by Pi Central/.test(external), "an external root must not claim to be managed");
});

test("a PROTOCOL MISMATCH is stated, because that was the confusing failure", async () => {
  // The whole point of showing the protocol version: the failure that motivated Increment 6 arrived
  // as `unknown kind 'listFiles'` from a connection that had agreed on `hello`. Both numbers and the
  // word MISMATCH make that class self-diagnosing instead.
  const html = renderToString(
    createElement(Settings, { install: installFacts({ protocol: 4242 }), ready: true, onClose() {}, initialSection: "about" }),
  );
  assert.match(html, /MISMATCH/);
  assert.match(html, /4242/);
});

test("a MATCHING protocol is stated as matching, and does not cry wolf", async () => {
  const { PROTOCOL_VERSION } = await server.ssrLoadModule("/src/../../protocol/src/index.ts");
  const html = renderToString(
    createElement(Settings, { install: installFacts({ protocol: PROTOCOL_VERSION }), ready: true, onClose() {}, initialSection: "about" }),
  );
  assert.ok(!/MISMATCH/.test(html), `a matching protocol must not report a mismatch: ${html}`);
  assert.match(html, /matches this UI/);
});

test("Settings has no UPDATE control, only a statement about it", async () => {
  // The rule: a control that looks functional and is not is worse than its absence. The update toggle
  // belongs here, and must not appear until #55 makes it work.
  //
  // NARROWED twice. It first asserted there was no `<input>` at all in Settings — a *proxy* for the rule,
  // which the Reading sliders are the exact opposite of. Then #142 split the dialog into panes, so the
  // statement (About) and the sliders (Display) are no longer in one render. Both halves are asserted, each
  // where it actually lives.
  const about = renderToString(
    createElement(Settings, { install: installFacts(), ready: true, onClose() {}, initialSection: "about" }),
  );
  assert.ok(!/role="switch"/i.test(about), "no switch may appear in Settings yet");
  assert.ok(
    !/check for updates[^<]*<input/i.test(about) && !/<input[^>]*update/i.test(about),
    `no control may be attached to updating: ${about}`,
  );
  assert.match(about, /does not check for updates/i);
  assert.match(about, /off unless you\s+turn it on|off unless you turn it on/i);

  const display = renderToString(
    createElement(Settings, { install: installFacts(), ready: true, onClose() {}, initialSection: "display" }),
  );
  // The inputs that ARE legitimate are preferences that work, not placeholders.
  assert.match(display, /type="range"/, "the Reading sliders are real controls");
  assert.match(display, /Reading/, "…in a section that names them");
});

test("Settings is a labelled dialog that can be left with the keyboard", async () => {
  // Opened from the topbar and dismissed with Esc; without `aria-modal` and a labelled heading it is
  // a div that happens to look like a dialog.
  const html = renderToString(createElement(Settings, { install: installFacts(), ready: true, onClose() {} }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="settings-title"/);
  assert.match(html, /id="settings-title"/);
  assert.match(html, />Close</);
});

test("an ABSENT fact is not copyable, because a placeholder is not a value", async () => {
  // Found by looking at a screenshot of this surface while every test was green. The first version
  // passed `install?.sessionsRoot ?? "not reported"` and rendered a copy button beside it — so the
  // button put the literal string `not reported` on the clipboard. Offering to copy a placeholder is
  // worse than offering nothing, which is why `Fact` now takes `string | undefined` and derives the
  // placeholder itself: the bug is unrepresentable rather than merely fixed.
  const html = renderToString(createElement(Settings, { install: undefined, ready: true, onClose() {} }));
  assert.ok(!/class="copy"/.test(html), `no copy button may appear without a value: ${html}`);
  assert.ok(!/Copy sessions|Copy workspaces|Copy agent root/.test(html), "no copy label either");
  // And the placeholder must not be dressed as a machine string — it is prose about an absence.
  assert.ok(!/settings-mono/.test(html), "a missing value must not be styled as a path");
});

test("present facts ARE copyable, so the fix did not remove the feature", async () => {
  // The falsifier for the test above: asserting only "no copy button when absent" would pass just as
  // well if copy buttons had been deleted outright.
  const html = renderToString(createElement(Settings, { install: installFacts(), ready: true, onClose() {}, initialSection: "about" }));
  assert.equal((html.match(/class="copy"/g) ?? []).length, 3);
});

test("absent facts are explained ONCE, and the reason is distinguished from 'not yet'", async () => {
  // Two different problems: the orchestrator has not answered yet, versus this orchestrator does not
  // send these facts at all (it is older). Only the second is actionable, and conflating them is how
  // the version skew in issue #8 stayed confusing. The explanation appears once rather than once per
  // row — six repetitions of one fact buries the part that matters.
  const waiting = renderToString(createElement(Settings, { install: undefined, ready: false, onClose() {} }));
  assert.match(waiting, /Waiting for the orchestrator/);
  assert.ok(!/older than this UI/.test(waiting), "must not claim staleness before a snapshot arrived");

  const stale = renderToString(createElement(Settings, { install: undefined, ready: true, onClose() {} }));
  assert.match(stale, /older than this UI/);
  assert.match(stale, /Restart it/);
  assert.equal((stale.match(/older than this UI/g) ?? []).length, 1, "stated once, not per row");

  // With facts present there is nothing to explain.
  const fine = renderToString(createElement(Settings, { install: installFacts(), ready: true, onClose() {} }));
  assert.ok(!/older than this UI|Waiting for the orchestrator/.test(fine));
});

// --- The panel toggle, and a collapsed panel (issue #75) -------------------------------------------

test("the panel toggle is a GLYPH in the context bar, and still states the action in words", () => {
  /*
   * Moved twice. It was `PanelToggle` in the topbar (a word), and reported from use: "the show hide panel
   * toggle shall be an icon, and it needs to be integrated in the context aware bar, not globally."
   *
   * The 48px bar cannot carry the words visibly, so the `title` and `aria-label` carry them — the label states
   * the ACTION ("Show…" / "Hide…"), because a control labelled by its state reads as a status and gets clicked
   * twice. `aria-expanded` carries the current truth.
   *
   * `PanelToggle.tsx` is kept as the module that documented those rules, and its reasoning still holds; what
   * changed is where it is rendered.
   */
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.ok(!/from "\.\/components\/PanelToggle\.tsx"/.test(app), "the topbar no longer renders it");
  const bar = app.slice(app.indexOf('side="right"'));
  assert.match(bar, /aria-expanded=\{!panel\.collapsed\}/, "the toggle states the fact in the context bar");
  assert.match(bar, /aria-label=\{panel\.collapsed \? "Show the session panel" : "Hide the session panel"\}/);
  assert.match(bar, /onClick=\{togglePanelCollapsed\}/);
});

test("a collapsed panel leaves no panel track behind", () => {
  // Without this class the grid keeps a third track, so hiding the panel would leave an empty column
  // — the panel would be gone and its space would not.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = /\.panes\.is-collapsed\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, ".panes.is-collapsed must have a rule");
  assert.match(rule[1], /grid-template-columns:\s*288px 1fr/, "two tracks, not three");
});

test("the narrow-viewport query collapses the rail track for a hidden panel too", () => {
  // The trap: `.panes.is-collapsed` out-specifies a bare `.panes`, so the existing `≤1023px` rule
  // would LOSE to it and leave a 288px empty track where the hidden rail used to be. The query must
  // name both selectors to win.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.panes,\s*\n\s*\.panes\.is-collapsed\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    "the ≤1023px query must list `.panes.is-collapsed` as well as `.panes`, and let the track shrink",
  );
});

test("a collapsed panel renders no panel body at all", () => {
  // Not rendered rather than rendered at zero width: a zero-width panel still mounts the body and
  // runs its container queries against 0px. Proven here on the component that owns the decision —
  // `Panel` renders only when the shell decides to include it.
  const html = renderToString(createElement(Panel, {
    mode: "session", onMode() {}, width: 360, onWidth() {}, viewportWidth: 1440,
  }, createElement("p", null, "body")));
  assert.match(html, /class="panel"/, "the panel renders when it IS included");
  // The shell excludes it entirely when collapsed; `App.tsx` holds that branch, so this asserts the
  // contract the branch relies on: the panel is a plain element with no hidden state of its own.
  /*
   * Asserted against the PANEL element rather than the whole document: the mode glyphs carry
   * `aria-hidden="true"` on purpose (each item has its own `aria-label`), so a bare `/hidden/` test now
   * matches the glyph and would report on the wrong thing. The property is unchanged — the panel has no
   * built-in collapse, so the shell decides by not rendering it.
   */
  const panelTag = /<aside[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(!/hidden|display:\s*none|aria-expanded/.test(panelTag), "the panel has no built-in collapse; the shell decides");
});

// --- Wrapping is a choice, and the default is wrapped (issue #73) ----------------------------------

test("the file viewer wraps long lines by default", async () => {
  // The defect: `white-space: pre` inside a scrolling panel forced prose into a horizontal scrollbar
  // at the bottom of a full-height panel, hundreds of pixels from the line being read — where it
  // reads as the end of the content. Wrapping is now the default, and the toggle is the code case.
  const state = await filesState();
  const html = renderToString(createElement(FilePane, {
    path: "CHANGELOG.md",
    state: { status: "loaded", content: { kind: "text", text: "a very long line that would otherwise scroll sideways\n" }, bytes: 52 },
    wrapped: true, onToggleWrap() {}, onClose() {},
  }));
  assert.match(html, /class="filepane-lines is-wrapped"/, "the wrapped class drives the CSS");
});

test("the wrap toggle's label states the ACTION, and aria-pressed states the fact", async () => {
  // Same rule as the panel and dotfile toggles: a control labelled by its state is read as a status
  // and clicked twice by anyone who takes it for one.
  const state = await filesState();
  const render = (wrapped) => renderToString(createElement(FilePane, {
    path: "a.ts",
    state: { status: "loaded", content: { kind: "text", text: "const x = 1;\n" }, bytes: 13 },
    wrapped, onToggleWrap() {}, onClose() {},
  }));

  const on = render(true);
  assert.match(on, /No wrap/, "wrapped on offers to stop wrapping");
  assert.match(on, /aria-pressed="true"/);

  const off = render(false);
  assert.match(off, /Wrap lines/, "wrapped off offers to wrap");
  assert.match(off, /aria-pressed="false"/);
  assert.ok(!/is-wrapped/.test(off), "no-wrap mode must not carry the wrapping class");
});

test("wrapped mode wraps, keeps indentation, and breaks long tokens", () => {
  // Asserted on the stylesheet because the markup cannot express it. `pre-wrap` not `pre-line`:
  // leading indentation is content in a source file. `anywhere` because the lines that need wrapping
  // most are the ones with no spaces in them.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = /\.filepane-lines\.is-wrapped \.filepane-line-text\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "the wrapped rule must exist");
  assert.match(rule[1], /white-space:\s*pre-wrap/, "pre-wrap preserves indentation while wrapping");
  assert.match(rule[1], /overflow-wrap:\s*anywhere/, "a long unbroken token must still wrap");

  // And the flex item must be allowed to shrink, or `min-width: auto` wins and nothing wraps.
  const text = /\.filepane-line-text\s*\{([^}]*)\}/.exec(css);
  assert.ok(text, ".filepane-line-text must have a rule");
  assert.match(text[1], /min-width:\s*0/, "a flex item will not shrink below its content without this");
  assert.match(text[1], /flex:\s*1/, "…and must claim the remaining width");
});

// --- `Jump to latest` must not cover a line of text (issue #71) -----------------------------------

test("the jump control floats in a band, anchored to the scroller", () => {
  /*
   * Issue #71: the control is positioned against the bottom of its region, so mid-list it sat on whatever line
   * happened to be there — "…the escaped quote in m[ ↓ Jump to latest ]check."
   *
   * Where the reservation and the anchor live has moved three times, and each move was a real defect rather than a
   * tidy-up:
   *
   *   1. `padding-bottom` on `.transcript-wrap` — correct while the composer was a sibling below it, wrong once the
   *      composer moved inside the wrapper, where the reserved row became a permanent gap above the input;
   *   2. anchored to the reading COLUMN — `bottom: 44px` measured from an edge below the composer, so the pill meant
   *      for the conversation appeared over the input (`img_31.png`);
   *   3. this: a `.transcript-viewport` that wraps ONLY the scroller and the pill, reserves the band, and is the
   *      pill's positioned ancestor.
   *
   * The property is what is asserted, not the selector: the pill is absolutely positioned, its offset is measured
   * from the same element that reserves at least that much space at its foot, and therefore nothing can sit under it.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const viewport = /(?:^|\n)\.transcript-viewport\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(viewport, ".transcript-viewport must exist — it is the pill's anchor");
  assert.match(viewport, /position:\s*relative/, "it is the positioned ancestor");
  assert.match(viewport, /padding-bottom:\s*var\(--jump-strip\)/, "…and it reserves the band");

  /*
   * THE OFFSET MUST BE INSIDE THE BAND, not above it.
   *
   * This assertion previously required `var(--jump-strip)` in the offset, on the reasoning that the pill should be
   * measured from the reservation. That reasoning was wrong in the direction that matters: with a 40px reservation and
   * `bottom: calc(var(--jump-strip) + 4px)`, a ~30px control sat 44px up — i.e. 4px ABOVE the top of the band it was
   * meant to occupy — so it floated over the last paragraph and the text visibly wrapped around it (`img_35.png`).
   *
   * The real property is arithmetic, so it is asserted as arithmetic: the offset must be smaller than the band, or the
   * control is not in the band at all.
   */
  const pill = /(?:^|\n)\.jump-latest\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(pill, /position:\s*absolute/, "the control floats");
  assert.match(pill, /z-index:/, "…on its own layer, so it cannot influence the line box beside it");

  const bottom = /bottom:\s*([^;]+);/.exec(pill)?.[1]?.trim() ?? "";
  const offset = Number(/^(\d+)px$/.exec(bottom)?.[1]);
  assert.ok(
    Number.isFinite(offset),
    `the offset must be a plain length INSIDE the reserved band, not measured from its top; got ${bottom}`,
  );

  const strip = Number(/--jump-strip:\s*(\d+)px/.exec(css)?.[1]);
  assert.ok(Number.isFinite(strip), "--jump-strip must be a number, or the reservation is a guess");
  assert.ok(
    offset < strip,
    `the control's ${offset}px offset must sit inside the ${strip}px band, or it is drawn above it — over the text`,
  );

  // And structurally: the pill must be a child of the viewport, not of the column that also holds the composer.
  const source = readFileSync(new URL("../src/components/Transcript.tsx", import.meta.url), "utf8");
  const view = /<div className="transcript-viewport">([\s\S]*?)\{\/\*\s*\n\s*THE COMPOSER LIVES HERE/.exec(source)?.[1] ?? "";
  assert.match(view, /jump-latest/, "the pill is rendered inside the viewport");
  assert.ok(!/transcript-footer/.test(view), "…and the composer is NOT, or the anchor would include it");
});

// --- The Reading panel's reset, and a preview that can show the setting (issue #142) ----------------

test("the Reading panel offers a reset, disabled when there is nothing to undo", async () => {
  // A preference you cannot get back from is a trap: a reader nudges a slider, dislikes it, and has no way
  // to know what "normal" was. Disabled at the defaults, so the control says whether there is anything to
  // undo instead of offering a no-op.
  const html = renderToString(
    createElement(Settings, { install: installFacts(), ready: true, onClose() {}, initialSection: "display" }),
  );
  assert.match(html, /Reset to defaults/, "a reset must exist");
  assert.match(
    html,
    /btn-quiet[^>]*disabled/,
    "…and be disabled at the defaults, where there is nothing to reset",
  );
});

test("the sample's SIZE is set on a selector that actually wins", async () => {
  // The bug: the first version set `font-size` on `.reading-sample` and put the text in a `<p>`. `.modal p`
  // — specificity 0,1,1 — beat `.reading-sample` (0,1,0) whatever the source order, so the preview always
  // rendered at 13px and never showed the reader's choice. A preview that cannot show the thing being set
  // is worse than no preview.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const sample = /\.reading-sample span\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(sample, /font-size:\s*var\(--reading-size\)/, "the size is on the element that wins");
  // And it must NOT be a `<p>`, which is what `.modal p` was reaching.
  const html = renderToString(
    createElement(Settings, { install: installFacts(), ready: true, onClose() {}, initialSection: "display" }),
  );
  const block = /<div class="reading-sample"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  assert.ok(!/<p[ >]/.test(block), `the sample must not be a <p>, which .modal p resizes: ${block}`);
});

test("the sample does not pretend to preview the WIDTH", async () => {
  // A width preview inside a dialog is a lie twice over: the dialog clamps it, so 82ch and 100ch look
  // identical, and it is not the width you get. The reader sees the real width live in the transcript
  // behind the dialog, which is better than any preview inside a 620px box.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const block = /\.reading-sample\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(
    !/max-width:\s*var\(--reading-measure\)/.test(block),
    "the sample must not cap itself to the measure — the dialog clamps it anyway, so it proves nothing",
  );
});

// --- Collapsed thinking blocks are distinguishable (issue #143) -----------------------------------

test("a collapsed thinking block shows a gist, so four blocks are not four identical bars", () => {
  // From a screenshot review of a real transcript: six thinking blocks, all the same width, all reading
  // only "Thinking". The feed's most common element carried no information — the eye could not tell a
  // two-second aside from a long derivation, nor decide which to open.
  const msg = {
    id: "1", role: "assistant", streaming: false,
    blocks: [
      { kind: "thinking", text: "The user says the tests fail. Let me reproduce it first.", complete: true },
      { kind: "thinking", text: "Now the symlink case, which is the suspicious one.", complete: true },
      { kind: "text", text: "Found it." },
    ],
  };
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [msg], tools: [] }, busy: false, sessionLabel: "Demo",
  }));
  // The gists now live inside the activity group (`ActivityGroup`), one row per thinking block, rather than
  // in top-level bars. The property is unchanged: each block names itself, so a run of them is not a stack
  // of identical lines.
  const gists = [...html.matchAll(/class="activity-thought-gist"[^>]*>([^<]*)/g)].map((m) => m[1]);
  assert.equal(gists.length, 2, `each thinking block gets a gist: ${html}`);
  assert.notEqual(gists[0], gists[1], "…and they differ from each other, which is the whole fix");
  assert.match(gists[0], /reproduce it first/);
});

test("a thinking block with no words still renders the label, and no empty gist", () => {
  const msg = {
    id: "1", role: "assistant", streaming: false,
    blocks: [{ kind: "thinking", text: "   ", complete: true }, { kind: "text", text: "Done." }],
  };
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [msg], tools: [] }, busy: false, sessionLabel: "Demo",
  }));
  // An empty FINISHED block is not announced at all any more: it used to render a bar that opened to nothing,
  // which is the noise this rework removes. Only the prose the message actually carries remains.
  assert.ok(!html.includes("activity-thought"), `an empty finished block gets no row: ${html}`);
  assert.ok(!html.includes("activity-thought-gist"), "and no empty gist");
  assert.match(html, /Done\./, "the prose the message does carry still renders");
});

test("a collapsed thinking block does NOT reveal its text on hover", () => {
  // Reported from use: "on mouse hover i dont want to see the complete thinking block. I only want to see
  // it when i explicitly open the thinking block. Otherwise on mouse over actions huge tool tips occur."
  //
  // A first version put the untruncated text on `title` so a word lost to the 72-character cap could be
  // recovered by hovering. That handed the reader a screen-filling native tooltip on a stray mouse-over —
  // no click, no focus, no way to keep it open or dismiss it. Collapsing exists so a long derivation costs
  // ONE LINE until it is asked for; opening the `<details>` is the only gesture that means "show me this".
  const long = `A very long thought. ${"more detail ".repeat(40)}`;
  const msg = {
    id: "1", role: "assistant", streaming: false,
    blocks: [{ kind: "thinking", text: long, complete: true }, { kind: "text", text: "Done." }],
  };
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [msg], tools: [] }, busy: false, sessionLabel: "Demo",
  }));

  const gistTag = /<span class="activity-thought-gist"[^>]*>/.exec(html)?.[0];
  assert.ok(gistTag !== undefined, `the gist must exist: ${html}`);
  assert.ok(!/title=/.test(gistTag), `the gist must carry no tooltip: ${gistTag}`);

  // The summary must be BOUNDED, not merely tooltip-free: the whole point is that a long derivation costs
  // one line. Asserting "does not contain the full text" was the first attempt and it was wrong twice — the
  // thought is 500 characters so any preview "fails" to contain it trivially, and the repeated padding words
  // made the phrase check pass on the gist itself. Bounding the summary is the property that actually holds.
  const summary = /<summary class="activity-thought-head"[^>]*>([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? "";
  assert.ok(summary.length > 0, "the summary must exist");
  /*
   * The bound, restated after the row gained structure. The property is that the row cannot carry the thought;
   * the old `< 200` was a proxy for "one line" at 72 characters of gist. The row now also carries its index and
   * its kind (`1`, `Thinking`), so the bound is: the GIST is elided (asserted below) and the row's own text —
   * excluding those two fixed labels — stays far short of the 500-character thought.
   */
  const gist = /<span class="activity-thought-gist">([\s\S]*?)<\/span>/.exec(summary)?.[1] ?? "";
  assert.ok(gist.length > 0, "the row carries a gist");
  assert.ok(gist.length < 120, `the gist must be elided, got ${gist.length} chars: ${gist}`);
  // The rendered row is markup, not text: tags and attributes are not characters the reader sees. Measured on the
  // VISIBLE text, which is the thing "one line" is a claim about.
  const visible = summary.replace(/<[^>]*>/g, "").trim();
  assert.ok(
    visible.length < 140,
    `a collapsed row must stay one line, not carry the thought ("${visible}" = ${visible.length} chars)`,
  );
  assert.match(summary, /\u2026/, "the gist is elided, so no title is needed to shorten it");
  assert.ok(!/title=/.test(summary), `nothing in the summary may pop a tooltip: ${summary}`);

  // The full text is still there, inside `<details>`, so opening the block is what reveals it.
  assert.ok(html.includes(long.slice(0, 80)), "the body still carries the whole thought");
});

// --- A thinking block says when it is STILL thinking (issue #146) ---------------------------------

test("an in-progress thinking block says so, and a finished one does not", () => {
  // Reported from use: "I definitely dont see any response in the thinking bar, there is no visual indication
  // that the thinking is still running. Users just see the bar and thats it."
  //
  // `TextBlock.complete` was already on the wire — set false by `thinking_start`, true by `thinking_end` — it
  // was simply never rendered, so a block being written looked identical to one that had finished.
  const msg = {
    id: "1", role: "assistant", streaming: true,
    blocks: [
      { kind: "thinking", text: "Still working this out", complete: false },
      { kind: "thinking", text: "This one is finished.", complete: true },
      { kind: "text", text: "…" },
    ],
  };
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [msg], tools: [] }, busy: true, sessionLabel: "Demo",
  }));

  const summaries = [...html.matchAll(/<summary class="activity-thought-head">([\s\S]*?)<\/summary>/g)].map((m) => m[1]);
  assert.equal(summaries.length, 2, "both blocks render");
  assert.match(summaries[0], /thinking\u2026/, "the in-progress block says so");
  assert.ok(!/thinking\u2026/.test(summaries[1]), "the finished block must NOT — or the state means nothing");
});

test("the thinking state is a WORD, and does not repeat the message's own dot", () => {
  // Two rejected versions, both recorded because each looked right in isolation.
  //
  // 1. A bare spinner would have been motion as the only carrier of meaning, which DESIGN §539 forbids.
  // 2. A green `live-dot` beside the word was rendered and reported from use: "i think now it is redundant".
  //    A thinking block only ever streams INSIDE an assistant message, whose `.role` line already shows
  //    `● responding…` for the whole message; a tool call does not close the message, so `responding…` is on
  //    screen the entire time a block is growing. The second dot repeated the first, one line lower.
  //
  // So: the word alone, and no dot anywhere in the summary.
  const msg = {
    id: "1", role: "assistant", streaming: true,
    blocks: [{ kind: "thinking", text: "Working", complete: false }, { kind: "text", text: "…" }],
  };
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [msg], tools: [] }, busy: true, sessionLabel: "Demo",
  }));
  const summary = /<summary class="activity-thought-head">([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? "";
  assert.match(summary, /thinking\u2026/, `the word must be present: ${summary}`);
  assert.ok(!/live-dot/.test(summary), `no dot may repeat the message's own indicator: ${summary}`);

  // And the message-level indicator is still there, which is what makes the block's dot redundant.
  assert.match(html, /responding\u2026/, "the message still says it is responding");
});

test("a thinking block with no text yet still shows it is running", () => {
  // The first moment of a block is `thinking_start`: the text is empty. If the state were tied to the gist
  // being non-empty, the bar would be silent for exactly the period the reader is waiting through.
  const msg = {
    id: "1", role: "assistant", streaming: true,
    blocks: [{ kind: "thinking", text: "", complete: false }, { kind: "text", text: "…" }],
  };
  const html = renderToString(createElement(TranscriptView, {
    transcript: { messages: [msg], tools: [] }, busy: true, sessionLabel: "Demo",
  }));
  assert.match(html, /thinking\u2026/, "an empty in-progress block still announces itself");
  assert.ok(!html.includes("activity-thought-gist"), "…but has no gist, which would be empty");
});

// --- A row that is not running is still in the rail (issue #89) ----------------------------------

test("a roster row with no live session appears under Stopped, and claims no metrics", () => {
  // The whole point of #89: the roster is the list, activity is a column. A session you are not running is still
  // yours — it sits under the existing `Stopped` heading, and prompting it resumes it later.
  const html = renderToString(createElement(SessionRail, {
    rows: [{ entry: { path: "/s/a/01a171ff.jsonl", name: "yesterday's task", cwd: "/Users/x/git/proj" } }],
    focusedId: undefined, onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {},
    home: "/Users/x", historyTotal: 0,
  }));

  assert.match(html, /Stopped/, "it lands in the section that already exists");
  assert.match(html, /yesterday&#x27;s task|yesterday's task/, "by its remembered name");
  assert.match(html, />stopped</, "the activity is stated in words, in the chip");
  // No fabricated metrics: a row with no process has no model, context or cost, and printing 0% / $0.00 would
  // state facts nobody measured — the same rule as `contextPercent` returning null rather than a zero.
  assert.ok(!/ctx 0%/.test(html), `no fabricated context: ${html}`);
  assert.ok(!/\$0\.0000/.test(html), `no fabricated cost: ${html}`);
});

// --- The rail's context bar (issue #13) --------------------------------------------------------
//
// The reader's own suggestion, after the fleet SUMMARY was rejected as "just more verbose text": put the gauge the
// header already draws into each row, because a bar is magnitude and can be compared at a glance where a number has
// to be read ten times. These assertions are about the two things that make it trustworthy: it agrees with the label
// beside it, and it never draws a bar for a context nobody measured.

/** The rail with one session at `percent`, for reading the bar and its label together. */
function railWithContext(percent) {
  return renderToString(createElement(SessionRail, {
    rows: rowsOf([session({ contextPercent: percent, name: "the row" })]),
    focusedId: undefined, onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true,
    onStartSession() {}, onOpenDirectory() {}, home: "/Users/x", historyTotal: 0,
  }));
}

test("a row draws a meter whose value matches the percentage printed beside it", () => {
  // The bar and the label are two renderings of one fact. If they could disagree, the bar would be worse than no
  // bar: a reader who scans fills would be told something the number contradicts.
  for (const percent of [12, 41, 79, 80, 96]) {
    const html = railWithContext(percent);
    const meter = /role="meter"[^>]*aria-valuenow="(\d+)"/.exec(html)
      // Attributes are emitted in source order, so accept either order rather than pinning it.
      ?? /aria-valuenow="(\d+)"[^>]*role="meter"/.exec(html);
    assert.ok(meter, `a measured context must render a meter: ${percent}%`);
    assert.equal(Number(meter[1]), percent, "the bar's value is the reported percentage");
    assert.match(html, new RegExp(`ctx ${percent}%`), "the label states the same number");
  }
});

test("the bar turns amber at exactly the point the label says `full`", () => {
  // Both come from CONTEXT_PRESSURE_PERCENT. Colour is never the only carrier (DESIGN §9): past the threshold the
  // words change too, and this asserts they change on the same row the fill does.
  const under = railWithContext(79);
  assert.ok(!/context-bar is-full/.test(under), "below the threshold the fill is not amber");
  assert.ok(!/ctx 79% full/.test(under), "and the word is absent");

  const at = railWithContext(80);
  assert.ok(/context-bar is-full/.test(at), "at the threshold the fill is amber");
  assert.match(at, /ctx 80% full/, "and the word appears — the amber is reinforcement, not the message");
});

test("an UNMEASURED context draws no bar at all", () => {
  // An empty track in a row reads as "0% used" for a session nobody has measured — the fabricated zero that
  // `formatContext` already refuses. The row says `ctx —` and shows no gauge.
  const html = railWithContext(null);
  assert.ok(!/role="meter"/.test(html), `no meter for an unknown context: ${html}`);
  assert.match(html, /ctx —/, "and it still says so rather than rendering nothing");
  assert.ok(!/context-bar/.test(html), "not even an empty track");
});

test("each row's meter is named for its session, so ten of them are distinguishable", () => {
  // The header's single meter is labelled "Context usage". Ten of those in a list are indistinguishable to a
  // screen-reader user moving through the rail, so the rail passes the session's own name.
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([
      session({ id: "a", name: "alpha", contextPercent: 30 }),
      session({ id: "b", name: "beta", contextPercent: 70 }),
    ]),
    focusedId: undefined, onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true,
    onStartSession() {}, onOpenDirectory() {}, home: "/Users/x", historyTotal: 0,
  }));
  assert.match(html, /aria-label="Context usage for alpha"/);
  assert.match(html, /aria-label="Context usage for beta"/);
});

test("a roster row with no live session still carries its directory on hover", () => {
  const html = renderToString(createElement(SessionRail, {
    rows: [{ entry: { path: "/s/a/x.jsonl", cwd: "/Users/x/git/proj" } }],
    focusedId: undefined, onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {},
    home: "/Users/x", historyTotal: 0,
  }));
  assert.match(html, /~\/git\/proj/, "the directory is shown, home abbreviated");
});

test("an empty roster says so, and does not claim sessions are missing", () => {
  const html = renderToString(createElement(SessionRail, {
    rows: [], focusedId: undefined, onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {},
    home: undefined, historyTotal: 0,
  }));
  assert.match(html, /No sessions yet/);
});

// --- The roster survives a restart, and a stopped row can be resumed by typing (#89) --------------

test("a persisted roster renders its sessions as Stopped rows after a restart", () => {
  // The reported failure, verbatim: "sessions are gone completly after restart". Nothing is running after a
  // restart (C3: there is no daemon), so every row is `stopped` — and every row is still THERE, which is the
  // whole point of the issue.
  const html = renderToString(createElement(SessionRail, {
    rows: [
      { entry: { path: "/s/a/one.jsonl", name: "first task", cwd: "/Users/x/git/a" }, session: undefined },
      { entry: { path: "/s/b/two.jsonl", name: "second task", cwd: "/Users/x/git/b" }, session: undefined },
    ],
    focusedId: undefined, onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {},
    home: "/Users/x", historyTotal: 0,
  }));
  assert.match(html, /first task/, "the roster is not empty after a restart");
  assert.match(html, /second task/);
  assert.match(html, /Stopped/, "and says plainly that nothing is running");
  assert.ok(!/No sessions yet/.test(html), "it must not claim there are no sessions");
});

test("a stopped row can be focused, because focusing is how resume-on-send starts it", async () => {
  // A row you cannot click is a row you cannot use. Focus no longer requires a live session (issue #89).
  const { reduce, initialState: blank } = await server.ssrLoadModule("/src/store.ts");
  let state = blank();
  state = reduce(state, { kind: "loadRoster", entries: [{ path: "/s/a/one.jsonl" }] });
  state = reduce(state, { kind: "focusRow", key: "/s/a/one.jsonl" });
  assert.equal(state.focusedId, "/s/a/one.jsonl", "a remembered path is a valid focus key");
});

test("focusing something that is neither live nor in the roster is ignored", async () => {
  const { reduce, initialState: blank } = await server.ssrLoadModule("/src/store.ts");
  let state = blank();
  state = reduce(state, { kind: "loadRoster", entries: [{ path: "/s/a/one.jsonl" }] });
  state = reduce(state, { kind: "focusRow", key: "/s/nope.jsonl" });
  assert.equal(state.focusedId, undefined, "an unknown key must not blank the main column");
});

test("forgetting a stopped row removes it, and the removal survives serialization", async () => {
  // The reachable case: Forget is offered only on a row that is not running (a running one must not be
  // dismissable — see the rail test below). A session that starts running IS re-added by App's effect, because a
  // live session belongs in the roster; a stopped one that was removed is not (issue #204).
  const { reduce, initialState: blank } = await server.ssrLoadModule("/src/store.ts");
  const { serializeRoster, parseRoster } = await server.ssrLoadModule("/src/roster.ts");

  let state = blank();
  state = reduce(state, { kind: "remember", entry: { path: "/s/a/one.jsonl" } });
  state = reduce(state, { kind: "remember", entry: { path: "/s/b/two.jsonl" } });
  state = reduce(state, { kind: "forget", path: "/s/a/one.jsonl" });

  assert.deepEqual(state.roster.map((e) => e.path), ["/s/b/two.jsonl"]);
  // Serialized WITH the removal list, which is what the app's single writer does — the whole point of #204 is that
  // dropping the entry is not enough for the reload to know.
  const restored = parseRoster(serializeRoster(state.roster, state.forgotten));
  assert.deepEqual(restored.entries.map((e) => e.path), ["/s/b/two.jsonl"]);
  assert.deepEqual(restored.forgotten, ["/s/a/one.jsonl"], "and a reload reads it back forgotten");
});

test("Forget is offered for a session that is not running, in the companion panel", async () => {
  // A running session must not be dismissable: hiding a live process from the rail while it keeps working and
  // spending would make the roster lie about what is happening.
  //
  // The control lives in the session panel now (asked for from use), so this asserts the panel's list rather than the
  // row's markup — the ROW no longer carries actions at all.
  const { sessionControlsFor } = await server.ssrLoadModule("/src/components/Inspector.tsx");
  const caps = { onForget() {}, retryAvailable: true };

  const stopped = sessionControlsFor(session({ state: "stopped" }), caps).map((c) => c.label);
  assert.ok(stopped.includes("Forget"), `a stopped session can be dismissed, got ${JSON.stringify(stopped)}`);

  const running = sessionControlsFor(session({ state: "streaming" }), caps).map((c) => c.label);
  // The RULE: nothing destructive on a live session. (Which other controls appear depends on the callbacks the shell
  // can offer, so the absence of Forget is the assertion, not the exact list.)
  assert.ok(!running.includes("Forget"), `a running session must not be dismissable, got ${JSON.stringify(running)}`);
  assert.ok(!running.includes("Delete transcript"), "and its transcript cannot be deleted while it is open");
});

test("a scratch session that is not running shows 'Scratch session', not its handle", () => {
  // Reported after a restart: "they carry the handle name". The remembered row must use the same labelling rule
  // as a live one, or the two paths disagree and the row loses the only human-readable word it had.
  const html = renderToString(createElement(SessionRail, {
    rows: [{ entry: { path: "/s/a/s2.jsonl", name: "s2", scratch: true, cwd: "/w/s2" }, session: undefined }],
    focusedId: undefined, onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {},
    home: undefined, historyTotal: 0,
  }));
  assert.match(html, /Scratch session/, `the generic label, not the handle: ${html}`);
  assert.ok(!/>s2</.test(html), `the bare handle must not be the row's name: ${html}`);
});

test("a remembered row with a placeholder name shows a label, never the word", () => {
  const html = renderToString(createElement(SessionRail, {
    rows: [
      { entry: { path: "/s/a/x.jsonl", name: "undefined", scratch: true }, session: undefined },
      { entry: { path: "/s/a/y.jsonl", name: "Undefined" }, session: undefined },
    ],
    focusedId: undefined, onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {}, onOpenDirectory() {},
    home: undefined, historyTotal: 0,
  }));
  assert.ok(!/undefined/i.test(html.replace(/live:undefined|data-[a-z-]+="[^"]*"/g, "")), `no placeholder word: ${html}`);
  assert.match(html, /Scratch session/);
  assert.match(html, /y</, "a non-scratch unnamed row falls back to its file name");
});

test("Settings says how to verify the install, and why it cannot do it itself", () => {
  // The app must not offer a self-check it cannot perform: a malicious build omits it, and shelling out to
  // npm would add outbound calls this app does not make. Stating the command and its limit is the honest
  // version — and it puts the instruction where a user already looks, not only in a README.
  const html = renderToString(createElement(Settings, {
    install: installFacts(), ready: true, onClose() {}, initialSection: "about",
  }));
  assert.match(html, /npm audit signatures/, "the command must be named");
  assert.match(html, /cannot check its own provenance/, "the limit must be stated");
  assert.ok(!/<button[^>]*>[^<]*audit signatures/i.test(html), "and it must not pretend to run it");
});

// --- Retrying a failed session (#11) --------------------------------------------------------------

test("a FAILED session offers Retry, and no other state does", async () => {
  // DESIGN.md promised this and it did not exist: the composer says "Retry it from the rail", and the rail had
  // no control. Retry is explicit — nothing restarts on its own, because a silent restart hides a crash loop.
  //
  // The control moved to the companion panel with the rest; the RULE is what this pins.
  const { sessionControlsFor } = await server.ssrLoadModule("/src/components/Inspector.tsx");
  const caps = { onRetry() {}, retryAvailable: true };
  const failed = sessionControlsFor(session({ state: "failed" }), caps).map((c) => c.label);
  assert.ok(failed.includes("Retry"), `a failed session can be retried, got ${JSON.stringify(failed)}`);

  for (const state of ["idle", "streaming", "starting", "awaiting-approval", "stopped"]) {
    const labels = sessionControlsFor(session({ state }), caps).map((c) => c.label);
    assert.ok(!labels.includes("Retry"), `${state} must not offer Retry, got ${JSON.stringify(labels)}`);
  }
});

test("the PREVIOUS failure stays visible after a retry", () => {
  // A retry clears `error` so the composer becomes usable again. Erasing the evidence would leave a reader
  // unable to compare attempts — which is the second thing they need when a spawn keeps failing.
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([session({ id: "s1", state: "starting", previousError: "EPERM: sandboxed environment" })]),
    focusedId: undefined, onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true, onStartSession() {},
    onOpenDirectory() {}, home: undefined, historyTotal: 0,
  }));
  assert.match(html, /last failure/, "the earlier attempt is named as such, not shown as the current state");
  assert.match(html, /EPERM: sandboxed environment/, "and its text is present");
  assert.ok(!/rail-row-retry/.test(html), "a retrying session is not itself retryable");
});

test("Retry is NOT offered when the orchestrator speaks an older protocol", async () => {
  // Observed from a window: a red banner reading `bad control: unknown kind 'retry'`. The UI offered an action
  // the connected orchestrator could not perform — reachable without any mistake in a checkout, because the UI
  // is served as FILES (a `ui:build` reaches a running orchestrator at once) while the orchestrator's own module
  // stays in memory from when it started.
  const { sessionControlsFor } = await server.ssrLoadModule("/src/components/Inspector.tsx");
  const controls = sessionControlsFor(session({ state: "failed" }), { onRetry() {}, retryAvailable: false });

  // No Retry CONTROL may be offered, and the reason is stated where the reader looks for it — a DISABLED item, never a
  // button that fails when pressed.
  assert.ok(!controls.some((c) => c.label === "Retry" && c.disabled !== true), "no button that cannot work");
  const unavailable = controls.find((c) => c.key === "retry-unavailable");
  assert.ok(unavailable, "a disabled item states that Retry is missing");
  assert.equal(unavailable.disabled, true);
  assert.match(unavailable.title, /restart the orchestrator/i, "saying what to do instead");
});
test("the error strip shows the reason, not a screenful of stderr", () => {
  // Reported from a window: the first line was the reason, the next eight were pi's startup chatter — LiteLLM
  // model notices and an nvim-tmux hint. `role="alert"` read all nine lines aloud.
  const html = renderToString(createElement(ErrorStrip, {
    message:
      "pi exited (code=137, signal=-) — killed by SIGKILL\n[LiteLLM] skipped a model\n[nvim-tmux] not in tmux",
    onDismiss() {},
  }));
  assert.match(html, /killed by SIGKILL/, "the reason is shown");
  assert.ok(!/LiteLLM|nvim-tmux/.test(html), `startup chatter must not reach the strip: ${html}`);
  // React separates adjacent text expressions with `<!-- -->`, so the rendered markup is `+<!-- -->2…`.
  // Stripping the markers is the difference between asserting the sentence and asserting React's output shape.
  const text = html.replace(/<!-- -->/g, "");
  assert.match(text, /\+2 more lines/, "and it says how much it is not showing");
});

test("a single-line error gets no 'more lines' note", () => {
  const html = renderToString(createElement(ErrorStrip, { message: "no such session: s1", onDismiss() {} }));
  assert.match(html, /no such session/);
  assert.ok(!/more line/.test(html), `nothing was withheld, so nothing may be claimed: ${html}`);
});

test("no control puts the session's stderr in a hover tooltip", async () => {
  // Reported: "when users hover over retry, they also see the error. That does not make sense." Same mistake as the
  // thinking block's `title` (issue #143): a native tooltip holding a wall of multi-line stderr, appearing on a stray
  // hover with no way to keep it open or dismiss it. A control's tooltip says what the control DOES.
  //
  // The controls are the panel's now, so the invariant is asserted on the LIST rather than on rail markup: every title
  // is a static sentence, and none of them can carry the stored error.
  const { sessionControlsFor } = await server.ssrLoadModule("/src/components/Inspector.tsx");
  const error = "pi exited (code=137)\n[LiteLLM] noise\n[nvim-tmux] noise";
  const controls = sessionControlsFor(
    session({ state: "failed", error, previousError: error }),
    { onRetry() {}, retryAvailable: true, onForget() {}, onDelete() {} },
  );
  assert.ok(controls.length > 0, "there are controls to check");
  for (const control of controls) {
    assert.ok(!/LiteLLM|nvim-tmux|code=137/.test(control.title), `static tooltip expected, got ${JSON.stringify(control.title)}`);
  }

  // The rail still shows the earlier failure as ONE line, without the stored wall — that part did not move.
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([session({ id: "s1", state: "failed", error, previousError: error })]),
    focusedId: undefined, onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true,
    onStartSession() {}, onOpenDirectory() {}, home: undefined, historyTotal: 0,
  }));
  assert.ok(!/nvim-tmux|LiteLLM/.test(html), `no stderr text on the row at all: ${html}`);
  // React separates the label from the value with `<!-- -->`; asserting the sentence means normalising first.
  assert.match(html.replace(/<!-- -->/g, ""), /last failure: pi exited \(code=137\)/, "and its first line is still shown");
});
test("Provider and Model share ONE label column, and Thinking is on the model's row", async () => {
  // From a screenshot: the provider sat above and to the right of the model, `Thinking` was on the PROVIDER's
  // line, and `Model` hung below on its own — three left edges in a 120px block. Each picker was a sibling with
  // its own label, and a `<label>` and a value of different widths cannot be aligned by eye, so alignment has to
  // belong to the container.
  //
  // Asserted with a DOM rather than a regex: the contract is PLACEMENT, and React decides attribute order. A
  // first version matched `data-picker-row="provider" data-picker-label=""` as adjacent and failed on markup that
  // was exactly right, because `class` is rendered first.
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: "gpt-5", provider: "litellm" }),
    models: undefined, error: undefined, onRequest() {}, onSelect() {},
    thinking: createElement("span", { className: "thinking-probe" }, "high"),
  }));
  const doc = new JSDOM(`<body>${html}</body>`).window.document;

  for (const row of ["provider", "model"]) {
    assert.ok(
      doc.querySelector(`[data-picker-row="${row}"][data-picker-label]`),
      `the ${row} label is placed by the grid`,
    );
  }
  // Both labels are in a label column and both values in the control column, whatever their content.
  assert.equal(doc.querySelectorAll("[data-picker-label]").length, 2, "exactly one label per row");

  // Thinking lives INSIDE the model's control cell, so it shares that row.
  const modelCell = doc.querySelector('.picker-controls[data-picker-row="model"]');
  assert.ok(modelCell, "the model row is a control cell");
  assert.ok(modelCell.querySelector(".thinking-probe"), "Thinking shares the model's row");
  assert.ok(modelCell.querySelector(".picker-field"), "…alongside the model field itself");
});

// --- The rail is for SELECTION; renaming belongs to the session you are looking at -----------------

test("nothing on the rail is a rename target", () => {
  // Reported from use: "users can now also rename a session from the left session roster. The mouse changes on
  // mouse over of the small card session title, which i find weird. Maybe just use the roster for selection of a
  // session, and leave the renaming to the active session rail."
  //
  // The rail's job is navigation. An edit target inside a 12px row competes with the row's own click, and the
  // cursor promised something the row cannot offer without that competition — so the header owns renaming.
  const html = renderToString(createElement(SessionRail, {
    rows: rowsOf([session({ id: "s1", state: "idle" })]),
    focusedId: "s1", onFocusRow() {}, onForgetRow() {}, onRetryRow() {}, retryAvailable: true,
    onStartSession() {}, onOpenDirectory() {}, home: undefined, historyTotal: 0,
  }));
  assert.ok(!/Double-click to rename/.test(html), `no rename affordance on a row: ${html}`);
  assert.ok(!/rail-row-rename/.test(html), "and no hidden rename field either");
  // It still shows the name, and is still selectable.
  assert.match(html, /class="name"/, "the name is still there");
  assert.match(html, /class="rail-row-main"/, "and the row is still a button");
});

test("the text cursor belongs to the header's name only", () => {
  // The cursor was the visible symptom. Asserted on the rule, because that is where the promise is made — and
  // asserted as ONE rule, since a second block for the same selector would be decided by source order.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/(?:^|\n)\.session-name\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(rules.length, 1, "one rule for .session-name, or source order decides");
  assert.match(rules[0], /cursor:\s*text/, "the header's name is a rename target");
  assert.ok(!/\.rail-row-main \.name[^{]*\{[^}]*cursor:\s*text/.test(css), "the rail's name is not");
});

// --- The narrow fallback is a working layout, not a hidden one --------------------------------

test("the rail is reachable below the drawer breakpoint", () => {
  /*
   * The reported defect (`img_33.png`): at a narrow width the transcript was pushed off-screen, the rail was clipped
   * at both edges, and there was no way to reach the session list at all — the stylesheet hid `.rail` and styled
   * `.rail.open` for a class nothing ever set.
   *
   * Two faults, and both are guarded:
   *
   *   1. the grid's middle track was `1fr` = `minmax(auto, 1fr)`, whose minimum is the content's MIN-CONTENT width, so
   *      a long command made the column wider than the window and no narrower rule could ever apply;
   *   2. the hidden rail needed a control, and a rule that actually works.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  assert.match(
    css,
    /grid-template-columns:\s*288px minmax\(0,\s*1fr\)/,
    "the workspace track must be allowed to shrink below its content's min-content width",
  );

  // A drawer that is never opened is `display: none` with extra steps.
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  /*
   * The opener moved from a `rail-toggle` button in the topbar to the Sessions item in the left activity
   * bar. It is still a BUTTON with `aria-expanded` and `aria-controls` — the property the original test
   * was written for — so the assertions follow the responsibility rather than the class name. Asserting
   * `rail-toggle` here would have kept the test green while nothing opened the drawer.
   */
  assert.match(app, /id: "activity-left-sessions"/, "the left bar has a Sessions item");
  assert.match(app, /expanded: railIsDrawer \? railOpen : undefined/, "…which states whether the drawer is open");
  assert.match(app, /controls: railIsDrawer \? "session-rail" : undefined/, "…and what it controls");
  assert.match(app, /setRailOpen\(\(open\) => !open\)/, "…and toggles it");
  assert.match(app, /rail-backdrop/, "a backdrop must close it");
  assert.match(app, /setRailOpen\(false\)/, "Escape, the backdrop and a selection all close it");

  // The two numbers that have to agree: the media query and the JavaScript breakpoint.
  const jsBreakpoint = Number(/RAIL_DRAWER_MAX_WIDTH = (\d+)/.exec(app)?.[1]);
  const cssBreakpoint = Number(/@media \(max-width: (\d+)px\)/.exec(css)?.[1]);
  assert.ok(Number.isFinite(jsBreakpoint), "App.tsx must declare the breakpoint");
  assert.equal(
    jsBreakpoint,
    cssBreakpoint + 1,
    `the button and the layout must flip at the same width: JS ${jsBreakpoint}, CSS ≤${cssBreakpoint}`,
  );
});

test("the narrow companion keeps what orients the reader and drops the labels", () => {
  /*
   * "More minimalistic, because not everything can fit."
   *
   * Stacked above the prose there is one line's worth of room and four things competing for it. The first version let
   * everything wrap, producing a header four rows tall that ate half a small viewport.
   *
   * The rule is a priority order, not a list of things to hide: identity and the two decision-changing numbers stay,
   * the pickers stay WITHOUT their labels because the controls are self-describing, and what is dropped is reachable
   * in the Session panel.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const narrow = /@container transcript \(max-width: 1080px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.match(narrow, /\.picker-label\s*\{\s*display:\s*none/, "the picker labels are the first thing to go");
  assert.match(narrow, /\.picker-grid\s*\{[^}]*flex-direction:\s*row/, "the pickers stay, on one line");
  assert.match(narrow, /\.picker-select\s*\{[^}]*max-width:\s*\d+ch/, "…and are capped so two fit beside the name");
  assert.ok(!/\.header-stats\s*\{\s*display:\s*none/.test(narrow), "the meter and cost are NOT dropped");
});

test("the query container is a DIFFERENT element from the one its queries style", () => {
  /*
   * The defect that made the narrow fallback a no-op, found by reading the DOM rather than the stylesheet: CSS
   * Containment says a container is NOT matched by its own `@container` rules.
   *
   * `.transcript-wrap` declared `container-type: inline-size`, so every `@container transcript` rule naming
   * `.transcript-wrap.has-header` was silently ignored — no error, no warning, the rule simply did not apply. The wide
   * row therefore never flipped to a column, and on a narrow window it overflowed with the transcript off-screen.
   *
   * The guard is structural, because the bug is structural: the element that declares the container must not be an
   * element the query targets. A class rename would slip past a name check; "these are two different elements" is the
   * property that actually holds.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const shell = /(?:^|\n)\.transcript-shell\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(shell, /container-type:\s*inline-size/, "the shell declares the container");

  const wrap = /(?:^|\n)\.transcript-wrap\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(
    !/container-type/.test(wrap),
    "the styled box must NOT declare the container, or its own @container rules are ignored",
  );

  // Every rule inside the query must target something other than the container element.
  const narrow = /@container transcript \(max-width: 1080px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.ok(narrow.length > 0, "the narrow form must exist");
  assert.ok(
    !/\.transcript-shell/.test(narrow),
    "no rule may style the container itself from its own query",
  );
  assert.match(narrow, /\.transcript-wrap\.has-header/, "…and the box the query styles is the wrap");

  // And the markup must actually nest them that way.
  const source = readFileSync(new URL("../src/components/Transcript.tsx", import.meta.url), "utf8");
  const shellAt = source.indexOf('className="transcript-shell"');
  const wrapAt = source.indexOf('className={`transcript-wrap');
  assert.ok(shellAt !== -1 && wrapAt !== -1, "both wrappers must exist in the markup");
  assert.ok(shellAt < wrapAt, "the shell must be the OUTER element");
});

test("the run track clears the companion's first line", () => {
  /*
   * `.run-track` is absolutely positioned at `top: 0` of the session header. When the companion's header had `padding:
   * 0` that put a 2px rule through the title's own line box — a grey bar cutting the tops of the `scratch` and `idle`
   * pills (`img_36.png`).
   *
   * The bar is WANTED: it reports a run in progress, and at rest it gives the companion a top edge so the block does not
   * float unattached in the transcript's canvas. So the rule is arithmetic rather than removal — the header's top
   * padding must exceed the bar's height, in both the wide and the stacked form.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const track = /(?:^|\n)\.run-track\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(track, /position:\s*absolute/, "the track floats at the header's top edge");
  assert.match(track, /top:\s*0/, "…exactly at the top");
  const height = Number(/height:\s*(\d+)px/.exec(track)?.[1]);
  assert.ok(Number.isFinite(height), "the track must declare its height, or the clearance cannot be checked");
  // Full width: an inset rule above a flush title reads as a stray line, not as the block's edge.
  assert.match(track, /left:\s*0/, "the track spans the block's full width");
  assert.match(track, /right:\s*0/);

  const wide = /\.transcript-header \.session-header\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const wideTop = /padding-top:\s*var\(--sp-(\d+)\)/.exec(wide)?.[1];
  assert.ok(wideTop !== undefined, `the companion needs top padding for the track; got ${wide}`);
  // The spacing scale: --sp-1 4, --sp-2 8, --sp-3 12. Any of the usable steps clears a 2px rule.
  assert.ok(Number(wideTop) >= 2, "the padding must clear the bar");

  // And the stacked form, which has its own padding and a visible fill.
  const stacked = /@container transcript[^{]*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.match(
    stacked,
    /padding:\s*calc\(var\(--sp-3\) \+ 2px\)/,
    "the stacked header clears the track too, and adds the track's own height",
  );
});

// ---------------------------------------------------------------------------------------------------
// The activity bars (the topbar rethink).
// ---------------------------------------------------------------------------------------------------

test("the fleet counters are separated in the TEXT, not only by CSS", () => {
  /*
   * The defect this pins, measured in a real window: `9 sessions3 scratch`. The CSS carried a note claiming
   * the separator was "a real character between counters (rendered by the component)" — the component never
   * rendered one, and `gap: 0` removed the only visual spacing, so both the screen and the accessible name
   * ran the numbers together.
   *
   * A `·` in the DOM is the fix rather than a `::before`: a pseudo-element is not in `textContent`, so it
   * would look right and read wrong.
   */
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const fleet = /<div className="fleet">([\s\S]*?)<\/div>/.exec(app)?.[1] ?? "";
  assert.ok(fleet.length > 0, "the fleet block must exist");
  for (const label of ["running", "scratch", "need you"]) {
    assert.match(fleet, new RegExp(`· \\{[^}]*\\} ${label}`), `"${label}" must carry its own separator`);
  }
  // The first counter has no separator by design: a leading middot reads as a stray bullet.
  assert.ok(!/fleet\.total[^<]*<span>· /.test(fleet), "the first counter must not be prefixed");
});

test("the word mark is a mark: the product name is not drawn in the topbar", () => {
  /*
   * "Can we remove the word text mark" — and the constraint that makes it safe to remove: the `<h1>` is the
   * only top-level heading in the app, so the NAME has to stay reachable even though it is no longer drawn.
   * Removing the text without keeping the heading would leave a page with no `h1` at all.
   */
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const wordmark = /<h1 className="wordmark">([\s\S]*?)<\/h1>/.exec(app)?.[1] ?? "";
  assert.ok(wordmark.length > 0, "the wordmark heading must exist");
  assert.match(wordmark, /logoIcon/, "the mark stays");
  assert.match(wordmark, /<span className="visually-hidden">Pi Central<\/span>/, "the name stays, not drawn");
  /*
   * The prose in this block names the product, so comments are stripped before asking whether the NAME is
   * rendered — a checker that reads its own rationale as code reports the opposite of the truth, which is the
   * same defect `lifecycle-wiring.test.ts` documents for `codeOnly`.
   */
  const markup = wordmark.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  /*
   * The accessible copy is removed before asking, because it LEGITIMATELY contains the name — that is the
   * whole point of it. What must not exist is the name as a bare text node, which is what the first version
   * of the topbar rendered beside the mark.
   */
  const visible = markup.replace(/<span className="visually-hidden">[\s\S]*?<\/span>/g, "");
  assert.ok(!/Pi Central/.test(visible), `the name must not be drawn; found it in: ${visible.trim()}`);
  // And exactly one `<h1>`, so this removal did not promote some other heading. Counted on the source with
  // JSX comments stripped, because the block above mentions `<h1>` in prose and a raw count included it.
  const noComments = app.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.equal((noComments.match(/<h1\b/g) ?? []).length, 1, "the app has exactly one h1");
});

test("both bars are vertical, labelled, and 48px wide", () => {
  const css = readCss();
  const activity = /\.navrail\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(activity, /flex-direction:\s*column/, "a bar is a column");
  assert.match(activity, /width:\s*48px/, "the width is the measured 48px, not an accident");
  // The edges face the content, so each bar reads as a side of the window.
  assert.match(css, /\.navrail-left\s*\{[^}]*border-right/, "the left bar's edge faces the content");
  assert.match(css, /\.navrail-right\s*\{[^}]*border-left/, "the right bar's edge faces the content");
});

test("the left bar is a nav and the right bar is a tablist, because they mean different things", () => {
  /*
   * Sessions and Settings are DESTINATIONS — announced as tabs they would promise a tabpanel that does not
   * exist. Session/Files/Trace are alternative views of one thing, which is what a tablist means and what
   * the panel body's `aria-labelledby` needs.
   */
  assert.match(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"), /side="left"[\s\S]{0,200}label="Main"/);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.ok(!/side="left"[\s\S]{0,120}as="tablist"/.test(app), "the app bar is not a tablist");
  assert.match(app, /side="right"[\s\S]{0,120}as=\{focused === undefined \? "nav" : "tablist"\}/, "the context bar is a tablist of modes");
});

test("the right bar is shown only when a session is focused", () => {
  /*
   * The reader's requirement: "only if session is active, so it becomes a context aware navigation". It is
   * also what keeps the bar honest — three views of a session, offered with nothing focused, would promise
   * three views of nothing.
   */
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  /*
   * The bar must exist on the Sessions page even with no session — it carries the panel's show/hide toggle,
   * which is the only door to a collapsed panel, and collapsed is the default. Gating the whole bar on
   * `focused` (which the first version did) leaves a fresh window with no way to open the panel at all.
   *
   * What the SESSION gates is the mode list, not the bar.
   */
  const flat = app.replace(/\s+/g, " ");
  assert.match(flat, /\{tab === "sessions" && \( <ActivityBar/, "the bar exists on the Sessions page only");
  assert.match(
    flat,
    /items=\{\(focused === undefined \? \[\] : PANEL_MODES\)/,
    "the modes require a session; the toggle does not",
  );
});

test("both bars and the workspace are ONE flex row, so neither bar is a full-width island", () => {
  /*
   * The defect, twice. First the right bar was rendered at `.shell`'s own level; the fix then left it AFTER
   * the shell's closing `</div>` — which looked nested because it was indented 8 spaces, so the indentation
   * assertion believed it. A screenshot showed the consequence: both bars collapsed to their content width
   * and height, because an empty `.shell` gives the flex row nothing to distribute.
   *
   * So this asserts the SHAPE THAT MATTERS to the CSS rather than parsing JSX: `.shell` is a flex ROW, the
   * workspace flexes inside it, and both bars are flex-none columns. Those three rules are what make three
   * columns; where the tags sit is only how they are produced. A JSX depth parser was attempted and is not
   * worth it — `.panes`'s opening tag carries a `style={{…}}` expression, so any `<div[^>]*>` pattern needs a
   * JSX parser to be honest, and a test that needs one should ask a different question.
   */
  const css = readCss();
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  };

  /*
   * Matched as a standalone selector, not by `\.shell\s*\{` — `.app > .shell { grid-row: … }` appears first in
   * the file and a loose regex reads THAT rule body instead. This is the same class of trap the panel's
   * container test documents ("String.match returns the first match"), and it is caught by asserting a property
   * the wrong rule cannot have.
   */
  const shell = new RegExp("(?:^|\\n)\\.shell\\s*\\{([^}]*)\\}").exec(css)?.[1] ?? "";
  assert.match(shell, /display:\s*flex/, "the shell is the flex row");
  assert.ok(!/flex-direction:\s*column/.test(shell), "a column here stacks the bars into bands");
  assert.match(shell, /min-height:\s*0/, "…and takes the row the grid gives it, or an empty row collapses");

  const panes = rule(".shell > .panes");
  assert.match(panes, /flex:\s*1/, "the workspace takes the remaining width");
  assert.match(panes, /min-width:\s*0/, "…and may shrink below its content, as `.panes` itself requires");

  const bar = rule(".navrail");
  assert.match(bar, /flex:\s*none/, "the bars are fixed beside the workspace, not flexible");
  assert.match(bar, /flex-direction:\s*column/, "each bar is a column of items");
  assert.match(bar, /width:\s*48px/, "the measured width");

  /*
   * Nesting, answered by a real scanner rather than by indentation or string order.
   *
   * Both shortcuts failed, which is why the code below is a character walk:
   *   - INDENTATION is not nesting in this file (line 1823 is a `</div>` at 6 spaces, inside `.panes`);
   *   - SOURCE ORDER is not nesting either — moving the right bar outside `.shell` does not reorder those
   *     strings, it only moves a `</div>`. An order-based assertion passed with the bug reintroduced.
   *
   * A JSX tag boundary cannot be found with `<div[^>]*>` because attribute lists contain `{…}` expressions
   * (`.panes` carries `style={{ "--panel-width": … }}`). So the walk skips brace-balanced expressions and
   * string literals, and counts only real `<div>`/`</div>` tags.
   */
  const src = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  /**
   * The DIRECT children of the div whose opening tag starts at `from`, as a list of names.
   *
   * ## Why this is a character walk and not a regex
   *
   * Three shortcuts were tried on this file and each reported the wrong tree:
   *
   *   1. **Indentation.** Line 1823 is a `</div>` at 6 spaces that closes `.panes`, while the shell's own close
   *      is at 6 spaces too. Formatting cannot tell them apart.
   *   2. **`<div[^>]*>`.** `.panes`'s opening tag carries `style={{ "--panel-width": … }}`, so the pattern either
   *      stops early or needs a JSX parser.
   *   3. **Source order of `side="right"`.** Moving the bar out of the shell does not reorder those strings; it
   *      only moves a `</div>`. That assertion passed with the bug reintroduced.
   *
   * A fourth came from skipping every `{…}`: `{focused !== undefined && (` is a WRAPPER, not an attribute, so
   * skipping it swallowed the right bar entirely and the walk reported one bar for a tree that has two. Hence
   * `inTag`: `{…}` is skipped only between `<` and `>`, where it is an attribute expression.
   *
   * Depth is seeded at 1 to stand for the container itself, so a `<div>` at depth 1 is a direct child and a
   * `</div>` that brings depth to 0 is the container's close.
   */
  function directChildren(source, from) {
    const out = [];
    let depth = 1;
    for (let i = from; i < source.length; i += 1) {
      const ch = source[i];

      if (ch === "<") {
        if (source.startsWith("</div>", i)) {
          depth -= 1;
          if (depth === 0) return out;
          i += 5;
          continue;
        }
        /*
         * A `<div>` is counted but its tag is NOT consumed. Consuming it is what broke the previous version:
         * `.panes`'s tag runs over four lines and ends with `>` alone, and a consumption loop that starts on
         * the next character still has to know where the `{…}` expressions inside it end. Counting the open and
         * continuing means the walk simply encounters those characters again — and a stray `>` or `=>` inside an
         * attribute is harmless, because only `<div`, `</div>`, `<ActivityBar` and `<` are looked for.
         */
        if (source.startsWith("<div", i)) {
          if (depth === 1) {
            const window = source.slice(i, i + 240);
            const named = /className=(?:"([^"]*)"|\{([^}]*)\})/.exec(window);
            out.push(named === null ? "" : (named[1] ?? named[2] ?? ""));
          }
          depth += 1;
          continue;
        }
        if (source.startsWith("<ActivityBar", i) && depth === 1) out.push("ACTIVITY-BAR");
        continue;
      }
    }
    return undefined;
  }

  const shellAt = src.indexOf('<div className="shell">');
  assert.notEqual(shellAt, -1, "the shell row must exist");
  // Start AFTER the shell's own opening tag, or the walk counts the shell itself as its first child.
  const openEnd = src.indexOf(">", shellAt) + 1;
  const inside = directChildren(src, openEnd);
  assert.ok(inside !== undefined, "the shell's closing tag must be found (a brace walk that never closes is a bug here)");

  /*
   * The shell's direct children, in order: the left bar, the workspace, the right bar. This is the assertion
   * that fails when the right bar is a sibling of the shell — the list then has one ACTIVITY-BAR and the bar
   * appears nowhere in it.
   */
  assert.equal(inside.length, 3, `expected 3 direct children of .shell, found ${inside.length}: ${JSON.stringify(inside)}`);
  assert.equal(inside[0], "ACTIVITY-BAR", "the left bar is first");
  assert.match(inside[1] ?? "", /panes/, "the workspace is in the middle");
  assert.equal(inside[2], "ACTIVITY-BAR", "the right bar is last");

  // And the bar count is what distinguishes the fixed tree from the broken one: outside the shell, the right
  // bar is not in this list at all.
  assert.equal(inside.filter((name) => name === "ACTIVITY-BAR").length, 2, "both bars are inside the shell");
});

test("no glyph is used for two different destinations", () => {
  /*
   * From a screenshot: `▤` was Sessions in the left bar AND Files in the context bar. In a 48px bar the glyph
   * is the only thing telling two items apart, so reusing one makes the reader resolve the collision from
   * position alone — and the two are not even the same kind of thing (a list of all sessions vs. this
   * session's files).
   */
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const leftGlyphs = [...app.matchAll(/glyph: "([^"]+)"/g)].map((m) => m[1]);
  const rightGlyphs = PANEL_MODES.map(({ glyph }) => glyph);
  assert.ok(leftGlyphs.length >= 2, "the app bar has items");
  assert.deepEqual(
    leftGlyphs.filter((g) => rightGlyphs.includes(g)),
    [],
    `a glyph may appear in only one bar; reused: ${leftGlyphs.filter((g) => rightGlyphs.includes(g)).join(", ")}`,
  );
  // And no glyph twice within the app bar either.
  assert.equal(new Set(leftGlyphs).size, leftGlyphs.length, "each destination has its own mark");
  assert.equal(new Set(rightGlyphs).size, rightGlyphs.length, "each panel mode has its own mark");
});

test("the shell occupies the growing row, whatever banners are present", () => {
  /*
   * The bottom gap, from a screenshot: the workspace stopped ~80px above the window's bottom edge.
   *
   * `grid-template-rows: 44px 1fr` on `.app` was correct only while the shell was the second child. The
   * banners between them are CONDITIONAL, so on the common path the second child is a falsy `&&` expression,
   * the `1fr` track belonged to nothing, and the shell fell into an implicit `auto` row sized to its content.
   *
   * Checked in two halves: the template has a growing LAST track, and the shell is pinned to it. Either alone
   * leaves the bug reachable.
   */
  const css = readCss();
  const appRule = /\.app\s*\{([^}]*)\}/.exec(css);
  assert.ok(appRule, "the .app rule must exist");
  const app = appRule[1];
  assert.match(app, /grid-template-rows:[^;]*minmax\(0,\s*1fr\)/, "the last track must be the one that grows");
  assert.ok(
    !/grid-template-rows:\s*44px\s+1fr\s*;/.test(app),
    "a bare `44px 1fr` gives the growing track to the first conditional banner",
  );
  assert.ok(!/grid-auto-rows/.test(app), "an implicit row per banner is the bug, not the fix");
});

test("the shell is pinned to the last grid row, so a banner cannot take the growing track", () => {
  // The companion to the template above. `grid-row: -2 / -1` means "the last track", whatever the banners did.
  const css = readCss();
  const pinned = /\.app\s*>\s*\.shell\s*\{([^}]*)\}/.exec(css);
  assert.ok(pinned, "the shell must have its own grid placement rule");
  assert.match(pinned[1], /grid-row:\s*-2\s*\/\s*-1/, "the shell occupies the final track");
});

test("the activity bars recede behind the panes instead of competing with the rail", () => {
  /*
   * From a screenshot: "the gray vertical bars distract next to the sessions". They used `--panel-2`
   * (#1c2230), which is LIGHTER than both the rail (`--panel`, #161b22) and the transcript (`--bg`, #0e1116),
   * so each bar read as a third slab of surface between two others. Chrome should not be the brightest thing
   * in the window.
   */
  const css = readCss();
  const barRule = /\.navrail\s*\{([^}]*)\}/.exec(css);
  assert.ok(barRule, "the .navrail rule must exist");
  assert.match(barRule[1], /background:\s*var\(--bg\)/, "the bar uses the window background, not a raised surface");
  assert.ok(!/--panel-2/.test(barRule[1]), "--panel-2 is lighter than the rail, so it competes");
});

test("a selected activity item is marked by colour and an edge, not by a filled tile", () => {
  /*
   * The tile was 40px in a 48px bar — most of it — so a selected item looked like a button held down, and the
   * tint read as yet another slab beside the rail.
   */
  const css = readCss();
  const start = css.indexOf('.navrail-item[aria-selected="true"]');
  assert.notEqual(start, -1, "the selected state must be styled");
  const block = css.slice(start, css.indexOf("}", start));
  assert.ok(!/background:/.test(block), "a filled tile reads as a permanently pressed button");
  assert.match(css, /\.navrail-left \.navrail-item::before/, "the left bar's marker is placed");
  assert.match(css, /\.navrail-right \.navrail-item::before/, "and the right bar's");
});

test("the bars use a namespace of their own, because `.activity` already means a tool group", () => {
  /*
   * From a screenshot: the left bar rendered as a grey slab with a 3px left border, and the marks above it
   * were black boxes. The cause was a CLASS COLLISION — `.activity` and `.activity-glyph` are the transcript's
   * tool-activity group (styles.css: `.activity { border-left: 3px solid var(--quarantine); background:
   * var(--panel); max-width: var(--reading-measure); margin: 2px 0 var(--sp-3) }`).
   *
   * The bar inherited every one of those, which is why it looked like a strip of surface with a coloured edge
   * rather than chrome — and why the glyphs sat in bordered boxes.
   *
   * A shared class is invisible in both directions: the bar's own rules looked fine, and the transcript's
   * looked fine. So this asserts the namespaces are DISJOINT, which is the property that was violated.
   */
  const css = readCss();
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const bar = readFileSync(new URL("../src/components/ActivityBar.tsx", import.meta.url), "utf8");

  // Every class the bar renders must be `navrail*`.
  const rendered = [...`${app}${bar}`.matchAll(/className=(?:"([^"]+)"|{`([^`]+)`})/g)]
    .flatMap((m) => (m[1] ?? m[2] ?? "").split(/\s+/))
    .filter((name) => name !== "");
  // Only the classes on the bar's own elements matter; the app renders many other things.
  const barClasses = rendered.filter((name) => /^(navrail|activity)/.test(name));
  assert.ok(barClasses.length > 0, "the bar must render classes at all");
  for (const name of barClasses) {
    assert.match(name, /^navrail/, `"${name}" is rendered by the bar but is not in the navrail namespace`);
  }

  /*
   * And the transcript's names are untouched: `.activity` still carries its quarantine border, and
   * `.activity-glyph` still carries its quarantine colour. If a future change renames those to `navrail`, the
   * bar would inherit the transcript's look and this test would say so.
   */
  const activityRule = /(?:^|\n)\.activity\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(activityRule, /border-left:\s*3px solid var\(--quarantine\)/, "`.activity` is still the tool group");
  const activityGlyph = /(?:^|\n)\.activity-glyph\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(activityGlyph, /var\(--quarantine\)/, "`.activity-glyph` is still the tool group's mark");

  // The bar's own rule must not carry the transcript's properties.
  const navrail = /(?:^|\n)\.navrail\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  for (const leak of ["--quarantine", "reading-measure"]) {
    assert.ok(!navrail.includes(leak), `the bar must not inherit ${leak} from the tool group`);
  }
});

test("a page shows its own list, not another page's", () => {
  /*
   * Reported from use: "The history panel shows the sessions and the context detail panel from sessions.
   * That is a violation of what we wanted the bars to work."
   *
   * The rule the bars promise: the LEFT bar chooses a PAGE, and a page owns its own furniture. The session
   * rail is the Sessions page's list, so it must not render beside History — which has its own full-width
   * list and its own search (`DESIGN.md` §6: "One full-width list, not a rail tail").
   *
   * The context bar is bound by the same rule from the other side: Session/Files/Trace are views of a LIVE
   * session, so on a page about the session ARCHIVE the bar names a context the page does not have.
   */
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  // Comments first and foremost: the guard string appears in the prose that EXPLAINS it, and a check that
  // reads prose as code reports the opposite of the truth — the failure this file's `codeOnly` convention
  // exists for. Falsification caught exactly that: with the guard removed the comment still satisfied
  // `lastIndexOf("tab === \"sessions\" && (")`.
  const src = app.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  const railAt = src.indexOf("<SessionRail");
  assert.notEqual(railAt, -1, "the session rail must exist");

  /*
   * The guard must be ADJACENT to the element, not merely somewhere before it in the file. Everything between
   * the guard and `<SessionRail` is whitespace, which is what makes "this conditional wraps that element" a
   * statement about the code rather than about the file's length.
   */
  const beforeRail = src.slice(0, railAt);
  const guardAt = beforeRail.lastIndexOf('{tab === "sessions" && (');
  assert.notEqual(guardAt, -1, "the rail must be rendered only on the Sessions page");
  const between = src.slice(guardAt, railAt);
  assert.equal(
    between.replace(/[{}\s]/g, ""),
    'tab==="sessions"&&(',
    `the guard must wrap the rail, not merely precede it; found "${between.trim().slice(0, 60)}"`,
  );

  // The context bar needs BOTH a live session and the Sessions page.
  assert.match(
    src.replace(/\s+/g, " "),
    /\{tab === "sessions" && \( <ActivityBar/,
    "the context bar belongs to the Sessions page",
  );
  assert.match(
    src.replace(/\s+/g, " "),
    /items=\{\(focused === undefined \? \[\] : PANEL_MODES\)/,
    "…and its views of a session require a session",
  );
});

test("the History page gives its list the rail's 288px back", () => {
  /*
   * The companion of the test above. If the rail is not rendered, reserving its grid track leaves a 288px
   * hole — which is a layout bug that looks like a loading bug. `is-pageless` is the modifier that removes
   * the track, and it must exist in both the collapsed and expanded form.
   */
  const css = readCss();
  assert.match(css, /\.panes\.is-pageless\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--panel-width/);
  assert.match(css, /\.panes\.is-pageless\.is-collapsed\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);

  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /is-pageless/, "the shell applies the modifier for a page with no list");
  assert.match(app, /tab === "history" \? " is-pageless"/, "…for exactly the History page");
});

test("the History page is centred on the reading measure", () => {
  /*
   * Reported from use: "the history content is now very left aligned and shall be centered". Without a cap the
   * rows stretched to the full column (~840px in a 1560px window) with the text hugging the left edge — and a
   * prose line that long is unreadable anyway, which is what `--reading-measure` is for.
   *
   * The property is a capped column that is centred (`margin-inline: auto`), not padding on the scroller: the
   * scrollbar must stay at the window's edge, and padding cannot centre.
   */
  const css = readCss();
  const inner = /\.history\s*>\s*\*\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(inner, /max-width:\s*var\(--reading-measure\)/, "the page content is capped at the reading measure");
  assert.match(inner, /margin-inline:\s*auto/, "…and centred, not left-aligned");
  // A second cap on a child would put that child off the shared centreline.
  const search = /\.history-search\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(!/max-width/.test(search), "the search row must inherit the page measure, not cap itself");
});

test("the panel and its door share one condition, so neither outlives the other", () => {
  /*
   * The bug this pins: the context BAR was gated on the page but the PANEL was not, so the trace list sat
   * beside the History page — "Showing trace information in the history does not make any sense."
   *
   * A bar is the panel's door. If the door closes and the room stays, the result is content with no control;
   * if the room goes and the door stays, the control opens nothing. They must be one condition.
   */
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const src = app.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.match(
    src.replace(/\s+/g, " "),
    /\{!panel\.collapsed && tab === "sessions" && \( <Panel/,
    "the panel renders on the Sessions page only",
  );
});

test("the panel toggle is the divided-square pair, at the TOP of the right bar, behind a rule", () => {
  /*
   * Three reports, in order, and this test pins the final shape:
   *
   *   1. "the show hide panel toggle shall be an icon, and it needs to be integrated in the context aware
   *      bar, not globally" — it moved from a word in the topbar to a glyph in the bar;
   *   2. "i think there are better icons for opening / closing a panel" — a pair of rectangles said
   *      "a rectangle";
   *   3. "use this icon pair and make this a top icon on the right bar. Right bottom is out of reach.
   *      Include a small visual separator" — the footer put it at the bottom of a full-height column.
   *
   * The pair is `◫` / `◨`: a square divided by a vertical rule (two panes, panel shown) and the same square
   * with its RIGHT half filled (one pane, panel hidden). The filled half is the panel's side, so the picture
   * says which side is missing — a depiction, not a direction, which is why it is two codepoints and not one
   * rotated glyph.
   */
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const src = app.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const bar = src.slice(src.indexOf('side="right"'));

  // The pair, in the right polarity: filled when the panel is GONE.
  assert.match(bar, /panel\.collapsed \? "◨" : "◫"/, "filled half when collapsed, divided square when shown");
  assert.ok(!/▮|▭|◀|▶/.test(bar), "the earlier rectangle and chevron glyphs are gone from the markup");

  // It is the HEADER of the bar, not the footer: `header=` comes before `items=`.
  const headerAt = bar.indexOf("header={");
  const itemsAt = bar.indexOf("items={");
  assert.notEqual(headerAt, -1, "the toggle is the bar's header");
  assert.ok(headerAt < itemsAt, "the header is rendered above the mode items");
  assert.ok(!/children=\{/.test(bar), "…and nothing is left in the footer slot");

  // The separator exists and is decorative.
  const component = readFileSync(new URL("../src/components/ActivityBar.tsx", import.meta.url), "utf8");
  assert.match(component, /className="navrail-rule" aria-hidden="true"/, "a rule separates the header from the items");
  const css = readCss();
  const rule = /\.navrail-rule\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /height:\s*1px/, "a hairline, not a band");
  assert.match(rule, /margin:[^;]*\b10px/, "inset, so it reads as a divider between groups");
});

test("the header slot is separated from the items by a rule, and only when it is used", () => {
  // The app bar has no header, so it must render no rule — a stray divider at the top of the left bar would be
  // a line between nothing and the first item.
  const component = readFileSync(new URL("../src/components/ActivityBar.tsx", import.meta.url), "utf8");
  assert.match(
    component,
    /\{header !== undefined && \(/,
    "the rule and the header are rendered together, so neither can exist alone",
  );
});

test("the bar's tablist holds only tabs, so the toggle is not an orphan inside it", () => {
  /*
   * Found while changing the icon: `role="tablist"` was on the BAR, and the bar also holds the panel toggle in
   * its footer. A tablist may contain only tabs — a plain `<button>` inside one is invalid ARIA and assistive
   * tech is entitled to ignore it, which would have made the only door to the panel unreachable to it.
   *
   * The role now goes on the GROUP of modes. Asserted on the component because that is where the structure is.
   */
  const bar = readFileSync(new URL("../src/components/ActivityBar.tsx", import.meta.url), "utf8");
  const src = bar.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  // The outer element must NOT carry the role; the inner group must.
  assert.match(src, /<div className=\{`navrail navrail-\$\{side\}`\}[^>]*>/, "the bar's own element has no role");
  assert.ok(
    !/navrail-\$\{side\}`\}[^>]*role=/.test(src),
    "the role must not be on the bar, because the bar also holds a non-tab control",
  );
  assert.match(src, /className="navrail-group"\s*\{\.\.\.groupRole\}/, "the mode group carries it instead");
});
