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
import { displayName, formatContext, formatCost, formatModel, formatThinking, shortenPath, whereLine } from "../format.ts";
import type { RosterEntry } from "../roster.ts";
import { stateLabel } from "../store.ts";

const GROUPS = [
  { key: "needs", label: "Needs you", match: (s: LiveSession) => s.state === "awaiting-approval" },
  { key: "failed", label: "Failed", match: (s: LiveSession) => s.state === "failed" },
  { key: "running", label: "Running", match: (s: LiveSession) => s.state === "streaming" || s.state === "starting" },
  { key: "idle", label: "Idle", match: (s: LiveSession) => s.state === "idle" },
  { key: "stopped", label: "Stopped", match: (s: LiveSession) => s.state === "stopped" || s.state === "registered" },
] as const;

export function SessionRail({
  sessions,
  focusedId,
  onFocus,
  onStartSession,
  onOpenDirectory,
  home,
  historyTotal,
  restored,
  onResumeRestored,
  onForgetRestored,
}: {
  sessions: LiveSession[];
  focusedId: string | undefined;
  onFocus: (id: string) => void;
  onStartSession: () => void;
  onOpenDirectory: () => void;
  home: string | undefined;
  /** Total sessions on disk, which may exceed the number loaded. */
  historyTotal: number;
  /**
   * Sessions remembered from a previous run that are NOT running now (issue #89).
   *
   * Rendered as a separate, clearly-labelled group rather than merged into `sessions`, because the two mean
   * different things: `sessions` are processes this orchestrator is running and whose state it has observed,
   * while these are files it knows about and cannot observe. C3: "there is no daemon", so claiming one is
   * idle would be a guess presented as a fact.
   */
  restored: RosterEntry[];
  onResumeRestored: (entry: RosterEntry) => void;
  onForgetRestored: (entry: RosterEntry) => void;
}) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return sessions;
    return sessions.filter(
      (session) =>
        displayName(session).toLowerCase().includes(needle) ||
        session.cwd.toLowerCase().includes(needle) ||
        session.id.toLowerCase().includes(needle),
    );
  }, [sessions, filter]);

  const grouped = useMemo(
    () => GROUPS.map((group) => ({ ...group, items: filtered.filter(group.match) })).filter((g) => g.items.length > 0),
    [filtered],
  );

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
        {sessions.length === 0 ? (
          <p className="rail-empty">
            No live sessions. Start one with <kbd>⌘N</kbd>.
          </p>
        ) : grouped.length === 0 ? (
          <p className="rail-empty">No sessions match “{filter}”.</p>
        ) : (
          grouped.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <h3 className="group-header">
                <span>{group.label}</span>
                <span className="count">{group.items.length}</span>
              </h3>
              {group.items.map((session) => (
                <RailRow
                  key={session.id}
                  session={session}
                  focused={session.id === focusedId}
                  onFocus={() => onFocus(session.id)}
                  home={home}
                />
              ))}
            </section>
          ))
        )}

        {/*
          Restored rows, in their own group with their own heading (issue #89).

          They are drawn AFTER the live groups so a running session is never pushed down by remembered ones,
          and every row says `stopped` in words plus the Resume action — never a bare absence of state, which
          would read as "idle". C3 is the reason: this process did not spawn them and cannot observe them.
        */}
        {restored.length > 0 && (
          <section>
            <h3 className="rail-group">
              Remembered <span className="rail-group-count">{restored.length}</span>
            </h3>
            {restored.map((entry) => (
              <RestoredRow
                key={entry.path}
                entry={entry}
                home={home}
                onResume={() => onResumeRestored(entry)}
                onForget={() => onForgetRestored(entry)}
              />
            ))}
          </section>
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

/**
 * A session remembered from a previous run (issue #89).
 *
 * Deliberately NOT a `RailRow`: that renders a `LiveSession` and every one of its affordances assumes state
 * this process has observed. The honest row for "I know this file exists and it is not running" has two
 * actions, Resume and Forget, and no live chips at all.
 *
 * It is a `<div>` rather than a `<button>`, because it now contains two buttons and nesting them is invalid
 * HTML that browsers resolve by breaking the inner ones.
 */
function RestoredRow({
  entry,
  home,
  onResume,
  onForget,
}: {
  entry: RosterEntry;
  home: string | undefined;
  onResume: () => void;
  onForget: () => void;
}) {
  const label = entry.name ?? lastPathSegment(entry.path);
  const where = entry.cwd === undefined ? "directory unknown" : shortenPath(entry.cwd, 34, home);
  return (
    <div className="rail-row rail-row-restored">
      <span className="r1">
        <span className="name">{label}</span>
        {/* The word, not just an absent chip. "Not running" is the fact; a missing chip reads as unknown. */}
        <span className="chip chip-stopped">not running</span>
      </span>
      <span className="r2" title={entry.cwd}>
        {where}
      </span>
      <span className="r-restored-actions">
        <button type="button" className="btn btn-quiet" onClick={onResume}>
          Resume
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={onForget}
          title="Remove from the remembered list. The session file is not deleted."
        >
          Forget
        </button>
      </span>
    </div>
  );
}

/** The filename without its extension, as a last-resort label. Never the session id. */
function lastPathSegment(path: string): string {
  const segment = path.split("/").filter((part) => part.length > 0).pop() ?? path;
  return segment.replace(/\.jsonl$/, "");
}

function RailRow({
  session,
  focused,
  onFocus,
  home,
}: {
  session: LiveSession;
  focused: boolean;
  onFocus: () => void;
  home: string | undefined;
}) {
  const ask = session.dialogs[0]?.message ?? session.dialogs[0]?.title;
  return (
    <button
      type="button"
      className={`rail-row state-${session.state}`}
      aria-current={focused ? "true" : undefined}
      onClick={onFocus}
    >
      <span className="r1">
        <span className="name">{displayName(session)}</span>
        {session.scratch && <span className="chip chip-scratch">scratch</span>}
        <span className={`chip chip-${session.state}`}>{stateLabel(session)}</span>
      </span>
      {/* The line carries the ask when one exists, because that is what the row is FOR then. */}
      {ask ? (
        <span className="r2 ask" title={ask}>
          ⚠ {ask}
        </span>
      ) : (
        <span className="r2" title={session.cwd}>
          {whereLine(session, home)}
        </span>
      )}
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
    </button>
  );
}
