/**
 * The transcript pane.
 *
 * **Prose first.** The conversation is what a reader follows; tools are a trace and belong in
 * `ToolTrace`. The previous version rendered every tool call AFTER every message, so a real
 * session put 1138 frames below the conversation and the agent's actual output became
 * unfindable. That was a bug, not a layout preference: tools happen *between* messages, and
 * appending them destroys the only ordering that makes them readable.
 *
 * So each message is followed by at most ONE compact marker per run of tools, which keeps the
 * position — "something happened here" — while refusing to spend a screenful on it. Clicking a
 * marker opens that call in the trace window, which is the bridge from reading to debugging.
 *
 * Two accessibility rules, both deliberate:
 *
 * 1. **No live region on the streaming tail.** Announcing per delta would emit hundreds of
 *    utterances per turn.
 * 2. **`aria-busy` while streaming**, so assistive tech does not read a half-written subtree.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Transcript as TranscriptModel } from "../transcript.ts";
import { assistantText, hasProse, planTranscript, thinkingGist, toolRunSummary, type ToolExecution, type TranscriptMessage } from "../transcript.ts";
import { MessageBody } from "./MessageBody.tsx";
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
import { ToolDetail } from "./ToolDetail.tsx";
import { formatBytes } from "../format.ts";

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
  sessionLabel,
  followToken = 0,
  autoFollow = true,
  expectedCount = 0,
  loading = false,
  onOpenTool,
  showMarkers = true,
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
   * Whether to show position markers for tool work.
   *
   * A marker preserves WHERE the agent did something, which the trace window alone cannot. But a
   * real session alternates prose and tools almost one-for-one, so markers are numerous by nature.
   * Making them optional means a reader can have pure prose when they want to read and position
   * when they want to understand — rather than one of the two being imposed.
   */
  showMarkers?: boolean;
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
  const entries = useMemo(() => planTranscript(transcript), [transcript]);

  return (
    // The scroller and the control are SIBLINGS rather than parent and child, and that is
    // deliberate: an absolutely-positioned button inside a scrolling container scrolls away with
    // the content, which is exactly when it is needed. `.transcript-wrap` is the positioned
    // ancestor instead, so the button stays put while the conversation moves.
    //
    // The wrap also reserves the strip the button floats in (issue #71) — see the CSS. Being a
    // sibling is what makes that possible, and the reservation is what stops the button covering a
    // line of text at any scroll position.
    <div className="transcript-wrap">
      <div
        className="transcript"
        ref={containerRef}
        tabIndex={0}
        role="region"
        aria-label={`Transcript for ${sessionLabel}`}
        aria-busy={busy || undefined}
      >
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
          {/* Planned as prose turns interleaved with ONE marker per stretch of tool work, so a
              burst of calls collapses to a single line instead of one line per call. */}
          {entries.map((entry, index) =>
            entry.kind === "tools" ? (
              showMarkers ? <ToolMarker key={`tools-${index}`} tools={entry.tools} /> : null
            ) : (
              <Turn key={entry.message.id} message={entry.message} />
            ),
          )}
        </>
      )}
        {/* Above the end sentinel, inside the scroller: a compaction or retry is part of what is
            happening, so following the tail should follow it too. Outside the transcript's own
            content so that `aria-busy` on the region does not imply the notices are unfinished. */}
        <RunNotices notices={transcript.notices} />
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
  );
}

/**
 * One line standing in for a run of tool calls.
 *
 * Compact by design: a reader must be able to see that the agent did something here without
 * reading what it did. The names are enough to orient, and the click is there for when they are
 * not.
 */
/**
 * One run of tool work, inline in the transcript (issue #131).
 *
 * ## What changed, and why
 *
 * A marker used to be a button that opened the trace panel at the bottom of the window. Reported: *"I
 * expected the tool output to open inline the transcript in this case."* The expectation is right — a
 * marker is a bookmark in the conversation, so the answer belongs where the question was asked.
 *
 * So the marker is now a **`<details>`**: the summary line is unchanged (the count, the names, the state),
 * and opening it reveals each call's arguments and a capped preview of its output, in place. The trace
 * panel is still there and still reachable, because the header of this file records what happens when tool
 * output grows without a bound: *"1138 frames below the conversation and the agent's actual output became
 * unfindable."* The remainder of a long result is a disclosure, and the **trace panel below the transcript**
 * is where the full view lives — every row in it is selectable, so no button is needed on this surface
 * (issue #139).
 *
 * `<details>` rather than `useState`: the browser owns the open/closed state, so it survives a re-render —
 * which is the bug #108 was about — and keyboard behaviour comes for free.
 */
function ToolMarker({ tools }: { tools: ToolExecution[] }) {
  if (tools.length === 0) return null;
  const summary = toolRunSummary(tools);
  const last = tools[tools.length - 1]!;
  const running = tools.some((tool) => tool.running);

  return (
    <details className={`tool-marker${summary.failed > 0 ? " has-error" : ""}${running ? " running" : ""}`}>
      <summary
        className="tool-marker-summary"
        // Said plainly, because the summary is a disclosure now rather than a jump.
        title="Show this call's arguments and output here"
      >
        <span className="m-glyph" aria-hidden="true">
          {running ? "●" : summary.failed > 0 ? "✕" : "⌁"}
        </span>
        <span className="m-count">
          {summary.count} tool{summary.count === 1 ? "" : "s"}
        </span>
        <span className="m-names mono">{summary.names.join(" · ")}</span>
        {summary.failed > 0 && <span className="m-failed">{summary.failed} failed</span>}
        {running && <span className="m-running">running</span>}
        <span className="spacer" />
        {/* Size only. The `Open in trace` button that used to sit here was removed (issue #139): it is a
            second control on a surface the reader is already reading, and the trace panel below the
            transcript already reaches every call — every row in it is selectable. */}
        <span className="tool-detail-meta">{formatBytes(last.result.length)}</span>
        {/* The expander marker is NOT `aria-hidden`: it is the only signal that this line opens. */}
        <span className="m-open" aria-hidden="true">
          ⌄
        </span>
      </summary>

      {tools.map((tool, index) => (
        <ToolDetail
          key={tool.toolCallId}
          tool={tool}
          /*
           * ONE bar per call (issue #136).
           *
           * The first call needs none: the `<summary>` above is its bar, carrying the tool name, the
           * state and the open/closed affordance. That is what lets the reader keep the mouse where they
           * clicked and close again — a second header bar meant moving to it.
           *
           * A LATER call in the same run does need one, because it is not the summary and would
           * otherwise be an unlabelled block. It names the call and its size, nothing more.
           */
          header={
            index === 0 ? undefined : (
              <div className="tool-detail-head">
                <span className="mono">{tool.toolName}</span>
                {tool.isError && <span className="err">failed</span>}
                {tool.running && <span className="m-running">running</span>}
                <span className="spacer" />
                <span className="tool-detail-meta">{formatBytes(tool.result.length)}</span>
              </div>
            )
          }
        />
      ))}
    </details>
  );
}

/**
 * One turn, memoized (issue #151).
 *
 * Without this, a delta in the LAST message re-rendered every turn above it — with streaming that is dozens of
 * times a second, over the whole conversation. `message` is replaced only for the message being written to, so
 * reference equality is the right comparison. There is no custom `areEqual`: the props are the message and
 * nothing else, and a hand-written comparison is how memoization silently stops working.
 */
const Turn = memo(function Turn({ message }: { message: TranscriptMessage }) {
  const label = message.role === "user" ? "You" : message.role === "assistant" ? "Assistant" : message.role;
  const text = assistantText(message);
  const thinking = message.blocks.filter((block) => block.kind === "thinking");

  // Guarded as well as filtered by `planTranscript`: a turn heading above nothing is pure noise.
  if (!hasProse(message)) return null;

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

      {thinking.map((block, i) => {
        // The gist, so four collapsed blocks are not four identical bars (issue #143). It is the block's
        // own first sentence, which is content already present behind this `<details>` — a preview, not a
        // disclosure. `thinkingGist` explains why it is not a duration.
        const gist = block.kind === "thinking" ? thinkingGist(block.text) : "";
        return (
          <details key={i} className="quarantine" style={{ marginBottom: 8 }}>
            <summary className="quarantine-head">
              <span className="label">Thinking</span>
              {/*
                That this block is STILL BEING WRITTEN (issue #146).

                Reported from use: "I definitely dont see any response in the thinking bar, there is no visual
                indication that the thinking is still running. Users just see the bar and thats it."

                The state was already on the wire — `TextBlock.complete` is set false by `thinking_start` and
                true by `thinking_end` — it was simply not rendered. A block that is still growing looked
                exactly like a finished one that had been collapsed, so a reader could not tell "it is
                thinking right now" from "it thought, a while ago, about something else".

                NO DOT. The first version put a green `live-dot` here beside the word, and the reader's verdict
                was immediate: "i think now it is redundant". They were right, and the reason is structural —
                a thinking block is only ever streamed INSIDE an assistant message, and the `.role` line above
                already carries `● responding…` for as long as that message streams. A tool call does not
                close the message (only `message_end` does), so `responding…` is on screen the whole time a
                block is growing. The second dot therefore repeated the first, one line lower, with the same
                colour.

                It was also worse than merely redundant: `.live-dot` only pulses under `.state-streaming`, so
                this was a STATIC green dot next to a pulsing one — two indicators of the same fact that did
                not even agree on whether the fact was ongoing.

                The word stays, because it is the part that says something the line above does not: WHICH part
                of the response is still arriving. And the word was always the carrier — DESIGN §539, "no
                motion is ever the only carrier of meaning" — so removing the decoration costs nothing.
              */}
              {block.kind === "thinking" && !block.complete && (
                <span className="quarantine-state">thinking…</span>
              )}
              {gist.length > 0 && (
                <>
                  <span className="spacer" />
                  {/*
                    The words, so the block says what it is about; the label already says what KIND of
                    block it is, so this does not repeat it.

                    NO `title`, and that is the whole point of a collapsed block (issue #143). A first
                    version put the untruncated text on `title` so a word lost to the cap could be
                    recovered by hovering — which handed the reader a screen-filling native tooltip
                    carrying the ENTIRE thought. Collapsing exists so a long derivation costs one line
                    until you ask for it; revealing it on a stray mouse-over undoes that, and it does so
                    without a click, without focus and without a way to keep it open. Opening the
                    `<details>` is the one gesture that says "show me this".
                  */}
                  <span className="quarantine-gist">{gist}</span>
                </>
              )}
            </summary>
            <pre className="quarantine-body">{block.kind === "thinking" ? block.text : ""}</pre>
          </details>
        );
      })}

      {/* Through MessageBody rather than Prose directly: prose still goes to the one sanitized
          insertion site, while a fenced code block becomes React elements and contributes no HTML
          to sanitize (issue #4). A message with no code takes the Prose path unchanged. */}
      {text.length > 0 && <MessageBody text={text} streaming={message.streaming} />}
    </article>
  );
});
