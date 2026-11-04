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

/**
 * The glyph for each control, chosen to match what the app already uses.
 *
 * ## Why these, and not an icon set
 *
 * `RunNotices` already draws `↻` for a retry and `✕` for a terminal failure, so those two are not invented here —
 * a second glyph for the same idea a few inches away would be the drift this repository keeps finding. The rest follow
 * the same restrained convention: a typographic character, not a pictogram, so the bar reads as text with marks rather
 * than as a toolbar of illustrations.
 *
 * ## Why the word stays beside it
 *
 * Asked for from use: *"if icons would be better since they are less pressing on the visual load. But that means users
 * need to see symbols that are really intuitive."* That last clause is the whole problem — and `DESIGN.md` §681 settles
 * the principle: a labelled control, not a glyph, because *"an icon makes it undiscoverable to anyone who reads words."*
 *
 * So the glyph reduces the visual weight and the WORD carries the meaning:
 *
 *   - **Forget vs Delete cannot be told apart as glyphs.** They differ only in consequence — one hides a row and keeps
 *     the file, the other unlinks it — and any two symbols close enough to be guessable are close enough to be confused.
 *     Confusing them is the irreversible case.
 *   - **Resume vs Retry are both "run it again"**, differing in whether the transcript continues.
 *   - **These are not frequent.** A session is resumed or stopped a handful of times a day, so recognition by
 *     repetition never accumulates and the glyph stays a guess.
 *
 * A frequent, safe action can earn a bare glyph later; an irreversible one does not.
 */
const GLYPHS: Readonly<Record<string, string>> = {
  resume: "▶",
  retry: "↻",
  stop: "◼",
  forget: "✕",
  delete: "⌫",
  "retry-unavailable": "↻",
};

/** The glyph for a control key, or `undefined` for one that has none — a missing glyph must not render as nothing. */
export function glyphFor(key: string): string | undefined {
  return GLYPHS[key];
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
          {glyphFor(control.key) !== undefined && (
            /*
             * `aria-hidden`, because the label is right beside it: an unlabelled glyph read aloud adds a symbol name
             * before every action, and "black right-pointing triangle Resumé session" is noise.
             */
            <span className="session-control-glyph" aria-hidden="true">
              {glyphFor(control.key)}
            </span>
          )}
          {control.label}
        </button>
      ))}
    </div>
  );
}
