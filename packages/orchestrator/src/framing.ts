/**
 * JSONL framing for Pi's RPC stream (C7).
 *
 * The rule: **one JSON object per record, terminated by LF (0x0a).** Never `readline`.
 *
 * Why this is its own module rather than a few lines in the supervisor: Node's `readline`
 * also splits on U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR), both of which are
 * *legal inside a JSON string*. A model that emits one — in a code block, a quoted passage,
 * an error message — would have a single record torn in half and the supervisor would parse
 * two invalid fragments. The bug would be rare, output-dependent, and look like corruption.
 *
 * So: split on the byte 0x0a only, and tolerate a CR immediately before it (a CRLF sender).
 */
import type { PiRecord } from "@pi-central/protocol";

/** Raised when a record has no `type`, so the caller can decide rather than guess. */
export class MalformedRecordError extends Error {
  // A plain field, not a parameter property: Node's strip-only TypeScript loader rejects
  // constructor parameter properties, and we run .ts directly (no build step).
  readonly line: string;
  constructor(line: string) {
    super(`record has no "type": ${line.slice(0, 120)}`);
    this.name = "MalformedRecordError";
    this.line = line;
  }
}

/**
 * A streaming splitter over a byte buffer. Feed it chunks; it yields complete records.
 *
 * Stateful, because a record can straddle any chunk boundary: the JSON, and even the
 * terminating newline, may arrive split.
 */
export class JsonlDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  /** Feed a chunk; returns any complete records it completed. */
  push(chunk: Buffer): PiRecord[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    return this.#drain();
  }

  /** Records left when the stream ends. A trailing record without LF is still valid. */
  flush(): PiRecord[] {
    const out = this.#drain();
    if (this.#buffer.length > 0) {
      const record = this.#parse(this.#buffer);
      this.#buffer = Buffer.alloc(0);
      if (record) out.push(record);
    }
    return out;
  }

  #drain(): PiRecord[] {
    const records: PiRecord[] = [];
    for (;;) {
      const nl = this.#buffer.indexOf(0x0a);
      if (nl === -1) break;
      const line = this.#buffer.subarray(0, nl);
      this.#buffer = this.#buffer.subarray(nl + 1);
      const record = this.#parse(line);
      if (record) records.push(record);
    }
    return records;
  }

  #parse(raw: Buffer): PiRecord | null {
    let line = raw;
    // Tolerate a CR before the LF.
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (line.length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      // A malformed record must not kill the reader (docs/PROTOCOL.md).
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as PiRecord;
    if (typeof record.type !== "string" || record.type.length === 0) return null;
    return record;
  }
}

/** Encode a command as a single LF-terminated line. */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
