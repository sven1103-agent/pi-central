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
  /**
   * The tool was called but no result was ever recorded.
   *
   * Verified on a real session: 1188 tool calls, 1187 tool results — one `bash` call's result was
   * never persisted, because the run was interrupted. Surfaced rather than omitted, since "the
   * agent tried this and we never saw the outcome" is exactly what someone opens a trace to find.
   */
  unfinished?: boolean | undefined;
  /**
   * How many messages existed when this tool ran, i.e. its position in the conversation.
   *
   * Recorded because tools are NOT a separate stream to be appended at the end: they happen
   * between two messages. Without a position the only way to render them is after everything
   * else, which buries the conversation under a thousand frames — the actual defect this field
   * exists to fix.
   *
   * A tool requested by the message at `messages[i]` has `afterMessage === i + 1`.
   */
  afterMessage: number;
}

export interface Transcript {
  messages: TranscriptMessage[];
  tools: ToolExecution[];
  /** Pi records seen, for the "is anything happening" indicator. */
  lastRecordType?: string | undefined;
  lastRecordAt?: number | undefined;
  /**
   * Notices about what Pi is doing to the RUN rather than saying: compaction and retries (#5).
   *
   * Kept OUT of `messages` and `tools`, deliberately. Those two are the conversation and its work,
   * and both are declared by Pi. A compaction or a retry is neither: it is an event about the
   * machinery. Putting it in `messages` would give it a role and a turn, which is a claim that the
   * agent said something; putting it in `tools` would give it a tool call, which is a claim something
   * ran. It is a third kind of thing, so it is a third field.
   *
   * Ordering is by arrival, because these are notices about the sequence of attempts and the
   * sequence is the information.
   *
   * OPTIONAL, and that is not laziness: `Transcript` is also built from whole conversations fetched
   * after a reload, where there are no notices because notices are records and records are not
   * replayed. A required field would force every such construction site to invent an empty array,
   * and `undefined` already means exactly "none were seen". `applyRecord` and `emptyTranscript` both
   * set it, so the live path always has one.
   */
  notices?: RunNotice[] | undefined;
}

/**
 * One notice about the run itself.
 *
 * Discriminated by `kind` so the renderer cannot mix up a compaction with a retry: their wording,
 * their duration and their meaning all differ, and the only thing they share is that neither is a
 * message.
 */
export type RunNotice =
  | {
      kind: "compaction";
      /** Why it started, since "overflow" and "manual" call for different things from the reader. */
      reason: string;
      startedAt: number;
      /** Present once `compaction_end` arrives. `undefined` while it is still running. */
      ended?: { aborted: boolean; willRetry: boolean; errorMessage?: string | undefined } | undefined;
      /** Token counts, when the result reported them. Always optional: Pi may not have them. */
      tokensBefore?: number | undefined;
      tokensAfter?: number | undefined;
    }
  | {
      kind: "retry";
      /** 1-based, as Pi reports it. */
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
      /** Present once `auto_retry_end` arrives. */
      ended?: { success: boolean; finalError?: string | undefined } | undefined;
    }
  | {
      kind: "summarization";
      /** Which summarizer is retrying — a branch summary and a compaction differ in consequence. */
      source: string;
      attempt: number;
      maxAttempts: number;
      errorMessage?: string | undefined;
      finished: boolean;
    };

export function emptyTranscript(): Transcript {
  // `notices` defaults to an empty array rather than being optional, so every reader can map over it
  // without a guard and a missing field cannot be mistaken for "no notices".
  return { messages: [], tools: [], notices: [] };
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

/**
 * Insert a tool, or MERGE it into the entry that already has its `toolCallId`.
 *
 * One tool call reaches the UI by two routes, and both are real:
 *
 *   1. the live `tool_execution_start` / `_update` / `_end` events — carry `args` and a duration;
 *   2. the persisted `toolResult` message, which the transcript also sees when history is loaded
 *      — carries the result and `isError`, but NO arguments.
 *
 * Pushing both produced two rows for one call. Measured on a real session: the file holds one
 * `bash` and one `write` tool result, and the trace showed four rows — with the two extras
 * sharing a `toolCallId`, which also collides as a React key.
 *
 * Merging rather than "prefer one source" is deliberate: neither route is complete on its own,
 * and which arrives first depends on whether history was loaded before or after the call ran.
 */
function upsertTool(tools: ToolExecution[], incoming: ToolExecution): ToolExecution[] {
  const index = tools.findIndex((tool) => tool.toolCallId === incoming.toolCallId);
  if (index === -1) return [...tools, incoming];

  return tools.map((tool, i) => {
    if (i !== index) return tool;
    return {
      ...tool,
      // Keep a real tool name over the "tool" placeholder a history entry starts with.
      toolName: tool.toolName && tool.toolName !== "tool" ? tool.toolName : incoming.toolName,
      args: tool.args ?? incoming.args,
      // The richer result wins: a live partial can arrive before the final text.
      result: incoming.result.length > tool.result.length ? incoming.result : tool.result,
      isError: tool.isError || incoming.isError,
      // Completion is inferred from EVIDENCE rather than from which route the entry came by:
      // a duration, or any result at all, means the call finished. Neither a live `end` nor a
      // history `toolResult` can exist without one, and a result is only ever persisted once the
      // tool is done — so a stale "running" cannot be produced by this rule.
      running: incoming.running
        ? true
        : incoming.durationMs !== undefined || incoming.result.length > 0
          ? false
          : tool.running,
      durationMs: tool.durationMs ?? incoming.durationMs,
      // Position is kept from the first sighting, which is the earlier and more accurate one.
      afterMessage: tool.afterMessage,
    };
  });
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
  // A LOCAL type that makes `notices` definite, so the notice branches below need no `?? []` at
  // every use. The public field stays optional because a transcript rebuilt from a fetched
  // conversation genuinely has none; inside the reducer, one has just been created.
  const next: Transcript & { notices: RunNotice[] } = {
    ...transcript,
    messages: [...transcript.messages],
    tools: [...transcript.tools],
    notices: [...(transcript.notices ?? [])],
    lastRecordType: type,
    lastRecordAt: Date.now(),
  };

  switch (type) {
    // --- Notices about the run itself (#5) ------------------------------------------------------
    //
    // Each of these is a START/END pair, and the END finds its notice by walking back for the most
    // recent one of the same kind that is still open. Matching on a Pi-supplied id would be better,
    // but Pi does not send one: these events carry no identifier, so "the most recent open one" is
    // the only correspondence available. That is stated here rather than assumed, because it is the
    // one place where two concurrent compactions would be conflated — which Pi does not do.
    case "compaction_start": {
      next.notices = [
        ...next.notices,
        {
          kind: "compaction",
          reason: String(record.reason ?? "unknown"),
          startedAt: Date.now(),
        },
      ];
      return next;
    }

    case "compaction_end": {
      const result = record.result as { tokensBefore?: number; tokensAfter?: number } | undefined;
      next.notices = closeNotice(next.notices, "compaction", (notice) => ({
        ...notice,
        ended: {
          aborted: record.aborted === true,
          willRetry: record.willRetry === true,
          ...(typeof record.errorMessage === "string" ? { errorMessage: record.errorMessage } : {}),
        },
        ...(typeof result?.tokensBefore === "number" ? { tokensBefore: result.tokensBefore } : {}),
        ...(typeof result?.tokensAfter === "number" ? { tokensAfter: result.tokensAfter } : {}),
      }));
      return next;
    }

    case "auto_retry_start": {
      next.notices = [
        ...next.notices,
        {
          kind: "retry",
          attempt: Number(record.attempt ?? 1),
          maxAttempts: Number(record.maxAttempts ?? 1),
          delayMs: Number(record.delayMs ?? 0),
          errorMessage: String(record.errorMessage ?? ""),
        },
      ];
      return next;
    }

    case "auto_retry_end": {
      next.notices = closeNotice(next.notices, "retry", (notice) => ({
        ...notice,
        ended: {
          success: record.success === true,
          ...(typeof record.finalError === "string" ? { finalError: record.finalError } : {}),
        },
      }));
      return next;
    }

    // Summarization retries are a DIFFERENT mechanism from `auto_retry` (a summarizer failing while
    // compacting, rather than a provider call failing) and the issue asks for them to be surfaced
    // rather than swallowed. Pi emits a scheduled event followed by an attempt-start, so both are
    // folded into one notice: two notices for one retry would misreport the attempt number, and the
    // count is the information.
    case "summarization_retry_scheduled": {
      next.notices = [
        ...next.notices,
        {
          kind: "summarization",
          // The source is not known until `attempt_start`; "unknown" is honest rather than a guess,
          // and is replaced when the next record arrives.
          source: "unknown",
          attempt: Number(record.attempt ?? 1),
          maxAttempts: Number(record.maxAttempts ?? 1),
          ...(typeof record.errorMessage === "string" ? { errorMessage: record.errorMessage } : {}),
          finished: false,
        },
      ];
      return next;
    }

    case "summarization_retry_attempt_start": {
      // Updates the pending notice in place rather than adding one: scheduled + attempt-start are
      // two events about ONE retry.
      let updated = false;
      next.notices = next.notices.map((notice) => {
        if (updated || notice.kind !== "summarization" || notice.finished) return notice;
        updated = true;
        return { ...notice, source: String(record.source ?? "unknown") };
      });
      if (!updated) {
        next.notices = [
          ...next.notices,
          {
            kind: "summarization",
            source: String(record.source ?? "unknown"),
            attempt: 1,
            maxAttempts: 1,
            finished: false,
          },
        ];
      }
      return next;
    }

    case "summarization_retry_finished": {
      next.notices = closeNotice(next.notices, "summarization", (notice) => ({
        ...notice,
        finished: true,
      }));
      return next;
    }

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
        next.tools = upsertTool(next.tools, {
          toolCallId,
          toolName: message?.toolName ?? (role === "bashExecution" ? "bash" : "tool"),
          // A `toolResult` message carries NO arguments; they are recovered from the assistant's
          // `toolCall` block in `attachHistoricalArgs`.
          args: message?.command !== undefined ? { command: message.command } : undefined,
          result: stringifyResult(message?.content) || String(message?.output ?? ""),
          isError: message?.isError === true,
          running: false,
          startedAt: Date.now(),
          // History arrives in order, so the message count at this point IS the position.
          afterMessage: next.messages.length,
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
      next.tools = upsertTool(next.tools, {
        toolCallId,
        toolName: String(record.toolName ?? ""),
        args: record.args,
        result: "",
        isError: false,
        running: true,
        startedAt: Date.now(),
        afterMessage: next.messages.length,
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
        next.tools = upsertTool(next.tools, {
          toolCallId,
          toolName: String(record.toolName ?? ""),
          args: record.args,
          result: stringifyResult(record.result),
          isError: record.isError === true,
          running: false,
          ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
          startedAt: Date.now(),
          afterMessage: next.messages.length,
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
  return attachHistoricalArgs(transcript);
}

/**
 * Fill in a history tool's arguments from the assistant `toolCall` block that requested it.
 *
 * A `toolResult` message records `toolCallId`, `toolName`, `content` and `isError` — but **not
 * the arguments**. So every trace row from history rendered with an empty description, which is
 * the least useful thing a trace row can be. The arguments are not missing from the session,
 * only from that record: the assistant's `toolCall` block in the same conversation has them,
 * keyed by the same id.
 *
 * Verified on a real session: `{id: call_c3567…, name: bash, arguments: {command: "ls -la"}}`
 * pairs with the `toolResult` whose `toolCallId` is `call_c3567…`.
 */
function attachHistoricalArgs(transcript: Transcript): Transcript {
  const calls = new Map<string, { name?: string | undefined; args?: unknown; index: number }>();
  transcript.messages.forEach((message, index) => {
    for (const block of message.blocks) {
      if (block.kind !== "toolcall" || block.id === undefined) continue;
      calls.set(block.id, { name: block.name, args: block.args, index });
    }
  });
  if (calls.size === 0) return transcript;

  const seen = new Set(transcript.tools.map((tool) => tool.toolCallId));

  const enriched = transcript.tools.map((tool) => {
    const call = calls.get(tool.toolCallId);
    if (!call) return tool;
    return {
      ...tool,
      args: tool.args ?? call.args,
      toolName: tool.toolName === "tool" && call.name ? call.name : tool.toolName,
    };
  });

  // Calls the agent made whose result was never recorded — an interrupted or aborted run.
  // Without this the trace quietly under-reports what the agent attempted.
  const unrecorded: ToolExecution[] = [];
  for (const [id, call] of calls) {
    if (seen.has(id)) continue;
    unrecorded.push({
      toolCallId: id,
      toolName: call.name ?? "tool",
      args: call.args,
      result: "",
      isError: false,
      running: false,
      startedAt: Date.now(),
      afterMessage: call.index + 1,
      unfinished: true,
    });
  }

  return {
    ...transcript,
    tools: [...enriched, ...unrecorded].sort((a, b) => a.afterMessage - b.afterMessage),
  };
}

/** The full assistant text so far, for copy and export. */
export function assistantText(message: TranscriptMessage): string {
  return message.blocks
    .filter((block): block is TextBlock => block.kind === "text")
    .map((block) => block.text)
    .join("");
}

// --- Tool positioning and the trace window ----------------------------------------------------
//
// Tools are a TRACE, not conversation. A session on this machine produced 1138 tool calls and
// over a megabyte of tool output; rendering all of it inline buries the agent's actual prose and
// imposes real mental load, especially with a fast provider. So:
//
//   - the transcript shows prose, plus one compact marker per contiguous run of tools, which
//     keeps the POSITION without the bulk;
//   - a small trace window shows the most recent few plus whatever is running now;
//   - the full list stays available for debugging, traversable on demand.

/** Tools that ran immediately after the message at `messageIndex` (0-based). */
export function toolsAfter(transcript: Transcript, messageIndex: number): ToolExecution[] {
  const position = messageIndex + 1;
  return transcript.tools.filter((tool) => tool.afterMessage === position);
}

/**
 * Tools that ran before any message, which happens when a session is resumed mid-tool-call.
 *
 * Returned separately rather than dropped: they are real work that produced real output, and a
 * trace that silently omits the first entries is worse than one that shows them out of context.
 */
export function leadingTools(transcript: Transcript): ToolExecution[] {
  return transcript.tools.filter((tool) => tool.afterMessage === 0);
}

/** The tool currently running, if any. At most one is expected, but a parallel batch can run. */
export function activeTools(transcript: Transcript): ToolExecution[] {
  return transcript.tools.filter((tool) => tool.running);
}

/**
 * The tail of the trace: the most recent tools, always including anything still running.
 *
 * Includes running tools even if they fall outside `limit`, because the active one is the only
 * entry that changes and the whole point of the window is to watch it.
 */
export function recentTools(tools: ToolExecution[], limit = 5): ToolExecution[] {
  const total = tools.length;
  if (total === 0) return [];
  const tail = tools.slice(Math.max(0, total - limit));
  const running = tools.filter((tool) => tool.running && !tail.includes(tool));
  return [...running, ...tail];
}

/** A one-line summary of a tool's input, for a trace row. Never a full argument dump. */
export function toolSummary(tool: ToolExecution): string {
  const args = tool.args;
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  if (typeof args === "object") {
    const record = args as Record<string, unknown>;
    // Prefer the argument that says WHAT the tool acted on, which is what a reader scans for.
    for (const key of ["command", "path", "file_path", "pattern", "query", "url", "prompt", "name"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return key === "command" ? value : `${value}`;
      }
    }
    const keys = Object.keys(record);
    return keys.length > 0 ? keys.join(", ") : "";
  }
  return String(args);
}

/** Counts for the transcript's compact marker. */
export function toolRunSummary(tools: ToolExecution[]): {
  count: number;
  names: string[];
  failed: number;
} {
  const names: string[] = [];
  for (const tool of tools) {
    if (!names.includes(tool.toolName)) names.push(tool.toolName);
  }
  return {
    count: tools.length,
    names,
    failed: tools.filter((tool) => tool.isError).length,
  };
}

/**
 * Does this message have anything worth reading?
 *
 * Many assistant messages are a tool call with no text at all — 212 of them in one real session —
 * and rendering a heading above nothing is pure noise.
 */
/**
 * One line of a thinking block, so four collapsed blocks are not four identical bars (issue #143).
 *
 * ## The defect this fixes
 *
 * A screenshot review of a real transcript found a column where SIX thinking blocks rendered as the
 * same 700px-wide bar with the same single word in it. Nothing about them differed, so the feed's
 * most common element carried no information: the eye cannot tell a two-second aside from a long
 * derivation, cannot tell one block from the next, and cannot decide which to open. The one thing
 * the reader wants from a collapsed block — "was this worth reading?" — was absent.
 *
 * ## Why the block's own words, and not a duration
 *
 * "Thought for 4s" was the obvious alternative and it is a worse answer here. `durationMs` exists on
 * TOOL calls, not on thinking blocks, so a duration would have to be invented from arrival times —
 * a number that measures the transport, not the thinking. The agent's first sentence is real, is
 * already on the wire, and is the thing that actually says what the block is about.
 *
 * ## Why it cannot leak more than the block already does
 *
 * The body is rendered in full behind the same `<details>`, so the gist exposes nothing that opening
 * the block would not. It is a preview of content already present and already marked as data.
 *
 * ## What the cap does NOT promise, and why the rest is not put on `title`
 *
 * A block whose distinguishing word arrives late — "Let me check whether this repository already has a
 * helper for reading PNG bytes" — loses "PNG" to the 72-character cut, because the lead-in spent the
 * budget. That is a real limit, and the first fix for it was a `title` carrying the whole block: hover the
 * bar, read the lost word.
 *
 * That was wrong, and it took a reader to see why. A native tooltip holding an entire thought is a
 * screen-filling panel that appears on a stray mouse-over — no click, no focus, no way to keep it open or
 * dismiss it. A collapsed block exists so a long derivation costs ONE LINE until it is asked for; the gist
 * is that one line. Opening the `<details>` is the only gesture that means "show me this".
 *
 * So the cap is honest instead: the gist may not contain the distinguishing word, and the way to read the
 * rest is to open the block. Two different thoughts still produce two different gists in practice, which is
 * the property that matters — a signature word surviving is common but not guaranteed.
 */
export function thinkingGist(text: string, max = 72): string {
  // Collapse newlines and runs of space first: markdown prose wraps, and a gist with a line break in it
  // is not one line. Then drop the leading markdown emphasis a thought often opens with (`**`, `_`, `#`),
  // which costs characters and says nothing.
  const flat = text
    .replace(/\s+/g, " ")
    .replace(/^[\s*_#>\-]+/, "")
    .trim();
  if (flat.length === 0) return "";
  if (flat.length <= max) return flat;
  // Cut at a word boundary rather than mid-word, and only announce the elision with an ellipsis: the
  // block is expandable, so a reader who wants the rest knows exactly where to get it.
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[,;:.\u2014-]+$/, "")}…`;
}

export function hasProse(message: TranscriptMessage): boolean {
  return (
    message.blocks.some((block) => block.kind === "text" && block.text.trim().length > 0) ||
    message.blocks.some((block) => block.kind === "thinking" && block.text.trim().length > 0)
  );
}

/** One entry in the transcript's render plan. */
export type TranscriptEntry =
  | { kind: "turn"; message: TranscriptMessage }
  | { kind: "tools"; tools: ToolExecution[] };

/**
 * Plan the transcript as a sequence of prose turns and tool markers.
 *
 * **One marker per contiguous stretch of tool work**, not one per message position. This is the
 * difference that makes the transcript readable: Pi interleaves assistant → tool → assistant
 * rapidly, so a marker at every position produced 997 markers against 866 turns on a real
 * session — still tool-dominated, and still the mental load the trace window exists to remove.
 *
 * Grouping by stretches of prose-less messages collapses each burst of work into a single line
 * such as `17 tools · bash read edit`, which preserves the POSITION of the work without spending
 * the reader's attention on each call.
 *
 * Tools requested by message `i` run after it, so a stretch of tools is emitted immediately
 * before the next turn that has something to read.
 */
/**
 * Mark the most recent OPEN notice of a kind as ended.
 *
 * The END events carry no id to match against — Pi does not send one — so this finds the last notice
 * of that kind that has not been closed yet. A notice arriving without a matching start is left
 * alone rather than fabricated: `compaction_end` with no `compaction_start` means the start happened
 * before this page loaded, and inventing one would claim to have seen something it did not.
 */
function closeNotice<K extends RunNotice["kind"]>(
  notices: RunNotice[],
  kind: K,
  update: (notice: Extract<RunNotice, { kind: K }>) => Extract<RunNotice, { kind: K }>,
): RunNotice[] {
  for (let index = notices.length - 1; index >= 0; index -= 1) {
    const notice = notices[index]!;
    if (notice.kind !== kind) continue;
    const closed = "ended" in notice ? notice.ended !== undefined : (notice as { finished?: boolean }).finished === true;
    if (closed) continue;
    const result = [...notices];
    result[index] = update(notice as Extract<RunNotice, { kind: K }>);
    return result;
  }
  return notices;
}

/**
 * Is a notice still in flight?
 *
 * Exported so the renderer decides "running" from ONE definition. A component that tested
 * `ended === undefined` itself would drift from this the first time a kind gained a different
 * completion marker — which `summarization` already has (`finished`, not `ended`), so the drift
 * would have started immediately.
 */
export function noticeIsOpen(notice: RunNotice): boolean {
  if (notice.kind === "summarization") return !notice.finished;
  return notice.ended === undefined;
}

export function planTranscript(transcript: Transcript): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const leading = leadingTools(transcript);
  if (leading.length > 0) entries.push({ kind: "tools", tools: leading });

  let pending: ToolExecution[] = [];
  transcript.messages.forEach((message, index) => {
    const tools = toolsAfter(transcript, index);
    if (hasProse(message)) {
      // Whatever ran before this readable turn is announced first, then the turn itself.
      if (pending.length > 0) {
        entries.push({ kind: "tools", tools: pending });
        pending = [];
      }
      entries.push({ kind: "turn", message });
    }
    pending.push(...tools);
  });

  // Work after the last readable turn still happened and still needs a marker.
  if (pending.length > 0) entries.push({ kind: "tools", tools: pending });
  return entries;
}
