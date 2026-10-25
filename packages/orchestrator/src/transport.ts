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
  type LiveSession,
  type PiRecord,
  type ServerPayload,
} from "@pi-central/protocol";
import type { Supervisor } from "./supervisor.ts";
import { discover } from "./registry.ts";
import type { Config } from "./config.ts";

export interface TransportOptions {
  host?: string;
  port?: number;
  /** Cap concurrent clients. Loopback is reachable by any local process (C5). */
  maxClients?: number;
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
  "abort",
  "stop",
  "rename",
  "answerDialog",
  "resume",
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

  constructor(supervisor: Supervisor, config: Config, options: TransportOptions = {}) {
    this.#supervisor = supervisor;
    this.#config = config;
    this.#options = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      maxClients: options.maxClients ?? 8,
    };
  }

  get address(): TransportAddress | undefined {
    return this.#address;
  }

  /** Bind and start serving. Resolves with the actual address (port 0 → a real port). */
  async listen(): Promise<TransportAddress> {
    if (this.#server) throw new Error("transport is already listening");

    // No HTTP routes: the UI is served by Vite in development and from disk in production.
    // A bare server exists only to host the WebSocket upgrade.
    const server = createServer((_req, res) => {
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("Pi Central speaks WebSocket only.\n");
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

  async #sendSnapshot(socket: WebSocket): Promise<void> {
    let history: HistoricalSession[] = [];
    try {
      const discovered = await discover(this.#config);
      history = discovered.sessions as typeof history;
    } catch (error) {
      // Discovery reads the real session store, which can be absent or unreadable. A
      // snapshot with no history is still useful; failing the whole connection is not.
      this.#send(socket, { kind: "error", message: `discovery failed: ${(error as Error).message}` });
    }
    this.#send(socket, { kind: "snapshot", live: this.#supervisor.list(), history });
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
        this.#broadcast({ kind: "history", history: discovered.sessions });
        this.#broadcast({ kind: "snapshot", live: this.#supervisor.list(), history: discovered.sessions });
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
        await this.#supervisor.prompt(control.sessionId, control.message);
        return;
      case "abort":
        await this.#supervisor.abort(control.sessionId);
        return;
      case "stop":
        await this.#supervisor.stop(control.sessionId);
        return;
      case "rename":
        await this.#supervisor.rename(control.sessionId, control.name);
        return;
      case "answerDialog":
        this.#supervisor.answerDialog(control.sessionId, control.dialogId, control.answer);
        return;
    }
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
