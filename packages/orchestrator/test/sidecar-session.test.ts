import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Supervisor } from "../src/supervisor.ts";
import { mcpConfigArgs } from "../src/sidecar-supervise.ts";

/**
 * The join between the sidecar and a session (ADR-0015).
 *
 * `sidecar-supervise.test.ts` proves the spawn and the lifetime in isolation; this proves the SUPERVISOR
 * uses them — specifically that a session with a configured port is launched with `--mcp-config`, and that
 * a session WITHOUT one is not. The negative is the important half: a sidecar appearing for a session that
 * never opted in would spend a process per session on every machine, and nobody would notice by reading the
 * positive test.
 */

function fixtureRoot(): string | undefined {
  const override = process.env["PI_CENTRAL_TEST_PRIVATE_ROOT"];
  if (override === undefined) return undefined;
  try {
    return mkdtempSync(join(override, "sidecar-session-"));
  } catch {
    return undefined;
  }
}

const root = fixtureRoot();
if (root !== undefined) process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const skip = root === undefined ? "# skip: set PI_CENTRAL_TEST_PRIVATE_ROOT to exercise the supervisor" : undefined;

function config(over: Record<string, unknown> = {}) {
  const base = root ?? "/nonexistent";
  return {
    workspaceRoot: join(base, "workspaces"),
    stateRoot: join(base, "state"),
    sessionsRoot: join(base, "sessions"),
    safehouse: join(base, "fixtures", "safehouse-stub"),
    pi: join(base, "fixtures", "pi-stub"),
    agentRoot: join(base, "agent"),
    fragmentDir: join(base, "state", "policy"),
    agentRootManaged: true,
    providerAgentDir: join(base, "provider"),
    home: base,
    installationRoot: join(base, "installation"),
    sidecarPort: undefined as number | undefined,
    browser: "/nonexistent/chrome",
    ...over,
  };
}

test("no configured port means no --mcp-config on the session argv", () => {
  // The pure half of the decision, and the one that must never regress: most machines never set this.
  assert.deepEqual(mcpConfigArgs(undefined), []);
});

test("a session with a port is launched with --mcp-config, and one without gets none", () => {
  if (skip) return console.log(skip);
  // Both sessions are spawned for real; the stub binaries exit immediately, so what is inspected is the
  // argv the supervisor COMPOSED rather than any process that survived.
  const supervisor = new Supervisor(config() as never, { rememberOpenSessions: false });
  supervisor.on("error", () => {});

  const withoutPort = supervisor.start({ cwd: root as string, mode: "sandboxed" });
  assert.equal(withoutPort.ok, true);
  if (withoutPort.ok) {
    assert.ok(
      !withoutPort.session.command.includes("--mcp-config"),
      "a session with no sidecar must not be handed a config that names one",
    );
  }

  const withPort = new Supervisor(config({ sidecarPort: 4173 }) as never, { rememberOpenSessions: false });
  withPort.on("error", () => {});
  // The spawn is expected to be attempted and may legitimately fail (no browser, no stub safehouse): a sidecar
  // is a capability, not a precondition, so the session starts regardless. What is under test is the argv.
  withPort.on("log", () => {});
  const started = withPort.start({ cwd: root as string, mode: "sandboxed" });
  assert.equal(started.ok, true);
  if (started.ok) {
    const configFile = join(root as string, "state", "sidecars", started.session.id, "mcp.json");
    assert.ok(existsSync(configFile), "the MCP config must be written when a port is configured");
    // And the session must be TOLD about it. Asserting only that the file exists left the wiring unguarded:
    // removing the --mcp-config push kept this test green, because a config nobody passes is still a file.
    assert.ok(
      started.session.command.includes("--mcp-config"),
      "the session argv must carry --mcp-config, got: " + started.session.command,
    );
    assert.ok(started.session.command.includes(configFile), "and it must name the file just written");
  }
  return Promise.all([supervisor.stopAll(), withPort.stopAll()]).then(() => undefined);
});

test("a sidecar is not spawned for a direct (unsandboxed) session", () => {
  if (skip) return console.log(skip);
  // Direct mode applies no policy at all, so a sidecar beside it would be confined by nothing -- the one
  // arrangement worse than no browser.
  //
  // A SEPARATE state root, deliberately. Session ids are sequential (`s1`, `s2`) and a fresh Supervisor
  // restarts the counter, so reusing the root would find the previous test's `s1` sidecar directory on disk
  // and this assertion would fail on a stale path rather than on a real spawn. That is a property of the
  // test, and it was found by this test failing.
  const isolated = join(root as string, "direct-only");
  const supervisor = new Supervisor(config({ sidecarPort: 4173, stateRoot: isolated }) as never, {
    rememberOpenSessions: false,
  });
  supervisor.on("error", () => {});
  const started = supervisor.start({ cwd: root as string, mode: "direct" });
  assert.equal(started.ok, true);
  if (started.ok) {
    assert.ok(
      !existsSync(join(isolated, "sidecars", started.session.id, "mcp.json")),
      "a direct session must not get a sidecar",
    );
  }
  return supervisor.stopAll().then(() => undefined);
});
