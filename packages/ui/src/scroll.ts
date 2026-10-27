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
