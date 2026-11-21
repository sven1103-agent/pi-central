/**
 * The rail's resize handle (issue #275).
 *
 * ## Why the rail gets a handle and the panel already had one
 *
 * The panel was made resizable in issue #8 for a stated reason — a document in a 320px column was clipped mid-word —
 * and the arithmetic was kept out of the component so it could be tested without a DOM. The rail has the same shape
 * of problem and had neither: a fixed 288px track, no drag, no keyboard nudge, and no way back to the default.
 *
 * The three properties are copied deliberately from `Panel.tsx` rather than re-derived:
 *
 *   1. **A 1px visual edge with a wider invisible hit area.** The gutter is one line of `--line` and a 1px target is
 *      not grabbable.
 *   2. **`role="separator"` with `aria-valuenow`/`valuemin`/`valuemax` and a spoken `aria-valuetext`.** A bare
 *      number gives no unit.
 *   3. **Commit on gesture END, not per `pointermove`.** A drag emits hundreds of moves and writing `localStorage`
 *      synchronously on each one makes the drag stutter.
 *
 * ## The sign is the opposite of the panel's, and that is the one thing not to copy
 *
 * Positive `delta` GROWS this column: the rail sits on the left and its handle is on its own right edge, so dragging
 * right gives the rail more room and the transcript less. `resizeRailBy` in `rail-prefs.ts` owns that inversion so
 * there is one place to be wrong.
 */
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH, clampRailWidth, railMaxWidth, resizeRailBy, resizeRailTo } from "../rail-prefs.ts";

export function RailResizer({
  width,
  viewportWidth,
  onWidth,
  onCommit,
}: {
  width: number;
  viewportWidth: number;
  /** A new width. `userSized` is implied: any gesture here is a deliberate placement. */
  onWidth: (width: number) => void;
  /** Persist. Called once per gesture, never per move. */
  onCommit?: (() => void) | undefined;
}) {
  // In a ref, not state: a re-render per pointermove is what makes a drag feel sticky, and nothing rendered depends
  // on the intermediate values.
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | undefined>(undefined);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Stops the drag from selecting the transcript text underneath, which otherwise leaves the whole window
    // highlighted the moment you grab the edge.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // `startWidth + delta`, not `width + delta`: accumulating against the live width compounds rounding and drifts
    // away from the pointer.
    onWidth(resizeRailBy(state.startWidth, event.clientX - state.startX, viewportWidth));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit?.();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    // Prevented so the arrow keys do not also scroll the list, which would make the gesture move two things at once.
    event.preventDefault();
    onWidth(resizeRailTo(event.key as "ArrowLeft", width, viewportWidth));
    onCommit?.();
  }

  return (
    <div
      className="rail-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the session list"
      aria-valuenow={width}
      aria-valuemin={RAIL_MIN_WIDTH}
      aria-valuemax={railMaxWidth(viewportWidth)}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => {
        // Reset is the only way back to the default without guessing the number — the same affordance, in the same
        // place, as the panel's.
        onWidth(clampRailWidth(RAIL_DEFAULT_WIDTH, viewportWidth));
        onCommit?.();
      }}
    />
  );
}
