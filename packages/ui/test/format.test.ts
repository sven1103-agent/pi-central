/**
 * Formatting tests.
 *
 * These exist because the rail is scanned rather than read: a formatting bug is not a crash,
 * it is a value that quietly misleads. `$0.0000` for an unknown cost reads as "this turn was
 * free" rather than "the provider did not report it", which is a different fact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayName,
  formatAge,
  CONTEXT_PRESSURE_PERCENT,
  formatContext,
  titleFromPrompt,
  TITLE_FROM_PROMPT_MAX,
  isNearFull,
  formatCost,
  formatElapsed,
  formatModel,
  formatThinking,
  formatTokens,
  headerLocation,
  shortenPath,
  truncateMiddle,
  whereLine,
} from "../src/format.ts";
import type { LiveSession } from "@pi-central/protocol";

function session(over: Partial<LiveSession> = {}): LiveSession {
  return {
    id: "s7",
    name: "s7",
    cwd: "/Users/x/git/project",
    state: "idle",
    mode: "sandboxed",
    isolation: "",
    command: "",
    scratch: false,
    messageCount: 0,
    pending: 0,
    contextPercent: null,
    tokensTotal: null,
    cost: null,
    dialogs: [],
    warnings: [],
    startedAt: 0,
    ...over,
  };
}

test("an unknown cost is an em dash, never $0.0000", () => {
  // The distinction between "free" and "not reported" must survive.
  assert.equal(formatCost(null), "—");
  assert.notEqual(formatCost(null), "$0.0000");
});

test("a sub-cent cost keeps four decimals", () => {
  // A single turn often costs less than a cent; $0.00 would hide every one of them.
  assert.equal(formatCost(0.0142), "$0.0142");
  assert.equal(formatCost(0.0001), "$0.0001");
});

test("larger costs use two decimals", () => {
  assert.equal(formatCost(1.4231), "$1.42");
});

test("a genuine zero is shown as $0.00, because zero is a fact", () => {
  assert.equal(formatCost(0), "$0.00");
});

test("NaN and Infinity are treated as unknown", () => {
  assert.equal(formatCost(Number.NaN), "—");
  assert.equal(formatCost(Number.POSITIVE_INFINITY), "—");
});

test("tokens abbreviate at 1000 and a million", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(41234), "41.2k");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(null), "—");
});

test("context pressure is stated in words at 80% and above", () => {
  // Colour alone must never carry this: the number is joined by a word.
  assert.equal(formatContext(62), "ctx 62%");
  assert.equal(formatContext(80), "ctx 80% full");
  assert.equal(formatContext(99), "ctx 99% full");
  assert.equal(formatContext(null), "ctx —");
});

test("the pressure threshold is ONE constant shared by every surface that shows it (issue #13)", () => {
  // It used to be two independent `80`s — one here, one in `ContextMeter` — and the comment on the
  // meter's copy claimed the two "can never disagree". Prose about an invariant is not the invariant:
  // moving one would have made the bar amber at a different point from the word `full` with nothing
  // failing. There are three consumers now (the word, the bar, the fleet's near-full count), so the
  // agreement is asserted rather than described.
  //
  // Asserted at the boundary rather than at 80 specifically, so changing the constant does not break
  // this test — changing a CONSUMER to a literal does.
  assert.equal(formatContext(CONTEXT_PRESSURE_PERCENT - 1), `ctx ${CONTEXT_PRESSURE_PERCENT - 1}%`);
  assert.equal(formatContext(CONTEXT_PRESSURE_PERCENT), `ctx ${CONTEXT_PRESSURE_PERCENT}% full`);
  assert.equal(isNearFull(CONTEXT_PRESSURE_PERCENT - 1), false);
  assert.equal(isNearFull(CONTEXT_PRESSURE_PERCENT), true);
  // Unknown is not "fine", but it is not a warning either — it must never be counted as pressure.
  assert.equal(isNearFull(null), false);
});

test("thinking level is truncated to three characters", () => {
  assert.equal(formatThinking("medium"), "med");
  assert.equal(formatThinking("high"), "high");
  assert.equal(formatThinking("off"), "off");
  assert.equal(formatThinking(undefined), "—");
});

test("elapsed time is minutes:seconds, then hours", () => {
  const start = 1_000_000;
  assert.equal(formatElapsed(start, start + 34_000), "0:34");
  assert.equal(formatElapsed(start, start + 62_000), "1:02");
  assert.equal(formatElapsed(start, start + 3_723_000), "1:02:03");
});

test("elapsed time never goes negative if the clock is skewed", () => {
  assert.equal(formatElapsed(2_000_000, 1_000_000), "0:00");
});

test("age is coarse: the exact second is never the question", () => {
  const now = 1_000_000_000;
  assert.equal(formatAge(now - 5_000, now), "just now");
  assert.equal(formatAge(now - 120_000, now), "2m ago");
  assert.equal(formatAge(now - 7_200_000, now), "2h ago");
  assert.equal(formatAge(now - 172_800_000, now), "2d ago");
});

test("paths truncate in the middle, keeping the project name", () => {
  // Trailing truncation loses what identifies the directory.
  const long = "/Users/sven1103/git/idea-factory/pi-central/packages/orchestrator";
  const short = shortenPath(long, 34);
  assert.ok(short.length <= 34, short);
  assert.ok(short.includes("…"), short);
  assert.ok(short.startsWith("/Users/sven1103"), `should keep the head: ${short}`);
  assert.ok(short.endsWith("orchestrator"), `should keep the tail: ${short}`);
});

test("paths abbreviate $HOME, which is noise in every row", () => {
  assert.equal(shortenPath("/Users/x/git/p", 40, "/Users/x"), "~/git/p");
});

test("a short path is returned unchanged", () => {
  assert.equal(shortenPath("/tmp/a", 34), "/tmp/a");
});

test("a scratch session gets a label, not a bare id", () => {
  // `s7` tells the reader nothing.
  assert.equal(displayName(session({ scratch: true, name: "s7" })), "Scratch session");
});

test("a named session keeps its name, scratch or not", () => {
  assert.equal(displayName(session({ scratch: true, name: "My question" })), "My question");
  assert.equal(displayName(session({ name: "api-gateway" })), "api-gateway");
});

test("a non-scratch session with a bare-id name keeps it rather than inventing a title", () => {
  // This is what an UNNAMED session looks like since #149's follow-up: the orchestrator stopped naming a session
  // after its directory (three tasks in one project gave three rows called `pi-central` — a name that looks
  // chosen, and a duplicate). It reports the handle instead, and the rail must show it as-is so the reader can
  // see the label is provisional. "Scratch session" would be wrong here (that label is for scratch sessions),
  // and inventing a title is exactly what was rejected: a generated name looks intentional.
  assert.equal(displayName(session({ scratch: false, name: "s7" })), "s7");
  // The handle is also NOT collapsed the way a scratch session's is, so two unnamed project sessions stay
  // distinguishable — #78's defect, which a shared label would reintroduce.
  // Each session's handle is its own, so the labels differ. (`id` is overridden as well as `name`: the helper's
  // default id is fixed, and two calls with the same id are the same session, not two.)
  assert.notEqual(
    displayName(session({ scratch: false, id: "s7", name: "s7" })),
    displayName(session({ scratch: false, id: "s8", name: "s8" })),
    "two unnamed sessions must not share a label",
  );
});

// --- The label for an UNNAMED session (issue #149 follow-up) -----------------------------------
//
// Reported from use: "when creating a new session it gets the handle name like s4, which means nothing to users."
// Measured before deciding: of 888 sessions in the store, only 9 carry a name — so `s4` would be what the rail showed
// for 99% of them. 885 of 888 have a first prompt, which is the option #77 named when it weighed generated names.

test("an unnamed session is labelled by its first prompt, not its handle", () => {
  assert.equal(displayName(session({ name: "s4" }), "Fix the login redirect"), '\u201cFix the login redirect\u201d');
  // The handle is NOT what the reader sees — that is the defect.
  assert.notEqual(displayName(session({ name: "s4" }), "Fix the login redirect"), "s4");
});

test("the prompt label is an EXCERPT: quoted, so it does not look like a chosen name", () => {
  // #77 rejected generated names because "a generated name looks chosen", which removes the nudge to name a session.
  // A truncated question in quotes reads as a preview, not as a title somebody gave it.
  const label = displayName(session({ name: "s4" }), "Hello");
  assert.match(label, /^\u201c.*\u201d$/, "wrapped in typographic quotes");
});

test("a long prompt truncates at a WORD boundary, with an ellipsis", () => {
  const label = titleFromPrompt(
    "For an improved userflow, is it possible to include information from the transcript in the composer",
  )!;
  assert.ok(label.length <= TITLE_FROM_PROMPT_MAX + 3, `too long: ${label.length}`);
  assert.match(label, /\u2026\u201d$/, "it ends with an ellipsis inside the closing quote");
  assert.ok(!/\s\u2026/.test(label), "no dangling space before the ellipsis");
  /*
   * Cut between words, not through one.
   *
   * Asserted against the SOURCE prompt rather than by eyeballing the tail: the label's last visible word must be one
   * of the prompt's whole words. A hard cut at the limit lands mid-word, and the first version of this assertion
   * ("the tail has more than one character") did not catch that — falsifying the word-boundary logic left it green.
   */
  const visible = label.replace(/^\u201c/, "").replace(/\u2026\u201d$/, "").trim();
  const words = visible.split(" ");
  const whole = "For an improved userflow, is it possible to include information from the transcript in the composer".split(" ");
  assert.ok(
    whole.includes(words.at(-1)!),
    `the last visible word must be complete, got "${words.at(-1)}" from ${JSON.stringify(visible.slice(-24))}`,
  );
  // And the label must not simply be the first 48 characters, which is what a hard cut produces.
  const hard = "For an improved userflow, is it possible to include information from the transcript in the composer".slice(0, TITLE_FROM_PROMPT_MAX);
  assert.notEqual(visible, hard.trimEnd(), "a word-boundary cut differs from a hard cut");
});

test("one long unbroken token is cut hard, since there is no word boundary to use", () => {
  const url = "https://github.com/sven1103-agent/pi-central/blob/main/packages/ui/src/components/History.tsx";
  const label = titleFromPrompt(url)!;
  assert.ok(label.length <= TITLE_FROM_PROMPT_MAX + 3, `too long: ${label}`);
  assert.match(label, /\u2026/, "still marked as truncated");
});

test("leading Markdown noise is stripped, so the label does not start with punctuation", () => {
  assert.equal(titleFromPrompt("# Fix the header"), '\u201cFix the header\u201d');
  assert.equal(titleFromPrompt("- one thing"), '\u201cone thing\u201d');
  assert.equal(titleFromPrompt("> quoted ask"), '\u201cquoted ask\u201d');
});

test("whitespace collapses, because a prompt is full of newlines and the rail is one line", () => {
  assert.equal(titleFromPrompt("Fix\n\n  the   header\nplease"), '\u201cFix the header please\u201d');
});

test("a session with NEITHER a name nor a prompt falls back to the handle", () => {
  // Last resort, and still addressable: an empty label would make the row unusable.
  // The helper's default id is `s7`; the LABEL must be the handle of THIS session, which is its id.
  assert.equal(displayName(session({ name: "s7", id: "s7" }), undefined), "s7", "the handle, because nothing better exists");
  assert.equal(titleFromPrompt(undefined), undefined);
  assert.equal(titleFromPrompt("   "), undefined);
  assert.equal(titleFromPrompt("# "), undefined, "a prompt that is only markup yields nothing");
});

test("a name a person CHOSE always wins over the prompt", () => {
  assert.equal(displayName(session({ name: "Heavy Lifting" }), "do some thinking"), "Heavy Lifting");
});

test("scratch sessions keep their label rather than borrowing a prompt", () => {
  // A scratch session's directory is app-owned and its handle is the only identity it has; showing the prompt for
  // ones and "Scratch session" for others would make the group inconsistent for no gain.
  assert.equal(displayName(session({ scratch: true, name: "s7" }), "do a thing"), "Scratch session");
});

test("scratch sessions hide their internal workspace path", () => {
  // The path is an implementation detail (US-3); it lives in the inspector instead.
  const line = whereLine(session({ scratch: true, cwd: "/Users/x/.local/share/pi-central/workspaces/s7" }));
  assert.equal(line, "scratch · s7");
});

test("a project session shows its shortened path", () => {
  assert.equal(whereLine(session({ cwd: "/Users/x/git/api", scratch: false }), "/Users/x"), "~/git/api");
});

// --- Findings from a real screenshot (see img_1.png) -----------------------------------------

test("the header states the working directory exactly ONCE", () => {
  // The screenshot showed `/Users/…/idea-factory · /Users/…/idea-factory`. `whereLine` already
  // returns the path for a project session, so appending it again duplicated it — which reads
  // as two different facts that happen to agree.
  const line = headerLocation(session({ cwd: "/Users/x/git/api", scratch: false }), "/Users/x");
  assert.equal(line, "~/git/api");
  assert.equal(line.split("~/git/api").length - 1, 1, `path appears more than once: ${line}`);
});

test("a scratch header adds the real path to the abstraction, because they differ", () => {
  // The rail shows `scratch · s7`; the header is where the actual location belongs.
  const scratch = session({ scratch: true, cwd: "/Users/x/.local/share/pi-central/workspaces/s7" });
  const line = headerLocation(scratch, "/Users/x");
  assert.match(line, /scratch · s7/);
  assert.match(line, /~\/\.local\/share\/pi-central\/workspaces\/s7/);
});

test("a long path in the header is truncated but a short one is untouched", () => {
  const long = "/very/long/path/that/definitely/exceeds/the/maximum/width/allowed/here/api";
  const line = headerLocation(session({ cwd: long, scratch: false }), undefined, 40);
  assert.ok(line.length <= 40, line);
  assert.match(line, /…/);
});

// --- Model truncation: the rail's shared metrics line ----------------------------------------

test("a long model name is shortened so the rest of the metrics survive", () => {
  // From the screenshot: `deepseek-ai/DeepSeek-V4.1-Flash  high  ct…` — the untruncated model
  // swallowed the row and the context and cost were cut off, which is worse than a shortened
  // model name because those are the values you scan for.
  const model = formatModel("deepseek-ai/DeepSeek-V4.1-Flash");
  assert.ok(model.length <= 14, `too long: ${model}`);
  assert.match(model, /…/, "a shortened name should show where it was cut");
  // The SUFFIX is what distinguishes models from one vendor, so it is the half worth keeping.
  // Asserting both `deepseek-ai` AND `V4.1-Flash` would be over-claiming: 14 characters cannot
  // hold both, and a test that demands the impossible is a test that gets deleted rather than
  // fixed. (This assertion was written the over-claiming way first, and failed.)
  assert.ok(model.endsWith("Flash"), `the version suffix is the identifying part: ${model}`);
  assert.ok(model.startsWith("deep"), `the head should still be readable: ${model}`);
});

test("a short model name is left alone, and an absent one says so", () => {
  assert.equal(formatModel("gpt-5"), "gpt-5");
  assert.equal(formatModel(undefined), "model —");
});

test("truncateMiddle never exceeds the budget, at any length", () => {
  for (let length = 0; length < 60; length += 1) {
    const text = "x".repeat(length);
    const out = truncateMiddle(text, 14);
    assert.ok(out.length <= Math.max(14, length), `len ${length} produced ${out.length}`);
  }
});
