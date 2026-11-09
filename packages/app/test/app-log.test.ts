/**
 * Diagnostics that survive being launched from Finder (issue #218).
 *
 * ## The gap, reported from use
 *
 * > the terminal shows nothing, since it is an app
 *
 * Every diagnostic in `main.ts` is a `console.log` or `console.error`. That is right for `npm run app` — the shell has a
 * terminal and echoing there is free — and useless for the installed bundle, whose `stdout` goes nowhere. So when `⌘Q`
 * looped for ever, the line that named it had been written several times a second:
 *
 *     Pi Central: the orchestrator did not stop within 5000 ms; quitting anyway
 *
 * and there was nowhere to read it.
 *
 * Asking a reader to launch the `.app` from a shell is not a workaround: a Finder launch has launchd's environment, not
 * their shell's, and that difference produced three separate bugs in this increment (the `PATH`, the missing `SHELL`,
 * and the aliased `pi`). The log is a file so the diagnostic can be read where the bug happens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEPT_LOG_FILES,
  MAX_LOG_BYTES,
  formatLine,
  logPath,
  openLogWriter,
  rotateIfNeeded,
  teeConsole,
  type ConsoleLike,
} from "../src/app-log.ts";

function scratch(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "pi-central-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// -----------------------------------------------------------------------------------------------------------
// The format, which is what makes a log readable.
// -----------------------------------------------------------------------------------------------------------

test("every line starts with a sortable timestamp at a fixed width", () => {
  /*
   * The property that makes a five-second loop visible AS a loop: consecutive lines must sort and align. Without a
   * timestamp the repeated line above proves nothing except that it happened.
   */
  const at = new Date("2026-11-09T14:03:07.123Z");
  const line = formatLine("log", ["Pi Central: trying again"], at);
  assert.match(line, /^2026-11-09 14:03:07\.123 LOG {3}Pi Central: trying again\n$/);
  // The level is padded, so the message column does not move between lines.
  assert.equal(formatLine("error", ["x"], at).slice(24, 29), "ERROR");
  assert.equal(formatLine("warn", ["x"], at).slice(24, 29), "WARN ");
});

test("an Error contributes its message AND its stack", () => {
  // The stack is the only thing that explains the failures this log exists to capture.
  const error = new Error("the socket died");
  const line = formatLine("error", [error], new Date("2026-11-09T00:00:00.000Z"));
  assert.match(line, /Error: the socket died/);
  assert.match(line, /app-log|at /, "the stack is included");
});

test("several arguments are joined, and odd values do not throw", () => {
  const at = new Date("2026-11-09T00:00:00.000Z");
  assert.match(formatLine("log", ["a", 1, { b: 2 }], at), /a 1 \{"b":2\}/);
  assert.match(formatLine("log", [undefined, null], at), /undefined null/);
  // A circular object is not worth failing a log line over.
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  assert.doesNotThrow(() => formatLine("log", [circular], at));
});

// -----------------------------------------------------------------------------------------------------------
// The tee: the console still works, and the file gets a copy.
// -----------------------------------------------------------------------------------------------------------

test("the console is still written to, and the file gets the same content", () => {
  /*
   * `console` first, file second, deliberately: a slow or failing disk must not change what an `npm run app` session
   * prints, and a write failure must degrade to "terminal only" rather than to silence.
   */
  const lines: string[] = [];
  const console_: ConsoleLike & { log: (...args: unknown[]) => void } = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const seen: string[] = [];
  console_.log = (...args: unknown[]) => seen.push(args.join(" "));

  const detach = teeConsole(console_, (line) => lines.push(line), () => new Date("2026-11-09T00:00:00.000Z"));
  console_.log("hello", 42);
  detach();

  assert.deepEqual(seen, ["hello 42"], "the console still received it");
  assert.equal(lines.length, 1, "and the file did");
  assert.match(lines[0] ?? "", /LOG {3}hello 42/);
});

test("a write that throws does not break the console", () => {
  // A log that throws inside `console.error` during an error path is how a diagnostic becomes a second fault.
  const seen: string[] = [];
  const console_: ConsoleLike = {
    log: () => undefined,
    warn: () => undefined,
    error: (...args: unknown[]) => seen.push(args.join(" ")),
  };
  const detach = teeConsole(console_, () => {
    throw new Error("disk full");
  });
  assert.doesNotThrow(() => console_.error("still reported", "here"));
  detach();
  assert.deepEqual(seen, ["still reported here"]);
});

test("detaching restores the console exactly", () => {
  // The app never detaches, but the test does — and a tee that cannot be removed would make every later test in the file
  // write to a closed-over array.
  const original = (): void => undefined;
  const console_: ConsoleLike = { log: original, warn: original, error: original };
  const detach = teeConsole(console_, () => undefined);
  assert.notEqual(console_.log, original);
  detach();
  assert.equal(console_.log, original);
  assert.equal(console_.warn, original);
  assert.equal(console_.error, original);
});

// -----------------------------------------------------------------------------------------------------------
// The file: header, rotation, and a path that cannot be written.
// -----------------------------------------------------------------------------------------------------------

test("a run gets a header, so several launches in one file can be told apart", (t) => {
  const root = scratch(t);
  const logs = join(root, "Logs", "Pi Central");
  const writer = openLogWriter(logs);
  assert.notEqual(writer, undefined);
  if (writer === undefined) return;

  assert.equal(writer.path, logPath(logs));
  const first = readFileSync(writer.path, "utf8");
  assert.match(first, /===== Pi Central started \d{4}-\d\d-\d\dT/, "the launch is marked");

  // A second launch appends ITS header rather than replacing the file.
  const second = openLogWriter(logs);
  assert.notEqual(second, undefined);
  const text = readFileSync(writer.path, "utf8");
  assert.equal((text.match(/===== Pi Central started/g) ?? []).length, 2, "both launches are in the file");
});

test("the log rotates, and keeps a bounded number of files", (t) => {
  /*
   * A loop like the `⌘Q` one fills a file in seconds, so an unbounded log is a disk problem rather than a diagnostic.
   * The bound is asserted by filling past it and checking the generations.
   */
  const root = scratch(t);
  const path = join(root, "main.log");
  writeFileSync(path, "x".repeat(MAX_LOG_BYTES + 10), "utf8");

  rotateIfNeeded(path);
  assert.equal(existsSync(path), false, "the full file was moved aside");
  assert.equal(existsSync(`${path}.1`), true, "to generation 1");

  // Fill generation 1 as well, and rotate again: it moves to 2.
  writeFileSync(path, "y".repeat(MAX_LOG_BYTES + 10), "utf8");
  rotateIfNeeded(path);
  assert.equal(existsSync(`${path}.2`), true);
  assert.equal(existsSync(`${path}.1`), true);

  // Beyond the kept count, the oldest is dropped rather than accumulating.
  for (let index = 0; index < KEPT_LOG_FILES + 2; index += 1) {
    writeFileSync(path, "z".repeat(MAX_LOG_BYTES + 10), "utf8");
    rotateIfNeeded(path);
  }
  assert.equal(existsSync(`${path}.${KEPT_LOG_FILES + 1}`), false, "nothing beyond the kept count");
});

test("rotation is skipped below the bound, and a missing file is not an error", (t) => {
  const root = scratch(t);
  const path = join(root, "main.log");
  // No file yet.
  assert.doesNotThrow(() => rotateIfNeeded(path));
  // A small file stays.
  writeFileSync(path, "a few lines\n", "utf8");
  rotateIfNeeded(path);
  assert.equal(readFileSync(path, "utf8"), "a few lines\n");
  assert.equal(statSync(path).size, 12);
});

test("a log directory that cannot be written degrades to console-only", (t) => {
  /*
   * The app must still start. A missing log is a loss of diagnostics, not a reason to fail to launch — and the reader
   * whose home directory is read-only is in more trouble than a missing log file.
   */
  const root = scratch(t);
  const blocker = join(root, "not-a-directory");
  writeFileSync(blocker, "this is a file", "utf8");
  // A path whose parent is a FILE cannot be created as a directory.
  const writer = openLogWriter(join(blocker, "Logs"));
  assert.equal(writer, undefined);
});

test("the writer appends rather than truncating", (t) => {
  const root = scratch(t);
  const logs = join(root, "Logs");
  const writer = openLogWriter(logs);
  assert.notEqual(writer, undefined);
  if (writer === undefined) return;
  writer.write("first\n");
  writer.write("second\n");
  const text = readFileSync(writer.path, "utf8");
  assert.match(text, /first\nsecond\n$/);
});

test("a log line written through the writer lands in the file with a timestamp", (t) => {
  // The end-to-end shape: `console.log` -> tee -> writer -> file, which is the path a real diagnostic takes.
  const root = scratch(t);
  const writer = openLogWriter(join(root, "Logs"));
  assert.notEqual(writer, undefined);
  if (writer === undefined) return;
  const console_: ConsoleLike = { log: () => undefined, warn: () => undefined, error: () => undefined };
  const detach = teeConsole(console_, writer.write);
  // The exact line the reported bug produced, once per five seconds.
  console_.error("Pi Central: the orchestrator did not stop within 5000 ms; quitting anyway");
  detach();

  const text = readFileSync(writer.path, "utf8");
  assert.match(text, /ERROR Pi Central: the orchestrator did not stop within 5000 ms; quitting anyway/);
  // And it is greppable, which is what "paste me the log" needs.
  assert.equal(text.split("\n").filter((line) => line.includes("did not stop within")).length, 1);
});

// -----------------------------------------------------------------------------------------------------------
// The wiring, which is the part a module test cannot see.
// -----------------------------------------------------------------------------------------------------------

test("the app installs the tee before anything else can log", () => {
  /*
   * The gap this closes has been repeated three times in this increment: a correct module, a correct test, and a wiring
   * line that was never added (or was removed by a later edit). The `pi` alias, the `⌘Q` loop, and this all shipped as
   * "the logic is right, the connection is missing".
   *
   * So the connection is asserted: `main.ts` must call `teeConsole`, and the call must come BEFORE `app.setName` — the
   * log path is derived from the app's name, and anything that logs during startup must already be captured.
   */
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const tee = main.indexOf("teeConsole(console");
  const setName = main.indexOf('app.setName("Pi Central")');
  assert.notEqual(tee, -1, "the app tees the console to a file");
  assert.notEqual(setName, -1);
  assert.ok(tee < setName, "the tee is installed before the app name settles the log directory");
  // And the writer is derived from the app's own logs directory, not a hand-built path.
  assert.match(main, /openLogWriter\(app\.getPath\("logs"\)\)/);
});

test("the log is reachable from the menu, so the reader never needs the path", () => {
  // A path in a document is a path nobody finds. Two menu items: reveal it in Finder, and open it.
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(main.includes('label: "Reveal Log in Finder"'), true);
  assert.equal(main.includes("showItemInFolder"), true);
  // Disabled when there is no writer, rather than a menu item that does nothing.
  assert.match(main, /enabled: logWriter !== undefined/);
});
