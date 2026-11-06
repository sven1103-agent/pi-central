/**
 * The directory chooser's state (issue #76, ADR-0012).
 *
 * ## Why this is separate from `files.ts`
 *
 * `files.ts` caches a *tree* per session: keyed by `(session, relative path)`, expanded node by node, with an
 * open-file pane attached. The chooser is one directory at a time, with no session, no expansion and no file
 * contents — a browser rather than a tree. Folding it into `files.ts` would mean every session transition
 * re-reasoning about a cache that no session owns.
 *
 * ## The state that matters is "what do we know", exactly as in `files.ts`
 *
 * `unloaded` is distinct from `loading`, and `loaded` with zero entries is a real answer ("no subdirectories
 * here"). A refusal is `failed` with a reason, never an empty list — the distinction `transcriptError` and
 * `FileErrorNote` both exist for. That is the mistake this module refuses to repeat, so it is stated once here
 * rather than per component.
 */
import type { PlaceEntryInfo, PlaceInfo } from "@pi-central/protocol";

/** What is known about one directory in the chooser. */
export type PlaceState =
  | { status: "unloaded" }
  | { status: "loading" }
  | { status: "loaded"; listing: Listing }
  | { status: "failed"; reason: string; code?: string | undefined; message: string };

/** A directory that was successfully listed. */
export interface Listing {
  /** The directory, as the orchestrator resolved it. This is what a session would be started in. */
  path: string;
  /** `~/git/project`, for the crumb. */
  abbreviated: string;
  /** The last segment, for the crumb's bold word. */
  name: string;
  /** Where going up leads, or `undefined` at a root — the orchestrator decides, because it knows the places. */
  parent?: string | undefined;
  entries: PlaceEntryInfo[];
  truncated: boolean;
}

export interface PlacesState {
  /** The roots, once the orchestrator has answered. `undefined` means "not asked yet". */
  roots: PlaceInfo[] | undefined;
  /**
   * Where the chooser should OPEN, when a previous visit left a usable directory (issue #76).
   *
   * Resolved against the roots at the moment they arrive (`resumable` in `chooser-prefs.ts`), so a stale value — a
   * directory deleted since, a volume unmounted, a place that no longer exists — degrades to opening at `Places`
   * rather than to a listing that fails on load. It is a STARTING POINT and never a submission: only an explicit
   * "use this folder" starts a session.
   */
  resumeAt: string | undefined;
  /** The orchestrator's `$HOME`, for abbreviation. */
  home: string | undefined;
  /** Directory state per absolute path. */
  directories: Record<string, PlaceState>;
}

export function initialPlacesState(): PlacesState {
  return { roots: undefined, home: undefined, resumeAt: undefined, directories: {} };
}

/** Actions on chooser state. Local only: none of these is a protocol message. */
export type PlacesAction =
  /**
   * The sheet has just opened, so every cached listing is from a previous open.
   *
   * The same file that hid a newly created file from the tree (#189) is present here in a milder form: the chooser
   * caches a listing so navigating back to a folder is instant, and a folder the agent created while the sheet was
   * closed would not appear until the app restarted. Clearing the listings on open is cheap — one directory is read per
   * descent — and keeps "what is on disk now" the only answer.
   */
  | { kind: "reload" }
  | { kind: "placesLoading" }
  | { kind: "placesLoaded"; places: PlaceInfo[]; home: string; resumeAt?: string | undefined }
  | { kind: "placesFailed"; message: string }
  | { kind: "listingLoading"; path: string }
  | { kind: "listingLoaded"; path: string; listing: Listing }
  | { kind: "listingFailed"; path: string; reason: string; code?: string | undefined; message: string };

export function reducePlaces(state: PlacesState, action: PlacesAction): PlacesState {
  switch (action.kind) {
    case "reload":
      // The ROOTS are kept: they are a fact about this machine, and blanking the pane to refill it would replace a
      // correct answer with "Reading your places…" for the duration of every open.
      return { ...state, directories: {} };

    case "placesLoading":
      // The roots are NOT cleared here. A re-request (a reconnect, say) must not blank the pane it is refilling:
      // an empty list during a refresh reads as "this machine has no places", which is the wrong claim.
      return state;

    case "placesLoaded":
      /*
       * A loaded answer REPLACES the roots, and drops cached listings that no longer sit under one.
       *
       * `$HOME` cannot change while the orchestrator runs, so this is not about churn; it is about the one case
       * that can happen — a place directory that was created (or removed) while the sheet was open, so the answer
       * differs from the last one. Keeping a listing for a root that is now `exists: false` would offer a
       * directory the next click refuses.
       */
      return {
        ...state,
        roots: action.places,
        home: action.home,
        // Resolved ONCE, when the roots arrive: recomputing it per answer would drag the reader back to the remembered
        // folder every time a listing returned, which is a page that fights the person using it.
        resumeAt: state.resumeAt === undefined ? action.resumeAt : state.resumeAt,
        directories: pruneToRoots(state.directories, action.places),
      };

    case "placesFailed":
      /*
       * Reported as an error, and the roots are left as they were.
       *
       * There is no `rootsFailed` field, deliberately: the transport answers `listPlaces` with either `places` or
       * `error`, and an `error` event is what the shell's error strip renders. Inventing a second place to keep it
       * would be a second copy of the same message.
       */
      return state;

    case "listingLoading":
      return { ...state, directories: { ...state.directories, [action.path]: { status: "loading" } } };

    case "listingLoaded":
      return {
        ...state,
        directories: { ...state.directories, [action.path]: { status: "loaded", listing: action.listing } },
      };

    case "listingFailed":
      return {
        ...state,
        directories: {
          ...state.directories,
          [action.path]: {
            status: "failed",
            reason: action.reason,
            ...(action.code === undefined ? {} : { code: action.code }),
            message: action.message,
          },
        },
      };
  }
}

/**
 * Drop cached listings that do not sit inside one of `places`.
 *
 * Segment-wise, not by prefix: `/Users/x/gitlab` is not inside `/Users/x/git`. The same comparison ADR-0007
 * requires of the orchestrator, applied here so the client cannot hold a listing the orchestrator would refuse.
 */
function pruneToRoots(directories: Record<string, PlaceState>, places: readonly PlaceInfo[]): Record<string, PlaceState> {
  const roots = places.map((place) => place.path);
  const kept: Record<string, PlaceState> = {};
  for (const [path, directory] of Object.entries(directories)) {
    if (roots.some((root) => path === root || path.startsWith(`${root}/`))) kept[path] = directory;
  }
  return kept;
}

/** The state of one directory in the chooser, defaulting to `unloaded` rather than to empty. */
export function placeAt(state: PlacesState, path: string): PlaceState {
  return state.directories[path] ?? { status: "unloaded" };
}

/**
 * The home-relative form of a path, for the crumb.
 *
 * A copy of `recent.ts`'s `abbreviateCwd` would be a second spelling of one rule; the two surfaces sit in the same
 * sheet, so they must not disagree about what `~` means. Kept here rather than imported to avoid a cycle
 * (`recent.ts` owns the recent list, which is a different question), and asserted equal in the test.
 */
export function abbreviate(path: string, home: string | undefined): string {
  if (home !== undefined && home !== "" && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}
