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
 * Extension UI methods that expect **no response** (docs/rpc-extension-ui.md).
 *
 * This list is the load-bearing one, and it is deliberately a list of the *non-dialog* family
 * rather than of the dialogs. Both families are documented and closed for Pi 1.4.0 — five
 * fire-and-forget plus four dialogs, which is exactly the nine requests observed in the startup
 * burst — so either could be enumerated. Which one is enumerated decides how to fail on a
 * method nobody has seen before:
 *
 *   - Enumerate the DIALOGS: an unrecognized method is ignored. If a future Pi adds a blocking
 *     method, the agent waits forever for a response nobody knows to send. Silent, permanent,
 *     unrecoverable without restarting the session.
 *   - Enumerate the NON-DIALOGS (this): an unrecognized method is treated as a dialog. The user
 *     sees it and can cancel. A spurious dialog costs a click; it cannot cost the session.
 *
 * The recoverable direction wins. This is the same lesson as C12/C13 in a different place: a
 * silent, plausible-looking non-failure is worse than a visible annoyance.
 */
export const FIRE_AND_FORGET_UI_METHODS = [
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
] as const;

export type FireAndForgetUIMethod = (typeof FIRE_AND_FORGET_UI_METHODS)[number];

const FIRE_AND_FORGET = new Set<string>(FIRE_AND_FORGET_UI_METHODS);

/**
 * Does this extension UI request need an answer?
 *
 * The default for an unknown method is **yes**, because that is the recoverable direction: an
 * unanswerable request that Pi is waiting on hangs the session with no visible cause, whereas a
 * request that needed no answer merely shows a dialog the user dismisses.
 */
export function isBlockingDialog(record: PiRecord): boolean {
  if (record.type !== "extension_ui_request") return false;
  return !FIRE_AND_FORGET.has(String(record.method ?? ""));
}

/** Is this a method Pi Central recognizes as expecting no response? */
export function isFireAndForget(record: PiRecord): boolean {
  return record.type === "extension_ui_request" && FIRE_AND_FORGET.has(String(record.method ?? ""));
}

/** Whether the method is one this build knows how to render. */
export function isKnownDialogMethod(method: string): boolean {
  return BLOCKING.has(method);
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
  /**
   * The existing conversation.
   *
   * Needed because Pi does NOT re-emit a resumed session's history as events: without this
   * command the UI renders "No messages yet" for a session with hundreds of them. It was
   * missing from this union while `rpc.send` accepted any object, so the omission could not be
   * caught by the compiler — see the note on `send`.
   */
  | { type: "get_messages" }
  /**
   * The models Pi can currently offer.
   *
   * Also absent from this union while being called from `verify-three.ts`, which is how the
   * C13 check (can the session reach a model?) was written without the compiler noticing. Making
   * `send` take this union found both omissions in the same minute.
   */
  | { type: "get_available_models" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "get_available_thinking_levels" }
  | { type: "set_thinking_level"; level: string }
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
