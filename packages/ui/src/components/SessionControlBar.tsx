/**
 * The session's control bar, on the header row above the transcript.
 *
 * ## Where this belongs, and the two places it does not
 *
 * Three attempts, and each failure named the next location:
 *
 *   1. **Inline buttons on the rail row** — Resume/Forget/Delete pinned to a 288px row's corner. They overlapped the
 *      row's own text, spilled past its edge, and could not be clicked: *"noboday can hit the right controls in the
 *      stopped session card."*
 *   2. **A `⋯` menu in that corner** — *"i dont like the approach, the menu is very tiny."*
 *   3. **The side panel** — *"i dont see actions in the panel."* They were there, but that panel is **collapsed by
 *      default** (`DESIGN.md` §78) and behind a *Show panel* toggle, which is exactly the defect #79 records for
 *      Rename: a control nobody can find.
 *
 * Asked for from use: *"a i wanted to introduce a control bar here"*, pointing at the session header — the row that
 * already carries the name, the directory and a row of chrome. It has the width for labelled buttons, it is always
 * visible, and it sits beside the session the actions belong to.
 *
 * ## Why a bar and not a menu
 *
 * The header row is horizontal and already holds several controls (pickers, the meter, the cost). A bar of buttons
 * reads at a glance and states what each one does; a menu in a header with this much room would be hiding something the
 * reader came to the header for.
 */
import type { LiveSession } from "@pi-central/protocol";
import { sessionControlsFor } from "./Inspector.tsx";

/** What the shell can offer. Absent callbacks mean the action is not rendered — never a button that would fail. */
export interface SessionControlCaps {
  onStop?: (() => void) | undefined;
  onResume?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  retryAvailable?: boolean | undefined;
  onForget?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
}

export function SessionControlBar({
  session,
  onStop,
  onResume,
  onRetry,
  retryAvailable = true,
  onForget,
  onDelete,
}: { session: LiveSession } & SessionControlCaps) {
  /*
   * Built from `sessionControlsFor`, so WHICH actions exist is decided in one place and stays a tested pure function.
   * This component only renders the list.
   */
  const controls = sessionControlsFor(session, {
    ...(onStop === undefined ? {} : { onStop }),
    ...(onResume === undefined ? {} : { onResume }),
    ...(onRetry === undefined ? {} : { onRetry }),
    retryAvailable,
    ...(onForget === undefined ? {} : { onForget }),
    ...(onDelete === undefined ? {} : { onDelete }),
  });

  if (controls.length === 0) return null;

  return (
    <div className="session-controls" role="group" aria-label="Session actions">
      {controls.map((control) => (
        <button
          key={control.key}
          type="button"
          className={`btn btn-quiet session-control${control.danger === true ? " session-control-danger" : ""}`}
          title={control.title}
          disabled={control.disabled === true}
          onClick={control.onSelect}
        >
          {control.label}
        </button>
      ))}
    </div>
  );
}
