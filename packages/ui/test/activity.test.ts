/**
 * Conversation plus activity, instead of a bar per internal step.
 *
 * ## The defect these lock down
 *
 * A screenshot review of a real session (`img_18.png`) showed:
 *
 *     Assistant · [Thinking] · 1 tool · Assistant · [Thinking] · 1 tool · Assistant · [Thinking] …
 *
 * Every collapse had already been made, and the collapsed rows were the feed. The cause was precise:
 * `hasProse()` counted a non-empty thinking block as something to read, so each thinking-only assistant
 * message flushed the tool group and became its own turn. Four tools and three thoughts cost seven
 * headings, seven bars and a conversation that could not be followed.
 *
 * Three properties have to hold at once, and each is asserted separately:
 *
 *   1. an interleaved run is ONE group, not one line per internal step;
 *   2. no content is lost — every tool execution and every thinking block stays reachable;
 *   3. the summary says only what was RECORDED (a failure is not "recovered" because work continued).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planEntries, activityStatus, activitySummary, activityTools, messageTexts, stepLabel } from "../src/activity.ts";
import { emptyTranscript, type Transcript, type TranscriptMessage, type ToolExecution } from "../src/transcript.ts";

function text(value: string, complete = true) {
  return { kind: "text" as const, text: value, complete };
}

function thinking(value: string, complete = true) {
  return { kind: "thinking" as const, text: value, complete };
}

function message(id: string, blocks: TranscriptMessage["blocks"], streaming = false): TranscriptMessage {
  return { id, role: "assistant", blocks, complete: !streaming, streaming };
}

function tool(id: string, afterMessage: number, overrides: Partial<ToolExecution> = {}): ToolExecution {
  return {
    toolCallId: id,
    toolName: "bash",
    args: { command: "ls" },
    result: "output",
    isError: false,
    running: false,
    startedAt: 0,
    afterMessage,
    ...overrides,
  };
}

function transcript(messages: TranscriptMessage[], tools: ToolExecution[] = []): Transcript {
  return { ...emptyTranscript(), messages, tools };
}

/** The shape of a plan, as a compact string per entry — the assertion that reads like the screen. */
function shape(plan: ReturnType<typeof planEntries>): string[] {
  return plan.map((entry) =>
    entry.kind === "message"
      ? `message:${entry.message.role === "user" ? "you" : "assistant"}:${entry.textIndexes.length}`
      : `activity:${entry.parts.map((part) => (part.kind === "tool" ? "tool" : "thinking")).join("+")}`,
  );
}

test("the interleaved run from the screenshot is ONE activity group, not seven rows", () => {
  // Exactly the reported pattern: two tools and a thought, then another tool and a thought, then a tool,
  // then a thought that is still arriving. Each thinking-only message used to become its own turn.
  const messages = [
    { id: "u1", role: "user" as const, blocks: [text("Review the shots.")], complete: true, streaming: false },
    message("a1", [thinking("Retry the subagent call without the bad acceptance option.")]),
    message("a2", [thinking("The subagent reviewed all images, not just img_17.")]),
    message("a3", [thinking("The report is good but it reviewed ALL images.")]),
    message("a4", [thinking("", false)], true),
  ];
  const tools = [tool("t1", 2), tool("t2", 3), tool("t3", 4), tool("t4", 5)];

  const plan = planEntries(transcript(messages, tools));

  assert.deepEqual(shape(plan), [
    "message:you:1",
    "activity:thinking+tool+thinking+tool+thinking+tool+thinking+tool",
  ], "one group for one uninterrupted stretch of work");

  const group = plan[1];
  assert.ok(group?.kind === "activity");
  assert.equal(group.parts.filter((part) => part.kind === "tool").length, 4, "every tool is present");
  assert.equal(group.parts.filter((part) => part.kind === "thinking").length, 4, "every thought is present");
});

test("no Assistant heading is produced for a thinking-only message", () => {
  // The specific noise: a heading that promised prose and delivered a collapsed bar.
  const plan = planEntries(transcript([message("a1", [thinking("Only a thought here.")])]));
  assert.equal(plan.filter((entry) => entry.kind === "message").length, 0);
});

test("real assistant prose still separates two groups, and is never merged into one", () => {
  // Grouping must not become "hide the conversation": a substantive answer between two runs stays visible
  // and keeps the two runs apart.
  const plan = planEntries(transcript(
    [
      message("a1", [text("Let me check the failing test.")]),
      message("a2", [text("Found it — the fixture path was wrong.")]),
    ],
    [tool("t1", 1), tool("t2", 2)],
  ));

  assert.deepEqual(shape(plan), [
    "message:assistant:1",
    "activity:tool",
    "message:assistant:1",
    "activity:tool",
  ]);
});

test("one thinking-only message does NOT flush the tool group (the actual bug)", () => {
  // The regression in one line: before this, the tool run was split into two markers by the thought
  // between them, and the thought became a turn.
  const plan = planEntries(transcript(
    [message("a1", [thinking("first thought")]), message("a2", [thinking("second thought")])],
    [tool("t1", 1), tool("t2", 2)],
  ));
  assert.deepEqual(shape(plan), ["activity:thinking+tool+thinking+tool"]);
});

test("a message with text, thinking, then more text keeps the recorded ORDER", () => {
  // Thinking between two spans of prose is not moved to the front. Reordering would state that the agent
  // said everything before it thought, which is a claim about what happened.
  const plan = planEntries(transcript([
    message("a1", [text("Before."), thinking("in between"), text("After.")]),
  ]));

  assert.deepEqual(shape(plan), [
    "message:assistant:1",
    "activity:thinking",
    "message:assistant:1",
  ]);
  const first = plan[0];
  const last = plan[2];
  assert.ok(first?.kind === "message" && last?.kind === "message");
  assert.deepEqual(first.textIndexes, [0], "the first entry is the first text block only");
  assert.deepEqual(last.textIndexes, [2], "…and the last is the third");
});

test("resolving a message's prose returns exactly its visible text", () => {
  const source = message("a1", [text("One."), text("   "), text("Two.")]);
  const plan = planEntries(transcript([source]));
  const entry = plan[0];
  assert.ok(entry?.kind === "message");
  assert.deepEqual(messageTexts(entry.message, entry.textIndexes), ["One.", "Two."]);
});

test("a tool that ran before the first message is planned first, not dropped", () => {
  // A resumed session can open mid-call.
  const plan = planEntries(transcript(
    [message("a1", [text("then this")])],
    [tool("orphan", 0)],
  ));
  assert.deepEqual(shape(plan), ["activity:tool", "message:assistant:1"]);
});

test("work after the last readable turn still gets a group", () => {
  const plan = planEntries(transcript([message("a1", [text("done for now")])], [tool("t1", 1)]));
  assert.deepEqual(shape(plan), ["message:assistant:1", "activity:tool"]);
});

test("a complete empty thinking block is dropped; an empty one still arriving is kept", () => {
  // A finished block with no words opens to nothing. An unfinished one is the moment a reader is waiting
  // for, so it must keep the group visibly live — and it is the only case where "Thinking…" is a fact.
  const finished = planEntries(transcript([message("a1", [thinking("")])]));
  assert.deepEqual(finished, [], "an empty finished block says nothing");

  const live = planEntries(transcript([
    message("a1", [thinking("", false), text("Working on it.")], true),
  ]));
  assert.deepEqual(shape(live), ["activity:thinking", "message:assistant:1"]);
  const group = live[0];
  assert.ok(group?.kind === "activity");
  assert.equal(activitySummary(activityStatus(group.parts, [])).primary, "Thinking…");
});

test("whitespace-only text placeholders are not turns", () => {
  // `blockAt()` creates empty text blocks while a message is assembled; a heading above nothing was the
  // original noise.
  const plan = planEntries(transcript([message("a1", [text("   "), text("\n\n")])]));
  assert.deepEqual(plan, []);
});

test("each execution appears once, however it reached the UI", () => {
  // A call arrives twice on the real wire: live `tool_execution_*` and a persisted `toolResult`. The
  // transcript correlates them to one execution, and the group must not add a second reference.
  const plan = planEntries(transcript([], [tool("c1", 0, { result: "a b c" })]));
  const group = plan[0];
  assert.ok(group?.kind === "activity");
  assert.equal(group.parts.length, 1);
  assert.equal(activityTools(group.parts, [tool("c1", 0)]).length, 1);
});

test("a group keeps its identity when it gains parts", () => {
  // The reader opens a group while work is running. If the key changed on every arrival, the disclosure
  // would snap shut at each tool call — the same failure as #108, one level down.
  const running = planEntries(transcript([message("a1", [thinking("hmm")])], [tool("t1", 1, { running: true })]));
  const andAnother = planEntries(transcript(
    [message("a1", [thinking("hmm")])],
    [tool("t1", 1, { running: true }), tool("t2", 1, { running: true })],
  ));

  const first = running[0];
  const later = andAnother[0];
  assert.ok(first?.kind === "activity" && later?.kind === "activity");
  assert.equal(first.key, later.key, "appending parts must not rename the group");
  assert.notEqual(first.parts.length, later.parts.length, "precondition: the content did change");
});

test("a message's key is stable when prose streams and its content changes", () => {
  const partial = planEntries(transcript([message("a1", [text("Hel")], true)]));
  const complete = planEntries(transcript([message("a1", [text("Hello there.")], false)]));
  const a = partial[0];
  const b = complete[0];
  assert.ok(a?.kind === "message" && b?.kind === "message");
  assert.equal(a.key, b.key, "a delta must not remount the prose that is being written");
});

// --- The summary states only what was recorded --------------------------------------------------

test("a running call is named; several running calls are counted", () => {
  const one = planEntries(transcript([], [tool("t1", 0, { toolName: "read", running: true })]));
  const group = one[0];
  assert.ok(group?.kind === "activity");
  assert.equal(
    activitySummary(activityStatus(group.parts, [tool("t1", 0, { toolName: "read", running: true })])).primary,
    "Running read",
  );

  const both = [tool("t1", 0, { toolName: "read", running: true }), tool("t2", 0, { toolName: "bash", running: true })];
  const two = activityStatus(
    both.map((entry) => ({ kind: "tool" as const, key: `tool:${entry.toolCallId}`, toolCallId: entry.toolCallId })),
    both,
  );
  assert.equal(activitySummary(two).primary, "2 tools running");
});

test("a failed call stays visible in a collapsed group, and is NOT called recovered", () => {
  // The screenshot's `1 failed` sat beside `running` with no relationship stated. A later successful call is
  // not evidence that the failed one was recovered, so the summary reports both facts and claims neither.
  const tools = [
    tool("t1", 0, { toolName: "subagent", isError: true }),
    tool("t2", 0, { toolName: "read" }),
    tool("t3", 0, { toolName: "bash", running: true }),
  ];
  const group = planEntries(transcript([], tools))[0];
  assert.ok(group?.kind === "activity");
  const summary = activitySummary(activityStatus(group.parts, tools));

  assert.equal(summary.primary, "Running bash", "what is happening now");
  assert.match(summary.detail ?? "", /1 call failed/, "…and the failure is not swallowed by collapsing");
  assert.ok(!/recover/i.test(`${summary.primary} ${summary.detail}`), "no claim the failure was recovered");
});

test("a call whose result never arrived is reported as missing, not as running forever", () => {
  const tools = [tool("t1", 0, { toolName: "bash", unfinished: true })];
  const group = planEntries(transcript([], tools))[0];
  assert.ok(group?.kind === "activity");
  const summary = activitySummary(activityStatus(group.parts, tools));
  assert.equal(summary.primary, "1 tool call recorded");
  assert.match(summary.detail ?? "", /no recorded result/);
});

test("a finished group says how many calls were recorded, and claims no completion", () => {
  const tools = [tool("t1", 0), tool("t2", 0), tool("t3", 0)];
  const group = planEntries(transcript([], tools))[0];
  assert.ok(group?.kind === "activity");
  const summary = activitySummary(activityStatus(group.parts, tools));
  assert.equal(summary.primary, "3 tool calls recorded");
  assert.equal(summary.detail, undefined, "nothing failed, so nothing to add");
  assert.ok(!/complete(d)?|success|done|finished/i.test(summary.primary), "no task-completion claim");
});

test("thinking-only activity is counted, not silently emptied", () => {
  const group = planEntries(transcript([message("a1", [thinking("a thought")])], []))[0];
  assert.ok(group?.kind === "activity");
  assert.equal(activitySummary(activityStatus(group.parts, [])).primary, "1 thinking block");
});

test("the planner reads each tool once per pass, not once per message", () => {
  // The same guarantee `planTranscript` carries (issue #151), kept for the new pass: planning runs on every
  // delta while streaming, so a per-message scan of the tool array is quadratic and paid constantly. The
  // assertion compares two message counts with the SAME tool array — identical reads is the property; an
  // absolute number would encode the current implementation instead of the rule.
  function countingTools(count: number) {
    let reads = 0;
    const tools = Array.from({ length: count }, (_, index) => {
      const entry = tool(`t${index}`, 1);
      return new Proxy(entry, {
        get(target, property, receiver) {
          reads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
    });
    return { tools: tools as ToolExecution[], reads: () => reads };
  }

  const { tools, reads } = countingTools(50);
  const messagesFor = (count: number) =>
    Array.from({ length: count }, (_, index) => message(`m${index}`, [text(`message ${index}`)]));

  planEntries({ messages: messagesFor(2), tools, notices: [] } as Transcript);
  const fewMessages = reads();
  reads();
  planEntries({ messages: messagesFor(400), tools, notices: [] } as Transcript);
  const manyMessages = reads() - fewMessages;
  assert.equal(manyMessages, fewMessages, "planning must not scale with the number of messages");
});

// --- What a step is CALLED -----------------------------------------------------------------------

test("a step names the thing it acted on", () => {
  // The label is what a reader scans; the JSON is what the trace is for.
  assert.equal(stepLabel(tool("t", 0, { toolName: "read", args: { path: "a/b.md" } })), "read a/b.md");
  assert.equal(stepLabel(tool("t", 0, { toolName: "bash", args: { command: "rg -n x docs" } })), "bash rg -n x docs");
  assert.equal(stepLabel(tool("t", 0, { toolName: "subagent", args: { agent: "ui-review" } })), "subagent ui-review");
});

test("a cd chain does not eat the label", () => {
  // The reported defect (img_20.png): ten consecutive rows read
  // `bash cd /Users/sven1103/….loca…`, because every command began with the same `cd … && ` prefix and the
  // head-keeping truncation spent the whole budget on it.
  const label = stepLabel(
    tool("t", 0, {
      toolName: "bash",
      args: { command: "cd /Users/sven1103/.local/share/pi-central/workspaces/s1 && rg -n 'min_size' dungeon.py" },
    }),
  );
  assert.equal(label, "bash rg -n 'min_size' dungeon.py", "the boilerplate prefix is dropped");
  assert.ok(!/cd \//.test(label), `no cd prefix in the label: ${label}`);
});

test("repeated cd chains are also stripped", () => {
  const label = stepLabel(
    tool("t", 0, { toolName: "bash", args: { command: "cd /a; cd /b && npm test" } }),
  );
  assert.equal(label, "bash npm test");
});

test("a long command keeps BOTH ends, because a verb and a path both identify it", () => {
  // Head-only truncation loses the tail, which is often the filename that distinguishes two calls.
  const command = `rg --glob '*.py' -n 'a rather long search pattern here' ${"deep/".repeat(12)}target.py`;
  const label = stepLabel(tool("t", 0, { toolName: "bash", args: { command } }));
  assert.ok(label.includes("\u2026"), `a long command is elided: ${label}`);
  assert.match(label, /^bash rg/, "the verb survives");
  assert.match(label, /target\.py$/, "…and so does the file at the tail");
});

test("a command with no useful argument falls back to the tool name, not an empty label", () => {
  assert.equal(stepLabel(tool("t", 0, { toolName: "list", args: {} })), "list");
  assert.equal(stepLabel(tool("t", 0, { toolName: "list", args: undefined })), "list");
});
