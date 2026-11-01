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
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ToolExecution } from "../transcript.ts";
import { recentTools, toolSummary } from "../transcript.ts";
import { traceRowLabel } from "../activity.ts";
import {
  clampTraceDetailHeight,
  orderTools,
  parseTraceOrder,
  resizeTraceDetailBy,
  resizeTraceDetailTo,
  traceDetailMaxHeight,
  TRACE_DETAIL_DEFAULT_HEIGHT,
  TRACE_DETAIL_MIN_HEIGHT,
  TRACE_ORDER_KEY,
  type TraceOrder,
} from "../trace.ts";

export function ToolTrace({
  tools,
  selectedId,
  onSelect,
  collapsed = false,
  onToggleCollapsed,
  showMarkers,
  onToggleMarkers,
  variant = "drawer",
  order: orderProp,
  onOrder,
  detailHeight: detailHeightProp,
  onDetailHeight,
  onResetDetailHeight,
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
  /**
   * Which way the list runs.
   *
   * Owned by the host when it is persisted (`App`), so it survives a session switch — `SessionView` remounts, and a sort
   * order that reset every time would be worse than no control. Controlled when provided, local otherwise.
   */
  order?: TraceOrder;
  onOrder?: ((order: TraceOrder) => void) | undefined;
  /** The detail pane's height, for the same reason: a size the reader chose must outlive the pane that shows it. */
  detailHeight?: number;
  onDetailHeight?: ((height: number) => void) | undefined;
  /** Double-click on the handle, or the app's own reset. */
  onResetDetailHeight?: (() => void) | undefined;
}) {
  const inPanel = variant === "panel";
  const listRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const active = tools.filter((tool) => tool.running);
  const count = tools.length;

  /*
   * ORDER and HEIGHT are controlled when the host persists them, local otherwise.
   *
   * The local fallback exists so the drawer — which has no preference storage of its own — still works. The trivial
   * `useState` setters are called only when the host did not supply one, which keeps the controlled path honest: a
   * component that wrote to its own copy as well would disagree with the persisted value on the next render.
   */
  const [localOrder, setLocalOrder] = useState<TraceOrder>(() => {
    try {
      return parseTraceOrder(localStorage.getItem(TRACE_ORDER_KEY));
    } catch {
      return "oldest";
    }
  });
  const order = orderProp ?? localOrder;
  const setOrder = useCallback(
    (next: TraceOrder) => {
      if (onOrder !== undefined) onOrder(next);
      else setLocalOrder(next);
    },
    [onOrder],
  );

  /*
   * THE DETAIL PANE'S HEIGHT IS A PROPERTY OF THE PANEL, NOT OF THE SELECTED CALL.
   *
   * It used to be `flex: 0 1 auto`, so its height followed the content: traversing with the arrow keys resized the pane
   * at every step, shifting the rows and the scroll position under the reader. A fixed height that the reader can drag
   * means moving through calls changes only what is INSIDE the pane.
   */
  const [localHeight, setLocalHeight] = useState(TRACE_DETAIL_DEFAULT_HEIGHT);
  const detailHeight = detailHeightProp ?? localHeight;
  const setDetailHeight = useCallback(
    (next: number) => {
      if (onDetailHeight !== undefined) onDetailHeight(next);
      else setLocalHeight(next);
    },
    [onDetailHeight],
  );

  /** The panel's own height, read at drag time: it changes with the window, so it cannot be a constant. */
  const panelHeightRef = useRef(0);
  const setPanelBox = useCallback((node: HTMLElement | null) => {
    if (node === null) return;
    panelHeightRef.current = node.getBoundingClientRect().height;
  }, []);

  /**
   * The DISPLAYED order. Traversal follows it too — an arrow key must move the selection one row on SCREEN, not one row
   * in the underlying data, or in a reversed list an arrow jumps in the wrong direction.
   */
  const ordered = orderTools(tools, order);

  const drag = useRef<{ pointerId: number; startY: number; startHeight: number } | undefined>(undefined);

  function handleDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: detailHeight };
  }
  function handleDragMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (state === undefined || state.pointerId !== event.pointerId) return;
    // `startHeight - delta`, not `height - delta`: accumulating against the live value compounds rounding and drifts
    // away from the pointer.
    setDetailHeight(resizeTraceDetailBy(state.startHeight, event.clientY - state.startY, panelHeightRef.current));
  }
  function handleDragEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current === undefined) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }
  function handleDragKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowUp", "ArrowDown", "Home", "End"] as const;
    if (!keys.includes(event.key as (typeof keys)[number])) return;
    event.preventDefault();
    setDetailHeight(
      resizeTraceDetailTo(event.key as (typeof keys)[number], detailHeight, panelHeightRef.current),
    );
  }

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
      // `ordered`, not `tools`: in a reversed list the arrow keys must move one row on SCREEN.
      const index = ordered.findIndex((tool) => tool.toolCallId === selectedId);
      const next = index === -1
        ? ordered.length - 1
        : Math.max(0, Math.min(ordered.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      onSelect(ordered[next]?.toolCallId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ordered, selectedId, onSelect, collapsed]);

  if (count === 0) return null;

  const selected = tools.find((tool) => tool.toolCallId === selectedId);
  const recent = recentTools(tools, 5);
  const recentIds = new Set(recent.map((tool) => tool.toolCallId));
  // The list is the whole trace, so an older call is reachable; the recent window is highlighted
  // so the eye can find "now" without reading the list.
  const rows = !inPanel && collapsed ? [] : ordered;

  return (
    <section className={`trace is-${variant}`} aria-label="Tool trace" ref={setPanelBox}>
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
          THE ORDER, as a control rather than a column of numbers.

          Index numbers were added so rows could be told apart, but the reader does not think in indices and the numbers
          earned a leading column they did not deserve. What was actually missing is a choice about DIRECTION — "show me
          the newest first" is a real question when 44 calls have accumulated, and the answer belongs at the top of the
          list rather than in a per-row label.

          A native `<select>`, so keyboard and screen-reader behaviour come free and the current value is always visible.
        */}
        <label className="trace-order">
          <span className="visually-hidden">Order</span>
          <select
            className="trace-order-select"
            value={order}
            onChange={(event) => setOrder(event.target.value === "newest" ? "newest" : "oldest")}
          >
            <option value="oldest">Oldest first</option>
            <option value="newest">Newest first</option>
          </select>
        </label>
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
          {rows.map((tool) => (
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
                NO INDEX.
                
                A leading number was added so rows could be told apart, but it earned a full column for a value the reader
                does not think in — and it made the list look like a spreadsheet rather than a log. The label now keeps
                both ends of the command, which is what actually distinguishes one call from another, and the ORDER is a
                choice at the top of the list instead.
              */}
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
      {inPanel && selected && (
        /*
          THE HANDLE. A 6px rule with a wider invisible hit area — the same shape as the panel's own vertical resizer, so
          there is one resize idiom in the app.
        */
        <div
          className="trace-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the call detail"
          aria-valuenow={detailHeight}
          aria-valuemin={TRACE_DETAIL_MIN_HEIGHT}
          aria-valuemax={traceDetailMaxHeight(panelHeightRef.current)}
          aria-valuetext={`${detailHeight} pixels`}
          tabIndex={0}
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          onKeyDown={handleDragKeys}
          onDoubleClick={() => onResetDetailHeight?.()}
        />
      )}

      {(inPanel || !collapsed) && selected && (
        <div
          className="trace-detail is-quarantined"
          /* A FIXED height in the panel, so traversing rows cannot resize the pane under the reader. The drawer keeps the
             content-fitted bound it needs to share the reading column. */
          style={inPanel ? { height: clampTraceDetailHeight(detailHeight, panelHeightRef.current || 900) } : undefined}
        >
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
