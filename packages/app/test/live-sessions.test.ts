/**
 * Asking the orchestrator about its sessions, and giving up in bounded time (issue #216, criterion 3).
 *
 * ## What is being defended
 *
 * `⌘Q` must name the sessions it is about to stop, and the list has to come from the supervisor — so the shell
 * asks over the socket. That adds three failure modes to a menu action, and each one is a way for the app to
 * appear hung:
 *
 *   - the socket never opens (nothing listening, which is the *stale record* case the launch already handles);
 *   - it opens and nothing is sent (an orchestrator wedged before its snapshot);
 *   - the list arrives and some entries cannot be read (a future orchestrator's field names).
 *
 * All three resolve to "no sessions", which makes `decideStop` answer `quit` — the safe direction, because a
 * dialog that lists nothing is worse than no dialog: it would ask the reader to confirm stopping zero things.
 * The `note` is what keeps that from being silent, and `main.ts` logs it.
 *
 * ## Why the socket is faked here
 *
 * The protocol side — the envelope shape, the `ws` package — is asserted against a *real* listener in
 * `live-sessions-live.test.ts`. This file asserts the timing and the giving-up, which a real listener cannot
 * provoke reliably without a sleep long enough to make the suite annoying.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASK_TIMEOUT_MS, askLiveSessions, liveSessionsFrom, type SocketLike } from "../src/live-sessions.ts";

/** A socket that does exactly what one scripted call says, and records what was done to it. */
class FakeSocket implements SocketLike {
  readonly closed: boolean[] = [];
  #listeners = new Map<string, ((argument: never) => void)[]>();
  readonly #script: (emit: (event: string, argument: unknown) => void) => void;

  constructor(script: (emit: (event: string, argument: unknown) => void) => void) {
    this.#script = script;
  }

  on(event: string, listener: (argument: never) => void): void {
    const existing = this.#listeners.get(event) ?? [];
    existing.push(listener);
    this.#listeners.set(event, existing);
  }

  /** Emit asynchronously, so the promise's wiring is complete before the socket speaks. */
  emit(event: string, argument: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as (value: unknown) => void)(argument);
    }
  }

  close(): void {
    this.closed.push(true);
  }

  start(): void {
    queueMicrotask(() => this.#script((event, argument) => this.emit(event, argument)));
  }
}

function factory(socket: FakeSocket): (url: string) => SocketLike {
  return () => {
    socket.start();
    return socket;
  };
}

const SNAPSHOT = JSON.stringify({
  dir: "orchestrator→client",
  protocol: 9,
  payload: {
    kind: "snapshot",
    live: [
      { id: "s1", name: "fix the parser", cwd: "/Users/x/git/parser", state: "streaming" },
      { id: "s2", name: "notes", cwd: "/Users/x/notes", state: "idle" },
      { id: "s3", name: "old", cwd: "/Users/x/old", state: "stopped" },
    ],
    history: [],
    historyTotal: 0,
    home: "/Users/x",
  },
});

test("the first snapshot answers the question, and the socket is closed rather than held", async () => {
  const socket = new FakeSocket((emit) => {
    emit("open", undefined);
    emit("message", JSON.stringify({ dir: "orchestrator→client", protocol: 9, payload: { kind: "hello", protocol: 9 } }));
    emit("message", SNAPSHOT);
  });
  const answer = await askLiveSessions(factory(socket), "ws://127.0.0.1:1");
  assert.equal(answer.note, undefined);
  assert.deepEqual(answer.sessions.map((session) => session.name), ["fix the parser", "notes", "old"]);
  assert.equal(socket.closed.length, 1, "the socket is closed once the answer arrived");
});

test("`hello` is not mistaken for an answer", () => {
  assert.equal(liveSessionsFrom(JSON.stringify({ payload: { kind: "hello", protocol: 9 } })), undefined);
  assert.equal(liveSessionsFrom(JSON.stringify({ payload: { kind: "installFacts", install: {} } })), undefined);
  assert.equal(liveSessionsFrom("not json"), undefined);
  assert.equal(liveSessionsFrom(JSON.stringify({})), undefined);
});

test("the full list arrives unpruned — filtering is `decideStop`'s job, not the socket's", () => {
  // The shell must not decide here which states count as live: a second definition of "live" is a second place
  // to be wrong, and `LIVE_STATES` in `runtime-record.ts` is asserted against the protocol's own union.
  const answer = liveSessionsFrom(SNAPSHOT);
  assert.equal(answer?.sessions.length, 3);
  assert.equal(answer?.note, undefined);
});

test("a live entry that cannot be read is counted and reported, not rendered as `undefined`", () => {
  const answer = liveSessionsFrom(
    JSON.stringify({
      payload: {
        kind: "snapshot",
        live: [
          { name: "fine", cwd: "/c", state: "idle" },
          { name: "no cwd", state: "idle" },
          { cwd: "/c", state: "idle" },
          { name: "no state", cwd: "/c" },
          "not an object",
        ],
      },
    }),
  );
  assert.deepEqual(answer?.sessions, [{ name: "fine", cwd: "/c", state: "idle" }]);
  assert.match(answer?.note ?? "", /4 live session\(s\) could not be read/);
});

test("a snapshot with no list is a note, not a crash", () => {
  const answer = liveSessionsFrom(JSON.stringify({ payload: { kind: "snapshot" } }));
  assert.deepEqual(answer?.sessions, []);
  assert.match(answer?.note ?? "", /no list of live sessions/);
});

test("a socket that cannot even be opened answers no sessions, with the reason", async () => {
  const answer = await askLiveSessions(() => {
    throw new Error("getaddrinfo ENOTFOUND");
  }, "ws://127.0.0.1:1");
  assert.deepEqual(answer.sessions, []);
  assert.match(answer.note ?? "", /could not open a socket/);
});

test("a socket that opens and says nothing gives up rather than hanging the quit", async () => {
  const socket = new FakeSocket((emit) => emit("open", undefined));
  const answer = await askLiveSessions(factory(socket), "ws://127.0.0.1:1", 50);
  assert.deepEqual(answer.sessions, []);
  assert.match(answer.note ?? "", /did not describe its sessions within 50 ms/);
  assert.equal(socket.closed.length, 1, "a socket that timed out is closed, not leaked");
});

test("a socket that closes before answering does not wait for the timeout", async () => {
  const socket = new FakeSocket((emit) => {
    emit("open", undefined);
    emit("close", undefined);
  });
  const started = Date.now();
  const answer = await askLiveSessions(factory(socket), "ws://127.0.0.1:1", 10_000);
  assert.deepEqual(answer.sessions, []);
  assert.match(answer.note ?? "", /closed before describing/);
  assert.ok(Date.now() - started < 2_000, "the answer is immediate, not the 10 s timeout");
});

test("an error before the snapshot is an answer, and it names the error", async () => {
  const socket = new FakeSocket((emit) => emit("error", new Error("ECONNRESET")));
  const answer = await askLiveSessions(factory(socket), "ws://127.0.0.1:1");
  assert.deepEqual(answer.sessions, []);
  assert.match(answer.note ?? "", /ECONNRESET/);
});

test("the timeout is short enough for a menu action", () => {
  // A `⌘Q` that waits longer than this has stopped feeling like a quit. Asserted rather than commented, because
  // the number is the interface here.
  assert.ok(ASK_TIMEOUT_MS <= 3000, `${ASK_TIMEOUT_MS} ms is too long to be the latency of a quit`);
});
