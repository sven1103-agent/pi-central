/**
 * Where the app's own diagnostics go when there is no terminal (issue #218).
 *
 * ## The gap this closes, reported from use
 *
 * Every diagnostic in `main.ts` is a `console.log` or `console.error`, which is correct for `npm run app` — the shell has
 * a terminal and echoing there is free. But the app is *installed* as a bundle, and a bundle launched from Finder has
 * `stdout` attached to nothing. So when the reader reported "⌘Q leaves the window open for ever", the answer was a line
 * that had already been written several times a second:
 *
 *     Pi Central: the orchestrator did not stop within 5000 ms; quitting anyway
 *
 * and it was unreadable, because there was no terminal to read it in. Asking a reader to launch a `.app` from a shell to
 * see the log is asking them to reproduce a different launch path — a Finder launch has launchd's environment, not their
 * shell's, which is exactly the difference that produced three separate bugs in this increment.
 *
 * ## What this does
 *
 * Copies every console line to a file under `~/Library/Logs/Pi Central/`, which is where macOS puts application logs —
 * Console.app lists it, and the reader can open it from the app's own menu. The console is still written to, so
 * `npm run app` behaves exactly as before.
 *
 * ## What it deliberately is not
 *
 * Not a logging framework, and not a place to put untrusted content. It formats one line per call, bounds the file, and
 * stops. The levels, the timestamps and the rotation are here because a log that grows without limit is a bug of its own,
 * and a log without timestamps cannot show a five-second loop as a loop.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the log lives, from the app's own logs directory (`~/Library/Logs/<name>` on macOS). */
export function logPath(logsDirectory: string): string {
  return join(logsDirectory, "main.log");
}

/**
 * Rotate at this size, and keep this many old files.
 *
 * 1 MiB and three files is about 4 MiB total — enough to hold a long session's startup, every quit, and the update
 * attempts, without becoming something a reader has to think about. A loop like the `⌘Q` one fills a file in seconds, so a
 * single unbounded log would be a disk problem rather than a diagnostic.
 */
export const MAX_LOG_BYTES = 1024 * 1024;
export const KEPT_LOG_FILES = 3;

/**
 * Rotate the log if it has grown past {@link MAX_LOG_BYTES}.
 *
 * `main.log` → `main.1.log` → `main.2.log`, oldest dropped. Failures are ignored: a rotation that cannot happen must not
 * stop the app from logging, and the worst case is one file larger than the bound.
 */
export function rotateIfNeeded(path: string, maxBytes = MAX_LOG_BYTES, kept = KEPT_LOG_FILES): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return; // No file yet: nothing to rotate.
  }
  if (size < maxBytes) return;
  // Oldest first, so each rename targets a name that is about to be free.
  try {
    rmSync(`${path}.${kept}`, { force: true });
    for (let index = kept - 1; index >= 1; index -= 1) {
      try {
        renameSync(`${path}.${index}`, `${path}.${index + 1}`);
      } catch {
        // That generation does not exist yet.
      }
    }
    renameSync(path, `${path}.1`);
  } catch {
    // Rotation is best-effort; the file stays and keeps growing.
  }
}

/**
 * One console call, as a line.
 *
 * ## Why the format is fixed rather than `util.inspect`'s default
 *
 * A log is read by a person looking for a sequence — "did it stop, did it wait, did it call quit again" — and that only
 * works if every line starts with a sortable timestamp at a fixed width. Arguments are joined with spaces, and an Error
 * contributes its message *and* its stack, because a stack trace is the only thing that explains the failures this log
 * exists to capture.
 *
 * JSON is deliberately not used. A line of JSON per event is machine-friendly and human-hostile, and this file's reader is
 * a person pasting five lines into an issue.
 */
export function formatLine(level: "log" | "warn" | "error", args: readonly unknown[], now: Date): string {
  const stamp = `${now.toISOString().replace("T", " ").replace("Z", "")}`;
  const text = args.map(describe).join(" ");
  return `${stamp} ${level.toUpperCase().padEnd(5)} ${text}\n`;
}

/** One argument, as text a person can read. */
function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    // Message first, then the stack — and the stack indented, so a multi-line trace does not look like several events.
    const stack = value.stack ?? "";
    return stack === "" ? `${value.name}: ${value.message}` : `${value.name}: ${value.message}\n${stack}`;
  }
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      // A circular structure is not worth failing a log line over.
      return String(value);
    }
  }
  return String(value);
}

/** The console surface this module needs, so the tee is testable without a real console. */
export interface ConsoleLike {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Send every console call to the file as well as to the console.
 *
 * ## Why the original is called FIRST
 *
 * So a slow or failing disk cannot change what a `npm run app` session prints, and so a write failure degrades to
 * "terminal only" rather than to silence. The file write is wrapped, because a log that throws inside `console.error`
 * during an error path is how a diagnostic becomes a second fault.
 *
 * Returns a function that detaches the tee — used by tests, and by nothing in the app.
 */
export function teeConsole(
  console_: ConsoleLike,
  write: (line: string) => void,
  clock: () => Date = () => new Date(),
): () => void {
  const originals = { log: console_.log, warn: console_.warn, error: console_.error };
  const levels = ["log", "warn", "error"] as const;
  for (const level of levels) {
    console_[level] = (...args: unknown[]): void => {
      originals[level](...args);
      try {
        write(formatLine(level, args, clock()));
      } catch {
        // The console already has it. A logging failure must not become the app's problem.
      }
    };
  }
  return () => {
    for (const level of levels) console_[level] = originals[level];
  };
}

/**
 * Prepare the log file and return a writer for it.
 *
 * `undefined` when the directory cannot be created or the file cannot be appended to — the app then runs with console
 * output only, which is what it did before this existed. A missing log is a loss of diagnostics, not a reason to fail to
 * start.
 */
export function openLogWriter(logsDirectory: string): { path: string; write: (line: string) => void } | undefined {
  const path = logPath(logsDirectory);
  try {
    mkdirSync(logsDirectory, { recursive: true });
    rotateIfNeeded(path);
    // A header per run, so a log holding several launches can be read as several launches.
    appendFileSync(path, `\n===== Pi Central started ${new Date().toISOString()} =====\n`, "utf8");
  } catch {
    return undefined;
  }
  return {
    path,
    write: (line: string) => {
      try {
        rotateIfNeeded(path);
        appendFileSync(path, line, "utf8");
      } catch {
        // Dropped. The console has it, and there is nowhere else to report it.
      }
    },
  };
}
