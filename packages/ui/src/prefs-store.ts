/**
 * The reader's preferences, held by the installation instead of by a browser origin (issue #285).
 *
 * ## Why this exists
 *
 * Every preference in this app lived in `localStorage`, which a browser partitions **per origin**. The desktop shell
 * launches the orchestrator with `--port 0` — ADR-0013 §4, and not negotiable, because the shell picking a port is
 * how the `EADDRINUSE` class was made unreachable — so each launch loads the UI from
 * `http://127.0.0.1:<a port nobody chose>`.
 *
 * The write succeeded. The read returned `null`. Every parser correctly degraded to its default. So the reader's set
 * of models, their roster, their rail width and their transcript measure were all lost on every launch and after
 * every update, with nothing failing anywhere to say so.
 *
 * ## The shape of the fix
 *
 * A `PrefsStore` is the ONE place a preference is read from and written to. Callers stay synchronous and local: the
 * store holds a Map, so `get`/`set` never await, and persistence happens behind them.
 *
 * That split is what makes the change safe to land in one slice. `App`'s React state for a preference is still React
 * state; what changed is that it is seeded from the store rather than from `localStorage`, and that the same
 * `setItem`-shaped call now reaches the installation.
 *
 * ## Three homes, and the rule that picks between them
 *
 * `initialise()` decides, ONCE per page:
 *
 *   1. the INSTALLATION, when the orchestrator answers `prefs` (issue #285). Preferences then follow the
 *      installation: they survive a restart, an update and a port change.
 *   2. `localStorage`, when the peer is too old to have the feature (`supportsPrefs` false). This is the behaviour
 *      before this existed, kept deliberately rather than by accident — an old orchestrator must not be handed a
 *      store it cannot keep.
 *   3. `localStorage` again, when the installation did not answer. The reader's values are already there from the
 *      release before this one, so nothing is lost while they restart the app.
 *
 * Within either real home, a key the INSTALLATION holds wins, and a key only the old per-origin store holds is
 * carried over and written back — because those are the reader's real preferences from the version before this one,
 * and dropping them would punish the reader for our bug: their model list would be empty on the first launch after
 * the upgrade, which is the exact symptom being fixed.
 *
 * ## A store that cannot persist says so, ONCE
 *
 * Two ways to have nowhere durable to write, and they are different facts:
 *
 *   - `memory` — no installation store (an old peer, or no answer) AND `localStorage` refuses. Private mode and a
 *     full quota both throw. The feature works within the page and is forgotten when it closes: a smaller promise,
 *     honestly kept, and stated rather than silent.
 *   - a WRITE that fails against either real home — usually a full disk or a read-only state root.
 *
 * Either way the reader is told once, not once per key. Twelve preferences each reporting the same condition is
 * noise that trains the reader to dismiss the strip, which is how a message that matters gets ignored.
 *
 * ## Why `get` returns `string | null` and not a parsed value
 *
 * The same reason `PrefsReader` in `chooser-prefs.ts` does: each preference's validation belongs with the module that
 * understands it (`model-scope.ts` knows what a model reference is, and that a corrupt one must mean "no scope"
 * rather than "an empty picker"). A store that parsed would need to know twelve formats, and would become the second
 * place each format is decided — the drift `parseRoster`/`serializeRoster` are kept adjacent to avoid.
 */
import { supportsPrefs, type Control, type PrefsErrorReason } from "@pi-central/protocol";
import { safeLocalStorage } from "./chooser-prefs.ts";

/**
 * How long a page waits for the installation's answer before deciding from what it already has.
 *
 * A LOCAL socket answered by the same machine: the round trip is microseconds. Five seconds is not a performance
 * budget, it is the difference between "this peer will answer" and "it will not" — a socket that connected and then
 * refused the control (an older peer answers `bad control`), or one that is not open yet.
 *
 * Waiting matters more than it looks. The alternative is to start from `localStorage`, paint the reader's values,
 * and SWAP them when the answer arrives — a visible jump in the rail's width and the transcript's measure at every
 * launch, for a value that never changed.
 */
export const PREFS_LOAD_TIMEOUT_MS = 5000;

/** Where a store keeps its values, which is also what it can promise. */
export type PrefsPersistence =
  /** The orchestrator holds them: they survive a restart, an update and a port change (issue #285). */
  | "installation"
  /** `localStorage`: they survive a restart of this window, but belong to one origin. A peer that predates #285. */
  | "origin"
  /** Nowhere but this page: private mode, a full quota, or both sources refusing. */
  | "memory";

/** The prefix every preference key shares, so this app's keys are recognisable in a store it shares. */
const KEY_PREFIX = "pi-central.";

/** The probe key. Outside `pi-central.` on purpose: a migration must never read it as a preference. */
const PROBE_KEY = "pi-central-prefs-probe";

/** What a store answers after asking the orchestrator. */
/**
 * A read that did not produce the installation's map.
 *
 * A named type rather than an inline shape because it travels through the initialisation promise's rejection, and a
 * `catch` binds `unknown` — so the shape needs somewhere to be asserted once rather than at every use.
 */
export interface PrefsProblem {
  reason: PrefsErrorReason;
  message: string;
}

export interface PrefsInitialisation {
  persistence: PrefsPersistence;
  /** True when the installation answered, so a write goes there rather than to `localStorage`. */
  remote: boolean;
  /** Why a read did not produce the installation's map. Absent when it did, including when the map was empty. */
  failure?: PrefsProblem | undefined;
  /** Keys carried over from the old per-origin store, so a caller can say what the upgrade preserved. */
  migrated: string[];
}

/** What the store needs from the outside world, so a test can supply all of it. */
export interface PrefsStoreOptions {
  /** The current peer's protocol version, or `undefined` before the handshake reports it. */
  protocol: () => number | undefined;
  /** Send a control over the socket. False when there is no socket to send it on. */
  send: (control: Control) => boolean;
  /** The old per-origin store. Injected so a test never touches a real one. */
  seed?: Storage;
  /** Where to say that preferences cannot be kept. Called at most once. */
  onProblem?: (message: string) => void;
  /**
   * How long to wait for the installation's answer. Defaults to {@link PREFS_LOAD_TIMEOUT_MS}.
   *
   * Injectable for the same reason the seed is: the only way to test "it gave up after the bound, rather than
   * blanking the window" without making every suite wait five seconds.
   */
  timeoutMs?: number;
}

interface Pending {
  resolve: (prefs: Record<string, string>) => void;
  reject: (problem: PrefsProblem) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PrefsStore {
  #options: PrefsStoreOptions;
  #seed: Storage | undefined;
  #seedDurable: boolean | undefined;
  /** What this page holds. The single source of truth for a synchronous `get`. */
  #values = new Map<string, string>();
  /** True once the installation's map is what `#values` was seeded from, so a write belongs there. */
  #remote = false;
  #persistence: PrefsPersistence = "memory";
  #pending: Pending | undefined;
  /** Whether the "cannot persist" message has been said. Never re-armed: the page's environment does not change. */
  #problemReported = false;
  #dirty = false;

  constructor(options: PrefsStoreOptions) {
    this.#options = options;
    // Its own instance rather than a shared one: the store writes through THIS object, so a test's injected seed
    // must be the object that receives the writes.
    this.#seed = options.seed ?? safeLocalStorage();
  }

  /** Where the values actually live, for a surface that needs to say so. */
  get persistence(): PrefsPersistence {
    return this.#persistence;
  }

  /** True when a real store — installation or origin — is behind this page. */
  get durable(): boolean {
    return this.#persistence !== "memory";
  }

  /** Every key this page holds a value for. */
  keys(): string[] {
    return [...this.#values.keys()].sort();
  }

  /** A stored value, or `null`. Never throws: a caller parses what it gets and degrades on its own terms. */
  get(key: string): string | null {
    const value = this.#values.get(key);
    if (value !== undefined) return value;
    /*
     * Not held yet. The old per-origin store is still the honest answer for a key the installation has no opinion
     * about — one written by an older release that this build has not migrated because nothing has asked for it yet —
     * and reading it here cannot disagree with anything, because nothing has written to it since the page loaded.
     */
    try {
      return this.#seed?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  /** Whether any source has a value for this key. */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Store a value.
   *
   * ## Why this does not throw, and why it is synchronous
   *
   * Callers are a dozen event handlers — a drag ending, a picker's change, a fold. Every one was written against
   * `localStorage.setItem`, which is synchronous and throws. Keeping that shape makes this change a substitution
   * rather than a rewrite of every call site, and a preference that cannot be saved must still not break the gesture
   * that set it.
   *
   * A failure is therefore recorded and reported by {@link flush}, rather than raised here.
   */
  set(key: string, value: string): void {
    if (this.#values.get(key) === value) return;
    this.#values.set(key, value);
    this.#dirty = true;
  }

  /** Forget a key. Whole-map replacement needs a way to express a removal, so the write can say "gone". */
  remove(key: string): void {
    if (!this.#values.delete(key)) return;
    this.#dirty = true;
  }
  /**
   * Ask the orchestrator for the installation's map, and seed this page from it.
   *
   * Resolves rather than rejects in every outcome, because there is always a usable answer: the page can start from
   * `localStorage` and say why. Callers get the reason in `failure`.
   *
   * Must run before the first read of any preference. `App` calls it once and seeds its React state afterwards, so
   * no initialiser can see a half-filled store.
   */
  async initialise(): Promise<PrefsInitialisation> {
    /*
     * A peer that cannot keep them is not asked.
     *
     * This is the whole reason `supportsPrefs` exists: against a v12 orchestrator, `getPrefs` answers
     * `bad control: unknown kind 'getPrefs'` — a symptom, not a version skew — and the values would then be stored
     * per origin, silently, which is the defect itself.
     */
    const protocol = this.#options.protocol();
    if (protocol !== undefined && !supportsPrefs(protocol)) {
      return this.#fromSeed({
        reason: "unsupported",
        message:
          "this orchestrator keeps no preferences (it speaks v" + protocol + "), so they are remembered per " +
          "browser origin and will be lost when the app loads from a different port. Update Pi Central to " +
          "change that.",
      });
    }

    let remote: Record<string, string>;
    try {
      remote = await this.#request({ kind: "getPrefs" });
    } catch (problem) {
      /*
       * No answer: the socket was not open yet, or the reply never came.
       *
       * The store does NOT retry on its own. A second attempt would have to decide whether it may overwrite values
       * the reader has changed since the first — a merge question this design exists to avoid. So the page keeps
       * `localStorage`'s values, which is exactly what shipped before this change, and the next launch tries again.
       */
      return this.#fromSeed(problem as PrefsProblem);
    }

    this.#remote = true;
    this.#persistence = "installation";
    const migrated = this.#seedInto(remote);
    return { persistence: "installation", remote: true, migrated };
  }

  /**
   * Turn whatever has been written since the last flush into one write, and report a failure once.
   *
   * Called on a timer rather than per `set`: a preference is often written in a burst (the roster writes whenever a
   * broadcast changes it, a measure slider writes on every step), and batching turns a drag into one round trip
   * instead of forty.
   *
   * Returns `true` when the values reached their store, so a caller — and a test — can tell "nothing to do" from
   * "written" from "refused".
   */
  flush(): boolean {
    if (!this.#dirty) return false;
    this.#dirty = false;

    if (!this.#remote) {
      /*
       * `localStorage` is the destination, per key, exactly as before issue #285 — written through the SEED object
       * rather than through a fresh `safeLocalStorage`, so an injected store in a test is the one that receives them.
       */
      try {
        for (const [key, value] of this.#values) this.#seed?.setItem(key, value);
        return true;
      } catch (error) {
        this.#report(
          "Pi Central cannot remember your preferences, so they will be lost when this window closes (" +
            (error as Error).message +
            ").",
        );
        return false;
      }
    }

    /*
     * The dirty flag is cleared whether or not `send` succeeds, and a refused send is REPORTED rather than retried.
     *
     * A write that never left cannot be completed by trying again later — the socket it would use is the one that
     * was closed — and the honest state is "not saved", said once. The answer to a dropped socket is a reconnect,
     * which re-asks for the map and therefore cannot resurrect a value the reader has since changed.
     */
    if (!this.#options.send({ kind: "setPrefs", prefs: this.#map() })) {
      this.#report("Pi Central is not connected, so your preferences were not saved.");
      return false;
    }
    return true;
  }

  /**
   * Take an answer from the orchestrator.
   *
   * Called from `App`'s socket handler for both `prefs` and `prefsError`, because both answer a question this store
   * asked. Always returns `true`: an answer belongs to this store, never to the reducer, and a caller that dispatched
   * it would be filing a preference under session state.
   */
  accept(
    event:
      | { kind: "prefs"; prefs: Record<string, string> }
      | { kind: "prefsError"; reason: PrefsErrorReason; message: string },
  ): boolean {
    if (event.kind === "prefs") {
      /*
       * An answer to a read still in flight is handed to `initialise`, which does the seeding.
       *
       * Seeding HERE as well would be the same work done twice, and the second pass would see the values the first
       * one had already put in place and report the migration as empty — so a caller would be told nothing was
       * carried over while it silently had been. One reader, one seeding.
       */
      if (this.#pending !== undefined) {
        this.#settle(event.prefs);
        return true;
      }
      this.#remote = true;
      this.#persistence = "installation";
      this.#seedInto(event.prefs);
      return true;
    }
    /*
     * A failed WRITE leaves the page's values alone and says so; a failed READ — which arrives while an answer is
     * still pending — is what the initialisation promise must hear.
     *
     * They are told apart by whether this store is still waiting, not by a field on the event: the orchestrator
     * cannot know which question a client is waiting for, and inventing a field for it would put this store's
     * bookkeeping on the wire.
     */
    if (this.#pending !== undefined) {
      this.#settleFailure(event);
      return true;
    }
    this.#report(event.message);
    return true;
  }

  // --- internals ---------------------------------------------------------------------------------

  /** Send one control and wait for its answer, or reject with the reason it did not come. */
  #request(control: Control): Promise<Record<string, string>> {
    return new Promise<Record<string, string>>((resolve, reject) => {
      const timeoutMs = this.#options.timeoutMs ?? PREFS_LOAD_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.#pending = undefined;
        reject({ reason: "unreadable", message: "the orchestrator did not answer within " + timeoutMs + "ms" });
      }, timeoutMs);
      this.#pending = { resolve, reject, timer };
      if (this.#options.send(control)) return;
      // Not connected. Rejected now rather than after the timeout, because the frame cannot be sent at all.
      clearTimeout(timer);
      this.#pending = undefined;
      reject({ reason: "unreadable", message: "not connected to the orchestrator" });
    });
  }

  #settle(prefs: Record<string, string>): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(prefs);
  }

  #settleFailure(problem: PrefsProblem): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(problem);
  }

  /**
   * Seed from the installation's map, carrying over anything it does not hold but the old store does.
   *
   * The installation wins for a key it holds — even an empty string — because it is the surface the reader has been
   * using since the upgrade, so a per-origin value from before it is a stale competitor. That is the same rule the
   * write path follows: one author per key.
   */
  #seedInto(remote: Record<string, string>): string[] {
    for (const [key, value] of Object.entries(remote)) this.#values.set(key, value);

    const migrated: string[] = [];
    for (const key of this.#seedKeys()) {
      if (remote[key] !== undefined || this.#values.has(key)) continue;
      let value: string | null;
      try {
        value = this.#seed?.getItem(key) ?? null;
      } catch {
        continue;
      }
      if (value === null) continue;
      this.#values.set(key, value);
      migrated.push(key);
    }
    // A carried-over value is not yet in the installation, so it is a pending WRITE — set here rather than by each
    // caller, because a caller that forgot would leave the migration in memory only and repeat it on every launch.
    if (migrated.length > 0) this.#dirty = true;
    return migrated;
  }

  /**
   * Every key the old store holds that belongs to this app.
   *
   * `length`/`key()` rather than a fixed list: the set of keys is the app's business, so a list here would be a
   * second copy that goes stale the moment a preference is added. Scoped by `pi-central.` so a key written by
   * something else on a shared origin is never carried into the installation's file.
   */
  #seedKeys(): string[] {
    const seed = this.#seed;
    if (seed === undefined) return [];
    const keys: string[] = [];
    try {
      for (let index = 0; index < seed.length; index += 1) {
        const key = seed.key(index);
        if (key !== null && key.startsWith(KEY_PREFIX)) keys.push(key);
      }
    } catch {
      return [];
    }
    return keys;
  }

  /** The whole map, sorted so the file's bytes do not churn with insertion order. */
  #map(): Record<string, string> {
    return Object.fromEntries(
      [...this.#values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }

  /** No installation store: start from the old one, and say what that costs when it cannot hold anything either. */
  #fromSeed(failure: PrefsProblem): PrefsInitialisation {
    this.#remote = false;
    this.#persistence = this.#seedHoldsValues() ? "origin" : "memory";

    const migrated: string[] = [];
    for (const key of this.#seedKeys()) {
      try {
        const value = this.#seed?.getItem(key) ?? null;
        if (value === null) continue;
        this.#values.set(key, value);
        migrated.push(key);
      } catch {
        // Nothing usable from this source; the caller's defaults apply.
      }
    }
    if (this.#persistence === "memory") {
      /*
       * Said HERE rather than on the first failed write: the reader is about to arrange an app whose settings will
       * vanish when it closes, and knowing that beforehand is worth more than learning it after ten minutes of work.
       */
      this.#report(
        "Pi Central cannot remember your preferences: no store is available in this window, so settings are kept " +
          "only until it closes.",
      );
    }
    return { persistence: this.#persistence, remote: false, failure, migrated };
  }

  /**
   * Whether `localStorage` will actually hold a value.
   *
   * Measured with a probe key and REMEMBERED, because the real check is a write — doing it per call would add a
   * write to every preference read. The probe is removed immediately and named outside `pi-central.`, so it is
   * neither a key this app appears to hold a value for nor something a migration could mistake for a preference.
   */
  #seedHoldsValues(): boolean {
    if (this.#seedDurable !== undefined) return this.#seedDurable;
    const seed = this.#seed;
    if (seed === undefined) {
      this.#seedDurable = false;
      return false;
    }
    try {
      seed.setItem(PROBE_KEY, "1");
      seed.removeItem(PROBE_KEY);
      this.#seedDurable = true;
    } catch {
      this.#seedDurable = false;
    }
    return this.#seedDurable;
  }

  /**
   * Say that preferences cannot be kept — once.
   *
   * Once per page is the requirement, not once per key: twelve preferences each reporting one condition is a strip
   * the reader learns to dismiss. It is not re-armed by a later success, because the environment that caused it has
   * not changed; only a new page can tell a new story.
   */
  #report(message: string): void {
    if (this.#problemReported) return;
    this.#problemReported = true;
    this.#options.onProblem?.(message);
  }
}
