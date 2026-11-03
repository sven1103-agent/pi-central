/**
 * A stopped session, selected from the rail (issue #89 deadlock, reported as prio A).
 *
 * ## The dead end this replaces
 *
 * Clicking a row with no live session set `focusedId` to a roster **path**, and the shell resolved that with
 * `focusedSession`, which searches only `state.live` — so it found nothing and the main column fell through to "No
 * session selected". There was then no control anywhere to start that session again: `queuePrompt`/`pendingPrompt`
 * existed in the store and were dispatched by nothing, so the "resume-on-send" #89 describes was never wired.
 *
 * Reported from use as: *"i could not recover a session … That leaves user in a deadlock to select the right
 * session."* Two problems, and this is the first: the click led nowhere at all.
 *
 * ## Why an explicit Resume button rather than the composed message
 *
 * #89's design is that the composer doubles as the resume trigger, which is elegant but needs a parked prompt to
 * survive the spawn — a mechanism that does not exist yet. An explicit button is the smallest correct thing: it does
 * exactly one thing, it says what it does, and it cannot silently drop a typed message the way a half-wired
 * resume-on-send could. When the composer path lands, this stays useful as the plain "start this again" action.
 *
 * ## What it shows, and why each line is there
 *
 *   - the label, from the same `rosterLabel` the rail used, so the view cannot name a different session than the row
 *     that was clicked;
 *   - the **full path** of the transcript, because a label may legitimately repeat across sessions and the path is
 *     the identity (ADR-0004);
 *   - the directory, message count and size — the facts that let a reader confirm "this is the one I meant" before
 *     spawning anything.
 */
import type { HistoricalSession } from "@pi-central/protocol";
import type { RosterRow } from "../roster.ts";
import { rosterLabel } from "../roster.ts";
import { formatBytes } from "../format.ts";

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
  /** Present only when the orchestrator can delete; the row's own control is the single delete path. */
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
    <div className="empty stopped-session">
      <h2>{label}</h2>
      <p className="mono stopped-path" title={row.entry.path}>
        {row.entry.path}
      </p>

      <dl className="stopped-facts">
        <dt>Directory</dt>
        <dd className="mono">{cwd === undefined ? "not recorded" : cwd}</dd>
        {history !== undefined && (
          <>
            <dt>Last used</dt>
            <dd>
              {new Date(history.modifiedMs).toISOString().slice(0, 16).replace("T", " ")} ·{" "}
              {history.messageCount} message{history.messageCount === 1 ? "" : "s"} ·{" "}
              {formatBytes(history.bytes)}
            </dd>
          </>
        )}
      </dl>

      {gone ? (
        <p className="stopped-blocked" role="alert">
          <strong>This session's directory is gone</strong>
          <span className="mono">{history.cwd}</span>
          {/* The same advice the History refusal gives, so the two surfaces do not describe one fact differently. */}
          Restore it, or start a new session where the work belongs. Pi Central does not move a session between
          directories.
        </p>
      ) : (
        <p>
          This session is <strong>stopped</strong> — its transcript is on disk and nothing is running. Starting it
          again continues the same conversation, in the same directory.
        </p>
      )}

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
            className="btn btn-quiet stopped-delete"
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
