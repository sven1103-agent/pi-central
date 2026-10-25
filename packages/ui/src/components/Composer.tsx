/**
 * The composer.
 *
 * The design rule that matters: **the mode control only appears when the choice is real.**
 * When idle, only one thing can happen, so showing a prompt/steer selector would be a lie
 * about complexity. During a run the choice is real and the strip explains its consequence.
 *
 * Steer is deliberately absent: `Control` has no `steer` and the supervisor hard-codes
 * `followUp` when streaming. A visible-but-disabled toggle would advertise a capability the
 * protocol cannot deliver, which is worse than its absence — so the hint says so instead.
 *
 * Esc follows a precedence ladder, and it NEVER touches the draft: the draft is the user's
 * text, and losing it to a keystroke meant for the agent would be the worst bug in the app.
 */
import { useEffect, useRef, useState } from "react";
import type { LiveSession } from "@pi-central/protocol";
import { composerMode } from "../store.ts";

export function Composer({
  session,
  onSend,
  onClearQueueAndStop,
  draft,
  onDraftChange,
}: {
  session: LiveSession | undefined;
  onSend: (message: string) => void;
  onClearQueueAndStop: () => void;
  draft: string;
  onDraftChange: (draft: string) => void;
}) {
  const mode = composerMode(session);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streaming = session?.state === "streaming";

  // Esc precedence, implemented in ONE place so the ladder cannot drift between handlers.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 1. A dialog open is handled by the dialog dock (it stops propagation).
      // 2. Popovers close themselves.
      // 3. Streaming: clear the queue and stop the run.
      if (streaming) {
        event.preventDefault();
        onClearQueueAndStop();
        // The queue text is not actually restored (Pi Central has no `clear_queue`), so the
        // honest message is that the run stopped. Never claim text came back that did not.
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
    if (message.length === 0 || mode.mode === "unavailable") return;
    onSend(message);
    onDraftChange("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a newline. Matches every chat surface the user already knows.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const buttonLabel = mode.mode === "steer" ? "Queue follow-up" : "Send";

  return (
    <div className="composer">
      {streaming && (
        <div className="mode-strip">
          <span>Run in progress · Follow-up</span>
          <span style={{ opacity: 0.85 }}>Queued: starts after this run finishes</span>
        </div>
      )}

      {mode.mode === "unavailable" && mode.reason && (
        <div className="hint" role="note">
          {mode.reason}
        </div>
      )}

      <div className="composer-row">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={mode.mode === "unavailable" ? mode.reason ?? "Unavailable" : "Send a prompt…"}
          disabled={mode.mode === "unavailable"}
          aria-label="Prompt"
          rows={3}
        />
        <button
          type="button"
          className="btn-send"
          onClick={submit}
          disabled={mode.mode === "unavailable" || draft.trim().length === 0}
        >
          {mode.mode === "unavailable" ? "Send" : buttonLabel}
        </button>
      </div>

      <div className="hint">
        {streaming ? (
          <>
            <kbd>Enter</kbd> to queue · <kbd>Esc</kbd> stops the run and clears the queue ·
            Steer is not available in this build
          </>
        ) : (
          <>
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
          </>
        )}
      </div>

      {justStopped && (
        <div className="hint" role="status">
          Stopped the run. Anything left in the queue was discarded.
        </div>
      )}
    </div>
  );
}
