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

/** Context usage, or an em dash rather than a fabricated 0%. */
export function formatContext(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return "ctx —";
  const rounded = Math.round(percent);
  // At 80%+ the number is joined by a word, so pressure is never conveyed by colour alone.
  return rounded >= 80 ? `ctx ${rounded}% full` : `ctx ${rounded}%`;
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
export function nameLabel(name: string | undefined, scratch: boolean, id: string): string {
  const trimmed = name?.trim();
  // The literals matter: a stored `"undefined"` is a value that reached storage, not a missing key, and it must
  // not be rendered as though a person had typed it.
  const isPlaceholder =
    trimmed === undefined || trimmed.length === 0 || /^(undefined|null)$/i.test(trimmed) || /^s\d+$/.test(trimmed);
  if (scratch) return isPlaceholder ? "Scratch session" : trimmed;
  return isPlaceholder ? id : trimmed;
}

/** A live session's display name. A thin adapter, so there is exactly one labelling rule. */
export function displayName(session: LiveSession): string {
  return nameLabel(session.name, session.scratch, session.id);
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
