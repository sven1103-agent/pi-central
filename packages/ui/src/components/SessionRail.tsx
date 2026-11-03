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
import { displayName, formatContext, isNearFull, nameLabel, shortenPath, whereLine } from "../format.ts";
import { stateLabel } from "../store.ts";
import { groupRows, isRunning, rosterLabel, rowActivity, type RosterRow } from "../roster.ts";
import { ContextBar } from "./ContextMeter.tsx";
import { RowActionsMenu, type RowActionItem } from "./RowActionsMenu.tsx";

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
  onDeleteRow,
  onStopRow,
  onResumeRow,
  onRetryRow,
  retryAvailable,
  onStartSession,
  onOpenDirectory,
  home,
  historyTotal,
  firstPromptFor,
  openAsDrawer = false,
  onCloseDrawer,
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
   * Delete a STOPPED session's transcript from disk (issue #150).
   *
   * Distinct from `onForgetRow` next to it, and the two are deliberately side by side: `Forget` hides a row and
   * deletes nothing, `Delete` removes bytes and cannot be undone. The rail's own comment on `onForgetRow` promised
   * "deleting is #150 … a different action with its own confirmation", and this is that action.
   *
   * Absent means the affordance is not rendered — so a UI connected to an orchestrator that predates the control does
   * not offer a button that would fail.
   */
  onDeleteRow?: ((row: RosterRow) => void) | undefined;
  /**
   * Stop a RUNNING session from its row (issue #150 follow-up).
   *
   * Added because a refusal sent the reader here and there was nothing to press. Deleting a transcript that a running
   * session holds open is refused, and the refusal says "stop that session first" — but Stop existed only in the
   * Session panel, for the FOCUSED session. So a reader with ten sessions had to find the right one, focus it, open the
   * panel, and stop it from there, to clear a warning that named a handle they could not see.
   *
   * The rail is the list of sessions; stopping one belongs in it.
   */
  onStopRow?: ((row: RosterRow) => void) | undefined;
  /**
   * Start a STOPPED session again from its row (reported from use).
   *
   * Stopping was a one-way door: the row kept its session object (`stopped` is a state, not an absence), so the
   * controls that were gated on `session === undefined` disappeared — no Resume, no Forget, no Delete. The rail could
   * stop a session and then had no way to bring it back.
   */
  onResumeRow?: ((row: RosterRow) => void) | undefined;
  /**
   * Retry a FAILED session (issue #11).
   *
   * The affordance `DESIGN.md` promised and never had: its composer text says "Retry it from the rail", and
   * the rail had no such control.
   */
  onRetryRow: (row: RosterRow) => void;
  /**
   * Whether the CONNECTED orchestrator understands `retry` (issue #11).
   *
   * False when the two halves are on different protocol versions — which happens in a checkout without any
   * mistake: the UI is served as files, so `npm run ui:build` reaches a running orchestrator at once, while
   * the orchestrator's own module stays in memory from when it started. Offering Retry then produces
   * `bad control: unknown kind 'retry'` — a symptom, not a reason. So the control is not offered, and the row
   * says what to do instead.
   */
  retryAvailable: boolean;
  onStartSession: () => void;
  onOpenDirectory: () => void;
  home: string | undefined;
  /** Total sessions on disk, which may exceed the number loaded. */
  historyTotal: number;
  /**
   * The first thing the reader asked a session, for its label when nobody named it (`titleFromPrompt`).
   *
   * A RESOLVER rather than an array: the rail is given rows, and a row already identifies its session. Passing the
   * history page would put a second, differently-shaped copy of the same data in this component's props.
   */
  firstPromptFor?: ((row: RosterRow) => string | undefined) | undefined;
  /**
   * Whether the rail is showing as an overlay drawer.
   *
   * Below the drawer breakpoint the columns cannot all fit, so the rail leaves the grid. The state lives in `App`
   * because the BUTTON that toggles it is in the topbar — a control inside the thing it opens would be unreachable
   * exactly when the thing is closed.
   */
  openAsDrawer?: boolean;
  /** Close the drawer. Called after choosing a session, so a selection does not leave the overlay covering it. */
  onCloseDrawer?: (() => void) | undefined;
}) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return rows;
    return rows.filter((row) => {
      const name = rowName(row, firstPromptFor?.(row)).toLowerCase();
      const cwd = (row.entry.cwd ?? "").toLowerCase();
      const id = row.session?.id.toLowerCase() ?? "";
      return name.includes(needle) || cwd.includes(needle) || id.includes(needle);
    });
  }, [rows, filter]);

  const sections = useMemo(() => groupRows(filtered), [filtered]);

  return (
    <nav
      id="session-rail"
      className={`rail${openAsDrawer ? " open" : ""}`}
      aria-label="Sessions"
    >
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
                  onDelete={onDeleteRow === undefined ? undefined : () => onDeleteRow(row)}
                  onStop={onStopRow === undefined ? undefined : () => onStopRow(row)}
                  onResume={onResumeRow === undefined ? undefined : () => onResumeRow(row)}
                  onRetry={() => onRetryRow(row)}
                  retryAvailable={retryAvailable}
                  home={home}
                  firstPromptFor={firstPromptFor}
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

/**
 * The states in which a session can be STOPPED.
 *
 * An allow-list, because the negative form is wrong in a way that shipped for one commit: a row with no live session
 * has no `state` at all, and `state !== "stopped" && state !== "failed"` is TRUE for `undefined` — so every stopped row
 * grew a Stop button that could not act.
 */
const RAIL_STOPPABLE: ReadonlySet<string> = new Set(["starting", "idle", "streaming", "awaiting-approval"]);

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
/**
 * A row's label.
 *
 * `firstPrompt` is what makes an unnamed session recognisable instead of an opaque handle — see
 * `titleFromPrompt`. The two sources are deliberately different:
 *
 *   - a LIVE session takes the prompt from its transcript, because a session started a moment ago has its question
 *     in memory and no file worth re-reading yet;
 *   - a row with no process takes it from the roster entry's stored `firstMessage`, which is already the first line
 *     of the persisted conversation.
 *
 * A `firstMessage` recorded in the roster is preferred over one passed in, since the entry is what survives a
 * restart and the two must not disagree about the same session.
 */
function rowName(row: RosterRow, firstPrompt?: string | undefined): string {
  if (row.session !== undefined) return displayName(row.session, firstPrompt);
  /*
   * A row with no process goes through `rosterLabel`, NOT `nameLabel`.
   *
   * The difference is the whole of the reported deadlock: `rosterEntryFor` persisted the old directory-derived name,
   * so several distinct sessions in one project rendered as several rows called `data-manager`, each with the same
   * cwd line. `rosterLabel` treats a name equal to the directory's basename as the placeholder it is, and falls back
   * to the first prompt — or, before History has loaded it, to a short form of the session's own file name.
   */
  return rosterLabel(row.entry, firstPrompt);
}

/**
 * What a row offers, as a list rather than as markup.
 *
 * Pure and exported, because *which* actions a row has is the part with rules: a running session offers Stop and
 * nothing destructive; a stopped one offers Resume, Forget and Delete; a failed one offers Retry plus the
 * housekeeping. Asserting that on a list is clearer than five string matches against rendered HTML, and it is where
 * the `isRunning` distinction lives.
 *
 * ORDER: the action that continues work first, the irreversible one last. A destructive item should never be the
 * first thing under the pointer when a menu opens.
 */
export function rowActionsFor(
  row: RosterRow,
  caps: {
    onResume?: (() => void) | undefined;
    onForget: () => void;
    onDelete?: (() => void) | undefined;
    onStop?: (() => void) | undefined;
    onRetry: () => void;
    retryAvailable: boolean;
  },
): RowActionItem[] {
  const session = row.session;
  const items: RowActionItem[] = [];

  if (session?.state === "failed") {
    if (caps.retryAvailable) {
      items.push({
        key: "retry",
        label: "Retry",
        title: "Try this session again in the same directory",
        onSelect: caps.onRetry,
        className: "rail-row-retry",
      });
    } else {
      /*
       * The control is withheld rather than shown-and-broken, and the REASON is stated in the place the reader is
       * looking for it. A disabled button alone would still be a promise.
       */
      items.push({
        key: "retry-unavailable",
        label: "Retry unavailable",
        title: "Restart the orchestrator to retry: it speaks an older protocol",
        onSelect: () => {},
        disabled: true,
        className: "rail-row-retry-unavailable",
      });
    }
    // A failed session is not running, so it can also be dismissed or deleted.
    items.push({ key: "forget", label: "Forget", title: FORGET_TITLE, onSelect: caps.onForget, className: "rail-row-forget" });
    if (caps.onDelete !== undefined) {
      items.push({ key: "delete", label: "Delete", title: DELETE_TITLE, onSelect: caps.onDelete, className: "rail-row-delete" });
    }
    return items;
  }

  if (isRunning(session)) {
    // Nothing destructive while a process holds the transcript open; and resuming a running session is not a thing.
    if (caps.onStop !== undefined && session !== undefined && RAIL_STOPPABLE.has(session.state)) {
      items.push({
        key: "stop",
        label: "Stop",
        title: "Stop this session. Its transcript stays on disk.",
        onSelect: caps.onStop,
        className: "rail-row-stop",
      });
    }
    return items;
  }

  // Not running: the whole housekeeping set, Resume first.
  if (caps.onResume !== undefined) {
    items.push({
      key: "resume",
      label: "Resume",
      title: "Start this session again in the same directory. Its transcript continues.",
      onSelect: caps.onResume,
      className: "rail-row-resume",
    });
  }
  items.push({ key: "forget", label: "Forget", title: FORGET_TITLE, onSelect: caps.onForget, className: "rail-row-forget" });
  if (caps.onDelete !== undefined) {
    items.push({ key: "delete", label: "Delete", title: DELETE_TITLE, onSelect: caps.onDelete, className: "rail-row-delete" });
  }
  return items;
}

/** The two housekeeping titles, in one place: their difference IS the point, so they are read side by side. */
const FORGET_TITLE = "Remove from the rail. The session file is not deleted.";
const DELETE_TITLE = "Delete this session's transcript from disk. This cannot be undone.";

/**
 * A row's label, exported so the DELETE dialog can name the same session the row named.
 *
 * One rule: a dialog asking "delete this session?" about a row that said something else is exactly the ambiguity a
 * destructive confirmation cannot afford. `firstPrompt` is forwarded for the same reason — the row may be labelled
 * by its prompt, and the dialog must say the same thing.
 */
export function rowLabel(row: RosterRow, firstPrompt?: string | undefined): string {
  return rowName(row, firstPrompt);
}

/** The first line of a message — the reason, as opposed to everything the process printed. */
function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}


function RailRow({
  firstPromptFor,
  row,
  focused,
  onFocus,
  onForget,
  onDelete,
  onStop,
  onResume,
  onRetry,
  retryAvailable,
  home,
}: {
  row: RosterRow;
  focused: boolean;
  onFocus: () => void;
  onForget: () => void;
  /** Absent when the connected orchestrator cannot delete sessions (older protocol). */
  onDelete?: (() => void) | undefined;
  /** Stop this session. Offered for a RUNNING row, which is the only kind it can act on. */
  onStop?: (() => void) | undefined;
  /** Start this session again. Offered for a row that is NOT running. */
  onResume?: (() => void) | undefined;
  onRetry: () => void;
  retryAvailable: boolean;
  home: string | undefined;
  firstPromptFor?: ((row: RosterRow) => string | undefined) | undefined;
}) {
  const session = row.session;
  /*
   * What this row offers, in one place. Pure and exported, so the rules about WHICH actions exist are asserted on a
   * list rather than on five string matches against rendered HTML.
   */
  const rowActions = rowActionsFor(row, {
    ...(onResume === undefined ? {} : { onResume }),
    onForget,
    ...(onDelete === undefined ? {} : { onDelete }),
    ...(onStop === undefined ? {} : { onStop }),
    onRetry,
    retryAvailable,
  });
  /*
   * NO RENAME HERE, deliberately.
   *
   * The rail is for SELECTING a session; renaming belongs to the session you are looking at. Reported from use:
   * *"users can now also rename a session from the left session roster. The mouse changes on mouse over of the small
   * card session title, which i find weird. Maybe just use the roster for selection of a session, and leave the
   * renaming to the active session rail."*
   *
   * That is also the more honest split: a rail row is a small target whose job is navigation, and an edit target
   * inside it competes with the row's own click. The header has room to show the name at full size, which is where
   * an inline edit belongs.
   */
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
    /*
      `has-actions` reserves room for the `⋯` trigger, so it never sits on top of the row's own text.
      The trigger floats at the row's trailing edge; without the reservation its 22px landed over the ctx gauge and the
      cost on the third line — visible in a screenshot as the button covering the numbers it was next to.
    */
    <div
      className={`rail-row state-${activity}${focused ? " is-focused" : ""}${rowActions.length > 0 ? " has-actions" : ""}`}
    >
      <button
        type="button"
        className="rail-row-main"
        aria-current={focused ? "true" : undefined}
        onClick={onFocus}
      >
      <span className="r1">
        <span className="name">{rowName(row, firstPromptFor?.(row))}</span>
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
        The third line keeps only what changes the DECISION about this row, and drops the rest.
        
        It used to carry `model · thinking · ctx · cost` on every session — four values that the workspace header
        already states for the session you are actually looking at, repeated for every row in the rail. A review
        found that dense without making selection clearer, and it is the reason the rail read as a wall of small
        grey numbers.
        
        What stays is what a row is FOR in a list of sessions: pressure (a context that is nearly full will need
        compaction), work waiting to run (`+N queued`), and the failure/warning text below. Model, thinking level
        and cost are still one click away in the header and the Session panel, where they can be read at a size
        that is legible.
        
        Nothing here is invented for a session with no live process: `formatContext(null)` renders `ctx —`, and a
        row with no process shows no metrics line at all, which is the same rule as `contextPercent` returning
        null rather than a fabricated zero.
      */}
      {session !== undefined && (
        <>
          <span className="r3">
            {/*
              The bar, before the metrics line, because it is read at a glance and the line is read on purpose.
              `ContextBar` renders nothing when the percentage is unknown, so the row cannot show a fabricated 0%.

              The percentage stays in the label beside it: a bar alone cannot say 84, and this row is where a reader
              decides whether to compact. The formatter is the same one the header uses, so the word `full` and the
              amber fill turn at the same threshold.
            */}
            <ContextBar percent={session.contextPercent} label={rowName(row, firstPromptFor?.(row))} />
            <span className={isNearFull(session.contextPercent) ? "warn" : ""}>
              {formatContext(session.contextPercent)}
            </span>
            {session.pending > 0 && <span>+{session.pending} queued</span>}
            {session.state === "failed" && session.error !== undefined && <span>failed</span>}
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
      {/*
        Stop, on any RUNNING row (issue #150 follow-up).

        Before this the rail had no way to stop a session at all — it lived in the Session panel, for the focused
        session only — so a reader told to "stop that session first" had to find the right row, focus it, and open a
        panel. The rail is the list of sessions; stopping one belongs in it.

        Not offered for `stopped` or `failed`: there is nothing to stop, and a control that cannot act is worse than
        none. `onStop` absent means the affordance is not rendered at all, so a connected orchestrator that predates
        the control does not offer a button that would fail.
      */}
      {/*
        An ALLOW-LIST of stoppable states, not `state !== "stopped" && state !== "failed"`.

        The difference is defence in depth rather than a live bug: `session !== undefined` above already excludes the
        row with no state at all, so both forms behave identically for every row that reaches here. The allow-list is
        still the right shape, because the negative form is only correct while that earlier guard exists — and the
        earlier guard was added for a different reason, so a future change could drop it without noticing that a Stop
        button now appears on every stopped row.

        Stated plainly because I could not falsify the allow-list on its own: reverting it changes nothing, which is
        what "defence in depth" means and also what a test that cannot fail looks like. The behaviour it guards is
        asserted (`Stop is not offered where it cannot act`); the guard itself is belt and braces.
      */}
      {/*
        EVERY action for this row, behind one `⋯` button.

        They were three separate strips: Stop pinned to the corner, Retry under a failed row, and Resume/Forget/Delete
        in an absolutely-positioned cluster. In a 288px column the cluster overlapped the row's own text and spilled
        past its edge, so the controls could not be clicked at all — reported as *"noboday can hit the right controls in
        the stopped session card ;) why not a menu icon (vertical ellipsis) with a submenue for the actions?"*

        A menu also stops the row growing with each new action, which is what happened when Stop became the fourth.
        `DESIGN.md` §712 had already specified this button.
      */}
      <RowActionsMenu label={rowName(row, firstPromptFor?.(row))} items={rowActions} />
      {/*
        The earlier failure, whenever there IS one — NOT only while the session is failed.

        The first version rendered this inside the failed-only block above, so it appeared exactly when it was
        redundant (the current `error` already says what went wrong) and disappeared exactly when it mattered
        (after a retry cleared `error`). A test for the acceptance criterion caught it.
      */}
      {session?.previousError !== undefined && (
        /*
          One line, and no `title`. The stored value is the whole stderr, and a rail row is not the place for
          it: `title` would surface all of it on hover, which is exactly what hovering a row should not do.
          `firstLine` is the same rule the error strip follows, so the two agree about what "the reason" is.
        */
        <span className="rail-row-earlier">last failure: {firstLine(session.previousError)}</span>
      )}
    </div>
  );
}
