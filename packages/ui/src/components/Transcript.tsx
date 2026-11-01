/**
 * The transcript pane.
 *
 * **Prose first, then the work as ONE group.** The conversation is what a reader follows; tools are
 * evidence. The version before last rendered every tool call AFTER every message, so a real session put
 * 1138 frames below the conversation and the agent's actual output became unfindable. The version before
 * THIS one grouped tools but still gave every `thinking` block its own top-level bar and every
 * thinking-only message its own `Assistant` heading, so a run of internal steps rendered as
 * `Assistant · [Thinking] · 1 tool · Assistant · [Thinking] · …` with every row already collapsed
 * (`img_18.png`).
 *
 * So the unit is now ACTIVITY, planned in `activity.ts`: a contiguous stretch of thinking and tool work
 * between two spans of real prose is one disclosure, and the host owns whether it is open so the answer
 * survives a session switch. Opening it shows the recorded steps in order, each tool call with its
 * arguments, capped output and full result behind a second disclosure.
 *
 * Two accessibility rules, both deliberate:
 *
 * 1. **No live region on the streaming tail.** Announcing per delta would emit hundreds of
 *    utterances per turn.
 * 2. **`aria-busy` while streaming**, so assistive tech does not read a half-written subtree.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Transcript as TranscriptModel } from "../transcript.ts";
import type { TranscriptMessage } from "../transcript.ts";
import { imageKey } from "../transcript.ts";
import { previewsFor } from "../references.ts";
import { fileAt, type FileState } from "../files.ts";
import { messageImages, messageTexts, planEntries, showActivity, type PlannedEntry } from "../activity.ts";
import { MessageBody } from "./MessageBody.tsx";
import { TranscriptImage } from "./TranscriptImage.tsx";
import { ReferencePreview } from "./ReferencePreview.tsx";
import { ActivityGroup } from "./ActivityGroup.tsx";
import {
  decideOnSessionChange,
  hasScrollableContent,
  isFollowing,
  isMeasured,
  shouldFollow,
  type ScrollSample,
  type SessionScroll,
} from "../scroll.ts";
import { RunNotices } from "./RunNotices.tsx";
import { FollowToggle } from "./FollowToggle.tsx";

/**
 * How close to the bottom still counts as "following the tail".
 *
 * A tolerance rather than equality because a fractional `scrollTop` (zoom, a device pixel ratio,
 * a smooth scroll in flight) puts the arithmetic a pixel or two off the true bottom forever; with
 * `=== 0` the app would silently stop following at random. 80px is also roughly one line of prose
 * plus a marker, so nudging the wheel without meaning to scroll does not unpin.
 */
export const FOLLOW_THRESHOLD_PX = 80;

/**
 * Whether a scrolled container is close enough to the end to keep following it.
 *
 * Pure and exported so the rule is testable without a layout engine. jsdom reports every
 * element's `scrollHeight`, `scrollTop` and `clientHeight` as 0, so a test that had to drive the
 * real event would be asserting on a DOM that cannot scroll — which is how `"at the bottom"`
 * would pass for the wrong reason. The component and the test therefore share this one function.
 *
 * `clientHeight === 0` means the container has not been laid out (or is hidden). That is reported
 * as pinned: an unmeasured box must not throw a "jump to latest" control onto the screen.
 */
export function isAtBottom(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = FOLLOW_THRESHOLD_PX,
): boolean {
  const { scrollHeight, scrollTop, clientHeight } = metrics;
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(scrollTop) || !Number.isFinite(clientHeight)) {
    return true;
  }
  if (clientHeight <= 0) return true;
  return scrollHeight - scrollTop - clientHeight < threshold;
}

export function TranscriptView({
  initialScroll,
  onScrollMemory,
  transcript,
  busy,
  sessionId,
  preview,
  previews,
  sessionLabel,
  followToken = 0,
  autoFollow = true,
  expectedCount = 0,
  loading = false,
  onOpenTool,
  showMarkers = true,
  activityOpen = {},
  onToggleActivity = () => {},
  onToggleAutoFollow,
  header,
  footer,
  historyError,
}: {
  /**
   * Where this session's transcript was left, if it has been read before (#80).
   *
   * Owned by `App`, NOT by this component, and that is forced by the shell: `SessionView` carries
   * `key={focused?.id}`, so it — and this pane inside it — **remounts on every session switch**. A
   * store kept here would be destroyed at exactly the moment it is needed. So the memory lives above
   * the remount boundary and is handed in.
   */
  initialScroll?: SessionScroll | undefined;
  /** Report the position back, so the owner can remember it for this session. */
  onScrollMemory?: (state: SessionScroll) => void;
  transcript: TranscriptModel;
  busy: boolean;
  /**
   * Which session this transcript belongs to.
   *
   * Required rather than optional, because it is half of an image's identity (`imageKey`) and a default would have to
   * be invented. The reason it cannot be inferred from the transcript is that message ids are minted per transcript by
   * counting — every session has an `m0` — so a cache keyed without it would show one session another's screenshot.
   */
  sessionId: string;
  /**
   * Ask for an image a turn names by path, so the turn can preview it.
   *
   * Called from an effect rather than during render, because it dispatches: rendering must stay a pure function of
   * state. The receiver is expected to ignore a path it already knows, so a repeated call is cheap.
   */
  preview?: ((path: string) => void) | undefined;
  /**
   * What is known about each named image.
   *
   * Absent means the caller does not preview references at all — the correct behaviour for an embedding with no
   * filesystem access behind it, where showing "Reading…" would be a permanent promise nobody would keep.
   */
  previews?: ((path: string) => FileState) | undefined;
  sessionLabel: string;
  /**
   * Changes when the reader sends a prompt, which re-arms following (#86).
   *
   * Sending is an act: you want to watch the reply. Without this, any earlier scroll left the reader
   * un-pinned for ever, so the answer arrived off-screen — the reported symptom.
   */
  followToken?: number;
  /**
   * Whether the transcript scrolls itself to new output (#86).
   *
   * False means it never moves on its own, whatever the scroll position. The explicit *Jump to
   * latest* still works: that is the reader asking.
   */
  autoFollow?: boolean;
  /**
   * How many messages Pi says the session has.
   *
   * Passed so the empty state cannot CONTRADICT the header. A screenshot once showed
   * `634 msgs` in the header and "No messages yet." underneath — both from real data, and
   * visibly disagreeing. An empty transcript with a non-zero count is history that has not
   * arrived, not an empty session.
   */
  expectedCount?: number;
  /** True once the session is up and its history has been requested. */
  loading?: boolean;
  onOpenTool?: (toolCallId: string) => void;
  /**
   * Whether activity groups are shown at all.
   *
   * The old control was `showMarkers` — "position markers for tool work", which is still what this
   * means: OFF is pure reading, and the trace panel remains the way to reach what ran. It is NOT a way
   * to hide failures: an activity group carrying a failed call, or one still running, is always
   * rendered, because the one line that needs attention cannot be behind a preference.
   */
  showMarkers?: boolean;
  /**
   * Which activity groups the reader has opened, by group key.
   *
   * Owned by the HOST, not by this pane: `SessionView` remounts per session (`key={focused?.id}`), so a
   * store here would be destroyed exactly when the reader comes back — the defect #108 reported for the
   * trace window, one level down. A group's key is derived from its first recorded part, so it is stable
   * across deltas, tool arrivals and streaming.
   */
  activityOpen?: Record<string, boolean>;
  onToggleActivity?: (key: string, open: boolean) => void;
  /**
   * Turn automatic following of new output on or off.
   *
   * Owned by `App` (the preference is app-wide, not per transcript), rendered here because the scroller's top
   * edge is where the behaviour it controls is visible. Omitted means no control — an embedding with no opinion
   * about following does not get a dead button.
   */
  onToggleAutoFollow?: (() => void) | undefined;
  /**
   * The composer (or the dialog dock that replaces it), rendered at the foot of the transcript.
   *
   * A slot rather than the component itself: this pane is about reading and scrolling, and it should not know
   * about prompts, queues or steering. `App` decides what occupies the Foot.
   */
  footer?: React.ReactNode;
  /**
   * The focused session's header.
   *
   * A SLOT, and placed by the transcript rather than by the shell, because the right placement depends on how much
   * room the transcript has. On a wide column it floats at the top right of the reading area as a companion to the
   * conversation — the review's point was that a full-width band above it reads as window chrome rather than as
   * something belonging to the session. Narrow, there is no room beside the prose, so it becomes a compact row above
   * the scroller.
   *
   * `container-type: inline-size` on this region is what makes that a container query rather than a guess about the
   * window: the same window can hold a wide transcript or a narrow one, depending on the panel.
   */
  header?: React.ReactNode;
  /**
   * Why the conversation could not be read, if it could not be.
   *
   * Passed so the pane can stop claiming to be loading. A failed read and an empty conversation
   * look identical from here, and rendering the failure as "Loading…" tells the reader to wait for
   * something that is never coming.
   */
  historyError?: string | undefined;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  /**
   * The same fact as `pinnedRef`, in state.
   *
   * The ref is what the scroll effect reads (it must not re-subscribe on every scroll), but the
   * CONTROL's presence has to re-render. Using the ref alone would compute the button correctly
   * and never show it — a control that exists but is never visible.
   */
  const [pinned, setPinned] = useState(true);

  /**
   * The memory callback, readable from the scroll handler.
   *
   * The listener is attached once on mount (it must not re-subscribe on every scroll), so it would
   * otherwise capture the first render's closure.
   */
  const memoryRef = useRef(onScrollMemory);
  memoryRef.current = onScrollMemory;
  /** The previous measurement, so growth can be told apart from the reader scrolling. */
  const sample = useRef<ScrollSample | undefined>(undefined);

  // Follow the tail only while the reader is already at the bottom. Auto-scrolling someone who
  // has scrolled up to read is the most common failure of a streaming transcript.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      const current: ScrollSample = {
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      };
      const previous = sample.current;
      // Only a real measurement may become the previous one: an unmeasured sample reads as enormous
      // growth and would cancel the reader's whole distance from the bottom (see `isMeasured`).
      if (isMeasured(current)) sample.current = current;
      // Growth since the last sample is discounted, because a scroll event arrives AFTER the browser
      // painted whatever arrived meanwhile. Without the discount, output outrunning the scroll looks
      // exactly like the reader scrolling away — which is the bug: the pane stopped following the
      // moment the stream got ahead of it.
      const following =
        previous !== undefined && isMeasured(previous)
          ? isFollowing(previous, current, FOLLOW_THRESHOLD_PX)
          : isAtBottom(container);
      /*
       * On MOUNT, the RESTORE DECISION wins over this measurement (issue #141).
       *
       * `onScroll()` is called once on mount to seed the control's state, and it measures a container
       * that has not been positioned yet: content present, `scrollTop` still 0. That reads as "not at the
       * bottom", so it set `pinnedRef = false` — the app had just decided to FOLLOW, and the measurement
       * silently overrode it before the follow effect ever ran. Which is why returning to a session you
       * were following left you at the top.
       *
       * `restoring` is true for exactly the mount tick and false ever after, so a real scroll — the reader
       * taking control — behaves as it always did.
       */
      if (restoring.current) return;
      // One measurement, two consumers, so the control and the follow behaviour cannot disagree
      // about whether the reader is at the bottom.
      pinnedRef.current = following;
      setPinned(following);
      /*
       * Do NOT record a position measured before there is content to scroll (issue #141, follow-up).
       *
       * The listener runs once on mount, and the pane mounts BEFORE its history is fetched — so the first
       * measurement is `{ scrollTop: 0, height: 0, client: 0 }` of an empty box. Writing that to memory
       * destroyed the offset the reader actually left at, and the next visit restored `scrollTop: 0`: the
       * transcript jumped to the BEGINNING.
       *
       * `isMeasured` already existed for the growth-discount; the same predicate is what distinguishes
       * "a real position" from "nothing to measure yet".
       */
      if (isMeasured(current)) {
        memoryRef.current?.({ scrollTop: current.scrollTop, pinned: following });
      }
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    // Measured once on mount as well: a restored page or a re-render after resize can already be
    // scrolled away from the bottom, and the control would otherwise stay hidden until the first
    // scroll event — which, if the reader never scrolls again, is never.
    onScroll();
    // The seed is done; from here a scroll event is the reader moving, not the pane settling.
    restoring.current = false;
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  /**
   * Put the transcript back where this session was left, or open it at the end.
   *
   * A LAYOUT effect on purpose: it has to run before the follow effect below, which fires on every
   * render. Otherwise a restored position would be immediately overridden by a scroll to the end,
   * and the restore would be invisible — which is exactly the behaviour #80 reported.
   *
   * A session never opened has nothing to restore, and opens following the tail: an agent may have
   * produced a great deal since the last look (see `decideOnSessionChange`).
   */
  const pendingRestore = useRef<SessionScroll | undefined>(undefined);
  /**
   * True for the mount tick only.
   *
   * The listener seeds `pinned` from a measurement on mount, and at that moment the container has content
   * but no position yet — so the measurement says "not at the bottom" and would override the restore
   * decision. Cleared after the first measurement, so every later scroll is the reader's and is honoured.
   */
  const restoring = useRef(true);

  useLayoutEffect(() => {
    const decision = decideOnSessionChange(initialScroll);
    if (decision.kind === "follow-end") {
      pinnedRef.current = true;
      setPinned(true);
      return;
    }
    pinnedRef.current = decision.pinned;
    setPinned(decision.pinned);
    // HELD, not applied: the pane mounts before its history has been fetched, so the container is
    // empty for the first frames and an offset set now would be clamped to 0 — landing the reader at
    // the top, which is the bug this exists to fix. Applied by the effect below, once there is
    // something to scroll.
    pendingRestore.current = { scrollTop: decision.scrollTop, pinned: decision.pinned };
    // Mount-only: this pane is remounted per session by the shell's `key`, so a mount IS a session
    // switch, and `initialScroll` belongs to exactly one session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Apply a held restore as soon as the content can take it.
   *
   * A layout effect with no dependencies, so it runs on every render *before* the follow effect
   * below — the order matters, because a restore applied after the follow would be overridden by a
   * scroll to the end.
   */
  useLayoutEffect(() => {
    const pending = pendingRestore.current;
    if (!pending) return;
    const container = containerRef.current;
    if (!container) return;
    if (!hasScrollableContent(container.scrollHeight, container.clientHeight)) return;
    container.scrollTop = pending.scrollTop;
    pendingRestore.current = undefined;
  });

  /**
   * Sending a prompt re-arms following (#86).
   *
   * The reported symptom was that a reply arrived off-screen after a prompt, because an earlier
   * scroll had un-pinned the reader and nothing ever re-pinned them. Following is re-enabled BEFORE
   * the scroll for the same reason `jumpToLatest` does it: the scroll event fires a handler that
   * would otherwise immediately un-follow the reader again.
   *
   * The first run is skipped — the token starts at 0 and is only meaningful once it changes.
   */
  const rearmToken = useRef(followToken);
  useEffect(() => {
    if (rearmToken.current === followToken) return;
    rearmToken.current = followToken;
    pinnedRef.current = true;
    setPinned(true);
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [followToken]);

  useEffect(() => {
    // Instant, never animated: this is a catch-up, and an animated one cannot catch a moving bottom.
    // `scroll-behavior` is `auto` on the container for the same reason (see styles.css).
    if (shouldFollow(autoFollow, pinnedRef.current)) endRef.current?.scrollIntoView({ block: "end" });
  });

  /**
   * Keep following when the content grows AFTER paint.
   *
   * ## The bug this fixes, reported from use
   *
   * *"when you prompt with an image reference, the rendered message with the thumbnail is not shown completely, even
   * with auto-follow on. When the assistant starts to work, then the transcript goes back to the end and following."*
   *
   * The follow effect above runs on every render, but a render is not when the height arrives. React writes the DOM,
   * the browser lays it out, and only THEN does it fetch and decode a lazy image — so on the frame where a preview turns
   * from "Reading…" into a picture, the `<img>` occupies **zero height**. `scrollIntoView` faithfully scrolls to an end
   * that is about to move down by 12vh, and then nothing else happens: the next render is not due until the agent emits
   * its first delta. Which is exactly what was seen — an incomplete turn, then a jump to the bottom once work started.
   *
   * ## Why an observer rather than a better-timed effect
   *
   * No effect runs at the right moment. `useLayoutEffect` is too early (no image yet), `useEffect` is too early (decode
   * is async), and `img.onload` would have to be plumbed through every image, every collapsed disclosure and every
   * syntax-highlighted code block — because they ALL change height after paint, and the preview is merely the newest
   * member of that family. A `ResizeObserver` on the lane covers the whole class: anything that makes the conversation
   * taller, for any reason, moves the tail and this follows it.
   *
   * The cost is that it fires for non-tail changes too — expanding a disclosure far above the reader scrolls the bottom
   * by the same amount. That is correct behaviour for a pane that is following, and it is the same thing the existing
   * effect already does on every render.
   */
  const laneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const lane = laneRef.current;
    if (lane === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      /*
       * The PINNED flag is read at fire time, not captured.
       *
       * A captured value would be the reader's choice as of the observer's first render, so scrolling away would leave
       * following armed and the pane would keep pulling them back — the opposite defect, and a much worse one. Reading
       * the ref means "the reader is following RIGHT NOW", which is the only question this should ask.
       */
      if (!shouldFollow(autoFollow, pinnedRef.current)) return;
      // Direct assignment rather than `scrollIntoView`: this fires on layout changes, and `scrollIntoView` can move an
      // ANCESTOR scroll port too — on a growing transcript that means the whole window jumping, which is a far more
      // disruptive bug than the one being fixed.
      const container = containerRef.current;
      if (container === null) return;
      container.scrollTop = container.scrollHeight;
    });
    observer.observe(lane);
    return () => observer.disconnect();
    /*
     * `autoFollow` is a dependency because the callback closes over it and must respect a change without
     * re-subscribing being avoidable. `pinnedRef` deliberately is NOT: a ref is stable, and re-subscribing on every
     * pin change would tear down and rebuild the observer on every scroll.
     */
  }, [autoFollow]);

  /**
   * Return to the newest content and start following again.
   *
   * Re-enabling the follow BEFORE scrolling is the load-bearing order: `scrollIntoView` fires a
   * scroll event, and if the flag were still false when that event was handled, the handler would
   * immediately re-pin the reader to "not following" — the button would scroll once and then stop
   * following, which is the bug it exists to fix. Setting it first means the resulting event
   * agrees.
   */
  const jumpToLatest = useCallback(() => {
    pinnedRef.current = true;
    setPinned(true);
    const end = endRef.current;
    if (!end) return;
    // `"end"` rather than `"nearest"`: the target is the bottom, and `"nearest"` would do nothing
    // when the element is already partly visible. `behavior: "smooth"` is asked for HERE, explicitly,
    // because this one IS a deliberate jump — the container no longer smooth-scrolls by default.
    if (typeof end.scrollIntoView === "function") end.scrollIntoView({ block: "end", behavior: "smooth" });
    // Belt and braces for the case that matters most — a browser where `scrollIntoView` is a
    // no-op in this container (for example if the pane is a scroll port but the target is not
    // reached). Assigning the scroll offset directly is what the reader asked for, and it is
    // cheap.
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, []);

  const isEmpty = transcript.messages.length === 0 && transcript.tools.length === 0;
  // An error is not "still loading": the attempt is over.
  const awaitingHistory = isEmpty && expectedCount > 0 && historyError === undefined;
  const failed = isEmpty && historyError !== undefined;
  /*
   * Memoized on the TRANSCRIPT reference (issue #151).
   *
   * `transcript` comes from the store, which replaces the object only when that session's records change — so
   * this recomputes when the session is written to and not when unrelated state (panel width, a toast, another
   * session's streaming) re-renders the tree. It was a plain call, so the plan was rebuilt on every render.
   */
  const entries = useMemo(() => planEntries(transcript), [transcript]);

  /**
   * The image paths the reader's own messages NAME, in message order.
   *
   * Only USER messages are scanned. An assistant message that says "I looked at img_17.png" is describing its own work,
   * and the picture is already inside the activity group for the `read` that produced it — previewing it here as well
   * would draw the same screenshot twice in one conversation and attribute the second copy to prose that merely
   * mentions it.
   */
  const referenced = useMemo(() => {
    const found: { messageId: string; paths: string[] }[] = [];
    for (const message of transcript.messages) {
      if (message.role !== "user") continue;
      const text = messageTexts(message, message.blocks.map((_, index) => index).filter((index) => {
        const block = message.blocks[index];
        return block?.kind === "text";
      })).join("\n");
      const paths = previewsFor(text);
      if (paths.length > 0) found.push({ messageId: message.id, paths });
    }
    return found;
  }, [transcript]);

  /**
   * The paths one message names, or `undefined`.
   *
   * A linear scan of a list that is almost always EMPTY, over at most a handful of entries — measured against the
   * alternative rather than assumed: this is cheaper than building a `Map` per render for a lookup that nearly always
   * misses, and it keeps the pane free of a store. The list being empty for almost every session is the fact that
   * decides it; a `Map` here would be an allocation to make the common case slower.
   *
   * `Transcript.tsx` is also held by a structural test that forbids a per-session store in this file (the pane remounts
   * on every session switch), so the absence of a cache is a documented property rather than an oversight.
   */
  const pathsFor = useCallback(
    (messageId: string): readonly string[] | undefined =>
      referenced.find((entry) => entry.messageId === messageId)?.paths,
    [referenced],
  );

  /**
   * Ask for what is not known yet.
   *
   * An effect rather than a call during planning because the receiver dispatches, and rendering must be pure. The
   * request is idempotent at the receiver (`unloaded` check), so the only cost of an extra run is one map lookup —
   * which matters because this runs on every record while a session streams.
   *
   * A session that is merely being READ (not running) still resolves these: `readFile` is served by the orchestrator
   * from its own process, and the history view is exactly where a reader names old screenshots.
   */
  useEffect(() => {
    if (preview === undefined) return;
    for (const { paths } of referenced) {
      for (const path of paths) preview(path);
    }
  }, [referenced, preview]);

  return (
    // The scroller and the control are SIBLINGS rather than parent and child, and that is
    // deliberate: an absolutely-positioned button inside a scrolling container scrolls away with
    // the content, which is exactly when it is needed. `.transcript-wrap` is the positioned
    // ancestor instead, so the button stays put while the conversation moves.
    //
    // The wrap also reserves the strip the button floats in (issue #71) — see the CSS. Being a
    // sibling is what makes that possible, and the reservation is what stops the button covering a
    // line of text at any scroll position.
    /*
      THREE ELEMENTS, and the outer one exists only to be a CONTAINER QUERY TARGET.
      
      A container cannot be styled by its own container query — an element with `container-type` is not matched by
      `@container` rules that name it. `.transcript-wrap` declares the container, so every `@container transcript`
      rule that named `.transcript-wrap.has-header` was silently ignored: the narrow layout never applied, and the
      wide row simply overflowed the window with the column pushed off-screen.
      
      So: `transcript-shell` is the query container (it declares `container-type` and nothing else), and
      `transcript-wrap` is the box the queries style. Two elements, one job each.
    */
    <div className="transcript-shell">
    <div className={`transcript-wrap${header !== undefined ? " has-header" : ""}`}>
      {header !== undefined && <div className="transcript-header">{header}</div>}
      {/*
        The reading column: scroller + composer, as ONE box.
        
        It exists so the centring has a single thing to centre. Centring via grid track sizes was unreliable — a
        `minmax(0, 72ch)` track plus `justify-content: center` left the pair pinned to the left edge on a wide window
        (`img_30.png`), and a layout whose centring depends on how track max-sizing resolves is a layout that will
        drift again. This wrapper is an ordinary block with an explicit width, centred by its parent.
      */}
      <div className="transcript-main">
      {/*
        The viewport: the scroller plus its floating control.
        
        A wrapper exists so the `Jump to latest` pill has something to be positioned against that is NOT the whole
        reading column. Anchored to the column it sat under the composer — 44px from a bottom edge that is below the
        input — so the control meant for the conversation appeared over the thing you type into.
      */}
      <div className="transcript-viewport">
      <div
        className="transcript"
        ref={containerRef}
        tabIndex={0}
        role="region"
        aria-label={`Transcript for ${sessionLabel}`}
        aria-busy={busy || undefined}
      >
        <div className="transcript-lane" ref={laneRef}>
        {failed ? (
        <div className="empty" style={{ padding: 0 }}>
          <h2>Could not load this session's history</h2>
          <p>{historyError}</p>
          <p className="dim">
            {`Pi reports ${expectedCount} message${expectedCount === 1 ? "" : "s"} in this session, `}
            so they exist — the request for them failed. Reconnect, or reload the page, to try again.
          </p>
        </div>
      ) : awaitingHistory ? (
        <div className="empty" style={{ padding: 0 }}>
          <h2>Loading this session's history…</h2>
          <p>
            {`Pi reports ${expectedCount} message${expectedCount === 1 ? "" : "s"} in this session. `}
            They are being fetched; nothing is missing.
          </p>
        </div>
      ) : isEmpty && !loading ? (
        <div className="empty" style={{ padding: 0 }}>
          <h2>No messages yet.</h2>
          <p>
            This session works in its own scratch workspace. Anything it writes stays there.
            To work in a project, use <strong>Open in a directory</strong>.
          </p>
        </div>
      ) : (
        <>
          {/* Planned as conversation interleaved with ONE activity group per stretch of internal work, so a
              run of thinking and tool calls costs one line instead of one line per step (#170). */}
          {entries.map((entry) =>
            entry.kind === "activity" ? (
              showActivity(entry.parts, transcript.tools, showMarkers) ? (
                <ActivityGroup
                  key={entry.key}
                  parts={entry.parts}
                  tools={transcript.tools}
                  live={busy}
                  onOpenTool={onOpenTool}
                  open={activityOpen[entry.key] ?? false}
                  onToggle={(open) => onToggleActivity(entry.key, open)}
                />
              ) : null
            ) : (
              <Turn
                key={entry.key}
                entry={entry}
                sessionId={sessionId}
                previews={previews}
                referenced={pathsFor(entry.message.id)}
              />
            ),
          )}
        </>
      )}
        {/*
          The notices are inside the LANE and OUTSIDE the branch: a compaction or a retry is part of what is
          happening whether or not there is a message to show yet, and an empty transcript with a retry in flight is
          exactly when a reader needs to see it. `aria-busy` on the region must not imply the notices are unfinished,
          which is why they sit below the conversation rather than inside it.
        */}
        <RunNotices notices={transcript.notices} />
        </div>

        {/* The end sentinel stays INSIDE the scroller and outside the lane: it is a scroll anchor, not content. */}
        <div ref={endRef} />
      </div>

      {/*
        * Appears only while the reader is unpinned from the bottom, which is the only moment it
        * has a job. A control that is always present is noise; one that appears when it can do
        * nothing is a lie about the state.
        *
        * A real <button>, so it is reachable by Tab and activates on Enter/Space for free, rather
        * than a <div> with an onClick that would need a key handler added and kept in sync. It is
        * rendered BEFORE the composer in DOM order but never focused programmatically, so
        * activating it with the mouse or by tabbing does not move focus out of the composer.
        */}
      {!pinned && (
        <button
          type="button"
          className="jump-latest"
          onClick={jumpToLatest}
          title="Scroll to the newest message and follow along again"
        >
          {/* The arrow is decorative: the label carries the meaning, so the glyph is hidden from
              assistive tech rather than read out as "downwards arrow". */}
          <span aria-hidden="true">↓</span> Jump to latest
        </button>
      )}
      </div>

      {/*
        THE COMPOSER LIVES HERE.

        It used to be a separate band below the transcript: its own top border, its own padding, its own width. A
        review called the horizontal and vertical separation the biggest problem — the conversation, the writing
        surface and the trace each occupied a different strip, so the workspace read as three panels stacked rather
        than one conversation.

        As the transcript's own bottom edge it is one region: the prose scrolls, the composer sits at the foot of it,
        and both share the lane's left edge and width without a second container re-deriving them. `autoFollow`
        joins it here too, because the control belongs with the scroller it governs rather than on a row of its own
        above the conversation.
      */}
      {/*
        THE COMPOSER IS THE TRANSCRIPT'S FOOT, AND HAS NO BAND OF ITS OWN.

        It used to be a strip with a top border and a `--panel` fill, which drew a hard rule across the column and
        made the composer read as a separate panel — the separation a review called the biggest problem in the
        layout, twice. `.transcript-footer` now fades the transcript into it instead of ruling it off, so the
        composer looks like it rests on the conversation while still occupying its own height.

        In the flow, not overlaid: the dock grows by 60–100px when a mode strip or a queue appears, so an overlay
        would need a reservation that is wrong in exactly the states where the reader is at the bottom, leaving the
        last message permanently behind the input.
      */}
      {footer !== undefined && (
        /*
          The follow control is handed INTO the footer rather than stacked above it.
          
          As a pill over the field it straddled the focus ring and shifted the gap to the text depending on focus
          (`img_40` vs `img_41`). It now lives in the composer's own chrome row, sharing the field's left edge — the
          reviewer's recommendation, and it fixes the overlap, the left-edge stagger and the "two pill systems" problem in
          one move.
        */
        <div className="transcript-footer">
          <div className="composer-dock">{footer}</div>
        </div>
      )}
      {/* The reading column closes here, AFTER the composer: the column is scroller + composer, and a close before
          the footer made the composer a THIRD flex child of the row — which put it in its own column on the right
          (`img_31.png`). */}
      </div>
    </div>
    </div>
  );
}

/**
 * One turn, memoized (issue #151).
 *
 * Without this, a delta in the LAST message re-rendered every turn above it — with streaming that is dozens of
 * times a second, over the whole conversation. `message` is replaced only for the message being written to, so
 * reference equality is the right comparison.
 *
 * ## Why the comparison is now written down, which it deliberately was not
 *
 * The note above used to say *"there is no custom `areEqual`: the props are the message and nothing else, and a
 * hand-written comparison is how memoization silently stops working"*. That was true when it was written and it
 * stopped being true when `planEntries` grew a second block list: the entry object is allocated FRESH on every
 * re-plan (`activity.ts`), and `Transcript.tsx` re-plans whenever the transcript object changes — during a run,
 * once per streaming record. So `{ entry }` was reference-unequal every time and `memo` never once short-circuited.
 *
 * That was invisible while a turn was a heading plus some text, and it is not invisible with an image in it: a child
 * that rebuilt its blob URL per render would revoke and recreate it dozens of times a second, and every
 * `loading="lazy"` decode in the conversation would be restarted. So the comparison is written down, and it compares
 * the things that actually change what is drawn: the message (for prose), and the two index lists (for which blocks
 * this entry owns).
 */
const Turn = memo(function Turn({
  entry,
  sessionId,
  previews,
  referenced,
}: {
  entry: Extract<PlannedEntry, { kind: "message" }>;
  /** Namespaces the blob-URL identity: message ids are minted per transcript, so `m0` exists in every session. */
  sessionId: string;
  previews?: ((path: string) => FileState) | undefined;
  /** Image paths THIS message names. Undefined when it names none, which is almost every message. */
  referenced?: readonly string[] | undefined;
}) {
  const { message } = entry;
  const label = message.role === "user" ? "You" : message.role === "assistant" ? "Assistant" : message.role;
  /*
   * ONLY the prose spans this entry owns.
   *
   * Thinking blocks are planned into an activity group above or below, so rendering "all the text of the
   * message" here would move prose that was recorded AFTER a thought above it. The indexes come from the
   * planner, which is the only place that ordering rule is written down.
   */
  const texts = messageTexts(message, entry.textIndexes);
  const images = messageImages(message, entry.imageIndexes);

  // The planner never emits an empty message entry; this keeps a heading above nothing impossible even if
  // a future caller builds one by hand.
  if (texts.length === 0 && images.length === 0) return null;

  return (
    // The ROLE is a class, so the two kinds of turn can be told apart by looking (issue #88). Before
    // this the only difference was the text of the label below — two small dim words — which does not
    // survive a glance down a long column.
    <article className={`turn measure turn-${message.role}`}>
      <div className="role">
        <span>{label}</span>
        {message.streaming && (
          <>
            <span className="live-dot" aria-hidden="true" />
            {/* The state word, not only the dot: colour and motion are never the sole signal. */}
            <span>responding…</span>
          </>
        )}
      </div>

      {/* Through MessageBody rather than Prose directly: prose still goes to the one sanitized
          insertion site, while a fenced code block becomes React elements and contributes no HTML
          to sanitize (issue #4). A message with no code takes the Prose path unchanged. */}
      {texts.map((text, index) => (
        <MessageBody
          key={`${entry.key}:${entry.textIndexes[index] ?? index}`}
          text={text}
          streaming={message.streaming && index === texts.length - 1}
        />
      ))}

      {/*
        Images, after the prose they accompany and in recorded order.

        The image's identity is built from the SESSION, the message and the block index — never from the entry, which
        is a fresh object on every re-plan. That is what lets the URL cache answer without work on a re-render.
      */}
      {images.map(({ index, block }) => (
        <TranscriptImage
          key={`${entry.key}:image:${index}`}
          block={block}
          identity={imageKey(sessionId, message.id, index)}
          role={message.role}
        />
      ))}

      {/*
        The images this message NAMES, previewed after the prose that names them.

        After rather than before, because the sentence is the point and the picture is the annotation: "what is wrong
        with this spacing?" followed by the spacing. `ReferencePreview` renders nothing while a file is unrequested, so
        a turn that mentions a path costs no layout until the bytes arrive.
      */}
      {referenced !== undefined &&
        previews !== undefined &&
        referenced.map((path) => (
          <ReferencePreview
            key={`${entry.key}:ref:${path}`}
            path={path}
            state={previews(path)}
            identity={`${sessionId}\u0000${message.id}\u0000ref\u0000${path}`}
          />
        ))}
    </article>
  );
}, sameTurn);

/**
 * The comparison this file used to argue against, now that the argument no longer holds.
 *
 * `entry.message` is the only thing whose CONTENT this component reads for prose, and it is reference-stable except
 * for the message being streamed into — so the common case is one cheap identity check. The two index arrays are
 * compared by length and element, because `planEntries` re-allocates them on every plan while their VALUES are
 * almost always identical; that is exactly the case a hand-written comparison exists for.
 *
 * `sessionId` is compared too, because a different session means a different namespace for the same message id.
 */
function sameTurn(previous: TurnProps, next: TurnProps): boolean {
  if (previous.sessionId !== next.sessionId) return false;
  if (previous.entry.message !== next.entry.message) return false;
  if (previous.previews !== next.previews) return false;
  /*
   * `referenced` is compared by REFERENCE, not by element.
   *
   * `referencedPaths` in `TranscriptView` is a `useMemo` over the transcript, so a message's array identity changes
   * only when the transcript does — which is exactly when this component should reconsider. Comparing elements would be
   * work done per turn per record to prove something the memo already guarantees.
   */
  if (previous.referenced !== next.referenced) return false;
  return (
    sameIndexes(previous.entry.textIndexes, next.entry.textIndexes) &&
    sameIndexes(previous.entry.imageIndexes, next.entry.imageIndexes)
  );
}

type TurnProps = {
  entry: Extract<PlannedEntry, { kind: "message" }>;
  sessionId: string;
  previews?: ((path: string) => FileState) | undefined;
  referenced?: readonly string[] | undefined;
};

function sameIndexes(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}
