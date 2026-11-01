/**
 * The queued prompts, as a grouped list. This component has NO position of its own.
 *
 * ## Why it is positionless
 *
 * The queue answers a gesture made in the composer, so its natural home is beside the field. But three hundred pixels
 * of permanently docked column for what is most often one row is more surface than the information warrants, and the
 * right panel defaults to hidden. So the LIST is built here, and where it appears is decided by whoever hosts it —
 * today a sheet, later a `Queued` panel tab if that turns out to be better. A component that knew its own position
 * would make that a rewrite instead of a ten-line change.
 *
 * ## The visual language, and why each part of it exists
 *
 * The reported problem was *"users have no idea which prompts are steering prompts and which ones are follow ups"* —
 * a typographic problem, so it is fixed typographically rather than with a control:
 *
 *   1. a TIME-WORD gutter: `now` for steering, `then` for follow-up. Words survive grayscale, `forced-colors` and a
 *      screen reader, and they are the primary carrier;
 *   2. ORDER, with a ruled divider labelled `After this run finishes` — steering happens first, so it is listed first;
 *   3. a left edge: solid for `now`, dashed for `then`. Solid is happening, dashed is pending.
 *
 * Three independent carriers, so removing any one of them loses nothing. No colour is relied on, and there are no
 * ordinals: nothing here can be reordered or removed, so a number would be decoration in the place the brief asks for
 * less.
 */
import type { Queued } from "../queue.ts";
import { railText } from "../queue.ts";

/**
 * How much of one message to show before asking.
 *
 * A queued prompt is a sentence or two, so most fit whole. One that does not is clamped rather than shown as a wall:
 * the reader is looking for which message is which, not to re-read it — and the full text is in the field's history
 * once it runs.
 */
const CLAMP_LINES = 8;

export function QueuedPrompts({
  queue,
  onClearQueueAndStop,
  onClose,
}: {
  queue: Queued;
  /** The ONE queue-mutating action. It clears everything and stops the run, because that is what the protocol offers. */
  onClearQueueAndStop: () => void;
  /** Close the surface. Esc does the same thing; the label states it. */
  onClose: () => void;
}) {
  const known = queue.steering.length + queue.followUp.length;
  const unknown = Math.max(0, queue.total - known);

  return (
    <div className="queue-prompts">
      {/*
        The grouping is the headline, so it is stated in words before any row is read. Counts come from Pi, so this
        sentence is true even when the texts are missing.
      */}
      <p className="queue-summary">{summary(queue)}</p>

      {queue.steering.length > 0 && (
        <section className="queue-group" aria-label="Steering this run">
          <h4 className="queue-group-head">
            <span className="queue-when">now</span>
            <span>Delivered when the current tool calls finish</span>
          </h4>
          <ol className="queue-list">
            {queue.steering.map((text, index) => (
              <li key={`s${index}`} className="queue-item is-steer">
                <span className="queue-item-when" aria-hidden="true">now</span>
                <span className="queue-item-text">{clamped(text)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {queue.followUp.length > 0 && (
        <section className="queue-group" aria-label="Runs after this one finishes">
          <h4 className="queue-group-head">
            <span className="queue-when">then</span>
            <span>Starts after this run finishes</span>
          </h4>
          <ol className="queue-list">
            {queue.followUp.map((text, index) => (
              <li key={`f${index}`} className="queue-item is-follow-up">
                <span className="queue-item-when" aria-hidden="true">then</span>
                <span className="queue-item-text">{clamped(text)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/*
        Texts that were never sent. Named, never invented — a placeholder row would be a fabricated claim about what the
        reader asked for, in the one list whose whole job is to say what they asked for.
      */}
      {unknown > 0 && (
        <p className="queue-unknown">
          {`${unknown} more ${unknown === 1 ? "was" : "were"} queued before this page loaded, so the text is not here. `}
          Clearing the queue returns it to the box below, where you can read it.
        </p>
      )}

      <footer className="queue-foot">
        {/*
          The reason there is no per-item control, stated rather than implied. Without the sentence, a read-only list
          reads as a list that is missing its controls.
        */}
        <p className="queue-note">Read-only: Pi Central can clear the whole queue, not one message.</p>
        <div className="queue-actions">
          <button type="button" className="btn-quiet queue-clear" onClick={onClearQueueAndStop}>
            Clear queue and stop run
          </button>
          <button type="button" className="btn-quiet queue-close" onClick={onClose}>
            Close <kbd>Esc</kbd>
          </button>
        </div>
      </footer>
    </div>
  );
}

/** The opening sentence: the arithmetic in words, before any row is read. */
function summary(queue: Queued): string {
  const { steering, followUp } = queue;
  const known = steering.length + followUp.length;
  if (known === 0 && queue.total > 0) {
    return `${queue.total} queued message${queue.total === 1 ? "" : "s"}.`;
  }
  const parts: string[] = [];
  if (steering.length > 0) parts.push(`${steering.length} steers this run`);
  if (followUp.length > 0) parts.push(`${followUp.length} run${followUp.length === 1 ? "s" : ""} after it finishes`);
  return `${parts.join("; ")}.`;
}

/**
 * One queued message, clamped.
 *
 * `railText` collapses the whitespace and the empty case; the clamp here is about LINES, because a 2000-character
 * message in a popover is a wall even when it is one paragraph. A `<details>` would put the full text behind another
 * gesture, which is one too many inside a surface that is already one gesture deep.
 */
function clamped(text: string): string {
  const flat = text.trim();
  if (flat.length === 0) return "(empty message)";
  const lines = flat.split("\n");
  if (lines.length <= CLAMP_LINES && flat.length <= 900) return flat;
  const shown = lines.slice(0, CLAMP_LINES).join("\n");
  const total = lines.length > CLAMP_LINES ? `${lines.length} lines` : `${flat.length} characters`;
  return `${shown}\n\n… ${total} in all. Clearing the queue returns it to the box, where it can be read in full.`;
}

// Re-exported for the rail's one-line rendering, so the two surfaces clip messages the same way.
export { railText };
