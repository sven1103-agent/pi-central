/**
 * The queue sheet: the full list, as a popover anchored to the composer.
 *
 * ## Why a popover and not a pane
 *
 * The rail answers "what is waiting"; the sheet answers "all of it". Making the sheet a pane would mean the full text of
 * every queued message permanently occupies part of the workspace to answer a question the reader asks occasionally —
 * and the right panel, the obvious home for it, defaults to collapsed, so the queue would be hidden until configured.
 *
 * ## The behaviour it has to get right
 *
 *   - **Escape closes the sheet and nothing else.** `escalation()` in `queue.ts` owns that decision so the composer and
 *     this component cannot disagree; pressing Escape again is the reader asking for the other thing.
 *   - **Focus returns to the trigger**, because a surface opened from the keyboard must be closable from it.
 *   - **A click outside closes it**, registered on the capture phase so a click on the field underneath does not focus
 *     the field and leave the sheet floating over a changed state.
 *   - It is `role="dialog"` with `aria-modal="false"`: the agent is not blocking the reader, so it must not trap them.
 *     This project made that argument for the dialog dock and it applies here for the same reason.
 */
import { useEffect, useId, useRef } from "react";
import type { Queued } from "../queue.ts";
import { QueuedPrompts } from "./QueuedPrompts.tsx";

export function QueueSheet({
  queue,
  onClose,
  onClearQueueAndStop,
}: {
  queue: Queued;
  onClose: () => void;
  onClearQueueAndStop: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (sheetRef.current?.contains(target) === true) return;
      // The trigger is outside the sheet; it toggles, so it must not be treated as an outside click or the sheet would
      // close and immediately reopen.
      if ((target as HTMLElement).closest?.(".queue-rail-open") !== null) return;
      onClose();
    };
    // CAPTURE: a click on the field underneath must close this sheet, not focus the field and leave it open.
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  // Focus moves in, so the reader can act on what opened without reaching for the mouse.
  useEffect(() => {
    sheetRef.current?.focus();
  }, []);

  return (
    <div
      ref={sheetRef}
      className="queue-sheet"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <h3 id={titleId} className="queue-sheet-title">
        Queued messages
      </h3>
      <QueuedPrompts queue={queue} onClearQueueAndStop={onClearQueueAndStop} onClose={onClose} />
    </div>
  );
}
