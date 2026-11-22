/**
 * The session rail.
 *
 * Ordered by ATTENTION, not by creation: a session blocked on a dialog is first because it
 * cannot progress without the user, while an idle one can wait. This differs from the
 * prototype, which stacked 40 dead history rows under the live ones — history lives in its own
 * pane with its own search, because two orderings in one scrolling column cannot both be
 * legible.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { isEditableTarget, matchesChord, nextRowKey, type TargetLike } from "../shortcuts.ts";
import type { LiveSession } from "@pi-central/protocol";
import { displayName, formatContext, isNearFull, nameLabel, shortenPath, whereLine } from "../format.ts";
import { stateLabel } from "../store.ts";
import { groupRows, isRunning, rosterLabel, rowActivity, type RosterRow } from "../roster.ts";
import { defaultRailPrefs, isFolded, showsRowMetrics, type RailPrefs } from "../rail-prefs.ts";
import { ContextBar } from "./ContextMeter.tsx";

/**
 * Section headings, in attention order.
 *
 * The CLASSIFICATION lives in `roster.ts#groupOf` so it is testable without a DOM and so "where does a row that
 * is not running go" has one answer; only the words a person reads are here.
 *
 * These sections are kept deliberately (#68, settled): *"i now see directly when sth has finished without
 * scrolling"*. A stable list with a state chip would show the same fact on a row the reader may not be looking at.
 *
 * ## Which of them may FOLD, and how #68 is paid for (issue #275)
 *
 * `idle` and `stopped` can be folded to their heading; the other three cannot, and that is a rule rather than a
 * default. A session blocked on a dialog cannot progress without the reader, and a session that is spending money
 * must stay on screen — the two conditions `roster.ts` and this component already treat as inviolable.
 *
 * #68 asked to SEE that something finished, not to see every finished row. Three things keep that property while a
 * section is folded, and each one is load-bearing:
 *
 *   1. **The heading carries the count**, and the heading is a state-coloured chip rather than a grey label.
 *   2. **A section that CHANGES while folded opens itself**, once — a session finishing is exactly the event the
 *      decision was made for, and a heading that quietly increments a number would be the reversal.
 *   3. **A fold is a reader choice**, remembered. Nothing folds on its own after the first render, so the rail never
 *      moves while it is being aimed at — the failure `roster.ts` records for row order.
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
  retryAvailable,
  onStartSession,
  onOpenDirectory,
  onSelectGroup,
  modalOpen = false,
  home,
  historyTotal,
  firstPromptFor,
  openAsDrawer = false,
  onCloseDrawer,
  prefs = defaultRailPrefs(),
  onToggleFolded,
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
  /**
   * Focus a row. A row that is not running focuses too, so the composer can send and resume on send.
   *
   * `viaKeyboard` says which surface asked, and the shell needs the difference (issue #275): a POINTER selection closes
   * a summoned rail, because the overlay would cover the conversation just chosen, while `⌥↑`/`⌥↓` must keep it open —
   * walking the list with the rail vanishing at every step would make the keys unusable, and summoning the rail for a
   * keystroke aimed at a list nobody can see would be worse.
   */
  onFocusRow: (row: RosterRow, viaKeyboard?: boolean) => void;
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
  /**
   * Select every row of a group, for one bulk delete.
   *
   * Only the `stopped` group offers this, and the constraint is not cosmetic: a RUNNING session cannot be deleted at
   * all — the orchestrator refuses, because the process holds the file open — so a group action over `Running` would
   * be a button whose only possible outcome is an error. `stopped` is exactly the set of rows where the operation is
   * legal, which is why the control lives on that heading and on no other.
   *
   * Absent means the affordance is not rendered: a shell that cannot delete does not offer a way to start deleting.
   */
  onSelectGroup?: ((rows: RosterRow[]) => void) | undefined;
  /**
   * A dialog is covering the app, so this surface must not act on the keyboard.
   *
   * `⌥↓` is a window listener — it has to be, or the key would only work while a row already had focus, which defeats
   * the point of a shortcut. But a window listener also fires while a confirmation or Settings is in front, and moving
   * the focus behind a dialog changes what its own buttons are about. The shell knows when a modal is open; the rail
   * cannot, so it is told.
   */
  modalOpen?: boolean;
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
  /**
   * The reader's rail preferences (issue #275): density and which sections are folded.
   *
   * Defaulted rather than required so the many tests that render this component without a shell stay valid — and so a
   * shell that has no preference store still gets a working rail rather than a component that must be configured
   * before it renders anything.
   */
  prefs?: RailPrefs;
  /**
   * Fold or unfold one section.
   *
   * Absent means the headings are not controls, which is the same rule every other capability in this rail follows:
   * a surface that cannot remember the choice does not offer it.
   */
  onToggleFolded?: ((group: "idle" | "stopped") => void) | undefined;
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

  /*
   * A folded section that CHANGES opens itself, once.
   *
   * This is how #68 survives folding: *"i now see directly when sth has finished without scrolling"* is a claim about
   * being told, and a heading whose number quietly went from 8 to 9 does not tell anyone. A session finishing while
   * `Stopped` is folded is precisely the event that decision was about, so the fold yields for it.
   *
   * The comparison is over row KEYS, not the count, and this is the whole subtlety: a roster where one session
   * finishes and another is dismissed in the same snapshot keeps the same count, so a count comparison would miss the
   * arrival. Keys are what the rows are keyed by anyway (`rowKey`), so nothing second is created.
   *
   * The ref starts empty, so the FIRST render after a load does not open everything: that would spend one render per
   * section and land the reader on the exact wall the fold existed to remove.
   */
  const prevKeys = useRef<Record<string, string[]> | undefined>(undefined);
  useEffect(() => {
    const previous = prevKeys.current;
    // The FIRST snapshot seeds the comparison and never opens anything: doing otherwise would unfold every section on
    // launch and hand the reader the exact wall the fold exists to remove.
    prevKeys.current = Object.fromEntries(sections.map((section) => [section.group, section.rows.map(rowKey)]));
    if (previous === undefined) return;

    let opened: "idle" | "stopped" | undefined;
    for (const section of sections) {
      if (opened !== undefined) break;
      if (!isFolded(prefs, section.group)) continue;
      /*
       * A section that was not in the previous snapshot is ALL arrivals — and that is the ordinary case for the one
       * event #68 is about: a session finishes, and `Stopped` appears where the group was empty before (`groupRows`
       * filters empty sections out). Treating "absent before" as "no arrival" missed exactly the case the fold has to
       * keep visible.
       */
      const was = previous[section.group] ?? [];
      if (!section.rows.some((row) => !was.includes(rowKey(row)))) continue;
      opened = section.group as "idle" | "stopped";
    }
    // Already unfolded by the reader in the same commit: nothing to do, and calling it would write a preference the
    // reader did not ask for.
    if (opened !== undefined) onToggleFolded?.(opened);
  }, [sections, prefs, onToggleFolded]);

  /*
   * `⌥↑` / `⌥↓` move the focus one row, in the order the reader SEES.
   *
   * Owned by the rail, not by the shell, and the registry says so (`shell: false`): the rendered order depends on the
   * filter and on the attention grouping, both of which are this component's. The shell could not compute "next" without
   * duplicating `groupRows` and the filter — and a second definition of the visible order is how the keys and the list
   * come to disagree.
   *
   * `preventDefault` so the keystroke does not also scroll the list, which would move the reader's place in one
   * direction while focus moved in the other.
   */
  useEffect(() => {
    if (modalOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      /*
       * `matchesChord` rather than `chordOf(event) === "alt+arrowdown"`: the arrow keys are named, so a layout never
       * forces Shift onto them, but keeping one predicate for "did this keystroke mean this chord" is what stops the
       * next layout-dependent key from being added here as a raw comparison and quietly failing.
       */
      const nextRow = matchesChord(event, "alt+arrowdown");
      if (!nextRow && !matchesChord(event, "alt+arrowup")) return;
      // A surface that already claimed the key, or a field the reader is typing in, keeps it.
      if (event.defaultPrevented || isEditableTarget(event.target as TargetLike | null)) return;
      const keys = sections.flatMap((section) => section.rows.map(rowKey));
      const next = nextRowKey(keys, focusedId, nextRow ? 1 : -1);
      if (next === undefined) return;
      const row = sections.flatMap((section) => section.rows).find((candidate) => rowKey(candidate) === next);
      if (row === undefined) return;
      event.preventDefault();
      onFocusRow(row, true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sections, focusedId, onFocusRow, modalOpen]);

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
          sections.map((section) => {
            const folded = isFolded(prefs, section.group);
            /* Which of this section's controls exist. The types are the rule: only these two keys are foldable. */
            const foldable = (section.group === "idle" || section.group === "stopped") && onToggleFolded !== undefined;
            return (
            <section key={section.group} aria-label={labelOf(section.group)}>
              {/*
                Heading order, left to right: the fold mark (Idle/Stopped), the group's word — or, for Stopped with a
                delete capability, the *bulk-selection control* that has carried that word since issue #253 — the count,
                the rule, and a "folded" pill for a section whose rows are hidden.

                One word per heading, always. The earlier attempt put the word inside the fold button as well, which read
                well for `Idle` and produced two controls both called "Stopped" in the one heading that also selects rows:
                a reader would have had to tell apart two identically named buttons that do different things.

                AND THE WHOLE HEADING FOLDS IT. Reported from a screenshot: the mark is "way too small, users can barely
                see it", and aiming for it is a precision task on a row where everything else is a wide target. So the
                heading itself is the button for a foldable section, and the two controls inside it keep their own jobs:
                a press that lands on either one is theirs alone, checked on the event rather than by stopping
                propagation in four handlers. The mark remains, and remains a BUTTON: it is what says the section can
                fold, and it is the keyboard stop and the accessible name for the action — an `h3` with a click handler
                is a pointer convenience and not a control, so nothing is reachable only through it.
              */}
              <h3
                className={`group-header${folded ? " is-folded" : ""}${foldable ? " is-foldable" : ""}`}
                onClick={
                  foldable
                    ? (event) => {
                        // A press on the mark or on the bulk selection is that control's press. Without this the mark
                        // would toggle twice (its own handler, then the bubble), which reads as "nothing happened".
                        if ((event.target as HTMLElement).closest("button") !== null) return;
                        onToggleFolded?.(section.group as "idle" | "stopped");
                      }
                    : undefined
                }
              >
                {/*
                  THE DISCLOSURE MARK, and only the mark.

                  The first version put the group's word inside this button, which read well for `Idle` and produced two
                  controls both called "Stopped" in the one heading that also offers the bulk selection — a reader would
                  have had to choose between two identically named buttons that do different things. The word stays with
                  the selection control it has always belonged to, and the mark carries the fold with `aria-label` and
                  `title` saying exactly what it does and how many rows it affects.

                  `▸`/`▾` rather than a chevron from the Technical block: `⌫` from that block rendered as an empty box on
                  this machine (`SessionControlBar` records the measurement), and a tofu square where the only affordance
                  is would read as a broken control.

                  The mark is `aria-hidden` inside a button that names the action, which is why enlarging it costs
                  nothing in speech: it is a picture of "this folds", not a second label.
                */}
                {foldable && (
                  <button
                    type="button"
                    className="group-fold"
                    aria-expanded={!folded}
                    aria-label={`${folded ? "Show" : "Hide"} ${section.rows.length} ${labelOf(section.group).toLowerCase()} session${section.rows.length === 1 ? "" : "s"}`}
                    /* The action and the count, where a hovering reader reads it — the rule `PanelToggle` records. */
                    title={`${folded ? "Show" : "Hide"} ${section.rows.length} ${labelOf(section.group).toLowerCase()} session${section.rows.length === 1 ? "" : "s"}`}
                    onClick={() => onToggleFolded(section.group as "idle" | "stopped")}
                  >
                    <span className="group-fold-mark" aria-hidden="true">{folded ? "▸" : "▾"}</span>
                  </button>
                )}
                {section.group === "stopped" && onSelectGroup !== undefined ? (
                  <button
                    type="button"
                    className="group-select"
                    title={`Select all ${section.rows.length} stopped session${section.rows.length === 1 ? "" : "s"} in the list, then delete them in one confirmation`}
                    onClick={() => onSelectGroup(section.rows)}
                  >
                    {labelOf(section.group)}
                  </button>
                ) : (
                  <span>{labelOf(section.group)}</span>
                )}
                <span className="count">{section.rows.length}</span>
                {folded && <span className="group-fold-note">folded</span>}
              </h3>
              {!folded && section.rows.map((row) => (
                <RailRow
                  key={rowKey(row)}
                  row={row}
                  focused={rowKey(row) === focusedId}
                  onFocus={() => onFocusRow(row)}
                  onForget={() => onForgetRow(row)}
                  onRetry={() => onRetryRow(row)}
                  retryAvailable={retryAvailable}
                  home={home}
                  firstPromptFor={firstPromptFor}
                  prefs={prefs}
                />
              ))}
            </section>
            );
          })
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
  prefs,
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
  /** The reader's density (issue #275): `calm` drops the metrics line where it says nothing. */
  prefs: RailPrefs;
}) {
  const session = row.session;
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
    <div className={`rail-row state-${activity}${focused ? " is-focused" : ""}${prefs.density === "calm" ? " is-calm" : ""}`}>
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
      {/*
        The metrics line, only when it can change a decision (issue #275).

        `showsRowMetrics` owns the rule; the short version is that `calm` keeps pressure, queued work and failure, and
        drops the rows whose answer is "nothing to do here". In `full` density it is always true, so this is a no-op
        for a reader who never opens Settings.
      */}
      {session !== undefined && showsRowMetrics(prefs.density, session) && (
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
            <span className="r3 r-warn" style={{ color: "var(--warn-text)" }} title={session.warnings.join("\n")}>
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
