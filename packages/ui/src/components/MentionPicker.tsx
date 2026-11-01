/**
 * The `@path` picker, anchored under the composer's field.
 *
 * ## Why a listbox rather than a menu
 *
 * It is a text-completion affordance, so it has to work without a pointer and without leaving the field: the reader is
 * mid-sentence and the caret must stay where it is. `<ul role="listbox">` with `aria-activedescendant` is the shape that
 * expresses "the focus is still in the input, and one option is current" — a real menu would move focus out of the field
 * and take the caret with it.
 *
 * The input owns the keyboard (see `Composer`), so this component is presentational: it renders what it is given and
 * reports clicks. That is also why it holds no open/closed state — the mention decides whether it exists.
 *
 * ## The two empty states, which are different facts
 *
 *   - the directory is not loaded yet → `Reading…`, because something is coming
 *   - the directory is loaded and nothing matches → `No match`, because nothing is coming and the reader should keep
 *     typing rather than wait
 *
 * Collapsing them is the defect `files.ts` was written to prevent: an empty list where the truth is "loading" tells the
 * reader to give up.
 */
import type { Completion } from "../mentions.ts";

export function MentionPicker({
  directory,
  completions,
  loading,
  selected,
  onChoose,
}: {
  /** The directory being listed, for the header. `""` is the session root, shown as `.`. */
  directory: string;
  completions: readonly Completion[];
  /** True when the listing has been requested and not answered. */
  loading: boolean;
  /** The current option's index, owned by the composer so the arrow keys and the highlight cannot disagree. */
  selected: number;
  onChoose: (completion: Completion) => void;
}) {
  return (
    <div className="mention" role="presentation">
      <div className="mention-head">
        <span className="mention-dir mono">{directory.length === 0 ? "." : directory}</span>
        <span className="mention-hint">
          <kbd>↑</kbd>
          <kbd>↓</kbd> choose · <kbd>Tab</kbd> or <kbd>Enter</kbd> accept · <kbd>Esc</kbd> dismiss
        </span>
      </div>

      {completions.length > 0 ? (
        <ul className="mention-list" role="listbox" id="mention-options" aria-label="Files to mention">
          {completions.map((completion, index) => (
            <li
              key={completion.value}
              id={`mention-option-${index}`}
              role="option"
              /*
               * `aria-selected` rather than an `aria-checked`: these are options in a list, one of which is current. The
               * highlight is a class as well, because colour alone is not a state a reader can see, and `role="option"`
               * does not convey the highlight to assistive tech on its own.
               */
              aria-selected={index === selected}
              className={`mention-option${index === selected ? " is-selected" : ""}${completion.continues ? " is-dir" : ""}`}
              /*
               * `onMouseDown` rather than `onClick`, and `preventDefault` inside it.
               *
               * A click would fire AFTER the field has lost focus, and the blur handler closes the picker — so the click
               * would land on nothing. Pressing the mouse down and cancelling the default keeps the caret in the field
               * and makes the pointer behave exactly like Tab.
               */
              onMouseDown={(event) => {
                event.preventDefault();
                onChoose(completion);
              }}
            >
              <span className="mention-name mono">{completion.label}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mention-empty" role="status">
          {loading ? "Reading…" : "No match"}
        </p>
      )}
    </div>
  );
}
