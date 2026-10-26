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
  type PiRecord,
  type ServerPayload,
} from "@pi-central/protocol";
import { findOwnPackage } from "./package-meta.ts";
import type { Supervisor } from "./supervisor.ts";
import type { FileError } from "./files.ts";
import { discover } from "./registry.ts";
import type { Config } from "./config.ts";
import { createUiRequestHandler, resolveUiDistDir } from "./static-ui.ts";

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
}

export interface TransportAddress {
  host: string;
  port: number;
  url: string;
}

/** Every control kind the orchestrator understands, for the runtime check in `#onMessage`. */
const KNOWN_CONTROL_KINDS: ReadonlySet<string> = new Set<Control["kind"]>([
  "list",
  "start",
  "prompt",
  "clearQueue",
  "abort",
  "stop",
  "rename",
  "setModel",
  "listModels",
  "setThinkingLevel",
  "listThinkingLevels",
  "answerDialog",
  "resume",
  "listFiles",
  "readFile",
]);

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
  #options: Required<TransportOptions>;
  #server: Server | undefined;
  #wss: WebSocketServer | undefined;
  #clients = new Set<WebSocket>();
  #address: TransportAddress | undefined;
  #install: InstallFacts | undefined;

  constructor(supervisor: Supervisor, config: Config, options: TransportOptions = {}) {
    this.#supervisor = supervisor;
    this.#config = config;
    this.#options = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      maxClients: options.maxClients ?? 8,
      uiDir: options.uiDir === undefined ? resolveUiDistDir() : options.uiDir,
    };
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
   */
  #installFacts(): InstallFacts {
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
    };
    return this.#install;
  }

  async #sendSnapshot(socket: WebSocket): Promise<void> {
    let history: HistoricalSession[] = [];
    let historyTotal = 0;
    try {
      const discovered = await discover(this.#config);
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
      install: this.#installFacts(),
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
      await this.#dispatch(control);
    } catch (error) {
      this.#send(socket, { kind: "error", message: (error as Error).message });
    }
  }

  /**
   * Route one control message.
   *
   * The switch is exhaustive over `Control`, so adding a command to the protocol without
   * handling it here is a compile error rather than a silent no-op.
   */
  async #dispatch(control: Control): Promise<void> {
    switch (control.kind) {
      case "list": {
        const discovered = await discover(this.#config);
        this.#broadcast({ kind: "history", history: discovered.sessions, total: discovered.total });
        this.#broadcast({
          kind: "snapshot",
          live: this.#supervisor.list(),
          history: discovered.sessions,
          historyTotal: discovered.total,
          home: this.#config.home,
          installationRoot: this.#config.installationRoot,
        });
        return;
      }
      case "start": {
        const result = this.#supervisor.start({
          ...(control.cwd ? { cwd: control.cwd } : {}),
          ...(control.name ? { name: control.name } : {}),
          ...(control.mode ? { mode: control.mode } : {}),
        });
        if (!result.ok) {
          this.#broadcast({ kind: "error", message: result.message });
          return;
        }
        this.#broadcast({ kind: "session", session: result.session });
        return;
      }
      case "resume": {
        const discovered = await discover(this.#config);
        const target = discovered.sessions.find((s) => s.path === control.path);
        if (!target) {
          this.#broadcast({ kind: "error", message: `no such session: ${control.path}` });
          return;
        }
        const result = this.#supervisor.resume(target, control.mode ? { mode: control.mode } : {});
        if (!result.ok) {
          this.#broadcast({ kind: "error", message: result.message });
          return;
        }
        this.#broadcast({ kind: "session", session: result.session });
        return;
      }
      case "prompt":
        // `behavior` is forwarded only when the client chose one; the supervisor decides what a
        // missing choice means (see `Supervisor#prompt`).
        await this.#supervisor.prompt(
          control.sessionId,
          control.message,
          ...(control.behavior ? [control.behavior] : []),
        );
        return;
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
            text: result.value.text,
            bytes: result.value.bytes,
          });
        } else {
          this.#broadcastFileError(control.sessionId, control.path, "read", result.error);
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

  /** Fan out to every client. One slow client must not stall the others. */
  #broadcast(event: Event): void {
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
