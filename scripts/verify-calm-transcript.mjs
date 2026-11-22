#!/usr/bin/env node
/**
 * Reproduce ADR-0016's measurements against real sessions in this machine's store.
 *
 *   node scripts/verify-calm-transcript.mjs           # both halves, each in its own process
 *   node scripts/verify-calm-transcript.mjs --part 1  # the cost measurement only
 *   node scripts/verify-calm-transcript.mjs --part 2  # the reveal census only
 *
 * Nothing here ships. It is the evidence behind docs/decisions/0016-calm-transcript.md, kept runnable
 * so a reader can disagree with the record rather than take it on trust — the same argument
 * scripts/render-session-html.mjs makes for itself: "the tests are green" is not the same claim as
 * "this is measurably worse".
 *
 * ## The two claims, and why each needs its own measurement
 *
 * 1. **Coalescing pays.** Today one `message_update` is one state update, so `Prose` re-parses the WHOLE
 *    accumulated message per delta (its memo is keyed on the text, and streaming changes the text). This
 *    sums the parse cost of every prefix of a real message and compares it to one parse per animation
 *    frame.
 *
 * 2. **Source-slicing is worse than the stream.** Pacing a reveal by N *source* characters shows partial
 *    markdown, and partial markdown is valid-but-wrong output: `The **root ` renders as
 *    `<p>The **root</p>`. Graded on the rendered TEXT, because that is what a reader sees; grading on
 *    the markup would count tags nobody looks at.
 *
 * ## What it deliberately does not measure
 *
 * Milliseconds are jsdom + DOMPurify in Node, not a browser, so the RATIO is the claim and the absolute
 * numbers are not. The geometry half of ADR-0016 (where the newest line sits) needs a screenshot and
 * cannot be measured here at all — a headless browser aborts under the Seatbelt profile these sessions
 * run in (C1). That gap is stated in the record rather than papered over.
 *
 * ## Why the sample is "newest N", and why the record quotes a band
 *
 * The corpus is whatever this machine has been used for, so it moves as sessions are created. An earlier
 * draft of the record cited exact percentages from one message each, which did not reproduce for that
 * reason. The record states a band across a sample and this script prints the per-message rates, so the
 * spread is visible rather than summarised into a single number that the next run would contradict.
 *
 * ## Three corrections this script found in its own record
 *
 * A runnable measurement's whole value is that it can disagree with the prose. It did, three times:
 *
 *   - the record claimed the cost of ONE parse was superlinear, from two one-shot timings. Batched across
 *     many documents, per-parse cost is SUBlinear (~0.45x per character). The quadratic total is real, but
 *     the cause is the NUMBER of parses (N/4 prefixes averaging N/2 characters) — which is what section
 *     1's prefix walk demonstrates against the N/8 prediction;
 *   - the reveal percentages were quoted per single message, a measurement of three arbitrary messages
 *     rather than of the phenomenon;
 *   - and this script itself aborted out of memory at 4 GB, because it imported a fresh `markdown.ts`
 *     per measurement to force cold parses. Keying on a unique string is enough, and the two halves now
 *     run in separate processes.
 *
 * None of the three changes the decision, which is why they are stated in the record rather than quietly
 * renumbered. A reader who distrusts the prose can run this and see the same numbers.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { JSDOM } = await import(join(ROOT, "node_modules", "jsdom", "lib", "api.js"));

// jsdom before any module loads: DOMPurify binds to `window` at module-init time.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const MD = join(ROOT, "packages", "ui", "src", "markdown.ts");
const { renderMarkdown, markdownCacheStats } = await import(MD);

/*
 * WHICH HALF TO RUN.
 *
 * DOMPurify and markdown-it retain memory under jsdom here — measured at roughly 88 bytes per parse, while
 * the parse cache correctly plateaus at its 4M-character budget. That is harmless for a page and fatal for
 * a benchmark: the census alone is ~40 000 parses, so one process doing everything aborted at 4 GB partway
 * through section 2. Each half gets a fresh heap instead, and neither needs the other's numbers.
 */
const partIndex = process.argv.indexOf("--part");
const part = partIndex >= 0 ? Number(process.argv[partIndex + 1]) : 0;

if (part === 0) {
  for (const which of [1, 2]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--part", String(which)], {
      stdio: "inherit",
    });
    if (child.status !== 0) process.exit(child.status ?? 1);
  }
  process.exit(0);
}

/*
 * TWO renderers, because the two halves want opposite things from the cache.
 *
 * `cold` is for TIMING. The cache is keyed on the EXACT source string, so a string never rendered before
 * cannot hit it: a unique suffix buys a cold parse without importing a fresh module graph each time. The
 * `misses` assertion keeps that honest, because a benchmark that silently began hitting the cache would
 * report a fast path that does not exist.
 *
 * `warm` is for the CENSUS, and a cache hit is the correct answer there. The census asks what markup a
 * given prefix produces, which is a pure function of the text. A suffix would change the text being
 * measured, and trailing `**` and unclosed backticks are precisely what the census is about.
 */
let unique = 0;
let parses = 0;
/** A guard: a runaway loop here would present as a slow benchmark rather than as a bug. */
const PARSE_BUDGET = 60_000;
function counted(source, render) {
  parses += 1;
  if (parses > PARSE_BUDGET) throw new Error("parse budget exhausted — this run would not finish");
  return render(source);
}
function cold(source) {
  unique += 1;
  const before = markdownCacheStats().misses;
  const html = counted(source + " " + unique, renderMarkdown);
  if (markdownCacheStats().misses === before) {
    throw new Error("the benchmark hit the parse cache — the measurement is not cold");
  }
  return html;
}
const warm = (source) => counted(source, renderMarkdown);

const FENCE = String.fromCharCode(96, 96, 96);
const STORE = join(homedir(), ".pi", "agent", "sessions");

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".jsonl")) {
      try {
        out.push({ path, modified: statSync(path).mtimeMs });
      } catch {
        // A session removed between the dirent and the stat is not worth reporting here.
      }
    }
  }
  return out;
}

/** The assistant's own prose, deduplicated: a resumed session repeats earlier messages. */
function assistantTexts(file) {
  const out = new Set();
  for (const line of readFileSync(file.path, "utf8").split("\n")) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "message" || record.message?.role !== "assistant") continue;
    if (!Array.isArray(record.message.content)) continue;
    for (const block of record.message.content) {
      if (block.type === "text" && typeof block.text === "string") out.add(block.text);
    }
  }
  return [...out];
}

const files = walk(STORE).sort((a, b) => b.modified - a.modified).slice(0, 150);
const corpus = [];
for (const file of files) {
  for (const text of assistantTexts(file)) {
    if (text.length >= 600 && text.length <= 3200) corpus.push(text);
  }
}

if (corpus.length === 0) {
  console.error(`No assistant message of 600-3200 characters found under ${STORE}. Run a session first.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// PART 1 — what one streamed message costs
// ---------------------------------------------------------------------------------------------

if (part === 1) {
  const stride = (from, to, count) =>
    Array.from({ length: count }, (_, i) => Math.min(to, Math.round(from + ((to - from) * (i + 1)) / count)));

  function cost(text, ends) {
    const started = performance.now();
    for (const end of ends) cold(text.slice(0, end));
    return { parses: ends.length, ms: Number((performance.now() - started).toFixed(1)) };
  }

  const sample = (predicate) => corpus.find(predicate);
  const groups = [
    ["prose", sample((t) => !t.includes(FENCE) && !t.includes("\n|") && /\*\*/.test(t))],
    ["fence", sample((t) => t.includes(FENCE) && !t.includes("\n|"))],
    ["table", sample((t) => t.includes("\n|") && !t.includes(FENCE))],
  ];

  /*
   * THREE runs, and the spread is printed.
   *
   * One reading of this ratio is not a number: repeated runs of these three messages have produced
   * everything from 8.9x to 14.4x. The record therefore claims "an order of magnitude", and this prints
   * the range it came from rather than a decimal that the next run will contradict.
   */
  const ROUNDS = 3;
  console.log("=== 1. what one streamed message costs ===");
  for (const [label, text] of groups) {
    if (text === undefined) {
      console.log(`${label.padEnd(6)} no sample in this corpus`);
      continue;
    }
    const ratios = [];
    let perDelta;
    let perFrame;
    for (let round = 0; round < ROUNDS; round += 1) {
      // One delta is ~4 characters, and each one re-parses everything received so far.
      perDelta = cost(text, stride(4, text.length, Math.floor((text.length - 4) / 4)));
      // The same stream coalesced to 60 Hz, over the number of frames the text fills at that rate.
      perFrame = cost(text, stride(4, text.length, 60));
      ratios.push(perDelta.ms / perFrame.ms);
    }
    const sorted = [...ratios].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(
      `${label.padEnd(6)} ${String(text.length).padStart(4)} chars` +
        ` | per-delta ${String(perDelta.parses).padStart(4)} parses, ~${perDelta.ms.toFixed(0)} ms` +
        ` | per-frame ${String(perFrame.parses).padStart(3)} parses, ~${perFrame.ms.toFixed(0)} ms` +
        ` | ratio ${median.toFixed(1)}x median of ${ROUNDS} (${sorted[0].toFixed(1)}-${sorted[sorted.length - 1].toFixed(1)}x)`,
    );
  }

  /*
   * WHY the total is quadratic, and the claim stated where it belongs.
   *
   * Not "one parse is superlinear" — measured properly it is SUBlinear (about 0.45x per character, because
   * a parse carries fixed per-call overhead). The quadratic total comes from the NUMBER of parses: a 4-char
   * stride does N/4 parses whose average input is N/2 characters, so ~N^2/8 characters are processed
   * against N for a single final parse. Predicted ratio: N/8. Measured below, so the arithmetic is checked
   * rather than asserted — an earlier draft compared two one-shot timings and drew the wrong conclusion
   * from GC noise.
   */
  const probe = (chars, tag) => {
    const para = "The **root cause** is in `scroll.ts`, where distance is measured after paint. ";
    let out = "";
    while (out.length < chars) out += para;
    return out.slice(0, chars - 10) + "u-" + tag;
  };

  /*
   * REPEATED, not one reading.
   *
   * A single one-final-parse denominator at 1500 characters is a few hundred microseconds, so it is mostly
   * JIT and GC noise: six runs produced one-parse values from 0.87 ms to 16.8 ms and ratios from 97x to
   * 240x against a predicted 188x. The 3000-character case is more stable (352-390x) because its
   * denominator is large enough to measure. Reporting one reading from either would be reporting noise as
   * arithmetic, which is the same mistake this section exists to correct — so the median is printed with
   * the spread, and an unstable denominator is labelled rather than quoted.
   */
  const REPEATS = 6;
  console.log("");
  for (const size of [1500, 3000]) {
    const ratios = [];
    const denominators = [];
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const text = probe(size, "walk" + repeat);
      const finals = Array.from({ length: 15 }, (_, i) => probe(size, "f" + repeat + "-" + i));
      const started = performance.now();
      for (const one of finals) cold(one);
      const oneParse = (performance.now() - started) / finals.length;
      denominators.push(oneParse);

      const ends = [];
      for (let end = 4; end <= text.length; end += 4) ends.push(end);
      const walkStart = performance.now();
      for (const end of ends) cold(text.slice(0, end));
      ratios.push((performance.now() - walkStart) / oneParse);
    }

    const sorted = [...ratios].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const predicted = Math.round(size / 4 / 2);
    // The denominator's own spread is the honest tell for whether the ratio can be trusted at this size.
    const trustworthy = Math.max(...denominators) / Math.min(...denominators) < 3;
    console.log(
      `  ${size} chars: every prefix costs ${median.toFixed(0)}x one final parse` +
        ` (arithmetic predicts ~${predicted}x = N/8; ${REPEATS} runs span ${sorted[0].toFixed(0)}-${sorted[sorted.length - 1].toFixed(0)}x)` +
        (trustworthy ? "" : "  <- denominator too small to trust at this size"),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// PART 2 — what revealing source characters shows the reader
// ---------------------------------------------------------------------------------------------

if (part === 2) {
  console.log("=== 2. what revealing SOURCE characters shows the reader ===");

  /** A prefix is literal when the reader is shown syntax characters rather than the thing they mark. */
  function showsLiteral(html) {
    const body = html.replace(/<[^>]*>/g, "");
    return /\*\*/.test(body) || /`[^`]*$/.test(body) || /\]\s*$/.test(body);
  }

  for (const [label, predicate] of [
    ["prose", (t) => !t.includes(FENCE) && !t.includes("\n|") && /\*\*/.test(t) && t.length <= 2000],
    ["fence", (t) => t.includes(FENCE) && !t.includes("\n|") && t.length <= 2000],
    ["table", (t) => t.includes("\n|") && !t.includes(FENCE) && t.length <= 2000],
  ]) {
    const sampleTexts = corpus.filter(predicate).slice(0, 12);
    if (sampleTexts.length === 0) continue;
    const rates = [];
    let firstAt = null;
    let worstRun = 0;
    for (const text of sampleTexts) {
      let positions = 0;
      let literal = 0;
      let run = 0;
      for (let end = 2; end <= text.length; end += 2) {
        positions += 1;
        if (showsLiteral(warm(text.slice(0, end)))) {
          literal += 1;
          run += 1;
          if (firstAt === null) firstAt = end;
          if (run > worstRun) worstRun = run;
        } else {
          run = 0;
        }
      }
      rates.push(Math.round((literal / positions) * 100));
    }
    rates.sort((a, b) => a - b);
    const median = rates[Math.floor(rates.length / 2)];
    console.log(
      `${label.padEnd(6)} n=${String(sampleTexts.length).padStart(2)}` +
        ` | rates ${rates.join(",")} %` +
        ` | median ${median}% range ${rates[0]}-${rates[rates.length - 1]}%` +
        ` | first literal at char ${firstAt}` +
        ` | longest run ${worstRun} chars`,
    );
  }

  const demo = "The **root ";
  console.log("");
  console.log(`  a reveal position shows: ${JSON.stringify(demo)} -> ${JSON.stringify(warm(demo))}`);
  console.log("  which is the punctuation the reader watches being eaten.");
}
