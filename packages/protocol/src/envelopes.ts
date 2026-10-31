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
   * The error from the attempt BEFORE a retry (issue #11).
   *
   * `error` describes the current state, so a retry clears it — but clearing it would erase the evidence of
   * the first failure, and a reader retrying a spawn problem needs to compare attempts. Kept separate rather
   * than appended to `error`, because the two answer different questions: "is it broken now" and "how did it
   * break last time".
   */
  previousError?: string | undefined;
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
  /**
   * Re-spawn a session that FAILED, in the directory it already had (issue #11).
   *
   * A dedicated control rather than "stop then start", because those two are not the same request: the
   * reader is asking for *this* session to try again, not for a new one, and a client-side sequence would
   * leave the failed row in the rail beside its replacement. `previousError` is carried so the second
   * attempt does not erase the evidence of the first.
   *
   * Only a `failed` session can be retried. A running one is refused rather than restarted: a silent
   * restart is how a crash loop hides itself.
   */
  | { kind: "retry"; sessionId: string }
  | { kind: "prompt"; sessionId: string; message: string; behavior?: "steer" | "followUp" }
  /**
   * Empty Pi's message queue, optionally stopping the run.
   *
   * `andStop` is a flag rather than two controls because the two are always one gesture: Esc
   * stops the run *and* returns the queue to the composer. Splitting them would let a caller
   * abort while silently discarding what the user typed, which is the bug this exists to fix.
   *
   * The cleared texts come back in a `queue` event, so "what was removed" is reported rather
   * than guessed — the composer restores exactly that text, not a reconstruction of it.
   */
  | { kind: "clearQueue"; sessionId: string; andStop: boolean }
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
  /**
   * List a session's working directory (issue #8).
   *
   * Paths are **relative to the session's cwd** and never absolute. That is not a convenience: the
   * orchestrator resolves each relative path and verifies the result is inside the cwd, so an
   * absolute path would mean the client and the boundary disagreed about what was being asked for.
   * The orchestrator refuses one outright rather than interpreting it (`files.ts`).
   *
   * `sessionId` rather than a bare path, because the confinement is per session: the root is that
   * session's cwd, so "which directory" is answered by "which session".
   */
  | { kind: "listFiles"; sessionId: string; path: string; includeHidden?: boolean }
  /** Read one text file, confined the same way. Answered with `file` or `fileError`. */
  | { kind: "readFile"; sessionId: string; path: string }
  | { kind: "resume"; path: string; mode?: "sandboxed" | "direct" };

/**
 * Facts about the running installation, for the Settings surface (issue #58).
 *
 * These are things the browser cannot discover for itself — the orchestrator is a local process that
 * already knows them, and three of the four were previously printed ONLY to the terminal at startup,
 * so a user who closed that terminal could not answer "where are my sessions on disk?".
 */
export interface InstallFacts {
  /**
   * The orchestrator's own version, read from the `package.json` it was shipped in (ADR-0011).
   *
   * Never a constant in either codebase: it must report the artifact that is actually running, or
   * "is this the build with the fix?" cannot be answered from the process being asked.
   */
  version: string;
  /** Where Pi's session files are discovered from. */
  sessionsRoot: string;
  /** The app-owned workspace used when a session is started without a directory (US-1). */
  workspaceRoot: string;
  /** The agent's credential/identity root. */
  agentRoot: string;
  /** True when Pi Central manages that root itself, rather than using an external one. */
  agentRootManaged: boolean;
  /**
   * The wire version the orchestrator speaks.
   *
   * Also carried on `hello`, and duplicated here deliberately: `hello` is consumed once by the
   * connection and never stored, while this surface must render the pair (orchestrator vs UI) from
   * the authoritative snapshot — including after a reconnect. Recovering it from `hello` would mean a
   * second piece of connection state kept in parallel with `store.ts`, which is exactly the split
   * this codebase avoids: everything the UI shows comes from an event (`store.ts`).
   */
  protocol: number;
}

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
      /**
       * Facts about the running installation (issue #58).
       *
       * Optional, and **a new optional field is deliberately NOT a protocol-version change**: a
       * receiver ignores a field it does not know, so an older UI meeting a newer orchestrator is
       * unaffected, and a newer UI meeting an older orchestrator renders "not reported" (the UI
       * handles the absent case rather than assuming it). `wire-surface.test.ts` fingerprints KINDS,
       * and this is the gap it documents — which is why the absent case is a tested state here
       * rather than an afterthought. The alternative, sending three new events, would have been a
       * breaking change to fix a cosmetic one.
       */
      install?: InstallFacts | undefined;
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
      /**
       * Where the orchestrator's own installation lives, if it could identify it (issue #25).
       *
       * Sent so the UI can warn LIVE, while a directory is being typed into the sheet — before any
       * session exists to carry the warning. `undefined` means the orchestrator could not identify
       * its own root, which is reported as unknown rather than as safe.
       */
      installationRoot?: string | undefined;
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
  /**
   * The session's CURRENT message queue, in full.
   *
   * A whole-list event rather than a delta, for the same reason `transcript` replaces rather than
   * appends: Pi already reports the entire queue on every `queue_update`, so a delta encoding
   * would mean reconstructing state the source hands over complete. It is also what makes
   * `clearQueue` reportable — the emptied queue arrives as `{ steering: [], followUp: [] }`
   * *and* the cleared texts are read from the same structure, so "nothing is queued" and "this is
   * what was queued" cannot disagree.
   *
   * `LiveSession.pending` remains the count (it is what the rail shows); this is the texts. The
   * two can legitimately differ after a reconnect, which is why the composer falls back to the
   * count rather than inventing text it never received.
   */
  | { kind: "queue"; sessionId: string; steering: string[]; followUp: string[] }
  /**
   * What `clearQueue` removed, so the composer can give it back (issue #3).
   *
   * Deliberately NOT the `queue` event with the cleared contents: Pi empties its queue as part of
   * clearing it, so the emptied `queue` arrives first and these texts would overwrite it — the
   * queue would then appear to still hold the messages just removed. The cleared texts belong to
   * the composer's draft, which is a different place, so they are a different event.
   */
  | { kind: "queueCleared"; sessionId: string; steering: string[]; followUp: string[] }
  /**
   * A directory listing, in response to `listFiles` (issue #8).
   *
   * `path` is echoed so the client can tell WHICH request this answers after a rapid series of
   * expansions — without it, a slow listing for one directory could be rendered under another's
   * heading, which is the class of bug that shows stale content as current.
   */
  | { kind: "files"; sessionId: string; path: string; entries: FileEntry[]; truncated: boolean }
  /**
   * A file's contents, in response to `readFile`.
   *
   * Text, and **untrusted**: it is displayed inert, never rendered as markup (ADR-0006).
   */
  /**
   * A file's contents, as either text or an image (issue #106).
   *
   * A discriminated union rather than optional fields, so a client that only knows about `text` fails
   * to compile rather than rendering an empty pane for an image.
   *
   * An image carries **base64** data and a type the ORCHESTRATOR decided from the bytes. Base64 rather
   * than a binary frame: this envelope is JSON, and the alternative is a second message shape for the
   * same request. The 33% inflation is bounded by the 8 MB image cap.
   */
  | {
      kind: "file";
      sessionId: string;
      path: string;
      bytes: number;
      content: { kind: "text"; text: string } | { kind: "image"; type: string; base64: string };
    }
  /**
   * A file request was refused.
   *
   * A distinct event from an empty listing, for the same reason `transcriptError` is distinct from
   * an empty transcript: "this directory is empty" and "this directory could not be read" are
   * opposite facts, and collapsing them made the UI assert something false. `reason` is a closed set
   * so the client must handle each case rather than print prose the orchestrator chose.
   *
   * `request` says WHICH question failed. Without it the client would have to guess from whichever
   * cache happened to be pending, and two requests for the same path (a listing and a read) would
   * make that guess a coin flip — with the failure then recorded against the wrong one.
   */
  | { kind: "fileError"; sessionId: string; path: string; request: "list" | "read"; reason: FileErrorReason; code?: string | undefined; message: string }
  | { kind: "error"; message: string; sessionId?: string | undefined };

/** One entry in a directory listing. Metadata only: a listing never reads file contents. */
export interface FileEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  /**
   * For a symlink, what it points at (`stat`, following the link), or `missing` when it dangles.
   *
   * `kind` stays `symlink` — the entry *is* a link, and calling it a directory would hide that
   * following it may leave the root. This only tells the UI whether the link can be entered.
   */
  linkTarget?: "file" | "directory" | "other" | "missing" | undefined;
  /** Size in bytes, for regular files only. */
  size?: number | undefined;
  hidden: boolean;
  /** `lstat` failed: the entry exists but its type could not be established. */
  unreadable?: boolean | undefined;
}

/**
 * Why a file request was refused. Mirrors `FileFailure` in the orchestrator's `files.ts`.
 *
 * A closed union rather than a string, so the client cannot silently ignore a new reason: adding one
 * here is a compile error at every handler that switches on it.
 */
export type FileErrorReason =
  | "absolute-path"
  | "escapes-cwd"
  /** Not a usable path: a NUL byte, or a non-string. Malformed input, not a boundary violation. */
  | "invalid-path"
  | "not-a-directory"
  | "is-directory"
  | "too-large"
  | "binary"
  | "not-found"
  | "permission"
  | "unreadable";

/**
 * The wire version, checked by BOTH sides on `hello`.
 *
 * **Bump this whenever a Control or Event kind is added, removed, or renamed.** That is the whole
 * point of the handshake: adding a kind is a protocol change, and it is exactly the case where
 * nobody remembers to bump, because nothing local fails — the author's UI and orchestrator are the
 * same commit. The failure appears later, on someone else's machine, as an unrelated-looking
 * `unknown kind` from a connection that reported itself compatible.
 *
 * That is not hypothetical: issue #8 added five kinds without a bump, and the symptom was
 * `bad control: unknown kind 'listFiles'` against a v1 orchestrator that had said `hello`.
 *
 * Enforced by `test/wire-surface.test.ts`, which pins the kind set against this number in both
 * directions — so the surface and the version cannot move independently.
 *
 * 1 → 2: `listFiles`, `readFile`, `files`, `file`, `fileError` (issue #8).
 * 2 → 3: the `file` event's payload became a discriminated union of text and image, so a v2
 *        client would read `text` off a message that no longer has it (issue #106). A FIELD
 *        change is exactly what the kind fingerprint cannot see — this one was caught by a
 *        type error at the one call site that read `text`, which is the backstop the
 *        fingerprint documents.
 */
/**
 * v4 (issue #11): the `retry` control, and `LiveSession.previousError`.
 *
 * Bumped rather than slipped in: a v3 orchestrator would receive `retry`, ignore it as unknown, and the
 * reader would press a button that does nothing — which is exactly what the handshake exists to catch.
 */
export const PROTOCOL_VERSION = 4 as const;

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
