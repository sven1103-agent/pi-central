/**
 * The probe against real processes and a real listener (issue #216, criteria 5 and 6).
 *
 * ## What only a live test can say
 *
 * `runtime-record.test.ts` decides what a probe's *answer* means. It cannot say whether the probe produces that
 * answer: `marksFromEtime` is a parser, and a parser test passes while the command that feeds it is wrong —
 * `ps -o etime=` on a platform that spells it differently, a `2>&1` that was dropped so `EPERM` looks like a
 * dead PID, a `/proc` path that does not exist. Those are the failures this file exists for, and each one is
 * invisible to a test that hands the parser a string.
 *
 * ## The two claims
 *
 *   1. **A live, identified process is adopted.** Spawn a real child, read its start time through the probe,
 *      write a record from it, and re-read: the round trip through `markIdentity` must hold. Then kill the
 *      child and assert the same probe now says `absent` — the same command, the two answers this slice needs.
 *   2. **"Is this the UI?" is answered by the page, not by the port.** Start the orchestrator's real static
 *      handler over its real built UI on an ephemeral port and assert `answerIsOurs`; then serve a *different*
 *      document on another port and assert it is refused. A `curl -f`-shaped check would call both a success.
 *
 * ## What it skips, and why that is stated rather than hidden
 *
 * The UI half needs `dist/ui/index.html`, which a fresh checkout does not have (CI builds it in the `package`
 * job, and `npm test` runs before that). The skip is named in the test output, so a run that did not check the
 * claim is visible rather than assumed — the same convention `spawn-live.test.ts` uses for `bin/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROBE_TIMEOUT_MS,
  answerIsOurs,
  connectionRefused,
  decideAttach,
  identityHolds,
  probeCommand,
  readRuntimeRecord,
  rememberedMarks,
  writeRuntimeRecord,
  type ProcessMarks,
  type ProbeAnswer,
} from "../src/runtime-record.ts";

const UI_DIST = fileURLToPath(new URL("../../../dist/ui", import.meta.url));

/** Run the probe exactly as `main.ts` will: through `sh`, with both streams merged by the command itself. */
function probe(pid: number): ProcessMarks {
  const [flag, script] = probeCommand(pid);
  const result = spawnSync("/bin/sh", [flag ?? "-c", script ?? ""], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    // The shell itself could not be run. Its own answer, and never "absent" — `rememberedMarks(undefined)`
    // is what main.ts gets in this case.
    return rememberedMarks(undefined, Date.now());
  }
  return rememberedMarks({ ok: result.status === 0, output: `${result.stdout}${result.stderr}` }, Date.now());
}

/** A real process to probe: this interpreter, doing nothing, in its own session so it can be reaped. */
function sleeper(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  const pid = child.pid;
  assert.ok(pid !== undefined, "the sleeper has a pid");
  return {
    pid,
    stop: () => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone, which is one of the answers under test.
        }
      }
    },
  };
}

/**
 * Wait until the probe reaches `status`, or the deadline passes.
 *
 * Returns early on `unknown` as well: on a host that forbids `ps` the probe will never reach `present`, and
 * spending the whole deadline to discover that would make this file slow for no information. `unknown` is a
 * final answer, not a transient state.
 */
async function untilMarks(pid: number, status: ProcessMarks["status"], timeoutMs = 5_000): Promise<ProcessMarks> {
  const deadline = Date.now() + timeoutMs;
  let last = probe(pid);
  while (Date.now() < deadline) {
    if (last.status === status || last.status === "unknown") return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
    last = probe(pid);
  }
  return last;
}

test("a real process is identified by the marks the record stores, and adopted", async (t) => {
  const child = sleeper();
  t.after(() => child.stop());

  const marks = await untilMarks(child.pid, "present");
  /*
   * The host this test runs on may forbid `ps` entirely (measured: `/bin/ps` returns `EPERM` under an agent
   * harness, while `/bin/sh` runs). That is a property of the *host*, not a failure of the probe — and the
   * assertion to make there is the honest one: the probe said `unknown`, which `decideAttach` turns into a
   * spawn with a warning rather than into a second orchestrator.
   */
  if (marks.status === "unknown") {
    t.diagnostic(`this host does not allow the probe (${marks.reason}); asserting the refuse-to-adopt branch`);
    const decision = decideAttach({
      record: { version: 1, pid: child.pid, port: 1, startedAt: 0, recordedAt: 0 },
      marks,
      answer: undefined,
      expectsNewProcess: false,
    });
    assert.equal(decision.verdict, "spawn");
    return;
  }

  assert.equal(marks.status, "present");
  assert.notEqual(marks.marks, undefined, "a live process has a start time on a host where `ps` answers");

  const recorded = { startedAt: marks.marks as number };
  assert.equal(identityHolds(recorded, marks), true, "the record written from this reading identifies this process");
  // A reading taken a moment later is still the same process: the tolerance is about `etime`'s resolution.
  const later = await untilMarks(child.pid, "present");
  assert.equal(identityHolds(recorded, later), true, "one process, two readings, one identity");

  // And a record written from a *different* reading — a PID recycled by a process that started later — is not.
  assert.equal(identityHolds({ startedAt: (marks.marks as number) + 60_000 }, later), false);
});

test("the record written from a live probe is what a later launch reads back", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-central-live-record-"));
  const child = sleeper();
  t.after(() => {
    child.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const marks = await untilMarks(child.pid, "present");
  if (marks.status !== "present" || marks.marks === undefined) {
    t.diagnostic(`the probe cannot identify a process on this host (${marks.status}); skipping the round trip`);
    return;
  }
  assert.deepEqual(writeRuntimeRecord(dir, { pid: child.pid, port: 51234, startedAt: marks.marks }), { ok: true });

  const { record, note } = readRuntimeRecord(dir);
  assert.equal(note, undefined);
  assert.ok(record !== undefined);
  // The whole point: what was read back is still the process that is running, measured again now.
  assert.equal(identityHolds(record, probe(child.pid)), true);
});

test("a killed process is `absent`, the same probe that said `present`", async (t) => {
  const child = sleeper();
  t.after(() => child.stop());

  const before = await untilMarks(child.pid, "present");
  if (before.status === "unknown") {
    t.diagnostic(`the probe cannot answer on this host (${before.reason}); skipping`);
    return;
  }
  assert.equal(before.status, "present");
  child.stop();

  const after = await untilMarks(child.pid, "absent");
  assert.equal(after.status, "absent", `a killed process is gone, not present: ${JSON.stringify(after)}`);
});

/** Start a throwaway server on an ephemeral port and return its port and a close function. */
async function serve(body: (path: string) => { status: number; headers?: Record<string, string>; body: string }): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const answer = body(req.url ?? "/");
    res.writeHead(answer.status, { "content-type": "text/html; charset=utf-8", ...(answer.headers ?? {}) });
    res.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Ask a port for `/`, following one redirect, exactly as `main.ts` will. */
async function askPort(port: number): Promise<ProbeAnswer> {
  const seek = async (path: string): Promise<ProbeAnswer> => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const body = response.status === 200 ? await response.text() : "";
      return { ok: true, status: response.status, location: response.headers.get("location") ?? undefined, body };
    } catch (error) {
      const message = (error as Error).message;
      // `ECONNREFUSED` is the one failure that means "nothing is listening", which is the only case where a
      // fresh bind is known to be safe. Classified by the module, because `main.ts` needs the same rule.
      return { ok: false, reason: message, refused: connectionRefused(error) };
    }
  };
  const first = await seek("/");
  if (!first.ok) return first;
  // `/` is served as a document by the UI handler, but a handler that redirects to `index.html` is followed once:
  // one redirect is a fact about the static handler, and the markers are what decide identity.
  if (first.status >= 300 && first.status < 400 && first.location !== undefined) {
    return seek(new URL(first.location, `http://127.0.0.1:${port}`).pathname);
  }
  return first;
}

const UI_SKIP = existsSync(join(UI_DIST, "index.html"))
  ? false
  : "dist/ui/index.html is not built; run npm run ui:build (CI builds it in the package job)";

test("the UI this shell serves is recognised by its own head, over a real listener", { skip: UI_SKIP }, async (t) => {
  const { createUiRequestHandler } = await import("../../orchestrator/src/static-ui.ts");
  const handler = createUiRequestHandler({ root: UI_DIST });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        // `fetch` keeps its socket alive, and `close` waits for it: without this the test holds the event loop
        // for the keep-alive timeout after its last assertion.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const ours = await askPort(address.port);
  assert.equal(ours.ok, true);
  assert.equal(answerIsOurs(ours), true, `the orchestrator's own UI is not recognised: ${JSON.stringify(ours).slice(0, 400)}`);
});

test("something else on the port is refused, which is what stops a stranger's page being shown", async (t) => {
  // The exact shape of the wrong answer: an `http` 200 for `/`. A check that only asked "does it answer" would
  // adopt this, and the window would display another application's page under Pi Central's dock icon.
  const stranger = await serve(() => ({ status: 200, body: "<!doctype html><title>Some other app</title><h1>hello</h1>" }));
  t.after(() => stranger.close());
  const answer = await askPort(stranger.port);
  assert.equal(answer.ok, true);
  assert.equal(answerIsOurs(answer), false);

  const decision = decideAttach({
    record: { version: 1, pid: process.pid, port: stranger.port, startedAt: Date.now(), recordedAt: Date.now() },
    marks: { status: "present", marks: Date.now(), summary: "00:00" },
    answer,
    expectsNewProcess: false,
  });
  assert.equal(decision.verdict, "spawn");
});

test("a closed port is refused as `refused`, so a fresh bind does not wait for a timeout", async () => {
  // Bind, note the port, close it: the port is now (almost certainly) free, and asks will be refused rather than
  // hanging. `decideAttach` uses `refused` to decide there is nothing to wait for.
  const gone = await serve(() => ({ status: 200, body: "x" }));
  const port = gone.port;
  await gone.close();

  const answer = await askPort(port);
  assert.equal(answer.ok, false);
  if (answer.ok) return;
  assert.equal(answer.refused, true, `a closed port reads as refused, not as a timeout: ${answer.reason}`);
});
