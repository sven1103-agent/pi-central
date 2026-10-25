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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  /** Counts fetches so a test can prove the transport RE-FETCHES rather than replaying a cache. */
  transcriptFetches = 0;

  // Typed like the real method so a test can substitute a failure without a cast.
  fetchTranscript = async (
    id: string,
  ): Promise<{ ok: true; messages: unknown[] } | { ok: false; message: string }> => {
    this.calls.push({ method: "fetchTranscript", args: [id] });
    this.transcriptFetches += 1;
    // Fresh content each time, so a cached replay would be visibly stale.
    return { ok: true, messages: [{ role: "user", content: `fetch ${this.transcriptFetches}` }] };
  };

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

  /** Substitutable so a test can make the change fail, as Pi does for an unconfigured provider. */
  setModelImpl: (id: string, provider: string, modelId: string) => Promise<void> = async () => undefined;

  async setModel(id: string, provider: string, modelId: string): Promise<void> {
    this.calls.push({ method: "setModel", args: [id, provider, modelId] });
    await this.setModelImpl(id, provider, modelId);
  }

  modelsResult: { ok: true; models: { provider: string; id: string }[] } | { ok: false; message: string } = {
    ok: true,
    models: [{ provider: "openai", id: "gpt-5" }],
  };

  async listModels(id: string) {
    this.calls.push({ method: "listModels", args: [id] });
    return this.modelsResult;
  }

  async setThinkingLevel(id: string, level: string): Promise<void> {
    this.calls.push({ method: "setThinkingLevel", args: [id, level] });
  }

  async listThinkingLevels(id: string) {
    this.calls.push({ method: "listThinkingLevels", args: [id] });
    return { ok: true as const, levels: ["off", "low", "high"] };
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
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
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
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
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
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
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
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
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
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
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
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
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
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
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

test("a client connecting to a live session receives its CURRENT conversation", async () => {
  // The reported bug: a reconnect showed a session as loading forever, because the transport
  // replayed a copy captured at session START (empty, for a fresh session) which then REPLACED
  // the client's correct transcript. Fetching fresh is the only way to be current.
  const supervisor = new FakeSupervisor();
  supervisor.sessions.push(makeSession("s1", "/tmp/a"));
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
  try {
    const address = await transport.listen();
    const first = await TestClient.connect(address.url);
    const one = await first.next("transcript");
    assert.equal(one.kind === "transcript" && one.sessionId, "s1");
    assert.match(JSON.stringify(one), /fetch 1/, "the first client gets the current conversation");

    // A second client — a page reload — must get the conversation NOW, not the first snapshot.
    const second = await TestClient.connect(address.url);
    const two = await second.next("transcript");
    assert.match(JSON.stringify(two), /fetch 2/, "the second client must re-fetch, not replay a cache");
    assert.equal(supervisor.transcriptFetches, 2);
    first.close();
    second.close();
  } finally {
    await transport.close();
  }
});

test("a stopped or failed session is not asked for a transcript", async () => {
  // There is no process to answer, so the fetch would fail and be reported as an error.
  const supervisor = new FakeSupervisor();
  supervisor.sessions.push(makeSession("s1", "/tmp/a"), { ...makeSession("s2", "/tmp/b"), state: "stopped" });
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
  try {
    const address = await transport.listen();
    const client = await TestClient.connect(address.url);
    await client.next("transcript");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fetched = supervisor.calls.filter((c) => c.method === "fetchTranscript");
    assert.deepEqual(fetched.map((c) => c.args[0]), ["s1"], "only the running session is fetched");
    client.close();
  } finally {
    await transport.close();
  }
});

test("a failed fetch is reported as an error, never as an empty transcript", async () => {
  // The two mean opposite things. Reported as empty, the UI asserted "Loading…" forever — a claim
  // that work was in progress when none was.
  const supervisor = new FakeSupervisor();
  supervisor.sessions.push(makeSession("s1", "/tmp/a"));
  supervisor.fetchTranscript = async () => ({ ok: false as const, message: "session is not running" });
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
  try {
    const address = await transport.listen();
    const client = await TestClient.connect(address.url);
    const event = await client.next("transcriptError");
    assert.equal(event.kind === "transcriptError" && event.sessionId, "s1");
    assert.match(event.kind === "transcriptError" ? event.message : "", /not running/);
    client.close();
  } finally {
    await transport.close();
  }
});

test("the client cap closes the extra connection with a reason", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig(), { maxClients: 1, uiDir: null });
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
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
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

test("with a UI directory, the transport serves the dashboard AND still upgrades /ws", async () => {
  // The wiring, not the handler: `static-ui.test.ts` covers traversal and the CSP in depth. What
  // this proves is that one listener answers both protocols from one origin — the property that
  // makes `connect-src 'self'` truthful (issue #24).
  const uiDir = mkdtempSync(join(tmpdir(), "pi-central-transport-ui-"));
  process.on("exit", () => rmSync(uiDir, { recursive: true, force: true }));
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><div id=\"root\"></div>\n");

  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir });
  const address = await transport.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /id="root"/);
    assert.ok(response.headers.get("content-security-policy"), "the served document needs the CSP header");

    // Same origin, same port: the socket must still work beside the static handler.
    const client = await TestClient.connect(address.url);
    await client.next("snapshot");
    client.close();
  } finally {
    await transport.close();
  }
});

test("the transport binds loopback only", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
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
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
  const address = await transport.listen();
  await transport.close();
  assert.equal(transport.address, undefined);
  // Re-listening must work, which it cannot if the server or its sockets leaked.
  const again = await transport.listen();
  assert.ok(again.port > 0);
  await transport.close();
});

// --- Model and thinking controls (issue #1) ------------------------------------------------------

test("a setModel control reaches the supervisor with provider and id", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
  const address = await transport.listen();
  try {
    const client = await TestClient.connect(address.url);
    await client.next("snapshot");
    client.send({ kind: "setModel", sessionId: "s1", provider: "openai", modelId: "gpt-5" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(supervisor.calls.at(-1), { method: "setModel", args: ["s1", "openai", "gpt-5"] });
    client.close();
  } finally {
    await transport.close();
  }
});

test("a REFUSED model change is broadcast as an error naming the reason", async () => {
  // Pi refuses a model whose provider is not configured ("No API key for …"). The acceptance
  // criterion is that this surfaces as an error, never as a silent no-op — a control that appears
  // to work and does nothing is the failure this project treats as worse than absence.
  const supervisor = new FakeSupervisor();
  supervisor.setModelImpl = async () => {
    throw new Error("No API key for anthropic/claude-x");
  };
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
  const address = await transport.listen();
  try {
    const client = await TestClient.connect(address.url);
    await client.next("snapshot");
    client.send({ kind: "setModel", sessionId: "s1", provider: "anthropic", modelId: "claude-x" });
    const event = await client.next("error");
    assert.equal(event.kind, "error");
    assert.match(event.message, /No API key for anthropic\/claude-x/);
    client.close();
  } finally {
    await transport.close();
  }
});

test("listModels broadcasts the catalogue, and a failure as modelsError", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
  const address = await transport.listen();
  try {
    const client = await TestClient.connect(address.url);
    await client.next("snapshot");

    client.send({ kind: "listModels", sessionId: "s1" });
    const models = await client.next("models");
    assert.equal(models.kind === "models" && models.sessionId, "s1");
    assert.deepEqual(models.kind === "models" && models.models, [{ provider: "openai", id: "gpt-5" }]);

    // A failure is a DIFFERENT event, not an empty list: "there are none" and "the read failed"
    // are opposite claims, and the UI renders them differently.
    supervisor.modelsResult = { ok: false, message: "session is not running" };
    client.send({ kind: "listModels", sessionId: "s2" });
    const failure = await client.next("modelsError");
    assert.equal(failure.kind === "modelsError" && failure.message, "session is not running");
    assert.equal(failure.kind === "modelsError" && failure.sessionId, "s2");
    client.close();
  } finally {
    await transport.close();
  }
});

test("thinking-level controls are routed, and a failed read is not an empty list", async () => {
  const supervisor = new FakeSupervisor();
  const transport = new Transport(supervisor as never, emptyConfig(), { uiDir: null });
  const address = await transport.listen();
  try {
    const client = await TestClient.connect(address.url);
    await client.next("snapshot");

    client.send({ kind: "listThinkingLevels", sessionId: "s1" });
    const levels = await client.next("thinkingLevels");
    assert.deepEqual(levels.kind === "thinkingLevels" && levels.levels, ["off", "low", "high"]);

    client.send({ kind: "setThinkingLevel", sessionId: "s1", level: "high" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(supervisor.calls.at(-1), { method: "setThinkingLevel", args: ["s1", "high"] });
    client.close();
  } finally {
    await transport.close();
  }
});
