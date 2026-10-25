/**
 * The orchestrator ↔ UI contract.
 *
 * Control and events travel on the same socket but have different trust levels
 * (docs/ARCHITECTURE.md): control is user intent (trusted), events carry model output
 * (untrusted). They are therefore distinguished **structurally**, by envelope type, not by
 * convention. A client cannot smuggle control by shaping an event payload.
 *
 * This package defines the shapes. The transport that carries them is Phase 2.
 */
import type { PiRecord } from "./pi.ts";

export type LiveState =
  | "registered"
  | "starting"
  | "idle"
  | "streaming"
  | "awaiting-approval"
  | "stopped"
  | "failed";

/**
 * A session Pi Central has discovered on disk. Untrusted in content, trusted in shape.
 *
 * Optional fields admit `undefined` explicitly. These values come from a JSON record, where
 * "the key is absent" and "the key is null/undefined" are the same thing for display
 * purposes; narrowing them would force conditional construction everywhere for no gain.
 */
export interface HistoricalSession {
  path: string;
  id: string;
  cwd: string;
  name?: string | undefined;
  created: string;
  modifiedMs: number;
  bytes: number;
  messageCount: number;
  firstMessage: string;
  /**
   * Whether the recorded cwd still exists. Validated at discovery time for display, and
   * again before every resume (D-4), because a directory can vanish between the two.
   */
  cwdExists: boolean;
  /** True when this session lives in the app-owned default workspace (US-3). */
  scratch: boolean;
}

/** A session Pi Central is supervising. This is the only source of truth for "running" (C3). */
export interface LiveSession {
  id: string;
  name: string;
  cwd: string;
  state: LiveState;
  mode: "sandboxed" | "direct";
  /** Human-readable description of the isolation actually in force. */
  isolation: string;
  /** The exact command line, for display. Never executed verbatim from here. */
  command: string;
  scratch: boolean;
  model?: string | undefined;
  provider?: string | undefined;
  thinkingLevel?: string | undefined;
  sessionFile?: string | undefined;
  messageCount: number;
  pending: number;
  contextPercent: number | null;
  tokensTotal: number | null;
  cost: number | null;
  dialogs: PendingDialog[];
  error?: string | undefined;
  warnings: string[];
  startedAt: number;
}

export interface PendingDialog {
  id: string;
  method: string;
  title?: string | undefined;
  message?: string | undefined;
  options?: string[] | undefined;
  placeholder?: string | undefined;
  prefill?: string | undefined;
  receivedAt: number;
}

/** Commands the UI may send. A closed union — the UI cannot name an arbitrary operation. */
export type Control =
  | { kind: "list" }
  | { kind: "start"; cwd?: string; name?: string; mode?: "sandboxed" | "direct" }
  | { kind: "prompt"; sessionId: string; message: string }
  | { kind: "abort"; sessionId: string }
  | { kind: "stop"; sessionId: string }
  | { kind: "rename"; sessionId: string; name: string }
  | { kind: "answerDialog"; sessionId: string; dialogId: string; answer: { value: string } | { confirmed: boolean } | { cancelled: true } }
  | { kind: "resume"; path: string; mode?: "sandboxed" | "direct" };

/**
 * A page of history plus the true total it was drawn from.
 *
 * Kept as a pair so a caller cannot accidentally present the page size as the total. The two
 * travel together for the same reason `{ sessions, total }` does in `registry.ts`.
 */
export interface HistoryPage {
  sessions: HistoricalSession[];
  /** Total session files on disk, which may exceed `sessions.length`. */
  total: number;
}

/** Events the UI may receive. `record` is untrusted and must be sanitized before render. */
export type Event =
  | {
      kind: "snapshot";
      live: LiveSession[];
      history: HistoricalSession[];
      /** True history total, as distinct from the length of `history`. */
      historyTotal: number;
      /**
       * The orchestrator's `$HOME`, for abbreviating paths in the UI.
       *
       * The browser cannot discover this: it is a local single-user tool talking to a process
       * that already knows the answer. Without it every path renders in full, so the rail loses
       * the `~/…` form that makes rows scannable.
       */
      home: string;
    }
  | { kind: "session"; session: LiveSession }
  | { kind: "record"; sessionId: string; record: PiRecord }
  | { kind: "history"; history: HistoricalSession[]; total: number }
  | { kind: "error"; message: string; sessionId?: string | undefined };

export const PROTOCOL_VERSION = 1 as const;

export interface Hello {
  kind: "hello";
  protocol: typeof PROTOCOL_VERSION;
}

/**
 * What an `orchestrator→client` envelope may carry.
 *
 * `hello` is a member even though it is not an `Event`: it is a preamble rather than state,
 * but it must travel in the same envelope so a client parses exactly one shape. Sending it
 * unwrapped made the client's reader handle two shapes, which is how the transport's first
 * tests failed.
 */
export type ServerPayload = Event | Hello;

/**
 * Envelope for anything crossing the socket. `dir` makes the trust direction explicit and
 * machine-checkable rather than implied by message shape.
 */
export type Envelope =
  | { dir: "client→orchestrator"; protocol: typeof PROTOCOL_VERSION; payload: Control }
  | { dir: "orchestrator→client"; protocol: typeof PROTOCOL_VERSION; payload: ServerPayload };
