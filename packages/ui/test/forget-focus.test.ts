/**
 * Forgetting a session moves the view off it (reported from use).
 *
 * > "When a user removes a session from the roster, it is still open in the active session pannel. I think this should
 * > default into the empty screen placeholder on startup, that users shall open a new session or resume an existing one"
 *
 * The reducer removed the roster entry and left `focusedId` alone, so the middle column kept rendering a session the
 * reader had just taken off the rail. The rail and the workspace then disagreed about what was still in play.
 *
 * Three cases, because the key is either a live handle or a roster path (issue #89) and the right fallback differs:
 *
 *   - the focused session has no live process  → clear, and the placeholder appears;
 *   - a live session was focused and others remain → fall to another, so running work is not hidden;
 *   - a row nobody is looking at is forgotten  → focus must NOT move.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSession } from "@pi-central/protocol";
import { focusedSession, initialState, reduce, type UiState } from "../src/store.ts";

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

/** A state with the given live sessions remembered in the roster, focused on `focus`. */
function setup(liveSessions: LiveSession[], focus: string | undefined): UiState {
  let state: UiState = { ...initialState(), live: liveSessions, focusedId: focus };
  for (const session of liveSessions) {
    state = reduce(state, {
      kind: "remember",
      entry: { path: session.sessionFile ?? "", cwd: session.cwd, name: session.name },
    });
  }
  return state;
}

test("forgetting a STOPPED session clears the view, so the placeholder shows", () => {
  // A stopped session is addressed by its file path, which is the roster's own key.
  let state = setup([], A);
  state = reduce(state, { kind: "remember", entry: { path: A, cwd: "/x" } });
  state = reduce(state, { kind: "focusRow", key: A });
  assert.equal(state.focusedId, A, "the stopped row is focused");

  state = reduce(state, { kind: "forget", path: A });
  assert.deepEqual(state.roster, [], "the row is gone");
  assert.equal(state.focusedId, undefined, "and nothing is focused, which is the placeholder");
});

test("forgetting a LIVE session falls to another running one, not to nothing", () => {
  // Live work must not be hidden: the reader removed a ROW, not the process. Showing an empty column with a session
  // still running would be the rail lying about what is happening.
  let state = setup([live("s1", A), live("s2", B)], "s1");
  state = reduce(state, { kind: "forget", path: A });
  assert.equal(state.focusedId, "s2", "focus moves to the session still in the rail");
  assert.equal(focusedSession(state)?.id, "s2");
});

test("forgetting a LIVE session with nothing else running clears the view", () => {
  let state = setup([live("s1", A)], "s1");
  state = reduce(state, { kind: "forget", path: A });
  assert.equal(state.focusedId, undefined, "no other session, so the placeholder");
});

test("forgetting a row nobody is looking at does NOT move the reader", () => {
  // The regression a blunt "clear on forget" would cause: dismissing a row elsewhere in the rail would yank the
  // session the reader is working in.
  //
  // THREE sessions, not two. With two, a removed "was this the focused one?" guard happened to fall back to the same
  // session and the test passed by luck — the fallback picks the first session that is not the forgotten one, which is
  // the focused one only when it happens to come first. Falsification showed that; three sessions do not.
  const C = "/sessions/--p--/c.jsonl";
  let state = setup([live("s1", A), live("s2", B), live("s3", C)], "s3");
  state = reduce(state, { kind: "forget", path: A });
  assert.equal(state.focusedId, "s3", "the focused session is untouched");
  assert.equal(focusedSession(state)?.id, "s3");
});

test("a live session focused by its FILE is still recognised as the one being forgotten", () => {
  // `focusedId` may hold either spelling (issue #89), so comparing only one of them missed this case.
  let state = setup([live("s1", A), live("s2", B)], undefined);
  state = reduce(state, { kind: "focusRow", key: A });
  assert.equal(state.focusedId, "s1", "focusRow resolves the file to the handle");

  state = reduce(state, { kind: "forget", path: A });
  assert.equal(state.focusedId, "s2", "and forgetting the same file still moves the view");
});
