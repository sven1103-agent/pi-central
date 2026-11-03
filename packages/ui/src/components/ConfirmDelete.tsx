/**
 * Confirming a deletion (issue #150).
 *
 * ## Why a dialog, and not a toast with undo
 *
 * A toast with an undo button is the pattern that makes a destructive action feel cheap, and it is a lie here: the
 * file is **unlinked**. Recovery would need a trash directory, which is a different feature with a different set of
 * ways to go wrong (a trash that fills up, a restore that restores a session whose cwd is gone, a purge policy). The
 * issue asks for a dialog for exactly this reason, and the wording says what happens rather than softening it.
 *
 * ## What the dialog must name
 *
 * Three things, because a confirmation that names fewer is a confirmation the reader cannot check:
 *
 *   - **which session** — by the same label the rail and History use, so the row and the dialog cannot look like two
 *     different sessions;
 *   - **which directory** — two tasks in one project is the intended workflow (#149), so the label alone is genuinely
 *     ambiguous here;
 *   - **that the transcript file is removed**, in those terms. "Delete" alone reads as "remove from the list", which
 *     is #87 and reversible.
 *
 * ## Why the confirming button is not focused
 *
 * `Cancel` takes focus, following `ConfirmStop`. A destructive dialog that focuses its destructive action turns a
 * stray `Enter` — from a reader who was typing in the composer a moment ago — into an irreversible delete.
 */
import { useEffect, useRef } from "react";

export function ConfirmDelete({
  /** The session's display label, from `nameLabel`/`displayName` — never a handle if a prompt explains it. */
  label,
  /** The absolute directory the session worked in. Absent for a selection, which can span several. */
  cwd,
  /** How many transcripts this confirmation will remove. Present for a bulk selection. */
  count,
  /** Set when a sidecar directory will also be removed, so the reader knows the count of what goes. */
  hasSidecar,
  onCancel,
  onConfirm,
}: {
  label: string;
  cwd?: string | undefined;
  count?: number | undefined;
  hasSidecar?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="delete-title">
          {/* Plural when it is a selection, because "delete this session?" over seven rows is the wrong question. */}
          {count !== undefined && count > 1 ? `Delete ${count} sessions?` : "Delete this session?"}
        </h3>
        <p style={{ marginBottom: 8 }}>
          <strong>{label}</strong>
          {/* The directory, because two tasks in one project is the normal case — the label alone is ambiguous. */}
          {cwd !== undefined && (
            <span className="mono" style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--dim)" }}>
              {cwd}
            </span>
          )}
        </p>
        <p style={{ marginBottom: hasSidecar === true ? 8 : 16 }}>
          {count !== undefined && count > 1 ? "Their transcript files will be" : "Its transcript file will be"}{" "}
          <strong>removed from disk</strong>. This cannot be undone — Pi Central keeps no
          copy, and the session will not appear in History again.
        </p>
        {hasSidecar === true && (
          <p style={{ marginBottom: 16, fontSize: "var(--fs-sm)", color: "var(--dim)" }}>
            The session's subagent records are removed with it.
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-danger" onClick={onConfirm}>
            {count !== undefined && count > 1 ? `Delete ${count} transcripts` : "Delete transcript"}
          </button>
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>
            Keep it
          </button>
        </div>
      </div>
    </div>
  );
}
