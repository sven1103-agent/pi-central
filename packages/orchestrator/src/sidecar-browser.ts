/**
 * The browser lifecycle: launch Chromium under the sidecar's profile, find its endpoint, hand back a page.
 *
 * Two facts shape this file and both were measured (Phase 0C):
 *
 *   1. **`--no-sandbox` is mandatory.** Safehouse cannot permit Chromium's nested Seatbelt sandbox
 *      (`safehouse --help` says so; `chromium-full.sb` explains the re-init failure). So the renderer runs
 *      with Chrome's own sandbox OFF and its only confinement is the appended fragment. This is the reason
 *      the fragment is required rather than optional.
 *   2. **The endpoint arrives as a FILE inside the profile.** Chrome writes `DevToolsActivePort` with the
 *      port and the browser path. That is why the profile must not sit in `/tmp` or `/var/folders`, which
 *      every session can read — the port in that file is a remote-control endpoint.
 *
 * `--remote-debugging-pipe` would avoid the file entirely and is the better answer if it ever becomes
 * reachable; it is not used here because the pipe transport needs a different client shape and this is a
 * spike-to-product step, not a rewrite. Named as a limit rather than a preference.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface BrowserOptions {
  /** The Chrome/Chromium executable. Fixed by the caller; never taken from a request. */
  executable: string;
  /** The sidecar's own profile directory. Must be private (see `assertPrivateLocation`). */
  profileDir: string;
  /** What to do with the browser's stderr, for the Inspector. */
  onLog?: (line: string) => void;
}

export interface Browser {
  /** The CDP websocket URL, from `DevToolsActivePort`. */
  cdpUrl: string;
  /** Kill the browser and wait for it to be gone. Idempotent. */
  stop: () => Promise<void>;
}

/** Chrome takes a moment to write its port file; this bounds the wait rather than polling forever. */
const ENDPOINT_TIMEOUT_MS = 20_000;

export async function launchBrowser(options: BrowserOptions): Promise<Browser> {
  if (!existsSync(options.executable)) {
    throw new Error(`no browser at ${options.executable}`);
  }
  mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
  // A stale endpoint from a previous run would make this connect to a dead port and report a browser fault.
  const portFile = join(options.profileDir, "DevToolsActivePort");
  rmSync(portFile, { force: true });

  const child = spawn(
    options.executable,
    [
      "--headless=new",
      `--user-data-dir=${options.profileDir}`,
      // Mandatory under Safehouse: see the header. Not a weakening chosen here.
      "--no-sandbox",
      "--disable-gpu",
      "--disable-crash-reporter",
      "--disable-breakpad",
      "--no-first-run",
      "--disable-extensions",
      // Port 0 asks the OS for a free one; the value is discovered from the file below, never guessed.
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
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

  const cdpUrl = await waitForEndpoint(portFile, () => exited, stderrTail);

  return {
    cdpUrl,
    stop: async () => {
      if (exited !== undefined) return;
      await terminate(child);
    },
  };
}

/**
 * Wait for `DevToolsActivePort` and turn it into a websocket URL.
 *
 * The file has two lines: the port, and the browser's `devtools/browser/…` path. Reading it is the only
 * supported discovery for `--remote-debugging-port=0`.
 *
 * **A browser that died must be reported with its own output**, not with a timeout. The first version of
 * the spike harness printed nothing at all because its filter matched only known failure strings, and a
 * `dyld` abort matched none of them — the check ran and its answer was discarded. So the exit is polled
 * and the stderr tail is included in the message.
 */
async function waitForEndpoint(
  portFile: string,
  exited: () => { code: number | null; signal: string | null } | undefined,
  stderrTail: string,
): Promise<string> {
  const deadline = Date.now() + ENDPOINT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const gone = exited();
    if (gone !== undefined) {
      throw new Error(
        `the browser exited before exposing an endpoint (code=${gone.code ?? "-"}, signal=${gone.signal ?? "-"})` +
          (stderrTail.trim() === "" ? "" : `\n${tail(stderrTail, 12)}`),
      );
    }
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").split("\n");
      if (port !== undefined && path !== undefined && port.trim() !== "" && path.trim() !== "") {
        return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
      }
    }
    await new Promise<void>((done) => setTimeout(done, 100));
  }
  throw new Error(
    `the browser wrote no DevToolsActivePort within ${ENDPOINT_TIMEOUT_MS} ms` +
      (stderrTail.trim() === "" ? "" : `\n${tail(stderrTail, 12)}`),
  );
}

const tail = (text: string, lines: number): string =>
  text.trimEnd().split("\n").slice(-lines).join("\n");

/** SIGTERM, then SIGKILL, then give up rather than hang the sidecar's shutdown. */
async function terminate(child: ChildProcess): Promise<void> {
  const gone = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const killed = await Promise.race([gone.then(() => true), delay(3000).then(() => false)]);
  if (!killed) {
    child.kill("SIGKILL");
    await Promise.race([gone, delay(2000)]);
  }
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
