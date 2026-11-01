/**
 * Detecting that this page is stale, and doing something about it (issue #184).
 *
 * ## The failure this exists for
 *
 * An installed PWA window is **focused, not reloaded**, when its dock icon is clicked. So the update
 * dance — stop the orchestrator, `npm install`, restart, click the dock — brings the NEW orchestrator
 * up behind the OLD page: the bundle in memory is the previous release, and no cache is involved at
 * all. If the protocol changed, the `hello` skew check fires and its advice ("reload the UI") names
 * an action a standalone window has no affordance for. If it did not, the old UI silently keeps
 * working and the update appears to have done nothing.
 *
 * ## The signal
 *
 * The orchestrator reports the fingerprinted entry bundle it is SERVING (`InstallFacts.ui`, read
 * from the `index.html` on disk), and this page reads its OWN entry from the document it was loaded
 * from. Equal means current; different means stale. Neither side can produce this answer alone:
 * the page's own stamp is by definition the old one, and only the orchestrator knows what is on
 * disk now.
 *
 * ## One reload, never a loop
 *
 * A stale verdict reloads the page ONCE per target identity, marked in `sessionStorage`. If the
 * same verdict returns after the reload, reloading again would loop forever — that is the
 * reverse-skew case (a NEW page against an OLD orchestrator, the dev-layout hazard from issue #11's
 * comments) or a genuinely poisoned client — so the second verdict becomes a banner with a real
 * Reload button and honest advice. Marks are cleared when a snapshot proves the halves agree, so a
 * LATER update in the same tab session can reload again.
 *
 * Everything here is pure apart from the injected storage, so the decision is tested without a
 * browser.
 */
import type { InstallFacts } from "@pi-central/protocol";

/** `sessionStorage` keys for the one-shot marks. Tab-scoped on purpose: a new tab re-evaluates. */
export const UPDATE_RELOAD_KEY = "pi-central.update-reload";
export const PROTOCOL_RELOAD_KEY = "pi-central.protocol-reload";

/** The slice of web storage the marks need, injected so tests drive the decision directly. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type UpdateAction =
  | { action: "none" }
  | { action: "reload" }
  | { action: "banner"; message: string };

/**
 * The entry bundle THIS page was loaded from, e.g. `assets/index-D8opqHSQ.js`.
 *
 * Read from the document's module script tag. `undefined` when the page has no fingerprinted entry
 * — a dev server, whose module is `/src/main.tsx` — in which case the whole comparison is silent:
 * a dev server legitimately serves a different UI than the orchestrator would (issue #119's PROD
 * guard exists for the same reason).
 */
export function ownEntry(doc: Document = document): string | undefined {
  const src = doc.querySelector('script[type="module"][src]')?.getAttribute("src") ?? "";
  return /assets\/index-[A-Za-z0-9_-]+\.js/.exec(src)?.[0];
}

/**
 * Compare the page's own entry bundle against the one the orchestrator reports serving.
 *
 * Absence is never a verdict: an older orchestrator sends no `ui`, a dev page has no fingerprinted
 * entry, and `--no-ui` serves nothing. Only two PRESENT and DIFFERENT entries are evidence of a
 * stale page — "not reported" and "different" must not look alike, or every older orchestrator
 * would send its clients into reloads.
 */
export function assessServedUi(
  pageEntry: string | undefined,
  install: InstallFacts | undefined,
  storage: StorageLike,
): UpdateAction {
  const served = install?.ui?.entry;
  if (pageEntry === undefined || served === undefined) return { action: "none" };
  if (pageEntry === served) {
    // Agreement re-arms the mark: a reload that worked must not block the NEXT update's reload.
    storage.removeItem(UPDATE_RELOAD_KEY);
    return { action: "none" };
  }
  if (storage.getItem(UPDATE_RELOAD_KEY) === served) {
    return {
      action: "banner",
      message:
        "Pi Central was updated while this window was open, and reloading once did not pick up the " +
        "new UI. Quit the app (⌘Q) and reopen it; if the old version still appears after that, " +
        "clear this site's data in the browser.",
    };
  }
  storage.setItem(UPDATE_RELOAD_KEY, served);
  return { action: "reload" };
}

/**
 * `sessionStorage` with the failure modes removed.
 *
 * A browser can refuse storage outright (private mode, a full quota, a locked-down profile), and
 * a throw here would break event handling for a feature that is a convenience. Refusal degrades
 * to "no memory": every verdict is a first verdict, which costs at most one extra reload per
 * disagreement rather than the app.
 */
export function safeSessionStorage(): StorageLike {
  try {
    const probe = "pi-central.storage-probe";
    sessionStorage.setItem(probe, "1");
    sessionStorage.removeItem(probe);
    return sessionStorage;
  } catch {
    const memory = new Map<string, string>();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => void memory.set(key, value),
      removeItem: (key) => void memory.delete(key),
    };
  }
}

/** The prefix every protocol-skew message starts with — see `versionSkew` in `connection.ts`. */
export const SKEW_PREFIX = "protocol mismatch:";

/**
 * The same one-shot decision for a `hello` skew.
 *
 * The mark is the whole message: it names both versions, so the SAME skew seen after a reload
 * means the reload changed nothing — the page and the orchestrator genuinely disagree about the
 * wire version, and only restarting the older half can fix that. The banner says which half, from
 * the message's own numbers.
 */
export function assessProtocolSkew(message: string, storage: StorageLike): UpdateAction {
  if (storage.getItem(PROTOCOL_RELOAD_KEY) === message) {
    return {
      action: "banner",
      message:
        `${message} This window already reloaded once and the halves still disagree, so the fix is ` +
        `on the other side: update and restart the orchestrator, then reload. In an installed app, ` +
        `⌘Q and reopen is the reload that always works.`,
    };
  }
  storage.setItem(PROTOCOL_RELOAD_KEY, message);
  return { action: "reload" };
}

/**
 * Clear the skew mark when a snapshot proves the halves agree on the protocol.
 *
 * The skew mark cannot be cleared by a matching `hello` — the App never sees one; `connection.ts`
 * consumes it silently. The snapshot's `install.protocol` is the same fact in a visible place.
 * Clearing matters for the tab's NEXT update: without it, one survived skew would turn every
 * future skew in this tab into a banner with no reload attempt.
 */
export function noteProtocolAgreement(
  install: InstallFacts | undefined,
  pageProtocol: number,
  storage: StorageLike,
): void {
  if (install?.protocol === pageProtocol) storage.removeItem(PROTOCOL_RELOAD_KEY);
}
