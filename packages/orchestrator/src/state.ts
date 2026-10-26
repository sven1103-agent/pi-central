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
import {
  BLOCKING_DIALOG_METHODS,
  FIRE_AND_FORGET_UI_METHODS,
  isBlockingDialog,
  type LiveSession,
  type PendingDialog,
  type PiRecord,
} from "@pi-central/protocol";

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

    case "compaction_end":
      // A stats refresh, and ONLY a stats refresh (#5). Compaction's whole purpose is to shrink the
      // context, so `contextPercent` is stale the moment it finishes — the meter would keep showing
      // the pressure that was just relieved, and the reader's next decision (prompt now, or compact
      // again?) would be made on the old number. An `agent_settled`-only refresh would hide the drop
      // for the entire rest of the turn.
      //
      // No state patch: a compaction can be followed by a retry, so it is not completion (C8).
      return { refreshStats: true };

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
      // Classified by METHOD, and the unknown-method default is "blocking" (see
      // `isBlockingDialog`): notify/setStatus/setWidget arrive in a burst at startup and must
      // never be dialogs, while an unrecognized method must never be silently dropped -- an
      // unanswerable request that Pi is waiting on hangs the session with no visible cause.
      if (!isBlockingDialog(record)) return {};
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

/**
 * Exposed so a test can assert the classification matches Pi's documented method families.
 *
 * This file previously carried its own copy of the blocking-method list, which is a second
 * source of truth for a security-relevant decision -- the two would drift. It now uses the
 * protocol's list, and the default for an unrecognized method is handled there.
 */
export const blockingDialogMethods: readonly string[] = [...BLOCKING_DIALOG_METHODS];

/** Exposed so a test can assert the non-dialog set matches Pi's fire-and-forget methods. */
export const fireAndForgetUiMethods: readonly string[] = [...FIRE_AND_FORGET_UI_METHODS];
