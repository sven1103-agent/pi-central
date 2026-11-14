/**
 * The orchestrator's one OS action (issue #255, ADR-0014).
 *
 * ## What this file has to prove, and why each proof can fail
 *
 * The action's safety is *not* a new check: it is `resolveWithin`, reused. So the tests that matter are
 * the ones that would fail if that reuse were replaced by a second implementation — which is exactly the
 * way this capability would go wrong, because a second implementation starts out equivalent and drifts.
 *
 * ## No test opens a Finder window
 *
 * Every test that reaches the spawn passes a **fake launcher**: a small shell script that appends its
 * argv to a temp file and exits. A test that called `/usr/bin/open` would be an unrequested OS action on
 * a developer's machine and would open a window on every CI run that has a `HOME`. `openPath` is a
 * function parameter rather than an environment variable for the reason the module documents: a
 * configurable launcher path is a configurable command, and a config file may not widen the sandbox.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revealArgv, revealInFileManager } from "../src/os-actions.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-central-osactions-")));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

/** A fresh root per test, so one test's fixtures cannot affect another's assertions. */
function makeRoot(name: string): string {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  return root;
}

function write(dir: string, relative: string, contents: string = "x"): string {
  const full = join(dir, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
  return full;
}

/**
 * A launcher that records the argv it was given, then exits with `code`.
 *
 * A real executable rather than a stub object: the property under test is the ARGV a child process
 * receives, and a fake `spawn` would be testing the fake. Shell rather than a Node script so the spawn
 * does not pay a Node startup per assertion.
 */
function recorder(dir: string, code = 0): { path: string; argv: () => string[] } {
  const log = join(dir, `argv-${Math.random().toString(36).slice(2)}.txt`);
  const path = join(dir, `open-${Math.random().toString(36).slice(2)}.sh`);
  /*
   * Each argument on its own line, so an argument containing spaces cannot be confused with two — and
   * written to a temporary name then renamed, so the reader can never observe half an argv. It did: the
   * polling reader below occasionally read after one of four writes and reported a truncated argv, which
   * failed the assertion for a reason that had nothing to do with the property under test.
   */
  writeFileSync(
    path,
    `#!/bin/sh\n: > '${log}.tmp'\nfor arg in "$@"; do printf '%s\\n' "$arg" >> '${log}.tmp'; done\nmv '${log}.tmp' '${log}'\nexit ${code}\n`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    argv: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : []),
  };
}

/** Wait for the detached child to have written its argv. Polls, because the spawn is asynchronous. */
async function settled(read: () => string[], timeoutMs = 5_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value.length > 0) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// --- containment is REUSED --------------------------------------------------------------------------

test("an escaping relative path is refused with `escapes-cwd` and nothing is spawned", async () => {
  // The falsifier: replace `resolveWithin(root, relative)` with `resolve(join(root, relative))` and this
  // test sees a spawn. That is the whole point of the reuse — a second containment implementation would
  // start out agreeing with this one and eventually not.
  const root = makeRoot("escape");
  write(root, "here.txt");
  const open = recorder(root);
  const result = revealInFileManager(root, "../outside.txt", { openPath: open.path, platform: "darwin" });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.reason, "escapes-cwd");
  // Nothing was launched. Asserted after a beat, because a spawn would be asynchronous if it happened.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(open.argv(), [], "a refused path must not reach the launcher");
});

test("an absolute path and a NUL byte keep their own reasons, not the escape's", async () => {
  // Both are refused by `resolveWithin` before the disk is touched, and both must keep the reason a READ
  // gives them — "outside the working directory" would name a place the path never reached.
  const root = makeRoot("reasons");
  write(root, "here.txt");
  const open = recorder(root);
  const absolute = revealInFileManager(root, "/etc/passwd", { openPath: open.path, platform: "darwin" });
  assert.equal(absolute.ok === false && absolute.error.reason, "absolute-path");
  const nul = revealInFileManager(root, "a\0b", { openPath: open.path, platform: "darwin" });
  assert.equal(nul.ok === false && nul.error.reason, "invalid-path");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(open.argv(), []);
});

test("a symlink pointing out of the tree is refused", () => {
  // The `realpath` containment pass, exercised through the action rather than through `files.ts`. Drop that
  // pass and a link inside the tree resolves to a target outside and this test sees `ok: true`.
  const root = makeRoot("symlink");
  write(root, "inside.txt");
  const outside = join(base, "symlink-outside.txt");
  writeFileSync(outside, "not mine\n");
  symlinkSync(outside, join(root, "escape.txt"));
  const open = recorder(root);
  const result = revealInFileManager(root, "escape.txt", { openPath: open.path, platform: "darwin" });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.reason, "escapes-cwd");
});

// --- the argv is a fixed shape ----------------------------------------------------------------------

test("argv is exactly `-g -R -- <resolved path>`: no application flag, and the path is the resolved one", async () => {
  // Three properties in one assertion, because they fail together: an added `-a` selects an application, a
  // removed `--` makes a filename parseable as a flag, and a client spelling would hand the launcher a
  // string the containment check never validated.
  const root = makeRoot("argv");
  write(root, "src/a.txt");
  const open = recorder(root);
  const result = revealInFileManager(root, "src/a.txt", { openPath: open.path, platform: "darwin" });
  assert.equal(result.ok, true);
  const argv = await settled(open.argv);
  assert.deepEqual(argv, revealArgv(join(root, "src/a.txt")));
  // The literal, asserted rather than compared to the exporter: a reordering of `revealArgv` must fail.
  assert.deepEqual(argv, ["-g", "-R", "--", join(root, "src/a.txt")]);
  assert.ok(!argv.includes("-a") && !argv.includes("-b"), "no flag may name an application");
});

test("a file whose name begins with `-` is revealed rather than parsed as a flag", async () => {
  // The measured case: `open -R -e` is the TextEdit flag, not a file called `-e`. The `--` is what makes
  // this a filename — and the test asserts the argv so REMOVING `--` fails here rather than being masked by
  // the argument already being absolute.
  const root = makeRoot("dashname");
  write(root, "-e");
  const open = recorder(root);
  const result = revealInFileManager(root, "-e", { openPath: open.path, platform: "darwin" });
  assert.equal(result.ok, true);
  const argv = await settled(open.argv);
  assert.deepEqual(argv, ["-g", "-R", "--", join(root, "-e")]);
});

// --- refusals decided before the spawn --------------------------------------------------------------

test("a file deleted between listing and reveal is `not-found`, with no spawn", async () => {
  // What must be true: the reader is told the file is gone, and nothing is launched. What this does NOT
  // prove: that the pre-spawn `lstat` is what refuses it. Measured — `resolveWithin`'s `realpathSync`
  // already answers `not-found` for a deleted path, so removing the `lstat` leaves this test green. It is
  // written down rather than presented as a falsifier it is not; the `lstat` covers the narrower window
  // between that `realpath` and the spawn, which has no deterministic seam.
  const root = makeRoot("deleted");
  write(root, "gone.txt");
  const open = recorder(root);
  // Resolved first so `resolveWithin` succeeds, then removed: the window between listing and clicking.  assert.equal(revealInFileManager(root, "gone.txt", { openPath: open.path, platform: "darwin" }).ok, true);
  rmSync(join(root, "gone.txt"));
  // A second file keeps the root resolvable, so the refusal is about the entry rather than the root.
  write(root, "still-here.txt");
  const second = revealInFileManager(root, "gone.txt", { openPath: open.path, platform: "darwin" });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.error.reason, "not-found");
  assert.equal(second.ok === false && second.error.code, "ENOENT");
});

test("a non-darwin platform is `unsupported-platform`, not an ENOENT", () => {
  // The orchestrator runs on Linux in CI and C10 makes macOS the only supported platform for the sandboxed
  // mode. Refusing with a reason is better than a spawn failure that reads as a missing file — and the
  // reason is what the UI turns into "Cannot show in Finder here".
  const root = makeRoot("platform");
  write(root, "a.txt");
  const open = recorder(root);
  const result = revealInFileManager(root, "a.txt", { openPath: open.path, platform: "linux" });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.reason, "unsupported-platform");
  assert.match(result.ok === false ? result.error.message : "", /linux/);
  assert.deepEqual(open.argv(), [], "a wrong platform must not spawn anything");
});

test("a spawn `ENOENT` (missing launcher) is a reported refusal, not a crash", async () => {
  // Node reports a spawn failure on an asynchronous `error` event. With no listener that is an unhandled
  // `error` event, which EXITS the process — so a launcher that has gone missing would take the orchestrator
  // and every session with it. The callback is where the refusal goes.
  const root = makeRoot("enolauncher");
  write(root, "a.txt");
  const errors: { reason: string; code?: string | undefined; message: string }[] = [];
  const result = revealInFileManager(root, "a.txt", {
    openPath: join(base, "no-such-launcher-xyz"),
    platform: "darwin",
    onLaunchError: (error) => errors.push(error),
  });
  assert.equal(result.ok, true, "the refusal is decided asynchronously, so the call itself returns");
  const deadline = Date.now() + 5_000;
  while (errors.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(errors.length, 1, "the spawn failure must be reported exactly once");
  assert.equal(errors[0]?.reason, "unreadable");
  assert.equal(errors[0]?.code, "ENOENT");
});

test("a launcher that exits non-zero is a CONFIRMED failure, and exits zero is not a success claim", async () => {
  // ADR-0014 rule 6: `open` returns 0 once launchd has accepted the request, which is not evidence that
  // Finder displayed anything. So zero reports nothing, and a non-zero is the only outcome worth stating.
  const root = makeRoot("exitcode");
  write(root, "a.txt");
  const failing = recorder(root, 1);
  const failures: string[] = [];
  revealInFileManager(root, "a.txt", {
    openPath: failing.path,
    platform: "darwin",
    onLaunchError: (error) => failures.push(error.message),
  });
  const deadline = Date.now() + 5_000;
  while (failures.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(failures.length, 1, "a non-zero exit is reported");
  assert.match(failures[0] ?? "", /exit 1/);

  const succeeding = recorder(root, 0);
  const quiet: string[] = [];
  assert.equal(
    revealInFileManager(root, "a.txt", {
      openPath: succeeding.path,
      platform: "darwin",
      onLaunchError: (error) => quiet.push(error.message),
    }).ok,
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(quiet, [], "a zero exit must not be reported as success, and must not be a failure");
});

test("the launcher is `unref`ed, so a slow Finder cannot hold the orchestrator open", () => {
  // A `detached` spawn that is not `unref`ed keeps the event loop alive: Node reports it as a
  // `ProcessWrap`, and a slow Finder would hold the process — and every session — open. Measured: a
  // detached `sleep 2` without `unref` leaves one `ProcessWrap` active, and with it leaves none.
  const root = makeRoot("detached");
  write(root, "a.txt");
  const slow = join(root, "slow-sh.sh");
  writeFileSync(slow, "#!/bin/sh\nsleep 2\n");
  chmodSync(slow, 0o755);

  const wraps = () => process.getActiveResourcesInfo().filter((name) => name === "ProcessWrap").length;
  const before = wraps();
  assert.equal(revealInFileManager(root, "a.txt", { openPath: slow, platform: "darwin" }).ok, true);
  assert.equal(wraps(), before, "a detached child must not keep this process alive");
});

// --- a legitimate path still works ------------------------------------------------------------------

test("a directory and an ordinary file both reveal, so the refusals are not refusing everything", async () => {
  // The falsifier for the negative tests above: a check that refuses too much is a bug the refusals cannot
  // see. A directory is the ordinary case — the tree's rows are mostly directories.
  const root = makeRoot("works");
  write(root, "docs/readme.md");
  const open = recorder(root);
  assert.equal(revealInFileManager(root, "docs", { openPath: open.path, platform: "darwin" }).ok, true);
  const argv = await settled(open.argv);
  assert.deepEqual(argv, ["-g", "-R", "--", join(root, "docs")]);
});
