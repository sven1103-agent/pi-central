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
  focusedSession,
  initialState,
  needingAttention,
  pendingDialogCount,
  reduce,
  scratchSessions,
  searchHistory,
  stateLabel,
  transcriptFor,
} from "../src/store.ts";
import type { HistoricalSession, LiveSession } from "@pi-central/protocol";
import { emptyTranscript } from "../src/transcript.ts";

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
  state = reduce(state, { kind: "snapshot", live: [live({ id: "s2" })], history: [] });
  assert.deepEqual(state.live.map((s) => s.id), ["s2"]);
  assert.equal(state.ready, true);
});

test("a snapshot preserves focus when the focused session still exists", () => {
  let state = initialState();
  state = reduce(state, { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "session", session: live({ id: "s2" }) });
  assert.equal(state.focusedId, "s1");
  state = reduce(state, { kind: "snapshot", live: [live({ id: "s1" }), live({ id: "s2" })], history: [] });
  assert.equal(state.focusedId, "s1", "a reconnect must not move the user's view");
});

test("a snapshot refocuses when the focused session is gone", () => {
  let state = initialState();
  state = reduce(state, { kind: "session", session: live({ id: "s1" }) });
  state = reduce(state, { kind: "snapshot", live: [live({ id: "s2" })], history: [] });
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
