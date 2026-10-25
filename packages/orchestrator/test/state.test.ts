import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSession } from "@pi-central/protocol";
import { blockingDialogMethods, fireAndForgetUiMethods, interpretRecord } from "../src/state.ts";
import { describeExitFailure } from "../src/supervisor.ts";

const session = (over: Partial<LiveSession> = {}): LiveSession => ({
  id: "s1",
  name: "test",
  cwd: "/tmp",
  state: "idle",
  mode: "sandboxed",
  isolation: "test",
  command: "safehouse -- pi --mode rpc",
  scratch: false,
  messageCount: 0,
  pending: 0,
  contextPercent: null,
  tokensTotal: null,
  cost: null,
  dialogs: [],
  warnings: [],
  startedAt: 0,
  ...over,
});

test("agent_start moves to streaming", () => {
  assert.equal(interpretRecord(session(), { type: "agent_start" }).patch?.state, "streaming");
});

test("agent_end does NOT settle the session (C8)", () => {
  // Retries, compaction, steering and follow-ups can all follow agent_end. Settling here
  // would mark a working session idle and invite a teardown or re-prompt mid-run.
  const effect = interpretRecord(session({ state: "streaming" }), { type: "agent_end" });
  assert.equal(effect.patch, undefined, "agent_end must produce no state change");
});

test("agent_settled is what settles the session, and asks for fresh stats (C8)", () => {
  const effect = interpretRecord(session({ state: "streaming" }), { type: "agent_settled" });
  assert.equal(effect.patch?.state, "idle");
  assert.equal(effect.refreshStats, true);
});

test("a settle with an outstanding dialog lands in awaiting-approval", () => {
  const busy = session({ state: "streaming", dialogs: [{ id: "d1", method: "confirm", receivedAt: 0 }] });
  assert.equal(interpretRecord(busy, { type: "agent_settled" }).patch?.state, "awaiting-approval");
});

test("non-dialog extension UI requests never block (the startup burst)", () => {
  // notify/setStatus/setWidget arrive in a burst at startup. Treating one as a dialog would
  // wedge the session on a prompt no human will ever answer.
  for (const method of ["notify", "setStatus", "setWidget"]) {
    const effect = interpretRecord(session(), { type: "extension_ui_request", id: "x", method });
    assert.equal(effect.dialog, undefined, `${method} must not register a dialog`);
    assert.equal(effect.patch, undefined, `${method} must not change state`);
  }
});

test("every blocking dialog method opens a dialog and moves to awaiting-approval", () => {
  for (const method of blockingDialogMethods) {
    const effect = interpretRecord(session(), { type: "extension_ui_request", id: "d1", method, title: "t" });
    assert.equal(effect.dialog?.method, method);
    assert.equal(effect.patch?.state, "awaiting-approval");
  }
});

test("dialog fields are carried through for display", () => {
  const effect = interpretRecord(session(), {
    type: "extension_ui_request",
    id: "d9",
    method: "select",
    title: "Pick one",
    message: "Which?",
    options: ["a", "b"],
  });
  assert.equal(effect.dialog?.id, "d9");
  assert.equal(effect.dialog?.title, "Pick one");
  assert.deepEqual(effect.dialog?.options, ["a", "b"]);
});

test("message_end counts user and assistant, ignores everything else", () => {
  const start = session({ messageCount: 0 });
  assert.equal(interpretRecord(start, { type: "message_end", message: { role: "user" } }).patch?.messageCount, 1);
  assert.equal(interpretRecord(start, { type: "message_end", message: { role: "assistant" } }).patch?.messageCount, 1);
  assert.equal(interpretRecord(start, { type: "message_end", message: { role: "tool" } }).patch, undefined);
  assert.equal(interpretRecord(start, { type: "message_end" }).patch, undefined);
});

test("queue_update sums steering and follow-up depth", () => {
  assert.equal(interpretRecord(session(), { type: "queue_update", steering: [1], followUp: [1, 2] }).patch?.pending, 3);
  assert.equal(interpretRecord(session(), { type: "queue_update" }).patch?.pending, 0);
});

test("an unknown record type is ignored, not guessed at", () => {
  assert.deepEqual(interpretRecord(session(), { type: "some_future_event" }), {});
});

// --- Extension UI classification (PROTOCOL.md: nine requests, two families) -------------------

test("all five documented fire-and-forget methods are NOT dialogs", () => {
  // Pi emits ~9 extension_ui_request records at startup: five notify, three setStatus, one
  // setWidget. Every one carries an `id`, so "has an id therefore it is a dialog" would wedge
  // every session on a prompt no human will ever answer, before the user has done anything.
  for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
    assert.equal(
      interpretRecord(session(), { type: "extension_ui_request", id: "x", method }).dialog,
      undefined,
      `${method} must not open a dialog`,
    );
  }
});

test("all four documented dialog methods DO open a dialog", () => {
  for (const method of ["select", "confirm", "input", "editor"]) {
    const effect = interpretRecord(session(), { type: "extension_ui_request", id: "x", method });
    assert.ok(effect.dialog, `${method} must open a dialog`);
    assert.equal(effect.patch?.state, "awaiting-approval");
  }
});

test("an UNKNOWN method is treated as a dialog, because that direction is recoverable", () => {
  // The classification is an allowlist of the NON-dialogs, not of the dialogs, and the
  // difference decides how a future Pi fails here:
  //
  //   - unknown -> dialog: the user sees it and cancels. Costs a click.
  //   - unknown -> ignored: Pi waits forever for a response nobody knows to send. Costs the
  //     session, silently, with no visible cause.
  //
  // Same lesson as C12/C13 in another place: a plausible-looking non-failure is worse than a
  // visible annoyance.
  const effect = interpretRecord(session(), {
    type: "extension_ui_request",
    id: "x",
    method: "someFutureBlockingMethod",
    message: "from a newer Pi",
  });
  assert.ok(effect.dialog, "an unrecognized method must be surfaced, not swallowed");
  assert.equal(effect.dialog.method, "someFutureBlockingMethod");
  assert.equal(effect.patch?.state, "awaiting-approval");
});

test("the classified families are exactly Pi's documented ones", () => {
  // Guards against a method being added to one list and not the other, which is how the two
  // families drift into an in-between state.
  assert.deepEqual([...blockingDialogMethods].sort(), ["confirm", "editor", "input", "select"]);
  // Compared as a SET, not a sorted list: the order is Pi's, and asserting a locally computed
  // sort order tests JavaScript's collation rather than the classification.
  assert.deepEqual(
    [...fireAndForgetUiMethods].sort(),
    ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"].sort(),
  );
  assert.equal(
    blockingDialogMethods.length + fireAndForgetUiMethods.length,
    9,
    "the two families plus the observed startup burst should account for all nine requests",
  );
});

test("a non-extension_ui_request record is never a dialog", () => {
  for (const type of ["agent_start", "message_update", "tool_execution_start", "session_info_changed"]) {
    assert.equal(interpretRecord(session(), { type }).dialog, undefined);
  }
});

// --- C1 diagnosis is attached where the evidence is -------------------------------------------

test("seatbelt refusal produces an actionable diagnosis", () => {
  // The most likely first-run failure. The raw output ("pi exited (code=71)") reads like a
  // launcher bug and sends the reader looking in the wrong place, so the cause is named.
  const seatbelt = describeExitFailure(71, null, "sandbox-exec: sandbox_apply: Operation not permitted");
  assert.match(seatbelt, /Seatbelt refusing to nest/);
  assert.match(seatbelt, /plain terminal/);
  assert.match(seatbelt, /code=71/, "the original evidence must survive");
});

test("an unrelated failure is NOT blamed on nesting", () => {
  // A wrong hint is worse than none: it would send someone to the wrong place with confidence.
  const other = describeExitFailure(1, null, "Error: cannot find module 'pi'");
  assert.ok(!other.includes("Seatbelt"), "an unrelated failure must not be blamed on nesting");
  assert.match(other, /cannot find module/);
});

test("a clean exit with no stderr still reports the code", () => {
  const clean = describeExitFailure(0, null, "");
  assert.match(clean, /code=0/);
  assert.ok(!clean.includes("Seatbelt"));
});

// --- The thinking level follows Pi (issue #2) ----------------------------------------------------

test("a thinking_level_changed record updates the session's level", () => {
  // The acceptance criterion is that the RAIL updates without a manual refresh. RPC mode forwards
  // every session event (`rpc-mode.js`: `session.subscribe(...)` with no type filter), so this
  // record really arrives — and this reducer is what applies it. It was wired from the start and
  // had no test until the picker made the path load-bearing.
  const effect = interpretRecord(session({ thinkingLevel: "low" }), {
    type: "thinking_level_changed",
    level: "high",
  });
  assert.equal(effect.patch?.thinkingLevel, "high");
});

test("a thinking_level_changed record does not disturb the run state", () => {
  // Pi re-applies the level on a model switch, mid-run, so this must never look like a state
  // transition — an `agent_end`-style mistake would mark a working session idle (C8's family).
  const effect = interpretRecord(session({ state: "streaming" }), {
    type: "thinking_level_changed",
    level: "off",
  });
  assert.equal(effect.patch?.state, undefined);
  assert.equal(effect.refreshStats, undefined);
  assert.equal(effect.dialog, undefined);
});
