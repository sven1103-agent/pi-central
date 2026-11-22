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
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeSidecarPolicy, type SidecarSpec } from "./sidecar-policy.ts";

export interface SidecarHandle {
  /** The MCP config file Pi is pointed at. */
  configFile: string;
  /** The origin this sidecar serves, for the Inspector. */
  origin: string;
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
export function spawnSidecar(options: SidecarSpawn): SidecarHandle {
  const root = join(options.stateRoot, "sidecars", options.sessionId);
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
    ...(options.sidecarArgs === undefined ? {} : { sidecarArgs: options.sidecarArgs }),
  };

  // Throws on a bad id, a shared temp root, or a port that is not a port. Before any file is written.
  const composed = composeSidecarPolicy(spec);

  mkdirSync(root, { recursive: true, mode: 0o700 });
  const configFile = join(root, "mcp.json");
  writeFileSync(
    configFile,
    JSON.stringify(
      {
        mcpServers: {
          pi_central_sidecar: {
            // stdio: no listening socket, so no port for another session to find (see sidecar.ts).
            command: composed.launch.command,
            args: composed.launch.args,
            // The sidecar reads its own arguments; it takes nothing from the environment, and the session's
            // sanitized env (C11) is not inherited here because this is a different process tree.
            env: { PI_CENTRAL_SIDECAR: "1" },
          },
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const child: ChildProcess = spawn(composed.launch.command, composed.launch.args, {
    // `stdin` is the lifetime mechanism: when this process dies or closes it, the sidecar exits on EOF.
    stdio: ["pipe", "pipe", "pipe"],
    cwd: composed.launch.cwd,
    // Explicit, never inherited (C4a/C11): the sidecar is a renderer and gets no ambient secrets.
    env: { ...composed.launch.env },
  });

  child.stderr?.on("data", (chunk) => options.onLog?.(String(chunk).trimEnd()));
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

  return {
    configFile,
    origin: `http://localhost:${options.port}`,
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
