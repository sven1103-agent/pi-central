/**
 * One supervised `pi --mode rpc` process (ADR-0003).
 *
 * A custom supervisor, not Pi's `RpcClient`: that class hardcodes `spawn("node", [cliPath,
 * ...])`, which cannot express spawning through `safehouse`. Its correlation patterns are
 * reused conceptually; see packages/protocol/src/pi.ts for the types.
 *
 * Responsibilities, and nothing else:
 *   - spawn the fixed command with its own process group, so teardown signals the whole
 *     sandboxed tree (safehouse → pi → tools), not just pi
 *   - frame stdout through the LF-only decoder (C7)
 *   - correlate responses by `id`
 *   - report exit, including stderr, so the supervisor can surface a failure verbatim
 *
 * It holds no policy logic and performs no state machine. Those are policy.ts and
 * supervisor.ts.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Command, PiRecord } from "@pi-central/protocol";
import { JsonlDecoder, encodeLine } from "./framing.ts";

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  /**
   * The session's complete environment. **Required, deliberately.**
   *
   * Node's `spawn` inherits `process.env` when `env` is omitted, which would hand the session
   * the orchestrator's ambient secrets — including `SSH_AUTH_SOCK`, which Safehouse's own
   * sanitized allowlist passes through (C4a). Making this non-optional means a caller that
   * forgets it fails to compile instead of leaking silently (C11).
   */
  env: Record<string, string>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  stderr: string;
}

/** Events: `record` (PiRecord), `stderr` (string), `exit` (ExitInfo), `failed` (Error). */
export class RpcProcess extends EventEmitter {
  readonly launch: LaunchSpec;

  #child: ChildProcessWithoutNullStreams | null = null;
  #decoder = new JsonlDecoder();
  #pending = new Map<string, Pending>();
  #seq = 0;
  #stderr = "";
  #stopping = false;
  #exited = false;

  constructor(launch: LaunchSpec) {
    super();
    this.launch = launch;
  }

  start(): this {
    if (this.#child) throw new Error("session already started");
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      // Replaces the inherited environment outright. There is no merge: an omitted `env`
      // would mean "inherit everything", which is the failure C11 exists to prevent.
      env: this.launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so a wedged session cannot outlive the dashboard.
      detached: true,
    });
    this.#child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      for (const record of this.#decoder.push(chunk)) this.#dispatch(record);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.#stderr += text;
      this.emit("stderr", text);
    });
    child.on("error", (error) => this.emit("failed", error));
    child.on("exit", (code, signal) => {
      this.#exited = true;
      // Any record still buffered at exit is real; flush before reporting.
      for (const record of this.#decoder.flush()) this.#dispatch(record);
      for (const [, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`pi exited before responding (code=${code ?? "-"}, signal=${signal ?? "-"})`));
      }
      this.#pending.clear();
      this.emit("exit", { code, signal, stderr: this.stderrTail } satisfies ExitInfo);
    });

    return this;
  }

  #dispatch(record: PiRecord): void {
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.#pending.get(record.id);
      if (pending) {
        this.#pending.delete(record.id);
        clearTimeout(pending.timer);
        if (record.success === false) {
          pending.reject(new Error(String(record.error ?? "command failed")));
        } else {
          pending.resolve(record.data);
        }
        return;
      }
    }
    this.emit("record", record);
  }

  /** Send a command and resolve with its response `data`, or reject on error/timeout. */
  /**
   * Send a command and await its correlated response.
   *
   * Takes the CLOSED `Command` union, not `{ type: string } & Record<string, unknown>`.
   *
   * This is not a style preference. The union was documented as "closed, on purpose: the
   * supervisor must not be able to send an arbitrary object derived from untrusted input", but
   * `send` accepted any object with a `type` string — so the union was decorative and a typo
   * (`get_message` for `get_messages`) compiled cleanly and failed only at runtime, as a
   * `success: false` response the caller might not check. `get_messages` was in fact absent from
   * the union while being called from the supervisor, which is exactly how that goes unnoticed.
   */
  send(command: Command, timeoutMs = 60_000): Promise<unknown> {
    const child = this.#child;
    if (!child || !child.stdin.writable) return Promise.reject(new Error("session is not running"));

    const id = `c${++this.#seq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${command.type}`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(encodeLine({ ...command, id }));
    });
  }

  /** Fire-and-forget write, for records that produce no `response` (extension UI). */
  write(record: Record<string, unknown>): void {
    const child = this.#child;
    if (child?.stdin.writable) child.stdin.write(encodeLine(record));
  }

  /**
   * Bounded, graceful teardown. Close stdin first (Pi's preferred shutdown), then escalate
   * to the process group.
   *
   * Waits at every step, including after SIGKILL, so that when this resolves the process has
   * actually been reaped. Firing the final signal and returning immediately would leave
   * `running` true for a process that is already dying, and a caller doing `stopAll()` before
   * exit could not tell a clean shutdown from a wedged one.
   */
  async stop(graceMs = 1500): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    const child = this.#child;
    if (!child || this.#exited) return;

    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }

    const pid = child.pid;
    if (await this.#waitForExit(graceMs)) return;

    try {
      if (pid) process.kill(-pid, "SIGTERM"); // the group, not just the child
    } catch {
      /* gone */
    }
    if (await this.#waitForExit(2000)) return;

    try {
      if (pid) process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
    // SIGKILL cannot be blocked or ignored, so the exit is prompt; still, wait for it rather
    // than assuming. Bounded, so a pathological child cannot wedge the caller forever.
    await this.#waitForExit(2000);
  }

  #waitForExit(ms: number): Promise<boolean> {
    const child = this.#child;
    if (!child || this.#exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.#exited), ms);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  get stderrTail(): string {
    return this.#stderr.split("\n").slice(-12).join("\n").trim();
  }

  get running(): boolean {
    const child = this.#child;
    return child !== null && !this.#exited;
  }
}
