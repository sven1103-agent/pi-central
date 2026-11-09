/**
 * Applying an update: the decisions, with no process and no window (issue #217, ADR-0011 §4).
 *
 * ## What this module is
 *
 * The shell's half of #56. ADR-0011 §4 already decided the trust model — detect freely, apply only on
 * request, verify before install, refuse rather than fall back, never automatic — and #55/#56 own
 * detection and application *in the orchestrator*. What did not exist is the **choreography**: stop the
 * child gracefully, wait for it, install, verify, spawn again, reload a window. Only a program that owns
 * the process can do that, which is why it lives here.
 *
 * Everything below is a pure function over facts, for the same reason `runtime-record.ts` and
 * `window-security.ts` are: `main.ts` imports `electron`, which cannot be loaded by `node --test`. A rule
 * that decides whether the app replaces its own binary has to be assertable without a display.
 *
 * ## The rule that shapes the whole file
 *
 * **An update either completes or leaves the running version untouched.** There is no partial state worth
 * preserving and no rollback (out of scope), so every branch that cannot finish must be able to say
 * "nothing was applied" *and* leave the previous child adoptable or respawned. That is why the decisions
 * are phrased as "may I proceed, and to what" rather than as a sequence of steps with error handling
 * sprinkled through them: a step that is not allowed to start cannot half-finish.
 */

/** The published package. The same name the shell launches (`PACKAGE_NAME` in `package-root.ts`). */
export const UPDATE_PACKAGE = "pi-central";

/**
 * How long a stop may take before `SIGKILL`, and how long the whole stop may take before the update is
 * abandoned.
 *
 * Two bounds, not one, because they answer different questions: `STOP_TERM_GRACE_MS` is "how long the
 * orchestrator gets to close its sessions", and `STOP_HARD_DEADLINE_MS` is "how long the app waits before
 * deciding it could not stop it". A child that ignores both is reported, never installed over.
 */
export const STOP_TERM_GRACE_MS = 5000;
export const STOP_HARD_DEADLINE_MS = 12_000;

/** How long `npm install` gets. Generous: this is a network operation on a real registry. */
export const INSTALL_TIMEOUT_MS = 300_000;

/**
 * A version string normalized for comparison, or `undefined` when it is not one.
 *
 * `v1.2.3` and `1.2.3` are the same version — npm accepts both and prints both — so the leading `v` is
 * stripped rather than treated as a difference. What is NOT tolerated is a mismatch of any other kind:
 * criterion 3 requires the installed version to **equal** the requested one, and a build-metadata suffix
 * or a range would make "equals" mean something the reader did not ask for.
 *
 * Deliberately not semver parsing. This decides one question — "is the string I asked npm for the string
 * that landed?" — and a comparator that understood ranges could answer "yes" for something that is not
 * the release that was verified. The publishing path (`scripts/release.yml`) yields exact versions.
 */
export function normalizeVersion(raw: string): string | undefined {
  const text = raw.trim().replace(/^v/i, "");
  // digits.digits.digits, optionally with a prerelease (`-beta.1`) and build metadata (`+sha`). No ranges,
  // no `^`, no `*`, no `latest`.
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text)) return undefined;
  return text;
}

/** Whether two version strings name the same release. `undefined` when either is not a version at all. */
export function sameVersion(left: string, right: string): boolean | undefined {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (a === undefined || b === undefined) return undefined;
  return a === b;
}

/**
 * Which of two releases is newer, by numeric field.
 *
 * Used only to refuse an **older** install — "you are on 0.11.0, `latest` says 0.10.0" is a registry
 * problem, not an update, and installing it would be a silent downgrade. Prerelease ordering is not
 * modelled: `1.0.0-beta` and `1.0.0` compare equal on the numeric triple, and the exact-version check in
 * `verifyInstall` is what decides whether the update actually landed.
 */
export function compareVersions(left: string, right: string): number | undefined {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (a === undefined || b === undefined) return undefined;
  const fields = (version: string): number[] =>
    (version.split(/[-+]/)[0] ?? "").split(".").map((field) => Number(field));
  const [aMajor = 0, aMinor = 0, aPatch = 0] = fields(a);
  const [bMajor = 0, bMinor = 0, bPatch = 0] = fields(b);
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}

/** What the app may do about a version it has been told about. */
export type UpdateVerdict =
  /** Install this exact version. */
  | { action: "install"; version: string; reason: string }
  /** Do nothing, and say why. `current` when there is nothing newer; `invalid` when the input is unusable. */
  | { action: "refuse"; kind: "up-to-date" | "invalid" | "downgrade"; reason: string };

/**
 * Decide whether a version is one to install.
 *
 * ## Why every refusal names its kind
 *
 * "Up to date" and "that is not a version" both mean *nothing happens*, but they are different sentences
 * to a reader and different bugs to a maintainer: the first is the normal answer, the second means the
 * registry (or the argument) is wrong. Collapsing them produced a banner nobody could act on in this
 * project before, so the kind travels with the refusal and the caller renders it.
 *
 * ## Why a downgrade is refused rather than allowed
 *
 * ADR-0011 §4: *refuse rather than fall back*. Installing what `latest` reports when it is older than the
 * running version would replace a working artifact with an older one and lose whatever the newer version
 * fixed — through an action whose only stated purpose was to get *newer*. If a reader genuinely needs to
 * go back, that is `npm install -g pi-central@<version>` in a terminal, which is explicit and outside this
 * decision.
 */
export function assessAvailableVersion(current: string, latest: string): UpdateVerdict {
  const available = normalizeVersion(latest);
  if (available === undefined) {
    return { action: "refuse", kind: "invalid", reason: `"${latest}" is not a version, so nothing was installed` };
  }
  const running = normalizeVersion(current);
  if (running === undefined) {
    // The running version cannot be read, which is a packaging fault. Installing over it is not the fix,
    // and the honest answer is that the comparison could not be made.
    return {
      action: "refuse",
      kind: "invalid",
      reason: `this installation's own version ("${current}") could not be read, so it cannot be compared with ${available}`,
    };
  }
  const order = compareVersions(available, running);
  if (order === undefined) {
    return { action: "refuse", kind: "invalid", reason: `${available} could not be compared with ${running}` };
  }
  if (order === 0) {
    return { action: "refuse", kind: "up-to-date", reason: `${running} is already installed, and that is the latest release` };
  }
  if (order < 0) {
    return {
      action: "refuse",
      kind: "downgrade",
      reason: `${available} is older than the ${running} that is running, so it was not installed`,
    };
  }
  return { action: "install", version: available, reason: `${available} is newer than ${running}` };
}

/** The `npm` invocation that installs one exact version. Pure so the command is asserted, not described. */
export function installCommand(version: string): { command: string; args: string[] } {
  const exact = normalizeVersion(version);
  // The guard is not decoration: this string reaches a subprocess's argv, and `pi-central@latest` or
  // `pi-central@^1` would make "verify the exact version that was asked for" a promise about something
  // that was never named.
  if (exact === undefined) throw new Error(`refusing to install ${JSON.stringify(version)}: not an exact version`);
  return { command: "npm", args: ["install", "--global", `${UPDATE_PACKAGE}@${exact}`] };
}

/** The `npm` invocation that asks the registry for the version `latest` points at. */
export function latestVersionCommand(): { command: string; args: string[] } {
  // `npm view` is npm's own single request for a dist-tag and carries nothing but the package name, which
  // is exactly what ADR-0011 §4 permits. It is issued only from an explicit menu action (criterion 1).
  return { command: "npm", args: ["view", `${UPDATE_PACKAGE}@latest`, "version", "--json"] };
}

/**
 * Read a version out of `npm view … --json`'s output.
 *
 * `--json` is asked for because the plain form is a human string that varies by npm version; the JSON form
 * is either `"1.2.3"` or `["1.2.3"]` depending on whether the tag is ambiguous. Both are accepted, and
 * anything else is `undefined` so `assessAvailableVersion` reports it as invalid rather than guessing.
 */
export function parseLatestVersion(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (typeof parsed === "string") return parsed;
  if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "string") return parsed[0];
  return undefined;
}

/** Why an update did not happen. `undefined` means it did. */
export type UpdateFailure =
  | { kind: "stopped-impossible"; reason: string }
  | { kind: "install-failed"; reason: string; output: string }
  | { kind: "version-mismatch"; reason: string; requested: string; installed: string };

/**
 * The verdict on what `npm install` actually landed (criterion 3).
 *
 * ## The case a naive implementation calls success
 *
 * `npm install -g pi-central@0.11.0` exiting 0 does **not** mean 0.11.0 is now installed. A lifecycle
 * script can install something else; a stale global prefix can leave the old copy first on `PATH`; a
 * shimmed `npm` can be a wrapper that exits 0 having done nothing. So the installed manifest is read back
 * and compared, and a mismatch is a **failed update** — reported as such, with the old child left running.
 *
 * An unreadable version is a mismatch, not a pass: "I could not check" must never read as "it worked",
 * which is the same rule the process probe follows (C16).
 */
export function verifyInstall(requested: string, installed: string): UpdateFailure | undefined {
  const wanted = normalizeVersion(requested);
  if (wanted === undefined) {
    return {
      kind: "version-mismatch",
      reason: `the requested version ${JSON.stringify(requested)} is not an exact version, so nothing could be verified`,
      requested,
      installed,
    };
  }
  const found = normalizeVersion(installed);
  if (found === undefined) {
    return {
      kind: "version-mismatch",
      reason: `after installing, the package's version could not be read (it reported ${JSON.stringify(installed)})`,
      requested: wanted,
      installed,
    };
  }
  if (found !== wanted) {
    return {
      kind: "version-mismatch",
      reason: `the install finished, but the package on disk is ${found} rather than ${wanted}`,
      requested: wanted,
      installed: found,
    };
  }
  return undefined;
}

/** What a stop attempt produced. */
export type StopOutcome =
  | { stopped: true; signal: "SIGTERM" | "SIGKILL"; waitedMs: number }
  | { stopped: false; reason: string };

/**
 * Decide whether an update may proceed, given what the stop attempt achieved (criterion 5).
 *
 * A child that could not be stopped is the one case where installing would be actively harmful: the next
 * `npm install` would replace files a live process is executing, and the sessions it owns would then be
 * running code that no longer exists on disk. So this refuses, and the caller reports it.
 */
export function assessStop(outcome: StopOutcome): { proceed: true } | { proceed: false; failure: UpdateFailure } {
  if (outcome.stopped) return { proceed: true };
  return {
    proceed: false,
    failure: {
      kind: "stopped-impossible",
      reason: `could not stop cleanly, so no update was applied: ${outcome.reason}`,
    },
  };
}

/** The phase an update is in, for the window and for crash recovery. */
export const UPDATE_PHASES = ["idle", "confirming", "stopping", "installing", "verifying", "respawning"] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];

/** Whether a phase is one in which the child has been (or is being) stopped. */
export function childIsDown(phase: UpdatePhase): boolean {
  return phase === "stopping" || phase === "installing" || phase === "verifying" || phase === "respawning";
}

/** The child as it was before the update, so a failed update can put it back. */
export interface PreviousChild {
  /** The port it announced. Used to decide whether the respawned one is a different process (criterion 7). */
  port: number;
  /** True when this app spawned it; false when it was adopted from a previous launch's record (#216). */
  spawnedByUs: boolean;
}

export interface CrashRecoveryInput {
  /** The phase that was in progress when the process ended. */
  phase: UpdatePhase;
  /** The child before the update, if one was running. */
  previous: PreviousChild | undefined;
  /** Whether `npm install` had completed and verified at that point. */
  installed: boolean;
}

/** What to do on the next launch after the app ended mid-update. */
export interface CrashRecovery {
  action: "respawn" | "none";
  /**
   * Whether the respawn must ignore the runtime record (#216) and start a **new** process.
   *
   * `true` after a completed install, because the recorded process is the OLD version executing files that
   * have just been replaced. `false` when the install never finished, because the old version is still the
   * right one and the record is the cheapest way back to the sessions it holds.
   */
  forceNew: boolean;
  reason: string;
}

/**
 * Decide what the next launch should do after an update was interrupted.
 *
 * ## Why the journal is a decision and not a file format
 *
 * An update spans several seconds of process-death window: stop the child, run `npm`, read the version,
 * spawn again. A crash in the middle leaves no child at all, and without a note the next launch would read
 * a `runtime.json` naming a process that no longer exists (harmless — it discards it) and simply start
 * afresh. That is *almost* right, and it is wrong in the one case that matters: the window between a
 * completed install and a respawn, where the on-disk package is the new version and there are still
 * sessions that were open. Losing them there is exactly the complaint #185 exists for.
 *
 * So the persisted phase is read here and turned into one of two orders. The file itself is written by
 * `updater.ts` through the same atomic pattern as `runtime.json`; this function only decides.
 */
export function crashRecovery(input: CrashRecoveryInput): CrashRecovery {
  if (input.phase === "idle" || input.phase === "confirming") {
    return { action: "none", forceNew: false, reason: "no update was in progress" };
  }
  if (input.installed) {
    return {
      action: "respawn",
      forceNew: true,
      reason: `an update to the installed package completed while ${input.phase}; starting the new version`,
    };
  }
  if (input.previous === undefined) {
    return { action: "respawn", forceNew: true, reason: `an update was interrupted during ${input.phase}; starting the installed version` };
  }
  return {
    action: "respawn",
    forceNew: !input.previous.spawnedByUs,
    reason:
      `an update was interrupted during ${input.phase} before anything was installed, so the previous ` +
      `orchestrator is still the right one`,
  };
}

/**
 * Whether the respawned orchestrator is a *different* process from the one that was stopped
 * (criterion 7).
 *
 * ## Why this is a check rather than a comment
 *
 * Criterion 7's failure is subtle and looks like success: the update completes, the app "respawns" the
 * child, and the window loads a URL — but the port is the one the OLD child announced, so the window is
 * pointed at a socket nothing is listening on (or worse, at whatever now holds that ephemeral port). The
 * shell never chooses ports (ADR-0013 §4), so a reused port is always a bug: it means the URL came from
 * the old child's announcement rather than from the new one's.
 *
 * Equal ports are refused; a port 0 or a non-integer is refused, because neither is an announcement.
 */
export function assessRespawnedPort(previous: PreviousChild | undefined, newPort: number): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(newPort) || newPort <= 0 || newPort > 65535) {
    return { ok: false, reason: `the new orchestrator reported no usable port (${String(newPort)})` };
  }
  if (previous !== undefined && previous.port === newPort) {
    return {
      ok: false,
      reason:
        `the new orchestrator announced port ${newPort}, which is the port the previous one used — ` +
        `that is the old URL, not a new announcement`,
    };
  }
  return { ok: true };
}

/**
 * What to tell the reader before anything is stopped (criterion 4).
 *
 * The sessions are named because ADR-0011 §4 requires it — *"a restart kills them, so the action states how
 * many are running and requires confirmation naming them"* — and this is #56 criterion 3, supplied by the
 * shell. Cancelling installs nothing and stops nothing, which is why `cancelId` is Cancel and not the
 * default.
 */
export interface UpdateConfirmSession {
  name: string;
  cwd: string;
}

export const UPDATE_CONFIRM_BUTTONS = ["Update Pi Central", "Cancel"] as const;

export function updateDialog(
  from: string,
  to: string,
  sessions: readonly UpdateConfirmSession[],
): {
  type: "question";
  buttons: string[];
  defaultId: number;
  cancelId: number;
  message: string;
  detail: string;
  noLink: true;
} {
  const count = sessions.length;
  const willRestart =
    count === 0
      ? "No session is running, so nothing will be interrupted."
      : `${count === 1 ? "1 session is" : `${count} sessions are`} running. ` +
        `Pi Central will be restarted, so ${count === 1 ? "it" : "they"} will be restarted too — ` +
        `the conversations open again from their session files, and anything streaming right now is cut off.`;
  return {
    type: "question",
    buttons: [...UPDATE_CONFIRM_BUTTONS],
    // Cancel is the default: an update is not urgent, and the reader reached this dialog by accident at
    // least as often as on purpose. It is also the `cancelId`, so Escape installs nothing.
    defaultId: 1,
    cancelId: 1,
    message: `Update Pi Central from ${from} to ${to}?`,
    detail: `${willRestart}`,
    noLink: true,
  };
}

/** The answers `UPDATE_CONFIRM_BUTTONS` maps to. */
export function chooseUpdateAnswer(response: number): "install" | "cancel" {
  return response === 0 ? "install" : "cancel";
}

/**
 * The panel shown when an update did not happen, as data.
 *
 * Copyable, like the failure page from #215 and for the same reason: `npm`'s own complaint is the only
 * thing that explains a registry error, a permissions error or a shim that cannot write the global prefix,
 * and a native dialog cannot be selected. `main.ts` renders this into the existing failure page rather than
 * growing a second one.
 */
export function updateFailurePage(failure: UpdateFailure, runningVersion: string): { title: string; detail: string } {
  switch (failure.kind) {
    case "stopped-impossible":
      return {
        title: "Pi Central could not be stopped, so the update was not applied",
        detail: `${failure.reason}\n\nThe running version is ${runningVersion} and nothing was changed.`,
      };
    case "version-mismatch":
      return {
        title: "The update installed something other than the version that was asked for",
        detail:
          `${failure.reason}\n\n` +
          `Asked for: ${failure.requested}\nFound: ${failure.installed}\n\n` +
          `The previous version is still running. If npm reports success and this still happens, the ` +
          `package on PATH is not the one being written — check where npm installs globally with ` +
          `\`npm prefix -g\`.`,
      };
    case "install-failed":
      return {
        title: "The update could not be installed",
        detail:
          `${failure.reason}\n\n` +
          `The running version is ${runningVersion} and nothing was changed.\n\n` +
          `What npm printed:\n\n${failure.output.trim() === "" ? "(nothing)" : failure.output}`,
      };
  }
}

/**
 * Whether the install output explains a permissions problem, which has a specific fix.
 *
 * Not used to change behaviour — the update fails identically — only to add one line naming the likely
 * cause. `EACCES` from a global install is the single most common way this step fails in practice, and it is
 * the one failure whose remedy (`sudo`, or an npm prefix the user owns) cannot be guessed from the stack
 * trace npm prints.
 */
export function looksLikePermissionFailure(output: string): boolean {
  return /EACCES|EPERM|permission denied|access is denied|Permission denied/i.test(output);
}
