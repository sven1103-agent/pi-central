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
let SessionRail, ToolTrace, DialogDock, TranscriptView, HistoryView, Composer, initialState;

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
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
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
