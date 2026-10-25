/**
 * Transcript reconstruction from Pi's event stream.
 *
 * The wire is **delta-only** (docs/json.md, PROTOCOL.md): `message_update` carries a fragment
 * and nothing cumulative, to keep stream size linear. Rebuilding a message from those
 * fragments is therefore the UI's job, and it is the part most likely to be subtly wrong.
 *
 * It is a pure reducer over records so it can be tested exhaustively without a browser, a
 * socket, or Pi. The rules, all from docs/json.md:
 *
 *   - `text_delta` / `thinking_delta` / `toolcall_delta`  → APPEND to the block at `contentIndex`
 *   - `text_end` / `thinking_end` / `toolcall_end`        → REPLACE that block with the
 *                                                            authoritative value
 *   - `message_end`                                       → REPLACE the whole message
 *   - `tool_execution_*`                                  → correlate by `toolCallId`, never by
 *                                                            order or name
 *
 * Two things this deliberately does NOT do:
 *
 * 1. It does not treat `agent_end` as completion. `agent_end` closes a low-level run;
 *    retries, compaction recovery, steering and follow-ups can all continue after it (C8).
 *    Only `agent_settled` means "no remaining automatic work".
 * 2. It does not use array position as identity. `contentIndex` is the address, and tool
 *    calls are keyed by `toolCallId`, because parallel tool calls interleave.
 */

export type BlockKind = "text" | "thinking" | "toolcall";

export interface TextBlock {
  kind: "text" | "thinking";
  /** Accumulated text: deltas append, the `*_end` value replaces. */
  text: string;
  /** True once the authoritative `*_end` value has arrived. */
  complete: boolean;
}

export interface ToolCallBlock {
  kind: "toolcall";
  contentIndex: number;
  /** The tool's call id, once known. Absent until `toolcall_start`. */
  id?: string | undefined;
  name?: string | undefined;
  /** Serialized argument fragments, appended until `toolcall_end` replaces them. */
  argsText: string;
  /** The complete arguments, once `toolcall_end` arrived. */
  args?: unknown;
  complete: boolean;
}

export type Block = TextBlock | ToolCallBlock;

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  blocks: Block[];
  /** Set by `message_end`; the block-level completeness flags are per-block. */
  complete: boolean;
  /** True while deltas are still arriving, i.e. this message is being streamed. */
  streaming: boolean;
  /** Provider-reported usage on the final update, if any. */
  usage?: { input?: number; output?: number; totalTokens?: number } | undefined;
}

/** One executed tool call, correlated from `tool_execution_*`. */
export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** Latest partial or final result. */
  result: string;
  isError: boolean;
  running: boolean;
  durationMs?: number | undefined;
  startedAt: number;
}

export interface Transcript {
  messages: TranscriptMessage[];
  tools: ToolExecution[];
  /** Pi records seen, for the "is anything happening" indicator. */
  lastRecordType?: string | undefined;
  lastRecordAt?: number | undefined;
}

export function emptyTranscript(): Transcript {
  return { messages: [], tools: [] };
}

/**
 * Flatten a Pi message's `content` into display blocks.
 *
 * Pi's `message_end.message` is a whole message with a `content` array. Its parts map onto
 * the same block kinds as the streaming events, so the authoritative replacement reuses the
 * block model rather than introducing a second one.
 */
function blocksFromContent(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const piece = part as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
    if (piece.type === "text" && typeof piece.text === "string") {
      blocks.push({ kind: "text", text: piece.text, complete: true });
    } else if (piece.type === "thinking" && typeof piece.thinking === "string") {
      blocks.push({ kind: "thinking", text: piece.thinking, complete: true });
    } else if (piece.type === "tool_use" || piece.type === "tool_call") {
      blocks.push({
        kind: "toolcall",
        contentIndex: blocks.length,
        ...(piece.id !== undefined ? { id: piece.id } : {}),
        ...(piece.name !== undefined ? { name: piece.name } : {}),
        argsText: "",
        ...(piece.input !== undefined ? { args: piece.input } : {}),
        complete: true,
      });
    }
  }
  return blocks;
}

/** Get or create the block at `contentIndex`, keeping the array sparse-tolerant. */
function blockAt(blocks: Block[], contentIndex: number, make: () => Block): Block {
  while (blocks.length <= contentIndex) {
    blocks.push({ kind: "text", text: "", complete: false });
  }
  const existing = blocks[contentIndex];
  // A placeholder created to fill a gap may have the wrong kind; replace it with the real one.
  if (existing === undefined || (existing.kind === "text" && existing.text === "" && !existing.complete && make().kind !== "text")) {
    const created = make();
    blocks[contentIndex] = created;
    return created;
  }
  return existing;
}

/** Is this the last assistant message, i.e. the one deltas belong to? */
function currentAssistant(transcript: Transcript): TranscriptMessage | undefined {
  const last = transcript.messages[transcript.messages.length - 1];
  return last?.role === "assistant" ? last : undefined;
}

/**
 * Fold one Pi record into the transcript.
 *
 * Returns a NEW transcript; the input is not mutated, so React can compare by reference and a
 * test can assert on the previous state.
 */
export function applyRecord(transcript: Transcript, record: Record<string, unknown>): Transcript {
  const type = String(record.type ?? "");
  const next: Transcript = {
    ...transcript,
    messages: [...transcript.messages],
    tools: [...transcript.tools],
    lastRecordType: type,
    lastRecordAt: Date.now(),
  };

  switch (type) {
    case "message_start": {
      const message = record.message as { role?: string } | undefined;
      const role = (message?.role ?? "assistant") as TranscriptMessage["role"];
      // A new assistant message supersedes any message still marked streaming, which would
      // otherwise leave a spinner on a message that will receive no more deltas.
      next.messages = next.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m));
      next.messages.push({
        id: `m${next.messages.length}`,
        role,
        blocks: [],
        complete: false,
        streaming: true,
      });
      return next;
    }

    case "message_update": {
      const update = record.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!update) return next;
      const usage = record.usage as TranscriptMessage["usage"] | undefined;
      if (usage) {
        const current = currentAssistant(next);
        if (current) next.messages[next.messages.length - 1] = { ...current, usage };
      }
      return applyAssistantEvent(next, update);
    }

    case "message_end": {
      const message = record.message as { role?: string; content?: unknown } | undefined;
      const blocks = blocksFromContent(message?.content);
      const last = next.messages[next.messages.length - 1];
      // The authoritative message REPLACES the partial one. Matching by position is correct
      // here because `message_end` refers to the message just streamed.
      if (last && last.role === "assistant" && !last.complete) {
        next.messages[next.messages.length - 1] = {
          ...last,
          // Only replace blocks when the authoritative message actually has content; a
          // `message_end` with an empty content array must not erase what was streamed.
          blocks: blocks.length > 0 ? blocks : last.blocks,
          complete: true,
          streaming: false,
        };
      } else if (message) {
        next.messages.push({
          id: `m${next.messages.length}`,
          role: (message.role ?? "assistant") as TranscriptMessage["role"],
          blocks,
          complete: true,
          streaming: false,
        });
      }
      return next;
    }

    case "tool_execution_start": {
      const toolCallId = String(record.toolCallId ?? "");
      next.tools.push({
        toolCallId,
        toolName: String(record.toolName ?? ""),
        args: record.args,
        result: "",
        isError: false,
        running: true,
        startedAt: Date.now(),
      });
      return next;
    }

    case "tool_execution_update": {
      // Correlated by `toolCallId`, NOT by position: parallel tool calls interleave.
      const toolCallId = String(record.toolCallId ?? "");
      next.tools = next.tools.map((tool) =>
        tool.toolCallId === toolCallId
          ? { ...tool, result: stringifyResult(record.partialResult) }
          : tool,
      );
      return next;
    }

    case "tool_execution_end": {
      const toolCallId = String(record.toolCallId ?? "");
      let matched = false;
      next.tools = next.tools.map((tool) => {
        if (tool.toolCallId !== toolCallId) return tool;
        matched = true;
        return {
          ...tool,
          result: stringifyResult(record.result),
          isError: record.isError === true,
          running: false,
          ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
        };
      });
      // An `end` with no matching `start` happens when a session is resumed mid-tool-call.
      // Recording it beats dropping it: the transcript would otherwise omit real work.
      if (!matched) {
        next.tools.push({
          toolCallId,
          toolName: String(record.toolName ?? ""),
          args: record.args,
          result: stringifyResult(record.result),
          isError: record.isError === true,
          running: false,
          ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
          startedAt: Date.now(),
        });
      }
      return next;
    }

    default:
      // Every other record type is retained only via `lastRecordType`/`lastRecordAt`. The
      // state machine in the orchestrator decides what matters for lifecycle; the transcript
      // only renders what it can render.
      return next;
  }
}

/** Apply one nested `assistantMessageEvent`. Split out to keep the reducer readable. */
function applyAssistantEvent(transcript: Transcript, update: Record<string, unknown>): Transcript {
  const kind = String(update.type ?? "");
  const contentIndex = typeof update.contentIndex === "number" ? update.contentIndex : 0;
  const current = currentAssistant(transcript);
  if (!current) return transcript;

  const messages = [...transcript.messages];
  const blocks = [...current.blocks];
  const replace = (next: TranscriptMessage) => {
    messages[messages.length - 1] = next;
  };

  switch (kind) {
    case "text_start":
      blockAt(blocks, contentIndex, () => ({ kind: "text", text: "", complete: false }));
      break;

    case "text_delta": {
      const block = blockAt(blocks, contentIndex, () => ({ kind: "text", text: "", complete: false }));
      if (block.kind === "text") {
        blocks[contentIndex] = { ...block, text: block.text + String(update.delta ?? "") };
      }
      break;
    }

    case "text_end": {
      // Authoritative: REPLACE, do not append. Appending here would double the block, because
      // `content` is cumulative and `delta` already contributed the same characters.
      const content = String(update.content ?? "");
      const block = blockAt(blocks, contentIndex, () => ({ kind: "text", text: "", complete: false }));
      blocks[contentIndex] = { kind: "text", text: content, complete: true } satisfies TextBlock;
      void block;
      break;
    }

    case "thinking_start":
      blockAt(blocks, contentIndex, () => ({ kind: "thinking", text: "", complete: false }));
      break;

    case "thinking_delta": {
      const block = blockAt(blocks, contentIndex, () => ({ kind: "thinking", text: "", complete: false }));
      if (block.kind === "thinking") {
        blocks[contentIndex] = { ...block, text: block.text + String(update.delta ?? "") };
      }
      break;
    }

    case "thinking_end": {
      blocks[contentIndex] = { kind: "thinking", text: String(update.content ?? ""), complete: true } satisfies TextBlock;
      break;
    }

    case "toolcall_start": {
      const block: ToolCallBlock = {
        kind: "toolcall",
        contentIndex,
        argsText: "",
        complete: false,
        ...(update.id !== undefined ? { id: String(update.id) } : {}),
        ...(update.toolName !== undefined ? { name: String(update.toolName) } : {}),
      };
      blockAt(blocks, contentIndex, () => block);
      blocks[contentIndex] = block;
      break;
    }

    case "toolcall_delta": {
      const existing = blocks[contentIndex];
      if (existing?.kind === "toolcall") {
        blocks[contentIndex] = { ...existing, argsText: existing.argsText + String(update.delta ?? "") };
      }
      break;
    }

    case "toolcall_end": {
      const existing = blocks[contentIndex];
      const call = update.toolCall as { id?: string; name?: string; input?: unknown } | undefined;
      const base: ToolCallBlock =
        existing?.kind === "toolcall"
          ? existing
          : { kind: "toolcall", contentIndex, argsText: "", complete: false };
      blocks[contentIndex] = {
        ...base,
        ...(call?.id !== undefined ? { id: call.id } : {}),
        ...(call?.name !== undefined ? { name: call.name } : {}),
        ...(call?.input !== undefined ? { args: call.input } : {}),
        complete: true,
      };
      break;
    }

    case "error": {
      // A provider stream error is content the user must see, not a silent stop.
      const block = blockAt(blocks, contentIndex, () => ({ kind: "text", text: "", complete: false }));
      const reason = String(update.reason ?? update.error ?? "the provider stream ended with an error");
      if (block.kind === "text") {
        blocks[contentIndex] = { ...block, text: `${block.text}\n\n[${reason}]`, complete: false };
      }
      break;
    }

    default:
      return transcript;
  }

  replace({ ...current, blocks });
  return { ...transcript, messages };
}

/** Results arrive as strings, objects, or arrays of content parts. Normalize to display text. */
function stringifyResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null) {
          const p = part as { text?: string; type?: string };
          if (typeof p.text === "string") return p.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof result === "object") {
    const r = result as { content?: unknown; text?: string; output?: string };
    if (typeof r.text === "string") return r.text;
    if (typeof r.output === "string") return r.output;
    if (r.content !== undefined) return stringifyResult(r.content);
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

/** The full assistant text so far, for copy and export. */
export function assistantText(message: TranscriptMessage): string {
  return message.blocks
    .filter((block): block is TextBlock => block.kind === "text")
    .map((block) => block.text)
    .join("");
}
