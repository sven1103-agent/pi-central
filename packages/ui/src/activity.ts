/**
 * Planning the transcript as CONVERSATION plus ACTIVITY (issue: the tool/thinking sequence).
 *
 * ## What this replaces, and the defect it answers
 *
 * `planTranscript` (transcript.ts) groups contiguous tool work into one marker, which fixed the
 * "1138 frames below the conversation" defect. What it did NOT fix is the other half: `hasProse()`
 * counts a non-empty THINKING block as something to read, so every thinking-only assistant message
 * became its own turn. A real session therefore rendered
 *
 *     Assistant · [Thinking bar] · 1 tool · Assistant · [Thinking bar] · 1 tool · …
 *
 * where every collapse had already been made and the rows themselves were the clutter. Reported from
 * a screenshot review: *"a sequence of tool calls and thinking, which I find particularly
 * distracting"*. Collapsing each event individually does not help when the collapsed events ARE the
 * feed.
 *
 * ## The shape this produces
 *
 *     message (the reader's or the assistant's actual words)
 *     activity (one disclosure: thinking blocks and tool runs, in recorded order)
 *     message
 *
 * One decision replaces two: consecutive thinking/tool work between two text spans is ONE group, and
 * a thinking-only message creates no heading at all. Nothing is discarded — the group's body still
 * reaches every thinking block and every `ToolExecution`.
 *
 * ## Why this is a projection and not another reducer
 *
 * `Transcript` (transcript.ts) stays the single source of truth: this module COPIES NOTHING out of it.
 * A part is a reference — a message id plus block index, or a `toolCallId` — so a group cannot hold a
 * stale copy of a 40 KB result while the transcript moves on, and a re-plan is cheap.
 *
 * ## Ordering rules, and the one that is easy to get wrong
 *
 * Parts are emitted in the order the blocks and calls were RECORDED, not by a sort on `startedAt`.
 * Synthetic timestamps collide (a whole batch can share one millisecond), so sorting by them would
 * reorder a real conversation. Tools keep their existing position rule — a tool requested by message
 * `i` ran after it, `afterMessage === i + 1` — which is the same rule `planTranscript` used.
 *
 * A text block does NOT swallow the activity around it: if a message is thinking → text → thinking,
 * the plan is activity, message, activity, rather than moving all reasoning to the front. Reordering
 * prose to tidy the layout would be a false statement about what happened.
 */

import type { TextBlock, ToolExecution, Transcript, TranscriptMessage } from "./transcript.ts";

/** One item inside an activity group. A REFERENCE into the transcript, never a copy of its content. */
export type ActivityPart =
  | {
      kind: "thinking";
      /** Stable identity: the message and block this block lives at. */
      key: string;
      messageId: string;
      blockIndex: number;
      text: string;
      /** `false` while `thinking_delta` records are still arriving. */
      complete: boolean;
    }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
    };

export type PlannedEntry =
  | {
      kind: "message";
      /** Stable across re-plans of the same conversation, so React does not remount prose. */
      key: string;
      message: TranscriptMessage;
      /**
       * Which blocks of `message` are prose to render, in order.
       *
       * An array, not a joined string: a message can legitimately have text → thinking → text, and the
       * thinking between them belongs to an activity group. Rendering only these blocks is what keeps
       * this entry from repainting when a thinking block above it streams.
       */
      textIndexes: readonly number[];
    }
  | {
      kind: "activity";
      key: string;
      parts: readonly ActivityPart[];
    };

/**
 * Is this block text a reader should see as prose?
 *
 * Empty or whitespace-only text blocks are placeholders created by `blockAt()` while a message is
 * being assembled, not content. A turn heading above nothing is the noise this whole module exists
 * to remove.
 */
function isVisibleText(block: { kind: string; text?: string }): boolean {
  return block.kind === "text" && (block.text ?? "").trim().length > 0;
}

/**
 * Is this thinking block worth a row in the group?
 *
 * A COMPLETE block with no text says nothing and opens to nothing, so it is dropped. An INCOMPLETE
 * empty block is the opposite fact: the agent is thinking right now, and `thinking_start` has been
 * seen but no words have arrived. Dropping that would make the group look idle during the one moment
 * a reader is waiting for it.
 */
function isVisibleThinking(block: TextBlock, message: TranscriptMessage): boolean {
  if (block.text.trim().length > 0) return true;
  return !block.complete && message.streaming;
}

/** Group tools by the message they followed. One pass, as `planTranscript` does (issue #151). */
function groupToolsByAfterMessage(tools: readonly ToolExecution[]): Map<number, ToolExecution[]> {
  const grouped = new Map<number, ToolExecution[]>();
  for (const tool of tools) {
    const existing = grouped.get(tool.afterMessage);
    if (existing === undefined) grouped.set(tool.afterMessage, [tool]);
    else existing.push(tool);
  }
  return grouped;
}

/**
 * Plan a transcript as alternating message and activity entries.
 *
 * Linear in blocks plus tools: one pass over each, no scan of the tool array per message.
 */
export function planEntries(transcript: Transcript): PlannedEntry[] {
  const entries: PlannedEntry[] = [];
  const byAfterMessage = groupToolsByAfterMessage(transcript.tools);
  let pending: ActivityPart[] = [];

  const flushActivity = () => {
    if (pending.length === 0) return;
    // The key names the group's FIRST part and never its length or status: a group that gains a tool
    // mid-run must keep its identity, or the reader's open disclosure snaps shut every time a call
    // arrives — the same class of defect as #108, one level down.
    entries.push({ kind: "activity", key: `activity:${pending[0]!.key}`, parts: pending });
    pending = [];
  };

  // Work that happened before the first message: a resumed session can open mid-call.
  for (const tool of byAfterMessage.get(0) ?? []) {
    pending.push({ kind: "tool", key: `tool:${tool.toolCallId}`, toolCallId: tool.toolCallId });
  }

  transcript.messages.forEach((message, index) => {
    let spans: number[] = [];

    const flushMessage = () => {
      if (spans.length === 0) return;
      const first = spans[0]!;
      entries.push({ kind: "message", key: `message:${message.id}:${first}`, message, textIndexes: spans });
      spans = [];
    };

    message.blocks.forEach((block, blockIndex) => {
      if (block.kind === "thinking") {
        if (!isVisibleThinking(block, message)) return;
        // Text before this block is its own entry, so the group sits where it was recorded.
        flushMessage();
        pending.push({
          kind: "thinking",
          key: `thinking:${message.id}:${blockIndex}`,
          messageId: message.id,
          blockIndex,
          text: block.text,
          complete: block.complete,
        });
        return;
      }

      if (!isVisibleText(block)) return;
      // Activity that happened BEFORE this text becomes a group above it.
      if (pending.length > 0) {
        flushMessage();
        flushActivity();
      }
      spans.push(blockIndex);
    });

    /*
     * The tools this message requested, which ran AFTER it wrote whatever it wrote.
     *
     * Emitted after the message's own blocks, because that is when they ran: an assistant message that
     * says "let me check" and then calls `read` must not have its call appear above the sentence that
     * announced it.
     */
    for (const tool of byAfterMessage.get(index + 1) ?? []) {
      flushMessage();
      pending.push({ kind: "tool", key: `tool:${tool.toolCallId}`, toolCallId: tool.toolCallId });
    }

    flushMessage();
  });

  // Work after the last readable turn still happened, and still needs to be reachable.
  flushActivity();

  return entries;
}

/** The tools a group refers to, resolved against the transcript they came from. */
export function activityTools(parts: readonly ActivityPart[], tools: readonly ToolExecution[]): ToolExecution[] {
  if (parts.every((part) => part.kind !== "tool")) return [];
  const byId = new Map(tools.map((tool) => [tool.toolCallId, tool]));
  const found: ToolExecution[] = [];
  for (const part of parts) {
    if (part.kind !== "tool") continue;
    const tool = byId.get(part.toolCallId);
    // A tool id with no execution is not invented into a fake call: it is simply absent from the
    // resolution. Only reachable from a malformed transcript, and dropping it is the honest fallback —
    // the status counts then describe what could actually be resolved.
    if (tool !== undefined) found.push(tool);
  }
  return found;
}

/** Blocks of a message that carry prose, in order. */
export function messageTexts(message: TranscriptMessage, textIndexes: readonly number[]): string[] {
  return textIndexes
    .map((index) => message.blocks[index])
    .map((block) => (block?.kind === "text" ? block.text : ""))
    .filter((text) => text.length > 0);
}

/**
 * The facts a group's summary may state.
 *
 * Computed from RECORDED data only. Nothing here infers that a failure was "recovered" because a later
 * call succeeded, that the task finished because the session settled, or that a step is "done" because
 * a spinner stopped: those are claims the wire does not make, and the project's rule is that a
 * displayed value which is wrong is a defect rather than a cosmetic issue.
 */
export interface ActivityStatus {
  /** Distinct tool names, in first-seen order. */
  names: string[];
  tools: number;
  running: string[];
  failed: number;
  /** Calls whose result was never recorded (an interrupted run), never counted as failures. */
  noResult: number;
  thinking: number;
  /** A thinking block that is still growing right now. */
  liveThinking: boolean;
}

export function activityStatus(parts: readonly ActivityPart[], tools: readonly ToolExecution[]): ActivityStatus {
  const executions = activityTools(parts, tools);
  const names: string[] = [];
  for (const tool of executions) {
    if (!names.includes(tool.toolName)) names.push(tool.toolName);
  }
  const thinking = parts.filter((part) => part.kind === "thinking").length;
  return {
    names,
    tools: executions.length,
    running: executions.filter((tool) => tool.running).map((tool) => tool.toolName),
    failed: executions.filter((tool) => tool.isError).length,
    noResult: executions.filter((tool) => tool.unfinished === true).length,
    thinking,
    liveThinking: parts.some((part) => part.kind === "thinking" && !part.complete),
  };
}

/**
 * The one-line summary of a group.
 *
 * `primary` says what is happening NOW when something is; otherwise what was RECORDED. `detail`
 * carries the facts that must not be lost by collapsing — a failed call in a run that continued, or a
 * call whose result never arrived. Both are plain words: the summary is also the accessible name of
 * the disclosure, so nothing depends on an icon or a colour.
 *
 * Deliberately absent: percentages, task names, completion claims, and payload sizes. A byte count
 * says how much the transport moved, which is a debugging fact — it lives in the expanded body.
 */
export function activitySummary(status: ActivityStatus): { primary: string; detail?: string } {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const details: string[] = [];
  if (status.failed > 0) details.push(`${plural(status.failed, "call")} failed`);
  if (status.noResult > 0) details.push(`${plural(status.noResult, "call")} has no recorded result`);
  const detail = details.length > 0 ? details.join(" · ") : undefined;

  if (status.running.length === 1) return { primary: `Running ${status.running[0]}`, ...(detail ? { detail } : {}) };
  if (status.running.length > 1) return { primary: `${status.running.length} tools running`, ...(detail ? { detail } : {}) };
  if (status.liveThinking) return { primary: "Thinking…", ...(detail ? { detail } : {}) };
  if (status.tools > 0) return { primary: `${plural(status.tools, "tool call")} recorded`, ...(detail ? { detail } : {}) };
  if (status.thinking > 0) return { primary: plural(status.thinking, "thinking block"), ...(detail ? { detail } : {}) };
  // A group cannot be empty by construction; this is the typed fallback and says nothing false.
  return { primary: "Activity" };
}

/**
 * A short, human label for one step: WHAT the agent did, not the JSON it did it with.
 *
 * ## Why this exists
 *
 * The first version of the expanded group rendered `ToolDetail` per call: a JSON argument dump plus the raw
 * result. A real screenshot (`img_19.png`) showed what that produces — fifty lines of `ls -la` output and an
 * `env` listing inside the transcript, which is a second, worse copy of the tool trace window that already
 * does exactly this job properly.
 *
 * So the group answers "which steps ran, in what order" and NOTHING else. The argument dump and the full
 * output stay in the trace, reachable from the step by one explicit action.
 *
 * The label prefers the argument that names WHAT was acted on — a path, a command, a query — because that is
 * what a reader scans for. When there is nothing useful to say, it says the tool name alone rather than
 * inventing a description.
 */
export function stepLabel(tool: ToolExecution): string {
  const args = tool.args;
  const name = tool.toolName || "tool";
  if (args === undefined || args === null) return name;

  const record = typeof args === "object" ? (args as Record<string, unknown>) : undefined;
  if (record === undefined) {
    const text = String(args).replace(/\s+/g, " ").trim();
    return text.length > 0 ? `${name} ${clip(text, 60)}` : name;
  }

  // Ordered by how directly the value names the thing acted on. `command` last only because it is also present on
  // some subagent call shapes, where the agent name identifies the call better.
  for (const key of ["path", "file_path", "filePath", "pattern", "query", "url", "name", "agent", "command"]) {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    if (key === "command") return `${name} ${clipCommand(value)}`;
    return `${name} ${clip(firstLine(value), 52)}`;
  }
  return name;
}

/**
 * A shell command as a LABEL: the part that identifies it, not the part that is boilerplate.
 *
 * ## The defect this fixes
 *
 * A real screenshot (`img_20.png`) showed ten consecutive rows all reading
 * `bash cd /Users/sven1103/….loca…`. Every one of those commands began `cd /Users/…/workspaces/s1 && …`, so the
 * head-keeping truncation spent the whole label on the same prefix and the actual command — the only thing that
 * distinguishes one call from the next — was cut off.
 *
 * So a leading `cd <path> &&` chain is dropped before the label is chosen. That is presentation, not
 * reinterpretation: the full command is unchanged, and it is still one click away in the trace. Chained
 * `cd`s are stripped too, because an agent that changes directory twice still says nothing by it.
 *
 * The remainder is truncated in the MIDDLE rather than at the end when it is long: a command's verb is at its
 * head (`rg -n 'pattern' …`) while a path at its tail is often what makes it unique, so keeping both ends
 * preserves what a reader scans for.
 */
function clipCommand(command: string): string {
  let rest = firstLine(command);
  // `cd x && …`, possibly repeated. Bounded, so a pathological input cannot loop.
  for (let guard = 0; guard < 4; guard += 1) {
    const match = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^&;]+?)\s*(?:&&|;)\s*(.+)$/.exec(rest);
    if (match === null) break;
    rest = match[1]!.trim();
  }
  const max = 70;
  if (rest.length <= max) return rest;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.55);
  const tail = keep - head;
  return `${rest.slice(0, head).trimEnd()}…${rest.slice(rest.length - tail).trimStart()}`;
}

/**
 * A trace row's label: the part of the call that IDENTIFIES it, kept from both ends.
 *
 * ## The defect this answers
 *
 * A screenshot of the trace panel (`img_38.png`) showed three adjacent rows rendered as the identical string
 * `cd /Users/sven1103/.local/share/pi-central/workspaces/s1 …`. Every command began with that `cd`, and the label was
 * truncated at the END — so the only distinguishing part, the command itself, was exactly what the ellipsis ate. A list
 * where every row reads the same cannot be navigated, which defeats the panel's whole purpose.
 *
 * So: the `cd … &&` preamble is dropped before measuring (the same rule `stepLabel` uses for the transcript), and what
 * remains is elided in the MIDDLE so both the verb at the head and the argument at the tail survive.
 */
export function traceRowLabel(tool: ToolExecution, max = 120): string {
  const args = tool.args;
  const name = tool.toolName || "tool";
  if (args === undefined || args === null) return name;
  const record = typeof args === "object" ? (args as Record<string, unknown>) : undefined;
  const raw =
    record === undefined
      ? String(args)
      : ["command", "path", "file_path", "pattern", "query", "url", "name", "agent"]
          .map((key) => record[key])
          .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";

  let text = raw.split("\n")[0]!.replace(/\s+/g, " ").trim();
  if (text.length === 0) return name;
  // The same `cd … &&` stripping as `stepLabel`, because an agent opens most commands by changing directory and that
  // preamble is identical on every row.
  for (let guard = 0; guard < 4; guard += 1) {
    const match = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^&;]+?)\s*(?:&&|;)\s*(.+)$/.exec(text);
    if (match === null) break;
    text = match[1]!.trim();
  }
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.45);
  const tail = keep - head;
  return `${text.slice(0, head).trimEnd()}…${text.slice(text.length - tail).trimStart()}`;
}

/** The first line of a value, because a multi-line command in one row is a wall, not a label. */
function firstLine(value: string): string {
  return value.split("\n")[0]!.replace(/\s+/g, " ").trim();
}

/** Clip at a word boundary, and say so. Never mid-word, which reads as a rendering fault. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Should this group be rendered at all?
 *
 * `showMarkers` (the reader's "hide the work so I can read" preference) hides ROUTINE activity. It must
 * never hide the one line that needs attention: a group carrying a failed call, a call that is running
 * now, or a call whose result never arrived is always rendered. Otherwise the preference would be a way
 * to lose a failure — and the review that produced this work found the failure states were exactly what
 * made a collapsed run ambiguous.
 */
export function showActivity(
  parts: readonly ActivityPart[],
  tools: readonly ToolExecution[],
  showMarkers: boolean,
): boolean {
  if (showMarkers) return true;
  const status = activityStatus(parts, tools);
  return status.failed > 0 || status.noResult > 0 || activityIsLive(status);
}

/**
 * Whether the group should look "in flight".
 *
 * Used for the live indicator only — a dot plus the word in `primary`, never colour on its own. Note
 * what it does NOT consult: `session.state`. A settled session can still hold a block whose end record
 * never arrived (an interrupted run), and painting that as live would be the C8 mistake in miniature.
 */
export function activityIsLive(status: ActivityStatus): boolean {
  return status.running.length > 0 || status.liveThinking;
}
