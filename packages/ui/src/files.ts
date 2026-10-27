/**
 * The file tree's state (issue #8, ADR-0007).
 *
 * ## Why this is a separate module from `store.ts`
 *
 * `store.ts` reduces the **session** protocol: sessions, transcripts, dialogs, models. A directory
 * tree is a different shape of thing — keyed by `(session, path)` rather than by session, and grown
 * one directory at a time as the user expands it. Folding it into the session store would put two
 * unrelated lifecycles in one reducer and make every session transition reason about a tree.
 *
 * ## The state that matters is "what do we know", not "what is the tree"
 *
 * Nothing here mirrors the filesystem. Each entry records the outcome of one request:
 *
 *   - `unloaded`  — never asked. Distinct from empty, which is why it is not `[]`.
 *   - `loading`   — asked, not answered.
 *   - `loaded`    — answered, with entries. **An empty `entries` array is a real answer**: the
 *                   directory is empty.
 *   - `error`     — refused, with a reason and the OS code when there was one.
 *
 * `unloaded` and `loaded: []` are the distinction this module exists to protect. Collapsing them is
 * the mistake `transcriptError` was introduced to fix (store.ts): a spinner where the truth is
 * "empty", or an empty pane where the truth is "it failed".
 *
 * ## A refusal is never rendered as emptiness
 *
 * ADR-0007's guardrails are refusals, and the issue requires each to be *stated*: too large, binary,
 * permission, escape. Each arrives as `error` with a closed `reason`, so a component must handle it
 * rather than print whatever prose it was handed.
 */
import type { FileEntry, FileErrorReason } from "@pi-central/protocol";

/** What is known about one directory. */
export type DirectoryState =
  | { status: "unloaded" }
  | { status: "loading" }
  | { status: "loaded"; entries: FileEntry[]; truncated: boolean }
  | { status: "error"; reason: FileErrorReason; code?: string | undefined; message: string };

/** What is known about one file's contents. */
export type FileState =
  | { status: "unloaded" }
  | { status: "loading" }
  | { status: "loaded"; text: string; bytes: number }
  | { status: "error"; reason: FileErrorReason; code?: string | undefined; message: string };

export interface FilesState {
  /** Directories keyed by `"<sessionId>\0<relative path>"`. `""` is the session's own cwd. */
  directories: Record<string, DirectoryState>;
  /** Files keyed the same way. */
  files: Record<string, FileState>;
  /** Which directories are expanded. Set membership IS the tree's open state. */
  expanded: Record<string, boolean>;
  /** Which file is open in the pane, per session. */
  openFile: Record<string, string | undefined>;
  /** Whether dotfiles are shown, per session. A view preference, not a server fact. */
  showHidden: Record<string, boolean>;
  /**
   * Whether long lines wrap, per session (issue #73).
   *
   * A view preference like `showHidden`, and per session for the same reason: what you read in one
   * project is not what you read in another. Absent means WRAPPED — see `showsWrapped`.
   */
  wrapLines: Record<string, boolean>;
}

export function initialFilesState(): FilesState {
  return { directories: {}, files: {}, expanded: {}, openFile: {}, showHidden: {}, wrapLines: {} };
}

/**
 * The composite key for one path within one session.
 *
 * A NUL separator rather than `/` or `:`: a relative path may legitimately contain either, so any
 * printable separator can be forged by a filename and would let one directory's cache collide with
 * another's. NUL cannot appear in a POSIX path — and the orchestrator refuses one outright — which is
 * what makes this unambiguous rather than merely unlikely.
 */
export function fileKey(sessionId: string, path: string): string {
  return `${sessionId}\0${path}`;
}

/** Split a key back apart. Exported so a test can assert the round trip. */
export function splitFileKey(key: string): { sessionId: string; path: string } {
  const index = key.indexOf("\0");
  return { sessionId: key.slice(0, index), path: key.slice(index + 1) };
}

/** The directory state for a path, defaulting to `unloaded` rather than to empty. */
export function directoryAt(state: FilesState, sessionId: string, path: string): DirectoryState {
  return state.directories[fileKey(sessionId, path)] ?? { status: "unloaded" };
}

/** The file state for a path, defaulting to `unloaded`. */
export function fileAt(state: FilesState, sessionId: string, path: string): FileState {
  return state.files[fileKey(sessionId, path)] ?? { status: "unloaded" };
}

/** Is this directory expanded in the tree? */
export function isExpanded(state: FilesState, sessionId: string, path: string): boolean {
  return state.expanded[fileKey(sessionId, path)] === true;
}

/** Is this session showing dotfiles? */
export function showsHidden(state: FilesState, sessionId: string): boolean {
  return state.showHidden[sessionId] === true;
}

/**
 * Are long lines wrapped in this session's file viewer?
 *
 * **Wrapped by default**, and that reverses a documented decision, so the reasoning is recorded.
 * The viewer used to force `white-space: pre` on the grounds that "this is a code surface, and
 * wrapping turns one logical line into three visual ones, which makes line numbers lie".
 *
 * That was right about code and wrong about the common case: the panel hosts whatever the reader
 * opens, and the document they open most often is prose — a `CHANGELOG.md`, a `README.md`, a log.
 * For those there are no logical lines to preserve, and forced horizontal scrolling put the only
 * scrollbar at the bottom of a full-height panel, hundreds of pixels from the line being read, where
 * it reads as the end of the content rather than as a way to see the rest of it.
 *
 * So the default is the reading-friendly one and the code case is served by the toggle, which is the
 * same trade the dotfile toggle makes. `!== false` rather than `=== true` because absent must mean
 * the default, and the default here is on.
 */
export function showsWrapped(state: FilesState, sessionId: string): boolean {
  return state.wrapLines[sessionId] !== false;
}

/**
 * The path to display in the file pane, or `undefined` when nothing is open.
 *
 * The open file's own state travels with it, so a component cannot render the path of one file
 * beside the contents of another — the pair is produced together, from one lookup.
 */
export function openFileFor(
  state: FilesState,
  sessionId: string,
): { path: string; state: FileState } | undefined {
  const path = state.openFile[sessionId];
  if (path === undefined) return undefined;
  return { path, state: fileAt(state, sessionId, path) };
}

/**
 * Can this entry be expanded as a directory?
 *
 * A symlink to a directory can, and a plain directory can. Expressed here rather than in the
 * component because it is a decision about what an entry MEANS, and because the naive form — `kind
 * === "directory"` — is wrong in a way a component test would not catch: clicking a `docs -> ../docs`
 * link would issue a read for a directory and surface "That is a directory".
 *
 * A dangling link is not enterable. Expanding it would request a listing of something that does not
 * exist, and the refusal would read as an app bug rather than as a broken link.
 */
export function isEnterable(entry: FileEntry): boolean {
  if (entry.kind === "directory") return true;
  return entry.kind === "symlink" && entry.linkTarget === "directory";
}

/** A link whose target does not exist. Worth stating: clicking it would only produce "not found". */
export function isBrokenLink(entry: FileEntry): boolean {
  return entry.kind === "symlink" && entry.linkTarget === "missing";
}

/**
 * The child path for an entry, given its parent.
 *
 * `join`, not a template that assumes a trailing slash: `""` (the cwd) must produce `"name"` rather
 * than `"/name"`, and the leading-slash form would be an absolute path — which the orchestrator
 * refuses by design.
 */
export function childPath(parent: string, name: string): string {
  if (parent === "") return name;
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

/** Actions on file state. Local only: nothing here is a protocol message. */
export type FilesAction =
  | { kind: "filesLoading"; sessionId: string; path: string }
  | { kind: "filesLoaded"; sessionId: string; path: string; entries: FileEntry[]; truncated: boolean }
  /** A LISTING was refused. Distinct from `filesLoaded` with no entries — see `DirectoryState`. */
  | { kind: "filesFailed"; sessionId: string; path: string; reason: FileErrorReason; code?: string | undefined; message: string }
  | { kind: "fileLoading"; sessionId: string; path: string }
  | { kind: "fileLoaded"; sessionId: string; path: string; text: string; bytes: number }
  | { kind: "fileFailed"; sessionId: string; path: string; reason: FileErrorReason; code?: string | undefined; message: string }
  /** Toggle a directory open/closed. Collapsing keeps the cached listing, so reopening is instant. */
  | { kind: "toggleExpanded"; sessionId: string; path: string }
  | { kind: "setExpanded"; sessionId: string; path: string; expanded: boolean }
  | { kind: "openFile"; sessionId: string; path: string }
  | { kind: "closeFile"; sessionId: string }
  | { kind: "toggleHidden"; sessionId: string }
  /** Turn line wrapping on or off for this session's file viewer. */
  | { kind: "toggleWrap"; sessionId: string }
  /**
   * A session is gone: drop its tree.
   *
   * Keyed by session, so a stopped session's cached listings are discarded rather than lingering —
   * and, more importantly, a NEW session that reuses an id could not inherit the old one's tree.
   */
  | { kind: "forgetSession"; sessionId: string };

export function reduceFiles(state: FilesState, action: FilesAction): FilesState {
  switch (action.kind) {
    case "filesLoading":
      return {
        ...state,
        directories: { ...state.directories, [fileKey(action.sessionId, action.path)]: { status: "loading" } },
      };

    case "filesLoaded":
      return {
        ...state,
        directories: {
          ...state.directories,
          [fileKey(action.sessionId, action.path)]: {
            status: "loaded",
            entries: action.entries,
            truncated: action.truncated,
          },
        },
      };

    case "filesFailed":
      // A refused LISTING. Kept separate from `filesLoaded: []`, which means "this directory is
      // empty" — collapsing them would render an escape or a permission failure as emptiness.
      return {
        ...state,
        directories: {
          ...state.directories,
          [fileKey(action.sessionId, action.path)]: {
            status: "error",
            reason: action.reason,
            ...(action.code === undefined ? {} : { code: action.code }),
            message: action.message,
          },
        },
      };

    case "fileLoading":
      return {
        ...state,
        files: { ...state.files, [fileKey(action.sessionId, action.path)]: { status: "loading" } },
      };

    case "fileLoaded":
      return {
        ...state,
        files: {
          ...state.files,
          [fileKey(action.sessionId, action.path)]: {
            status: "loaded",
            text: action.text,
            bytes: action.bytes,
          },
        },
      };

    case "fileFailed":
      return {
        ...state,
        files: {
          ...state.files,
          [fileKey(action.sessionId, action.path)]: {
            status: "error",
            reason: action.reason,
            ...(action.code === undefined ? {} : { code: action.code }),
            message: action.message,
          },
        },
      };

    case "toggleExpanded":
    case "setExpanded": {
      const key = fileKey(action.sessionId, action.path);
      const expanded =
        action.kind === "toggleExpanded" ? state.expanded[key] !== true : action.expanded;
      return { ...state, expanded: { ...state.expanded, [key]: expanded } };
    }

    case "openFile":
      return { ...state, openFile: { ...state.openFile, [action.sessionId]: action.path } };

    case "closeFile":
      return { ...state, openFile: { ...state.openFile, [action.sessionId]: undefined } };

    case "toggleHidden":
      return {
        ...state,
        showHidden: { ...state.showHidden, [action.sessionId]: state.showHidden[action.sessionId] !== true },
      };

    case "toggleWrap":
      // Absent means wrapped, so the flip is "was it explicitly turned off?".
      return {
        ...state,
        wrapLines: { ...state.wrapLines, [action.sessionId]: state.wrapLines[action.sessionId] === false },
      };

    case "forgetSession": {
      const prefix = `${action.sessionId}\0`;
      const drop = <T>(record: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith(prefix)));
      const { [action.sessionId]: _open, ...openFile } = state.openFile;
      const { [action.sessionId]: _hidden, ...showHidden } = state.showHidden;
      const { [action.sessionId]: _wrapped, ...wrapLines } = state.wrapLines;
      return {
        directories: drop(state.directories),
        files: drop(state.files),
        expanded: drop(state.expanded),
        openFile,
        showHidden,
        wrapLines,
      };
    }
  }
}
