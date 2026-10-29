/**
 * Startup failures, said in terms a person can act on (issue #114).
 *
 * ## A correction this test records
 *
 * My first write-up of #114 claimed a second `npm run server` "exits 0 and does nothing". **It does
 * not** — `transport.listen()` rejects, `main()`'s rejection handler prints the message and exits 1:
 *
 *     Pi Central failed to start: listen EADDRINUSE: address already in use 127.0.0.1:8787
 *
 * So the failure was never invisible. What it lacked was the *situation*: "EADDRINUSE" names a syscall,
 * not "you have a second server running, which is why the code you just rebuilt is not being served".
 * That is the debugging round trip the issue is actually about, and it is what these messages fix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeBuiltUi, explainStartupError } from "../src/startup-error.ts";

test("a port collision explains the second-server case, which is the one that matters here", () => {
  // `EADDRINUSE` on a local tool has exactly one common cause, and it is the cause that also explains
  // why a rebuild appeared to do nothing.
  const message = explainStartupError({ code: "EADDRINUSE" }, "127.0.0.1", 8787);
  assert.ok(message, "a port collision must be explained");
  assert.match(message, /Port 8787 is already in use/, "the port, named");
  assert.match(message, /already running/, "the situation");
  assert.match(message, /Node has its old modules cached|cached/, "why a rebuild would appear not to work");
  assert.match(message, /lsof -ti tcp:8787/, "and a command to find it");
  assert.match(message, /--port/, "…and the alternative");
});

test("the message does not just restate the syscall", () => {
  // The old behaviour printed `listen EADDRINUSE: address already in use`. A message whose content is
  // the error code is a message that has not been written.
  const message = explainStartupError({ code: "EADDRINUSE" }, "127.0.0.1", 8787) ?? "";
  assert.ok(!/^\s*listen EADDRINUSE/.test(message), "it must not open with the syscall");
  assert.ok(message.split("\n").length > 4, "it has to say more than one thing");
});

test("the other two bind failures are explained rather than relayed", () => {
  // A privileged port and a wrong host are the two other ways `listen` fails, and their fixes differ.
  const denied = explainStartupError({ code: "EACCES" }, "127.0.0.1", 80) ?? "";
  assert.match(denied, /Permission denied/);
  assert.match(denied, /--port/, "and the fix, which is not 'use sudo'");

  const noHost = explainStartupError({ code: "EADDRNOTAVAIL" }, "10.0.0.9", 8787) ?? "";
  assert.match(noHost, /not an address this machine has/);
  assert.match(noHost, /loopback/, "the reason Pi Central binds loopback only");
});

test("an unrecognised error is left to the generic handler, not half-explained", () => {
  // Returning a message for something we do not understand would replace a true (if terse) error with a
  // plausible wrong one.
  assert.equal(explainStartupError(new Error("something else"), "127.0.0.1", 8787), undefined);
  assert.equal(explainStartupError({ code: "EWHATEVER" }, "127.0.0.1", 8787), undefined);
  assert.equal(explainStartupError(undefined, "127.0.0.1", 8787), undefined);
});

test("the startup log names the served bundle, so 'am I current?' needs no curl", () => {
  // The other half of the diagnosis: the terminal says what is on disk, the page says what the tab is
  // running. Comparing the two is the whole check the issue is about.
  const described = describeBuiltUi(new URL("../../ui/dist", import.meta.url).pathname);
  // `dist` may not exist in a fresh checkout — CI builds it, but this test must not depend on the order.
  assert.match(
    described,
    /assets\/index-[A-Za-z0-9_-]+\.js \(built \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)|\(unreadable\)|no entry bundle/,
    `got ${described}`,
  );
});

test("an unreadable UI directory is reported as such rather than throwing", () => {
  // A log line must never be able to fail a start.
  assert.equal(describeBuiltUi("/definitely/not/here"), "(unreadable)");
});
