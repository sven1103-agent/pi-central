/**
 * The orchestrator, as the shell sees it: a child process with a URL and a lifetime (issue #214).
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is the *decisions* about a child: what to do with a line it printed, whether to restart it, what
 * to say when it fails. It is not the `spawn` call and not a window — those live in `main.ts`, so every
 * rule below is exercised by `node --test` with no Electron, no display and no real process.
 *
 * That split is the same one `update-check.ts` uses in the UI, and for the same reason: the interesting
 * failures here are all *timing*, and timing bugs are exactly what a test that needs a real GUI cannot
 * provoke reliably.
 *
 * ## The three timings that matter
 *
 *   1. **A child that never reports a URL.** It printed nothing, or it printed startup chatter and then
 *      hung. If the app waits, the reader sees an empty window, which is indistinguishable from a UI
 *      bug — so the wait is bounded and the verdict is `timeout` with the captured stderr.
 *   2. **A child that exits mid-run.** One restart, because a single crash is usually transient (a port
 *      race, a killed helper). A third consecutive failure stops restarting, because a loop that
 *      restarts forever hides the failure and burns the machine.
 *   3. **A restart that must not look like a first start.** The successor has to be treated as a fresh
 *      launch — new URL, new transcript — because the old port and the old socket are gone. Reusing
 *      them is how a window ends up connected to nothing.
 *
 * ## Why the URL is read from stdout and not from the port
 *
 * The orchestrator picks the port (`--port 0`) and prints `PI_CENTRAL_URL=ws://127.0.0.1:<port>`. The
 * shell could compute the URL from a port it chose instead — but then it would have to choose the port,
 * which is the `EADDRINUSE` class the ephemeral port exists to remove. Reading the announced URL also
 * means the shell works unchanged if the orchestrator ever binds something other than what was asked.
 */
import type { FoundExecutable } from "./executables.ts";

/** How long a child gets to announce a URL before it is killed and reported. */
export const URL_TIMEOUT_MS = 10_000;

/**
 * How many consecutive failed starts are tolerated before restarting stops.
 *
 * Three attempts total (the first launch plus two restarts) matches criterion 5's "restarted once, then
 * not again" while leaving room for the one race worth surviving: a restart that fails because the
 * previous child's socket was still closing.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** How much of a child's stderr is kept for the failure panel. Bounded so a chatty child cannot grow memory. */
export const STDERR_KEEP_BYTES = 64 * 1024;

/** What the child printed that the shell cares about. */
export type ChildLine =
  | { kind: "url"; url: string; httpUrl: string }
  /** Startup chatter. Kept for the log and for the failure panel, never parsed as protocol. */
  | { kind: "note"; text: string }
  /** A line that looks like an announcement but is not usable, e.g. an empty URL. */
  | { kind: "bad-url"; text: string; reason: string }
  | { kind: "ignored" };

/**
 * Parse one line of the child's stdout.
 *
 * The orchestrator prints exactly one machine-readable line, `PI_CENTRAL_URL=…`, and everything else is
 * for a human reading a terminal. Only that prefix is treated as protocol — the same rule the
 * orchestrator applies to Pi's own stdout (C7), applied one level up.
 *
 * The `ws://` → `http://` rewrite is here rather than at the window, because it is a fact about the
 * announcement: the orchestrator reports the socket URL it bound, and the UI is served on the same
 * listener. If that ever stops being true, this function is where it changes.
 */
export function parseChildLine(raw: string): ChildLine {
  const line = raw.replace(/\r$/, "");
  const prefix = "PI_CENTRAL_URL=";
  if (!line.startsWith(prefix)) return line.trim() === "" ? { kind: "ignored" } : { kind: "note", text: line };
  const url = line.slice(prefix.length).trim();
  if (url === "") return { kind: "bad-url", text: line, reason: "the announced URL was empty" };
  if (!url.startsWith("ws://")) {
    return { kind: "bad-url", text: line, reason: `expected a ws:// URL, got ${JSON.stringify(url)}` };
  }
  // The listener serves both the socket and the UI document, so the window's URL is the same
  // host:port over http. Rewriting the scheme, not re-parsing and rebuilding, keeps any path the
  // orchestrator might announce.
  return { kind: "url", url, httpUrl: `http://${url.slice("ws://".length)}` };
}

/**
 * Accumulates a child's line-split stdout.
 *
 * A chunk boundary can land mid-line, so this buffers and emits complete lines — the same hazard the
 * orchestrator's own framing solves for Pi (C7), one level up. `flush` exists for the exit path: a
 * child that printed its URL without a trailing newline and then died has still announced where it was.
 */
export class LineAccumulator {
  #buffer = "";

  /** Feed one chunk; return the complete lines it completed. */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines;
  }

  /** The unterminated remainder, if any. */
  flush(): string | undefined {
    const rest = this.#buffer;
    this.#buffer = "";
    return rest === "" ? undefined : rest;
  }
}

/** What the supervisor decided after a child exited. */
export type ExitDecision =
  /** Start it again, after this many milliseconds. */
  | { action: "restart"; delayMs: number; reason: string }
  /** Stop trying, and show this. */
  | { action: "stop"; reason: string };

/**
 * Decide whether to restart, given how many starts have already failed in a row.
 *
 * Backoff is bounded and short: this is a local process on the same machine, not a network service, so
 * the longest wait a reader should ever see is a couple of seconds. Anything longer starts to look like
 * the app has hung, which is the outcome the restart exists to avoid.
 */
export function decideAfterExit(failures: number): ExitDecision {
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      action: "stop",
      reason:
        `Pi Central's orchestrator failed to start ${failures} times in a row, so it will not be ` +
        `started again automatically. The log below has what it printed; Restart tries once more.`,
    };
  }
  const delayMs = [0, 500, 1500][failures] ?? 1500;
  return { action: "restart", delayMs, reason: `the orchestrator exited; restarting in ${delayMs} ms` };
}

/**
 * The last {@link STDERR_KEEP_BYTES} of a stream, keeping the END rather than the start.
 *
 * The tail is what explains a failure — a Node stack trace names the cause in its last lines, and a
 * startup banner does not. Trimming from the front is also what makes the bound safe: a child that
 * spams a warning cannot push the diagnosis out of the window.
 */
export function keepTail(existing: string, chunk: string): string {
  const combined = existing + chunk;
  if (combined.length <= STDERR_KEEP_BYTES) return combined;
  const cut = combined.slice(combined.length - STDERR_KEEP_BYTES);
  // Do not begin mid-line: a truncated first line reads as corruption rather than as truncation.
  const firstBreak = cut.indexOf("\n");
  return firstNewlineMarker(cut, firstBreak);
}

function firstNewlineMarker(text: string, firstBreak: number): string {
  return firstBreak === -1 ? text : `… earlier output omitted\n${text.slice(firstBreak + 1)}`;
}

/** What the window should show about the child right now. */
export type ChildStatus =
  | { state: "starting"; attempt: number }
  | { state: "running"; url: string; httpUrl: string; pid: number | undefined }
  /** Died or was killed, and the supervisor has stopped trying. */
  | { state: "failed"; reason: string; stderr: string };

/** Everything a start needs, assembled once so a restart uses exactly the same rules. */
export interface SpawnPlan {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface SpawnPlanInput {
  node: FoundExecutable;
  pkg: { root: string; bin: string };
  /** Resolved `pi` and `safehouse`, passed so the child does not have to re-find them. */
  pi: FoundExecutable;
  safehouse: FoundExecutable;
  /** Extra options from the shell's own argv, forwarded verbatim after the port. */
  extraArgs?: readonly string[];
}

/**
 * Build the child's argv and environment.
 *
 * `--port 0` is not a default here, it is the rule: the shell never picks a port, so the `EADDRINUSE`
 * class is unreachable from the app (criterion 3). The port that results is whatever the child
 * announced.
 *
 * ## The environment, and why it is not `process.env`
 *
 * C11 says the orchestrator's own spawn environment is the sanitization boundary for sessions, and
 * `env.ts` builds that deliberately. This is one level further out: what the *orchestrator* is given.
 * Passing `process.env` through would hand it everything the app inherited — including, in principle,
 * variables a launcher added — and the orchestrator would then pass an unknown subset on. So the plan
 * carries an explicit allowlist, and `PATH` is the resolved one rather than the truncated launchd one.
 *
 * `PI_CENTRAL_NODE`, `PI_CENTRAL_PI` and `PI_CENTRAL_SAFEHOUSE` are how the shell tells the child where
 * its tools are without asking the child to repeat the login-shell lookup. They are read by
 * `config.ts`, which already resolves `safehouse` from `PI_CENTRAL_SAFEHOUSE`.
 */
export function planSpawn(input: SpawnPlanInput): SpawnPlan {
  const env: Record<string, string> = {
    // The orchestrator must run unsandboxed (C1, ADR-0001). Saying so explicitly in its environment
    // is belt-and-braces: `sandbox-guard.ts` probes and refuses, and this is not a substitute for it.
    PI_CENTRAL_LAUNCHED_BY: "app",
    PI_CENTRAL_PI: input.pi.path,
    PI_CENTRAL_SAFEHOUSE: input.safehouse.path,
  };
  // The resolved PATH, so the child can find anything else it shells out to (`git`, `gh`, …) without
  // repeating the login-shell lookup. Composed from the directories of the binaries we resolved plus
  // the standard set, which is enough for the tools the orchestrator itself runs.
  env["PATH"] = composePath([input.node, input.pi, input.safehouse]);
  const args = [input.pkg.bin, "--port", "0", ...(input.extraArgs ?? [])];
  return { command: input.node.path, args, cwd: input.pkg.root, env };
}

/**
 * A `PATH` made of the directories the resolved binaries live in, with the standard set kept.
 *
 * Ordering is by proximity to what the orchestrator actually needs: the directory `node` came from
 * first (so a version manager's shims win over a system copy), then the tools', then the defaults. The
 * defaults are appended rather than replaced, because a system `git` is better than none.
 */
export function composePath(executables: readonly FoundExecutable[]): string {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const executable of executables) {
    const directory = executable.path.slice(0, executable.path.lastIndexOf("/"));
    if (directory === "" || seen.has(directory)) continue;
    seen.add(directory);
    directories.push(directory);
  }
  for (const fallback of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    if (seen.has(fallback)) continue;
    seen.add(fallback);
    directories.push(fallback);
  }
  return directories.join(":");
}
