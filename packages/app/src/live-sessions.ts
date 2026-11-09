/**
 * Which sessions are live, asked over the socket rather than invented by the shell (issue #216, criterion 3).
 *
 * ## Why the shell asks at all
 *
 * `⌘Q` has to name what it is about to stop, and ADR-0011 §4 is explicit that a restart "states how many are
 * running and requires confirmation naming them". The shell knows only that *an orchestrator* is running — it
 * has never been told which sessions that process holds. Two candidates:
 *
 *   1. Read `open-sessions.json` from the orchestrator's state root. **Rejected, and it is the wrong answer for
 *      a reason worth stating:** #185 makes that file the record of the *previous* run's set, written eagerly as
 *      sessions become known and cleared only on an explicit stop. It is not a live list, so a session started
 *      in the last second, or one that just failed to spawn, would be missing from the dialog — and the shell
 *      would have invented a count, which is precisely what criterion 3 forbids.
 *   2. Ask the process itself. The orchestrator already sends a **snapshot** containing `live: LiveSession[]` on
 *      every new connection, and that list is `supervisor.list()` verbatim. So the shell opens a socket, keeps
 *      the first snapshot, and closes. One message, no new protocol surface, no second record of what is open.
 *
 * Option 2 is what this file does. It adds nothing to the wire — the control it sends is the connection itself.
 *
 * ## Why the socket is a real WebSocket and not an HTTP call
 *
 * The same-origin rule is the orchestrator's (ADR-0006, C5): the UI is served by the same listener and the socket
 * is the only control channel. There is no `GET /sessions`, and adding one for the shell's convenience would be
 * a second surface for the same facts. The `ws` package is already a dependency of the orchestrator, and this is
 * the client side of a protocol that is already specified.
 *
 * ## What a failure means
 *
 * Nothing. Failing to ask is answered with "no sessions", never with an error dialog: `⌘Q` must remain a `⌘Q`,
 * and a quit that refuses to proceed because a socket did not open would be a worse outcome than a quit that
 * stopped one session without offering to keep it. The distinction is kept in the *log*, where a reader can see
 * why the dialog did not appear.
 */
import type { SessionSummary } from "./runtime-record.ts";

/**
 * The shape this reads from a snapshot's `live` array.
 *
 * Structural, and narrowed at the boundary rather than trusted: the field is another process's JSON, and a shell
 * that spread it straight into a dialog would render whatever a future orchestrator put there — including
 * `undefined`, which the dialog would show as the word "undefined" beside a bullet.
 */
function summarise(entry: unknown): SessionSummary | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const live = entry as { name?: unknown; cwd?: unknown; state?: unknown };
  if (typeof live.name !== "string" || live.name === "") return undefined;
  if (typeof live.cwd !== "string" || live.cwd === "") return undefined;
  if (typeof live.state !== "string") return undefined;
  return { name: live.name, cwd: live.cwd, state: live.state };
}

/** What the ask produced, and why, so `main.ts` can log the second half. */
export interface LiveSessionAnswer {
  sessions: SessionSummary[];
  /** Absent on success. A sentence naming *why* the list may be incomplete, for the log. */
  note?: string;
}

/**
 * The envelope the orchestrator sends, read for the first snapshot.
 *
 * A `hello` arrives first and is skipped; the snapshot is the message with a `live` array. Anything else — an
 * error, an `installFacts` reply, an unknown future event — is not an answer to this question.
 */
export function liveSessionsFrom(message: string): LiveSessionAnswer | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (typeof envelope !== "object" || envelope === null) return undefined;
  const payload = (envelope as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const event = payload as { kind?: unknown; live?: unknown };
  if (event.kind !== "snapshot") return undefined;
  if (!Array.isArray(event.live)) return { sessions: [], note: "the snapshot carried no list of live sessions" };

  const sessions: SessionSummary[] = [];
  let dropped = 0;
  for (const entry of event.live) {
    const summary = summarise(entry);
    if (summary === undefined) {
      dropped += 1;
      continue;
    }
    sessions.push(summary);
  }
  return dropped === 0
    ? { sessions }
    : { sessions, note: `${dropped} live session(s) could not be read from the snapshot and are not named` };
}

/** How long the ask may take. A `⌘Q` that waits longer than this has stopped feeling like a quit. */
export const ASK_TIMEOUT_MS = 2000;

/** The parts of a `ws` socket this file uses. Narrow, so `main.ts` hands over the real thing. */
export interface SocketLike {
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "open", listener: () => void): void;
  close(): void;
}

/** The constructor, injected so the parse-and-give-up logic is testable without a listener. */
export type SocketFactory = (url: string) => SocketLike;

/**
 * Ask a running orchestrator which sessions it holds.
 *
 * Resolves — never rejects. Every outcome is an object, because the caller's next decision (`decideStop`) takes a
 * list and must not need a `try`.
 */
export function askLiveSessions(connect: SocketFactory, url: string, timeoutMs = ASK_TIMEOUT_MS): Promise<LiveSessionAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: SocketLike | undefined;
    const finish = (answer: LiveSessionAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // Closing a socket that already failed is not a second failure.
      }
      resolve(answer);
    };
    const timer = setTimeout(
      () => finish({ sessions: [], note: `the orchestrator did not describe its sessions within ${timeoutMs} ms` }),
      timeoutMs,
    );

    try {
      socket = connect(url);
    } catch (error) {
      finish({ sessions: [], note: `could not open a socket to ${url}: ${(error as Error).message}` });
      return;
    }

    socket.on("message", (data: unknown) => {
      const text = typeof data === "string" ? data : String(data);
      const answer = liveSessionsFrom(text);
      if (answer !== undefined) finish(answer);
    });
    socket.on("error", (error: Error) => finish({ sessions: [], note: `the socket to ${url} failed: ${error.message}` }));
    // A close before a snapshot means the orchestrator went away mid-question. That is a fact to record, not a
    // reason to wait for the timeout: nothing more is coming on a closed socket.
    socket.on("close", () => finish({ sessions: [], note: `the socket to ${url} closed before describing its sessions` }));
    socket.on("open", () => undefined);
  });
}
