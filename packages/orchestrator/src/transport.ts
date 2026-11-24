/**
 * The orchestrator's WebSocket transport (Phase 2, ROADMAP).
 *
 * Bridges the `Supervisor` to browser clients using the typed envelopes in
 * `@pi-central/protocol`. Deliberately thin: it routes, serializes, and enforces two
 * boundaries, and holds no session logic of its own. Anything that needs to know about Pi
 * belongs in the supervisor, which is testable without a socket.
 *
 * Two boundaries, both structural rather than conventional:
 *
 *   1. **Control is a closed union.** A client cannot name an arbitrary operation; the
 *      protocol has no shape for one. An unknown `kind` is rejected, not ignored, so a UI
 *      version skew surfaces as an error instead of silently doing nothing.
 *
 *   2. **Events carry untrusted content and are never re-parsed as control.** The envelope
 *      direction field makes that machine-checkable, so the trust boundary does not depend
 *      on the reader remembering it.
 *
 * Loopback is **not** a security boundary (C5): any local process can connect. The socket
 * therefore grants exactly the capabilities of the user running the orchestrator, which is
 * why it must not be exposed beyond `127.0.0.1` and why the client count is bounded.
 */
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  type Control,
  type Envelope,
  type Event,
  type HistoricalSession,
  type InstallFacts,
  type LiveSession,
  type OsActionKind,
  type PiRecord,
  type ServerPayload,
} from "@pi-central/protocol";
import { findOwnPackage } from "./package-meta.ts";
import type { Supervisor } from "./supervisor.ts";
import type { FileError } from "./files.ts";
import type { OsActionError } from "./os-actions.ts";
import { acceptImages } from "./prompt-images.ts";
import { discover, sessionAt } from "./registry.ts";
import { abbreviate, listPlace, nameOf, placesFor } from "./places.ts";
import { existsSync } from "node:fs";
import { deleteSessionFile } from "./delete-session.ts";
import type { Config } from "./config.ts";
import type { KeychainCheck } from "./keychain.ts";
import { createUiRequestHandler, resolveUiDistDir, servedUiIdentity } from "./static-ui.ts";
import { acceptPrefs, readPrefs, writePrefs } from "./prefs-store.ts";

export interface TransportOptions {
  host?: string;
  port?: number;
  /** Cap concurrent clients. Loopback is reachable by any local process (C5). */
  maxClients?: number;
  /**
   * The built UI to serve at `/` (issue #24). Absent → `resolveUiDistDir()`, i.e. the repository's
   * own `packages/ui/dist`.
   *
   * Set to `null` to serve no UI at all, which is what a test that only cares about the socket
   * wants: otherwise every transport test would depend on whether the UI happened to be built.
   */
  uiDir?: string | null;
  /**
   * Session discovery, replaceable so a test can COUNT it (issue #220).
   *
   * Injectable rather than mocked: #220's whole claim is that a window returning to view no longer runs
   * discovery, and the only way to assert that is to count the calls. Node's `mock.module` would do it, but
   * it is experimental and needs a flag this repository's test script does not pass — so the seam is a
   * parameter, the same shape `static-ui.ts` uses for its packaged-layout test.
   *
   * It is a seam and nothing more: no production caller passes it, and the default is the real function, so
   * there is no second discovery implementation to keep in step.
   */
  discoverSessions?: typeof discover;
  /**
   * How the transport learns the launch's keychain state (issue #269).
   *
   * **Supplied by the entry point, never derived here.** The state is a fact about the LAUNCH — established
   * once, before the fleet restored — rather than about the transport or the snapshot, so the transport
   * reports what it was told and nothing else. Absent means "not reported", which the snapshot renders as
   * silence rather than as a healthy keychain: the transport cannot invent a state the launch did not find.
   *
   * A function rather than a value for the same reason `ui` is read per snapshot: a connection that arrives
   * before the launch has answered would otherwise freeze `undefined` for the life of the process.
   */
  keychainCheck?: () => KeychainCheck | undefined;
}

export interface TransportAddress {
  host: string;
  port: number;
  url: string;
}

/**
 * Every control kind the orchestrator understands, for the runtime check in `#onMessage`.
 *
 * ## Why this is a `Record` and not a `Set` literal
 *
 * It was `new Set<Control["kind"]>([...])`, and `Set<Control["kind"]>` does **not** require every member: a
 * missing kind compiles cleanly. So issue #11 added `retry` to the `Control` union and to the `switch`, and the
 * allowlist above the switch went on rejecting it — every press answered `bad control: unknown kind 'retry'`
 * on a branch that had implemented it. The feature was dead on arrival and nothing failed.
 *
 * A `Record<Control["kind"], true>` IS exhaustive: adding a member to the union makes this object stop
 * compiling until it is added here. The set is derived from it, so there is one list rather than two.
 */
const CONTROL_KINDS: Record<Control["kind"], true> = {
  list: true,
  install: true,
  getPrefs: true,
  setPrefs: true,
  start: true,
  prompt: true,
  clearQueue: true,
  abort: true,
  stop: true,
  rename: true,
  deleteSession: true,
  setModel: true,
  listModels: true,
  setThinkingLevel: true,
  listThinkingLevels: true,
  compact: true,
  reload: true,
  toolset: true,
  answerDialog: true,
  resume: true,
  retry: true,
  listFiles: true,
  listPlaces: true,
  readFile: true,
  reveal: true,
};

const KNOWN_CONTROL_KINDS: ReadonlySet<string> = new Set(Object.keys(CONTROL_KINDS));

/** Reject a malformed envelope with a reason, rather than closing silently. */
export function parseControl(raw: string): Control | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "not an object" };

  const envelope = parsed as Partial<Envelope> & { dir?: string; payload?: unknown };
  // The direction is checked, not assumed. An event-shaped message arriving as control is
  // rejected here rather than being coerced into a command.
  if (envelope.dir !== "client→orchestrator") {
    return { error: `wrong direction: expected 'client→orchestrator', got '${String(envelope.dir)}'` };
  }
  if (envelope.protocol !== PROTOCOL_VERSION) {
    return { error: `protocol mismatch: expected ${PROTOCOL_VERSION}, got ${String(envelope.protocol)}` };
  }
  const payload = envelope.payload as Control | undefined;
  if (typeof payload !== "object" || payload === null || typeof (payload as Control).kind !== "string") {
    return { error: "payload has no kind" };
  }
  return payload;
}

export class Transport {
  #supervisor: Supervisor;
  #config: Config;
  /**
   * The resolved options, with the discovery seam kept OUT: it has its own field, because it is a function to
   * call rather than a value to read, and folding it in here would make `Required<…>` promise a non-null one.
   */
  #options: Required<Omit<TransportOptions, "discoverSessions" | "keychainCheck">>;
  #server: Server | undefined;
  #wss: WebSocketServer | undefined;
  #clients = new Set<WebSocket>();
  #address: TransportAddress | undefined;
  #install: Omit<InstallFacts, "keychain"> | undefined;
  #discover: typeof discover;
  #keychainCheck: () => KeychainCheck | undefined;

  constructor(supervisor: Supervisor, config: Config, options: TransportOptions = {}) {
    this.#supervisor = supervisor;
    this.#config = config;
    this.#options = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      maxClients: options.maxClients ?? 8,
      uiDir: options.uiDir === undefined ? resolveUiDistDir() : options.uiDir,
    };
    this.#discover = options.discoverSessions ?? discover;
    this.#keychainCheck = options.keychainCheck ?? (() => undefined);
  }

  get address(): TransportAddress | undefined {
    return this.#address;
  }

  /** The UI directory being served, or `null` when the socket is the only surface. */
  get uiDir(): string | null {
    return this.#options.uiDir;
  }

  /** Bind and start serving. Resolves with the actual address (port 0 → a real port). */
  async listen(): Promise<TransportAddress> {
    if (this.#server) throw new Error("transport is already listening");

    // One listener, two protocols. `/ws` upgrades to the socket; every other path is the built
    // UI. Serving both from one origin is what makes `connect-src 'self'` in the CSP truthful
    // rather than aspirational (ADR-0006), and it means the dashboard needs no dev server.
    //
    // The UI directory may legitimately not exist (nothing built yet). That is not a startup
    // failure — the socket is still useful, and a CLI smoke run should not require a UI build —
    // so the handler reports the missing build per request, naming the fix, and the entry point
    // prints the same fact once at startup.
    const uiHandler = this.#options.uiDir === null ? undefined : createUiRequestHandler({ root: this.#options.uiDir });

    const server = createServer((req, res) => {
      if (uiHandler) {
        uiHandler(req, res);
        return;
      }
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("Pi Central speaks WebSocket only, and no UI directory is configured.\n");
    });

    const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 * 1024 });
    this.#server = server;
    this.#wss = wss;

    wss.on("connection", (socket) => this.#onConnection(socket));

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port, this.#options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("unexpected server address");
    this.#address = {
      host: this.#options.host,
      port: addr.port,
      url: `ws://${this.#options.host}:${addr.port}`,
    };
    return this.#address;
  }

  #onConnection(socket: WebSocket): void {
    if (this.#clients.size >= this.#options.maxClients) {
      // Say why. A silent close looks like a network fault.
      this.#send(socket, { kind: "error", message: `too many clients (max ${this.#options.maxClients})` });
      socket.close(1013, "too many clients");
      return;
    }
    this.#clients.add(socket);

    // On connect, the client needs the whole picture: what is live, and what is on disk.
    // Sent as one snapshot rather than two events so a client never renders a half-state.
    this.#send(socket, { kind: "hello", protocol: PROTOCOL_VERSION });
    void this.#sendSnapshot(socket);

    socket.on("message", (data) => void this.#onMessage(socket, String(data)));
    socket.on("close", () => this.#clients.delete(socket));
    socket.on("error", () => this.#clients.delete(socket));
  }

  /**
   * Facts about this installation, for the Settings surface (issue #58).
   *
   * Computed once and cached: `findOwnPackage` walks the directory tree, and this is sent on every
   * connection. The version cannot change while the process runs, so recomputing it per connection
   * would be work done to produce a value already known to be identical.
   *
   * The keychain facts are NOT cached with the rest, and the reason is the same one that applies to `ui`: they
   * are established by the launch rather than by the build, so freezing them into the cached facts would keep
   * `undefined` for the life of the process if the first snapshot was built before the probe answered (issue
   * #269).
   */
  #installFacts(): Omit<InstallFacts, "keychain"> {
    if (this.#install !== undefined) return this.#install;
    const own = findOwnPackage();
    this.#install = {
      // "unknown" rather than a substituted "0.0.0": a version that cannot be determined is a
      // packaging fault, and saying so is truthful. A plausible-looking default would be believed,
      // and every question asked afterwards would start from a false premise.
      version: own?.version ?? "unknown",
      sessionsRoot: this.#config.sessionsRoot,
      workspaceRoot: this.#config.workspaceRoot,
      agentRoot: this.#config.agentRoot,
      agentRootManaged: this.#config.agentRootManaged,
      protocol: PROTOCOL_VERSION,
      // Only when the capability is offered: a machine with no browser is told nothing, rather than shown a switch that
      // would fail. `browserExists` is re-stated here because it is what the switch's own note explains.
      ...(this.#config.sidecarOffered === true
        ? { sidecar: { browser: this.#config.browser, browserExists: existsSync(this.#config.browser) } }
        : {}),
    };
    return this.#install;
  }

  /**
   * The install facts for ONE snapshot, with the served-UI identity read live (issue #184).
   *
   * `#installFacts` is cached because a package walk cannot change under a running process; the UI
   * directory CAN — a dev `vite build` replaces it while the orchestrator runs, and reading it is
   * one small file — so `ui` is resolved per snapshot rather than frozen into the cached facts. A
   * stale `ui` here would be the one value issue #184 exists for, reported wrong.
   */
  #snapshotInstallFacts(): InstallFacts {
    const keychain = this.#keychainFacts();
    const facts: InstallFacts = keychain === undefined ? this.#installFacts() : { ...this.#installFacts(), keychain };
    if (this.#options.uiDir === null) return facts;
    const ui = servedUiIdentity(this.#options.uiDir);
    return ui === undefined ? facts : { ...facts, ui };
  }

  /**
   * The launch's keychain state, in the shape the wire carries — or `undefined` when there is none to report.
   *
   * Three absences, and they are kept apart because they mean different things:
   *
   *   - **nothing was established** — either the orchestrator never asked, or the entry point did not pass a
   *     source. Reported as nothing at all: a fabricated `unlocked` would be a claim nothing verified.
   *   - **nothing needed asking** — no provider key is resolved by a command (C13). Reported as `needed: false`
   *     with no lock state, because "nobody asked" and "asked, and it is open" are different facts.
   *   - **asked and answered** — reported as found, including `unknown`, which a broken probe produces and which
   *     must not be dressed up as healthy.
   */
  #keychainFacts(): InstallFacts["keychain"] {
    const check = this.#keychainCheck();
    if (check === undefined) return undefined;
    if (!check.needed) {
      return {
        path: this.#config.agentRoot,
        state: "unknown",
        detail: "no provider key is resolved by a command, so no keychain was read",
        needed: false,
      };
    }
    if (check.report === undefined) {
      return {
        path: this.#config.agentRoot,
        state: "unknown",
        detail: "the keychain probe produced no answer",
        needed: true,
      };
    }
    return { path: check.report.path, state: check.report.state, detail: check.report.detail, needed: true };
  }

  async #sendSnapshot(socket: WebSocket): Promise<void> {
    let history: HistoricalSession[] = [];
    let historyTotal = 0;
    try {
      const discovered = await this.#discover(this.#config);
      history = discovered.sessions;
      historyTotal = discovered.total;
    } catch (error) {
      // Discovery reads the real session store, which can be absent or unreadable. A
      // snapshot with no history is still useful; failing the whole connection is not.
      this.#send(socket, { kind: "error", message: `discovery failed: ${(error as Error).message}` });
    }
    this.#send(socket, {
      kind: "snapshot",
      live: this.#supervisor.list(),
      history,
      historyTotal,
      home: this.#config.home,
      installationRoot: this.#config.installationRoot,
      install: this.#snapshotInstallFacts(),
      // Absent when the installation does not offer one, and absent is what an older orchestrator sends too.
      ...(this.#config.sidecarOffered === true ? { sidecarOffered: true } : {}),
      ...(this.#config.sidecar === true ? { sidecarDefault: true } : {}),
    });

    // Then the CURRENT conversation for each live session, FETCHED rather than replayed.
    //
    // The `transcript` event fires once when a session starts, so a client that connects later —
    // after a browser reload, say — receives none of it. An earlier version replayed a copy cached
    // at session start; for a session started fresh that copy held its opening, empty state, so a
    // reload REPLACED a correct transcript with an empty one and the session appeared to load
    // forever. Re-fetching is the only way to be current.
    for (const session of this.#supervisor.list()) {
      if (session.state === "stopped" || session.state === "failed") continue;
      void this.#sendTranscript(socket, session.id);
    }
  }

  /** Fetch one session's conversation for one client, and report failure as a failure. */
  async #sendTranscript(socket: WebSocket, sessionId: string): Promise<void> {
    const result = await this.#supervisor.fetchTranscript(sessionId);
    if (!result.ok) {
      this.#send(socket, { kind: "transcriptError", sessionId, message: result.message });
      return;
    }
    this.#send(socket, { kind: "transcript", sessionId, messages: result.messages });
  }

  async #onMessage(socket: WebSocket, raw: string): Promise<void> {
    const control = parseControl(raw);
    if ("error" in control) {
      this.#send(socket, { kind: "error", message: `bad control: ${control.error}` });
      return;
    }

    // TypeScript makes the switch below exhaustive over `Control`, but that guarantee is
    // compile-time only: an unknown `kind` from a newer client would reach the end of the
    // switch and do NOTHING. Silence looks like a broken button, so it is checked at runtime
    // too. (Found by a test: this case originally fell through and hung the client.)
    if (!KNOWN_CONTROL_KINDS.has(control.kind)) {
      this.#send(socket, { kind: "error", message: `bad control: unknown kind '${control.kind}'` });
      return;
    }

    try {
      await this.#dispatch(socket, control);
    } catch (error) {
      this.#send(socket, { kind: "error", message: (error as Error).message });
    }
  }

  /**
   * Route one control message.
   *
   * The switch is exhaustive over `Control`, so adding a command to the protocol without
   * handling it here is a compile error rather than a silent no-op.
   *
   * `socket` is the ASKER, and it is threaded through for the two controls whose answer is per client rather than
   * per process (issue #285): a preference read or write must reply to the page that asked, because two surfaces can
   * legitimately hold different preferences at the same moment. Every other kind reaches every client through
   * `#broadcast`, which is the same shape the snapshot already had.
   */
  async #dispatch(socket: WebSocket, control: Control): Promise<void> {
    switch (control.kind) {
      case "list": {
        const discovered = await this.#discover(this.#config);
        this.#broadcast({ kind: "history", history: discovered.sessions, total: discovered.total });
        this.#broadcast({
          kind: "snapshot",
          live: this.#supervisor.list(),
          history: discovered.sessions,
          historyTotal: discovered.total,
          home: this.#config.home,
          installationRoot: this.#config.installationRoot,
          // `install` here as well as on the connect snapshot (issue #184): a page that never
          // reconnects still learns the orchestrator was replaced the next time it lists, rather
          // than only when the socket happens to drop.
          install: this.#snapshotInstallFacts(),
        });
        return;
      }
      case "install": {
        /*
         * The cheap question (issue #220).
         *
         * `install` states the facts about this installation and nothing else — deliberately no discovery, no
         * supervisor listing, no transcript fetch. It exists because the alternative was `list`, which re-runs
         * `discover()` over the whole store, and a page returning to view asks this on EVERY focus. Measured: a
         * median of 329 ms of filesystem work per alt-tab, on 886 sessions, and it grows with the store.
         *
         * Broadcast rather than sent to the asker: the answer is a fact about the process, identical for every
         * client, and a listener that happens to be watching the same installation benefits from the same answer.
         * The alternative — echoing to one socket — would make the served-UI identity a per-client value, which
         * it is not.
         */
        this.#broadcast({ kind: "installFacts", install: this.#snapshotInstallFacts() });
        return;
      }
      /*
       * The reader's preferences (issue #285).
       *
       * ## Why they are here rather than in the page
       *
       * `localStorage` is partitioned per origin, and the shell launches this process with `--port 0`, so the origin
       * changes on every launch and every preference was written to a bucket the next launch never read. This process
       * is the one thing whose identity does not depend on the port.
       *
       * ## Why the answer is sent to the asker only
       *
       * The state is per reader, unlike `installFacts` — two surfaces can legitimately hold different preferences
       * (a page that has not written yet, a second window mid-drag), and broadcasting one client's map to another
       * would overwrite a value the other had just changed. So this is a reply, not an announcement.
       */
      case "getPrefs": {
        const stored = readPrefs(this.#config.stateRoot);
        if (!stored.ok) {
          this.#send(socket, { kind: "prefsError", reason: stored.reason, message: stored.message });
          return;
        }
        this.#send(socket, { kind: "prefs", prefs: stored.prefs });
        return;
      }
      case "setPrefs": {
        /*
         * Stored, then answered with what was actually kept.
         *
         * The reply carries the ACCEPTED map rather than an acknowledgement, because the two can differ: this store
         * drops a key it will not keep, and a client that assumed its whole map was written would be wrong about
         * what the next launch will show. Echoing the accepted set makes that difference visible in the protocol
         * instead of leaving it to be discovered.
         */
        const { prefs, dropped } = acceptPrefs(control.prefs);
        if (dropped.length > 0) {
          console.error(`preferences: ${dropped.length} key(s) not stored: ${dropped.join(", ")}`);
        }
        const written = writePrefs(this.#config.stateRoot, prefs);
        if (!written.ok) {
          // Reported as a failure and NOT as an empty map: the reader's settings are still on this page, and saying
          // "nothing is stored" would invite the next write to replace whatever is actually there.
          this.#send(socket, { kind: "prefsError", reason: "unreadable", message: written.message });
          return;
        }
        this.#send(socket, { kind: "prefs", prefs });
        return;
      }
      case "start": {
        const result = await this.#supervisor.start({
          ...(control.cwd ? { cwd: control.cwd } : {}),
          ...(control.name ? { name: control.name } : {}),
          ...(control.mode ? { mode: control.mode } : {}),
          // Validated where it is used, not here: start() returns a structured failure, and a bad port reads better
          // as a message beside the session than as a dropped control message.
          ...(control.sidecarPort === undefined ? {} : { sidecarPort: control.sidecarPort }),
          ...(control.sidecar === undefined ? {} : { sidecar: control.sidecar }),
        });
        if (!result.ok) {
          this.#broadcast({ kind: "error", message: result.message });
          return;
        }
        this.#broadcast({ kind: "session", session: result.session });
        return;
      }
      case "resume": {
        /*
         * Look the file up DIRECTLY, not through `discover` (bug fixed here).
         *
         * This used to be `const discovered = await discover(config); discovered.sessions.find(...)`, and
         * `discover` returns `sessions.slice(0, 500)` — so on a machine with 867 sessions, resuming anything
         * older than the newest 500 reported "no such session" for a file that exists. The error named the
         * wrong cause, which is why it read as a mystery rather than as a limit.
         *
         * `sessionAt` reads one header instead of walking the store, so resume is also O(1) rather than
         * O(everything) — the eager-work problem from #150, which was being paid on a click.
         */
        const target = await sessionAt(this.#config, control.path);
        if (!target) {
          /*
           * An unresolvable path is REFUSED only when no live session holds it.
           *
           * Pi reports `sessionFile` from `get_state` — the path it will write — and creates the file lazily, on the
           * first message. A session stopped before it was ever prompted therefore has a rail entry whose file does not
           * exist, and `sessionAt` correctly returns nothing for it. `no such session` reads as data loss for a session
           * the reader had just deliberately stopped: *"when i want to resume a session i have just stoppend, i get an
           * error"*.
           *
           * The supervisor's `resume` already draws the distinction — it withholds `--session` when there is no
           * transcript and starts fresh in the recorded directory — so this only has to stop refusing before that.
           * The entry is reconstructed from the live session, which is where the cwd and mode still are.
           */
          // `entryByFile`, NOT `listedByFile`: the latter excludes `stopped`, which is exactly the state being resumed.
          const owner = this.#supervisor.entryByFile(control.path);
          if (owner === undefined) {
            this.#broadcast({
              kind: "error",
              message: `no such session: ${control.path}. Its transcript is not on disk, and no running session holds it.`,
            });
            return;
          }
          /*
           * A minimal `HistoricalSession`: `resume` reads `path` and `cwd`, and the rest describe the transcript that
           * does not exist. Filling them with zeros would be inventing facts, so they are stated as what they are —
           * nothing yet — and the supervisor's own `checkResumable` decides the directory's fate.
           */
          const resumed = await this.#supervisor.resume(
            {
              path: control.path,
              cwd: owner.cwd,
              id: owner.sessionId ?? owner.id,
              created: "",
              modifiedMs: 0,
              bytes: 0,
              messageCount: 0,
              firstMessage: "",
              cwdExists: true,
              scratch: owner.scratch,
            },
            {
              ...(control.mode ? { mode: control.mode } : {}),
              ...(control.sidecar === undefined ? {} : { sidecar: control.sidecar }),
            },
          );
          if (!resumed.ok) {
            this.#broadcast({ kind: "error", message: resumed.message });
            return;
          }
          this.#broadcast({ kind: "session", session: resumed.session });
          return;
        }
        const result = await this.#supervisor.resume(target, {
          ...(control.mode ? { mode: control.mode } : {}),
          ...(control.sidecar === undefined ? {} : { sidecar: control.sidecar }),
        });
        if (!result.ok) {
          this.#broadcast({ kind: "error", message: result.message });
          return;
        }
        this.#broadcast({ kind: "session", session: result.session });
        return;
      }
      case "retry": {
        /*
         * Re-spawn a failed session (issue #11).
         *
         * A dedicated control rather than stop-then-start: the reader wants THIS session to try again, and a
         * client-side sequence would leave the failed row beside its replacement. The failure is broadcast
         * like every other refusal — with the reason, never a silent no-op, because a button that does
         * nothing is indistinguishable from one that is broken.
         */
        const result = await this.#supervisor.retry(control.sessionId);
        if (!result.ok) {
          this.#broadcast({ kind: "error", message: result.message });
          return;
        }
        this.#broadcast({ kind: "session", session: result.session });
        return;
      }
      case "prompt": {
        /*
         * Images are validated HERE, before anything is forwarded.
         *
         * A refusal is reported to the client as an `error` event with a sentence the reader can act on, rather than
         * being dropped: a dropped image is a prompt the model answers as though nothing was attached, and "I don't see
         * any image" is an error message written by the model about a defect in this process.
         *
         * All-or-nothing: see `acceptImages`. A prompt missing one of its four screenshots is worse than one refused.
         */
        const accepted = acceptImages(control.images);
        if (!accepted.ok) {
          this.#broadcast({ kind: "error", message: `image refused: ${accepted.message}`, sessionId: control.sessionId });
          return;
        }
        /*
         * EXPLICIT arguments, never a positional spread.
         *
         * This was `...(control.behavior ? [control.behavior] : []), ...(images.length > 0 ? [images] : [])`, which is
         * correct only when every earlier optional argument is present. For an IDLE prompt — the normal case — `behavior`
         * is absent, the spread contributed nothing, and the images array shifted left into the `behavior` parameter.
         * `Supervisor#prompt` then received a media-type list where it expected "steer" or "followUp", put nothing in
         * Pi's `images`, and sent an empty message: the transcript showed an empty Assistant box and the prompt looked
         * like it had not been sent at all.
         *
         * Reported from use as "the preview did work, but when I click Enter, nothing happens." The spread looked tidy and
         * was silently positionally wrong, which is why the arguments are now named at the call site and the regression
         * test asserts their POSITIONS rather than merely that a third argument arrived.
         */
        await this.#supervisor.prompt(control.sessionId, control.message, control.behavior, accepted.images);
        return;
      }
      case "clearQueue": {
        await this.#supervisor.clearQueue(control.sessionId, control.andStop);
        return;
      }
      case "abort":
        await this.#supervisor.abort(control.sessionId);
        return;
      case "stop":
        await this.#supervisor.stop(control.sessionId);
        return;
      case "rename":
        await this.#supervisor.rename(control.sessionId, control.name);
        return;
      case "deleteSession": {
        /*
         * Refused for a LIVE session, before anything is touched (issue #150).
         *
         * The file is open and Pi will keep appending to it, so deleting underneath a running process would leave it
         * writing to an unlinked inode: the transcript the reader can still see would be gone from disk, and the
         * session would look alive until it next flushed. The reader must stop it first, and the refusal says so
         * rather than being a silent no-op.
         *
         * Keyed on the FILE, because that is what identifies the conversation — a resumed session has a different
         * handle but the same path.
         */
        const live = this.#supervisor.listedByFile(control.path);
        if (live !== undefined) {
          /*
           * The refusal must be ACTIONABLE, which the first version was not.
           *
           * Reported from use: "I get a warning, that I shall stop this session first. I dont see a session open with
           * that id though." The message named a handle (`s4`) and a condition, but not how to find the row — and the
           * session is easy to lose: it may be one of many in a collapsed group, or a session restored at startup that
           * the reader never opened.
           *
           * So the refusal names the session, its DIRECTORY (the thing that identifies the row in a list of ten), and
           * its state — because "still running" is wrong for an idle one, and the two need different actions.
           */
          const where = live.cwd === undefined ? "" : ` in ${live.cwd}`;
          this.#broadcast({
            kind: "error",
            message:
              `Cannot delete this transcript: it is open in the running session "${live.name}"${where} ` +
              `(${live.state}). Stop that session from the Sessions tab, then delete it — deleting it now would ` +
              `remove a file the process is still writing to.`,
            sessionId: live.id,
          });
          return;
        }
        const result = deleteSessionFile(this.#config, control.path);
        if (!result.ok) {
          // The failure names the OS reason, and the session stays visible because nothing was removed.
          this.#broadcast({ kind: "error", message: result.message });
          return;
        }
        /*
         * The sidecar's own failure is a SEPARATE report even though the delete succeeded: silence there would leave
         * the store growing through sidecars while the reader believes the session is gone.
         */
        if (result.sidecarFailure !== undefined) {
          this.#broadcast({ kind: "error", message: result.sidecarFailure });
        }
        /*
         * TELL the clients what was deleted, before the store is re-described.
         *
         * `history` and `snapshot` say what exists now; neither can say what was removed, because a session that
         * scrolled out of the discovered page looks the same as a deleted one. The roster is `localStorage` and keeps
         * its own list, so it has to be told — otherwise the rail keeps a row whose transcript is gone, the reader
         * presses Delete again, and the second attempt fails on a file that no longer exists. Reported as: *"when
         * deleting a transcript, it is not removed from the rail"*.
         */
        /*
         * The supervisor FORGETS the session too, not just the file being unlinked.
         *
         * Its entry is a row for a file that no longer exists, and it would be re-broadcast in the snapshot below —
         * so the client's "every live session belongs in the roster" effect would put the row straight back, and the
         * deletion would not stick. Reported as: *"When I stop a session and click delete, they are still in the
         * roster."* Deleting is therefore forget-and-delete, as one act; the reader is not asked to do both.
         */
        await this.#supervisor.forgetFile(control.path);

        this.#broadcast({ kind: "deleted", path: control.path });

        // Then re-describe the store, so both the rail and History drop the row from one authoritative answer
        // rather than each removing it locally and possibly disagreeing.
        const after = await this.#discover(this.#config);
        this.#broadcast({ kind: "history", history: after.sessions, total: after.total });
        this.#broadcast({
          kind: "snapshot",
          live: this.#supervisor.list(),
          history: after.sessions,
          historyTotal: after.total,
          home: this.#config.home,
          installationRoot: this.#config.installationRoot,
          install: this.#snapshotInstallFacts(),
        });
        return;
      }
      case "listModels": {
        const result = await this.#supervisor.listModels(control.sessionId);
        // "empty" and "failed" are different events: an empty picker would claim the session has
        // no models when the truth is that the question failed. This is the same distinction
        // `transcriptError` exists for.
        if (result.ok) this.#broadcast({ kind: "models", sessionId: control.sessionId, models: result.models });
        else this.#broadcast({ kind: "modelsError", sessionId: control.sessionId, message: result.message });
        return;
      }
      case "setModel": {
        // Not caught here: `#dispatch` reports a throw as an error event, which is what a refusal
        // from Pi must become — a visible reason, never a silent no-op.
        await this.#supervisor.setModel(control.sessionId, control.provider, control.modelId);
        return;
      }
      case "listThinkingLevels": {
        const result = await this.#supervisor.listThinkingLevels(control.sessionId);
        if (result.ok) this.#broadcast({ kind: "thinkingLevels", sessionId: control.sessionId, levels: result.levels });
        else this.#broadcast({ kind: "thinkingLevelsError", sessionId: control.sessionId, message: result.message });
        return;
      }
      case "setThinkingLevel":
        await this.#supervisor.setThinkingLevel(control.sessionId, control.level);
        return;
      case "compact":
        /*
         * Not caught here, for the same reason as `setModel`: `#dispatch` reports a throw as an `error` event, and
         * that is exactly what a refusal from Pi (nothing to compact, a provider that will not summarize) or from
         * the supervisor (no live process, a compaction already running) must become. A swallowed refusal would be
         * a button that appears to work.
         */
        await this.#supervisor.compact(control.sessionId);
        return;
      case "reload":
        /*
         * Not caught here, for the same reason as `compact`: `#dispatch` reports a throw as an `error` event, and a
         * refusal — Pi's own "wait for the current response to finish", a session with no process, a second reload,
         * or Pi taking the command as a prompt because the extension is not loaded — must arrive as a visible
         * sentence. A reload that appeared to work and changed nothing is the failure the issue forbids.
         */
        await this.#supervisor.reload(control.sessionId, {
          ...(control.interrupt === undefined ? {} : { interrupt: control.interrupt }),
        });
        return;
      case "toolset": {
        /*
         * Answered as a RESULT rather than by throwing, because "I could not establish the toolset" and "I established
         * that it is unchanged" are different claims and only one of them is a failure: `toolsetError` says the
         * question could not be asked at all, while `unknown` freshness is an ANSWER that says what could not be
         * seen. Collapsing them is the fabricated-clean-result failure C14 describes for a transcript.
         */
        try {
          this.#broadcast({ kind: "toolset", sessionId: control.sessionId, status: this.#supervisor.toolset(control.sessionId) });
        } catch (error) {
          this.#broadcast({ kind: "toolsetError", sessionId: control.sessionId, message: (error as Error).message });
        }
        return;
      }
      case "answerDialog":
        this.#supervisor.answerDialog(control.sessionId, control.dialogId, control.answer);
        return;
      // --- File browsing (issue #8, ADR-0007) ------------------------------------------------
      //
      // Resolved through the SUPERVISOR, not straight to `files.ts`, because the root is the
      // session's cwd and only the supervisor knows it. That keeps one answer to "which directory is
      // this session confined to" — and it means a request for an unknown session is refused as
      // such, rather than being resolved against some path the transport guessed.
      //
      // Everything below is read at the ORCHESTRATOR's UID, deliberately (ADR-0007). No sandbox is
      // involved: Safehouse confines agents, and this serves the person.
      // --- The directory chooser (issue #76, ADR-0012) -----------------------------------------
      //
      // A DIFFERENT capability from `listFiles`, and deliberately a different control (see
      // `Control.listPlaces`): the file tree is confined to a session's cwd, while this reads directories
      // that no session owns, restricted instead to the fixed places `placesFor` derives from `$HOME`.
      //
      // Both branches live here rather than in the supervisor, because there is no session involved — no
      // session id, no cwd, nothing for the supervisor's registry to look up. Putting it behind a method
      // that takes no session would be a supervisor that no longer answers only about sessions.
      case "listPlaces": {
        const places = placesFor(this.#config.home);
        if (control.path === undefined) {
          this.#broadcast({ kind: "places", places, home: this.#config.home });
          return;
        }
        const result = listPlace(places, control.path, {
          ...(control.includeHidden === undefined ? {} : { includeHidden: control.includeHidden }),
        });
        if (!result.ok) {
          /*
           * `not-found` and `unreadable` are kept apart, and the message is the orchestrator's (it carries
           * the errno). The path is echoed as SENT, for the reason `fileError` does: the complaint is about
           * what was asked for, and a resolved path would describe something the reader never chose.
           */
          this.#broadcast({
            kind: "placeError",
            path: control.path,
            reason: result.error.reason,
            ...(result.error.code === undefined ? {} : { code: result.error.code }),
            message: result.error.message,
          });
          return;
        }
        this.#broadcast({
          kind: "placeListing",
          path: control.path,
          listing: {
            path: result.value.path,
            abbreviated: abbreviate(result.value.path, this.#config.home),
            name: nameOf(result.value.path),
            ...(result.value.parent === undefined ? {} : { parent: result.value.parent }),
            entries: result.value.entries,
            truncated: result.value.truncated,
          },
        });
        return;
      }
      case "listFiles": {
        const result = this.#supervisor.listFiles(control.sessionId, control.path, {
          ...(control.includeHidden === undefined ? {} : { includeHidden: control.includeHidden }),
        });
        if (result.ok) {
          this.#broadcast({
            kind: "files",
            sessionId: control.sessionId,
            // The path as the CLIENT sent it, not the normalized one the orchestrator resolved.
            // The client keys its cache, its `loading` state and its expansion flag by the path it
            // requested, so echoing a different spelling would file the result under one key while
            // the node waited on another — leaving it in "Reading…" forever. Normalization stays
            // inside the orchestrator, where it is used for the filesystem work and for messages.
            path: control.path,
            entries: result.value.entries,
            truncated: result.value.truncated,
          });
        } else {
          this.#broadcastFileError(control.sessionId, control.path, "list", result.error);
        }
        return;
      }
      case "readFile": {
        const result = this.#supervisor.readFile(control.sessionId, control.path);
        if (result.ok) {
          this.#broadcast({
            kind: "file",
            sessionId: control.sessionId,
            // As sent, for the same reason as `files`: one key for the client's bookkeeping.
            path: control.path,
            bytes: result.value.bytes,
            content:
              result.value.kind === "image"
                ? { kind: "image", type: result.value.type, base64: result.value.data.toString("base64") }
                : { kind: "text", text: result.value.text },
          });
        } else {
          this.#broadcastFileError(control.sessionId, control.path, "read", result.error);
        }
        return;
      }
      case "reveal": {
        /*
         * A refusal is decided before the spawn and reported here; a SUCCESS reports nothing.
         *
         * That asymmetry is ADR-0014 rule 6, not an omission: `open` returns 0 once `launchd` has accepted
         * the request, which is not evidence that Finder displayed anything. So there is no success event to
         * send, and inventing one would be the app claiming an outcome it cannot see. What the client may
         * state is a refusal it produced, and a refusal can also arrive LATER (the binary is missing, or it
         * exits non-zero), which is why the callback broadcasts rather than returning.
         *
         * `path` is echoed as the client SENT it, for the same reason `readFile` does: the client keys its
         * per-row note by the path it asked for, and a resolved spelling would file the refusal under a key
         * no row is watching.
         */
        const result = this.#supervisor.reveal(control.sessionId, control.path, {
          onLaunchError: (error) => {
            this.#broadcastOsActionError("reveal", control.sessionId, control.path, error);
          },
        });
        if (!result.ok) {
          this.#broadcastOsActionError("reveal", control.sessionId, control.path, result.error);
        }
        return;
      }
    }
  }

  /**
   * Report a refused file request.
   *
   * `path` is echoed as the client SENT it, not as it resolved — the complaint is about what was
   * asked for, and a resolved path would describe something the user never typed.
   *
   * `request` distinguishes a failed listing from a failed read, so the client routes the error to the
   * right cache instead of guessing which request it answered.
   */
  #broadcastFileError(
    sessionId: string,
    path: string,
    request: "list" | "read",
    error: FileError,
  ): void {
    this.#broadcast({
      kind: "fileError",
      request,
      sessionId,
      path,
      reason: error.reason,
      ...(error.code === undefined ? {} : { code: error.code }),
      message: error.message,
    });
  }

  /**
   * Report a refused OS action (ADR-0014).
   *
   * A separate event from `fileError` because it belongs to no cache: it states that an attempt was refused,
   * not that something is known about a path. `path` is echoed as the client sent it, so the refusal is filed
   * under the row that asked.
   */
  #broadcastOsActionError(
    action: OsActionKind,
    sessionId: string,
    path: string,
    error: OsActionError,
  ): void {
    this.#broadcast({
      kind: "osActionError",
      action,
      sessionId,
      path,
      reason: error.reason,
      ...(error.code === undefined ? {} : { code: error.code }),
      message: error.message,
    });
  }

  /**
   * Fan out to every client. One slow client must not stall the others.
   *
   * Takes `ServerPayload` rather than `Event` since issue #285: `prefs` IS an `Event`, so nothing widened — but
   * the signature now says what the function does (send whatever a client may receive), which is the distinction
   * that keeps a per-client reply from being written as a broadcast by mistake.
   */
  #broadcast(event: ServerPayload): void {
    for (const socket of this.#clients) this.#send(socket, event);
  }

  #send(socket: WebSocket, event: ServerPayload): void {
    if (socket.readyState !== socket.OPEN) return;
    const envelope = { dir: "orchestrator→client", protocol: PROTOCOL_VERSION, payload: event };
    socket.send(JSON.stringify(envelope));
  }

  /**
   * Forward supervisor events to clients.
   *
   * Called by the entry point after construction, because it wires the supervisor's
   * `EventEmitter` to the socket. Kept out of the constructor so a test can build a
   * transport without an emitting supervisor.
   */
  attach(): void {
    this.#supervisor.on("update", (session: LiveSession) => {
      this.#broadcast({ kind: "session", session });
    });
    this.#supervisor.on("record", (sessionId: string, record: PiRecord) => {
      this.#broadcast({ kind: "record", sessionId, record });
    });
    // Replayed history, kept distinct from the live stream (see the `transcript` event).
    this.#supervisor.on("transcript", (sessionId: string, messages: unknown[]) => {
      this.#broadcast({ kind: "transcript", sessionId, messages });
    });
    this.#supervisor.on("transcriptError", (sessionId: string, message: string) => {
      this.#broadcast({ kind: "transcriptError", sessionId, message });
    });
    // The queue's TEXTS (issue #3). `LiveSession.pending` carries the count on every update;
    // this carries what is IN the queue, which is what the composer shows and what the user is
    // told will happen.
    this.#supervisor.on("queue", (sessionId: string, steering: string[], followUp: string[]) => {
      this.#broadcast({ kind: "queue", sessionId, steering, followUp });
    });    this.#supervisor.on(
      "queueCleared",
      (sessionId: string, steering: string[], followUp: string[]) => {
        this.#broadcast({ kind: "queueCleared", sessionId, steering, followUp });
      },
    );
    this.#supervisor.on("error", (sessionId: string, message: string) => {
      this.#broadcast({ kind: "error", message, sessionId });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.#clients) socket.close(1001, "server shutting down");
    this.#clients.clear();
    const wss = this.#wss;
    const server = this.#server;
    this.#wss = undefined;
    this.#server = undefined;
    this.#address = undefined;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
