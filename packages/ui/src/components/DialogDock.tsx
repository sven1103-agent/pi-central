/**
 * The approvals surface.
 *
 * This is the reason the dashboard is worth building: Pi emits `extension_ui_request` records
 * that BLOCK the agent until answered, and a terminal can only show one at a time. Here, a
 * dialog from any session is visible and answerable without losing your place.
 *
 * The critical distinction (PROTOCOL.md, verified by execution): only `select`, `confirm`,
 * `input` and `editor` block. Pi emits ~9 non-blocking requests at startup — five `notify`,
 * three `setStatus`, one `setWidget` — and every one of them carries an `id`. So a naive
 * "has an id, therefore it is a dialog" rule would wedge the session on a prompt no human will
 * ever answer, before the user has done anything. The classification is by METHOD.
 */
import { useEffect, useRef, useState } from "react";
import type { PendingDialog } from "@pi-central/protocol";
import { FIRE_AND_FORGET_UI_METHODS, isKnownDialogMethod } from "@pi-central/protocol";

export type DialogAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export function DialogDock({
  dialogs,
  onAnswer,
}: {
  dialogs: PendingDialog[];
  onAnswer: (dialogId: string, answer: DialogAnswer) => void;
}) {
  // Fire-and-forget requests are filtered out rather than trusted, because a `notify` reaching
  // this component would be a classification bug upstream.
  //
  // Note which family is filtered: the NON-dialogs. The orchestrator's default for an
  // unrecognized method is "blocking", so anything unfamiliar arrives here as a dialog and is
  // rendered — with a Cancel, since a request the user cannot dismiss would hang the agent.
  const fireAndForget = new Set<string>(FIRE_AND_FORGET_UI_METHODS);
  const blocking = dialogs.filter((dialog) => !fireAndForget.has(dialog.method));
  if (blocking.length === 0) return null;

  // One at a time: the agent is blocked on the first anyway, and stacking adds no agency.
  const dialog = blocking[0]!;

  return (
    <div className="dialog-dock">
      <div className="dialog-head">
        <span>Needs your answer</span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--mono)" }}>{dialog.method}</span>
      </div>
      <DialogBody key={dialog.id} dialog={dialog} onAnswer={onAnswer} />
    </div>
  );
}

function DialogBody({
  dialog,
  onAnswer,
}: {
  dialog: PendingDialog;
  onAnswer: (dialogId: string, answer: DialogAnswer) => void;
}) {
  const [value, setValue] = useState(dialog.prefill ?? "");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // Focus enters on arrival. Not a hard trap: a real modal would punish switching to another
  // session, which is the dashboard's whole point. Esc cancels, per the precedence ladder.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Stop propagation so the composer's Esc handler does not also fire and abort the run:
        // the first rung of the ladder is "answer the dialog", not "stop the session".
        event.stopPropagation();
        event.preventDefault();
        onAnswer(dialog.id, { cancelled: true });
      }
    };
    const node = containerRef.current;
    node?.addEventListener("keydown", onKeyDown);
    return () => node?.removeEventListener("keydown", onKeyDown);
  }, [dialog.id, onAnswer]);

  const question = dialog.message ?? dialog.title ?? "The agent is asking for input.";

  return (
    <div className="dialog-body" ref={containerRef} role="dialog" aria-label={question}>
      {dialog.title && dialog.message && <p className="title">{dialog.title}</p>}
      <p className="question">{question}</p>

      {dialog.method === "confirm" && (
        <div className="dialog-actions">
          {/* `Allow once` rather than `Yes`: it states the scope of what is granted. */}
          <button type="button" className="btn" onClick={() => onAnswer(dialog.id, { confirmed: true })}>
            Allow once
          </button>
          <button type="button" className="btn" onClick={() => onAnswer(dialog.id, { confirmed: false })}>
            Deny
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onAnswer(dialog.id, { cancelled: true })}
          >
            Cancel request
          </button>
        </div>
      )}

      {dialog.method === "select" && (
        <div className="dialog-options">
          {(dialog.options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onAnswer(dialog.id, { value: option })}
            >
              {option}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginTop: 6 }}
            onClick={() => onAnswer(dialog.id, { cancelled: true })}
          >
            Cancel request
          </button>
        </div>
      )}

      {dialog.method === "input" && (
        <>
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="text"
            value={value}
            placeholder={dialog.placeholder ?? "Type your answer"}
            aria-label={question}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onAnswer(dialog.id, { value });
              }
            }}
          />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => onAnswer(dialog.id, { value })}>
              Submit
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onAnswer(dialog.id, { cancelled: true })}
            >
              Cancel request
            </button>
          </div>
        </>
      )}

      {dialog.method === "editor" && (
        <>
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={value}
            placeholder={dialog.placeholder ?? "Edit the content"}
            aria-label={question}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => onAnswer(dialog.id, { value })}>
              Submit
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onAnswer(dialog.id, { cancelled: true })}
            >
              Cancel request
            </button>
          </div>
        </>
      )}

      {/* A method we do not know how to render: offer a cancel rather than showing a dialog the
          user cannot dismiss, which would block the agent forever. */}
      {!isKnownDialogMethod(dialog.method) && (
        <div className="dialog-actions">
          <button
            type="button"
            className="btn"
            onClick={() => onAnswer(dialog.id, { cancelled: true })}
          >
            Cancel request
          </button>
        </div>
      )}
    </div>
  );
}
