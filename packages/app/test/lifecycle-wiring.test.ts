/**
 * The main process routes the lifecycle decisions, and the source says so where a test can read it
 * (issue #216, criteria 1 and 2).
 *
 * ## Why this reads the source, and what makes that legitimate here
 *
 * Criteria 1 and 2 are *wiring*: `window-all-closed` must not quit on macOS, `activate` must reopen, and `⌘Q` must
 * reach the question. `main.ts` imports `electron`, whose package export is a **path string** to a binary, so it
 * cannot be loaded by `node --test` at all — and the decisions it wires are already asserted directly in
 * `runtime-record.test.ts`.
 *
 * What is left is the join, and the failure mode is specific: a handler registered on the wrong event, a `SIGTERM`
 * that survived the rewrite, or a `quit()` that runs before the question. Each of those is visible in the source and
 * invisible to every other test in this repository. The assertions are therefore written against *structure* —
 * the handler's body, the order of the calls — rather than against prose, and each one names the line it would
 * rather have failed on.
 *
 * `window-security.test.ts` established the same convention for the same reason (`bundleProblems` reads assembled
 * output; this reads the handler bodies), and the alternative — a test that clicks through a real `⌘Q` — is the one
 * thing this project's test suite cannot do on the machine the bug happens on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MAIN = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

/**
 * The body of one `app.on("<event>", …)` handler, from the registration to its closing brace.
 *
 * Balanced rather than matched with a regex or a `indexOf("}")`: a handler containing a template literal (`${x}`)
 * or a nested callback puts a `}` where a naive scan would stop, and the assertions below are about what comes after
 * that point.
 */
function handlerBody(event: string): string {
  const start = MAIN.indexOf(`app.on("${event}"`);
  assert.notEqual(start, -1, `main.ts no longer registers a "${event}" handler`);
  return balancedBlock(MAIN, start, `the "${event}" handler`);
}

/** The brace-balanced block that starts at the first `{` after `from`. */
function balancedBlock(text: string, from: number, what: string): string {
  const open = text.indexOf("{", from);
  assert.notEqual(open, -1, `${what} has no body`);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  assert.fail(`${what} is not brace-balanced`);
}

test("closing the window does not quit on macOS (criterion 1)", () => {
  const body = handlerBody("window-all-closed");
  // The defect this is the whole criterion for: the previous slice quit here, which stopped the orchestrator and every
  // session with it.
  assert.equal(body.includes("app.quit"), true, "a non-macOS quit is still required");
  assert.match(body, /process\.platform !== "darwin"/, "the quit is conditional on the platform, and on macOS it is not taken");
  // And the piece that makes the platform conditional safe: the quit must be *inside* the guard, not before it.
  const guard = body.indexOf('process.platform !== "darwin"');
  const quit = body.indexOf("app.quit");
  assert.ok(guard !== -1 && quit > guard, "app.quit is reached only after the platform check");
});

test("the dock icon reopens the window, and does not start a second orchestrator over a running one", () => {
  const body = handlerBody("activate");
  // The window `close` destroys, so `activate` has to be able to build one. Returning early when there is no window
  // is what made the app unreachable after a close in the previous slice.
  assert.equal(body.includes("existing !== undefined && !existing.isDestroyed()"), true, "the window is reused when it exists");
  assert.equal(body.includes("appWindow()"), true, "and built when it does not");
  /*
   * The load-bearing half: with an orchestrator still running, the reopened window loads ITS url. `start()` would
   * probe the record, adopt the same process, and be harmless — but this is the direct statement of "the window
   * reopens onto the work that is still there", and it is what criterion 1's "PID unchanged" looks like from the
   * window's side.
   */
  assert.match(body, /current\.httpUrl/, "a running orchestrator's URL is what the new window loads");
  assert.equal(body.includes("loadURL"), true);
});

test("`⌘Q` asks before it stops anything (criteria 2 and 3)", () => {
  const body = handlerBody("before-quit");
  assert.equal(body.includes("decideAndQuit()"), true, "the question is asked from the quit path");
  assert.equal(body.includes("event.preventDefault()"), true, "the quit is held while the answer is obtained");
  /*
   * And the answer is what re-enters the quit. `quitDecided` is the flag the second pass reads: without it the
   * handler would ask again, which is the loop a naive `preventDefault` + `app.quit()` builds.
   */
  assert.match(body, /if \(quitDecided\)/, "the second pass acts instead of asking");
  const decided = body.indexOf("if (quitDecided)");
  const ask = body.indexOf("decideAndQuit()");
  assert.ok(decided !== -1 && decided < ask, "the decided branch is checked BEFORE the question is asked");
});

test("the kill is conditional on the answer, and `detach` is a branch rather than a comment (criterion 4)", () => {
  const body = MAIN.slice(MAIN.indexOf("function stopOrchestratorForQuit"));
  /*
   * The previous version of this file sent `SIGTERM` unconditionally from `before-quit`. That single line is what made
   * "quit" and "stop every session" the same action, so the assertion is that the signal is now nested under the
   * detach check — structurally, by position, not by the presence of an `if`.
   */
  const detach = body.indexOf("if (detachOnQuit)");
  const signal = body.indexOf('kill("SIGTERM")');
  assert.ok(detach !== -1, "the detach decision is consulted");
  assert.ok(signal > detach, "and the child is signalled only after it");
  // The detach branch must RETURN: falling through would signal the process it just decided to keep.
  const branch = balancedBlock(body, detach, "the detach branch");
  assert.equal(branch.includes("return"), true, "the keep branch returns before the stop branch runs");
  assert.equal(branch.includes("SIGTERM"), false, "and sends nothing to the child");
});

test("the record is written when an orchestrator is started, and removed on a clean quit (criterion 7)", () => {
  // Written in `onAnnounced`, which is the one place a launch becomes a running orchestrator.
  const announced = MAIN.slice(MAIN.indexOf("function onAnnounced"), MAIN.indexOf("function missingTitle"));
  assert.equal(announced.includes("writeRuntimeRecord"), true, "a started orchestrator is recorded");
  assert.equal(announced.includes("app.getPath(\"userData\")"), true, "and recorded under the app's own data directory");

  // Removed on the stop path, before the signal: a record for a process that is being stopped is a stale hint.
  const stop = MAIN.slice(MAIN.indexOf("function stopOrchestratorForQuit"));
  const remove = stop.indexOf("removeRuntimeRecord");
  const signal = stop.indexOf('kill("SIGTERM")');
  assert.notEqual(remove, -1, "a clean quit removes the record");
  assert.ok(remove < signal, "removed BEFORE the orchestrator is signalled, so no stale record survives the quit");
});

test("the launch probes the record before deciding, and only a `spawn` verdict spawns", () => {
  const launch = MAIN.slice(MAIN.indexOf("async function launch"), MAIN.indexOf("function keepsRecordOnSpawn"));
  // The three inputs `decideAttach` needs, each named: the record, the process marks, the port's answer.
  assert.equal(launch.includes("readRuntimeRecord"), true);
  assert.equal(launch.includes("probeProcess("), true, "the PID is probed rather than trusted");
  assert.equal(launch.includes("probePort("), true, "the port is asked rather than assumed");
  assert.equal(launch.includes("decideAttach("), true);
  /*
   * And the spawn is guarded by the verdict. The failure this prevents is a launch that probes, decides "attach",
   * and then spawns anyway because the spawn line was left at the end of the function.
   */
  const attach = launch.indexOf('decision.verdict === "attach"');
  const spawn = launch.indexOf("spawnOrchestrator(");
  assert.ok(attach !== -1 && spawn > attach, "the spawn is after the attach branch");
  const attachBranch = launch.slice(attach, spawn);
  assert.equal(attachBranch.includes("return"), true, "the attach branch returns rather than falling through");
});

test("the child is spawned detached, so a group signal to the app misses it (criterion 4)", () => {
  const spawnCall = MAIN.slice(MAIN.indexOf("const child = spawn(plan.command"), MAIN.indexOf("child.unref()"));
  assert.match(spawnCall, /detached: true/, "detachment is what the detach-live test asserts the consequence of");
  assert.equal(MAIN.includes("child.unref()"), true, "and unref, so a kept child cannot hold the app's loop open");
});

test("the shell passes no flag that suppresses session restoration (criterion 8)", () => {
  /*
   * #185's restoration is `restoreOpenSessions()`, called by the orchestrator on every start with no flag. The failure
   * this asserts against is a future change that adds a `--no-restore` "so a restart is fast", which would make every
   * shell restart silently lose the sessions the shell exists to protect.
   *
   * The switch that exists is read from the orchestrator's own parser, so the assertion is that the shell's argv does
   * not contain any of the strings that would mean "do not restore".
   */
  const plan = readFileSync(new URL("../src/orchestrator-process.ts", import.meta.url), "utf8");
  const args = plan.slice(plan.indexOf("const args = ["), plan.indexOf("return { command: input.node.path"));
  assert.match(args, /--port",\s*"0"/, "the argv is the package, the port, and forwarded extras");
  for (const forbidden of ["no-restore", "restore", "no-resume"]) {
    assert.equal(args.includes(forbidden), false, `the spawn argv must not contain ${forbidden}`);
  }
  // And the orchestrator restores unconditionally, which is what makes the absence above sufficient.
  const server = readFileSync(new URL("../../orchestrator/src/server.ts", import.meta.url), "utf8");
  assert.match(server, /await supervisor\.restoreOpenSessions\(\)/, "restoration is unconditional in the entry point");
});

test("`quitting` is not set before the question is answered", () => {
  /*
   * A subtle invariant, and the one a future edit is most likely to undo by tidying: `quitting` means "a quit is under
   * way", and `retry` consults it to refuse spawning an orchestrator nothing would own. Setting it on entry to
   * `before-quit` would make the whole dialog look like a quit in progress — a reload from the failure page refused
   * while the reader is still deciding, and, on Cancel, an app whose `exit` handler no longer restarts a crashed child.
   *
   * Asserted by position: the assignment must come after the `quitDecided` branch that actually commits.
   */
  const body = handlerBody("before-quit");
  const assignment = body.indexOf("quitting = true");
  const committed = body.indexOf("if (quitDecided)");
  assert.notEqual(assignment, -1, "`quitting` is set somewhere in the quit path");
  assert.ok(committed !== -1 && assignment > committed, "`quitting` is set by the committed branch, not on entry");
  // And the handler's first statement must not be it.
  const firstStatement = body.split(";")[0] ?? "";
  assert.equal(firstStatement.includes("quitting = true"), false, "the handler does not set it before deciding anything");
});
