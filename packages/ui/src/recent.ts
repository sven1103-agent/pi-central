/**
 * Directories you have worked in before (issue #149).
 *
 * ## The use case this serves
 *
 * *"the user can have multiple sessions in the same working directory… which causes attention dilution. So
 * users want to actually create a new session in the same dir"* — many sessions per directory is the
 * **intended** workflow, one task per session, and `/new` in the Pi TUI is the established gesture for it.
 * Pi Central had the capability and not the gesture: starting a second task in a project meant retyping an
 * absolute path from memory, because `OpenDirectorySheet` is a bare text input with no path memory anywhere.
 *
 * ## Why this is derived and not stored
 *
 * The list is a **projection of what is already on disk**. Every session header records its `cwd`
 * (`registry.ts`), so "directories I have worked in" is a `groupBy` over history — there is no new state to
 * keep valid, nothing to migrate, and nothing that can disagree with the sessions it claims exist. A
 * `localStorage` list of recent paths would be a second answer to a question the session store already
 * answers, and it would survive the directory being deleted.
 *
 * ## What "recent" means
 *
 * The **newest session's** `modifiedMs`, not the oldest and not an average. A directory you have not touched
 * in a month but whose session you appended to this morning is recent, and the newest timestamp is the only
 * one that reflects that.
 *
 * Ordering is by that timestamp, descending, with a name-order tiebreak so the list cannot shuffle between
 * two renders when two directories share a timestamp.
 *
 * ## Scratch directories are excluded, and that is a decision
 *
 * `--Users-x-.local-share-pi-central-workspaces-s7--`-style scratch directories are app-owned, one per
 * session, and never a project you return to. Offering them would fill the list with paths whose names are
 * `s7`, `s8`, `s9` — the exact "wall of meaningless rows" the rail was cleared of in #77.
 */
import type { HistoricalSession } from "@pi-central/protocol";

/** One directory, with the sessions that share it. */
export interface RecentDirectory {
  /** The absolute path, exactly as a session header recorded it. */
  cwd: string;
  /** How many sessions in the history ran here. The evidence that this is a real place you work. */
  sessions: number;
  /** The newest `modifiedMs` among those sessions. What "recent" is ordered by. */
  lastUsedMs: number;
  /** Whether the directory exists NOW, as discovery last checked (D-4). */
  cwdExists: boolean;
  /**
   * Why it cannot be used, when it cannot — the same distinction History makes (issue #196).
   *
   * A directory that is merely **unreadable** is a different situation from one that is gone, and the recovery is
   * different (grant access or remount, versus restore a directory). Aggregated across the sessions that share this
   * path, and kept only while they agree: if one session saw `EPERM` and another saw `ENOENT`, the state is genuinely
   * unclear and claiming either with confidence would be the same lie the boolean told.
   *
   * Absent when the directory is present, and absent from an orchestrator that predates the field — in which case the
   * sheet falls back to the vaguer `missing` wording rather than inventing a cause.
   */
  cwdMissing?: "missing" | "unreadable" | undefined;
}

/**
 * The directories from a page of history, most recently used first.
 *
 * Takes `HistoricalSession[]` rather than `UiState` so it is testable without a store, and so the caller
 * decides which sessions to offer — the History pane's page, or the live fleet's own directories.
 *
 * `limit` bounds the result rather than the input: a fleet of one project with forty sessions should yield
 * ONE row, so trimming the input first would be the wrong order.
 */
export function recentDirectories(
  history: readonly HistoricalSession[],
  limit = 6,
): RecentDirectory[] {
  const byCwd = new Map<string, RecentDirectory>();

  for (const session of history) {
    // A scratch workspace is app-owned and one-per-session, never a project to return to.
    if (session.scratch) continue;
    // A session that does not record its directory cannot contribute one (the `unknown-cwd` case
    // `resume.ts` refuses). An empty string would become a row that starts a session nowhere.
    if (session.cwd === "") continue;

    const existing = byCwd.get(session.cwd);
    if (existing === undefined) {
      byCwd.set(session.cwd, {
        cwd: session.cwd,
        sessions: 1,
        lastUsedMs: session.modifiedMs,
        cwdExists: session.cwdExists,
        ...(session.cwdMissing === undefined ? {} : { cwdMissing: session.cwdMissing }),
      });
      continue;
    }
    existing.sessions += 1;
    if (session.modifiedMs > existing.lastUsedMs) existing.lastUsedMs = session.modifiedMs;
    // One session's directory still existing is enough: a stale `false` from a directory that has since
    // been restored must not mark the row unavailable.
    existing.cwdExists = existing.cwdExists || session.cwdExists;
    // The reason survives only while every unreadable report agrees — see the field's comment.
    if (!existing.cwdExists && session.cwdMissing !== undefined) {
      if (existing.cwdMissing === undefined || existing.cwdMissing === session.cwdMissing) {
        existing.cwdMissing = session.cwdMissing;
      } else {
        // Disagreement: the two sessions could not reach it for different reasons, so neither is asserted.
        delete existing.cwdMissing;
      }
    }
  }

  return [...byCwd.values()]
    .sort((a, b) => b.lastUsedMs - a.lastUsedMs || a.cwd.localeCompare(b.cwd))
    .slice(0, limit);
}

/**
 * Where a directory lives, abbreviated for a list.
 *
 * `~/git/project` rather than the full path, with the home directory collapsed only when it is a real
 * prefix — the same rule `shortenPath` follows in the rail, applied here so the two surfaces agree about
 * what a path looks like.
 */
export function abbreviateCwd(cwd: string, home: string | undefined): string {
  if (home !== undefined && home !== "" && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

/**
 * The last path segment, for the second line of a row.
 *
 * The basename alone would be ambiguous (`project` in two trees), which is why it is shown BESIDE the
 * abbreviated path rather than instead of it — but as the bolder of the two, because it is what a reader
 * recognises.
 */
export function baseName(cwd: string): string {
  const parts = cwd.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? cwd;
}
