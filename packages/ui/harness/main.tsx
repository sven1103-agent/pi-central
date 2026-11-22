/**
 * The follow-scroll harness (ADR-0016). Not part of the app; nothing imports it.
 *
 * Mounts the REAL `TranscriptView` and feeds it simulated streaming through the REAL reducer, so what you see is
 * the component's behaviour rather than a rendering of it. That distinction is the whole point: the previous
 * preview pages were server-rendered strings, the scroll handler never ran, and the fades they were meant to
 * demonstrate were invisible — reported, correctly, as "I cannot see any fade".
 *
 * ## What is simulated, and what is not
 *
 * - **Simulated:** the socket. Deltas are pushed on a timer instead of arriving from Pi.
 * - **Not simulated:** the reducer (`applyRecord`), the component, the stylesheet, the scroll container, and
 *   the browser's own layout and scrolling. Those are the things under review.
 *
 * ## The four modes, because "smooth" is only meaningful against a comparison
 *
 *   1. **1× steady** — a realistic trickle. The tail should follow continuously with no visible jump.
 *   2. **bursty** — paragraphs arriving whole, which is what real models do when a tool returns. This is the
 *      case the per-frame clamp exists for.
 *   3. **slow** — a token every few frames, where nothing should move at all for long stretches.
 *   4. **huge** — thousands of characters at once, which is routed to an instant settle rather than a glide.
 *
 * And a scroll-behaviour switch, so the reader can feel the difference between gliding and teleporting rather
 * than being told about it.
 */
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TranscriptView } from "../src/components/Transcript.tsx";
import { applyRecord, emptyTranscript, type Transcript } from "../src/transcript.ts";
import "../src/styles.css";
import "./harness.css";

const FENCE = String.fromCharCode(96, 96, 96);

/** The answer being streamed. Realistic: prose, emphasis, inline code, a fence, a table, a long paragraph. */
const ANSWER = [
  "Two separate causes, and only one of them is about animation.",
  "",
  "**First, the anchor.** The newest line is pinned to the scroller's bottom edge, so following a run means your eyes travel to the foot of the window on every delta.",
  "",
  "**Second, the arrival rate.** Every message update is a state update, so the text grows by exactly the delta carried, one commit per token Pi emits.",
  "",
  FENCE + "ts",
  "const distance = current.scrollHeight - current.scrollTop - current.clientHeight;",
  "const grew = Math.max(0, current.scrollHeight - previous.scrollHeight);",
  "return distance - grew;",
  FENCE,
  "",
  "That rule is the whole fix for following, and it is **nine lines**.",
  "",
  "The cost was measured against message length, and it is the long answers that pay:",
  "",
  "| length | parses today | per frame | ratio |",
  "| --- | --- | --- | --- |",
  "| 800 | 198 | 60 | 3.2x |",
  "| 1500 | 372 | 60 | 6.3x |",
  "| 3000 | 748 | 60 | 12.5x |",
  "",
  "So the saving scales with the answer, which is exactly where a stutter hurts most: the reply you are reading as it is written. The longer the answer, the more the per-token re-parse costs, and the more the scroll has to keep up with.",
  "",
  "And a final paragraph, so the transcript is comfortably taller than the window and following actually means something. Without this much content the pane would fit on one screen and no scrolling would happen at all.",
].join("\n");

/** One delta of the answer, as `message_update` carries it: a fragment, never cumulative. */
function nextDelta(full: string, from: number, size: number): { delta: string; to: number } {
  const to = Math.min(full.length, from + size);
  return { delta: full.slice(from, to), to };
}

type Mode = "steady" | "bursty" | "slow" | "huge";

const MODE_LABEL: Record<Mode, string> = {
  steady: "1× steady (4 chars/frame)",
  bursty: "bursty (a paragraph at once)",
  slow: "slow (1 char every 4 frames)",
  huge: "huge (2000 chars at once)",
};

/** How much text arrives per frame, by mode. */
function deltaSize(mode: Mode, frame: number): number {
  if (mode === "steady") return 4;
  if (mode === "slow") return frame % 4 === 0 ? 1 : 0;
  if (mode === "huge") return frame % 30 === 0 ? 2000 : 0;
  // bursty: a whole paragraph roughly every half second, nothing in between
  return frame % 30 === 0 ? 340 : 0;
}

function useStream(mode: Mode, running: boolean, resetKey: number) {
  const [transcript, setTranscript] = useState<Transcript>(() => emptyTranscript());
  const cursor = useRef(0);
  const frame = useRef(0);
  const raf = useRef<number | null>(null);

  // Reset when the reader asks for it, or the mode changes.
  useEffect(() => {
    cursor.current = 0;
    frame.current = 0;
    setTranscript(
      applyRecord(emptyTranscript(), {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "Why does the text arrive so harshly?" }] },
      }),
    );
    setTranscript((previous) =>
      applyRecord(previous, {
        type: "message_start",
        message: { id: "a1", role: "assistant", content: [] },
      }),
    );
  }, [mode, resetKey]);

  useEffect(() => {
    if (!running) return undefined;
    const step = () => {
      const size = deltaSize(mode, frame.current);
      frame.current += 1;
      if (cursor.current < ANSWER.length) {
        const { delta, to } = nextDelta(ANSWER, cursor.current, size);
        if (delta.length > 0) {
          cursor.current = to;
          /*
           * Through the REAL reducer, as a `message_update` record. This is the path the socket feeds, so the
           * component sees exactly what it sees in the product — same block appending, same streaming flag.
           */
          setTranscript((previous) =>
            applyRecord(previous, {
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
            }),
          );
        }
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [mode, running]);

  return transcript;
}

function Harness() {
  const [mode, setMode] = useState<Mode>("steady");
  const [running, setRunning] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const transcript = useStream(mode, running, resetKey);

  const restart = useCallback(() => {
    setResetKey((n) => n + 1);
    setRunning(true);
  }, []);

  return (
    <div className="hx">
      <div className="hx-bar">
        <strong>Follow scroll — ADR-0016</strong>
        {(Object.keys(MODE_LABEL) as Mode[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={mode === key}
            onClick={() => {
              setMode(key);
              setRunning(true);
            }}
          >
            {MODE_LABEL[key]}
          </button>
        ))}
        <button type="button" onClick={restart}>
          ↻ Restart
        </button>
        <button type="button" onClick={() => setRunning((r) => !r)}>
          {running ? "⏸ Pause" : "▶ Resume"}
        </button>
        <span className="hx-hint">
          Watch the scroll, not the text. Scroll up mid-stream and it must stop following and stay stopped.
        </span>
      </div>
      <div className="hx-stage">
        <TranscriptView
          transcript={transcript}
          busy={running}
          sessionId="harness"
          preview={() => {}}
          sessionLabel="harness"
          footer={
            <textarea
              className="composer-input"
              readOnly
              defaultValue="The composer sits here, so the distance from the newest line to the input is visible."
            />
          }
        />
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
