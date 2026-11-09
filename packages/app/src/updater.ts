/**
 * The update choreography: stop, install, verify, respawn (issue #217).
 *
 * ## What this module is, and what it is deliberately not
 *
 * `update-decide.ts` answers the *questions* — is this a version to install, did the right one land, may I
 * proceed after that stop. This file performs the sequence and nothing else: it never decides, it never tells
 * a window what to do, and it holds no Electron import. Every external effect is injected, which is what lets
 * `update.test.ts` drive a full update — including the cases that fail — with no `npm`, no child process and
 * no display.
 *
 * `main.ts` supplies the real effects: a spawn, an `npm`, a filesystem read, and a callback for each phase.
 *
 * ## The one invariant
 *
 * **An update either completes or leaves the running version unchanged.** So the sequence is written to stop
 * at the first refusal, and the value it returns says whether the old child must be put back. There is no
 * rollback (out of scope): the design avoids needing one by never replacing the package until the child is
 * confirmed dead, and never calling the update a success until the manifest says the requested version landed.
 *
 * ## Why the stop is bounded in two stages
 *
 * `SIGTERM` is a request. `server.ts` answers it by closing the transport and stopping every session, which
 * takes as long as the sessions take. So the child gets `STOP_TERM_GRACE_MS`, then `SIGKILL`, and if it
 * survives *that* the update is abandoned (criterion 5) — because installing would replace files a live
 * process is executing, and the sessions it owns would be running code that no longer exists on disk.
 */
import {
  INSTALL_TIMEOUT_MS,
  STOP_HARD_DEADLINE_MS,
  STOP_TERM_GRACE_MS,
  assessAvailableVersion,
  assessRespawnedPort,
  assessStop,
  crashRecovery,
  installCommand,
  latestVersionCommand,
  looksLikePermissionFailure,
  parseLatestVersion,
  updateFailurePage,
  verifyInstall,
  type CrashRecovery,
  type PreviousChild,
  type StopOutcome,
  type UpdateFailure,
  type UpdatePhase,
} from "./update-decide.ts";

/** A command's result, as the sequence needs it. `signal` is set when the timeout killed it. */
export interface CommandResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Everything the update does to the outside world.
 *
 * Each is one call, so a test supplies four stubs and drives the real sequence. `readInstalledVersion` is
 * separate from `runInstall` on purpose: it is the *verification* (criterion 3), and a stub that returns a
 * version different from the one requested must be able to simulate the case a naive implementation reports
 * as success.
 */
export interface UpdateEnvironment {
  /** Ask npm which version `latest` names. One request, package name only (ADR-0011 §4). */
  readLatestVersion(): Promise<CommandResult>;
  /** Run `npm install -g pi-central@<version>`. */
  runInstall(version: string): Promise<CommandResult>;
  /** Read `version` from the installed `package.json`. `undefined` when it cannot be read at all. */
  readInstalledVersion(): Promise<string | undefined>;
  /** The version running right now, from the artifact (criterion 2 — never restated). */
  readCurrentVersion(): Promise<string>;
  /**
   * Stop the child: `SIGTERM`, then `SIGKILL` after the grace period.
   *
   * Returns what happened rather than throwing, because "could not stop" is a decision this sequence must make
   * and not an exception to catch.
   */
  stopChild(): Promise<StopOutcome>;
  /**
   * Start a new child and return the port it announced.
   *
   * `forceNew` is passed through from `crashRecovery`: after a completed install the previous process must not be
   * adopted, because it is the old version executing files that have been replaced.
   */
  respawn(forceNew: boolean): Promise<{ port: number }>;
  /** Called at each transition, so the window can say what is happening and a crash can be recovered. */
  onPhase(phase: UpdatePhase, detail: string): void;
  /** Persist the phase, so an interrupted update is recoverable on the next launch. */
  persistPhase(phase: UpdatePhase, installed: boolean): void;
}

/** What an update attempt produced. Every outcome is a value; nothing is thrown for an expected failure. */
export type UpdateResult =
  /** The new version is installed, verified and running. `port` is the NEW child's. */
  | { ok: true; from: string; to: string; port: number; output: string }
  /** Nothing was applied. `respawned` says whether the previous child is running again. */
  | { ok: false; failure: UpdateFailure; runningVersion: string; respawned: boolean; output: string };

/** The previous child, as `main.ts` knows it, plus what the sequence needs to put it back. */
export interface UpdateContext {
  /** The child before the update, or `undefined` when none was running. */
  previous: PreviousChild | undefined;
  /** Whether a child is currently running and must be stopped. */
  hasChild: boolean;
}

/**
 * Perform an update to `latest`.
 *
 * ## The order, and why each step precedes the next
 *
 *   1. **Ask what `latest` is.** Before anything is stopped, so a registry failure costs the reader nothing but
 *      an error page — the sessions keep running because nothing has happened yet.
 *   2. **Refuse an older or equal version** (`assessAvailableVersion`). This also validates the string, so a
 *      malformed answer never reaches a subprocess.
 *   3. **Stop the child**, bounded. A child that survives is a refusal (criterion 5) and the update ends here,
 *      with the child still running and untouched.
 *   4. **Install the exact version.** A non-zero exit is a failure that respawns the previous child (criterion
 *      6) — the package on disk was not replaced, so the old version is still the correct one.
 *   5. **Verify the manifest** (criterion 3). `npm` exiting 0 is not evidence; a version that is not the one
 *      requested is a failed update, and the message says so.
 *   6. **Respawn on a fresh port** (criterion 7) and refuse a port the previous child used.
 *
 * The `from` version in the result is read at step 1 from the artifact, so a report of "updated from X" cannot
 * disagree with what was actually running.
 */
export async function applyUpdate(env: UpdateEnvironment, context: UpdateContext): Promise<UpdateResult> {
  const from = await env.readCurrentVersion();

  env.onPhase("confirming", "asking npm which version is latest");
  const latest = await env.readLatestVersion();
  const discovered = parseLatestVersion(latest.stdout);
  const verdict = assessAvailableVersion(from, discovered ?? latest.stdout);
  if (verdict.action === "refuse") {
    return {
      ok: false,
      failure: { kind: "install-failed", reason: verdict.reason, output: latest.stderr },
      runningVersion: from,
      respawned: false,
      output: latest.stderr,
    };
  }
  const to = verdict.version;

  if (context.hasChild) {
    env.onPhase("stopping", "stopping the orchestrator so its files can be replaced");
    const stopOutcome = await env.stopChild();
    const assessment = assessStop(stopOutcome);
    if (!assessment.proceed) {
      /*
       * The child could not be stopped. It is still running — nothing was installed — so `respawned` is TRUE in the
       * sense the caller cares about (a child is alive and owns the sessions), even though this sequence did not start
       * it. Reporting `false` here would make `main.ts` start a second one over the sessions the first still holds.
       */
      return { ok: false, failure: assessment.failure, runningVersion: from, respawned: true, output: "" };
    }
  }

  env.onPhase("installing", `installing ${to}`);
  env.persistPhase("installing", false);
  const { args } = installCommand(to);
  const install = await env.runInstall(to);
  const output = `${install.stdout}${install.stderr}`;
  if (install.code !== 0) {
    const failure: UpdateFailure = {
      kind: "install-failed",
      reason:
        `npm ${args.join(" ")} exited ${install.code === null ? `on signal ${install.signal ?? "?"}` : `with code ${install.code}`}` +
        (looksLikePermissionFailure(output) ? ". The global npm prefix is probably not writable by this user" : ""),
      output,
    };
    // Nothing was replaced, so the previous child is still the right version: put it back (criterion 6).
    return { ok: false, failure, runningVersion: from, respawned: await putItBack(env, context), output };
  }

  env.onPhase("verifying", `checking that ${to} is what was installed`);
  const installed = await env.readInstalledVersion();
  const mismatch = verifyInstall(to, installed ?? "");
  if (mismatch !== undefined) {
    /*
     * The package on disk is now whatever landed. The previous child cannot be put back by respawning it — it runs
     * code that has been replaced — but starting *something* is better than a window pointed at nothing, so the
     * installed version is started and the failure says what landed.
     */
    const port = await respawnQuietly(env);
    /*
     * An empty string is not a reportable version. `?? "unknown"` would let `""` through and the failure page would
     * claim the app is running version " " — the same "absent is not a value" mistake the install-version probe guards
     * against, one level up.
     */
    const runningVersion = installed === undefined || installed.trim() === "" ? "unknown" : installed;
    return { ok: false, failure: mismatch, runningVersion, respawned: port !== undefined, output };
  }

  env.onPhase("respawning", `starting ${to}`);
  env.persistPhase("respawning", true);
  const respawned = await env.respawn(true);
  const portCheck = assessRespawnedPort(context.previous, respawned.port);
  if (!portCheck.ok) {
    /*
     * A reused port means the URL came from the OLD child's announcement rather than from this one's. There is a child
     * running, so report it — a second spawn here would be the branch point C9 forbids.
     */
    return { ok: false, failure: { kind: "install-failed", reason: portCheck.reason, output }, runningVersion: to, respawned: true, output };
  }

  env.persistPhase("idle", false);
  env.onPhase("idle", `updated to ${to}`);
  return { ok: true, from, to, port: respawned.port, output };
}

/** Put the previous child back after a failed install, and report whether that worked. */
async function putItBack(env: UpdateEnvironment, context: UpdateContext): Promise<boolean> {
  if (!context.hasChild) return false;
  // `forceNew` is false: nothing was installed, so the version on disk is the one that was running.
  const recovery = crashRecovery({ phase: "installing", previous: context.previous, installed: false });
  const port = await respawnQuietly(env, recovery);
  return port !== undefined;
}

/** Respawn, swallowing a failure into `undefined` — used on paths that are already reporting a failure. */
async function respawnQuietly(env: UpdateEnvironment, recovery?: CrashRecovery): Promise<number | undefined> {
  try {
    const { port } = await env.respawn(recovery?.forceNew ?? false);
    return port;
  } catch {
    return undefined;
  }
}

/**
 * Read the latest version without installing anything, for the menu's "check" action.
 *
 * Separate from `applyUpdate` because detection and application are different actions (ADR-0011 §4) and this is
 * the shell's own use of npm's single metadata request — not #55, which owns the opt-in, cached, versioned
 * detection in the orchestrator. Nothing here installs, and nothing here is called on a timer.
 */
export async function checkLatestVersion(
  env: Pick<UpdateEnvironment, "readLatestVersion" | "readCurrentVersion">,
): Promise<{ current: string; latest: string | undefined; verdict: ReturnType<typeof assessAvailableVersion>; output: string }> {
  const current = await env.readCurrentVersion();
  const { args } = latestVersionCommand();
  void args;
  const result = await env.readLatestVersion();
  const latest = parseLatestVersion(result.stdout);
  const verdict = assessAvailableVersion(current, latest ?? result.stdout);
  return { current, latest, verdict, output: `${result.stdout}${result.stderr}` };
}

/** The page to show when an update failed. Re-exported so `main.ts` has one import for the failure surface. */
export { updateFailurePage };

/** How long an update may take overall before the caller's own watchdog fires. */
export const UPDATE_OVERALL_TIMEOUT_MS = STOP_HARD_DEADLINE_MS + INSTALL_TIMEOUT_MS + STOP_TERM_GRACE_MS;
