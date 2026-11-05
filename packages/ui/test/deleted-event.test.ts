/**
 * Deleting a transcript removes it everywhere (reported from use).
 *
 * > "Now when deleting a transcript, it is not removed from the rail and not the default entry app layout shown. This
 * > leads to users trying to trigger delete again and then this step fails, because the session file was indeed
 * > deleted."
 *
 * Two rendering faults, and the orchestrator was already doing its part:
 *
 *   1. The roster is `localStorage` and keeps its own list, so `history` + `snapshot` — which say what EXISTS — could
 *      not tell it what was REMOVED. A deleted session and one that merely scrolled out of the discovered page look
 *      identical. The rail kept a row whose file was gone, and a second Delete failed on it.
 *   2. `snapshot` fell back to `event.live[0]` when the focused id no longer resolved, so the reader landed on a
 *      different conversation instead of the placeholder.
 *
 * Both are the same rule the `forget` fix established: a choice the reader did not make must not put a session in front
 * of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSession } from "@pi-central/protocol";
import { focusedSession, initialState, reduce, type UiState } from "../src/store.ts";

const A = "/sessions/--p--/a.jsonl";
const B = "/sessions/--p--/b.jsonl";

function live(id: string, sessionFile: string): LiveSession {
  return {
    id,
    name: id,
    cwd: "/x",
    state: "idle",
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

/** A ready store with both files in the roster, focused on `focus`. */
function ready(focus: string | undefined): UiState {
  let state: UiState = {
    ...initialState(),
    live: [live("s1", A)],
    focusedId: focus,
    ready: true,
  };
  state = reduce(state, { kind: "remember", entry: { path: A, cwd: "/x", name: "a" } });
  state = reduce(state, { kind: "remember", entry: { path: B, cwd: "/x", name: "b" } });
  return state;
}

test("a deleted transcript drops its roster row", () => {
  // The rail kept the row because nothing told `localStorage` what was removed: `history` says what exists, and a
  // deleted session looks the same as one outside the discovered page.
  const state = reduce(ready(A), { kind: "deleted", path: B });
  assert.deepEqual(state.roster.map((entry) => entry.path), [A], "only the deleted row is gone");
});

test("deleting the FOCUSED stopped session clears the view", () => {
  // The row was addressed by path, which is the roster's key for a session with no process.
  let state = ready(B);
  state = reduce(state, { kind: "deleted", path: B });
  assert.equal(state.focusedId, undefined, "the placeholder, not another session");
});

test("deleting a row nobody is looking at does not move the reader", () => {
  const state = reduce(ready(A), { kind: "deleted", path: B });
  assert.equal(state.focusedId, A, "the focused session is untouched");
});

test("the snapshot after a delete does NOT re-focus another session", () => {
  // This is the second half of the report: the row went, and the reader was still not shown the placeholder, because
  // `snapshot` fell back to `live[0]` when the focused id no longer resolved.
  let state = ready(B);
  state = reduce(state, { kind: "deleted", path: B });
  state = reduce(state, { kind: "snapshot", live: [live("s1", A)], history: [], historyTotal: 0, home: "/x",
    installationRoot: undefined, install: undefined });
  assert.equal(state.focusedId, undefined, "the placeholder, not the first live session");
  assert.equal(focusedSession(state), undefined);
});

test("the FIRST snapshot still focuses a session, because the reader has expressed no intent", () => {
  // The fallback was not wrong in itself — it was wrong once something had been focused and then removed. A cold start
  // has nothing to preserve, and an empty column would be a worse arrival than a session.
  const state = reduce(initialState(), {
    kind: "snapshot",
    live: [live("s1", A)],
    history: [],
    historyTotal: 0,
    home: "/x",
    installationRoot: undefined,
    install: undefined,
  });
  assert.equal(state.focusedId, "s1", "the first live session");
});

test("a reconnect preserves the focus, and a stopped row's path still resolves", () => {
  // The snapshot also arrives on every reconnect. Focus must survive when it still names something — including a roster
  // path, which is how a stopped session is focused.
  let state = ready(B);
  state = reduce(state, { kind: "snapshot", live: [live("s1", A)], history: [], historyTotal: 0, home: "/x",
    installationRoot: undefined, install: undefined });
  assert.equal(state.focusedId, B, "a focused stopped row survives a reconnect");
});

test("the row does NOT come back, because the session is dropped from `live` too", () => {
  /*
   * Reported after the first fix: "When I stop a session and click delete, they are still in the roster."
   *
   * `App` re-remembers every live session on any change to `state.live` — correct, since a running session belongs in
   * the rail. But a STOPPED session is also in `state.live` (`stopped` is a state, not an absence, C3), so removing
   * the roster row alone left that effect to put it straight back on the next render.
   *
   * This simulates that effect, which is the part the earlier test could not see.
   */
  const rememberAll = (state: UiState): UiState =>
    state.live.reduce(
      (acc, session) => reduce(acc, { kind: "remember", entry: { path: session.sessionFile ?? "", cwd: session.cwd } }),
      state,
    );

  let state: UiState = { ...initialState(), live: [live("s1", A)], focusedId: "s1", ready: true };
  state = reduce(state, { kind: "remember", entry: { path: A, cwd: "/x" } });
  state = rememberAll(state);
  assert.equal(state.roster.length, 1, "the running session is in the rail");

  state = reduce(state, { kind: "deleted", path: A });
  assert.deepEqual(state.live, [], "and it leaves `live`, so the effect has nothing to re-add");
  state = rememberAll(state);
  assert.deepEqual(state.roster, [], "the row does not come back");
});
