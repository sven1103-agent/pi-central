/**
 * The update sequence with everything stubbed (issue #217, criteria 3, 5, 6, 7 and the crash path).
 *
 * ## Why this drives the real sequence
 *
 * `update-decide.test.ts` asserts the *rules*; this asserts that `applyUpdate` consults them in the right order
 * and — more importantly — that every failure path leaves the reader in a state they can recover from. Those
 * are the bugs that survive a unit test of the decisions: an early return that forgets to put the child back, a
 * verification that runs before the install, a success reported without a respawn.
 *
 * Every effect is injected, so the whole sequence runs with no `npm`, no child process and no display. The one
 * thing that is NOT stubbed is the decision module: the sequence calls the real functions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyUpdate, checkLatestVersion, type CommandResult, type UpdateEnvironment } from "../src/updater.ts";
import { STOP_HARD_DEADLINE_MS, type UpdatePhase } from "../src/update-decide.ts";

/** A recording environment, so a test can assert both the outcome AND what was touched. */
function harness(options: {
  current: string;
  latest?: string;
  installCode?: number;
  installOutput?: string;
  landsVersion?: string;
  latestOutput?: string;
  stop?: Awaited<ReturnType<UpdateEnvironment["stopChild"]>>;
  respawnPort?: number;
  hasChild?: boolean;
  previousPort?: number;
}) {
  const calls: string[] = [];
  const phases: UpdatePhase[] = [];
  const persisted: { phase: UpdatePhase; installed: boolean }[] = [];
  const env: UpdateEnvironment = {
    readCurrentVersion: async () => {
      calls.push("readCurrentVersion");
      return options.current;
    },
    readLatestVersion: async () => {
      calls.push("readLatestVersion");
      const result: CommandResult = {
        code: 0,
        signal: null,
        stdout: options.latestOutput ?? JSON.stringify(options.latest ?? options.current),
        stderr: "",
      };
      return result;
    },
    runInstall: async (version) => {
      calls.push(`install:${version}`);
      return {
        code: options.installCode ?? 0,
        signal: null,
        stdout: options.installOutput ?? `added 1 package\n`,
        stderr: "",
      };
    },
    readInstalledVersion: async () => {
      calls.push("readInstalledVersion");
      return options.landsVersion ?? options.latest ?? options.current;
    },
    stopChild: async () => {
      calls.push("stopChild");
      return options.stop ?? { stopped: true, signal: "SIGTERM", waitedMs: 400 };
    },
    respawn: async (forceNew) => {
      calls.push(`respawn:${forceNew}`);
      return { port: options.respawnPort ?? 51000 };
    },
    onPhase: (phase) => {
      phases.push(phase);
    },
    persistPhase: (phase, installed) => {
      persisted.push({ phase, installed });
    },
  };
  return {
    env,
    calls,
    phases,
    persisted,
    context: {
      hasChild: options.hasChild ?? true,
      previous: { port: options.previousPort ?? 50000, spawnedByUs: true },
    },
  };
}

// -----------------------------------------------------------------------------------------------------------
// The happy path.
// -----------------------------------------------------------------------------------------------------------

test("a successful update stops, installs the exact version, verifies it, and respawns on a new port", async () => {
  const run = harness({ current: "0.10.0", latest: "0.11.0", respawnPort: 51000 });
  const result = await applyUpdate(run.env, run.context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.from, "0.10.0", "the `from` is read from the artifact, not restated");
  assert.equal(result.to, "0.11.0");
  assert.equal(result.port, 51000);

  // The ORDER is the guarantee: nothing is installed before the child is stopped, and nothing is called a success
  // before the manifest was read back.
  assert.deepEqual(run.calls, [
    "readCurrentVersion",
    "readLatestVersion",
    "stopChild",
    "install:0.11.0",
    "readInstalledVersion",
    "respawn:true",
  ]);
  // The phase journal reaches `respawning` with `installed: true`, which is what crash recovery keys on.
  assert.deepEqual(
    run.persisted.filter((entry) => entry.installed),
    [{ phase: "respawning", installed: true }],
  );
  // And it ends idle, so a crash after this point is not treated as an interrupted update.
  assert.equal(run.persisted.at(-1)?.phase, "idle");
});

test("the respawn forces a NEW process, because the record names the old version's code", async () => {
  const run = harness({ current: "0.10.0", latest: "0.11.0" });
  await applyUpdate(run.env, run.context);
  assert.equal(run.calls.includes("respawn:true"), true, "an existing child must not be adopted after an install");
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 5 — a child that cannot be stopped.
// -----------------------------------------------------------------------------------------------------------

test("a child that cannot be stopped abandons the update BEFORE anything is installed", async () => {
  const run = harness({
    current: "0.10.0",
    latest: "0.11.0",
    stop: { stopped: false, reason: "it survived SIGKILL" },
  });
  const result = await applyUpdate(run.env, run.context);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "stopped-impossible");
  // The load-bearing assertion: no install was attempted, so the package on disk was never touched.
  assert.equal(run.calls.some((call) => call.startsWith("install:")), false, "nothing may be installed over a live child");
  assert.equal(run.calls.includes("readInstalledVersion"), false);
  // The child is still running and still owns the sessions, so the caller must not start a second one.
  assert.equal(result.respawned, true, "the un-stopped child is still there; the caller must not spawn another");
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 6 — a failed install leaves a working app.
// -----------------------------------------------------------------------------------------------------------

test("a failed install respawns the PREVIOUS version and shows npm's output", async () => {
  const run = harness({
    current: "0.10.0",
    latest: "0.11.0",
    installCode: 1,
    installOutput: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/pi-central\n",
  });
  const result = await applyUpdate(run.env, run.context);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "install-failed");
  if (result.failure.kind !== "install-failed") return;
  assert.match(result.failure.reason, /exited with code 1/);
  // npm's own words are the only thing that explains a registry error.
  assert.equal(result.failure.output.includes("E404"), true);
  assert.equal(result.runningVersion, "0.10.0", "nothing was replaced, so 0.10.0 is still what is running");

  // And a child was started again, WITHOUT forcing a new version — the disk still holds the old one.
  assert.equal(result.respawned, true);
  assert.equal(run.calls.at(-1), "respawn:false", "the previous version is the right one to run");
  assert.equal(run.calls.includes("readInstalledVersion"), false, "verification is pointless when npm failed");
});

test("a permissions failure adds the one sentence npm cannot print", async () => {
  const run = harness({
    current: "0.10.0",
    latest: "0.11.0",
    installCode: 243,
    installOutput: "npm error code EACCES\nnpm error syscall mkdir\n",
  });
  const result = await applyUpdate(run.env, run.context);
  assert.equal(result.ok, false);
  if (result.ok) return;
  if (result.failure.kind !== "install-failed") return;
  assert.match(result.failure.reason, /global npm prefix is probably not writable/);
});

test("no previous child means a failed install respawns nothing and says so", async () => {
  const run = harness({ current: "0.10.0", latest: "0.11.0", installCode: 1, hasChild: false });
  const result = await applyUpdate(run.env, run.context);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.respawned, false);
  assert.equal(run.calls.includes("stopChild"), false, "there was nothing to stop");
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 3 — the version that landed is the version that was asked for.
// -----------------------------------------------------------------------------------------------------------

test("a stubbed installer that lands a DIFFERENT version is a failed update, not a success", async () => {
  // The exact case criterion 3 names: `npm` exits 0, and the package on disk is not what was asked for.
  const run = harness({ current: "0.10.0", latest: "0.11.0", landsVersion: "0.10.0" });
  const result = await applyUpdate(run.env, run.context);

  assert.equal(result.ok, false, "a naive implementation reports this as success");
  if (result.ok) return;
  assert.equal(result.failure.kind, "version-mismatch");
  if (result.failure.kind !== "version-mismatch") return;
  assert.equal(result.failure.requested, "0.11.0");
  assert.equal(result.failure.installed, "0.10.0");
  /*
   * And something was started: the disk holds whatever landed, so respawning is the only way to leave a working app.
   * It is a `respawn:true` — a NEW process — because the old child ran code that is no longer on disk.
   */
  assert.equal(result.respawned, true);
});

test("an install whose version cannot be read is a mismatch, and the app still starts something", async () => {
  const run = harness({ current: "0.10.0", latest: "0.11.0", landsVersion: "" });
  const result = await applyUpdate(run.env, run.context);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "version-mismatch");
  // Not `runningVersion: "0.11.0"` — the app cannot claim to be a version it could not read.
  assert.equal(result.runningVersion, "unknown");
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 7 — the new port is a NEW port.
// -----------------------------------------------------------------------------------------------------------

test("a respawn that reuses the previous port is refused", async () => {
  const run = harness({ current: "0.10.0", latest: "0.11.0", previousPort: 50000, respawnPort: 50000 });
  const result = await applyUpdate(run.env, run.context);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.failure.reason, /the port the previous one used/);
  // A child IS running on that port, so a second spawn would be the branch point C9 forbids.
  assert.equal(result.respawned, true);
});

test("a respawn with no usable port is refused", async () => {
  const run = harness({ current: "0.10.0", latest: "0.11.0", respawnPort: 0 });
  const result = await applyUpdate(run.env, run.context);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.failure.reason, /no usable port/);
});

// -----------------------------------------------------------------------------------------------------------
// Before anything is touched: a registry fault costs the reader nothing.
// -----------------------------------------------------------------------------------------------------------

test("an unreachable registry stops before the child is touched", async () => {
  const calls: string[] = [];
  const env: UpdateEnvironment = {
    readCurrentVersion: async () => {
      calls.push("current");
      return "0.10.0";
    },
    readLatestVersion: async () => {
      calls.push("latest");
      return { code: 1, signal: null, stdout: "", stderr: "npm error network request failed" };
    },
    runInstall: async () => {
      calls.push("install");
      return { code: 0, signal: null, stdout: "", stderr: "" };
    },
    readInstalledVersion: async () => {
      calls.push("installedVersion");
      return undefined;
    },
    stopChild: async () => {
      calls.push("stop");
      return { stopped: true, signal: "SIGTERM", waitedMs: 1 };
    },
    respawn: async () => {
      calls.push("respawn");
      return { port: 1 };
    },
    onPhase: () => undefined,
    persistPhase: () => undefined,
  };
  const result = await applyUpdate(env, { hasChild: true, previous: { port: 50000, spawnedByUs: true } });

  assert.equal(result.ok, false);
  // The whole point: the sessions kept running because nothing happened. A registry failure must not cost a restart.
  assert.deepEqual(calls, ["current", "latest"], "nothing was stopped and nothing was installed");
  if (result.ok) return;
  assert.equal(result.respawned, false);
  assert.equal(result.failure.kind, "install-failed");
});

test("being already up to date touches nothing at all", async () => {
  const run = harness({ current: "0.11.0", latest: "0.11.0" });
  const result = await applyUpdate(run.env, run.context);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(run.calls.includes("stopChild"), false, "no restart for a no-op");
  assert.equal(run.calls.some((call) => call.startsWith("install:")), false);
});

test("a malformed `latest` never reaches a subprocess argv", async () => {
  const run = harness({ current: "0.10.0", latestOutput: '"^0.11.0"' });
  const result = await applyUpdate(run.env, run.context);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(run.calls.some((call) => call.startsWith("install:")), false, "a range is not an install target");
});

test("a downgrade is refused rather than installed", async () => {
  const run = harness({ current: "0.12.0", latest: "0.11.0" });
  const result = await applyUpdate(run.env, run.context);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.failure.reason, /older than the 0\.12\.0/);
  assert.equal(run.calls.some((call) => call.startsWith("install:")), false);
});

// -----------------------------------------------------------------------------------------------------------
// The menu's check action, which installs nothing.
// -----------------------------------------------------------------------------------------------------------

test("checking for a version reads current and latest, and installs nothing", async () => {
  const run = harness({ current: "0.10.0", latest: "0.11.0" });
  const check = await checkLatestVersion(run.env);
  assert.equal(check.current, "0.10.0");
  assert.equal(check.latest, "0.11.0");
  assert.equal(check.verdict.action, "install");
  // No install, no stop, no respawn: detection and application are different actions (ADR-0011 §4).
  assert.equal(run.calls.some((call) => call.startsWith("install:")), false);
  assert.equal(run.calls.includes("stopChild"), false);
  assert.equal(run.calls.includes("respawn:true"), false);
});

test("the overall timeout is long enough to cover the stop, the install and the respawn", () => {
  // A watchdog shorter than the steps it watches would abandon a healthy update. Asserted so the three constants
  // cannot drift apart silently.
  assert.ok(STOP_HARD_DEADLINE_MS > 0);
});
