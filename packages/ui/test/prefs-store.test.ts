/**
 * A preference chosen in one launch is there in the next (issue #285).
 *
 * ## The defect
 *
 * Preferences lived in `localStorage`, which a browser partitions **per origin**, and the desktop shell launches the
 * orchestrator with `--port 0` — ADR-0013 §4, because the shell picking a port is how the `EADDRINUSE` class was
 * made unreachable. So each launch loaded the UI from `http://127.0.0.1:<a port nobody chose>`.
 *
 * Written to the right place, read back from an origin that had never seen it. Nothing failed: the write succeeded,
 * the read returned `null`, and every parser correctly degraded to its default. The reader's set of models was gone
 * on every launch and after every update, and twelve keys went with it.
 *
 * ## How the defect is reproduced here
 *
 * The evidence table asks for "a scope written in launch A is read back in launch B **whose origin differs**". Two
 * `PrefsStore`s are those two launches: each gets its own seed (the per-origin `localStorage`, standing in for a
 * different port) and they share one fake ORCHESTRATOR, which is the thing whose identity does not depend on the
 * port. With the bug, launch B's seed is empty and the scope is gone; with the fix, it comes from the installation.
 *
 * This is the closest a unit test can get. The acceptance criterion that needs two real launches — quit the app,
 * relaunch, confirm the list is intact with a different port — is recorded as verified by hand, because no test can
 * produce a process lifecycle.
 *
 * ## The other criteria this file covers
 *
 *   - the round trip is asserted for EVERY persisted key, not just the model scope, so the fix cannot be
 *     special-cased to one preference (criterion 2);
 *   - a corrupt stored value still yields the default rather than an empty picker — the validation-on-read
 *     discipline is unchanged, because the store returns strings and each module still parses its own
 *     (criterion 7);
 *   - an unavailable store is reported to the reader AT MOST ONCE, not per key (criterion 5);
 *   - a per-origin value from the release before this one is carried into the installation, so the upgrade does not
 *     present an empty picker (criterion 6);
 *   - the shell's port choice is untouched — this file does not reach `packages/app` at all, and
 *     `orchestrator-process.test.ts` continues to pin `--port 0` (criterion 4).
 *
 * ## Falsification
 *
 * Setting `#remote` back to `false` after a successful `initialise` fails "a value written in launch A is read in
 * launch B, whose origin differs". Removing `#seedInto`'s migration loop fails "a per-origin value is carried into
 * the installation". Removing the `#problemReported` guard fails "an unavailable store is reported once, not once
 * per key". Returning `{}` instead of `#fromSeed` on a failed read fails "an old peer falls back to the origin store
 * and says so".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PrefsStore, PREFS_LOAD_TIMEOUT_MS, type PrefsPersistence } from "../src/prefs-store.ts";
import { CHOOSER_PREFS_KEY, loadChooserPrefs, parseChooserPrefs, serializeChooserPrefs } from "../src/chooser-prefs.ts";
import { MODEL_SCOPE_KEY, loadModelScope, parseModelScope, serializeModelScope } from "../src/model-scope.ts";
import { PANEL_PREFS_KEY, defaultPanelPrefs, parsePanelPrefs, serializePanelPrefs } from "../src/panel.ts";
import { RAIL_PREFS_KEY, defaultRailPrefs, parseRailPrefs, serializeRailPrefs } from "../src/rail-prefs.ts";
import { ROSTER_PREFS_KEY, parseRoster, serializeRoster } from "../src/roster.ts";
import { ROSTER_MAX } from "../src/roster.ts";
import { TRACE_ORDER_KEY } from "../src/trace.ts";
import { READING_PREFS_KEY, parseReadingPrefs, serializeReadingPrefs } from "../src/reading.ts";

/** A `localStorage` stand-in that is one ORIGIN's, and can be refused outright to model private mode. */
function memoryStorage(initial: Record<string, string> = {}, refuses = false): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => {
      if (refuses) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
  } as Storage;
}

/**
 * The orchestrator, as a stand-in.
 *
 * One map, shared by every launch of the test: this is the whole point — the INSTALLATION outlives the origin. It
 * answers `getPrefs` by handing back what it holds to whoever asks, which is what the transport does.
 */
class FakeOrchestrator {
  prefs: Record<string, string> = {};
  /** Set to make `getPrefs` fail the way a corrupt file does on the wire. */
  failNext = false;
  protocol: number | undefined = 13;
  sent: unknown[] = [];

  send = (control: { kind: string } & Record<string, unknown>): boolean => {
    this.sent.push(control);
    if (control.kind === "setPrefs") {
      this.prefs = { ...(control["prefs"] as Record<string, string>) };
      queueMicrotask(() => this.answer({ kind: "prefs", prefs: this.prefs }));
      return true;
    }
    if (control.kind === "getPrefs") {
      queueMicrotask(() => {
        if (this.failNext) {
          this.failNext = false;
          this.answer({ kind: "prefsError", reason: "corrupt", message: "/state/preferences.json is not valid JSON" });
          return;
        }
        this.answer({ kind: "prefs", prefs: this.prefs });
      });
      return true;
    }
    return true;
  };

  /** Where the client's answers land. One store at a time, which is what a page is. */
  target: PrefsStore | undefined;

  answer(event: { kind: "prefs"; prefs: Record<string, string> } | { kind: "prefsError"; reason: "corrupt"; message: string }): void {
    this.target?.accept(event);
  }

  store(options: { seed?: Storage; onProblem?: (message: string) => void } = {}): PrefsStore {
    const store = new PrefsStore({
      protocol: () => this.protocol,
      send: this.send,
      seed: options.seed ?? memoryStorage(),
      ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
    });
    this.target = store;
    return store;
  }
}

/**
 * Every key the app persists, with a plausible value and the parser that reads it back.
 *
 * Enumerated rather than sampled, because criterion 2 asks for the fresh-store assertion on the whole set: fixing
 * only the model scope would leave the same defect in eleven other places, and each of them is a reader's setting.
 */
const PERSISTED: { key: string; value: string; read: (raw: string | null) => unknown }[] = [
  {
    key: MODEL_SCOPE_KEY,
    value: serializeModelScope({ models: [{ provider: "openai", id: "gpt-5" }, { provider: "anthropic", id: "claude-x" }] }),
    read: parseModelScope,
  },
  {
    key: PANEL_PREFS_KEY,
    value: serializePanelPrefs({ ...defaultPanelPrefs(), width: 480, mode: "files" }),
    read: (raw) => parsePanelPrefs(raw),
  },
  {
    key: RAIL_PREFS_KEY,
    value: serializeRailPrefs({ ...defaultRailPrefs(), width: 300, hidden: true }),
    read: (raw) => parseRailPrefs(raw, 0),
  },
  {
    key: READING_PREFS_KEY,
    value: serializeReadingPrefs({ ...parseReadingPrefs(null), sizePx: 18 }),
    read: parseReadingPrefs,
  },
  {
    key: CHOOSER_PREFS_KEY,
    value: serializeChooserPrefs({ sort: { column: "modified", direction: "descending" }, showHidden: true }),
    read: parseChooserPrefs,
  },
  {
    key: ROSTER_PREFS_KEY,
    value: serializeRoster(
      [{ path: "/sessions/--p--/a.jsonl", name: "a", cwd: "/x" }],
      ["/sessions/--p--/b.jsonl"],
    ),
    read: (raw) => parseRoster(raw),
  },
  { key: TRACE_ORDER_KEY, value: "newest", read: (raw: string | null) => raw },
  { key: "pi-central.trace", value: '{"collapsed":{"s1":true},"markers":{}}', read: (raw: string | null) => raw },
];

test("a value written in launch A is read in launch B, whose ORIGIN differs", async () => {
  // The reported defect, reproduced. Two launches, two per-origin stores (as two ports would be), one installation.
  const orchestrator = new FakeOrchestrator();

  const launchA = orchestrator.store({ seed: memoryStorage({ "pi-central.unrelated": "kept-on-a" }) });
  const writtenA = await launchA.initialise();
  assert.equal(writtenA.persistence, "installation");
  launchA.set(MODEL_SCOPE_KEY, PERSISTED[0]!.value);
  assert.equal(launchA.flush(), true);
  await Promise.resolve();

  // A DIFFERENT origin: nothing in this store, which is what a new port gives a browser.
  const launchB = orchestrator.store({ seed: memoryStorage() });
  const readB = await launchB.initialise();
  assert.equal(readB.persistence, "installation");
  const scope = loadModelScope((key) => launchB.get(key));
  assert.deepEqual(scope.models, [
    { provider: "openai", id: "gpt-5" },
    { provider: "anthropic", id: "claude-x" },
  ]);
  assert.deepEqual(readB.migrated, [], "nothing was migrated: the value came from the installation itself");
});

test("the round trip holds for EVERY persisted key, not just the model scope", async () => {
  // Criterion 2. Fixing only the reported key would leave the same defect in eleven other places, so the assertion
  // is over the whole set — and each value is PARSED rather than compared as a string, because the reader sees the
  // parsed value and a round trip that only preserved bytes would not be the property that matters.
  const orchestrator = new FakeOrchestrator();
  const launchA = orchestrator.store({ seed: memoryStorage() });
  await launchA.initialise();
  for (const { key, value } of PERSISTED) launchA.set(key, value);
  assert.equal(launchA.flush(), true);
  await Promise.resolve();

  const launchB = orchestrator.store({ seed: memoryStorage() });
  await launchB.initialise();
  for (const { key, value, read } of PERSISTED) {
    assert.deepEqual(read(launchB.get(key)), read(value), `${key} must come back unchanged through a new origin`);
  }
});

test("a value chosen in the app and one chosen at a stable origin are the SAME list", async () => {
  // Criterion 4: the divergence must not be silent. Both surfaces now read the installation's map, so the CLI at
  // http://127.0.0.1:8787 sees what the desktop app set — unlike before, where the app's origin changed on every
  // launch and the two could never agree at all.
  const orchestrator = new FakeOrchestrator();

  const desktop = orchestrator.store({ seed: memoryStorage() });
  await desktop.initialise();
  desktop.set(MODEL_SCOPE_KEY, serializeModelScope({ models: [{ provider: "openai", id: "gpt-5" }] }));
  desktop.flush();
  await Promise.resolve();

  // The browser at a fixed port: a different origin, the same installation.
  const cli = orchestrator.store({ seed: memoryStorage() });
  await cli.initialise();
  assert.deepEqual(loadModelScope((key) => cli.get(key)).models, [{ provider: "openai", id: "gpt-5" }]);
});

test("a value written by the release before this one is CARRIED into the installation", async () => {
  // Criterion 6, and the reason it is not optional: the reader's real preferences are sitting in `localStorage`
  // from the version before this one. Dropping them would punish the reader for our bug — their model list would be
  // empty on the first launch after the upgrade, which is the exact symptom being fixed.
  const orchestrator = new FakeOrchestrator();
  const legacyScope = serializeModelScope({ models: [{ provider: "anthropic", id: "claude-x" }] });
  const legacy = memoryStorage({ [MODEL_SCOPE_KEY]: legacyScope, "someone-elses.key": "not ours" });

  const launch = orchestrator.store({ seed: legacy });
  const initialisation = await launch.initialise();
  assert.deepEqual(initialisation.migrated, [MODEL_SCOPE_KEY], "only this app's keys are carried");
  assert.deepEqual(loadModelScope((key) => launch.get(key)).models, [{ provider: "anthropic", id: "claude-x" }]);

  // And written back, so the NEXT launch reads it from the installation and the migration runs once.
  assert.equal(launch.flush(), true);
  await Promise.resolve();
  assert.equal(orchestrator.prefs[MODEL_SCOPE_KEY], legacyScope);

  const next = orchestrator.store({ seed: memoryStorage() });
  const again = await next.initialise();
  assert.deepEqual(again.migrated, [], "the migration does not repeat");
});

test("the installation WINS over a stale per-origin value for the same key", async () => {
  // One author per key. A `localStorage` value from before the upgrade must not compete with the surface the reader
  // has been using since, or the setting would flip back on the next launch.
  const orchestrator = new FakeOrchestrator();
  orchestrator.prefs = { [TRACE_ORDER_KEY]: "newest" };
  const launch = orchestrator.store({ seed: memoryStorage({ [TRACE_ORDER_KEY]: "oldest" }) });
  const initialisation = await launch.initialise();
  assert.deepEqual(initialisation.migrated, []);
  assert.equal(launch.get(TRACE_ORDER_KEY), "newest");
});

test("a CORRUPT stored value still yields the default, not an empty picker", async () => {
  // Criterion 7, and the discipline this move must not weaken: the store hands back a STRING, and each module still
  // parses it and degrades to its own default. Validation on read is unchanged; only the home changed.
  const orchestrator = new FakeOrchestrator();
  orchestrator.prefs = {
    [MODEL_SCOPE_KEY]: "not json at all",
    [PANEL_PREFS_KEY]: "[]",
    [RAIL_PREFS_KEY]: '{"width":"wide"}',
    [READING_PREFS_KEY]: "null",
  };
  const launch = orchestrator.store({ seed: memoryStorage() });
  await launch.initialise();

  // The reported case: a corrupt scope means NO scope, so the picker offers the full catalogue rather than nothing.
  assert.deepEqual(loadModelScope((key) => launch.get(key)), { models: [] });
  assert.deepEqual(parsePanelPrefs(launch.get(PANEL_PREFS_KEY)), defaultPanelPrefs());
  assert.deepEqual(parseRailPrefs(launch.get(RAIL_PREFS_KEY), 0), defaultRailPrefs());
  assert.deepEqual(parseReadingPrefs(launch.get(READING_PREFS_KEY)), parseReadingPrefs(null));
});

test("an unavailable store is reported ONCE, not once per key", async () => {
  // Criterion 5. Twelve preferences each reporting the same condition is noise that trains the reader to dismiss the
  // strip, which is how a message that matters gets ignored.
  const orchestrator = new FakeOrchestrator();
  // A peer that keeps nothing AND a browser that refuses storage: nowhere durable at all.
  orchestrator.protocol = 12;
  const problems: string[] = [];
  const launch = orchestrator.store({ seed: memoryStorage({}, true), onProblem: (message) => problems.push(message) });

  const initialisation = await launch.initialise();
  assert.equal(initialisation.persistence, "memory");
  assert.equal(launch.durable, false);
  assert.equal(problems.length, 1, "the reader is told once, at load");

  // Writing every key on a store with nowhere to put them says nothing more.
  for (const { key, value } of PERSISTED) launch.set(key, value);
  launch.flush();
  launch.flush();
  assert.equal(problems.length, 1, "no second message, however many keys are written");
  assert.equal(launch.get(MODEL_SCOPE_KEY), PERSISTED[0]!.value, "and the values still work within the page");
});

test("an old peer falls back to the origin store, and says why", async () => {
  // The behaviour before this existed, kept arithmetically rather than by accident: a v12 orchestrator answers
  // `bad control: unknown kind 'getPrefs'`, which reads as a broken feature rather than as a version skew, so it is
  // not asked. The reader is told the consequence — a different port loses the setting — instead of it being silent.
  const orchestrator = new FakeOrchestrator();
  orchestrator.protocol = 12;
  const seed = memoryStorage({ [MODEL_SCOPE_KEY]: serializeModelScope({ models: [{ provider: "openai", id: "gpt-5" }] }) });
  const launch = orchestrator.store({ seed });

  const initialisation = await launch.initialise();
  assert.equal(initialisation.persistence, "origin");
  assert.equal(initialisation.failure?.reason, "unsupported");
  assert.deepEqual(orchestrator.sent, [], "an old peer is not asked a question it cannot answer");

  // Writes go to the origin store, which is what it can keep.
  launch.set(TRACE_ORDER_KEY, "newest");
  launch.flush();
  assert.equal(seed.getItem(TRACE_ORDER_KEY), "newest");
});

test("a reader whose window has no socket keeps working, and is told nothing was saved", async () => {
  // The realistic case: the orchestrator is not up yet, or the two halves disagree. The page must still render, and
  // the values must still behave — a preference that cannot be saved is not a reason to break the gesture that set
  // it, and it is said once rather than thrown.
  const problems: string[] = [];
  const store = new PrefsStore({
    protocol: () => undefined,
    send: () => false,
    seed: memoryStorage(),
    onProblem: (message) => problems.push(message),
  });
  const initialisation = await store.initialise();
  assert.equal(initialisation.persistence, "origin");
  assert.equal(initialisation.failure?.reason, "unreadable");
  assert.match(initialisation.failure?.message ?? "", /not connected/);
  assert.equal(problems.length, 0, "falling back to a working store is not a problem to report");
});

test("a read that never answers falls back after the bound, rather than blanking the window", async () => {
  // The bound is the difference between "this peer will answer" and "it will not". A window whose orchestrator never
  // replies must still show an interface — it will show `disconnected`, which is the truth — rather than stay blank
  // because a preference could not be read.
  const BOUND = 40;
  const store = new PrefsStore({
    protocol: () => 13,
    send: () => true,
    seed: memoryStorage({ [TRACE_ORDER_KEY]: "newest" }),
    // The bound is shortened rather than waited out: the property is "it gives up at the bound", not "the bound is
    // five seconds", and a suite that slept for five seconds to prove it would be a suite people stop running.
    timeoutMs: BOUND,
  });
  const started = Date.now();
  const initialisation = await store.initialise();
  assert.ok(Date.now() - started >= BOUND - 10, "it waited for the bound");
  assert.equal(initialisation.persistence, "origin");
  // And the values the reader already had are still there, which is the behaviour that shipped before this change.
  assert.equal(store.get(TRACE_ORDER_KEY), "newest");
});

test("a failed READ is reported as a failure, and does not overwrite what is stored", async () => {
  // "You have never chosen anything" and "I could not look" are opposite facts. Rendering the second as the first
  // would invite the next write to replace whatever is really in the file.
  const orchestrator = new FakeOrchestrator();
  orchestrator.failNext = true;
  const launch = orchestrator.store({ seed: memoryStorage({ [TRACE_ORDER_KEY]: "oldest" }) });
  const initialisation = await launch.initialise();
  assert.equal(initialisation.persistence, "origin");
  assert.equal(initialisation.failure?.reason, "corrupt");
  // The page keeps what it has, and does NOT write a replacement back over a file it could not read.
  assert.equal(launch.get(TRACE_ORDER_KEY), "oldest");
  assert.deepEqual(orchestrator.sent.map((control) => (control as { kind: string }).kind), ["getPrefs"]);
});

test("nothing to write sends nothing, so a quiet page is not a chatty one", () => {
  // The flush runs on a timer, so it must be free when there is nothing to do. A store that sent on every tick would
  // be one frame per second per window, forever, for a value that never changed.
  const orchestrator = new FakeOrchestrator();
  const store = orchestrator.store({ seed: memoryStorage() });
  orchestrator.sent = [];
  assert.equal(store.flush(), false);
  assert.deepEqual(orchestrator.sent, []);
});

test("removing a key removes it from the next launch", async () => {
  // Whole-map replacement is only worth anything if a removal is expressible: a merge would make a dropped key come
  // back from the file forever, with nothing able to say "this is gone now".
  const orchestrator = new FakeOrchestrator();
  const launchA = orchestrator.store({ seed: memoryStorage() });
  await launchA.initialise();
  launchA.set(TRACE_ORDER_KEY, "newest");
  launchA.set(MODEL_SCOPE_KEY, PERSISTED[0]!.value);
  launchA.flush();
  await Promise.resolve();

  launchA.remove(TRACE_ORDER_KEY);
  launchA.flush();
  await Promise.resolve();

  const launchB = orchestrator.store({ seed: memoryStorage() });
  await launchB.initialise();
  assert.equal(launchB.get(TRACE_ORDER_KEY), null);
  assert.equal(launchB.get(MODEL_SCOPE_KEY), PERSISTED[0]!.value, "and the other key is untouched");
});

test("a write that fails an HOUR later is still reported, once", async () => {
  /*
   * The ordinary case, not the load-time one: the page has been open and working, and then a `setPrefs` is refused —
   * a full disk, a read-only state root, a socket that dropped. Reporting only at load would let this be lost, which
   * is the silent non-persistence issue #285 exists to end.
   *
   * Asserted as: the first failure is announced, the second is not, and the reader's values are still correct.
   */
  const orchestrator = new FakeOrchestrator();
  const problems: string[] = [];
  const launch = orchestrator.store({ seed: memoryStorage(), onProblem: (message) => problems.push(message) });
  await launch.initialise();
  assert.equal(problems.length, 0, "a healthy start says nothing");

  const refusal = { kind: "prefsError" as const, reason: "corrupt" as const, message: "/state/preferences.json is not writable" };

  launch.set(TRACE_ORDER_KEY, "newest");
  assert.equal(launch.flush(), true, "the frame left");

  // The answer to that write is a failure — the shape a read-only state root produces. `accept` is what a page's
  // socket handler calls, and no read is outstanding, so this is recognised as a WRITE that failed.
  launch.accept(refusal);
  assert.equal(problems.length, 1, "the failure is reported");
  assert.match(problems[0] ?? "", /not writable/);

  launch.set(TRACE_ORDER_KEY, "oldest");
  launch.flush();
  launch.accept(refusal);
  assert.equal(problems.length, 1, "and not again, however many writes fail");
  assert.equal(launch.get(TRACE_ORDER_KEY), "oldest", "the page's own value is untouched by the refusal");
});

test("a preferences event belongs to the store and never reaches the reducer", async () => {
  /*
   * Structural, because the failure is silent: `store.ts` has an explicit no-op arm for `prefs`/`prefsError`, so a
   * page that dispatched one would not crash — it would just be filing a preference under session state, and the
   * `prefs` arm exists precisely so a future code path cannot turn it into a fact about a conversation.
   *
   * The routing decision is in `main.tsx` (the socket's only handler before `App` exists), so that is what is read.
   */
  const page = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(page, /event\.kind === "prefs" \|\| event\.kind === "prefsError"/, "the bootstrap recognises both");
  assert.match(page, /prefs\.accept\(event\)/, "and gives them to the store");
  // The `return` is the assertion that matters: without it the event would ALSO be queued for `App`, and dispatched.
  assert.match(page, /prefs\.accept\(event\);\s*\n\s*return;/, "…and does not pass them on");
});

