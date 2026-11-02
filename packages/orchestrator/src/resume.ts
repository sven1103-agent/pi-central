/**
 * Resume validation (US-5, D-4, C2).
 *
 * The trap, verified in `dist/main.js:558`: if a session's recorded `cwd` no longer exists,
 * Pi's modes differ —
 *
 *   interactive   Pi prompts "continue in current cwd" or cancel
 *   print / JSON / RPC   Pi writes MissingSessionCwdError to stderr and **exits 1**
 *
 * Pi Central drives RPC mode, so it gets the exit, not the prompt. It must therefore check
 * the recorded cwd ITSELF before spawning, and present the outcome, rather than spawn and
 * interpret a crash.
 *
 * This is not theoretical: 82 of 833 sessions on the development machine point at
 * directories that no longer exist (finished worktrees, unmounted volumes, moved checkouts).
 *
 * Pi Central does NOT retarget a session to another directory (ADR-0008). The only remedies
 * are: restore the directory, or start a new session where you actually mean to work.
 */
import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import type { HistoricalSession } from "@pi-central/protocol";

export type ResumeReadiness =
  | { ok: true; cwd: string }
  | { ok: false; reason: ResumeBlocker; message: string; cwd: string };

/**
 * Whether a directory can be entered, and why not when it cannot.
 *
 * Extracted from `checkResumable` so **discovery and resume share one answer** (issue #196). They did not:
 * `registry.ts` had its own `directoryExists` that collapsed every failure to `false`, so History said a
 * directory was "gone" while the refusal dialog for the SAME session correctly said it was unreadable. Two
 * `statSync` calls that can disagree, described to the reader as two facts.
 *
 * The distinction is the whole point, and `checkResumable` already recorded why:
 *
 * > an EACCES on an ancestor directory — the path was present and fine — reported as a missing directory,
 * > which sends the reader off to restore something that is already there.
 *
 * A permissions problem is often recoverable *now* (grant access, remount); a deleted directory is not. So
 * the difference decides what the reader does next, which makes it worth a type rather than a boolean.
 */
export type DirectoryState =
  | { ok: true }
  | { ok: false; reason: "missing" | "unreadable" | "not-a-directory"; code?: string };

/**
 * Classify one directory. Never throws, and never guesses: an unrecognised error code is reported as
 * `missing` with the code attached, so an unfamiliar failure still reaches the reader rather than being
 * swallowed into a bare boolean.
 */
export function inspectDirectory(dir: string): DirectoryState {
  if (dir === "") return { ok: false, reason: "missing" };
  let stats;
  try {
    stats = statSync(dir);
  } catch (error) {
    return { ok: false, ...classifyStatFailure((error as NodeJS.ErrnoException).code) };
  }
  if (!stats.isDirectory()) return { ok: false, reason: "not-a-directory" };
  return { ok: true };
}

/**
 * The error code → reason mapping, as a pure function.
 *
 * Split out **so it can be tested without a filesystem that refuses**. A test for this needs a real `EPERM`,
 * which means a directory owned by another user or a sandbox — environment-dependent, and therefore the kind of
 * test that skips in CI and passes only where it was written. The mapping is the whole decision; `statSync` is
 * the part that cannot be arranged portably.
 *
 * `EPERM`/`EACCES` are permission denials on a path that may well be there. Everything else — `ENOENT`,
 * `ENOTDIR`, an unmounted volume's `EIO` — is reported as `missing`, which is the honest answer to "why can I
 * not see it". An unrecognised code keeps its code attached rather than being swallowed.
 */
export function classifyStatFailure(code: string | undefined): { reason: "missing" | "unreadable"; code?: string } {
  const unreadable = code === "EACCES" || code === "EPERM";
  return { reason: unreadable ? "unreadable" : "missing", ...(code === undefined ? {} : { code }) };
}

export type ResumeBlocker = "missing-directory" | "not-a-directory" | "unreadable" | "unknown-cwd";

/**
 * Decide whether a discovered session can be resumed, before anything is spawned.
 *
 * Takes the session rather than a bare path so the blocker carries the reason a user needs:
 * "this project's directory is gone" is actionable, "resume failed" is not.
 */
export function checkResumable(session: Pick<HistoricalSession, "cwd" | "path">): ResumeReadiness {
  if (!session.cwd) {
    return {
      ok: false,
      reason: "unknown-cwd",
      cwd: session.cwd,
      message:
        "This session does not record the directory it ran in, so a sandbox cannot be composed for it. Start a new session in the directory you want.",
    };
  }

  /*
   * The classification comes from `inspectDirectory`, which is where the error CODE is read.
   *
   * It used to be inline here, and duplicated in `registry.ts` in a worse form that threw the code away —
   * so History said "gone" for a directory this function correctly called unreadable. One implementation now,
   * so the chip and this message cannot disagree.
   */
  const state = inspectDirectory(session.cwd);

  if (!state.ok && state.reason === "not-a-directory") {
    return {
      ok: false,
      reason: "not-a-directory",
      cwd: session.cwd,
      message: `The directory this session recorded is no longer a directory:\n  ${session.cwd}`,
    };
  }

  if (!state.ok) {
    const unreadable = state.reason === "unreadable";
    return {
      ok: false,
      reason: unreadable ? "unreadable" : "missing-directory",
      cwd: session.cwd,
      message: unreadable
        ? `The directory this session worked in cannot be read (${state.code ?? "permission denied"}):\n  ${session.cwd}\n\nThis is a permissions problem, not a missing directory. Check that you can enter it: it may be owned by another user, or a parent directory may deny access.`
        : `The directory this session worked in no longer exists:\n  ${session.cwd}\n\nRestore it, or start a new session in the directory you want to work in. Pi Central does not move a session between directories.`,
    };
  }

  try {
    accessSync(session.cwd, constants.R_OK | constants.X_OK);
  } catch {
    return {
      ok: false,
      reason: "unreadable",
      cwd: session.cwd,
      message: `The directory this session worked in is not readable:\n  ${session.cwd}`,
    };
  }

  return { ok: true, cwd: resolve(session.cwd) };
}
