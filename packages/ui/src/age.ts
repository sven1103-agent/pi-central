/**
 * How long ago something changed, in the shortest form that is still useful (issue #76).
 *
 * Lives in its own module rather than inside `DirectoryChooser.tsx` for the reason `panel.ts` records: the component
 * tests render static markup and run no handlers, so arithmetic inside a component is arithmetic no test can see.
 * Here it is a pure function with a `now` parameter, and a `.ts` file the test runner can import directly.
 *
 * Coarse on purpose: "3d" answers "is this the folder I touched this week", and second-level precision in a directory
 * list is noise. Over a year it degrades to years, because that is the only distinction left worth making.
 */
export function ageOf(mtimeMs: number, now: number = Date.now()): string {
  /*
   * Clamped at zero, and that is a decision rather than defensive noise. Two machines can disagree about the clock, and
   * a file server a minute ahead would otherwise render `-0m ago` — which reads as a bug in the app rather than as
   * skew between two clocks.
   */
  const seconds = Math.max(0, Math.round((now - mtimeMs) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(days / 365)}y`;
}
