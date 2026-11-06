/**
 * Choosing a directory without typing it — the orchestrator's half (issue #76, ADR-0012).
 *
 * ## What this is for
 *
 * The sheet that starts a session in a named directory was a text input with no path memory. #149 gave it
 * "directories used before"; this is the other half of the same complaint: *a directory you have **not** used
 * before* is still a path you have to recite. It offers what a file dialog offers — the places you usually
 * start from, one level at a time — inside the browser UI, with no API that the stack cannot support.
 *
 * ## Why this is not `files.ts` with a wider root
 *
 * `files.ts` confines every path to a session's `cwd`; that confinement IS the feature, and it exists because
 * the browser can read the user's files at the user's UID (ADR-0007). This module is the *opposite* shape of
 * request: it deliberately reads directories that no session owns, because the whole point is to pick one.
 *
 * So the boundary is drawn by what it may read rather than by where it must stay:
 *
 *   1. **Directories only.** No file contents, no sizes beyond a kind, no metadata beyond a name and whether it
 *      is a directory. There is no `readFile` here and there must not be one.
 *   2. **A fixed set of roots.** Every path is resolved against one of `placesFor(home)` — never an arbitrary
 *      absolute path chosen by the client (see `resolveInPlaces`).
 *   3. **No writes, no execution, no spawning.** This module imports `node:fs` read calls and nothing else.
 *
 * That is a genuine capability increase over `files.ts`, and it is recorded as one: ADR-0012, which extends
 * ADR-0007 rather than quietly widening it. The browser's own picker CANNOT answer this question — a page may open
 * the OS folder panel, but `webkitRelativePath` is relative to the chosen root and `showDirectoryPicker`'s handle
 * carries no path, while `cwd` must be absolute (ADR-0012 §Alternatives, verified). The server-side alternative
 * (`osascript`) works and is rejected on cost: it would be this product's first OS-specific code path. That is why
 * the capability is built here instead of delegated.
 *
 * ## Why the roots are computed and not configured
 *
 * `placesFor` derives them from `$HOME`, so there is no config file to keep in step with a user's machine and
 * nothing to migrate. A place that does not exist is reported as absent and is not offered, because a row that
 * cannot be opened is the same lie as a recent directory that looks available.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fromErrno, type OsFailure } from "./fs-error.ts";

/** How many entries one listing returns before it says so. */
export const MAX_PLACE_ENTRIES = 500;

/**
 * A root the chooser starts from.
 *
 * `id` is stable across machines and is what the client round-trips; `path` is absolute and local. Both travel
 * because the label is not unique (`home` and a project can share a basename) and a path alone cannot be
 * re-derived for display after the roots are recomputed.
 */
export interface Place {
  id: string;
  /** The label to show: a root's own name, never a path. */
  label: string;
  path: string;
  /** False when the directory is not there (yet, or any more). Reported rather than hidden. */
  exists: boolean;
}

/** One directory in a listing. Directories only — this is a directory chooser. */
export interface PlaceEntry {
  name: string;
  /** The absolute path, so a click needs no re-derivation on the client. */
  path: string;
}

export type PlaceListing = {
  /** The directory listed, resolved. Echoed so the client can tell which answer this is. */
  path: string;
  /** The nearest enclosing root, and where this sits under it. `""`/`""` when the path IS the root. */
  root: string;
  relative: string;
  /** The parent, or `undefined` at a root — there is no ascending above the places. */
  parent?: string | undefined;
  entries: PlaceEntry[];
  /** True when the directory held more directories than {@link MAX_PLACE_ENTRIES}. */
  truncated: boolean;
};

export type PlaceResult<T> = { ok: true; value: T } | { ok: false; error: OsFailure };

/**
 * The roots offered, in the order they are shown.
 *
 * `home` first and by name, because "a project beside the others" is the common case and `~/git` is where most
 * people keep them. The list is short on purpose: a wall of twelve roots is the "meaningless rows" problem the
 * rail was cleared of (#77), and `/` is reachable by typing it rather than by being a row.
 *
 * A root that does not exist is still returned with `exists: false`, for the reason `recentDirectories`
 * documents in the UI: hiding it would read as "Pi Central has no idea where your code is", which is a
 * different and worse claim than "this place is not on this machine".
 */
export function placesFor(home: string): Place[] {
  const candidates: { id: string; label: string }[] = [
    { id: "home", label: "Home" },
    { id: "git", label: "git" },
    { id: "projects", label: "Projects" },
    { id: "src", label: "src" },
    { id: "dev", label: "dev" },
    { id: "code", label: "Code" },
    { id: "work", label: "work" },
  ];
  return candidates.map(({ id, label }) => {
    const path = id === "home" ? home : join(home, id);
    return { id, label, path, exists: isDirectory(path) };
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a client-supplied path to one that lies inside a place.
 *
 * ## Why an absolute path is accepted here when `files.ts` refuses one
 *
 * `files.ts` speaks only relative paths because a session has exactly one root and an absolute path would mean
 * the client and the boundary disagreed. This has several roots, so the client has to name one — and it names
 * it absolutely, because that is what the places ARE. What is not accepted is a path that is outside all of
 * them, and that is what this function is: a `realpath` followed by a containment check per place, using the
 * same segment-wise comparison ADR-0007 requires (`containsPath`, not `startsWith`).
 *
 * Resolving symlinks BEFORE the check is the property that matters: `/tmp` on macOS is a symlink to
 * `/private/tmp`, so a lexical comparison against a resolved root would refuse a path it had just handed out.
 *
 * `undefined` when the path is not inside any place — a closed refusal with no filesystem access at all.
 */
export function resolveInPlaces(places: readonly Place[], candidate: string): string | undefined {
  if (typeof candidate !== "string" || candidate.includes("\0")) return undefined;
  if (!candidate.startsWith("/")) return undefined;

  /*
   * Resolve what exists, and resolve the rest LEXICALLY against its real ancestor.
   *
   * `realpathSync` on a path that does not exist throws, and treating that as "leave the candidate as typed" is wrong
   * in a way a reader sees: on macOS `/var/folders/…` is a symlink to `/private/var/folders/…`, so an unresolved
   * candidate never matches the resolved root, and a TYPO inside a place was reported as "not inside one of the
   * places" — a statement about the boundary instead of about the typo. Found by a transport test that expected
   * `not-found` and got `unreadable`.
   *
   * So: walk up to the nearest ancestor that does resolve, then re-attach the missing segments. The result is compared
   * against the roots exactly as a resolved path is, so a missing path outside every place is still refused — and a
   * missing path INSIDE one reaches `readdirSync`, which is what produces the honest `ENOENT`.
   */
  const real = realPathAllowingMissing(candidate);
  for (const place of places) {
    const realPlace = realPathOf(place.path);
    if (realPlace === undefined) continue;
    // `containsPath` compares segments. A bare prefix check would let `/Users/x/git` claim `/Users/x/gitlab`.
    if (real === realPlace || real.startsWith(realPlace + sep)) return real;
  }
  return undefined;
}

/**
 * `realpath`, tolerating a tail that does not exist.
 *
 * Returns the resolved form of the deepest existing ancestor with the remaining segments (resolved for `..`, so an
 * escape is a path that the containment check then sees) re-attached.
 */
function realPathAllowingMissing(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    // Fall through: find the deepest ancestor that exists.
  }
  const segments = candidate.split(sep).filter((segment) => segment !== "");
  for (let keep = segments.length - 1; keep >= 0; keep -= 1) {
    const head = sep + segments.slice(0, keep).join(sep);
    let realHead: string;
    try {
      realHead = realpathSync(head === "" ? sep : head);
    } catch {
      continue;
    }
    // `resolve` so a `..` in the missing tail is collapsed before the containment check, not after.
    return resolve(realHead, ...segments.slice(keep));
  }
  return candidate;
}

function realPathOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * List the DIRECTORIES inside one place path.
 *
 * Directories only, and that is not a display preference: this exists to choose a working directory, so a file
 * in the list would be a row that cannot be clicked. `includeHidden` is off by default for the same reason the
 * file tree's is — the dotfile a person is looking for is rare, and `.git` beside every project is not.
 *
 * A directory that exists but cannot be read is a **stated refusal**, not an empty listing: "no subdirectories"
 * and "I may not look" send the reader to two different fixes (`fs-error.ts`).
 */
export function listPlace(
  places: readonly Place[],
  path: string,
  options: { includeHidden?: boolean } = {},
): PlaceResult<PlaceListing> {
  const resolved = resolveInPlaces(places, path);
  if (resolved === undefined) {
    return {
      ok: false,
      error: {
        reason: "unreadable",
        message: `"${path}" is not inside one of the places Pi Central offers, so it was not listed`,
      },
    };
  }

  let names: string[];
  try {
    names = readdirSync(resolved);
  } catch (error) {
    return { ok: false, error: fromErrno(error, "cannot list", `"${resolved}"`) };
  }

  const includeHidden = options.includeHidden ?? false;
  const entries: PlaceEntry[] = [];
  let truncated = false;
  for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
    if (!includeHidden && name.startsWith(".")) continue;
    const child = join(resolved, name);
    // `stat`, not `lstat`: a symlink to a directory is a perfectly good place to work, and refusing it would
    // hide `~/src -> ~/git/elsewhere`, which is ordinary. The containment check already ran on the resolved
    // PARENT; a link that points outside the places is caught when the client asks to list it, because that
    // request is resolved again from scratch.
    if (!isDirectory(child)) continue;
    if (entries.length >= MAX_PLACE_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({ name, path: child });
  }

  /*
   * The MOST SPECIFIC containing root, not the first.
   *
   * `home` contains every other place, so `places.find` picked `home` for `~/git/alpha` and reported the relative
   * path as `git/alpha` — one crumb level where there should be two, and a root whose label is `Home` for a folder
   * inside `git`. Choosing the longest matching path is what makes `~/git` the root of its own subtree.
   */
  const root = places
    .filter((place) => {
      const realPlace = realPathOf(place.path);
      return realPlace !== undefined && (resolved === realPlace || resolved.startsWith(realPlace + sep));
    })
    .sort((a, b) => b.path.length - a.path.length)[0];
  const relative = root === undefined ? "" : resolved.slice(realPathOf(root.path)!.length).replace(/^[/\\]/, "");
  const atRoot = relative === "";
  const parent =
    atRoot || root === undefined
      ? undefined
      : dirname(resolved) === realPathOf(root.path)
        ? realPathOf(root.path)
        : dirname(resolved);

  return {
    ok: true,
    value: {
      path: resolved,
      root: root?.path ?? "",
      relative,
      ...(parent === undefined ? {} : { parent }),
      entries,
      truncated,
    },
  };
}

/**
 * `~/git/project` for a path under `home` — the same abbreviation the rail and the recent list use.
 *
 * Tolerates a `home` that is itself a symlink, which is not hypothetical: a listing's `path` comes back from
 * `realpathSync`, so a home reached through a link would never match the un-resolved form.
 */
export function abbreviate(path: string, home: string): string {
  for (const form of homeForms(home)) {
    if (path === form || path.startsWith(form + sep)) return `~${path.slice(form.length)}`;
  }
  return path;
}

/**
 * `home` as given, and as resolved.
 *
 * A listing's path comes back resolved, so a `$HOME` reached through a symlink (macOS's `/var` → `/private/var` is
 * the everyday case for a temp fixture, and a home on a linked volume is the everyday case for a person) would never
 * match the un-resolved form — and every path in the chooser would render in full. Found by a transport test that
 * expected `~/git` and got the absolute path.
 */
function homeForms(home: string): string[] {
  if (home === "") return [];
  const real = realPathOf(home);
  return real === undefined || real === home ? [home] : [real, home];
}

/** The last segment, for a row's bolder line. */
export function nameOf(path: string): string {
  return basename(path) || path;
}
