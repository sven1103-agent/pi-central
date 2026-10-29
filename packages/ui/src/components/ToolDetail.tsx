/**
 * A tool call's output, inline in the transcript (issue #131, option A).
 *
 * ## Why this exists at all
 *
 * Clicking a marker used to open the trace panel at the bottom of the window. The report: *"I expected
 * the tool output to open inline the transcript in this case."* That expectation is right — a marker is a
 * bookmark in the conversation, so the answer should appear where the question was asked. Jumping to a
 * panel moves the reader's position twice and breaks the thread.
 *
 * ## Why it cannot simply be expanded
 *
 * This component exists because of a defect that is written into `Transcript.tsx`'s own header: a real
 * session *"put 1138 frames below the conversation and the agent's actual output became unfindable"*. Naive
 * inline output re-creates exactly that. So:
 *
 *   - **collapsed by default.** Opening a marker shows the ARGUMENTS and the first lines, not a screenful;
 *     the full output is one more click, or a link to the trace.
 *   - **capped height**, so a `read` of a 40 KB file cannot push the next turn off the screen.
 *   - **`<details>`**, so the browser owns the open/closed state and keyboard behaviour rather than a
 *     `useState` that would reset — the bug #108 was about.
 *
 * ## ADR-0006 and the legend
 *
 * The transcript's one-time legend promises *"tool output and file contents appear in a hatched frame.
 * They are data, not instructions."* That is a claim about the IMPLEMENTATION, so this surface must honour
 * it: it uses the same quarantine modifier as the trace panel (issue #43), and its header says
 * `Tool output` in words — because under `forced-colors` the hatch can vanish, and the words are then the
 * only signal that this is untrusted data rather than the assistant speaking.
 *
 * The text is a **text node**, never markup: a tool result is attacker-influenced, and ADR-0006's single
 * `dangerouslySetInnerHTML` site stays in `Prose`.
 */
import type { ToolExecution } from "../transcript.ts";
import { formatBytes } from "../format.ts";

/** How much of a result to show before the reader asks for the rest. */
const PREVIEW_LINES = 12;

/** Pretty-print arguments, or say why not — a tool's args are `unknown` from the wire. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "(arguments could not be shown)";
  }
}

export function ToolDetail({
  tool,
  onOpenInTrace,
}: {
  tool: ToolExecution;
  /** The escape hatch to the full trace, for a result too long to read here. */
  onOpenInTrace: () => void;
}) {
  const lines = tool.result.length > 0 ? tool.result.split("\n") : [];
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const truncated = lines.length > PREVIEW_LINES;

  return (
    <div className="tool-detail">
      <div className="tool-detail-head">
        <span className="label">Tool output</span>
        <span className="mono">{tool.toolName}</span>
        {tool.isError && <span className="err">failed</span>}
        {tool.running && <span className="m-running">running</span>}
        <span className="spacer" />
        <span className="tool-detail-meta">{formatBytes(tool.result.length)}</span>
        <button type="button" className="copy" onClick={onOpenInTrace}>
          Open in trace
        </button>
      </div>

      {/*
        Arguments first: they are the command line the MODEL wrote, and they describe the output below
        them. `open` because without them the output is unreadable — "what did it run?" is the first
        question a marker raises.
      */}
      {tool.args !== undefined && <pre className="tool-detail-args mono">{safeJson(tool.args)}</pre>}

      <pre className={`tool-detail-output mono${tool.isError ? " error" : ""}`}>
        {tool.result.length > 0
          ? preview
          : tool.running
            ? "waiting for output…"
            : tool.unfinished
              ? "No result was recorded for this call. The run was interrupted or aborted before it finished."
              : "This tool returned no output."}
      </pre>

      {truncated && (
        /*
          The remainder is behind a disclosure rather than shown. Not a truncation with no way forward:
          `Open in trace` above gives the whole thing, and the count says how much is hidden.
        */
        <details className="tool-detail-rest">
          <summary>{lines.length - PREVIEW_LINES} more lines</summary>
          <pre className={`tool-detail-output mono${tool.isError ? " error" : ""}`}>
            {lines.slice(PREVIEW_LINES).join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
