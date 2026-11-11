/**
 * Context usage, tokens and cost — read from Pi, coalesced per session.
 *
 * ## Why this module exists
 *
 * The numbers used to be fetched only on `agent_settled`, which is the end of a whole run. A new
 * session given a complex task spends minutes in turns before that, so the header read `ctx —` and
 * the rail showed no bar for a run that was already costing money. The comment beside the old call
 * said stats were "cosmetic"; the context meter is the one telemetry value that changes what a
 * reader should do (see `ContextMeter.tsx`), so it cannot be minutes stale.
 *
 * ## Why a coalescer and not just a `send` per record
 *
 * The cadence is now `turn_end` (see `interpretRecord`), so refreshes arrive seconds apart — but a
 * compaction, a settle and a turn can land inside one round trip, and a Pi that is slow to answer
 * would otherwise accumulate a promise per turn, each with a 20s deadline. One question in flight per
 * session, and the asks that arrive while it is out merge into a single follow-up: the follow-up
 * answers for all of them, because Pi's answer is a snapshot of a state that only grows.
 *
 * The follow-up (rather than dropping the late asks) is what keeps the LAST number on screen honest:
 * a turn that finishes mid-flight changed the answer, so the in-flight reply is already stale.
 */
import type { LiveSession } from "@pi-central/protocol";

/** The subset of Pi's `get_session_stats` answer this module reads. Everything is untrusted. */
export interface SessionStats {
  contextPercent: number | null;
  tokensTotal: number | null;
  cost: number | null;
}

/**
 * Narrow Pi's stats payload, or report nothing.
 *
 * Unreported stays `null` all the way through: `contextUsage` is genuinely absent while Pi has no
 * context window to measure against, and `percent` is `null` between a compaction and the next
 * assistant response. Coercing either to `0` would draw an empty meter, which says "you have a whole
 * window free" about a session nobody has measured.
 */
export function readStats(raw: unknown): SessionStats {
  const stats = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const context = stats["contextUsage"];
  const contextUsage = (typeof context === "object" && context !== null ? context : undefined) as
    | { percent?: unknown }
    | undefined;
  const tokens = stats["tokens"];
  const tokenTotals = (typeof tokens === "object" && tokens !== null ? tokens : undefined) as
    | { total?: unknown }
    | undefined;

  const percent = contextUsage?.percent;
  const total = tokenTotals?.total;
  const cost = stats["cost"];
  return {
    contextPercent: typeof percent === "number" && Number.isFinite(percent) ? percent : null,
    tokensTotal: typeof total === "number" && Number.isFinite(total) ? total : null,
    cost: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
  };
}

/** Apply a stats reading to a live session, in place. Returns nothing — the caller patches once. */
export function applyStats(session: LiveSession, stats: SessionStats): void {
  session.contextPercent = stats.contextPercent;
  session.tokensTotal = stats.tokensTotal;
  session.cost = stats.cost;
}

/**
 * At most one refresh in flight per key, with the asks that arrived during it merged into one more.
 *
 * `refresh` is injected rather than using the supervisor's process map, so this is testable without
 * spawning Pi — the same seam `clearQueueVia` uses for its ordering.
 */
export class RefreshCoalescer {
  #inFlight = new Set<string>();
  #pending = new Set<string>();

  /** Run `refresh` for `key`, or note that it should run again when the current one finishes. */
  async run(key: string, refresh: () => Promise<void>): Promise<void> {
    if (this.#inFlight.has(key)) {
      this.#pending.add(key);
      return;
    }
    this.#inFlight.add(key);
    try {
      for (;;) {
        await refresh();
        // Deleted without testing for a live session: a stopped session's refresh is a no-op anyway, and
        // `refresh` is what knows that. The loop is bounded by how often a caller can ask, which is one per
        // turn — not by anything this class has to guess.
        if (!this.#pending.delete(key)) break;
      }
    } finally {
      this.#inFlight.delete(key);
      this.#pending.delete(key);
    }
  }

  /** Is a refresh outstanding or owed for this key? Exposed for tests and diagnosis. */
  busy(key: string): boolean {
    return this.#inFlight.has(key) || this.#pending.has(key);
  }
}
