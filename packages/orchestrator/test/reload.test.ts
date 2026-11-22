/**
 * Reloading a session's resources through the real supervisor (issue #274).
 *
 * ## What this covers that a pure test cannot
 *
 * The mechanism is the whole decision (ADR-0015): Pi has no RPC `reload` command, so Pi Central provisions an
 * extension whose handler calls `ctx.reload()` and delivers its NAME as a `prompt`. Everything load-bearing is about
 * the frames that follow:
 *
 *   - the command sent is `prompt` with `/pi-central:reload`, and nothing else;
 *   - `disposition: "handled"` is the ONLY answer that counts as a reload — `started` means Pi took the text as a
 *     task for the model, which is what happens when the extension is not loaded;
 *   - an `extension_error` arriving during the call is a FAILED reload, even though the `prompt` response says
 *     `success: true` (measured against Pi: a throwing command handler produces exactly that pair);
 *   - `interrupt` aborts the run FIRST, because Pi refuses a reload while streaming;
 *   - a second reload while one is outstanding never reaches Pi.
 *
 * ## What each test would catch
 *
 *   - the command-shape test fails if this is wired to anything but the extension command — a bare `/reload`, which
 *     Pi would send to the model;
 *   - the `started` test fails if the disposition is ignored, which turns "your command is not loaded" into a
 *     reported success;
 *   - the extension-error test fails if a broken reload reads as a working one;
 *   - the interrupt test fails if the abort happens after the reload (which Pi then refuses);
 *   - the toolset tests fail if a staleness claim is fabricated in either direction: "changed" from nothing, or
 *     "unchanged" over a directory that could not be read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiRecord } from "@pi-central/protocol";

const { Supervisor } = await import("../src/supervisor.ts");

/**
 * A `pi --mode rpc` stand-in that plays the reload command.
 *
 * `FAKE_RELOAD_MODE` selects the scripted outcome:
 *   - `handled` — the extension command ran; `prompt` answers `handled`;
 *   - `started` — the extension is NOT loaded, so Pi takes the text as a prompt for the model;
 *   - `throws`  — the handler threw: an `extension_error`, then `success: true, disposition: "handled"`;
 *   - `slow`    — `handled`, with the answer held open long enough for a second press to arrive.
 *
 * `FAKE_RELOAD_LOG` records every command that arrives, so a test can assert the ORDER (abort before reload) and
 * that a refused press never reached Pi.
 */
const FAKE_PI = String.raw`
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const write = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const mode = process.env.FAKE_RELOAD_MODE ?? "handled";
const log = process.env.FAKE_RELOAD_LOG;

const note = (command) => {
  if (log) appendFileSync(log, JSON.stringify({ type: command.type, message: command.message ?? null }) + "\n");
};

const respond = (command, data, success = true) =>
  write({
    type: "response",
    id: command.id,
    command: command.type,
    success,
    ...(success ? { data } : { error: data }),
  });

const reload = async (command) => {
  if (mode === "started") {
    // Pi took the text as a prompt for the model: no run is started here either, because the test asserts the
    // DISPOSITION rather than the run.
    respond(command, { disposition: "started" });
    return;
  }
  if (mode === "throws") {
    // Measured against Pi 1.6.0: a throwing command handler reports extension_error, and the prompt response
    // STILL says success with disposition handled.
    write({ type: "extension_error", extensionPath: "command:pi-central:reload", event: "command", error: "Wait for the current response to finish before reloading." });
    respond(command, { disposition: "handled" });
    return;
  }
  if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 400));
  respond(command, { disposition: "handled" });
};

const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  note(command);
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
      respond(command, { tokens: { total: 1 }, cost: 0, contextUsage: { percent: 10 } });
      return;
    case "prompt":
      if (String(command.message ?? "").startsWith("/")) {
        void reload(command);
        return;
      }
      /*
       * A real run: Pi announces the run BEFORE accepting the prompt, and answers only after the run has started.
       * That ordering is what the interrupt test needs, because the abort must be sent to a session Pi considers
       * streaming — and a reload sent first would be refused by Pi for exactly this reason.
       */
      write({ type: "agent_start" });
      respond(command, { disposition: "started" });
      return;
    case "abort":
      // Pi would refuse a reload after this point, so the stand-in does too: the test asserting the ORDER of the
      // two commands is what catches a reload sent before the abort.
      write({ type: "agent_end", messages: [], willRetry: false });
      write({ type: "agent_settled", aborted: true });
      respond(command, {});
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
  root: string;
  work: string;
  agentDir: string;
  reloadLog: string;
  records: PiRecord[];
  cleanup: () => Promise<void>;
}

async function harness(mode: "handled" | "started" | "throws" | "slow"): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "pi-central-reload-"));
  const pi = join(root, "fake-pi");
  writeFileSync(pi, `#!${process.execPath}\n${FAKE_PI}`, { mode: 0o755 });
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const agentDir = join(root, "provider");
  mkdirSync(agentDir, { recursive: true });
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, "");
  const reloadLog = join(root, "reload.log");

  const supervisor = new Supervisor({
    workspaceRoot: join(root, "workspaces"),
    stateRoot: join(root, "state"),
    sessionsRoot: join(root, "sessions"),
    safehouse: "unused",
    pi,
    agentRoot: join(root, "agent"),
    fragmentDir: join(root, "state", "policy"),
    agentRootManaged: true,
    providerAgentDir: agentDir,
    home: root,
    installationRoot: join(root, "installation"),
  });
  supervisor.on("error", () => {});
  const records: PiRecord[] = [];
  supervisor.on("record", (_sessionId: string, record: PiRecord) => records.push(record));

  const started = supervisor.resume(
    {
      path: sessionFile,
      id: "uuid-1",
      cwd: work,
      created: new Date().toISOString(),
      modifiedMs: Date.now(),
      bytes: 0,
      messageCount: 0,
      firstMessage: "reload me",
      cwdExists: true,
      scratch: false,
    },
    {
      // Direct mode is the one in which a stand-in binary is reachable without composing a policy (C1).
      mode: "direct",
      env: { FAKE_SESSION_FILE: sessionFile, FAKE_RELOAD_MODE: mode, FAKE_RELOAD_LOG: reloadLog },
    },
  );
  if (!started.ok) {
    rmSync(root, { recursive: true, force: true });
    assert.fail(started.message);
  }
  const id = started.session.id;
  await until(() => supervisor.get(id), (session) => session?.state === "idle", "the session to reach idle");

  return {
    supervisor,
    id,
    root,
    work,
    agentDir,
    reloadLog,
    records,
    cleanup: async () => {
      await supervisor.stopAll();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function commandsSent(logPath: string): { type: string; message: string | null }[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { type: string; message: string | null });
}

test("a reload is delivered as the extension command, through prompt, and nothing else", async () => {
  const { supervisor, id, reloadLog, cleanup } = await harness("handled");
  try {
    await supervisor.reload(id);
    const prompts = commandsSent(reloadLog).filter((command) => command.type === "prompt");
    assert.equal(prompts.length, 1, "one press is one command");
    /*
     * The exact text, and the assertion is deliberately this strict. `/reload` would be a BUILT-IN TUI command, which
     * Pi excludes from `get_commands` because it "would not execute if sent via prompt" — so sending it would deliver
     * the word to the MODEL as a task. The name must be the extension's, and it must be prefixed, because that prefix
     * is what makes Pi look for a command rather than start a run.
     */
    assert.equal(prompts[0]?.message, "/pi-central:reload");
  } finally {
    await cleanup();
  }
});

test("a prompt Pi did not run as a command is a FAILED reload, not a silent success", async () => {
  const { supervisor, id, cleanup } = await harness("started");
  try {
    await assert.rejects(() => supervisor.reload(id), /disposition: started/);
    // And the reason names the cause, because "reload failed" would send the reader to the wrong place entirely.
    await assert.rejects(() => supervisor.reload(id), /not loaded in this session/);
  } finally {
    await cleanup();
  }
});

test("an extension_error during the reload makes it fail, even though prompt answered success", async () => {
  const { supervisor, id, cleanup } = await harness("throws");
  try {
    // This is the defect the issue names: "a failed reload is reported as success". Pi answers
    // { success: true, disposition: "handled" } for a handler that threw, so the disposition alone is not evidence.
    await assert.rejects(() => supervisor.reload(id), /the reload failed: Wait for the current response to finish/);
  } finally {
    await cleanup();
  }
});

test("interrupt aborts the run BEFORE the reload, because Pi refuses one while streaming", async () => {
  const { supervisor, id, reloadLog, cleanup } = await harness("handled");
  try {
    await supervisor.prompt(id, "do something").catch(() => undefined);
    await until(() => supervisor.get(id), (session) => session?.state === "streaming", "a streaming session");
    await supervisor.reload(id, { interrupt: true });
    const sent = commandsSent(reloadLog);
    const abortAt = sent.findIndex((command) => command.type === "abort");
    // By MESSAGE, not by type: the run's own prompt is also a `prompt`, and matching the first one would compare the
    // abort against a command that was sent before the reader ever pressed anything.
    const reloadAt = sent.findIndex((command) => command.message === "/pi-central:reload");
    const summary = sent.map((command) => command.message ?? command.type).join(",");
    assert.ok(abortAt !== -1, `an abort must be sent, saw: ${summary}`);
    assert.ok(reloadAt !== -1, `the reload command must be sent, saw: ${summary}`);
    assert.ok(reloadAt > abortAt, `the reload must follow the abort, saw: ${summary}`);
  } finally {
    await cleanup();
  }
});

test("without interrupt, nothing is aborted: the run is left alone", async () => {
  const { supervisor, id, reloadLog, cleanup } = await harness("handled");
  try {
    await supervisor.prompt(id, "do something").catch(() => undefined);
    await until(() => supervisor.get(id), (session) => session?.state === "streaming", "a streaming session");
    await supervisor.reload(id).catch(() => undefined);
    const sent = commandsSent(reloadLog).map((command) => command.type);
    assert.ok(!sent.includes("abort"), "a run must not be abandoned unless the caller said so");
  } finally {
    await cleanup();
  }
});

test("a second reload while one is outstanding is refused, and never reaches Pi", async () => {
  const { supervisor, id, reloadLog, cleanup } = await harness("slow");
  try {
    const first = supervisor.reload(id);
    await until(() => supervisor.get(id), (session) => session?.reloading === true, "the reload to be marked outstanding");
    await assert.rejects(() => supervisor.reload(id), /a reload is already running/i);
    await first;
    const prompts = commandsSent(reloadLog).filter((command) => command.type === "prompt");
    assert.equal(prompts.length, 1, "the refused press must not reach Pi");
  } finally {
    await cleanup();
  }
});

test("a reload on a session with no live process is refused with a stated reason", async () => {
  const { supervisor, id, reloadLog, cleanup } = await harness("handled");
  try {
    await supervisor.stop(id);
    await assert.rejects(() => supervisor.reload(id), /not running.*no resources to reload/i);
    assert.deepEqual(
      commandsSent(reloadLog).filter((command) => command.type === "prompt"),
      [],
      "a stopped session must not be sent a reload command",
    );
  } finally {
    await cleanup();
  }
});

test("a reload that succeeded is remembered as the moment the resources were read", async () => {
  const { supervisor, id, cleanup } = await harness("handled");
  try {
    const before = supervisor.toolset(id).resourcesLoadedAt;
    assert.ok(before !== undefined, "a spawned session knows when it read its resources");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await supervisor.reload(id);
    const after = supervisor.toolset(id).resourcesLoadedAt;
    assert.ok(after !== undefined && after >= before, "the moment must move forward, or a stale session would read as fresh");
  } finally {
    await cleanup();
  }
});

test("a file added after the session read its resources makes the toolset read as changed", async () => {
  const { supervisor, id, work, cleanup } = await harness("handled");
  try {
    assert.equal(supervisor.toolset(id).freshness, "unchanged", "nothing has happened yet");
    const loadedAt = supervisor.toolset(id).resourcesLoadedAt;
    assert.ok(loadedAt !== undefined);
    // The real case this issue is about: a skill added while the session runs. The mtime is set RELATIVE to the
    // session's own reference moment rather than to `Date.now()`, so the assertion cannot drift into a tolerance
    // window — and 5 ms after that moment is unambiguously "written since".
    mkdirSync(join(work, ".pi", "skills"), { recursive: true });
    const skill = join(work, ".pi", "skills", "new-skill.md");
    writeFileSync(skill, "# a skill\n");
    utimesSync(skill, (loadedAt + 5) / 1000, (loadedAt + 5) / 1000);
    assert.equal(supervisor.toolset(id).freshness, "changed");
    // And after a reload it is current again, which is what makes the warning actionable rather than permanent.
    await supervisor.reload(id);
    assert.equal(supervisor.toolset(id).freshness, "unchanged");
  } finally {
    await cleanup();
  }
});

test("a write inside the SAME millisecond as the resource read does not read as changed", async () => {
  /*
   * macOS reports `mtimeMs` as a float while `Date.now()` is an integer, so an unfloored comparison makes a file
   * written 0.6 ms AFTER the reference moment — the same millisecond — read as newer than it. In practice that is a
   * file saved while the session was reading its resources, and the consequence is a session that reports "changed"
   * for ever: the reload moves the reference to `Date.now()`, and the file's fractional mtime is still past it.
   *
   * The mtime is set explicitly rather than raced for, so this is a statement about the comparison and not about how
   * fast the filesystem is.
   */
  const { supervisor, id, work, cleanup } = await harness("handled");
  try {
    const loadedAt = supervisor.toolset(id).resourcesLoadedAt;
    assert.ok(loadedAt !== undefined);
    const dir = join(work, ".pi", "prompts");
    mkdirSync(dir, { recursive: true });
    const prompt = join(dir, "review.md");
    writeFileSync(prompt, "# review\n");
    // 0.6 ms past the reference moment: within the same millisecond, and fractional.
    const seconds = (loadedAt + 0.6) / 1000;
    /*
     * The DIRECTORY's mtime is set too, and leaving it alone is what made the first version of this test pass for
     * the wrong reason: creating the directory after the session started makes it newer than the reference moment
     * on its own, so "changed" came from the mkdir rather than from the file. Both are part of what is measured.
     */
    utimesSync(prompt, seconds, seconds);
    utimesSync(dir, seconds, seconds);
    utimesSync(join(work, ".pi"), seconds, seconds);
    utimesSync(work, seconds, seconds);
    assert.equal(supervisor.toolset(id).freshness, "unchanged", "a sub-millisecond difference is the same millisecond");
  } finally {
    await cleanup();
  }
});

test("a location that exists and cannot be read makes the answer UNKNOWN, never unchanged", async () => {
  /*
   * A symlink loop rather than a mode change, and the difference is why this test can fail on every host: `chmod
   * 000` is not a failure for a process running as root, so a mode-based fixture would quietly assert nothing in
   * CI. `ELOOP` is an error for root too.
   *
   * What it protects is the rule C14 states one level up: a check that could not look has not found anything, and
   * reporting that as "unchanged" is a fabricated clean result.
   */
  const { supervisor, id, work, cleanup } = await harness("handled");
  try {
    mkdirSync(join(work, ".pi"), { recursive: true });
    symlinkSync("skills", join(work, ".pi", "skills"));
    const status = supervisor.toolset(id);
    assert.equal(status.freshness, "unknown");
    assert.ok(status.unreadable.length > 0, "unknown freshness must name what could not be read");
    assert.equal(status.unreadable[0]?.code, "ELOOP");
  } finally {
    await cleanup();
  }
});

test("the toolset lists what it actually looked at, and says what it cannot see", async () => {
  const { supervisor, id, cleanup } = await harness("handled");
  try {
    const status = supervisor.toolset(id);
    // The evidence, not only the verdict: a claim of freshness with no list of locations is an assertion.
    assert.ok(status.watched.length > 0, "the locations that answered travel with the answer");
    for (const location of status.watched) {
      assert.ok(location.path.startsWith("/"), "a location is an absolute path a reader can go and look at");
      assert.ok(["agent", "project"].includes(location.scope));
    }
    // The limit, stated on the payload rather than only in documentation: some sources are outside every watched
    // location, so "unchanged" cannot mean "current".
    assert.ok(status.unwatched.length > 0, "a check that cannot see everything must say so");
  } finally {
    await cleanup();
  }
});