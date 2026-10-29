/**
 * What the transcript should do when the session changes (issues #80 and #86).
 *
 * ## The bug this exists to fix, told once
 *
 * `TranscriptView` held `pinned` — "am I following the tail?" — as a single component-level value,
 * and never recorded the scroll offset at all. Because one component serves every session:
 *
 *   - **reading position leaked between sessions** (#80): scrolling up in one session left the next
 *     one un-pinned, so its content appeared wherever the old offset clamped;
 *   - **and nothing re-armed it on send** (#86): after any scroll, following stayed off — including
 *     right after you submit a prompt, which is precisely when you expect the reply to scroll in.
 *
 * Both are the same defect seen from two sides, so they are one change: keep the state **per
 * session**, and re-arm it on send. Fixing either alone leaves the other half in place.
 *
 * ## Why the decision is a pure function
 *
 * Like `panel.ts`, this is arithmetic-adjacent logic that a React component cannot be exercised for
 * here — this repository's component tests render to static HTML and run no effects. The rule itself
 * is one judgement call (*what does a session I have never opened do?*), so it lives where it can be
 * tested rather than inline.
 */

/** Where a session's transcript was left, per session id. */
export interface SessionScroll {
  scrollTop: number;
  /** Was the reader following the tail when they left? */
  pinned: boolean;
}

/** What to do when the focused session becomes `sessionId`. */
export type ScrollDecision =
  | { kind: "follow-end" }
  | { kind: "restore"; scrollTop: number; pinned: boolean };

/**
 * The one judgement: a session the reader has never opened opens at the **end**.
 *
 * Following the newest content is what a reader arriving wants, and it is what a live session needs
 * — an agent may have produced a great deal since the last look. Restoring a position only makes
 * sense for a session they actually read and left.
 *
 * A stored entry is trusted as-is. `scrollTop` is clamped by the browser to whatever the new content
 * allows, so a session that has since grown or shrunk lands at a sane place without this function
 * having to know anything about the content's height.
 */
export function decideOnSessionChange(previous: SessionScroll | undefined): ScrollDecision {
  if (previous === undefined) return { kind: "follow-end" };
  return { kind: "restore", scrollTop: previous.scrollTop, pinned: previous.pinned };
}

/**
 * Is there anything to scroll yet?
 *
 * The reason a restore cannot simply be applied on mount. The pane mounts the moment the session is
 * focused, but its history is **fetched** — so for the first frames the container is empty and
 * `scrollTop = 412` is silently clamped to `0`. Applying the restore then would land the reader at
 * the top of the transcript, which is precisely the bug this work exists to fix, and it would look
 * like the feature simply did not work.
 *
 * So the offset is held until the content can accept it. `scrollHeight <= clientHeight` means the
 * content fits and there is no position to restore, which is also the right moment to stop waiting.
 */
export function hasScrollableContent(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight > clientHeight;
}

/** One measurement of a scrolled container. */
export interface ScrollSample {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * How far the reader is from the bottom, with **content growth discounted**.
 *
 * ## Why the discount is the whole point
 *
 * Following a stream means scrolling the container to the bottom over and over while output arrives.
 * The naive rule — "if the distance from the bottom exceeds a threshold, the reader has scrolled
 * away" — cannot tell the two apart, because **both** change that distance:
 *
 *   - the reader scrolling up, and
 *   - the agent appending output.
 *
 * So the naive rule un-follows the reader every time output outruns the scroll, which is exactly the
 * reported symptom: *"it jumps to the latest output after submitting a prompt, but then does not
 * follow"*. The measurement is taken in a scroll event, which arrives **after** the browser has
 * painted whatever arrived in the meantime — so the distance it sees includes growth the reader never
 * asked for.
 *
 * Subtracting the growth since the previous sample leaves the part of the distance the READER is
 * responsible for. Growth alone discounts to zero; a genuine scroll up survives.
 *
 * Growth is clamped at zero so a shrinking container (a collapsed trace, a session switch) does not
 * invent a negative discount.
 */
export function readerDistanceFromTail(previous: ScrollSample, current: ScrollSample): number {
  const grew = Math.max(0, current.scrollHeight - previous.scrollHeight);
  const distance = current.scrollHeight - current.scrollTop - current.clientHeight;
  return distance - grew;
}

/**
 * Is the reader still following the tail?
 *
 * The threshold is `FOLLOW_THRESHOLD_PX`'s job in the component; this is the rule without the
 * number, so the two can be tested apart.
 */
export function isFollowing(previous: ScrollSample, current: ScrollSample, threshold: number): boolean {
  return readerDistanceFromTail(previous, current) < threshold;
}

/**
 * Is this a real measurement?
 *
 * jsdom reports `0` for every scroll metric, and so does a pane that has not been laid out or is
 * hidden. Such a sample must never become the "previous" one, because the discount is a subtraction:
 * `0` to `2000px` of content reads as two thousand pixels of GROWTH, which cancels out the reader's
 * entire distance from the bottom and pins them to a transcript they had scrolled away from.
 *
 * That is not hypothetical — it broke three DOM tests the moment the discount was introduced, and it
 * would have looked, in a browser, like the "Jump to latest" button never appearing.
 */
export function isMeasured(sample: ScrollSample): boolean {
  return (
    Number.isFinite(sample.scrollTop) &&
    Number.isFinite(sample.scrollHeight) &&
    Number.isFinite(sample.clientHeight) &&
    sample.scrollHeight > 0 &&
    sample.clientHeight > 0
  );
}

/**
 * Should the transcript scroll itself to the tail on this render?
 *
 * Two conditions, and both are needed:
 *
 *   - `autoFollow` — the reader's own setting (#86). Someone who reads at their own pace should not
 *     have to keep proving it by scrolling; a reader who never wants to be moved turns it off and the
 *     transcript never moves on its own again. The explicit *Jump to latest* still works, because
 *     that is them asking.
 *   - `pinned` — they are already at the bottom (#80/#86). Auto-scrolling a reader who has scrolled up
 *     to read something is the most common failure of a streaming transcript.
 */
export function shouldFollow(autoFollow: boolean, pinned: boolean): boolean {
  return autoFollow && pinned;
}

/**
 * The trace's per-session view state (issue #108).
 *
 * ## Why this is persisted at all
 *
 * The report is precise: *"when I have my tool window collapsed and I return to the session, the tool
 * window opens again"* — and *"it should survive restarts"*. Both halves come from the same mistake:
 * the state lived in `SessionView`, which carries `key={focused?.id}` and therefore **remounts on every
 * session switch**, resetting to the default. Lifting it to `App` fixes the first; persisting it fixes
 * the second.
 *
 * ## Why the validation is this paranoid
 *
 * `localStorage` outlives upgrades and is shared with whatever else runs on this origin. A stored value
 * may be a string, an array, a half-written object from a crash, or a map naming sessions that no longer
 * exist. None of those is worth a broken render, so anything unrecognised is dropped rather than trusted
 * — and a stale session id is harmless because the map is only ever read by id.
 */
export const TRACE_PREFS_KEY = "pi-central.trace";

/** Keep only `string -> boolean` entries; everything else is discarded. */
function booleanRecord(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") out[key] = entry;
  }
  return out;
}

/** Read the persisted trace preferences. Never throws; absent or corrupt means empty. */
export function readTracePrefs(): { collapsed: Record<string, boolean>; markers: Record<string, boolean> } {
  try {
    const raw = localStorage.getItem(TRACE_PREFS_KEY);
    if (raw === null || raw === "") return { collapsed: {}, markers: {} };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { collapsed: {}, markers: {} };
    const record = parsed as Record<string, unknown>;
    return { collapsed: booleanRecord(record["collapsed"]), markers: booleanRecord(record["markers"]) };
  } catch {
    // Storage disabled, or an opaque origin. A preference that is not remembered is not an error.
    return { collapsed: {}, markers: {} };
  }
}

/** Write the persisted trace preferences. Silent on failure, for the same reason as `readTracePrefs`. */
export function writeTracePrefs(prefs: {
  collapsed: Record<string, boolean>;
  markers: Record<string, boolean>;
}): void {
  try {
    localStorage.setItem(
      TRACE_PREFS_KEY,
      JSON.stringify({ collapsed: prefs.collapsed, markers: prefs.markers }),
    );
  } catch {
    // Full or disabled. Losing a remembered toggle is not worth failing a render over.
  }
}
