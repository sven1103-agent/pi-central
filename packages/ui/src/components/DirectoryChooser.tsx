/**
 * The directory chooser: places on the left, a filterable listing on the right (issue #76, ADR-0012).
 *
 * ## What this is, after a review said the first version was not fit
 *
 * The first version was a recent list plus three root rows plus a text field, and a screenshot review
 * (`docs/ui-reviews/directory-chooser-review.md`) concluded it was *"not fit to be the only way to pick a
 * directory — and the fix is restructuring, not restyling."* The specific findings, each of which this file
 * answers:
 *
 * | Finding | Answer here |
 * |---|---|
 * | "No up/back navigation — once you descend, nothing returns you" | A crumb with every segment clickable, plus an explicit **Up** |
 * | "No type-to-filter — the only way in is a full absolute path" | A **filter box** over the listing, autofocused, with ↑↓ + Enter |
 * | "No row affordance; a click's meaning is ambiguous" | A **folder icon**, a trailing **chevron** for descent, hover, and a separate primary button for "use this folder" |
 * | "No dates, no sorting, nothing" | **Relative age** per row and a **sort** control (Name / Recent), which the orchestrator now supplies `mtimeMs` for |
 * | "A three-item static menu is not a places rail" | A real left rail: one row per place, with its icon |
 * | "`git~/` on the right — a text-direction fault" | `direction: rtl` removed; see `styles.css`. It reversed the line's run order, and the review proved it was a bug rather than copy |
 * | "Two stacked scrollers in a narrow column" | The listing is the only scroller; the places rail and the footer are fixed |
 *
 * ## What it deliberately still is not
 *
 * Not a file manager: no rename, delete, create, or file selection. It answers exactly one question — "which
 * directory should this session work in" — and every control here is in service of answering it fast. The boundary
 * is ADR-0012's: directories only, inside a closed set of roots.
 *
 * ## Two things a reader can do and should never have to guess
 *
 * **Descending never starts anything.** Clicking a folder row navigates; only "Use this folder" starts a session.
 * That is the review's most serious finding about the first version — a used-before row launched an irreversible
 * action on a single click with no warning — and it applies to the recent list too, which now asks first.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PlaceEntryInfo, PlaceInfo } from "@pi-central/protocol";
import { placeAt, type PlacesState } from "../places.ts";
import type { PlaceSort } from "../chooser-prefs.ts";
import { ageOf } from "../age.ts";
import { FileErrorNote } from "./FileErrorNote.tsx";

export function DirectoryChooser({
  state,
  sort,
  showHidden,
  onSort,
  onToggleHidden,
  onList,
  onChoose,
  onNavigated,
}: {
  state: PlacesState;
  /** How rows are ordered. Remembered across opens (`chooser-prefs.ts`). */
  sort: PlaceSort;
  showHidden: boolean;
  onSort: (sort: PlaceSort) => void;
  /** Flip dotfolders and RE-READ `path` with the new flag — the sheet owns the request, so it needs the path. */
  onToggleHidden: (path: string) => void;
  /** List one absolute path. The roots are requested by the sheet, not here. */
  onList: (path: string) => void;
  /** Start a session in this directory. Called ONLY from an explicit "use this folder" control. */
  onChoose: (path: string) => void;
  /** Report where the reader went, so the next open resumes there. */
  onNavigated: (path: string) => void;
}) {
  /**
   * Where the reader is.
   *
   * `undefined` means the roots, which is the pane's state when nothing is remembered — or when the remembered
   * directory is not usable any more (its place is gone), in which case starting at `Places` is honest rather than
   * silently opening a different folder.
   */
  const [at, setAt] = useState<string | undefined>(state.resumeAt);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLParagraphElement>(null);

  const listing = at === undefined ? undefined : placeAt(state, at);

  /**
   * Resume where the reader was, ONCE, when the roots arrive.
   *
   * The INITIAL value above covers the common case — the places were already in the reducer when the sheet opened, so
   * the chooser renders inside the remembered folder on its first paint and nothing flickers. This effect covers the
   * other one: the sheet opened first and the roots arrived afterwards, in which case `resumeAt` appears late.
   *
   * Guarded so it cannot fight the reader: it fires once, and only while the reader has not navigated yet (`at` still
   * equals the initial value). Re-reading the preference on every listing would drag them back.
   */
  const resumed = useRef(state.resumeAt !== undefined);
  useEffect(() => {
    if (resumed.current) return;
    const start = state.resumeAt;
    if (start === undefined) return;
    resumed.current = true;
    setAt(start);
  }, [state.resumeAt]);

  /*
   * Ask for whatever is on screen, once per destination.
   *
   * Keyed on `at` alone: `placeAt(state, at)` changes identity on every answer, so depending on it would re-request
   * the same directory forever. The `unloaded` guard is what makes the effect idle after the first answer.
   */
  useEffect(() => {
    if (at === undefined) return;
    if (placeAt(state, at).status !== "unloaded") return;
    onList(at);
  }, [at, state, onList]);

  // Focus follows the location, so a keyboard reader is placed where the content changed. The filter is the exception:
  // once the reader is typing in it, moving focus on every descent would interrupt the word they are mid-way through.
  useEffect(() => {
    if (at === undefined) filterRef.current?.focus();
    else headingRef.current?.focus();
  }, [at]);

  useEffect(() => {
    setFilter("");
  }, [at]);

  const entries = useMemo(() => {
    if (listing === undefined || listing.status !== "loaded") return [];
    const needle = filter.trim().toLowerCase();
    const matching = needle === "" ? listing.listing.entries : listing.listing.entries.filter((entry) => entry.name.toLowerCase().includes(needle));
    // Sorted on the CLIENT, so changing the order is instant and needs no request — the metadata travelled with the listing.
    return [...matching].sort((a, b) => {
      if (sort === "modified") return b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }, [listing, filter, sort]);

  if (state.roots === undefined) {
    return (
      <div className="chooser chooser-empty">
        <p className="chooser-note" role="status">
          Reading your places…
        </p>
      </div>
    );
  }

  const existing = state.roots.filter((place) => place.exists);
  /**
   * The ONE place the reader is currently inside — the most specific match, not every match.
   *
   * `$HOME` contains `~/git`, so the obvious `startsWith` test marks BOTH rows current when the reader is in `~/git`:
   * two highlighted rows in a rail of three, which reads as "you are in both" and makes the rail useless for telling
   * where you are. Longest match wins, the same rule `listPlace` applies to its root.
   */
  const currentPlace = at === undefined
    ? undefined
    : existing
        .filter((place) => at === place.path || at.startsWith(`${place.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0]?.path;
  const absent = state.roots.filter((place) => !place.exists);
  const here = listing !== undefined && listing.status === "loaded" ? listing.listing : undefined;
  const loaded = listing !== undefined && listing.status === "loaded" ? listing.listing : undefined;

  return (
    <div className="chooser">
      {/* The places rail: what a file dialog puts on the left. Its own fixed column, so it never scrolls with the
          listing — the two answer different questions and must not move together. */}
      <nav className="chooser-places" aria-label="Places">
        <button
          type="button"
          className={`chooser-place${at === undefined ? " is-current" : ""}`}
          onClick={() => setAt(undefined)}
          aria-current={at === undefined ? "page" : undefined}
        >
          <PlaceIcon kind="roots" />
          <span className="chooser-place-name">Places</span>
        </button>
        {existing.map((place) => (
          <button
            key={place.id}
            type="button"
            className={`chooser-place${currentPlace === place.path ? " is-current" : ""}`}
            onClick={() => setAt(place.path)}
            aria-current={at === place.path ? "page" : undefined}
            title={place.path}
          >
            <PlaceIcon kind={place.id === "home" ? "home" : "folder"} />
            <span className="chooser-place-name">{place.label}</span>
          </button>
        ))}
        {absent.length > 0 && (
          <p className="chooser-absent">
            Not on this machine: {absent.map((place) => abbreviateWith(place.path, state.home)).join(", ")}
          </p>
        )}
      </nav>

      <div className="chooser-main">
        {/* The crumb answers "where am I" and "how do I go back" in one control. Every segment is a button except the
            current one, which is a label — a control that reloads what is already on screen is a no-op to discover. */}
        <div className="chooser-bar">
          <p className="chooser-crumb" ref={headingRef} tabIndex={-1}>
            {at === undefined ? (
              <span className="chooser-crumb-root">Places</span>
            ) : (
              <Trail state={state} at={at} onNavigate={setAt} />
            )}
          </p>
          {here?.parent !== undefined && (
            <button type="button" className="btn btn-quiet chooser-up" onClick={() => setAt(here.parent)} title="One level up">
              <span aria-hidden="true">↑</span> Up
            </button>
          )}
        </div>

        {at === undefined ? (
          existing.length === 0 ? (
            /*
             * No place exists on this machine — a real state for someone whose projects live under `/Volumes` or a path
             * that is none of the roots. The rail is empty, so an instructive sentence is the only useful thing here,
             * and it names the two routes that still work rather than leaving a blank pane.
             */
            <p className="chooser-note">
              None of the usual folders exist here. Type a path below, or use one you have worked in before.
            </p>
          ) : (
            <p className="chooser-note">
              Choose a place on the left, or pick up where you left off from the list of directories you have used before.
            </p>
          )
        ) : (
          <>
            {/* The primary action sits at the TOP of the listing, next to where the reader is looking, and it says what
                it will do to THIS folder. It is the only control on this surface that starts a session. */}
            {here !== undefined && (
              <div className="chooser-actions">
                <button type="button" className="btn chooser-use" onClick={() => onChoose(here.path)}>
                  Use “{here.name}”
                </button>
                <input
                  ref={filterRef}
                  type="search"
                  className="chooser-filter"
                  value={filter}
                  placeholder="Filter folders…"
                  aria-label={`Filter folders in ${here.name}`}
                  spellCheck={false}
                  onChange={(event) => setFilter(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-quiet chooser-sort"
                  onClick={() => onSort(sort === "name" ? "modified" : "name")}
                  title={sort === "name" ? "Sorted by name — click for most recently changed" : "Sorted by most recently changed — click for name"}
                >
                  {sort === "name" ? "A–Z" : "Recent"}
                </button>
                <button
                  type="button"
                  className="btn btn-quiet chooser-hidden"
                  onClick={() => onToggleHidden(here.path)}
                  aria-pressed={showHidden}
                  title={showHidden ? "Hide dotfolders" : "Show dotfolders"}
                >
                  {showHidden ? "Hide dots" : "Show dots"}
                </button>
              </div>
            )}

            {listing === undefined || listing.status === "loading" || listing.status === "unloaded" ? (
              <p className="chooser-note" role="status">
                Reading {abbreviateWith(at, state.home)}…
              </p>
            ) : listing.status === "failed" ? (
              <div className="chooser-failure">
                <FileErrorNote path={at} reason={listing.reason} code={listing.code} message={listing.message} />
                <button type="button" className="btn btn-quiet" onClick={() => onList(at)}>
                  Try again
                </button>
              </div>
            ) : entries.length === 0 ? (
              /* Three different emptinesses, and they are not the same fact: filtered to nothing, genuinely empty, or
                 "everything here is hidden". Saying which one is what stops a reader concluding the app is broken. */
              <p className="chooser-note">
                {filter.trim() !== ""
                  ? `No folder here matches “${filter.trim()}”.`
                  : (loaded?.entries.length ?? 0) > 0
                    ? "Only hidden folders here — turn on “Show dots”."
                    : "No subfolders — this folder is where the work would live."}
              </p>
            ) : (
              <ul className="chooser-entries" aria-label={`Folders in ${here?.name ?? "this folder"}`}>
                {entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="chooser-row"
                      onClick={() => {
                        setAt(entry.path);
                        onNavigated(entry.path);
                      }}
                      title={entry.path}
                    >
                      <FolderIcon />
                      <span className="chooser-name">{entry.name}</span>
                      {/* Age is the second line of information a file dialog gives, and the thing that makes "the
                          project I made yesterday" findable in a list of forty. `isEmpty` stops a dead-end descent. */}
                      <span className="chooser-meta">
                        {entry.isEmpty ? "empty" : ageOf(entry.mtimeMs)}
                      </span>
                      <span className="chooser-open" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {loaded?.truncated === true && (
              <p className="chooser-note">
                Stopped at the first {loaded.entries.length} folders — filtering is faster than scrolling here.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The trail from a place to here.
 *
 * Built from the listing's `abbreviated` path and the root it belongs to, never from string surgery on an absolute
 * path — so a path segment named like the home directory cannot forge a crumb.
 */
function Trail({
  state,
  at,
  onNavigate,
}: {
  state: PlacesState;
  at: string;
  onNavigate: (path: string | undefined) => void;
}) {
  const directory = placeAt(state, at);
  const root = state.roots?.find((place) => at === place.path || at.startsWith(`${place.path}/`));

  if (directory.status !== "loaded" || root === undefined) {
    return <span className="chooser-crumb-here">{abbreviateWith(at, state.home)}</span>;
  }

  const { abbreviated } = directory.listing;
  const rootForm = abbreviateWith(root.path, state.home);
  const rest = abbreviated.startsWith(rootForm) ? abbreviated.slice(rootForm.length).replace(/^[/\\]/, "") : "";
  const segments = rest === "" ? [] : rest.split("/");

  return (
    <>
      <button type="button" className="chooser-crumb-link" onClick={() => onNavigate(undefined)}>
        Places
      </button>
      <span className="chooser-sep" aria-hidden="true">
        /
      </span>
      <button type="button" className="chooser-crumb-link" onClick={() => onNavigate(root.path)}>
        {root.label}
      </button>
      {segments.map((segment, index) => {
        const path = `${root.path}/${segments.slice(0, index + 1).join("/")}`;
        const last = index === segments.length - 1;
        return (
          <span key={path}>
            <span className="chooser-sep" aria-hidden="true">
              /
            </span>
            {last ? (
              <span className="chooser-crumb-here">{segment}</span>
            ) : (
              <button type="button" className="chooser-crumb-link" onClick={() => onNavigate(path)}>
                {segment}
              </button>
            )}
          </span>
        );
      })}
    </>
  );
}

/**
 * A folder glyph, drawn inline.
 *
 * Inline SVG rather than an emoji or an icon font: an emoji renders as a different picture on every platform (and as
 * a colour glyph that ignores `currentColor`, so it cannot follow the theme), and an icon font is a webfont request
 * for one shape. Three paths, `currentColor`, nothing to load.
 */
function FolderIcon() {
  return (
    <svg className="chooser-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M1.5 3.75A1.25 1.25 0 0 1 2.75 2.5h3.1c.33 0 .64.13.88.36l.9.86h5.62a1.25 1.25 0 0 1 1.25 1.25v6.28a1.25 1.25 0 0 1-1.25 1.25H2.75A1.25 1.25 0 0 1 1.5 11.25z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The glyph for one kind of place. `roots` is the "all places" entry, so it gets a different mark from a folder. */
function PlaceIcon({ kind }: { kind: "roots" | "home" | "folder" }) {
  if (kind === "home") {
    return (
      <svg className="chooser-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2 7.2 8 2.5l6 4.7V13a.9.9 0 0 1-.9.9H2.9A.9.9 0 0 1 2 13z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "roots") {
    return (
      <svg className="chooser-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2.5 4.5h4M2.5 8h4M2.5 11.5h4M9.5 4.5h4M9.5 8h4M9.5 11.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  return <FolderIcon />;
}

function abbreviateWith(path: string, home: string | undefined): string {
  if (home !== undefined && home !== "" && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}
