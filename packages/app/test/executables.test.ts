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
