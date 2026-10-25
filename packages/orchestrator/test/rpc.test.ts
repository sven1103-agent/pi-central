/**
 * RpcProcess integration tests, against real subprocesses.
 *
 * These use `/bin/cat` and `/bin/sh` instead of Pi: they exercise the transport — framing,
 * correlation, timeouts, teardown — which is exactly the part a fake would not test. No
 * credentials and no sandbox are involved, so this runs anywhere, including CI.
 *
 * The teardown tests exist because a bug was found here by hand: `stop()` fired SIGKILL and
 * returned immediately, so `running` was still true for a process that was already dying.
 * A caller doing `stopAll()` before exit could not tell a clean shutdown from a wedged one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcProcess } from "../src/rpc.ts";

const cwd = process.cwd();

/**
 * These tests exercise the transport, not the environment boundary (that is env.test.ts).
 * They still pass an explicit env, because `LaunchSpec.env` is required — deliberately, so
 * that "inherit process.env" cannot be expressed by accident (C11).
 */
function testEnv(): Record<string, string> {
  return { PATH: "/usr/bin:/bin" };
}

/** A process that echoes stdin, so a sent command produces no matching `response`. */
function echoProcess(): RpcProcess {
  return new RpcProcess({ command: "/bin/cat", args: [], cwd, env: testEnv() });
}

test("a command with no response times out near its deadline, rather than hanging", async () => {
  const rpc = echoProcess();
  rpc.start();
  const started = Date.now();
  await assert.rejects(
    () => rpc.send({ type: "get_state" }, 300),
    /timeout after 300ms/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 280 && elapsed < 2000, `timed out in ${elapsed}ms, not near the deadline`);
  await rpc.stop();
});

test("an in-flight command rejects when the process exits, instead of waiting for its timeout", async () => {
  const rpc = new RpcProcess({ command: "/bin/sh", args: ["-c", "sleep 0.2; exit 7"], cwd, env: testEnv() });
  const exitInfo = new Promise<{ code: number | null }>((resolve) => rpc.on("exit", resolve));
  rpc.start();

  const started = Date.now();
  // A 10s timeout: only the exit path can reject this quickly.
  await assert.rejects(() => rpc.send({ type: "get_state" }, 10_000), /pi exited before responding/);
  assert.ok(Date.now() - started < 5000, "rejected on exit, not on timeout");

  const exit = await exitInfo;
  assert.equal(exit.code, 7, "the real exit code is reported");
});

test("stop() resolves only once the process is actually reaped (SIGTERM ignored -> SIGKILL)", async () => {
  // A child that ignores SIGTERM forces the escalation path.
  const rpc = new RpcProcess({ command: "/bin/sh", args: ["-c", "trap '' TERM; sleep 30"], cwd, env: testEnv() });
  rpc.start();
  await new Promise((resolve) => setTimeout(resolve, 300));

  await rpc.stop(500); // short grace so the test stays quick
  assert.equal(rpc.running, false, "the process must be gone when stop() resolves");
});

test("stop() is prompt for a process that exits on stdin close", async () => {
  const rpc = echoProcess(); // `cat` exits when its stdin closes
  rpc.start();
  const started = Date.now();
  await rpc.stop(3000);
  assert.equal(rpc.running, false);
  assert.ok(Date.now() - started < 3000, "should not need the full escalation ladder");
});

test("stop() is idempotent", async () => {
  const rpc = echoProcess();
  rpc.start();
  await rpc.stop();
  await rpc.stop(); // must not throw or hang
  assert.equal(rpc.running, false);
});

test("send() on a stopped process rejects rather than throwing", async () => {
  const rpc = echoProcess();
  rpc.start();
  await rpc.stop();
  await assert.rejects(() => rpc.send({ type: "get_state" }, 1000), /not running/);
});

test("stderr is captured and available as a tail for diagnostics", async () => {
  const rpc = new RpcProcess({ command: "/bin/sh", args: ["-c", "echo boo >&2; sleep 0.1"], cwd, env: testEnv() });
  rpc.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match(rpc.stderrTail, /boo/);
  await rpc.stop();
});

test("start() twice is refused", () => {
  const rpc = echoProcess();
  rpc.start();
  assert.throws(() => rpc.start(), /already started/);
  return rpc.stop();
});
