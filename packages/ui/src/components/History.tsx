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
  onDeleteMany,
  home,
}: {
  history: HistoricalSession[];
  /** Total on disk, which may exceed the loaded page. */
  historyTotal: number;
  onResume: (session: HistoricalSession) => void;
  /**
   * Delete MANY at once (requested alongside #150).
   *
   * The ONLY way to delete from this tab: a row has no control of its own, so every path goes through a selection and
   * one confirmation. That is also what lets the dialog state a count rather than name one row out of several.
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
      {/*
        ONE action bar: search, sort, count, and the bulk action (requested from use).

        They were three separate rows — a search field, then a toolbar, then a select-all line — which pushed the list
        down by ~90px and made the controls read as unrelated. They are the controls a reader uses together, so they
        share a row, and the select-all checkbox is in the list's own header where it belongs.
      */}
      <div className="history-actions">
        <input
          type="search"
          className="history-search-input"
          value={query}
          placeholder="Search sessions by content, project, or name"
          aria-label="Search sessions"
          onChange={(event) => {
            setQuery(event.target.value);
            // Back to page 1: a filter that leaves 3 rows must not strand the reader on page 7 of the old list.
            setPage(1);
          }}
        />
        {query.length > 0 && (
          <button type="button" className="btn btn-quiet" onClick={() => setQuery("")}>
            Clear
          </button>
        )}

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

        {/*
          The pager, TOP-RIGHT of the list — the fix for "users need to scroll a lot to see it".

          It shares its page state with the bottom pager, so there is one answer to "which page am I on".
        */}
        <HistoryPager view={view} onPage={setPage} position="top" />

        {/*
          How many sessions there are, as its own fact.

          It said `500 of 500 · 885 on disk` — two ratios pushed together, which is exactly the kind of arithmetic a
          reader has to do to extract "there are 885 sessions". The COUNT is the important information, so it is stated
          as a number with a noun: `885 sessions`. The filtered case says so separately, and only when it applies.
        */}
        <span className="history-count" aria-live="polite">
          {selectedSessions.length > 0 && (
            <strong className="history-selected-count">{selectedSessions.length} selected · </strong>
          )}
          <strong>{historyTotal}</strong> session{historyTotal === 1 ? "" : "s"}
          {results.length !== history.length && (
            <span className="hint"> · {results.length} match{results.length === 1 ? "" : "es"}</span>
          )}
        </span>

        {/*
          Clear, whenever anything is selected — and it is not decoration.

          Removing the old bulk toolbar silently removed the only way to drop a selection in one step: a reader who had
          ticked twenty rows had to untick them one at a time. With "select this page" that is the difference between
          a usable bulk action and a trap.

          It sits BEFORE the delete button so the safe escape is not the last thing in the row, and it appears on the
          same condition — which is fine here, unlike the delete button, because hiding it when nothing is selected
          removes nothing: there is no state to escape from.
        */}
        {selectedSessions.length > 0 && (
          <button
            type="button"
            className="btn btn-quiet history-clear"
            title={`Clear ${selectedSessions.length} selected session${selectedSessions.length === 1 ? "" : "s"}`}
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        )}

        {onDeleteMany !== undefined && (
          /*
            ALWAYS present, DISABLED until something is selected (requested from use).

            It used to appear only once a selection existed, which made a primary action materialise out of nowhere
            and left the reader with no way to see that bulk delete exists before selecting. A disabled control states
            the capability and the condition — and the count in its label says what it will act on.
          */
          <button
            type="button"
            className="btn btn-danger history-bulk-delete"
            disabled={selectedSessions.length === 0}
            title={
              selectedSessions.length === 0
                ? "Select sessions with the checkboxes first"
                : `Delete ${selectedSessions.length} selected transcript${selectedSessions.length === 1 ? "" : "s"}`
            }
            onClick={() => onDeleteMany(selectedSessions)}
          >
            Delete{selectedSessions.length > 0 ? ` ${selectedSessions.length}` : ""}
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
                />
              </li>
            ))}
          </ul>

          {/*
            Pagination. Present whenever there is more than one page, and it states the RANGE rather than only the page
            number — "26–50 of 200" answers "how far in am I", which a bare "page 2" does not.
          */}
          {/* The end-of-list pager. The same control sits at the TOP as well — see `HistoryPager`. */}
          <HistoryPager view={view} onPage={setPage} position="bottom" />
        </>
      )}

      {refused && <ResumeRefusal session={refused} onDismiss={() => setRefused(undefined)} />}
    </div>
  );
}

/**
 * The pager, rendered at BOTH ends of the list.
 *
 * ## Why both, and why the top one is the one that fixes this
 *
 * Pagination conventionally sits at the bottom right, because it is read after the rows. That convention assumes
 * rows you can take in at once. A History row is a ~120px card, so 25 of them is roughly 3,000px of scrolling — the
 * reader has to travel the whole list to reach the only control that leaves it. That is not a convention problem, it
 * is a distance problem.
 *
 * So there are two, sharing one page state: the top one is reachable without scrolling, and the bottom one is where
 * a reader who has actually read the page expects it. Neither is a second source of truth — both call the same
 * `setPage`.
 *
 * ## What it states
 *
 * The RANGE and the TOTAL (`26–50 of 500`), not the page number. "Page 2 of 20" says how many pages there are;
 * "26–50 of 500" says where you are in the corpus, which is the question a reader has. The total is also the only
 * place the size of the collection is visible without reading the toolbar, so it is repeated here rather than
 * assumed.
 */
function HistoryPager({
  view,
  onPage,
  position,
}: {
  view: { page: number; pages: number; total: number };
  onPage: (page: number) => void;
  /** Distinguishes the two instances for assistive tech, which would otherwise see two identically-named navs. */
  position: "top" | "bottom";
}) {
  // One page needs no pager: there is nowhere to go, and the total is already in the toolbar.
  if (view.pages <= 1) return null;
  const first = (view.page - 1) * HISTORY_PAGE_SIZE + 1;
  const last = Math.min(view.page * HISTORY_PAGE_SIZE, view.total);

  return (
    <nav className="history-pages" aria-label={`History pages (${position})`}>
      <button
        type="button"
        className="btn"
        disabled={view.page <= 1}
        onClick={() => onPage(view.page - 1)}
        // Named so a screen-reader user knows which pager they are on; "Previous" twice in one page is ambiguous.
        aria-label={`Previous page (${position} pager)`}
      >
        ‹ Previous
      </button>
      <span className="hint">
        {first}–{last} of {view.total}
      </span>
      <button
        type="button"
        className="btn"
        disabled={view.page >= view.pages}
        onClick={() => onPage(view.page + 1)}
        aria-label={`Next page (${position} pager)`}
      >
        Next ›
      </button>
    </nav>
  );
}

function HistoryRow({
  session,
  home,
  onSelect,
  selected,
  onToggleSelected,
}: {
  session: HistoricalSession;
  home: string | undefined;
  onSelect: () => void;
  /** Present only when deletion is available; absent means the affordance is not rendered at all. */
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
      A `<div>` hosting the checkbox and the row's button — the same restructuring the rail needed in #89.

      Nested buttons are invalid HTML and browsers resolve them by breaking the inner one. `.history-row-main` carries
      the row's layout so the visual rhythm is unchanged.

      The row has NO delete control of its own: deletion is a bulk action in the toolbar, disabled until something is
      selected. Per-row buttons on every row made the list read as a grid of destructive affordances, and with a
      selection model they were a second, redundant way to do the same thing.
    */
    <div className={`history-row-wrap${selected ? " is-selected" : ""}`}>
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
