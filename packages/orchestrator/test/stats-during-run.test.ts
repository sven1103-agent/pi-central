/**
 * The context meter and the cost update DURING a run, through the real supervisor.
 *
 * ## The report this reproduces
 *
 * *"When a new session is started and the agent prompted with a complex task, the context consumption
 * and costs are not updated in Pi Central — both rail and session sidecar — until the agent is ready
 * and waits for user interaction."*
 *
 * Nothing was broken in the display. Both surfaces read `LiveSession.contextPercent` and `.cost`, the
 * transport broadcasts every `update`, and the UI reducer replaces the session object. The gap was in
 * the orchestrator's CADENCE: stats were fetched only when a record asked for it, and only
 * `agent_settled` and `compaction_end` did. A complex task is minutes of turns before anything settles,
 * so the numbers were absent for exactly as long as the run was expensive.
 *
 * ## Why this test uses a stand-in `pi`
 *
 * The defect lived in the wiring — `interpretRecord` → `#refreshStats` → `rpc.send({ type:
 * "get_session_stats" })` → `#patch` → `update` event — and every one of those steps is real here. A
 * pure test of `interpretRecord` proves the decision (it is in `state.test.ts`); this proves the decision
 * reaches the wire, which is the half that was missing.
 *
 * The stand-in is a small executable Node script installed where `pi` would be, so `spawn(pi, ["--mode", "rpc"])`
 * runs it exactly as it would run the real one — direct mode, no sandbox and no credentials, so this runs in CI.
 * It answers `get_state`, `get_messages` and `get_session_stats`, and replays a paced scripted run for a prompt.
 *
 * ## What it would catch that the pure test would not
 *
 * A record whose effect is computed and then dropped — an `if` around the call, a `void` on a function
 * that returns early, the coalescer keeping a key it never releases. All of those leave
 * `interpretRecord`'s unit test green and the meter at `ctx —`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveSession } from "@pi-central/protocol";

const { Supervisor } = await import("../src/supervisor.ts");

/**
 * A `pi --mode rpc` stand-in: answers the lifecycle commands, and replays a scripted run.
 *
 * The run is the REPORTED shape, not a convenient one: two turns with `agent_end` between them and no
 * `agent_settled` until the very end, because that is what a long task looks like and it is the case
 * the old cadence reported as unmeasured.
 *
 * Written with a `#!` line the test makes executable, so it can stand in for the `pi` binary itself: direct
 * mode launches `pi --mode rpc`, and the stand-in simply ignores the argument it is handed.
 */
const FAKE_PI = `
import { createInterface } from "node:readline";

const write = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
let statsAsks = 0;

// The id is echoed from the request, because that is how the transport correlates a response. A stand-in
// that made up its own id would leave every ask to time out and prove nothing.
const stats = (id) => ({
  type: "response",
  id,
  command: "get_session_stats",
  success: true,
  data: {
    tokens: { total: 900 + statsAsks * 100 },
    cost: 0.5 + statsAsks * 0.1,
    contextUsage: { tokens: 1000, contextWindow: 200000, percent: 12 + statsAsks },
  },
});

/*
 * The run is PACED, because that is what the report is about: a complex task spends seconds in each turn, and
 * the question is whether the numbers move DURING that time. A run that emitted all its records in one tick
 * would prove only that the coalescer merges them — which is the opposite of what a reader sees.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const run = async () => {
  write({ type: "agent_start" });
  for (let turn = 1; turn <= 2; turn += 1) {
    write({ type: "turn_start" });
    write({ type: "message_start", message: { role: "user", content: "do the thing" } });
    write({ type: "message_end", message: { role: "user", content: "do the thing" } });
    write({ type: "message_start", message: { role: "assistant", content: [] } });
    write({ type: "message_end", message: { role: "assistant", content: [] } });
    // A tool result, so this is the shape of a real turn rather than a monologue.
    write({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
    write({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
    // agent_end, NOT agent_settled: the run continues into the next turn.
    write({ type: "agent_end", messages: [], willRetry: false });
    // The gap a real turn has while the next tool runs or the next response streams.
    await sleep(120);
  }
  write({ type: "agent_settled", aborted: false });
};

const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  const respond = (data) => write({ type: "response", id: command.id, command: command.type, success: true, data });
  switch (command.type) {
    case "get_state":
      respond({
        model: { provider: "test", id: "test-model" },
        isStreaming: false,
        sessionFile: process.env.FAKE_SESSION_FILE,
        sessionId: "uuid-1",
        messageCount: 0,
        pendingMessageCount: 0,
      });
      return;
    case "get_messages":
      respond({ messages: [] });
      return;
    case "get_session_stats":
      statsAsks += 1;
      // Answered ASYNCHRONOUSLY, like a real child process, so the ordering the supervisor sees is the
      // ordering a real Pi produces rather than a synchronous echo.
      setTimeout(() => process.stdout.write(JSON.stringify(stats(command.id)) + "\\n"), 5);
      return;
    case "prompt":
      respond({ disposition: "started" });
      // The run starts after the prompt is acknowledged, which is the real order.
      setTimeout(run, 10);
      return;
    default:
      respond({});
  }
});
`;

/**
 * Wait until `predicate` holds, or fail with what the session actually looked like.
 *
 * The subject is whichever map is being watched (the session entry, or the broadcasts a client received), so this
 * is generic over it rather than typed to `LiveSession`.
 */
async function until<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  describe: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = read();
    if (predicate(value)) return;
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${describe}; last value was ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a turn reports context usage and cost, so a long task is not unmeasured until it settles", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-central-stats-"));
  // A stand-in for the `pi` binary: executable, with this Node as its interpreter, so `spawn(pi, ["--mode",
  // "rpc"])` runs it exactly as it would run the real one. Nothing about the launch is faked.
  const pi = join(root, "fake-pi");
  writeFileSync(pi, `#!${process.execPath}\n${FAKE_PI}`, { mode: 0o755 });
  const work = join(root, "work");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(work, { recursive: true });
  // The stand-in reports this as the session file it "created", which is what the supervisor remembers.
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, "");

  const supervisor = new Supervisor({
    workspaceRoot: join(root, "workspaces"),
    stateRoot: join(root, "state"),
    sessionsRoot: join(root, "sessions"),
    safehouse: "unused",
    pi,
    agentRoot: join(root, "agent"),
    fragmentDir: join(root, "state", "policy"),
    agentRootManaged: true,
    providerAgentDir: join(root, "provider"),
    home: root,
    installationRoot: join(root, "installation"),
  });
  supervisor.on("error", () => {});

  // An `update` is what the transport broadcasts, so collecting them is the client's view.
  const seen: LiveSession[] = [];
  supervisor.on("update", (session: LiveSession) => seen.push({ ...session }));

  const started = supervisor.resume(
    {
      path: sessionFile,
      id: "uuid-1",
      cwd: work,
      created: new Date().toISOString(),
      modifiedMs: Date.now(),
      bytes: 0,
      messageCount: 0,
      firstMessage: "do the thing",
      cwdExists: true,
      scratch: false,
    },
    {
      /*
       * Direct mode: no Safehouse, so this needs no sandbox and no credentials — the one mode in which a stand-in
       * binary is reachable without composing a policy for it.
       */
      mode: "direct",
    },
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  if (!started.ok) return;
  const id = started.session.id;

  try {
    /*
     * Wait for IDLE, not merely for a first number.
     *
     * `start` fires its own `get_state` and `get_session_stats` while the process is warming up, so the
     * session reports `ctx 13%` and `$0.60` from that first read — which is correct and is the honest state
     * of a session with no messages yet, not the defect. The defect is the GAP: from that first read until
     * `agent_settled`, the old cadence left the numbers frozen. So the assertion below is that a TURN moves
     * them, not that they are absent at rest.
     */
    await until(() => supervisor.get(id), (session) => session?.state === "idle", "the session to reach idle");
    // The startup read lands just after the state does, so wait for it rather than racing it.
    await until(() => supervisor.get(id), (session) => session?.contextPercent !== null, "the startup read");
    const atRest = supervisor.get(id)!.contextPercent!;
    assert.ok(atRest > 0, "the startup read reports something, which is what makes the stall visible");

    await supervisor.prompt(id, "do the thing");

    /*
     * The assertion the report is about: numbers move during a TURN, while the agent is still working.
     *
     * The state is taken from the BROADCAST that carried the number, not from a poll afterwards. A poll races
     * the rest of the scripted run; the update is the exact moment a client would have rendered, and asserting
     * on it is also the assertion that the transport receives the numbers at all — the rail and the header read
     * nothing but these broadcasts.
     *
     * With the refresh gated on `agent_settled` (the defect), the wait below times out while the session is
     * mid-run — which is exactly the screen the report describes.
     */
    await until(
      () => seen,
      (updates) => updates.some((session) => (session.contextPercent ?? 0) > atRest),
      "context usage to move DURING the run",
    );
    const during = seen.find((session) => (session.contextPercent ?? 0) > atRest);
    assert.ok(during, "an update carrying the new numbers must reach the transport");
    assert.equal(during.state, "streaming", "the numbers moved while the agent was still working");
    assert.ok(during.tokensTotal !== null && during.tokensTotal > 0, "token totals arrive too");
    assert.ok(during.cost !== null && during.cost > 0, "and the cost — the other number the header shows");

    // And it keeps moving: the second turn reports a newer answer, so the meter is not frozen at turn 1.
    const firstPercent = during.contextPercent!;
    await until(
      () => supervisor.get(id),
      (session) => (session?.contextPercent ?? 0) > firstPercent,
      "the meter to advance on a later turn",
    );

    // The run still settles normally afterwards — the refresh is additive, not a replacement (C8).
    await until(() => supervisor.get(id), (session) => session?.state === "idle", "the run to settle");
  } finally {
    await supervisor.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
