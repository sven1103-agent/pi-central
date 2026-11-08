/**
 * "Keep sessions running" really does leave one running (issue #216, criterion 4).
 *
 * ## The claim, and why it needs a real process
 *
 * The criterion is *"the child is left alive with its own session (or at least survives the parent's exit), and the
 * app exits without sending `SIGINT`/`SIGTERM` to it. Asserted by an integration test that exits the app and then
 * re-finds the process."* None of that is a decision that can be unit-tested: it is a fact about the process tree,
 * and the ways to get it wrong are mundane — a missing `detached: true`, a stdio pipe whose closure kills the
 * child, an exit handler that signals on the way out.
 *
 * So the shape the shell builds is rebuilt here in a fixture: a **parent** that spawns the orchestrator detached
 * with piped stdio, reports the announced URL, and then ends. This file re-finds the orchestrator afterwards by
 * asking its port for the UI.
 *
 * ## The first version of this test could not fail, and that is why it is written this way
 *
 * It asserted only "the orchestrator answers after its parent exited" — and it passed with `detached: false` as
 * readily as with `detached: true`. Measured, not guessed: an orphaned child on macOS survives its parent's normal
 * exit either way, so the flag was not what the assertion was testing. A test that gives the same verdict for both
 * spellings of the option is not evidence for either, and stating the falsification is what caught it.
 *
 * What `detached` actually buys is a **process group**. Without it the orchestrator is in the app's group, and a
 * signal aimed at that group — `kill -TERM -<pgid>`, which is what a shell's job control, a logout and a `kill %1`
 * all do — reaches every session under it. With it, the orchestrator has a group of its own and the app can be
 * signalled out from under the reader without touching the work. So the test sends a group signal and asserts the
 * orchestrator is *not* in that group; that assertion fails with `detached: false`.
 *
 * ## What is still not proven here
 *
 * That Electron's `⌘Q` reaches this path, and that the dialog offers it — `lifecycle-wiring.test.ts` reads the main
 * process for the first, and the manual pass in [DOGFOODING](../../../docs/DOGFOODING.md) is the second. This file
 * proves the *outcome* the dialog promises.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerIsOurs, PROBE_TIMEOUT_MS, type ProbeAnswer } from "../src/runtime-record.ts";

const BUNDLE = fileURLToPath(new URL("../../../bin/pi-central.js", import.meta.url));
const UI_DIST = fileURLToPath(new URL("../../../dist/ui", import.meta.url));
const SKIP = existsSync(BUNDLE)
  ? false
  : "bin/pi-central.js is not built; run npm run build:package (CI builds it in the package job)";

/**
 * The parent fixture: spawn detached, report, wait to be signalled.
 *
 * `detached` is taken from argv so the same fixture can build both shapes — which is what makes the falsification
 * possible. It is written to a file rather than inlined into `node -e` because a shell-quoted program is a place
 * bugs hide, and this is meant to be readable as the thing it reproduces.
 */
const PARENT = `
import { spawn } from "node:child_process";
const [bundle, uiDist, detachedFlag] = process.argv.slice(2);
const child = spawn(process.execPath, [bundle, "--port", "0", "--ui-dist", uiDist, "--allow-unsandboxed-host"], {
  detached: detachedFlag === "detached",
  // The shell pipes the child's output and parses it. Kept here because the pipe is one of the things that could
  // be the cause of a child's death, and a fixture that dropped it would be testing a different shape.
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
let buffer = "";
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const match = /PI_CENTRAL_URL=(ws:\\/\\/[^\\s]+)/.exec(buffer);
  if (match === null) return;
  process.stdout.write(JSON.stringify({ url: match[1], pid: child.pid }) + "\\n");
  /*
   * Stay alive without signalling anything, so the test can signal the GROUP this process belongs to. The child's
   * exit would be reported, so a death is visible rather than inferred from a timeout.
   */
  child.on("exit", (code, signal) => {
    process.stdout.write(JSON.stringify({ event: "child-exit", code, signal }) + "\\n");
  });
});
setTimeout(() => {
  process.stderr.write("no URL within 20 s\\n" + stderr);
  process.exit(1);
}, 20_000);
`;

interface ParentRun {
  url: string;
  pid: number;
  /** Resolves with the orchestrator's exit report, or `undefined` if it is still running after `graceMs`. */
  expectExit: (graceMs: number) => Promise<{ code: number | null; signal: string | null } | undefined>;
  /** The parent process, already in its own session so `-pid` addresses exactly its group. */
  parent: ReturnType<typeof spawn>;
}

/**
 * Run the fixture and resolve once it reports the orchestrator's URL.
 *
 * The parent is spawned in its own session (`detached: true`), so `-parent.pid` names a group containing the parent
 * and — when the orchestrator was spawned without detachment — the orchestrator as well. That is precisely the group
 * a shell's job control signals, which is what the first test below aims at.
 *
 * Every failure path kills the group before rejecting. A fixture that leaked its parent would leave a 20-second
 * timer holding the test runner open, which is how the first version of this file appeared to hang rather than fail.
 */
async function runParent(t: { after: (fn: () => void) => void }, detached: boolean): Promise<ParentRun> {
  const dir = mkdtempSync(join(tmpdir(), "pi-central-detach-"));
  const path = join(dir, "parent.mjs");
  writeFileSync(path, PARENT, "utf8");
  // The directory is removed when the test ends, not now: `node` has to be able to read the file it was given.
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const parent = spawn(process.execPath, [path, BUNDLE, UI_DIST, detached ? "detached" : "attached"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const parentPid = parent.pid;
  // Registered before the wait, so a rejection below cannot leave the fixture running.
  t.after(() => {
    if (parentPid !== undefined) safeKillGroup(parentPid);
  });

  let out = "";
  let err = "";
  parent.stdout?.setEncoding("utf8");
  parent.stderr?.setEncoding("utf8");
  parent.stdout?.on("data", (chunk: string) => {
    out += chunk;
  });
  parent.stderr?.on("data", (chunk: string) => {
    err += chunk;
  });

  const reported = await new Promise<{ url: string; pid: number }>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`the parent reported no URL within 20 s\n${out}\n${err}`)), 20_000);
    const poll = setInterval(() => {
      const line = out.split("\n").find((entry) => entry.includes("\"url\""));
      if (line === undefined) return;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(JSON.parse(line) as { url: string; pid: number });
    }, 20);
  });

  return {
    ...reported,
    parent,
    expectExit: (graceMs: number) =>
      new Promise((resolve) => {
        const check = setInterval(() => {
          const line = out.split("\n").find((entry) => entry.includes("child-exit"));
          if (line === undefined) return;
          clearInterval(check);
          resolve(JSON.parse(line) as { code: number | null; signal: string | null });
        }, 20);
        setTimeout(() => {
          clearInterval(check);
          resolve(undefined);
        }, graceMs);
      }),
  };
}

/** Ask a port for `/`, following one same-origin redirect. */
async function askPort(port: number): Promise<ProbeAnswer> {
  const seek = async (path: string): Promise<ProbeAnswer> => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const body = response.status === 200 ? await response.text() : "";
      return { ok: true, status: response.status, location: response.headers.get("location") ?? undefined, body };
    } catch (error) {
      return { ok: false, reason: (error as Error).message, refused: false };
    }
  };
  const first = await seek("/");
  if (!first.ok) return first;
  if (first.status >= 300 && first.status < 400 && first.location !== undefined) {
    return seek(new URL(first.location, `http://127.0.0.1:${port}`).pathname);
  }
  return first;
}

/**
 * Kill one process group, or nothing at all.
 *
 * `process.kill(0, …)` and `process.kill(-0, …)` signal **the caller's own group**, so a PID of `0` or `undefined`
 * reaching this function would kill the test runner (and whatever else shares its group). The guard is the whole
 * reason this is a function: the first version of this file called `killGroup(run.parent.pid ?? 0)`, which is a
 * harmless-looking fallback that is not harmless.
 */
function safeKillGroup(pgid: number | undefined): void {
  if (pgid === undefined || !Number.isInteger(pgid) || pgid <= 1) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Already gone, which is one of the answers under test.
  }
}

test("the orchestrator is in its own process group, so a signal to the app's group misses it", { skip: SKIP }, async (t) => {
  const run = await runParent(t, true);
  const parentPid = run.parent.pid;
  assert.ok(parentPid !== undefined);
  t.after(() => safeKillGroup(run.pid));

  // The orchestrator is alive and serving first, so that what follows is about the signal and not about a start
  // that never worked.
  const port = Number.parseInt(new URL(run.url).port, 10);
  const before = await askPort(port);
  assert.equal(before.ok, true, `the orchestrator serves before the signal: ${JSON.stringify(before)}`);
  assert.equal(answerIsOurs(before), true);

  /*
   * Signal the GROUP the app belongs to, and nothing else. With `detached: true` the orchestrator is not a member of
   * it — this is the assertion that fails when the flag is dropped, which the first version of this test did not do.
   */
  process.kill(-parentPid, "SIGTERM");

  // The orchestrator must not have exited. `expectExit` reports one if it does, so this is an assertion about the
  // child rather than a timeout being read as success.
  const exited = await run.expectExit(1_500);
  assert.equal(exited, undefined, `the orchestrator was signalled with the app's group: ${JSON.stringify(exited)}`);

  const after = await askPort(port);
  assert.equal(after.ok, true, `the orchestrator survives a signal to the app's process group: ${JSON.stringify(after)}`);
  assert.equal(answerIsOurs(after), true, "and it is still Pi Central serving its own UI");
});

test("a parent that exits without signalling leaves the orchestrator serving", { skip: SKIP }, async (t) => {
  // The other half of the criterion, and the one the first version of this file covered: "survives the parent's
  // exit". It passes for both `detached` spellings on macOS — which is why it is the *second* test here and not the
  // only one, and why the group assertion above is the load-bearing one.
  const run = await runParent(t, true);
  t.after(() => safeKillGroup(run.pid));

  const port = Number.parseInt(new URL(run.url).port, 10);
  // The parent is ended without a signal to the child: `SIGKILL` to the parent alone, never to the group.
  run.parent.kill("SIGKILL");
  await new Promise<void>((resolve) => run.parent.on("exit", () => resolve()));

  const answer = await askPort(port);
  assert.equal(answer.ok, true, `the orchestrator outlived the parent that started it: ${JSON.stringify(answer)}`);
  if (!answer.ok) return;
  assert.equal(answerIsOurs(answer), true, "and it is still serving Pi Central's UI");
});

/**
 * The defect this found, kept as a test because it would have made criterion 4 false in the field.
 *
 * ## What it was
 *
 * The shell reads the orchestrator's banner from a **pipe**. When `⌘Q` → "Keep sessions running" ends the shell, that
 * pipe's read end goes with it, and the orchestrator's next `console.log` fails with `EPIPE`. With no `stdout` error
 * listener, Node treats a stream `error` as unhandled and **terminates the process** — so the orchestrator would stop
 * within one write interval of the app quitting, and every session with it.
 *
 * Measured before the fix: a child whose parent read one line and exited died within 250 ms, having written nothing
 * to a log it was appending to on a timer. That is not a slow leak; it is the next `console.log` after the app quits.
 *
 * ## Why it is asserted through a real orchestrator and not a stub
 *
 * Because the fix is in `server.ts` (`tolerateClosedStream`), and a stub would test the stub. The shape reproduced here
 * is the shell's exact one: `detached: true`, `stdio: ["ignore", "pipe", "pipe"]`, read until the announced URL, then the
 * parent exits **without signalling**. The orchestrator must still be serving afterwards — which it can only be if its
 * output stream failure was tolerated.
 */
test("an orchestrator whose output pipe has closed still shuts down cleanly", { skip: SKIP }, async (t) => {
  /*
   * This test holds the pipes itself rather than going through the fixture, and that is what makes the exit code
   * observable: the orchestrator stays a direct child of this process, so `exit` fires here even after the read ends are
   * gone. Going through the fixture meant the parent died with the pipes, and the only thing left to observe was the
   * port — which cannot distinguish a clean exit from a crash.
   */
  const child = spawn(
    process.execPath,
    [BUNDLE, "--port", "0", "--ui-dist", UI_DIST, "--allow-unsandboxed-host"],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  t.after(() => safeKillGroup(child.pid));

  const url = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    let stderr = "";
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => reject(new Error(`no URL within 20 s\n${stderr}`)), 20_000);
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const match = /PI_CENTRAL_URL=(ws:\/\/[^\s]+)/.exec(buffer);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
  });

  /*
   * The shell's own teardown for "Keep sessions running" (`stopOrchestratorForQuit`): destroy the parent's read ends and
   * leave the child alive. Reproduced with the same calls, because the point is that this exact sequence is survivable.
   */
  child.stdout?.destroy();
  child.stderr?.destroy();

  // Still serving, so what follows is about the write and not about a start that never worked.
  const port = Number.parseInt(new URL(url).port, 10);
  const before = await askPort(port);
  assert.equal(before.ok, true, `the orchestrator serves after its pipes were released: ${JSON.stringify(before)}`);

  /*
   * Now make it write. `server.ts`'s SIGTERM handler greets the signal with `console.log`, which is a write into a pipe
   * whose reader is gone. Without a `stdout` error listener Node treats that `EPIPE` as an unhandled stream error and
   * terminates the process on the spot — the shutdown handler dies at its first line and every session is orphaned.
   *
   * That sequence is the product's: `⌘Q` -> Keep, quit, come back, quit and choose Stop. Measured before the fix: the
   * process died non-zero without stopping anything.
   */
  const exited = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    // A timeout is reported as a sentinel rather than as `null`, so it cannot be read as a clean exit.
    setTimeout(() => resolve({ code: -1, signal: "the test gave up waiting" }), 8_000);
    try {
      process.kill(-(child.pid ?? 0), "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  });
  assert.equal(
    exited.code,
    0,
    `the orchestrator did not shut down cleanly while its output pipe was closed, so a later Stop would orphan every session: ${JSON.stringify(exited)}`,
  );
});
