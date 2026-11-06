/**
 * The directory sheet: naming the path a session will work in.
 *
 * Deliberately a sheet rather than the greeting. The common case is a session with no path (US-1);
 * this exists for the case where the work already has a home.
 *
 * ## ONE commit target, and that is the whole design (issue #76)
 *
 * There are two ways to name a directory — the browser, and the text field — and the first version had **two
 * independent commit paths**: "Use «folder»" committed the browsed selection while "Open here" (a form submit)
 * committed the text field. Three defects came out of that one duplication, all reported from a screenshot:
 *
 *   1. **Enter did the wrong thing.** The field is autofocused and inside the `<form>`, so pressing Enter committed
 *      whatever it held — which, when the reader had been browsing, was the empty string. The button that looks like
 *      the dialog's OK button silently depended on having typed something.
 *   2. **"Open here" was a lie in the browse case.** It said "here" while meaning "the text field". A reader who
 *      selected `~/git/data-management` and pressed it was told to enter an absolute path.
 *   3. **Two primaries.** A filled control in the middle of the listing and a bare one at the bottom, both starting a
 *      session, neither obviously the dialog's outcome.
 *
 * So: **the text field is an INPUT to one selection, not a competing source of truth.** The selection is
 * `effectivePath` — what the reader typed if they typed anything, otherwise the folder they browsed to. One "Open"
 * button commits it, at the bottom right where every file dialog puts it, and Enter commits it too. There is no state
 * in which two buttons can disagree, because there is only one.
 *
 * ## Two different things are still checked here, and they are different in kind
 *
 * `problem` is a **validation error**: the path cannot be used, and submission is blocked.
 * `hazard` is a **warning**: the path is usable and the consequences are worth knowing, so
 * submission is NOT blocked. Collapsing them would make the app refuse something the user may
 * have a good reason to do — which is the wrong trade for a hazard whose whole purpose is to inform.
 *
 * The hazard uses `ownInstallationWarning` from the shared protocol package, the SAME function the
 * orchestrator calls when it attaches the warning to a session. Two implementations would mean the
 * sheet warning and the rail not (or the reverse), with nothing to reveal the disagreement.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ownInstallationWarning } from "@pi-central/protocol";
import type { RecentDirectory } from "../recent.ts";
import { completeDirectory, completionBase, expandHome } from "../complete.ts";
import type { PlacesState } from "../places.ts";
import type { ChooserPrefs } from "../chooser-prefs.ts";
import { DirectoryChooser } from "./DirectoryChooser.tsx";

export function OpenDirectorySheet({
  installationRoot,
  home,
  recent = [],
  initialPath = "",
  places,
  onListPlaces,
  chooser,
  onChooserChange,
  onNavigated,
  onClose,
  onOpen,
}: {
  /** Where Pi Central is running from, or `undefined` if it could not be identified (issue #25). */
  installationRoot: string | undefined;
  /** The orchestrator's `$HOME`, for abbreviating the recent list. */
  home: string | undefined;
  /**
   * Directories used before, most recent first (issue #149).
   *
   * Derived from session history by `recentDirectories` — a projection of what is on disk, not a stored
   * list — so this sheet has no path memory of its own to keep valid.
   */
  recent?: readonly RecentDirectory[];
  /** A prefilled path, which a test uses to reach a given state without simulating typing. */
  initialPath?: string;
  /**
   * The directory chooser's state, when the orchestrator can offer one (issue #76, ADR-0012).
   *
   * `undefined` means the orchestrator is older than the chooser and does not answer for places. The pane is then
   * WITHHELD rather than rendered empty — an empty pane reads as "there are no folders on this machine", which is a
   * false claim about the machine rather than an honest statement about the versions. The sheet falls back to
   * exactly what it was: recents plus the text input.
   */
  places?: PlacesState | undefined;
  /** Ask for the roots, or for one directory inside them. Ignored when `places` is absent. */
  onListPlaces?: ((path: string | undefined, includeHidden: boolean) => void) | undefined;
  /**
   * Remembered chooser preferences: sort order, dotfolders, and where to resume (issue #76).
   *
   * Owned by `App` because they are persisted (`chooser-prefs.ts`), and passed down rather than read here so the sheet
   * stays a rendering of state it was given — the same rule `recentDirectories` follows.
   */
  chooser?: ChooserPrefs | undefined;
  onChooserChange?: ((next: ChooserPrefs) => void) | undefined;
  /** Report where the reader navigated, so the next open resumes there. */
  onNavigated?: ((path: string) => void) | undefined;
  onClose: () => void;
  onOpen: (cwd: string) => void;
}) {
  const [path, setPath] = useState(initialPath);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * The folder the reader browsed to, reported up by the chooser as they move.
   *
   * Held here rather than only inside `DirectoryChooser` because the Open button needs it: the dialog's outcome is one
   * directory, and something has to know which one when the click lands.
   */
  const [browsed, setBrowsed] = useState<string | undefined>(undefined);

  /**
   * The selection: where the reader navigated, or the folder the chooser RESUMED into.
   *
   * The fallback is not a convenience — it was a bug. The picker opens inside the remembered directory (`resumeAt`), so
   * a reader who opened the sheet and pressed Open without navigating got a disabled button while looking straight at a
   * folder. Found by a test that expected the primary to be enabled once a folder is on screen.
   */
  const selection = browsed ?? places?.resumeAt;

  /**
   * Ask for the roots when the pane first appears.
   *
   * The RESPONSE is held by the shell (`App`), because the socket listener is where every other orchestrator
   * answer lands and a second `useReducer` here would be a second copy of the same state. What belongs here is the
   * request: the pane exists only while this sheet is open, so asking at mount is asking exactly when it is needed
   * and not on every snapshot.
   *
   * Guarded on `roots === undefined` so a re-render cannot spam the socket; `onListPlaces` is stable, so the effect
   * runs once per open.
   */
  useEffect(() => {
    if (places === undefined || onListPlaces === undefined) return;
    // EVERY open, not only the first: the answer also clears the listings cached by the previous open, which is what
    // makes a folder created in between visible. See `PlacesAction.reload`.
    onListPlaces(undefined, chooser?.showHidden ?? false);
    // Deliberately not dependent on `places`: an answer must not re-trigger the request that caused it. `onListPlaces`
    // is stable, so this runs exactly once per mount — i.e. once per open.
  }, [onListPlaces]);

  /*
   * NO AUTOFOCUS, and it was the last trace of the old design (issue #76).
   *
   * The field used to take focus when the dialog opened, which said — in the loudest way a dialog can — that typing is
   * the primary act here. It is not: browsing is, and the field is the alternative for a path you already know. The
   * reporter put it plainly: *"the textfield shall only be active when the user actively clicked into it."*
   *
   * It was also the mechanism behind the Enter bug. An autofocused field inside a `<form>` means Enter commits it, so
   * pressing Enter after browsing committed an empty string while a folder sat on screen. That is fixed by the single
   * commit target, and the autofocus is the part of it that had no remaining purpose.
   *
   * What still gets focus on open is the DIALOG, so a keyboard reader lands inside it and Escape works without clicking
   * first — the dialog is the focused element, not a control inside it.
   */
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const trimmed = path.trim();
  /*
   * `~` is expanded here rather than refused (issue #76).
   *
   * The orchestrator requires an absolute path and always did. But `~/git/project` is what a reader TYPES, and telling
   * them to rewrite it as `/Users/them/git/project` is friction with no purpose: `$HOME` is sent in every snapshot, so
   * the expansion is a fact this component already holds. What is NOT relaxed is the requirement itself — an
   * unexpanded `~someone/else` still fails, because this process cannot know where another user's home is.
   */
  const expanded = useMemo(() => expandHome(trimmed, home), [trimmed, home]);

  /**
   * THE selection — the one directory "Open" commits.
   *
   * Typed text WINS when there is any, because a reader who typed has explicitly overridden the browser; otherwise the
   * browsed folder. That precedence is also what makes the two inputs stop competing: the field no longer needs to be
   * cleared or avoided, and the browser no longer needs its own commit button, because typing simply replaces the
   * selection the browser set.
   *
   * Before this, the two were separate commit paths — and Enter, in an autofocused field inside a `<form>`, committed
   * the empty text field rather than the folder on screen.
   */
  const effectivePath = trimmed !== "" ? expanded : (selection ?? "");

  // Client-side validation is advisory only: the orchestrator validates the directory before
  // spawning, and a directory can vanish between the two checks (D-4).
  const problem = useMemo(() => {
    if (effectivePath === "") return "Choose a folder below, or type a path.";
    if (!effectivePath.startsWith("/")) return "Enter an absolute path, starting with /.";
    return undefined;
  }, [effectivePath]);

  /**
   * The self-hosting hazard, evaluated while the path is being typed (issue #25).
   *
   * Advisory and non-blocking: the user may have a good reason, and the warning exists to inform the
   * decision rather than to make it. `problem` gates submission; this deliberately does not.
   *
   * Skipped when the path is already invalid, because a sentence about consequences next to "enter
   * an absolute path" would be noise about something the user cannot act on yet.
   */
  const hazard = useMemo(() => {
    if (problem !== undefined) return undefined;
    return ownInstallationWarning(effectivePath, installationRoot);
  }, [effectivePath, installationRoot, problem]);

  /**
   * The completions for what is being typed (issue #76).
   *
   * Candidates come from the recent list (directories used before, #149) and from the chooser's cache — the folder
   * currently being typed into, whose contents the reader may already have loaded. The second source is why this costs
   * no new request: a completion of `~/git/pro` only needs `~/git`, which the chooser already asked for when the reader
   * was there.
   *
   * Suppressed while a `problem` is showing EXCEPT the absolute-path one, because completing `/Us` is exactly how a
   * reader gets to an absolute path. See the guard below.
   */
  const completions = useMemo(() => {
    if (trimmed === "" || expanded === "") return [];
    const { dir } = completionBase(expanded);
    const known = places?.directories[dir];
    const siblings = known?.status === "loaded" ? known.listing.entries.map((entry) => entry.path) : [];
    return completeDirectory({
      typed: trimmed,
      home,
      recent: recent.map((entry) => entry.cwd),
      siblings,
    });
  }, [trimmed, expanded, home, recent, places]);

  /** Commit the ONE selection. The only place a session is started from this dialog. */
  const commit = () => {
    if (problem === undefined) onOpen(effectivePath);
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal modal-sheet"
        role="dialog"
        // Focusable itself, so it can RECEIVE focus without putting the caret in a field. `tabIndex={-1}` keeps it out of
        // the Tab order; it is a focus anchor, not a control.
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="open-dir-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="open-dir-title">Open in a directory</h3>
        {/*
          ONE navigation surface: the recent directories and the places share a rail, and the listing fills the rest.

          This replaced a recent list stacked ABOVE the browser, and the reason is measurable in the screenshot that
          prompted it: the dialog was 720px wide with a mostly-empty right pane, because three vertical blocks (recents,
          places, listing) were each given a slice of a 900px dialog. Nobody could see more than four folders. Moving
          the recents into the rail does three things at once — the listing gets the whole height, "where could I go"
          has ONE answer instead of two, and the two ways of choosing (a destination I used before, versus a place I
          browse) become visually distinct groups in one column rather than two competing regions.
        */}
        {places !== undefined && onListPlaces !== undefined && (
          <DirectoryChooser
            state={places}
            recent={recent}
            onChooseRecent={(cwd) => onOpen(cwd)}
            sort={chooser?.sort ?? "name"}
            showHidden={chooser?.showHidden === true}
            onSort={(sort) => onChooserChange?.({ ...(chooser ?? { sort: "name", showHidden: false }), sort })}
            onToggleHidden={(target) => {
              const next = { ...(chooser ?? { sort: "name" as const, showHidden: false }), showHidden: chooser?.showHidden !== true };
              onChooserChange?.(next);
              /*
               * Re-read the folder the reader is LOOKING AT, not the remembered one.
               *
               * `includeHidden` is a server-side filter, so toggling it is a request rather than a client filter: the
               * orchestrator caps a listing at 500 entries, and a client-side filter would hide dotfolders the cap had
               * already displaced — the toggle would appear to do nothing. (Same reasoning as `listFiles`.)
               */
              onListPlaces(target, next.showHidden);
            }}
            onList={(target) => onListPlaces(target, chooser?.showHidden === true)}
            onNavigated={(target) => {
              // The browsed folder IS the selection, reported up so the footer's Open button can commit it. It is also
              // remembered, so the next open resumes there.
              setBrowsed(target);
              onNavigated?.(target);
            }}
            /*
             * A row in "used before" COMMITS — it is a destination, not a location — so it goes straight to `onOpen`
             * rather than through `commit`. That is the one deliberate second path, and it is not a second SOURCE: the
             * row names its directory explicitly, so there is nothing to disagree about.
             */
          />
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
        >
          <div className="path-row">
            <input
              ref={inputRef}
              type="text"
              value={path}
              spellCheck={false}
              placeholder="Or type an absolute path"
              aria-label="Working directory"
              aria-invalid={problem !== undefined && path.length > 0}
              onChange={(event) => setPath(event.target.value)}
              style={{
                width: "100%",
                background: "var(--bg)",
                border: "1px solid var(--line-strong)",
                borderRadius: 6,
                padding: "8px 10px",
                color: "var(--text)",
                font: "13px var(--mono)",
              }}
            />
            {/*
              Clear the typed override and fall back to the browsed selection. Without this there is no way back: a
              reader who typed a path and then changed their mind would have to select the text and delete it, and the
              browser would look broken because clicking a folder no longer changed what Open would use.
            */}
            {trimmed !== "" && (
              <button
                type="button"
                className="btn btn-quiet path-clear"
                onClick={() => {
                  setPath("");
                  inputRef.current?.focus();
                }}
                title="Clear the typed path and use the folder selected above"
              >
                Clear
              </button>
            )}
          </div>
          {problem !== undefined && path.length > 0 && (
            <p style={{ color: "var(--warn-text)", fontSize: 12, margin: "6px 0 0" }}>{problem}</p>
          )}
          {/*
            Suggestions, under the input and only when there is something to suggest.

            A list that appears before anything is typed would cover the recent list above with a duplicate of itself.
            Each row ACCEPTS by filling the input rather than submitting, so a reader can descend two levels without
            starting a session by accident — and the last click is always the explicit Open.
          */}
          {completions.length > 0 && (
            <ul className="completions" aria-label="Matching directories">
              {completions.map((completion) => (
                <li key={completion.path}>
                  <button
                    type="button"
                    className="completion"
                    title={completion.path}
                    onClick={() => {
                      /*
                       * The DISPLAY form with a trailing slash, not the absolute path.
                       *
                       * Display form because the reader must see a value they would recognise: someone who typed
                       * `~/git/pro` and got `/Users/them/git/project` back has been handed a different string, and the
                       * expansion happens once at commit. The slash because every completion is a directory — so the
                       * next list immediately offers its contents, instead of making the reader type the slash that
                       * this feature exists to save.
                       */
                      setPath(`${completion.display}/`);
                      inputRef.current?.focus();
                    }}
                  >
                    <span className="completion-typed">{completion.typedPart}</span>
                    <strong className="completion-rest">{completion.remainder}</strong>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {hazard !== undefined && (
            // `role="status"` rather than `alert`: this updates as the user types, and an alert on
            // every keystroke would interrupt a screen reader mid-word. Not an error — the submit
            // button stays enabled, which a test asserts.
            <p className="hazard" role="status">
              <span aria-hidden="true">⚠ </span>
              {hazard}
            </p>
          )}
          {/*
            WHAT WILL BE OPENED, stated — because one of the two inputs may have won, and the reader is entitled to see
            which. This is the fix for the competition the reporter noticed: instead of asking the reader to work out
            whether their typing or their clicking counts, the dialog says so in one line, right above the button.

            No longer only "when a `~` was expanded": it appears whenever the two inputs differ, which is exactly when
            the precedence is not obvious.
          */}
          {problem === undefined && effectivePath !== trimmed && (
            <p className="effective-path mono" role="status">
              <span className="effective-path-label">
                {trimmed === "" ? "Selected" : "Opening"}
              </span>
              {effectivePath}
            </p>
          )}
          <div className="dialog-actions">
            {/*
              Cancel first, primary last: the conventional order in a file dialog, and it puts the primary at the
              bottom RIGHT, where the reporter (and every OS file picker) expects the outcome of the dialog.
            */}
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary-sheet" disabled={problem !== undefined}>
              Open
            </button>
          </div>
          {/*
            The sandbox/exemption sentence is a FOOTNOTE, below the actions.

            It sat between the recents and the chooser, where it cost two lines of a 900px dialog to say something a
            reader needs once and cannot act on — while the two things they DO act on were competing for that space.
            A sentence about consequences belongs beside the consequence (the buttons), not between the two ways of
            choosing.
          */}
          <p className="sheet-footnote">
            The session is sandboxed to this directory, and Pi Central does not change a session's directory later.
            Start it where the work belongs.
          </p>
        </form>
      </div>
    </div>
  );
}
