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

/**
 * Strip comments from source, so an assertion about CODE cannot be satisfied by a mention of it.
 *
 * Needed more than once: `update-safety.test.ts` matched `http://host:port` in an error message, and this file matched
 * the string `if (quitting) return;` inside the comment that explains why it may not come first. A checker that reads
 * prose as code reports the opposite of the truth.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
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

// -----------------------------------------------------------------------------------------------------------
// The quit that never finished, reported from a running app.
// -----------------------------------------------------------------------------------------------------------

test("`running` is cleared on exit BEFORE the `quitting` early-return", () => {
  /*
   * Reported: "when I press Command Q, the window stays open forever and shows the disconnect state."
   *
   * The loop, exactly:
   *
   *   1. `⌘Q` -> `before-quit` -> `quitDecided` -> `app.quit()`
   *   2. `before-quit` again -> `stopOrchestratorForQuit()` -> child `SIGTERM`
   *   3. the child exits, and its `exit` handler did `if (quitting) return;` **before** `running = undefined`
   *   4. so `running` still named a dead process, and the next pass waited for an `exit` that had already fired
   *   5. after STOP_GRACE_MS it resolved and called `app.quit()` again -> back to 4, for ever
   *
   * The window stayed on screen because every pass called `preventDefault`, and it showed `disconnected` because the
   * socket was gone while the page was still there. A five-second heartbeat of nothing.
   *
   * Every existing test passed while this shipped, because they assert the DECISIONS and the handler REGISTRATIONS —
   * neither of which is the ordering inside a callback.
   */
  /*
   * The window is the handler's opening, taken up to the first branch. It must span BOTH statements under test, so the
   * slice ends at the `quitting` guard rather than at `!announced` — the first version cut the region before the guard it
   * was looking for, and reported the ordering as wrong when it was right.
   */
  const exitHandler = codeOnly(MAIN.slice(MAIN.indexOf('child.on("exit", (code, signal) => {')));
  const body = exitHandler.slice(0, exitHandler.indexOf("if (!announced)") + 1);
  const cleared = body.indexOf("running = undefined");
  const bail = body.indexOf("if (quitting) return");
  assert.notEqual(cleared, -1, "the exit handler clears `running`");
  assert.notEqual(bail, -1, "and still distinguishes a quit from a crash");
  assert.ok(cleared < bail, "`running` is cleared BEFORE the early return, or a stopped child still looks running");
});

test("the stop is performed at most once, so `app.quit()` cannot re-enter it", () => {
  // `app.quit()` re-enters `before-quit`; a handler that stops "whatever is running" every pass loops for ever.
  const body = handlerBody("before-quit");
  const committed = body.indexOf("if (quitDecided)");
  const guard = body.indexOf("if (stopRequested) return");
  const stop = body.indexOf("stopOrchestratorForQuit()");
  assert.ok(committed !== -1 && guard > committed, "the once-only guard is inside the committed branch");
  assert.ok(stop > guard, "and the stop is only reached when it has not been requested");
  // The flag is set when the stop is requested, and reset when the reader cancels.
  assert.match(MAIN, /stopRequested = true/);
  assert.match(MAIN, /stopRequested = false/);
});

test("stopping a child that has already exited resolves immediately instead of waiting", () => {
  /*
   * The second half of the same bug: `child.once("exit")` on an already-dead child never fires, so the promise waited the
   * full grace period before letting the quit proceed — which is what turned a stuck quit into a five-second loop rather
   * than a hang. `exitCode`/`signalCode` are the facts that answer "has it already gone?".
   */
  const stop = MAIN.slice(MAIN.indexOf("function stopOrchestratorForQuit"));
  assert.match(stop, /exitCode !== null \|\| child\.signalCode !== null/, "an exited child is detected before waiting");
  // And the detection returns `undefined` — "nothing to wait for" — rather than a resolved promise, which the caller
  // treats as "hold the quit".
  const guard = stop.slice(stop.indexOf("exitCode !== null"), stop.indexOf("exitCode !== null") + 120);
  assert.match(guard, /return undefined/);
});

test("the app applies its own icon and its own About facts before the first window exists", () => {
  /*
   * Issue #239, and the reason this is a source assertion rather than a rendering one: `main.ts` imports `electron`,
   * whose package export is a path to a binary, so it cannot be loaded by `node --test` at all. What is left is the
   * join, and the defect being prevented is a join — a function that exists but is never called, which is exactly what
   * "the dock still shows Electron's logo" looks like from here.
   *
   * Both are called in `whenReady` **before** `start()`: the dock tile and the About facts are per-process state, and a
   * window that appears before them shows the frameworks's answers for a moment (and keeps them, for About, if the panel
   * is opened from the menu that `buildMenu` registers).
   */
  const ready = MAIN.slice(MAIN.indexOf("app.whenReady()"), MAIN.indexOf('app.on("activate"'));
  const icon = ready.indexOf("applyDockIcon()");
  const about = ready.indexOf("applyAboutPanel()");
  const start = ready.indexOf("start();");
  assert.notEqual(icon, -1, "the dock icon is applied on a development run");
  assert.notEqual(about, -1, "the About panel is told which app and which version it is");
  assert.notEqual(start, -1);
  assert.ok(icon < start, "the icon comes before the first window, not after it");
  assert.ok(about < start, "…and so do the About facts");

  const code = codeOnly(MAIN);
  // Both are defined and do what they say. `setIcon` and `setAboutPanelOptions` are the two Electron calls that matter;
  // a helper that only logs would satisfy the ordering above while changing nothing on screen.
  assert.match(code, /app\.dock\?\.setIcon\(image\)/, "the dock icon is actually set");
  assert.match(code, /app\.setAboutPanelOptions\(/, "the About panel is actually configured");
  // And the version is the installed package's, not Electron's — the panel is where a reader answers "which version?".
  const aboutBody = balancedBlock(code, code.indexOf("function applyAboutPanel"), "applyAboutPanel");
  assert.match(aboutBody, /applicationVersion: readRunningVersion\(\)/, "the installed package's version, not Electron's");
});
