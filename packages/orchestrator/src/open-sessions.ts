/**
 * Which sessions were open, remembered across a restart (issue #185).
 *
 * ## Why this file exists
 *
 * The supervisor's state is entirely in memory: `#sessions` and `#processes` die with the process,
 * and shutdown calls `stopAll()`. So the update dance — stop the orchestrator, `npm install`,
 * restart — brought the app back with **every working session gone**. The roster (issue #89) kept
 * the *rows*, because those live in `localStorage`, but every row came back stopped: nothing
 * re-spawned anything, and resuming a dozen sessions by hand after every update is the frustration
 * users actually reported.
 *
 * C3 is why this is a *list* and not a mechanism: sessions are files plus private stdio, and there
 * is no daemon and no attach. Restoration means re-spawning, which `Supervisor.resume` already
 * does — including its refusal to retarget a session's directory (ADR-0008) and its check that the
 * directory still exists before spawning anything (C2).
 *
 * ## What is recorded, and what is deliberately not
 *
 * Only `{sessionFile, mode}`. The file is the durable identity of a conversation (ADR-0004), and
 * `mode` matters because a session started `--direct` must not silently come back sandboxed (or the
 * reverse: a sandboxed session must never come back unsandboxed, which would be a privilege change
 * nobody asked for).
 *
 * Deliberately absent: `enable` and `env`. Neither is part of `LiveSession`, so a restart cannot
 * reproduce a per-spawn login grant — the same limitation `Supervisor.retry` states rather than
 * hides. A restored session may have fewer capabilities than the original, which is visible in the
 * composer when a credential is missing.
 *
 * The `id` is not recorded either: Pi Central's `sN` handles are per-process, and reusing one would
 * address a different conversation after a restart (the same "keyed by handle" mistake `roster.ts`
 * documents).
 *
 * ## Eager writes, not a shutdown hook
 *
 * Entries are written when a session becomes known and removed on an **explicit** stop. A shutdown
 * is not forgetting — `stopAll({ forget: false })` — so Ctrl-C keeps the set for the next launch,
 * and an orchestrator killed with SIGKILL (which gets no hook at all) is still restorable. Wiring
 * this to shutdown instead would make the feature work for the tidy case and fail for the crash.
 *
 * ## A corrupt file is an empty set
 *
 * This is convenience state about *which* conversations to reopen, and the conversations themselves
 * are untouched on disk. Refusing to start because this file is unreadable would trade a minor loss
 * for a total one, so a parse failure is reported to the caller as a note and read as "nothing was
 * open".
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The same session file, spelled one way.
 *
 * **This is not tidiness; without it the store silently holds one conversation twice.** `sessionAt`
 * resolves a requested path through `realpathSync` (a symlinked store, and on macOS `/var` vs
 * `/private/var`), so the path a restore hands back is not always the path that was written. Keyed
 * by the raw string, one conversation becomes two entries — and two entries mean two `pi` processes
 * appending to one file on the next launch, which is the branch point ADR-0004 exists to prevent.
 *
 * `realpathSync` where the file exists (the honest canonical answer) and `resolve` where it does
 * not (a session whose store is not mounted still has to be remembered and compared consistently).
 */
export function normalizeSessionFile(sessionFile: string): string {
  try {
    return realpathSync(sessionFile);
  } catch {
    return resolve(sessionFile);
  }
}

/** One session to try to reopen. */
export interface OpenSession {
  /** The Pi session file — the conversation's durable identity (ADR-0004). */
  sessionFile: string;
  /** How it was launched, so a sandboxed session never returns unsandboxed. */
  mode: "sandboxed" | "direct";
}

/** Where the list lives, under Pi Central's own state root (Q7 — never inside `~/.pi`). */
export function openSessionsPath(stateRoot: string): string {
  return join(stateRoot, "open-sessions.json");
}

/** The file's shape. Versioned so a future change can be recognised rather than guessed at. */
interface StoredShape {
  version: 1;
  sessions: OpenSession[];
}

/**
 * Read the remembered set, tolerating every failure.
 *
 * Duplicate session files are collapsed (last wins, which is the most recent statement about that
 * conversation): a file can legitimately be recorded twice if a session is stopped and resumed
 * inside one orchestrator's life, and reopening one conversation twice is exactly the
 * two-processes-one-file branch point ADR-0004 refuses.
 */
export function readOpenSessions(stateRoot: string): { sessions: OpenSession[]; note?: string } {
  const path = openSessionsPath(stateRoot);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // Absent is the normal first-run case, not a fault.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [] };
    return { sessions: [], note: `could not read ${path}: ${(error as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { sessions: [], note: `${path} is not valid JSON, so no sessions were restored` };
  }
  const shape = parsed as Partial<StoredShape> | null;
  if (typeof shape !== "object" || shape === null || shape.version !== 1 || !Array.isArray(shape.sessions)) {
    return { sessions: [], note: `${path} is not a recognised open-sessions file, so no sessions were restored` };
  }

  const byFile = new Map<string, OpenSession>();
  for (const entry of shape.sessions) {
    if (typeof entry !== "object" || entry === null) continue;
    const { sessionFile, mode } = entry as Partial<OpenSession>;
    if (typeof sessionFile !== "string" || sessionFile.length === 0) continue;
    if (sessionFile.includes("\u0000")) continue;
    // An unknown mode is read as `sandboxed`: the safe direction, since the alternative would be
    // silently granting a session more access than it was launched with.
    const canonical = normalizeSessionFile(sessionFile);
    byFile.set(canonical, { sessionFile: canonical, mode: mode === "direct" ? "direct" : "sandboxed" });
  }
  return { sessions: [...byFile.values()] };
}

/**
 * Write the set, atomically.
 *
 * The tmp-then-rename pair is not ceremony: a crash mid-write on a truncating write leaves an empty
 * file, and an empty file reads as "nothing was open" — the exact data loss this feature exists to
 * prevent. `rename` within one directory is atomic on every platform Pi Central runs on.
 *
 * Failures are reported rather than thrown. Losing the list costs one restart's worth of
 * convenience; killing a running orchestrator over it would cost the sessions themselves.
 */
export function writeOpenSessions(stateRoot: string, sessions: OpenSession[]): { ok: true } | { ok: false; message: string } {
  const path = openSessionsPath(stateRoot);
  const body: StoredShape = { version: 1, sessions };
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `could not write ${path}: ${(error as Error).message}` };
  }
}

/**
 * The remembered set, held in memory and written on every change.
 *
 * A tiny wrapper rather than calls sprinkled through the supervisor: every mutation has to write,
 * and a mutation added later that forgot to would be invisible until the next update — which is
 * precisely the bug being fixed. There is one `#changed()`, and it ends in a write.
 */
export class OpenSessionStore {
  #stateRoot: string;
  #entries = new Map<string, OpenSession>();
  #warned = false;

  constructor(stateRoot: string) {
    this.#stateRoot = stateRoot;
  }

  /**
   * Load the remembered set from disk, reporting anything the reader should know.
   *
   * Separate from the constructor because it touches the filesystem and can produce a note the
   * startup log must print — the same shape `readOpenSessions` returns.
   */
  load(): { sessions: OpenSession[]; note?: string } {
    const { sessions, note } = readOpenSessions(this.#stateRoot);
    this.#entries = new Map(sessions.map((entry) => [entry.sessionFile, entry]));
    return note === undefined ? { sessions } : { sessions, note };
  }

  /** Every remembered session, in insertion order. */
  list(): OpenSession[] {
    return [...this.#entries.values()];
  }

  has(sessionFile: string): boolean {
    return this.#entries.has(normalizeSessionFile(sessionFile));
  }

  /** Remember a session. A no-op (and no write) when nothing changed. */
  remember(sessionFile: string | undefined, mode: "sandboxed" | "direct"): void {
    if (sessionFile === undefined) return;
    const canonical = normalizeSessionFile(sessionFile);
    const existing = this.#entries.get(canonical);
    if (existing !== undefined && existing.mode === mode) return;
    this.#entries.set(canonical, { sessionFile: canonical, mode });
    this.#changed();
  }

  /** Forget a session — an EXPLICIT stop, never a shutdown. */
  forget(sessionFile: string | undefined): void {
    if (sessionFile === undefined) return;
    if (!this.#entries.delete(normalizeSessionFile(sessionFile))) return;
    this.#changed();
  }

  /**
   * Write the current set.
   *
   * The warning is printed once per process: a state root that cannot be written would otherwise
   * produce a line on every session start and stop, which trains a reader to ignore it.
   */
  #changed(): void {
    const result = writeOpenSessions(this.#stateRoot, this.list());
    if (result.ok || this.#warned) return;
    this.#warned = true;
    console.error(`Sessions will not be restored after a restart: ${result.message}`);
  }
}
