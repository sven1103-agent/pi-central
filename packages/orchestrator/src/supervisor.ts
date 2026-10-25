/**
 * Session supervisor: the state machine and lifecycle.
 *
 * Two rules that the rest of the product depends on:
 *
 * 1. **Completion is gated on `agent_settled`, never `agent_end`** (C8). Retries,
 *    compaction, steering and follow-ups can all follow `agent_end`; treating it as "done"
 *    would let a session be marked idle while it is still working, and would tear down or
 *    re-prompt a process mid-run.
 *
 * 2. **At most one live process per `(sessionFile, cwd)`** (ADR-0004) — among the sessions
 *    THIS instance spawned. Two processes appending to one session file add a branch point
 *    to its history, and Pi takes no file lock, so a `pi` started by hand in a terminal is
 *    undetectable (C9). That case is a stated limitation, not a solved problem. A second
 *    resume for a session this instance already supervises returns the existing one rather
 *    than spawning.
 *
 * The supervisor is also the only source of truth for "running" (C3): Pi has no daemon and
 * no attach protocol, so a session is live iff this process spawned it.
 */
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import type { HistoricalSession, LiveSession, PiRecord } from "@pi-central/protocol";
import { composePolicy, describe, type LaunchMode, type SessionSpec } from "./policy.ts";
import { RpcProcess, type LaunchSpec } from "./rpc.ts";
import { checkResumable } from "./resume.ts";
import { isScratch, scratchDirFor, type Config } from "./config.ts";
import { interpretRecord } from "./state.ts";

export interface StartRequest {
  /** Directory to work in. Omitted means "the app-owned default workspace" (US-1, US-3). */
  cwd?: string;
  name?: string;
  mode?: LaunchMode;
  enable?: string[];
  envPass?: string[];
}

export interface SupervisorEvents {
  update: (session: LiveSession) => void;
  record: (sessionId: string, record: PiRecord) => void;
  error: (sessionId: string, message: string) => void;
}

export interface StartResult {
  ok: true;
  session: LiveSession;
}
export interface StartFailure {
  ok: false;
  message: string;
}

export class Supervisor extends EventEmitter {
  #config: Config;
  #sessions = new Map<string, LiveSession>();
  #processes = new Map<string, RpcProcess>();
  #created = 0;

  constructor(config: Config) {
    super();
    this.#config = config;
  }

  list(): LiveSession[] {
    return [...this.#sessions.values()];
  }

  get(id: string): LiveSession | undefined {
    return this.#sessions.get(id);
  }

  /**
   * The underlying RPC process, for verification and diagnostics.
   *
   * Exposed so a test can issue a probe through the *model-facing* `bash` tool inside a
   * session (verify-three.ts). Normal product code goes through the typed lifecycle methods
   * above; this is the escape hatch that keeps the harness honest about what it exercises.
   */
  rpcProcess(id: string): RpcProcess | undefined {
    return this.#processes.get(id);
  }

  /**
   * Start a new session. When `cwd` is omitted this creates and uses the app-owned default
   * workspace for the new session's id (US-1 with US-3), rather than defaulting to `$HOME`
   * or the orchestrator's own directory.
   */
  start(request: StartRequest = {}): StartResult | StartFailure {
    const mode = request.mode ?? "sandboxed";

    // The id is allocated before the cwd, because a scratch workdir is derived from it.
    const id = `s${++this.#created}`;

    let cwd: string;
    if (request.cwd) {
      cwd = request.cwd;
    } else {
      try {
        cwd = scratchDirFor(this.#config, id);
        // Create it eagerly: composePolicy validates the directory exists, and a scratch
        // session should find an empty workspace waiting rather than a missing path.
        mkdirSync(cwd, { recursive: true });
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    }

    return this.#spawn({ id, cwd, mode, name: request.name, enable: request.enable, envPass: request.envPass });
  }

  /**
   * Resume a historical session in its own recorded directory (US-5).
   *
   * The cwd is validated here, before spawning, because RPC-mode Pi exits `1` on a missing
   * directory rather than prompting (C2). The session's directory is never changed
   * (ADR-0008); an unusable directory is refused, not retargeted.
   */
  resume(session: HistoricalSession, options: { mode?: LaunchMode; envPass?: string[] } = {}): StartResult | StartFailure {
    const readiness = checkResumable(session);
    if (!readiness.ok) return { ok: false, message: readiness.message };

    const live = this.#findLiveByPath(session.path);
    if (live) return { ok: true, session: live }; // one process per session file (ADR-0004)

    const id = `s${++this.#created}`;
    return this.#spawn({
      id,
      cwd: readiness.cwd,
      mode: options.mode ?? "sandboxed",
      // No name: the session already carries its own, and re-applying one would append a
      // redundant session_info entry to a file we did not create.
      envPass: options.envPass,
      sessionPath: session.path,
    });
  }

  #findLiveByPath(sessionPath: string): LiveSession | undefined {
    for (const session of this.#sessions.values()) {
      if (session.sessionFile === sessionPath && session.state !== "stopped" && session.state !== "failed") {
        return session;
      }
    }
    return undefined;
  }

  #spawn(input: {
    id: string;
    cwd: string;
    mode: LaunchMode;
    name?: string | undefined;
    enable?: string[] | undefined;
    envPass?: string[] | undefined;
    sessionPath?: string | undefined;
  }): StartResult | StartFailure {
    // A resumed session must reopen its file; a new one gets a fresh name.
    const spec: SessionSpec = {
      id: input.id,
      cwd: input.cwd,
      mode: input.mode,
      safehouse: this.#config.safehouse,
      pi: this.#config.pi,
      ...(input.enable ? { enable: input.enable } : {}),
      ...(input.envPass ? { envPass: input.envPass } : {}),
      ...(input.name ? { name: input.name } : {}),
    };

    let policy;
    try {
      policy = composePolicy(spec);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }

    const session: LiveSession = {
      id: input.id,
      name: input.name?.trim() || defaultName(input.cwd, input.id),
      cwd: input.cwd,
      state: "starting",
      mode: input.mode,
      isolation: policy.isolation,
      command: describe(policy),
      scratch: isScratch(this.#config, input.cwd),
      messageCount: 0,
      pending: 0,
      contextPercent: null,
      tokensTotal: null,
      cost: null,
      dialogs: [],
      warnings: [...policy.warnings],
      startedAt: Date.now(),
      ...(input.sessionPath ? { sessionFile: input.sessionPath } : {}),
    };
    this.#sessions.set(session.id, session);

    const rpc = new RpcProcess(this.#buildLaunch(policy.launch, input.sessionPath));
    this.#processes.set(session.id, rpc);

    rpc.on("record", (record: PiRecord) => this.#onRecord(session.id, record));
    rpc.on("failed", (error: Error) => {
      session.state = "failed";
      session.error = error.message;
      this.#patch(session.id);
      this.emit("error", session.id, error.message);
    });
    rpc.on("exit", ({ code, signal, stderr }: { code: number | null; signal: string | null; stderr: string }) => {
      if (session.state === "stopped") return;
      session.state = "failed";
      session.error = `pi exited (code=${code ?? "-"}, signal=${signal ?? "-"})${stderr ? `\n${stderr}` : ""}`;
      session.dialogs = [];
      this.#patch(session.id);
      this.emit("error", session.id, session.error);
    });

    rpc.start();
    this.#patch(session.id);
    void this.#refreshState(session.id);
    return { ok: true, session };
  }

  /**
   * A resumed session reopens its file (`--session <path>`); a new session is left to Pi's
   * default naming in its workspace.
   *
   * `--session` is appended after the `--` separator, so it is a *pi* argument, not a
   * safehouse one. The only value interpolated is a path validated to exist by
   * `checkResumable`; the argument shape is fixed.
   */
  #buildLaunch(launch: LaunchSpec, sessionPath?: string): LaunchSpec {
    if (!sessionPath) return launch;
    return { ...launch, args: [...launch.args, "--session", sessionPath] };
  }

  async #refreshState(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    const rpc = this.#processes.get(id);
    if (!session || !rpc) return;
    try {
      const state = (await rpc.send({ type: "get_state" }, 20_000)) as Record<string, unknown>;
      const model = state.model as { id?: string; provider?: string } | undefined;
      session.model = model?.id;
      session.provider = model?.provider;
      session.thinkingLevel = state.thinkingLevel as string | undefined;
      if (typeof state.sessionFile === "string") session.sessionFile = state.sessionFile;
      if (typeof state.sessionName === "string" && state.sessionName) session.name = state.sessionName;
      session.messageCount = Number(state.messageCount ?? session.messageCount);
      session.pending = Number(state.pendingMessageCount ?? session.pending);
      // Only leave `starting` if the process is genuinely up and idle or streaming.
      if (session.state === "starting") session.state = state.isStreaming ? "streaming" : "idle";
      session.error = undefined;
      this.#patch(id);
      void this.#refreshStats(id);
    } catch (error) {
      session.state = "failed";
      session.error = `${(error as Error).message}${rpc.stderrTail ? `\n${rpc.stderrTail}` : ""}`;
      this.#patch(id);
    }
  }

  async #refreshStats(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    const rpc = this.#processes.get(id);
    if (!session || !rpc || !rpc.running) return;
    try {
      const stats = (await rpc.send({ type: "get_session_stats" }, 20_000)) as Record<string, unknown>;
      const ctx = stats.contextUsage as { percent?: number | null } | undefined;
      const tokens = stats.tokens as { total?: number } | undefined;
      session.contextPercent = ctx?.percent ?? null;
      session.tokensTotal = tokens?.total ?? null;
      session.cost = typeof stats.cost === "number" ? stats.cost : null;
      this.#patch(id);
    } catch {
      // Stats are cosmetic. Never fail a session over them.
    }
  }

  #onRecord(id: string, record: PiRecord): void {
    const session = this.#sessions.get(id);
    if (!session) return;

    // The decision is pure (state.ts) so it is testable without a spawned process; the
    // supervisor only applies it.
    const effect = interpretRecord(session, record);
    if (effect.dialog) session.dialogs.push(effect.dialog);
    if (effect.patch) Object.assign(session, effect.patch);
    if (effect.refreshStats) void this.#refreshStats(id);

    this.emit("record", id, record);
    this.#patch(id);
  }

  answerDialog(
    id: string,
    dialogId: string,
    answer: { value: string } | { confirmed: boolean } | { cancelled: true },
  ): void {
    const session = this.#sessions.get(id);
    const rpc = this.#processes.get(id);
    if (!session || !rpc) return;

    const payload: Record<string, unknown> = { type: "extension_ui_response", id: dialogId };
    if ("cancelled" in answer) payload.cancelled = true;
    else if ("confirmed" in answer) payload.confirmed = answer.confirmed;
    else payload.value = answer.value;

    rpc.write(payload);
    session.dialogs = session.dialogs.filter((dialog) => dialog.id !== dialogId);
    if (session.dialogs.length === 0 && session.state === "awaiting-approval") session.state = "idle";
    this.#patch(id);
  }

  /** Send a prompt. The command shape is closed; the message is the only free value. */
  async prompt(id: string, message: string): Promise<void> {
    const rpc = this.#processes.get(id);
    const session = this.#sessions.get(id);
    if (!rpc || !session) throw new Error(`no such session: ${id}`);
    if (session.state === "streaming") {
      await rpc.send({ type: "prompt", message, streamingBehavior: "followUp" }, 60_000);
    } else {
      await rpc.send({ type: "prompt", message }, 60_000);
    }
  }

  async abort(id: string): Promise<void> {
    const rpc = this.#processes.get(id);
    if (rpc) await rpc.send({ type: "abort" }, 30_000);
  }

  async rename(id: string, name: string): Promise<void> {
    const rpc = this.#processes.get(id);
    const session = this.#sessions.get(id);
    if (!rpc || !session) throw new Error(`no such session: ${id}`);
    await rpc.send({ type: "set_session_name", name }, 20_000);
    session.name = name;
    this.#patch(id);
  }

  async stop(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    const rpc = this.#processes.get(id);
    if (!session || !rpc) return;
    session.state = "stopped";
    session.dialogs = [];
    this.#patch(id);
    await rpc.stop();
    this.#processes.delete(id);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#processes.keys()].map((id) => this.stop(id)));
  }

  #patch(id: string): void {
    const session = this.#sessions.get(id);
    if (session) this.emit("update", session);
  }
}

/** Only used so a display name is never a bare id. */
function defaultName(cwd: string, id: string): string {
  const base = cwd.split("/").filter(Boolean).pop();
  return base && base.length > 0 ? base : id;
}
