/**
 * The queued prompts: how much of them the dock shows, and what clears them.
 *
 * ## The defect this exists to fix
 *
 * The composer's dock rendered a row per queued message. Its height was therefore a function of **N**, and because the
 * transcript's scroller is a flex sibling above it, every queued item re-shrunk the conversation — a reader pinned to
 * the tail was moved up the page again for each message they queued. Reported as *"it changes the canvas of the
 * transcript… it pushes the steering line to the top"*.
 *
 * The rail is therefore bounded by the number of GROUPS that are non-empty — zero, one or two rows — and never by the
 * number of messages. `queueRail` returns at most two rows whatever the count; the full list is a sheet.
 *
 * ## Why the arithmetic is here
 *
 * Same reason as `trace.ts` and `panel.ts`: this repository's component tests render to static HTML and run no
 * handlers, so a bound that lives inside a component is a bound no test can reach. The invariant that matters —
 * "the dock's height does not grow with the queue" — is only testable as arithmetic.
 */

/** Which of the two destinations a queued message has. The names match Pi's `streamingBehavior`. */
export type QueueKind = "steer" | "followUp";

export interface Queued {
  /** Messages delivered when the current turn's tools finish. Shown first, because they happen first. */
  steering: string[];
  followUp: string[];
  /** How many Pi says are queued. May exceed the texts, after a reconnect. */
  total: number;
  /**
   * Whether every text is accounted for.
   *
   * `false` does NOT mean "no texts" — `queuedMessages` reports it unless the texts account for the count, and a caller
   * that then hides all of them throws away the ones it has. The partial state below is the fix.
   */
  textsKnown: boolean;
}

/** One row of the rail: a group, its first message, and how many more follow in that group. */
export interface QueueRow {
  kind: QueueKind;
  /** The time-word that carries the meaning: `now` or `then`. Never abbreviated, never a glyph. */
  when: "now" | "then";
  /** The message shown, already collapsed to one line and clipped. */
  text: string;
  /** How many further messages in this group are not shown. */
  more: number;
  /** Parsed from the count alone, because the text was not sent with the reconnect. */
  unknown: boolean;
}

export interface Rail {
  rows: QueueRow[];
  /** Messages Pi counts but whose texts are not available. Named rather than invented. */
  unknownCount: number;
  /** The whole queue, for the trigger's label. */
  total: number;
}

/** A one-line rendering of a message, whatever it actually contains. */
export function railText(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // An empty or whitespace-only message is still a queued message. Said plainly rather than rendered as a gap, which
  // would look like a rendering fault.
  if (flat.length === 0) return "(empty message)";
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The rail: at most ONE row per non-empty group.
 *
 * Two rows maximum, always. That is the whole point — the dock's height is a function of how many KINDS are queued,
 * not of how many messages are, so queueing a tenth message changes nothing on screen.
 */
export function queueRail(queue: Queued): Rail {
  const rows: QueueRow[] = [];
  const group = (kind: QueueKind, texts: readonly string[]): void => {
    if (texts.length === 0) return;
    rows.push({
      kind,
      when: kind === "steer" ? "now" : "then",
      // `?? ""` rather than a non-null assertion: a malformed record must not crash a rail.
      text: railText(texts[0] ?? ""),
      more: texts.length - 1,
      unknown: false,
    });
  };
  // Steering first, because it happens first.
  group("steer", queue.steering);
  group("followUp", queue.followUp);

  const known = queue.steering.length + queue.followUp.length;
  // The count may exceed what arrived with a reconnect. Named, never invented — and never allowed to add a third row.
  const unknownCount = Math.max(0, queue.total - known);

  return { rows, unknownCount, total: queue.total };
}

/**
 * The sheet's opening sentence.
 *
 * "1 steers this run; 5 run after it finishes." — the arithmetic stated in words, because the whole confusion being
 * fixed is that readers cannot tell the two kinds apart. Counts come from Pi, never from the texts, so this sentence is
 * correct even when the texts are missing.
 */
export function queueSummary(queue: Queued): string {
  const steering = queue.steering.length;
  const followUp = queue.followUp.length;
  const known = steering + followUp;

  if (known === 0 && queue.total > 0) {
    const n = queue.total;
    return `${n} queued message${n === 1 ? "" : "s"}, queued before this page loaded.`;
  }
  const parts: string[] = [];
  if (steering > 0) parts.push(`${steering} steers this run`);
  if (followUp > 0) parts.push(`${followUp} run${followUp === 1 ? "s" : ""} after it finishes`);
  const sentence = parts.join("; ");
  const unknown = queue.total - known;
  // The remainder is ADDED, not substituted: what is known is still true and still worth stating.
  if (unknown > 0) return `${sentence}. ${unknown} more ${unknown === 1 ? "was" : "were"} queued before this page loaded.`;
  return `${sentence}.`;
}

/**
 * What Escape does, in one place.
 *
 * `DESIGN.md` §4.3's ladder, with the queue sheet as step 2 — which until now had no subscriber at all, so a popover
 * could only be closed with Escape if some other handler happened to swallow it. Stated as data because two components
 * act on Escape (the sheet and the composer) and a ladder implemented twice is a ladder that drifts.
 */
export type EscapeAction = "close-sheet" | "close-picker" | "clear-and-stop" | "noop";

export function escalation({
  sheetOpen,
  pickerOpen = false,
  streaming,
}: {
  sheetOpen: boolean;
  /**
   * The `@` picker is open.
   *
   * A NEW STEP, and it goes ABOVE the sheet: a picker is the most recently opened surface, sits on top of everything, and
   * closing it must not stop a run. Placed here rather than handled ad hoc in the composer for the reason this function
   * exists — a ladder written in two places drifts, and the drift is invisible until someone presses Escape twice in the
   * wrong order.
   */
  pickerOpen?: boolean;
  streaming: boolean;
}): EscapeAction {
  // 1. A dialog open is handled by the dialog dock, which stops propagation before this runs.
  // 2. A popover open closes only itself. The run and the queue are untouched — pressing Escape twice is the reader's
  //    way to say "now the other thing", and the queue is recoverable because its texts return to the composer.
  if (pickerOpen) return "close-picker";
  if (sheetOpen) return "close-sheet";
  // 3. Streaming: clear the queue and stop the run.
  if (streaming) return "clear-and-stop";
  // 4. Nothing to do. The draft is never touched.
  return "noop";
}
