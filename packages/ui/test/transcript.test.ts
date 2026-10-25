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
