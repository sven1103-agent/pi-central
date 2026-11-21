/**
 * The agent keychain's lock state, read ONCE per launch (issue #269).
 *
 * ## The report this exists for
 *
 * > when pi central starts again, after an OS restart, users get prompted with the pi agents keychain
 * > password prompt indefinitely. Entering the correct password once is not enough. Users need to cancel
 * > and restart the app to recover.
 *
 * A reboot locks the keychain, and every provider key is resolved by Pi's own
 * `!security find-generic-password -ws '<provider>'` (C13) — a **separate process per lookup**, inside a
 * session's sandbox. Each of those meets the same locked keychain, so with N restored sessions the reader
 * gets N prompts for one keychain, and answering one of them unlocks it only after the others have already
 * asked. The recovery people found (cancel, then restart) is consistent with that: cancelling makes every
 * queued lookup fail fast, so startup finishes, and the one password that did land leaves the keychain
 * unlocked for the next launch.
 *
 * ## Why the fix is one probe, in this process, before any session spawns
 *
 * An unlock is **process-wide state** — one keychain, one lock, one search list (ADR-0010 §2 named exactly
 * this concurrency problem and left it unsolved). So the only way to get one prompt rather than N is to
 * make the FIRST keychain access happen here, in the unsandboxed orchestrator, and make it the last one
 * that has to ask: once the user answers, the keychain is unlocked for every session that follows.
 *
 * `security show-keychain-info <path>` is that first access. On an unlocked keychain it prints its
 * settings and exits `0` with no prompt; on a locked one it raises the password dialog and, once answered,
 * prints the same settings — so the exit status answers "can the key be read now?" rather than "was a
 * dialog shown?". Measured on this machine, and every arm below comes from that measurement:
 *
 * | Probe result | Meaning |
 * |---|---|
 * | `0`, `no-timeout` | unlocked (or just unlocked by the answer) |
 * | `128`, `User canceled the operation` | the prompt was dismissed — still locked |
 * | `51`, `The user name or passphrase you entered is not correct` | a wrong password — still locked |
 * | `50`, `The specified keychain could not be found` | absent |
 *
 * `dump-keychain` and `find-generic-password -w` also prompt, and both read more than the lock state;
 * `show-keychain-info` is the narrowest command that answers the question and nothing else.
 *
 * ## What this module must never do
 *
 * No creating, unlocking with a stored password, deleting, or search-list mutation — C13 and ADR-0010 §6
 * forbid all of it, including as a convenience fix. Creating a keychain has been observed to drop
 * `login.keychain-db` from the user-wide search list and break the user's own shell access. So the verbs
 * are fixed in `keychainProbeArgv`, the invariant test asserts they stay that way, and the only party that
 * ever holds a keychain password is the user, at the OS dialog.
 *
 * ## Why the wait is bounded, and why the bound is this short
 *
 * A dialog nobody answers must not become an app nobody can start. The desktop shell kills an orchestrator
 * that prints no URL within `URL_TIMEOUT_MS` (10 s, `packages/app/src/orchestrator-process.ts`), and
 * restoration happens before that line is printed — so this probe has to finish inside the same budget or
 * the "fix" would stop the app from starting at all. `KEYCHAIN_PROBE_TIMEOUT_MS` is therefore 8 s: long
 * enough for someone at the keyboard, short enough to leave room for the restore behind it.
 *
 * An expired wait is reported as `locked`, not as `unknown`. "It did not answer `0` within the bound" is
 * the honest reading of "not shown to be unlockable", and it puts C13's warning on every affected session
 * instead of letting a session report `idle` while it cannot think.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The four states, named rather than collapsed into a boolean.
 *
 * `unknown` is a real answer — the binary was missing, or it failed for a reason no arm above explains —
 * and it is kept separate so a caller cannot report a guess as a fact.
 */
export type KeychainState = "unlocked" | "locked" | "absent" | "unknown";

export interface KeychainReport {
  state: KeychainState;
  /** The keychain asked about. Always the agent root's own file, so a message can name it. */
  path: string;
  /** What produced this state, in one sentence. Never a guess about what the OS did. */
  detail: string;
  /** The probe's exit code, when it produced one. Absent when it timed out or never ran. */
  code?: number | undefined;
  /** False when the probe did not run: no keychain file to ask about, or nothing needed one. */
  probed: boolean;
}

/** The binary, and the only one this module will ever run. */
export const SECURITY_PATH = "/usr/bin/security";

/** The bound on the wait, and the reason for the number (see the module comment). */
export const KEYCHAIN_PROBE_TIMEOUT_MS = 8_000;

/**
 * How long an unanswered probe waits before it says a prompt is on screen.
 *
 * An unlocked keychain answers in milliseconds (measured: ~20 ms), so anything slower is a dialog. Saying
 * so is what tells the reader that the thing asking for a password belongs to Pi Central and to the agent's
 * keychain — macOS's dialog names neither the application nor the full path.
 */
export const PROMPT_NOTE_AFTER_MS = 300;

/**
 * The argv, in one place, so a test asserts the literal shape rather than a paraphrase of it.
 *
 * One verb, read-only, plus the path. `--` is not accepted by `security`, and the path is not caller
 * input — it is the agent root's own keychain — so no argument can change what this command does.
 */
export function keychainProbeArgv(path: string): string[] {
  return ["show-keychain-info", path];
}

/** What one probe run produced, before it is interpreted. Raw facts, so the mapping stays testable. */
export interface ProbeOutcome {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** True when the wait expired. The child is killed, and the state is reported as `locked`. */
  timedOut: boolean;
  /** The bound that expired, so the message can state it. */
  timeoutMs: number;
}

/**
 * Interpret one probe run.
 *
 * Pure, and separate from the spawn, because these four arms are the whole claim this module makes and a
 * test can assert each of them without a keychain, a dialog, or a Mac.
 */
export function interpretKeychainProbe(outcome: ProbeOutcome, path: string): KeychainReport {
  const said = `${outcome.stdout}\n${outcome.stderr}`;
  const code = outcome.code ?? undefined;

  if (outcome.timedOut) {
    return {
      state: "locked",
      path,
      detail:
        `its password prompt was not answered within ${Math.round(outcome.timeoutMs / 1000)} s, so the ` +
        `keychain was not shown to be unlocked`,
      ...(code === undefined ? {} : { code }),
      probed: true,
    };
  }

  if (outcome.code === 0) {
    return {
      state: "unlocked",
      path,
      detail: "it answered its own settings without asking for a password",
      code: 0,
      probed: true,
    };
  }

  // `security` reports "could not be found" for a path that holds no keychain — distinct from a locked
  // one, and the distinction matters: an absent keychain is a setup fact, not something to unlock.
  if (/could not be found/i.test(said)) {
    return {
      state: "absent",
      path,
      detail: `there is no keychain at ${path}`,
      ...(code === undefined ? {} : { code }),
      probed: true,
    };
  }

  if (/user canceled|cancelled|canceled/i.test(said)) {
    return {
      state: "locked",
      path,
      detail: "its password prompt was dismissed, so it is still locked",
      ...(code === undefined ? {} : { code }),
      probed: true,
    };
  }

  if (/not correct|passphrase you entered/i.test(said)) {
    return {
      state: "locked",
      path,
      detail: "the password entered at its prompt was not accepted, so it is still locked",
      ...(code === undefined ? {} : { code }),
      probed: true,
    };
  }

  if (outcome.code === null) {
    // No exit and no timeout: `spawn` itself failed (a missing or non-executable binary).
    return {
      state: "unknown",
      path,
      detail: `${SECURITY_PATH} could not be run${outcome.signal === null ? "" : ` (${outcome.signal})`}`,
      probed: true,
    };
  }

  const first = said.split("\n").find((line) => line.trim() !== "")?.trim();
  return {
    state: "unknown",
    path,
    detail: `its exit status ${outcome.code} is not one this build recognises` +
      `${first === undefined ? "" : `: ${first}`}`,
    code: outcome.code,
    probed: true,
  };
}

/**
 * Read the agent keychain's lock state, at most once per launch.
 *
 * `probe()` is memoised, and the memo is the mechanism rather than an optimisation: it is what makes the
 * prompt count one instead of one-per-session. `report()` never probes, so the spawn path can read the
 * answer synchronously and cannot start a second dialog.
 */
export interface KeychainProbe {
  readonly path: string;
  /** The answer, or the run that will produce it. Repeated calls return the same promise. */
  probe(): Promise<KeychainReport>;
  /** The answer, if there is one. Never triggers a probe. */
  report(): KeychainReport | undefined;
}

export interface KeychainProbeOptions {
  /** The keychain to ask about: the agent root's own file. */
  path: string;
  /** `security`, injectable so a test never needs a real keychain. */
  securityPath?: string;
  timeoutMs?: number;
  noteAfterMs?: number;
  /**
   * Called once, when nothing has answered by `noteAfterMs`, so a line naming the keychain can be printed
   * BEFORE the dialog is read as a puzzle. Never called for an unlocked keychain.
   */
  onWaitingForPrompt?: (path: string) => void;
  /**
   * Replace the run itself, for tests that count it or script its answer.
   *
   * A parameter rather than an environment variable: this decides whether a prompt appears, and a
   * configurable prompt is a configurable dialog.
   */
  invoke?: (path: string, options: ResolvedProbeOptions) => Promise<ProbeOutcome>;
  /** Injectable existence check, so a fixture keychain need not be a real one. */
  exists?: (path: string) => boolean;
}

export interface ResolvedProbeOptions {
  securityPath: string;
  timeoutMs: number;
  noteAfterMs: number;
  onWaitingForPrompt?: (path: string) => void;
}

export function createKeychainProbe(options: KeychainProbeOptions): KeychainProbe {
  const exists = options.exists ?? existsSync;
  const invoke = options.invoke ?? runSecurityProbe;
  const resolved: ResolvedProbeOptions = {
    securityPath: options.securityPath ?? SECURITY_PATH,
    timeoutMs: options.timeoutMs ?? KEYCHAIN_PROBE_TIMEOUT_MS,
    noteAfterMs: options.noteAfterMs ?? PROMPT_NOTE_AFTER_MS,
    ...(options.onWaitingForPrompt === undefined
      ? {}
      : { onWaitingForPrompt: options.onWaitingForPrompt }),
  };

  let answer: KeychainReport | undefined;
  let pending: Promise<KeychainReport> | undefined;

  return {
    path: options.path,
    probe(): Promise<KeychainReport> {
      if (pending !== undefined) return pending;
      pending = (async () => {
        if (!exists(options.path)) {
          // Asked and answered without a process: nothing to unlock, no dialog to raise. An absent
          // keychain is a setup fact (C13), not a lock state.
          answer = {
            state: "absent",
            path: options.path,
            detail: `there is no keychain at ${options.path}`,
            probed: false,
          };
          return answer;
        }
        answer = interpretKeychainProbe(await invoke(options.path, resolved), options.path);
        return answer;
      })();
      return pending;
    },
    report(): KeychainReport | undefined {
      return answer;
    },
  };
}

/**
 * The real run: one `security show-keychain-info`, bounded, with the note fired when it is still silent.
 *
 * `stdio[0]` is `"ignore"` — `/dev/null` — deliberately. A TTY prompt is not how this question is answered
 * (ADR-0010 §1: headless, the unlock fails fast), and giving the child a readable stdin would only turn a
 * "cancel" into a wait for a line nobody will type. The dialog, when one appears, belongs to macOS.
 *
 * The environment is inherited, and that is not a C11 exception: this is the orchestrator's own child,
 * running at the user's identity by design. It is not a session, it is never sandboxed, and nothing here
 * is delivered to one.
 */
function runSecurityProbe(path: string, options: ResolvedProbeOptions): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>((resolve) => {
    const child = spawn(options.securityPath, keychainProbeArgv(path), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      clearTimeout(note);
      resolve({ code, signal, stdout, stderr, timedOut, timeoutMs: options.timeoutMs });
    };

    const note = setTimeout(() => options.onWaitingForPrompt?.(path), options.noteAfterMs);
    const bound = setTimeout(() => {
      timedOut = true;
      // The dialog is owned by macOS, not by this child, so killing the child is asking it to withdraw
      // rather than closing it. Stated because the alternative — waiting forever — is the defect.
      child.kill("SIGKILL");
      finish(null, "SIGKILL");
    }, options.timeoutMs);
    note.unref?.();
    bound.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 8192) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    // A failed `spawn` reports `error` and NO `exit`, so this is the only arm that can settle it.
    child.on("error", (error: NodeJS.ErrnoException) => {
      stderr += `${error.code ?? String(error)}: ${error.message}`;
      finish(null, null);
    });
    child.on("exit", (code, signal) => finish(code, signal));
  });
}

/**
 * What a launch found, including the case where nothing needed asking.
 *
 * `needed: false` is deliberately not the same as `absent`: one means the provider configuration resolves no
 * key through a command, the other means it does and the file is not there (C13 — the search list may still
 * find the keys, so absence is a setup fact rather than a fault). Keeping them apart stops a skipped check
 * from reading like a passing one.
 */
export interface KeychainCheck {
  needed: boolean;
  report?: KeychainReport | undefined;
}

/** One line for the startup banner, so the state is stated once and in full. */
export function describeKeychainCheck(check: KeychainCheck): string {
  if (!check.needed) return "not needed — no provider key is resolved by a command (C13)";
  if (check.report === undefined) return "NOT CHECKED — the probe produced no answer";
  return describeKeychain(check.report);
}

/**
 * One line for the startup banner, so the state is stated once and in full.
 *
 * Names the path in every arm: "locked" without a path is a fact the reader cannot act on, and it reads
 * exactly like their login keychain's own prompt.
 */
export function describeKeychain(report: KeychainReport): string {
  switch (report.state) {
    case "unlocked":
      return `unlocked (${report.path}) — provider keys can be read`;
    case "locked":
      return `LOCKED (${report.path}) — ${report.detail}; sessions report that they cannot reach a model until it is unlocked`;
    case "absent":
      return `none at ${report.path} — provider keys are looked up through the search list (C13)`;
    case "unknown":
      return `state unknown (${report.path}) — ${report.detail}`;
  }
}
