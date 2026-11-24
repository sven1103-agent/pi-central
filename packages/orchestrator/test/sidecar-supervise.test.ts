import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mcpConfigArgs,
  sidecarFailureWarning,
  spawnSidecar,
  type SidecarHandle,
  type SidecarSpawn,
} from "../src/sidecar-supervise.ts";

/**
 * The supervisor wiring (ADR-0018 §1, §11).
 *
 * These spawn a REAL process, because the properties worth having are properties of a running child: that
 * the MCP config lands where Pi can read it and the agent cannot write it, and that closing stdin takes the
 * sidecar down. A test that only inspected the config file would prove none of that.
 *
 * The sidecar is started with `node -e` rather than the real entry point: the lifetime is what is under test,
 * and a real browser would make these slow, flaky, and dependent on Chrome being installed.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");

function fixtureRoot(): string | undefined {
  const override = process.env["PI_CENTRAL_TEST_PRIVATE_ROOT"];
  const candidates = override ? [override] : [process.env["HOME"] ?? "", join(REPO, ".test-private")];
  for (const base of candidates) {
    if (base === "") continue;
    try {
      return mkdtempSync(join(base, "sidecar-supervise-"));
    } catch {
      continue;
    }
  }
  return undefined;
}

const root = fixtureRoot();
if (root !== undefined) process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const skip = root === undefined ? "# skip: no private directory for fixtures (set PI_CENTRAL_TEST_PRIVATE_ROOT)" : undefined;

/**
 * A stand-in for the sidecar: reads stdin, exits on EOF. The lifetime under test, without a browser.
 *
 * Passed through `sidecarArgs` so it takes the SAME argv shape the real sidecar does — binary, then a
 * `--`, then its own flags. Exercising a different shape here would test something the product never runs.
 *
 * ## Why these are FILES and not `-e` snippets
 *
 * They were `-e` snippets, and that made the lifetime test vacuous. Measured: `node -e <code> --executable X`
 * exits with `node: bad option: --executable` before running a single line, because node parses everything after
 * `-e` as its own options. So the stand-in died instantly, `stop()` found the process already `gone`, and
 * "closing stdin takes the sidecar down" passed by proving nothing. A script PATH is followed by real argv, so
 * the policy's trailing flags arrive as `process.argv` and the stand-in actually runs.
 */
const FAKE_PATH = (base: string): string => {
  const dir = join(base, "fixtures");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "sidecar-fake.mjs");
  writeFileSync(
    file,
    [
      /*
       * It must ANNOUNCE, because the config is written from the announcement.
       *
       * A port of 0 means "ask the kernel", exactly as the real sidecar does — so this stands in for the real
       * thing at the level that matters: the number is not known until it is reported.
       */
      "import { createServer } from 'node:http';",
      "const server = createServer();",
      "server.listen(0, '127.0.0.1', () => {",
      "  const { port } = server.address();",
      "  process.stderr.write('sidecar listening on 127.0.0.1:' + port + ' origin=http://localhost:4173\\n');",
      "});",
      "process.stdin.resume();",
      "process.stdin.on('end', () => server.close(() => process.exit(0)));",
      "",
    ].join("\n"),
  );
  return file;
};

/**
 * A stand-in that dies the way a real sidecar dies: a cause on stderr, a stack behind it, a status.
 *
 * The stack is deliberate and long. The first version of the failure message was built from the tail alone, so a
 * twenty-line stack pushed the cause out of the message entirely — the shape this fixture reproduces.
 */
const DIES_PATH = (base: string): string => {
  const dir = join(base, "fixtures");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "sidecar-dies.mjs");
  writeFileSync(
    file,
    [
      "process.stderr.write('sidecar cannot listen on 127.0.0.1:47816: EADDRINUSE\\n');",
      "process.stderr.write('at x (node:net:1:1)\\n'.repeat(30));",
      "process.exit(2);",
      "",
    ].join("\n"),
  );
  return file;
};

/**
 * A launcher that drops its own policy flags and executes the rest.
 *
 * `safehouse` is `process.execPath` in the older fixtures, and that is a trap this file walked into: node itself
 * then received `--workdir … --enable=… --append-profile=…` and died with `bad option: --workdir` — so a test
 * about the sidecar's failure message was measuring NODE's argument parser. The stub skips to the `--` separator
 * and execs what follows, so the argv shape is still exactly production's while the program that runs is ours.
 */
function writeLauncherStub(base: string): string {
  const dir = join(base, "fixtures");
  mkdirSync(dir, { recursive: true });
  const stub = join(dir, "safehouse-stub");
  writeFileSync(
    stub,
    '#!/bin/sh\nwhile [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ $# -gt 0 ] && shift\nexec "$@"\n',
    { mode: 0o755 },
  );
  return stub;
}

const launcher = root === undefined ? process.execPath : writeLauncherStub(root);

const options = (over: Partial<SidecarSpawn> = {}): SidecarSpawn => ({
  sessionId: "sess-1",
  port: 4173,
  stateRoot: root ?? "/nonexistent",
  safehouse: launcher,
  sidecar: process.execPath,
  sidecarCodeDir: root ?? "/nonexistent",
  sidecarArgs: [root === undefined ? "/nonexistent/fake.mjs" : FAKE_PATH(root)],
  browser: "/nonexistent/chrome",
  ...over,
});

test("the MCP config is written 0600 under the state root, outside ~/.pi", async () => {
  if (skip) return console.log(skip);
  const handle = spawnSidecar(options());
  /*
   * AWAITED, and that is the new contract rather than laziness: the config names the port the kernel gave the
   * child, so the file does not exist until the child announces. Reading it straight after `spawnSidecar` would
   * assert against a file that has not been written — which is exactly the bug this ordering prevents.
   */
  await handle.ready.catch(() => undefined);
  return handle.stop().then(() => {
    const stats = statSync(handle.configFile);
    assert.equal(stats.mode & 0o777, 0o600, "an MCP config names a command, so it is not world-readable");
    assert.ok(handle.configFile.startsWith(root ?? ""), "the config must live under the state root");
    assert.ok(!handle.configFile.includes("/.pi/"), "never in agent-writable ~/.pi (C6)");
    const parsed = JSON.parse(readFileSync(handle.configFile, "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    const entry = parsed.mcpServers?.["pi_central_sidecar"];
    assert.ok(entry !== undefined, "the config must name the server Pi will start");
    assert.ok((entry.args ?? []).includes("--append-profile=undefined") === false, "no undefined argument leaks");
  });
});

test("two fleets opening their own s18 BOTH get a browser, on different ports", async () => {
  if (skip) return console.log(skip);
  /*
   * THE regression this whole change exists for, and it is reproduced from a report: a session browser failed on
   * `port 47818` with no second window open.
   *
   * `47818` is `47800 + 18`, so it was session `s18`. Session ids restart at `s1` on every launch, so a sidecar
   * left over from an earlier run derived the same number for ITS `s18` and won the bind. The reader of the new
   * launch got "no session browser" and nothing else.
   *
   * Falsification: restore `listenPort: SIDECAR_PORT_BASE + sessionOrdinal(...)` and this fails — the second
   * fleet is refused on the first fleet's port. Two approaches were measured and rejected before this one:
   *
   *   - Probing the range first. Both fleets probe before either binds, so both see the port free. Verified: still
   *     collided.
   *   - Any scheme that decides the number in advance. The race is against a bind that has not happened, and two
   *     processes cannot agree on a number by looking at it.
   *
   * The kernel decides here (port 0), so the ports are distinct BY CONSTRUCTION rather than by arithmetic that was
   * only ever true for one orchestrator at a time.
   */
  // The REAL entry point, because this test is about which port gets BOUND.
  const real = {
    sidecarArgs: [join(HERE, "..", "src", "sidecar.ts")],
    sidecarCodeDir: join(HERE, ".."),
  };
  const a = spawnSidecar(options({ ...real, sessionId: "s18", stateRoot: join(root as string, "fleet-a") }));
  const b = spawnSidecar(options({ ...real, sessionId: "s18", stateRoot: join(root as string, "fleet-b") }));

  const [first, second] = await Promise.allSettled([a.ready, b.ready]);
  await a.stop().catch(() => undefined);
  await b.stop().catch(() => undefined);

  assert.equal(first.status, "fulfilled", "the first fleet's s18 gets a browser");
  assert.equal(second.status, "fulfilled", "AND SO DOES THE SECOND — this is the defect being fixed");
  if (first.status !== "fulfilled" || second.status !== "fulfilled") return;

  assert.notEqual(first.value, second.value, "the two sidecars must be on different ports");
  assert.ok(first.value > 0 && second.value > 0, "and both are real, kernel-assigned ports");

  // The identity that used to make this a collision: same session NUMBER, different fleets.
  assert.equal(a.configFile.startsWith(join(root as string, "fleet-a")), true);
  assert.equal(b.configFile.startsWith(join(root as string, "fleet-b")), true);
  // Each config must name ITS OWN port, not a shared guess — the silent mix-up that would be worse than no browser.
  const aConfig = readFileSync(a.configFile, "utf8");
  const bConfig = readFileSync(b.configFile, "utf8");
  assert.match(aConfig, new RegExp("127\\.0\\.0\\.1:" + first.value + "/mcp"), "fleet A's config names A's port");
  assert.match(bConfig, new RegExp("127\\.0\\.0\\.1:" + second.value + "/mcp"), "fleet B's config names B's port");
});

test("the advice names the cause, and a C1 refusal is not called a fault to investigate", () => {
  /*
   * Falsification: revert `sidecarFailureWarning` to the single sentence that ended "the orchestrator's log has the
   * detail" and the first two assertions fail. That sentence was wrong twice for a C1 refusal — the reader's setup
   * is not broken, and nothing about it is in the orchestrator's log — so it sent someone to read a file that could
   * not answer them.
   */
  const nested = sidecarFailureWarning(
    "the sidecar exited (code=71, signal=-) before it could listen on port 47816:\n" +
      "sandbox-exec: sandbox_apply: Operation not permitted",
  );
  assert.match(nested, /refusing to nest/, "C1 is named as the cause");
  assert.match(nested, /plain terminal/, "and the one action that fixes it is stated");
  assert.ok(!/orchestrator's log has the rest/.test(nested), "and it does not send them to a log that has nothing");

  const busy = sidecarFailureWarning(
    "the sidecar exited (code=2, signal=-) before it could listen on port 47816:\n" +
      "sidecar cannot listen on 127.0.0.1:47816: EADDRINUSE",
  );
  assert.match(busy, /already in use/, "a held port is named as a held port");
  assert.match(busy, /previous Pi Central launch/, "with the usual owner of it, which is the actionable part");

  const unknown = sidecarFailureWarning("something odd happened");
  assert.match(unknown, /orchestrator's log/, "an unrecognised cause still points somewhere real");
  assert.match(unknown, /fault rather than a setting/, "and every cause is still named as a fault, not a setting");
});

test("a session with no sidecar gets no --mcp-config argument", async () => {
  assert.deepEqual(await mcpConfigArgs(undefined), []);
});

test("--mcp-config precedes any subcommand, because after it the flag is unrecognised", async () => {
  // Phase 0D measured `pi mcp list --mcp-config X` -> "Unknown option". Returning the flag as a list that
  // the caller prepends is what keeps that ordering true; a caller that appended it would reproduce the
  // probe's first failure.
  const handle: SidecarHandle = {
    configFile: "/state/mcp.json",
    origin: "http://localhost:4173",
    devPort: 4173,
    token: "t",
    port: () => 47801,
    ready: Promise.resolve(47801),
    stop: async () => {},
    gone: true,
  };
  const args = await mcpConfigArgs(handle);
  assert.deepEqual(args, ["--mcp-config", "/state/mcp.json"]);
});

test("the sidecar policy refuses a port that is not a port, before writing any config", () => {
  if (skip) return console.log(skip);
  for (const port of [0, -1, 70000, 1.5]) {
    assert.throws(
      () => spawnSidecar(options({ port })),
      /1\.\.65535/,
      `port ${port} must be refused before a config is written`,
    );
  }
});

test("closing stdin takes the sidecar down", () => {
  if (skip) return console.log(skip);
  // The lifetime mechanism. The child is `node -e "read stdin; exit on end"` wrapped in the same argv shape
  // the real sidecar gets, so what is under test is the pipe and not the browser.
  const handle = spawnSidecar(options());
  const started = Date.now();
  return handle.stop().then(() => {
    assert.equal(handle.gone, true, "stop() must resolve only once the process is gone");
    assert.ok(Date.now() - started < 6000, "stop must be bounded, not a hang");
  });
});

test("a sidecar that dies before listening reports WHY, not just that it did", async () => {
  if (skip) return console.log(skip);
  /*
   * Falsification: remove the `failureTail(stderrTail)` and `exitReason(...)` from the rejection in
   * `spawnSidecar` and this test fails on the first assertion. That is the defect it was written from — a reader
   * saw "the sidecar exited before it could listen (port 47816)" and asked what went wrong, and neither the
   * orchestrator nor the transcript could answer, because the child's stderr was collected into a variable that
   * nothing read.
   *
   * The stand-in prints a CAUSE line and then dies, which is the shape of the real failure (an uncaught
   * `listen EADDRINUSE`) without needing a port to be held.
   */
  const handle = spawnSidecar(
    options({
      sessionId: "sess-dies",
      // The first line is the cause; the rest is the stack that used to bury it.
      sidecarArgs: [DIES_PATH(root as string)],
    }),
  );

  await assert.rejects(
    () => handle.ready,
    (error: Error) => {
      assert.match(error.message, /the sidecar exited/, "it still says the sidecar died");
      assert.match(error.message, /code=2/, "and HOW: the exit status, which distinguishes a crash from a kill");
      assert.match(error.message, /EADDRINUSE/, "and WHY: the cause the child actually printed");
      assert.match(error.message, /47816/, "including the port, which is the only actionable part");
      // The stack must not crowd the cause out, and the cause must not be lost to the tail's own bound.
      assert.ok(error.message.length < 2000, `the message stays readable, got ${error.message.length} chars`);
      return true;
    },
  );
});

test("stopping twice is harmless", () => {
  if (skip) return console.log(skip);
  const handle = spawnSidecar(options({ sessionId: "sess-2" }));
  return handle.stop().then(() => handle.stop()).then(() => {
    assert.equal(handle.gone, true);
  });
});
