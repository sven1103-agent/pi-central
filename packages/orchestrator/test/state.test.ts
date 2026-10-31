import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSession, PiRecord } from "@pi-central/protocol";
import { blockingDialogMethods, fireAndForgetUiMethods, interpretRecord } from "../src/state.ts";
import { boundedTail, clearQueueVia, describeExitFailure, exitReason } from "../src/supervisor.ts";

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

// --- clearQueue: the order is the behaviour (issue #3) -------------------------------------------

test("clearQueue empties the queue BEFORE aborting, so the cleared text is still recoverable", () => {
  // Reversing these is the bug this function exists to prevent: abort first lets the run settle
  // while messages are still queued, and Pi may deliver one as a real turn in that window. The
  // order is asserted rather than described, so a refactor that swaps them fails here.
  const order: string[] = [];
  const send = async (command: { type: string }) => {
    order.push(command.type);
    return command.type === "clear_queue" ? { steering: ["keep me"], followUp: [] } : {};
  };
  return clearQueueVia(send as never, true).then((result) => {
    assert.deepEqual(order, ["clear_queue", "abort"]);
    assert.deepEqual(result.steering, ["keep me"]);
  });
});

test("clearQueue without andStop clears but does NOT abort", () => {
  // Clearing is useful on its own (a queue that should be emptied while the run continues), so
  // the abort must be conditional rather than always sent.
  const order: string[] = [];
  const send = async (command: { type: string }) => {
    order.push(command.type);
    return {};
  };
  return clearQueueVia(send as never, false).then(() => {
    assert.deepEqual(order, ["clear_queue"]);
  });
});

test("clearQueue returns the steering AND follow-up texts, and coerces untrusted entries", () => {
  // Pi returns both queues. A record's contents are untrusted, so a non-string entry is coerced
  // rather than passed through to a renderer.
  const send = async () => ({ steering: ["a", 2], followUp: ["b"] });
  return clearQueueVia(send as never, false).then((result) => {
    assert.deepEqual(result.steering, ["a", "2"]);
    assert.deepEqual(result.followUp, ["b"]);
  });
});

test("a clear_queue answer with no lists is empty, not a crash or a fabricated entry", () => {
  const send = async () => undefined;
  return clearQueueVia(send as never, false).then((result) => {
    assert.deepEqual(result.steering, []);
    assert.deepEqual(result.followUp, []);
  });
});

// --- Compaction and retry records must not change the session's state (issue #5) -----------------

test("compaction and retry records do NOT move the session out of streaming", () => {
  // The issue's fifth criterion, and the reason it exists: `agent_end` is not `agent_settled` (C8),
  // and a retry or a compaction can follow a failed turn. A banner rendered from one of these
  // records must therefore never be a state transition — a session that flipped to `idle` mid-retry
  // would invite a teardown or a second prompt while Pi was still working.
  const records: PiRecord[] = [
    { type: "compaction_start", reason: "overflow" },
    { type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, result: undefined },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "529" },
    { type: "auto_retry_end", success: true, attempt: 1 },
    // The FAILING variant is the one that matters, and its absence is why this test first failed to
    // catch a falsification: a retry that gave up is the most tempting record to read as "the run is
    // over", and it is exactly the one that must not be. Pi may still be recovering.
    { type: "auto_retry_end", success: false, attempt: 3, finalError: "provider unavailable" },
    { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 500, errorMessage: "x" },
    { type: "summarization_retry_finished" },
  ];
  for (const record of records) {
    const effect = interpretRecord(session({ state: "streaming" }), record);
    assert.equal(effect.patch?.state, undefined, `${record.type} must not change the run state`);
    assert.equal(effect.dialog, undefined, `${record.type} must not open a dialog`);
    // `compaction_end` is the ONE exception, and it refreshes stats for a reason: the meter has to
    // show the drop the compaction just produced (criterion 1), or it keeps displaying the pressure
    // that was relieved and the reader decides on a stale number.
    if (record.type === "compaction_end") {
      assert.equal(effect.refreshStats, true, "the context meter must reflect the drop");
    } else {
      assert.equal(effect.refreshStats, undefined, `${record.type} must not trigger a stats refresh`);
    }
  }
});

// --- A failure names what killed it, and does not bury it (reported from a window) ---------------

test("a shell-style 128+n exit is named as the signal it was", () => {
  // Reported: killing the session's process produced `pi exited (code=137, signal=-)` and nothing else. 137 is
  // 128 + 9, because the wrapper exited rather than the signal propagating — so the ONE word that explains the
  // failure was missing. The numbers are kept: they are the evidence.
  const killed = exitReason(137, null);
  assert.match(killed, /killed by SIGKILL/, killed);
  assert.match(killed, /code=137/, "the raw code must survive — it is what the log says");

  assert.match(exitReason(143, null), /killed by SIGTERM/);
  // A propagated signal is already named, and must not be decoded twice.
  assert.match(exitReason(null, "SIGKILL"), /killed by SIGKILL/);
  // An ordinary exit is not a signal.
  assert.ok(!/killed by/.test(exitReason(1, null)));
  assert.ok(!/killed by/.test(exitReason(0, null)));
  // A number outside the signal range is left alone rather than mislabelled.
  assert.ok(!/killed by/.test(exitReason(200, null)));
});

test("the failure is not buried under startup chatter", () => {
  // The reported screen: the LiteLLM and nvim-tmux banner lines, then `Killed: 9` on the last line of a
  // screenful. The cause is at the END of stderr — a process writes its banner as it starts and the fatal line
  // as it dies — so the tail is bounded from the top.
  const noise = Array.from({ length: 40 }, (_, i) => `[LiteLLM] startup notice ${i}`).join("\n");
  const message = describeExitFailure(137, null, `${noise}\nKilled: 9`);
  assert.match(message, /killed by SIGKILL/, "the reason comes first");
  assert.match(message, /Killed: 9/, "and the decisive line survives");
  assert.ok(message.split("\n").length < 20, `bounded, got ${message.split("\n").length} lines`);
  assert.match(message, /earlier lines of output omitted/, "and says what it dropped, rather than trimming silently");
});

test("short stderr is left exactly as it was", () => {
  // No truncation notice when nothing was truncated — a banner that always says "omitted" is noise.
  assert.equal(boundedTail("Error: cannot find module 'pi'"), "Error: cannot find module 'pi'");
  assert.equal(boundedTail(""), "");
  assert.equal(boundedTail("trailing newlines\n\n"), "trailing newlines");
});
