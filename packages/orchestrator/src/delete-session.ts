/**
 * Deleting a session's transcript (issue #150).
 *
 * ## Why this is the only irreversible action in the app
 *
 * Everything else Pi Central does can be undone or re-derived: a stopped session is a file, a renamed one keeps its
 * old name in the record, a rejected prompt costs a retype. **A deleted transcript is gone.** So this module is
 * deliberately small, deliberately refusal-first, and deliberately un-clever: there is no trash, no soft delete, and
 * no "undo" — an undo on a removed file is a lie, which is why the issue asks for a confirmation dialog instead.
 *
 * ## What is deleted, precisely
 *
 * Two things, and the second is the one that would leave the store growing invisibly:
 *
 *   - the session file, `<stem>.jsonl`;
 *   - its **sidecar directory**, `<stem>/`, which holds the subagent runs for that session.
 *
 * Measured on a real store: the sidecar is a directory whose name is exactly the session file's stem, sitting beside
 * it. Removing only the `.jsonl` would leave the sidecar behind forever — and nothing would ever read it again, so the
 * growth would be invisible rather than merely wasteful.
 *
 * ## The containment rule, and why it is the same one #8 uses
 *
 * The path being deleted arrives from a client. A traversal here is worse than anywhere else in the program, because
 * this is the one operation that cannot be undone — so the check is not "does the string look safe" but "is the
 * canonical path inside `sessionsRoot`", the boundary ADR-0007 and C15c are built on.
 *
 * `realpathSync` runs BEFORE the containment test, and that ordering is load-bearing: a symlink inside the store
 * pointing at `~/.ssh` is a path that *looks* contained and is not. Testing the pre-resolution path would pass and
 * then delete whatever the link pointed at.
 */
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Config } from "./config.ts";

/** A refusal, with the reason a reader needs to act on. */
export interface DeleteFailure {
  ok: false;
  reason: "outside-store" | "not-found" | "not-a-file" | "not-a-session" | "failed";
  message: string;
}

export interface DeleteSuccess {
  ok: true;
  /** The session file that was removed. */
  path: string;
  /** The sidecar directory that was removed, or `undefined` when the session had none. */
  sidecar: string | undefined;
  /**
   * A sidecar that exists and could NOT be removed.
   *
   * Reported rather than swallowed, because the issue is explicit: leaving it behind silently means the store keeps
   * growing through sidecars while the reader believes the session is gone.
   */
  sidecarFailure: string | undefined;
}

export type DeleteResult = DeleteSuccess | DeleteFailure;

/** Is `candidate` inside `root` (or equal to it), on resolved paths? */
function isInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const target = resolve(candidate);
  if (target === rootPath) return true;
  return target.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep);
}

/**
 * Delete one session's transcript and its sidecar.
 *
 * Refusal-first: every check that can fail runs before anything is removed, so a partially-deleted session is not a
 * state this can produce. The one exception is the sidecar, which is removed AFTER the transcript because a failure
 * there must not leave the reader thinking the session survived — and it is reported rather than thrown, so the
 * caller can say what happened.
 */
export function deleteSessionFile(
  config: Pick<Config, "sessionsRoot">,
  requestedPath: string,
): DeleteResult {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    return { ok: false, reason: "not-found", message: "no session path was given" };
  }
  if (requestedPath.includes("\0")) {
    // Malformed input, not an escape attempt: named as what it is so the reader is not sent hunting for a traversal.
    return { ok: false, reason: "not-a-file", message: "the path contains a NUL byte, which no filesystem path can" };
  }

  /*
   * The store root, resolved. A missing root is "nothing can be deleted", not an error worth a different message —
   * there is no session to delete under a directory that does not exist.
   */
  let root: string;
  try {
    root = realpathSync(config.sessionsRoot);
  } catch {
    return {
      ok: false,
      reason: "not-found",
      message: `the session store does not exist: ${config.sessionsRoot}`,
    };
  }

  /*
   * Resolve the TARGET before testing containment.
   *
   * This is the ordering that matters. `realpathSync` collapses `..` and follows symlinks, so what is tested is the
   * file that would actually be removed — not the string that was asked for. A symlink inside the store pointing out
   * of it fails here, which is the whole reason the check is on the canonical path (ADR-0007, C15c).
   */
  let target: string;
  try {
    target = realpathSync(requestedPath);
  } catch {
    return {
      ok: false,
      reason: "not-found",
      message: `no such session file: ${requestedPath}`,
    };
  }

  if (!isInside(root, target)) {
    return {
      ok: false,
      reason: "outside-store",
      message: `refusing to delete ${target}: it is not inside the session store (${root})`,
    };
  }

  let stats;
  try {
    stats = statSync(target);
  } catch (error) {
    return { ok: false, reason: "not-found", message: (error as Error).message };
  }
  if (!stats.isFile()) {
    return {
      ok: false,
      reason: "not-a-file",
      message: `refusing to delete ${target}: it is not a file`,
    };
  }
  if (!target.endsWith(".jsonl")) {
    // The store holds only `.jsonl` session files. Anything else inside it is not ours to remove, and saying so is
    // better than a check that "happens" to be true of the current layout.
    return {
      ok: false,
      reason: "not-a-session",
      message: `refusing to delete ${basename(target)}: not a Pi session file (.jsonl)`,
    };
  }

  // The sidecar's name is the transcript's STEM, beside it — measured on a real store, not assumed.
  const stem = target.slice(0, -".jsonl".length);
  const sidecarCandidate = join(dirname(target), basename(stem));
  let sidecar: string | undefined;
  try {
    // Only a real directory counts. A file with that name is not a sidecar and is left alone.
    if (existsSync(sidecarCandidate) && statSync(sidecarCandidate).isDirectory()) sidecar = sidecarCandidate;
  } catch {
    // An unreadable candidate is treated as absent: the transcript is still deletable, and the sidecar check must not
    // be able to block the operation the reader actually asked for.
    sidecar = undefined;
  }

  /*
   * A sidecar must ALSO be inside the store.
   *
   * It is derived from the target rather than supplied by the client, so this cannot be a traversal in practice — but
   * the operation is irreversible and the check is free, so the invariant is asserted rather than argued.
   */
  if (sidecar !== undefined && !isInside(root, realpathSync(sidecar))) {
    return {
      ok: false,
      reason: "outside-store",
      message: `refusing to delete: the sidecar ${sidecar} resolves outside the session store`,
    };
  }

  try {
    rmSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: "failed",
      message: `could not delete ${basename(target)}${code === undefined ? "" : ` (${code})`}: ${(error as Error).message}`,
    };
  }

  // AFTER the transcript, so a failure here leaves a message about the sidecar rather than a claim that the session
  // survived.
  let sidecarFailure: string | undefined;
  if (sidecar !== undefined) {
    try {
      rmSync(sidecar, { recursive: true, force: true });
    } catch (error) {
      sidecarFailure = `the session file was deleted, but its sidecar could not be removed: ${sidecar} — ${(error as Error).message}`;
    }
  }

  return { ok: true, path: target, sidecar, sidecarFailure };
}
