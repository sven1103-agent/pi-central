/**
 * RPC client for one Pi session.
 *
 * Implements the transport contract from docs/PROTOCOL.md:
 *   - one JSON object per record, terminated by LF
 *   - tolerate a preceding CR
 *   - NEVER use readline (it also splits on U+2028/U+2029, legal inside JSON strings)
 *   - correlate responses by `id`, because command handling is asynchronous
 *
 * Uses a Buffer-based splitter on 0x0a rather than any line-oriented reader.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class RpcSession extends EventEmitter {
  readonly id: string;
  readonly cwd: string;
  readonly launch: LaunchSpec;

  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = Buffer.alloc(0);
  #pending = new Map<string, Pending>();
  #seq = 0;
  #stderr = "";
  #stopping = false;

  constructor(id: string, launch: LaunchSpec) {
    super();
    this.id = id;
    this.cwd = launch.cwd;
    this.launch = launch;
  }

  start(): this {
    // detached: true gives the session its own process group, so teardown can
    // signal the whole sandboxed tree (safehouse -> pi -> tools), not just pi.
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.#child = child;

    child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.#stderr += text;
      this.emit("stderr", text);
    });
    child.on("error", (err) => this.emit("failed", err));
    child.on("exit", (code, signal) => this.emit("exit", { code, signal }));

    return this;
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const nl = this.#buffer.indexOf(0x0a);
      if (nl === -1) break;
      let line = this.#buffer.subarray(0, nl);
      this.#buffer = this.#buffer.subarray(nl + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length === 0) continue;

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
      } catch {
        continue; // a malformed record must not kill the reader
      }
      this.#dispatch(record);
    }
  }

  #dispatch(record: Record<string, unknown>): void {
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.#pending.get(record.id);
      if (pending) {
        this.#pending.delete(record.id);
        if (record.success === false) pending.reject(new Error(String(record.error ?? "command failed")));
        else pending.resolve(record.data);
        return;
      }
    }
    this.emit("record", record);
  }

  /** Send a command and resolve with its response data. */
  send(command: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    const child = this.#child;
    if (!child || !child.stdin.writable) return Promise.reject(new Error("session is not running"));

    const id = `c${++this.#seq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timeout waiting for ${String(command.type)}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  /** Fire-and-forget write, for records that produce no `response` (extension UI). */
  write(record: Record<string, unknown>): void {
    const child = this.#child;
    if (child?.stdin.writable) child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  async stop(graceMs = 1500): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    const child = this.#child;
    if (!child) return;

    try { child.stdin.end(); } catch { /* already closed */ }

    const pid = child.pid;
    await new Promise((r) => setTimeout(r, graceMs));
    if (child.exitCode !== null || child.signalCode !== null) return;

    // Kill the process group: a wedged session must not outlive the dashboard.
    try { if (pid) process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
    await new Promise((r) => setTimeout(r, 2000));
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { if (pid) process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  }

  get stderrTail(): string {
    return this.#stderr.split("\n").slice(-12).join("\n").trim();
  }

  get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null;
  }
}
