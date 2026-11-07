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
 * ## Returning to a window that was stale while it was hidden (issue #213)
 *
 * The one-shot reload above fires when a *snapshot* arrives. An installed window that was hidden or
 * minimised receives none while it is in the background — the socket is throttled, and the dock icon
 * focuses rather than reloads — so the reader comes back to a stale page and a banner that says
 * "quit and reopen". Two additions close that:
 *
 *   - `reloadOnReturn` reloads a page that comes back into view **with a stale verdict already
 *     recorded**, at most once per target identity. It is deliberately not "reload on focus": a
 *     focus event carries no evidence, and an unguarded reload-on-focus would destroy drafts on
 *     every tab switch.
 *   - `isReloadBlocked` reports whether reloading would throw away work the page holds — unsent text
 *     or attached images — because the page is the only copy of those. Session state is not at risk
 *     (it lives in the orchestrator, and a reconnect re-fetches every transcript); the composer is.
 *
 * Everything here is pure apart from the injected storage, so the decision is tested without a
 * browser.
 */
import type { InstallFacts } from "@pi-central/protocol";
import { supportsInstall } from "@pi-central/protocol";

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
        "new UI. A reload button is below; if the old version still appears after pressing it, quit " +
        "the app (⌘Q) and reopen it, and if that fails too, clear this site's data in the browser.",
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

/** One record of what a page returning to view did. */
export type ReturnAction = { action: "request"; control: { kind: "install" } } | { action: "none" };

/**
 * Should this page ask the orchestrator to re-state itself, because it just came back into view — and with
 * which control?
 *
 * ## Why this asks, instead of reloading
 *
 * The obvious implementation is "reload when the window is focused". It is wrong twice over:
 *
 *   1. A focus event carries **no evidence** that the page is stale, and an unguarded reload-on-focus
 *      would throw away drafts on every tab switch.
 *   2. Gating it on the recorded mark instead only moves the fault: the marks are written *before* the
 *      reload that a mark now permits, so a window that returns to the reverse-skew case #184 documents
 *      (a NEW page against an OLD orchestrator) would reload on every single focus, forever. The
 *      one-shot guard that stops the snapshot path looping does not stop this one, because here the
 *      decision is made by the page rather than by a fresh verdict.
 *
 * So a page that comes back into view **asks**, and the existing verdict machinery answers: the answer
 * re-runs `assessServedUi` and `assessProtocolSkew` with new evidence, and their own one-shot marks decide
 * whether that becomes a reload or a banner. There is exactly one place that decides to reload, and it is
 * the one that has always had the evidence for it.
 *
 * ## Why the question is `install` and not `list` (issue #220)
 *
 * `list` was the question, because a snapshot carries the installation facts. It also re-runs
 * `discover()` over the whole session store: **329 ms median per focus** on this machine, over 886
 * sessions, growing with the store — paid on every alt-tab, for history the verdict does not look at.
 * `install` states the same facts from one small file read and a cached package walk, so the answer is
 * identical and the cost is not.
 *
 * ## Why an old peer is not asked (issue #220)
 *
 * A refused control is an `error` event. This runs on every focus, so asking an orchestrator that predates
 * `install` would fill the error strip with one `bad control: unknown kind 'install'` per alt-tab, for a
 * page that is perfectly current. Silence is the right answer to a peer that cannot answer, which is what
 * `supportsInstall` decides — the same shape as `supportsPlaces`.
 */
export function recheckOnReturn(protocol: number | undefined): ReturnAction {
  if (!supportsInstall(protocol)) return { action: "none" };
  return { action: "request", control: { kind: "install" } };
}

/**
 * Is a reload right now the wrong thing to do?
 *
 * The page is the only copy of what the reader has typed or pasted: drafts are per-session React state
 * and attachments are in-memory base64 (megabytes, deliberately never persisted). A reload throws both
 * away, so a stale-page reload must wait for a composer that is empty rather than silently discarding
 * a paragraph someone was writing into a long-running agent.
 *
 * This is not a hypothetical: the `banner` path exists precisely because the reload was already spent
 * once, which is the state a reader is most likely to be typing in.
 */
export function isReloadBlocked(work: { draft: string; attachmentCount: number }): boolean {
  return work.draft.trim().length > 0 || work.attachmentCount > 0;
}

/** The sentence a blocked return shows. One place, so the banner and the notice cannot disagree. */
export const BLOCKED_RELOAD_MESSAGE =
  "Pi Central was updated while this window was in the background, but reloading now would discard " +
  "the message you are writing. Send or clear it and the new version will load itself.";

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
        `on the other side: update and restart the orchestrator, then press Reload. In an installed ` +
        `app, ⌘Q and reopen is the reload that always works.`,
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
