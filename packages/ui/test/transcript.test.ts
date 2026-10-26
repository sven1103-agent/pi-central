/**
 * Transcript reducer tests.
 *
 * These matter more than most UI tests. Streaming reconstruction is where a subtle bug
 * produces *plausible* wrong output — duplicated text, a stale partial, a spinner that never
 * stops — rather than an obvious failure. Every rule from docs/json.md is covered here,
 * including the ones that are easy to get backwards (append vs replace).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRecord,
  assistantText,
  emptyTranscript,
  hasProse,
  noticeIsOpen,
  planTranscript,
  seedTranscript,
  type RunNotice,
  type Transcript,
} from "../src/transcript.ts";

/** Fold records, starting from empty. */
function fold(records: Record<string, unknown>[]): Transcript {
  return records.reduce<Transcript>(applyRecord, emptyTranscript());
}

/** Build a `message_update` with a nested assistant event. */
function update(event: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "message_update", assistantMessageEvent: event, ...extra };
}

// --- Deltas append, ends replace (the rule most easily inverted) ---------------------------

test("text_delta appends across many updates", () => {
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_start", contentIndex: 0 }),
    update({ type: "text_delta", contentIndex: 0, delta: "Hello" }),
    update({ type: "text_delta", contentIndex: 0, delta: ", " }),
    update({ type: "text_delta", contentIndex: 0, delta: "world" }),
  ]);
  assert.equal(assistantText(t.messages[0]!), "Hello, world");
});

test("text_end REPLACES rather than appending (would otherwise double the text)", () => {
  // The delta stream already contributed these characters. Appending `content` would produce
  // "HelloHello, world".
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_delta", contentIndex: 0, delta: "Hello" }),
    update({ type: "text_delta", contentIndex: 0, delta: ", world" }),
    update({ type: "text_end", contentIndex: 0, content: "Hello, world" }),
  ]);
  assert.equal(assistantText(t.messages[0]!), "Hello, world");
});

test("text_end with corrected content wins over the deltas", () => {
  // Providers sometimes finalize with content that differs from the streamed deltas.
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_delta", contentIndex: 0, delta: "teh" }),
    update({ type: "text_end", contentIndex: 0, content: "the" }),
  ]);
  assert.equal(assistantText(t.messages[0]!), "the");
});

test("thinking is a separate block from text at the same contentIndex space", () => {
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "thinking_start", contentIndex: 0 }),
    update({ type: "thinking_delta", contentIndex: 0, delta: "let me think" }),
    update({ type: "thinking_end", contentIndex: 0, content: "let me think" }),
    update({ type: "text_start", contentIndex: 1 }),
    update({ type: "text_delta", contentIndex: 1, delta: "answer" }),
  ]);
  const blocks = t.messages[0]!.blocks;
  assert.equal(blocks[0]?.kind, "thinking");
  assert.equal(blocks[1]?.kind, "text");
  assert.equal(assistantText(t.messages[0]!), "answer", "thinking must not leak into the answer text");
});

test("interleaved blocks are addressed by contentIndex, not by arrival order", () => {
  // A delta arriving for block 1 before block 0 finishes must not be misrouted.
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_delta", contentIndex: 0, delta: "first" }),
    update({ type: "thinking_delta", contentIndex: 2, delta: "third" }),
    update({ type: "text_delta", contentIndex: 1, delta: "second" }),
  ]);
  const blocks = t.messages[0]!.blocks;
  assert.equal(blocks.length, 3, `expected a block per index, got ${blocks.length}`);
  assert.equal((blocks[1] as { text: string }).text, "second");
  assert.equal((blocks[2] as { text: string }).text, "third");
});

// --- Authoritative replacement at message_end ---------------------------------------------

test("message_end replaces the whole partial message", () => {
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_delta", contentIndex: 0, delta: "partial" }),
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "the final answer" }] },
    },
  ]);
  assert.equal(t.messages.length, 1, "must replace, not append a second message");
  assert.equal(assistantText(t.messages[0]!), "the final answer");
  assert.equal(t.messages[0]!.complete, true);
  assert.equal(t.messages[0]!.streaming, false);
});

test("message_end with empty content does not erase a streamed message", () => {
  // A `message_end` whose content failed to serialize must not blank the transcript.
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_delta", contentIndex: 0, delta: "keep me" }),
    { type: "message_end", message: { role: "assistant", content: [] } },
  ]);
  assert.equal(assistantText(t.messages[0]!), "keep me");
  assert.equal(t.messages[0]!.complete, true);
});

test("a new message_start stops the previous message streaming", () => {
  // Otherwise a spinner stays on a message that will never receive another delta.
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_delta", contentIndex: 0, delta: "one" }),
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_delta", contentIndex: 0, delta: "two" }),
  ]);
  assert.equal(t.messages.length, 2);
  assert.equal(t.messages[0]!.streaming, false);
  assert.equal(t.messages[1]!.streaming, true);
});

test("a message_end for an unknown message is appended rather than dropped", () => {
  // Happens when a session is resumed mid-stream and the start was never seen.
  const t = fold([
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "unseen" }] } },
  ]);
  assert.equal(t.messages.length, 1);
  assert.equal(assistantText(t.messages[0]!), "unseen");
});

// --- Tool calls ---------------------------------------------------------------------------

test("toolcall args accumulate from deltas, then the end value replaces them", () => {
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "read" }),
    update({ type: "toolcall_delta", contentIndex: 0, delta: '{"pa' }),
    update({ type: "toolcall_delta", contentIndex: 0, delta: 'th":"/x"}' }),
    update({ type: "toolcall_end", contentIndex: 0, toolCall: { id: "c1", name: "read", input: { path: "/x" } } }),
  ]);
  const block = t.messages[0]!.blocks[0];
  assert.equal(block?.kind, "toolcall");
  assert.equal(block?.kind === "toolcall" && block.name, "read");
  assert.equal(block?.kind === "toolcall" && block.complete, true);
  assert.deepEqual(block?.kind === "toolcall" && block.args, { path: "/x" });
});

test("a toolcall_end without a start still produces a usable block", () => {
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "toolcall_end", contentIndex: 0, toolCall: { id: "c9", name: "bash", input: { command: "ls" } } }),
  ]);
  const block = t.messages[0]!.blocks[0];
  assert.equal(block?.kind === "toolcall" && block.name, "bash");
});

// --- Tool execution -----------------------------------------------------------------------

test("tool executions are correlated by toolCallId, even when interleaved", () => {
  // Two parallel tool calls: keying by position or name would cross their results.
  const t = fold([
    { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "/a" } },
    { type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "/b" } },
    { type: "tool_execution_end", toolCallId: "b", toolName: "read", result: "B RESULT", isError: false },
    { type: "tool_execution_end", toolCallId: "a", toolName: "read", result: "A RESULT", isError: false },
  ]);
  const a = t.tools.find((tool) => tool.toolCallId === "a");
  const b = t.tools.find((tool) => tool.toolCallId === "b");
  assert.equal(a?.result, "A RESULT", "results must not be swapped between parallel calls");
  assert.equal(b?.result, "B RESULT");
  assert.equal(a?.running, false);
});

test("a partial tool result is shown while the tool runs", () => {
  const t = fold([
    { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} },
    { type: "tool_execution_update", toolCallId: "a", partialResult: "line 1\n" },
    { type: "tool_execution_update", toolCallId: "a", partialResult: "line 1\nline 2\n" },
  ]);
  assert.equal(t.tools[0]!.result, "line 1\nline 2\n");
  assert.equal(t.tools[0]!.running, true, "still running until tool_execution_end");
});

test("tool failure is recorded as an error, not as success", () => {
  const t = fold([
    { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: "boom", isError: true, durationMs: 12 },
  ]);
  assert.equal(t.tools[0]!.isError, true);
  assert.equal(t.tools[0]!.durationMs, 12);
});

test("an end with no matching start is recorded rather than dropped", () => {
  // A resumed session may show the result of a tool call whose start was never streamed.
  const t = fold([
    { type: "tool_execution_end", toolCallId: "orphan", toolName: "read", result: "content", isError: false },
  ]);
  assert.equal(t.tools.length, 1);
  assert.equal(t.tools[0]!.result, "content");
  assert.equal(t.tools[0]!.running, false);
});

test("structured tool results are normalized to text", () => {
  const cases: [unknown, string][] = [
    ["plain", "plain"],
    [{ text: "from text" }, "from text"],
    [{ output: "from output" }, "from output"],
    [{ content: [{ type: "text", text: "from content" }] }, "from content"],
    [[{ type: "text", text: "a" }, { type: "text", text: "b" }], "a\nb"],
    [undefined, ""],
    [null, ""],
  ];
  for (const [input, expected] of cases) {
    const t = fold([{ type: "tool_execution_end", toolCallId: "x", toolName: "t", result: input }]);
    assert.equal(t.tools[0]!.result, expected, `for ${JSON.stringify(input)}`);
  }
});

// --- Lifecycle: agent_end is NOT completion (C8) -------------------------------------------

test("agent_end does not mark anything complete (C8)", () => {
  // `agent_end` closes one low-level run; retries, compaction recovery, steering and
  // follow-ups can still continue. Treating it as completion is the documented trap.
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_delta", contentIndex: 0, delta: "working" }),
    { type: "agent_end", messages: [], willRetry: true },
  ]);
  assert.equal(t.messages[0]!.streaming, true, "agent_end must not stop the stream indicator");
  assert.equal(t.messages[0]!.complete, false, "agent_end must not mark the message complete");
});

test("agent_settled is recorded but does not fabricate transcript content", () => {
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_delta", contentIndex: 0, delta: "done" }),
    { type: "agent_settled", aborted: false },
  ]);
  assert.equal(t.lastRecordType, "agent_settled");
  assert.equal(assistantText(t.messages[0]!), "done");
});

test("unknown record types are tallied without altering the transcript", () => {
  const before = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_delta", contentIndex: 0, delta: "x" }),
  ]);
  const after = applyRecord(before, { type: "some_future_event", payload: 1 });
  assert.equal(after.messages.length, before.messages.length);
  assert.equal(assistantText(after.messages[0]!), "x");
  assert.equal(after.lastRecordType, "some_future_event");
});

// --- Provider errors ----------------------------------------------------------------------

test("a provider stream error becomes visible text, not a silent stop", () => {
  const t = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_delta", contentIndex: 0, delta: "partial" }),
    update({ type: "error", contentIndex: 0, reason: "rate limited" }),
  ]);
  const text = assistantText(t.messages[0]!);
  assert.ok(text.includes("partial"), text);
  assert.ok(text.includes("rate limited"), `the error must be visible to the user: ${text}`);
});

// --- Purity -------------------------------------------------------------------------------

test("applyRecord does not mutate its input", () => {
  // React relies on reference identity to decide what re-rendered; mutation would break it.
  const before = fold([
    { type: "message_start", message: { role: "assistant" } },
    update({ type: "text_delta", contentIndex: 0, delta: "one" }),
  ]);
  const snapshot = JSON.stringify(before);
  applyRecord(before, update({ type: "text_delta", contentIndex: 0, delta: "two" }));
  assert.equal(JSON.stringify(before), snapshot, "the original transcript was mutated");
});

test("malformed records do not throw", () => {
  // Frames come from a child process; a truncated or unexpected one must not crash the UI.
  const hostile: Record<string, unknown>[] = [
    {},
    { type: "message_update" },
    { type: "message_update", assistantMessageEvent: null },
    { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
    { type: "message_start" },
    { type: "message_end" },
    { type: "message_end", message: "not an object" },
    { type: "tool_execution_end" },
    { type: "text_delta" },
  ];
  for (const record of hostile) {
    assert.doesNotThrow(() => applyRecord(emptyTranscript(), record), `threw on ${JSON.stringify(record)}`);
  }
});

test("a delta with no preceding message_start is ignored rather than crashing", () => {
  const t = fold([update({ type: "text_delta", contentIndex: 0, delta: "orphan" })]);
  assert.equal(t.messages.length, 0);
});

// --- Findings from a real session file (img_2.png) --------------------------------------------
//
// The shapes below are copied from an actual 2169-message session. They are the reason a resumed
// session rendered an EMPTY transcript, and the reason tool calls and tool results vanished.
// Three separate mismatches, all silent:
//
//   Pi's content block is `toolCall` (camelCase)  -- the code matched `tool_use` / `tool_call`
//   a user message's content may be a plain STRING -- the code required an array
//   tool results are their own message ROLE        -- the code only knew text and thinking

test("a toolCall block (Pi's camelCase) becomes a tool block, not nothing", () => {
  // 1121 of these exist in one real session. Matching only snake_case dropped every one.
  const t = fold([
    { type: "message_end", message: { role: "assistant", content: [
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
    ] } },
  ]);
  const block = t.messages[0]!.blocks[0];
  assert.equal(block?.kind, "toolcall", "a camelCase toolCall must be recognised");
  assert.equal(block?.kind === "toolcall" && block.name, "bash");
  assert.deepEqual(block?.kind === "toolcall" && block.args, { command: "npm test" });
});

test("a toolCall's payload is `arguments`, not `input`", () => {
  const t = fold([
    { type: "message_end", message: { role: "assistant", content: [
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } },
    ] } },
  ]);
  const block = t.messages[0]!.blocks[0];
  assert.deepEqual(block?.kind === "toolcall" && block.args, { path: "/x" });
});

test("a user message whose content is a plain string is not rendered empty", () => {
  // Two of these exist in the real session, and both rendered as blank turns.
  const t = fold([{ type: "message_end", message: { role: "user", content: "fix the parser" } }]);
  assert.equal(t.messages.length, 1);
  assert.equal(assistantText(t.messages[0]!), "fix the parser");
  assert.equal(t.messages[0]!.role, "user");
});

test("a toolResult message becomes a tool frame, not a chat turn", () => {
  // 1120 of these in one real session. They are output the model did not author, so they belong
  // in the hatched quarantine rather than captioned "toolResult" as if it were prose.
  const t = fold([
    { type: "message_end", message: {
      role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false,
      content: [{ type: "text", text: "PASS 14 tests" }],
    } },
  ]);
  assert.equal(t.messages.length, 0, "a tool result is not a chat message");
  assert.equal(t.tools.length, 1);
  assert.equal(t.tools[0]!.toolName, "bash");
  assert.equal(t.tools[0]!.result, "PASS 14 tests");
  assert.equal(t.tools[0]!.running, false);
});

test("a failed toolResult is marked as an error", () => {
  const t = fold([
    { type: "message_end", message: {
      role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true,
      content: [{ type: "text", text: "boom" }],
    } },
  ]);
  assert.equal(t.tools[0]!.isError, true);
});

test("a bashExecution message becomes a tool frame with its command", () => {
  // A direct shell command is not an LLM tool result, but it is the same thing to a reader.
  const t = fold([
    { type: "message_end", message: { role: "bashExecution", command: "ls -la", output: "total 0", exitCode: 0 } },
  ]);
  assert.equal(t.tools.length, 1);
  assert.equal(t.tools[0]!.toolName, "bash");
  assert.equal(t.tools[0]!.result, "total 0");
  assert.deepEqual(t.tools[0]!.args, { command: "ls -la" });
});

test("system messages are not rendered as conversation", () => {
  // The initial prompt plus tool declarations; two of them can exceed the whole exchange.
  const t = fold([
    { type: "message_end", message: { role: "system", content: "You are a coding agent…" } },
    { type: "message_end", message: { role: "user", content: "hi" } },
  ]);
  assert.equal(t.messages.length, 1);
  assert.equal(t.messages[0]!.role, "user");
});

test("image blocks are skipped rather than rendered as garbage", () => {
  // No image viewer exists, and 3 of these are in the real session.
  const t = fold([
    { type: "message_end", message: { role: "user", content: [
      { type: "text", text: "look at this" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ] } },
  ]);
  assert.equal(t.messages[0]!.blocks.length, 1);
  assert.equal(assistantText(t.messages[0]!), "look at this");
  assert.ok(!JSON.stringify(t).includes("iVBORw0KGgo"), "base64 image data must not leak into the transcript");
});

test("an unknown role does not become a literal label", () => {
  const t = fold([{ type: "message_end", message: { role: "someFutureRole", content: "x" } }]);
  assert.equal(t.messages[0]!.role, "assistant");
});

// --- Seeding a resumed session's history -------------------------------------------------------

test("seedTranscript renders a full conversation in order", () => {
  // What a resumed session needs: Pi does not re-emit history as events, so the UI asks for it.
  const t = seedTranscript([
    { role: "user", content: "first question" },
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "output" }] },
    { role: "user", content: "second question" },
  ]);
  assert.deepEqual(t.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(assistantText(t.messages[0]!), "first question");
  assert.equal(assistantText(t.messages[1]!), "first answer");
  assert.equal(assistantText(t.messages[2]!), "second question");
  assert.equal(t.tools.length, 1, "the tool result landed as a frame, in place");
});

test("seeded history is marked complete, so nothing looks like it is still streaming", () => {
  const t = seedTranscript([{ role: "assistant", content: [{ type: "text", text: "done long ago" }] }]);
  assert.equal(t.messages[0]!.complete, true);
  assert.equal(t.messages[0]!.streaming, false, "history must not show a spinner");
});

test("seeding an empty or malformed history yields an empty transcript, not a crash", () => {
  for (const input of [[], [null], [undefined], ["a string"], [42]]) {
    assert.doesNotThrow(() => seedTranscript(input as unknown[]), `threw on ${JSON.stringify(input)}`);
  }
  assert.equal(seedTranscript([]).messages.length, 0);
});

test("a failed response with EMPTY content is not rendered as a blank turn", () => {
  // All 10 empty-content messages in a real session carry stopReason error/aborted plus an
  // errorMessage, so rendering them blank hid a provider failure completely.
  const t = fold([
    { type: "message_end", message: {
      role: "assistant", content: [], stopReason: "error",
      errorMessage: "rate limit exceeded",
    } },
  ]);
  const text = assistantText(t.messages[0]!);
  assert.ok(text.length > 0, "an empty-content failure must still say something");
  assert.match(text, /did not complete/);
  assert.match(text, /rate limit exceeded/, "the provider's own message must survive");
});

test("an aborted response says it was interrupted", () => {
  const t = fold([
    { type: "message_end", message: {
      role: "assistant", content: [], stopReason: "aborted", errorMessage: "user aborted",
    } },
  ]);
  assert.match(assistantText(t.messages[0]!), /interrupted/);
});

test("a normal completion adds no failure note", () => {
  const t = fold([
    { type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "all good" }], stopReason: "stop",
    } },
  ]);
  assert.equal(assistantText(t.messages[0]!), "all good");
});

test("a partial response keeps its text AND gains the failure note", () => {
  // The common real case: some text streamed, then the provider failed.
  const t = fold([
    { type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "I started to explain" }],
      stopReason: "error", errorMessage: "connection reset",
    } },
  ]);
  const text = assistantText(t.messages[0]!);
  assert.match(text, /I started to explain/, "the partial answer must not be lost");
  assert.match(text, /connection reset/, "and the failure must be visible");
});

// --- The transcript plan: prose first, tools as markers (the reported bug) ---------------------
//
// Reported from real use: "the tools are all pushed to the end of the conversation history, which
// makes it impossible to read the actual agent output". Tools happen BETWEEN messages, so they
// are planned into position rather than appended.

test("tools are interleaved by position, not appended at the end", () => {
  // Build: user, assistant(text), tool, assistant(text), tool, assistant(text).
  const t = fold([
    { type: "message_end", message: { role: "user", content: "do the thing" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "step one" }] } },
    { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "a b c" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "step two" }] } },
    { type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "/x" } },
    { type: "tool_execution_end", toolCallId: "c2", toolName: "read", result: "contents" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ]);

  const plan = planTranscript(t);
  const shape = plan.map((e) => (e.kind === "turn" ? `turn:${assistantText(e.message).slice(0, 8)}` : `tools:${e.tools.length}`));
  assert.deepEqual(shape, [
    "turn:do the t",
    "turn:step one",
    "tools:1",
    "turn:step two",
    "tools:1",
    "turn:done",
  ], "each tool must sit between the turns it ran between");

  // The final entry is a turn, NOT a pile of tools.
  assert.equal(plan[plan.length - 1]!.kind, "turn", "tools must not be dumped at the end");
});

test("a burst of tool work with no prose between collapses into ONE marker", () => {
  // This is what removes the mental load: Pi interleaves assistant->tool->assistant rapidly, and
  // one marker per position was still tool-dominated (measured: 997 markers vs 866 turns).
  const records: Record<string, unknown>[] = [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
  ];
  for (let i = 0; i < 9; i += 1) {
    records.push({ type: "tool_execution_start", toolCallId: `c${i}`, toolName: "bash", args: {} });
    records.push({ type: "tool_execution_end", toolCallId: `c${i}`, toolName: "bash", result: "x" });
    // An assistant message that is ONLY a tool call: nothing for a reader, so no turn.
    records.push({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "bash", arguments: {} }] } });
  }
  records.push({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished" }] } });

  const plan = planTranscript(fold(records));
  const markers = plan.filter((e) => e.kind === "tools");
  assert.equal(markers.length, 1, `expected one collapsed marker, got ${markers.length}`);
  assert.equal(markers[0]!.kind === "tools" && markers[0]!.tools.length, 9);
  assert.deepEqual(plan.map((e) => e.kind), ["turn", "tools", "turn"]);
});

test("prose-less assistant messages do not produce empty turns", () => {
  // 212 assistant messages in a real session are a tool call with no text.
  const t = fold([
    { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }] } },
  ]);
  assert.equal(hasProse(t.messages[0]!), false);
  assert.deepEqual(planTranscript(t), [], "a message with nothing to read is not a turn");
});

test("a tool result with no content still gets a marker", () => {
  // Otherwise work would be invisible, which is the opposite failure.
  const plan = planTranscript(fold([
    { type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [] } },
  ]));
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.kind, "tools");
});

test("work before the first message is planned first, not dropped", () => {
  // A resumed session can open mid-tool-call.
  const plan = planTranscript(fold([
    { type: "tool_execution_end", toolCallId: "orphan", toolName: "bash", result: "early" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "then this" }] } },
  ]));
  assert.deepEqual(plan.map((e) => e.kind), ["tools", "turn"]);
});

// --- Double-counting: one call reached the UI by two routes (img_3.png) ------------------------
//
// Measured on a real session: the file holds ONE `bash` tool result and ONE `write`, but the trace
// showed FOUR rows. Every call arrives twice — as live `tool_execution_*` events (with arguments
// and a duration) and as a persisted `toolResult` message (with the result, but no arguments).
// The two extras also shared a `toolCallId`, which collides as a React key.

const CALL_ID = "call_c3567abe6db9434aa0f960f6";

test("a tool seen live and then in history is ONE row, not two", () => {
  const t = fold([
    // Live: start carries args, end carries the duration.
    { type: "tool_execution_start", toolCallId: CALL_ID, toolName: "bash", args: { command: "ls -la" } },
    { type: "tool_execution_end", toolCallId: CALL_ID, toolName: "bash", result: "a b c", durationMs: 17 },
    // History: the same call as a toolResult message. No arguments, no duration.
    { type: "message_end", message: { role: "toolResult", toolCallId: CALL_ID, toolName: "bash", content: [{ type: "text", text: "a b c" }] } },
  ]);
  assert.equal(t.tools.length, 1, `expected one row for one call, got ${t.tools.length}`);
  assert.equal(t.tools[0]!.result, "a b c");
  assert.equal(t.tools[0]!.durationMs, 17, "the live duration must survive the merge");
});

test("a tool seen in history and then live is also ONE row", () => {
  // The opposite order happens when history is loaded before the call runs, so neither source can
  // simply be preferred.
  const t = fold([
    { type: "message_end", message: { role: "toolResult", toolCallId: CALL_ID, toolName: "bash", content: [{ type: "text", text: "a b c" }] } },
    { type: "tool_execution_start", toolCallId: CALL_ID, toolName: "bash", args: { command: "ls -la" } },
    { type: "tool_execution_end", toolCallId: CALL_ID, toolName: "bash", result: "a b c", durationMs: 17 },
  ]);
  assert.equal(t.tools.length, 1);
  assert.deepEqual(t.tools[0]!.args, { command: "ls -la" }, "the live arguments must be merged in");
});

test("tool ids are unique, because they are React keys", () => {
  const t = fold([
    { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: "x" },
    { type: "message_end", message: { role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "x" }] } },
    { type: "tool_execution_start", toolCallId: "b", toolName: "read", args: {} },
  ]);
  const ids = t.tools.map((tool) => tool.toolCallId);
  assert.equal(new Set(ids).size, ids.length, `duplicate tool ids: ${ids.join(", ")}`);
});

test("a history entry that carries a result marks the tool finished", () => {
  // Completion is inferred from EVIDENCE (a duration, or any result), not from which route the
  // entry took. A `toolResult` is only persisted once the tool is done, so this cannot leave a
  // stale "running" behind — and a session resumed after its tools finished must not show them
  // as still running.
  //
  // (An earlier version of this test asserted the opposite and failed. The failure was useful: it
  // showed the code and its comment disagreed, and the code was right.)
  const t = fold([
    { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} },
    { type: "message_end", message: { role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "old" }] } },
  ]);
  assert.equal(t.tools[0]!.running, false, "a result is evidence the call finished");
});

test("a bare start with no result yet stays running", () => {
  const t = fold([{ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} }]);
  assert.equal(t.tools[0]!.running, true);
});

test("a live end DOES clear the running flag", () => {
  const t = fold([
    { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: "done", durationMs: 5 },
  ]);
  assert.equal(t.tools[0]!.running, false);
});

test("the richer result wins when a partial arrives before the final text", () => {
  const t = fold([
    { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} },
    { type: "tool_execution_update", toolCallId: "a", partialResult: "part" },
    { type: "message_end", message: { role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "the complete output" }] } },
  ]);
  assert.equal(t.tools[0]!.result, "the complete output");
});

test("history tool arguments are recovered from the assistant's toolCall block", () => {
  // `toolResult` records do NOT carry arguments, so every historical trace row rendered blank —
  // the least useful thing a trace row can be. The arguments are in the same conversation.
  const t = seedTranscript([
    { role: "assistant", content: [
      { type: "toolCall", id: CALL_ID, name: "bash", arguments: { command: "ls -la" } },
    ] },
    { role: "toolResult", toolCallId: CALL_ID, toolName: "bash", content: [{ type: "text", text: "a b c" }] },
  ]);
  assert.deepEqual(t.tools[0]!.args, { command: "ls -la" }, "arguments must be recovered");
  assert.equal(t.tools.length, 1);
});

test("a history row with no matching toolCall block still renders, just without arguments", () => {
  const t = seedTranscript([
    { role: "toolResult", toolCallId: "orphan", toolName: "bash", content: [{ type: "text", text: "out" }] },
  ]);
  assert.equal(t.tools.length, 1);
  assert.equal(t.tools[0]!.args, undefined);
  assert.equal(t.tools[0]!.result, "out");
});

test("a real session's duplicate-free tool count matches its toolCall blocks", () => {
  // The property that was violated: the number of trace rows should equal the number of DISTINCT
  // calls, not the number of records that mention them.
  const t = seedTranscript([
    { role: "assistant", content: [
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } },
      { type: "toolCall", id: "c2", name: "write", arguments: { path: "random-notes.md" } },
    ] },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "files" }] },
    { role: "toolResult", toolCallId: "c2", toolName: "write", content: [{ type: "text", text: "wrote" }] },
  ]);
  assert.equal(t.tools.length, 2, "two calls must be two rows");
  assert.deepEqual(t.tools.map((x) => x.toolName).sort(), ["bash", "write"]);
  assert.deepEqual(t.tools.map((x) => x.args).sort((a, b) => String(a).localeCompare(String(b))), [
    { command: "ls -la" },
    { path: "random-notes.md" },
  ]);
});

test("a call whose result was never recorded still appears in the trace", () => {
  // Real session: 1188 tool calls, 1187 tool results. One `bash` call's result was never
  // persisted because the run was interrupted. Omitting it makes the trace under-report what the
  // agent attempted — and "it tried this and we never saw the outcome" is exactly what someone
  // opens a trace to find.
  const t = seedTranscript([
    { role: "assistant", content: [
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: "c2", name: "bash", arguments: { command: "never finished" } },
    ] },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }] },
  ]);
  assert.equal(t.tools.length, 2, "the unrecorded call must not vanish");
  const orphan = t.tools.find((tool) => tool.toolCallId === "c2")!;
  assert.equal(orphan.unfinished, true);
  assert.deepEqual(orphan.args, { command: "never finished" }, "its arguments are still known");
  assert.equal(orphan.running, false, "it is not running now, it simply never reported");
});

test("every tool call the agent made appears in the trace", () => {
  // The property that must hold: trace rows == distinct calls, never fewer.
  const t = seedTranscript([
    { role: "assistant", content: [
      { type: "toolCall", id: "a", name: "bash", arguments: {} },
      { type: "toolCall", id: "b", name: "read", arguments: {} },
      { type: "toolCall", id: "c", name: "write", arguments: {} },
    ] },
    { role: "toolResult", toolCallId: "b", toolName: "read", content: [{ type: "text", text: "x" }] },
  ]);
  assert.equal(t.tools.length, 3);
  assert.equal(t.tools.filter((x) => x.unfinished).length, 2);
});

test("unrecorded calls are ordered by where they were made, not appended", () => {
  const t = seedTranscript([
    { role: "assistant", content: [{ type: "toolCall", id: "late", name: "bash", arguments: {} }] },
    { role: "user", content: "more" },
    { role: "assistant", content: [{ type: "toolCall", id: "later", name: "read", arguments: {} }] },
  ]);
  assert.deepEqual(t.tools.map((x) => x.afterMessage), [1, 3]);
});

// --- Notices about the run itself (issue #5) -----------------------------------------------------

/** Fold a sequence of records, which is how the notices actually arrive. */
function notices(records: Record<string, unknown>[]): RunNotice[] {
  let transcript: Transcript = emptyTranscript();
  for (const record of records) transcript = applyRecord(transcript, record);
  return transcript.notices ?? [];
}

test("a compaction start produces an OPEN notice, and the end closes it", () => {
  // The pair is the unit: a start alone means "still compacting", which is what the banner must say.
  const started = notices([{ type: "compaction_start", reason: "overflow" }]);
  assert.equal(started.length, 1);
  assert.equal(started[0]!.kind, "compaction");
  assert.equal(noticeIsOpen(started[0]!), true, "a started compaction is still running");
  assert.equal(started[0]!.kind === "compaction" && started[0]!.reason, "overflow");

  const ended = notices([
    { type: "compaction_start", reason: "overflow" },
    {
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: false,
      result: { tokensBefore: 118_000, tokensAfter: 41_000 },
    },
  ]);
  assert.equal(ended.length, 1, "the end must CLOSE the notice, not add a second one");
  assert.equal(noticeIsOpen(ended[0]!), false);
  assert.equal(ended[0]!.kind === "compaction" && ended[0]!.tokensBefore, 118_000);
  assert.equal(ended[0]!.kind === "compaction" && ended[0]!.tokensAfter, 41_000);
});

test("an ABORTED compaction is recorded as aborted, not as completed", () => {
  // Collapsing these would report a failure as a success, which is the lie that matters most here.
  const ended = notices([
    { type: "compaction_start", reason: "manual" },
    { type: "compaction_end", reason: "manual", aborted: true, willRetry: false, result: undefined },
  ]);
  assert.equal(ended[0]!.kind === "compaction" && ended[0]!.ended?.aborted, true);
});

test("a retry records the attempt number and the bound", () => {
  const started = notices([{ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: "529" }]);
  assert.equal(started.length, 1);
  assert.equal(started[0]!.kind === "retry" && started[0]!.attempt, 2);
  assert.equal(started[0]!.kind === "retry" && started[0]!.maxAttempts, 3);
  assert.equal(noticeIsOpen(started[0]!), true);
  assert.equal(started[0]!.kind === "retry" && started[0]!.errorMessage, "529");
});

test("a successful retry and a failed one are different notices", () => {
  const recovered = notices([
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "529" },
    { type: "auto_retry_end", success: true, attempt: 1 },
  ]);
  assert.equal(recovered[0]!.kind === "retry" && recovered[0]!.ended?.success, true);
  assert.equal(recovered[0]!.kind === "retry" && recovered[0]!.ended?.finalError, undefined);

  const gaveUp = notices([
    { type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 1000, errorMessage: "529" },
    { type: "auto_retry_end", success: false, attempt: 3, finalError: "provider unavailable" },
  ]);
  assert.equal(gaveUp[0]!.kind === "retry" && gaveUp[0]!.ended?.success, false);
  assert.equal(gaveUp[0]!.kind === "retry" && gaveUp[0]!.ended?.finalError, "provider unavailable");
});

test("summarization retries are SURFACED rather than swallowed", () => {
  // The issue asks specifically for this: these are a different mechanism from `auto_retry`, and
  // were previously invisible.
  const started = notices([{ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 500, errorMessage: "timeout" }]);
  assert.equal(started.length, 1);
  assert.equal(started[0]!.kind, "summarization");
  assert.equal(noticeIsOpen(started[0]!), true);
});

test("a scheduled summarization retry and its attempt are ONE notice, not two", () => {
  // Pi emits both for a single retry. Two notices would misreport the attempt count, and the count
  // is the information the reader needs.
  const both = notices([
    { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 500, errorMessage: "timeout" },
    { type: "summarization_retry_attempt_start", source: "compaction", reason: "overflow" },
    { type: "summarization_retry_finished" },
  ]);
  assert.equal(both.length, 1, "one retry must be one notice");
  assert.equal(both[0]!.kind === "summarization" && both[0]!.source, "compaction");
  assert.equal(noticeIsOpen(both[0]!), false, "finished closes it");
});

test("an END with no matching start does not fabricate a notice", () => {
  // After a page reload the start is not in the buffer. Inventing one would claim to have seen
  // something this client never received — the same rule as the queue's unknown texts.
  const orphan = notices([{ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, result: undefined }]);
  assert.deepEqual(orphan, []);
});

test("two compactions in sequence are two notices, each closed by its own end", () => {
  // "The most recent open notice of that kind" is the only correspondence available, since Pi sends
  // no id. Consecutive compactions must therefore still pair up correctly.
  const two = notices([
    { type: "compaction_start", reason: "threshold" },
    { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, result: { tokensBefore: 100, tokensAfter: 50 } },
    { type: "compaction_start", reason: "overflow" },
    { type: "compaction_end", reason: "overflow", aborted: true, willRetry: false, result: undefined },
  ]);
  assert.equal(two.length, 2);
  assert.equal(two[0]!.kind === "compaction" && two[0]!.ended?.aborted, false);
  assert.equal(two[1]!.kind === "compaction" && two[1]!.ended?.aborted, true);
});

test("notices do not touch messages or tools", () => {
  // A notice is neither a message nor a tool call, and putting it in either would claim the agent
  // said something or that something ran.
  const transcript = [{ type: "compaction_start", reason: "overflow" }, { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 100, errorMessage: "x" }]
    .reduce((t, r) => applyRecord(t, r), emptyTranscript());
  assert.deepEqual(transcript.messages, []);
  assert.deepEqual(transcript.tools, []);
  assert.equal(transcript.notices?.length, 2);
});

test("a transcript made before notices existed still reads as having none", () => {
  // `notices` defaults rather than being optional, so a reader never has to distinguish "absent"
  // from "empty" — and an old transcript cannot be mistaken for one full of notices.
  assert.deepEqual(emptyTranscript().notices, []);
});
