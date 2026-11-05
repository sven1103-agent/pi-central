/**
 * The directory chooser: places, one level at a time (issue #76, ADR-0012).
 *
 * ## What this replaces, precisely
 *
 * Not the text input — an exact path is still the fastest way in for someone who knows it, so it stays. This
 * replaces the *recall*: a directory you have never used was previously a path you had to recite, and the recent
 * list (#149) only helps with directories you have used before. This offers `~/git`, then the projects inside it,
 * which is the gesture a file dialog provides and which the browser stack can genuinely support.
 *
 * ## Why the trail is a crumb and not a stack of "back" buttons
 *
 * The reader is choosing a directory, and the thing they are choosing between is "this one" and "one inside it".
 * A crumb shows where they are in that hierarchy and lets them jump up in one click; a back button would require
 * walking. The crumb is built from the listing the orchestrator sent, including `parent` — the client never
 * slices a path to guess where "up" is, because only the orchestrator knows whether going up would leave the
 * places.
 *
 * ## What it must not do
 *
 * It does not spawn anything, and it does not decide that a directory is usable. "Choose this directory" hands
 * the path to the same `onOpen` the text input uses, so the orchestrator's own validation (existence, the #25
 * hazard, #49's root check) is the only answer to "may I work here" — one implementation, so the two entry
 * paths inside this sheet cannot disagree.
 */
import { useEffect, useRef, useState } from "react";
import type { PlaceInfo } from "@pi-central/protocol";
import { placeAt, type PlacesState } from "../places.ts";
import { FileErrorNote } from "./FileErrorNote.tsx";

export function DirectoryChooser({
  state,
  onList,
  onListRoots,
  onChoose,
}: {
  state: PlacesState;
  /** List one absolute path (or ask for the roots again, which is what a retry needs). */
  onList: (path: string) => void;
  /** Ask for the roots again. Used by the retry beside a failed first request. */
  onListRoots: () => void;
  /** Start a session here. The path is already absolute and orchestrator-resolved. */
  onChoose: (path: string) => void;
}) {
  /**
   * Where the reader currently is.
   *
   * `undefined` means "the roots", which is the pane's first state and is not a directory. Kept as local state
   * rather than in `PlacesState` because it is *navigation* — which folder is on screen — and a snapshot or a
   * reconnect must not move the reader somewhere else while they are choosing.
   */
  const [at, setAt] = useState<string | undefined>(undefined);
  const headingRef = useRef<HTMLParagraphElement>(null);

  const listing = at === undefined ? undefined : placeAt(state, at);

  /*
   * Ask for whatever is on screen, once per destination.
   *
   * Keyed on `at` alone, deliberately: `placeAt(state, at)` changes identity on every answer, so depending on it
   * would re-request the same directory forever. The `unloaded` guard is what makes the effect idle after the
   * first answer — `loading`, `loaded` and `failed` all mean "already asked".
   */
  useEffect(() => {
    if (at === undefined) return;
    if (placeAt(state, at).status !== "unloaded") return;
    onList(at);
  }, [at, state, onList]);

  /*
   * Move focus to the heading when the directory changes.
   *
   * Without this, choosing a folder replaces the content under the reader's pointer and leaves focus on a button
   * that no longer exists — so the next Tab starts from the top of the document, and a screen-reader user is told
   * nothing about the navigation they just performed.
   */
  useEffect(() => {
    headingRef.current?.focus();
  }, [at]);

  if (state.roots === undefined) {
    return (
      <div className="chooser">
        <p className="chooser-note" role="status">
          Reading your places…
        </p>
      </div>
    );
  }

  const existing = state.roots.filter((place) => place.exists);
  const absent = state.roots.filter((place) => !place.exists);

  return (
    <div className="chooser">
      <div className="chooser-bar">
        {at === undefined ? (
          <p className="chooser-crumb" ref={headingRef} tabIndex={-1}>
            Places
          </p>
        ) : (
          <Breadcrumb state={state} at={at} onNavigate={setAt} headingRef={headingRef} />
        )}
        {/*
          A second, explicit ascend control beside the path input comes later in the sheet — this one exists so a
          reader in a deep folder is never dependent on spotting a crumb segment.
        */}
        {listing?.status === "loaded" && listing.listing.parent !== undefined && (
          <button
            type="button"
            className="btn btn-quiet chooser-up"
            onClick={() => setAt(listing.listing.parent)}
            title="One level up"
          >
            Up
          </button>
        )}
      </div>

      {at === undefined ? (
        <>
          {existing.length === 0 && (
            /*
             * No places at all is a real machine state, not a bug: someone whose projects are under `/Volumes` or
             * a path that is none of the seven. The text input is still there, and this says so rather than
             * showing an empty box.
             */
            <p className="chooser-note">
              None of the usual folders exist here. Type a path below, or use one you have worked in before.
            </p>
          )}
          <ul className="chooser-roots" aria-label="Places">
            {existing.map((place) => (
              <li key={place.id}>
                <button type="button" className="chooser-row" onClick={() => setAt(place.path)} title={place.path}>
                  <span className="chooser-name">{place.label}</span>
                  <span className="chooser-path mono">{abbreviateWith(place.path, state.home)}</span>
                </button>
              </li>
            ))}
          </ul>
          {absent.length > 0 && (
            /*
              A root that is not on this machine is SHOWN, disabled, and named. Hiding it would be the same mistake
              the recent list corrects (#149): the reader concludes Pi Central does not know about `~/Projects`,
              when the truth is that this machine has no such folder.
            */
            <p className="chooser-absent">
              Not on this machine:{" "}
              {absent.map((place, index) => (
                <span key={place.id}>
                  {index > 0 && ", "}
                  <span className="mono">{abbreviateWith(place.path, state.home)}</span>
                </span>
              ))}
            </p>
          )}
        </>
      ) : listing === undefined || listing.status === "loading" || listing.status === "unloaded" ? (
        <p className="chooser-note" role="status">
          Reading {abbreviateWith(at, state.home)}…
        </p>
      ) : listing.status === "failed" ? (
        /*
          A refusal states its reason and offers the two things that could help: try again, or go back. A plain
          "could not read" beside an empty list would be the failure `FileErrorNote` exists to prevent.
        */
        <div className="chooser-failure">
          <FileErrorNote path={at} reason={listing.reason} code={listing.code} message={listing.message} />
          <div className="dialog-actions">
            <button type="button" className="btn btn-quiet" onClick={() => onList(at)}>
              Try again
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setAt(undefined)}>
              Back to places
            </button>
          </div>
        </div>
      ) : (
        <>
          {/*
            The "choose this directory" control comes FIRST and is the primary action: descending is a means, and
            the folder the reader is looking at is usually the answer. It states the path rather than "Open here" so
            two open buttons in one sheet are distinguishable.
          */}
          <div className="chooser-current">
            <button type="button" className="btn" onClick={() => onChoose(listing.listing.path)}>
              Use {listing.listing.name}
            </button>
          </div>

          {listing.listing.entries.length === 0 ? (
            /* Empty is an ANSWER, not a failure. Say which one it is. */
            <p className="chooser-note">No subdirectories — this folder is where the work would live.</p>
          ) : (
            <ul className="chooser-entries" aria-label={`Folders in ${listing.listing.name}`}>
              {listing.listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="chooser-row"
                    onClick={() => setAt(entry.path)}
                    // The full path, because two entries can share a name in different trees and the crumb above is
                    // the only other place it appears.
                    title={entry.path}
                  >
                    <span className="chooser-name">{entry.name}</span>
                    <span className="chooser-open" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {listing.listing.truncated && (
            <p className="chooser-note">
              Stopped at the first {listing.listing.entries.length} folders. It is probably faster to type the path.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The trail from a root to here.
 *
 * Segments are derived from the LISTING's `abbreviated` path and the root it belongs to, not from string surgery
 * on an absolute path — so a path containing a segment named like the home directory cannot forge a crumb.
 */
function Breadcrumb({
  state,
  at,
  onNavigate,
  headingRef,
}: {
  state: PlacesState;
  at: string;
  /** `undefined` returns to the roots, which is what the leading crumb does. */
  onNavigate: (path: string | undefined) => void;
  headingRef: React.RefObject<HTMLParagraphElement | null>;
}) {
  const directory = placeAt(state, at);
  const root = state.roots?.find((place) => at === place.path || at.startsWith(`${place.path}/`));

  if (directory.status !== "loaded" || root === undefined) {
    return (
      <p className="chooser-crumb" ref={headingRef} tabIndex={-1}>
        {abbreviateWith(at, state.home)}
      </p>
    );
  }

  const { abbreviated } = directory.listing;
  const rootForm = abbreviateWith(root.path, state.home);
  // `abbreviated` always begins with the root's abbreviated form, because the orchestrator derived one from the
  // other. The remainder is the trail below the root.
  const rest = abbreviated.startsWith(rootForm) ? abbreviated.slice(rootForm.length).replace(/^[/\\]/, "") : "";
  const segments = rest === "" ? [] : rest.split("/");

  return (
    <p className="chooser-crumb" ref={headingRef} tabIndex={-1}>
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
              // The current directory is not a link: a control that reloads what is already on screen is a no-op
              // the reader has to discover by pressing it.
              <span className="chooser-crumb-here">{segment}</span>
            ) : (
              <button type="button" className="chooser-crumb-link" onClick={() => onNavigate(path)}>
                {segment}
              </button>
            )}
          </span>
        );
      })}
    </p>
  );
}

function abbreviateWith(path: string, home: string | undefined): string {
  if (home !== undefined && home !== "" && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}
