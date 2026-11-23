/**
 * Is a session's toolset stale? What can this process honestly say about it (issue #274).
 *
 * ## The question, and the two dishonest answers
 *
 * A reader adds a skill, an extension or an MCP server while a session runs. Pi discovered its resources
 * once, at startup, so the session does not have it — and Pi Central, until this module, knew nothing about
 * a session's toolset at all, so it could not say so either.
 *
 * The two easy answers are both wrong:
 *
 *   - **"Up to date"** because nothing here changed. A session can be stale for a reason outside any
 *     directory this process watches: an `extensions` list in the agent's `settings.json` pointing at
 *     somebody else's path, an MCP server registered from an installed package.
 *   - **"Stale"** because a directory's mtime is recent. A `skills/` directory touched by an editor save
 *     that changed nothing makes Pi's own discovery produce an identical set, and a reader who reloads and
 *     sees no difference has been told a story.
 *
 * So the module reports what it MEASURED, and the payload carries the limit with it: `watched` names the
 * locations that answered, `unwatched` names the kinds of source it cannot see, and `unreadable` forces the
 * answer to `unknown` rather than to a clean one.
 *
 * ## Why mtimes rather than a hash of the contents
 *
 * The check runs over locations that can hold hundreds of files (skills, prompt templates), on a control a
 * reader presses, and its only output is three-valued. Reading every file to hash it would turn a press into
 * a filesystem sweep for a coarser claim than the timestamps already support — Pi itself decides staleness
 * by re-reading, and the reload is what proves it either way. The mtime is the cheapest evidence that the
 * directory CHANGED since the session read it, which is exactly the claim made.
 *
 * ## C14's lesson, one level down
 *
 * "A failed read and an empty result must be different events." An absent directory is not a failure — a
 * machine with no `prompts/` has no prompt templates, and that is a fact. A directory that exists and cannot
 * be read is a failure, and it is reported as `unreadable` and ANDed into `unknown`.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolsetLocation, ToolsetStatus } from "@pi-central/protocol";

/** The resource kinds Pi discovers from a directory, per scope. */
const DIRECTORY_KINDS = ["extensions", "skills", "prompts", "themes"] as const;

export interface ToolsetInput {
  /**
   * Pi's agent directory — where user-level `extensions/`, `skills/`, `prompts/`, `themes/` and
   * `mcp.json` live. `config.providerAgentDir` in practice, because that is the directory Pi actually reads
   * (`PI_CODING_AGENT_DIR` when set), rather than an assumption about `~/.pi/agent`.
   */
  agentDir: string;
  /** The session's working directory. Project resources are discovered from here (`.pi/…`). */
  cwd: string;
  /**
   * When the session last loaded its resources — its start, or its last reload.
   *
   * `undefined` means Pi Central never saw that moment, and then the freshness is `unknown`: without it
   * there is nothing to compare a directory against, and "newest file is old" cannot be established.
   */
  resourcesLoadedAt: number | undefined;
}

/** Files whose own mtime decides freshness, because the location is one file rather than a directory. */
const MCP_FILE = "mcp.json";

/**
 * Read one location, or record why it could not be read.
 *
 * Deliberately NON-recursive at the top level, with one exception: a directory's own mtime changes when an
 * entry inside it is created, removed or renamed, so `extensions/foo.ts` appearing is visible without
 * walking. It does NOT change when an existing file is edited in place — which is why the union below takes
 * the newest top-level mtime AND replaces it with the newest entry mtime the stat call already has.
 */
function measure(
  path: string,
  isFile: boolean,
): { mtimeMs: number | undefined; code?: never } | { mtimeMs?: never; code: string } {
  try {
    /*
     * FLOORED to whole milliseconds, and this is not tidiness.
     *
     * `statSync().mtimeMs` is a float on macOS (a file written in the same millisecond as the session read its
     * resources reports `…187.9`), while `Date.now()` is an integer. Comparing the two directly made a file
     * written a moment BEFORE a reload read as newer than it, so a session that had just picked a change up went on
     * reporting "changed" — the false-positive direction, which trains a reader to ignore the warning.
     */
    if (isFile) return { mtimeMs: Math.floor(statSync(path).mtimeMs) };
    const stats = statSync(path);
    if (!stats.isDirectory()) return { mtimeMs: Math.floor(stats.mtimeMs) };
    // The directory's own mtime covers create/remove/rename of direct children; the children's own mtimes
    // cover an edit in place, which the directory's mtime does not see. Both are cheap and neither is enough.
    let newest = Math.floor(stats.mtimeMs);
    for (const name of readdirSync(path)) {
      try {
        const child = Math.floor(statSync(join(path, name)).mtimeMs);
        if (child > newest) newest = child;
      } catch {
        // A child that vanished between readdir and stat is not a reason to fail the check; the DIRECTORY was
        // readable, which is what this function reports.
      }
    }
    return { mtimeMs: newest };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Absent is a fact, not a failure: a machine with no prompts/ simply has no prompt templates.
    if (code === "ENOENT" || code === "ENOTDIR") return { mtimeMs: undefined };
    return { code: code ?? "unknown" };
  }
}

/**
 * Establish what can be said about one session's toolset.
 *
 * Every location is read, so the payload describes the check rather than only its verdict — a surface that
 * lists them is showing what was actually looked at, which is the difference between this and a badge.
 */
export function inspectToolset(input: ToolsetInput): ToolsetStatus {
  const watched: ToolsetLocation[] = [];
  const unreadable: { path: string; code?: string | undefined }[] = [];

  const look = (scope: "agent" | "project", kind: ToolsetLocation["kind"], path: string, isFile = false): void => {
    const result = measure(path, isFile);
    if (result.code !== undefined) {
      unreadable.push({ path, code: result.code });
      return;
    }
    watched.push({
      scope,
      kind,
      path,
      ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
    });
  };

  for (const kind of DIRECTORY_KINDS) look("agent", kind, join(input.agentDir, kind));
  look("agent", "mcp", join(input.agentDir, MCP_FILE), true);
  for (const kind of DIRECTORY_KINDS) look("project", kind, join(input.cwd, ".pi", kind));
  look("project", "mcp", join(input.cwd, ".pi", MCP_FILE), true);

  /*
   * The sources this check structurally cannot see. Named rather than counted, because each one is a
   * different reason a reader's addition might not appear here — and because a surface that renders
   * "unchanged" beside this list is telling the truth about its own coverage.
   */
  const unwatched = [
    "extensions enabled by a path in the agent settings.json",
    "MCP servers registered from an installed package",
    "skills under ~/.agents/skills, which Pi also reads",
  ];

  if (input.resourcesLoadedAt === undefined) {
    return { freshness: "unknown", watched, unwatched, unreadable };
  }
  if (unreadable.length > 0) {
    // A check that could not look has not found anything. Reporting the readable half as "unchanged" would
    // be the fabricated-clean-result failure this module exists to avoid.
    return { freshness: "unknown", resourcesLoadedAt: input.resourcesLoadedAt, watched, unwatched, unreadable };
  }
  const newest = watched.reduce<number | undefined>(
    (max, location) =>
      location.mtimeMs === undefined ? max : max === undefined ? location.mtimeMs : Math.max(max, location.mtimeMs),
    undefined,
  );
  /*
   * A strict comparison, with NO grace window, and the asymmetry is the reason.
   *
   * A grace window cuts both ways and the two errors are not equally bad:
   *
   *   - reporting "changed" for a file that the reload already picked up costs one extra reload, and the next
   *     reload moves the reference forward — the warning is self-correcting;
   *   - reporting "unchanged" for a file written a moment after the session read its resources is a MISSED
   *     staleness, and it persists until the directory changes again. The session is missing a tool and the panel
   *     says there is nothing to do about it.
   *
   * The repository's rule for a claim it cannot fully verify is to over-report rather than under-report, so the
   * cheaper error is the one chosen. (A filesystem that rounds mtimes to the second only widens the harmless side.)
   */
  const changed = newest !== undefined && newest > input.resourcesLoadedAt;
  return {
    freshness: changed ? "changed" : "unchanged",
    resourcesLoadedAt: input.resourcesLoadedAt,
    watched,
    unwatched,
    unreadable,
  };
}
