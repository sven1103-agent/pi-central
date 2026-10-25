/**
 * Shared display helpers.
 *
 * Formatting is centralized because the rail is *scanned*, not read: six machine values must
 * align in a column and use one convention each. Scattering `toFixed` across components is how
 * `$0.0142` and `0.014` end up in adjacent rows.
 */
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
 * Shorten a path from the middle, keeping the head and tail.
 *
 * Middle truncation rather than trailing: `/Users/x/git/idea…ry/pi-central` still tells you
 * which project it is, while `/Users/x/git/idea-factory/pi-ce…` does not.
 */
export function shortenPath(path: string, max = 34, home?: string): string {
  let display = path;
  // `$HOME` is abbreviated because it is noise in every single row.
  const prefix = home ?? "";
  if (prefix && display.startsWith(prefix)) display = `~${display.slice(prefix.length)}`;
  if (display.length <= max) return display;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.55);
  const tail = keep - head;
  return `${display.slice(0, head)}…${display.slice(display.length - tail)}`;
}

/** A session's display name, falling back to something more useful than a bare id. */
export function displayName(session: LiveSession): string {
  const name = session.name?.trim();
  // A scratch session named `s7` tells the reader nothing. It gets a generic label instead of
  // a fabricated title, since the first message may not have arrived yet.
  if (!name || (session.scratch && /^s\d+$/.test(name))) return session.scratch ? "Scratch session" : name ?? session.id;
  return name;
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

/** Clipboard write that never throws into a render. Returns whether it succeeded. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
