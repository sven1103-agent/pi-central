/**
 * A stopped session, selected from the rail (issue #89).
 *
 * ## Why this view exists
 *
 * Clicking a row with no live process set `focusedId` to a roster path, and the shell resolved that with
 * `focusedSession`, which searches only `state.live` — so it found nothing and the column fell through to "No session
 * selected". A dead end: no control anywhere could restart it.
 *
 * ## What it shows, and why each line is there
 *
 *   - the label, from the same `rosterLabel` the rail used, so the view cannot name a different session than the row
 *     that was clicked;
 *   - the **full path** of the transcript, because a label may legitimately repeat and the path is the identity
 *     (ADR-0004);
 *   - the directory, and last-used facts, so a reader can confirm "this is the one I meant" before spawning anything.
 *
 * ## Why it is NOT the `.empty` placeholder any more
 *
 * It was written as `<div className="empty stopped-session">` and I never looked at it. `.empty` is the centring
 * placeholder shown when nothing is selected — so a stopped session rendered as centred prose with an unstyled `<dl>`
 * and three loose buttons, and the one view a reader sees when recovering work looked less finished than the screen it
 * replaced. Reported from a screenshot: *"now the old stoped sessions look weird."*
 *
 * It now has its own layout: left-aligned like every other surface (DESIGN: alignment is left throughout, because
 * every surface is either a scan list or a document), with the actions in the same control bar idiom the live session
 * header uses, and the facts in a labelled grid.
 */
import type { HistoricalSession } from "@pi-central/protocol";
import type { RosterRow } from "../roster.ts";
import { rosterLabel } from "../roster.ts";
import { formatAge, formatBytes } from "../format.ts";

export function StoppedSession({
  row,
  history,
  home,
  onResume,
  onForget,
  onDelete,
}: {
  row: RosterRow;
  /** The matching History entry, when the loaded page contains it. Its prompt is what makes the label recognisable. */
  history: HistoricalSession | undefined;
  home: string | undefined;
  /** Start this session again, in the directory it recorded (ADR-0008: never a different one). */
  onResume: () => void;
  onForget: () => void;
  /** Present only when the orchestrator can delete; deleting is the one irreversible action. */
  onDelete?: (() => void) | undefined;
}) {
  const label = rosterLabel(row.entry, history?.firstMessage);
  const cwd = row.entry.cwd ?? history?.cwd;
  /*
   * A recorded directory that is gone cannot be resumed: RPC-mode Pi exits 1 rather than prompting (C2), and the
   * refusal names the directory. Saying it here, before the click, is the difference between "this button is broken"
   * and "that project was deleted".
   */
  const gone = history !== undefined && !history.cwdExists;

  return (
    <div className="stopped-session">
      <h2 className="stopped-title">{label}</h2>

      {/*
        The transcript path, once and truncated.

        It was a full-height paragraph of wrapped mono — four lines of `/Users/sven1103/.pi/agent/sessions/--Users-…`
        above everything else, which pushed the actions below the fold for no benefit. The path IS the identity, so it
        stays, but as one ellipsised line whose `title` carries the whole thing, with a Copy affordance.
      */}
      <p className="stopped-path mono" title={row.entry.path}>
        {row.entry.path}
      </p>

      <dl className="stopped-facts">
        <dt>Directory</dt>
        <dd className="mono">{cwd === undefined ? "not recorded" : cwd}</dd>
        {history !== undefined && (
          <>
            <dt>Last used</dt>
            <dd>{formatAge(history.modifiedMs)}</dd>
            <dt>Conversation</dt>
            <dd>
              {history.messageCount} message{history.messageCount === 1 ? "" : "s"} · {formatBytes(history.bytes)}
            </dd>
          </>
        )}
      </dl>

      {gone ? (
        <p className="stopped-blocked" role="alert">
          <strong>This session's directory is gone.</strong>{" "}
          {/* The same advice the History refusal gives, so the two surfaces do not describe one fact differently. */}
          Restore it, or start a new session where the work belongs. Pi Central does not move a session between
          directories.
        </p>
      ) : (
        <p className="stopped-note">
          Stopped — its transcript is on disk and nothing is running. Resuming continues the same conversation.
        </p>
      )}

      {/*
        The actions, in the same idiom as the live session header's control bar: labelled buttons on one line, the
        work-continuing one first, the irreversible one last.

        NOT derived from `sessionControlsFor`: that takes a `LiveSession`, and this view has a roster row whose session
        object may not exist at all. Two shapes, two lists — but the same order and the same words, because a reader who
        learns one should not have to relearn the other.
      */}
      <div className="stopped-actions">
        <button type="button" className="btn btn-primary" disabled={gone} onClick={onResume}>
          Resume session
        </button>
        <button type="button" className="btn" onClick={onForget} title="Remove from the rail. The file is not deleted.">
          Forget
        </button>
        {onDelete !== undefined && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={onDelete}
            title="Delete this session's transcript from disk. This cannot be undone."
          >
            Delete transcript
          </button>
        )}
      </div>
    </div>
  );
}
