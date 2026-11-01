/**
 * The composer.
 *
 * The design rule that matters: **the mode control only appears when the choice is real.**
 * When idle, only one thing can happen, so showing a prompt/steer selector would be a lie
 * about complexity. During a run the choice is real — the message either redirects the running
 * turn or waits for it — and the strip explains which of the two is selected and what that means.
 *
 * Both halves are now delivered, so there is no capability hint left to hedge: `steer` is sent as
 * `streamingBehavior: "steer"`, follow-up as `"followUp"`, and the label names the consequence
 * rather than the mechanism. Pi's own interactive mode uses steer for a plain Enter mid-run and
 * follow-up for Alt+Enter, and this matches that.
 *
 * Esc follows a precedence ladder, and the draft is never DISCARDED: the queue is cleared into
 * the draft, and the abort stops the run. Losing the user's text to a keystroke meant for the
 * agent was the bug this guarded against; now that Pi can hand the queue back, clearing it is
 * safe rather than lossy.
 */
import { useEffect, useRef, useState } from "react";
import type { LiveSession } from "@pi-central/protocol";
import { queuedMessages, type UiState } from "../store.ts";
import { escalation } from "../queue.ts";
import { QueueRail } from "./QueueRail.tsx";
import { QueueSheet } from "./QueueSheet.tsx";

export type QueueBehavior = "steer" | "followUp";

export function Composer({
  session,
  state,
  unavailableReason,
  onSend,
  onClearQueueAndStop,
  onRestored,
  restored,
  draft,
  onDraftChange,
  follow,
}: {
  session: LiveSession | undefined;
  /** The reducer state, for the queued texts. The mode itself comes from `composerMode`. */
  state: UiState;
  /** Why the composer cannot be used, from `composerMode`. Undefined when it can. */
  unavailableReason: string | undefined;
  onSend: (message: string, behavior: QueueBehavior) => void;
  onClearQueueAndStop: () => void;
  /** Called once the cleared text has been merged into the draft, so it is not merged twice. */
  onRestored: () => void;
  /** Text that `clearQueue` returned, to be put back into the composer. */
  restored: string[];
  draft: string;
  onDraftChange: (draft: string) => void;
  /**
   * The follow toggle, rendered in the composer's own chrome row.
   *
   * A SLOT rather than a prop pair, because the composer has no opinion about scrolling — the transcript owns that
   * behaviour and passes the control down. The composer only decides WHERE it goes, which is the thing that was wrong.
   */
  follow?: React.ReactNode;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streaming = session?.state === "streaming";
  const unavailable = unavailableReason !== undefined;

  /*
   * NO MODE STATE.
   *
   * There used to be a `behavior` state behind a segmented control. The choice is now the KEY: `Enter` steers,
   * `Alt+Enter` queues for after the run - Pi's own bindings, which this control was mirroring anyway. Deleting the
   * state deleted the whole strip with it: three elements and 26px of permanent dock height to choose between two things.
   */
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetTriggerRef = useRef<HTMLButtonElement>(null);
  const queue = queuedMessages(state, session);

  /**
   * Put cleared text back, once.
   *
   * Appended BELOW the draft rather than replacing it: the draft is what the user was typing
   * while the run went on, so overwriting it would lose the newer text to restore the older. The
   * blank line between them keeps two queued messages from reading as one.
   *
   * The guard is `restored.length > 0`, which is what makes this happen once per clear rather
   * than on every render — `onRestored` then clears the store field, and the empty array that
   * results is a no-op here.
   */
  useEffect(() => {
    if (restored.length === 0) return;
    const incoming = restored.filter((text) => text.trim().length > 0).join("\n\n");
    // Careful with the separator: a draft of only whitespace should not produce a leading blank
    // line, and an empty draft should not produce a trailing one.
    const current = draft.trim();
    if (incoming.length > 0) {
      onDraftChange(current.length > 0 ? `${current}\n\n${incoming}` : incoming);
      textareaRef.current?.focus();
    }
    onRestored();
    // `draft` and `onDraftChange` are deliberately absent: this reacts to `restored` arriving,
    // and including the draft would re-run it on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored]);

  // Esc precedence, implemented in ONE place so the ladder cannot drift between handlers.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The ladder lives in ONE place (`queue.ts`), because two components act on Escape - this one and the sheet - and a
      // ladder implemented twice is a ladder that drifts. Step 1 (a dialog open) is handled by the dialog dock, which
      // stops propagation before this runs.
      const action = escalation({ sheetOpen, streaming });
      if (action === "close-sheet") {
        event.preventDefault();
        setSheetOpen(false);
        sheetTriggerRef.current?.focus();
        return;
      }
      if (action === "clear-and-stop") {
        event.preventDefault();
        onClearQueueAndStop();
        // Said here rather than inferred: the queue coming back into the box is the main feedback, but with nothing
        // queued there would otherwise be no sign the run is stopping.
        setJustStopped(true);
      }
      // `noop`: the draft is NEVER touched.
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sheetOpen, streaming, onClearQueueAndStop]);

  /*
   * Alt+Q opens the sheet, for the same reason the destination has a key: reaching the queue must not require a pointer.
   */
  useEffect(() => {
    if (!streaming) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && (event.key === "q" || event.key === "Q")) {
        event.preventDefault();
        setSheetOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [streaming]);

  const [justStopped, setJustStopped] = useState(false);

  // The notice is transient: it describes a transition, so it must not persist as a claim
  // about the current state.
  useEffect(() => {
    if (justStopped && !streaming) {
      const timer = setTimeout(() => setJustStopped(false), 6_000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [justStopped, streaming]);

  const submit = () => {
    const message = draft.trim();
    if (message.length === 0 || unavailable) return;
    // Plain Enter STEERS while streaming. Sending "steer" for an idle prompt would be harmless to Pi and misleading to a
    // reader of the wire, so the behavior is only claimed when the choice was real.
    onSend(message, "steer");
    onDraftChange("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a newline. Matches every chat surface the user already knows.
    // Mid-run, Alt+Enter picks the other queue mode, which is Pi's own binding
    // (`interactive-mode.js`: Alt+Enter queues a follow-up).
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (streaming && event.altKey) {
        // Alt+Enter sends as a follow-up directly. The key MEANS "queue this for after", so making the reader press
        // Enter again would be a second gesture for one intent - and with the toggle gone, the key is the whole choice.
        const message = draft.trim();
        if (message.length > 0 && !unavailable) {
          onSend(message, "followUp");
          onDraftChange("");
        }
        return;
      }
      submit();
    }
  };

  return (
    <div className="composer">
      {/*
        THE RAIL. At most two rows, whatever the count — see `queue.ts`. It sits between the transcript's scroller and
        the field, and its height is a function of how many KINDS are queued, never of how many messages are.
      */}
      <QueueRail queue={queue} onOpenSheet={() => setSheetOpen(true)} />

      {unavailable && unavailableReason && (
        <div className="hint" role="note">
          {unavailableReason}
        </div>
      )}

      {/*
        ONE SURFACE, NO BUTTON.

        Enter sends — it is the natural way to submit a prompt, and it already worked. The button was a second
        affordance for the same action, sitting outside the input's box and therefore dragging the control's width
        away from the prose's. Removing it makes the input the whole composer: one rounded surface, one left edge,
        one width, and nothing to misalign.

        The button's LABEL still matters while streaming, because "Send", "Send steer" and "Queue follow-up" are
        different promises — so the state is stated in the hint line below rather than lost with the button.
      */}
      <textarea
        ref={textareaRef}
        className="composer-input"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          unavailable
            ? unavailableReason ?? "Unavailable"
            : streaming
              ? "Steer this run…"
              : "Send a prompt…"
        }
        disabled={unavailable}
        aria-label="Prompt"
        /*
         * THREE LINES, FIXED. A longer prompt scrolls inside the field rather than growing the composer.
         *
         * `rows` is the fallback for a browser that ignores the stylesheet's `height`; the CSS is the authority, because
         * the height has to be the same whether or not the browser supports everything else here. Three lines is the
         * smallest height that shows a short paragraph in full, which is the size of prompt this app is for.
         */
        rows={3}
      />

      {/*
        THE COMPOSER'S CHROME ROW: the hint, and the follow toggle.

        Both used to float: the toggle as a pill ABOVE the field, straddling its focus ring and shifting the gap between
        the pill and the text depending on whether the field was focused (`img_40` vs `img_41`). A reviewer's verdict was
        that `auto-follow` should be "part of the composer's chrome instead of a pill floating over it" — and that the
        hint row's empty right half was the place for it.

        So one row, inside the composer's own boundary, sharing the field's left edge. The toggle is right-aligned in the
        space the hint does not use, which also stops two pill systems (this and `Jump to latest`) competing above the
        field.
      */}
      <div className="composer-chrome">
        <span className="composer-hint">
          {streaming ? (
            <>
              <kbd>Enter</kbd> steers · <kbd>Alt</kbd>+<kbd>Enter</kbd> queues for after this run ·{" "}
              <kbd>Esc</kbd> stops the run
            </>
          ) : (
            <>
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
            </>
          )}
        </span>
        {follow !== undefined && follow}
      </div>

      {justStopped && (
        <div className="hint" role="status">
          Stopped the run.
        </div>
      )}

      {sheetOpen && queue.total > 0 && (
        <QueueSheet
          queue={queue}
          onClose={() => {
            setSheetOpen(false);
            // Focus returns to the trigger: a surface opened from the keyboard must be closable from it.
            sheetTriggerRef.current?.focus();
          }}
          onClearQueueAndStop={() => {
            setSheetOpen(false);
            onClearQueueAndStop();
            setJustStopped(true);
          }}
        />
      )}
    </div>
  );
}
