/**
 * The UI's derived state.
 *
 * A pure reducer over orchestrator events. Kept separate from React so it is testable as a
 * plain function and so a component cannot invent state that the protocol never sent.
 *
 * Two rules it enforces deliberately:
 *
 * 1. **`state` comes from the orchestrator, never from event observing.** The UI must not infer
 *    "streaming" from having seen a delta: `agent_end` is not completion (C8), and the
 *    orchestrator's `interpretRecord` is the single place that decision is made. Duplicating
 *    it here would produce two state machines that disagree.
 *
 * 2. **A snapshot replaces live state wholesale.** Reconnection, `list`, and start-up all
 *    produce an authoritative snapshot; merging would leave a session showing as live after
 *    the orchestrator had stopped it.
 */
import type { HistoricalSession, LiveSession, PiRecord } from "@pi-central/protocol";
import { applyRecord, emptyTranscript, type Transcript } from "./transcript.ts";

export interface UiState {
  live: LiveSession[];
  history: HistoricalSession[];
  /** True history total on disk, which may exceed `history.length`. */
  historyTotal: number;
  /** The orchestrator's `$HOME`, for path abbreviation. Absent until the first snapshot. */
  home: string | undefined;
  /** Transcripts keyed by session id, built from that session's records. */
  transcripts: Record<string, Transcript>;
  /** The session the user is looking at. Not necessarily the one that is streaming. */
  focusedId: string | undefined;
  connection: "connecting" | "open" | "closed";
  connectionDetail: string | undefined;
  /** Errors worth showing, newest first. */
  errors: string[];
  /** True once a snapshot has arrived, so the UI can distinguish "empty" from "loading". */
  ready: boolean;
}

export function initialState(): UiState {
  return {
    live: [],
    history: [],
    historyTotal: 0,
    home: undefined,
    transcripts: {},
    focusedId: undefined,
    connection: "connecting",
    connectionDetail: undefined,
    errors: [],
    ready: false,
  };
}

/** How many errors to retain. Enough to diagnose, few enough not to bury the UI. */
const MAX_ERRORS = 20;

export function reduce(state: UiState, event: Parameters<typeof applyEvent>[1]): UiState {
  return applyEvent(state, event);
}

function applyEvent(state: UiState, event: import("@pi-central/protocol").Event): UiState {
  switch (event.kind) {
    case "snapshot": {
      // Authoritative replacement, both halves. `focusedId` is preserved when that session is
      // still present, so a reconnect does not move the user's view.
      const stillPresent = state.focusedId && event.live.some((s) => s.id === state.focusedId);
      const focusedId = stillPresent
        ? state.focusedId
        : // Otherwise focus the first session, which is what a user arriving expects.
          event.live[0]?.id;
      return {
        ...state,
        live: event.live,
        history: event.history,
        historyTotal: event.historyTotal,
        home: event.home,
        focusedId,
        ready: true,
      };
    }

    case "session": {
      const index = state.live.findIndex((s) => s.id === event.session.id);
      const live = index === -1
        ? [...state.live, event.session]
        : state.live.map((s) => (s.id === event.session.id ? event.session : s));
      // Focus a newly started session, but never steal focus from one the user is reading.
      const focusedId = state.focusedId ?? event.session.id;
      return { ...state, live, focusedId };
    }

    case "record": {
      const previous = state.transcripts[event.sessionId] ?? emptyTranscript();
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [event.sessionId]: applyRecord(previous, event.record as Record<string, unknown>),
        },
      };
    }

    case "history":
      return { ...state, history: event.history, historyTotal: event.total, ready: true };

    case "error":
      return {
        ...state,
        errors: [event.message, ...state.errors].slice(0, MAX_ERRORS),
      };
  }
}

// --- Selectors, so components do not re-derive -------------------------------------------------

/**
 * Fleet counts for the topbar, each label matched to the number it shows.
 *
 * Derived rather than assembled inline, because the first version labelled
 * `state.live.length` as "running" — so a screenshot of two IDLE sessions read "2 running".
 * A count is only useful if its label is true, and every state needed to compute it is right
 * here rather than in a component.
 */
export function fleetCounts(state: UiState): {
  total: number;
  running: number;
  idle: number;
  needs: number;
  scratch: number;
} {
  const isRunning = (s: LiveSession) => s.state === "streaming" || s.state === "starting";
  const isBlocked = (s: LiveSession) => s.state === "awaiting-approval" || s.state === "failed";
  return {
    total: state.live.length,
    running: state.live.filter(isRunning).length,
    idle: state.live.filter((s) => s.state === "idle").length,
    needs: state.live.filter(isBlocked).length,
    scratch: state.live.filter((s) => s.scratch).length,
  };
}

/**
 * Is the loaded history a page rather than the whole store?
 *
 * The rail and the history pane must say so when it is: "1115 sessions on disk" while only
 * searching the newest 500 is a half-truth, and the honest version is short enough to state.
 */
export function historyIsPartial(state: UiState): boolean {
  return state.historyTotal > state.history.length;
}

export function focusedSession(state: UiState): LiveSession | undefined {
  return state.live.find((s) => s.id === state.focusedId);
}

export function transcriptFor(state: UiState, sessionId: string | undefined): Transcript {
  if (!sessionId) return emptyTranscript();
  return state.transcripts[sessionId] ?? emptyTranscript();
}

export function scratchSessions(state: UiState): LiveSession[] {
  return state.live.filter((s) => s.scratch);
}

/**
 * Sessions needing a human: blocked on a dialog, or failed.
 *
 * Used to decide where to draw attention. `awaiting-approval` is first because a session
 * blocked on a dialog will make no further progress until answered, whereas a failed one has
 * already stopped.
 */
export function needingAttention(state: UiState): LiveSession[] {
  return state.live.filter((s) => s.state === "awaiting-approval" || s.state === "failed");
}

export function pendingDialogCount(state: UiState): number {
  return state.live.reduce((total, session) => total + session.dialogs.length, 0);
}

/**
 * Whether a session can accept a prompt right now, and why not if it cannot.
 *
 * The composer uses this to decide between prompt, steer and follow-up rather than guessing:
 * during streaming, `prompt` REQUIRES a `streamingBehavior` or Pi errors (PROTOCOL.md).
 */
export function composerMode(session: LiveSession | undefined): {
  mode: "prompt" | "steer" | "unavailable";
  reason?: string;
} {
  if (!session) return { mode: "unavailable", reason: "No session selected." };
  switch (session.state) {
    case "starting":
      return { mode: "unavailable", reason: "Starting up. The session will accept a prompt shortly." };
    case "idle":
      return { mode: "prompt" };
    case "streaming":
      return { mode: "steer" };
    case "awaiting-approval":
      return { mode: "unavailable", reason: "Waiting for your answer to a dialog below." };
    case "failed":
      return { mode: "unavailable", reason: session.error ?? "This session failed to start." };
    case "stopped":
      return { mode: "unavailable", reason: "This session has stopped." };
    case "registered":
      return { mode: "unavailable", reason: "Not yet started." };
  }
}

/**
 * Search history by content, cwd, and name.
 *
 * Content search is the point (US-4): a user remembers what a session was *about*, not its
 * filename or timestamp. Matches are ranked so a title or project hit beats an incidental
 * mention deep in a transcript.
 */
export function searchHistory(
  history: HistoricalSession[],
  query: string,
  limit = 200,
): HistoricalSession[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return history.slice(0, limit);

  const scored: { session: HistoricalSession; score: number }[] = [];
  for (const session of history) {
    let score = 0;
    const name = (session.name ?? "").toLowerCase();
    const cwd = session.cwd.toLowerCase();
    const first = session.firstMessage.toLowerCase();
    if (name.includes(trimmed)) score += 100;
    if (cwd.includes(trimmed)) score += 50;
    if (first.includes(trimmed)) score += 20;
    if (score > 0) scored.push({ session, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.session.modifiedMs - a.session.modifiedMs));
  return scored.slice(0, limit).map((entry) => entry.session);
}

/** Human-readable state, for the rail. The label is what the user needs to know, not the enum. */
export function stateLabel(session: LiveSession): string {
  switch (session.state) {
    case "registered": return "registered";
    case "starting": return "starting";
    case "idle": return "idle";
    case "streaming": return "working";
    case "awaiting-approval": return "needs you";
    case "stopped": return "stopped";
    case "failed": return "failed";
  }
}

/** Context usage as a percentage, or null when unknown. Never a fabricated 0. */
export function contextPercent(session: LiveSession): number | null {
  if (session.contextPercent === null || !Number.isFinite(session.contextPercent)) return null;
  return Math.max(0, Math.min(100, session.contextPercent));
}

/** Does this record carry transcript content? Used to skip work for lifecycle-only records. */
export function affectsTranscript(record: PiRecord): boolean {
  return (
    record.type === "message_start" ||
    record.type === "message_update" ||
    record.type === "message_end" ||
    record.type === "tool_execution_start" ||
    record.type === "tool_execution_update" ||
    record.type === "tool_execution_end"
  );
}
