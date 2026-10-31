/**
 * Rename a session in place (issues #78, #79).
 *
 * ## Why this exists at all
 *
 * Reported: *"renaming a session is not easy"* — the only path was Inspector → Actions → expand `Rename…` →
 * type → `Save name`. The detail panel had to be visible and a disclosure opened before a single character could
 * be typed, which is why nobody names a session. And `DESIGN.md` §12 already specified the intended gesture:
 *
 *   > **Double-click the header name** → inline rename (`set_session_name`)
 *
 * ## Why the logic is a hook with two renderers
 *
 * The header can put the field where the text was, but the rail row cannot: its content lives inside a `<button>`,
 * and an `<input>` inside a button is invalid HTML that browsers resolve by breaking the row. So the rail has to
 * swap the whole row while editing.
 *
 * A first version kept the state inside `InlineRename`, which left the rail unable to use it at all — and the rail
 * half of #162 was then claimed in its description and never wired. The behaviour lives in `useRenameEditor`, and
 * both renderers are thin: one state machine, two shapes.
 *
 * ## Commit and cancel
 *
 * Enter commits, Escape cancels, and blur COMMITS — because the alternative is losing a typed name by clicking
 * away, which is the failure this whole issue is about. An empty or unchanged value never reaches the
 * orchestrator: a rename that sends `""` would blank a name the reader can see.
 */
import { useEffect, useRef, useState } from "react";

export interface RenameEditor {
  editing: boolean;
  draft: string;
  /** Begin editing. Prefills from `value`. */
  start: () => void;
  /**
   * Behaviour props for the `<input>` (commit, cancel, focus guard).
   *
   * Spreading them is what keeps both renderers behaviourally identical. `ref`, `className` and `aria-label` stay
   * with the caller, because those are the parts that differ between the header's field and the rail's.
   */
  inputProps: React.InputHTMLAttributes<HTMLInputElement>;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

/**
 * The state machine behind every rename affordance.
 *
 * `value` is the name **as displayed**, which is what the field edits. Reported from use: a scratch session's row
 * read `Scratch session` but opened `s1`, because the caller passed the stored name and a separate display value.
 * One value means the two cannot disagree — and an unchanged commit compares against what is on screen, so
 * accepting a default label sends nothing rather than promoting it into a literal name.
 */
export function useRenameEditor({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (name: string) => void;
}): RenameEditor {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus and select on entering edit mode, so the common case is "type the new name" rather than
  // "select all, then type". A `useEffect` rather than `autoFocus`: the element mounts inside a subtree that may
  // already have focus, and selecting after mount is what makes it usable.
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next.length === 0 || next === value) return;
    onCommit(next);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const start = () => {
    setDraft(value);
    setEditing(true);
  };

  return {
    editing,
    draft,
    start,
    inputRef,
    inputProps: {
      value: draft,
      onChange: (event) => setDraft(event.target.value),
      onBlur: commit,
      onKeyDown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
        // Name editing must not reach the window-level handlers: Escape is bound globally to close dialogs and to
        // stop a run, and a key pressed inside a form field is not a command for the rest of the app.
        event.stopPropagation();
      },
      // A double-click inside the field would start a second edit on the text; the field is already the editor.
      onDoubleClick: (event) => event.stopPropagation(),
    },
  };
}

/** The header's shape: the text swaps for a field in place. */
export function InlineRename({
  value,
  onCommit,
  label,
  className,
}: {
  value: string;
  onCommit: (name: string) => void;
  label: string;
  className?: string;
}) {
  const editor = useRenameEditor({ value, onCommit });

  if (editor.editing) {
    return (
      <input
        {...editor.inputProps}
        ref={editor.inputRef}
        className={`inline-rename${className ? ` ${className}` : ""}`}
        aria-label={label}
      />
    );
  }

  return (
    <span
      className={className}
      onDoubleClick={(event) => {
        // The header sits inside clickable surfaces. Editing is the more specific intent, so it claims the event.
        event.stopPropagation();
        editor.start();
      }}
      title="Double-click to rename"
    >
      {value}
    </span>
  );
}
