/**
 * The agent keychain's lock state, asked once per launch (issue #269).
 *
 * ## What this suite can and cannot prove
 *
 * The behaviour under test in the report is macOS's password dialog, and nothing in-process can raise one.
 * So the assertions are split exactly along that line:
 *
 *   - **Here:** the probe RUNS ONCE, the lock state is READ from an exit status rather than guessed, a
 *     hung dialog is bounded and reported as `locked`, and an absent keychain is not confused with a
 *     locked one. Each of those can fail, and does fail if the corresponding arm is reverted.
 *   - **`supervisor-keychain.test.ts`:** the count that matters to the reader — one probe for a restore of
 *     five sessions, and not one per spawn.
 *   - **`docs/…` / manual:** a real reboot. Stated as manual in the issue because a test that skipped there
 *     would read as a passing one.
 *
 * The fixture `security` scripts are real executables that print what the real command prints, measured on
 * this machine. That is deliberate: the mapping from exit status to state IS the claim, and a stub that
 * returned a state directly would prove the stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEYCHAIN_PROBE_TIMEOUT_MS,
  createKeychainProbe,
  describeKeychain,
  describeKeychainCheck,
  interpretKeychainProbe,
  keychainProbeArgv,
  type ProbeOutcome,
} from "../src/keychain.ts";

const root = mkdtempSync(join(tmpdir(), "pi-central-keychain-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

let counter = 0;

/** A `security` stand-in that prints one fixed outcome and exits with a chosen status. */
function fixtureSecurity(body: { stdout?: string; stderr?: string; exit: number; sleepSeconds?: number }): string {
  const dir = join(root, `bin${++counter}`);
  const file = join(dir, "security");
  mkdirSync(dir, { recursive: true });
  const { stdout = "", stderr = "", exit, sleepSeconds = 0 } = body;
  const script = [
    "#!/bin/sh",
    sleepSeconds > 0 ? `sleep ${sleepSeconds}` : ":",
    stdout === "" ? ":" : `printf '%s\\n' ${JSON.stringify(stdout)}`,
    stderr === "" ? ":" : `printf '%s\\n' ${JSON.stringify(stderr)} >&2`,
    `exit ${exit}`,
  ].join("\n");
  writeFileSync(file, `${script}\n`);
  chmodSync(file, 0o755);
  return file;
}

function outcome(overrides: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, timeoutMs: 8000, ...overrides };
}

// --- The argv is the boundary ----------------------------------------------------------------

test("the probe passes one read-only verb and the keychain path, and nothing else", () => {
  // The argv IS the guarantee that this cannot create, unlock, or rescue a keychain. A shape rather than a
  // policy, because a policy can be added to and a shape cannot.
  assert.deepEqual(keychainProbeArgv("/agent/agent.keychain-db"), [
    "show-keychain-info",
    "/agent/agent.keychain-db",
  ]);
});

// --- Reading the state from what the command actually printed --------------------------------

test("an exit 0 is 'unlocked' — the settings were printed without a password", () => {
  const report = interpretKeychainProbe(
    outcome({ code: 0, stdout: 'Keychain "/agent/agent.keychain-db" no-timeout' }),
    "/agent/agent.keychain-db",
  );
  assert.equal(report.state, "unlocked");
  assert.equal(report.code, 0);
  assert.equal(report.probed, true);
});

test("a dismissed password dialog is 'locked', not a fatal error", () => {
  // Measured: `security show-keychain-info <locked path>` prints "User canceled the operation" and exits
  // 128 when the prompt is dismissed. Cancelling has to be a supported outcome — the report's users found
  // it was the ONLY way out, which is the trap this criterion removes.
  const report = interpretKeychainProbe(
    outcome({ code: 128, stderr: "security: SecKeychainCopySettings /a/k-db: User canceled the operation." }),
    "/a/k-db",
  );
  assert.equal(report.state, "locked");
  assert.match(report.detail, /dismissed/);
});

test("a wrong password is 'locked' and named as the password, not as a permission", () => {
  const report = interpretKeychainProbe(
    outcome({ code: 51, stderr: "security: SecKeychainUnlock /a/k-db: The user name or passphrase you entered is not correct." }),
    "/a/k-db",
  );
  assert.equal(report.state, "locked");
  assert.match(report.detail, /not accepted/);
});

test("a keychain file that is not there is 'absent', which is a setup fact and not a lock", () => {
  const report = interpretKeychainProbe(
    outcome({ code: 50, stderr: "security: SecKeychainCopySettings /a/k-db: The specified keychain could not be found." }),
    "/a/k-db",
  );
  assert.equal(report.state, "absent");
  assert.match(report.detail, /no keychain at \/a\/k-db/);
});

test("an unexplained exit status is 'unknown', never guessed as unlocked", () => {
  // The C13/C15 lesson applied to a new check: a state that was not shown to be good must not be reported
  // as good. A silently-healthy default is how "the session cannot think" hides.
  const report = interpretKeychainProbe(outcome({ code: 7, stderr: "security: something new happened" }), "/a/k-db");
  assert.equal(report.state, "unknown");
  assert.equal(report.code, 7);
  assert.match(report.detail, /something new happened/);
});

test("a security that could not be started at all is 'unknown' and says so", () => {
  // `spawn` reports a missing binary as an `error` event with no `exit`, so `code` is null here.
  const report = interpretKeychainProbe(outcome({ code: null, stderr: "ENOENT: spawn /usr/bin/security ENOENT" }), "/a/k-db");
  assert.equal(report.state, "unknown");
  assert.match(report.detail, /could not be run/);
});

test("an expired wait is 'locked' and states the bound that expired", () => {
  // The dialog nobody answers. Reported as locked rather than as `unknown` because the honest reading of
  // "did not answer 0 in time" is "not shown to be unlockable" — and that puts C13's warning on every
  // affected session instead of leaving them reporting `idle` while unable to think.
  const report = interpretKeychainProbe(
    outcome({ code: null, signal: "SIGKILL", timedOut: true, timeoutMs: 8000 }),
    "/a/k-db",
  );
  assert.equal(report.state, "locked");
  assert.match(report.detail, /not answered within 8 s/);
});

// --- The probe runs once, and that is the mechanism -------------------------------------------

test("concurrent and repeated probes run the command ONCE", async () => {
  const path = join(root, "present.keychain-db");
  writeFileSync(path, "not a real keychain\n");
  let calls = 0;
  const probe = createKeychainProbe({
    path,
    exists: () => true,
    invoke: async () => {
      calls += 1;
      return outcome({ code: 0 });
    },
  });

  // Ten asks is a restore of ten sessions, all of which see the same keychain.
  const answers = await Promise.all([probe.probe(), probe.probe(), probe.probe(), probe.probe(), probe.probe()]);
  await probe.probe();
  assert.equal(calls, 1, "one keychain question per launch, however many sessions ask");
  for (const answer of answers) assert.equal(answer.state, "unlocked");
  assert.equal(probe.report()?.state, "unlocked", "the answer is readable afterwards without asking again");
});

test("an absent keychain is answered without running the command at all", async () => {
  let calls = 0;
  const probe = createKeychainProbe({
    path: "/nonexistent/agent.keychain-db",
    exists: () => false,
    invoke: async () => {
      calls += 1;
      return outcome({ code: 0 });
    },
  });
  const report = await probe.probe();
  assert.equal(calls, 0, "there is nothing to unlock, so nothing should be asked");
  assert.equal(report.state, "absent");
  assert.equal(report.probed, false, "and it must not claim to have asked");
});

test("report() never starts a probe, so a spawn path cannot raise a dialog", () => {
  let calls = 0;
  const probe = createKeychainProbe({
    path: "/a/k-db",
    exists: () => true,
    invoke: async () => {
      calls += 1;
      return outcome({ code: 0 });
    },
  });
  assert.equal(probe.report(), undefined, "nothing has been asked yet, and that is the answer");
  assert.equal(calls, 0);
});

// --- The bound, exercised through a real child ------------------------------------------------

test("a hanging security is bounded, and the launch is told 'locked' rather than waiting forever", async () => {
  // A REAL fixture process that sleeps past the bound, so the timeout path in `runSecurityProbe` runs
  // rather than being described. A stubbed `invoke` cannot exercise it: it replaces the run entirely.
  const path = join(root, "locked.keychain-db");
  writeFileSync(path, "not a real keychain\n");
  const probe = createKeychainProbe({
    path,
    securityPath: fixtureSecurity({ exit: 0, sleepSeconds: 5, stdout: "never printed in time" }),
    timeoutMs: 150,
    noteAfterMs: 20,
  });

  const started = Date.now();
  const report = await probe.probe();
  const elapsed = Date.now() - started;

  assert.equal(report.state, "locked", "an unanswered prompt is not a healthy keychain");
  assert.equal(report.probed, true);
  assert.ok(elapsed < 2000, `the wait must be bounded by the probe's own timeout, took ${elapsed} ms`);
});

test("the real bound leaves room inside the shell's own 10 s URL budget", () => {
  // The desktop shell kills an orchestrator that prints no URL within `URL_TIMEOUT_MS` (10 s), and this probe
  // runs BEFORE that line is printed. A probe that took as long as the shell's budget would turn "a dialog
  // nobody answered" into "the app never starts", which is the opposite of the fix.
  assert.ok(
    KEYCHAIN_PROBE_TIMEOUT_MS < 10_000,
    "the probe must finish inside the shell's URL budget, or a locked keychain stops the app starting",
  );
});

test("a note fires while the dialog is still up, so the prompt can be attributed", async () => {
  // The OS dialog names neither Pi Central nor the keychain's path. A line printed BEFORE it is read is the
  // only way the reader learns which keychain is asking (acceptance criterion 8).
  const path = join(root, "noted.keychain-db");
  writeFileSync(path, "not a real keychain\n");
  let noted: string | undefined;
  const probe = createKeychainProbe({
    path,
    securityPath: fixtureSecurity({ exit: 0, sleepSeconds: 1 }),
    timeoutMs: 3000,
    noteAfterMs: 100,
    onWaitingForPrompt: (waited) => {
      noted = waited;
    },
  });
  const report = await probe.probe();
  assert.equal(report.state, "unlocked");
  assert.equal(noted, path, "the note must name the keychain asking, and arrive while it is still asking");
});

// --- Reporting --------------------------------------------------------------------------------

test("a locked keychain's line names its path, so it is distinguishable from the login keychain's prompt", () => {
  const line = describeKeychain({
    state: "locked",
    path: "/Users/x/.agent/agent.keychain-db",
    detail: "its password prompt was dismissed, so it is still locked",
    code: 128,
    probed: true,
  });
  assert.match(line, /LOCKED/);
  assert.match(line, /\/Users\/x\/\.agent\/agent\.keychain-db/);
  assert.match(line, /cannot reach a model/, "the consequence is what makes the line actionable (C13)");
});

test("a skipped check does not read like a passing one", () => {
  // `needed: false` means the provider configuration resolves nothing through a command. Saying
  // "unlocked" there would be a claim nothing verified.
  assert.match(describeKeychainCheck({ needed: false }), /not needed/);
  assert.match(describeKeychainCheck({ needed: true }), /NOT CHECKED/);
});
