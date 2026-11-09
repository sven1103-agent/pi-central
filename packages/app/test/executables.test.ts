/**
 * Finding `node`, `pi` and `safehouse` from a GUI launch (issue #214, criterion 2).
 *
 * ## The reported failure this is modelled on
 *
 * Everything works in the terminal and nothing works from the dock. A macOS app gets launchd's `PATH`
 * — `/usr/bin:/bin:/usr/sbin:/sbin` — while the reader's shell has Homebrew's `/opt/homebrew/bin` in it
 * because `.zprofile` put it there. So the check that matters is not "does this file exist"; it is
 * **"does the app see what the shell sees"**.
 *
 * Both halves are asserted, and the second is the one a naive implementation skips:
 *
 *   - with a `PATH` that does not contain the binary, the login shell's answer is used;
 *   - with a login shell that also has nothing, the refusal **names the binary** rather than reporting
 *     a spawn failure — criterion 2 forbids the bare version explicitly.
 *
 * The login shell is injected (`runLoginShell`) so these run with no shell, no `spawn`, and no 10 s
 * timeout: what is being tested is the decision, and the decision is what a real `.zshrc` cannot vary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXECUTABLE_HINTS,
  diagnoseLoginShellLookup,
  isShimDirectory,
  resolveEnvironment,
  resolveExecutable,
  searchPath,
  type LookupContext,
} from "../src/executables.ts";

function scratch(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "pi-central-bin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** An executable-looking file. `existsSync` is the only test `searchPath` applies, deliberately. */
function fakeBinary(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

/** A context whose login shell answers from a fixed map, standing in for `.zprofile`. */
function context(env: Record<string, string>, shellAnswers: Record<string, string | undefined> = {}): LookupContext {
  return {
    env,
    shell: "/bin/zsh",
    runLoginShell: (_shell, name) => shellAnswers[name],
  };
}

test("a binary on PATH wins, and the login shell is not consulted", (t) => {
  // The free path first: a subprocess is not spawned when the app's own view already works.
  const root = scratch(t);
  const bin = fakeBinary(join(root, "homebrew", "bin"), "safehouse");
  let consulted = 0;
  const result = resolveExecutable(
    "safehouse",
    {
      env: { PATH: `${join(root, "homebrew", "bin")}:/usr/bin` },
      shell: "/bin/zsh",
      runLoginShell: () => {
        consulted += 1;
        return "/somewhere/else/safehouse";
      },
    },
    EXECUTABLE_HINTS.safehouse,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.executable.path, bin);
  assert.equal(result.executable.source, "environment");
  assert.equal(consulted, 0, "the login shell must not run when PATH already answered");
});

test("a truncated launchd PATH falls through to the login shell — the dock-click case", (t) => {
  // This is the whole point of the module: `/usr/bin:/bin:/usr/sbin:/sbin` has no Homebrew on it.
  const root = scratch(t);
  const homebrew = fakeBinary(join(root, "homebrew", "bin"), "safehouse");
  const result = resolveExecutable(
    "safehouse",
    context({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, { safehouse: homebrew }),
    EXECUTABLE_HINTS.safehouse,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.executable.path, homebrew);
  assert.equal(result.executable.source, "login-shell");
});

test("an answer the login shell hallucinates is not trusted", () => {
  // `.zshrc` can print anything. A path that does not exist is not an answer, and using it would trade
  // a clear "not found" for a spawn error nobody can explain.
  const result = resolveExecutable(
    "pi",
    context({ PATH: "/usr/bin" }, { pi: "/nowhere/at/all/pi" }),
    EXECUTABLE_HINTS.pi,
  );
  assert.equal(result.ok, false);
});

test("a relative answer is refused: a shell function's name is not a path", () => {
  const result = resolveExecutable(
    "node",
    context({ PATH: "/usr/bin" }, { node: "node" }),
    EXECUTABLE_HINTS.node,
  );
  assert.equal(result.ok, false);
});

test("nothing anywhere names the binary, both places it looked, and the fix", () => {
  const result = resolveExecutable(
    "safehouse",
    context({ PATH: "/usr/bin:/bin" }),
    EXECUTABLE_HINTS.safehouse,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.missing.name, "safehouse");
  // The three things criterion 2 demands, in one sentence: the name, the two places, the action.
  assert.match(result.missing.message, /`safehouse`/);
  assert.match(result.missing.message, /PATH/);
  assert.match(result.missing.message, /login shell/);
  assert.match(result.missing.message, /Install it/);
  // And it must NOT be a bare spawn failure, which is the shape the criterion forbids.
  assert.doesNotMatch(result.missing.message, /failed to spawn/i);
  assert.doesNotMatch(result.missing.message, /ENOENT/);
});

test("an empty PATH is reported as empty rather than as a mystery", () => {
  const result = resolveExecutable("node", context({}), EXECUTABLE_HINTS.node);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.missing.message, /which is empty/);
});

test("no SHELL at all still produces a named refusal instead of throwing", () => {
  const result = resolveExecutable(
    "node",
    { env: { PATH: "/usr/bin" }, shell: undefined, runLoginShell: () => undefined },
    EXECUTABLE_HINTS.node,
  );
  assert.equal(result.ok, false);
});

test("the environment resolves all three, and stops at the first one missing", (t) => {
  const root = scratch(t);
  const bin = join(root, "bin");
  const node = fakeBinary(bin, "node");
  const pi = fakeBinary(bin, "pi");
  const safehouse = fakeBinary(bin, "safehouse");
  const env = { PATH: bin };

  const complete = resolveEnvironment(context(env));
  assert.equal(complete.ok, true);
  if (!complete.ok) return;
  assert.equal(complete.environment.node.path, node);
  assert.equal(complete.environment.pi.path, pi);
  assert.equal(complete.environment.safehouse.path, safehouse);

  // A missing `safehouse` fails the whole resolution rather than starting a window that will render
  // `disconnected` for a reason the reader cannot see — and it still carries what it DID find, so the
  // failure panel can say how far it got.
  const partial = resolveEnvironment(context({ PATH: bin }, {}) as LookupContext);
  assert.equal(partial.ok, true, "the fixture has all three on PATH");

  rmSync(safehouse);
  const missing = resolveEnvironment(context(env));
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.missing.name, "safehouse");
  assert.equal(missing.partial?.node?.path, node);
  assert.equal(missing.partial?.pi?.path, pi);
  assert.equal(missing.partial?.safehouse, undefined);
});

test("searchPath skips empty segments instead of resolving against the cwd", () => {
  // `PATH=::/x` is a real thing (a trailing colon is common), and treating an empty segment as "the
  // current directory" is how a shell-injection-adjacent bug gets in. A shell does that; this must not.
  assert.equal(searchPath("node", "::/definitely/not/here"), undefined);
});

// --- `node_modules/.bin` is not a place to run an agent's tool from ------------------------------
//
// Reported from use: every session failed with `env: …/node_modules/.bin/pi: Operation not permitted`
// (exit 126). The trigger is `npm run app`, which prepends the repo's `node_modules/.bin` to PATH — so
// `pi` resolved to the dependency vendored in this project's devDependencies rather than the one the
// reader installed, and that path then reached every session because Safehouse appends its dev paths to
// the PATH it inherits. Two audiences, one variable.

test("a shim directory is recognised wherever it appears", () => {
  assert.equal(isShimDirectory("/Users/x/project/node_modules/.bin"), true);
  assert.equal(isShimDirectory("node_modules/.bin"), true);
  assert.equal(isShimDirectory("/opt/homebrew/bin"), false);
  assert.equal(isShimDirectory("/Users/x/node_modules/.bin/../bin"), false, "the check is on the entry as written");
});

test("resolution skips the shim and takes the real binary further along PATH", (t) => {
  // The exact shape `npm run app` produces: the shim first, Homebrew second.
  const root = scratch(t);
  fakeBinary(join(root, "repo", "node_modules", ".bin"), "pi");
  const real = fakeBinary(join(root, "homebrew", "bin"), "pi");
  const result = resolveExecutable(
    "pi",
    context({ PATH: `${join(root, "repo", "node_modules", ".bin")}:${join(root, "homebrew", "bin")}` }),
    EXECUTABLE_HINTS.pi,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.executable.path, real, "the shim must not be used even though it is first");
});

test("a name that resolves ONLY to a shim falls through to the login shell", (t) => {
  // The important half. Accepting the shim when nothing else is available would reproduce the exit-126
  // failure one directory later; asking the shell is what finds the globally installed tool.
  const root = scratch(t);
  fakeBinary(join(root, "repo", "node_modules", ".bin"), "pi");
  const real = fakeBinary(join(root, "elsewhere", "bin"), "pi");
  const result = resolveExecutable(
    "pi",
    context({ PATH: join(root, "repo", "node_modules", ".bin") }, { pi: real }),
    EXECUTABLE_HINTS.pi,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.executable.path, real);
  assert.equal(result.executable.source, "login-shell");
});

test("shim-only and no login shell is a refusal, not the shim", (t) => {
  const root = scratch(t);
  fakeBinary(join(root, "repo", "node_modules", ".bin"), "pi");
  const result = resolveExecutable(
    "pi",
    { env: { PATH: join(root, "repo", "node_modules", ".bin") }, shell: "/bin/zsh", runLoginShell: () => undefined },
    EXECUTABLE_HINTS.pi,
  );
  assert.equal(result.ok, false, "a shim is not an answer");
});

// -----------------------------------------------------------------------------------------------------------
// Why the login shell did not answer — reported from a real app launch.
// -----------------------------------------------------------------------------------------------------------

test("the diagnosis carries the reason and what the shell printed", (t) => {
  /*
   * Reported from a Finder launch:
   *
   *   "Pi Central could not find `pi`. It is not on this app's PATH (/usr/bin:/bin:/usr/sbin:/sbin) and the
   *    login shell did not report it either."
   *
   * — while `pi` was at /opt/homebrew/bin/pi and worked in the reader's terminal. "Did not report it" was true
   * and useless: four causes hide behind it, with four different fixes.
   *
   * The first case is the one that produces it in practice: a chatty shell startup file whose LAST line is a banner,
   * because a plugin manager printed after `command -v` had already answered.
   */
  const root = scratch(t);
  const shell = join(root, "fake-shell");
  // A shell that prints a banner last, then exits 0 with no path anywhere.
  writeFileSync(shell, '#!/bin/sh\necho "/opt/homebrew/bin/pi"\necho "Welcome to zsh! p10k loaded"\nexit 0\n');
  chmodSync(shell, 0o755);

  const diagnosis = diagnoseLoginShellLookup(shell, "pi");
  assert.equal(diagnosis.path, undefined, "a banner is not a path");
  assert.notEqual(diagnosis.note, undefined, "the reason is reported, not swallowed");
  assert.match(diagnosis.note ?? "", /not an absolute path/, "and it says WHICH problem it was");
  // The banner is quoted, because seeing it is what tells the reader their shell startup is the cause.
  assert.match(diagnosis.note ?? "", /Welcome to zsh/, "the shell's own output is quoted");
});

test("a non-zero exit is reported with its status and stderr", (t) => {
  const root = scratch(t);
  const shell = join(root, "broken-shell");
  // A `.zshrc` that aborts the shell — a real failure mode, and indistinguishable from "not installed" without this.
  writeFileSync(shell, '#!/bin/sh\necho "compinit: initialization aborted" >&2\nexit 1\n');
  chmodSync(shell, 0o755);

  const diagnosis = diagnoseLoginShellLookup(shell, "pi");
  assert.equal(diagnosis.path, undefined);
  assert.match(diagnosis.note ?? "", /exit 1/, "the exit status is named");
  assert.match(diagnosis.note ?? "", /compinit/, "and stderr is quoted, because that is the diagnosis");
});

test("a shell that answers properly is not annotated", (t) => {
  // The control: a working lookup must stay silent, or the message grows a paragraph for the happy path.
  const root = scratch(t);
  const shell = join(root, "good-shell");
  const pi = join(root, "pi");
  writeFileSync(pi, "#!/bin/sh\n");
  writeFileSync(shell, `#!/bin/sh\necho "a banner"\necho "${pi}"\nexit 0\n`);
  chmodSync(shell, 0o755);

  const diagnosis = diagnoseLoginShellLookup(shell, "pi");
  assert.equal(diagnosis.path, pi, "the last absolute line is the answer, after the banner");
  assert.equal(diagnosis.note, undefined, "and nothing is added to the message");
});

test("a shell that cannot be started says so, rather than reporting a wrong answer", () => {
  const diagnosis = diagnoseLoginShellLookup("/nonexistent/shell", "pi");
  assert.equal(diagnosis.path, undefined);
  assert.match(diagnosis.note ?? "", /could not be started/);
});

test("the failure message carries the diagnosis, not just the absence", () => {
  /*
   * The sentence the reader saw, and what it must become. `resolveExecutable` takes the note through
   * `diagnoseLoginShell` and puts it in the message — this is the assertion that the wiring exists, because a note that
   * is computed and never shown fixes nothing.
   */
  const context: LookupContext = {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    shell: "/bin/zsh",
    runLoginShell: () => undefined,
    diagnoseLoginShell: () => ({ path: undefined, note: "/bin/zsh printed \"Welcome to zsh!\", which is not an absolute path; exit 0" }),
  };
  const resolution = resolveExecutable("pi", context, EXECUTABLE_HINTS.pi);
  assert.equal(resolution.ok, false);
  if (resolution.ok) return;
  assert.match(resolution.missing.message, /Welcome to zsh/, "what the shell printed is in the message");
  assert.match(resolution.missing.message, /not an absolute path/, "and so is the reason");
  // Still names the binary and still gives the fix, which the original message did right.
  assert.match(resolution.missing.message, /`pi`/);
  assert.match(resolution.missing.message, /docs\/AGENT-SETUP\.md/);
});

test("a path the shell reports but the app cannot use is its own sentence", (t) => {
  /*
   * The fourth cause: the shell KNOWS where it is, and the app may not execute or read it. That is a different problem
   * from "not found", and saying "did not report it" about this case is simply false.
   *
   * The reported path is one this test invents under a scratch directory, because a real path like
   * `/opt/homebrew/bin/pi` EXISTS on a machine where the bug happens — and then the lookup succeeds and there is nothing
   * to assert. The point is a path that is absolute and unusable.
   */
  const root = scratch(t);
  const missing = join(root, "does-not-exist", "pi");
  const context: LookupContext = {
    env: { PATH: "/usr/bin:/bin" },
    shell: "/bin/zsh",
    runLoginShell: () => missing,
    diagnoseLoginShell: () => ({ path: missing }),
  };
  const resolution = resolveExecutable("pi", context, EXECUTABLE_HINTS.pi);
  assert.equal(resolution.ok, false);
  if (resolution.ok) return;
  assert.equal(resolution.missing.message.includes(missing), true, "the message names the path the shell reported");
  assert.match(resolution.missing.message, /not an executable file/);
});

test("without the optional diagnosis, the message is exactly what it was", () => {
  // Backwards compatibility for every caller and test that does not supply the hook: the note is absent, not "undefined".
  const context: LookupContext = {
    env: { PATH: "/usr/bin:/bin" },
    shell: "/bin/zsh",
    runLoginShell: () => undefined,
  };
  const resolution = resolveExecutable("pi", context, EXECUTABLE_HINTS.pi);
  assert.equal(resolution.ok, false);
  if (resolution.ok) return;
  assert.match(resolution.missing.message, /asking your login shell did not resolve it\./);
  assert.equal(resolution.missing.message.includes("undefined"), false);
});
