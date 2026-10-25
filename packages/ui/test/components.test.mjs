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
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

let server;
let SessionRail, ToolFrame, DialogDock, TranscriptView, HistoryView;

before(async () => {
  // `root` must be the UI package, not the process CWD: Vite resolves the `/src/...` specifiers
  // below against its root, and the test runner starts from the repository root.
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ SessionRail } = await server.ssrLoadModule("/src/components/SessionRail.tsx"));
  ({ ToolFrame } = await server.ssrLoadModule("/src/components/ToolFrame.tsx"));
  ({ DialogDock } = await server.ssrLoadModule("/src/components/DialogDock.tsx"));
  ({ TranscriptView } = await server.ssrLoadModule("/src/components/Transcript.tsx"));
  ({ HistoryView } = await server.ssrLoadModule("/src/components/History.tsx"));
});

after(async () => {
  await server?.close();
});

function session(over = {}) {
  return {
    id: "s7", name: "s7", cwd: "/Users/x/git/project", state: "idle", mode: "sandboxed",
    isolation: "Safehouse workdir=/Users/x/git/project", command: "safehouse -- pi --mode rpc",
    scratch: false, messageCount: 0, pending: 0, contextPercent: null, tokensTotal: null,
    cost: null, dialogs: [], warnings: [], startedAt: 0, ...over,
  };
}

// --- The rail: attention ordering and honest labels (US-1, US-3) ------------------------------

test("the primary action is first and mentions no directory", () => {
  // The governing decision: starting a session must not require choosing a path (US-1).
  const html = renderToString(createElement(SessionRail, {
    sessions: [], focusedId: undefined, onFocus() {}, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyCount: 0,
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
    sessions: [
      session({ id: "idle", state: "idle" }),
      session({ id: "blocked", state: "awaiting-approval", dialogs: [{ id: "d", method: "confirm", message: "Allow?", receivedAt: 0 }] }),
    ],
    focusedId: undefined, onFocus() {}, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyCount: 0,
  }));
  assert.ok(html.indexOf("Needs you") < html.indexOf("Idle"), "the blocked group must come first");
});

test("a scratch session shows a label, not its internal workspace path", () => {
  // The workspace path is an implementation detail (US-3).
  const html = renderToString(createElement(SessionRail, {
    sessions: [session({ scratch: true, cwd: "/Users/x/.local/share/pi-central/workspaces/s7" })],
    focusedId: "s7", onFocus() {}, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyCount: 0,
  }));
  assert.match(html, /Scratch session/);
  assert.match(html, /scratch · s7/);
  // The full path stays in `title`, where a hover or a screen reader can reach it: hiding it
  // from the scan line is not the same as hiding it from the user.
  assert.match(html, /title="[^"]*workspaces\/s7"/, "the full path should remain available on hover");
  assert.ok(!/>[^<]*workspaces\/s7</.test(html), "the internal path must not be visible text");
});

test("the rail states an unknown cost as an em dash, never $0.0000", () => {
  const html = renderToString(createElement(SessionRail, {
    sessions: [session({ cost: null })],
    focusedId: "s7", onFocus() {}, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyCount: 0,
  }));
  assert.ok(html.includes("—"), "expected an em dash for unknown values");
  assert.ok(!html.includes("$0.0000"), "an unknown cost must not read as free");
});

test("a dialog's ask replaces the path line, because that is what the row is for", () => {
  const html = renderToString(createElement(SessionRail, {
    sessions: [session({ state: "awaiting-approval", dialogs: [{ id: "d", method: "confirm", message: "Allow running npm test?", receivedAt: 0 }] })],
    focusedId: "s7", onFocus() {}, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyCount: 0,
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

test("tool output is labelled and rendered as preformatted text, not prose", () => {
  const html = renderToString(createElement(ToolFrame, {
    tool: { toolCallId: "c1", toolName: "bash", args: {}, result: "output *not* markdown", isError: false, running: false, startedAt: 0 },
  }));
  assert.match(html, /Tool output/);
  assert.match(html, /class="quarantine"/);
  assert.match(html, /<pre/);
  // The asterisks survive literally: a diff must show what the command produced.
  assert.ok(!html.includes("<em>"), "tool output must not be interpreted as Markdown");
  assert.ok(html.includes("*not*"), "tool output must be shown verbatim");
});

test("a failed tool is marked as failed, not silently shown as success", () => {
  const html = renderToString(createElement(ToolFrame, {
    tool: { toolCallId: "c1", toolName: "bash", args: {}, result: "boom", isError: true, running: false, startedAt: 0 },
  }));
  assert.match(html, /failed/);
  assert.match(html, /error/);
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
