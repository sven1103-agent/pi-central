/**
 * History — past sessions, searchable by content (US-4).
 *
 * The prototype listed 40 rows that did nothing when clicked; history that cannot be resumed
 * is just a log file. This makes each row actionable, and is honest about the two ways resuming
 * can fail:
 *
 *   - the recorded directory no longer exists, in which case Pi would exit 1 in RPC mode, so it
 *     is refused BEFORE spawning (resume.ts) — and the refusal offers a way forward (US-5);
 *   - Pi Central never moves a session between directories (ADR-0008), so the offered action is
 *     resume in place or start fresh, never "continue elsewhere".
 */
import { useState } from "react";
import type { HistoricalSession } from "@pi-central/protocol";
import { formatAge, nameLabel } from "../format.ts";
import {
  allOnPageSelected,
  HISTORY_PAGE_SIZE,
  HISTORY_SORT_LABELS,
  pageOf,
  pruneSelection,
  sortHistory,
  togglePageSelected,
  toggleSelected,
  type HistorySort,
} from "../history-view.ts";
import { searchHistory } from "../store.ts";
import { CopyButton } from "./CopyButton.tsx";

export function HistoryView({
  history,
  historyTotal,
  onResume,
  onDelete,
  onDeleteMany,
  home,
}: {
  history: HistoricalSession[];
  /** Total on disk, which may exceed the loaded page. */
  historyTotal: number;
  onResume: (session: HistoricalSession) => void;
  /**
   * Delete a session's transcript (issue #150).
   *
   * A callback rather than the request itself, so the confirmation dialog — which lives here, next to the row that was
   * clicked — is the only path to it. Nothing deletes without passing through a dialog the reader has read.
   */
  onDelete?: ((session: HistoricalSession) => void) | undefined;
  /**
   * Delete MANY at once (requested alongside #150).
   *
   * Separate from `onDelete` so the confirmation can say "3 sessions" and the request can carry a list — one dialog for
   * one, and one dialog for a selection, rather than N dialogs in sequence.
   */
  onDeleteMany?: ((sessions: HistoricalSession[]) => void) | undefined;
  home: string | undefined;
}) {
  const [query, setQuery] = useState("");
  const [refused, setRefused] = useState<HistoricalSession | undefined>(undefined);
  /** How the list is ordered. `newest` because that is what the page already arrives as. */
  const [sort, setSort] = useState<HistorySort>("newest");
  const [page, setPage] = useState(1);
  /**
   * Selected paths, not sessions (see `history-view.ts`).
   *
   * `useState` holding a Set: every mutation goes through the helpers, which return a new Set, so a checkbox cannot
   * appear unresponsive because the object identity never changed.
   */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  /*
   * Search, then sort, then page.
   *
   * That order matters: paging BEFORE sorting would page the unsorted list and then sort each page, so page 1 would
   * hold the newest 25 of an arbitrary 25. And selecting from `results` before paging would let "select all" reach rows
   * the reader has never seen — see `togglePageSelected`.
   */
  /*
   * `searchHistory` returns at most its own cap; the loaded page is at most that anyway, so no extra limit is applied
   * here — the reader sees every row they have, ordered and paged, rather than a second invisible cap.
   */
  const results = sortHistory(searchHistory(history, query, history.length), sort);
  const view = pageOf(results, page);

  // A selection cannot outlive the rows it names. Computed rather than stored, so it is correct on the same render the
  // list changes — the alternative is an effect that runs one frame late, showing a stale count.
  const liveSelection = pruneSelection(selected, results);
  const selectedSessions = results.filter((session) => liveSelection.has(session.path));

  return (
    <div className="history">
      <div className="history-search">
        <input
          type="search"
          value={query}
          placeholder="Search sessions by content, project, or name"
          aria-label="Search sessions"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query.length > 0 && (
          <button type="button" className="btn" onClick={() => setQuery("")}>
            Clear search
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <div className="empty" style={{ padding: 0 }}>
          <h2>No sessions on disk yet</h2>
          <p>
            History comes from <span className="mono">~/.pi/agent/sessions/</span>. A session
            appears here after its first message.
          </p>
        </div>
      ) : results.length === 0 ? (
        <div className="empty" style={{ padding: 0 }}>
          <h2>No sessions match “{query}”.</h2>
          <button type="button" className="btn" onClick={() => setQuery("")}>
            Clear search
          </button>
        </div>
      ) : (
        <>
          {/*
            The toolbar: order, count, and the bulk action. One row, because these are the controls a reader uses
            together — "show me the biggest ones, and delete the ones I have selected".
          */}
          <div className="history-toolbar">
            <label className="history-sort">
              <span>Sort</span>
              <select
                className="btn"
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value as HistorySort);
                  // Back to page 1: staying on page 7 of a re-ordered list shows rows from the middle of a different
                  // order, which reads as the sort having done nothing.
                  setPage(1);
                }}
              >
                {(Object.keys(HISTORY_SORT_LABELS) as HistorySort[]).map((key) => (
                  <option key={key} value={key}>
                    {HISTORY_SORT_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>

            <span className="hint" aria-live="polite">
              {results.length} of {history.length} session{history.length === 1 ? "" : "s"}
              {/* Say when the loaded set is a page. Presenting 500 of 1115 as a total would be a
                  half-truth, and the honest version is one short clause. */}
              {historyTotal > history.length && (
                <> · searching the {history.length} most recent of {historyTotal}</>
              )}
            </span>

            {selectedSessions.length > 0 && (
              <span className="history-bulk">
                <span className="history-bulk-count">
                  {selectedSessions.length} selected
                </span>
                {onDeleteMany !== undefined && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => onDeleteMany(selectedSessions)}
                  >
                    Delete selected
                  </button>
                )}
                <button type="button" className="btn btn-quiet" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </span>
            )}
          </div>

          <ul className="history-list">
            <li className="history-selectbar">
              <label>
                <input
                  type="checkbox"
                  checked={allOnPageSelected(liveSelection, view.rows)}
                  /*
                   * `aria-label` because the visible text is a column heading rather than a phrase: a bare checkbox
                   * announces as "checkbox". The label says the SCOPE, since "select all" over a paged list means this
                   * page and saying so prevents a nasty surprise.
                   */
                  aria-label={`Select all ${view.rows.length} sessions on this page`}
                  onChange={() => setSelected(togglePageSelected(liveSelection, view.rows))}
                />
                <span>Select this page</span>
              </label>
            </li>
            {view.rows.map((session) => (
              <li key={session.path}>
                <HistoryRow
                  session={session}
                  home={home}
                  selected={liveSelection.has(session.path)}
                  onToggleSelected={
                    onDeleteMany === undefined
                      ? undefined
                      : () => setSelected(toggleSelected(liveSelection, session.path))
                  }
                  onSelect={() => {
                    if (!session.cwdExists) {
                      // Refused before spawning: Pi exits 1 on a missing directory in RPC mode.
                      setRefused(session);
                      return;
                    }
                    onResume(session);
                  }}
                  onDelete={onDelete === undefined ? undefined : () => onDelete(session)}
                />
              </li>
            ))}
          </ul>

          {/*
            Pagination. Present whenever there is more than one page, and it states the RANGE rather than only the page
            number — "26–50 of 200" answers "how far in am I", which a bare "page 2" does not.
          */}
          {view.pages > 1 && (
            <nav className="history-pages" aria-label="History pages">
              <button
                type="button"
                className="btn"
                disabled={view.page <= 1}
                onClick={() => setPage(view.page - 1)}
              >
                ‹ Previous
              </button>
              <span className="hint">
                {(view.page - 1) * HISTORY_PAGE_SIZE + 1}–
                {Math.min(view.page * HISTORY_PAGE_SIZE, view.total)} of {view.total}
              </span>
              <button
                type="button"
                className="btn"
                disabled={view.page >= view.pages}
                onClick={() => setPage(view.page + 1)}
              >
                Next ›
              </button>
            </nav>
          )}
        </>
      )}

      {refused && <ResumeRefusal session={refused} onDismiss={() => setRefused(undefined)} />}
    </div>
  );
}

function HistoryRow({
  session,
  home,
  onSelect,
  onDelete,
  selected,
  onToggleSelected,
}: {
  session: HistoricalSession;
  home: string | undefined;
  onSelect: () => void;
  /** Present only when deletion is available; absent means the affordance is not rendered at all. */
  onDelete?: (() => void) | undefined;
  /** Whether this row is part of the bulk selection. */
  selected: boolean;
  /**
   * Toggle this row's selection. Absent when bulk deletion is not available, in which case no checkbox is rendered —
   * a checkbox that cannot lead to an action is a control that does nothing.
   */
  onToggleSelected?: (() => void) | undefined;
}) {
  return (
    /*
      A `<div>` hosting two controls, not one `<button>` — the same restructuring the rail needed in #89.

      Nested buttons are invalid HTML and browsers resolve them by breaking the inner one, so a Delete control inside a
      button row would silently not work. `.history-row-main` carries the row's layout so the visual rhythm is
      unchanged.
    */
    <div className={`history-row-wrap${onDelete === undefined ? "" : " has-delete"}${selected ? " is-selected" : ""}`}>
      {onToggleSelected !== undefined && (
        /*
         * A real checkbox, not a click on the row: selecting and opening are different intents, and a row that
         * selected when clicked would make "resume this session" impossible to do without also selecting it.
         */
        <input
          type="checkbox"
          className="history-check"
          checked={selected}
          aria-label={`Select ${nameLabel(session.name, session.scratch, session.id, session.firstMessage)}`}
          onChange={onToggleSelected}
        />
      )}
      <button type="button" className="history-row history-row-main" onClick={onSelect}>
        <span className="h1">
        {/*
          The same labelling rule the rail uses (issue #149 follow-up).

          It read `session.name ?? "Untitled session"` — so a session Pi has not named showed a constant, and the
          reader had no way to tell one from another. The prompt is available for essentially every session (885 of
          888 measured) and is what the reader would have recognised it by.
        */}
        <strong>{nameLabel(session.name, session.scratch, session.id, session.firstMessage)}</strong>
        {session.scratch && <span className="chip chip-scratch">scratch</span>}
        {/*
          The chip distinguishes GONE from UNREADABLE (issue #196).

          It said "directory is gone" for both, because the orchestrator reported them as one boolean. A
          permissions denial on a directory that is present is often fixable right now (grant access, remount,
          reopen the terminal), and telling the reader it is gone sends them to restore something that is
          already there — the exact defect `resume.ts` records having fixed once, still living in discovery.

          The wording matches what the refusal dialog says for the SAME session, because both now come from
          one classification: `directory is gone` only when it is gone, `directory unreadable` when it exists
          but cannot be read.
        */}
        {!session.cwdExists && (
          <span
            className="chip chip-awaiting-approval"
            title={
              session.cwdMissing === "unreadable"
                ? `${session.cwd} — exists but cannot be read${session.cwdError === undefined ? "" : ` (${session.cwdError})`}`
                : session.cwd
            }
          >
            {session.cwdMissing === "unreadable" ? "directory unreadable" : "directory is gone"}
          </span>
        )}
      </span>
      <span className="project" title={session.cwd}>
        {abbreviate(session.cwd, home)}
      </span>
      <p className="first">{session.firstMessage || "(no messages)"}</p>
        <span className="meta">
          <span>{formatAge(session.modifiedMs)}</span>
          <span>{session.messageCount} msgs</span>
          <span>{formatBytes(session.bytes)}</span>
        </span>
      </button>
      {onDelete !== undefined && (
        <button
          type="button"
          className="btn btn-quiet history-delete"
          /*
            Labeled for the session, not just "Delete". A list of ten rows each announcing "Delete" is unusable to a
            screen-reader user, and this is the one control whose target matters more than most.
          */
          aria-label={`Delete the session ${nameLabel(session.name, session.scratch, session.id)}`}
          title="Delete this session's transcript from disk"
          onClick={onDelete}
        >
          Delete
        </button>
      )}
    </div>
  );
}

/**
 * The refusal, with a way forward.
 *
 * Two facts must survive: the directory is gone, and Pi Central will not move the session.
 * A user who reads only the first sentence would expect a "continue elsewhere" button, so the
 * second is stated explicitly.
 */
function ResumeRefusal({
  session,
  onDismiss,
}: {
  session: HistoricalSession;
  onDismiss: () => void;
}) {
  /*
   * The dialog follows the SAME field as the chip (issue #196).
   *
   * The orchestrator answers `checkResumable` on the click and words its own refusal, but the dialog is drawn
   * before that request returns — so if it hard-coded "gone" it would flash the wrong reason for an unreadable
   * directory. Reading `cwdMissing` means the chip and this dialog say the same thing, from one fact.
   */
  const unreadable = session.cwdMissing === "unreadable";
  return (
    <div className="modal-backdrop" onClick={onDismiss} role="presentation">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="refusal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="refusal-title">
          {unreadable ? "This session's directory cannot be read" : "This session's directory is gone"}
        </h3>
        <p style={{ marginBottom: 12 }}>
          {unreadable
            ? "The directory this session worked in exists, but this process may not read it:"
            : "The directory this session worked in no longer exists:"}
        </p>
        <pre className="cmd" style={{ marginBottom: 12 }}>
          {session.cwd}
        </pre>
        <p style={{ marginBottom: 16 }}>
          {/* A different action for each, because they are different problems. */}
          {unreadable
            ? `Check that you can enter it — it may be owned by another user, a parent directory may deny access${
                session.cwdError === undefined ? "" : ` (${session.cwdError})`
              }, or a volume may not be mounted. Pi Central does not move a session between directories.`
            : "Restore it, or start a new session in the directory you want to work in. Pi Central does not move a session between directories."}
        </p>
        <div className="dialog-actions" style={{ marginTop: 0 }}>
          <button type="button" className="btn" onClick={onDismiss}>
            Close
          </button>
          <CopyButton text={session.cwd} label="path" />
        </div>
      </div>
    </div>
  );
}

function abbreviate(path: string, home: string | undefined): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
