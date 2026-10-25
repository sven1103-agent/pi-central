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
import type { PiRecord } from "@pi-central/protocol";
import { JsonlDecoder, encodeLine } from "./framing.ts";

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
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
  send(command: { type: string } & Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
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
   * to the process group. A session that ignores all three is left to the OS rather than
   * wedging the dashboard forever.
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
