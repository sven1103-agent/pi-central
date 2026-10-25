/**
 * The UI's connection to the orchestrator.
 *
 * A thin, reconnecting client over the typed envelopes in `@pi-central/protocol`. It holds
 * **no derived state**: it receives, and hands events to a listener. Everything the UI shows
 * is computed from those events by `store.ts`, so the wire format stays the only contract and
 * a protocol change cannot silently diverge from a cached copy here.
 *
 * Reconnection is deliberate about one thing: a reconnect produces a fresh `snapshot`, which
 * is authoritative and replaces what the client believed. Merging instead would risk showing
 * a session as live after the orchestrator had stopped it — the one lie the UI must not tell,
 * because a live-looking session that is actually dead would swallow a prompt.
 */
import {
  PROTOCOL_VERSION,
  type Control,
  type Envelope,
  type Event,
  type ServerPayload,
} from "@pi-central/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface ConnectionHandlers {
  onEvent: (event: Event) => void;
  onStatus: (status: ConnectionStatus, detail?: string) => void;
}

/** Backoff schedule in ms. Bounded, because a local orchestrator restarts in seconds. */
const BACKOFF_MS = [500, 1000, 2000, 3000, 5000];

export class Connection {
  #socket: WebSocket | undefined;
  #handlers: ConnectionHandlers;
  #url: string;
  #attempt = 0;
  #closedByUs = false;
  #status: ConnectionStatus = "connecting";
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(url: string, handlers: ConnectionHandlers) {
    this.#url = url;
    this.#handlers = handlers;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  connect(): void {
    this.#closedByUs = false;
    this.#open();
  }

  #open(): void {
    this.#setStatus("connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#url);
    } catch (error) {
      // A malformed URL throws synchronously and retrying will not help.
      this.#setStatus("closed", (error as Error).message);
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#setStatus("open");
    };

    socket.onmessage = (message) => {
      let payload: ServerPayload;
      try {
        payload = (JSON.parse(String(message.data)) as Envelope & { payload: ServerPayload }).payload;
      } catch {
        // A frame we cannot parse is a bug or a version mismatch, not a session event. Report
        // it rather than dropping it, so it is visible in the UI.
        this.#handlers.onEvent({ kind: "error", message: "received a malformed frame from the orchestrator" });
        return;
      }
      if (payload.kind === "hello") {
        if (payload.protocol !== PROTOCOL_VERSION) {
          this.#handlers.onEvent({
            kind: "error",
            message:
              `protocol mismatch: the orchestrator speaks v${payload.protocol} and this UI speaks ` +
              `v${PROTOCOL_VERSION}. Reload the UI; if that fails, restart the orchestrator.`,
          });
        }
        return;
      }
      this.#handlers.onEvent(payload);
    };

    socket.onerror = () => {
      // `error` carries nothing useful in browsers; the `close` handler reports the reason.
    };

    socket.onclose = () => {
      this.#socket = undefined;
      if (this.#closedByUs) {
        this.#setStatus("closed");
        return;
      }
      const wait = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)]!;
      this.#attempt += 1;
      this.#setStatus("closed", `reconnecting in ${(wait / 1000).toFixed(1)}s`);
      this.#timer = setTimeout(() => this.#open(), wait);
    };
  }

  #setStatus(status: ConnectionStatus, detail?: string): void {
    this.#status = status;
    this.#handlers.onStatus(status, detail);
  }

  /** Send a control message. Returns false when not connected, so the caller can say so. */
  send(control: Control): boolean {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    const envelope: Envelope = {
      dir: "client→orchestrator",
      protocol: PROTOCOL_VERSION,
      payload: control,
    };
    this.#socket.send(JSON.stringify(envelope));
    return true;
  }

  disconnect(): void {
    this.#closedByUs = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#socket?.close(1000, "client disconnected");
    this.#socket = undefined;
  }
}

/**
 * Where the socket lives.
 *
 * Same-origin `/ws` by default, so ADR-0006's `connect-src 'self'` CSP is truthful. A direct
 * `ws://127.0.0.1:<port>` would require widening that directive, which is why the dev server
 * proxies instead (see `vite.config.ts`).
 */
export function socketUrl(): string {
  const override = import.meta.env["VITE_PI_CENTRAL_WS"];
  if (typeof override === "string" && override.length > 0) return override;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}
