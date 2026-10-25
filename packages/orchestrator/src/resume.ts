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

  let stats;
  try {
    stats = statSync(session.cwd);
  } catch (error) {
    // The error CODE decides the message, and this was originally a bare `catch` that always
    // claimed "no longer exists". Observed in practice: an EACCES on an ancestor directory — the
    // path was present and fine — reported as a missing directory, which sends the reader off to
    // restore something that is already there. `unreadable` existed as a blocker for exactly this
    // case and could never be produced by this branch.
    const code = (error as NodeJS.ErrnoException).code;
    const unreadable = code === "EACCES" || code === "EPERM";
    return {
      ok: false,
      reason: unreadable ? "unreadable" : "missing-directory",
      cwd: session.cwd,
      message: unreadable
        ? `The directory this session worked in cannot be read (${code}):\n  ${session.cwd}\n\nThis is a permissions problem, not a missing directory. Check that you can enter it: it may be owned by another user, or a parent directory may deny access.`
        : `The directory this session worked in no longer exists:\n  ${session.cwd}\n\nRestore it, or start a new session in the directory you want to work in. Pi Central does not move a session between directories.`,
    };
  }

  if (!stats.isDirectory()) {
    return {
      ok: false,
      reason: "not-a-directory",
      cwd: session.cwd,
      message: `The directory this session recorded is no longer a directory:\n  ${session.cwd}`,
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
