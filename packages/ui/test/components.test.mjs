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
let SessionRail, ToolTrace, DialogDock, TranscriptView, HistoryView, Composer, FileTree, FilePane, Panel, FilesPanel, Settings, initialState;

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

// --- The rail: attention ordering and honest labels (US-1, US-3) ------------------------------

test("the primary action is first and mentions no directory", () => {
  // The governing decision: starting a session must not require choosing a path (US-1).
  const html = renderToString(createElement(SessionRail, {
    sessions: [], focusedId: undefined, onFocus() {}, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyTotal: 0,
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
    focusedId: undefined, onFocus() {}, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyTotal: 0,
  }));
  assert.ok(html.indexOf("Needs you") < html.indexOf("Idle"), "the blocked group must come first");
});

test("a scratch session shows a label, not its internal workspace path", () => {
  // The workspace path is an implementation detail (US-3).
  const html = renderToString(createElement(SessionRail, {
    sessions: [session({ scratch: true, cwd: "/Users/x/.local/share/pi-central/workspaces/s7" })],
    focusedId: "s7", onFocus() {}, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyTotal: 0,
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
    sessions: [session()], focusedId: "s7", onFocus() {}, onStartSession() {}, onOpenDirectory() {},
    home: "/Users/x", historyTotal: 1115,
  }));
  assert.match(html, /1115 sessions on disk/);
  assert.ok(!html.includes("500 sessions"), "the page size must not be shown as the total");
});

test("a long model name does not swallow the rail's metrics line", () => {
  // The screenshot showed `deepseek-ai/DeepSeek-V4.1-Flash  high  ct…` -- context and cost cut
  // off entirely, which is worse than a shortened model because those are the scanned values.
  const html = renderToString(createElement(SessionRail, {
    // contextPercent and cost are set deliberately: the point is that THEY survive the model.
    sessions: [session({ model: "deepseek-ai/DeepSeek-V4.1-Flash", contextPercent: 62, cost: 0.0142 })],
    focusedId: "s7", onFocus() {}, onStartSession() {}, onOpenDirectory() {}, home: "/Users/x", historyTotal: 0,
  }));
  assert.ok(!html.includes("deepseek-ai/DeepSeek-V4.1-Flash"), "the raw model name must be shortened");
  assert.match(html, /…/, "the shortening should be visible");
  assert.match(html, /ctx 62%/, "the context value must survive");
  assert.match(html, /\$0\.0142/, "the cost must survive");
});

test("the rail abbreviates HOME, so rows are scannable", () => {
  const html = renderToString(createElement(SessionRail, {
    sessions: [session({ cwd: "/Users/x/git/api-gateway", scratch: false })],
    focusedId: "s7", onFocus() {}, onStartSession() {}, onOpenDirectory() {}, home: "/Users/x", historyTotal: 0,
  }));
  assert.match(html, /~\/git\/api-gateway/);
  assert.ok(!html.includes(">/Users/x/git"), "the home prefix should be abbreviated away");
});

test("the rail states an unknown cost as an em dash, never $0.0000", () => {
  const html = renderToString(createElement(SessionRail, {
    sessions: [session({ cost: null })],
    focusedId: "s7", onFocus() {}, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyTotal: 0,
  }));
  assert.ok(html.includes("—"), "expected an em dash for unknown values");
  assert.ok(!html.includes("$0.0000"), "an unknown cost must not read as free");
});

test("a dialog's ask replaces the path line, because that is what the row is for", () => {
  const html = renderToString(createElement(SessionRail, {
    sessions: [session({ state: "awaiting-approval", dialogs: [{ id: "d", method: "confirm", message: "Allow running npm test?", receivedAt: 0 }] })],
    focusedId: "s7", onFocus() {}, onStartSession() {}, onOpenDirectory() {}, home: undefined, historyTotal: 0,
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
  // The panel states its own economy rather than silently hiding the rest.
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
  // The hatch is a background, so the class is only meaningful if a rule carries the gradient.
  // Asserted against the stylesheet rather than the class name, because a class with no rule is
  // exactly the state this bug was in.
  const css = readCss();
  const rule = /\.trace-detail\.is-quarantined\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "a .trace-detail.is-quarantined rule must exist");
  assert.match(rule[1], /repeating-linear-gradient/, "the rule must actually draw the hatch");
  assert.match(rule[1], /var\(--quarantine\)/, "the frame colour must come from the quarantine token");
});

test("the quarantine hatch is not defeated by cascade order", () => {
  // Found while fixing #43: `.quarantine` and `.trace-detail` both set `background`, and
  // `.trace-detail` is declared LATER, so stacking both classes would let the plain background win
  // on source order — markup correct, frame invisible. This asserts the property directly: whatever
  // rule gives the panel its hatch must be declared after any rule that would override it.
  const css = readCss();
  const hatchAt = css.indexOf(".trace-detail.is-quarantined {");
  assert.ok(hatchAt > 0);
  // Every later rule that sets `background` on a bare `.trace-detail` would win. There must be none.
  const after = css.slice(hatchAt);
  const laterPlain = /\.trace-detail\s*\{[^}]*background/.exec(after);
  assert.equal(laterPlain, null, "a later `.trace-detail` background rule would override the hatch");
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

test("while streaming, the picker says the change applies to the next turn", async () => {
  // A model change takes effect for the next turn, so a control that looked immediate would claim
  // something false.
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ state: "streaming", model: "gpt-5", provider: "openai" }),
    models: [{ provider: "openai", id: "gpt-5" }],
    error: undefined,
    onRequest() {},
    onSelect() {},
  }));
  assert.match(text(html), /Applies to the next turn/);
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

test("the mode strip appears ONLY while a run is in progress", async () => {
  const init = initialState;

  const streaming = renderToString(createElement(Composer, {
    session: session({ state: "streaming" }), state: init(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "", onDraftChange() {},
  }));
  assert.match(streaming, /mode-strip/);

  // Idle: only one thing can happen, so a selector would be a lie about complexity.
  const idle = renderToString(createElement(Composer, {
    session: session({ state: "idle" }), state: init(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "", onDraftChange() {},
  }));
  assert.ok(!/mode-strip/.test(idle), "an idle composer must not offer a queue choice");
});

test("the strip offers BOTH modes and states which one is selected", async () => {
  const html = renderToString(createElement(Composer, {
    session: session({ state: "streaming" }), state: initialState(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "", onDraftChange() {},
  }));
  assert.match(html, /Steer/);
  assert.match(html, /Follow-up/);
  // Steer is the default, matching Pi's own Enter binding, and it is stated as selected.
  assert.match(text(html), /aria-checked="true"[^>]*>Steer/);
  // The consequence of the SELECTED mode, which is what the issue asks the strip to convey.
  assert.match(text(html), /Delivered after the current turn's tools finish/);
});

test("the interim 'steer is not available' copy is gone", async () => {
  // The whole point of the slice: the capability is real now, so the hedge must not survive.
  const html = renderToString(createElement(Composer, {
    session: session({ state: "streaming" }), state: initialState(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "", onDraftChange() {},
  }));
  assert.ok(!/not available/i.test(html), "the interim capability hint must be removed");
  assert.match(text(html), /Esc<\/kbd> stops the run and returns the queue to this box/);
});

test("the button label names the action the selected mode will take", async () => {
  const steer = renderToString(createElement(Composer, {
    session: session({ state: "streaming" }), state: initialState(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "hello", onDraftChange() {},
  }));
  assert.match(steer, /Send steer/);

  const idle = renderToString(createElement(Composer, {
    session: session({ state: "idle" }), state: initialState(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "hello", onDraftChange() {},
  }));
  assert.match(idle, />Send</);
});

test("the queued texts are listed, and a read-only row has no removal control", async () => {
  // Rows are read-only because Pi Central has no per-item removal, so a `×` would be a fake
  // control — the one real action is Esc, which the hint names.
  const state = { ...initialState(), queues: { s7: { steering: ["do this instead"], followUp: ["and then"] } } };
  const html = renderToString(createElement(Composer, {
    session: session({ state: "streaming", pending: 2 }), state,
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "", onDraftChange() {},
  }));
  assert.match(text(html), /2 queued/);
  assert.match(text(html), /do this instead/);
  assert.match(text(html), /and then/);
  assert.ok(!/×|Remove|remove/.test(html), "no per-item removal control may be offered");
});

test("a queue count with no texts says so instead of inventing rows", async () => {
  // After a reconnect the count is known and the texts are not, because records are not replayed.
  const html = renderToString(createElement(Composer, {
    session: session({ state: "streaming", pending: 1 }), state: initialState(),
    unavailableReason: undefined, onSend() {}, onClearQueueAndStop() {}, restored: [],
    onRestored() {}, draft: "", onDraftChange() {},
  }));
  assert.match(text(html), /1 message queued before this page loaded/);
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
  const focus = (state, id) => reduce(state, { kind: "focusSession", sessionId: id });

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
    sessions: [session({ id: "s1", name: "first" }), session({ id: "s2", name: "second" })],
    focusedId: "s1", onFocus() {}, onStartSession() {}, onOpenDirectory() {},
    home: undefined, historyTotal: 0,
  }));
  const rows = html.match(/class="rail-row[^"]*"/g) ?? [];
  assert.equal(rows.length, 2, "both sessions must render a row");
  // Each row is a real button, so it is reachable and activatable by keyboard as well.
  assert.equal((html.match(/<button[^>]*rail-row/g) ?? []).length, 2);
});

test("focus is marked with aria-current so the focus is not colour-only", async () => {
  const html = renderToString(createElement(SessionRail, {
    sessions: [session({ id: "s1" }), session({ id: "s2" })],
    focusedId: "s2", onFocus() {}, onStartSession() {}, onOpenDirectory() {},
    home: undefined, historyTotal: 0,
  }));
  const rows = html.match(/<button[^>]*rail-row[^>]*>/g) ?? [];
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
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: "deepseek-V4.1-Flash", provider: "litellm" }),
    models: undefined, error: undefined, onRequest() {}, onSelect() {},
  }));
  const shown = /class="picker-display[^"]*"[^>]*>([^<]*)</.exec(html)?.[1];
  assert.equal(shown, "litellm/deep…4.1-Flash");
  assert.ok(!shown.endsWith("-"), "a trailing cut is the bug: it loses the identifying tail");
  assert.ok(shown.includes("…"), "an elision must be marked as one");
  assert.ok(shown.length <= 22, "the label must actually fit the control's width");
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
  assert.match(html, /<option value=""[^>]*>litellm\/deepseek-V4\.1-Flash</, "the option keeps the full name");
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
  const long = "DeepSeek V4 Flash Vision Exp";
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
  assert.ok(shown.endsWith("sion Exp"), `the overlay must elide the option's name, got ${JSON.stringify(shown)}`);
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

test("a short name is left alone rather than elided for no reason", async () => {
  const { ModelPicker } = await server.ssrLoadModule("/src/components/ModelPicker.tsx");
  const html = renderToString(createElement(ModelPicker, {
    session: session({ model: "gpt-5", provider: "openai" }),
    models: undefined, error: undefined, onRequest() {}, onSelect() {},
  }));
  assert.match(html, /class="picker-display[^"]*"[^>]*>openai\/gpt-5</);
  assert.ok(!/openai\/gpt-5[^<]*…/.test(html), "a name that fits must not be elided");
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
    onClose() {},
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
    state: { status: "loaded", text: payload, bytes: payload.length },
    onClose() {},
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

test("the panel offers both modes, and marks the active one", () => {
  const html = renderToString(createElement(Panel, panelProps(), createElement("p", null, "body")));
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"/);
  // Both modes are present; exactly one is selected.
  assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.match(html, /aria-selected="true"[^>]*>Session</);
});

test("only the selected TAB is in the tab order (roving tabindex)", () => {
  // Scoped to the tabs on purpose: the resize separator is also tabbable, and counting every
  // `tabindex="0"` in the panel conflated the two — which is how the first version of this test
  // passed for the wrong reason.
  const html = renderToString(createElement(Panel, panelProps(), createElement("p", null, "body")));
  const tabs = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
  assert.equal(tabs.length, 2, "expected two tabs");
  const selected = tabs.filter((t) => t.includes('aria-selected="true"'));
  const other = tabs.filter((t) => t.includes('aria-selected="false"'));
  assert.equal(selected.length, 1);
  assert.equal(other.length, 1);
  assert.match(selected[0], /tabindex="0"/, "the selected tab must be reachable by Tab");
  assert.match(other[0], /tabindex="-1"/, "the unselected tab must be skipped");
});

test("the body is tied to the tab that labels it", () => {
  // `aria-labelledby` on the tabpanel is what makes the region announce as "Files, tab panel"
  // rather than as an unlabelled group.
  const html = renderToString(createElement(Panel, panelProps({ mode: "files" }), createElement("p", null, "body")));
  assert.match(html, /id="panel-body-files"[^>]*aria-labelledby="panel-tab-files"/);
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
  const html = renderToString(createElement(Settings, { install: installFacts(), onClose() {} }));
  assert.match(html, /9\.9\.9-witness/);
  assert.ok(!/0\.\d+\.\d+/.test(html.replace(/4242/g, "")), `no real-looking version may appear: ${html}`);
});

test("Settings says 'not reported' rather than showing a blank or a zero", async () => {
  // The state an orchestrator older than this field produces, and the state before the first
  // snapshot. A blank where a version belongs reads as a bug in the surface; "not reported" is a
  // fact. This is the case that let the protocol add the field without a version bump.
  const html = renderToString(createElement(Settings, { install: undefined, onClose() {} }));
  assert.match(html, /not reported/);
  assert.ok(!/0\.0\.0|unknown version|v0\b/.test(html), `must not invent a version: ${html}`);
});

test("Settings shows where things live, copyable", async () => {
  const html = renderToString(createElement(Settings, { install: installFacts(), onClose() {} }));
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
  const managed = renderToString(createElement(Settings, { install: installFacts(), onClose() {} }));
  assert.match(managed, /managed by Pi Central/);

  const external = renderToString(
    createElement(Settings, { install: installFacts({ agentRootManaged: false }), onClose() {} }),
  );
  assert.match(external, /external/);
  assert.ok(!/managed by Pi Central/.test(external), "an external root must not claim to be managed");
});

test("a PROTOCOL MISMATCH is stated, because that was the confusing failure", async () => {
  // The whole point of showing the protocol version: the failure that motivated Increment 6 arrived
  // as `unknown kind 'listFiles'` from a connection that had agreed on `hello`. Both numbers and the
  // word MISMATCH make that class self-diagnosing instead.
  const html = renderToString(
    createElement(Settings, { install: installFacts({ protocol: 4242 }), onClose() {} }),
  );
  assert.match(html, /MISMATCH/);
  assert.match(html, /4242/);
});

test("a MATCHING protocol is stated as matching, and does not cry wolf", async () => {
  const { PROTOCOL_VERSION } = await server.ssrLoadModule("/src/../../protocol/src/index.ts");
  const html = renderToString(
    createElement(Settings, { install: installFacts({ protocol: PROTOCOL_VERSION }), onClose() {} }),
  );
  assert.ok(!/MISMATCH/.test(html), `a matching protocol must not report a mismatch: ${html}`);
  assert.match(html, /matches this UI/);
});

test("Settings contains NO preference control, only a statement about updates", async () => {
  // The rule this slice is built around: a control that looks functional and is not is worse than
  // its absence. The update toggle belongs here, and must not appear until #55 makes it work — so
  // this asserts the absence, which is what would silently rot as someone "helpfully" adds it.
  const html = renderToString(createElement(Settings, { install: installFacts(), onClose() {} }));
  assert.ok(!/<input/i.test(html), `no input may appear in Settings yet: ${html}`);
  assert.ok(!/type="checkbox"/i.test(html), "no checkbox may appear in Settings yet");
  assert.ok(!/role="switch"/i.test(html), "no switch may appear in Settings yet");
  // But the question "why can I not turn this on?" is answered, rather than left to the reader.
  assert.match(html, /does not check for updates/i);
  assert.match(html, /off unless you\s+turn it on|off unless you turn it on/i);
});

test("Settings is a labelled dialog that can be left with the keyboard", async () => {
  // Opened from the topbar and dismissed with Esc; without `aria-modal` and a labelled heading it is
  // a div that happens to look like a dialog.
  const html = renderToString(createElement(Settings, { install: installFacts(), onClose() {} }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="settings-title"/);
  assert.match(html, /id="settings-title"/);
  assert.match(html, />Close</);
});
