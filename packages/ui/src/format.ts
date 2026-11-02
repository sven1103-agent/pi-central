/**
 * Shared display helpers.
 *
 * Formatting is centralized because the rail is *scanned*, not read: six machine values must
 * align in a column and use one convention each. Scattering `toFixed` across components is how
 * `$0.0142` and `0.014` end up in adjacent rows.
 */
export { formatBytes } from "@pi-central/protocol";

import type { LiveSession } from "@pi-central/protocol";

/**
 * A cost, or an em dash when unknown.
 *
 * Never `$0.0000` for an unknown cost: that reads as "free" rather than "not reported", and
 * the two are different facts. Sub-cent values keep four decimals because a single turn often
 * costs less than a cent and rounding to `$0.00` would hide all of them.
 */
export function formatCost(cost: number | null): string {
  if (cost === null || !Number.isFinite(cost)) return "—";
  if (cost === 0) return "$0.00";
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** Token count, abbreviated at 1000 to keep the metric strip from shifting width. */
export function formatTokens(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens)) return "—";
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * Where context pressure stops being trivia and starts being a warning.
 *
 * This lives here, in the display module, because **three** surfaces need the same number and each used
 * to carry its own literal: `formatContext`'s word `full`, `ContextMeter`'s amber fill, and the rail
 * row's warning class (issue #13).
 *
 * It was already duplicated twice, and the comment on `ContextMeter`'s copy claimed the two "can never
 * disagree". They could: they were two independent `80`s in two files, and nothing would have failed if
 * one moved. Prose about an invariant is not the invariant, so there is one constant now, the meter
 * imports it, and the rail's comparison goes through `isNearFull` below.
 *
 * 80% is where compaction becomes likely within the next turn or two — the point at which the reader
 * has a decision to make (compact now, or finish the thought first).
 */
export const CONTEXT_PRESSURE_PERCENT = 80;

/** Is this session's context under pressure? `false` for unknown, which is not "fine" but is not a warning. */
export function isNearFull(percent: number | null): boolean {
  return percent !== null && Number.isFinite(percent) && percent >= CONTEXT_PRESSURE_PERCENT;
}

/** Context usage, or an em dash rather than a fabricated 0%. */
export function formatContext(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return "ctx —";
  const rounded = Math.round(percent);
  // At the threshold the number is joined by a word, so pressure is never conveyed by colour alone.
  return isNearFull(percent) ? `ctx ${rounded}% full` : `ctx ${rounded}%`;
}

export function formatThinking(level: string | undefined): string {
  if (!level) return "—";
  // Truncated to 3 because it shares a line with the model and the context meter.
  return level.length > 4 ? level.slice(0, 3) : level;
}

/** A duration as `0:34` or `1:02:03`. */
export function formatElapsed(fromMs: number, now = Date.now()): string {
  const total = Math.max(0, Math.floor((now - fromMs) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Relative time, coarse on purpose: the exact second is never the question. */
export function formatAge(modifiedMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - modifiedMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(modifiedMs).toLocaleDateString();
}

/**
 * Truncate from the middle, keeping the head and tail.
 *
 * Middle rather than trailing because both ends carry identity: `deepseek-ai/DeepSeek-V4.1-Flash`
 * is recognizable as `deepseek-ai/D…4.1-Flash` while `deepseek-ai/DeepS…` is not.
 */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1; // one character is spent on the ellipsis
  const head = Math.ceil(keep * 0.55);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * Shorten a path from the middle, keeping the head and tail.
 *
 * The same rule as `truncateMiddle`, with `$HOME` abbreviated first because it is noise in
 * every single row.
 */
export function shortenPath(path: string, max = 34, home?: string): string {
  let display = path;
  if (home && home.length > 1 && display.startsWith(home)) {
    display = `~${display.slice(home.length)}`;
  }
  return truncateMiddle(display, max);
}

/**
 * The model name, shortened to fit on a shared metrics line.
 *
 * The rail's third line carries model · thinking · context · cost, so an untruncated model
 * swallows the row: observed in a real screenshot as
 * `deepseek-ai/DeepSeek-V4.1-Flash  high  ct…` — the context and cost were cut off entirely,
 * which is worse than a shortened model name because those are the values you scan for.
 */
export function formatModel(model: string | undefined, max = 14): string {
  if (!model) return "model —";
  return truncateMiddle(model, max);
}

/**
 * What to CALL a session: one rule, used by the rail for a live session and for a remembered one.
 *
 * ## The bug this exists to stop
 *
 * Reported from the rail, twice in one sentence: unnamed scratch sessions showed **"Undefined"**, and after a
 * restart they showed **the handle** (`s2`) instead. Both were the same defect — the label was whatever had been
 * stored, with no rule applied — and it appeared exactly where the two code paths diverged: a live row went
 * through `displayName`, a row that was not running read `entry.name` raw.
 *
 * ## The rule
 *
 * A name is only shown when it is a name a person chose. A scratch session's default name is its handle
 * (`defaultName` falls back to the id), and Pi may report an empty or `undefined`-ish value before anything is
 * named — none of those are information, so they get a generic label instead of a fabricated title.
 *
 * `id` is the last resort for a non-scratch session, because a handle at least identifies the row.
 */
/** How much of the opening prompt a derived title shows. */
export const TITLE_FROM_PROMPT_MAX = 48;

/**
 * A session's label when nobody has named it: the first thing the reader asked for.
 *
 * ## Why not the handle
 *
 * It was the handle (`s4`), and reported from use: *"when creating a new session it gets the handle name like s4,
 * which means nothing to users."* Correct — and measured, not assumed: of **888 sessions in this machine's store,
 * only 9 carry a name**, and all nine are deliberate human titles (*"Data Manager"*, *"Heavy Lifting"*). So an
 * unnamed session is not an edge case, it is 99% of them, and `s4` is what the rail would show almost always.
 *
 * ## Why the prompt, specifically
 *
 * It is the option #77 named when it weighed generated names: *"a title derived from the first user message — Pi
 * Central already holds the transcript, and that prompt is what the human would have named it."* It is also
 * available for **every** session: measured on the same store, 885 of 888 have a `firstMessage`.
 *
 * A prompt-derived title is also *not* the thing #77 rejected. That objection was that *"a generated name looks
 * chosen"*, which removes the nudge to name a session — and a truncated question does not look chosen: it reads as
 * a preview, in quotes, cut mid-sentence. It gives the reader what they actually wanted, which is to recognise the
 * task, not to admire a label.
 *
 * ## The rules
 *
 *   - Whitespace collapses, because a prompt is full of newlines and indentation and the rail is one line.
 *   - It truncates at a WORD boundary where one is near the limit, so the title is not cut mid-word when it does
 *     not have to be.
 *   - Markdown noise is stripped from the start: `# `, `- `, `> ` and a `@path` mention would otherwise lead.
 *   - It is wrapped in typographic quotes so the reader can see it is an excerpt, not a name somebody gave.
 */
export function titleFromPrompt(firstMessage: string | undefined): string | undefined {
  const raw = firstMessage?.replace(/\s+/g, " ").trim();
  if (raw === undefined || raw.length === 0) return undefined;

  /*
   * Leading structural noise: a heading marker, a list bullet, a quote marker.
   *
   * The `\s*` rather than `\s+` matters, and was found by a test: `"# "` collapses to `"#"` under the whitespace
   * rule above (trailing space trimmed), so a pattern requiring a space after the marker missed it and produced a
   * label of `"#"`. A marker with nothing after it is markup and nothing else, and must yield no title at all.
   */
  const cleaned = raw.replace(/^(?:#{1,6}\s*|[-*+]\s+|>\s+)/, "").trim();
  if (cleaned.length === 0) return undefined;

  if (cleaned.length <= TITLE_FROM_PROMPT_MAX) return `\u201c${cleaned}\u201d`;

  // Prefer the last space before the limit, so the cut lands between words; fall back to a hard cut when the
  // prompt is one long token (a URL or a path), where a word boundary does not exist.
  const window = cleaned.slice(0, TITLE_FROM_PROMPT_MAX);
  const lastSpace = window.lastIndexOf(" ");
  const cut = lastSpace > TITLE_FROM_PROMPT_MAX * 0.6 ? window.slice(0, lastSpace) : window;
  return `\u201c${cut.trimEnd()}\u2026\u201d`;
}

/**
 * The label for a session, with the prompt as the fallback when it has no name.
 *
 * `firstMessage` is optional and the handle remains the last resort: a session with neither a name nor a prompt
 * still has to be addressable, and an empty label would make the row unclickable in practice.
 */
export function nameLabel(
  name: string | undefined,
  scratch: boolean,
  id: string,
  firstMessage?: string | undefined,
): string {
  const trimmed = name?.trim();
  // The literals matter: a stored `"undefined"` is a value that reached storage, not a missing key, and it must
  // not be rendered as though a person had typed it.
  const isPlaceholder =
    trimmed === undefined || trimmed.length === 0 || /^(undefined|null)$/i.test(trimmed) || /^s\d+$/.test(trimmed);
  if (scratch) return isPlaceholder ? "Scratch session" : trimmed;
  if (!isPlaceholder) return trimmed;
  // The reader's own words beat a handle — see `titleFromPrompt`.
  return titleFromPrompt(firstMessage) ?? id;
}

/** A live session's display name. A thin adapter, so there is exactly one labelling rule. */
export function displayName(session: LiveSession, firstMessage?: string | undefined): string {
  return nameLabel(session.name, session.scratch, session.id, firstMessage);
}

/**
 * A one-line description of where the session works.
 *
 * Scratch sessions show `scratch · <id>` rather than the internal workspace path: the path is
 * an implementation detail (US-3), and hiding it keeps the rail scannable. The full path is in
 * the inspector and the header for anyone who needs it.
 */
export function whereLine(session: LiveSession, home?: string): string {
  if (session.scratch) return `scratch · ${session.id}`;
  return shortenPath(session.cwd, 34, home);
}

/**
 * Where a session works, as the header states it: one location, said once.
 *
 * Extracted from the component because the first version appended the path to `whereLine`, and
 * `whereLine` ALREADY returns the path for a project session — so the header printed
 * `/Users/…/idea-factory · /Users/…/idea-factory`. A duplicated value is a small bug with a
 * large cost: it reads as two different facts that happen to agree.
 *
 * A scratch session is the one case where two facts genuinely differ, so it gets both: the
 * `scratch · s7` abstraction AND the real path, because the header is where the actual location
 * belongs.
 */
export function headerLocation(session: LiveSession, home?: string, max = 70): string {
  if (session.scratch) {
    return `${whereLine(session, home)} · ${shortenPath(session.cwd, max, home)}`;
  }
  return shortenPath(session.cwd, max, home);
}

/** Clipboard write that never throws into a render. Returns whether it succeeded. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
