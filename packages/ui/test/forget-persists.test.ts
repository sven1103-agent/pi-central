/**
 * A forgotten row stays forgotten (issue #204).
 *
 * ## The defect
 *
 * `forget` removed the roster entry and cleared focus, and nothing recorded that the reader had removed it. Two
 * paths then put the row straight back:
 *
 *   - `App` re-remembers every session in `state.live` on any change to it (`App.tsx:936-940`). A **stopped**
 *     session is still in `state.live` — `stopped` is a state, not an absence (C3) — so the very next `session`
 *     patch restored the row. In a fleet with one streaming session that is sub-second.
 *   - The persisted roster therefore never learned either, so a reload restored it as well.
 *
 * This is the same defect that was found and fixed for DELETE in `7575e8e` ("deleting is now forget-and-delete as
 * one act"), where a `deleted` event drops the session from `live` so the effect has nothing to re-add. `forget`
 * never got the equivalent, because forget is not supposed to be irreversible.
 *
 * ## The rule these tests pin
 *
 * A removed path does not come back through `remember`, a snapshot, or a reload — **unless the session is
 * genuinely running again**. Hiding live work is the one thing the rail must not do: `SessionRail.tsx` says
 * *"a hidden live session would be a session you cannot stop"*.
 *
 * ## The second round: the row and the entry are two different things (still #204)
 *
 * The fix above was applied to the reducer and the entry was removed correctly — `state.roster` was `[]` after a
 * forget — and the row STILL came back. Two remaining reasons, both of them downstream of the array these tests
 * originally asserted:
 *
 *   - `rosterRows` is the join the rail RENDERS, and its append loop re-adds every live session missing from the
 *     roster. A stopped session is in `live` (C3), so `state.roster === []` and a visible row were true at the same
 *     time. The removal now reaches the join.
 *   - `App` passed `isRunning(session)` as the "running again" flag, and `isRunning` is `state !== "stopped"` — which
 *     includes `failed`. So a forgotten FAILED row was re-added by the next broadcast while a stopped one stayed
 *     gone. That is the half that made the report intermittent. The flag is now `hasProcess`.
 *
 * Asserting `state.roster` was the mistake: it is the reducer's answer, not the reader's. The tests below assert
 * `railPaths`, which is exactly what `App` hands the rail.
 *
 * Falsification: reverting `remember` to unconditional re-add fails the first two tests; dropping the
 * `forgotten` list from `serializeRoster` fails the reload test; dropping the `removed` guard from `rosterRows`
 * fails only the rail test; passing `isRunning` instead of `hasProcess` fails only the failed-session test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSession } from "@pi-central/protocol";
import { initialState, reduce, type UiState } from "../src/store.ts";
import { FORGOTTEN_MAX, hasProcess, isRunning, parseRoster, rosterEntryFor, rosterRows, serializeRoster } from "../src/roster.ts";

const A = "/sessions/--p--/a.jsonl";
const B = "/sessions/--p--/b.jsonl";

function live(id: string, sessionFile: string, state: LiveSession["state"] = "idle"): LiveSession {
  return {
    id,
    name: id,
    cwd: "/x",
    state,
    mode: "sandboxed",
    isolation: "",
    command: "",
    scratch: false,
    messageCount: 1,
    pending: 0,
    contextPercent: null,
    tokensTotal: null,
    cost: null,
    dialogs: [],
    warnings: [],
    startedAt: 0,
    sessionFile,
  };
}

/** Exactly the effect in `App.tsx` that re-adds rows: re-remember every session in `live`, saying whether it runs. */
function rememberAll(state: UiState): UiState {
  return state.live.reduce((acc, session) => {
    const entry = rosterEntryFor(session);
    return entry === undefined ? acc : reduce(acc, { kind: "remember", entry, running: hasProcess(session) });
  }, state);
}

/** Exactly what `App` hands the rail: the persisted roster, `live`, and the removals it must respect. */
function railPaths(state: UiState): string[] {
  return rosterRows(state.roster, state.live, state.forgotten).map((row) => row.entry.path);
}

test("a forgotten STOPPED session is not re-added by the re-remember effect", () => {
  let state: UiState = { ...initialState(), live: [live("s1", A, "stopped")] };
  state = rememberAll(state);
  assert.deepEqual(state.roster.map((e) => e.path), [A], "the stopped session starts in the rail");

  state = reduce(state, { kind: "forget", path: A });
  assert.deepEqual(state.roster, [], "forget removes the row");

  // Any later broadcast — a snapshot, a `session` patch, a reconnect.
  state = rememberAll(state);
  assert.deepEqual(state.roster, [], "and the row does not come back");
});

test("an UNRELATED session's patch does not resurrect a forgotten row", () => {
  // The reported symptom in a live fleet: session B streams, its `session` patch lands, and A — which the reader
  // removed — is back before they can blink.
  let state: UiState = { ...initialState(), live: [live("s1", A, "stopped"), live("s2", B, "idle")] };
  state = rememberAll(state);
  state = reduce(state, { kind: "forget", path: A });

  state = reduce(state, { kind: "session", session: live("s2", B, "streaming") });
  state = rememberAll(state);
  assert.deepEqual(state.roster.map((e) => e.path), [B], "only the session nobody removed is in the rail");
});

test("a forgotten row survives a reload, because the removal is persisted with the roster", () => {
  let state: UiState = { ...initialState(), live: [live("s1", A, "stopped")] };
  state = rememberAll(state);
  state = reduce(state, { kind: "forget", path: A });

  // What the single writer in `App` puts in `localStorage`, then reads back on mount.
  const stored = serializeRoster(state.roster, state.forgotten);
  let reloaded: UiState = {
    ...initialState(),
    live: [live("s1", A, "stopped")],
  };
  const restored = parseRoster(stored);
  reloaded = reduce(reloaded, { kind: "loadRoster", entries: restored.entries, forgotten: restored.forgotten });
  reloaded = rememberAll(reloaded);

  assert.deepEqual(reloaded.forgotten, [A], "the removal is remembered");
  assert.deepEqual(reloaded.roster, [], "so the reloaded rail does not show the row again");
});

test("a forgotten session that is genuinely RUNNING again comes back", () => {
  // The one thing the rail must not do is hide live work — `SessionRail.tsx`: "a hidden live session would be a
  // session you cannot stop". Resuming (or the #185 auto-reopen) is a real transition, not a stale broadcast, so
  // the removal is spent.
  let state: UiState = { ...initialState(), live: [live("s1", A, "stopped")] };
  state = rememberAll(state);
  state = reduce(state, { kind: "forget", path: A });
  assert.deepEqual(state.roster, []);

  // The reader resumes it: the supervisor re-broadcasts the same file with a live state.
  state = reduce(state, { kind: "session", session: live("s1", A, "idle") });
  state = rememberAll(state);

  assert.deepEqual(state.roster.map((e) => e.path), [A], "running again, so it is in the rail again");
  assert.deepEqual(state.forgotten, [], "and the removal is spent rather than left to fire later");
});

test("a forgotten session that is still STOPPED does not come back through a snapshot", () => {
  // `stopped` is a state, not an absence (C3), so a reconnect's snapshot re-describes it and must not be treated
  // as "running again". This is the case that distinguishes the two transitions above.
  let state: UiState = { ...initialState(), live: [live("s1", A, "stopped")], ready: true };
  state = rememberAll(state);
  state = reduce(state, { kind: "forget", path: A });

  state = reduce(state, {
    kind: "snapshot",
    live: [live("s1", A, "stopped")],
    history: [],
    historyTotal: 0,
    home: "/x",
    installationRoot: undefined,
    install: undefined,
  });
  state = rememberAll(state);

  assert.deepEqual(state.roster, [], "a stopped session re-described by a snapshot is still forgotten");
  assert.deepEqual(state.forgotten, [A]);
});

test("the RAIL shows no row for a forgotten stopped session", () => {
  // The reported symptom, and the half the earlier tests could not see: they asserted `state.roster`, which WAS empty,
  // while the rail still drew the row. `rosterRows` is the join the rail renders, and its append loop re-adds every
  // live session missing from the roster — a stopped session is in `live` (C3) — so the removal has to reach it too.
  //
  // Falsification: dropping the `removed` guard from `rosterRows` leaves `state.roster` empty and this test failing.
  let state: UiState = { ...initialState(), live: [live("s1", A, "stopped")] };
  state = rememberAll(state);
  assert.deepEqual(railPaths(state), [A], "the stopped session starts in the rail");

  state = reduce(state, { kind: "forget", path: A });
  assert.deepEqual(state.roster, [], "the reducer removed the entry");
  assert.deepEqual(railPaths(state), [], "and the rail draws no row for it, which is what the reader sees");

  // …and it stays gone through the re-remember effect the next broadcast triggers.
  state = rememberAll(state);
  assert.deepEqual(railPaths(state), []);
});

test("a forgotten FAILED session is not resurrected by the re-remember effect", () => {
  // The intermittent half of the report. `App` passed `isRunning(session)` as the "running again" flag, and
  // `isRunning` is `state !== "stopped"` — so a FAILED session counted as running again, spent the removal, and the
  // row returned on the next broadcast. A stopped session stayed gone; a failed one came back, which is why the bug
  // looked intermittent. The question this flag answers is "is there a PROCESS whose row must not be hidden", and a
  // failed session has none.
  //
  // Falsification: passing `isRunning` instead of `hasProcess` in `rememberAll` fails this test and nothing else.
  let state: UiState = { ...initialState(), live: [live("s1", A, "failed")] };
  state = rememberAll(state);
  state = reduce(state, { kind: "forget", path: A });
  state = rememberAll(state);

  assert.deepEqual(state.forgotten, [A], "the removal is still recorded");
  assert.deepEqual(railPaths(state), [], "and a failed session does not put the row back");
});

test("a forgotten session that is genuinely running again is shown by the rail", () => {
  // The other side of the same predicate: a session with a PROCESS must never be hidden, because a hidden live
  // session is one the reader cannot stop. This is what keeps `hasProcess` from being "just exclude everything".
  let state: UiState = { ...initialState(), live: [live("s1", A, "stopped")] };
  state = rememberAll(state);
  state = reduce(state, { kind: "forget", path: A });

  // The reader resumes it: the supervisor re-broadcasts the same file, now streaming.
  state = reduce(state, { kind: "session", session: live("s1", A, "streaming") });
  state = rememberAll(state);

  assert.deepEqual(state.forgotten, [], "the removal is spent");
  assert.deepEqual(railPaths(state), [A], "so the row is back, and visible");
});

test("a forgotten path does not suppress a DIFFERENT session in the same directory", () => {
  // The removal is keyed by session FILE, and the check must be the same key — an index- or directory-based match
  // would quietly hide a neighbour, which is the sort of bug the reader would report as "the rail eats sessions".
  const rows = rosterRows([{ path: B }], [live("s2", B, "idle")], [A]);
  assert.deepEqual(rows.map((row) => row.entry.path), [B]);
});

test("the removal list is bounded, like the roster, so a corrupt store cannot grow it forever", () => {
  // Same reasoning as `ROSTER_MAX`: this value outlives upgrades and is shared with whatever else runs on the
  // origin. A cap that a hostile value cannot exceed is the difference between a filter and a memory leak.
  const many = Array.from({ length: FORGOTTEN_MAX + 100 }, (_, i) => `/sessions/--p--/f${i}.jsonl`);
  const restored = parseRoster(JSON.stringify({ entries: [], forgotten: many }));
  assert.equal(restored.forgotten.length, FORGOTTEN_MAX, "a stored value past the cap is truncated, not trusted");
});

test("a bare array still parses, so an older stored roster is not thrown away", () => {
  // `serializeRoster` wrote a bare array before this change. A parser that only understood the object form would
  // silently empty the rail of everyone who upgrades — the failure mode `roster.ts` is shaped to prevent.
  const restored = parseRoster(JSON.stringify([{ path: A, cwd: "/x" }]));
  assert.deepEqual(restored.entries.map((e) => e.path), [A]);
  assert.deepEqual(restored.forgotten, []);
});

// --- The WIRING, not only the rule ----------------------------------------------------------------
//
// Everything above verifies the rule through `rememberAll`/`railPaths`, which are MIRRORS of what `App` does. That is a
// real gap: the defect being fixed was never the rule, it was `App` handing the rail the wrong arguments — a `rosterRows`
// call without the removal list, and `isRunning` where `hasProcess` was meant. A mirror cannot see a wrong call site.
//
// The component tests render to static HTML and execute no effects, so `App` cannot be driven here. What CAN be
// asserted is the source, and that is honest: these two expressions are the whole wiring, and both have been wrong.

test("App passes the removal list to the join, and hasProcess to the re-remember effect", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "");

  assert.match(
    app,
    /rosterRows\(state\.roster,\s*state\.live,\s*state\.forgotten\)/,
    "the rail's join must receive `forgotten` — without it the append loop re-adds a stopped session",
  );
  assert.match(
    app,
    /dispatch\(\{\s*kind:\s*"remember",\s*entry,\s*running:\s*hasProcess\(session\)\s*\}\)/,
    "the re-remember effect must ask `hasProcess` — `isRunning` includes `failed` and spent the removal on it",
  );
  // And the wrong predicate must be gone entirely, not merely unused in one place: a second `isRunning(session)` in this
  // file is the bug coming back somewhere else.
  assert.ok(!/isRunning\(session\)/.test(app), "no `isRunning(session)` anywhere in App");
});
