/**
 * Fleet manager: owns the live sessions and their state machine.
 *
 * State follows docs/ARCHITECTURE.md:
 *   starting -> idle <-> streaming -> stopped/failed
 *   awaiting-approval is first-class: it is the highest-value signal a central
 *   station can show ("which session needs a human?").
 *
 * Completion is gated on `agent_settled`, never `agent_end` (C8): retries,
 * compaction, steering and follow-ups can all follow agent_end.
 */
import { EventEmitter } from "node:events";
import { RpcSession } from "./rpc.ts";
import { composePolicy, describe, type LaunchMode, type SessionSpec } from "./policy.ts";

export type SessionState =
  | "starting"
  | "idle"
  | "streaming"
  | "awaiting-approval"
  | "stopped"
  | "failed";

export interface PendingDialog {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  receivedAt: number;
}

export interface LiveSession {
  id: string;
  name: string;
  cwd: string;
  mode: LaunchMode;
  state: SessionState;
  isolation: string;
  command: string;
  model?: string;
  provider?: string;
  thinkingLevel?: string;
  sessionFile?: string;
  messageCount: number;
  pending: number;
  contextPercent: number | null;
  tokensTotal: number | null;
  cost: number | null;
  dialogs: PendingDialog[];
  error?: string;
  warnings: string[];
  startedAt: number;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export class Fleet extends EventEmitter {
  #sessions = new Map<string, LiveSession>();
  #rpc = new Map<string, RpcSession>();
  #created = 0;

  list(): LiveSession[] {
    return [...this.#sessions.values()];
  }

  get(id: string): LiveSession | undefined {
    return this.#sessions.get(id);
  }

  rpc(id: string): RpcSession | undefined {
    return this.#rpc.get(id);
  }

  #patch(id: string): void {
    const s = this.#sessions.get(id);
    if (s) this.emit("update", s);
  }

  startSession(input: {
    cwd: string;
    name?: string;
    mode: LaunchMode;
    enable?: string[];
  }): LiveSession {
    const id = `s${++this.#created}`;
    const name = input.name?.trim() || input.cwd.split("/").filter(Boolean).pop() || `session-${this.#created}`;

    const spec: SessionSpec = {
      id,
      name,
      cwd: input.cwd,
      mode: input.mode,
      enable: input.enable,
    };

    const policy = composePolicy(spec);
    const session: LiveSession = {
      id,
      name,
      cwd: input.cwd,
      mode: input.mode,
      state: "starting",
      isolation: policy.isolation,
      command: describe(policy),
      messageCount: 0,
      pending: 0,
      contextPercent: null,
      tokensTotal: null,
      cost: null,
      dialogs: [],
      warnings: policy.warnings,
      startedAt: Date.now(),
    };
    this.#sessions.set(id, session);

    const rpc = new RpcSession(id, policy.launch);
    this.#rpc.set(id, rpc);

    rpc.on("record", (record) => this.#onRecord(id, record));
    rpc.on("stderr", () => { /* surfaced via stderrTail on failure */ });
    rpc.on("failed", (err: Error) => {
      session.state = "failed";
      session.error = err.message;
      this.#patch(id);
    });
    rpc.on("exit", ({ code, signal }: { code: number | null; signal: string | null }) => {
      if (session.state === "failed") return;
      if (session.state !== "stopped") {
        session.state = "failed";
        session.error = `pi exited (code=${code ?? "-"}, signal=${signal ?? "-"})\n${rpc.stderrTail}`;
      }
      this.#patch(id);
    });

    rpc.start();
    this.#patch(id);

    // Prime state. Failure here usually means sandbox-exec refused (C1) or the
    // working directory is missing — both worth showing verbatim.
    void this.#refresh(id);

    return session;
  }

  async #refresh(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    const rpc = this.#rpc.get(id);
    if (!session || !rpc) return;
    try {
      const state = (await rpc.send({ type: "get_state" }, 20_000)) as Record<string, unknown>;
      const model = state.model as { id?: string; provider?: string } | undefined;
      session.model = model?.id;
      session.provider = model?.provider;
      session.thinkingLevel = state.thinkingLevel as string | undefined;
      session.sessionFile = state.sessionFile as string | undefined;
      session.messageCount = Number(state.messageCount ?? 0);
      session.pending = Number(state.pendingMessageCount ?? 0);
      if (session.state === "starting") session.state = state.isStreaming ? "streaming" : "idle";
      session.error = undefined;
    } catch (err) {
      session.state = "failed";
      session.error = `${(err as Error).message}\n${rpc.stderrTail}`;
    }
    this.#patch(id);
    void this.#refreshStats(id);
  }

  async #refreshStats(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    const rpc = this.#rpc.get(id);
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
      /* stats are cosmetic; never fail the session over them */
    }
  }

  #onRecord(id: string, record: Record<string, unknown>): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    const type = String(record.type ?? "");

    switch (type) {
      case "agent_start":
        session.state = "streaming";
        break;
      case "agent_end":
        // Deliberately NOT idle: retries/compaction/follow-ups may follow (C8).
        break;
      case "agent_settled":
        session.state = session.dialogs.length > 0 ? "awaiting-approval" : "idle";
        void this.#refreshStats(id);
        break;
      case "message_end": {
        const message = record.message as { role?: string } | undefined;
        if (message?.role === "user" || message?.role === "assistant") session.messageCount += 1;
        break;
      }
      case "queue_update": {
        const steering = (record.steering as unknown[] | undefined)?.length ?? 0;
        const followUp = (record.followUp as unknown[] | undefined)?.length ?? 0;
        session.pending = steering + followUp;
        break;
      }
      case "thinking_level_changed":
        session.thinkingLevel = record.level as string | undefined;
        break;
      case "extension_ui_request":
        this.#onDialog(id, record);
        break;
      default:
        break;
    }

    this.emit("event", { sessionId: id, record });
    this.#patch(id);
  }

  #onDialog(id: string, record: Record<string, unknown>): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    const method = String(record.method ?? "");
    if (!DIALOG_METHODS.has(method)) return; // notify/setStatus/setWidget: non-blocking

    session.dialogs.push({
      id: String(record.id),
      method,
      title: record.title as string | undefined,
      message: record.message as string | undefined,
      options: record.options as string[] | undefined,
      placeholder: record.placeholder as string | undefined,
      prefill: record.prefill as string | undefined,
      receivedAt: Date.now(),
    });
    session.state = "awaiting-approval";
    this.emit("event", { sessionId: id, record });
    this.#patch(id);
  }

  /** Answer a dialog. Mirrors the extension UI response union (docs/rpc-extension-ui.md). */
  answerDialog(id: string, dialogId: string, answer: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    const session = this.#sessions.get(id);
    const rpc = this.#rpc.get(id);
    if (!session || !rpc) return;

    const payload: Record<string, unknown> = { type: "extension_ui_response", id: dialogId };
    if (answer.cancelled) payload.cancelled = true;
    else if (answer.confirmed !== undefined) payload.confirmed = answer.confirmed;
    else payload.value = answer.value ?? "";

    rpc.write(payload);
    session.dialogs = session.dialogs.filter((d) => d.id !== dialogId);
    if (session.dialogs.length === 0 && session.state === "awaiting-approval") session.state = "idle";
    this.#patch(id);
  }

  async stop(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    const rpc = this.#rpc.get(id);
    if (!session || !rpc) return;
    session.state = "stopped";
    session.dialogs = [];
    this.#patch(id);
    await rpc.stop();
    this.#rpc.delete(id);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#rpc.keys()].map((id) => this.stop(id)));
  }
}
