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
import { useEffect, useRef } from "react";
import { scrollToShow, type Completion } from "../mentions.ts";

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
  const listRef = useRef<HTMLUListElement>(null);

  /**
   * Keep the selected row inside the list, scrolling the LIST and nothing else.
   *
   * ## The reported defect
   *
   * *"when the auto-complete helper is opened, the window shall scroll if users use the arrow keys to navigate the list down.
   * Otherwise the selected files / directories cannot be seen."* Correct: the list is capped at six rows and scrolls, but
   * nothing tied the SELECTION to the SCROLL — so arrowing past the sixth row moved the highlight to a row outside the box.
   * The picker looked frozen while Down kept being pressed, and "what will Enter accept?" had no visible answer.
   *
   * ## Why `scrollIntoView` is not used, and this is the important part
   *
   * `scrollIntoView` scrolls every scrollable ANCESTOR. Here that is the transcript — so a keystroke in a helper would jump
   * the whole reading area, which on a conversation pinned to the tail is a far worse bug than the one being fixed.
   *
   * Instead `scrollToShow` returns HOW FAR to move (or `undefined` when the row is already visible), and that number is
   * assigned to this list's own `scrollTop`. Arithmetic in `mentions.ts`, one assignment here.
   *
   * The effect depends on `selected` and the option count, not on the rows: the geometry is read at the moment the selection
   * changes, which is the only time it matters.
   */
  const optionCount = completions.length;
  useEffect(() => {
    const list = listRef.current;
    if (list === null || selected < 0 || selected >= optionCount) return;
    const row = list.children[selected] as HTMLElement | undefined;
    if (row === undefined) return;
    /*
     * `offsetTop` is measured from the nearest POSITIONED ancestor — and that is NOT the list.
     *
     * The DOM here is:
     *
     *     .mention            position: absolute   ← the offsetParent for everything inside it
     *       .mention-head       (the header, ~26px)
     *       .mention-list     overflow-y: auto, NOT positioned   ← the real scroll container
     *         li.mention-option
     *
     * So `row.offsetTop` is the distance from `.mention`'s top edge, which INCLUDES the header. Using it directly made
     * every row look ~26px further down than it was, and the failure was asymmetric — which is exactly how it was
     * reported: *"it works when traversing down, but not up."*
     *
     * Down happened to work because the same offset was added on both sides of the comparison, so the "scroll down" branch
     * was off by a constant that the reader could not see. Up did not, because "the row is above the band" was evaluated
     * against a position 26px too large — a row near the top looked comfortably visible when it was not, so it was never
     * scrolled to. Scrolling back to the first row settled on 24 rather than 0, leaving it under the header.
     *
     * The fix is to measure in the LIST's coordinate space: a row's position relative to the list is its distance from the
     * list's top edge, which is `offsetTop - list.offsetTop` when the two share an offsetParent.
     */
    const offsetParent = row.offsetParent;
    const rowTop = list.offsetParent === offsetParent ? row.offsetTop - list.offsetTop : row.offsetTop;
    const offset = scrollToShow(
      { top: rowTop, height: row.offsetHeight },
      { scrollTop: list.scrollTop, height: list.clientHeight },
      // The list's own vertical padding, so a row aligned to the edge is not flush against it and clipped-looking.
      2,
    );
    if (offset === undefined) return;
    list.scrollTop = offset;
  }, [selected, optionCount]);

  return (
    <div className="mention" role="presentation">
      {/*
        A SLIMMER HEADER, after a review called the first one overloaded.

        It carried a bare `.` on the left — which reads as a rendering fault rather than as a path — and four key hints on
        the right, at ~10px grey-on-dark, competing with the results they describe. Three changes:

          - the directory is LABELLED (`in .`), so a lone punctuation mark is not asked to mean "the session root";
          - the hints are trimmed to the keys that are not guessable: `↑↓` is visible from the list itself, `Esc` is
            universal, and "Tab or Enter" was two words for one affordance;
          - the MATCH COUNT takes the middle, which is the fact a reader of a filtered list actually wants and which the
            first version left out entirely.
      */}
      <div className="mention-head">
        <span className="mention-dir mono">in {directory.length === 0 ? "." : directory}</span>
        {completions.length > 0 && (
          <span className="mention-count">
            {completions.length} match{completions.length === 1 ? "" : "es"}
          </span>
        )}
        <span className="mention-hint">
          <kbd>↑</kbd>
          <kbd>↓</kbd> · <kbd>Tab</kbd> accept · <kbd>Esc</kbd> dismiss
        </span>
      </div>

      {completions.length > 0 ? (
        <ul className="mention-list" role="listbox" id="mention-options" aria-label="Files to mention" ref={listRef}>
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
