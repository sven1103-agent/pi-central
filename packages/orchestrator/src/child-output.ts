/**
 * Reading a dead child's last words (shared by sessions and sidecars).
 *
 * ## Why this is its own module
 *
 * Both a session and a sidecar are child processes, and both fail the same way: the useful line is written to
 * stderr as the process dies, and the reader is told only that it died. This logic used to live in `supervisor.ts`,
 * which imports `sidecar-supervise.ts` — so the sidecar could not reuse it without an import cycle. It is here so
 * there is ONE reading of "what did it say before it died", not two that drift.
 *
 * ## Why `EXIT_REASON_PREFIX` is a parameter
 *
 * `exitReason` opens with `pi exited (code=…)`. That is right for a session and wrong for a sidecar: a reader
 * looking at a session browser failure would be told `pi` had exited, which names the wrong process and sends them
 * to the wrong log. The wording is the caller's, the decoding is not.
 */

/**
 * How many stderr lines survive into a failure message.
 *
 * Sized so the cause and its immediate context fit, and bounded so a wall of startup chatter cannot bury it.
 */
export const STDERR_TAIL_LINES = 12;

/** The conventional short name for a signal number, for the ones a process plausibly dies from. */
function signame(number: number): string | undefined {
  const names: Record<number, string> = {
    1: "SIGHUP",
    2: "SIGINT",
    3: "SIGQUIT",
    6: "SIGABRT",
    9: "SIGKILL",
    11: "SIGSEGV",
    13: "SIGPIPE",
    15: "SIGTERM",
  };
  return names[number];
}

/**
 * The first line of a failure message: what ended the process.
 *
 * `code` is the exit status and `signal` the terminating signal, and they are rarely both populated: a shell
 * wrapping a killed child exits `128 + n`, so nobody sees `SIGKILL` — only `137`. Decoding it is the difference
 * between a number and a sentence. The raw numbers are kept, because they are the evidence.
 *
 * `what` names the process in the message. It defaults to `pi` because a session is the common caller; a sidecar
 * passes its own name so the sentence cannot be misleading.
 */
export function exitReason(
  code: number | null,
  signal: string | null,
  what = "pi",
): string {
  const raw = `${what} exited (code=${code ?? "-"}, signal=${signal ?? "-"})`;
  if (signal) return `${raw} — killed by ${signal}`;
  // `128 + n` is how a SHELL reports a signalled child. Naming it is a reading of the number, not a guess about
  // intent: a kill and an OOM kill both land here, which is why the number is kept alongside the name.
  if (code !== null && code > 128 && code <= 128 + 64) {
    const name = signame(code - 128);
    if (name !== undefined) return `${raw} — killed by ${name}`;
  }
  return raw;
}

/**
 * The last lines of stderr, with a count of what was dropped.
 *
 * Trimmed from the TOP rather than the bottom because the cause is usually at the end: a process writes its banner
 * as it starts and the fatal line as it dies.
 */
export function boundedTail(stderr: string): string {
  const text = stderr.replace(/\s+$/, "");
  if (text === "") return "";
  const lines = text.split("\n");
  if (lines.length <= STDERR_TAIL_LINES) return text;
  const kept = lines.slice(-STDERR_TAIL_LINES);
  const omitted = lines.length - STDERR_TAIL_LINES;
  return `… ${omitted} earlier line${omitted === 1 ? "" : "s"} of output omitted\n${kept.join("\n")}`;
}

/**
 * The last lines of a killed child's stderr, WITHOUT losing the line that names the cause.
 *
 * `boundedTail` alone is wrong for an uncaught exception, and that is measured rather than supposed. Node prints
 * `Error: listen EADDRINUSE: address already in use 127.0.0.1:47816` as the FIRST line and follows it with a
 * twenty-line stack; the `code: 'EADDRINUSE'` line is near the BOTTOM. Twelve bottom lines of that output contain
 * a stack frame or two and the node version, and not one word about a port. Rejecting a sidecar with that tail
 * would be the same "it failed, look elsewhere" the whole fix exists to remove.
 *
 * So: the first non-blank line is kept, then the bounded tail. When the tail already begins with that line the
 * result is unchanged — no duplication, and `boundedTail` still owns the ordinary case.
 */
export function failureTail(stderr: string): string {
  const text = stderr.replace(/\s+$/, "");
  if (text === "") return "";
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  const tail = boundedTail(text);
  if (first === "" || tail.startsWith(first)) return tail;
  return `${first}\n${tail}`;
}
