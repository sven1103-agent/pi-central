/**
 * Reading a session's working directory — confined to it (ADR-0007, issue #8).
 *
 * ## Who this runs as, and why that is not a gap
 *
 * These functions use plain `fs` in the **orchestrator** process, at the user's UID. There is no
 * `safehouse` invocation, no sidecar, and no round trip through the session's RPC `bash`. ADR-0007
 * decides this: Safehouse confines the *agent* processes, which is what constrains model-generated
 * actions. The file browser serves the *person*, and the person's own UID is already the correct
 * privilege level for reading their own files. Routing it through the agent's sandbox would be
 * slower, more complex, and would conflate two actors.
 *
 * The consequence, stated because the UI must not misrepresent it: **this can read files the agent
 * cannot.** The browser shows "your files, as you", never "what the agent can see".
 *
 * ## Containment is the whole feature
 *
 * Because the privilege is the user's, the only thing standing between a path from the UI and the
 * rest of the disk is the check below. ADR-0007's guardrails are therefore load-bearing, not
 * hygiene:
 *
 *   1. **Canonicalize with `realpath`, then verify containment.** Never compare string prefixes:
 *      that fails on `..`, on symlinks, and on case-insensitive filesystems.
 *   2. **Resolve symlinks *before* the containment check**, so a link pointing out of the tree is
 *      refused rather than followed.
 *   3. **Cap reads, and refuse binary content** rather than rendering replacement characters.
 *   4. **Report the OS error code**, never a guess. A permission failure was once reported as a
 *      missing directory elsewhere in this project (C14's neighbourhood), and the two need
 *      different fixes.
 *
 * ## Two roots, because a symlinked cwd is ordinary on macOS
 *
 * `root` is what the caller asked for (`/tmp/x`), `realRoot` is what the OS says it is
 * (`/private/tmp/x` on macOS). Containment is checked against `realRoot`, because the *resolved*
 * candidate comes back in OS form and comparing it against the un-resolved root would refuse a
 * perfectly good path. Both are derived here so no caller has to remember.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
// Shared with the UI so a size in the tree and a size in a refusal cannot disagree (protocol/bytes.ts).
import { formatBytes } from "@pi-central/protocol";
export { formatBytes };

/**
 * The largest file this will read, in bytes.
 *
 * 256 KB, matching `registry.ts`'s transcript head cap — the same figure and the same reason: it is
 * large enough for any source file a person browses and small enough that a stray log or archive
 * cannot be pulled into memory. A file above it is **refused, not clipped**: the issue requires that
 * an oversized file "says so rather than truncating silently", and a partial view of a file is a
 * wrong answer to "what is in this file".
 */
export const MAX_FILE_BYTES = 256 * 1024;

/**
 * How much of a file to inspect when deciding whether it is binary.
 *
 * A NUL byte in the first 8 KB is git's own heuristic and is what makes this cheap: it needs one
 * `read` of a constant size, not the whole file.
 */
export const BINARY_SNIFF_BYTES = 8 * 1024;

/** Why a path or read was refused. A closed set, so callers must handle each rather than print it. */
export type FileFailure =
  /** The path was absolute. The UI only speaks relative paths, so this is always a mistake. */
  | "absolute-path"
  /**
   * Not a usable path at all — a NUL byte, or a non-string. Distinct from `escapes-cwd`: a NUL is
   * malformed input rather than a boundary violation, and reporting it as "outside the working
   * directory" would name a place the path never reached.
   */
  | "invalid-path"
  /** A `..` segment or a symlink took the resolved path outside the session's cwd. */
  | "escapes-cwd"
  /** The path exists but is not a directory, and a listing was requested. */
  | "not-a-directory"
  /** A read was requested for a directory. */
  | "is-directory"
  /** Larger than {@link MAX_FILE_BYTES}; refused rather than truncated. */
  | "too-large"
  /** Not text: a NUL byte, or the bytes are not valid UTF-8. */
  | "binary"
  | "not-found"
  /** The OS denied access. `code` carries its errno, which is the useful part. */
  | "permission"
  /** Anything else, with the OS code preserved. */
  | "unreadable";

export interface FileError {
  reason: FileFailure;
  /** The raw errno (`EACCES`, `EPERM`, `ENOENT`, …) when the OS produced one. */
  code?: string | undefined;
  /** A sentence for the UI. Names the code when there is one — never a substituted guess. */
  message: string;
}

export interface DirEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  /**
   * For a symlink, what it points AT (`stat`, following the link), or `missing` when it dangles.
   *
   * The `kind` stays `symlink` — that is what the entry *is*, and collapsing a link into its target
   * would hide the fact that following it may leave the root. But a UI needs to know whether a link
   * is enterable, and without this it would treat every link as a file: clicking a `docs -> ../docs`
   * link would send a read for a directory and surface "That is a directory", which is true and
   * useless. Established with `stat` (following) alongside `lstat` (not), so this is a *description*
   * and not a safety decision — `resolveWithin` still decides that when the path is actually entered.
   */
  linkTarget?: "file" | "directory" | "other" | "missing" | undefined;
  /** Size in bytes, for regular files only. */
  size?: number | undefined;
  /** A dotfile. Returned anyway when `includeHidden` is set; the flag is why. */
  hidden: boolean;
  /**
   * The entry could not be `lstat`ed.
   *
   * Reported rather than dropped: an entry that exists but cannot be inspected is a fact the user
   * needs, and silently omitting it would make the tree disagree with `ls` for no stated reason.
   */
  unreadable?: boolean | undefined;
}

export interface DirListing {
  /** The directory, relative to the session cwd and normalized. `""` means the cwd itself. */
  path: string;
  entries: DirEntry[];
  /** True when the directory held more entries than `limit`. */
  truncated: boolean;
}

export interface FileContent {
  path: string;
  text: string;
  /** Bytes read. Equal to the file's size, because an oversized file is refused, not clipped. */
  bytes: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: FileError };

/** The default cap on entries returned for one directory, so a huge tree cannot stall the tab. */
export const DEFAULT_ENTRY_LIMIT = 2000;

/**
 * Is `child` the same path as `parent`, or inside it?
 *
 * Compared on **path segments**, not string prefixes: `contains("/a/b", "/a/bc")` is false, which a
 * bare `startsWith` gets wrong. ADR-0007 forbids prefix comparison for exactly this reason, and
 * this repository has already been bitten by the prefix form once (`own-installation.ts`, issue #25,
 * where `pi-central-dev` looked like it was inside `pi-central`).
 *
 * Both arguments are expected to be resolved (no `..`, no symlinks) — that is the caller's job, and
 * `resolveWithin` is the caller.
 */
export function containsPath(parent: string, child: string): boolean {
  if (parent === child) return true;
  const withSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(withSep);
}

/** Turn an errno into a {@link FileError}, preserving the code. */
function fromErrno(error: unknown, what: string, relPath: string): FileError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const label = relPath === "" ? "the working directory" : `"${relPath}"`;
  switch (code) {
    case "ENOENT":
      return { reason: "not-found", code, message: `${what} ${label}: no such file or directory (ENOENT)` };
    case "EACCES":
    case "EPERM":
      return { reason: "permission", code, message: `${what} ${label}: permission denied (${code})` };
    case "ENOTDIR":
      return { reason: "not-a-directory", code, message: `${what} ${label}: not a directory (ENOTDIR)` };
    case "EISDIR":
      return { reason: "is-directory", code, message: `${what} ${label}: is a directory (EISDIR)` };
    default:
      // No code, or one not worth special-casing. The code is still reported when present; what is
      // forbidden is inventing one.
      return {
        reason: "unreadable",
        code,
        message: code === undefined ? `${what} ${label}: ${String(error)}` : `${what} ${label}: ${String(error)} (${code})`,
      };
  }
}

/**
 * Resolve a UI-supplied relative path against the session's cwd, refusing anything outside it.
 *
 * The order is the security property, so it is not rearranged for tidiness:
 *
 *   1. Reject absolute paths and NUL bytes outright.
 *   2. `resolve()` the candidate — this is what collapses `..`, so `../x` becomes a sibling that
 *      step 3 can then reject.
 *   3. Check containment against the root *lexically*, which catches `..` before any I/O.
 *   4. `realpathSync()` — this is where symlinks are followed, and it fails if nothing is there.
 *   5. Check containment **again** against the resolved root. A symlink that pointed outside is a
 *      real path outside, so it is refused here.
 *
 * Steps 3 and 5 overlap for a path that EXISTS — `realpath` resolves `..` too, so 5 would refuse an
 * escaping path with or without 3. 3 is kept for two reasons, both about the ANSWER rather than the
 * verdict:
 *
 *   - It refuses without touching the disk. `../does-not-exist` would otherwise report `not-found`,
 *     which describes the child rather than the escape and sends the reader to the wrong fix. This
 *     is the same failure shape as a permission error reported as a missing directory.
 *   - It runs before `realpathSync` on the ROOT, so a cwd that has been deleted still reports as a
 *     missing working directory rather than as a path that escaped.
 */
export function resolveWithin(root: string, relative: string): Result<{ path: string; relPath: string }> {
  if (typeof relative !== "string" || relative.includes("\0")) {
    // `invalid-path`, not `escapes-cwd`: a NUL byte is malformed input, not a boundary violation.
    // Calling it an escape names a place the path never reached and sends the reader to the wrong
    // fix — the same misreporting as a permission failure shown as a missing file.
    return {
      ok: false,
      error: {
        reason: "invalid-path",
        message: "the path contains a NUL byte, which no filesystem path can",
      },
    };
  }
  if (isAbsolute(relative)) {
    // Refused rather than interpreted. The UI deals only in paths relative to the session's cwd, so
    // an absolute one means a caller is confused — and "it happened to be inside the root" would be
    // a coincidence, not a guarantee.
    return {
      ok: false,
      error: {
        reason: "absolute-path",
        message: `"${relative}" is an absolute path; paths are relative to the session's working directory`,
      },
    };
  }

  const relPath = normalizeRelative(relative);

  // The root must itself resolve; a session whose cwd has been deleted is a distinct failure from a
  // bad child path, so it is reported as one.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    return { ok: false, error: fromErrno(error, "the session's working directory is unavailable:", "") };
  }

  const candidate = resolve(realRoot, relPath);
  // Lexical containment first: catches `..` with no filesystem access at all.
  if (!containsPath(realRoot, candidate)) {
    return {
      ok: false,
      error: {
        reason: "escapes-cwd",
        message: `"${relative}" resolves outside the session's working directory`,
      },
    };
  }

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (error) {
    return { ok: false, error: fromErrno(error, "cannot open", relPath) };
  }

  // Containment again, on the RESOLVED path. This is the symlink check: a link inside the tree that
  // points out of it resolves to a target outside, and only here is that visible.
  if (!containsPath(realRoot, real)) {
    return {
      ok: false,
      error: {
        reason: "escapes-cwd",
        message:
          `"${relative}" is a symlink whose target lies outside the session's working directory, ` +
          `so it is refused rather than followed`,
      },
    };
  }

  return { ok: true, value: { path: real, relPath } };
}

/**
 * Normalize a relative path for display and comparison.
 *
 * `""` and `"."` both mean the cwd itself, so they collapse to `""` — one spelling, so the UI's
 * "which directory am I in" comparison cannot fail on a cosmetic difference. Separators are
 * normalized to `/` so a relative path is comparable regardless of platform.
 */
export function normalizeRelative(relative: string): string {
  const parts: string[] = [];
  for (const part of relative.split(/[/\\]+/)) {
    if (part === "" || part === ".") continue;
    // `..` is deliberately NOT collapsed here. `resolve()` in `resolveWithin` is what handles it,
    // and collapsing it by hand would hide an escape from the containment check rather than expose
    // it. Keeping the segment means `../x` stays a path that step 3 refuses.
    parts.push(part);
  }
  return parts.join("/");
}

/** Hidden means dot-prefixed, which is the convention on every platform this runs on. */
export function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/**
 * List one directory, confined to `root`.
 *
 * Not recursive: directories are expanded lazily by the caller, one level per request. A recursive
 * walk would read the whole tree on every open, which is both slow and a much larger read than the
 * user asked for.
 */
export function listDirectory(
  root: string,
  relative: string,
  options: { includeHidden?: boolean; limit?: number } = {},
): Result<DirListing> {
  const resolvedPath = resolveWithin(root, relative);
  if (!resolvedPath.ok) return resolvedPath;
  const { path, relPath } = resolvedPath.value;

  const limit = options.limit ?? DEFAULT_ENTRY_LIMIT;
  const includeHidden = options.includeHidden ?? false;

  let names: string[];
  try {
    names = readdirSync(path);
  } catch (error) {
    return { ok: false, error: fromErrno(error, "cannot list", relPath) };
  }

  const entries: DirEntry[] = [];
  let truncated = false;

  for (const name of names) {
    if (!includeHidden && isHidden(name)) continue;
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
    entries.push(describeEntry(join(path, name), name));
  }

  // Directories first, then by name. Case-insensitive so `README` and `readme.md` sort together,
  // which is what a person expects from a file tree even on a case-sensitive volume.
  entries.sort((a, b) => {
    const aDir = a.kind === "directory" ? 0 : 1;
    const bDir = b.kind === "directory" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return { ok: true, value: { path: relPath, entries, truncated } };
}

/** `lstat`, so a symlink is reported as a symlink rather than as whatever it points at. */
function describeEntry(fullPath: string, name: string): DirEntry {
  try {
    const stats = lstatSync(fullPath);
    if (stats.isSymbolicLink()) {
      // Whether it is safe to enter is decided when it IS entered (`resolveWithin`), not here — a
      // link pointing inside the tree is perfectly usable, and refusing it at listing time would
      // hide a legitimate path. What IS decided here is what the link points at, so the UI can tell
      // an enterable link from a file-like one and from a broken one.
      return { name, kind: "symlink", linkTarget: linkTargetOf(fullPath), hidden: isHidden(name) };
    }
    if (stats.isDirectory()) return { name, kind: "directory", hidden: isHidden(name) };
    if (stats.isFile()) return { name, kind: "file", size: stats.size, hidden: isHidden(name) };
    return { name, kind: "other", hidden: isHidden(name) };
  } catch {
    return { name, kind: "other", hidden: isHidden(name), unreadable: true };
  }
}

/**
 * What a symlink points at, following it.
 *
 * `stat`, not `lstat` — that is the whole point. A dangling link reports `missing` rather than
 * throwing: a broken link is a fact worth showing, not a read error, and the entry still exists.
 */
function linkTargetOf(fullPath: string): "file" | "directory" | "other" | "missing" {
  try {
    const stats = statSync(fullPath);
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}

/**
 * Read a text file, confined to `root`.
 *
 * Three refusals, each of which the issue requires to be *stated* rather than worked around:
 *
 *   - **Too large** — `too-large`, with the size. Not a clipped read: see {@link MAX_FILE_BYTES}.
 *   - **Binary** — `binary`. Detected two ways, because either alone misses a class: a NUL byte in
 *     the head (git's heuristic), and a failing strict UTF-8 decode. The decode is what prevents the
 *     replacement-character rendering the issue names, since a file that is not valid UTF-8 would
 *     otherwise be shown as a corrupted version of itself.
 *   - **A directory** — `is-directory`, rather than an EISDIR surfacing as a generic failure.
 */
export function readFileText(root: string, relative: string): Result<FileContent> {
  const resolvedPath = resolveWithin(root, relative);
  if (!resolvedPath.ok) return resolvedPath;
  const { path, relPath } = resolvedPath.value;

  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    return { ok: false, error: fromErrno(error, "cannot open", relPath) };
  }
  if (stats.isDirectory()) {
    return { ok: false, error: { reason: "is-directory", message: `"${relPath}" is a directory` } };
  }
  if (stats.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: {
        reason: "too-large",
        message:
          `"${relPath}" is ${formatBytes(stats.size)}, above the ${formatBytes(MAX_FILE_BYTES)} limit ` +
          `for reading a file here, so it was not read`,
      },
    };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    return { ok: false, error: fromErrno(error, "cannot read", relPath) };
  }

  const sniff = buffer.subarray(0, BINARY_SNIFF_BYTES);
  if (sniff.includes(0)) {
    // The SIZE is named, because a refusal has to say enough for the reader to know what they are
    // looking at (issue #9: "reported as binary with its size"). We know it exactly — `lstat` was
    // consulted for the cap above — so withholding it would be a choice, not a limitation.
    return {
      ok: false,
      error: {
        reason: "binary",
        message:
          `"${relPath}" is a binary file of ${formatBytes(stats.size)} (it contains NUL bytes), ` +
          `so it was not rendered as text`,
      },
    };
  }

  let text: string;
  try {
    // `fatal` is the point: a lenient decode would produce U+FFFD replacement characters, which is
    // precisely the "rendered as replacement characters" failure the issue calls out.
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return {
      ok: false,
      error: {
        reason: "binary",
        message: `"${relPath}" is ${formatBytes(stats.size)} and not valid UTF-8, so it was not rendered as text`,
      },
    };
  }

  return { ok: true, value: { path: relPath, text, bytes: buffer.byteLength } };
}

