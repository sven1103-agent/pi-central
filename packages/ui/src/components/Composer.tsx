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
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streaming = session?.state === "streaming";
  const unavailable = unavailableReason !== undefined;

  // The choice is only REAL while streaming, so it is only remembered then. Idle, the strip is
  // hidden and `behavior` is not sent at all — Pi drops a streamingBehavior on a non-streaming
  // prompt, but sending one would still be a claim that a choice was made.
  const [behavior, setBehavior] = useState<QueueBehavior>("steer");
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
      // 1. A dialog open is handled by the dialog dock (it stops propagation).
      // 2. Popovers close themselves.
      // 3. Streaming: clear the queue (returning the text) and stop the run.
      if (streaming) {
        event.preventDefault();
        onClearQueueAndStop();
        // Said here rather than inferred: the queue coming back into the box is the main
        // feedback, but with nothing queued there would otherwise be no sign the run is stopping.
        setJustStopped(true);
      }
      // 4. Otherwise: no-op. The draft is NEVER touched.
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [streaming, onClearQueueAndStop]);

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
    // The behavior is sent ONLY while streaming, where it is a real choice. Sending "steer" for
    // an idle prompt would be harmless to Pi and misleading to a reader of the wire.
    onSend(message, streaming ? behavior : "steer");
    onDraftChange("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a newline. Matches every chat surface the user already knows.
    // Mid-run, Alt+Enter picks the other queue mode, which is Pi's own binding
    // (`interactive-mode.js`: Alt+Enter queues a follow-up).
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (streaming && event.altKey) {
        setBehavior("followUp");
        // Alt+Enter sends as a follow-up directly rather than only changing the toggle: the user
        // pressed a key that means "queue this for after", so making them press Enter again would
        // be a second gesture for one intent.
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

  const buttonLabel = streaming
    ? behavior === "steer"
      ? "Send steer"
      : "Queue follow-up"
    : "Send";

  return (
    <div className="composer">
      {streaming && (
        <div className="mode-strip">
          <div className="mode-choice" role="radiogroup" aria-label="What this message does">
            <button
              type="button"
              role="radio"
              aria-checked={behavior === "steer"}
              className={behavior === "steer" ? "mode-option mode-option-on" : "mode-option"}
              onClick={() => setBehavior("steer")}
            >
              Steer
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={behavior === "followUp"}
              className={behavior === "followUp" ? "mode-option mode-option-on" : "mode-option"}
              onClick={() => setBehavior("followUp")}
            >
              Follow-up
            </button>
          </div>
          <span className="mode-consequence">
            {/* The consequence, not the mechanism. This is the sentence the issue asks for: which
                of the two will happen. */}
            {behavior === "steer"
              ? "Delivered after the current turn's tools finish"
              : "Starts after this run finishes"}
          </span>
        </div>
      )}

      {streaming && queue.total > 0 && (
        <div className="queue-strip" role="status">
          <span className="queue-head">{queue.total} queued</span>
          {/* Rows are read-only: Pi Central has no per-item removal, so a `×` would be a fake
              control. The one real action is Esc, which is stated in the hint line. */}
          {queue.textsKnown ? (
            <ul className="queue-rows">
              {queue.steering.map((text, index) => (
                <li key={`s${index}`}>{text}</li>
              ))}
              {queue.followUp.map((text, index) => (
                <li key={`f${index}`}>{text}</li>
              ))}
            </ul>
          ) : (
            // Never invented. After a reconnect the count is known and the texts are not.
            <span className="queue-unknown">
              {queue.total === 1 ? "1 message" : "Messages"} queued before this page loaded
            </span>
          )}
        </div>
      )}

      {unavailable && unavailableReason && (
        <div className="hint" role="note">
          {unavailableReason}
        </div>
      )}

      <div className="composer-row">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={unavailable ? unavailableReason ?? "Unavailable" : "Send a prompt…"}
          disabled={unavailable}
          aria-label="Prompt"
          rows={3}
        />
        <button
          type="button"
          className="btn-send"
          onClick={submit}
          disabled={unavailable || draft.trim().length === 0}
        >
          {unavailable ? "Send" : buttonLabel}
        </button>
      </div>

      <div className="hint">
        {streaming ? (
          <>
            <kbd>Enter</kbd> to {behavior === "steer" ? "steer" : "queue a follow-up"} ·{" "}
            <kbd>Alt</kbd>+<kbd>Enter</kbd> for {behavior === "steer" ? "a follow-up" : "steer"} ·{" "}
            <kbd>Esc</kbd> stops the run and returns the queue to this box
          </>
        ) : (
          <>
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
          </>
        )}
      </div>

      {justStopped && (
        <div className="hint" role="status">
          Stopped the run.
        </div>
      )}
    </div>
  );
}
