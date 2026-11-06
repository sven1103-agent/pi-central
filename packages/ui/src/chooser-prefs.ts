/**
 * Where the directory chooser was left, and how it lists (issue #76).
 *
 * Stored in `localStorage` — NOT `sessionStorage`: "pick up the last directory" has to survive a reload, and a PWA
 * window that is closed and reopened is exactly when a reader expects the picker to remember. `sessionStorage` would
 * forget at the moment the memory is worth most.
 *
 * ## The complaint this answers, in the reporter's words
 *
 * *"when users have been in a location before (previous directory picking), don't let them start from the default
 * again, pick up the last directory."*
 *
 * That is the same argument `recentDirectories` (#149) makes about sessions, one step further: a chooser that opens
 * on `Places` every time makes the reader re-walk a path they walked ten minutes ago. A file dialog reopens where you
 * last were, and it is one of the few behaviours every OS file picker shares.
 *
 * ## Why this is stored and `recentDirectories` is not
 *
 * They look similar and are different kinds of fact. "Directories I have worked in" is derivable from session headers,
 * so it is a projection and must never be stored — storing it would create a second answer that can disagree with the
 * sessions it claims exist (see `recent.ts`).
 *
 * "Where I was browsing, and how I wanted the list sorted" is **not** derivable from anything: it is a record of a
 * navigation the user performed, and no session header knows about it. So it is stored, in `localStorage`, and it is
 * treated as a *preference* rather than as data — see the validation below.
 *
 * ## Everything here is validated, because localStorage outlives upgrades
 *
 * A stored last-directory may name a directory that has been deleted, renamed, or was on a volume that is now
 * unmounted. The rule is the one `panel.ts` follows: a corrupt or stale value degrades to the default rather than
 * producing a broken state — and crucially, the chooser **verifies existence before offering it**, so a stale value
 * costs one failed listing at worst and never a session started in the wrong place.
 */

/** How a listing is ordered. `name` is the convention; the others answer "what did I touch recently". */
export type PlaceSort = "name" | "modified";

export interface ChooserPrefs {
  /**
   * The directory the chooser was last left in, or `undefined` for "never navigated".
   *
   * Absolute, as the orchestrator resolved it. Only ever used as the STARTING point — never submitted — and only after
   * it is confirmed to be inside a place and to exist, so a stale value cannot start a session anywhere.
   */
  lastDirectory?: string | undefined;
  /** Ascending name order, or newest-modified first. */
  sort: PlaceSort;
  /** Whether dotfolders are shown. A view preference, so it is remembered like one. */
  showHidden: boolean;
}

export const CHOOSER_PREFS_KEY = "pi-central.chooser";

/**
 * `localStorage`, or an in-memory stand-in when it is unavailable.
 *
 * The same shape `update-check.ts` uses for `sessionStorage`, and for the same reason: private mode and a full quota
 * both throw on `setItem`, and a picker that cannot remember a directory must still open. Degrading to memory means the
 * feature works within the tab and is forgotten on reload — a smaller promise, honestly kept.
 */
export function safeLocalStorage(): Storage {
  try {
    const probe = "pi-central.chooser-probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    const memory = new Map<string, string>();
    return {
      get length() {
        return memory.size;
      },
      clear: () => memory.clear(),
      getItem: (key: string) => memory.get(key) ?? null,
      key: (index: number) => [...memory.keys()][index] ?? null,
      removeItem: (key: string) => void memory.delete(key),
      setItem: (key: string, value: string) => void memory.set(key, value),
    } as Storage;
  }
}

export function defaultChooserPrefs(): ChooserPrefs {
  return { sort: "name", showHidden: false };
}

/**
 * Read remembered chooser preferences, discarding anything not recognised.
 *
 * A `sort` naming a mode that no longer exists degrades to `name` rather than to an empty list; a `lastDirectory` that
 * is not a string (or is not absolute) is dropped rather than half-used, because a relative path cannot be resumed and
 * silently substituting one would start a session somewhere the reader never chose.
 */
export function parseChooserPrefs(raw: string | null): ChooserPrefs {
  const fallback = defaultChooserPrefs();
  if (raw === null || raw === "") return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A half-written value from a crash mid-write. The default is correct, so this is not worth reporting.
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;
  const record = parsed as Record<string, unknown>;

  const last = record["lastDirectory"];
  return {
    // Absolute only. `startsWith("/")` is the same test the sheet applies to a typed path, and it is what stops a
    // corrupted value becoming a relative path that resolves somewhere unexpected.
    ...(typeof last === "string" && last.startsWith("/") ? { lastDirectory: last } : {}),
    sort: record["sort"] === "modified" ? "modified" : "name",
    showHidden: record["showHidden"] === true,
  };
}

/** Serialize for `localStorage`. Kept beside `parseChooserPrefs` so the two cannot drift. */
export function serializeChooserPrefs(prefs: ChooserPrefs): string {
  return JSON.stringify(prefs);
}

/**
 * Whether a remembered directory is usable as a starting point.
 *
 * ## Two conditions, and the second is the one I got wrong first
 *
 * The directory must be inside a place (`resumable` would otherwise open somewhere the orchestrator refuses to list),
 * AND the directory must itself still be reportable. The first version checked only "is its place present", which
 * answers the wrong question: `$HOME` exists on every machine, so a remembered `~/Projects/notes` on a machine where
 * `notes` was deleted passed the test — the chooser then opened there and the reader saw `not-found` before touching
 * anything. Found by a test that expected `undefined` and got the path back.
 *
 * `exists` for the directory itself comes from the caller, which has just listed the parent (or is about to): the
 * chooser asks the orchestrator, and this function only decides. Keeping the decision pure is what makes the failure
 * above testable without a filesystem.
 *
 * Returning `undefined` rather than a corrected path is deliberate: "start at the nearest place above the old
 * directory" sounds helpful and would silently open a DIFFERENT folder from the one remembered, which reads as the app
 * forgetting where you were. Falling back to `Places` is honest — it says "start again" instead of pretending.
 */
export function resumable(
  last: string | undefined,
  places: readonly { path: string; exists: boolean }[] | undefined,
  /** Whether the remembered directory itself is still there. Absent means "not checked", which is NOT "missing". */
  lastExists?: boolean,
): string | undefined {
  if (last === undefined || places === undefined) return undefined;
  // A known-missing directory is refused even though its place is fine. `undefined` (not checked) is allowed through:
  // the listing it triggers is what will report the truth, and refusing on "unknown" would make every first open
  // start at Places.
  if (lastExists === false) return undefined;
  for (const place of places) {
    if (!place.exists) continue;
    // Segment-wise, not a bare prefix: `/Users/x/git` must not claim `/Users/x/gitlab` (ADR-0007's rule).
    if (last === place.path || last.startsWith(`${place.path}/`)) return last;
  }
  return undefined;
}
