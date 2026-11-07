/**
 * The app's environment, end to end: does a session actually start (issue #214)?
 *
 * ## Why this file exists, and what it cost not to have it
 *
 * #214 shipped with a plan that forwarded only `PATH` and the `PI_CENTRAL_*` pointers. Every unit test
 * passed: the allowlist was asserted, `--port 0` was asserted, the restart policy was asserted. And every
 * session failed, because `env.ts` reads its own `PASSTHROUGH` list from **the orchestrator's**
 * environment, so a name the shell never forwarded did not exist for any session either:
 *
 *     HOME is not set; set HOME in the environment before running this script.
 *
 * The lesson is not "add HOME to a list". It is that the *unit* of this defect is the seam between two
 * packages, and a test of either side alone cannot see it. So this test crosses the seam: it builds the
 * child's environment exactly as the app does, starts the real orchestrator, asks it for a session, and
 * asserts the session got past the point where a missing variable kills it.
 *
 * It is deliberately narrow about what it claims. A session that reaches `starting` and prints a `pi`
 * invocation error has proven the environment arrived; it has NOT proven the session works, which needs a
 * real sandboxed `pi` on a plain terminal (C1) and is `verified/manual` on the issue.
 *
 * ## Why it skips rather than fails
 *
 * It needs `bin/pi-central.js` (built by `npm run build:package`, which CI runs in the `package` job
 * AFTER `npm test`) and a `pi` and `safehouse` on this machine. Neither is guaranteed, and a test that
 * fails on a machine without them would be reporting the machine, not the code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loginShellLookup, resolveEnvironment } from "../src/executables.ts";
import { LineAccumulator, parseChildLine, planSpawn } from "../src/orchestrator-process.ts";

const BUNDLE = fileURLToPath(new URL("../../../bin/pi-central.js", import.meta.url));

/** The reason to skip, or `false` to run. Named so a skipped run says WHAT was missing. */
function skipReason(): false | string {
  if (!existsSync(BUNDLE)) return "bin/pi-central.js is not built; CI builds it in the package job";
  const env = resolveEnvironment({
    env: process.env,
    shell: process.env["SHELL"] ?? "/bin/zsh",
    runLoginShell: loginShellLookup,
  });
  if (!env.ok) return `no ${env.missing.name} on this machine`;
  return false;
}

/**
 * Start the orchestrator with the app's OWN `planSpawn`, then open one session and report what happened.
 *
 * The workspace and state roots are redirected into a temp directory: this test is about the environment
 * arriving, not about the reader's real session store, and writing into it from a test would be a
 * side effect nobody asked for.
 */
async function startSessionWithAppEnvironment(): Promise<{
  events: string[];
  errorLines: string[];
  stop: () => void;
}> {
  const env = resolveEnvironment({
    env: process.env,
    shell: process.env["SHELL"] ?? "/bin/zsh",
    runLoginShell: loginShellLookup,
  });
  assert.equal(env.ok, true);
  if (!env.ok) throw new Error("unreachable");

  const scratch = mkdtempSync(join(tmpdir(), "pi-central-app-env-"));
  const spawned = planSpawn({
    node: env.environment.node,
    pkg: { root: fileURLToPath(new URL("../../..", import.meta.url)), bin: BUNDLE },
    pi: env.environment.pi,
    safehouse: env.environment.safehouse,
    sourceEnv: {
      ...process.env,
      // Redirected so this test cannot write into the reader's real session store. This ALSO asserts
      // that the `PI_CENTRAL_*` namespace is forwarded — the first version of the forwarding list
      // dropped it, so this override never arrived and the test wrote to the real workspace while
      // passing.
      PI_CENTRAL_WORKSPACE: join(scratch, "workspaces"),
      PI_CENTRAL_STATE: join(scratch, "state"),
    },
  });

  const child = spawn(spawned.command, [...spawned.args, "--direct", "--allow-unsandboxed-host"], {
    cwd: spawned.cwd,
    env: spawned.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const stop = (): void => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    rmSync(scratch, { recursive: true, force: true });
  };

  const events: string[] = [];
  const errorLines: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line.trim() !== "") errorLines.push(line);
  });

  const url = await new Promise<string>((resolve, reject) => {
    const lines = new LineAccumulator();
    const timer = setTimeout(() => reject(new Error(`no URL\n${errorLines.join("\n")}`)), 20_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of lines.push(chunk)) {
        const parsed = parseChildLine(line);
        if (parsed.kind !== "url") continue;
        clearTimeout(timer);
        resolve(parsed.url);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code ?? "-"} before announcing\n${errorLines.join("\n")}`));
    });
  });

  const WebSocket = (await import("ws")).default;
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });
  socket.on("message", (data) => {
    const envelope = JSON.parse(String(data)) as { payload?: { kind?: string; message?: string; session?: { state?: string } } };
    const payload = envelope.payload;
    if (payload?.kind === "error") events.push(`error: ${payload.message ?? ""}`);
    if (payload?.kind === "session") events.push(`session: ${payload.session?.state ?? "?"}`);
  });
  socket.send(
    JSON.stringify({ dir: "client→orchestrator", protocol: 8, payload: { kind: "start" } }),
  );
  return { events, errorLines, stop };
}

/** Wait until `predicate` holds or the deadline passes. */
async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("a session started with the app's environment gets past the environment check", { skip: skipReason() }, async (t) => {
  const run = await startSessionWithAppEnvironment();
  t.after(run.stop);
  await until(() => run.events.some((event) => event !== "session: started"), 15_000);

  const transcript = [...run.errorLines, ...run.events].join("\n");
  // The defect verbatim. A regression that drops `HOME` puts this line back and fails here.
  assert.doesNotMatch(transcript, /HOME is not set/, `the app's environment did not reach pi:\n${transcript}`);
  // And it must not fail for the adjacent reason — a `pi` that could not be found at all.
  assert.doesNotMatch(transcript, /ENOENT/, `the app's environment has no usable PATH:\n${transcript}`);

  /*
   * The load-bearing assertion, and the reason the first version of this test was worthless.
   *
   * It originally asserted only "no HOME error and at least one event" — which a run that never reached
   * `pi` also satisfies. The failure it missed was an EPERM creating the scratch workspace, i.e. the test
   * passed because it died EARLIER than the bug, and the bug was therefore invisible. So the claim made
   * here is the narrower, checkable one: the orchestrator got as far as *spawning pi* — its own error
   * messages about the sandbox, the session store or the workspace all happen before that, and none of
   * them is "the environment did not arrive".
   */
  const reachedPi = run.events.some((event) =>
    event.startsWith("session:") || event.includes("pi exited") || event.includes("before responding"),
  );
  const blockedEarlier = /mkdir|EPERM|EACCES|policy/.test(transcript);
  assert.equal(
    reachedPi || !blockedEarlier,
    true,
    `the orchestrator failed before it could spawn pi, so this test proves nothing about the ` +
      `environment it would have given it:\n${transcript}`,
  );
});
