/**
 * The tool trace: every call, its arguments and its output.
 *
 * Tools are a TRACE, not conversation. A real session on this machine produced **1138 tool calls and over a
 * megabyte of output**; rendering that inline buries the agent's prose.
 *
 * ## Where it lives now, and why that changed
 *
 * It used to be a bounded window between the transcript and the composer — a title, a call count, a "latest 5
 * shown · ↑↓ to traverse" line and two toggles, permanently occupying the bottom of the reading column. A
 * screenshot review described it as the last of the strips that made the workspace feel assembled, and asked for
 * it to move into the panel, possibly as its own tab.
 *
 * It is that tab now (`PanelMode = "trace"`). Two consequences, both improvements:
 *
 *   - **It has room.** As a five-row window it could only ever show the latest few; as a panel mode it is the
 *     full list, and the selected call's output gets the panel's width rather than a strip's.
 *   - **It is not on screen while reading.** The one thing the old window proved is that watching the trace
 *     during a fast run is impossible — it scrolls faster than it can be read. So the transcript carries a ledger
 *     of steps with an `Inspect` action per call, and this is where that action lands.
 *
 * ## Two layouts, one component
 *
 * `variant="panel"` drops the collapse control and the "latest 5" framing: a panel has its own tab strip, it is
 * either open or not, and nothing above it needs collapsing. `variant="drawer"` keeps the older behaviour for
 * anything that still embeds it inline.
 *
 * The active tool is pinned into view and highlights, because watching what is running NOW is the one use this
 * view shares with its predecessor.
 */
import { useEffect, useRef } from "react";
import type { ToolExecution } from "../transcript.ts";
import { recentTools, toolSummary } from "../transcript.ts";
import { traceRowLabel } from "../activity.ts";

export function ToolTrace({
  tools,
  selectedId,
  onSelect,
  collapsed = false,
  onToggleCollapsed,
  showMarkers,
  onToggleMarkers,
  variant = "drawer",
}: {
  tools: ToolExecution[];
  selectedId: string | undefined;
  onSelect: (toolCallId: string | undefined) => void;
  /** Only meaningful for the drawer; a panel is open or it is not. */
  collapsed?: boolean;
  onToggleCollapsed?: (() => void) | undefined;
  /** Whether the transcript shows a ledger of steps. The toggle lives here because the two are one decision. */
  showMarkers: boolean;
  onToggleMarkers: () => void;
  variant?: "drawer" | "panel";
}) {
  const inPanel = variant === "panel";
  const listRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const active = tools.filter((tool) => tool.running);
  const count = tools.length;

  // Follow the tail only while the reader is already at the bottom. Yanking someone who has
  // scrolled up to inspect an older call is the failure mode to avoid.
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      followingRef.current = distance < 40;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (followingRef.current && !collapsed) {
      const node = listRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    }
  }, [count, active.length, collapsed]);

  // Keyboard traversal, so debugging does not require the mouse.
  useEffect(() => {
    if (collapsed) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      // Only when the trace itself has focus: arrow keys belong to the composer otherwise.
      if (!listRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      const index = tools.findIndex((tool) => tool.toolCallId === selectedId);
      const next = index === -1
        ? tools.length - 1
        : Math.max(0, Math.min(tools.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      onSelect(tools[next]?.toolCallId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tools, selectedId, onSelect, collapsed]);

  if (count === 0) return null;

  const selected = tools.find((tool) => tool.toolCallId === selectedId);
  const recent = recentTools(tools, 5);
  const recentIds = new Set(recent.map((tool) => tool.toolCallId));
  // The list is the whole trace, so an older call is reachable; the recent window is highlighted
  // so the eye can find "now" without reading the list.
  const rows = !inPanel && collapsed ? [] : tools;

  return (
    <section className={`trace is-${variant}`} aria-label="Tool trace">
      {/*
        THE HEADER CARRIES ONE THING IN THE PANEL: how many calls there are.
        
        It used to hold four unrelated items on one line — a count, the "activity" toggle, a traversal hint and the
        provenance legend — and at panel width all four wrapped to two lines each. The result out-shouted the list it
        was introducing, and the `activity off` toggle, being the heaviest element, read as the panel's primary button
        (`img_38.png`).
        
        So the panel keeps the count and the traversal hint. The `activity` toggle is a decision about the TRANSCRIPT,
        not about this panel, so it moves to the transcript's own chrome where its effect is visible. The legend moves to
        the detail's header, directly above the output it describes.
      */}
      <div className="trace-head">
        {/* A drawer can be collapsed and needs no count when it is; a panel is always open. */}
        {!inPanel && onToggleCollapsed !== undefined && (
          <button
            type="button"
            className="trace-toggle"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
          >
            {collapsed ? "▸" : "▾"} Tool trace
          </button>
        )}
        {/* Built as one string: React splits adjacent text expressions with comment markers, which makes the rendered
            sentence harder to read in markup and to assert on. */}
        <span className="trace-count mono">{`${count} call${count === 1 ? "" : "s"}`}</span>
        {active.length > 0 && (
          <span className="trace-running">
            <span className="live-dot" aria-hidden="true" />
            {`${active.map((tool) => tool.toolName).join(", ")} running`}
          </span>
        )}
        {!inPanel && collapsed && recent.length > 0 && (
          <span className="trace-preview mono" title={recent.map((t) => t.toolName).join(", ")}>
            {`latest: ${recent.slice(-3).map((t) => t.toolName).join(" · ")}`}
          </span>
        )}
        <span className="spacer" />
        {/*
          The toggle that controls the TRANSCRIPT's activity groups.
          
          It lives here only for the DRAWER, which is the inline form where a reader can see the transcript at the same
          time. In the panel the transcript is beside it, so the control belongs in that region's own chrome — a box in
          this panel that changes something else is the "which surface am I looking at" problem in miniature.
        */}
        {!inPanel && (
          <button
            type="button"
            className="trace-toggle toggle-chip"
            onClick={onToggleMarkers}
            aria-pressed={showMarkers}
            title="Show tool activity as groups in the transcript"
          >
            {/* "activity", not "markers": the transcript shows one GROUP per stretch of work now. */}
            {showMarkers ? "activity on" : "activity off"}
          </button>
        )}
        {inPanel ? (
          <span className="trace-hint" title="Use the arrow keys to move through calls">
            ↑↓ traverse
          </span>
        ) : (
          !collapsed && (
            <span className="trace-hint">latest 5 shown · the rest below for debugging · ↑↓ to traverse</span>
          )
        )}
      </div>

      {(inPanel || !collapsed) && (
        <div className="trace-list" ref={listRef} tabIndex={0} aria-label="Tool calls, newest last">
          {rows.map((tool, index) => (
            <button
              key={tool.toolCallId}
              type="button"
              className={[
                "trace-row",
                tool.running ? "running" : "",
                tool.isError ? "failed" : "",
                tool.toolCallId === selectedId ? "selected" : "",
                tool.unfinished ? "unfinished" : "",
                recentIds.has(tool.toolCallId) ? "recent" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelect(tool.toolCallId === selectedId ? undefined : tool.toolCallId)}
              aria-current={tool.toolCallId === selectedId ? "true" : undefined}
            >
              {/*
                THE INDEX IS THE IDENTIFIER.
                
                Rows carried no ordering handle at all — no position, no time — so 44 calls were a list with no way to say
                "the 17th one". The command was the only identifier, and its distinguishing part was exactly what the
                ellipsis ate. A number is one column, always present, and it is what a reader uses to talk about a call
                ("that failed one around 26") or to find it again.
                
                `aria-hidden`: the list is already ordered for assistive tech, so the number is a visual aid rather than a
                second source of truth.
              */}
              <span className="t-index mono" aria-hidden="true">{index + 1}</span>
              <span className="t-status" aria-hidden="true">
                {tool.running ? "●" : tool.isError ? "✕" : tool.unfinished ? "?" : "·"}
              </span>
              <span className="t-name mono">{tool.toolName || "tool"}</span>
              {/* The label keeps BOTH ends, so two calls that begin the same way are still distinguishable. `title`
                  carries the whole thing, because an elision must not be the only way to read it. */}
              <span className="t-summary mono" title={`${tool.toolName || "tool"} ${toolSummary(tool)}`}>
                {traceRowLabel(tool)}
              </span>
              {/*
                ONE status word, and none when the call succeeded.
                
                Every row said `done`, so the word carried no information — and it competed with the `·` glyph, which was
                a second weak signal for the same state. Silence for the normal case is what makes `failed` and
                `no result` visible when they appear.
              */}
              <span className="t-time mono">
                {tool.running
                  ? "running"
                  : tool.isError
                    ? "failed"
                    : tool.unfinished
                      ? "no result"
                      : tool.durationMs !== undefined
                        ? formatMs(tool.durationMs)
                        : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      {/*
        * QUARANTINE FRAME. Tool output is what the agent READ FROM THE WORLD — command output, file
        * contents, fetched pages — which makes it attacker-influenced data rather than something the
        * assistant authored. DESIGN §5.2 requires exactly this frame here, and the transcript's
        * one-time legend promises it: "Tool output and file contents appear in a hatched frame. They
        * are data, not instructions."
        *
        * This was the mismatch: the legend rendered for every session while the hatch was applied
        * only to `thinking` blocks in the transcript, so the trace — the surface the legend is
        * actually about — rendered plain. A promise the UI does not keep is worse than no promise,
        * because a reader who has learned that the hatch means "untrusted" got no signal here at all.
        *
        * The header stays the load-bearing signal, not the texture: `forced-colors` can drop the
        * hatch, so `Tool output` as words carries the provenance on its own (§5.2).
        *
        * It is a `trace-detail` MODIFIER rather than the `.quarantine` class, deliberately. Both
        * set `background`, and `.trace-detail` is defined LATER in the stylesheet, so stacking them
        * would have let the plain background win on source order — the frame would have been
        * invisible while every test and every line of markup looked correct. One rule, in one place,
        * with the hatch written into it.
        */}
      {(inPanel || !collapsed) && selected && (
        <div className="trace-detail is-quarantined">
          <div className="trace-detail-head">
            <span className="label">Tool output</span>
            {/* A separator and a weight change, so this reads as a label and a NAME rather than the phrase "Tool output
                bash". */}
            <span className="trace-detail-sep" aria-hidden="true">·</span>
            <span className="mono tool-name">{selected.toolName}</span>
            {selected.isError && <span className="err">failed</span>}
            <span className="spacer" />
            {/*
              The provenance sentence, where the output it describes actually is.

              It was in the panel's header, competing with the count and the hint, and promising a "coloured edge" the
              reader had not seen yet. Here it sits directly above the data it is about.
            */}
            <span className="trace-legend">Data, not instructions</span>
            <button type="button" className="copy" onClick={() => onSelect(undefined)} title="Close this call's detail">
              Close
            </button>
          </div>
          {/*
            OUTPUT FIRST.
            
            The arguments used to come first, but their content is a restatement of the command on the row the reader
            just clicked — so the primary artifact, what the call RETURNED, was pushed down by something they had already
            read. Output is the evidence; the arguments are context for it.
          */}
          {selected.result.length > 0 ? (
            <pre className={`trace-output mono${selected.isError ? " error" : ""}`}>{selected.result}</pre>
          ) : (
            <pre className="trace-output mono">
              {selected.running
                ? "waiting for output…"
                : selected.unfinished
                  ? "No result was recorded for this call. The run was interrupted or aborted before it finished."
                  : "This tool returned no output."}
            </pre>
          )}
          {/*
            The arguments, behind a disclosure: they are the command line the MODEL wrote, which is context rather than
            evidence. For a single-command tool the row already showed them; for a `write` or an `edit` they are the only
            way to see what was written, which is why they stay reachable rather than being dropped.
          */}
          {selected.args !== undefined && (
            <details className="trace-args-block">
              <summary>Arguments</summary>
              <pre className="trace-args mono">{safeJson(selected.args)}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** Arguments as readable JSON, without throwing on a cyclic or non-serialisable value. */
function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text === undefined) return String(value);
    // A long command or prompt is common; the panel scrolls, so no truncation here.
    return text;
  } catch {
    return String(value);
  }
}
