/**
 * The file tree (issue #8, ADR-0007).
 *
 * ## What it shows, and what it must not imply
 *
 * This browses **the session's working directory**, and it can reach files the *agent* cannot: the
 * orchestrator reads at the user's UID, deliberately (ADR-0007). ADR-0007 is explicit that the UI
 * must not present this as "what the agent can see":
 *
 *   > If a future feature browses outside the workdir, it must be presented as "your files, as you",
 *   > not as "what the agent can see". Do not imply the browser shows the agent's view.
 *
 * Scope is the session's own `cwd`, so the two coincide here — but the label says *working
 * directory*, never "the agent's view". The distinction matters the moment anything browses wider.
 *
 * ## Directory state has four values, and three of them are not "empty"
 *
 * `unloaded`, `loading`, `loaded` (possibly with zero entries) and `error`. Rendering an error or a
 * pending load as an empty list is the same class of bug as showing a spinner forever for a failed
 * transcript read — a claim about the directory that is not known to be true. Each state gets its own
 * text, and a refusal states the *reason* (too large, binary, permission, escape) rather than a
 * generic failure.
 */
import type { FileEntry } from "@pi-central/protocol";
import {
  childPath,
  directoryAt,
  fileAt,
  isBrokenLink,
  isEnterable,
  isExpanded,
  showsHidden,
  type DirectoryState,
  type FilesState,
} from "../files.ts";
import { formatBytes } from "../format.ts";

export function FileTree({
  sessionId,
  state,
  cwd,
  onExpand,
  onCollapse,
  onToggleHidden,
  onOpenFile,
}: {
  sessionId: string;
  state: FilesState;
  /** The session's working directory, for the header. Absolute, from the orchestrator. */
  cwd: string;
  onExpand: (path: string) => void;
  onCollapse: (path: string) => void;
  onToggleHidden: () => void;
  onOpenFile: (path: string) => void;
}) {
  const hidden = showsHidden(state, sessionId);
  const root = directoryAt(state, sessionId, "");

  return (
    <div className="filetree">
      <div className="filetree-head">
        <span className="filetree-scope" title={cwd}>
          Working directory
        </span>
        {/*
          The toggle says what it will DO, not what is currently true — a button labelled by its
          state is read as a status, and then clicked twice by anyone who reads it as one.
        */}
        <button
          type="button"
          className="btn btn-quiet"
          onClick={onToggleHidden}
          aria-pressed={hidden}
          title={hidden ? "Hide dotfiles" : "Show dotfiles"}
        >
          {hidden ? "Hide dotfiles" : "Show dotfiles"}
        </button>
      </div>

      {root.status === "unloaded" ? (
        // Kicked off by the parent on focus. Said as such rather than showing an empty list.
        <p className="filetree-note">Not loaded yet.</p>
      ) : root.status === "loading" ? (
        <p className="filetree-note" role="status">
          Reading…
        </p>
      ) : root.status === "error" ? (
        <FileErrorNote path="" reason={root.reason} code={root.code} message={root.message} />
      ) : root.entries.length === 0 ? (
        // A REAL answer, and worded as one. "No files" is a fact about the directory; it is not the
        // same statement as "we could not read it", which renders above.
        <p className="filetree-note">This directory is empty.</p>
      ) : (
        <ul className="filetree-list" role="tree" aria-label={`Files in ${cwd}`}>
          {root.entries.map((entry) => (
            <TreeNode
              key={entry.name}
              sessionId={sessionId}
              parent=""
              entry={entry}
              state={state}
              depth={0}
              onExpand={onExpand}
              onCollapse={onCollapse}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      )}

      {root.status === "loaded" && root.truncated && (
        // Stated, because a capped list that ended silently would read as a complete one.
        <p className="filetree-note filetree-truncated">
          Showing the first entries only — this directory holds more.
        </p>
      )}
    </div>
  );
}

/** One entry, and its children when it is an open directory. */
function TreeNode({
  sessionId,
  parent,
  entry,
  state,
  depth,
  onExpand,
  onCollapse,
  onOpenFile,
}: {
  sessionId: string;
  parent: string;
  entry: FileEntry;
  state: FilesState;
  depth: number;
  onExpand: (path: string) => void;
  onCollapse: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const path = childPath(parent, entry.name);
  // Whether the entry can be expanded is a question about what it means, so it is answered in the
  // state module (`isEnterable`) rather than inline — see there for why the naive `kind === "directory"`
  // form is wrong. Safety is still decided on ENTRY, by `resolveWithin`.
  const isDirectory = isEnterable(entry);
  const open = isDirectory && isExpanded(state, sessionId, path);
  const children = isDirectory && open ? directoryAt(state, sessionId, path) : undefined;

  return (
    <li
      className={`filetree-node${entry.unreadable ? " is-unreadable" : ""}`}
      role="treeitem"
      aria-expanded={isDirectory ? open : undefined}
      style={{ paddingLeft: `${depth * 12}px` }}
    >
      <button
        type="button"
        className="filetree-row"
        onClick={() => {
          if (isDirectory) {
            if (open) onCollapse(path);
            else onExpand(path);
          } else {
            onOpenFile(path);
          }
        }}
        // The full path, because the tree is indented and a name alone is ambiguous when two
        // directories hold the same one.
        title={path}
      >
        <span className="filetree-mark" aria-hidden="true">
          {isDirectory ? (open ? "▾" : "▸") : entry.kind === "symlink" ? "↗" : "·"}
        </span>
        <span className={`filetree-name${entry.hidden ? " is-hidden" : ""}`}>{entry.name}</span>
        {entry.kind === "symlink" && !isBrokenLink(entry) && <span className="filetree-kind">link</span>}
        {isBrokenLink(entry) && (
          // Said, rather than shown as an ordinary file: clicking it would produce "not found" from
          // the orchestrator, which reads as a bug in the app rather than as a broken link on disk.
          <span className="filetree-kind filetree-bad">broken</span>
        )}
        {entry.unreadable && <span className="filetree-kind filetree-bad">unreadable</span>}
        {entry.size !== undefined && <span className="filetree-size">{formatBytes(entry.size)}</span>}
      </button>

      {children !== undefined && (
        <ChildList
          files={state}
          directory={children}
          sessionId={sessionId}
          parent={path}
          depth={depth + 1}
          onExpand={onExpand}
          onCollapse={onCollapse}
          onOpenFile={onOpenFile}
        />
      )}
    </li>
  );
}

/**
 * A directory's children, in whichever of the four states it is in.
 *
 * Takes the whole `FilesState` as well as this directory's resolved state: each child is a `TreeNode`,
 * which needs the full state to look up ITS children. Passing only the resolved directory here forced
 * a cast at the call site to satisfy the type, and that cast is exactly the kind of thing that hides a
 * real mismatch — so the state is threaded properly instead.
 */
function ChildList({
  files,
  directory,
  sessionId,
  parent,
  depth,
  onExpand,
  onCollapse,
  onOpenFile,
}: {
  files: FilesState;
  directory: DirectoryState;
  sessionId: string;
  parent: string;
  depth: number;
  onExpand: (path: string) => void;
  onCollapse: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  if (directory.status === "loading" || directory.status === "unloaded") {
    return (
      <p className="filetree-note" role="status" style={{ paddingLeft: `${depth * 12}px` }}>
        Reading…
      </p>
    );
  }
  if (directory.status === "error") {
    return (
      <FileErrorNote
        path={parent}
        reason={directory.reason}
        code={directory.code}
        message={directory.message}
        depth={depth}
      />
    );
  }
  if (directory.entries.length === 0) {
    return (
      <p className="filetree-note" style={{ paddingLeft: `${depth * 12}px` }}>
        Empty.
      </p>
    );
  }
  return (
    <>
      <ul className="filetree-list" role="group">
        {directory.entries.map((entry) => (
          <TreeNode
            key={entry.name}
            sessionId={sessionId}
            parent={parent}
            entry={entry}
            state={files}
            depth={depth}
            onExpand={onExpand}
            onCollapse={onCollapse}
            onOpenFile={onOpenFile}
          />
        ))}
      </ul>
      {directory.truncated && (
        // Stated per directory, not only at the root. A nested directory that was capped would
        // otherwise end silently and read as complete — and the root's notice only ever spoke for
        // the root.
        <p className="filetree-note filetree-truncated" style={{ paddingLeft: `${depth * 12}px` }}>
          Showing the first entries only — this directory holds more.
        </p>
      )}
    </>
  );
}

/**
 * A refusal, stated with its reason.
 *
 * The reason is a closed set from the protocol, so each case is handled rather than printed as
 * whatever prose arrived. That matters because the *fix* differs per reason: a binary file is not
 * going to become readable, a permission failure is a chmod, an escape is a path bug, and an
 * oversized file is a judgement call. A generic "could not read" would hide all four.
 */
export function FileErrorNote({
  path,
  reason,
  code,
  message,
  depth = 0,
}: {
  path: string;
  reason: string;
  code?: string | undefined;
  message: string;
  depth?: number;
}) {
  return (
    <p
      className="filetree-note filetree-error"
      role="note"
      style={{ paddingLeft: `${depth * 12}px` }}
      title={path === "" ? undefined : path}
    >
      <strong>{reasonLabel(reason)}</strong>
      {/* The orchestrator's message is shown verbatim: it carries the OS code and the sizes, and
          rewording it here would be a second place that could disagree with the first. */}
      <span className="filetree-error-detail">{message}</span>
      {code !== undefined && <span className="filetree-kind">{code}</span>}
    </p>
  );
}

/** A short human label for a refusal reason. The long explanation is the orchestrator's message. */
function reasonLabel(reason: string): string {
  switch (reason) {
    case "escapes-cwd":
      return "Outside the working directory";
    case "absolute-path":
      return "Not a relative path";
    case "invalid-path":
      return "Not a usable path";
    case "too-large":
      return "Too large to read";
    case "binary":
      return "Not a text file";
    case "permission":
      return "Permission denied";
    case "not-found":
      return "Not found";
    case "not-a-directory":
      return "Not a directory";
    case "is-directory":
      return "That is a directory";
    default:
      return "Could not read";
  }
}

/**
 * The open file's contents (issue #8).
 *
 * Text, displayed **inert** — never rendered as markup (ADR-0006). It is untrusted for the same
 * reason a transcript is: it came off the filesystem, and a file in a working directory may have been
 * written by the agent, by a dependency, or by whoever sent the repository.
 */
export function FilePane({
  sessionId,
  path,
  state,
  onClose,
}: {
  sessionId: string;
  path: string;
  state: ReturnType<typeof fileAt>;
  onClose: () => void;
}) {
  const lines = state.status === "loaded" ? state.text.split("\n") : [];

  return (
    <div className="filepane">
      <div className="filepane-head">
        <span className="filepane-path" title={path}>
          {path}
        </span>
        {state.status === "loaded" && (
          <span className="filepane-meta">
            {lines.length} line{lines.length === 1 ? "" : "s"} · {formatBytes(state.bytes)}
          </span>
        )}
        <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Close file">
          Close
        </button>
      </div>

      {state.status === "unloaded" || state.status === "loading" ? (
        <p className="filetree-note" role="status">
          Reading…
        </p>
      ) : state.status === "error" ? (
        <FileErrorNote path={path} reason={state.reason} code={state.code} message={state.message} />
      ) : (
        /*
          Line numbers and the text as separate elements, so a line number cannot be selected as part
          of the content and a copy of the code does not begin with its numbering.
        */
        <ol className="filepane-lines">
          {lines.map((line, index) => (
            <li key={index}>
              <span className="filepane-line-no" aria-hidden="true">
                {index + 1}
              </span>
              {/* Rendered as a text node: React escapes it, and there is no `dangerouslySetInnerHTML`
                  anywhere near this — ADR-0006's single insertion point is in `MessageBody`. */}
              <span className="filepane-line-text">{line === "" ? "\u00a0" : line}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
