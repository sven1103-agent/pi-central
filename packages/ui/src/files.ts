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
  | {
      status: "loaded";
      entries: FileEntry[];
      truncated: boolean;
      /**
       * When this listing was read, in ms, and the newest mtime it contained.
       *
       * They answer different questions and both are needed: `lastRead` is the age of the answer
       * (so it can be re-asked), and `changedAt` is evidence that the directory ALREADY moved (so it
       * need not wait). A listing fetched before these existed has neither, which `staleDirectories`
       * reads as "re-read once".
       */
      lastRead?: number;
      changedAt?: number;
    }
  | { status: "error"; reason: FileErrorReason; code?: string | undefined; message: string };

/** What is known about one file's contents. */
export type FileState =
  | { status: "unloaded" }
  | { status: "loading" }
  /**
   * Loaded. **Text or an image** (issue #106).
   *
   * A discriminated union rather than a nullable `text`, so a component that only handles text fails
   * to compile instead of rendering an empty pane for an image.
   *
   * The image arm carries `base64` and the orchestrator's `type`, and the blob URL is created by the
   * component that displays it — a URL is a resource with a lifetime, and state is not the place to
   * own one (it would leak on every re-render, and never be revoked on unmount).
   */
  | { status: "loaded"; content: { kind: "text"; text: string } | { kind: "image"; type: string; base64: string }; bytes: number }
  | { status: "error"; reason: FileErrorReason; code?: string | undefined; message: string };

/**
 * How long a listing is trusted without asking again.
 *
 * The tree had NO expiry: a directory answered once and that answer was authoritative for the life of
 * the page. So a file the agent created mid-session never appeared — in the tree or in the composer's
 * `@` picker, which reads the same cache — and the reported cure was restarting the app.
 *
 * Five seconds, and the number is a trade rather than a fact. The alternative was a `listFiles` request
 * per directory per transcript record, which is a flood: the agent writes several records per second
 * and most of them cannot have changed the filesystem. Five seconds is long enough that a reader
 * scrolling a directory does not re-request it, and short enough that a file the agent just wrote is
 * there by the time the reader looks for it.
 *
 * The cost is bounded by not re-reading while the window is hidden — the reader cannot see an update
 * they are not looking at — and by re-reading only directories that are already `loaded`.
 */
export const TREE_REREAD_MS = 5_000;

/** Minutes of clock skew, in ms, before an mtime is believed to be from the future. */
const FUTURE_SKEW_MS = 60_000;

/**
 * Which of a session's loaded listings are stale enough to ask about again.
 *
 * Pure, and separated from the effect that fetches them, for the reason `interpretRecord` is
 * separated in the orchestrator: the rule is the whole feature, and it is worth testing without a
 * socket.
 *
 * ## Age is the only test, and that is deliberate
 *
 * An earlier draft also tried to use the listing's newest `mtimeMs` as evidence that a directory
 * "just moved", so a fresh file would appear without waiting out the window. It cannot work: the
 * newest mtime of a listing is, by construction, recent *at the moment it is read* — so every
 * directory would look freshly changed for a full window after every read, and the loop would
 * re-request it on every tick. The watermark is useful for something else, and it is used for that:
 * `filesLoaded` compares it against the listing it is replacing, so a re-read that found nothing new
 * keeps the existing state object instead of re-rendering the tree.
 *
 * So the contract is a bound rather than a promise: **a change appears within `windowMs`.** Stating
 * that is better than a mechanism that appears to be instantaneous and is not.
 *
 * Two inputs decide it, and each rules out one way of being wrong:
 *
 *   - `status` — only `loaded` listings are candidates. A `loading` one would discard an answer that
 *     is in flight, an `error` one would re-ask a question that was just refused, and `unloaded` is
 *     already going to be read.
 *   - `lastRead` — the age test. Without it this would re-request every loaded directory on every
 *     transcript record.
 *
 * A `lastRead` *newer* than `now` is treated as fresh rather than as infinitely stale: a file server
 * and a browser can disagree about the clock by seconds, and a time in the future would otherwise
 * make the directory permanently stale and re-request it forever.
 */
export function staleDirectories(
  state: FilesState,
  sessionId: string,
  now: number,
  windowMs: number = TREE_REREAD_MS,
): string[] {
  const prefix = `${sessionId}\0`;
  const stale: string[] = [];
  for (const [key, directory] of Object.entries(state.directories)) {
    if (!key.startsWith(prefix)) continue;
    if (directory.status !== "loaded") continue;

    const path = key.slice(prefix.length);
    if (directory.lastRead === undefined) {
      // Loaded before readings were timed, or answered by an orchestrator that reports no freshness.
      // Re-reading is the honest answer, and it happens once because the next answer carries the field.
      stale.push(path);
      continue;
    }
    if (directory.lastRead > now + FUTURE_SKEW_MS) continue; // clock skew: believe the browser
    if (now - directory.lastRead >= windowMs) stale.push(path);
  }
  return stale;
}

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
  | {
      kind: "filesLoaded";
      sessionId: string;
      path: string;
      entries: FileEntry[];
      truncated: boolean;
      /**
       * When the read happened, and the newest mtime it saw.
       *
       * Recorded HERE rather than inside the reducer from `Date.now()`, because the reducer must stay
       * pure: two identical action sequences have to produce the same state or the tests are testing
       * a clock. Absent for a response that carried no mtimes (an unreadable entry, an empty
       * directory), which `staleDirectories` reads as "age it by `lastRead` only".
       */
      readAt?: number;
      changedAt?: number;
    }
  /** A LISTING was refused. Distinct from `filesLoaded` with no entries — see `DirectoryState`. */
  | { kind: "filesFailed"; sessionId: string; path: string; reason: FileErrorReason; code?: string | undefined; message: string }
  | { kind: "fileLoading"; sessionId: string; path: string }
  | {
      kind: "fileLoaded";
      sessionId: string;
      path: string;
      bytes: number;
      content: { kind: "text"; text: string } | { kind: "image"; type: string; base64: string };
    }
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
   * Mark some of a session's loaded listings as needing a re-read.
   *
   * The tree used to have no expiry at all: once a directory answered, its listing was authoritative
   * for the life of the page. A file created by the agent during a session therefore never appeared —
   * neither in the tree nor in the composer's `@` picker, which reads the same cache — and the only
   * cure was restarting the app.
   *
   * The action does not fetch anything, because the reducer cannot. It demotes listings to `unloaded`,
   * which is the same state a never-read directory is in, so the existing "fetch it when it is needed"
   * paths do the work: expanding a node, and the composer's own request when its picker opens. That is
   * also why nothing visibly reloads: a directory the reader is not looking at is not re-read until it
   * is looked at.
   */
  | { kind: "invalidateDirectories"; sessionId: string; paths: readonly string[] }
  /** Discard one file's cached CONTENT, so reopening it re-reads from disk. */
  | { kind: "invalidateFile"; sessionId: string; path: string }
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

    case "filesLoaded": {
      const key = fileKey(action.sessionId, action.path);
      const previous = state.directories[key];

      /*
       * A re-read that found nothing new keeps the state object.
       *
       * The tree is re-read on a timer (issue #189), and for an idle directory every one of those
       * replies is identical to the last. Replacing the entries array would rebuild the tree — and,
       * because `previewsFor` keys off the file cache, every memoised turn with it — twice a second
       * forever. Comparing `changedAt` (the newest mtime, from the same `lstat` as the names) to the
       * previous one is the cheap way to know nothing moved: a name added or removed changes it, and so
       * does an edit inside an entry.
       *
       * `lastRead` is deliberately NOT updated on an identical re-read. The listing was re-read, but
       * what the reader sees is unchanged, so there is nothing to re-render for — and letting age
       * reset on an unchanged answer would mean the directory's freshness never expires and a later
       * real change waits a full window from the LAST no-op instead of from the change.
       */
      if (
        previous !== undefined &&
        previous.status === "loaded" &&
        action.changedAt !== undefined &&
        previous.changedAt === action.changedAt &&
        previous.truncated === action.truncated
      ) {
        return state;
      }

      return {
        ...state,
        directories: {
          ...state.directories,
          [key]: {
            status: "loaded",
            entries: action.entries,
            truncated: action.truncated,
            ...(action.readAt === undefined ? {} : { lastRead: action.readAt }),
            ...(action.changedAt === undefined ? {} : { changedAt: action.changedAt }),
          },
        },
      };
    }

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
            content: action.content,
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

    case "invalidateDirectories": {
      if (action.paths.length === 0) return state;
      const directories = { ...state.directories };
      let changed = false;
      for (const path of action.paths) {
        const key = fileKey(action.sessionId, path);
        const current = directories[key];
        // Only a `loaded` listing is demoted, and the other three are each a different reason:
        // `unloaded` is already going to be read, demoting `loading` would discard the answer in
        // flight, and an `error` is a settled refusal rather than an old one — demoting it would loop
        // the same "permission denied" question twice a second. (`staleDirectories` never nominates
        // an error either; this guard is the second half of the same rule, so neither path can.)
        if (current === undefined || current.status !== "loaded") continue;
        directories[key] = { status: "unloaded" };
        changed = true;
      }
      // A no-op returns the SAME object: this runs on a timer, and a fresh object per tick would
      // re-render the tree and the transcript forever.
      return changed ? { ...state, directories } : state;
    }

    case "invalidateFile": {
      const key = fileKey(action.sessionId, action.path);
      if (state.files[key] === undefined) return state;
      const files = { ...state.files };
      delete files[key];
      return { ...state, files };
    }

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

/**
 * The newest mtime in a listing, or `undefined` when it carries none.
 *
 * Used as the listing's freshness watermark: comparing it against the previous listing's says the
 * directory moved, which is what makes a file the agent just created appear without waiting out
 * `TREE_REREAD_MS`.
 *
 * `undefined` rather than `0` for "no mtimes": an orchestrator that predates the field must not look
 * like a directory from 1970, which would read as permanently stale and re-request it forever.
 */
export function newestMtime(entries: readonly FileEntry[]): number | undefined {
  let newest: number | undefined;
  for (const entry of entries) {
    if (entry.mtimeMs === undefined) continue;
    if (newest === undefined || entry.mtimeMs > newest) newest = entry.mtimeMs;
  }
  return newest;
}
