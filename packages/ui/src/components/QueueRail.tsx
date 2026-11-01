/**
 * The queue rail: at most two rows, between the scroller and the field.
 *
 * ## The invariant it exists to hold
 *
 * The composer's dock used to render a row per queued message, so its height was a function of N and the transcript's
 * scroller re-shrank on every queue. The rail is bounded by the number of GROUPS instead: one row for steering, one for
 * follow-ups, and a `+N more` on each. Queueing a tenth message changes NOTHING here.
 *
 * That is asserted as arithmetic in `queue.test.ts` rather than trusted, and `invariants.test.ts` forbids any other
 * component from enumerating the queue — a component that cannot map over `.steering` cannot grow the dock.
 *
 * ## Why it shows a row at all, rather than just a count
 *
 * The complaint was that readers cannot tell steering from follow-up. A count makes that worse at rest, because at rest
 * nothing is a steering prompt. So the rail shows one representative of each kind, with its time-word — enough to answer
 * "what is waiting, and in which of the two ways" without opening anything.
 */
import type { Queued, Rail } from "../queue.ts";
import { queueRail } from "../queue.ts";

export function QueueRail({
  queue,
  onOpenSheet,
}: {
  queue: Queued;
  /** Open the full list. The rail is a summary; this is the way to the rest. */
  onOpenSheet: () => void;
}) {
  const rail: Rail = queueRail(queue);
  /*
   * Nothing to say. Rendered only when there is something queued: a permanent empty rail would be a row of chrome that
   * exists to announce that there is no news.
   */
  if (rail.total === 0) return null;

  const more = rail.rows.reduce((sum, row) => sum + row.more, 0) + rail.unknownCount;

  return (
    <div className="queue-rail">
      <ul className="queue-rail-rows">
        {rail.rows.map((row) => (
          <li key={row.kind} className={`queue-rail-row is-${row.kind}`}>
            {/*
              The time-word is real text, not a glyph and not `aria-hidden`: it is the primary carrier of which kind this
              is, so a screen reader must hear it and a grayscale rendering must show it.
            */}
            <span className="queue-when">{row.when}</span>
            <span className="queue-rail-text">{row.text}</span>
          </li>
        ))}
        {rail.rows.length === 0 && (
          /*
            Counted but not readable: the reconnect delivered the number and not the texts. Said plainly rather than
            rendered as rows, because an invented row is a fabricated claim about what the reader asked for.
          */
          <li className="queue-rail-row is-unknown">
            <span className="queue-when" aria-hidden="true">…</span>
            <span className="queue-rail-text">
              {`${rail.total} queued before this page loaded`}
            </span>
          </li>
        )}
      </ul>

      {/*
        The trigger. One control for the whole rail, so there is one tab stop rather than one per row, and its label
        states what it opens rather than naming a component.
      */}
      <button
        type="button"
        className="queue-rail-open"
        onClick={onOpenSheet}
        aria-haspopup="dialog"
        title="Show every queued message"
      >
        {more > 0 && <span className="queue-rail-more">{`+${more} more`}</span>}
        <span className="queue-rail-open-label">Show queue</span>
      </button>
    </div>
  );
}
