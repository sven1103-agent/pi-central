/**
 * The Pi RPC surface Pi Central depends on, as types only.
 *
 * The load-bearing decision (docs/STACK.md, ADR-0005): these are `import type`, so Pi is a
 * devDependency of this package and never enters the runtime bundle. If Pi changes a
 * command or event name, `tsc` fails here instead of the supervisor silently
 * misunderstanding the protocol.
 *
 * ADR-0009: the orchestrator does NOT import Pi's agent core at runtime. Discovery is our
 * own parser. The only runtime contact with Pi is the `pi --mode rpc` child process.
 */
import type {
  RpcCommand,
  RpcResponse,
  RpcSessionState,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";

export type { RpcCommand, RpcResponse, RpcSessionState, RpcExtensionUIRequest, RpcExtensionUIResponse };

/** JSON records Pi emits on stdout. Pi's own union is broad; we narrow where we act. */
export interface PiRecord {
  type: string;
  [key: string]: unknown;
}

/** A response Pi has correlated to a command `id`. */
export function isRpcResponse(record: PiRecord): record is PiRecord & RpcResponse {
  return record.type === "response" && typeof record.id === "string";
}

/** The dialog methods that block the agent until answered (docs/PROTOCOL.md). */
export const BLOCKING_DIALOG_METHODS = ["select", "confirm", "input", "editor"] as const;
export type BlockingDialogMethod = (typeof BLOCKING_DIALOG_METHODS)[number];

const BLOCKING = new Set<string>(BLOCKING_DIALOG_METHODS);

/**
 * Non-dialog extension UI requests (`notify`, `setStatus`, `setWidget`) arrive in a burst at
 * startup and must never be treated as blocking. Misclassifying one would wedge a session
 * on a prompt that no human will ever answer.
 */
export function isBlockingDialog(record: PiRecord): boolean {
  return record.type === "extension_ui_request" && BLOCKING.has(String(record.method ?? ""));
}

/**
 * The commands Pi Central is allowed to send.
 *
 * A closed union, on purpose: the supervisor must not be able to send an arbitrary object
 * derived from untrusted input (docs/ARCHITECTURE.md, trust boundary rules).
 */
export type Command =
  | { type: "get_state" }
  | { type: "get_session_stats" }
  | { type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "abort" }
  | { type: "set_session_name"; name: string }
  | { type: "bash"; command: string; excludeFromContext?: boolean };

/** Extension UI responses are fire-and-forget: they carry no `id` of our own. */
export type DialogAnswer =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };
