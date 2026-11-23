import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync as fileExists } from "node:fs";
import { Supervisor, resolveSidecarEntry } from "../src/supervisor.ts";
import { renderPolicyFragment } from "../src/fragment.ts";
import {
  DEV_PORT_BASE,
  devPortFor,
  isPiCentralCheckout,
  mcpConfigArgs,
  pickDevPort,
  portHasListener,
  reapDevPort,
  sidecarInstruction,
  sidecarPromptArgs,
} from "../src/sidecar-supervise.ts";

/**
 * The join between the sidecar and a session (ADR-0018).
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
    // Off unless a test turns it on: the app default, and the SUBJECT of the opt-in tests.
    sidecar: false as boolean | undefined,
    sidecarOffered: true as boolean | undefined,
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

test("a dev port with something already listening on it is skipped, not handed out", () => {
  // The measured failure: session ids restart at s1, so s1 always got the same port, and a server the previous
  // run's agent left behind still held it. The next sidecar probed THAT server, got a 404 page with no problems,
  // and reported verdict "ok" for a page that overflowed by 720px.
  const stale = new Set<number>([48001]);
  const listening = (port: number): boolean => stale.has(port);
  assert.equal(pickDevPort("s1", new Set(), () => false), 48001, "a free port is the session's own");
  assert.equal(pickDevPort("s1", new Set(), listening), 48002, "a stale listener must push it to the next port");
  assert.equal(pickDevPort("s1", new Set([48002]), listening), 48003, "and so must a port assigned to a live session");
  assert.equal(pickDevPort("s200", new Set(), (port) => port === 48000), 48001, "the range wraps");
  assert.equal(pickDevPort("s1", new Set(), () => true), undefined, "an exhausted range yields no port, not a guess");
});

test("portHasListener sees a real listener on either address family", async () => {
  if (!fileExists("/usr/sbin/lsof")) return console.log("# skip: /usr/sbin/lsof is not present");
  // The stubbed test above proves the choice; this proves the question is asked correctly, because a wrong lsof
  // argument would answer "free" for every port and the whole defence would be a no-op that every other test
  // passed.
  for (const host of ["127.0.0.1", "::1"]) {
    const server = createServer();
    const port = await new Promise<number>((done, fail) => {
      server.once("error", fail);
      server.listen(0, host, () => done((server.address() as { port: number }).port));
    }).catch(() => undefined);
    if (port === undefined) continue;
    try {
      assert.equal(portHasListener(port), true, "a listener on " + host + " must be seen");
    } finally {
      await new Promise((done) => server.close(done));
    }
    assert.equal(portHasListener(port), false, "and a closed port must read as free");
  }
});

test("a session started while its own dev port is occupied is given a different one", async () => {
  if (skip) return console.log(skip);
  if (!fileExists("/usr/sbin/lsof")) return console.log("# skip: /usr/sbin/lsof is not present");
  const occupied = devPortFor("s1");
  const blocker = createServer();
  const bound = await new Promise<boolean>((done) => {
    blocker.once("error", () => done(false));
    blocker.listen(occupied, "127.0.0.1", () => done(true));
  });
  if (!bound) return console.log("# skip: port " + occupied + " is already in use on this machine");
  try {
    const state = join(root as string, "occupied");
    const app = new Supervisor(config({ sidecar: true, stateRoot: state }) as never, { rememberOpenSessions: false });
    app.on("error", () => {});
    app.on("log", () => {});
    const started = app.start({ cwd: root as string, mode: "sandboxed" });
    assert.ok(started.ok);
    if (!started.ok) return;
    const fragment = readFileSync(join(state, "sidecars", started.session.id, "policy", started.session.id + ".sb"), "utf8");
    const pinned = Number(/localhost:(\d+)/.exec(fragment)?.[1]);
    assert.notEqual(pinned, occupied, "the sidecar must not be pinned to a port something already holds");
    assert.ok(pinned > occupied && pinned < 48200, "it must be the next free port in the range");
    await app.stopAll();
  } finally {
    await new Promise((done) => blocker.close(done));
  }
});

/** A dev server that is NOT in the session's process group, as one started with "&" from Pi's bash tool is not. */
function strayServer(port: number): Promise<{ pid: number; exited: Promise<boolean> } | undefined> {
  const child = spawn(
    process.execPath,
    ["-e", `require("net").createServer().listen(${port}, "127.0.0.1", () => console.log("up"))`],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const exited = new Promise<boolean>((done) => child.once("exit", () => done(true)));
  return new Promise((resolve) => {
    child.stdout.once("data", () => resolve({ pid: child.pid as number, exited }));
    child.once("exit", () => resolve(undefined));
  });
}

const visible = (port: number): boolean => existsSync("/usr/sbin/lsof") && portHasListener(port);

test("a stray dev server on an assigned port is stopped when its session stops", async () => {
  if (skip) return console.log(skip);
  const state = join(root as string, "reap-assigned");
  const app = new Supervisor(config({ sidecar: true, stateRoot: state }) as never, { rememberOpenSessions: false });
  app.on("error", () => {});
  app.on("log", () => {});
  const started = app.start({ cwd: root as string, mode: "sandboxed" });
  assert.ok(started.ok);
  if (!started.ok) return;
  const fragment = readFileSync(join(state, "sidecars", started.session.id, "policy", started.session.id + ".sb"), "utf8");
  const port = Number(/localhost:(\d+)/.exec(fragment)?.[1]);
  const stray = await strayServer(port);
  if (!stray) return console.log("# skip: port " + port + " is already held on this machine, so a stand-in cannot bind it");
  if (!visible(port)) {
    process.kill(stray.pid, "SIGKILL");
    return console.log("# skip: this environment cannot see other processes' sockets (lsof), so reaping cannot be shown");
  }
  await app.stopAll();
  const gone = await Promise.race([stray.exited, new Promise<boolean>((done) => setTimeout(() => done(false), 3000))]);
  if (!gone) process.kill(stray.pid, "SIGKILL");
  assert.equal(gone, true, "a dev server left on the assigned port must not outlive its session");
});

test("a server on an EXPLICIT port is never stopped, because it is somebody's own dev server", async () => {
  if (skip) return console.log(skip);
  const state = join(root as string, "reap-explicit");
  const explicit = 48190;
  const app = new Supervisor(config({ sidecar: true, stateRoot: state }) as never, { rememberOpenSessions: false });
  app.on("error", () => {});
  app.on("log", () => {});
  const stray = await strayServer(explicit);
  assert.ok(stray, "the stand-in dev server must start");
  if (!stray) return;
  try {
    const started = app.start({ cwd: root as string, mode: "sandboxed", sidecarPort: explicit });
    assert.ok(started.ok);
    await app.stopAll();
    await new Promise((done) => setTimeout(done, 500));
    assert.doesNotThrow(() => process.kill(stray.pid, 0), "an explicit port's server must still be running");
  } finally {
    try { process.kill(stray.pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("reapDevPort never signals the process that asks", async () => {
  if (!existsSync("/usr/sbin/lsof")) return console.log("# skip: /usr/sbin/lsof is not present");
  const own = createServer();
  const port = await new Promise<number>((done) => own.listen(0, "127.0.0.1", () => done((own.address() as { port: number }).port)));
  try {
    assert.deepEqual(reapDevPort(port), [], "the orchestrator's own socket must never be signalled");
  } finally {
    await new Promise((done) => own.close(done));
  }
});

test("the sidecar entry is resolved for the installation that exists, not for one mode", () => {
  // Measured defect: the supervisor launched `<dir>/sidecar.ts`. From source that is right; in the published package
  // the sources are not shipped (and Node will not strip types under node_modules), so every installed session got
  // no browser and no error. Resolved by looking, so BOTH layouts are exercisable here.
  const scratch = mkdtempSync(join(root as string, "entry-"));
  try {
    assert.equal(resolveSidecarEntry(scratch), join(scratch, "pi-central-sidecar.js"), "a bundled layout must use the bundle");
    writeFileSync(join(scratch, "sidecar.ts"), "");
    assert.equal(resolveSidecarEntry(scratch), join(scratch, "sidecar.ts"), "a source layout must use the source");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a session can opt IN per session, without the app default being on", () => {
  if (skip) return console.log(skip);
  // The UI gate's request shape: the picker sends `sidecar: true` for one session. Without this the only way to get a
  // browser would be a global switch, so a reader who wanted one for a single frontend task could not have it.
  const state = join(root as string, "opt-in");
  const app = new Supervisor(config({ stateRoot: state }) as never, { rememberOpenSessions: false });
  app.on("error", () => {});
  app.on("log", () => {});
  const asked = app.start({ cwd: root as string, mode: "sandboxed", sidecar: true });
  const plain = app.start({ cwd: root as string, mode: "sandboxed" });
  assert.ok(asked.ok && plain.ok);
  if (!asked.ok || !plain.ok) return;
  assert.ok(
    existsSync(join(state, "sidecars", asked.session.id, "mcp.json")),
    "an explicit opt-in must arm the session even with the default off",
  );
  assert.ok(
    !existsSync(join(state, "sidecars", plain.session.id, "mcp.json")),
    "and a session that did not ask must stay without one",
  );
  // The event the UI reads to show which address the browser can see.
  assert.match(asked.session.sidecarOrigin ?? "", /^http:\/\/localhost:\d+$/, "the session must report its browser's origin");
  assert.equal(plain.session.sidecarOrigin, undefined, "a session with no browser must report no origin");
  return app.stopAll().then(() => undefined);
});

test("a per-session opt-in cannot grant a browser that the installation does not offer", () => {
  if (skip) return console.log(skip);
  // Both halves of the gate: the client may ask, and the orchestrator still decides. A machine with no browser
  // configured, or an app with the feature off, must not be turned on by a control message.
  const app = new Supervisor(config({ stateRoot: join(root as string, "no-grant") }) as never, {
    rememberOpenSessions: false,
  });
  app.on("error", () => {});
  const started = app.start({ cwd: root as string, mode: "direct", sidecar: true });
  assert.ok(started.ok);
  if (!started.ok) return;
  // A DIRECT session applies no policy at all, so a sidecar beside it would be confined by nothing: that refusal is
  // the existing rule, and an opt-in must not bypass it.
  assert.equal(started.session.sidecarOrigin, undefined, "an opt-in must not arm an unsandboxed session");
  return app.stopAll().then(() => undefined);
});

test("a Pi Central checkout is told it cannot serve its own orchestrator, and what to do instead", () => {
  // Measured: an agent asked to start the dev server and look at the login page in a Pi Central checkout spent its
  // whole turn discovering C1, offering three workarounds, and showed no screenshot. The instruction said nothing about
  // a project whose own start script spawns a sandboxed child, which is the one case a session cannot work around.
  const dir = join(root as string, "self-hosted");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-central" }));
  assert.equal(isPiCentralCheckout(dir), true, "the checkout must be recognised by its manifest");

  const text = sidecarInstruction(48001, true);
  assert.match(text, /is inside a sandbox/, "the instruction must name the failure the agent will see");
  assert.match(text, /C1/, "and the constraint, so it stops looking for a flag");
  assert.match(text, /ui:dev/, "and the one way to see the interface from inside a session");
  assert.match(text, /48001/, "naming the port it was actually assigned");
  assert.match(text, /do not spend turns/, "and telling it not to hunt for a way around the sandbox");

  // The appendix is for THIS project only: every other session must not be given an irrelevant warning.
  assert.ok(!sidecarInstruction(48001, false).includes("This project IS Pi Central"));
});

test("a project merely NAMED pi-central is not the checkout", () => {
  // The detector reads the manifest name, so this case is the one it would get wrong if it matched a path or a word.
  const theirs = join(root as string, "not-ours");
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(theirs, "package.json"), JSON.stringify({ name: "pi-central-dashboard" }));
  assert.equal(isPiCentralCheckout(theirs), false);
  assert.equal(isPiCentralCheckout(join(root as string, "nowhere")), false, "a missing manifest is not a match");
});

test("the session's own directory decides the appendix, through the prompt arguments", () => {
  if (skip) return console.log(skip);
  // The wiring, not just the text: `sidecarPromptArgs` takes the cwd, and `#buildLaunch` passes it. Removing either
  // leaves `sidecarInstruction` correct and the agent uninformed -- which is exactly the state that was measured.
  const dir = join(root as string, "wiring");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-central" }));
  const handle = {
    configFile: join(dir, "mcp.json"),
    origin: "http://localhost:48001",
    devPort: 48001,
    token: "t",
    port: () => 47801,
    ready: Promise.resolve(47801),
    stop: async () => {},
    gone: false,
  };
  const own = sidecarPromptArgs(handle, dir).join(" ");
  const other = sidecarPromptArgs(handle, join(root as string, "elsewhere")).join(" ");
  assert.match(own, /This project IS Pi Central/, "a Pi Central checkout must be told");
  assert.doesNotMatch(other, /This project IS Pi Central/, "and another project must not be");
  assert.deepEqual(sidecarPromptArgs(undefined, dir), [], "no sidecar, no instruction");
});

test("the config-directory grant is passed only for a session that has a sidecar", () => {
  if (skip) return console.log(skip);
  // The wiring, not just the renderer. A session WITH a sidecar that did not get the grant shows "0 servers configured"
  // while the sidecar sits listening -- measured, and invisible from every other angle. A session WITHOUT one that got
  // the grant would be an unexplained capability.
  //
  // Asserted on the rendered policy through the public renderer plus a source check of the call site, because the
  // supervisor writes ONE fragment file that the last spawn overwrites: reading it back cannot attribute it to a
  // session, which is how the first version of this test failed.
  const withDir = renderPolicyFragment({
    agentRoot: join(root as string, "agent"),
    sidecarConfigDir: join(root as string, "sidecars", "s1"),
  });
  assert.match(withDir, /The UI sidecar's config/);
  const withoutDir = renderPolicyFragment({ agentRoot: join(root as string, "agent") });
  assert.doesNotMatch(withoutDir, /The UI sidecar's config/);

  const source = readFileSync(join(import.meta.dirname, "..", "src", "supervisor.ts"), "utf8");
  assert.match(
    source,
    /sidecarHandle === undefined[\s\S]{0,120}\{\}\s*:\s*\{\s*sidecarConfigDir:/,
    "the grant must be conditional on the handle, and name the sidecar's own directory",
  );
  assert.match(source, /stateRoot, "sidecars", input\.id/, "and the directory must be the one spawnSidecar writes to");
});
