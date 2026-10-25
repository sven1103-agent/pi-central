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
import { useEffect, useRef } from "react";
import type { Transcript as TranscriptModel } from "../transcript.ts";
import { assistantText, hasProse, planTranscript, toolRunSummary, type ToolExecution, type TranscriptMessage } from "../transcript.ts";
import { Prose } from "./Prose.tsx";

export function TranscriptView({
  transcript,
  busy,
  sessionLabel,
  expectedCount = 0,
  loading = false,
  onOpenTool,
  showMarkers = true,
  historyError,
}: {
  transcript: TranscriptModel;
  busy: boolean;
  sessionLabel: string;
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

  // Follow the tail only while the reader is already at the bottom. Auto-scrolling someone who
  // has scrolled up to read is the most common failure of a streaming transcript.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      pinnedRef.current = distance < 80;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (pinnedRef.current) endRef.current?.scrollIntoView({ block: "end" });
  });

  const isEmpty = transcript.messages.length === 0 && transcript.tools.length === 0;
  // An error is not "still loading": the attempt is over.
  const awaitingHistory = isEmpty && expectedCount > 0 && historyError === undefined;
  const failed = isEmpty && historyError !== undefined;
  const entries = planTranscript(transcript);

  return (
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
              showMarkers ? (
                <ToolMarker key={`tools-${index}`} tools={entry.tools} onOpenTool={onOpenTool} />
              ) : null
            ) : (
              <Turn key={entry.message.id} message={entry.message} />
            ),
          )}
        </>
      )}
      <div ref={endRef} />
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
function ToolMarker({
  tools,
  onOpenTool,
}: {
  tools: ToolExecution[];
  onOpenTool?: ((toolCallId: string) => void) | undefined;
}) {
  if (tools.length === 0) return null;
  const summary = toolRunSummary(tools);
  const last = tools[tools.length - 1]!;
  const running = tools.some((tool) => tool.running);

  return (
    <button
      type="button"
      className={`tool-marker${summary.failed > 0 ? " has-error" : ""}${running ? " running" : ""}`}
      onClick={() => onOpenTool?.(last.toolCallId)}
      title="Open the tool trace at this point"
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
    </button>
  );
}

function Turn({ message }: { message: TranscriptMessage }) {
  const label = message.role === "user" ? "You" : message.role === "assistant" ? "Assistant" : message.role;
  const text = assistantText(message);
  const thinking = message.blocks.filter((block) => block.kind === "thinking");

  // Guarded as well as filtered by `planTranscript`: a turn heading above nothing is pure noise.
  if (!hasProse(message)) return null;

  return (
    <article className="turn measure">
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

      {thinking.map((block, i) => (
        <details key={i} className="quarantine" style={{ marginBottom: 8 }}>
          <summary className="quarantine-head">
            <span className="label">Thinking</span>
          </summary>
          <pre className="quarantine-body">{block.kind === "thinking" ? block.text : ""}</pre>
        </details>
      ))}

      {text.length > 0 && <Prose text={text} streaming={message.streaming} />}
    </article>
  );
}
