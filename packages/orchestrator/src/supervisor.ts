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
import type { Command, HistoricalSession, LiveSession, ModelOption, PiRecord, ToolsetStatus } from "@pi-central/protocol";
import { composePolicy, describe, type LaunchMode, type SessionSpec } from "./policy.ts";
import {
  mcpConfigArgs,
  pickDevPort,
  reapDevPort,
  removeSidecarState,
  sidecarPromptArgs,
  spawnSidecar,
  type SidecarHandle,
} from "./sidecar-supervise.ts";
import { RpcProcess, type LaunchSpec } from "./rpc.ts";
import { retryRefusal } from "./retry.ts";
import { checkResumable } from "./resume.ts";
import { OpenSessionStore, type OpenSession } from "./open-sessions.ts";
import { sessionAt } from "./registry.ts";
import { isScratch, scratchDirFor, type Config } from "./config.ts";
import { agentRoutingEnv } from "./env.ts";
import type { AcceptedImage } from "./prompt-images.ts";
import { KEYCHAIN_FILE, inspectProviderAuth, readStore } from "./agent-store.ts";
import { assessAgentCapabilities, agentKeychainPath } from "./capabilities.ts";
import { createKeychainProbe, type KeychainCheck, type KeychainProbe } from "./keychain.ts";
import { renderPolicyFragment } from "./fragment.ts";
import { inspectToolset } from "./toolset.ts";
import { RELOAD_COMMAND, provisionReloadExtension } from "./reload-extension.ts";
import {
  listDirectory,
  readFileForDisplay,
  readFileText,
  type DirListing,
  type FileContent,
  type ImageContent,
  type Result,
} from "./files.ts";
import { revealInFileManager, type OsActionResult, type RevealOptions } from "./os-actions.ts";
import { resolveInstallationRoot } from "./installation-root.ts";
import { ownInstallationWarning } from "@pi-central/protocol";

/**
 * What an image-only prompt says, so the session file records words rather than an empty text block.
 *
 * The composer's placeholder is "Send a prompt…", which would be a lie in the transcript — this states what the reader
 * did instead of what they did not type.
 */
export const EMPTY_PROMPT_WITH_IMAGES = "See the attached image.";

/**
 * How long a manual `compact` may take before its command is considered unanswered (issue #263).
 *
 * Much longer than the state and stats timeouts because this is not a state read: Pi summarizes the conversation with
 * the model, and the response arrives at the END. A 20s deadline would abandon a compaction that is still running and
 * would have produced a perfectly good summary a few seconds later.
 */
const COMPACT_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a manual `reload` may take before its command is considered unanswered (issue #274).
 *
 * Generous, and measured rather than guessed: a reload re-resolves every package, reloads settings, shuts
 * down the extension instances and rebinds new ones, and MCP servers reconnect. On this machine, with a
 * handful of extensions, the command answers in well under a second — so a minute is not a tight bound but it
 * is far enough above the normal case that a failure is reported as a failure rather than as slowness.
 */
const RELOAD_TIMEOUT_MS = 60_000;
import { interpretRecord } from "./state.ts";
import { RefreshCoalescer, applyStats, readStats } from "./stats.ts";

export interface StartRequest {
  /** Directory to work in. Omitted means "the app-owned default workspace" (US-1, US-3). */
  cwd?: string;
  name?: string;
  mode?: LaunchMode;
  enable?: string[];
  /**
   * The dev-server port this session's sidecar may reach (ADR-0018), overriding the orchestrator default.
   *
   * `null` disables the sidecar for this session even when a default is configured, so a scratch session can
   * opt out without changing global configuration.
   */
  sidecarPort?: number | null;
  /**
   * The reader's answer to "Preview its work in a browser" (ADR-0018 §15).
   *
   * THREE-VALUED, and the middle one is the point:
   *
   *   `true`      -- give this session a browser, even when the default is off
   *   `false`     -- do NOT, even when the default is on
   *   `undefined` -- the installation's default decides
   *
   * It began two-valued, and that made the checkbox decorative: the picker always sends the reader's answer, so an
   * unticked box sent `false`, which the old code read as "not an opt-in" and then let the default supply a browser
   * anyway. Measured in the first real run.
   *
   * It still cannot GRANT a browser the machine does not have: `sidecarOffered` decides whether the checkbox is shown.
   */
  sidecar?: boolean;
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

/** What a startup restore managed to reopen, and what it could not (issue #185). */
export interface RestoreReport {
  /** A problem with the remembered set itself (unreadable, corrupt). */
  note?: string;
  /** Sessions that are running again. */
  restored: LiveSession[];
  /** Session files that no longer exist and were dropped from the set. */
  missingFile: string[];
  /**
   * Sessions that were KEPT but could not start, with the reason.
   *
   * The usual cause is a working directory that is not there at the moment — an unmounted volume,
   * a worktree that will be recreated — which is temporary and must not be treated as deletion.
   */
  unavailable: { sessionFile: string; message: string }[];
}

export class Supervisor extends EventEmitter {
  #config: Config;
  #sessions = new Map<string, LiveSession>();
  #processes = new Map<string, RpcProcess>();
  /**
   * UI sidecars, one per session that opted in (ADR-0018).
   *
   * Keyed by session so teardown can find it, and **absent** for most sessions: a sidecar exists only when a
   * port is configured, because the port is what the fragment pins. No port means no browser, and a session
   * that never sees one costs nothing.
   */
  #sidecars = new Map<string, SidecarHandle>();
  #created = 0;
  /**
   * The stats refreshes, coalesced per session (`stats.ts`).
   *
   * The cadence became `turn_end` so the meter and the cost are not minutes stale, which made two
   * refreshes overlap reachable for the first time: a compaction, a settle and a turn can all land
   * inside one round trip.
   */
  #stats = new RefreshCoalescer();
  /**
   * Compactions Pi has announced but not finished, by session id (issue #263).
   *
   * Kept separately from `LiveSession.state` on purpose. A compaction is not a run: it can start while the session is
   * idle, `agent_end` does not end it (C8), and a retry can follow it. Reading `state === "streaming"` as "a
   * compaction is running" would therefore refuse a legitimate manual compaction on an idle session, and reading
   * `state !== "streaming"` as "nothing is compacting" would allow a second one while the first is still summarizing.
   */
  #compacting = new Set<string>();
  /**
   * Manual `compact` commands sent, but not yet answered, by session id (issue #263).
   *
   * Pi's `compact` responds only after the summary has been produced, so this covers the window BEFORE
   * `compaction_start` arrives. A request timeout does not clear the announced set: Pi may still be working, and
   * sending a second compaction into that state is exactly what the guard exists to prevent.
   */
  #compactRequests = new Set<string>();
  /**
   * When each session last loaded its resources — its start, or its last reload (issue #274).
   *
   * Kept here rather than on `LiveSession` for the reason `#compacting` is: it is a fact about a MOMENT in
   * this process's life, not something Pi reported, and the toolset check needs the moment the session
   * actually read its resources. A resumed session's real start is the resume, not the file's first line, so
   * reading it from the transcript would answer a different question.
   *
   * Absent means "this process never saw it", which is reported as `unknown` freshness rather than assumed
   * fresh — exactly the case of a session restored by an earlier orchestrator and then described by this one.
   */
  #resourcesLoadedAt = new Map<string, number>();
  /**
   * Manual reloads in flight, by session id (issue #274).
   *
   * Pi refuses a reload while a run is in flight, so the guard cannot be `session.state`: the whole point of
   * the control is a session that is BUSY and stale. What must be refused is a SECOND reload while this one
   * has not answered — the same shape as `#compactRequests`, and the same consequence if it were missing: two
   * reloads racing would leave the second's `session_start` arriving after the first's rebound instances.
   */
  #reloading = new Set<string>();
  /**
   * Which sessions were open, so a restart can reopen them (issue #185).
   *
   * Loaded eagerly rather than on first use: the startup restore reads it before any session
   * exists, and a lazily-created store would be a second code path that only the first launch takes.
   */
  #open: OpenSessionStore;
  /**
   * Whether starting and stopping a session changes the remembered set (issue #185).
   *
   * Off for the one-shot CLI (`run`, `resume`), and that is a correctness requirement rather than a
   * preference: the CLI exits immediately after stopping its session, so recording it would leave an
   * entry the web app would faithfully reopen on its next launch — a session nobody has open, spawned
   * behind the surprise of whoever started the orchestrator. It would also rewrite the file the
   * running web app owns, from a second process.
   *
   * On for the long-running server, which is the thing a restart can lose.
   */
  #rememberOpenSessions: boolean;
  /**
   * The agent keychain's lock state, asked about at most once per launch (issue #269).
   *
   * Never probed here: `ensureKeychainState()` is what runs `security`, and it is called by the launch path
   * (the entry point, and the CLI) BEFORE any session spawns. The memo inside the probe is the whole
   * mechanism — without it every session would run its own `security`, and a locked keychain would raise one
   * password dialog per session for one keychain (ADR-0010 §2, C13a).
   */
  #keychain: KeychainProbe;
  /**
   * What the probe found, once it has found it. Read synchronously by `#spawn`, so the spawn path can never
   * start a dialog of its own — the same reason `report()` exists rather than a second `probe()` call.
   */
  #keychainCheck: KeychainCheck | undefined;

  constructor(
    config: Config,
    options: { rememberOpenSessions?: boolean; keychainProbe?: KeychainProbe } = {},
  ) {
    super();
    this.#config = config;
    this.#open = new OpenSessionStore(config.stateRoot);
    // Opt-in, so every existing caller (tests, the CLI, the verification harness) keeps its current
    // behaviour and only the server that owns the rail writes the list. See the field's comment.
    this.#rememberOpenSessions = options.rememberOpenSessions === true;
    // Resolved from THIS module's URL rather than configured: a configured path would be right for
    // exactly one checkout — the author's — and silently wrong everywhere else (issue #25).
    this.#installationRoot = resolveInstallationRoot();
    // Injectable for the same reason every other OS seam here is: a test cannot raise a real macOS
    // password dialog, so the only way to assert the prompt COUNT is to count the probe calls.
    this.#keychain =
      options.keychainProbe ?? createKeychainProbe({ path: agentKeychainPath(config.agentRoot) });
  }

  /**
   * Ask the agent keychain once whether it is unlocked (issue #269).
   *
   * ## Why this must run before any session spawns
   *
   * A reboot locks the keychain, and every provider key is resolved by a SEPARATE
   * `security find-generic-password` process inside a session's sandbox (C13). N restored sessions mean N
   * lookups meeting N locked-keychain requests, so the reader is prompted once per session and the one
   * password they type arrives after the others have already asked. That is the reported
   * "prompted indefinitely, entering the password once is not enough".
   *
   * One access from THIS process, before the fleet returns, turns that into one dialog: the answer unlocks
   * the keychain for every session that follows. It also decides the honest REPORTING — a locked keychain
   * makes each session unable to reach a model, which is C13's core lesson and must be said per session
   * rather than hidden behind `state: idle`.
   *
   * ## Only when it matters
   *
   * No probe runs unless the provider configuration resolves at least one key through a command
   * (`inspectProviderAuth`). A machine with inline keys needs no keychain, and probing anyway would raise a
   * password dialog for a capability nothing is about to use — the noise that trains a reader to dismiss
   * warnings.
   *
   * Never blocks indefinitely: the wait is bounded (`KEYCHAIN_PROBE_TIMEOUT_MS`) and an expired wait is
   * reported as `locked`, so a dialog nobody answers leaves a usable app with sessions that say what is
   * wrong, not an app that never starts.
   */
  async ensureKeychainState(): Promise<KeychainCheck> {
    if (this.#keychainCheck !== undefined) return this.#keychainCheck;
    const needed = inspectProviderAuth(this.#config.providerAgentDir).needsKeychain;
    if (!needed) {
      this.#keychainCheck = { needed: false };
      return this.#keychainCheck;
    }
    this.#keychainCheck = { needed: true, report: await this.#keychain.probe() };
    return this.#keychainCheck;
  }

  /**
   * The keychain state as the spawn path needs it: the answer if it exists, `undefined` otherwise.
   *
   * Never probes. A spawn must not be able to raise a dialog — that is the defect this fix exists for, and
   * the assertion that it cannot is what the prompt-count test measures.
   */
  keychainCheck(): KeychainCheck | undefined {
    return this.#keychainCheck;
  }

  /**
   * Reopen the sessions that were open when this process last ran (issue #185).
   *
   * Called once at startup by the entry point, deliberately NOT from the constructor: restoring
   * spawns Pi, and a constructor that spawned processes would make every test that builds a
   * supervisor launch sandboxes (C1 — they cannot, in CI).
   *
   * Each entry goes through the SAME path a reader's click does — `sessionAt` for the file, then
   * `resume` for the spawn — so restore inherits every rule already established there: the file
   * must still be a valid Pi session, the recorded cwd must still exist (C2), and the cwd is never
   * retargeted (ADR-0008). A second implementation of "is this resumable" is exactly the drift
   * `registry.ts` refuses elsewhere.
   *
   * Three outcomes, and the difference between them is the point:
   *
   *   - **the file is gone** → dropped from the set. A deleted session cannot come back, and keeping
   *     it would mean reporting the same absence on every launch forever.
   *   - **the cwd is gone** → reported and KEPT. This is the case that must not be forgotten: a
   *     worktree on an unmounted volume, a directory restored later in the day. Dropping it would
   *     turn a temporary absence into permanent loss of the reader's rail.
   *   - **it resumed** → nothing to say.
   *
   * Returns a summary rather than logging, so the entry point owns the wording and a test can assert
   * the decisions without capturing stderr.
   */
  async restoreOpenSessions(): Promise<RestoreReport> {
    const loaded = this.#open.load();
    const report: RestoreReport = {
      ...(loaded.note === undefined ? {} : { note: loaded.note }),
      restored: [],
      missingFile: [],
      unavailable: [],
    };

    for (const entry of loaded.sessions) {
      // A file that no longer parses as a session is indistinguishable from one that was deleted:
      // `sessionAt` refuses both, and neither can be reopened.
      const session = await sessionAt(this.#config, entry.sessionFile);
      if (session === undefined) {
        this.#open.forget(entry.sessionFile);
        report.missingFile.push(entry.sessionFile);
        continue;
      }
      const result = this.resume(session, { mode: entry.mode });
      if (!result.ok) {
        // The entry survives: `checkResumable`'s refusals include a directory that is not there at
        // the moment — a volume that will remount — and only an explicit stop may forget a session.
        report.unavailable.push({ sessionFile: entry.sessionFile, message: result.message });
        continue;
      }
      report.restored.push(result.session);
    }
    return report;
  }

  /** The remembered open sessions, for diagnosis and tests. */
  openSessions(): OpenSession[] {
    return this.#open.list();
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

    return this.#spawn({
      id,
      cwd,
      mode,
      name: request.name,
      enable: request.enable,
      env: request.env,
      ...(request.sidecarPort === undefined ? {} : { sidecarPort: request.sidecarPort }),
      ...(request.sidecar === undefined ? {} : { sidecar: request.sidecar }),
    });
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

    /*
     * NO TRANSCRIPT YET means "start fresh", not "this session does not exist".
     *
     * Pi reports `sessionFile` from `get_state` — the path it WILL write — but creates the file lazily, on the first
     * message. So a session stopped before it was ever prompted has a handle, a cwd and a path, and nothing on disk.
     * Resuming it used to fail with `no such session: <path>`, which reads as a data-loss message for a session the
     * reader had deliberately just stopped: reported as *"when i want to resume a session i have just stoppend, i get an
     * error"*.
     *
     * Nothing is lost by starting fresh — there was never a transcript to resume — and the alternative is a rail entry
     * that can only be deleted. `--session` is withheld in that case, because handing Pi a path that does not exist is
     * exactly what its exit-1-on-missing-session path is for.
     */
    const hasTranscript = existsSync(session.path);

    const id = `s${++this.#created}`;
    const mode = options.mode ?? "sandboxed";
    const spawned = this.#spawn({
      id,
      cwd: readiness.cwd,
      mode,
      // No name: the session already carries its own, and re-applying one would append a
      // redundant session_info entry to a file we did not create.
      ...(options.env ? { env: options.env } : {}),
      ...(hasTranscript ? { sessionPath: session.path } : {}),
    });
    // Recorded HERE as well as from `#refreshState`, because reopening a session on the next launch
    // is the whole point of #185, and a resumed session that failed to start must still be
    // remembered — otherwise one bad spawn at startup would quietly shrink the rail on the launch
    // after it. `resume` is the only path that knows the file synchronously.
    // A session with no transcript is remembered under the file Pi reports after it starts, not under `session.path` —
    // otherwise the next launch would try to reopen a path that was never written.
    if (spawned.ok && hasTranscript && this.#rememberOpenSessions) this.#open.remember(session.path, mode);
    return spawned;
  }

  /**
   * The live session using one session file, if any.
   *
   * Public because deleting a transcript has to refuse while a process holds it open (issue #150), and that decision
   * belongs with the component that knows what is running (C3) rather than with the transport.
   */
  listedByFile(sessionPath: string): LiveSession | undefined {
    return this.#findLiveByPath(sessionPath);
  }

  /**
   * The session entry for one file, in ANY state — including `stopped` and `failed`.
   *
   * ## Why this is separate from `listedByFile`
   *
   * `listedByFile` answers "is a PROCESS holding this transcript open", because that is what refusing a delete needs,
   * and it therefore excludes `stopped` and `failed`. Reusing it to answer "do I know this session" was wrong in a way
   * that made a fix dead code: resuming a session the reader had just stopped asked `listedByFile`, got `undefined`,
   * and refused with `no such session` — the exact report — because a stopped session is by definition not running.
   *
   * The two questions are different and now have different names.
   */
  /**
   * Drop a session entry whose transcript has been deleted (issue #150).
   *
   * The FILE is already gone by the time this runs; what remains is a supervisor entry for a file that no longer exists.
   * Left in place it would be re-broadcast in the next snapshot, and the client's "every live session belongs in the
   * roster" effect would restore the row the reader had just deleted.
   *
   * Refused for a session that is still RUNNING. The delete path already refuses that case; this is the second guard,
   * because forgetting a live entry would leave a process writing to a file nothing is tracking, which is the branch
   * point ADR-0004 exists to prevent.
   */
  forgetFile(sessionPath: string): void {
    const entry = this.entryByFile(sessionPath);
    if (entry === undefined) return;
    if (entry.state !== "stopped" && entry.state !== "failed") return;
    this.#sessions.delete(entry.id);
    this.#processes.delete(entry.id);
    this.#open.forget(sessionPath);
  }

  entryByFile(sessionPath: string): LiveSession | undefined {
    for (const session of this.#sessions.values()) {
      if (session.sessionFile === sessionPath) return session;
    }
    return undefined;
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
    /** Per-session override (ADR-0015): a number pins the port, `null` opts out entirely. */
    sidecarPort?: number | null;
    /** Per-session opt-IN, so a client can turn the browser on without a global default. */
    sidecar?: boolean;
  }): StartResult | StartFailure {
    // A resumed session must reopen its file; a new one gets a fresh name.
    //
    // The environment carries the agent-scoped routing (ADR-0010 §3): GH_CONFIG_DIR and
    // GIT_CONFIG_GLOBAL point into the agent's own tree, and GIT_CONFIG_SYSTEM=/dev/null
    // removes the host's system git config as an independent route to the login keychain.
    /**
     * Resolve the sidecar port, and spawn the sidecar BEFORE the session's policy is composed.
     *
     * The ordering is forced: the sidecar's bearer token has to reach Pi through the session environment, and
     * `composePolicy` derives `--env-pass` from that environment (C15 — Safehouse runs the session under
     * `env -i`, so a variable is delivered only when it is requested by name). Composing first would produce a
     * session that could never present the token, and the failure would look like an unreachable server.
     *
     * The port resolves per session: an explicit `null` opts out, a number overrides the orchestrator default.
     */
    // Precedence: an explicit per-session value, then an explicit global pin, then the port Pi Central assigns
    // (when sidecars are on at all). ASSIGNED is the default because a discovered port collides across sessions.
    const sidecarPort =
      input.sidecarPort === null || input.sidecar === false
        ? undefined
        : (input.sidecarPort ??
          this.#config.sidecarPort ??
          (this.#config.sidecar === true || input.sidecar === true ? this.#assignDevPort(input.id) : undefined));
    const sidecarHandle =
      sidecarPort !== undefined && input.mode === "sandboxed"
        ? this.#startSidecar(input.id, sidecarPort)
        : undefined;

    const env = {
      ...agentRoutingEnv(this.#config.agentRoot),
      ...(input.env ?? {}),
      // The trusted channel (ADR-0010 §3). Absent when there is no sidecar, so nothing references a token that
      // does not exist.
      ...(sidecarHandle === undefined
        ? {}
        : {
            PI_CENTRAL_SIDECAR_TOKEN: sidecarHandle.token,
            PI_CENTRAL_DEV_PORT: String(sidecarHandle.devPort),
          }),
    };

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
            // Only when this session HAS a sidecar: the grant is for the directory holding its mcp.json, and Pi is the
            // process that must read it. Measured failure this prevents: the file existed, the sidecar was answering,
            // and Pi reported "0 servers configured" because the open was denied.
            ...(sidecarHandle === undefined
              ? {}
              : { sidecarConfigDir: join(this.#config.stateRoot, "sidecars", input.id) }),
          })
        : undefined;

    /*
     * Pi Central's own reload command, provisioned into the agent directory and loaded with `--extension` (issue
     * #274, ADR-0015). Written on EVERY spawn so an upgraded Pi Central cannot leave an older copy behind, and
     * deliberately best-effort: an agent tree the reader owns is not Pi Central's to write into (ADR-0010 §5), so
     * a failure here costs the reload control and nothing else — the session still starts.
     */
    const reloadExtension = provisionReloadExtension(this.#config.providerAgentDir);

    const spec: SessionSpec = {
      id: input.id,
      cwd: input.cwd,
      mode: input.mode,
      safehouse: this.#config.safehouse,
      pi: this.#config.pi,
      ...(reloadExtension === undefined ? {} : { extension: reloadExtension }),
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
      // Read-only, and read synchronously on purpose: `ensureKeychainState()` is the ONLY place that runs
      // `security`, and it ran before the fleet restored (issue #269). Probing here would put one dialog per
      // session back, which is the defect. `undefined` means nobody asked, and then the assessment stays silent
      // about the keychain rather than claiming it is fine.
      ...(this.#keychainCheck === undefined ? {} : { keychainState: this.#keychainCheck }),
    });

    /*
     * A session that has just spawned is, by construction, current: Pi discovered its resources a moment ago.
     * Recorded HERE because this is the only place that knows the moment — and the toolset check is unusable
     * without it, since "newer than what?" has no answer otherwise (issue #274).
     */
    this.#resourcesLoadedAt.set(input.id, Date.now());

    const session: LiveSession = {
      id: input.id,
      name: input.name?.trim() || handleName(input.id),
      cwd: input.cwd,
      state: "starting",
      mode: input.mode,
      isolation: policy.isolation,
      ...(sidecarHandle === undefined ? {} : { sidecarOrigin: sidecarHandle.origin }),
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

    const launch = this.#buildLaunch(policy.launch, input.sessionPath, this.#sidecars.get(session.id), input.cwd);
    // The Inspector shows this string, so it has to be the argv that actually runs. It was computed from
    // `policy` before the sidecar existed, which showed a session without `--mcp-config` while the process
    // had one — a display that disagrees with reality in the one place that exists to be truthful (the house
    // style there is the verbatim policy).
    session.command = [launch.command, ...launch.args].join(" ");
    const rpc = new RpcProcess(launch);
    this.#processes.set(session.id, rpc);

    rpc.on("record", (record: PiRecord) => this.#onRecord(session.id, record));
    rpc.on("failed", (error: Error) => {
      session.state = "failed";
      session.error = error.message;
      this.#clearCompacting(session.id);
      this.#clearReloading(session.id);
      this.#patch(session.id);
      this.emit("error", session.id, error.message);
    });
    rpc.on("exit", ({ code, signal, stderr }: { code: number | null; signal: string | null; stderr: string }) => {
      if (session.state === "stopped") return;
      session.state = "failed";
      session.error = describeExitFailure(code, signal, stderr);
      session.dialogs = [];
      this.#clearCompacting(session.id);
      this.#clearReloading(session.id);
      this.#patch(session.id);
      // A session whose Pi died gets no browser either. Without this the sidecar outlives the only thing that
      // could have used it, and a failed session would leak a process until shutdown.
      void this.#stopSidecar(session.id);
      this.emit("error", session.id, session.error);
    });

    rpc.start();
    this.#patch(session.id);
    void this.#refreshState(session.id);
    return { ok: true, session };
  }

  /**
   * Persist a session once its FILE is known (issue #185).
   *
   * Called from the two places that learn it: `#refreshState` (the first `get_state` of a new
   * session, where Pi reports the file it just created) and `retry` of a session that already had
   * one. Recording the Pi Central handle here instead would be the "keyed by handle" mistake
   * `roster.ts` documents: `sN` is per-process, and after a restart it addresses a different
   * conversation.
   *
   * A resumed session is already known — `resume` records it synchronously — so the store's own
   * "nothing changed, no write" check keeps this from writing on every state refresh.
   */
  #rememberSession(session: LiveSession): void {
    if (!this.#rememberOpenSessions) return;
    this.#open.remember(session.sessionFile, session.mode);
  }

  /**
   * A resumed session reopens its file (`--session <path>`); a new session is left to Pi's
   * default naming in its workspace.
   *
   * `--session` is appended after the `--` separator, so it is a *pi* argument, not a
   * safehouse one. The only value interpolated is a path validated to exist by
   * `checkResumable`; the argument shape is fixed.
   */
  /**
   * `cwd` is passed so the instruction can say when a project cannot be served at all (Pi Central's own checkout,
   * where C1 stops its orchestrator). Advisory only: it changes what the agent is told.
   */
  #buildLaunch(launch: LaunchSpec, sessionPath: string | undefined, sidecar: SidecarHandle | undefined, cwd: string): LaunchSpec {
    const extra: string[] = [];
    // BEFORE any subcommand: `pi mcp list --mcp-config X` reports "Unknown option" (Phase 0D measured it,
    // and a probe nearly concluded the flag did not exist because of the ordering).
    extra.push(...mcpConfigArgs(sidecar));
    extra.push(...sidecarPromptArgs(sidecar, cwd));
    if (sessionPath) extra.push("--session", sessionPath);
    if (extra.length === 0) return launch;
    return { ...launch, args: [...launch.args, ...extra] };
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
      // A new session's file only exists after this first `get_state`, which is why the set is
      // written HERE rather than at spawn (issue #185). A no-op once known.
      this.#rememberSession(session);
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
    await this.#stats.run(id, async () => {
      // Re-read both each round rather than capturing them: a stop can delete the entry while a refresh is in
      // flight, and asking a reaped process is how a cosmetic read turns into a log of timeouts.
      const session = this.#sessions.get(id);
      const rpc = this.#processes.get(id);
      if (!session || !rpc || !rpc.running) return;
      try {
        applyStats(session, readStats(await rpc.send({ type: "get_session_stats" }, 20_000)));
        this.#patch(id);
      } catch {
        // Stats are still cosmetic in the sense that they must never FAIL a session — but they are no longer
        // cosmetic in when they are read: see the cadence note in `state.ts`.
      }
    });
  }

  #onRecord(id: string, record: PiRecord): void {
    const session = this.#sessions.get(id);
    if (!session) return;

    /*
     * A compaction is tracked from Pi's OWN announcement, so an AUTOMATIC one (overflow or threshold) is guarded
     * exactly like a manual one: a second manual command while either is running would be a second summarization of
     * the same context. The record is also the only place that can clear the mark on a compaction this process did
     * not start, and `compaction_end` arrives for a failure too (`aborted` / `errorMessage`).
     */
    if (record.type === "compaction_start") this.#compacting.add(id);
    if (record.type === "compaction_end") this.#compacting.delete(id);
    session.compacting = this.#isCompacting(id);

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
   * Send a prompt. The command shape is closed; the message and its images are the only free values.
   *
   * `behavior` decides what a message means mid-run, and it is the caller's choice rather than
   * this method's: Pi REJECTS a streaming `prompt` with no `streamingBehavior` (`"Agent is
   * already processing. Specify streamingBehavior ('steer' or 'followUp')"`), so defaulting it
   * silently would decide for the user something the composer is there to ask (issue #3). When
   * idle there is nothing to steer into, so the flag is dropped rather than sent.
   *
   * `images` arrive ALREADY VALIDATED (`prompt-images.ts`) and are mapped to Pi's shape here — the one
   * place a control becomes Pi's stdin, which is the right place for the spelling to change. Pi wants
   * `{ type: "image", data, mimeType }`; the wire carries `{ mediaType, data }` because `type` is the
   * discriminant of every record on that wire and reusing it inside a payload makes a log ambiguous.
   */
  async prompt(
    id: string,
    message: string,
    behavior?: "steer" | "followUp",
    images: readonly AcceptedImage[] = [],
  ): Promise<void> {
    const rpc = this.#processes.get(id);
    const session = this.#sessions.get(id);
    if (!rpc || !session) throw new Error(`no such session: ${id}`);

    /*
     * Omitted rather than sent empty, because Pi distinguishes the two: `images: []` is a field asserting "this message
     * has no images", while an absent field is a message that was never about images. Only the second is true for the
     * overwhelming majority of prompts, and a provider request should not carry a claim it need not make.
     */
    /*
     * An image-only prompt gets a stated message rather than an empty one.
     *
     * Pi accepts `message: ""` with images and builds `[{type:"text", text:""}, ...images]`, which every provider then
     * receives as an empty text block beside the picture. Measured against the real flow: the model answers, but the
     * session file records a turn whose text is nothing, and a reader scrolling back sees an image with no words around
     * it. One sentence saying what the message is costs nothing and makes the transcript legible later.
     *
     * The composer's placeholder says the same thing, so this is not inventing an instruction — it is recording the one
     * the reader was typing under. It is applied HERE rather than in the browser so a transcript written by any client
     * (or by `pi-central run --prompt`) stays readable.
     */
    const text = message.trim().length === 0 && images.length > 0 ? EMPTY_PROMPT_WITH_IMAGES : message;
    const withImages = images.length > 0
      ? { images: images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mediaType })) }
      : {};

    if (session.state === "streaming") {
      await rpc.send(
        { type: "prompt", message: text, streamingBehavior: behavior ?? "followUp", ...withImages },
        60_000,
      );
    } else {
      await rpc.send({ type: "prompt", message: text, ...withImages }, 60_000);
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
          /*
           * `input` decides whether the composer may offer a paste.
           *
           * Filtered to the two values the wire declares rather than passed through: Pi's catalogue may grow a
           * modality this version does not know, and an unrecognised member would widen the UI's type for a capability
           * nothing here can use. Absent when Pi did not report it — which is "unknown", NOT "text only", and the
           * difference decides whether the affordance is hidden or merely unflagged.
           */
          ...(Array.isArray(model["input"])
            ? {
                input: (model["input"] as unknown[]).filter(
                  (value): value is "text" | "image" => value === "text" || value === "image",
                ),
              }
            : {}),
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

  /**
   * Compact this session's context on request (issue #263).
   *
   * ## Why the guard is the compaction, not the run
   *
   * A second press while a compaction is outstanding is REFUSED here, and the guard is the two sets below rather
   * than `session.state`: compaction can begin on an idle session and `agent_end` does not finish it (C8), so the run
   * state answers a different question. `#compactRequests` covers the window before Pi announces `compaction_start`;
   * `#compacting` covers the window after, including an AUTOMATIC compaction the reader did not ask for.
   *
   * ## Why the send is awaited
   *
   * Pi answers `compact` only after the summary has been generated, with `success: false` and a reason when there is
   * nothing to compact or the provider refuses. Awaiting that answer is what lets a refusal become an `error` event
   * naming the reason, exactly as `setModel` does, instead of a button that appears to work. The timeout is therefore
   * generous: a summary is a model call, not a state read.
   *
   * ## What it deliberately does not do
   *
   * It does not refresh stats, set `idle`, or touch `session.state`. `compaction_end` is the one stats refresh point
   * (`state.ts`), and a compaction is not completion. `contextPercent` becomes `null` when Pi says it is unknown
   * after the compaction, which the meter renders as `—`, never `0%`.
   */
  async compact(id: string): Promise<void> {
    const rpc = this.#processes.get(id);
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`no such session: ${id}`);
    if (!rpc || !rpc.running) {
      throw new Error("this session is not running, so there is nothing to compact");
    }
    if (this.#isCompacting(id)) {
      throw new Error("a compaction is already running for this session");
    }

    this.#compactRequests.add(id);
    session.compacting = true;
    this.#patch(id);
    try {
      await rpc.send({ type: "compact" }, COMPACT_TIMEOUT_MS);
    } finally {
      this.#compactRequests.delete(id);
      // Pi emits `compaction_end` before its response, so this is normally already false. If an event was missed or
      // the command timed out, the ANNOUNCED set still wins: a compaction Pi has not finished stays guarded.
      session.compacting = this.#isCompacting(id);
      this.#patch(id);
    }
  }

  /**
   * Make this session re-read its resources (issue #274).
   *
   * ## Why the mechanism is a command, and not `ctx.reload()` from here
   *
   * This process is not inside Pi. `ctx.reload()` belongs to an extension running in the session's own
   * process, and Pi's RPC surface has no `reload` command — `/reload` is a built-in TUI command, excluded from
   * `get_commands` because it "would not execute if sent via `prompt`" (Pi's `rpc-commands.md`). What IS
   * reachable is an extension-registered command, which `get_commands` returns and `prompt` runs with a `/`
   * prefix. So Pi Central provisions one extension (`reload-extension.ts`, ADR-0015) and sends its name.
   *
   * ## Why the send is awaited, and what its answer means
   *
   * Pi answers `prompt` as soon as the command is accepted, with `disposition: "handled"` for an extension
   * command: no run starts, so `agent_settled` never follows and waiting for one would hang. The reload itself
   * has not finished at that point, so the moment is recorded when the answer arrives — which is slightly late
   * rather than slightly early, and therefore conservative: a file written DURING the reload reads as changed
   * rather than as included, and the safe direction for a staleness claim is to over-report.
   *
   * ## A failure must not read as success
   *
   * `ctx.reload()` can throw, and Pi reports a throwing command handler as an `extension_error` record while the
   * `prompt` response still says `success: true, disposition: "handled"` — measured, not assumed. Reporting that
   * as a successful reload is exactly the "session that has lost its extensions and says nothing" the issue
   * forbids, so the extension errors seen during the call are collected and rethrown here.
   *
   * ## `interrupt`
   *
   * Pi refuses to reload mid-run ("Wait for the current response to finish before reloading"). A reader who
   * asked for the reload anyway has confirmed that the RUN is affected — that is what the confirmation in the
   * UI names — so this aborts first, then reloads. Nothing is aborted unless the caller said so: the default is
   * to refuse with Pi's own sentence, which the UI shows.
   */
  async reload(id: string, options: { interrupt?: boolean } = {}): Promise<void> {
    const rpc = this.#processes.get(id);
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`no such session: ${id}`);
    if (!rpc || !rpc.running) {
      throw new Error("this session is not running, so it has no resources to reload");
    }
    if (this.#reloading.has(id)) throw new Error("a reload is already running for this session");

    this.#reloading.add(id);
    session.reloading = true;
    this.#patch(id);
    const errors: string[] = [];
    /*
     * ONE argument, because this listens to the PROCESS rather than to the supervisor.
     *
     * `RpcProcess` emits `record` with the record alone, while `Supervisor` emits `(id, record)` — a difference
     * that is invisible in the type system (both are `EventEmitter`s) and produced exactly the silent failure this
     * listener exists to prevent: with the supervisor's shape, `sessionId` was the record and `record` was
     * `undefined`, so the handler threw on its first line and a broken reload was reported as a working one.
     */
    const onRecord = (record: PiRecord): void => {
      if (record.type === "extension_error" && String(record.event ?? "") === "command") {
        errors.push(String(record.error ?? "the reload command failed"));
      }
    };
    rpc.on("record", onRecord);
    try {
      if (options.interrupt === true && session.state === "streaming") {
        // Before the reload, never after: Pi refuses a reload while streaming, so the order is not a preference.
        await rpc.send({ type: "abort" }, 30_000);
      }
      const data = (await rpc.send({ type: "prompt", message: `/${RELOAD_COMMAND}` }, RELOAD_TIMEOUT_MS)) as
        | { disposition?: string }
        | undefined;
      /*
       * `started` or `queued` means Pi did NOT run the command — it took the text as a prompt for the model,
       * which happens whenever the extension is not loaded (an agent directory the reader owns and Pi Central
       * could not write into, say). Treating that as a reload would send `/pi-central:reload` to the model as a
       * task and report success. `handled` is the ONLY disposition that means the command ran.
       */
      if (data?.disposition !== "handled") {
        throw new Error(
          `Pi accepted the reload as a prompt rather than running it (disposition: ${String(data?.disposition)}). ` +
            "Pi Central's reload command is not loaded in this session, so nothing was reloaded.",
        );
      }
      if (errors.length > 0) throw new Error(`the reload failed: ${errors.join("; ")}`);
      this.#resourcesLoadedAt.set(id, Date.now());
      // Re-read the state rather than assume: a reload rebinds the extension instances, so the model, the
      // thinking level and the streaming flag are read FRESH from Pi afterwards — the rule `setModel` follows,
      // and for a stronger reason here.
      await this.#refreshState(id);
    } finally {
      rpc.off("record", onRecord);
      this.#reloading.delete(id);
      session.reloading = false;
      this.#patch(id);
    }
  }

  /**
   * What can honestly be said about this session's toolset (issue #274).
   *
   * Synchronous and plain `fs`, at the orchestrator's UID: it reads directory metadata inside the session's
   * OWN cwd and Pi's agent directory, which is the orchestrator's business — the same reasoning as `listFiles`
   * (ADR-0007). No sandbox is involved, and nothing inside a session is asked.
   *
   * A session with no live process is still answered: "is this session stale" is a question about the session,
   * not about its process, and the answer is what tells a reader whether resuming would pick anything new up.
   * `resourcesLoadedAt` is `undefined` in that case, so the freshness is `unknown` rather than a fabricated
   * `unchanged`.
   */
  toolset(id: string): ToolsetStatus {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`no such session: ${id}`);
    return inspectToolset({
      agentDir: this.#config.providerAgentDir,
      cwd: session.cwd,
      resourcesLoadedAt: this.#resourcesLoadedAt.get(id),
    });
  }

  /** Is a reload outstanding for this session? (issue #274) */
  #isReloading(id: string): boolean {
    return this.#reloading.has(id);
  }

  /** Drop a reload mark for a session that is going away, and say so on its next update. */
  #clearReloading(id: string): void {
    this.#reloading.delete(id);
    const session = this.#sessions.get(id);
    if (session) session.reloading = false;
  }

  /** Is a compaction outstanding for this session? Requests count before Pi announces the start (issue #263). */
  #isCompacting(id: string): boolean {
    return this.#compacting.has(id) || this.#compactRequests.has(id);
  }

  /** Drop both compaction marks for a session that is going away, and say so on its next update. */
  #clearCompacting(id: string): void {
    this.#compacting.delete(id);
    this.#compactRequests.delete(id);
    const session = this.#sessions.get(id);
    if (session) session.compacting = false;
  }

  async stop(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    const rpc = this.#processes.get(id);
    if (!session || !rpc) return;
    session.state = "stopped";
    session.dialogs = [];
    // An EXPLICIT stop is the only thing that forgets a session (issue #185). Shutdown does not —
    // see `stopAll` — because "I am updating Pi Central" and "I am done with this conversation"
    // are different statements, and only the second should empty the rail.
    if (this.#rememberOpenSessions) this.#open.forget(session.sessionFile);
    // A stopped session has no compaction to guard: leaving the mark would refuse the next one after a resume.
    this.#clearCompacting(id);
    // Same for a reload in flight (issue #274): the process is about to answer nothing, and a latch would refuse
    // every reload after the resume.
    this.#clearReloading(id);
    this.#patch(id);
    await this.#stopSidecar(id);
    await rpc.stop();
    this.#processes.delete(id);
  }

  /**
   * Take a session's sidecar down, and forget it.
   *
   * Called from every path that ends a session, because a sidecar outliving its session holds a browser and a
   * port — the failure mode the pipe lifetime exists to prevent. The pipe is the backstop; this is the
   * deliberate half, and both are kept: the pipe covers `kill -9` of this process, which no code here runs for.
   *
   * A stop failure is logged and swallowed. A sidecar already gone is the normal case during shutdown, and
   * refusing to finish a session teardown because its browser had died first would be a worse outcome than a
   * stale log line.
   */
  /**
   * Spawn a session's sidecar, or return `undefined` when it cannot be started.
   *
   * Called BEFORE the session's policy is composed, because the sidecar's bearer token has to reach Pi through
   * the session environment and `composePolicy` derives `--env-pass` from that environment (C15). Composing
   * first would produce a session that could never present the token, and the failure would look like an
   * unreachable server rather than a missing variable.
   *
   * **Eager, deliberately.** A sidecar is a process the ORCHESTRATOR owns (ADR-0018 §1 — it cannot be a child of
   * the session, because Seatbelt does not nest). Starting it at spawn means the tool is simply there when the
   * agent looks; the alternative is a `/reload` dance after writing the config, which teaches the agent that the
   * feature is unreliable. The BROWSER inside stays lazy: `info` answers without launching one.
   *
   * A failure is logged and swallowed. A browser is a capability, not a precondition: the session is still
   * useful without one, and a launch error in the transcript is noise nobody asked for.
   */
  /** Ports assigned to live sessions, which may not be listening yet and so cannot be found by looking. */
  readonly #devPorts = new Map<string, number>();

  #assignDevPort(sessionId: string): number | undefined {
    const port = pickDevPort(sessionId, new Set(this.#devPorts.values()));
    if (port === undefined) {
      this.emit("log", sessionId, "no UI sidecar for this session: every dev port in the assigned range is in use");
      return undefined;
    }
    this.#devPorts.set(sessionId, port);
    return port;
  }

  #startSidecar(sessionId: string, port: number): SidecarHandle | undefined {
    try {
      const handle = spawnSidecar({
        sessionId,
        port,
        stateRoot: this.#config.stateRoot,
        safehouse: this.#config.safehouse,
        // NODE, not `pi`. The first version passed `config.pi` and started the sidecar with Pi itself, which is
        // not an interpreter for a .ts file: the process died before printing anything and Pi reported only
        // "Connection closed".
        sidecar: process.execPath,
        sidecarArgs: [resolveSidecarEntry(import.meta.dirname)],
        // Read-only access to the sidecar's own code. Without it a source-launched sidecar cannot start at all:
        // the sandbox will not let the interpreter open a script outside its workdir.
        sidecarCodeDir: join(import.meta.dirname, ".."),
        browser: this.#config.browser,
        onLog: (line: string) => this.emit("log", sessionId, line),
      });
      this.#sidecars.set(sessionId, handle);
      return handle;
    } catch (error) {
      this.emit("log", sessionId, `no UI sidecar for this session: ${(error as Error).message}`);
      return undefined;
    }
  }

  async #stopSidecar(id: string): Promise<void> {
    // Only a port Pi Central ASSIGNED is ever in this map, so an explicit or pinned port (someone's real dev server)
    // cannot be reaped by mistake. See `reapDevPort` for why the port is the handle.
    const assigned = this.#devPorts.get(id);
    this.#devPorts.delete(id);
    if (assigned !== undefined) {
      const reaped = reapDevPort(assigned);
      if (reaped.length > 0) this.emit("log", id, `stopped ${reaped.length} dev server(s) left on port ${assigned}`);
    }
    // The STATE goes too, not only the process. Measured: a dev install had five session directories under
    // <state>/sidecars/ that nothing would ever read again, each holding a fragment pinning a port and a config naming
    // a token from a previous launch. Only for an assigned port: a hand-configured one is the reader's own.
    if (assigned !== undefined) removeSidecarState(this.#config.stateRoot, id);
    const sidecar = this.#sidecars.get(id);
    if (sidecar === undefined) return;
    this.#sidecars.delete(id);
    try {
      await sidecar.stop();
    } catch (error) {
      this.emit("log", id, `sidecar teardown: ${(error as Error).message}`);
    }
  }

  /**
   * Stop every session, WITHOUT forgetting them (issue #185).
   *
   * This is the shutdown path (Ctrl-C, SIGTERM), and the distinction is the whole feature: the next
   * launch reopens what was open. `forget` exists for the one caller that really means "empty the
   * rail" — an explicit stop.
   */
  async stopAll(options: { forget?: boolean } = {}): Promise<void> {
    const ids = [...this.#processes.keys()];
    if (options.forget === true) {
      await Promise.all(ids.map((id) => this.stop(id)));
      return;
    }
    // Stop the processes directly rather than through `stop`, whose contract includes forgetting.
    await Promise.all(
      ids.map(async (id) => {
        const session = this.#sessions.get(id);
        const rpc = this.#processes.get(id);
        if (!session || !rpc) return;
        session.state = "stopped";
        session.dialogs = [];
        this.#clearCompacting(id);
        this.#clearReloading(id);
        this.#patch(id);
        await this.#stopSidecar(id);
        await rpc.stop();
        this.#processes.delete(id);
      }),
    );
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
   * Select one path from a session's working directory in the platform file manager (ADR-0014).
   *
   * The session lookup is here for the same reason `readFile`'s is: `cwd` has exactly one source, and the
   * action must be confined by the SAME root a read uses. An unknown session is refused rather than resolved
   * against some other root, or a stale id would reveal a directory with no relation to what it named.
   *
   * `onLaunchError` carries the failures that can only be known after the spawn — the binary is missing, or it
   * exited non-zero. They arrive asynchronously, so they cannot be a return value.
   */
  reveal(id: string, path: string, options: RevealOptions = {}): OsActionResult {
    const session = this.#sessions.get(id);
    if (!session) {
      return {
        ok: false,
        error: { reason: "not-found", message: `no session ${id}, so there is no working directory to reveal from` },
      };
    }
    return revealInFileManager(session.cwd, path, options);
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

/**
 * A session with no name of its own is named by its HANDLE, not by its directory.
 *
 * ## Why not the directory name
 *
 * It was the directory name, and it looked like a title somebody chose. Reported from use: *"the new session gets
 * the name of the directory as it seems. I think we should stick to the Undefined session, because otherwise it
 * looks intentional."*
 *
 * That is the same principle #77 settled for generated names — *"a generated name looks chosen"*, which removes the
 * nudge to ever name the session. A directory-derived name is worse than a random one, because it is also
 * **duplicated**: three tasks in one project gave three rows called `pi-central`. With many sessions per directory
 * now the intended workflow (#149), that is three identical labels in the rail, which is the #78 defect arriving
 * from a new direction.
 *
 * The handle is honest — `s12` says "unnamed, and here is which one" — and it is what `nameLabel` in the UI already
 * treats as a placeholder, so the rail shows it as-is rather than mistaking it for a chosen name.
 *
 * The session is NOT nameless, though: Pi titles it from the first message (the `session_info` record
 * `registry.ts` reads back), and `refreshState` adopts that name as soon as it exists. So this label is genuinely
 * provisional, which is exactly what it should look like.
 *
 * Considered and rejected: `"<old session name (n)>"` when starting from an existing session. It reads as a name
 * the user chose, and it inherits a name they may not have chosen either.
 */
export function handleName(id: string): string {
  return id;
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


/**
 * The sidecar's entry point, as this installation actually has it.
 *
 * Two modes that cannot share a path. From SOURCE the supervisor sits in `packages/orchestrator/src` and the entry
 * is the `.ts` file beside it. In the PUBLISHED package everything is bundled into `bin/`, and the sidecar is a
 * second bundle there -- the `.ts` sources are not shipped, and Node refuses to strip types under `node_modules`
 * anyway. Before this existed, an installed copy launched a path that did not exist, and the failure was swallowed
 * as "no browser for this session".
 *
 * Resolved by looking, not by a mode flag: a flag is one more thing to set, and a wrong setting would fail as a
 * missing capability rather than as an error. Exported so a test can hold both branches without building a package.
 */
export function resolveSidecarEntry(dir: string): string {
  const source = join(dir, "sidecar.ts");
  return existsSync(source) ? source : join(dir, "pi-central-sidecar.js");
}
