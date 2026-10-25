/**
 * Transport tests.
 *
 * These exercise the routing and the two structural boundaries. They do NOT spawn Pi: the
 * supervisor is faked, because a transport test that needed a real sandboxed session would
 * fail both in CI and inside a sandbox (C1). The seam is `Supervisor`, so the fake only has
 * to satisfy the surface the transport actually uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, type Event } from "@pi-central/protocol";
import { parseControl, Transport } from "../src/transport.ts";
import type { Config } from "../src/config.ts";
import type { LiveSession } from "@pi-central/protocol";

/** A supervisor stand-in: emits what the tests tell it to, records what it was asked. */
class FakeSupervisor extends EventEmitter {
  calls: { method: string; args: unknown[] }[] = [];
  sessions: LiveSession[] = [];
  #next = 0;

  list(): LiveSession[] {
    return this.sessions;
  }

  start(request: { cwd?: string; name?: string; mode?: string }) {
    this.calls.push({ method: "start", args: [request] });
    const session = makeSession(`s${++this.#next}`, request.cwd ?? "/scratch/default", request.name);
    this.sessions.push(session);
    return { ok: true as const, session };
  }

  resume(session: { path: string; cwd: string }, options: { mode?: string }) {
    this.calls.push({ method: "resume", args: [session, options] });
    const live = makeSession(`s${++this.#next}`, session.cwd);
    live.sessionFile = session.path;
    this.sessions.push(live);
    return { ok: true as const, session: live };
  }

  async prompt(id: string, message: string): Promise<void> {
    this.calls.push({ method: "prompt", args: [id, message] });
  }
  async abort(id: string): Promise<void> {
    this.calls.push({ method: "abort", args: [id] });
  }
  async stop(id: string): Promise<void> {
    this.calls.push({ method: "stop", args: [id] });
  }
  async rename(id: string, name: string): Promise<void> {
    this.calls.push({ method: "rename", args: [id, name] });
  }
  answerDialog(id: string, dialogId: string, answer: unknown): void {
    this.calls.push({ method: "answerDialog", args: [id, dialogId, answer] });
  }
}

function makeSession(id: string, cwd: string, name?: string): LiveSession {
  return {
    id,
    name: name ?? cwd.split("/").pop() ?? id,
    cwd,
    state: "idle",
    mode: "sandboxed",
    isolation: "test",
    command: "safehouse -- pi --mode rpc",
    scratch: false,
    messageCount: 0,
    pending: 0,
    contextPercent: null,
    tokensTotal: null,
    cost: null,
    dialogs: [],
    warnings: [],
    startedAt: Date.now(),
  };
}

/** A config whose discovery finds nothing, so tests never read the real session store. */
function emptyConfig(): Config {
  return {
    workspaceRoot: "/nonexistent/workspaces",
    stateRoot: "/nonexistent/state",
    sessionsRoot: "/nonexistent/sessions",
    safehouse: "safehouse",
    pi: "pi",
    agentRoot: "/nonexistent/agent",
    fragmentDir: "/nonexistent/policy",
    agentRootManaged: true,
    providerAgentDir: "/nonexistent/provider",
    home: "/Users/tester",
  };
}

// --- Envelope parsing: the boundary, tested without a socket -------------------------------

test("a well-formed control envelope is accepted", () => {
  const control = parseControl(
    JSON.stringify({
      dir: "client→orchestrator",
      protocol: PROTOCOL_VERSION,
      payload: { kind: "prompt", sessionId: "s1", message: "hi" },
    }),
  );
  assert.deepEqual(control, { kind: "prompt", sessionId: "s1", message: "hi" });
});

test("an event-shaped message is rejected as control, not coerced", () => {
  // The direction field exists precisely so this cannot be smuggled through.
  const control = parseControl(
    JSON.stringify({
      dir: "orchestrator→client",
      protocol: PROTOCOL_VERSION,
      payload: { kind: "prompt", sessionId: "s1", message: "hi" },
    }),
  );
  assert.ok("error" in control && control.error.includes("wrong direction"));
});

test("a protocol mismatch is reported rather than best-effort parsed", () => {
  const control = parseControl(
    JSON.stringify({ dir: "client→orchestrator", protocol: 999, payload: { kind: "list" } }),
  );
  assert.ok("error" in control && control.error.includes("protocol mismatch"));
});

test("malformed input is rejected with a reason, never thrown", () => {
  for (const bad of ["", "not json", "null", "[]", JSON.stringify({ dir: "client→orchestrator" })]) {
    const control = parseControl(bad);
    assert.ok("error" in control, `expected a rejection for ${JSON.stringify(bad)}`);
  }
});

test("a payload with no kind is rejected", () => {
  const control = parseControl(
    JSON.stringify({ dir: "client→orchestrator", protocol: PROTOCOL_VERSION, payload: { nope: 1 } }),
  );
  assert.ok("error" in control && control.error.includes("no kind"));
});

// --- Live socket behaviour ----------------------------------------------------------------

/**
 * A small test client.
 *
 * Buffers every event and lets a test await a specific kind. Deliberately simple: an earlier
 * version re-queued non-matching events and deadlocked, which is exactly the class of bug a
 * test helper must not have.
 */
class TestClient {
  #socket: WebSocket;
  #buffer: Event[] = [];
  #waiting: { kind: string | undefined; resolve: (e: Event) => void; reject: (e: Error) => void }[] = [];
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      const payload = (JSON.parse(String(data)) as { payload: { kind: string } }).payload;
      // `hello` is not in the Event union; drop it so tests only reason about real events.
      if (payload.kind === "hello") return;
      this.#buffer.push(payload as Event);
      this.#drain();
    });
    socket.on("close", () => {
      this.#closed = true;
      for (const w of this.#waiting.splice(0)) w.reject(new Error("socket closed while waiting"));
    });
  }

  static async connect(url: string): Promise<TestClient> {
    // The listener is attached by the constructor, which therefore must run BEFORE awaiting
    // open. The server sends its snapshot in the connection handler, so a listener attached
    // after `open` can miss it -- `ws` emits `message` with no listener attached and the event
    // is simply dropped. That race made these tests flaky.
    const socket = new WebSocket(url);
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return client;
  }

  #drain(): void {
    for (let i = 0; i < this.#waiting.length; ) {
      const waiter = this.#waiting[i]!;
      const index = this.#buffer.findIndex((e) => waiter.kind === undefined || e.kind === waiter.kind);
      if (index === -1) {
        i += 1;
        continue;
      }
      const [event] = this.#buffer.splice(index, 1);
      this.#waiting.splice(i, 1);
      clearTimeout((waiter as { timer?: NodeJS.Timeout }).timer);
      waiter.resolve(event!);
    }
  }

  /** Await the next event, optionally of a specific kind. */
  next(kind?: string, timeoutMs = 5_000): Promise<Event> {
    const found = this.#buffer.findIndex((e) => kind === undefined || e.kind === kind);
    if (found !== -1) return Promise.resolve(this.#buffer.splice(found, 1)[0]!);
    return new Promise<Event>((resolve, reject) => {
      const waiter = { kind, resolve, reject } as {
        kind: string | undefined;
        resolve: (e: Event) => void;
        reject: (e: Error) => void;
        timer?: NodeJS.Timeout;
      };
      waiter.timer = setTimeout(() => {
        const index = this.#waiting.indexOf(waiter);
        if (index !== -1) this.#waiting.splice(index, 1);
        reject(new Error(`timed out waiting for ${kind ?? "any event"}; buffered: ${this.#buffer.map((e) => e.kind).join(", ") || "none"}`));
      }, timeoutMs);
      this.#waiting.push(waiter);
    });
  }

  /** Every event received so far, for assertions that are not order-sensitive. */
  get received(): Event[] {
    return [...this.#buffer];
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(control: unknown): void {
    this.#socket.send(
      JSON.stringify({ dir: "client→orchestrator", protocol: PROTOCOL_VERSION, payload: control }),
    );
  }

  /** Send raw text, bypassing envelope construction, to test malformed input. */
  sendRaw(text: string): void {
    this.#socket.send(text);
  }

  close(): void {
    this.#socket.close();
  }
}

test("a client receives the protocol version, then a snapshot", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig());
  const address = await transport.listen();
  try {
    const client = await TestClient.connect(address.url);
    // The hello arrives before the snapshot; read raw to assert both.
    const hello = await client.next();
    assert.equal(hello.kind, "snapshot");
    assert.deepEqual(hello.live, []);
    client.close();
  } finally {
    await transport.close();
  }
});

test("a start command is routed to the supervisor and its session broadcast", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig());
  const address = await transport.listen();
  try {
    const client = await TestClient.connect(address.url);
    await client.next("snapshot");
    client.send({ kind: "start", name: "my session" });
    const event = await client.next("session");
    assert.equal(event.kind, "session");
    assert.equal(event.session.name, "my session");
    assert.deepEqual(supervisor.calls[0]?.method, "start");
    client.close();
  } finally {
    await transport.close();
  }
});

test("a prompt is routed with its exact message, unmodified", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig());
  const address = await transport.listen();
  try {
    const client = await TestClient.connect(address.url);
    await client.next("snapshot");
    // Content that would be dangerous if it ever became markup or a command.
    const message = "<img src=x onerror=alert(1)> — and a newline\nand a U+2028\u2028";
    client.send({ kind: "prompt", sessionId: "s1", message });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(supervisor.calls.at(-1), { method: "prompt", args: ["s1", message] });
    client.close();
  } finally {
    await transport.close();
  }
});

test("an unknown control kind is rejected with an error, not ignored", async () => {
  // Version skew must be visible. Silence would look like a broken button.
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig());
  const address = await transport.listen();
  try {
    const client = await TestClient.connect(address.url);
    await client.next("snapshot");
    client.send({ kind: "definitelyNotACommand" });
    const event = await client.next("error");
    assert.equal(event.kind, "error");
    assert.ok(event.message.includes("bad control"), event.message);
    client.close();
  } finally {
    await transport.close();
  }
});

test("a resume for an unknown path reports an error rather than spawning", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig());
  const address = await transport.listen();
  try {
    const client = await TestClient.connect(address.url);
    await client.next("snapshot");
    client.send({ kind: "resume", path: "/nonexistent/session.jsonl" });
    const event = await client.next("error");
    assert.equal(event.kind, "error");
    assert.ok(event.message.includes("no such session"), event.message);
    assert.equal(supervisor.calls.length, 0, "nothing should reach the supervisor");
    client.close();
  } finally {
    await transport.close();
  }
});

test("supervisor updates and records are broadcast to connected clients", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig());
  transport.attach();
  const address = await transport.listen();
  try {
    const client = await TestClient.connect(address.url);
    await client.next("snapshot");

    const session = makeSession("s9", "/tmp/whatever");
    supervisor.emit("update", session);
    const updated = await client.next("session");
    assert.equal(updated.kind, "session");
    assert.equal(updated.session.id, "s9");

    supervisor.emit("record", "s9", { type: "agent_settled" });
    const record = await client.next("record");
    assert.equal(record.kind, "record");
    assert.equal(record.sessionId, "s9");

    supervisor.emit("error", "s9", "boom");
    const error = await client.next("error");
    assert.equal(error.kind, "error");
    assert.equal(error.message, "boom");
    client.close();
  } finally {
    await transport.close();
  }
});

test("all clients see a broadcast (fan-out, not first-wins)", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig());
  transport.attach();
  const address = await transport.listen();
  try {
    const a = await TestClient.connect(address.url);
    const b = await TestClient.connect(address.url);
    await a.next("snapshot");
    await b.next("snapshot");
    supervisor.emit("update", makeSession("s7", "/tmp/x"));
    const [ea, eb] = await Promise.all([a.next("session"), b.next("session")]);
    assert.equal(ea.kind === "session" && ea.session.id, "s7");
    assert.equal(eb.kind === "session" && eb.session.id, "s7");
    a.close();
    b.close();
  } finally {
    await transport.close();
  }
});

test("the client cap closes the extra connection with a reason", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig(), { maxClients: 1 });
  const address = await transport.listen();
  try {
    const first = await TestClient.connect(address.url);
    await first.next("snapshot");

    // The second client is told why before being closed.
    const second = new WebSocket(address.url);
    const messages: Event[] = [];
    second.on("message", (data) => messages.push((JSON.parse(String(data)) as { payload: Event }).payload));
    await new Promise<void>((resolve) => second.once("close", () => resolve()));
    assert.ok(
      messages.some((m) => m.kind === "error" && m.message.includes("too many clients")),
      `expected a reason, got ${JSON.stringify(messages)}`,
    );
    first.close();
  } finally {
    await transport.close();
  }
});

test("a disconnect does not disturb the remaining clients", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig());
  transport.attach();
  const address = await transport.listen();
  try {
    const a = await TestClient.connect(address.url);
    const b = await TestClient.connect(address.url);
    await a.next("snapshot");
    await b.next("snapshot");
    a.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // b must still receive broadcasts; a closed socket in the set would throw on send.
    supervisor.emit("update", makeSession("s5", "/tmp/y"));
    const event = await b.next("session");
    assert.equal(event.kind === "session" && event.session.id, "s5");
    b.close();
  } finally {
    await transport.close();
  }
});

test("the transport binds loopback only", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig());
  const address = await transport.listen();
  try {
    assert.equal(address.host, "127.0.0.1");
    assert.ok(address.port > 0, "port 0 must resolve to a real port");
    assert.equal(address.url, `ws://127.0.0.1:${address.port}`);
  } finally {
    await transport.close();
  }
});

test("closing the transport releases the port and clears state", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig());
  const address = await transport.listen();
  await transport.close();
  assert.equal(transport.address, undefined);
  // Re-listening must work, which it cannot if the server or its sockets leaked.
  const again = await transport.listen();
  assert.ok(again.port > 0);
  await transport.close();
});
