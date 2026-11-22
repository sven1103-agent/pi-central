/**
 * Spawning a sidecar beside a session, and taking it down with it (ADR-0015 §1, §11).
 *
 * ## Why the lifetime needs code and not a signal
 *
 * macOS has no parent-death signal (C16 records the same gap for the orchestrator itself). A sidecar whose
 * orchestrator is `kill -9`ed becomes an orphan holding a browser and, worse, a live port. So the lifetime is
 * a **pipe**: the sidecar reads stdin, and exits on EOF when this process closes it. That is a kernel
 * property rather than a promise.
 *
 * ## Why the MCP config is a file and not an argument
 *
 * `pi --mcp-config <path>` is measured to work (Phase 0D) and to point Pi at a config **outside `~/.pi`**.
 * That placement is the security property: `~/.pi` is writable from inside every session (C6), so a config
 * there would let the agent choose which MCP server Pi talks to. The file is 0600 in a 0700 directory under
 * the state root, for the same reason a policy fragment is.
 *
 * ## What is NOT here
 *
 * No `cwd` from the caller, no `--enable` from the caller, and no origin from the caller. This module decides
 * *when* to spawn and *what to tell Pi*; it decides no grants — `composeSidecarPolicy` does, and it can
 * refuse.
 */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeSidecarPolicy, type SidecarSpec } from "./sidecar-policy.ts";

export interface SidecarHandle {
  /** The MCP config file Pi is pointed at. */
  configFile: string;
  /** The origin this sidecar serves, for the Inspector. */
  origin: string;
  /** The bearer token, for delivery to Pi's environment (never into the config file). */
  token: string;
  /** The port the sidecar actually bound, once it said so. */
  port: () => number | undefined;
  /** Resolves once the sidecar has announced its port, or rejects when it exits first. */
  ready: Promise<number>;
  /** Stop it and wait. Idempotent. */
  stop: () => Promise<void>;
  /** True once the process has exited, so a caller can reap without guessing. */
  readonly gone: boolean;
}

export interface SidecarSpawn {
  /** The session this sidecar belongs to. Used for paths and for logs, never for grants. */
  sessionId: string;
  /** The dev server's port. Egress is pinned to it, so it is the one thing that must be right. */
  port: number;
  /** Where the sidecar's state lives. Under the orchestrator's state root — never `/tmp` (D-5). */
  stateRoot: string;
  safehouse: string;
  /** The sidecar executable: a fixed binary (or an interpreter), driven by a fixed verb set. */
  sidecar: string;
  /**
   * The directory the sidecar's code lives in, granted read-only to the sandbox.
   *
   * Measured: without it a source-launched sidecar never starts — the interpreter cannot open a script
   * outside its workdir, and the failure is a silent hang with no output and no exit.
   */
  sidecarCodeDir: string;
  /** Arguments before the sidecar's own flags — the script path when `sidecar` is an interpreter. */
  sidecarArgs?: string[];
  /** The browser executable, resolved by configuration. */
  browser: string;
  onLog?: (line: string) => void;
}

/**
 * Spawn the sidecar and write the MCP config that points Pi at it.
 *
 * Order matters and it is the same order as a session's: compose the policy (which validates the id, the
 * profile location and the port, and RENDERS the fragment), then spawn, then hand Pi a config file. A
 * refusal from `composeSidecarPolicy` must happen before anything is written, so a bad spec leaves no
 * half-configured state behind.
 *
 * @throws if the policy refuses the spec, or the process fails to start. Both are launch-time refusals: a
 *   sidecar that exists but cannot be confined is worse than none.
 */
/** The first port a sidecar may use. High and uncommon, so it does not collide with a dev server. */
const SIDECAR_PORT_BASE = 47800;

/**
 * A stable, per-session offset into the sidecar port range.
 *
 * Derived from the session id (`s1`, `s2`, …) and bounded, so two sidecars cannot drift into the same port.
 * A session id that is not of that shape falls back to 0, which is safe: a collision then surfaces as a stated
 * bind failure rather than a silent mix-up.
 */
function sessionOrdinal(sessionId: string): number {
  const match = /^s(\d+)$/.exec(sessionId);
  return match === null ? 0 : Number(match[1]) % 200;
}

export function spawnSidecar(options: SidecarSpawn): SidecarHandle {
  const root = join(options.stateRoot, "sidecars", options.sessionId);
  const token = randomBytes(24).toString("hex");
  const spec: SidecarSpec = {
    id: options.sessionId,
    port: options.port,
    // Under the state root, not /tmp: the profile holds the endpoint file for a remote-control socket.
    profileDir: join(root, "profile"),
    fragmentDir: join(root, "policy"),
    safehouse: options.safehouse,
    // The sidecar is a NODE SCRIPT here rather than a compiled binary, because Phase 2 runs from source.
    // The argv shape is what matters and it is fixed: executable, then two flags with validated values.
    sidecar: options.sidecar,
    sidecarCodeDir: options.sidecarCodeDir,
    browser: options.browser,
    listenPort: SIDECAR_PORT_BASE + sessionOrdinal(options.sessionId),
    token,
    ...(options.sidecarArgs === undefined ? {} : { sidecarArgs: options.sidecarArgs }),
  };

  // Throws on a bad id, a shared temp root, or a port that is not a port. Before any file is written.
  const composed = composeSidecarPolicy(spec);

  mkdirSync(root, { recursive: true, mode: 0o700 });

  /**
   * The bearer token, generated here and never written into the config file.
   *
   * The config names it as `${PI_CENTRAL_SIDECAR_TOKEN}`, which Pi interpolates from its own environment — and
   * C15 is why it must: Safehouse runs a session under `env -i`, so a variable reaches Pi only when it is
   * requested by name via `--env-pass`. Putting the literal token in mcp.json would work and would also write a
   * secret to a file that outlives the session.
   */
  const child: ChildProcess = spawn(composed.launch.command, composed.launch.args, {
    // `stdin` is the lifetime mechanism: when this process dies or closes it, the sidecar exits on EOF.
    stdio: ["pipe", "pipe", "pipe"],
    cwd: composed.launch.cwd,
    // Explicit, never inherited (C4a/C11): the sidecar is a renderer and gets no ambient secrets.
    env: { ...composed.launch.env },
  });

  // Every line, kept for the failure message AND offered to the port announcement below.
  const pendingPortListeners: ((line: string) => void)[] = [];
  let stderrTail = "";
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    stderrTail = (stderrTail + text).slice(-4000);
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      options.onLog?.(line.trimEnd());
      for (const listener of pendingPortListeners) listener(line);
    }
  });
  child.stdout?.on("data", (chunk) => options.onLog?.(String(chunk).trimEnd()));

  let gone = false;
  /**
   * A failed spawn must surface, not escape.
   *
   * Node emits `error` and then `close` when the binary is missing. Without an `error` listener that event is
   * unhandled and the process dies — so an unavailable sidecar would take the orchestrator with it, which is
   * the opposite of a supervisor's job. Recorded and resolved into the same `exited` promise, so `stop()`
   * and `gone` stay truthful either way.
   */
  let spawnError: Error | undefined;
  const exited = new Promise<void>((done) => {
    const finish = (): void => {
      gone = true;
      done();
    };
    child.once("exit", finish);
    child.once("close", finish);
    child.once("error", (error) => {
      spawnError = error;
      finish();
    });
  });

  const stop = async (): Promise<void> => {
    if (gone) {
      if (spawnError !== undefined) throw spawnError;
      return;
    }
    // Closing stdin is the graceful path: the sidecar shuts its browser down and exits.
    child.stdin?.end();
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((done) => setTimeout(() => done(false), 3000)),
    ]);
    if (!graceful) {
      child.kill("SIGTERM");
      const terminated = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((done) => setTimeout(() => done(false), 2000)),
      ]);
      // A sidecar that outlives its session holds a browser and a port, which is the whole failure mode this
      // file exists to prevent. SIGKILL rather than a third wait.
      if (!terminated) child.kill("SIGKILL");
    }
    await exited;
    if (spawnError !== undefined) throw spawnError;
  };

  /**
   * A port chosen BEFORE the spawn, deterministically, so the config can name it.
   *
   * The first version asked the child for port 0 and waited for it to announce the real one. That is more
   * correct in principle and it made `spawnSidecar` async, which made `start` async, which rippled into the
   * transport and every test — a large change justified by a detail. Session ids are unique per orchestrator,
   * so a base plus the id's number is unique too, and a collision with an unrelated process surfaces as a
   * stated bind failure rather than a silent mix-up.
   *
   * `SIDECAR_PORT_BASE` is high and uncommon on purpose; the range is bounded so two sessions cannot drift
   * into each other.
   */
  const port = SIDECAR_PORT_BASE + sessionOrdinal(options.sessionId);


  /**
   * The config is written AFTER the bind, because it must name the real port.
   *
   * The token is referenced by name, not written: Pi interpolates `${PI_CENTRAL_SIDECAR_TOKEN}` from its own
   * environment, and C15 is why the variable must also be requested through `--env-pass` — Safehouse runs a
   * session under `env -i`, so an inherited variable is discarded. A literal token here would work and would
   * also leave a secret in a file that outlives the session.
   */
  const configFile = join(root, "mcp.json");
  writeFileSync(
    configFile,
    JSON.stringify(
      {
        mcpServers: {
          pi_central_sidecar: {
            // A URL, not a command: the orchestrator owns the process, so Pi CONNECTS rather than spawning it
            // inside the session's sandbox (which C1 makes impossible — measured as "Path does not exist").
            url: `http://127.0.0.1:${port}/mcp`,
            headers: { Authorization: "Bearer ${PI_CENTRAL_SIDECAR_TOKEN}" },
          },
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  return {
    configFile,
    origin: `http://localhost:${options.port}`,
    token,
    port: () => (gone ? undefined : port),
    ready: Promise.resolve(port),
    stop,
    get gone() {
      return gone;
    },
  };
}

/**
 * The `--mcp-config` argument a session needs, or nothing when it has no sidecar.
 *
 * Returned as a list rather than a string so it is appended to Pi's argv without a shell, and so the
 * caller cannot accidentally place it after the subcommand — `pi mcp list --mcp-config X` reports
 * "Unknown option", which is how Phase 0D nearly concluded the flag did not exist.
 */
export function mcpConfigArgs(handle: SidecarHandle | undefined): string[] {
  return handle === undefined ? [] : ["--mcp-config", handle.configFile];
}
