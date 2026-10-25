/**
 * Session registry.
 *
 * Pi has no daemon, no attach protocol, no socket registry (C3). A session is
 * visible to Pi Central only if Pi Central spawned it, or if Pi Central reads
 * its file. This prototype does two things:
 *
 *   - discovers historical sessions by reading ~/.pi/agent/sessions/<encoded>/*.jsonl
 *   - starts live sessions itself, and is the only source of truth for "running"
 *
 * The directory encoding is Pi's: strip the leading slash, replace / and : with
 * '-', wrap in '--'. Derived from dist/core/session-manager.js
 * (getDefaultSessionDirPath), and verified against this machine's layout.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface HistoricalSession {
  path: string;
  id: string;
  cwd: string;
  created: string;
  modifiedMs: number;
  bytes: number;
  firstUserText: string;
}

export function sessionsRoot(): string {
  return process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions");
}

/** Mirror Pi's directory encoding for a working directory. */
export function encodeSessionDir(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function decodeSessionDir(dir: string): string {
  const inner = dir.replace(/^--/, "").replace(/--$/, "");
  return `/${inner.replace(/-/g, "/")}`;
}

interface Header {
  type?: string;
  cwd?: string;
  id?: string;
  timestamp?: string;
}

/**
 * Read only the header line (and a little more, for a preview). Session files
 * can be large, so this never loads a whole transcript.
 */
function readSessionHead(path: string): HistoricalSession | null {
  let text: string;
  let bytes: number;
  let modifiedMs: number;
  try {
    const stats = statSync(path);
    const size = Math.min(stats.size, 64 * 1024);
    text = readFileSync(path).subarray(0, size).toString("utf8");
    bytes = stats.size;
    modifiedMs = stats.mtimeMs;
  } catch {
    return null;
  }

  const lines = text.split("\n");
  let header: Header | null = null;
  let firstUserText = "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!header && rec.type === "session") {
      header = rec as Header;
      continue;
    }
    if (!firstUserText && rec.type === "message") {
      const message = rec.message as { role?: string; content?: unknown } | undefined;
      if (message?.role === "user") {
        firstUserText = flatten(message.content).slice(0, 160);
      }
    }
    if (header && firstUserText) break;
  }

  if (!header?.id) return null;
  return {
    path,
    id: header.id,
    cwd: header.cwd ?? decodeSessionDir(basename(join(path, ".."))),
    created: header.timestamp ?? "",
    modifiedMs,
    bytes,
    firstUserText,
  };
}

function flatten(content: unknown): string {
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

/** All persisted sessions, newest first. */
export function listHistorical(limit = 200): HistoricalSession[] {
  const root = sessionsRoot();
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const found: HistoricalSession[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(join(root, dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const parsed = readSessionHead(join(root, dir, file));
      if (parsed) found.push(parsed);
    }
  }
  found.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return found.slice(0, limit);
}
