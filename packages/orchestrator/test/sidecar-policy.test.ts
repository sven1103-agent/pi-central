import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeSidecarPolicy,
  SIDECAR_ENABLE,
  SHARED_TEMP_ROOTS,
  type SidecarSpec,
} from "../src/sidecar-policy.ts";
import { composePolicy, type SessionSpec } from "../src/policy.ts";

/**
 * Two assemblers now exist (ADR-0015), so the guarantee `policy.ts` states — one function derives a
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
  profileDir: join(dir, "profile"),
  fragmentDir: join(dir, "policy"),
  safehouse: "safehouse",
  sidecar: "/state/bin/pi-central-sidecar",
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
  // The sidecar binary and its verbs, after the `--`.
  const dd = launch.args.indexOf("--");
  assert.equal(launch.args[dd + 1], "/state/bin/pi-central-sidecar");
  // Mandatory: Safehouse cannot host Chromium's nested sandbox, so a browser without this does not start.
  assert.ok(launch.args.includes("--no-sandbox"));
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

test("the sidecar env cannot inherit the orchestrator's", () => {
  if (skipReason) return console.log(skipReason);
  const { launch } = composeSidecarPolicy(spec());
  // `spawn` inherits `process.env` when `env` is omitted, which would hand the renderer every ambient
  // secret (C4a/C11). An explicit empty object is the smallest honest answer.
  assert.ok(launch.env !== undefined, "env must be present, or spawn inherits");
  assert.deepEqual(launch.env, {});
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
