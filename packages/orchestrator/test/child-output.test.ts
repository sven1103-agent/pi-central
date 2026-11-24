import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedTail, exitReason, failureTail, STDERR_TAIL_LINES } from "../src/child-output.ts";

/**
 * Reading a dead child's last words.
 *
 * This module exists because two callers needed it and one of them could not reach the other: `boundedTail` lived
 * in `supervisor.ts`, which imports `sidecar-supervise.ts`, so the sidecar could not use it without a cycle.
 * The functions are tested here ONCE rather than in each caller, which is the point of moving them.
 */

test("a shell-style 128+n exit is named as the signal it was", () => {
  // A shell reports a killed child as `128 + n` with no signal name, so a deliberate kill reads as a bare number
  // unless it is decoded. `137` is `SIGKILL`; saying so is what makes the message explain the action.
  assert.match(exitReason(137, null), /killed by SIGKILL/, "137 is decoded, not left as a number");
  assert.match(exitReason(143, null), /killed by SIGTERM/);
  assert.match(exitReason(null, "SIGKILL"), /killed by SIGKILL/, "an explicit signal is passed through");
  assert.ok(!/killed by/.test(exitReason(1, null)), "an ordinary failure is not called a kill");
  assert.ok(!/killed by/.test(exitReason(0, null)), "and neither is a clean exit");
  assert.ok(!/killed by/.test(exitReason(200, null)), "nor a number outside the 128+n range");
});

test("the raw numbers survive alongside the decoded name", () => {
  // The evidence is the number. Naming the signal is a READING of it, and a reader who disagrees with the reading
  // must still be able to see what was actually reported.
  assert.match(exitReason(137, null), /code=137/);
  assert.match(exitReason(null, null), /code=-, signal=-/, "an unknown status says so rather than guessing");
});

test("the process is named by the caller, so a sidecar failure does not say 'pi'", () => {
  // Measured consequence of the default being hard-coded: a session-browser failure would have told the reader that
  // `pi` had exited, which names the wrong process and sends them to the wrong log.
  assert.match(exitReason(2, null, "the sidecar"), /^the sidecar exited/, "the caller's name opens the sentence");
  assert.match(exitReason(2, null), /^pi exited/, "the default is the common caller, a session");
});

test("a long stderr is trimmed from the TOP, because the cause is at the end", () => {
  const lines = Array.from({ length: STDERR_TAIL_LINES + 5 }, (_, i) => `line ${i + 1}`);
  const bounded = boundedTail(lines.join("\n"));
  assert.ok(bounded.includes(`line ${STDERR_TAIL_LINES + 5}`), "the last line survives: that is the fatal one");
  assert.ok(!bounded.includes("line 1\n"), "the banner does not");
  assert.match(bounded, /5 earlier lines of output omitted/, "and the omission is counted rather than silent");
});

test("short stderr is left exactly as it was", () => {
  // No count line and no reflowing: a two-line message must not be decorated.
  assert.equal(boundedTail("Error: cannot find module 'pi'"), "Error: cannot find module 'pi'");
  assert.equal(boundedTail(""), "");
  assert.equal(boundedTail("trailing newlines\n\n"), "trailing newlines");
});

test("an uncaught exception keeps the line that names it, even when the stack overflows the bound", () => {
  /*
   * THE defect this function exists for, and it is measured rather than supposed.
   *
   * Node prints `Error: listen EADDRINUSE: address already in use 127.0.0.1:47816` FIRST and follows it with a
   * twenty-line stack; the `code: 'EADDRINUSE'` line is near the BOTTOM, but the last twelve lines are stack frames
   * and the node version. So `boundedTail` alone returned a tail that contained no mention of a port — and the
   * orchestrator's failure message, built from that tail, told the reader nothing.
   *
   * Falsification: make `failureTail` return `boundedTail(stderr)` and this fails on the first assertion.
   */
  const stderr =
    "Error: listen EADDRINUSE: address already in use 127.0.0.1:47816\n" +
    Array.from({ length: 25 }, (_, i) => `    at frame ${i} (node:net:1:1)`).join("\n");
  const tail = failureTail(stderr);

  assert.match(tail, /EADDRINUSE/, "the cause is present: this is the whole reason the function exists");
  assert.match(tail, /127\.0\.0\.1:47816/, "and the address, which is the actionable part");
  assert.ok(tail.includes("frame 24"), "the last frame still survives, so it is still a tail");
  assert.ok(tail.length < stderr.length, "and it is shorter than the input, so it is still bounded");
});

test("the first line is not duplicated when the tail already begins with it", () => {
  // Short output that fits the bound unchanged: the cause IS the tail, so prepending it would print it twice.
  const stderr = "sidecar cannot listen on 127.0.0.1:47816: EADDRINUSE\nnode:net:1";
  assert.equal(failureTail(stderr), boundedTail(stderr), "no duplication for the ordinary short case");
});

test("an empty stderr stays empty, so no separator is emitted around nothing", () => {
  // The rejection appends the tail only when it is non-empty; a stray "\n" or a lone "…" would show as an artifact.
  assert.equal(failureTail(""), "");
  assert.equal(failureTail("   \n  \n"), "");
});
