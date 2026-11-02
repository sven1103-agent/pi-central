/**
 * The focused session's compact header: identity, state, and the controls that change the session.
 *
 * ## What this replaces, and why it was three strips
 *
 * The workspace used to open with THREE full-width rows before the conversation started — a session header
 * (name, location, model pickers), a metrics strip (`ctx · tokens · cost · msgs`), and a legend promising what
 * the tool frames meant. Plus a `run-track` hairline between them, and the trace's own header below the
 * transcript. Each row was defensible alone; together they made the conversation look like a viewport squeezed
 * between control panels, and they gave secondary information the same structural weight as the task.
 *
 * The review's finding was specific: *"the workspace uses three different widths"* — narrow conversation, wide
 * composer, distant controls — which reads as components assembled rather than a composed workspace.
 *
 * So: one header, in three fixed groups — identity, the two numbers that change a decision, then configuration.
 *
 * The first attempt put telemetry behind a disclosure instead, and a screenshot showed what that costs: opening it
 * added a row that pushed the pickers onto two more lines and left the button stranded at the far right of a
 * four-row header (`img_23.png`). A disclosure that BREAKS the row it lives in is worse than the density it was
 * meant to relieve. So the stats are simply shown, and the lookups (tokens, messages) go where they already were:
 * the Session panel.
 *
 * ## What stays in the header, and why
 *
 * - **Name, state, location**: "which session am I in, is it doing anything, where does it work".
 * - **Model and thinking**: a session-level decision like rename or stop, and the value the reader is most
 *   likely to want to check while a run costs money. Both keep `ModelPicker`/`ThinkingPicker`, with their
 *   loading, error and next-turn semantics unchanged.
 * - **Context usage and cost**: the two numbers that change a decision, always visible. Context is a meter, amber
 *   past the threshold, with the words `ctx 84% full` beside it so nothing depends on colour. Tokens and message
 *   count are lookups and stay in the Session panel, which already listed them.
 *
 * One value, one format: everything goes through `format.ts`, the rule a real screenshot broke when the inspector
 * said `127.2M` and the strip said `12723914`.
 */
import type { LiveSession } from "@pi-central/protocol";
import { displayName, formatCost, headerLocation } from "../format.ts";
import { stateLabel } from "../store.ts";
import { InlineRename } from "./InlineRename.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ThinkingPicker } from "./ThinkingPicker.tsx";
import { ContextMeter } from "./ContextMeter.tsx";

export function SessionHeader({
  session,
  home,
  models,
  modelError,
  onRequestModels,
  onSelectModel,
  thinking,
  onRequestThinkingLevels,
  onSelectThinkingLevel,
  onRename,
  onNewInDirectory,
  busy = false,
  warnings = [],
}: {
  session: LiveSession;
  home: string | undefined;
  models: Parameters<typeof ModelPicker>[0]["models"];
  modelError: string | undefined;
  onRequestModels: () => void;
  onSelectModel: (provider: string, modelId: string) => void;
  thinking: { levels: string[] | undefined; error: string | undefined };
  onRequestThinkingLevels: () => void;
  onSelectThinkingLevel: (level: string) => void;
  onRename: (name: string) => void;
  /**
   * Start a NEW session in this session's directory (issue #149).
   *
   * Beside the location line, because that is the thing it acts on: the reader looking at
   * `~/git/project` is the reader who wants a second task in it. Absent for a scratch session, whose
   * directory is app-owned and per-session — offering it there would produce a session in the workspace of
   * a different one, which is not a project.
   */
  onNewInDirectory?: ((cwd: string) => void) | undefined;
  /**
   * Is a run in progress? The 2px progress rule lives here now.
   *
   * It used to be a `run-track` div between two full-width strips, which reserved height for a bar that is empty
   * most of the time. As part of the header's own edge it costs nothing when idle and belongs to the thing it
   * describes.
   */
  busy?: boolean;
  /** Session warnings. They belong with the identity they qualify, not on a row of their own above the transcript. */
  warnings?: readonly string[];
}) {
  return (
    <header className="session-header">
      {/* The run bar sits on the header's top edge, where "something is happening" is answered. */}
      <div className="run-track">{busy && <div className="run-bar" style={{ width: "100%" }} />}</div>
      <div className="title">
        <h2>
          {/*
            In its own element so it can truncate: a bare text node cannot carry `text-overflow`, and without it
            the name pushes the controls out of the header. Double-click renames (issues #78, #79).
          */}
          <InlineRename
            value={displayName(session)}
            label="Session name"
            className="session-name"
            onCommit={onRename}
          />
          {session.scratch && <span className="chip chip-scratch">scratch</span>}
          <span className={`chip chip-${session.state}`}>{stateLabel(session)}</span>
          {session.pending > 0 && <span className="chip chip-pending">+{session.pending} queued</span>}
        </h2>
        {/*
          The LOCATION line is gone from the header.
          
          It read `scratch · s1 · ~/.local/share/pi-central/workspaces/s1` — the same information the rail row
          carries, on a second line of the header, where it pushed the stats and the pickers into the same band.
          A reader who needs to know where a session works has the rail (which shows it per row) and the Session
          panel (which shows it in full, with a copy button for the path). Removing it buys the header a single row
          at every width, which is what let the meter and the cost sit on the same line as the name.
        */}
        {/*
          The LOCATION line, and the action that acts on it, in ONE row.

          `.title` is a flex COLUMN (name above location), so a button placed as its next child became a second
          full-width block underneath — reported from a screenshot as looking like a text field, and it pushed the
          meter and the cost down a line. So the path and the action share an inner flex row: the button belongs
          beside the thing it acts on, not below it.
        */}
        {session.scratch === false && session.cwd !== undefined && (
          <div className="where-row">
            {/* A PROJECT session keeps a shortened path, because "which of my directories is this" is not in the
                session's name and is genuinely ambiguous across rows. A scratch session's location is its id,
                which the rail already states as `scratch · s1`. */}
            <span className="where" title={session.cwd}>
              {headerLocation(session, home)}
            </span>
            {/*
              One click from the session you are in to a NEW task in the SAME directory (issue #149).

              Beside the path rather than in an overflow menu: many sessions per directory is the intended workflow
              (one task, one session), so the action is frequent, and hiding a frequent action behind a menu is how
              the retyping habit survived.

              It starts EMPTY. `fork`/`clone` is #12 and is the opposite action — it copies a transcript.
            */}
            {onNewInDirectory !== undefined && (
              <button
                type="button"
                className="btn btn-quiet new-in-dir"
                title={`Start a new session in ${session.cwd}`}
                /*
                 * The label is short on screen and complete for a screen reader.
                 *
                 * "New session here" is unambiguous next to a path and ambiguous out of context — and the button's
                 * accessible name has no path beside it. `aria-label` carries the directory so the control can be
                 * understood on its own, which is the same rule the rail's context meters follow.
                 */
                aria-label={`New session in ${session.cwd}`}
                onClick={() => onNewInDirectory(session.cwd)}
              >
                New session here
              </button>
            )}
          </div>
        )}
      </div>

      {/*
        THE TWO NUMBERS WORTH A PERMANENT PLACE.

        Context usage changes what a reader should do — near the limit the session is about to compact — and cost is
        what the run is spending. Both are always visible, on one line, with the meter turning amber past the
        threshold and the word `full` beside it so nothing depends on colour.

        What is NOT here: tokens and message count. They are lookups rather than decisions, and they are already in
        the Session panel, so a disclosure in the header was offering a second copy of a panel the reader has. That
        disclosure is what broke this row (`img_23.png`): it pushed the pickers onto two more lines and left its own
        button stranded at the far right of a four-row header.
      */}
      <div className="header-stats">
        <ContextMeter percent={session.contextPercent} />
        <span className="header-cost mono" title="Total cost reported for this session">
          {formatCost(session.cost)}
        </span>
      </div>

      {/*
        ONE block, two rows, one label column (issue #163): a `<label>` and a value of different widths cannot be
        aligned by eye, which is what put three left edges in a 120px space before.
      */}
      {warnings.length > 0 && (
        <div className="warnings" role="note">
          {warnings.map((warning, index) => (
            <span key={index}>⚠ {warning}</span>
          ))}
        </div>
      )}

      <div className="picker picker-grid">
        <ModelPicker
          session={session}
          models={models}
          error={modelError}
          onRequest={onRequestModels}
          onSelect={onSelectModel}
          thinking={
            // On the MODEL's row: the levels are per-model, so a change to one invalidates the other. The provider
            // is the only thing here that needs a line of its own, being a read-only fact.
            <ThinkingPicker
              session={session}
              levels={thinking.levels}
              error={thinking.error}
              onRequest={onRequestThinkingLevels}
              onSelect={onSelectThinkingLevel}
            />
          }
        />
      </div>
    </header>
  );
}
