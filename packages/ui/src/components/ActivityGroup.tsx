/**
 * One activity group: the internal steps of a turn, behind ONE disclosure.
 *
 * ## What this replaces
 *
 * A tool run had its own bar, and each `thinking` block had its own bar above it. Because Pi interleaves
 * them, a real session rendered
 *
 *     Assistant · [Thinking] · 1 tool · Assistant · [Thinking] · 1 tool · …
 *
 * with every bar already collapsed. The rows were the clutter: there was no dominant result, no stable
 * progress anchor, and nothing to read except the machinery (`img_18.png`).
 *
 * Now a contiguous stretch of thinking and tool work is ONE line —
 *
 *     ▸ Running read · 1 earlier call failed
 *
 * — and opening it shows a LEDGER of the recorded steps in order:
 *
 *     1  Thinking   Read the diagram first, then the constraints file.…
 *     2  Tool output  read assets/architecture.svg            Inspect
 *     3  Thinking   The diagram is generated from the constraints.…
 *     4  Tool output  bash rg -n 'nest' docs/CONSTRAINTS.md  Inspect
 *
 * A row states WHAT ran and nothing else. Arguments and output are NOT rendered here — a real screenshot
 * (`img_19.png`) showed that turning the group into an inline copy of the tool trace produced fifty lines of
 * `ls -la` output and an `env` dump in the conversation. The trace already shows those properly, bounded and
 * in full, so `Inspect` is the one action a step offers.
 *
 * ## What the summary may say
 *
 * Only what was RECORDED (`activitySummary`). No percentages, no task names, no "done"/"success": a later
 * successful call is not evidence that an earlier failed one was recovered, and a settled session is not a
 * successful task. Failures and missing results stay in the collapsed line, because collapsing must not be
 * a way to lose the one fact that needs attention.
 *
 * ## Disclosure state lives above this component
 *
 * `<details>` owns its own open state, which is enough while the element keeps its identity. It does NOT
 * survive a remount, and `SessionView` remounts on every session switch — the #108 defect, one level down.
 * So the host renders this as a CONTROLLED disclosure: `open` and `onToggle` are props, and the state is
 * keyed by session and group in `App`. The rendered markup is still a native `<details>`/`<summary>`, so
 * keyboard behaviour, `aria-expanded` and find-in-page come from the browser rather than from a custom
 * widget.
 */
import type { ToolExecution } from "../transcript.ts";
import {
  activityIsLive,
  activityStatus,
  activitySummary,
  stepLabel,
  type ActivityPart,
} from "../activity.ts";
import type { ToolExecution as ToolExecutionType } from "../transcript.ts";

/** One row of the ledger: either a thought with words, or a tool call. */
type Step =
  | { kind: "thinking"; part: Extract<ActivityPart, { kind: "thinking" }> }
  | { kind: "tool"; part: Extract<ActivityPart, { kind: "tool" }>; tool: ToolExecutionType };

export function ActivityGroup({
  parts,
  tools,
  open,
  onToggle,
  live,
  onOpenTool,
}: {
  parts: readonly ActivityPart[];
  tools: readonly ToolExecution[];
  /** Controlled: the host owns this so it survives a session switch (see the header). */
  open: boolean;
  onToggle: (open: boolean) => void;
  /** The session is streaming. Used only for the live indicator's words, never to claim progress. */
  live: boolean;
  /**
   * Open one call in the tool trace.
   *
   * The group deliberately does NOT render arguments or output: the trace window already does that, with a
   * bounded height and a full view. A step is a signpost, so this is the one action it offers.
   */
  onOpenTool?: ((toolCallId: string) => void) | undefined;
}) {
  const status = activityStatus(parts, tools);
  const summary = activitySummary(status);
  const isLive = live && activityIsLive(status);

  /*
   * The steps, in RECORDED order, resolved once.
   *
   * `parts` is already chronological (the planner emits them as the blocks and calls were recorded), so this is a
   * single map over it: no sorting, and no splitting into "thoughts then tools" — that split is what made the
   * first version read as a different sequence from the one that happened. The `byId` map keeps resolution
   * linear rather than scanning the tool array once per part.
   */
  const byId = new Map(tools.map((tool) => [tool.toolCallId, tool]));
  const steps: Step[] = [];
  for (const part of parts) {
    if (part.kind === "thinking") {
      steps.push({ kind: "thinking", part });
      continue;
    }
    const tool = byId.get(part.toolCallId);
    // A reference with no execution is dropped rather than rendered as an empty row: only reachable from a
    // malformed transcript, and an unnamed row would look like a rendering fault.
    if (tool !== undefined) steps.push({ kind: "tool", part, tool });
  }

  return (
    <details
      className={`activity${isLive ? " is-live" : ""}${status.failed > 0 ? " has-error" : ""}`}
      open={open}
      // `onToggle` on the `<details>` element fires for the browser's own activation AND for a click on the
      // summary; reading `currentTarget.open` keeps this the single source of truth rather than
      // second-guessing which gesture happened.
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary className="activity-summary" title="Show what the agent did: each call and its reasoning">
        {/*
          ONE dot, and its colour answers ONE question: is this group working right now?
          
          The first version made the dot red whenever ANY call in the group had failed — on a recorded group that
          is permanent, so a finished run sat there red for ever (`img_20.png`) while nothing was wrong any more.
          A recorded failure belongs to the DETAIL (`1 call failed`, in `--danger-text`), which is a fact the
          reader can act on; the dot answers "live or not", which is a different question and is the one a
          glance needs. Live is green, at rest is a quiet gutter colour.
        */}
        <span className={`activity-glyph${isLive ? " is-live" : ""}`} aria-hidden="true">
          ●
        </span>
        <span className="activity-primary">{summary.primary}</span>
        {summary.detail !== undefined && <span className="activity-detail">{summary.detail}</span>}
        <span className="spacer" />
        {/* The rolled-up composition, so a collapsed row still says WHAT ran without a byte count. */}
        {status.names.length > 0 && <span className="activity-names mono">{status.names.join(" · ")}</span>}
        <span className="m-open" aria-hidden="true">
          ⌄
        </span>
      </summary>

      {/*
        THE STEP LEDGER.
        
        One row per recorded step, in recorded ORDER — which is the thing the first version got wrong in a way
        worth naming: it rendered every thinking block first and every tool call afterwards, so a run that
        thought, ran something, thought again read as "all the thinking, then all the work". The sequence IS the
        information; grouping must not reorder it.

        A row is a LABEL, not a payload. The first version put `ToolDetail` here — JSON arguments and the raw
        result — and a real screenshot showed fifty lines of `ls -la` output and an `env` dump inside the
        transcript. That is a second, worse copy of the tool trace window, which already exists and does this
        properly. So each row names WHAT ran and offers two explicit actions: open its reasoning in place, or
        open the call in the trace.
      */}
      <div className="activity-body">
        <ol className="activity-steps">
          {steps.map((step) =>
            step.kind === "thinking" ? (
              <li key={step.part.key} className="activity-step is-thought">
                <details
                  // The thought's own state is local: it is a nested disclosure inside the group, and the group's
                  // own open state (owned by the host) is the only state that has to survive a session switch.
                  className="activity-thought"
                >
                  <summary className="activity-thought-head">
                    {/* The dot IS the position marker: the rail behind it says "same run, next step". A number said
                        the same thing twice and competed with the label for the eye's first fixation. */}
                    <span className={`activity-dot is-thought${step.part.complete ? "" : " is-live"}`} aria-hidden="true" />
                    <span className="activity-step-kind">Thinking</span>
                    {!step.part.complete && <span className="activity-thought-state">thinking…</span>}
                    <span className="spacer" />
                    {gistOf(step.part.text).length > 0 && (
                      <span className="activity-thought-gist">{gistOf(step.part.text)}</span>
                    )}
                  </summary>
                  {/* Escaped text, never markup: reasoning is data, and the sanitized pipeline stays in `Prose`. */}
                  <pre className="activity-thought-body">{step.part.text}</pre>
                </details>
              </li>
            ) : (
              <li
                key={step.part.key}
                className={`activity-step is-tool${step.tool.isError ? " has-error" : ""}${step.tool.running ? " is-running" : ""}`}
              >
                {/*
                  The dot carries the step's STATE; the rail carries its POSITION.
                  
                  Four states, and each one is legible on its own: running (green, pulsing), failed (red), no
                  result recorded (amber), done (quiet). Colour is never the only signal — the row still says
                  `running` / `failed` / `no result` in words beside the label, which is what survives
                  `forced-colors`.
                */}
                <span
                  className={`activity-dot${step.tool.running ? " is-live" : step.tool.isError ? " is-failed" : step.tool.unfinished === true ? " is-missing" : ""}`}
                  aria-hidden="true"
                />
                <span className="activity-step-kind">Tool output</span>
                <span className="activity-step-label mono" title={stepLabel(step.tool)}>
                  {stepLabel(step.tool)}
                </span>
                {step.tool.isError && <span className="err">failed</span>}
                {step.tool.running && <span className="activity-step-running">running</span>}
                {step.tool.unfinished === true && <span className="activity-step-missing">no result</span>}
                <span className="spacer" />
                {onOpenTool !== undefined && (
                  <button
                    type="button"
                    className="activity-step-action"
                    onClick={() => onOpenTool(step.tool.toolCallId)}
                    title="Show the arguments and output in the tool trace"
                  >
                    Inspect
                  </button>
                )}
              </li>
            ),
          )}
        </ol>
      </div>
    </details>
  );
}

/**
 * The one-line preview of a thinking block, for its own row inside the group.
 *
 * The same shape as the old top-level bars (`thinkingGist` in transcript.ts), kept local because it is now
 * subordinate to the group rather than a feed of its own — and because the group is the only caller.
 */
function gistOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  const max = 96;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[,;:.\u2014-]+$/, "")}…`;
}
