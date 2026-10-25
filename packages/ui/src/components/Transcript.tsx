/**
 * The transcript pane.
 *
 * Renders whatever the reducer produced. Two rules from the design that matter for behaviour:
 *
 * 1. **No live region on the streaming tail.** Announcing per delta would emit hundreds of
 *    utterances per turn and make the app unusable with a screen reader. `aria-busy` on the
 *    region plus one announcement per *settled* turn is the honest trade (DESIGN.md §9).
 * 2. **Tool output is quarantined, prose is not.** Assistant text is rendered as Markdown;
 *    tool results get the hatched frame and are rendered as plain text, because they are data
 *    rather than prose and are not Markdown.
 */
import { useEffect, useRef } from "react";
import type { Transcript as TranscriptModel } from "../transcript.ts";
import { assistantText, type TranscriptMessage } from "../transcript.ts";
import { Prose } from "./Prose.tsx";
import { ToolFrame } from "./ToolFrame.tsx";

export function TranscriptView({
  transcript,
  busy,
  sessionLabel,
  expectedCount = 0,
  loading = false,
}: {
  transcript: TranscriptModel;
  busy: boolean;
  sessionLabel: string;
  /**
   * How many messages Pi says the session has.
   *
   * Passed so the empty state cannot CONTRADICT the header. The screenshot that exposed the
   * missing-history bug showed `634 msgs` in the header and "No messages yet." underneath —
   * both rendered from real data, and visibly disagreeing. An empty transcript with a non-zero
   * count is not an empty session; it is history that has not arrived, and saying "no messages"
   * then is worse than saying nothing.
   */
  expectedCount?: number;
  /** True once the session is up and its history has been requested. */
  loading?: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Follow the tail only while the user is already at the bottom. Auto-scrolling someone who
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
  // Only claim the session is empty when Pi agrees it is. Otherwise this is history in flight.
  const awaitingHistory = isEmpty && expectedCount > 0;

  return (
    <div
      className="transcript"
      ref={containerRef}
      tabIndex={0}
      role="region"
      aria-label={`Transcript for ${sessionLabel}`}
      aria-busy={busy || undefined}
    >
      {awaitingHistory ? (
        <div className="empty" style={{ padding: 0 }}>
          <h2>Loading this session's history…</h2>
          <p>
            Pi reports {expectedCount} message{expectedCount === 1 ? "" : "s"} in this session.
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
          {transcript.messages.map((message, index) => (
            <Turn key={message.id} message={message} index={index} />
          ))}
          {/* Tools are rendered after messages in arrival order; the reducer keeps them
              correlated by toolCallId so interleaved parallel calls stay correct. */}
          {transcript.tools.map((tool) => (
            <ToolFrame key={tool.toolCallId} tool={tool} />
          ))}
        </>
      )}
      <div ref={endRef} />
    </div>
  );
}

function Turn({ message, index }: { message: TranscriptMessage; index: number }) {
  const label = message.role === "user" ? "You" : message.role === "assistant" ? "Assistant" : message.role;
  const text = assistantText(message);
  const thinking = message.blocks.filter((block) => block.kind === "thinking");

  return (
    <article className="turn measure">
      <div className="role">
        <span>{label}</span>
        {message.streaming && (
          <>
            <span className="live-dot" aria-hidden="true" />
            {/* The state word, not just the dot: colour and motion are never the only signal. */}
            <span>responding…</span>
          </>
        )}
        {!message.streaming && message.complete && index > 0 && <span>· done</span>}
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

      {/* Blocks with no text yet: show that a tool call was issued before its result arrives. */}
      {message.blocks
        .filter((block) => block.kind === "toolcall")
        .map((block, i) => (
          <div key={i} className="quarantine-head" style={{ cursor: "default" }}>
            <span className="label">Calling tool</span>
            <span className="tool-name">{block.kind === "toolcall" ? block.name ?? "unknown" : ""}</span>
          </div>
        ))}
    </article>
  );
}
