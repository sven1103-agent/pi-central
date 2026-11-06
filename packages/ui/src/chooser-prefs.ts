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

/**
 * How a listing is ordered: which column, and which way.
 *
 * ## Why direction is separate from the column
 *
 * *"Clicking the header again shall also revert the order, so users can decide about the sorting direction"* — and that
 * is the behaviour every file manager has, because ascending is not the only useful order for either column. Newest
 * first is what you want from "Modified" almost always, and A→Z is what you want from "Name" almost always; but the
 * one time you want the opposite (the oldest backup, the project starting with `z`), a control that cannot express it
 * sends you scrolling instead.
 *
 * Two fields rather than one doubled string (`"name-desc"`), because the column and the direction are independent: a
 * reader toggling direction does not change which column is in force, and storing them apart is what keeps that true.
 */
export type SortDirection = "ascending" | "descending";

export interface SortState {
  column: "name" | "modified";
  direction: SortDirection;
}

/**
 * What a column's FIRST click means.
 *
 * Per column, because the useful default differs: "Modified" is almost always wanted newest-first, and starting it
 * oldest-first would make the first click produce the less useful of the two orders. "Name" is the reverse — A→Z is
 * what a name column is for.
 *
 * This is the rule that makes the toggle feel obvious rather than arbitrary, and it is why `defaultSort` is a function
 * rather than a constant.
 */
export function firstDirection(column: SortState["column"]): SortDirection {
  return column === "modified" ? "descending" : "ascending";
}

/**
 * What clicking `column` does to the current state.
 *
 * Same column → flip the direction. Different column → switch to it at that column's useful default. One function,
 * because the two behaviours are one gesture and splitting them would make the header's own logic the place where they
 * could disagree.
 */
export function nextSort(current: SortState, column: SortState["column"]): SortState {
  if (current.column === column) {
    return { column, direction: current.direction === "ascending" ? "descending" : "ascending" };
  }
  return { column, direction: firstDirection(column) };
}

/** The order a fresh installation uses: names, A→Z, which is how a folder list reads before you touch it. */
export function defaultSort(): SortState {
  return { column: "name", direction: "ascending" };
}

export interface ChooserPrefs {
  /**
   * The directory a session was last STARTED in from this picker — never merely one that was browsed.
   *
   * ## This field was a bug, and the reporter caught it
   *
   * *"Please make the users home folder the default one. I don't know from where this project folder is coming from."*
   *
   * It set itself on every DESCENT, so merely looking inside `~/git/data-management` made it the place the picker
   * opened from then on, for good. Nothing about looking at a folder says "this is where I want to start" — so the
   * value could only ever appear from nowhere, which is exactly how it read.
   *
   * It is now written in exactly one circumstance: `Open` succeeded. That is the only moment at which a reader has
   * expressed a preference about where to begin, and it is also the only moment at which they would be surprised to
   * start somewhere else next time.
   *
   * Absolute, as the orchestrator resolved it. Only ever used as the STARTING point — never submitted — and only after
   * it is confirmed to be inside a place and to exist, so a stale value cannot start a session anywhere.
   */
  lastDirectory?: string | undefined;
  /** Which column, and which way. See {@link SortState}. */
  sort: SortState;
  /** Whether dotfolders are shown. A view preference, so it is remembered like one. */
  showHidden: boolean;
}

export const CHOOSER_PREFS_KEY = "pi-central.chooser";

/**
 * The key chooser preferences were stored under before the descent bug was fixed.
 *
 * ## Why this exists at all
 *
 * That release wrote `lastDirectory` on every DESCENT, so an existing browser holds a folder the reader only ever
 * *looked* at — `data-management`, in the report this fixes. Fixing the writer is not enough: the bad value is already
 * in `localStorage`, and it would go on opening the picker there until something overwrote it. The reporter would press
 * refresh, open the picker, and see the same unexplained folder.
 *
 * ## What is carried forward, and what is not
 *
 * `sort` and `showHidden` were never affected by the descent bug, so they migrate — discarding them would punish the
 * reader twice for one defect. `lastDirectory` is **dropped**, deliberately: it was never a considered choice, so there
 * is nothing worth keeping, and keeping it would leave the reader looking at exactly the folder they complained about.
 *
 * ## Why a versioned envelope rather than deleting the old key
 *
 * Deleting `pi-central.chooser` outright would also be correct, but it would throw away two preferences that are fine.
 * So the envelope records `version`, and the migration runs when a stored value is versionless — i.e. written by the
 * buggy release. The SAME key is reused, which is why both fields are written together on every save: a reader can never
 * end up with a version stamp and no payload, or the reverse.
 */
const CHOOSER_PREFS_VERSION = 2;

/**
 * `localStorage`, or an in-memory stand-in when it is unavailable.
 *
 * Private mode and a full quota both throw on the first `setItem`; a picker that cannot remember a directory must still
 * open. Degrading to memory means the feature works within the tab and is forgotten on reload — a smaller promise,
 * honestly kept. (Same shape as `update-check.ts`'s `safeSessionStorage`.)
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
  return { sort: defaultSort(), showHidden: false };
}

/**
 * Read preferences from a stored string, discarding anything not recognised.
 *
 * Every field validated rather than trusted: `localStorage` is shared with whatever else runs on this origin and
 * outlives upgrades, so a stored `sort` may name a mode that no longer exists and `lastDirectory` may be a number, a
 * relative path, or absent. A refused value degrades to the default, never to a half-used one.
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
    // Absolute only. The same test the sheet applies to a typed path, and what stops a corrupted value becoming a
    // relative path that resolves somewhere unexpected.
    ...(typeof last === "string" && last.startsWith("/") ? { lastDirectory: last } : {}),
    sort: parseSort(record["sort"]),
    showHidden: record["showHidden"] === true,
  };
}

/** Read from `localStorage`, or any other string store. */
export type PrefsReader = (key: string) => string | null;

/**
 * Read the stored preferences, migrating a value written by the buggy release.
 *
 * The caller cannot tell whether a migration happened, which is the point: nothing else in the app should have to know
 * that a field was once written on every click.
 */
export function loadChooserPrefs(read: PrefsReader): ChooserPrefs {
  const raw = read(CHOOSER_PREFS_KEY);
  const parsed = parseDoc(raw);
  if (parsed === undefined) return defaultChooserPrefs();
  if (parsed.version === CHOOSER_PREFS_VERSION) return parseChooserPrefs(raw);

  /*
   * VERSIONLESS means "written by the release that persisted on every descent". Carry the two preferences that were
   * never wrong, drop `lastDirectory` (see the module comment), and report the result at the current version so the
   * migration runs once.
   */
  const carried = parseChooserPrefs(raw);
  return { sort: carried.sort, showHidden: carried.showHidden };
}

/** What {@link serializeChooserPrefs} writes: the preferences plus the envelope's version. */
export function serializeChooserPrefs(prefs: ChooserPrefs): string {
  return JSON.stringify({ ...prefs, version: CHOOSER_PREFS_VERSION });
}

/** The parsed document, or `undefined` when the stored value is not an object at all. */
function parseDoc(raw: string | null): { version?: number } | undefined {
  if (raw === null || raw === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const version = (parsed as Record<string, unknown>)["version"];
    return typeof version === "number" ? { version } : {};
  } catch {
    return undefined;
  }
}

/**
 * Read a stored sort, accepting the previous release's bare string.
 *
 * `"modified"` was stored as a plain string before direction existed, so it migrates to that column at its useful
 * default rather than being thrown away — a reader's choice of column survives the upgrade, and only the direction they
 * never had is chosen for them.
 */
export function parseSort(raw: unknown): SortState {
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    const column = record["column"] === "modified" ? "modified" : "name";
    return { column, direction: record["direction"] === "descending" ? "descending" : "ascending" };
  }
  // The previous release's form: a bare column name with no direction.
  if (raw === "modified") return { column: "modified", direction: firstDirection("modified") };
  return defaultSort();
}

/**
 * Whether a remembered directory is usable as a starting point.
 *
 * Two conditions, and the second was a bug: the directory must be inside a place (or the picker would open where the
 * orchestrator refuses to list), AND the directory must itself still be reportable. Checking only the first answers the
 * wrong question — `$HOME` exists on every machine, so a remembered `~/Projects/notes` where `notes` was deleted passed
 * and the reader got `not-found` before touching anything.
 *
 * `undefined` rather than a corrected path when it fails: "start at the nearest place above the old directory" sounds
 * helpful and would silently open a DIFFERENT folder from the one remembered, which reads as the app forgetting you.
 */
export function resumable(
  last: string | undefined,
  places: readonly { path: string; exists: boolean }[] | undefined,
  /** Whether the remembered directory itself is still there. Absent means "not checked", which is NOT "missing". */
  lastExists?: boolean,
): string | undefined {
  if (last === undefined || places === undefined) return undefined;
  // A known-missing directory is refused even though its place is fine. `undefined` is "not checked", which is NOT
  // "missing" — the listing it triggers reports the truth, and refusing on "unknown" would make every first open start
  // at Places, so the feature would look broken.
  if (lastExists === false) return undefined;
  for (const place of places) {
    if (!place.exists) continue;
    // Segment-wise, not a bare prefix: `/Users/x/git` must not claim `/Users/x/gitlab` (ADR-0007's rule).
    if (last === place.path || last.startsWith(`${place.path}/`)) return last;
  }
  return undefined;
}

/**
 * Where the picker should OPEN, in priority order (issue #76).
 *
 *   1. the directory a session was last **started** in, if it is still usable;
 *   2. `$HOME` — the reporter's requirement, and the right default: it is the one root that exists on every machine and
 *      is never empty, so a first run opens somewhere useful instead of on a menu of seven names;
 *   3. `undefined`, which means the Places pane (a machine with an unusual layout, where `$HOME` is not itself inside a
 *      place).
 *
 * The second step is what makes "the home folder is the default" true, and the first is what keeps the earlier
 * requirement — *"pick up the last directory"* — without the two contradicting each other: a fresh install has no
 * history, so it gets home; once a session has been opened somewhere, that is a stronger signal than home.
 *
 * Both candidates go through `resumable`, so neither can open the picker somewhere the orchestrator cannot list.
 *
 * Kept as a named function rather than inline in the event handler because it IS the rule, and a rule buried in a
 * callback is a rule no test can reach.
 */
export function openingDirectory(
  prefs: ChooserPrefs,
  places: readonly { path: string; exists: boolean }[] | undefined,
  home: string,
): string | undefined {
  return resumable(prefs.lastDirectory, places) ?? resumable(home, places);
}
