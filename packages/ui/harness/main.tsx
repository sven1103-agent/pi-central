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
 *   2. **fast** — ~960 chars/s, the ceiling a token stream realistically reaches.
 *      case the per-frame clamp exists for.
 *   3. **slow** — a token every few frames, where nothing should move at all for long stretches.
 *
 * ## What was REMOVED, and why
 *
 * There used to be bursty (340 chars in one frame) and huge (2000 in one frame). Both were inventions of
 * this harness, not behaviour of the product: transport.ts broadcasts every record as it arrives with no
 * batching, so the arrival rate is Pi’s own token rate. Six rounds of tuning were spent against those modes
 * before the operator stopped it: Pi Central has no bursty or huge mode, so we were chasing something we do
 * not offer.
 *
 * And a scroll-behaviour switch, so the reader can feel the difference between gliding and teleporting rather
 * than being told about it.
 */
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TranscriptView } from "../src/components/Transcript.tsx";
import { applyRecord, emptyTranscript, type Transcript } from "../src/transcript.ts";
import {
  FRAME_MS,
  FOLLOW_DEFAULTS,
  followConfig,
  resetFollowConfig,
  setFollowConfig,
  tailStep,
  type FollowConfig,
} from "../src/follow-scroll.ts";
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

type Mode = "steady" | "slow" | "fast";

/*
 * ONLY RATES PI CENTRAL ACTUALLY PRODUCES.
 *
 * The first version had "bursty" (340 chars in one frame) and "huge" (2000 chars in one frame). Both were
 * invented by this harness: `transport.ts:942` broadcasts each `record` as it arrives with NO batching, so the
 * arrival rate is Pi's own token rate — roughly 20-100 tokens/sec, which at ~4 chars/token is 80-400 chars/sec.
 * The editor never emits a paragraph in one commit.
 *
 * Six rounds of scroll tuning were spent against those invented modes, and the report that finally stopped it was
 * the right one: "we have no bursty or huge mode in Pi Central. So we are chasing sth we dont offer."
 *
 * These three spans the real range: a slow model, a typical one, a fast one. If a genuine burst case is ever
 * found in the product it must be demonstrated from a real session first, not simulated here.
 */
const MODE_LABEL: Record<Mode, string> = {
  slow: "slow (~15 chars/s)",
  steady: "steady (~240 chars/s)",
  fast: "fast (~960 chars/s)",
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
 * settle closely, the useful move is not a slower stream but a SHORTER one: pause, restart, and watch the
 * first screenful fill at 1x.
 */
const SPEEDS = [1, 2, 4, 8] as const;
type Speed = (typeof SPEEDS)[number];

/**
 * How much text arrives per frame, by mode and speed.
 *
 * The base rates are per frame at 60Hz, so `steady` at 1× is 240 characters per second — a fast model. `slow` is
 * 15/s, a cautious one, and 960/s a fast one. All three are rates a real token stream produces.
 */
function deltaSize(mode: Mode, frame: number, speed: Speed): number {
  const scaled = (base: number) => Math.max(1, Math.round(base * speed));
  if (mode === "steady") return scaled(4);
  if (mode === "slow") return frame % 4 === 0 ? scaled(1) : 0;
  // fast: 16 chars/frame ~= 960 chars/sec, the ceiling of what a token stream realistically reaches.
  return scaled(16);
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


/**
 * A live readout of what the SCROLLER actually does, frame by frame.
 *
 * Added because two rounds of fixing were argued from arithmetic rather than observation, and the second round
 * was reported as "bursty and huge still teleport" while "steady is getting smoother" — a signature no amount of
 * reasoning about `tailStep` could explain, because our own code cannot move more than 2.33px per frame. If a 99px
 * or 581px jump is happening, something ELSE is moving the scroller, and the only way to name it is to watch the
 * number change.
 *
 * Records the largest single-frame movement in the last second, and whether it came from our animation or from
 * somewhere else. A jump larger than the rate cap is, by definition, not ours.
 */
function ScrollProbe({ stageRef }: { stageRef: React.RefObject<HTMLDivElement | null> }) {
  const [worst, setWorst] = useState<{ px: number; perSecond: number; at: number }>({ px: 0, perSecond: 0, at: 0 });
  const [ours, setOurs] = useState(0);
  const [external, setExternal] = useState(0);

  useEffect(() => {
    /*
     * Retried, because the probe and the stage are siblings and the probe can mount first — in which case
     * stageRef.current is null on the first effect and the probe would silently measure nothing. A reader would
     * then see "peak 0.0px/frame" while the transcript jumped, which is the worst possible failure for a
     * diagnostic.
     */
    let scroller: HTMLElement | null = null;
    let retry = 0;
    const find = () => {
      scroller = stageRef.current?.querySelector<HTMLElement>(".transcript") ?? null;
      if (scroller === null && retry < 60) {
        retry += 1;
        requestAnimationFrame(find);
      }
    };
    find();
    if (scroller === null) return undefined;
    // Captured in a const: TypeScript cannot narrow a `let` that a callback reassigns, and the sample loop below
    // runs long after `find` finished. The first version narrowed `scroller` to `never` because the only
    // assignment it could see was the null one.
    const pane: HTMLElement = scroller;

    let previous = pane.scrollTop;
    let lastReport = performance.now();
    let peakThisSecond = 0;

    /*
     * Sampling on rAF, NOT on the scroll event: a scroll event fires once per frame at most, which is what we
     * want, but it does not fire for a jump the browser makes during layout — and that is precisely the case
     * being investigated. Sampling the value every frame catches movement whatever caused it.
     */
    let raf = 0;
    const sample = () => {
      const now = performance.now();
      const delta = Math.abs(pane.scrollTop - previous);
      previous = pane.scrollTop;
      peakThisSecond = Math.max(peakThisSecond, delta);

      /*
       * JUDGED AGAINST THE REAL CEILING, imported rather than hardcoded.
       *
       * The previous version used a 2.5px threshold carried over from an older constant, so it reported EVERY
       * frame as a jump once the ceiling became one line (23px) — a probe that is always red is a probe nobody
       * reads. The threshold is now the ceiling the module actually enforces, plus half a pixel for the browser
       * rounding `scrollTop` to a device pixel.
       *
       * The distinction it draws is still the useful one: a movement at or below the ceiling is OUR animation, and
       * anything above it came from somewhere else — a clamp, an anchoring jump, or a caller passing `instant`.
       */
      const ceiling = followConfig.maxStepPx + 0.5;
      if (delta > ceiling) setExternal((n) => n + 1);
      else if (delta > 0) setOurs((n) => n + 1);

      if (now - lastReport > 1000) {
        setWorst({ px: peakThisSecond, perSecond: peakThisSecond * 60, at: Date.now() });
        peakThisSecond = 0;
        lastReport = now;
      }
      raf = requestAnimationFrame(sample);
    };
    raf = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(raf);
  }, [stageRef]);

  const jump = worst.px > followConfig.maxStepPx + 0.5;
  return (
    <span className={"hx-probe" + (jump ? " is-jump" : "")}>
      {jump ? (
        <strong>JUMP {worst.px.toFixed(0)}px in one frame = {worst.perSecond.toFixed(0)} px/sec</strong>
      ) : (
        <>peak {worst.px.toFixed(1)}px of {followConfig.maxStepPx.toFixed(0)}px/frame</>
      )}
      {" · ours "}{ours}{" · external "}{external}
    </span>
  );
}


/**
 * THE TUNING PANEL.
 *
 * Four fixed curves were shipped and each was reported wrong from this harness. The conclusion is not that a
 * fifth constant is needed — it is that these are TASTE values, and the person watching the motion is the only one
 * who can set them. So every parameter is a slider, the effect is immediate, and the current settle times are
 * printed so a setting can be understood as well as felt.
 */
const TUNING: { key: keyof FollowConfig; label: string; min: number; max: number; step: number; unit: string; note: string }[] = [
  {
    key: "maxStepPx",
    label: "per-frame cap",
    min: 4,
    max: 80,
    step: 0.25,
    unit: "px",
    note: "NOT REACHED at real rates: the tail settles ~2.6px behind, far below the cap",
  },
  { key: "ease", label: "gentle fraction", min: 0.005, max: 0.9, step: 0.005, unit: "", note: "DOMINANT at real token rates — the whole distance is multiplied by it" },
  { key: "burstFraction", label: "burst fraction", min: 0.01, max: 1, step: 0.01, unit: "", note: "WEAK unless ramp span is small — see below" },
  { key: "rampSpanPx", label: "ramp span", min: 4, max: 200, step: 1, unit: "px", note: "mostly off at real rates: the ramp weight stays near 0.09" },
  { key: "snapPx", label: "snap", min: 0.1, max: 4, step: 0.1, unit: "px", note: "NOT REACHED at real rates" },
];

/** What each arrival costs under the CURRENT settings, so a slider movement is legible as well as felt. */
function settleTable(): { distance: number; frames: number; ms: number; peak: number; governedBy: string }[] {
  return [23, 99, 233, 581, 1163, 2000].map((distance) => {
    let remaining = distance;
    let frames = 0;
    let peak = 0;
    while (Math.abs(remaining) > 0.001 && frames < 5000) {
      const step = tailStep(remaining);
      peak = Math.max(peak, Math.abs(step));
      remaining -= step;
      frames += 1;
    }
    /*
     * WHICH PARAMETER DECIDES THIS ARRIVAL — computed, not guessed, and the column exists because five rounds of
     * tuning went into knobs that provably could not affect the case being watched.
     *
     * The cap binds whenever `remaining * fraction > cap`, i.e. above `cap / burstFraction` px. Below that the
     * fraction decides, and which fraction depends on the ramp. So an arrival is "cap" if it is above that
     * threshold, "burst" between rampSpan and it, and "gentle" below rampSpan.
     */
    const threshold = followConfig.maxStepPx / followConfig.burstFraction;
    const governedBy =
      distance > threshold
        ? "per-frame cap"
        : distance > followConfig.rampSpanPx
          ? "burst fraction"
          : "gentle fraction";
    return { distance, frames, ms: Math.round((frames * FRAME_MS)), peak: Math.round(peak), governedBy };
  });
}

function TuningPanel() {
  const [values, setValues] = useState<FollowConfig>({ ...followConfig });
  const [, force] = useState(0);

  const update = (key: keyof FollowConfig, value: number) => {
    // Applied to the LIVE config immediately, so the next frame of the running stream uses it — no restart, and
    // no rebuild. That is the whole point of the panel.
    setFollowConfig({ [key]: value } as Partial<FollowConfig>);
    setValues({ ...followConfig });
    force((n) => n + 1);
  };

  /*
   * THE DISTANCE THE TAIL ACTUALLY SETTLES AT, at a real token rate.
   *
   * This is the number that decides which sliders can do anything, and it is ~2.6px — an order of magnitude below
   * the per-frame cap (23.25px) and the snap threshold is 0.6px, also below it. So the cap and the snap can never
   * fire, and the ROOT of this panel is `ease`: it multiplies the whole distance, not a part of it.
   *
   * That was reported from the chair before it was derived here — "per-frame cap does not make a noticeable
   * effect, same for ramp span and snap" — and the arithmetic agrees exactly. Printed live so a slider that cannot
   * matter is visibly labelled rather than silently disappointing.
   */
  const arrivalPx = 4 / 80 * 23.25;
  let settleDistance = 0;
  for (let frame = 0; frame < 400; frame += 1) {
    settleDistance += arrivalPx;
    if (Math.abs(settleDistance) > 0.001) settleDistance -= tailStep(settleDistance);
  }
  const reach = {
    maxStepPx: followConfig.maxStepPx / Math.max(settleDistance, 0.01),
    snapPx: followConfig.snapPx / Math.max(settleDistance, 0.01),
    rampSpanPx: Math.max(settleDistance, 0.01) / followConfig.rampSpanPx,
  };
  const live = (key: keyof FollowConfig): string => {
    if (key === "maxStepPx") return reach.maxStepPx > 2 ? `${reach.maxStepPx.toFixed(0)}x above reach` : "within reach";
    if (key === "snapPx") return reach.snapPx < 1 ? `${(1 / reach.snapPx).toFixed(0)}x below reach` : "within reach";
    if (key === "rampSpanPx") return `ramp weight ${Math.min(1, reach.rampSpanPx).toFixed(2)}`;
    return "ACTIVE";
  };

  return (
    <div className="hx-tuning">
      <p className="hx-tuning-truth">
        At a real token rate the tail settles <b>{settleDistance.toFixed(2)}px</b> behind the text. Anything
        below that number can shape the motion; anything above it cannot fire at all.
      </p>
      {TUNING.map(({ key, label, min, max, step, unit, note }) => (
        <label key={key} className={`hx-tune${live(key).startsWith("ACTIVE") ? " hx-tune-active" : ""}`}>
          <span className="hx-tune-name">{label}</span>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={values[key]}
            onChange={(event) => update(key, Number(event.target.value))}
          />
          <span className="hx-tune-value">
            {values[key]}
            {unit}
          </span>
          <span className="hx-tune-reach">{live(key)}</span>
          <span className="hx-tune-note">{note}</span>
        </label>
      ))}
      <button
        type="button"
        onClick={() => {
          resetFollowConfig();
          setValues({ ...followConfig });
          force((n) => n + 1);
        }}
      >
        Reset to shipped
      </button>
      <code className="hx-config">
        {JSON.stringify(Object.fromEntries(TUNING.map(({ key }) => [key, followConfig[key]])), null, 0)}
      </code>
      <table className="hx-settle">
        <thead>
          <tr>
            <th>arrival</th>
            <th>frames</th>
            <th>settle</th>
            <th>peak step</th>
            <th>governed by</th>
          </tr>
        </thead>
        <tbody>
          {settleTable().map((row) => (
            <tr key={row.distance} className={row.peak > values.maxStepPx + 0.5 ? "is-over" : undefined}>
              <td>{row.distance}px</td>
              <td>{row.frames}</td>
              <td>{row.ms}ms</td>
              <td>{row.peak}px</td>
              <td>{row.governedBy}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Harness() {
  const [mode, setMode] = useState<Mode>("steady");
  const [speed, setSpeed] = useState<Speed>(1);
  const [running, setRunning] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const transcript = useStream(mode, speed, running, resetKey);
  const stageRef = useRef<HTMLDivElement | null>(null);

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
        <ScrollProbe stageRef={stageRef} />
        <span className="hx-hint">
          Watch the scroll, not the text. Scroll up mid-stream: it must stop following and stay stopped.
        </span>
      </div>
      <TuningPanel />
      <div className="hx-stage" ref={stageRef}>
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
