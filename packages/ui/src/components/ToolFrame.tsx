/**
 * The quarantined frame for tool output and file contents.
 *
 * Every string here is attacker-influenced: command output, file bodies, fetched pages. The
 * design's job is to make that provenance *visible*, so a reader never mistakes quoted content
 * for the assistant speaking. Hence the hatched left edge and the explicit `Tool output`
 * header — the one deliberately bold element in the interface.
 *
 * Rendered as PRE-FORMATTED TEXT, never through the Markdown pipeline: tool output is not
 * Markdown, and running a diff through it would reinterpret `*` and `_` and change what the
 * user sees. React escapes it, which is the honest rendering.
 */
import { useState } from "react";
import type { ToolExecution } from "../transcript.ts";

export function ToolFrame({ tool }: { tool: ToolExecution }) {
  // Long output starts collapsed: a `npm test` transcript should not push the conversation
  // off screen. The header always shows so the reader knows something is there.
  const [expanded, setExpanded] = useState(false);
  const lines = tool.result.split("\n");
  const isLong = lines.length > 12 || tool.result.length > 800;
  const shown = expanded || !isLong ? tool.result : `${lines.slice(0, 8).join("\n")}\n…`;

  return (
    <section className="quarantine" aria-label={`Tool output from ${tool.toolName}`}>
      <button
        type="button"
        className="quarantine-head"
        onClick={() => setExpanded((was) => !was)}
        aria-expanded={expanded}
      >
        <span className="label">Tool output</span>
        <span className="tool-name">{tool.toolName}</span>
        {tool.running && <span>· running</span>}
        {tool.durationMs !== undefined && <span className="mono">{formatMs(tool.durationMs)}</span>}
        {tool.isError && <span className="err">· failed</span>}
        <span className="spacer" />
        {/* The affordance is stated in words, since an arrow glyph alone is not a label. */}
        {isLong && <span>{expanded ? "Show less" : `Show all ${lines.length} lines`}</span>}
      </button>
      {tool.result.length > 0 && (
        <pre className={`quarantine-body${tool.isError ? " error" : ""}`}>{shown}</pre>
      )}
      {tool.result.length === 0 && !tool.running && (
        <pre className="quarantine-body">(no output)</pre>
      )}
      {tool.running && tool.result.length === 0 && (
        <pre className="quarantine-body">waiting for output…</pre>
      )}
    </section>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
