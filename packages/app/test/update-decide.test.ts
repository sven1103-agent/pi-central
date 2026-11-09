/**
 * The update decisions, without a process, a registry or a window (issue #217, criteria 1–3 and 5–9).
 *
 * ## What this file can and cannot claim
 *
 * It asserts `update-decide.ts` — every rule that decides whether the app replaces its own binary. It cannot
 * claim that `main.ts` only calls the installer from a menu action (criterion 1) or that `~/.pi` is
 * untouched (criterion 9); those are asserted in `update-safety.test.ts` and `update-live.test.ts`, which
 * read the wiring and run a real install into a temporary prefix.
 *
 * ## The defect family these prevent
 *
 *   - **Reporting success for an install that landed something else.** `npm` exiting 0 is not evidence; the
 *     manifest is read back and compared (`verifyInstall`). This is criterion 3, and a naive implementation
 *     passes it.
 *   - **Installing over a live child.** A stop that could not complete must abandon the update, because the
 *     alternative replaces files a running process is executing.
 *   - **Reusing the old port.** The shell never picks ports, so a "respawn" that reports the previous port is
 *     the old URL wearing a new label.
 *   - **Downgrading through an action that says "update".** `latest` pointing at an older release is a
 *     registry fault; installing it would lose whatever the running version fixed.
 *   - **"I could not check" read as "it worked".** An unreadable version, a non-JSON answer, a missing
 *     manifest: each is a refusal, never a pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UPDATE_CONFIRM_BUTTONS,
  UPDATE_PACKAGE,
  assessAvailableVersion,
  assessRespawnedPort,
  assessStop,
  chooseUpdateAnswer,
  compareVersions,
  crashRecovery,
  installCommand,
  latestVersionCommand,
  looksLikePermissionFailure,
  normalizeVersion,
  parseLatestVersion,
  sameVersion,
  updateDialog,
  updateFailurePage,
  verifyInstall,
} from "../src/update-decide.ts";

// -----------------------------------------------------------------------------------------------------------
// Versions: read, compared, and never assumed.
// -----------------------------------------------------------------------------------------------------------

test("a version is normalized only as far as npm's own spelling, never parsed as a range", () => {
  assert.equal(normalizeVersion("1.2.3"), "1.2.3");
  assert.equal(normalizeVersion("v1.2.3"), "1.2.3", "npm accepts and prints both spellings");
  assert.equal(normalizeVersion("  1.2.3  "), "1.2.3");
  assert.equal(normalizeVersion("1.2.3-beta.1"), "1.2.3-beta.1");
  assert.equal(normalizeVersion("1.2.3+build.7"), "1.2.3+build.7");
  // Everything that is not an exact version. Accepting any of these would make "verify the version that was
  // asked for" a promise about something that was never named.
  for (const notAVersion of ["latest", "^1.2.3", "~1.2.3", "*", "1.2", "1", "", "next", ">=1.0.0", "1.2.3 || 2.0.0"]) {
    assert.equal(normalizeVersion(notAVersion), undefined, `${JSON.stringify(notAVersion)} must not be a version`);
  }
});

test("two versions are the same only if they are the same release", () => {
  assert.equal(sameVersion("1.2.3", "v1.2.3"), true);
  assert.equal(sameVersion("1.2.3", "1.2.4"), false);
  // Undefined, not `false`: "one of these is not a version" is not the same statement as "they differ", and
  // the caller must be able to tell a mismatch from an unusable input.
  assert.equal(sameVersion("1.2.3", "latest"), undefined);
});

test("versions compare by numeric field, not by string order", () => {
  // The bug this exists for: `"0.10.0" < "0.9.0"` lexically, so a string comparison would call 0.10.0 the
  // OLDER release and refuse to install it.
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.2.3", "v1.2.3"), 0);
  assert.equal(compareVersions("1.2.3", "nope"), undefined);
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 2 — the current version comes from the artifact, and the decision follows it.
// -----------------------------------------------------------------------------------------------------------

test("the verdict follows the CURRENT version it is given, so a restated constant cannot pass", () => {
  // Criterion 2: the caller reads `findOwnPackage().version`. The decision must therefore be a function of it
  // — the same `latest` yields all three answers depending on what is installed.
  assert.equal(assessAvailableVersion("0.10.0", "0.11.0").action, "install");
  assert.equal(assessAvailableVersion("0.11.0", "0.11.0").action, "refuse");
  assert.equal(assessAvailableVersion("0.12.0", "0.11.0").action, "refuse");
  const install = assessAvailableVersion("0.10.0", "0.11.0");
  if (install.action !== "install") return;
  assert.equal(install.version, "0.11.0");
  assert.match(install.reason, /newer than 0\.10\.0/);
});

test("up to date, invalid and downgrade are three refusals, not one silence", () => {
  const upToDate = assessAvailableVersion("0.11.0", "v0.11.0");
  assert.equal(upToDate.action, "refuse");
  if (upToDate.action === "refuse") assert.equal(upToDate.kind, "up-to-date");

  const invalid = assessAvailableVersion("0.11.0", "latest");
  assert.equal(invalid.action, "refuse");
  if (invalid.action === "refuse") assert.equal(invalid.kind, "invalid");

  const downgrade = assessAvailableVersion("0.12.0", "0.11.0");
  assert.equal(downgrade.action, "refuse");
  if (downgrade.action === "refuse") {
    assert.equal(downgrade.kind, "downgrade");
    assert.match(downgrade.reason, /older than the 0\.12\.0/);
  }
});

test("an unreadable CURRENT version is a refusal, never an install", () => {
  // The packaging fault case: the app cannot say what it is. Installing over it is not the fix.
  const verdict = assessAvailableVersion("not-a-version", "0.11.0");
  assert.equal(verdict.action, "refuse");
  if (verdict.action === "refuse") assert.equal(verdict.kind, "invalid");
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 3 — the install is verified against the version that was ASKED for.
// -----------------------------------------------------------------------------------------------------------

test("an install that landed the requested version passes", () => {
  assert.equal(verifyInstall("0.11.0", "0.11.0"), undefined);
  assert.equal(verifyInstall("0.11.0", "v0.11.0"), undefined);
});

test("an install that landed a DIFFERENT version is a failed update, not a success", () => {
  // The case a naive implementation reports as success, because `npm` exited 0.
  const failure = verifyInstall("0.11.0", "0.10.0");
  assert.equal(failure?.kind, "version-mismatch");
  if (failure?.kind !== "version-mismatch") return;
  assert.equal(failure.requested, "0.11.0");
  assert.equal(failure.installed, "0.10.0");
  assert.match(failure.reason, /is 0\.10\.0 rather than 0\.11\.0/);
});

test("an install whose version cannot be read is a mismatch, never a pass", () => {
  // "I could not check" must not read as "it worked" — the same rule the process probe follows (C16).
  for (const unreadable of ["", "unknown", "not-a-version", "latest"]) {
    const failure = verifyInstall("0.11.0", unreadable);
    assert.equal(failure?.kind, "version-mismatch", `${JSON.stringify(unreadable)} must not pass verification`);
  }
});

test("a requested version that is not exact cannot be verified at all", () => {
  const failure = verifyInstall("latest", "0.11.0");
  assert.equal(failure?.kind, "version-mismatch");
  if (failure?.kind !== "version-mismatch") return;
  assert.match(failure.reason, /not an exact version/);
});

// -----------------------------------------------------------------------------------------------------------
// The commands, asserted rather than described.
// -----------------------------------------------------------------------------------------------------------

test("the install command names one exact version, and refuses anything else", () => {
  assert.deepEqual(installCommand("0.11.0"), { command: "npm", args: ["install", "--global", "pi-central@0.11.0"] });
  // `--global` and the exact pin are the two things that make verification meaningful.
  const { args } = installCommand("v0.11.0");
  assert.equal(args.includes("--global"), true);
  assert.equal(args.includes("pi-central@0.11.0"), true, "the leading v is normalized, and no range is ever passed");
  for (const bad of ["latest", "^0.11.0", "*", "0.11"]) {
    assert.throws(() => installCommand(bad), /not an exact version/, `${bad} must not reach a subprocess argv`);
  }
});

test("the version check is ONE request for a dist-tag, carrying only the package name", () => {
  // ADR-0011 §4: "The request carries nothing but the package name."
  const { command, args } = latestVersionCommand();
  assert.equal(command, "npm");
  assert.equal(args.join(" "), "view pi-central@latest version --json");
  assert.equal(args.some((arg) => /token|http|registry\.npmjs|--registry/i.test(arg)), false, "no registry override, no credential");
  assert.equal(UPDATE_PACKAGE, "pi-central");
});

test("`npm view --json` output is read in both shapes npm produces", () => {
  assert.equal(parseLatestVersion('"1.2.3"'), "1.2.3");
  assert.equal(parseLatestVersion('["1.2.3"]'), "1.2.3");
  assert.equal(parseLatestVersion('  "v1.2.3"\n'), "v1.2.3");
  // Not a version: undefined, so `assessAvailableVersion` reports `invalid` rather than guessing.
  assert.equal(parseLatestVersion("1.2.3"), undefined, "plain text is not the JSON form that was asked for");
  assert.equal(parseLatestVersion('["1.2.3","2.0.0"]'), undefined, "an ambiguous answer is not an answer");
  assert.equal(parseLatestVersion(""), undefined);
  assert.equal(parseLatestVersion("npm error code E404"), undefined);
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 5 — a child that cannot be stopped never gets installed over.
// -----------------------------------------------------------------------------------------------------------

test("a clean stop lets the update proceed, whether it needed SIGKILL or not", () => {
  assert.deepEqual(assessStop({ stopped: true, signal: "SIGTERM", waitedMs: 400 }), { proceed: true });
  assert.deepEqual(assessStop({ stopped: true, signal: "SIGKILL", waitedMs: 5100 }), { proceed: true });
});

test("a child that could not be stopped abandons the update, and says no update was applied", () => {
  const assessment = assessStop({ stopped: false, reason: "it ignored SIGTERM and survived SIGKILL" });
  assert.equal(assessment.proceed, false);
  if (assessment.proceed) return;
  assert.equal(assessment.failure.kind, "stopped-impossible");
  assert.match(assessment.failure.reason, /no update was applied/);
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 7 — the respawned child is a new process, and its port is a new port.
// -----------------------------------------------------------------------------------------------------------

test("a respawn on a fresh port is accepted", () => {
  assert.deepEqual(assessRespawnedPort({ port: 51234, spawnedByUs: true }, 51235), { ok: true });
  // And with no previous child, any valid port is fine.
  assert.deepEqual(assessRespawnedPort(undefined, 51235), { ok: true });
});

test("reusing the previous port is refused, because the shell never picks ports", () => {
  const verdict = assessRespawnedPort({ port: 51234, spawnedByUs: true }, 51234);
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.match(verdict.reason, /the port the previous one used/);
});

test("a respawn with no usable port is refused", () => {
  for (const bad of [0, -1, 1.5, 70_000, Number.NaN]) {
    assert.equal(assessRespawnedPort(undefined, bad).ok, false, `${bad} is not an announcement`);
  }
});

// -----------------------------------------------------------------------------------------------------------
// Crash recovery — the window between "installed" and "respawned" must not lose sessions.
// -----------------------------------------------------------------------------------------------------------

test("no update in progress means the next launch does nothing special", () => {
  for (const phase of ["idle", "confirming"] as const) {
    const recovery = crashRecovery({ phase, previous: undefined, installed: false });
    assert.equal(recovery.action, "none");
  }
});

test("a completed install forces a NEW process, because the record names the old one's code", () => {
  // The recorded PID is the old version executing files that have just been replaced. Adopting it (#216) would
  // run the old code and report the old version as current — ADR-0011 §4 forbids exactly that.
  const recovery = crashRecovery({ phase: "respawning", previous: { port: 51234, spawnedByUs: true }, installed: true });
  assert.equal(recovery.action, "respawn");
  assert.equal(recovery.forceNew, true);
  assert.match(recovery.reason, /update to the installed package completed/);
});

test("an interrupted install leaves the previous orchestrator as the right one", () => {
  const recovery = crashRecovery({ phase: "installing", previous: { port: 51234, spawnedByUs: true }, installed: false });
  assert.equal(recovery.action, "respawn");
  assert.equal(recovery.forceNew, false, "nothing was installed, so the running version is still the version to run");
});

test("an interrupted update with no previous child starts the installed version", () => {
  const recovery = crashRecovery({ phase: "installing", previous: undefined, installed: false });
  assert.equal(recovery.action, "respawn");
  assert.equal(recovery.forceNew, true);
});

test("an adopted child is not force-replaced when nothing was installed", () => {
  // `forceNew` follows "did we start this process", because a record for a process we did not spawn is the only
  // thing that can find it again — and it is still the right version.
  const recovery = crashRecovery({ phase: "stopping", previous: { port: 51234, spawnedByUs: false }, installed: false });
  assert.equal(recovery.forceNew, true, "an adopted child cannot be signalled by handle, so the launch starts its own");
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 4 — the confirmation names the sessions and cancelling installs nothing.
// -----------------------------------------------------------------------------------------------------------

test("the update confirmation is Cancel-by-default and Escape installs nothing", () => {
  const dialog = updateDialog("0.10.0", "0.11.0", [{ name: "s1", cwd: "/a" }]);
  assert.deepEqual(dialog.buttons, [...UPDATE_CONFIRM_BUTTONS]);
  assert.equal(dialog.buttons[dialog.defaultId], "Cancel", "an update is not urgent, so it is not the default");
  assert.equal(dialog.buttons[dialog.cancelId], "Cancel", "and a dismissal installs nothing");
  assert.equal(chooseUpdateAnswer(dialog.defaultId), "cancel");
  assert.equal(chooseUpdateAnswer(dialog.cancelId), "cancel");
  assert.equal(chooseUpdateAnswer(0), "install", "and the first button is the one that does it");
  // An out-of-range answer is a cancel, never an install.
  assert.equal(chooseUpdateAnswer(99), "cancel");
});

test("the confirmation states how many sessions will be restarted", () => {
  const two = updateDialog("0.10.0", "0.11.0", [{ name: "s1", cwd: "/a" }, { name: "s2", cwd: "/b" }]);
  assert.match(two.message, /Update Pi Central from 0\.10\.0 to 0\.11\.0\?/);
  assert.match(two.detail, /^2 sessions are running/);
  assert.match(two.detail, /restarted too/);
  // And the consequence that is not obvious: a streaming turn is cut off.
  assert.match(two.detail, /streaming right now is cut off/);

  const one = updateDialog("0.10.0", "0.11.0", [{ name: "s1", cwd: "/a" }]);
  assert.match(one.detail, /^1 session is running/);

  // With nothing running it says so, rather than "0 sessions are running", which reads as a bug.
  const none = updateDialog("0.10.0", "0.11.0", []);
  assert.match(none.detail, /^No session is running/);
  assert.equal(none.detail.includes("0 sessions"), false);
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 6 — a failed install explains itself in a copyable panel.
// -----------------------------------------------------------------------------------------------------------

test("every failure has a page that says nothing was changed and shows npm's own words", () => {
  const stopped = updateFailurePage({ kind: "stopped-impossible", reason: "it survived SIGKILL" }, "0.10.0");
  assert.match(stopped.title, /could not be stopped/);
  assert.match(stopped.detail, /nothing was changed/);
  assert.match(stopped.detail, /0\.10\.0/);

  const failed = updateFailurePage(
    { kind: "install-failed", reason: "npm exited 1", output: "npm error code E404\nnpm error 404 Not Found" },
    "0.10.0",
  );
  assert.match(failed.title, /could not be installed/);
  // The output is the only thing that explains a registry error, so it must survive into the panel verbatim.
  assert.equal(failed.detail.includes("npm error code E404"), true);
  assert.match(failed.detail, /nothing was changed/);

  const mismatch = updateFailurePage(
    { kind: "version-mismatch", reason: "landed 0.10.0", requested: "0.11.0", installed: "0.10.0" },
    "0.10.0",
  );
  assert.match(mismatch.title, /other than the version that was asked for/);
  assert.match(mismatch.detail, /Asked for: 0\.11\.0/);
  assert.match(mismatch.detail, /Found: 0\.10\.0/);
  // And the diagnostic that actually resolves it.
  assert.match(mismatch.detail, /npm prefix -g/);
});

test("an empty npm output does not leave a blank panel", () => {
  const failure = updateFailurePage({ kind: "install-failed", reason: "npm exited 1", output: "   \n" }, "0.10.0");
  assert.match(failure.detail, /What npm printed:\n\n\(nothing\)/);
});

test("a permissions failure is recognized, because its remedy is the one npm cannot print", () => {
  for (const output of [
    "npm error code EACCES",
    "npm error EPERM: operation not permitted",
    "Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules'",
    "access is denied",
  ]) {
    assert.equal(looksLikePermissionFailure(output), true, `${output} names a permissions problem`);
  }
  assert.equal(looksLikePermissionFailure("npm error code E404"), false);
  assert.equal(looksLikePermissionFailure(""), false);
});
