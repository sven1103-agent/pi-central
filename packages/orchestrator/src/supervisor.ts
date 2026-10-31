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
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Command, HistoricalSession, LiveSession, ModelOption, PiRecord } from "@pi-central/protocol";
import { composePolicy, describe, type LaunchMode, type SessionSpec } from "./policy.ts";
import { RpcProcess, type LaunchSpec } from "./rpc.ts";
import { retryRefusal } from "./retry.ts";
import { checkResumable } from "./resume.ts";
import { isScratch, scratchDirFor, type Config } from "./config.ts";
import { agentRoutingEnv } from "./env.ts";
import { KEYCHAIN_FILE, inspectProviderAuth, readStore } from "./agent-store.ts";
import { assessAgentCapabilities } from "./capabilities.ts";
import { renderPolicyFragment } from "./fragment.ts";
import {
  listDirectory,
  readFileForDisplay,
  readFileText,
  type DirListing,
  type FileContent,
  type ImageContent,
  type Result,
} from "./files.ts";
import { resolveInstallationRoot } from "./installation-root.ts";
import { ownInstallationWarning } from "@pi-central/protocol";
import { interpretRecord } from "./state.ts";

export interface StartRequest {
  /** Directory to work in. Omitted means "the app-owned default workspace" (US-1, US-3). */
  cwd?: string;
  name?: string;
  mode?: LaunchMode;
  enable?: string[];
  /**
   * Extra environment values for this session — the trusted channel for the agent's own
   * credentials (ADR-0010). Never sourced from `process.env` by the caller.
   */
  env?: Record<string, string>;
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
    // Resolved from THIS module's URL rather than configured: a configured path would be right for
    // exactly one checkout — the author's — and silently wrong everywhere else (issue #25).
    this.#installationRoot = resolveInstallationRoot();
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

    return this.#spawn({ id, cwd, mode, name: request.name, enable: request.enable, env: request.env });
  }

  /**
   * Resume a historical session in its own recorded directory (US-5).
   *
   * The cwd is validated here, before spawning, because RPC-mode Pi exits `1` on a missing
   * directory rather than prompting (C2). The session's directory is never changed
   * (ADR-0008); an unusable directory is refused, not retargeted.
   */
  resume(
    session: HistoricalSession,
    options: { mode?: LaunchMode; env?: Record<string, string> } = {},
  ): StartResult | StartFailure {
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
      ...(options.env ? { env: options.env } : {}),
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

  /**
   * Re-spawn a session that failed, in the directory it already had (issue #11).
   *
   * ## Why this is not "stop, then start"
   *
   * The reader is asking for THIS session to try again. A client-side stop+start would put a second row in
   * the rail beside the failed one, and the roster (keyed by session file) would then have two live entries
   * pointing at one conversation. Reusing the id keeps the row where the reader put it.
   *
   * ## Refusals, all before anything is spawned
   *
   * - **Not failed** → refused. A silent restart is how a crash loop hides itself, and a running session is
   *   not broken.
   * - **Directory gone or unreadable** → refused with the reason, for the same purpose `resume` refuses: RPC
   *   Pi exits 1 on a missing directory rather than prompting (C2), so re-spawning would produce a second
   *   failure that says less than the first.
   *
   * ## What is preserved
   *
   * `previousError` holds the last failure. Clearing `error` is what makes the retry a retry — the composer
   * becomes usable again — but erasing the evidence would leave a reader unable to compare attempts.
   */
  async retry(id: string): Promise<StartResult | StartFailure> {
    const existing = this.#sessions.get(id);
    if (existing === undefined) return { ok: false, message: `no such session: ${id}` };
    const refusal = retryRefusal(existing);
    if (refusal !== undefined) return { ok: false, message: refusal };

    // Dispose the old process before spawning a replacement under the same id, so the map cannot end up
    // holding a dead RpcProcess while a new one runs.
    const previous = this.#processes.get(id);
    this.#processes.delete(id);
    // `stop()` on a process that already exited is the cheap case; awaiting it means the replacement cannot
    // race the old one for the same session file.
    await previous?.stop().catch(() => undefined);

    return this.#spawn({
      id,
      cwd: existing.cwd,
      mode: existing.mode,
      /*
       * No `--name` when the session already has a file.
       *
       * `resume` makes the same choice for the same reason: the session carries its own name, and re-applying
       * one appends a redundant `session_info` record to a file we did not create. A retry of a session that
       * already wrote records is exactly that case. When there is no file yet the name is still needed, so it
       * is passed only then.
       */
      ...(existing.sessionFile === undefined ? { name: existing.name } : {}),
      sessionPath: existing.sessionFile,
      previousError: existing.error ?? existing.previousError,
      // `enable` and `env` are not part of `LiveSession`, so a retry cannot reproduce logins granted per
      // spawn. Stated here rather than silently lost: a retried session may come back with fewer
      // capabilities than the original, which is visible in the composer when a credential is missing.
    });
  }

  #spawn(input: {
    id: string;
    cwd: string;
    mode: LaunchMode;
    name?: string | undefined;
    enable?: string[] | undefined;
    env?: Record<string, string> | undefined;
    sessionPath?: string | undefined;
    previousError?: string | undefined;
  }): StartResult | StartFailure {
    // A resumed session must reopen its file; a new one gets a fresh name.
    //
    // The environment carries the agent-scoped routing (ADR-0010 §3): GH_CONFIG_DIR and
    // GIT_CONFIG_GLOBAL point into the agent's own tree, and GIT_CONFIG_SYSTEM=/dev/null
    // removes the host's system git config as an independent route to the login keychain.
    const env = { ...agentRoutingEnv(this.#config.agentRoot), ...(input.env ?? {}) };

    // Provider-key resolution needs keychain access (C13), and the grant is derived from the
    // provider configuration that is ACTUALLY in force rather than from an assumption.
    //
    // `auth.json` resolves each key with a command such as
    //   !security find-generic-password -ws 'litellm'
    // which needs `SecurityServer` to read any keychain, and the user-wide search list to find
    // the agent keychain. A command-based key is resolved lazily, so Pi cannot report the
    // failure at startup: without this grant the session starts, reports idle, and then cannot
    // think. That is the exact C13 failure mode.
    const providerAuth = inspectProviderAuth(this.#config.providerAgentDir);
    const keychainPath = join(this.#config.agentRoot, KEYCHAIN_FILE);
    const keychainNeeded = providerAuth.needsKeychain;
    const keychainPresent = existsSync(keychainPath);

    // Only sandboxed sessions get a fragment: direct mode applies no Safehouse policy, so
    // there is nothing to append to.
    //
    // The agent root is passed unconditionally (not just when managed): the session is
    // configured with GH_CONFIG_DIR/GIT_CONFIG_GLOBAL inside it, so it must be able to read
    // its own credentials whether Pi Central created the tree or adopted an external one.
    const fragment =
      input.mode === "sandboxed"
        ? renderPolicyFragment({
            agentRoot: this.#config.agentRoot,
            ...(keychainNeeded ? { keychain: true, keychainPath } : {}),
          })
        : undefined;

    const spec: SessionSpec = {
      id: input.id,
      cwd: input.cwd,
      mode: input.mode,
      safehouse: this.#config.safehouse,
      pi: this.#config.pi,
      env,
      ...(fragment !== undefined
        ? { policyFragment: fragment, fragmentDir: this.#config.fragmentDir }
        : {}),
      ...(input.enable ? { enable: input.enable } : {}),
      ...(input.name ? { name: input.name } : {}),
    };

    let policy;
    try {
      policy = composePolicy(spec);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }

    // Can the session USE the credentials it is configured with? (issue #28)
    //
    // Checked here rather than earlier because the honest answer depends on the RENDERED fragment:
    // the C15 defect was a fragment that did not grant what GH_CONFIG_DIR pointed at, and the
    // fragment is the artifact that actually gets applied. Assessment never reads a credential --
    // `readStore` is metadata-only -- and never blocks the session: a session with no identity is
    // still useful for non-credential work.
    const store = readStore(this.#config.agentRoot, {
      ownership: this.#config.agentRootManaged ? "managed" : "external",
    });
    const capabilities = assessAgentCapabilities({
      store,
      sandboxed: input.mode === "sandboxed",
      ...(fragment !== undefined ? { fragment } : {}),
      providerAuth,
      keychainPath,
    });

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
      // Policy warnings, credential warnings, and the self-hosting hazard (issues #28, #25).
      // A session that starts and cannot think, or cannot use its own identity, is one failure this
      // surfaces (C13, C15); a session pointed at the checkout Pi Central is running from is
      // another, and it is warned about rather than refused — the user may have a good reason, and
      // the consequences are what they need in order to judge (issue #25).
      warnings: [
        ...policy.warnings,
        ...capabilities.warnings,
        ...(ownInstallationWarning(input.cwd, this.#installationRoot) !== undefined
          ? [ownInstallationWarning(input.cwd, this.#installationRoot)!]
          : []),
      ],
      startedAt: Date.now(),
      ...(input.sessionPath ? { sessionFile: input.sessionPath } : {}),
      ...(input.previousError ? { previousError: input.previousError } : {}),
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
      session.error = describeExitFailure(code, signal, stderr);
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
      // Pi's OWN session id, which is a uuid. Distinct from `session.id`, which is Pi Central's
      // short handle. Both are needed: the handle addresses the process, the uuid identifies the
      // transcript, and showing one under the other's label is a lie about which is which.
      if (typeof state.sessionId === "string" && state.sessionId) session.sessionId = state.sessionId;
      if (typeof state.sessionName === "string" && state.sessionName) session.name = state.sessionName;
      session.messageCount = Number(state.messageCount ?? session.messageCount);
      session.pending = Number(state.pendingMessageCount ?? session.pending);
      // Only leave `starting` if the process is genuinely up and idle or streaming.
      if (session.state === "starting") session.state = state.isStreaming ? "streaming" : "idle";
      session.error = undefined;
      this.#patch(id);
      void this.#refreshStats(id);
      // Load the existing conversation BEFORE anything new arrives.
      void this.#loadTranscript(id);
    } catch (error) {
      session.state = "failed";
      session.error = `${(error as Error).message}${rpc.stderrTail ? `\n${rpc.stderrTail}` : ""}`;
      this.#patch(id);
    }
  }

  /**
   * Fetch a session's conversation from Pi.
   *
   * **Authoritative and current, and nothing is cached.** That is the whole design, and it is a
   * correction: an earlier version fetched once at session start, cached the result, and replayed
   * the cache to every client that connected later. For a session started fresh that cache held
   * the empty conversation from its first instant, so a reconnect REPLACED a correct transcript
   * with an empty one — and a one-shot guard meant it could never recover. The UI then showed
   * "Loading this session's history…" indefinitely, because Pi reported messages that the client
   * would never receive.
   *
   * A cache of a conversation is stale the moment it is taken. Re-fetching costs one sub-
   * millisecond round trip per session per connection, which is a price worth paying for being
   * right.
   *
   * Returns a result rather than throwing, because callers must distinguish "the conversation is
   * empty" from "the conversation could not be read" — the first is fine and the second must not
   * be presented as an eternal spinner.
   */
  async fetchTranscript(
    id: string,
  ): Promise<{ ok: true; messages: unknown[] } | { ok: false; message: string }> {
    const rpc = this.#processes.get(id);
    if (!rpc) return { ok: false, message: "this session is not running" };
    try {
      const data = (await rpc.send({ type: "get_messages" }, 30_000)) as { messages?: unknown[] };
      return {
        ok: true,
        messages: (data?.messages ?? []).filter(
          (message) => typeof message === "object" && message !== null,
        ),
      };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  /**
   * Load a session's conversation once, when it starts or resumes.
   *
   * **This is the fix for a resumed session showing an empty transcript.** Pi loads a resumed
   * session's history into the model's context but does NOT re-emit it as events, so a UI built
   * only from `record` events shows "No messages yet" for a session with hundreds of messages —
   * which is precisely the case US-5 exists to serve.
   *
   * Re-emitted as `message_end` records rather than through a new event type, so history and a
   * live stream take the SAME code path in the UI reducer. There is one renderer for one
   * conversation; two is how the past and the present end up looking different.
   *
   * The once-only guard covers this automatic path to avoid duplicating the conversation on every
   * state refresh. Clients that connect later call `fetchTranscript` directly instead, so they
   * always get the CURRENT conversation rather than this session's opening state.
   */
  async #loadTranscript(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session || session.transcriptLoaded) return;

    const result = await this.fetchTranscript(id);
    if (!result.ok) {
      // Deliberately NOT marking the load as done: a transient failure (Pi not ready yet) should
      // be retryable rather than permanently disabling this session's history.
      session.warnings = [
        ...session.warnings,
        `Could not load this session's earlier messages: ${result.message}`,
      ];
      this.emit("transcriptError", id, result.message);
      this.#patch(id);
      return;
    }

    session.transcriptLoaded = true;
    this.emit("transcript", id, result.messages);
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
    // The queued TEXTS come from the record, not from `LiveSession.pending` (which is only a
    // count). Pi sends the whole queue on every `queue_update`, so this is a full replacement
    // rather than a reconstruction — see the `queue` event's comment.
    if (record.type === "queue_update") {
      this.emit(
        "queue",
        id,
        asTextArray(record.steering),
        asTextArray(record.followUp),
      );
    }
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

  /**
   * Send a prompt. The command shape is closed; the message is the only free value.
   *
   * `behavior` decides what a message means mid-run, and it is the caller's choice rather than
   * this method's: Pi REJECTS a streaming `prompt` with no `streamingBehavior` (`"Agent is
   * already processing. Specify streamingBehavior ('steer' or 'followUp')"`), so defaulting it
   * silently would decide for the user something the composer is there to ask (issue #3). When
   * idle there is nothing to steer into, so the flag is dropped rather than sent.
   */
  async prompt(id: string, message: string, behavior?: "steer" | "followUp"): Promise<void> {
    const rpc = this.#processes.get(id);
    const session = this.#sessions.get(id);
    if (!rpc || !session) throw new Error(`no such session: ${id}`);
    if (session.state === "streaming") {
      await rpc.send({ type: "prompt", message, streamingBehavior: behavior ?? "followUp" }, 60_000);
    } else {
      await rpc.send({ type: "prompt", message }, 60_000);
    }
  }

  /**
   * Empty Pi's queue, and optionally stop the run, in that order.
   *
   * **The order is the whole point.** Pi's `clear_queue` returns the queued texts, so clearing
   * first is what makes them recoverable: abort-then-clear would let the run settle and, in the
   * window before the queue was emptied, Pi could begin delivering a queued message as a real
   * turn. Clearing first removes the queue before anything else can act on it, and the returned
   * texts are broadcast so the composer restores exactly what was removed instead of guessing.
   *
   * `abort` is sent directly rather than via `this.abort` so the pair cannot be reordered by a
   * later refactor.
   *
   * Returns the cleared texts, so a caller that wants them does not have to wait for the event.
   */
  async clearQueue(id: string, andStop: boolean): Promise<{ steering: string[]; followUp: string[] }> {
    const rpc = this.#processes.get(id);
    if (!rpc) throw new Error(`no such session: ${id}`);
    const result = await clearQueueVia((command, timeout) => rpc.send(command, timeout), andStop);
    // A SEPARATE event from `queue`, and deliberately so. Pi emits an emptied `queue_update`
    // during `clearQueue` (agent-session.js: `_emitQueueUpdate()`), which already tells the
    // client the queue is now empty. Reporting these texts as the queue would therefore
    // overwrite that empty list with the very messages that were just removed — the queue would
    // appear to still hold them. These texts belong to the composer, not to the queue.
    //
    // Emitted even when both lists are empty, so "nothing was queued" is reported rather than
    // left ambiguous with "the clear failed".
    this.emit("queueCleared", id, result.steering, result.followUp);
    return result;
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

  /**
   * Ask Pi which models this session can use.
   *
   * Returns a result rather than throwing, for the same reason `fetchTranscript` does: the caller
   * needs "there are none" and "the question failed" to be different events. A list rendered as
   * empty when the command errored would say the session has no models, which is a different and
   * false claim (C14's family).
   */
  async listModels(
    id: string,
  ): Promise<{ ok: true; models: ModelOption[] } | { ok: false; message: string }> {
    const rpc = this.#processes.get(id);
    if (!rpc) return { ok: false, message: "this session is not running" };
    try {
      const data = (await rpc.send({ type: "get_available_models" }, 30_000)) as {
        models?: Record<string, unknown>[];
      };
      // Narrowed here rather than passed through: the picker renders these, and `model.name` may
      // be absent, so the shape is normalized once instead of at every render site.
      const models: ModelOption[] = (data?.models ?? [])
        .filter((model) => typeof model === "object" && model !== null)
        .map((model) => ({
          provider: String(model["provider"] ?? ""),
          id: String(model["id"] ?? ""),
          ...(typeof model["name"] === "string" ? { name: model["name"] } : {}),
          ...(typeof model["reasoning"] === "boolean" ? { reasoning: model["reasoning"] } : {}),
        }))
        // A model without a provider or an id cannot be selected by `set_model`, which requires
        // both, so offering it would be a control that cannot work.
        .filter((model) => model.provider !== "" && model.id !== "");
      return { ok: true, models };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  /**
   * Change a session's model, then re-read the state Pi reports.
   *
   * **The session's fields are not set optimistically.** Pi validates the choice (an unconfigured
   * provider fails with `No API key for <provider>/<model>`), persists it to the transcript, and
   * re-applies the thinking level for the new model. Setting `session.model` from the request
   * would therefore display a change that may not have happened, and would miss the thinking-level
   * adjustment — the two ways this can disagree with Pi.
   *
   * A refusal is thrown, not swallowed: the caller broadcasts it, so it appears as an error naming
   * the reason rather than as a control that silently did nothing.
   */
  async setModel(id: string, provider: string, modelId: string): Promise<void> {
    const rpc = this.#processes.get(id);
    const session = this.#sessions.get(id);
    if (!rpc || !session) throw new Error(`no such session: ${id}`);
    await rpc.send({ type: "set_model", provider, modelId }, 30_000);
    // Re-read rather than assume. `refreshState` also pulls the thinking level the switch applied.
    await this.#refreshState(id);
  }

  /** Which thinking levels the CURRENT model supports. Per-model, so it must be re-read on a switch. */
  async listThinkingLevels(
    id: string,
  ): Promise<{ ok: true; levels: string[] } | { ok: false; message: string }> {
    const rpc = this.#processes.get(id);
    if (!rpc) return { ok: false, message: "this session is not running" };
    try {
      const data = (await rpc.send({ type: "get_available_thinking_levels" }, 30_000)) as {
        levels?: unknown[];
      };
      return { ok: true, levels: (data?.levels ?? []).map((level) => String(level)) };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  /**
   * Change the thinking level, then re-read the state Pi reports.
   *
   * The same reasoning as `setModel`: Pi may reject a level the model does not support, so the
   * value shown must be the one Pi confirms rather than the one that was asked for.
   */
  async setThinkingLevel(id: string, level: string): Promise<void> {
    const rpc = this.#processes.get(id);
    const session = this.#sessions.get(id);
    if (!rpc || !session) throw new Error(`no such session: ${id}`);
    await rpc.send({ type: "set_thinking_level", level }, 20_000);
    await this.#refreshState(id);
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

  /**
   * List a session's working directory (issue #8, ADR-0007).
   *
   * Synchronous and plain `fs`, at the orchestrator's UID — no sandbox, no RPC round trip. The
   * confinement is the session's own `cwd`, which is why this goes through the supervisor: it is the
   * component that knows what that cwd is, so there is exactly one answer to "what is this session
   * confined to".
   *
   * An unknown session is REFUSED rather than resolved against some other root. Falling back would
   * mean a stale session id browsed a directory that had nothing to do with it.
   */
  listFiles(
    id: string,
    path: string,
    options: { includeHidden?: boolean } = {},
  ): Result<DirListing> {
    const session = this.#sessions.get(id);
    if (!session) {
      return {
        ok: false,
        error: { reason: "not-found", message: `no session ${id}, so there is no working directory to list` },
      };
    }
    return listDirectory(session.cwd, path, options);
  }

  /** Read one text file from a session's working directory, confined the same way. */
  readFile(id: string, path: string): Result<FileContent | ImageContent> {
    const session = this.#sessions.get(id);
    if (!session) {
      return {
        ok: false,
        error: { reason: "not-found", message: `no session ${id}, so there is no working directory to read from` },
      };
    }
    return readFileForDisplay(session.cwd, path);
  }

  /**
   * Where this Pi Central installation lives, resolved once.
   *
   * Overridable so a test can supply a path rather than depending on where the test file happens to
   * be — the same seam `#config` provides for everything else. `undefined` means the walk could not
   * identify it, in which case no session is warned: an unidentifiable path is not evidence of
   * safety, but a warning on every session would be noise, so the honest report is the absence of a
   * claim. The startup banner says so instead, once.
   */
  #installationRoot: string | undefined;

  setInstallationRoot(path: string | undefined): void {
    this.#installationRoot = path;
  }

  #patch(id: string): void {
    const session = this.#sessions.get(id);
    if (session) this.emit("update", session);
  }
}

/**
 * Explain a session's death in a way a reader can act on.
 *
 * The MOST LIKELY first-run failure is also the least self-explanatory. Seatbelt does not nest
 * (C1), so running the orchestrator inside another sandbox makes `sandbox-exec` fail with EPERM
 * and every session dies the moment it starts. The raw output — `pi exited (code=71)` plus
 * `sandbox_apply: Operation not permitted` — reads like a launcher bug and sends the reader
 * looking in the wrong place, so the diagnosis is attach­ed here, where the evidence is.
 *
 * Exported so the test exercises this function rather than a paraphrase of it, which is the
 * same reason `interpretRecord` is pure.
 */
export function describeExitFailure(
  code: number | null,
  signal: string | null,
  stderr: string,
): string {
  /*
   * ## Two defects fixed here, both reported from a window
   *
   * **1. `code=137, signal=-` does not say what happened.** A shell reports a child killed by a signal as
   * `128 + n` with no signal name, because the wrapper exited rather than the signal propagating. So the most
   * likely deliberate action — someone killing the session's process — produced a message that named a number
   * and nothing else. The signal is decoded from the code, because that is what the reader needs.
   *
   * **2. The cause was buried under startup chatter.** The stderr tail used to be the WHOLE tail, so a session
   * that started fine and ran for a while reported its failure after every extension's banner line — the
   * LiteLLM and nvim-tmux notices, in the case that was reported. `Killed: 9` arrived on the last line of a
   * screenful. The summary now names the reason, and the tail is bounded to its last lines with a count of
   * what was left out, so the evidence survives without the wall.
   */
  const reason = exitReason(code, signal);
  const tail = boundedTail(stderr);
  const base = `${reason}${tail ? `\n${tail}` : ""}`;
  if (!/sandbox_apply|Operation not permitted/i.test(stderr)) return base;
  return (
    `${base}\n\n` +
    "This looks like Seatbelt refusing to nest (C1). The orchestrator must run from a plain " +
    "terminal, not inside another sandbox, editor task, or agent harness -- because `safehouse` " +
    "applies its policy with `sandbox-exec`, and that cannot run inside an existing sandbox."
  );
}

/** How many stderr lines survive into the message. */
const STDERR_TAIL_LINES = 12;

/**
 * The first line of a failure message: what ended the process.
 *
 * `code` is the exit status and `signal` the terminating signal, and they are rarely both populated: a shell
 * wrapping a killed child exits `128 + n`, so nobody sees `SIGKILL` — only `137`. Decoding it is the difference
 * between a number and a sentence. The raw numbers are kept, because they are the evidence.
 */
export function exitReason(code: number | null, signal: string | null): string {
  const raw = `pi exited (code=${code ?? "-"}, signal=${signal ?? "-"})`;
  if (signal) return `${raw} — killed by ${signal}`;
  // `128 + n` is how a SHELL reports a signalled child. Naming it is a reading of the number, not a guess about
  // intent: a kill and an OOM kill both land here, which is why the number is kept alongside the name.
  if (code !== null && code > 128 && code <= 128 + 64) {
    const name = signame(code - 128);
    if (name !== undefined) return `${raw} — killed by ${name}`;
  }
  return raw;
}

/** The conventional short name for a signal number, for the ones a session plausibly dies from. */
function signame(number: number): string | undefined {
  const names: Record<number, string> = {
    1: "SIGHUP",
    2: "SIGINT",
    3: "SIGQUIT",
    6: "SIGABRT",
    9: "SIGKILL",
    11: "SIGSEGV",
    13: "SIGPIPE",
    15: "SIGTERM",
  };
  return names[number];
}

/**
 * The last lines of stderr, with a count of what was dropped.
 *
 * Trimmed from the TOP rather than the bottom because the cause is at the end: a process writes its banner as it
 * starts and the fatal line as it dies.
 */
export function boundedTail(stderr: string): string {
  const text = stderr.replace(/\s+$/, "");
  if (text === "") return "";
  const lines = text.split("\n");
  if (lines.length <= STDERR_TAIL_LINES) return text;
  const kept = lines.slice(-STDERR_TAIL_LINES);
  const omitted = lines.length - STDERR_TAIL_LINES;
  return `… ${omitted} earlier line${omitted === 1 ? "" : "s"} of output omitted\n${kept.join("\n")}`;
}

/** Only used so a display name is never a bare id. */
function defaultName(cwd: string, id: string): string {
  const base = cwd.split("/").filter(Boolean).pop();
  return base && base.length > 0 ? base : id;
}

/**
 * A record's list field as strings.
 *
 * Records are untrusted, so the elements are coerced rather than asserted: a `queue_update` whose
 * `steering` held objects would otherwise reach the composer as `[object Object]` or, worse, be
 * rendered as markup. Nothing is filtered out, because dropping a queued message would make the
 * count and the list disagree in a way the user cannot see.
 */
function asTextArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/** The `send` surface `clearQueueVia` needs, so the ordering can be tested without a live Pi. */
export type RpcSend = (command: Command, timeoutMs: number) => Promise<unknown>;

/**
 * Empty Pi's queue, and optionally abort, in the order that makes the texts recoverable.
 *
 * **The order is the whole point, and it is why this is a separate exported function rather than
 * three lines inside `Supervisor#clearQueue`.** Two things go wrong if the abort is sent first:
 *
 *   - Pi's `clear_queue` returns what it removed, so aborting first lets the run settle in the
 *     window before the clear, and Pi may begin delivering one of the queued messages as a real
 *     turn — the user asked for the opposite.
 *   - Any later refactor that reorders the pair would be invisible. Extracted, the order is an
 *     assertion in a test (C13's lesson: a thing that must happen in one order should be
 *     testable in that order).
 *
 * The returned texts are normalised from untrusted record data, so a caller can render them
 * without a second narrowing step.
 */
export async function clearQueueVia(
  send: RpcSend,
  andStop: boolean,
): Promise<{ steering: string[]; followUp: string[] }> {
  const cleared = (await send({ type: "clear_queue" }, 20_000)) as {
    steering?: unknown;
    followUp?: unknown;
  };
  const result = {
    steering: asTextArray(cleared?.steering),
    followUp: asTextArray(cleared?.followUp),
  };
  // Only now, once nothing is left to be delivered.
  if (andStop) await send({ type: "abort" }, 30_000);
  return result;
}

