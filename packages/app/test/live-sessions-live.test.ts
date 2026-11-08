/**
 * The question `⌘Q` asks, against a real orchestrator (issue #216, criterion 3).
 *
 * ## What only this test can say
 *
 * `live-sessions.test.ts` asserts the giving-up logic against a scripted socket. It cannot say that the shape it
 * parses is the shape the orchestrator actually sends — that it is a `snapshot`, that the list is `live`, that a
 * session carries `name`/`cwd`/`state`. Those are facts about another process, and a parser tested against a
 * hand-written envelope agrees with itself after the orchestrator renames a field.
 *
 * So this spawns the real bundle, connects the real `ws` client, and asserts on the *answer* — over the same
 * socket the UI uses. It skips when `bin/pi-central.js` is absent, the convention `spawn-live.test.ts` states.
 *
 * ## Why the assertion is about the connection, not about a session
 *
 * Starting a session needs `pi` and `safehouse` and a plain terminal (C1), which CI does not have. The claim
 * being tested is narrower and fully checkable: **a snapshot arrives on connect, its `live` field is a list of
 * things carrying a name, a directory and a state, and the shell reads the list rather than inventing one.** An
 * empty list still proves the channel and the shape, which is what a shell whose dialog names no sessions would
 * break.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LineAccumulator, parseChildLine } from "../src/orchestrator-process.ts";
import { askLiveSessions, type SocketLike } from "../src/live-sessions.ts";

const BUNDLE = fileURLToPath(new URL("../../../bin/pi-central.js", import.meta.url));
const SKIP = existsSync(BUNDLE)
  ? false
  : "bin/pi-central.js is not built; run npm run build:package (CI builds it in the package job)";

/** Start the real orchestrator and resolve with its announced socket URL. */
function startOrchestrator(timeoutMs: number): Promise<{
  url: string;
  stderr: () => string;
  stop: () => void;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BUNDLE, "--port", "0", "--no-ui", "--allow-unsandboxed-host"],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const stop = (): void => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`no URL within ${timeoutMs} ms\n${stderr}`));
    }, timeoutMs);
    const lines = new LineAccumulator();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of lines.push(chunk)) {
        const parsed = parseChildLine(line);
        if (parsed.kind !== "url") continue;
        clearTimeout(timer);
        resolve({ url: parsed.url, stderr: () => stderr, stop });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code ?? "-"} before announcing\n${stderr}`));
    });
  });
}

test("the orchestrator answers `which sessions are live` with a snapshot the shell can read", { skip: SKIP }, async (t) => {
  const orchestrator = await startOrchestrator(20_000);
  t.after(() => orchestrator.stop());

  // The real `ws` client, because that is what `main.ts` will use: a fake here would leave the one part that can
  // differ — the package's event names and message type — untested.
  const WebSocket = (await import("ws")).default;
  const connect = (url: string): SocketLike => {
    const socket = new WebSocket(url);
    return {
      on: (event: string, listener: (argument: never) => void) => {
        // `ws` hands a `Buffer` to `message` and a bare `Error` to `error`, which the shell's narrow interface
        // declares as `unknown`. The cast is the boundary between the library's types and this file's.
        socket.on(event, listener as never);
      },
      close: () => socket.close(),
    };
  };

  const answer = await askLiveSessions(connect, orchestrator.url, 5_000);
  assert.equal(answer.note, undefined, `the question was answered without a caveat: ${answer.note ?? ""}`);
  // The channel and the shape, which is the whole claim: a snapshot arrived and its list was read.
  assert.ok(Array.isArray(answer.sessions), "the answer is a list");
  for (const session of answer.sessions) {
    assert.equal(typeof session.name, "string");
    assert.equal(typeof session.cwd, "string");
    assert.equal(typeof session.state, "string");
  }
});

test("the answer is the same list the snapshot carries, read from the wire", { skip: SKIP }, async (t) => {
  const orchestrator = await startOrchestrator(20_000);
  t.after(() => orchestrator.stop());

  const WebSocket = (await import("ws")).default;
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(orchestrator.url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`no snapshot within 5 s\n${orchestrator.stderr()}`));
    }, 5_000);
    socket.on("message", (data: unknown) => {
      const text = String(data);
      const envelope = JSON.parse(text) as { payload?: { kind?: string } };
      if (envelope.payload?.kind !== "snapshot") return;
      clearTimeout(timer);
      socket.close();
      resolve(text);
    });
    socket.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const fromWire = JSON.parse(raw) as { payload: { live: unknown[] } };
  const viaAsk = await askLiveSessions((url) => {
    const socket = new WebSocket(url);
    return {
      on: (event: string, listener: (argument: never) => void) => {
        socket.on(event, listener as never);
      },
      close: () => socket.close(),
    };
  }, orchestrator.url, 5_000);
  // Nothing dropped, nothing added: the shell reports what the supervisor's snapshot held.
  assert.equal(viaAsk.sessions.length, fromWire.payload.live.length);
});
