/**
 * How long ago something changed, in a form a reader does not have to decode (issue #76).
 *
 * ## Why the first version was wrong
 *
 * It returned `4m`, `2d`, `2w`, `5d` — and a screenshot reviewer said what a reader would say: *"users will not
 * understand the sorting like presented here"*. `4m` is four minutes or four months; `2w` needs a pause. Compression is
 * only worth paying for when the reader already knows the unit, and in a folder list they do not.
 *
 * So the units are written out. It costs about 2 characters per row and removes the whole class of misreading — and the
 * column is labelled "Modified" beside it, which is the other half of the answer (a bare `4m` is cryptic even when it is
 * unambiguous; under a "Modified" header it is a fact).
 *
 * ## Recent days are relative, older things are dates
 *
 * This is what macOS Finder and Windows Explorer both do, and the reason is that "2 d" answers a question ("did I touch
 * this recently?") that "31 Oct" does not, while "11 months ago" is harder to place than a date. The crossover is a
 * month: inside it the interval is the useful fact, beyond it the date is.
 */
export function ageOf(mtimeMs: number, now: number = Date.now()): string {
  /*
   * Clamped at zero, and that is a decision rather than defensive noise. Two machines can disagree about the clock, and
   * a file server a minute ahead would otherwise render `-0 min` — which reads as a bug in the app rather than as skew
   * between two clocks.
   */
  const seconds = Math.max(0, Math.round((now - mtimeMs) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} d`;
  return dateOf(mtimeMs, now);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A date, without the year when this year is implied.
 *
 * `12 Oct` for the current year and `12 Oct 2025` otherwise: a year in every row is noise when almost every row is from
 * this one, and omitting it when it differs would be a small lie. UTC is NOT used — a folder's mtime is local time to
 * the person reading it, and a date that shifts by a day depending on the reader's timezone is worse than one that
 * rounds.
 */
export function dateOf(mtimeMs: number, now: number = Date.now()): string {
  const then = new Date(mtimeMs);
  const base = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
  return then.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${then.getFullYear()}`;
}
