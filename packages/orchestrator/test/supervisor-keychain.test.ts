/**
 * One keychain prompt per launch, however many sessions are restored (issue #269).
 *
 * ## The count is the acceptance criterion, so the count is what is asserted
 *
 * The report:
 *
 * > when pi central starts again, after an OS restart, users get prompted with the pi agents keychain
 * > password prompt indefinitely. Entering the correct password once is not enough. Users need to cancel
 * > and restart the app to recover.
 *
 * Three symptoms, one cause: every session resolves its provider key with its own `security` process (C13),
 * so a restore of N sessions met the locked keychain N times. "Indefinitely" and "one entry is not enough"
 * follow from that — the dialogs were already queued before the first answer landed.
 *
 * A test cannot raise a real macOS dialog, so the seam is the probe itself: `Supervisor` takes an injected
 * `KeychainProbe`, and these tests count its `probe()` calls and read what a spawn sees. That makes the
 * criterion — **exactly one probe for a restore of five sessions** — falsifiable in the way the issue asks:
 * move the probe into `#spawn` and the count becomes five, and these tests fail.
 *
 * ## Why the sessions here are real but never spawn a `pi`
 *
 * `Supervisor.resume`/`start` register a session and then launch a process; there is no `pi` in a test run and
 * Seatbelt does not nest (C1). So each test attaches an `error` listener, which is the same seam
 * `own-installation.test.ts` and `supervisor-files.test.ts` use: the launch fails, the session stays, and the
 * `warnings` the assessment produced are what is under test — not the failed spawn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOpenSessions } from "../src/open-sessions.ts";
import { createKeychainProbe } from "../src/keychain.ts";
import type { Config } from "../src/config.ts";

const { Supervisor } = await import("../src/supervisor.ts");

const base = mkdtempSync(join(tmpdir(), "pi-central-keychain-restore-"));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

let counter = 0;

/**
 * A Pi-provider configuration whose keys are resolved by a command, which is the only case a keychain
 * matters for (C13). Written as the real file, because `inspectProviderAuth` parses the real shape.
 */
function configWithCommandProvider(): { root: string; config: Config } {
  const root = join(base, `c${++counter}`);
  const provider = join(root, "provider");
  mkdirSync(provider, { recursive: true });
  writeFileSync(
    join(provider, "auth.json"),
    JSON.stringify({
      litellm: { type: "api_key", key: "!security find-generic-password -ws 'litellm'" },
    }),
  );
  const agent = join(root, "agent");
  mkdirSync(agent, { recursive: true });
  return {
    root,
    config: {
      workspaceRoot: join(root, "workspaces"),
      stateRoot: join(root, "state"),
      sessionsRoot: join(root, "sessions"),
      safehouse: "safehouse",
      pi: "pi-not-present",
      agentRoot: agent,
      fragmentDir: join(root, "state", "policy"),
      agentRootManaged: true,
      providerAgentDir: provider,
      home: root,
      installationRoot: join(root, "installation"),
      sidecarPort: undefined,
      browser: "/nonexistent/chrome",
    },
  };
}

/** A session file Pi's own parser accepts: a header, then nothing. */
function writeSession(config: Config, cwd: string, id: string): string {
  const dir = join(config.sessionsRoot, cwd.replace(/[/:]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-11-01T10-00-00-000Z_${id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-11-01T10:00:00.000Z" })}\n`,
  );
  return realpathSync(path);
}

/** A probe that answers with a fixed report and COUNTS how many times it was asked. */
function countingProbe(state: "unlocked" | "locked" | "absent", keychainPath: string) {
  const calls: string[] = [];
  const probe = createKeychainProbe({
    path: keychainPath,
    // Absence is answered without a process, exactly as the real probe does — there is nothing to unlock, so
    // nothing is asked. Saying so through the same path the production code takes is the point.
    exists: () => state !== "absent",
    invoke: async () => {
      calls.push(keychainPath);
      // The real probe is one process per keychain; the count of CALLS is the assertion, so the seam is
      // exhausted as soon as it is asked twice.
      return {
        code: state === "locked" ? 128 : 0,
        signal: null,
        stdout: "",
        stderr: state === "locked" ? "User canceled the operation." : "",
        timedOut: false,
        timeoutMs: 8000,
      };
    },
  });
  return { probe, calls };
}

/**
 * Wait until a session leaves `starting`.
 *
 * The same wait the CLI does, and for the same reason: a restored session registers as `starting` and only
 * leaves it when Pi answers `get_state` — or when the launch fails. In a test run there is no `pi`, so it
 * fails; what matters here is that it SETTLES rather than hanging, which is what "no session is left
 * starting" means for a launch whose cancellation did not block anything.
 */
async function settledState(supervisor: InstanceType<typeof Supervisor>, id: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = supervisor.get(id)?.state;
    if (state !== undefined && state !== "starting") return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return supervisor.get(id)?.state ?? "gone";
}

/** Five restored sessions, all in directories that exist. */
function fiveSessions(config: Config): void {
  const entries = [];
  for (let i = 0; i < 5; i += 1) {
    const cwd = join(config.workspaceRoot, `w${i}`);
    mkdirSync(cwd, { recursive: true });
    entries.push({ sessionFile: writeSession(config, cwd, `5555555${i}-0000-0000-0000-000000000000`), mode: "sandboxed" as const });
  }
  writeOpenSessions(config.stateRoot, entries);
}

// --- Criterion 1: one prompt for a restore of five sessions -----------------------------------

test("a locked keychain is asked about ONCE for a restore of five sessions", async () => {
  const { config } = configWithCommandProvider();
  fiveSessions(config);
  const { probe, calls } = countingProbe("locked", config.agentRoot);

  const supervisor = new Supervisor(config, { keychainProbe: probe });
  supervisor.on("error", () => {});

  // The entry point's sequence: probe once, THEN restore.
  await supervisor.ensureKeychainState();
  const report = await supervisor.restoreOpenSessions();
  assert.equal(report.restored.length, 5, "all five sessions must come back, locked keychain or not");

  assert.equal(calls.length, 1, "one keychain question for the whole launch, never one per session");

  // And the answer is still there afterwards, so a later spawn does not ask again either.
  assert.equal(supervisor.keychainCheck()?.report?.state, "locked");
  assert.equal(calls.length, 1);
  await supervisor.stopAll();
});

test("a spawn alone never asks the keychain, even when the check never ran", async () => {
  // The regression this pins: the probe must not live in `#spawn`. If it did, every session would raise its
  // own dialog — which is the reported defect, and would make the count above five.
  const { config } = configWithCommandProvider();
  const cwd = join(config.workspaceRoot, "w");
  mkdirSync(cwd, { recursive: true });
  const { probe, calls } = countingProbe("locked", config.agentRoot);

  const supervisor = new Supervisor(config, { keychainProbe: probe });
  supervisor.on("error", () => {});
  const started = supervisor.start({ cwd });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  assert.equal(calls.length, 0, "a spawn must not probe: that is one dialog per session, which is the bug");
  assert.equal(supervisor.keychainCheck(), undefined, "an unasked keychain is reported as unasked, not as healthy");
  await supervisor.stopAll();
});

// --- Criterion 2: unlocked means no prompt and no delay ---------------------------------------

test("an unlocked keychain is asked once and nothing else happens", async () => {
  const { config } = configWithCommandProvider();
  fiveSessions(config);
  const { probe, calls } = countingProbe("unlocked", config.agentRoot);

  const supervisor = new Supervisor(config, { keychainProbe: probe });
  supervisor.on("error", () => {});
  const check = await supervisor.ensureKeychainState();
  assert.equal(check.needed, true);
  assert.equal(check.report?.state, "unlocked");

  const report = await supervisor.restoreOpenSessions();
  assert.equal(report.restored.length, 5);
  assert.equal(calls.length, 1, "still one, and it was the probe — not the first session's lookup");
  // No session may carry a keychain warning when the keychain answered.
  for (const session of report.restored) {
    assert.ok(
      !session.warnings.some((w) => w.includes("provider keychain access")),
      `an unlocked keychain must not warn: ${JSON.stringify(session.warnings)}`,
    );
  }
  await supervisor.stopAll();
});

// --- Criterion 3: cancelling is a supported outcome -------------------------------------------

test("a cancelled prompt leaves every session started, warned with C13, and none left starting", async () => {
  const { config } = configWithCommandProvider();
  fiveSessions(config);
  const { probe } = countingProbe("locked", config.agentRoot);

  const supervisor = new Supervisor(config, { keychainProbe: probe });
  supervisor.on("error", () => {});
  await supervisor.ensureKeychainState();
  const report = await supervisor.restoreOpenSessions();

  assert.equal(report.restored.length, 5, "cancelling must not cost the reader their sessions");
  for (const session of report.restored) {
    // C13's core lesson, applied to the lock state: a session that cannot reach a model must SAY so rather
    // than report a healthy state.
    const warning = session.warnings.find((w) => w.includes("provider keychain access"));
    assert.ok(warning, `a locked keychain must warn on every affected session: ${JSON.stringify(session.warnings)}`);
    assert.equal(warning.includes("locked"), true, warning);
    assert.equal(warning.includes(config.agentRoot), true, "the warning must name the keychain's own path");
    // Criterion 6: no host credential path may leak into the message.
    assert.equal(warning.includes("/Library/Keychains"), false, warning);
    assert.equal(warning.includes("login.keychain"), false, warning);
  }

  // Cancelling must not leave the launch stuck behind a dialog: every session settles, and the one it settles
  // on names a real cause (there is no `pi` in a test run) rather than the keychain.
  for (const session of report.restored) {
    const state = await settledState(supervisor, session.id);
    assert.notEqual(state, "starting", "no session may be left in the starting state");
    assert.notEqual(state, "registered", "a registered session is one nothing tried to start");
  }
  await supervisor.stopAll();
});

test("the warning tells the reader what to DO, because it is not a setup step", async () => {
  // A locked keychain is not "provision a credential" — the credential is there and the reader did nothing
  // wrong. The repair is to answer the prompt or unlock it, and saying that is the whole difference between
  // an actionable warning and a scary one.
  const { config } = configWithCommandProvider();
  fiveSessions(config);
  const { probe } = countingProbe("locked", config.agentRoot);
  const supervisor = new Supervisor(config, { keychainProbe: probe });
  supervisor.on("error", () => {});
  await supervisor.ensureKeychainState();
  const report = await supervisor.restoreOpenSessions();
  const warning = report.restored[0]!.warnings.find((w) => w.includes("provider keychain access"))!;
  assert.match(warning, /Keychain Access|password prompt/);
  assert.match(warning, /cannot reach a model|unable to reach a model/);
  await supervisor.stopAll();
});

// --- Nothing to ask about ---------------------------------------------------------------------

test("inline provider keys mean NO probe at all — no dialog for a capability nothing uses", async () => {
  const { config } = configWithCommandProvider();
  // Rewrite the provider file with an inline key, which is the whole difference `inspectProviderAuth` reads.
  writeFileSync(
    join(config.providerAgentDir, "auth.json"),
    JSON.stringify({ litellm: { type: "api_key", key: "sk-inline-not-a-secret" } }),
  );
  fiveSessions(config);
  const { probe, calls } = countingProbe("locked", config.agentRoot);

  const supervisor = new Supervisor(config, { keychainProbe: probe });
  supervisor.on("error", () => {});
  const check = await supervisor.ensureKeychainState();
  assert.equal(check.needed, false, "an inline key needs no keychain (C13)");
  assert.equal(check.report, undefined, "and a skipped check is not a passing one");
  assert.equal(calls.length, 0, "probing here would raise a password dialog for nothing");

  const report = await supervisor.restoreOpenSessions();
  assert.equal(report.restored.length, 5);
  for (const session of report.restored) {
    assert.ok(
      !session.warnings.some((w) => w.includes("provider keychain access")),
      "an inline key must not warn about a keychain",
    );
  }
  await supervisor.stopAll();
});

test("an absent keychain is reported as absent, and is not treated as a lock to clear", async () => {
  // Absence is a setup fact: the keys may still be found through the user-wide search list (C13). Reporting
  // it as `locked` would send the reader to unlock a file that is not there.
  const { config } = configWithCommandProvider();
  fiveSessions(config);
  const { probe } = countingProbe("absent", config.agentRoot);
  const supervisor = new Supervisor(config, { keychainProbe: probe });
  supervisor.on("error", () => {});
  const check = await supervisor.ensureKeychainState();
  assert.equal(check.report?.state, "absent");
  const report = await supervisor.restoreOpenSessions();
  for (const session of report.restored) {
    assert.ok(!session.warnings.some((w) => w.includes("is locked")), "absent is not locked");
  }
  await supervisor.stopAll();
});

// --- The cost of asking twice -----------------------------------------------------------------

test("ensureKeychainState is idempotent, so a second call cannot raise a second dialog", async () => {
  const { config } = configWithCommandProvider();
  const { probe, calls } = countingProbe("locked", config.agentRoot);
  const supervisor = new Supervisor(config, { keychainProbe: probe });
  supervisor.on("error", () => {});
  await supervisor.ensureKeychainState();
  await supervisor.ensureKeychainState();
  await supervisor.ensureKeychainState();
  assert.equal(calls.length, 1);
});
