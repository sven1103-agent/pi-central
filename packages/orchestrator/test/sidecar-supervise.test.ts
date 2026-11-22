import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpConfigArgs, spawnSidecar, type SidecarHandle, type SidecarSpawn } from "../src/sidecar-supervise.ts";

/**
 * The supervisor wiring (ADR-0015 §1, §11).
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
 */
const FAKE = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";

const options = (over: Partial<SidecarSpawn> = {}): SidecarSpawn => ({
  sessionId: "sess-1",
  port: 4173,
  stateRoot: root ?? "/nonexistent",
  safehouse: process.execPath,
  sidecar: process.execPath,
  sidecarCodeDir: root ?? "/nonexistent",
  sidecarArgs: ["-e", FAKE],
  browser: "/nonexistent/chrome",
  ...over,
});

test("the MCP config is written 0600 under the state root, outside ~/.pi", () => {
  if (skip) return console.log(skip);
  const handle = spawnSidecar(options());
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

test("a session with no sidecar gets no --mcp-config argument", () => {
  assert.deepEqual(mcpConfigArgs(undefined), []);
});

test("--mcp-config precedes any subcommand, because after it the flag is unrecognised", () => {
  // Phase 0D measured `pi mcp list --mcp-config X` -> "Unknown option". Returning the flag as a list that
  // the caller prepends is what keeps that ordering true; a caller that appended it would reproduce the
  // probe's first failure.
  const handle: SidecarHandle = {
    configFile: "/state/mcp.json",
    origin: "http://localhost:4173",
    token: "t",
    port: () => 47801,
    ready: Promise.resolve(47801),
    stop: async () => {},
    gone: true,
  };
  const args = mcpConfigArgs(handle);
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

test("stopping twice is harmless", () => {
  if (skip) return console.log(skip);
  const handle = spawnSidecar(options({ sessionId: "sess-2" }));
  return handle.stop().then(() => handle.stop()).then(() => {
    assert.equal(handle.gone, true);
  });
});
