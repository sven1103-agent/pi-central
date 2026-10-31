/**
 * The session rail.
 *
 * Ordered by ATTENTION, not by creation: a session blocked on a dialog is first because it
 * cannot progress without the user, while an idle one can wait. This differs from the
 * prototype, which stacked 40 dead history rows under the live ones — history lives in its own
 * pane with its own search, because two orderings in one scrolling column cannot both be
 * legible.
 */
import { useMemo, useState } from "react";
import type { LiveSession } from "@pi-central/protocol";
import { displayName, formatContext, formatCost, formatModel, formatThinking, nameLabel, shortenPath, whereLine } from "../format.ts";
import { stateLabel } from "../store.ts";
import { groupRows, rowActivity, type RosterRow } from "../roster.ts";

/**
 * Section headings, in attention order.
 *
 * The CLASSIFICATION lives in `roster.ts#groupOf` so it is testable without a DOM and so "where does a row that
 * is not running go" has one answer; only the words a person reads are here.
 *
 * These sections are kept deliberately (#68, settled): *"i now see directly when sth has finished without
 * scrolling"*. A stable list with a state chip would show the same fact on a row the reader may not be looking at.
 */
const GROUPS = [
  { key: "needs", label: "Needs you" },
  { key: "failed", label: "Failed" },
  { key: "running", label: "Running" },
  { key: "idle", label: "Idle" },
  { key: "stopped", label: "Stopped" },
] as const;

export function SessionRail({
  rows,
  focusedId,
  onFocusRow,
  onForgetRow,
  onRetryRow,
  onStartSession,
  onOpenDirectory,
  home,
  historyTotal,
}: {
  /**
   * The roster, with activity joined in (issue #89).
   *
   * One list of rows — `session === undefined` means the session is not running and belongs under `Stopped`. The
   * roster decides WHICH rows exist and their order within a section; activity decides the section.
   */
  rows: RosterRow[];
  /** The focused row's key: a live session's id, or a row's file path. */
  focusedId: string | undefined;
  /** Focus a row. A row that is not running focuses too, so the composer can send and resume on send. */
  onFocusRow: (row: RosterRow) => void;
  /**
   * Take a row off the roster.
   *
   * A view change, not a deletion: the session FILE stays on disk. Deleting is #150 and is irreversible, so it
   * is a different action with its own confirmation.
   */
  onForgetRow: (row: RosterRow) => void;
  /**
   * Retry a FAILED session (issue #11).
   *
   * The affordance `DESIGN.md` promised and never had: its composer text says "Retry it from the rail", and
   * the rail had no such control.
   */
  onRetryRow: (row: RosterRow) => void;
  onStartSession: () => void;
  onOpenDirectory: () => void;
  home: string | undefined;
  /** Total sessions on disk, which may exceed the number loaded. */
  historyTotal: number;
}) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return rows;
    return rows.filter((row) => {
      const name = rowName(row).toLowerCase();
      const cwd = (row.entry.cwd ?? "").toLowerCase();
      const id = row.session?.id.toLowerCase() ?? "";
      return name.includes(needle) || cwd.includes(needle) || id.includes(needle);
    });
  }, [rows, filter]);

  const sections = useMemo(() => groupRows(filtered), [filtered]);

  return (
    <nav className="rail" aria-label="Sessions">
      <div className="rail-start">
        {/* The PRIMARY action, first in the rail, with no path field anywhere near it (US-1). */}
        <button type="button" className="btn-primary" onClick={onStartSession}>
          New session
          <small>runs in a scratch workspace</small>
        </button>
        {/* Secondary, and deliberately quiet: it is the exception, not the greeting. */}
        <button type="button" className="btn-quiet" onClick={onOpenDirectory}>
          <span>Open in a directory…</span>
          <span className="mono">⌘⇧O</span>
        </button>
      </div>

      <div className="rail-filter">
        <input
          type="search"
          value={filter}
          placeholder="Filter sessions"
          aria-label="Filter sessions"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <div className="rail-list">
        {rows.length === 0 ? (
          <p className="rail-empty">
            No sessions yet. Start one with <kbd>⌘N</kbd>.
          </p>
        ) : sections.length === 0 ? (
          <p className="rail-empty">No sessions match “{filter}”.</p>
        ) : (
          sections.map((section) => (
            <section key={section.group} aria-label={labelOf(section.group)}>
              <h3 className="group-header">
                <span>{labelOf(section.group)}</span>
                <span className="count">{section.rows.length}</span>
              </h3>
              {section.rows.map((row) => (
                <RailRow
                  key={rowKey(row)}
                  row={row}
                  focused={rowKey(row) === focusedId}
                  onFocus={() => onFocusRow(row)}
                  onForget={() => onForgetRow(row)}
                  onRetry={() => onRetryRow(row)}
                  home={home}
                />
              ))}
            </section>
          ))
        )}

        {historyTotal > 0 && (
          <p className="rail-empty" style={{ borderTop: "1px solid var(--line)", marginTop: 8 }}>
            {/* The true total, not the size of the loaded page. See `historyTotal`. Built as one
                string so it renders as one text node rather than three that React separates. */}
            {`${historyTotal} session${historyTotal === 1 ? "" : "s"} on disk — see the History tab.`}
          </p>
        )}
      </div>
    </nav>
  );
}

/** The section label for a group key. The words live here; the classification lives in `roster.ts`. */
function labelOf(group: (typeof GROUPS)[number]["key"]): string {
  return GROUPS.find((candidate) => candidate.key === group)?.label ?? group;
}

/**
 * The render key for a row.
 *
 * A live session has a handle; a row that is not running has only its file. Both are stable, and a row can never
 * be keyed by BOTH, so the two namespaces cannot collide.
 */
function rowKey(row: RosterRow): string {
  return row.session?.id ?? row.entry.path;
}

/**
 * What to call a row — the SAME rule for a live session and one that is not running.
 *
 * The first version read `entry.name` raw for a remembered row, which is how a scratch session came back after a
 * restart as `s2` instead of `Scratch session`, and how a placeholder value came back as the word itself. One
 * function decides, so the two paths cannot disagree.
 *
 * A remembered entry with no id of its own uses the file name, which is stable and at least identifies the row.
 */
function rowName(row: RosterRow): string {
  if (row.session !== undefined) return displayName(row.session);
  return nameLabel(row.entry.name, row.entry.scratch === true, filenameOf(row.entry.path));
}

/** The file's name without its extension, as a last-resort label. */
function filenameOf(path: string): string {
  const segment = path.split("/").filter((part) => part.length > 0).pop() ?? path;
  return segment.replace(/\.jsonl$/, "");
}

function RailRow({
  row,
  focused,
  onFocus,
  onForget,
  onRetry,
  home,
}: {
  row: RosterRow;
  focused: boolean;
  onFocus: () => void;
  onForget: () => void;
  onRetry: () => void;
  home: string | undefined;
}) {
  const session = row.session;
  const ask = session?.dialogs[0]?.message ?? session?.dialogs[0]?.title;
  // The activity column. For a row with no live session this is `stopped` — the same word `LiveState` already
  // uses, so a roster with sessions that are not running adds rows to an existing group and invents nothing.
  const activity = rowActivity(row);
  const where =
    row.entry.cwd === undefined ? "directory unknown" : shortenPath(row.entry.cwd, 34, home);

  return (
    /*
      A `<div>` wrapping two controls, not a `<button>`: the row is focusable AND dismissable, and nesting
      buttons is invalid HTML that browsers resolve by breaking the inner one.

      Forget appears only for a row that is NOT running (issue #89). Dismissing a row while its process runs
      would hide a live session from the rail while it kept working and spending — the roster is a view, but it
      must not be able to lie about what is happening.
    */
    <div className={`rail-row state-${activity}${focused ? " is-focused" : ""}`}>
      <button
        type="button"
        className="rail-row-main"
        aria-current={focused ? "true" : undefined}
        onClick={onFocus}
      >
      <span className="r1">
        <span className="name">{rowName(row)}</span>
        {session?.scratch && <span className="chip chip-scratch">scratch</span>}
        <span className={`chip chip-${activity}`}>
          {session === undefined ? "stopped" : stateLabel(session)}
        </span>
      </span>
      {/* The line carries the ask when one exists, because that is what the row is FOR then. */}
      {ask ? (
        <span className="r2 ask" title={ask}>
          ⚠ {ask}
        </span>
      ) : (
        <span className="r2" title={row.entry.cwd}>
          {session === undefined ? where : whereLine(session, home)}
        </span>
      )}
      {/*
        The metrics line exists only for a running session: a row with no live process has no model, no context
        percentage and no cost, and printing `0%` / `$0.00` for it would state facts nobody measured (the same
        rule as `contextPercent` returning null rather than a fabricated zero).
      */}
      {session !== undefined && (
        <>
          <span className="r3">
            <span>{formatModel(session.model)}</span>
            <span>{formatThinking(session.thinkingLevel)}</span>
            <span>{formatContext(session.contextPercent)}</span>
            <span>{formatCost(session.cost)}</span>
            {session.pending > 0 && <span>+{session.pending} queued</span>}
          </span>
          {session.warnings.length > 0 && (
            <span className="r3" style={{ color: "var(--warn-text)" }} title={session.warnings.join("\n")}>
              ⚠ {session.warnings[0]}
            </span>
          )}
        </>
      )}
      </button>
      {/*
        Retry appears only on a FAILED session, and only a failed one can be retried (#11). It is explicit —
        nothing restarts on its own — because a silent restart is how a crash loop hides itself.

        The previous failure is shown beneath it once a retry has happened: the second attempt clears `error`
        (the composer becomes usable again), and erasing the evidence would leave a reader unable to compare
        attempts.
      */}
      {session?.state === "failed" && (
        <span className="rail-row-actions">
          <button
            type="button"
            className="rail-row-retry"
            onClick={onRetry}
            title={session.error ?? "Try this session again in the same directory"}
          >
            Retry
          </button>
        </span>
      )}
      {/*
        The earlier failure, whenever there IS one — NOT only while the session is failed.

        The first version rendered this inside the failed-only block above, so it appeared exactly when it was
        redundant (the current `error` already says what went wrong) and disappeared exactly when it mattered
        (after a retry cleared `error`). A test for the acceptance criterion caught it.
      */}
      {session?.previousError !== undefined && (
        <span className="rail-row-earlier" title={session.previousError}>
          last failure: {session.previousError}
        </span>
      )}
      {session === undefined && (
        <button
          type="button"
          className="rail-row-forget"
          onClick={onForget}
          title="Remove from the rail. The session file is not deleted."
        >
          Forget
        </button>
      )}
    </div>
  );
}
