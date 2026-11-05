/**
 * Turning an OS errno into a stated refusal.
 *
 * ## Why this is its own module, and why it is small
 *
 * Two capabilities report filesystem refusals: the session-confined file browser (`files.ts`, issue #8)
 * and the directory chooser's listing (`places.ts`, issue #76, ADR-0012). They have different scopes —
 * one is confined to a session's cwd, the other is deliberately unconfined — but the same errno means
 * the same thing in both, and it must be *said* the same way.
 *
 * The alternative was a second switch, and this repository has already paid for that twice in one
 * direction: `EPERM` reported as "gone" (#196) and a missing directory reported as `not-found` when the
 * real answer was "outside the root". A reader who is told two different things about one `EACCES`
 * cannot tell whether they are looking at two problems.
 *
 * Only the reasons that are *about the OS* live here. `escapes-cwd`, `absolute-path` and `too-large`
 * are decisions made above this layer, and folding them in would make the shared function claim to know
 * about a root it does not have.
 */
export type OsFailureReason = "not-found" | "permission" | "not-a-directory" | "is-directory" | "unreadable";

export interface OsFailure {
  reason: OsFailureReason;
  /** The raw errno, when the OS produced one. Never invented. */
  code?: string | undefined;
  /** A sentence for the reader, naming the code when there was one — never a substituted guess. */
  message: string;
}

/**
 * Map a thrown `fs` error to a refusal.
 *
 * `what` is the verb ("cannot list"), and `label` names the thing it was done to — already quoted and
 * contextualised by the caller, because only the caller knows whether it holds a relative path, an
 * absolute one, or the working directory itself.
 */
export function fromErrno(error: unknown, what: string, label: string): OsFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return { reason: "not-found", code, message: `${what} ${label}: no such file or directory (ENOENT)` };
    case "EACCES":
    case "EPERM":
      return { reason: "permission", code, message: `${what} ${label}: permission denied (${code})` };
    case "ENOTDIR":
      return { reason: "not-a-directory", code, message: `${what} ${label}: not a directory (ENOTDIR)` };
    case "EISDIR":
      return { reason: "is-directory", code, message: `${what} ${label}: is a directory (EISDIR)` };
    default:
      // No code, or one not worth special-casing. The code is still reported when present; what is
      // forbidden is inventing one.
      return {
        reason: "unreadable",
        code,
        message: code === undefined ? `${what} ${label}: ${String(error)}` : `${what} ${label}: ${String(error)} (${code})`,
      };
  }
}
