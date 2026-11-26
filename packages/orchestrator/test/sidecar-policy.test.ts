import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeSidecarPolicy,
  resolveInterpreter,
  resolveInterpreterPath,
  SIDECAR_ENABLE,
  SHARED_TEMP_ROOTS,
  type SidecarSpec,
} from "../src/sidecar-policy.ts";
import { composePolicy, type SessionSpec } from "../src/policy.ts";

/**
 * Two assemblers now exist (ADR-0018), so the guarantee `policy.ts` states — one function derives a
 * session's grant set — has to be restated as something that can fail. Each test below names what it
 * would take to make it pass with the defect present.
 *
 * Fixture placement is a problem here, and the resolution is worth stating: `composeSidecarPolicy` refuses
 * a profile under `/tmp` **by design**, because Safehouse grants every session read/write there. So a
 * fixture under `/tmp` cannot exercise the happy path — the function is right to reject it.
 *
 * `PI_CENTRAL_STATE`-shaped placement is the production answer; for a test, `mkdtemp` under the real
 * `$HOME` is the closest honest equivalent, falling back to `/tmp` only where `$HOME` is not writable
 * (an agent harness: C1 territory). The fallback is named so it cannot silently weaken the happy-path test.
 */
function fixtureRoot(): string | undefined {
  // PI_CENTRAL_TEST_PRIVATE_ROOT lets a caller name a private directory explicitly, which is the only way
  // to exercise the happy path where $HOME is unwritable (an agent harness) and /tmp is refused by design.
  const override = process.env["PI_CENTRAL_TEST_PRIVATE_ROOT"];
  const candidates = override ? [override] : [homedir(), tmpdir()];
  for (const base of candidates) {
    let dir: string;
    try {
      dir = mkdtempSync(join(base, ".pi-central-sidecar-test-"));
    } catch {
      continue;
    }
    // A candidate only counts if the guard would ACCEPT it. Asking the production constant rather than
    // hardcoding the check means the fallback cannot drift from the rule it is working around.
    if (!SHARED_TEMP_ROOTS.some((root) => dir === root || dir.startsWith(`${root}/`))) return dir;
    rmSync(dir, { recursive: true, force: true });
  }
  return undefined;
}

/**
 * The fixture root, or `undefined` when this environment has no private directory to offer.
 *
 * `undefined` produces a LOUD SKIP rather than a crash, and the choice is deliberate. A crash makes
 * `npm test` fail everywhere the constraint holds (an agent harness: no writable `$HOME`, and `/tmp`
 * refused by the guard under test), and a test that cannot run is a test people delete. A skip says so.
 *
 * It is not a silent pass: the skip line names the three ways to give it a directory, and CI sets one.
 */
const workdir = fixtureRoot();
if (workdir !== undefined) process.on("exit", () => rmSync(workdir, { recursive: true, force: true }));

const skipReason =
  workdir === undefined
    ? `# skip: no writable private directory for fixtures (/tmp, /var/folders are readable by every \
session, and $HOME is unwritable here). Set PI_CENTRAL_TEST_PRIVATE_ROOT to a private path.`
    : undefined;
const dir = workdir ?? "/nonexistent";

const base: Omit<SidecarSpec, "id" | "port"> = {
  // Read-only access to the sidecar's own code: without it a source-launched sidecar cannot start at all.
  sidecarCodeDir: join("/nonexistent-code", "orchestrator"),
  profileDir: join(dir, "profile"),
  fragmentDir: join(dir, "policy"),
  safehouse: "safehouse",
  sidecar: "/state/bin/pi-central-sidecar",
  browser: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  listenPort: 47800,
  token: "test-token",
};
const spec = (over: Partial<SidecarSpec> = {}): SidecarSpec => ({
  ...base,
  id: "session-1",
  port: 4173,
  ...over,
});

test("the sidecar launches through safehouse with its own profile and the pinned port", () => {
  if (skipReason) return console.log(skipReason);
  const { launch, isolation, fragmentFile } = composeSidecarPolicy(spec());
  assert.equal(launch.command, "safehouse");
  assert.equal(launch.args[0], "--workdir");
  assert.equal(launch.args[1], join(dir, "profile"));
  assert.ok(launch.args.includes(`--enable=${SIDECAR_ENABLE}`));
  assert.ok(launch.args.includes(`--append-profile=${fragmentFile}`));

  // The sidecar and ITS OWN flags, after the `--`. Each of these was wrong once, and each failed only at
  // runtime: the flags were written before `sidecar.ts` existed, so they named a `--port` the sidecar does not
  // take. A test that only checked "a path appears after --" would have passed throughout.
  const dd = launch.args.indexOf("--");
  assert.equal(launch.args[dd + 1], "/state/bin/pi-central-sidecar");
  const sidecarArgs = launch.args.slice(dd + 2);
  assert.equal(sidecarArgs[0], "--executable");
  assert.equal(sidecarArgs[1], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(sidecarArgs[2], "--profile");
  assert.equal(sidecarArgs[3], join(dir, "profile"));
  assert.equal(sidecarArgs[4], "--origin");
  assert.equal(sidecarArgs[5], "http://localhost:4173");
  assert.match(isolation, /egress=localhost:4173/);
});

test("the fragment is written 0600 and pins the port it was given, per session", () => {
  if (skipReason) return console.log(skipReason);
  const a = composeSidecarPolicy(spec({ id: "a", port: 4173 }));
  const b = composeSidecarPolicy(spec({ id: "b", port: 5173 }));
  assert.notEqual(a.fragmentFile, b.fragmentFile);
  assert.equal(statSync(a.fragmentFile).mode & 0o777, 0o600);
  assert.match(readFileSync(a.fragmentFile, "utf8"), /localhost:4173/);
  assert.match(readFileSync(b.fragmentFile, "utf8"), /localhost:5173/);
  // Two sidecars must not share a port allow, or one reaches the other's dev server.
  assert.ok(!readFileSync(a.fragmentFile, "utf8").includes("localhost:5173"));
});

test("an interpreter that no longer exists falls back to a bare node, and the launch still names one", () => {
  if (skipReason) return console.log(skipReason);
  /*
   * Falsification: revert `resolveInterpreter` to `return plan.sidecar` (or pass `process.execPath` straight to
   * the argv, which is the defect) and the first assertion fails: the launch names the deleted path.
   *
   * The shape is issue #299, and its measured evidence: a Homebrew node revision bump deletes the Cellar directory
   * the orchestrator was started from, and a process that keeps handing out `process.execPath` launches an
   * interpreter that is not there — `env: …/node: No such file or directory`, exit 127.
   */
  const bin = join(dir, "bin-fallback");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "node"), "", { mode: 0o755 });
  const { launch } = composeSidecarPolicy(
    spec({ interpreter: "/opt/homebrew/Cellar/node/26.13.1_3/bin/node", path: `${bin}:/usr/bin` }),
  );
  const separator = launch.args.indexOf("--");
  assert.equal(
    launch.args[separator + 1],
    "node",
    "a bare name, not a hard-coded interpreter: execvp resolves it through the PATH the sidecar is given",
  );
  // The argv shape is unchanged — executable, then its own flags — so only the first word moved.
  assert.deepEqual(launch.args.slice(separator + 2, separator + 4), ["--executable", spec().browser]);
});

test("the fallback's bare node is resolved through the PATH the sidecar itself gets", () => {
  if (skipReason) return console.log(skipReason);
  /*
   * Falsification: compose the child environment from `process.env` (or drop `PATH` from it) and the assertion
   * below fails — the resolution would rely on an environment the sidecar does not receive. `sidecar-policy.ts`
   * records the measured version of this: with no `PATH`, a bare command name is not resolvable at all.
   */
  const bin = join(dir, "bin-env");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "node"), "", { mode: 0o755 });
  const { launch } = composeSidecarPolicy(spec({ interpreter: "/nowhere/node", path: `${bin}:/usr/bin` }));
  assert.equal(launch.args[launch.args.indexOf("--") + 1], "node");
  assert.equal(launch.env?.["PATH"], `${bin}:/usr/bin`, "the bare name must resolve in the child's own PATH");
});

test("an interpreter that exists is used as given, with no lookup beyond it", () => {
  /*
   * Falsification: resolve unconditionally — search `PATH` for a bare `node` even when the recorded path is fine —
   * and the call count fails. The common case does not gain a lookup.
   */
  const asked: string[] = [];
  const resolved = resolveInterpreterPath(
    { sidecar: "/state/bin/pi-central-sidecar", interpreter: "/opt/homebrew/bin/node", path: "/usr/bin" },
    (path) => {
      asked.push(path);
      return true;
    },
  );
  assert.equal(resolved, "/opt/homebrew/bin/node");
  assert.deepEqual(asked, ["/opt/homebrew/bin/node"], "one check, on the recorded path, and no search");
});

test("a sidecar that is its own executable resolves no interpreter at all", () => {
  // Falsification: treat `sidecar` as a script unconditionally and this throws, or returns a `node` path.
  const resolved = resolveInterpreter({
    sidecar: "/state/bin/pi-central-sidecar",
    path: "/usr/bin",
  });
  assert.equal(resolved, "/state/bin/pi-central-sidecar");
});

test("no interpreter anywhere is refused, naming the interpreter and the PATH that was searched", () => {
  /*
   * Falsification: fall back to the recorded path regardless (the defect) and no throw happens; return `undefined`
   * and the argv names an empty string. Either way the reader is told the sidecar died with exit 127 and nothing
   * about the interpreter — which is the warning this refusal replaces (issue #299).
   */
  assert.equal(
    resolveInterpreterPath(
      { sidecar: "/state/bin/sidecar.ts", interpreter: "/gone/node", path: "/nowhere:/elsewhere" },
      () => false,
    ),
    undefined,
    "with nothing on disk the answer is 'nothing', not the path that was remembered",
  );
  assert.throws(
    () => resolveInterpreter({ sidecar: "/state/bin/sidecar.ts", interpreter: "/gone/node", path: "/nowhere" }),
    (error: Error) => {
      assert.match(error.message, /no interpreter for the sidecar/, "the refusal names what is missing");
      assert.match(error.message, /\/gone\/node/, "the path that went missing");
      assert.match(error.message, /\/nowhere/, "and the PATH that was searched, which is where a reader looks next");
      return true;
    },
  );
});

test("a sidecar cannot be given a working directory", () => {
  if (skipReason) return console.log(skipReason);
  const { launch } = composeSidecarPolicy(spec());
  // The absence of a `cwd` PARAMETER is the control; this asserts the argv carries no workdir grant beyond
  // the profile. A `--workdir` pointing at a project would hand the renderer read/write over it.
  const workdirs = launch.args.filter((arg) => arg === "--workdir");
  assert.equal(workdirs.length, 1);
  assert.equal(launch.args[launch.args.indexOf("--workdir") + 1], join(dir, "profile"));
});

test("a profile or fragment under a world-readable temp root is refused", () => {
  for (const root of ["/tmp", "/var/folders/x", "/private/tmp/y", "/private/var/folders/z"]) {
    assert.throws(
      () => composeSidecarPolicy(spec({ profileDir: join(root, "p") })),
      /every session can read and write there/,
      `profileDir ${root} must be refused`,
    );
  }
});

test("an id that is not identifier-shaped is refused", () => {
  for (const id of ["../etc", "a b", "x/y", ""]) {
    assert.throws(() => composeSidecarPolicy(spec({ id })), /unsafe id/, `id ${JSON.stringify(id)}`);
  }
});

test("the sidecar env carries what it needs to run, and no invented secret", () => {
  if (skipReason) return console.log(skipReason);
  const { launch } = composeSidecarPolicy(spec());
  // `spawn` inherits `process.env` when `env` is omitted, which would hand the renderer every ambient secret
  // (C4a/C11). So the object is EXPLICIT and short. Every entry earns its place:
  //
  //   PATH  — without it a bare command name does not resolve, and the sidecar never spawned at all
  //   HOME  — Node refuses to start without one, and it is the sidecar's OWN profile, not the user's home
  //   TOKEN — the MCP bearer token; in the environment rather than the argv because `ps` shows arguments
  //
  // Everything else stays out, including every secret-shaped name a session would legitimately carry.
  assert.ok(launch.env !== undefined, "env must be present, or spawn inherits");
  assert.deepEqual(Object.keys(launch.env).sort(), ["HOME", "PATH", "PI_CENTRAL_SIDECAR_TOKEN"]);
  assert.equal(launch.env["HOME"], join(dir, "profile"), "HOME must be the sidecar profile itself");
  assert.equal(launch.env["PI_CENTRAL_SIDECAR_TOKEN"], "test-token");
  // The token must NOT be on the command line, where any process of the same user can read it.
  assert.ok(!launch.args.join(" ").includes("test-token"), "the token leaks into argv");
  // And the PATH in that object is the one an interpreter is resolved against, so the two cannot drift: a bare
  // `node` found through one PATH and looked for through another is issue #299 with an extra step.
  assert.equal(
    composeSidecarPolicy(spec({ path: "/custom/bin:/usr/bin" })).launch.env?.["PATH"],
    "/custom/bin:/usr/bin",
    "the child's PATH is the one the interpreter resolution used",
  );
});

test("a session can never be given a Chromium feature, and the sidecar is the only assembler that can", () => {
  if (skipReason) return console.log(skipReason);
  // Asking for a browser feature in a session must emit no such token. This is asserted from the caller's
  // side because FORBIDDEN_ENABLE is a filter, not a type: without the entry, the argv would carry it.
  const session: SessionSpec = {
    id: "s1",
    cwd: dir,
    mode: "sandboxed",
    safehouse: "safehouse",
    pi: "pi",
    enable: ["playwright-chrome", "chromium-full", "agent-browser"],
  };
  const { launch } = composePolicy(session);
  const argv = launch.args.join(" ");
  for (const feature of ["playwright-chrome", "chromium-full", "chromium-headless", "agent-browser"]) {
    assert.ok(!argv.includes(feature), `a session must not receive ${feature}: ${argv}`);
  }
});

test("the sidecar's own launch forwards its token, because Safehouse discards the rest", () => {
  if (skipReason) return console.log(skipReason);
  const { launch } = composeSidecarPolicy(spec());
  // C15, one level down. The token is in the spawn environment, and Safehouse runs the wrapped command under
  // `env -i` -- so a variable it was not asked for is discarded and the sidecar starts with no token. Measured:
  // it printed its usage line, and Pi reported only "Nothing is listening".
  assert.ok(
    launch.args.includes("--env-pass=PI_CENTRAL_SIDECAR_TOKEN"),
    "without --env-pass the token never reaches the sidecar",
  );
  // And the name in the flag must match the name in the environment, or the forward delivers nothing.
  assert.ok(
    Object.keys(launch.env).includes("PI_CENTRAL_SIDECAR_TOKEN"),
    "the forwarded name must exist in the environment",
  );
});

test("every safehouse flag precedes the separator, and none leaks to the sidecar", () => {
  if (skipReason) return console.log(skipReason);
  const { launch } = composeSidecarPolicy(spec());
  const separator = launch.args.indexOf("--");
  assert.ok(separator > 0, "the separator must exist");

  const safehouseArgs = launch.args.slice(0, separator);
  const sidecarArgs = launch.args.slice(separator + 1);

  // The defect this holds: `--env-pass` was appended AFTER the separator, so safehouse passed it through as an
  // argument to the sidecar's own command line. node forwarded it, the sidecar rejected it as unknown, and Pi
  // reported "Nothing is listening" -- a bind-failure message for a misplaced argument. Measured once already.
  for (const flag of ["--env-pass=", "--enable=", "--append-profile=", "--add-dirs-ro=", "--workdir"]) {
    assert.ok(
      safehouseArgs.some((arg) => arg.startsWith(flag)),
      `${flag} must be a SAFEHOUSE argument, before the separator`,
    );
    assert.ok(
      !sidecarArgs.some((arg) => arg.startsWith(flag)),
      `${flag} leaked into the sidecar's own argv`,
    );
  }

  // And the reverse: the sidecar's flags must not appear on safehouse's side, where they would be rejected.
  for (const flag of ["--executable", "--profile", "--origin", "--port"]) {
    assert.ok(!safehouseArgs.includes(flag), `${flag} belongs to the sidecar, not to safehouse`);
  }
});
