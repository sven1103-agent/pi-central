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
import { AttachmentRail } from "./AttachmentRail.tsx";
import { canSend, type Attachment } from "../attachments.ts";
import { imageFilesFrom } from "../paste.ts";

export type QueueBehavior = "steer" | "followUp";

/*
 * Stable defaults for the attachment props, so an embedding that knows nothing about images does not have to pass them.
 *
 * Module-level constants rather than inline `[]` and `() => {}`: the composer compares `attachments` in `canSend` on every
 * keystroke, and a fresh array each render would make that comparison false every time for no reason.
 */
const noAttachments: readonly Attachment[] = Object.freeze([]);
const noAttach = () => {};
const noRemoveAttachment = () => {};

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
  attachments = noAttachments,
  onAttach = noAttach,
  onRemoveAttachment = noRemoveAttachment,
  canAttach = "unknown",
  notice,
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
   * Images waiting to be sent with the next prompt.
   *
   * Owned by `App` and keyed per session, for the reason drafts are: an attachment that leaked between sessions would be
   * sent to a different agent in a different directory, and content leaking is worse than text leaking.
   */
  attachments?: readonly Attachment[] | undefined;
  /**
   * Hand a paste or a drop to the owner, which validates, downscales and stores it.
   *
   * The composer deliberately does not own attachment state. It would have to be lifted anyway (the send path needs it),
   * and a component that both captures and stores would make "what is attached" answerable in two places.
   */
  onAttach?: ((files: readonly File[]) => void) | undefined;
  onRemoveAttachment?: ((id: string) => void) | undefined;
  /**
   * Whether the model can accept an image at all — `imageSupport(model.input)`.
   *
   * `"no"` suppresses the paste affordance entirely, because offering one would produce a provider error the reader
   * cannot act on. `"unknown"` keeps it: Pi omitting the field is not a claim that the model is text-only.
   */
  canAttach?: "yes" | "no" | "unknown" | undefined;
  /** A refused paste or drop, or a sent acknowledgement. Rendered in the chrome row, where the eyes already are. */
  notice?: string | undefined;
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
    /*
     * `canSend`, not `message.length > 0`.
     *
     * A screenshot with no words is a complete instruction ("what is this?"), and Pi accepts an empty message when images
     * are present because the image IS the content. Requiring text would force the reader to type filler.
     */
    if (!canSend(message, attachments) || unavailable) return;
    // Plain Enter STEERS while streaming. Sending "steer" for an idle prompt would be harmless to Pi and misleading to a
    // reader of the wire, so the behavior is only claimed when the choice was real.
    onSend(message, "steer");
    onDraftChange("");
  };

  /**
   * A paste that carries an image becomes an attachment; a paste that carries only text is left alone.
   *
   * `preventDefault` is called ONLY when images were found. A screenshot copy in Chromium puts an image AND its
   * placeholder text on the clipboard, so an unconditional preventDefault would swallow a text paste from a screenshot's
   * own alt text — and an unconditional pass-through would let the browser insert a filename into the field.
   */
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (canAttach === "no") return;
    const files = imageFilesFrom(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    onAttach(files);
  };

  /**
   * Drop, on the whole composer rather than on the textarea.
   *
   * A drop aimed at the field's padding or at the rail beside it would otherwise fall through to the page, where the
   * browser navigates to the file — which loses the draft and is the worst possible outcome of a near miss.
   */
  const [dragging, setDragging] = useState(false);
  const onDragOver = (event: React.DragEvent) => {
    if (canAttach === "no") return;
    // Only claim the drop when the payload actually has a file, so dragging text into the field still selects text.
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const onDragLeave = (event: React.DragEvent) => {
    // `relatedTarget` is the element being entered. Without this check a child boundary fires `leave` and the highlight
    // flickers as the pointer crosses the field.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  };
  const onDrop = (event: React.DragEvent) => {
    setDragging(false);
    if (canAttach === "no") return;
    const files = imageFilesFrom(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    onAttach(files);
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
        // `canSend` for the same reason `submit` uses it: an image alone is a complete prompt.
        if (canSend(message, attachments) && !unavailable) {
          onSend(message, "followUp");
          onDraftChange("");
        }
        return;
      }
      submit();
    }
  };

  return (
    <div
      className={`composer${dragging ? " is-dragging" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
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
        onPaste={onPaste}
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
        THE ATTACHMENTS, above the field.

        Above rather than below, because they are part of the MESSAGE being composed — the field's content follows them in
        reading order, and a chip strip between the field and the chrome row would sit where the hint belongs and grow the
        composer's permanent height on every paste.
      */}
      <AttachmentRail attachments={attachments} onRemove={onRemoveAttachment} />

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

      {/*
        A refusal, or the acknowledgement of a sent prompt with images, in the composer's own chrome row.

        `role="status"` rather than `alert`: it is information about the reader's own action, not an interruption, and an
        alert here would fire while they are typing the next thing. The text is a sentence from `attachments.ts`, so the
        refusal the composer shows and the one the orchestrator would give cannot be worded differently.
      */}
      {notice !== undefined && (
        <div className="hint attach-notice" role="status">
          {notice}
        </div>
      )}

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
