/**
 * The directory sheet: naming the path a session will work in.
 *
 * Deliberately a sheet rather than the greeting. The common case is a session with no path (US-1);
 * this exists for the case where the work already has a home.
 *
 * ## Two different things are checked here, and they are different in kind
 *
 * `problem` is a **validation error**: the path cannot be used, and submission is blocked.
 * `hazard` is a **warning**: the path is usable and the consequences are worth knowing, so
 * submission is NOT blocked. Collapsing them would make the app refuse something the user may have
 * a good reason to do — which is the wrong trade for a hazard whose whole purpose is to inform.
 *
 * The hazard uses `ownInstallationWarning` from the shared protocol package, the SAME function the
 * orchestrator calls when it attaches the warning to a session. Two implementations would mean the
 * sheet warning and the rail not (or the reverse), with nothing to reveal the disagreement.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ownInstallationWarning } from "@pi-central/protocol";
import { abbreviateCwd, baseName, type RecentDirectory } from "../recent.ts";
import { completeDirectory, completionBase, expandHome } from "../complete.ts";
import type { PlacesState } from "../places.ts";
import { DirectoryChooser } from "./DirectoryChooser.tsx";

export function OpenDirectorySheet({
  installationRoot,
  home,
  recent = [],
  initialPath = "",
  places,
  onListPlaces,
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
  onListPlaces?: ((path?: string) => void) | undefined;
  onClose: () => void;
  onOpen: (cwd: string) => void;
}) {
  const [path, setPath] = useState(initialPath);
  const inputRef = useRef<HTMLInputElement>(null);

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
    onListPlaces();
    // Deliberately not dependent on `places`: an answer must not re-trigger the request that caused it. `onListPlaces`
    // is stable, so this runs exactly once per mount — i.e. once per open.
  }, [onListPlaces]);

  useEffect(() => {
    inputRef.current?.focus();
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

  // Client-side validation is advisory only: the orchestrator validates the directory before
  // spawning, and a directory can vanish between the two checks (D-4).
  const problem = useMemo(() => {
    if (trimmed.length === 0) return "Enter a directory.";
    if (!expanded.startsWith("/")) return "Enter an absolute path, starting with /.";
    return undefined;
  }, [trimmed, expanded]);

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
    return ownInstallationWarning(trimmed, installationRoot);
  }, [trimmed, installationRoot, problem]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-dir-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="open-dir-title">Open in a directory</h3>
        {/*
          Recent directories come FIRST, and they are the reason this sheet is usable at all (issue #149).

          Before this the sheet was a bare text input: starting a second task in a project you were already
          working in meant retyping an absolute path from memory. The list is derived from session headers
          (`recentDirectories`), so it is a projection of what is on disk rather than a cache that could
          disagree with it — and a directory that has since been deleted is still shown, marked, and
          refused before anything is spawned (the #11 rule) rather than silently omitted.
        */}
        {recent.length > 0 && (
          <div className="recent-dirs">
            <p className="recent-dirs-label" id="recent-dirs-label">
              Used before
            </p>
            <ul aria-labelledby="recent-dirs-label">
              {recent.map((entry) => (
                <li key={entry.cwd}>
                  <button
                    type="button"
                    className="recent-dir"
                    /*
                      A directory that no longer exists is DISABLED rather than hidden or allowed.

                      Hidden would make the list silently forget a project whose volume is unmounted — the
                      reader would conclude Pi Central forgot it. Allowed would spend a spawn on a directory
                      that cannot work: RPC-mode Pi exits 1 rather than prompting (C2), so the failure would
                      arrive as an unexplained crash instead of a stated reason.
                    */
                    disabled={!entry.cwdExists}
                    /*
                      The reason, not just "no longer exists" (issue #196).

                      `cwdExists: false` from an orchestrator that predates `cwdMissing` keeps the old wording — a
                      missing cause must not be invented. When the reason IS known, it decides the sentence, because
                      "unreadable" is often fixable now and "gone" is not.
                    */
                    title={
                      entry.cwdExists
                        ? entry.cwd
                        : entry.cwdMissing === "unreadable"
                          ? `${entry.cwd} — exists but cannot be read`
                          : `${entry.cwd} — no longer exists`
                    }
                    onClick={() => onOpen(entry.cwd)}
                  >
                    <span className="recent-dir-name">{baseName(entry.cwd)}</span>
                    <span className="recent-dir-path mono">{abbreviateCwd(entry.cwd, home)}</span>
                    <span className="recent-dir-count">
                      {entry.cwdExists
                        ? `${entry.sessions} session${entry.sessions === 1 ? "" : "s"}`
                        : entry.cwdMissing === "unreadable"
                          ? "unreadable"
                          : "missing"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p style={{ marginBottom: 12 }}>
          The session is sandboxed to this directory. Pi Central does not change a session's
          directory later, so start it where the work belongs.
        </p>
        {/*
          The chooser comes after the recent list and before the text input.

          That order is the frequency order: "a directory I used before" and "the project I am working in" are both
          one click above, and browsing is for the case neither answers — a project you have never opened here. Putting
          it above the input keeps the exact-path route (the fastest one for someone who knows the path) reachable
          without scrolling past a folder list.
        */}
        {places !== undefined && onListPlaces !== undefined && (
          <DirectoryChooser
            state={places}
            onList={(target) => onListPlaces(target)}
            onListRoots={() => onListPlaces()}
            onChoose={onOpen}
          />
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (problem === undefined) onOpen(expanded);
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={path}
            spellCheck={false}
            placeholder="/absolute/path/to/project"
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
          {problem !== undefined && path.length > 0 && (
            <p style={{ color: "var(--warn-text)", fontSize: 12, margin: "6px 0 0" }}>{problem}</p>
          )}
          {/*
            Suggestions, under the input and only when there is something to suggest.

            A list that appears before anything is typed would cover the recent list above with a duplicate of itself.
            Each row ACCEPTS by filling the input rather than submitting, so a reader can descend two levels without
            starting a session by accident — and the last click is always the explicit "Open here".
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
                       * expansion happens once at submit. The slash because every completion is a directory — so the
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
            What will actually be used, when a `~` was expanded. The alternative is a session started in a directory
            the reader never saw written down — the same class of dishonesty as a rename that silently retargets.
          */}
          {problem === undefined && expanded !== trimmed && (
            <p className="expanded-path mono" role="status">
              {expanded}
            </p>
          )}
          <div className="dialog-actions">
            <button type="submit" className="btn" disabled={problem !== undefined}>
              Open here
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
