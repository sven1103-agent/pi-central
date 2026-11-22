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

/**
 * The answer being streamed, and WHY IT IS LONG.
 *
 * The first version was 1292 characters, which at 4 chars/frame is five seconds, and the operator could not
 * observe the scrolling at all. A transcript shorter than a few screens never scrolls: with a 35vh tail anchor
 * the first screenfuls fill without the tail moving off the fold. A behaviour that only happens after content
 * has genuinely overflowed cannot be demonstrated by content that barely does.
 *
 * So the answer is built from REPEATED SECTIONS until it passes a target length: many screens at any window
 * size, and tens of seconds of steady scrolling. The sections differ in shape -- prose, a list, a fence, a
 * table -- because identical paragraphs would make the bursty mode look artificial, and it is the differing
 * heights arriving that the per-frame clamp has to cope with.
 */
const SECTIONS: string[][] = [
  [
    "Two separate causes, and only one of them is about animation.",
    "",
    "**First, the anchor.** The newest line is pinned to the scroller's bottom edge, so following a run means your eyes travel to the foot of the window on every delta. With a tail anchor of 35vh the newest line sits near the vertical middle instead, which is where the eye already is when a display is set up for reading.",
    "",
    "**Second, the arrival rate.** Every message update is a state update, so the text grows by exactly the delta carried: one commit per token Pi emits. The parse cost of that is the same text parsed hundreds of times, because `Prose` memoizes on the text and streaming changes the text on every delta.",
  ],
  [
    "```ts",
    "const distance = current.scrollHeight - current.scrollTop - current.clientHeight;",
    "const grew = Math.max(0, current.scrollHeight - previous.scrollHeight);",
    "return distance - grew;",
    "```",
    "",
    "That rule is the whole fix for following, and it is **nine lines**. The growth discount is what makes it work: a scroll event arrives after the browser has painted whatever arrived in the meantime, so the raw distance includes movement the reader never asked for. Only the part they are responsible for should un-pin them.",
  ],
  [
    "The cost was measured against message length, and it is the long answers that pay:",
    "",
    "| length | parses today | per frame | ratio |",
    "| --- | --- | --- | --- |",
    "| 800 | 198 | 60 | 3.2x |",
    "| 1500 | 372 | 60 | 6.3x |",
    "| 3000 | 748 | 60 | 12.5x |",
    "",
    "So the saving scales with the answer, which is exactly where a stutter hurts most: the reply you are reading as it is written. A typical assistant message is only about a hundred characters, so the win is small there, and roughly 88% of all parse work in a real session sits in the 9% of messages over 2500 characters.",
  ],
  [
    "## What actually made it stutter",
    "",
    "Not the tokens, and not the parsing. Every follow path was a **teleport**: the scrollTop assignment, `scrollIntoView` with block end, and the resize observer's assignment were each an instant jump to a new position, once per commit, with no interpolation. Coalescing deltas reduces how often a jump happens and changes nothing about how each one looks.",
    "",
    "The glide is bounded three ways, and each bound exists because an unbounded version fails in a specific way:",
    "",
    "1. **Per frame** at most 28px. A paragraph arriving at once is a 200 to 400px hop otherwise.",
    "2. **Per distance** anything past a quarter of the scrollport simply arrives, because a 900px glide cannot be both smooth and quick, and the reader was not tracking the tail anyway.",
    "3. **Per preference** reduced motion settles instantly, which is the one gate that cannot live in CSS because the movement is written from JavaScript.",
  ],
  [
    "## Why animating is safe now",
    "",
    "It was forbidden after #86, where smooth scrolling made the pane un-pin itself: the animation emitted intermediate positions, and an intermediate position is indistinguishable from the reader scrolling up.",
    "",
    "That diagnosis was correct and its conclusion was too broad. The defect was **measuring the pinned flag from scroll events during our own animation**. A comparison against what we last wrote, read back after assignment because the browser clamps and rounds, tells them apart. A difference of more than a pixel is a wheel notch, a keypress or a drag. Under that, it is ours.",
    "",
    "```ts",
    "if (readerMoved(container.scrollTop, lastWritten.current)) {",
    "  stopFrames();   // the reader took control: stop immediately",
    "}",
    "```",
    "",
    "A reader's input cancels an in-flight glide rather than being fought by it, which matters more than any of the easing constants: an animation that continues after you grab the scrollbar is worse than no animation.",
  ],
  [
    "## The two clues that replace the scrollbar",
    "",
    "The scrollbar was drawn as a vertical rule most of the column tall, which read as a second unowned edge beside the prose. A following reader is at the end by construction, so a position indicator answers a question they do not have.",
    "",
    "What replaces it answers the only two they do: is there more above me, and is there more below. A fade at each end of the column, driven by the same measurement that decides the pinned flag, so the two cannot disagree about where the reader is.",
    "",
    "Why a fade and not a chevron: an affordance has to be noticed and interpreted, while a gradient from the page colour says the same thing in the shape this product already uses elsewhere. The composer dissolves into the conversation the same way.",
  ],
  [
    "## What this deliberately does not do",
    "",
    "- No typewriter pacing. Slicing source characters shows partial markdown, which the census measured at 3 to 40% of reveal positions showing literal asterisks or an unclosed backtick. With the scroll smooth it is no longer obviously wanted.",
    "- No virtualisation. The whole transcript stays mounted, because the existing memo means only the streaming turn re-renders and the rest is cheap.",
    "- No change to what a session stores. This is presentation only, so the transcript on disk is untouched and a resumed session replays through exactly the same reducer.",
  ],
];

/** Long enough to overflow any window several times over, even with the 35vh tail anchor applied. */
const TARGET_CHARS = 7000;

/**
 * The answer, repeated until it passes the target.
 *
 * Repeated rather than one enormous literal, so extending it is one number and the SHAPE of the content stays
 * readable. The length is what makes following have to move at all -- and therefore what makes the harness able
 * to show the thing it exists to show.
 */
export const ANSWER: string = (() => {
  const parts: string[] = [];
  let length = 0;
  let round = 0;
  while (length < TARGET_CHARS) {
    for (const section of SECTIONS) {
      const body = section.join("\n");
      parts.push(round === 0 ? body : body.replace(/^(## .+)$/m, "$1 (continued)"));
      length += body.length + 2;
    }
    round += 1;
  }
  return parts.join("\n\n");
})();

/** One delta of the answer, as `message_update` carries it: a fragment, never cumulative. */
function nextDelta(full: string, from: number, size: number): { delta: string; to: number } {
  const to = Math.min(full.length, from + size);
  return { delta: full.slice(from, to), to };
}

type Mode = "steady" | "bursty" | "slow" | "huge";

const MODE_LABEL: Record<Mode, string> = {
  steady: "1× steady",
  bursty: "bursty (paragraphs)",
  slow: "slow (a trickle)",
  huge: "huge (2000 at once)",
};

/**
 * How fast the answer streams, as a multiplier on the mode's base rate.
 *
 * Added because the length fix created the opposite problem: at 4 chars/frame the answer now takes 42 seconds,
 * which is too long to sit through while judging whether a settle looks smooth. And at the other end, 4
 * chars/frame is FASTER than most models stream, so the steady mode understated the smoothness it was meant to
 * demonstrate.
 *
 * The ladder is 1x to 8x and deliberately has no slow end: the answer is 10 000 characters, so half speed
 * would be 84 seconds and a quarter nearly three minutes, which nobody sits through. To watch a SINGLE
 * settle closely, the useful move is not a slower stream but a shorter one -- pick the huge mode at 1x and
 * watch one 2000-character arrival glide in about four seconds.
 */
const SPEEDS = [1, 2, 4, 8] as const;
type Speed = (typeof SPEEDS)[number];

/**
 * How much text arrives per frame, by mode and speed.
 *
 * The base rates are per frame at 60Hz, so `steady` at 1× is 240 characters per second — a fast model. `slow` is
 * 15/s, a cautious one. `bursty` and `huge` are quantised to a 30-frame interval so the arrival is genuinely
 * uneven: a paragraph or a screenful, then nothing, which is what a tool returning looks like on the wire.
 */
function deltaSize(mode: Mode, frame: number, speed: Speed): number {
  const scaled = (base: number) => Math.max(1, Math.round(base * speed));
  if (mode === "steady") return scaled(4);
  if (mode === "slow") return frame % 4 === 0 ? scaled(1) : 0;
  if (mode === "huge") return frame % 30 === 0 ? scaled(2000) : 0;
  // bursty: a whole paragraph roughly every half second, nothing in between
  return frame % 30 === 0 ? scaled(340) : 0;
}

function useStream(mode: Mode, speed: Speed, running: boolean, resetKey: number) {
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

  // Speed is NOT a reset: changing it mid-stream should take effect on the next delta, not restart the answer.

  useEffect(() => {
    if (!running) return undefined;
    const step = () => {
      const size = deltaSize(mode, frame.current, speed);
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
  }, [mode, speed, running]);

  return transcript;
}

function Harness() {
  const [mode, setMode] = useState<Mode>("steady");
  const [speed, setSpeed] = useState<Speed>(1);
  const [running, setRunning] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const transcript = useStream(mode, speed, running, resetKey);

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
        {/*
          Speed, because length and pace pull in opposite directions: the answer is long enough to scroll for 42
          seconds, which is too long to sit through, and 4 chars/frame is faster than most models stream, which
          understated the smoothness. ¼× shows a settle in slow motion; 4× compresses a long run.

          Changing it does NOT restart the answer — it takes effect on the next delta, so a reader can slow down
          exactly when something interesting is happening.
        */}
        <label className="hx-speed">
          speed
          <select value={speed} onChange={(event) => setSpeed(Number(event.target.value) as Speed)}>
            {SPEEDS.map((option) => (
              <option key={option} value={option}>
                {option}×
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={restart}>
          ↻ Restart
        </button>
        <button type="button" onClick={() => setRunning((r) => !r)}>
          {running ? "⏸ Pause" : "▶ Resume"}
        </button>
        <span className="hx-hint">
          Watch the scroll, not the text. Scroll up mid-stream: it must stop following and stay stopped.
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
