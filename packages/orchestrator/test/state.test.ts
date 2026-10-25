import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSession } from "@pi-central/protocol";
import { blockingDialogMethods, interpretRecord } from "../src/state.ts";

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
