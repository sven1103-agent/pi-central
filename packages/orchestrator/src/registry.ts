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
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

/** Mirror Pi's directory encoding: strip leading slash, replace `/` and `:` with `-`. */
export function encodeSessionDir(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Best-effort inverse, used only when a header lacks a cwd (old sessions). */
export function decodeSessionDir(dirName: string): string {
  const inner = dirName.replace(/^--/, "").replace(/--$/, "");
  return `/${inner.replace(/-/g, "/")}`;
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

      const parsed = parseHead(await readHead(path));
      if (!parsed) {
        skipped.push({ path, reason: "not a Pi session file (no valid header)" });
        continue;
      }
      if (!KNOWN_SESSION_VERSIONS.has(parsed.header.version)) {
        skipped.push({ path, reason: `unknown session version ${parsed.header.version}` });
        continue;
      }

      const cwd = parsed.header.cwd || decodeSessionDir(projectDir);
      sessions.push({
        path,
        id: parsed.header.id,
        cwd,
        ...(parsed.name ? { name: parsed.name } : {}),
        created: parsed.header.timestamp,
        modifiedMs: stats.mtimeMs,
        bytes: stats.size,
        messageCount: parsed.messageCount,
        firstMessage: parsed.firstMessage,
        cwdExists: directoryExists(cwd),
        scratch: isScratch(config, cwd),
      });
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
