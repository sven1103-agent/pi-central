/**
 * The stale-page banner (issues #184, #213).
 *
 * A component rather than an inline block in `App.tsx`, because the recovery it offers is the whole
 * point of the feature and inline JSX cannot be rendered in this project's test setup. `#184` shipped
 * a banner whose Reload button existed and whose advice said "quit the app and reopen" — a sentence,
 * next to a control that did the same thing — and neither could be asserted anywhere but by hand.
 *
 * ## The Reload button is not the only way out, and must not look like it is
 *
 * A page whose script is wedged (a service worker serving a half-armed bundle, a tab whose bundle was
 * replaced mid-load) can have a button that does nothing when pressed. So the banner keeps naming the
 * manual fallback in `message`; the button is the fast path, not the only path. That is also why the
 * message is passed in rather than composed here: `assessServedUi` and `assessProtocolSkew` each own
 * the sentence for their own fault, and this component must not be able to describe a third.
 */
import type { ReactNode } from "react";

export interface UpdateBannerProps {
  /** The verdict's sentence, from `update-check.ts`. Never composed here. */
  message: string;
  /** Set when a reload is warranted but would destroy unsent work; takes the place of the button. */
  blockedMessage?: string | undefined;
  /** Pressing Reload. Injected so a test can assert the call without a browser. */
  onReload: () => void;
  /** Heading override, for the case where the window is already up to date on return. */
  title?: string | undefined;
}

/**
 * The banner. One shape for both faults.
 *
 * `role="alert"` because it reports a condition about the window that the reader did not ask about and
 * must be able to act on; it is not a status message. The button is `btn` rather than `btn-primary`:
 * the recovery is available, not the app's main action.
 */
export function UpdateBanner({ message, blockedMessage, onReload, title = "Update available" }: UpdateBannerProps): ReactNode {
  const blocked = blockedMessage !== undefined;
  return (
    <div className="direct-banner update-banner" role="alert">
      <strong>{title}</strong>
      <span>{blocked ? blockedMessage : message}</span>
      {blocked ? null : (
        <button type="button" className="btn" onClick={onReload}>
          Reload now
        </button>
      )}
    </div>
  );
}
