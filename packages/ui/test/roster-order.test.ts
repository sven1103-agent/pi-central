/**
 * Order within a rail section is recency of ACTIVITY (asked for from use).
 *
 * ## The rule, and what it replaces
 *
 * A section's rows were ordered by the roster array alone, and `addToRoster` only ever prepended a NEW entry — so a
 * position meant "when this row was first added", not "when anything last happened to it". In the Idle section that is
 * the wrong question: *"which of these went quiet last?"* was answered by insertion order, which for an old roster is
 * close to arbitrary.
 *
 * The array is still the clock — **no timestamp is stored, and nothing needs migrating**. What changed is that a
 * position is now updated when a session's STATE changes, so the array is ordered by the last activity.
 *
 * ## The cost, and why it is narrowed rather than dropped
 *
 * #68 settled that positions must hold still, because a row that jumps while you aim at it is the original complaint.
 * So the rule is narrowed: a row moves only on a state change (start, settle, block, fail, stop) — never while
 * streaming, and never on a hint refresh. The GROUPS keep #68's stable attention order; only the order *within* a group
 * is recency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSession, LiveState } from "@pi-central/protocol";
import { initialState, reduce, type UiState } from "../src/store.ts";
import { groupRows, moveToFront, rosterRows, type RosterEntry } from "../src/roster.ts";

const entry = (name: string): RosterEntry => ({ path: `/s/${name}.jsonl`, name, cwd: `/x/${name}` });

function live(name: string, state: LiveState, id = `h-${name}`): LiveSession {
  return {
    id,
    name,
    cwd: `/x/${name}`,
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
    sessionFile: `/s/${name}.jsonl`,
  };
}

/** A store with `names` idled in the given order, so the roster order is the reverse (each add prepends). */
function withRoster(names: readonly string[]): UiState {
  let state = initialState();
  for (const name of names) {
    state = reduce(state, { kind: "remember", entry: entry(name) });
    state = reduce(state, { kind: "session", session: live(name, "idle") });
  }
  return state;
}

const sectionOrder = (state: UiState, group: string): string[] =>
  groupRows(rosterRows(state.roster, state.live))
    .find((section) => section.group === group)!
    .rows.map((row) => row.entry.name ?? "");

test("moveToFront moves an entry, and no-ops when it is first or absent", () => {
  const entries = [entry("c"), entry("b"), entry("a")];
  assert.deepEqual(moveToFront(entries, "/s/a.jsonl").map((e) => e.name), ["a", "c", "b"]);
  // Already first, or unknown: the SAME reference, so a caller cannot trigger a re-render for nothing.
  assert.equal(moveToFront(entries, "/s/c.jsonl"), entries);
  assert.equal(moveToFront(entries, "/s/nope.jsonl"), entries);
  // And the input is never mutated: the roster is React state.
  assert.deepEqual(entries.map((e) => e.name), ["c", "b", "a"]);
});

test("a new entry goes to the front, so a fresh session is the top of its section", () => {
  const state = withRoster(["alpha", "beta"]);
  assert.deepEqual(sectionOrder(state, "idle"), ["beta", "alpha"]);
});

test("a session that goes IDLE moves to the front of the idle section", () => {
  // The reported question: "which of these went quiet last?" — alpha was added first, so it used to sit at the bottom.
  let state = withRoster(["alpha", "beta", "gamma"]);
  assert.deepEqual(sectionOrder(state, "idle"), ["gamma", "beta", "alpha"], "insertion order, the old behaviour");

  state = reduce(state, { kind: "session", session: live("alpha", "streaming") });
  assert.deepEqual(sectionOrder(state, "running"), ["alpha"], "it entered running");

  state = reduce(state, { kind: "session", session: live("alpha", "idle") });
  assert.deepEqual(sectionOrder(state, "idle"), ["alpha", "gamma", "beta"], "and it is now the most recent in idle");
});

test("a session that starts RUNNING moves to the front of the running section", () => {
  // Asked for explicitly: users scan the running section too, so it needs the same recency.
  let state = withRoster(["alpha", "beta", "gamma"]);
  state = reduce(state, { kind: "session", session: live("alpha", "streaming") });
  state = reduce(state, { kind: "session", session: live("gamma", "streaming") });
  assert.deepEqual(sectionOrder(state, "running"), ["gamma", "alpha"], "most recently started is first");
});

test("a session that FAILS moves to the front of the failed section", () => {
  let state = withRoster(["alpha", "beta"]);
  state = reduce(state, { kind: "session", session: live("alpha", "failed") });
  state = reduce(state, { kind: "session", session: live("beta", "failed") });
  assert.deepEqual(sectionOrder(state, "failed"), ["beta", "alpha"]);
});

test("a refresh with NO state change does not reorder", () => {
  // `session` is broadcast on every patch, so a streaming session arrives here several times a second. Moving on those
  // would reorder the rail continuously and make rows impossible to click.
  let state = withRoster(["alpha", "beta", "gamma"]);
  state = reduce(state, { kind: "session", session: live("alpha", "streaming") });
  const order = sectionOrder(state, "running");
  for (let i = 0; i < 5; i += 1) {
    state = reduce(state, { kind: "session", session: live("alpha", "streaming") });
  }
  assert.deepEqual(sectionOrder(state, "running"), order, "five identical patches changed nothing");

  /*
   * The case that makes this test able to FAIL: a same-state patch for a row that is NOT already first in its section.
   *
   * The first version of this test only patched `alpha`, which sat first in `running` — so moving it to the front was a
   * no-op, and removing the state check left the test green. Found by falsifying it; this case is what it needed.
   */
  const idleBefore = sectionOrder(state, "idle");
  state = reduce(state, { kind: "session", session: live("beta", "idle") });
  assert.deepEqual(sectionOrder(state, "idle"), idleBefore, "beta was second in idle and stays second");
  // `remember` is the other frequent path — it must not move anything either.
  state = reduce(state, { kind: "remember", entry: entry("alpha") });
  assert.deepEqual(sectionOrder(state, "running"), order, "a hint refresh keeps the position");
});

test("the GROUPS keep their attention order, so only order WITHIN a section changed", () => {
  // #68's settled verdict is about the sections; this change is deliberately narrower than that.
  const state = withRoster(["alpha", "beta"]);
  const groups = groupRows(rosterRows(state.roster, state.live)).map((section) => section.group);
  assert.deepEqual(groups, ["idle"]);
  // And `needs` still precedes `running`, which precedes `idle`, whatever the roster order says.
  let mixed = withRoster(["alpha", "beta", "gamma"]);
  mixed = reduce(mixed, { kind: "session", session: live("gamma", "awaiting-approval") });
  mixed = reduce(mixed, { kind: "session", session: live("beta", "streaming") });
  assert.deepEqual(
    groupRows(rosterRows(mixed.roster, mixed.live)).map((s) => s.group),
    ["needs", "running", "idle"],
  );
});

test("a stopped row moves to the front of the stopped section too", () => {
  let state = withRoster(["alpha", "beta"]);
  state = reduce(state, { kind: "session", session: live("alpha", "stopped") });
  state = reduce(state, { kind: "session", session: live("beta", "stopped") });
  assert.deepEqual(sectionOrder(state, "stopped"), ["beta", "alpha"]);
});
