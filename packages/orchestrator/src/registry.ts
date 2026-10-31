/**
 * Session discovery (ADR-0009).
 *
 * Pi Central reads `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl` directly. It does NOT call
 * `SessionManager.listAll()`, which is a runtime import that would load Pi's agent core into
 * this unsandboxed, privileged process (ADR-0002/ADR-0009).
 *
 * Deliberate limits:
 *   - exactly one level of directories under the root; no recursive walk
 *   - only regular files ending in `.jsonl` (see the trap below)
 *   - at most `HEAD_BYTES` of each file is read, so a huge transcript is cheap to skip
 *
 * ## The sidecar-directory trap
 *
 * Pi creates a sidecar directory next to each session file, named after the session with
 * the `.jsonl` suffix dropped, holding subagent runs:
 *
 *     <project>/
 *       2026-…_<id>.jsonl          <- the session file
 *       2026-…_<id>/               <- sidecar DIR (no .jsonl suffix)
 *         <uuid>/run-0/session.jsonl
 *
 * The directory name has no `.jsonl` suffix, so a suffix filter already excludes it. The
 * real hazard is **recursion**: a walk that descended into the sidecar would surface every
 * subagent `run-0/session.jsonl` as a top-level session. So this module enumerates exactly
 * one level and takes only regular files. `isFile()` is checked rather than assumed; it
 * costs one call and makes the invariant explicit instead of incidental.
 */
import { createReadStream, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { HistoricalSession } from "@pi-central/protocol";
import { isScratch, type Config } from "./config.ts";

/** Pi's session header. Versioned; asserted on read. */
export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export const KNOWN_SESSION_VERSIONS = new Set([3]);

/**
 * How much of a session file discovery is willing to read.
 *
 * Discovery is a *list* operation over hundreds of files, so it caps its read rather than
 * scanning each transcript to the end. The cost of that choice is stated plainly:
 *
 *   - `messageCount` is a FLOOR, not exact, for sessions larger than this window
 *   - `name` is best-effort; `session_info` can appear anywhere, so a name set late in a
 *     large session will not be seen
 *
 * Measured on this machine: 833 real sessions in ~900 ms, 0 unparseable. Scanning every
 * file to the end would be correct and several times slower for a field the rail does not
 * need yet. The floor can be visibly wrong: for one 2.8 MB session the head window counted
 * 69 messages of 869 records (429 user+assistant). That is why a live session's count is
 * corrected from `get_state`, which is authoritative, the moment it is supervised.
 *
 * Full counts and names belong to a full read, which happens when a session is opened, not
 * when the list is drawn.
 */
const HEAD_BYTES = 256 * 1024;

/**
 * How much of the END of a large session file is read, for a name set late (issue #164).
 *
 * ## Why the head alone was not enough
 *
 * Pi stores a session's name as a `session_info` record, appended wherever the rename happened — and a rename
 * appends at the END. `HEAD_BYTES` is 256 KB, so a name given to a session larger than that was never seen:
 * `registry.ts` used to say so itself ("a name set late in a large session will not be seen").
 *
 * Measured on this machine: 272 of 873 sessions are larger than the window, so **31% of sessions could not show
 * a rename in History at all**, however often the app reconnected. The session header carries no name — only
 * `cwd`, `id`, `timestamp`, `type`, `version` — so there is no cheaper fallback.
 *
 * ## Why this is not a full read
 *
 * The window exists so a huge transcript is cheap to skip. This is one extra read per LARGE file, of a few KB,
 * and only when the file is bigger than the head window. A `session_info` line is well under a kilobyte; 8 KB of
 * tail holds the last few hundred records, which is where a rename sits.
 */
const TAIL_BYTES = 8 * 1024;

/** Mirror Pi's directory encoding: strip leading slash, replace `/` and `:` with `-`. */
export function encodeSessionDir(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Best-effort inverse, used only when a header lacks a cwd (old sessions). */
export function decodeSessionDir(dirName: string): string {
  const inner = dirName.replace(/^--/, "").replace(/--$/, "");
  return `/${inner.replace(/-/g, "/")}`;
}

/**
 * The name from the LAST `session_info` in a file's tail, or `undefined`.
 *
 * The tail can begin in the middle of a record — the read starts at an arbitrary byte — so the first (possibly
 * partial) line is discarded rather than parsed. A partial JSON line would otherwise be the one case that makes
 * this throw on a perfectly good file.
 */
async function readLateSessionName(path: string): Promise<string | undefined> {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return undefined;
  }
  const start = Math.max(0, stats.size - TAIL_BYTES);
  if (start === 0) return undefined;

  const text = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start, end: stats.size - 1 });
    stream.on("data", (chunk) => chunks.push(chunk as Buffer));
    // A tail that cannot be read is not a reason to lose the session: the head's name is still valid.
    stream.on("error", () => resolve(""));
    stream.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  if (text === "") return undefined;

  const lines = text.split("\n");
  // Drop the first line: it is almost certainly a fragment of a record that began before `start`.
  lines.shift();
  let name: string | undefined;
  for (const line of lines) {
    if (!line.includes('"session_info"')) continue;
    try {
      const record = JSON.parse(line) as { type?: unknown; name?: unknown };
      if (record.type === "session_info" && typeof record.name === "string") {
        const trimmed = record.name.trim();
        if (trimmed.length > 0) name = trimmed;
      }
    } catch {
      continue;
    }
  }
  return name;
}

/** Read up to HEAD_BYTES of a file as utf8, streamed so a large file is not loaded whole. */
async function readHead(path: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = createReadStream(path, { start: 0, end: HEAD_BYTES - 1 });
    stream.on("data", (chunk) => {
      chunks.push(chunk as Buffer);
      size += (chunk as Buffer).length;
    });
    stream.on("error", () => resolve(""));
    stream.on("close", () => resolve(Buffer.concat(chunks, size).toString("utf8")));
  });
}

interface ParsedHead {
  header: SessionHeader;
  name: string | undefined;
  firstMessage: string;
  messageCount: number;
}

/**
 * Parse the records we need from the head window.
 *
 * `messageCount` is a lower bound and `name` is best-effort — see `HEAD_BYTES`. Both are
 * reported as found, never inflated.
 */
function parseHead(text: string): ParsedHead | null {
  const lines = text.split("\n");
  let header: SessionHeader | null = null;
  let name: string | undefined;
  let firstMessage = "";
  let messageCount = 0;

  for (const line of lines) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (!header) continue;
      break; // a partial trailing line; stop rather than mis-count
    }
    if (!header) {
      if (record.type !== "session") return null;
      if (typeof record.id !== "string" || typeof record.cwd !== "string") return null;
      header = {
        type: "session",
        version: Number(record.version ?? 0),
        id: record.id,
        timestamp: String(record.timestamp ?? ""),
        cwd: record.cwd,
        ...(typeof record.parentSession === "string" ? { parentSession: record.parentSession } : {}),
      };
      continue;
    }
    if (record.type === "session_info" && typeof record.name === "string") {
      name = record.name.trim() || undefined;
      continue;
    }
    if (record.type === "message") {
      messageCount += 1;
      if (!firstMessage) {
        const message = record.message as { role?: string; content?: unknown } | undefined;
        if (message?.role === "user") firstMessage = flattenContent(message.content).slice(0, 200);
      }
    }
  }

  return header ? { header, name, firstMessage, messageCount } : null;
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text);
        return "";
      })
      .join(" ");
  }
  return "";
}

export interface DiscoveryResult {
  sessions: HistoricalSession[];
  /**
   * How many session files exist, BEFORE the `limit` is applied.
   *
   * This exists because the UI states a total as a fact, and passing it the length of a
   * truncated array makes it assert something false. Observed on this machine: 1115 session
   * files, a limit of 500, and a rail reading "500 sessions on disk" -- a misleading machine
   * value stated confidently, which is precisely the class of thing `format.ts` has tests
   * against. A total the caller cannot distinguish from a page size will eventually be shown
   * as one.
   */
  total: number;
  /** Files that looked like sessions but could not be parsed. Surfaced, not hidden. */
  skipped: { path: string; reason: string }[];
}

/** Discover every session file under the configured root, newest first. */
/**
 * Turn one session file into a row, or explain why it cannot be read.
 *
 * Extracted from `discover` so the same rules apply when a SINGLE path is described (see `sessionAt`). The
 * alternative was a second implementation, and two implementations of "is this a valid session file" is the
 * kind of drift that ends with resume accepting a file the History pane refuses to list.
 */
async function describeSessionFile(
  config: Config,
  path: string,
  projectDir: string,
  stats: Stats,
): Promise<{ ok: true; session: HistoricalSession } | { ok: false; reason: string }> {
  const head = await readHead(path);
  const parsed = parseHead(head);
  if (!parsed) return { ok: false, reason: "not a Pi session file (no valid header)" };
  /*
   * The name Pi wrote LAST, which for a large session lives outside the head window (issue #164).
   *
   * Only for files bigger than the head read: for anything smaller the whole file was already parsed, and a second
   * read would be pure cost.
   */
  const lateName = stats.size > HEAD_BYTES ? await readLateSessionName(path) : undefined;
  if (!KNOWN_SESSION_VERSIONS.has(parsed.header.version)) {
    return { ok: false, reason: `unknown session version ${parsed.header.version}` };
  }
  const cwd = parsed.header.cwd || decodeSessionDir(projectDir);
  return {
    ok: true,
    session: {
      path,
      id: parsed.header.id,
      cwd,
      // The late name wins: it is the most recent rename, and the head's is the earliest one.
      ...((lateName ?? parsed.name) ? { name: (lateName ?? parsed.name)! } : {}),
      created: parsed.header.timestamp,
      modifiedMs: stats.mtimeMs,
      bytes: stats.size,
      messageCount: parsed.messageCount,
      firstMessage: parsed.firstMessage,
      cwdExists: directoryExists(cwd),
      scratch: isScratch(config, cwd),
    },
  };
}

/**
 * Describe ONE session file by path — the lookup `resume` needs, and the reason it exists.
 *
 * ## The bug this fixes
 *
 * `resume` used to do `const discovered = await discover(config)` and then
 * `.find((s) => s.path === control.path)`. `discover` returns `sessions.slice(0, 500)`, so resuming any
 * session outside the newest 500 reported **"no such session"** for a file that plainly exists — on a machine
 * with 867 sessions, every session older than the most recent 500 was unresumable, with an error that named
 * the wrong cause.
 *
 * ## Why this does not just call `discover(config, Infinity)`
 *
 * Because that walks and parses the entire store to find one file: it is the eager-work problem in #150,
 * performed on a click. This reads exactly one header.
 *
 * ## Containment
 *
 * The path arrives from the client, so it is not trusted. It must resolve INSIDE `config.sessionsRoot`, and
 * containment is checked on `realpath` as well as lexically — the same two-step `files.ts` uses, for the same
 * reason: a symlink inside the store must not let a request reach outside it. The unit of the boundary is the
 * DIRECTORY, per C15c, not a name list.
 */
export async function sessionAt(config: Config, requested: string): Promise<HistoricalSession | undefined> {
  if (typeof requested !== "string" || requested.length === 0 || requested.includes("\u0000")) return undefined;

  let root: string;
  let real: string;
  try {
    root = realpathSync(config.sessionsRoot);
    real = realpathSync(resolve(requested));
  } catch {
    // A missing file, an unreadable store, or a broken symlink are all "cannot resume this", not an error that
    // should reach the user as a stack trace.
    return undefined;
  }

  // Lexical containment on the RESOLVED paths, by segment rather than prefix: `/a/bc` must not satisfy a
  // boundary of `/a/b`.
  const inside = (parent: string, child: string): boolean =>
    child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  if (!inside(root, real)) return undefined;
  if (!real.endsWith(".jsonl")) return undefined;

  let stats: Stats;
  try {
    stats = statSync(real);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) return undefined;

  // The project directory is the segment of the SESSIONS ROOT the file sits in, used for `decodeSessionDir`
  // when a header carries no `cwd`. Taken from the stored path, not the client's string.
  const projectDir = basename(dirname(real));
  const row = await describeSessionFile(config, real, projectDir, stats);
  return row.ok ? row.session : undefined;
}

export async function discover(config: Config, limit = 500): Promise<DiscoveryResult> {
  const sessions: HistoricalSession[] = [];
  const skipped: { path: string; reason: string }[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(config.sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { sessions, total: 0, skipped }; // no sessions yet is not an error
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(config.sessionsRoot, projectDir);
    let entries;
    try {
      entries = readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.name.endsWith(".jsonl")) continue;
      // The trap: a sidecar directory holds subagent runs. Its name has no `.jsonl` suffix,
      // so the check above already excludes it -- but assert regularity explicitly, and
      // never recurse, so a nested run-0/session.jsonl can never be surfaced as a session.
      if (!entry.isFile()) continue;

      const path = join(projectPath, entry.name);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }

      const row = await describeSessionFile(config, path, projectDir, stats);
      if (!row.ok) {
        skipped.push({ path, reason: row.reason });
        continue;
      }
      sessions.push(row.session);
    }
  }

  sessions.sort((a, b) => b.modifiedMs - a.modifiedMs);
  // `total` is measured after the sort but before the slice, so it is the true count rather
  // than the size of the page returned.
  return { sessions: sessions.slice(0, limit), total: sessions.length, skipped };
}

function directoryExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
