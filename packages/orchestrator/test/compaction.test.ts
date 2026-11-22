/**
 * Manual compaction through the real supervisor, against a stand-in `pi`.
 *
 * ## What this covers that a pure test cannot
 *
 * The feature is a WIRE decision: `Supervisor#compact` must send Pi exactly `{ type: "compact" }`,
 * wait for Pi's answer (the response arrives at the END of the summary), refuse a second press
 * while the first is outstanding, and let Pi's refusal reach the caller verbatim. All four are
 * about the sequence of frames, so the test runs the real `RpcProcess`, the real `Supervisor` and
 * the real `state.ts` against a small executable that speaks the same line protocol.
 *
 * The stand-in is installed where `pi` would be and launched in DIRECT mode — no Safehouse, no
 * credentials — so this runs in CI and inside another sandbox (C1). It answers the lifecycle
 * commands a session starts with, and scripts a compaction whose `compaction_start` can be held
 * open long enough for a second press to arrive.
 *
 * ## What each test would catch
 *
 *   - the command-shape test fails if the control is wired to `set_auto_compaction` or an `abort`;
 *   - the outstanding test fails if the guard reads `session.state` instead of the compaction;
 *   - the `agent_end` test fails if compaction is modelled as a stop (C8);
 *   - the refusal test fails if Pi's sentence is replaced with a generic "compaction failed";
 *   - the after-compaction test fails if `contextPercent` is coerced to `0` when Pi reports `null`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveSession, PiRecord } from "@pi-central/protocol";

const { Supervisor } = await import("../src/supervisor.ts");

/**
 * A `pi --mode rpc` stand-in.
 *
 * `FAKE_COMPACT_MODE` selects the scripted compaction:
 *   - `ok`     — start, a short summary, end, success response;
 *   - `slow`   — the same, with a start held open long enough for a second press;
 *   - `refuse` — Pi's own refusal sentence, on the response AND on `compaction_end`.
 *
 * `FAKE_COMPACT_LOG` records every compact command's own keys, so a test can prove Pi received
 * exactly the fields the control is allowed to send — and that only ONE command was sent.
 */
const FAKE_PI = String.raw`
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const write = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const mode = process.env.FAKE_COMPACT_MODE ?? "ok";
const log = process.env.FAKE_COMPACT_LOG;
let compacted = false;
let statsAsks = 0;

const respond = (command, data, success = true) =>
  write({
    type: "response",
    id: command.id,
    command: command.type,
    success,
    ...(success ? { data } : { error: data }),
  });

const stats = (id) => {
  statsAsks += 1;
  return {
    type: "response",
    id,
    command: "get_session_stats",
    success: true,
    data: {
      tokens: { total: 42000 + statsAsks },
      cost: 0.1,
      contextUsage: {
        tokens: 1000,
        contextWindow: 200000,
        // Pi's own rule, and the fact this file pins: NULL after a compaction, never 0.
        percent: compacted ? null : 84,
      },
    },
  };
};

const compact = async (command) => {
  if (log) appendFileSync(log, JSON.stringify({ keys: Object.keys(command).sort(), type: command.type }) + "\n");
  if (mode === "refuse") {
    write({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
      errorMessage: "Nothing to compact (session too small)",
    });
    respond(command, "Nothing to compact (session too small)", false);
    return;
  }
  compacted = true;
  write({ type: "compaction_start", reason: "manual" });
  await new Promise((resolve) => setTimeout(resolve, mode === "slow" ? 500 : 20));
  write({
    type: "compaction_end",
    reason: "manual",
    result: { tokensBefore: 80000, tokensAfter: 20000 },
    aborted: false,
    willRetry: false,
  });
  respond(command, { tokensBefore: 80000, estimatedTokensAfter: 20000 });
};

const run = async () => {
  write({ type: "agent_start" });
  compacted = true;
  write({ type: "compaction_start", reason: "manual" });
  write({
    type: "compaction_end",
    reason: "manual",
    result: { tokensBefore: 80000, tokensAfter: 20000 },
    aborted: false,
    willRetry: false,
  });
  // agent_end, and no agent_settled: C8 says the session is still working.
  write({ type: "agent_end", messages: [], willRetry: false });
};

const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  switch (command.type) {
    case "get_state":
      respond(command, {
        model: { provider: "test", id: "test-model" },
        isStreaming: false,
        sessionFile: process.env.FAKE_SESSION_FILE,
        sessionId: "uuid-1",
        messageCount: 0,
        pendingMessageCount: 0,
      });
      return;
    case "get_messages":
      respond(command, { messages: [] });
      return;
    case "get_session_stats":
      // Asynchronous, like a real child process: the supervisor's ordering must be its own.
      setTimeout(() => process.stdout.write(JSON.stringify(stats(command.id)) + "\n"), 5);
      return;
    case "compact":
      // Deferred so the supervisor's request bookkeeping runs before the first event arrives.
      setTimeout(() => {
        void compact(command);
      }, 0);
      return;
    case "prompt":
      respond(command, { disposition: "started" });
      setTimeout(() => {
        void run();
      }, 10);
      return;
    default:
      respond(command, {});
  }
});
`;

async function until<T>(read: () => T, predicate: (value: T) => boolean, describe: string): Promise<void> {
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

interface Harness {
  supervisor: InstanceType<typeof Supervisor>;
  id: string;
  compactLog: string;
  cleanup: () => Promise<void>;
}

/** Start a session against the stand-in, wait for it to be idle with its first stats read, and hand it back. */
async function harness(mode: "ok" | "slow" | "refuse"): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "pi-central-compact-"));
  const pi = join(root, "fake-pi");
  writeFileSync(pi, `#!${process.execPath}\n${FAKE_PI}`, { mode: 0o755 });
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, "");
  const compactLog = join(root, "compact.log");

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
    sidecarPort: undefined,
    browser: "/nonexistent/chrome",
  });
  supervisor.on("error", () => {});

  const started = supervisor.resume(
    {
      path: sessionFile,
      id: "uuid-1",
      cwd: work,
      created: new Date().toISOString(),
      modifiedMs: Date.now(),
      bytes: 0,
      messageCount: 0,
      firstMessage: "compact me",
      cwdExists: true,
      scratch: false,
    },
    {
      // Direct mode is the one in which a stand-in binary is reachable without composing a policy.
      mode: "direct",
      env: {
        FAKE_SESSION_FILE: sessionFile,
        FAKE_COMPACT_MODE: mode,
        FAKE_COMPACT_LOG: compactLog,
      },
    },
  );
  if (!started.ok) {
    rmSync(root, { recursive: true, force: true });
    assert.fail(started.message);
  }
  const id = started.session.id;

  try {
    await until(() => supervisor.get(id), (session) => session?.state === "idle", "the session to reach idle");
    // The first stats read lands just after the state does. Waiting for it means a later `null` is a CHANGE, not a
    // session that was never measured.
    await until(() => supervisor.get(id), (session) => session?.contextPercent === 84, "the startup stats read");
  } catch (error) {
    await supervisor.stopAll();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    supervisor,
    id,
    compactLog,
    cleanup: async () => {
      await supervisor.stopAll();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a compact control sends Pi exactly { type: 'compact' } and nothing else", async () => {
  const { supervisor, id, compactLog, cleanup } = await harness("ok");
  try {
    await supervisor.compact(id);
    const lines = existsSync(compactLog) ? readFileSync(compactLog, "utf8").trim().split("\n") : [];
    assert.equal(lines.length, 1, "one press is one command");
    const command = JSON.parse(lines[0]!) as { keys: string[]; type: string };
    // `id` is the transport's correlation handle, added by `RpcProcess.send`. Anything else — `customInstructions`,
    // `enabled`, a second type — would mean the control is not the one the issue asked for.
    assert.deepEqual(command.keys, ["id", "type"], `Pi received ${JSON.stringify(command.keys)}`);
    assert.equal(command.type, "compact", "and the command is compact, not set_auto_compaction or abort");
  } finally {
    await cleanup();
  }
});

test("after a manual compaction a null context reads as unmeasured, never as 0%", async () => {
  // Pi reports `contextUsage.percent: null` between a compaction and the next assistant response: the count genuinely
  // is unknown. Coercing it to 0 would draw an empty meter over a session nobody has measured — the fabricated zero
  // `stats.ts` and `ContextMeter.tsx` exist to refuse.
  const { supervisor, id, cleanup } = await harness("ok");
  try {
    await supervisor.compact(id);
    await until(() => supervisor.get(id), (session) => session?.contextPercent === null, "the post-compaction stats read");
    assert.equal(supervisor.get(id)?.contextPercent, null, "not 0, which would be a measurement Pi did not make");
  } finally {
    await cleanup();
  }
});

test("a compaction followed by agent_end leaves the session streaming, because it is not a stop (C8)", async () => {
  const { supervisor, id, cleanup } = await harness("ok");
  const records: PiRecord[] = [];
  supervisor.on("record", (_sessionId: string, record: PiRecord) => records.push(record));
  try {
    await supervisor.prompt(id, "work");
    await until(() => records, (seen) => seen.some((record) => record.type === "agent_end"), "agent_end after a compaction");
    // `compaction_end` refreshes stats, and Pi reports `null` afterwards. The session is still streaming: the run can
    // be followed by a retry, and treating `agent_end` as completion would mark a working session idle.
    await until(() => supervisor.get(id), (session) => session?.contextPercent === null, "the post-compaction stats read");
    const session = supervisor.get(id);
    assert.equal(session?.state, "streaming", "the session is still working after agent_end");
    assert.equal(session?.compacting, false, "and the compaction itself is no longer outstanding");
  } finally {
    await cleanup();
  }
});

test("a second press while compaction_start is outstanding is refused, and only one command is sent", async () => {
  const { supervisor, id, compactLog, cleanup } = await harness("slow");
  const records: PiRecord[] = [];
  supervisor.on("record", (_sessionId: string, record: PiRecord) => records.push(record));
  try {
    const first = supervisor.compact(id);
    // Wait for Pi's own announcement, which is the state the guard must read. A guard on `session.state` would need
    // the run to be streaming, and this session is idle — exactly the case that made the wrong guard look plausible.
    await until(() => records, (seen) => seen.some((record) => record.type === "compaction_start"), "compaction_start");
    await assert.rejects(() => supervisor.compact(id), /compaction is already running/i);
    await first;
    const lines = existsSync(compactLog) ? readFileSync(compactLog, "utf8").trim().split("\n") : [];
    assert.equal(lines.length, 1, "the refused press must not reach Pi");
  } finally {
    await cleanup();
  }
});

test("Pi's refusal reaches the caller verbatim, so the reason is not replaced by 'compaction failed'", async () => {
  const { supervisor, id, cleanup } = await harness("refuse");
  try {
    await assert.rejects(() => supervisor.compact(id), /Nothing to compact \(session too small\)/);
    // The refusal ended the compaction, so a later press is allowed again — the guard must not become a latch.
    assert.equal(supervisor.get(id)?.compacting, false);
  } finally {
    await cleanup();
  }
});

test("a session with no live process is refused with a stated reason, and Pi receives nothing", async () => {
  const { supervisor, id, compactLog, cleanup } = await harness("ok");
  try {
    await supervisor.stop(id);
    await assert.rejects(() => supervisor.compact(id), /not running.*nothing to compact/i);
    const lines = existsSync(compactLog) ? readFileSync(compactLog, "utf8").trim().split("\n") : [];
    assert.deepEqual(lines, [], "a stopped session must not be sent a compact command");
  } finally {
    await cleanup();
  }
});
