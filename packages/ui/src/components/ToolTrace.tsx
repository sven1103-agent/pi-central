/**
 * The tool trace window.
 *
 * Tools are a TRACE, not conversation. A real session on this machine produced **1138 tool calls
 * and over a megabyte of output**; rendering that inline buries the agent's prose and imposes
 * real mental load, especially with a fast provider where the trace scrolls faster than it can
 * be read.
 *
 * So the transcript carries the prose, and this window carries the trace:
 *
 *   - **Latest five plus whatever is running**, which is the only part that describes what is
 *     happening NOW.
 *   - **Traversable on demand.** The whole list is here and scrollable, and selecting a row shows
 *     its full input and output. Debugging a tool call is a deliberate act, not something forced
 *     on a reader during every run.
 *   - **Bounded height.** It never grows with the trace, so the layout does not shift as a run
 *     proceeds. A panel that resizes while you read is its own kind of load.
 *
 * The active tool is pinned into view and highlights, because watching it is the entire reason
 * the window exists while work is happening.
 */
import { useEffect, useRef } from "react";
import type { ToolExecution } from "../transcript.ts";
import { recentTools, toolSummary } from "../transcript.ts";

export function ToolTrace({
  tools,
  selectedId,
  onSelect,
  collapsed,
  onToggleCollapsed,
  showMarkers,
  onToggleMarkers,
}: {
  tools: ToolExecution[];
  selectedId: string | undefined;
  onSelect: (toolCallId: string | undefined) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Whether the transcript shows position markers for tool work. */
  showMarkers: boolean;
  onToggleMarkers: () => void;
}) {
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
  const rows = collapsed ? [] : tools;

  return (
    <section className="trace" aria-label="Tool trace">
      <div className="trace-head">
        <button
          type="button"
          className="trace-toggle"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
        >
          {collapsed ? "▸" : "▾"} Tool trace
        </button>
        {/* Built as one string: React splits adjacent text expressions with comment markers,
            which makes the rendered sentence harder to read in markup and to assert on. */}
        <span className="trace-count mono">{`${count} call${count === 1 ? "" : "s"}`}</span>
        {active.length > 0 && (
          <span className="trace-running">
            <span className="live-dot" aria-hidden="true" />
            {`${active.map((tool) => tool.toolName).join(", ")} running`}
          </span>
        )}
        {collapsed && recent.length > 0 && (
          <span className="trace-preview mono" title={recent.map((t) => t.toolName).join(", ")}>
            {`latest: ${recent.slice(-3).map((t) => t.toolName).join(" · ")}`}
          </span>
        )}
        {/* How tools appear in the transcript is the same decision as this window, so the control
            sits with it rather than somewhere unrelated. */}
        <button
          type="button"
          className="trace-toggle"
          style={{ marginLeft: collapsed ? "auto" : undefined }}
          onClick={onToggleMarkers}
          aria-pressed={showMarkers}
        >
          {showMarkers ? "markers on" : "markers off"}
        </button>
        {!collapsed && (
          <span className="trace-hint">
            {/* Stated, because the window's economy is a design choice rather than a limit. */}
            latest 5 shown · the rest below for debugging · ↑↓ to traverse
          </span>
        )}
      </div>

      {!collapsed && (
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
                recentIds.has(tool.toolCallId) ? "recent" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelect(tool.toolCallId === selectedId ? undefined : tool.toolCallId)}
              aria-current={tool.toolCallId === selectedId ? "true" : undefined}
            >
              <span className="t-status" aria-hidden="true">
                {tool.running ? "●" : tool.isError ? "✕" : "·"}
              </span>
              <span className="t-name mono">{tool.toolName || "tool"}</span>
              <span className="t-summary mono" title={toolSummary(tool)}>
                {toolSummary(tool)}
              </span>
              <span className="t-time mono">
                {tool.running ? "running" : tool.durationMs !== undefined ? formatMs(tool.durationMs) : "done"}
              </span>
            </button>
          ))}
        </div>
      )}

      {!collapsed && selected && (
        <div className="trace-detail">
          <div className="trace-detail-head">
            <span className="label">Tool output</span>
            <span className="mono">{selected.toolName}</span>
            {selected.isError && <span className="err">failed</span>}
            <span className="spacer" />
            <button type="button" className="copy" onClick={() => onSelect(undefined)}>
              Close
            </button>
          </div>
          {selected.args !== undefined && (
            <pre className="trace-args mono">{safeJson(selected.args)}</pre>
          )}
          {selected.result.length > 0 ? (
            <pre className={`trace-output mono${selected.isError ? " error" : ""}`}>{selected.result}</pre>
          ) : (
            <pre className="trace-output mono">{selected.running ? "waiting for output…" : "(no output)"}</pre>
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
