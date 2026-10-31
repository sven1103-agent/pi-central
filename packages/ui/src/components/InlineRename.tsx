/**
 * Rename a session in place (issues #78, #79).
 *
 * ## Why this exists at all
 *
 * Reported: *"renaming a session is not easy"* — the only path was Inspector → Actions → expand `Rename…` →
 * type → `Save name`. The detail panel has to be visible and a disclosure opened before a single character can
 * be typed, which is why nobody names a session. And `DESIGN.md` §12 already specified the intended gesture:
 *
 *   > **Double-click the header name** → inline rename (`set_session_name`)
 *
 * It had never been built. This is that gesture, written once so the header and the rail row share it rather
 * than growing two behaviours.
 *
 * ## The decision behind the fix
 *
 * The alternative was a generated default name, so unnamed sessions would at least be distinguishable. Rejected:
 * a generated name *looks chosen*, which removes the nudge to ever name anything, and `brisk-otter` is no more
 * findable tomorrow than `s7`. Cheap renaming fixes the actual complaint — the name is only useful if giving one
 * is one gesture.
 *
 * ## Editing is a real input, not contenteditable
 *
 * An `<input>` brings IME, selection, clipboard and undo for free, and `contenteditable` brings a parser. The
 * input is rendered INSTEAD of the display node rather than inside it, so nothing nests interactive content
 * inside a button — the rail row is a `<button>`, and an `<input>` inside one is invalid HTML that browsers
 * resolve by breaking the row.
 *
 * ## Commit and cancel
 *
 * Enter commits, Escape cancels, and blur COMMITS — because the alternative is losing a typed name by clicking
 * away, which is the failure this whole issue is about. An empty or unchanged value never reaches the
 * orchestrator: a rename that sends `""` would blank a name the reader can see.
 */
import { useEffect, useRef, useState } from "react";

export function InlineRename({
  value,
  onCommit,
  label,
  className,
}: {
  /**
   * The name **as displayed**, which is what the field edits.
   *
   * Reported from use: a scratch session showed `Scratch session` in the row but opened `s1` in the field,
   * because the caller passed the raw `session.name` and a separate display value. Two values for one name is the
   * defect — the reader was shown one thing and invited to edit another.
   *
   * Passing the display value has a consequence worth stating, because it is the reason this is safe: an
   * UNCHANGED commit compares against what is on screen, so accepting `Scratch session` unchanged sends nothing.
   * That keeps #78's decision intact — a default label cannot be silently promoted into a real name, which would
   * give every scratch session the same literal title again.
   */
  value: string;
  /** Receives the trimmed name, only when it differs from `value`. */
  onCommit: (name: string) => void;
  /** The accessible name of the input while editing. */
  label: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus and select on entering edit mode, so the common case is "type the new name" rather than
  // "select all, then type". `useEffect` rather than an autoFocus attribute: the element mounts inside a
  // component that may already have focus, and selecting after mount is what makes it usable.
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

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`inline-rename${className === undefined ? "" : ` ${className}`}`}
        aria-label={label}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
          // Name editing must not reach the window-level handlers: Escape is bound globally to close dialogs and
          // to stop a run, and a key pressed inside a form field is not a command for the rest of the app.
          event.stopPropagation();
        }}
        // A double-click inside the field would start a second edit on the text; the field is already the editor.
        onDoubleClick={(event) => event.stopPropagation()}
      />
    );
  }

  return (
    <span
      className={className}
      onDoubleClick={(event) => {
        // The header and the rail row both sit inside clickable surfaces. Editing is the more specific intent,
        // so it claims the event before the row treats it as "focus this session".
        event.stopPropagation();
        setDraft(value);
        setEditing(true);
      }}
      title="Double-click to rename"
    >
      {value}
    </span>
  );
}
