/**
 * The surface for update outcomes: a dialog that returns to the dashboard (issue #217).
 *
 * ## The defect this exists for, reported from a running app
 *
 * "The Update Pi Central path brings users into a dead end of the app, they cannot return from unless to
 * restart the app."
 *
 * The first version reported every update outcome through `showFailure` — the page built for "the
 * orchestrator could not start". That function **replaces the window's document** with a `data:` page, and its
 * only control is *Try again*, which calls `retry()`. On the update path the orchestrator is usually still
 * running, so `retry()` refuses ("an orchestrator is already running") and the button does nothing. The
 * window is left showing a diagnostic page about an update, over a dashboard that is alive and now
 * unreachable. The only way out was to quit.
 *
 * Three separate mistakes, and each is worth naming because each is independently enough to cause the dead end:
 *
 *   1. **The wrong surface.** `showFailure` means "the window has nothing to show", so it takes the window.
 *      An update outcome is a *message about an action the reader took* — the dashboard behind it is fine and
 *      must stay.
 *   2. **The wrong control.** "Try again" restarts the orchestrator. For a failed update it must re-try the
 *      *update*, and for "no update to apply" there is nothing to retry at all — the honest control is
 *      *OK*.
 *   3. **A refusal rendered as a failure.** "There is no update to apply because you are current" is a
 *      successful check. Painting it as a failure page trains the reader to read a normal answer as a fault.
 *
 * ## Why a native dialog rather than a banner in the page
 *
 * A banner would need a preload and IPC to reach `main.ts`, and this app deliberately ships no preload
 * (`windowWebPreferences` documents it: "a preload arrives with its own criteria and its own review"). A
 * dialog is dismissible by construction, needs no channel into the renderer, and cannot be left covering the
 * dashboard in a way that blocks interaction — which is the property the dead end lacked.
 *
 * The detail is still selectable in a native `dialog.showMessageBox` on macOS, which was the reason
 * `showFailure` was built as HTML in the first place (an `showErrorBox` cannot be copied from). This is the
 * non-modal, information-bearing member of the same family.
 */

/** What an update message is about, which decides the wording and the buttons. */
export type UpdateNoticeKind =
  /** The check ran and a newer version exists. */
  | "update-available"
  /** The check ran and this installation is current. */
  | "up-to-date"
  /** There is nothing to apply, and the reason is in the message. */
  | "nothing-to-apply"
  /** The installation is managed elsewhere, so this app may not replace it. */
  | "managed-elsewhere"
  /** The update was attempted and failed. */
  | "failed"
  /** The check itself could not be made. */
  | "check-failed";

/**
 * One message, as data.
 *
 * Built here rather than inline in `main.ts` for the same reason `stopDialog` and `updateDialog` are: a
 * dialog's wording and buttons *are* its behaviour, and `main.ts` cannot be loaded by a test.
 */
export interface UpdateNotice {
  type: "info" | "warning" | "error";
  message: string;
  detail: string;
  buttons: string[];
  /** The button a Return or a dismissal selects. Always the non-destructive one. */
  defaultId: number;
  cancelId: number;
  noLink: true;
}

/**
 * The notice for one outcome.
 *
 * ## The button rule
 *
 * Every notice here has exactly one useful action — *OK* — except a failed update, where re-trying is
 * genuinely useful and the reader is already in the menu. "Try again" restarts the **update**, never the
 * orchestrator, and it is never the default: an accidental Return must not re-run `npm`.
 *
 * `standardVersion` is passed separately from the failure text so the message can say what is *still
 * running*, which is the fact a reader needs after a failed update.
 */
export function updateNotice(kind: UpdateNoticeKind, input: {
  /** The version running now, when it is known. */
  runningVersion?: string | undefined;
  /** What the check found, when it found something. */
  availableVersion?: string | undefined;
  /** The explanation, for the kinds that carry one. */
  detail?: string | undefined;
  /** Whether re-trying the update is a sensible offer. */
  canRetry?: boolean | undefined;
}): UpdateNotice {
  const running = input.runningVersion === undefined ? "" : ` ${input.runningVersion}`;
  const base = { type: "info" as const, defaultId: 0, cancelId: 0, noLink: true as const };

  switch (kind) {
    case "update-available":
      return {
        ...base,
        message: `Pi Central ${input.availableVersion ?? ""} is available`,
        detail:
          `You are running${running === "" ? " an older version" : running}. ` +
          `Use "Update Pi Central…" to install it — the app will be restarted, so any running session will be too.`,
        buttons: ["OK"],
      };
    case "up-to-date":
      return {
        ...base,
        message: "Pi Central is up to date",
        detail:
          `Running${running === "" ? " the latest release" : running}, which is the latest release.` +
          (input.detail === undefined ? "" : `\n\n${input.detail}`),
        buttons: ["OK"],
      };
    case "nothing-to-apply":
      /*
       * Distinct from `up-to-date` because the reason can be something else entirely — a downgrade refused, a
       * malformed answer from the registry. Calling all of those "up to date" would be a false report; calling them a
       * failure would be a false alarm. This is: nothing happened, here is why.
       */
      return {
        ...base,
        type: "warning",
        message: "There is no update to apply",
        detail: `${input.detail ?? "No newer version was found."}\n\nNothing was changed${running === "" ? "" : `, and ${running.trim()} is still running`}.`,
        buttons: ["OK"],
      };
    case "managed-elsewhere":
      return {
        ...base,
        type: "warning",
        message: "This Pi Central was installed another way",
        detail: `${input.detail ?? ""}\n\nNothing was changed${running === "" ? "" : `, and ${running.trim()} is still running`}.`,
        buttons: ["OK"],
      };
    case "failed":
      return {
        ...base,
        type: "error",
        message: "The update was not applied",
        detail: `${input.detail ?? ""}\n\n${running === "" ? "" : `${running.trim()} is still running. `}Nothing was changed.`,
        // Re-trying restarts the UPDATE. It is never the default, so a stray Return cannot run npm again.
        buttons: input.canRetry === true ? ["OK", "Try the update again"] : ["OK"],
        defaultId: 0,
        cancelId: 0,
      };
    case "check-failed":
      return {
        ...base,
        type: "error",
        message: "Pi Central could not check for updates",
        detail: `${input.detail ?? ""}\n\nNothing was changed. You can also check from a terminal:  npm view pi-central version`,
        buttons: ["OK"],
      };
  }
}

/** Which button of `updateNotice(...)` means "do it again". */
export const RETRY_UPDATE_BUTTON = "Try the update again";

/**
 * Whether a response to a failed update's dialog asks for another attempt.
 *
 * Read by `main.ts` after the dialog closes, so the retry happens *outside* the dialog's own event — a re-entrant
 * update would otherwise start while the first one's `finally` is still unwinding `updating`.
 */
export function wantsRetry(notice: UpdateNotice, response: number): boolean {
  return notice.buttons[response] === RETRY_UPDATE_BUTTON;
}

/**
 * Whether the update surface may take over the window at all.
 *
 * The rule, as a function so it can be asserted: **only a launch failure may replace the dashboard.** An update
 * outcome — including a failed one — leaves the orchestrator running, so the window keeps showing it. This exists
 * because the two were conflated and produced a page with no way back.
 */
export function mayReplaceWindow(reason: "launch-failure" | "update-outcome"): boolean {
  return reason === "launch-failure";
}
