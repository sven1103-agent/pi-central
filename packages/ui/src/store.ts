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
import type {
  HistoricalSession,
  InstallFacts,
  LiveSession,
  ModelOption,
  PiRecord,
} from "@pi-central/protocol";
import { applyRecord, emptyTranscript, seedTranscript, type Transcript } from "./transcript.ts";
import { addToRoster, removeFromRoster, type RosterEntry, type RosterRow } from "./roster.ts";
// A type-only import from a component, which is the odd part of this file: `QueueBehavior` is the composer's
// vocabulary for how a prompt joins a run, and `pendingPrompt` has to speak it so a parked prompt is sent with
// the same behaviour the reader chose. Imported as a TYPE so no component code is pulled into the reducer.
import type { QueueBehavior } from "./components/Composer.tsx";

export interface UiState {
  live: LiveSession[];
  history: HistoricalSession[];
  /** True history total on disk, which may exceed `history.length`. */
  historyTotal: number;
  /** The orchestrator's `$HOME`, for path abbreviation. Absent until the first snapshot. */
  home: string | undefined;
  /**
   * Where the orchestrator's own installation lives, for the self-hosting warning (issue #25).
   *
   * From the snapshot rather than computed here: "am I pointing at my own checkout?" is a fact
   * about the *orchestrator*, and the browser cannot discover it. `undefined` means unknown, which
   * the UI reports as unknown rather than as safe.
   */
  installationRoot: string | undefined;
  /**
   * Facts about the running installation, for the Settings surface (issue #58).
   *
   * `undefined` until the first snapshot, and in principle forever when talking to an orchestrator
   * older than this field. The UI renders that as "not reported", never as an empty string — the same
   * distinction `home` makes, and the reason the protocol could add this field without a version
   * bump: a receiver that does not know it ignores it, and one that expects it says so.
   */
  install: InstallFacts | undefined;
  /** Transcripts keyed by session id, built from that session's records. */
  transcripts: Record<string, Transcript>;
  /**
   * Sessions whose conversation could not be read, keyed by session id.
   *
   * Tracked separately from an empty transcript because the two mean opposite things: an empty
   * conversation is a fact about the session, a failed read is a fact about the attempt. Without
   * this distinction the UI asserted "Loading…" indefinitely — a claim that work is in progress
   * when none is.
   */
  transcriptErrors: Record<string, string>;
  /** The session the user is looking at. Not necessarily the one that is streaming. */
  focusedId: string | undefined;
  /**
   * A session the reader has ASKED for and that has not arrived yet (issue #144).
   *
   * Reported: "When I open a session (from the history or from scratch), it is not made the active one in
   * the transcript window. That leads to confusion, and I started to type prompts into the wrong
   * conversation."
   *
   * The `session` event's focus rule is `state.focusedId ?? event.session.id` — deliberately, so a session
   * the reader is READING never has focus stolen by a broadcast about some other process. That rule is
   * correct and stays. The bug was that nothing distinguished "a session appeared" from "the session I just
   * asked for appeared", so the intent was lost the moment any session was already focused — which is the
   * normal case.
   *
   * This is that intent, not a second focus. It is set by a local action when the reader starts or resumes,
   * and consumed exactly once by the next NEW session to arrive.
   */
  focusNextNewSession: boolean;
  /**
   * The session FILE the reader asked for, when they asked for one that may already be running.
   *
   * ## The defect this fixes
   *
   * Clicking a History row for a session that is ALREADY live did nothing to the selection. `focusNextNewSession` is
   * consumed only by a session that is NEW to the list (`arrived`), and resuming an already-live session re-broadcasts
   * that same session — so `arrived` is false, the intent is never spent, and the tab switches to Sessions showing
   * **whatever was focused before**. Reported as: *"when you click a session in the history, and it is already active in
   * the roster, it opens this session, but the selection is not updated. Users dont realise that they are in the new
   * session. This is a huge identity issue."*
   *
   * A boolean cannot express "the one in this file", so the file is recorded. Matching on `sessionFile` is the same
   * identity the roster uses (ADR-0004) — a resumed session has a NEW handle for the SAME conversation, so the handle
   * is exactly the wrong thing to wait for.
   */
  focusNextSessionFile: string | undefined;
  /**
   * The sessions the reader is working with (issue #89).
   *
   * **This list is the rail.** Nothing retires entries from it and nothing derives it from `live`: activity is
   * joined per row by `rosterRows`. A first attempt built it FROM `live` and retired rows as they came online —
   * write, retire, re-add — and every session appeared twice as a result.
   */
  roster: RosterEntry[];
  /**
   * A prompt waiting for the session it belongs to come back (issue #89, resume-on-send).
   *
   * Sending to a session that is not running has to RESUME first, and the resumed session arrives later with a
   * NEW handle (`s1` after a restart is a different session). So the message is parked against the roster
   * PATH — the durable identity — and sent when a live session with that file appears.
   *
   * Parked rather than dropped: the reader typed something, and silently discarding it because a spawn takes a
   * second would be the worst possible answer.
   */
  pendingPrompt: { path: string; message: string; behavior?: QueueBehavior } | undefined;
  connection: "connecting" | "open" | "closed";
  connectionDetail: string | undefined;
  /** Errors worth showing, newest first. */
  errors: string[];
  /**
   * Model catalogues, keyed by session id, from `listModels`.
   *
   * Request-shaped rather than a field on `LiveSession`, because it is hundreds of entries and it
   * changes only with the provider configuration. Absent means "not asked yet", which is different
   * from an empty list, so a picker can say "loading" rather than "no models".
   */
  models: Record<string, ModelOption[]>;
  /** Why a catalogue could not be read. Distinct from an empty catalogue, deliberately. */
  modelErrors: Record<string, string>;
  /** Thinking levels per session, from `listThinkingLevels`. Per-model, so re-read on a switch. */
  thinkingLevels: Record<string, string[]>;
  thinkingLevelErrors: Record<string, string>;
  /**
   * The queued messages' TEXTS, keyed by session id, from `queue_update` records.
   *
   * The count lives in `LiveSession.pending`; this is the content. The two can disagree after a
   * reconnect (a snapshot has the count but no texts, because texts are records and records are
   * not replayed), so `queuedMessages` below never fabricates text to make them match.
   */
  queues: Record<string, { steering: string[]; followUp: string[] }>;
  /**
   * Text that `clearQueue` took out of the queue, waiting to be restored to the composer.
   *
   * Held in the store rather than passed through a callback because it arrives as an EVENT: Esc
   * is a keystroke in one component and the texts come back from Pi, so the round trip has to be
   * modelled as state that lands, not as a return value.
   */
  restoredQueue: Record<string, string[]>;
  /** True once a snapshot has arrived, so the UI can distinguish "empty" from "loading". */
  ready: boolean;
}

export function initialState(): UiState {
  return {
    live: [],
    history: [],
    historyTotal: 0,
    home: undefined,
    installationRoot: undefined,
    install: undefined,
    transcripts: {},
    transcriptErrors: {},
    models: {},
    modelErrors: {},
    thinkingLevels: {},
    thinkingLevelErrors: {},
    queues: {},
    restoredQueue: {},
    focusedId: undefined,
    focusNextNewSession: false,
    focusNextSessionFile: undefined,
    roster: [],
    pendingPrompt: undefined,
    connection: "connecting",
    connectionDetail: undefined,
    errors: [],
    ready: false,
  };
}

/** How many errors to retain. Enough to diagnose, few enough not to bury the UI. */
const MAX_ERRORS = 20;

/**
 * An action the reducer handles that did NOT come from the orchestrator.
 *
 * A separate union rather than a widened `Event`, because the two have different sources and
 * therefore different trust: `Event` comes off the socket and is untrusted, while this is
 * produced by the client's own components. Merging them would put a locally-invented event on
 * the same footing as a message from Pi, which is the kind of blurring C8 exists to prevent. It
 * is also why this is not a socket round trip: "the composer has now taken the restored text"
 * is something only the composer knows.
 */
export type LocalAction =
  | { kind: "queueRestored"; sessionId: string }
  /**
   * Clear the error currently shown (issue #11, reported from a window).
   *
   * Dismiss used to dispatch `{ kind: "error", message: "" }`, which PREPENDS an empty string to the list
   * rather than removing anything — so `errors.length > 0` stayed true, the strip stayed on screen, and the
   * button looked broken. A local action, because this is the reader dismissing something, not the
   * orchestrator reporting it.
   */
  | { kind: "dismissError" }
  /**
   * Move the focus to another session. **A view change, not a data change.**
   *
   * This exists because there was no way to switch sessions at all. The rail dispatched a `session`
   * event to do it, and that event is an UPSERT whose focus rule is
   * `state.focusedId ?? event.session.id` — deliberately, so a newly started session is focused but
   * a session the user is reading never has focus stolen from it. With focus already set, that rule
   * keeps the OLD id, so clicking a rail row refreshed the row's data and changed nothing visible.
   * The rail's primary interaction did nothing, and no test caught it because the store had no
   * focus test — only the event's "does not steal focus" behaviour, which was working correctly.
   *
   * Kept separate from `session` rather than given a flag, because the two have different owners:
   * `session` events carry facts from the orchestrator, while focus is the user's position in the
   * UI. A single event serving both is what made "the user clicked" indistinguishable from
   * "the supervisor sent an update".
   */
  /**
   * Focus a row by its KEY — a live session's handle, or a roster entry's file path.
   *
   * One key type, because the rail shows one list (issue #89). A row that is not running still has to be
   * focusable: that is what makes the composer usable for it, which is how resume-on-send works.
   */
  | { kind: "focusRow"; key: string }
  /** Adopt the roster read from `localStorage` at startup. */
  | { kind: "loadRoster"; entries: RosterEntry[] }
  /** Put a session in the roster, or refresh its hints. Order is preserved for one already there. */
  | { kind: "remember"; entry: RosterEntry }
  /** Take a session off the roster. The file is NOT deleted — that is #150. */
  | { kind: "forget"; path: string }
  /** Park a prompt against a session path until that session is running (resume-on-send). */
  | { kind: "queuePrompt"; path: string; message: string; behavior?: QueueBehavior }
  /** The parked prompt has been sent, or can never be — either way it is no longer waiting. */
  | { kind: "clearPendingPrompt" }
  /**
   * "The session I am about to create or resume should become the active one" (issue #144).
   *
   * Dispatched BEFORE the `start`/`resume` control is sent, because the orchestrator broadcasts the new
   * session synchronously in reply — so the intent has to already be in the store when that event lands.
   */
  /**
   * "The reader asked for this one."
   *
   * `file` names WHICH, when it may already be running — the History case, where the click targets a conversation that
   * a live session may already be holding. Without it the intent could only be spent by a session new to the list.
   */
  | { kind: "expectNewSession"; file?: string | undefined };

export function reduce(
  state: UiState,
  event: import("@pi-central/protocol").Event | LocalAction,
): UiState {
  // Narrowed on the key that distinguishes them. A protocol event's `kind` is never
  // `queueRestored`, so this cannot misroute a server message into local handling.
  if (event.kind === "queueRestored") {
    const { [event.sessionId]: _taken, ...restoredQueue } = state.restoredQueue;
    return { ...state, restoredQueue };
  }
  if (event.kind === "expectNewSession") {
    /*
     * A flag, not an id: the id does not exist yet. Consumed by the next new `session` event.
     *
     * `file` is how a session that is ALREADY running is reached. Without it the intent is spent only by a session new
     * to the list, so a resume of a live one focuses nothing and the reader is left looking at a different session.
     */
    const file = event.file;
    if (state.focusNextNewSession && state.focusNextSessionFile === file) return state;
    return {
      ...state,
      focusNextNewSession: true,
      focusNextSessionFile: file,
    };
  }
  if (event.kind === "dismissError") {
    // The strip shows `errors[0]`, so dismissing removes exactly that one and reveals the next — which is the
    // difference between "dismiss" and "clear everything", and keeps a second error from being hidden by a
    // click aimed at the first.
    return state.errors.length === 0 ? state : { ...state, errors: state.errors.slice(1) };
  }
  if (event.kind === "loadRoster") {
    return { ...state, roster: event.entries };
  }
  if (event.kind === "remember") {
    return { ...state, roster: addToRoster(state.roster, event.entry) };
  }
  if (event.kind === "forget") {
    return { ...state, roster: removeFromRoster(state.roster, event.path) };
  }
  if (event.kind === "queuePrompt") {
    return {
      ...state,
      pendingPrompt: {
        path: event.path,
        message: event.message,
        ...(event.behavior ? { behavior: event.behavior } : {}),
      },
    };
  }
  if (event.kind === "clearPendingPrompt") {
    return state.pendingPrompt === undefined ? state : { ...state, pendingPrompt: undefined };
  }
  if (event.kind === "focusRow") {
    /*
     * A key is a live session's handle, a roster entry's file path, OR (since the identity fix) a session file — the
     * History case, where the reader names a conversation rather than a row.
     *
     * Three resolutions, and the third is the one that was missing:
     *
     *   - a handle → that session;
     *   - a file a LIVE session holds → that session's handle. This matters more than it looks: the same conversation
     *     can be running under a handle the reader never saw (`s12`), and focusing the path instead would render the
     *     stopped-session view beside a running process;
     *   - a file no live session holds → the roster row, which `focusedStoppedRow` then renders.
     *
     * Ignored when it is none of those: focus and presence are different facts, and focusing something unknown would
     * blank the main column — a worse outcome than ignoring the click. Returning the SAME object when nothing changes
     * keeps React from re-rendering the whole app for a click on the already-focused row.
     */
    const byHandle = state.live.find((session) => session.id === event.key);
    const byFile = byHandle === undefined ? state.live.find((session) => session.sessionFile === event.key) : undefined;
    const live = byHandle ?? byFile;
    const isRoster = state.roster.some((entry) => entry.path === event.key);
    if (live === undefined && !isRoster) return state;
    const key = live?.id ?? event.key;
    if (state.focusedId === key) return state;
    return { ...state, focusedId: key };
  }
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
        installationRoot: event.installationRoot,
        install: event.install,
        focusedId,
        ready: true,
      };
    }

    case "session": {
      const index = state.live.findIndex((s) => s.id === event.session.id);
      const live = index === -1
        ? [...state.live, event.session]
        : state.live.map((s) => (s.id === event.session.id ? event.session : s));
      /*
       * Focus a newly started session, but never steal focus from one the user is reading.
       *
       * The `??` alone is not enough (issue #144): it focuses a new session only when NOTHING was focused,
       * which is the rare case. When the reader already has a session open and starts another, the
       * `focusedId` is set, so the `??` keeps the OLD one and the new session opens invisibly — the reader
       * then types into a conversation they cannot see.
       *
       * `focusNextNewSession` is the missing half: an explicit "I asked for this one". It is consumed only
       * by a session that is NEW to the list (`index === -1`), so a later broadcast about an existing
       * session cannot trigger it, and it is cleared either way so a failed start does not redirect the
       * NEXT unrelated session.
       */
      const arrived = index === -1;
      /*
       * The intent is spent by EITHER a new session OR the session the reader named by file.
       *
       * The `file` half is the identity fix: resuming a session that is already live re-broadcasts the SAME session, so
       * `arrived` is false and a boolean-only intent was never spent — the tab switched to Sessions showing whatever
       * had been focused before, and the reader had no way to tell they were somewhere else.
       *
       * A new session still wins on arrival (`arrived`), because that is the `start` case where no file was named and
       * none exists yet.
       */
      const named = state.focusNextSessionFile !== undefined && event.session.sessionFile === state.focusNextSessionFile;
      /*
       * When a FILE was named, only that file can spend the intent.
       *
       * `focusNextNewSession && arrived` alone is the #144 rule for `start`, where no file can be named because none
       * exists yet — but applied to a named resume it means the FIRST new session to arrive wins, whichever it is. That
       * is not hypothetical: a resume is a spawn, and any other session starting in the same second would take the
       * reader's view. Caught by a test that lets an unrelated session arrive first.
       */
      const claimed =
        named || (state.focusNextNewSession && arrived && state.focusNextSessionFile === undefined);
      const focusedId = claimed ? event.session.id : (state.focusedId ?? event.session.id);
      /*
       * Keep the HISTORY entry in step when this is the same session (issue #164).
       *
       * A rename updates the live session, but History is a separate list built from `discover()` on connect — and
       * nothing re-broadcasts it. The UI never sends `list` at all, so History showed the old name until a full
       * page reload. Matching on `sessionFile` is the same identity the roster uses, and it needs no new event and
       * no protocol change: the `session` patch already carries both the file and the new name.
       */
      const file = event.session.sessionFile;
      // ONE guard, not two. A first version wrapped this in `file === undefined ? state.history : map(...)` as well,
      // and that made the behaviour unfalsifiable: either guard alone was enough, so removing one changed nothing
      // and a test could not tell. `entry.path` is always a string, so an unknown `file` matches nothing on its
      // own — the comparison is sufficient, and now removing it fails a test.
      const history = state.history.map((entry) =>
        entry.path === file ? { ...entry, ...(event.session.name ? { name: event.session.name } : {}) } : entry,
      );

      return {
        ...state,
        live,
        history,
        focusedId,
        // Cleared when the intent is SPENT, not merely when something new appeared: a `session` event for an unrelated
        // session must not consume "focus the one I asked for".
        ...(claimed ? { focusNextNewSession: false, focusNextSessionFile: undefined } : {}),
      };
    }

    case "record": {
      // A `message_end` with a timestamped whole message is either live or replayed history;
      // both fold through `applyRecord`, which is the point of replaying history as records.
      const previous = state.transcripts[event.sessionId] ?? emptyTranscript();
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [event.sessionId]: applyRecord(previous, event.record as Record<string, unknown>),
        },
      };
    }

    case "transcript": {
      // Replaces whatever was there, because it is the authoritative conversation as of now.
      // Appending would duplicate the conversation on every reconnect.
      const { [event.sessionId]: _cleared, ...errors } = state.transcriptErrors;
      return {
        ...state,
        transcripts: { ...state.transcripts, [event.sessionId]: seedTranscript(event.messages) },
        transcriptErrors: errors,
      };
    }

    case "transcriptError":
      return {
        ...state,
        transcriptErrors: { ...state.transcriptErrors, [event.sessionId]: event.message },
      };

    case "models": {
      // A successful read CLEARS the previous error for this session, so a retry that worked does
      // not leave a stale failure on screen.
      const { [event.sessionId]: _cleared, ...modelErrors } = state.modelErrors;
      return { ...state, models: { ...state.models, [event.sessionId]: event.models }, modelErrors };
    }

    case "modelsError":
      return { ...state, modelErrors: { ...state.modelErrors, [event.sessionId]: event.message } };

    case "thinkingLevels": {
      const { [event.sessionId]: _cleared, ...thinkingLevelErrors } = state.thinkingLevelErrors;
      return {
        ...state,
        thinkingLevels: { ...state.thinkingLevels, [event.sessionId]: event.levels },
        thinkingLevelErrors,
      };
    }

    case "thinkingLevelsError":
      return {
        ...state,
        thinkingLevelErrors: { ...state.thinkingLevelErrors, [event.sessionId]: event.message },
      };

    case "queue":
      // A whole-list replacement, for the same reason `transcript` replaces: Pi sends the entire
      // queue on every `queue_update`, so appending would duplicate it.
      return {
        ...state,
        queues: {
          ...state.queues,
          [event.sessionId]: { steering: event.steering, followUp: event.followUp },
        },
      };

    case "queueCleared": {
      // Cleared AND handed back in one transition, so the composer cannot observe the texts as
      // "still queued" and "not yet restored" at the same time. The `queue` event that emptied
      // the list arrives separately and is what makes the strip disappear.
      const restored = [...event.steering, ...event.followUp];
      return {
        ...state,
        queues: { ...state.queues, [event.sessionId]: { steering: [], followUp: [] } },
        restoredQueue: { ...state.restoredQueue, [event.sessionId]: restored },
      };
    }

    case "history":
      return { ...state, history: event.history, historyTotal: event.total, ready: true };

    // --- File browsing (issue #8) ---------------------------------------------------------
    //
    // Both handled here as no-ops on the SESSION state, because the file tree lives in its own store
    // (`files.ts`, driven by App.tsx). They are cases rather than an omission so the switch stays
    // exhaustive: a new event kind must be considered here, and "this does not touch session state"
    // is a decision worth writing down rather than an accident of the default branch.
    case "files":
    case "file":
    case "fileError":
      return state;

    case "error":
      // An error DISARMS a pending "focus the session I asked for" (issue #144). The orchestrator answers a
      // refused `start`/`resume` with an error and no `session` event, so without this the intent would sit
      // armed and pull the view to some unrelated session later. It is spent, not deferred: the reader's
      // request did not produce a session, so there is nothing to focus.
      return {
        ...state,
        focusNextNewSession: false,
        // The FILE goes with it: an error disarms the whole intent, or a later unrelated session could be matched.
        focusNextSessionFile: undefined,
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
 * Is any live session running WITHOUT isolation?
 *
 * `mode` is per-session, so this is derived rather than configured. It exists because running
 * a session unsandboxed is the single most important fact about it, and the design's rule is
 * to stay honest about isolation: a per-session chip in the inspector is not enough for
 * something that grants the agent the user's own account.
 */
export function hasUnisolatedSession(state: UiState): boolean {
  return state.live.some((s) => s.mode === "direct");
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

/**
 * The focused row when it is a STOPPED session, i.e. a roster entry rather than a live handle.
 *
 * ## Why this has to exist
 *
 * `focusedId` holds EITHER a live session's handle or a roster entry's file path (issue #89). `focusedSession` only
 * searches `state.live`, so clicking a stopped row set a `focusedId` that resolved to nothing — and the main column
 * rendered "No session selected". There was then no control anywhere to start that session again: the
 * "resume-on-send" the issue describes was never wired (`queuePrompt` is dispatched by nothing).
 *
 * A dead end, reported as: *"i could not recover a session … That leaves user in a deadlock to select the right
 * session."* Selecting was the second problem; this is the first — the click led nowhere at all.
 *
 * Returns `undefined` when the focus is a live session (use `focusedSession`) or names nothing known.
 */
export function focusedStoppedRow(state: UiState): RosterRow | undefined {
  const id = state.focusedId;
  if (id === undefined) return undefined;
  /*
   * A live handle wins, so one session never gets two views.
   *
   * Defence in depth rather than a live fix: a live handle (`s1`) can never equal a roster path (an absolute `.jsonl`
   * path), so the `find` below would return nothing anyway. It is kept because the two branches render DIFFERENT
   * components for the same row — `SessionView` or `StoppedSession` — and a future change that made a handle and a path
   * collide would silently render both.
   *
   * Stated plainly because I could not falsify it on its own: removing it changes no test, which is what "cannot fail"
   * looks like from the outside.
   */
  if (state.live.some((session) => session.id === id)) return undefined;
  const entry = state.roster.find((candidate) => candidate.path === id);
  if (entry === undefined) return undefined;
  // A session that came back is live again; the live branch above already returned in that case, but a snapshot can
  // race a focus, so the join is done here rather than trusted.
  const session = state.live.find((candidate) => candidate.sessionFile === entry.path);
  return { entry, session };
}

export function transcriptFor(state: UiState, sessionId: string | undefined): Transcript {
  if (!sessionId) return emptyTranscript();
  return state.transcripts[sessionId] ?? emptyTranscript();
}

/**
 * The first thing the reader asked this session, for a label (`titleFromPrompt`).
 *
 * Read from the LIVE TRANSCRIPT rather than from discovery, because a session started a moment ago has a prompt in
 * memory and no file worth re-reading yet — and the rail must not show `s4` for a session the reader can already see
 * a question in. Returns `undefined` until the first user message arrives, which is the honest answer for a session
 * nothing has been asked yet.
 */
export function firstPromptFor(state: UiState, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const transcript = state.transcripts[sessionId];
  if (transcript === undefined) return undefined;
  for (const message of transcript.messages) {
    if (message.role !== "user") continue;
    for (const block of message.blocks) {
      if (block.kind === "text" && block.text.trim().length > 0) return block.text;
    }
  }
  return undefined;
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
      // Both steer and follow-up are available; "steer" is the DEFAULT, which is what Pi's own
      // interactive mode uses for a plain Enter mid-run (`interactive-mode.js`: `prompt(text, {
      // streamingBehavior: "steer" })`). Alt+Enter there is the follow-up. Matching the surface
      // the user already knows is worth more than inventing a different default.
      return { mode: "steer" };
    case "awaiting-approval":
      return { mode: "unavailable", reason: "Waiting for your answer to a dialog below." };
    case "failed":
      /*
       * DESIGN.md's sentence, not the error.
       *
       * This used to return `session.error`, so the whole stderr appeared under the composer as well as in the
       * banner and the Session panel. Reported as "the error is everywhere", and it is the same redundancy in
       * a third place. The composer says what to DO; the Session panel says what happened.
       */
      return { mode: "unavailable", reason: "This session failed to start. Retry it from the rail." };
    case "stopped":
      return { mode: "unavailable", reason: "This session has stopped." };
    case "registered":
      return { mode: "unavailable", reason: "Not yet started." };
  }
}

/**
 * The queue's contents, and whether those contents are actually known.
 *
 * `LiveSession.pending` is a COUNT and the texts arrive as `queue_update` records, so the two
 * have genuinely different lifetimes: a reconnect replaces the session from a snapshot (count
 * present) without replaying records (texts absent). The design rule is that the count is the
 * header and the texts are the rows, and that a missing text is *said* rather than invented —
 * "1 message queued before this page loaded" — because a fabricated row would claim to know what
 * the user typed. `textsKnown` is that distinction, exposed so the component does not re-derive
 * it from array lengths.
 */
export function queuedMessages(
  state: UiState,
  session: LiveSession | undefined,
): { steering: string[]; followUp: string[]; total: number; textsKnown: boolean } {
  if (!session) return { steering: [], followUp: [], total: 0, textsKnown: true };
  const queue = state.queues[session.id];
  const steering = queue?.steering ?? [];
  const followUp = queue?.followUp ?? [];
  // Known when a record has been seen AND it accounts for the count the snapshot reported. A
  // record that is short of the count means some messages predate this page, which is exactly
  // the case the design calls out.
  const textsKnown = queue !== undefined && steering.length + followUp.length >= session.pending;
  return { steering, followUp, total: session.pending, textsKnown };
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

// --- The model and thinking pickers ------------------------------------------------------------

/**
 * Models grouped by provider, in the order Pi returned them.
 *
 * Grouped rather than flat because a provider's models share a prefix and a flat list of hundreds
 * is unreadable. The grouping is computed here so the component renders and does not decide.
 */
export function modelsByProvider(models: ModelOption[]): { provider: string; models: ModelOption[] }[] {
  const groups: { provider: string; models: ModelOption[] }[] = [];
  for (const model of models) {
    const last = groups.at(-1);
    if (last && last.provider === model.provider) last.models.push(model);
    else groups.push({ provider: model.provider, models: [model] });
  }
  return groups;
}

/**
 * Is this model the one the session is currently on?
 *
 * Both parts are compared: the same model id can exist under two providers (a proxy and the
 * upstream), and marking the wrong one as current would make the picker claim a change that is
 * not the one in effect.
 */
export function isCurrentModel(session: LiveSession, model: ModelOption): boolean {
  return session.model === model.id && (session.provider === undefined || session.provider === model.provider);
}

/**
 * What the model control should say while a run is in progress.
 *
 * A change takes effect for the NEXT turn, not the one in flight, so a control that looked
 * immediate would be claiming something false. Returned as text rather than a boolean so the
 * wording lives in one place and can be asserted.
 */
export function modelChangeTiming(session: LiveSession | undefined): string {
  if (!session) return "";
  return session.state === "streaming"
    ? "Applies to the next turn; this run is already using the current model."
    : "";
}

/**
 * Thinking levels, filtered to the ones the current model actually supports.
 *
 * `available` is what Pi reported for THIS model. When it has not been read yet the list is empty,
 * and an empty list must not be presented as "this model has no levels" — hence the caller checks
 * `error` and `loaded` separately. Returning only the intersection keeps the constraint in one
 * place: a level that is offered but unsupported would be a control Pi refuses.
 */
export function availableThinkingLevels(
  state: UiState,
  sessionId: string,
): { levels: string[]; loaded: boolean; error?: string } {
  const error = state.thinkingLevelErrors[sessionId];
  const levels = state.thinkingLevels[sessionId];
  if (error !== undefined) return { levels: [], loaded: true, error };
  if (levels === undefined) return { levels: [], loaded: false };
  return { levels, loaded: true };
}
