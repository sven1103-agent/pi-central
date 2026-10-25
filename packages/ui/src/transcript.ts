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
 * Verified against a real 2169-message session file, and the shapes are not what the streaming
 * events suggest:
 *
 *   content blocks found: text 1884, thinking 440, **toolCall** 1121, image 3, plain-string 2
 *   roles found:          system, user, assistant, **toolResult** (1120)
 *
 * Three things this got wrong at first, all now load-bearing:
 *
 *   - Pi's content block is `toolCall`, **camelCase**. The original code matched `tool_use` and
 *     `tool_call`, so all 1121 tool calls in a history would have been dropped silently.
 *   - A user message's `content` may be a plain **string**, not an array, so those messages
 *     rendered as empty.
 *   - Tool results are not content blocks at all: they are separate messages with role
 *     `toolResult`. They are handled in `applyRecord`, not here.
 *
 * `image` blocks are deliberately skipped: the transcript has no image viewer, and inventing
 * one from a base64 payload is worse than omitting it.
 */
function blocksFromContent(content: unknown): Block[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ kind: "text", text: content, complete: true }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const piece = part as {
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      arguments?: unknown;
      input?: unknown;
    };
    if (piece.type === "text" && typeof piece.text === "string") {
      blocks.push({ kind: "text", text: piece.text, complete: true });
    } else if (piece.type === "thinking" && typeof piece.thinking === "string") {
      blocks.push({ kind: "thinking", text: piece.thinking, complete: true });
    } else if (piece.type === "toolCall" || piece.type === "tool_use" || piece.type === "tool_call") {
      // Pi names the payload `arguments`; the snake_case spellings are accepted so a
      // provider-shaped payload still renders rather than vanishing.
      const args = piece.arguments ?? piece.input;
      blocks.push({
        kind: "toolcall",
        contentIndex: blocks.length,
        ...(piece.id !== undefined ? { id: piece.id } : {}),
        ...(piece.name !== undefined ? { name: piece.name } : {}),
        argsText: "",
        ...(args !== undefined ? { args } : {}),
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
      const message = record.message as
        | {
            role?: string;
            content?: unknown;
            toolCallId?: string;
            toolName?: string;
            isError?: boolean;
            command?: string;
            output?: string;
            stopReason?: string;
            errorMessage?: string;
          }
        | undefined;

      // History replay arrives through this same path (see `Supervisor#loadTranscript`), so the
      // roles that only appear in a session file have to be handled here rather than only the
      // two a live stream produces.
      const role = message?.role;

      // System messages are the initial prompt and the tool declarations. They are not
      // conversation, and two of them can be larger than the entire exchange.
      if (role === "system") return next;

      // Tool results are their own MESSAGE role in Pi, not a content block. They become tool
      // frames so the UI renders them in the hatched quarantine, which is where output the
      // model did not author belongs.
      if (role === "toolResult" || role === "bashExecution") {
        const toolCallId = message?.toolCallId ?? `history-${next.tools.length}`;
        next.tools.push({
          toolCallId,
          toolName: message?.toolName ?? (role === "bashExecution" ? "bash" : "tool"),
          args: message?.command !== undefined ? { command: message.command } : undefined,
          result: stringifyResult(message?.content) || String(message?.output ?? ""),
          isError: message?.isError === true,
          running: false,
          startedAt: Date.now(),
        });
        return next;
      }

      const blocks = blocksFromContent(message?.content);
      // A failed or aborted response is shown even when it produced no content. Without this a
      // provider error arrives as an empty turn and the reader is told nothing at all.
      const failure = message ? describeStopReason(message as { stopReason?: string; errorMessage?: string }) : undefined;
      if (failure) blocks.push({ kind: "text", text: failure, complete: true });
      const last = next.messages[next.messages.length - 1];
      // The authoritative message REPLACES the partial one. Matching by position is correct
      // here because `message_end` refers to the message just streamed.
      if (last && last.role === "assistant" && !last.complete && role !== "user") {
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
          role: normaliseRole(role),
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

/**
 * Describe a message that did not complete.
 *
 * Verified against a real session: 10 assistant messages have an EMPTY content array, and all 10
 * carry `stopReason` of `"error"` (8) or `"aborted"` (2) with an `errorMessage`. Rendering those
 * as blank turns hides a provider failure completely — the same silent-failure class as C12 and
 * C13, in the transcript rather than the policy.
 */
function describeStopReason(message: { stopReason?: string; errorMessage?: string }): string | undefined {
  const reason = message.stopReason;
  if (reason !== "error" && reason !== "aborted") return undefined;
  const detail = message.errorMessage?.trim();
  const head = reason === "aborted" ? "This response was interrupted." : "This response did not complete.";
  return `⚠ ${head}${detail ? ` ${detail}` : ""}`;
}

/**
 * Map Pi's message roles onto the four the transcript renders.
 *
 * Pi has more roles than the four (system, user, assistant, toolResult, bashExecution, and
 * coding-agent extras), and an unmapped one would be rendered verbatim as a label — which is how
 * a transcript ends up captioned "toolResult".
 */
function normaliseRole(role: string | undefined): TranscriptMessage["role"] {
  switch (role) {
    case "user":
      return "user";
    case "system":
      return "system";
    case "toolResult":
    case "bashExecution":
      return "tool";
    default:
      return "assistant";
  }
}

/**
 * Fold a list of historical messages into an empty transcript.
 *
 * Used when a session is resumed: Pi loads its history into the model's context but does NOT
 * re-emit it as events, so without this the UI shows "No messages yet" for a session with
 * hundreds of them.
 *
 * Each message is fed through the SAME `message_end` path a live message takes, rather than a
 * parallel history renderer. Two renderers for one conversation is how the past and the present
 * end up looking different.
 */
export function seedTranscript(messages: unknown[]): Transcript {
  let transcript = emptyTranscript();
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    transcript = applyRecord(transcript, { type: "message_end", message });
  }
  return transcript;
}

/** The full assistant text so far, for copy and export. */
export function assistantText(message: TranscriptMessage): string {
  return message.blocks
    .filter((block): block is TextBlock => block.kind === "text")
    .map((block) => block.text)
    .join("");
}
