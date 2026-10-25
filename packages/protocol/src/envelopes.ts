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
  /**
   * Pi's OWN session id, a uuid, from `get_state`.
   *
   * Distinct from `id`, and the distinction is not cosmetic: `id` is Pi Central's short handle
   * (`s1`) that addresses the process, while this identifies the transcript. Showing `s1` under
   * the label "Session id" states something false — Pi's id is `01a171ff-…` — and the uuid is
   * what a person needs in order to find the session file or correlate it with `pi --session`.
   */
  sessionId?: string | undefined;
  /**
   * Whether the existing conversation has been fetched from Pi.
   *
   * Guards a single load: the UI reducer APPENDS every message it receives, so loading twice
   * would duplicate the whole transcript. Exposed so that property is directly testable.
   */
  transcriptLoaded?: boolean | undefined;
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

/** A model Pi can offer for a session. A subset of Pi's `Model`, chosen for display. */
export interface ModelOption {
  provider: string;
  id: string;
  /** The human name, when Pi reports one. Falls back to `id` for display. */
  name?: string | undefined;
  /**
   * Whether the model supports extended thinking.
   *
   * Displayed rather than acted on here: the authoritative constraint is
   * `get_available_thinking_levels` for the model (issue #2), because `reasoning: false` does not
   * by itself say WHICH levels are available.
   */
  reasoning?: boolean | undefined;
}

/** Commands the UI may send. A closed union — the UI cannot name an arbitrary operation. */
export type Control =
  | { kind: "list" }
  | { kind: "start"; cwd?: string; name?: string; mode?: "sandboxed" | "direct" }
  | { kind: "prompt"; sessionId: string; message: string }
  | { kind: "abort"; sessionId: string }
  | { kind: "stop"; sessionId: string }
  | { kind: "rename"; sessionId: string; name: string }
  /** Change the model. Carries provider AND id because `set_model` requires both (PROTOCOL.md). */
  | { kind: "setModel"; sessionId: string; provider: string; modelId: string }
  /** Ask for the session's available models. Answered with `models` or `modelsError`. */
  | { kind: "listModels"; sessionId: string }
  /** Change the thinking level. Only levels `listThinkingLevels` reported should be offered. */
  | { kind: "setThinkingLevel"; sessionId: string; level: string }
  /** Ask which thinking levels the CURRENT model supports. */
  | { kind: "listThinkingLevels"; sessionId: string }
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
  /**
   * The models Pi can offer for a session, in response to `listModels`.
   *
   * A REQUEST-shaped event rather than part of `LiveSession`, and that is a deliberate choice:
   * the catalogue is hundreds of entries (426 measured across three providers), so folding it
   * into every session update would resend the whole list on each state refresh. It changes only
   * when the provider configuration does, so it is fetched on demand.
   *
   * `error` is present instead of `models` when Pi could not answer — never an empty list, which
   * would render as "this session has no models" when the truth is "the question failed".
   */
  | { kind: "models"; sessionId: string; models: ModelOption[] }
  | { kind: "modelsError"; sessionId: string; message: string }
  /**
   * The thinking levels the CURRENT model supports, in response to `listThinkingLevels`.
   *
   * Per-model rather than global: a model without extended thinking has fewer levels, so a list
   * fetched for one model can offer a level the next model cannot use.
   */
  | { kind: "thinkingLevels"; sessionId: string; levels: string[] }
  | { kind: "thinkingLevelsError"; sessionId: string; message: string }
  /**
   * A session's EXISTING conversation, fetched when it starts or resumes.
   *
   * Separate from `record` on purpose. `record` is the live stream and is appended to; this is
   * the authoritative past and REPLACES what the client holds. Encoding both in one event would
   * make "append or replace?" undecidable from the payload, and a reconnect would then either
   * duplicate the conversation or lose the newest turn.
   */
  | { kind: "transcript"; sessionId: string; messages: unknown[] }
  /**
   * The conversation could not be read.
   *
   * A distinct event rather than an empty `transcript`, because the two mean opposite things: an
   * empty conversation is a fact about the session, and a failed read is a fact about the attempt.
   * Collapsing them made the UI show "Loading this session's history…" forever, which is a claim
   * that something is still in progress when nothing is.
   */
  | { kind: "transcriptError"; sessionId: string; message: string }
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
