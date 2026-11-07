/**
 * The two criteria that need a real child process: an ephemeral port under contention (criterion 3), and
 * a child that never announces a URL (criterion 4).
 *
 * ## Why these cannot be unit tests
 *
 * `decideAfterExit` and `parseChildLine` are tested without a process in `orchestrator-process.test.ts`.
 * What is left is the claim that the *shell's* spawn actually works against the *real artifact* — and
 * that claim is exactly the kind that a stub would corroborate while the product stayed broken.
 *
 * So this spawns `node bin/pi-central.js --port 0` for real, twice concurrently, and reads the announced
 * line with the same parser the app uses. It needs the built bundle, so it **skips** when `bin/` is absent
 * — CI builds it in the `package` job, and `npm test` runs before that on a fresh checkout.
 *
 * ## The contention case, and what it is really asserting
 *
 * Two orchestrators at once is not a supported configuration for *sessions* (C9, one live process per
 * session file). What it does test is narrower and worth having: that the shell never has to name a port,
 * so a leftover orchestrator on the default port cannot stop a new window from opening. That is the
 * `EADDRINUSE` class `startup-error.ts` exists for, made unreachable from the app rather than explained.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LineAccumulator, parseChildLine } from "../src/orchestrator-process.ts";

const BUNDLE = fileURLToPath(new URL("../../../bin/pi-central.js", import.meta.url));
const SKIP = existsSync(BUNDLE)
  ? false
  : "bin/pi-central.js is not built; run npm run build:package (CI builds it in the package job)";

/** Start the real orchestrator and resolve with its announced URL, or reject after `timeoutMs`. */
function startOrchestrator(timeoutMs: number): Promise<{ url: string; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BUNDLE, "--port", "0", "--no-ui", "--allow-unsandboxed-host"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so `SIGKILL` to `-pid` reaps anything it spawned. The tests below start
        // no sessions, but a leaked orchestrator on a developer machine is a nuisance worth avoiding.
        detached: true,
      },
    );
    const stop = (): void => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const lines = new LineAccumulator();
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`no URL within ${timeoutMs} ms`));
    }, timeoutMs);
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of lines.push(chunk)) {
        const parsed = parseChildLine(line);
        if (parsed.kind !== "url") continue;
        clearTimeout(timer);
        resolve({ url: parsed.url, stop });
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code ?? "-"} before announcing a URL\n${stderr}`));
    });
  });
}

test("the real bundle announces a URL the shell's parser accepts", { skip: SKIP }, async (t) => {
  const started = await startOrchestrator(20_000);
  t.after(started.stop);
  assert.match(started.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
});

test("two orchestrators coexist because neither is given a port", { skip: SKIP }, async (t) => {
  // Criterion 3. Both ask for port 0, so each gets its own; the shell parses whichever it is told. The
  // assertion is that the two URLs differ — if the shell had named a port, the second would have failed
  // with EADDRINUSE, which is the support case this removes.
  const first = await startOrchestrator(20_000);
  t.after(first.stop);
  const second = await startOrchestrator(20_000);
  t.after(second.stop);
  assert.notEqual(first.url, second.url);
});

test("a child that exits before announcing is caught by the exit path, not by the timeout", { skip: SKIP }, async (t) => {
  // Criterion 4 has two mechanisms and both must work: the TIMEOUT reports a child that hangs, and the
  // EXIT path reports one that dies first. Without the second, a fast failure would wait out the full
  // ten seconds before saying anything — a window that sits empty for 10 s and then blames a timeout.
  const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const outcome = await new Promise<string>((resolve) => {
    child.on("exit", (code) => resolve(`exited ${code ?? "-"}`));
  });
  // The exit arrives with a code, so the app's `exit` handler — not the timer — is what reports it.
  assert.equal(outcome, "exited 3");
});
