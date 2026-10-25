/**
 * The thinking-level picker (issue #2).
 *
 * Constrained by the CURRENT model, not by a hardcoded list: Pi reports the levels a model supports
 * via `get_available_thinking_levels`, and a model without extended thinking has fewer of them. So
 * the levels are (a) read from Pi, (b) re-read whenever the model changes, and (c) never offered
 * from a cached list belonging to another model.
 *
 * ## Why the re-read matters more than it looks
 *
 * Pi re-applies the thinking level on a model switch (`agent-session.js:2013`,
 * `_getThinkingLevelForModelSwitch`), so after changing the model the level can legitimately be
 * something other than it was. Two consequences shape this component:
 *
 *   - A level that no longer exists must not remain selectable. The list belongs to the model, so
 *     a switch **invalidates** it — `thinkingLevelsFor` below keys the request on
 *     provider/id/level, which is exactly the set of facts that make a fetched list current.
 *   - The displayed level comes from `LiveSession.thinkingLevel`, which the orchestrator sets from
 *     `get_state` and from `thinking_level_changed` records. The picker therefore follows Pi rather
 *     than its own last request, which is what the issue's third criterion asks for.
 *
 * A native `<select>`, for the same reason as the model picker: correct for keyboard and screen
 * readers with no code, and it cannot be broken by a focus bug.
 */
import type { LiveSession } from "@pi-central/protocol";
import { useEffect, useState } from "react";

export interface ThinkingPickerProps {
  session: LiveSession;
  /** What Pi reported for THIS model. `undefined` means it has not been read for it yet. */
  levels: string[] | undefined;
  error: string | undefined;
  /** Ask for the levels of the current model. Called on first render and on an explicit retry. */
  onRequest: () => void;
  onSelect: (level: string) => void;
}

/**
 * The identity of a thinking-level list: what must stay the same for a fetched list to be current.
 *
 * The model matters because the list is per-model. The level is included because Pi re-applies it on
 * a switch, so the reported level can change without the user asking — and a stale list keyed only
 * on the model would then disagree with the level in effect.
 */
export function thinkingLevelsFor(session: LiveSession): string {
  return `${session.provider ?? "?"}/${session.model ?? "?"}@${session.thinkingLevel ?? "?"}`;
}

export function ThinkingPicker({ session, levels, error, onRequest, onSelect }: ThinkingPickerProps) {
  // Remembers which identity the user has already asked about, so a re-render does not refetch. A
  // model or level change produces a new identity, which asks again — that is the mechanism by
  // which the list is never stale.
  const [askedFor, setAskedFor] = useState<string | undefined>(undefined);
  const identity = thinkingLevelsFor(session);
  const usable = session.state !== "starting" && session.state !== "stopped" && session.state !== "failed";

  // An EFFECT, not a call during render. Requesting during render would fire on every React render,
  // including the double render of StrictMode, and — the reason it was caught — during server-side
  // rendering, where a side effect is silently wrong and the component test renders to a string.
  // ALL hooks precede the error-branch return below, because hooks cannot be conditional.
  useEffect(() => {
    if (!usable || askedFor === identity) return;
    setAskedFor(identity);
    onRequest();
  }, [usable, identity, askedFor, onRequest]);

  // `levels` may belong to a previous model. Reporting an unread list as "no levels" would be a
  // claim about the model rather than about the attempt, so the two are rendered differently.
  const loaded = levels !== undefined;
  const current = session.thinkingLevel ?? "—";

  if (error !== undefined) {
    return (
      <div className="picker picker-broken">
        <span className="picker-label">Thinking</span>
        <span className="picker-value" title={error}>
          {current}
        </span>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            // Clearing the remembered identity is what makes this an actual retry: the effect above
            // sees a mismatch and asks again. A retry that were also guarded would be a button that
            // cannot work.
            setAskedFor(undefined);
          }}
        >
          Retry
        </button>
        <span className="picker-note warn">Could not read the levels: {error}</span>
      </div>
    );
  }

  return (
    <div className="picker">
      <label className="picker-label" htmlFor={`thinking-${session.id}`}>
        Thinking
      </label>
      <select
        id={`thinking-${session.id}`}
        className="picker-select picker-select-narrow"
        // The session's value, never the request's: a level Pi refused leaves the control where it
        // was rather than showing what was asked for.
        value={loaded && levels.includes(current) ? current : ""}
        disabled={!usable || !loaded}
        onChange={(event) => {
          if (event.target.value !== "") onSelect(event.target.value);
        }}
      >
        {/* The current level is an option even before the list arrives, so the control displays the
            truth rather than an empty selection. */}
        {(!loaded || !levels.includes(current)) && <option value="">{current}</option>}
        {loaded && levels.map((level) => <option key={level} value={level}>{level}</option>)}
      </select>
      {!loaded && <span className="picker-note">reading the levels…</span>}
    </div>
  );
}
