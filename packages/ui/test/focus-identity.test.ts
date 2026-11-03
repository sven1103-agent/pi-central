/**
 * Which session the reader is looking at after clicking a History row (reported from use).
 *
 * ## The report
 *
 * *"when you click a session in the history, and it is already active in the roster, it opens this session, but the
 * selection is not updated. Users dont realise that they are in the new session. This is a huge identity issue."*
 *
 * ## The cause
 *
 * `expectNewSession` was a BOOLEAN, spent only by a session **new to the list** (`arrived`). Resuming an
 * already-running session re-broadcasts that same session, so `arrived` is false, the intent was never spent — and
 * `focusedId` stayed on whatever had been focused before. The tab switched to Sessions showing a DIFFERENT session,
 * with nothing on screen saying so.
 *
 * A boolean cannot express "the one in this file", which is why the file is now recorded and matched. These tests pin
 * the three cases that have to be distinguished, because each one failed in a different way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSession } from "@pi-central/protocol";
import { focusedSession, focusedStoppedRow, initialState, reduce, type UiState } from "../src/store.ts";

const A = "/sessions/--p--/2026-07-01T09-00-00-000Z_aaa.jsonl";
const B = "/sessions/--p--/2026-07-01T10-00-00-000Z_bbb.jsonl";
const OTHER = "/sessions/--other--/2026-07-02T09-00-00-000Z_zzz.jsonl";

function live(id: string, sessionFile: string): LiveSession {
  return {
    id,
    name: id,
    cwd: "/p",
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

function withFocusedS1(): UiState {
  const base = initialState();
  return { ...base, live: [live("s1", A)], focusedId: "s1" };
}

test("clicking a History row for an ALREADY-LIVE session moves the focus to it", () => {
  // Case A — the reported bug. The reader is looking at `s1`, clicks the History row for the conversation `s2` holds.
  let state: UiState = { ...withFocusedS1(), live: [live("s1", A), live("s2", B)], focusedId: "s1" };
  state = reduce(state, { kind: "focusRow", key: B });
  assert.equal(state.focusedId, "s2", "focus follows the click, by FILE resolved to the live handle");
  assert.equal(focusedSession(state)?.sessionFile, B, "and the main column shows that conversation");
});

test("a session FILE resolves to the live HANDLE, not to a stopped row", () => {
  // Focusing the path instead would render the stopped-session view beside a running process.
  const state = reduce({ ...withFocusedS1(), focusedId: undefined }, { kind: "focusRow", key: A });
  assert.equal(state.focusedId, "s1", "the handle");
  assert.equal(focusedStoppedRow(state), undefined, "and NOT a stopped row for the same conversation");
});

test("a spawn still in flight is focused when it arrives", () => {
  // Case B: the resume is async, so the session does not exist yet at click time.
  let state = withFocusedS1();
  state = reduce(state, { kind: "focusRow", key: B });
  state = reduce(state, { kind: "expectNewSession", file: B });
  state = reduce(state, { kind: "session", session: live("s7", B) });
  assert.equal(state.focusedId, "s7", "the arriving session claims the focus");
});

test("an UNRELATED session arriving first does NOT steal the focus", () => {
  // Case C, and this failed when the fix was first written: `focusNextNewSession && arrived` still claimed any new
  // session, so a concurrent start took the reader's view. When a file is named, only that file may claim it.
  let state = withFocusedS1();
  state = reduce(state, { kind: "expectNewSession", file: B });
  state = reduce(state, { kind: "session", session: live("s9", OTHER) });
  assert.equal(state.focusedId, "s1", "an unrelated arrival leaves the focus alone");

  state = reduce(state, { kind: "session", session: live("s7", B) });
  assert.equal(state.focusedId, "s7", "and the one that was asked for still claims it");
});

test("a plain `start` (no file) keeps the #144 behaviour", () => {
  // `⌘N` names no file — none exists yet — so the next new session must still be focused, which is what #144 fixed.
  let state = withFocusedS1();
  state = reduce(state, { kind: "expectNewSession" });
  state = reduce(state, { kind: "session", session: live("s9", OTHER) });
  assert.equal(state.focusedId, "s9", "a new session claims the intent when nothing was named");
});

test("a refused resume disarms the intent, file included", () => {
  // #144's rule: an error produces no `session` event, so an armed intent would pull the view to some later session.
  let state = withFocusedS1();
  state = reduce(state, { kind: "expectNewSession", file: B });
  state = reduce(state, { kind: "error", message: "could not resume" });
  assert.equal(state.focusNextNewSession, false);
  assert.equal(state.focusNextSessionFile, undefined, "the file is cleared with the flag, or a later session matches it");
  state = reduce(state, { kind: "session", session: live("s9", OTHER) });
  assert.equal(state.focusedId, "s1", "so nothing steals the view afterwards");
});
