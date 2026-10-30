/**
 * Store tests.
 *
 * The properties worth protecting: a snapshot is authoritative, focus is never stolen, the
 * composer never guesses between prompt and steer, and history is searchable by content — not
 * only by name or date (US-4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composerMode,
  contextPercent,
  fleetCounts,
  hasUnisolatedSession,
  historyIsPartial,
  focusedSession,
  initialState,
  needingAttention,
  pendingDialogCount,
  queuedMessages,
  reduce,
  scratchSessions,
  searchHistory,
  stateLabel,
  transcriptFor,
} from "../src/store.ts";
import type { HistoricalSession, LiveSession } from "@pi-central/protocol";
import { emptyTranscript, noticeIsOpen } from "../src/transcript.ts";

function live(over: Partial<LiveSession> = {}): LiveSession {
  return {
    id: "s1",
    name: "a session",
    cwd: "/tmp/a",
    state: "idle",
    mode: "sandboxed",
    isolation: "Safehouse workdir=/tmp/a",
    command: "safehouse -- pi --mode rpc",
    scratch: false,
    messageCount: 0,
    pending: 0,
    contextPercent: null,
    tokensTotal: null,
    cost: null,
    dialogs: [],
    warnings: [],
    startedAt: 0,
    ...over,
  };
}

function historical(over: Partial<HistoricalSession> = {}): HistoricalSession {
  return {
    path: "/sessions/a.jsonl",
    id: "h1",
    cwd: "/Users/x/project",
    created: "2026-01-01T00:00:00Z",
    modifiedMs: 1,
    bytes: 100,
    messageCount: 2,
    firstMessage: "hello",
    cwdExists: true,
    scratch: false,
    ...over,
  };
}

// --- Snapshot authority --------------------------------------------------------------------

test("a snapshot replaces live state wholesale", () => {
  // Merging would leave a session showing as live after the orchestrator stopped it.
  let state = initialState();
  state = reduce(state, { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "session", session: live({ id: "s2" }) });
  assert.equal(state.live.length, 2);
  state = reduce(state, { kind: "snapshot", live: [live({ id: "s2" })], history: [], historyTotal: 0, home: "/Users/x" });
  assert.deepEqual(state.live.map((s) => s.id), ["s2"]);
  assert.equal(state.ready, true);
});

test("a snapshot preserves focus when the focused session still exists", () => {
  let state = initialState();
  state = reduce(state, { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "session", session: live({ id: "s2" }) });
  assert.equal(state.focusedId, "s1");
  state = reduce(state, { kind: "snapshot", live: [live({ id: "s1" }), live({ id: "s2" })], history: [], historyTotal: 0, home: "/Users/x" });
  assert.equal(state.focusedId, "s1", "a reconnect must not move the user's view");
});

test("a snapshot refocuses when the focused session is gone", () => {
  let state = initialState();
  state = reduce(state, { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "snapshot", live: [live({ id: "s2" })], history: [], historyTotal: 0, home: "/Users/x" });
  assert.equal(state.focusedId, "s2", "focus must not point at a session that no longer exists");
});

test("a new session does not steal focus from one being read", () => {
  let state = initialState();
  state = reduce(state, { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "session", session: live({ id: "s2" }) });
  assert.equal(state.focusedId, "s1");
});

test("the first session to arrive is focused", () => {
  const state = reduce(initialState(), { kind: "session", session: live({ id: "only" }) });
  assert.equal(state.focusedId, "only");
});

// --- Session updates -----------------------------------------------------------------------

test("an update for an existing session replaces it rather than duplicating", () => {
  let state = initialState();
  state = reduce(state, { kind: "session", session: live({ id: "s1", state: "idle" }) });
  state = reduce(state, { kind: "session", session: live({ id: "s1", state: "streaming" }) });
  assert.equal(state.live.length, 1);
  assert.equal(focusedSession(state)?.state, "streaming");
});

// --- Transcripts ---------------------------------------------------------------------------

test("records accumulate per session and never cross sessions", () => {
  // Cross-talk here would show one session's output under another's name.
  let state = initialState();
  const record = (text: string) => ({
    kind: "record" as const,
    sessionId: "",
    record: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } },
  });
  state = reduce(state, { kind: "record", sessionId: "a", record: { type: "message_start", message: { role: "assistant" } } });
  state = reduce(state, { kind: "record", sessionId: "b", record: { type: "message_start", message: { role: "assistant" } } });
  state = reduce(state, { ...record("A says hello"), sessionId: "a" });
  state = reduce(state, { ...record("B says goodbye"), sessionId: "b" });

  const a = transcriptFor(state, "a");
  const b = transcriptFor(state, "b");
  assert.ok(a.messages[0]!.blocks.some((block) => block.kind === "text" && block.text.includes("A says")));
  assert.ok(b.messages[0]!.blocks.some((block) => block.kind === "text" && block.text.includes("B says")));
  assert.ok(!transcriptFor(state, "a").messages[0]!.blocks.some((block) => block.kind === "text" && block.text.includes("B ")));
});

test("a transcript for an unknown session is empty, not undefined", () => {
  const state = initialState();
  assert.deepEqual(transcriptFor(state, "nope"), emptyTranscript());
  assert.deepEqual(transcriptFor(state, undefined), emptyTranscript());
});

// --- Errors --------------------------------------------------------------------------------

test("errors accumulate newest-first and are bounded", () => {
  let state = initialState();
  for (let i = 0; i < 30; i += 1) state = reduce(state, { kind: "error", message: `e${i}` });
  assert.equal(state.errors[0], "e29");
  assert.ok(state.errors.length <= 20, `errors must be bounded, got ${state.errors.length}`);
});

// --- Selectors -----------------------------------------------------------------------------

test("needingAttention surfaces blocked and failed sessions, blocked first", () => {
  const state = {
    ...initialState(),
    live: [
      live({ id: "idle" }),
      live({ id: "failed", state: "failed" }),
      live({ id: "blocked", state: "awaiting-approval" }),
    ],
  };
  const ids = needingAttention(state).map((s) => s.id);
  assert.ok(ids.includes("blocked"));
  assert.ok(ids.includes("failed"));
  assert.ok(!ids.includes("idle"));
});

test("pendingDialogCount totals across sessions", () => {
  const state = {
    ...initialState(),
    live: [
      live({ id: "a", dialogs: [{ id: "d1", method: "confirm", receivedAt: 0 }] }),
      live({ id: "b", dialogs: [{ id: "d2", method: "select", receivedAt: 0 }, { id: "d3", method: "input", receivedAt: 0 }] }),
    ],
  };
  assert.equal(pendingDialogCount(state), 3);
});

test("scratchSessions isolates app-owned sessions (US-3)", () => {
  const state = { ...initialState(), live: [live({ id: "a", scratch: true }), live({ id: "b" })] };
  assert.deepEqual(scratchSessions(state).map((s) => s.id), ["a"]);
});

// --- Composer: never guess between prompt and steer ------------------------------------------

test("the composer picks steer while streaming, because prompt would error", () => {
  // During streaming, `prompt` requires a streamingBehavior or Pi rejects it (PROTOCOL.md).
  assert.equal(composerMode(live({ state: "streaming" })).mode, "steer");
});

test("the composer picks prompt when idle", () => {
  assert.equal(composerMode(live({ state: "idle" })).mode, "prompt");
});

test("the composer is unavailable, with a reason, in every other state", () => {
  for (const state of ["starting", "awaiting-approval", "failed", "stopped", "registered"] as const) {
    const result = composerMode(live({ state, error: state === "failed" ? "spawn failed" : undefined }));
    assert.equal(result.mode, "unavailable", `${state} should not accept a prompt`);
    assert.ok(result.reason && result.reason.length > 0, `${state} must explain why`);
  }
});

test("a failed session surfaces its actual error in the composer", () => {
  assert.equal(composerMode(live({ state: "failed", error: "EPERM" })).reason, "EPERM");
});

test("no session selected says so rather than failing silently", () => {
  assert.equal(composerMode(undefined).mode, "unavailable");
  assert.ok(composerMode(undefined).reason);
});

test("stateLabel is human, not the enum", () => {
  assert.equal(stateLabel(live({ state: "streaming" })), "working");
  assert.equal(stateLabel(live({ state: "awaiting-approval" })), "needs you");
});

test("contextPercent clamps and never fabricates a value", () => {
  assert.equal(contextPercent(live({ contextPercent: 42 })), 42);
  assert.equal(contextPercent(live({ contextPercent: null })), null);
  assert.equal(contextPercent(live({ contextPercent: 150 })), 100);
  assert.equal(contextPercent(live({ contextPercent: -5 })), 0);
  assert.equal(contextPercent(live({ contextPercent: Number.NaN })), null);
});

// --- History search (US-4) ------------------------------------------------------------------

test("history search matches content, not just name or date", () => {
  // The point of US-4: a user remembers what a session was about.
  const history = [
    historical({ id: "1", name: "fix bug", firstMessage: "the parser drops U+2028" }),
    historical({ id: "2", name: "unrelated", firstMessage: "rename a variable" }),
  ];
  const results = searchHistory(history, "u+2028");
  assert.deepEqual(results.map((s) => s.id), ["1"]);
});

test("history search ranks a name hit above a content hit", () => {
  const history = [
    historical({ id: "content", name: "zzz", firstMessage: "about safehouse", modifiedMs: 9 }),
    historical({ id: "name", name: "safehouse notes", firstMessage: "unrelated", modifiedMs: 1 }),
  ];
  assert.deepEqual(searchHistory(history, "safehouse").map((s) => s.id), ["name", "content"]);
});

test("history search matches the working directory", () => {
  const history = [historical({ id: "1", cwd: "/Users/x/widget-factory" })];
  assert.deepEqual(searchHistory(history, "widget").map((s) => s.id), ["1"]);
});

test("an empty query returns recent history rather than everything", () => {
  const history = Array.from({ length: 500 }, (_, i) => historical({ id: String(i) }));
  assert.equal(searchHistory(history, "").length, 200);
  assert.equal(searchHistory(history, "   ").length, 200, "whitespace is an empty query");
});

test("history search is case-insensitive and returns nothing when nothing matches", () => {
  const history = [historical({ name: "MixedCase" })];
  assert.equal(searchHistory(history, "mixedcase").length, 1);
  assert.equal(searchHistory(history, "absent").length, 0);
});

// --- Findings from a real screenshot (see img_1.png) -----------------------------------------

test("fleet counts label each number truthfully", () => {
  // The screenshot showed "2 running" while BOTH sessions were idle, because the label was
  // applied to `live.length`. A count is only useful if its label is true.
  const state = {
    ...initialState(),
    live: [
      live({ id: "a", state: "idle" }),
      live({ id: "b", state: "idle", scratch: true }),
    ],
  };
  const counts = fleetCounts(state);
  assert.equal(counts.total, 2);
  assert.equal(counts.running, 0, "idle sessions are not running");
  assert.equal(counts.idle, 2);
  assert.equal(counts.scratch, 1);
  assert.equal(counts.needs, 0);
});

test("only streaming and starting count as running", () => {
  const state = {
    ...initialState(),
    live: [
      live({ id: "a", state: "streaming" }),
      live({ id: "b", state: "starting" }),
      live({ id: "c", state: "idle" }),
      live({ id: "d", state: "stopped" }),
      live({ id: "e", state: "awaiting-approval" }),
      live({ id: "f", state: "failed" }),
    ],
  };
  const counts = fleetCounts(state);
  assert.equal(counts.running, 2);
  assert.equal(counts.needs, 2, "blocked and failed both need a human");
  assert.equal(counts.total, 6);
});

test("historyIsPartial distinguishes a page from the whole store", () => {
  // The rail read "500 sessions on disk" while 1115 existed, because the discovery limit was
  // presented as a total.
  const partial = { ...initialState(), history: [historical()], historyTotal: 1115 };
  assert.equal(historyIsPartial(partial), true);

  const complete = { ...initialState(), history: [historical()], historyTotal: 1 };
  assert.equal(historyIsPartial(complete), false);

  const empty = initialState();
  assert.equal(historyIsPartial(empty), false, "0 of 0 is not partial");
});

test("a snapshot carries HOME and the true history total", () => {
  // The browser cannot discover either: HOME is the orchestrator's environment, and the total
  // is known only to discovery.
  const state = reduce(initialState(), {
    kind: "snapshot",
    live: [],
    history: [historical()],
    historyTotal: 1115,
    home: "/Users/tester",
  });
  assert.equal(state.home, "/Users/tester");
  assert.equal(state.historyTotal, 1115);
  assert.equal(state.history.length, 1);
});

test("a history event updates the total, not just the page", () => {
  const state = reduce(initialState(), { kind: "history", history: [historical()], total: 42 });
  assert.equal(state.historyTotal, 42);
});

test("an unsandboxed session is detectable, so the banner can be shown", () => {
  // The banner is the only global signal that a session has the user's own account access. A
  // per-session chip in the inspector is the wrong prominence for that fact.
  const sandboxed = { ...initialState(), live: [live({ mode: "sandboxed" })] };
  assert.equal(hasUnisolatedSession(sandboxed), false);

  const mixed = { ...initialState(), live: [live({ id: "a", mode: "sandboxed" }), live({ id: "b", mode: "direct" })] };
  assert.equal(hasUnisolatedSession(mixed), true, "one direct session is enough to warn");

  assert.equal(hasUnisolatedSession(initialState()), false, "no sessions is not a warning");
});

// --- A failed history read must not look like an empty session ---------------------------------
//
// Reported: a session showed "Loading this session's history…" indefinitely. An empty conversation
// and a failed read mean opposite things, and collapsing them made the UI claim that work was in
// progress when none was.

test("a transcript error is recorded per session", () => {
  const state = reduce(initialState(), {
    kind: "transcriptError",
    sessionId: "s1",
    message: "session is not running",
  });
  assert.equal(state.transcriptErrors["s1"], "session is not running");
});

test("a successful transcript clears that session's error", () => {
  let state = reduce(initialState(), { kind: "transcriptError", sessionId: "s1", message: "boom" });
  state = reduce(state, { kind: "transcript", sessionId: "s1", messages: [{ role: "user", content: "hi" }] });
  assert.equal(state.transcriptErrors["s1"], undefined, "a later success must not leave a stale error");
  assert.equal(transcriptFor(state, "s1").messages.length, 1);
});

test("one session's error does not affect another", () => {
  let state = reduce(initialState(), { kind: "transcriptError", sessionId: "s1", message: "boom" });
  state = reduce(state, { kind: "transcript", sessionId: "s2", messages: [] });
  assert.equal(state.transcriptErrors["s1"], "boom");
  assert.equal(state.transcriptErrors["s2"], undefined);
});

// --- The model picker's derived state (issue #1) -------------------------------------------------

test("models are grouped by provider, preserving Pi's order", async () => {
  const { modelsByProvider } = await import("../src/store.ts");
  const groups = modelsByProvider([
    { provider: "openai", id: "a" },
    { provider: "openai", id: "b" },
    { provider: "anthropic", id: "c" },
    { provider: "openai", id: "d" },
  ]);
  // Consecutive runs, not a global grouping: re-sorting Pi's list would put a model somewhere the
  // user did not see it come from, and grouping is a display concern, not a reordering.
  assert.deepEqual(groups.map((g) => [g.provider, g.models.map((m) => m.id)]), [
    ["openai", ["a", "b"]],
    ["anthropic", ["c"]],
    ["openai", ["d"]],
  ]);
});

test("the current model is matched on provider AND id", async () => {
  const { isCurrentModel } = await import("../src/store.ts");
  const session = live({ model: "gpt-5", provider: "openai" });
  // The same id can exist under two providers (a proxy and the upstream), so matching on id alone
  // would mark the wrong entry as current.
  assert.equal(isCurrentModel(session, { provider: "openai", id: "gpt-5" }), true);
  assert.equal(isCurrentModel(session, { provider: "proxy", id: "gpt-5" }), false);
  assert.equal(isCurrentModel(session, { provider: "openai", id: "other" }), false);
});

test("a model change states its timing only while streaming", async () => {
  const { modelChangeTiming } = await import("../src/store.ts");
  assert.equal(modelChangeTiming(live({ state: "idle" })), "");
  assert.match(modelChangeTiming(live({ state: "streaming" })), /next turn/);
});

test("an unasked thinking-level list is 'not loaded', not 'no levels'", async () => {
  const { availableThinkingLevels, initialState } = await import("../src/store.ts");
  const fresh = availableThinkingLevels(initialState(), "s1");
  assert.deepEqual(fresh, { levels: [], loaded: false });
  // The distinction matters: rendering "no levels" for a model that simply has not been asked about
  // would be a claim about the model rather than about the attempt.
});

test("a thinking-level error is reported as an error, not as an empty list", async () => {
  const { availableThinkingLevels, initialState, reduce } = await import("../src/store.ts");
  const state = reduce(initialState(), { kind: "thinkingLevelsError", sessionId: "s1", message: "boom" });
  const result = availableThinkingLevels(state, "s1");
  assert.equal(result.error, "boom");
  assert.equal(result.loaded, true);
});

test("a successful model read clears that session's previous error", async () => {
  const { initialState, reduce } = await import("../src/store.ts");
  let state = reduce(initialState(), { kind: "modelsError", sessionId: "s1", message: "boom" });
  assert.equal(state.modelErrors["s1"], "boom");
  state = reduce(state, { kind: "models", sessionId: "s1", models: [{ provider: "p", id: "m" }] });
  // A retry that worked must not leave a stale failure on screen.
  assert.equal(state.modelErrors["s1"], undefined);
  assert.equal(state.models["s1"]?.length, 1);
});

test("a snapshot does not clobber a fetched catalogue", async () => {
  // The catalogue is request-shaped and deliberately not part of `LiveSession`, so an authoritative
  // snapshot must leave it alone: it is a fact about the provider configuration, not session state.
  const { initialState, reduce } = await import("../src/store.ts");
  let state = reduce(initialState(), { kind: "models", sessionId: "s1", models: [{ provider: "p", id: "m" }] });
  state = reduce(state, {
    kind: "snapshot",
    live: [live({ id: "s1" })],
    history: [],
    historyTotal: 0,
    home: "/Users/x",
  });
  assert.equal(state.models["s1"]?.length, 1);
});

// --- Steer, follow-up and queue restoration (issue #3) -------------------------------------------

test("the composer defaults to steer while streaming, matching Pi's own Enter binding", () => {
  // Pi's interactive mode sends a plain Enter mid-run as a steer and Alt+Enter as a follow-up
  // (`interactive-mode.js`). Defaulting to the same one means the familiar gesture does the
  // familiar thing; the strip states the consequence either way, so this is not a hidden default.
  assert.equal(composerMode(live({ state: "streaming" })).mode, "steer");
});

test("a queue_update replaces the whole queue rather than appending to it", () => {
  // Pi sends the entire queue every time, so appending would grow it without bound and show
  // duplicates of every message.
  let state = reduce(initialState(), { kind: "queue", sessionId: "s1", steering: ["one"], followUp: [] });
  state = reduce(state, { kind: "queue", sessionId: "s1", steering: ["two"], followUp: ["later"] });
  assert.deepEqual(state.queues["s1"], { steering: ["two"], followUp: ["later"] });
});

test("an emptied queue_update clears the strip's rows", () => {
  let state = reduce(initialState(), { kind: "queue", sessionId: "s1", steering: ["one"], followUp: [] });
  state = reduce(state, { kind: "queue", sessionId: "s1", steering: [], followUp: [] });
  const queued = queuedMessages(state, live({ pending: 0 }));
  assert.deepEqual(queued.steering, []);
  assert.equal(queued.textsKnown, true);
});

test("queueCleared empties the queue AND hands the texts to the composer in one transition", () => {
  // Both in one reduce call so the composer can never observe the texts as "still queued" and
  // "not yet restored" at the same time.
  let state = reduce(initialState(), { kind: "queue", sessionId: "s1", steering: ["a"], followUp: ["b"] });
  state = reduce(state, { kind: "queueCleared", sessionId: "s1", steering: ["a"], followUp: ["b"] });
  assert.deepEqual(queuedMessages(state, live({ pending: 0 })).steering, []);
  assert.deepEqual(state.restoredQueue["s1"], ["a", "b"]);
});

test("the cleared text is taken back exactly once", () => {
  // `onRestored` clears the field so the merge effect cannot run twice on the same texts, which
  // would duplicate everything the user had queued.
  let state = reduce(initialState(), { kind: "queueCleared", sessionId: "s1", steering: ["a"], followUp: [] });
  assert.deepEqual(state.restoredQueue["s1"], ["a"]);
  state = reduce(state, { kind: "queueRestored", sessionId: "s1" });
  assert.deepEqual(state.restoredQueue["s1"], undefined);
});

test("a queue count with no texts is reported as unknown rather than invented", () => {
  // After a reconnect a snapshot carries `pending` but records are not replayed, so the texts are
  // genuinely absent. Fabricating a row would claim to know what the user typed.
  const state = { ...initialState(), live: [live({ pending: 2 })] };
  const queued = queuedMessages(state, state.live[0]);
  assert.equal(queued.total, 2);
  assert.equal(queued.textsKnown, false);
  assert.deepEqual(queued.steering, []);
});

test("a queue whose texts account for the count is known", () => {
  let state = { ...initialState(), live: [live({ pending: 2 })] };
  state = reduce(state, { kind: "queue", sessionId: "s1", steering: ["a"], followUp: ["b"] });
  assert.equal(queuedMessages(state, state.live[0]).textsKnown, true);
});

test("a local queueRestored action cannot be mistaken for a protocol event", () => {
  // The two unions are separate because their sources differ in trust: an Event arrives over the
  // socket, this is produced by a component. `reduce` narrows on the kind, and no protocol event
  // is named `queueRestored`, so a server message can never be routed into local handling.
  const before = initialState();
  const after = reduce(before, { kind: "queueRestored", sessionId: "nothing-was-restored" });
  assert.deepEqual(after.restoredQueue, {});
  assert.equal(after.live, before.live);
});


// --- The installation root reaches the UI (issue #25) --------------------------------------------

test("a snapshot carries the installation root, so the sheet can warn without a session", () => {
  // The sheet warns BEFORE any session exists, so the fact cannot come from a `LiveSession`. It
  // comes from the snapshot, and must be `undefined` rather than invented when the orchestrator
  // could not identify its own root.
  const known = reduce(initialState(), {
    kind: "snapshot",
    live: [],
    history: [],
    historyTotal: 0,
    home: "/Users/x",
    installationRoot: "/Users/x/git/pi-central",
  });
  assert.equal(known.installationRoot, "/Users/x/git/pi-central");

  const unknown = reduce(initialState(), {
    kind: "snapshot",
    live: [],
    history: [],
    historyTotal: 0,
    home: "/Users/x",
  });
  assert.equal(unknown.installationRoot, undefined, "unknown must stay unknown, not become safe");
});

test("a later snapshot can update the root, since it is authoritative", () => {
  let state = reduce(initialState(), {
    kind: "snapshot", live: [], history: [], historyTotal: 0, home: "/Users/x",
    installationRoot: "/old/checkout",
  });
  state = reduce(state, {
    kind: "snapshot", live: [], history: [], historyTotal: 0, home: "/Users/x",
    installationRoot: "/new/checkout",
  });
  assert.equal(state.installationRoot, "/new/checkout");
});

test("a compaction record reaching the store produces a notice, end to end", () => {
  // The reducer is tested directly in transcript.test.ts, but that does not prove the record ever
  // ARRIVES: the store only folds types it recognises, and a notice is useless if the plumbing drops
  // it. This drives the store with the wire event, which is what actually happens.
  let state = reduce(initialState(), { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, {
    kind: "record",
    sessionId: "s1",
    record: { type: "compaction_start", reason: "overflow" },
  });
  const notices = state.transcripts["s1"]?.notices ?? [];
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.kind, "compaction");
  assert.equal(noticeIsOpen(notices[0]!), true);
});

// --- Focusing another session (the rail's entire purpose) ----------------------------------------

test("focusSession moves the focus to the named session", () => {
  // The bug this exists for: the rail dispatched a `session` event to switch sessions, and that
  // event is an UPSERT whose focus rule is `state.focusedId ?? event.session.id` — "focus a NEWLY
  // STARTED session, but never steal focus from one the user is reading". With focus already set,
  // it keeps the OLD id, so clicking a rail row updated the row's data and changed nothing visible.
  let state = reduce(initialState(), { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "session", session: live({ id: "s2" }) });
  assert.equal(state.focusedId, "s1", "the first session keeps focus, as designed");

  state = reduce(state, { kind: "focusSession", sessionId: "s2" });
  assert.equal(state.focusedId, "s2", "an explicit focus request must move the focus");
  assert.equal(focusedSession(state)?.id, "s2");
});

test("focusSession does NOT touch the session list", () => {
  // The separation that makes this safe: focusing is a view change, while `session` events carry
  // data from the orchestrator. Routing focus through the data event is what caused the bug, so
  // this action must not be able to mutate a session at all.
  let state = reduce(initialState(), { kind: "session", session: live({ id: "s1" }) });
  const before = state.live;
  state = reduce(state, { kind: "focusSession", sessionId: "s1" });
  assert.equal(state.live, before, "the live array must be the same reference, untouched");
});

test("focusSession ignores a session that is not live", () => {
  // Focus and presence are different facts. Focusing a session the UI does not have would make
  // `focusedSession` return undefined and blank the main column — a worse outcome than ignoring
  // the request, and reachable by clicking a row for a session that was stopped concurrently.
  let state = reduce(initialState(), { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "focusSession", sessionId: "ghost" });
  assert.equal(state.focusedId, "s1", "an unknown id must not clear the focus");
  assert.equal(focusedSession(state)?.id, "s1");
});

test("a local focus action is routed locally, never as a protocol event", () => {
  // `reduce` narrows on `kind` before delegating to `applyEvent`, so a local action whose name
  // collided with a server event would be swallowed. The direction that matters is this one: an
  // unknown kind falls through to `applyEvent`, which ignores it — so a focus request sent as an
  // unrecognized EVENT would silently do nothing, which is the bug class this whole change is about.
  let base = reduce(initialState(), { kind: "session", session: live({ id: "s1" }) });
  // Both must be live first, or the presence guard (correctly) refuses the focus and the test would
  // be asserting the guard rather than the routing.
  base = reduce(base, { kind: "session", session: live({ id: "s2" }) });
  const viaEvent = reduce(base, { kind: "session", session: live({ id: "s2" }) });
  assert.equal(viaEvent.focusedId, "s1", "a session EVENT must not move focus (its own rule)");
  const viaLocal = reduce(base, { kind: "focusSession", sessionId: "s2" });
  assert.equal(viaLocal.focusedId, "s2", "the local action must move it");
});

test("switching focus preserves the other session's transcript", () => {
  // DESIGN §Shortcuts: "the previous session's transcript and draft stay in memory (switch back is
  // instant)". A focus change that rebuilt or dropped transcripts would make switching lossy.
  let state = reduce(initialState(), { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "session", session: live({ id: "s2" }) });
  state = reduce(state, { kind: "record", sessionId: "s1", record: { type: "message_start", message: { role: "assistant" } } });
  state = reduce(state, { kind: "focusSession", sessionId: "s2" });
  assert.equal(state.transcripts["s1"]?.messages.length, 1, "s1's transcript must survive the switch");
  state = reduce(state, { kind: "focusSession", sessionId: "s1" });
  assert.equal(state.transcripts["s1"]?.messages.length, 1, "and still be there when switching back");
});

// --- Facts about the installation (issue #58) ----------------------------------------------------

test("a snapshot carries the installation facts into the state", () => {
  // The Settings surface renders from `state.install`, so the snapshot is the only source. A reducer
  // that dropped the field would leave Settings permanently at "not reported" while the orchestrator
  // was sending the answer — a surface that always looks broken.
  const state = reduce(initialState(), {
    kind: "snapshot",
    live: [],
    history: [],
    historyTotal: 0,
    home: "/Users/x",
    install: {
      version: "9.9.9-witness",
      protocol: 4242,
      sessionsRoot: "/s",
      workspaceRoot: "/w",
      agentRoot: "/a",
      agentRootManaged: false,
    },
  });
  assert.equal(state.install?.version, "9.9.9-witness");
  assert.equal(state.install?.protocol, 4242);
  assert.equal(state.install?.agentRootManaged, false);
});

test("installation facts are absent until a snapshot arrives, and are NOT invented", () => {
  // The state an orchestrator older than the field produces. `undefined` is the honest value; a
  // default like `{ version: "unknown" }` would make "the orchestrator did not say" indistinguishable
  // from "the orchestrator said unknown", which are different facts.
  assert.equal(initialState().install, undefined);
});

test("a snapshot that omits the facts CLEARS them, because a snapshot is authoritative", () => {
  // The rule store.ts states at the top, applied to this field: a snapshot replaces rather than
  // merges. If it merged, reconnecting to an older orchestrator would keep showing the previous
  // orchestrator's version — a stale claim about which build is running, which is the one thing this
  // surface exists to answer.
  const withFacts = reduce(initialState(), {
    kind: "snapshot",
    live: [],
    history: [],
    historyTotal: 0,
    home: "/Users/x",
    install: {
      version: "9.9.9-witness",
      protocol: 4242,
      sessionsRoot: "/s",
      workspaceRoot: "/w",
      agentRoot: "/a",
      agentRootManaged: true,
    },
  });
  assert.ok(withFacts.install, "precondition: the first snapshot set them");
  const afterOlder = reduce(withFacts, {
    kind: "snapshot",
    live: [],
    history: [],
    historyTotal: 0,
    home: "/Users/x",
  });
  assert.equal(afterOlder.install, undefined, "a snapshot without the facts must not retain older ones");
});

// --- The session you asked for becomes the active one (issue #144) -------------------------------

test("starting a session while another is focused focuses the NEW one", () => {
  // The report, verbatim: "When I open a session (from the history or from scratch), it is not made the
  // active one in the transcript window. That leads to confusion, and I started to type prompts into the
  // wrong conversation."
  //
  // The `session` event's rule is `focusedId ?? newId` — "never steal focus from a session the reader is
  // reading". That rule is correct and stays. The missing piece was intent: nothing distinguished "a
  // session appeared" from "the session I just asked for appeared", so with anything already focused the
  // new one opened invisibly.
  let state = reduce(initialState(), { kind: "session", session: live({ id: "s1" }) });
  assert.equal(state.focusedId, "s1");

  // The reader clicks "New session": intent is recorded, then the control goes out.
  state = reduce(state, { kind: "expectNewSession" });
  state = reduce(state, { kind: "session", session: live({ id: "s2" }) });

  assert.equal(state.focusedId, "s2", "the session the reader asked for must become active");
  assert.equal(focusedSession(state)?.id, "s2");
});

test("an UNREQUESTED session still never steals focus", () => {
  // The original rule must survive, or this fix trades one bug for a worse one: a background broadcast
  // pulling the reader out of what they are reading. A session that appears without `expectNewSession` is
  // exactly the case the `??` was protecting.
  let state = reduce(initialState(), { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "session", session: live({ id: "s9" }) });
  assert.equal(state.focusedId, "s1", "a session appearing on its own must not move the view");
});

test("the intent is consumed once, so it cannot redirect a LATER session", () => {
  // A flag that stays set would make every subsequent new session jump the view — turning a one-shot
  // request into "the view follows any new process forever". It is cleared by the first NEW session.
  let state = reduce(initialState(), { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "expectNewSession" });
  state = reduce(state, { kind: "session", session: live({ id: "s2" }) });
  assert.equal(state.focusedId, "s2");

  state = reduce(state, { kind: "session", session: live({ id: "s3" }) });
  assert.equal(state.focusedId, "s2", "the second new session must NOT pull focus again");
});

test("a broadcast about an EXISTING session does not consume the intent", () => {
  // `session` is an upsert, so it also fires for routine updates to a session already in the list. If that
  // consumed the flag, a heartbeat landing between the intent and the new session would swallow it — the
  // original bug, intermittently.
  let state = reduce(initialState(), { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "expectNewSession" });
  // An update to the session the reader is already looking at.
  state = reduce(state, { kind: "session", session: live({ id: "s1", state: "streaming" }) });

  // Asserting the FLAG is the point, not `focusedId`. A first version checked only `focusedId`, and that
  // could not fail: the stray event here is about `s1`, which is already focused, so "focus s1" is a no-op
  // and the assertion held even with the `arrived` guard removed. The flag is the thing that distinguishes
  // a consumed intent from a surviving one.
  assert.equal(state.focusNextNewSession, true, "the intent must survive an update to an existing session");

  state = reduce(state, { kind: "session", session: live({ id: "s2" }) });
  assert.equal(state.focusedId, "s2", "…and still apply to the session that actually arrives");
});

test("a failed start does not leave the intent armed", () => {
  // If the orchestrator refuses, no `session` event arrives. The flag must not sit there waiting to
  // redirect an unrelated session minutes later.
  let state = reduce(initialState(), { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "expectNewSession" });
  state = reduce(state, { kind: "error", message: "could not start: port in use" });
  assert.equal(state.focusedId, "s1", "focus must not move on an error");
  assert.equal(state.focusNextNewSession, false, "…and the intent must be spent, not left armed");
});

test("an update to ANOTHER existing session must not consume the intent", () => {
  // The case the `arrived` guard exists for, and the one my first attempt could not see: with two sessions
  // live and the reader focused on s1, a routine `session` broadcast about s2 while the intent is armed
  // would — without the guard — move focus to s2 and swallow the request. That is worse than the original
  // bug, because it takes the reader somewhere they never asked to go.
  let state = reduce(initialState(), { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "snapshot", live: [live({ id: "s1" }), live({ id: "s2" })], history: [], historyTotal: 0, home: "/Users/x" });
  assert.equal(state.focusedId, "s1");

  state = reduce(state, { kind: "expectNewSession" });
  // A heartbeat about the OTHER session, which is not the one the reader is waiting for.
  state = reduce(state, { kind: "session", session: live({ id: "s2", state: "streaming" }) });

  assert.equal(state.focusedId, "s1", "an unrelated update must not move the view");
  assert.equal(state.focusNextNewSession, true, "…nor consume the pending request");

  // …and the request still applies when its session finally arrives.
  state = reduce(state, { kind: "session", session: live({ id: "s3" }) });
  assert.equal(state.focusedId, "s3");
});
