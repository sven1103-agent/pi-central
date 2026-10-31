/**
 * Whether a session may be retried, decided before anything is spawned (issue #11).
 *
 * ## Why this is a function rather than a few lines inside `Supervisor.retry`
 *
 * The interesting part of a retry is entirely in its REFUSALS: a session that is not failed must not be
 * restarted (a silent restart is how a crash loop hides itself), and a session whose directory is gone must
 * be refused *before* spawning rather than becoming a second, less informative failure. Those decisions need
 * a real `Supervisor` and a real spawn to exercise end to end, which no test in this repo can do (C1: the
 * sandbox does not nest). Pulling the decision out makes every refusal testable, and leaves the supervisor
 * holding only the disposal and the spawn.
 *
 * ## The error CODE decides the message
 *
 * `checkResumable` had this bug and it was fixed there: a bare `catch` reported every failure as "no longer
 * exists", including an EACCES on an ancestor directory whose path was present and fine — which sends a
 * reader off to restore something that is already there. The same distinction is drawn here.
 */
import { statSync } from "node:fs";
import type { LiveSession } from "@pi-central/protocol";

/** A refusal message, or `undefined` when the session may be retried. */
export function retryRefusal(session: Pick<LiveSession, "state" | "cwd">): string | undefined {
  if (session.state === "starting" || session.state === "streaming" || session.state === "awaiting-approval") {
    return "This session is still running. Stop it before retrying.";
  }
  if (session.state !== "failed") {
    // `idle`, `registered` and `stopped` are all "not broken". Offering a retry for them would restart a
    // working session and lose its conversation position for no reason.
    return `Only a failed session can be retried; this one is ${session.state}.`;
  }
  return directoryRefusal(session.cwd);
}

/** Whether the directory a failed session was using can still be spawned in. */
export function directoryRefusal(cwd: string): string | undefined {
  let stats;
  try {
    stats = statSync(cwd);
  } catch (error) {
    return refusalForCode((error as NodeJS.ErrnoException).code, cwd);
  }
  if (!stats.isDirectory()) {
    return `Cannot retry: ${cwd} is no longer a directory.`;
  }
  return undefined;
}

/**
 * The refusal for a specific `stat` failure code.
 *
 * Split out and exported because the DISTINCTION is the whole point and it is not observable in a test that
 * runs as root: permission checks are bypassed for uid 0, so an EACCES cannot be produced reliably on every
 * machine this runs on. Testing the mapping directly makes the guarantee checkable everywhere, and a
 * filesystem test only has to prove the mapping is reached for ENOENT.
 */
export function refusalForCode(code: string | undefined, cwd: string): string {
  if (code === "ENOENT") {
    return `Cannot retry: ${cwd} no longer exists. Open a directory that exists, or start a new session.`;
  }
  if (code === "EACCES" || code === "EPERM") {
    return `Cannot retry: ${cwd} is not readable by this process (${code}). The directory exists; its permissions changed.`;
  }
  return `Cannot retry: ${cwd} cannot be used (${code ?? "unknown error"}).`;
}
