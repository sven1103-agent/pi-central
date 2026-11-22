/**
 * Launch Chromium for the sidecar, on a CDP PIPE (ADR-0015).
 *
 * Two measured facts shape this file, and both replaced an earlier version:
 *
 *   1. **`--no-sandbox` is mandatory.** Safehouse cannot permit Chromium's nested Seatbelt sandbox
 *      (`safehouse --help` says so; `chromium-full.sb` explains the re-init failure), so the renderer runs
 *      with Chrome's own sandbox OFF and its only confinement is the appended fragment.
 *   2. **The control channel is fd 3/4, not a port.** The WebSocket version needed the sidecar to reach its
 *      own browser over loopback, which its own egress rule forbids — measured: Chrome started, printed
 *      `DevTools listening on ws://127.0.0.1:…`, and then every CDP call was denied. The pipe has no port,
 *      no listening socket and no `DevToolsActivePort` file, so there is nothing for the policy to forbid
 *      and nothing for another session to discover.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

export interface BrowserOptions {
  /** The Chrome/Chromium executable. Resolved by configuration, never from a request. */
  executable: string;
  /** The sidecar's own profile directory. Private (the orchestrator refuses a shared temp root). */
  profileDir: string;
  /** Browser output, for the Inspector and for diagnosing a refusal. */
  onLog?: (line: string) => void;
}

export interface Browser {
  /** The child, whose fd 3/4 carry CDP. Passed to `CdpPage.open`. */
  child: ChildProcess;
  /** Kill the browser and wait for it to be gone. Idempotent. */
  stop: () => Promise<void>;
}

export function launchBrowser(options: BrowserOptions): Browser {
  if (!existsSync(options.executable)) {
    throw new Error(`no browser at ${options.executable}`);
  }
  mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });

  const child = spawn(
    options.executable,
    [
      "--headless=new",
      // Chrome's macOS helpers probe the crash database, the keychain, the dock, the notification centre and
      // CoreVideo continuations. Under --no-sandbox none of those are granted, so each fails with a line on
      // stderr that says "Operation not permitted" and is expected. Left on, they flood the log at ~30 ms
      // intervals (measured: CVDisplayLinkCreateWithCGDisplay repeated for the whole run) and bury the one line
      // that matters.
      "--disable-features=DialMediaRouteProvider,MediaRouter,OptimizationHints",
      `--user-data-dir=${options.profileDir}`,
      // Mandatory under Safehouse; see the header. Not a weakening chosen here.
      "--no-sandbox",
      "--disable-gpu",
      "--disable-crash-reporter",
      "--disable-breakpad",
      "--no-first-run",
      "--disable-extensions",
      // CDP over fd 3/4: no port to open, no endpoint file to leak, nothing for the egress rule to block.
      "--remote-debugging-pipe",
      "about:blank",
    ],
    // Two extra pipes BECOME fd 3 and fd 4 in the child. Their order is the protocol: 3 to write, 4 to read.
    { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] },
  );

  let stderrTail = "";
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    stderrTail = (stderrTail + text).slice(-4000);
    options.onLog?.(text.trimEnd());
  });
  child.stdout?.on("data", (chunk) => options.onLog?.(String(chunk).trimEnd()));

  let exited: { code: number | null; signal: string | null } | undefined;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  // A spawn failure must not escape as an unhandled event: Node would end the sidecar, and the caller would
  // see a closed pipe rather than the reason.
  child.once("error", (error) => {
    options.onLog?.(`browser spawn failed: ${error.message}`);
    exited = { code: null, signal: null };
  });

  return {
    child,
    stop: async () => {
      if (exited !== undefined) return;
      await terminate(child, stderrTail);
    },
  };
}

/** SIGTERM, then SIGKILL, then give up rather than hang the sidecar's shutdown. */
async function terminate(child: ChildProcess, stderrTail: string): Promise<void> {
  const gone = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const stopped = await Promise.race([gone.then(() => true), delay(3000).then(() => false)]);
  if (!stopped) {
    child.kill("SIGKILL");
    await Promise.race([gone, delay(2000)]);
  }
  void stderrTail;
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
