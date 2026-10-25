/**
 * The record→state interpretation, as a pure function.
 *
 * This lives outside the supervisor on purpose. The rules here are the ones that are silent
 * and expensive when wrong — above all, **completion is `agent_settled`, never `agent_end`**
 * (C8) — so they are worth testing directly rather than through a spawned process, a
 * credential, and a sandbox.
 *
 * `interpretRecord` decides; the supervisor applies. Keeping the decision pure means the
 * tests exercise the real code path, not a paraphrase of it.
 */
import type { LiveSession, PendingDialog, PiRecord } from "@pi-central/protocol";

/** The dialog methods that block the agent until answered (docs/PROTOCOL.md). */
const BLOCKING_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** What the supervisor should change after seeing one record. */
export interface RecordEffect {
  /** Fields to merge into the session. */
  patch?: Partial<LiveSession>;
  /** A dialog to register, if this record opened one. */
  dialog?: PendingDialog;
  /** Whether fresh stats should be fetched (settled is the natural moment). */
  refreshStats?: boolean;
}

/** Neither user nor assistant: a tool result, a system note, a log line. */
function countAsMessage(record: PiRecord): boolean {
  const message = record.message as { role?: string } | undefined;
  return message?.role === "user" || message?.role === "assistant";
}

/**
 * Interpret one Pi record against the session's current state.
 *
 * `session` is passed in read-only because a couple of decisions depend on current state
 * (an outstanding dialog changes what "settled" means).
 */
export function interpretRecord(session: LiveSession, record: PiRecord): RecordEffect {
  switch (record.type) {
    case "agent_start":
      return { patch: { state: "streaming" } };

    case "agent_end":
      // Deliberately no patch (C8). Retries, compaction, steering and follow-ups can all
      // follow agent_end; calling it "done" would mark a working session idle and invite a
      // teardown or a re-prompt mid-run.
      return {};

    case "agent_settled":
      // THIS is completion (C8).
      return {
        patch: { state: session.dialogs.length > 0 ? "awaiting-approval" : "idle" },
        refreshStats: true,
      };

    case "message_end":
      return countAsMessage(record) ? { patch: { messageCount: session.messageCount + 1 } } : {};

    case "queue_update": {
      const steering = (record.steering as unknown[] | undefined)?.length ?? 0;
      const followUp = (record.followUp as unknown[] | undefined)?.length ?? 0;
      return { patch: { pending: steering + followUp } };
    }

    case "thinking_level_changed":
      return { patch: { thinkingLevel: record.level as string | undefined } };

    case "extension_ui_request": {
      // notify / setStatus / setWidget arrive in a burst at startup and are non-blocking.
      // Misclassifying one would wedge the session on a prompt no human will ever answer.
      if (!BLOCKING_DIALOG_METHODS.has(String(record.method))) return {};
      const dialog: PendingDialog = {
        id: String(record.id),
        method: String(record.method),
        title: record.title as string | undefined,
        message: record.message as string | undefined,
        options: record.options as string[] | undefined,
        placeholder: record.placeholder as string | undefined,
        prefill: record.prefill as string | undefined,
        receivedAt: Date.now(),
      };
      return { dialog, patch: { state: "awaiting-approval" } };
    }

    default:
      return {};
  }
}

/** Exposed so a test can assert the dialog set matches Pi's blocking methods. */
export const blockingDialogMethods: readonly string[] = [...BLOCKING_DIALOG_METHODS];
