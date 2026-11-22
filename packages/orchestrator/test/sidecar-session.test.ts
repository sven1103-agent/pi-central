import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Supervisor } from "../src/supervisor.ts";
import {
  DEV_PORT_BASE,
  devPortFor,
  mcpConfigArgs,
  sidecarInstruction,
  sidecarPromptArgs,
} from "../src/sidecar-supervise.ts";

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

test("the sidecar port resolves per session: override, opt-out, or default", () => {
  // Three cases that must not collapse, because each is a different intention:
  //   a number -> THIS session gets a sidecar on that port
  //   null     -> this session opts OUT even though the app configures a default
  //   absent   -> the app's default applies
  if (skip) return console.log(skip);
  const app = new Supervisor(config({ sidecarPort: 4173, stateRoot: join(root as string, "resolve") }) as never, {
    rememberOpenSessions: false,
  });
  app.on("error", () => {});

  const optedOut = app.start({ cwd: root as string, mode: "sandboxed", sidecarPort: null });
  assert.equal(optedOut.ok, true);
  if (optedOut.ok) {
    assert.ok(
      !existsSync(join(root as string, "resolve", "sidecars", optedOut.session.id, "mcp.json")),
      "an explicit null must opt a session out even when the app configures a default",
    );
  }

  const overridden = app.start({ cwd: root as string, mode: "sandboxed", sidecarPort: 5173 });
  assert.equal(overridden.ok, true);
  if (overridden.ok) {
    const configFile = join(root as string, "resolve", "sidecars", overridden.session.id, "mcp.json");
    assert.ok(existsSync(configFile), "an explicit number must arm this session");
    // The port does not appear in mcp.json — that file names the COMMAND. It appears in the rendered FRAGMENT,
    // which is what pins egress. The first version of this assertion looked in the config and failed on correct
    // code, because it assumed the port travelled with the argv rather than with the policy.
    const fragment = join(root as string, "resolve", "sidecars", overridden.session.id, "policy", `${overridden.session.id}.sb`);
    assert.ok(existsSync(fragment), "the fragment is the artifact that pins the port");
    assert.match(readFileSync(fragment, "utf8"), /localhost:5173/, "an override must pin THAT port, not the default");
  }
  return app.stopAll().then(() => undefined);
});

test("each session is assigned its own dev port, in a range that cannot meet the sidecar's listen ports", () => {
  // The collision this exists to prevent: two sessions both run Vite on 5173, the second silently moves to 5174,
  // and a sidecar pinned to 5173 screenshots the OTHER session's app and reports it as this session's work.
  const ports = Array.from({ length: 200 }, (_, index) => devPortFor("s" + (index + 1)));
  assert.equal(new Set(ports).size, 200, "two of the first 200 sessions were assigned the same dev port");
  assert.ok(ports.every((port) => port >= DEV_PORT_BASE && port < DEV_PORT_BASE + 200));
  // The sidecar listens at 47800 + ordinal. A dev port inside that range would be the sidecar's own socket.
  assert.ok(ports.every((port) => port >= 48000), "dev ports must sit above the sidecar listen range");
  assert.equal(devPortFor("s7"), devPortFor("s7"), "the assignment must be deterministic");
});

test("the instruction names the port itself and forbids falling back to another", () => {
  const text = sidecarInstruction(48007);
  // A variable the agent must expand is an instruction it gets wrong, so the NUMBER must be in the text.
  assert.match(text, /port 48007/);
  assert.match(text, /http:\/\/localhost:48007/);
  assert.match(text, /do not let it fall back/);
  // The finding from Checkpoint B: the proxy forms drop the image, so the typed function must be named.
  assert.match(text, /tools\.mcp__pi_central_sidecar__capture/);
  assert.match(text, /image\(r\.content\[0\]\)/);
  assert.deepEqual(sidecarPromptArgs(undefined), [], "a session with no sidecar must be told nothing about one");
});

test("with sidecars on, a session is assigned a dev port, pinned in its policy and told in its prompt", () => {
  if (skip) return console.log(skip);
  const state = join(root as string, "assigned");
  const app = new Supervisor(config({ sidecar: true, stateRoot: state }) as never, { rememberOpenSessions: false });
  app.on("error", () => {});
  app.on("log", () => {});
  const first = app.start({ cwd: root as string, mode: "sandboxed" });
  const second = app.start({ cwd: root as string, mode: "sandboxed" });
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;

  const portOf = (id: string): number =>
    Number(/localhost:(\d+)/.exec(readFileSync(join(state, "sidecars", id, "policy", id + ".sb"), "utf8"))?.[1]);
  assert.equal(portOf(first.session.id), devPortFor(first.session.id), "the policy must pin the ASSIGNED port");
  assert.notEqual(portOf(first.session.id), portOf(second.session.id), "two sessions must not share a port");

  const argv = ([] as string[]).concat(first.session.command as never).join(" ");
  assert.ok(argv.includes("--append-system-prompt"), "the session must be told about its browser");
  assert.ok(argv.includes("port " + devPortFor(first.session.id)), "and told ITS port, not another session's");
  // The --env-pass ARGUMENT, not the bare name: the instruction text mentions $PI_CENTRAL_DEV_PORT too, so a bare
  // substring match passed with the variable removed (found by breaking it).
  assert.match(argv, /--env-pass=\S*PI_CENTRAL_DEV_PORT/, "the port must be forwarded as a variable, by name (C15)");
  return app.stopAll().then(() => undefined);
});

test("an explicit port still wins over the assigned one, and null still opts out", () => {
  if (skip) return console.log(skip);
  const state = join(root as string, "precedence");
  const app = new Supervisor(config({ sidecar: true, stateRoot: state }) as never, { rememberOpenSessions: false });
  app.on("error", () => {});
  app.on("log", () => {});
  const pinned = app.start({ cwd: root as string, mode: "sandboxed", sidecarPort: 5173 });
  const optedOut = app.start({ cwd: root as string, mode: "sandboxed", sidecarPort: null });
  assert.ok(pinned.ok && optedOut.ok);
  if (!pinned.ok || !optedOut.ok) return;
  assert.match(readFileSync(join(state, "sidecars", pinned.session.id, "policy", pinned.session.id + ".sb"), "utf8"), /localhost:5173/);
  assert.ok(!existsSync(join(state, "sidecars", optedOut.session.id, "mcp.json")), "null must opt out even with sidecars on");
  return app.stopAll().then(() => undefined);
});

test("without the switch and without a port, a session gets no sidecar and no instruction", () => {
  if (skip) return console.log(skip);
  const app = new Supervisor(config({ stateRoot: join(root as string, "off") }) as never, { rememberOpenSessions: false });
  app.on("error", () => {});
  const started = app.start({ cwd: root as string, mode: "sandboxed" });
  assert.ok(started.ok);
  if (!started.ok) return;
  const argv = ([] as string[]).concat(started.session.command as never).join(" ");
  assert.ok(!argv.includes("--append-system-prompt"), "a session with no sidecar must not be told it has a browser");
  assert.doesNotMatch(argv, /--env-pass=\S*PI_CENTRAL_DEV_PORT/);
  return app.stopAll().then(() => undefined);
});
