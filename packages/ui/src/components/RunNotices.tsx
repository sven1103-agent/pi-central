/**
 * Compaction and retry banners (issue #5).
 *
 * ## The rule these follow
 *
 * A session that is compacting or retrying is **working**, not stalled. Before this, a provider
 * failure or a compaction produced several seconds of a still transcript with no explanation, and the
 * honest reading of a still transcript is "Pi Central has stopped doing anything". So the banner
 * exists to say what Pi is doing to the run.
 *
 * ## What a banner must NOT do, and these are the constraints from the issue
 *
 *   1. **Never a live region.** DESIGN.md §9: announcing per delta emits hundreds of utterances per
 *      turn. A retry banner updates on every attempt, so `role="alert"` would be actively hostile.
 *      They are `role="status"` at most, and the stream is not announced at all — the transcript
 *      region already carries `aria-busy` for that purpose.
 *   2. **Never a state change.** `agent_end` is not `agent_settled` (C8), and a retry can follow a
 *      failed turn. The banner is rendered from a notice in the transcript; it does not touch
 *      `LiveSession.state`, and a reducer test asserts the session stays `streaming`.
 *   3. **Never a claim of completion.** A finished compaction says what it did — the token drop —
 *      and a successful retry says it recovered. Neither says the turn is over.
 *
 * ## Why the copy differs per outcome
 *
 * An ABORTED compaction and a completed one are opposite facts and must not share a sentence. A
 * compaction that will retry is a third. The `ended` shape carries exactly those distinctions,
 * because collapsing them into "compaction finished" would report a failure as a success — the kind
 * of lie this project treats as worse than a missing feature.
 */
import type { RunNotice } from "../transcript.ts";
import { noticeIsOpen } from "../transcript.ts";
import { formatTokens } from "../format.ts";

/** How a compaction ended, as a sentence. Never "done": each outcome is a different fact. */
function compactionOutcome(notice: Extract<RunNotice, { kind: "compaction" }>): string {
  const ended = notice.ended;
  if (!ended) return "Compacting context…";
  if (ended.aborted) return "Context compaction stopped.";
  if (ended.errorMessage !== undefined) return `Context compaction failed: ${ended.errorMessage}`;
  if (ended.willRetry) return "Context compaction failed; retrying…";
  const before = notice.tokensBefore;
  const after = notice.tokensAfter;
  // The drop is the useful part. Absent numbers are omitted rather than rendered as `0`, which would
  // claim the context was emptied.
  if (typeof before === "number" && typeof after === "number") {
    return `Context compacted: ${formatTokens(before)} → ${formatTokens(after)} tokens.`;
  }
  return "Context compacted.";
}

/** Why a compaction started, which changes what the reader should expect. */
function compactionReason(reason: string): string | undefined {
  switch (reason) {
    case "overflow":
      return "the context was full";
    case "threshold":
      return "the context crossed the threshold";
    case "manual":
      return "you asked for it";
    default:
      // An unrecognised reason is not guessed at: Pi may add one, and inventing "the context was
      // full" would be a specific false claim about why the reader's session paused.
      return undefined;
  }
}

export function RunNoticeBanner({ notice }: { notice: RunNotice }) {
  const open = noticeIsOpen(notice);

  if (notice.kind === "compaction") {
    const reason = compactionReason(notice.reason);
    return (
      <div className="run-notice" data-kind="compaction" data-open={open || undefined}>
        <span className="notice-glyph" aria-hidden="true">
          {open ? "◐" : notice.ended?.aborted || notice.ended?.errorMessage ? "✕" : "✓"}
        </span>
        <span className="notice-text">{compactionOutcome(notice)}</span>
        {open && reason !== undefined && <span className="notice-note">({reason})</span>}
      </div>
    );
  }

  if (notice.kind === "retry") {
    const ended = notice.ended;
    // `attempt` and `maxAttempts` are both stated, because "retrying" without a bound reads as an
    // unbounded loop — and Pi's own limit is the thing that tells the reader whether to wait.
    const label = `Retrying (${notice.attempt}/${notice.maxAttempts})`;
    const delay = notice.delayMs > 0 ? ` in ${Math.round(notice.delayMs / 1000)}s` : "";
    if (!ended) {
      return (
        <div className="run-notice" data-kind="retry" data-open>
          <span className="notice-glyph" aria-hidden="true">
            ↻
          </span>
          <span className="notice-text">
            {label}
            {delay} after {notice.errorMessage || "a provider error"}
          </span>
        </div>
      );
    }
    return (
      <div className="run-notice" data-kind="retry">
        <span className="notice-glyph" aria-hidden="true">
          {ended.success ? "✓" : "✕"}
        </span>
        <span className="notice-text">
          {ended.success
            ? `Recovered after ${notice.attempt} ${notice.attempt === 1 ? "retry" : "retries"}.`
            : `Gave up after ${notice.attempt} ${notice.attempt === 1 ? "attempt" : "attempts"}: ${
                ended.finalError ?? notice.errorMessage
              }`}
        </span>
      </div>
    );
  }

  // Summarization: a DIFFERENT mechanism from `auto_retry`, so it gets its own wording. Reporting it
  // as a provider retry would misattribute the failure — nothing was wrong with the provider.
  const source = notice.source === "branchSummary" ? "summary of the earlier branch" : "context summary";
  return (
    <div className="run-notice" data-kind="summarization" data-open={open || undefined}>
      <span className="notice-glyph" aria-hidden="true">
        {notice.finished ? "✓" : "↻"}
      </span>
      <span className="notice-text">
        {notice.finished
          ? `Recovered while building the ${source}.`
          : `Retrying the ${source} (${notice.attempt}/${notice.maxAttempts})${
              notice.errorMessage !== undefined ? `: ${notice.errorMessage}` : ""
            }`}
      </span>
    </div>
  );
}

/**
 * Every notice for a session, in arrival order.
 *
 * Rendered WITHOUT `aria-live`, and that is the deliberate choice the issue names. The notices
 * change as attempts are made, and a live region would announce each change — hundreds of utterances
 * across a run. They are in the document, reachable by reading, which is the same trade the
 * transcript's `aria-busy` makes.
 */
export function RunNotices({ notices }: { notices: readonly RunNotice[] | undefined }) {
  // Absent and empty mean the same thing here — "none were seen" — so both render nothing rather
  // than an empty wrapper that would add a gap to every transcript.
  if (notices === undefined || notices.length === 0) return null;
  return (
    <div className="run-notices">
      {notices.map((notice, index) => (
        <RunNoticeBanner key={`${notice.kind}-${index}`} notice={notice} />
      ))}
    </div>
  );
}
