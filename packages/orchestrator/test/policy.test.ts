import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePolicy, describe, type SessionSpec } from "../src/policy.ts";

/**
 * These tests use /tmp for *fixtures only* — the check under test is argv composition, not
 * isolation. (Phase 0 proves isolation; the fixture-placement rule there is about not
 * getting a false pass, which does not apply to an argv assertion.)
 */
const dir = mkdtempSync(join(tmpdir(), "pi-central-policy-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const base: Omit<SessionSpec, "cwd"> = {
  id: "s1",
  mode: "sandboxed",
  safehouse: "safehouse",
  pi: "pi",
};
const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({ ...base, cwd: dir, ...over });

test("sandboxed policy puts safehouse first, the workdir, then the pi command", () => {
  const { launch, isolation } = composePolicy(spec());
  assert.equal(launch.command, "safehouse");
  assert.deepEqual(launch.args, ["--workdir", dir, "--", "pi", "--mode", "rpc"]);
  assert.equal(launch.cwd, dir);
  assert.match(isolation, /Safehouse workdir=/);
});

test("the command after -- is exactly `pi` -- never a caller-supplied string", () => {
  const { launch } = composePolicy(spec());
  const dd = launch.args.indexOf("--");
  assert.equal(launch.args[dd + 1], "pi");
});

test("--name is passed after the pi command, as a pi flag", () => {
  const { launch } = composePolicy(spec({ name: "my session" }));
  assert.deepEqual(launch.args.slice(-4), ["--mode", "rpc", "--name", "my session"]);
});

test("wide-read is refused with a warning and never reaches argv (ADR-0002)", () => {
  const { launch, warnings } = composePolicy(spec({ enable: ["wide-read"] }));
  assert.ok(!launch.args.some((a) => a.includes("wide-read")));
  assert.ok(warnings.some((w) => w.includes("wide-read")));
});

test("a permitted enable survives, and only as a single comma-joined flag", () => {
  const { launch } = composePolicy(spec({ enable: ["docker"] }));
  assert.ok(launch.args.includes("--enable=docker"));
});

test("ssh and keychain are refused: they re-open the credential boundary (ADR-0010)", () => {
  // Verified by policy diff: --enable=ssh appends an SSH integration block granting
  // agent-socket network access; keychain grants keychain RW + SecurityServer mach-lookups.
  for (const feature of ["ssh", "keychain", "cloud-credentials", "cloud-storage"]) {
    const { launch, warnings } = composePolicy(spec({ enable: [feature] }));
    assert.ok(
      !launch.args.some((a) => a.includes(feature)),
      `--enable=${feature} must never reach argv`,
    );
    assert.ok(warnings.some((w) => w.includes(feature)), `${feature} must warn when refused`);
  }
});

test("a refusal still lets the remaining features through", () => {
  const { launch } = composePolicy(spec({ enable: ["ssh", "docker"] }));
  assert.ok(launch.args.includes("--enable=docker"));
  assert.ok(!launch.args.some((a) => a.includes("ssh")));
});

test("a forbidden flag is refused outright, not warned about", () => {
  // The flags are not reachable through the typed API; the assertion is that if one were
  // smuggled into the assembled args, composePolicy throws rather than spawning.
  const { launch } = composePolicy(spec());
  assert.ok(!launch.args.includes("--allow-profile-writes"));
  assert.ok(!launch.args.includes("--allow-workdir-config-writes"));
});

test("--env-pass is never used: it cannot remove a variable (C4a)", () => {
  // The flag merges append-only into Safehouse's allowlist, which already contains
  // SSH_AUTH_SOCK. Env control lives in env.ts instead, so the flag must not appear.
  const { launch } = composePolicy(spec());
  assert.ok(!launch.args.some((a) => a.startsWith("--env-pass")));
  assert.ok(!launch.args.some((a) => a.startsWith("--env=")));
});

test("the session environment is sanitized and never inherits process.env (C11)", () => {
  // A planted secret in the parent must not reach the session.
  process.env.PI_CENTRAL_TEST_SECRET = "leaked-value-123";
  try {
    const { launch } = composePolicy(spec());
    assert.equal(launch.env["PI_CENTRAL_TEST_SECRET"], undefined);
    assert.equal(launch.env["SSH_AUTH_SOCK"], undefined);
  } finally {
    delete process.env.PI_CENTRAL_TEST_SECRET;
  }
});

test("injected credentials reach the session, and the host ssh-agent cannot", () => {
  const { launch } = composePolicy(spec({ env: { GH_TOKEN: "agent-token" } }));
  assert.equal(launch.env["GH_TOKEN"], "agent-token");
  assert.equal(launch.env["SSH_AUTH_SOCK"], undefined);
  assert.throws(
    () => composePolicy(spec({ env: { SSH_AUTH_SOCK: "/tmp/evil.sock" } })),
    /ssh-agent/,
  );
});

test("a policy fragment is written 0600 and passed as --append-profile (ADR-0010)", () => {
  const fragmentDir = join(dir, "policy");
  const { launch, fragmentFile, isolation } = composePolicy(
    spec({ policyFragment: ";; test fragment\n(deny file-read*)\n", fragmentDir }),
  );
  assert.ok(fragmentFile, "the fragment path is surfaced");
  assert.ok(launch.args.includes(`--append-profile=${fragmentFile}`));
  assert.match(isolation, /bespoke-fragment/);
  assert.equal(statSync(fragmentFile!).mode & 0o777, 0o600);
});

test("no fragment means no --append-profile at all", () => {
  const { launch, fragmentFile } = composePolicy(spec());
  assert.equal(fragmentFile, undefined);
  assert.ok(!launch.args.some((a) => a.startsWith("--append-profile")));
});

test("a fragment without a directory is refused rather than silently dropped", () => {
  assert.throws(
    () => composePolicy(spec({ policyFragment: ";; x\n" })),
    /needs a fragmentDir/,
  );
  assert.throws(() => composePolicy(spec({ fragmentDir: join(dir, "p") })), /without a policyFragment/);
});

test("direct mode applies no safehouse and says so loudly", () => {
  const { launch, isolation, warnings } = composePolicy(spec({ mode: "direct" }));
  assert.equal(launch.command, "pi");
  assert.deepEqual(launch.args, ["--mode", "rpc"]);
  assert.match(isolation, /NONE/);
  assert.ok(warnings.some((w) => w.includes("no Safehouse policy")));
});

test("a missing directory is refused before anything is spawned (US-5, D-4)", () => {
  assert.throws(() => composePolicy(spec({ cwd: join(dir, "does-not-exist") })), /does not exist/);
});

test("a path that is not a directory is refused", () => {
  const file = join(dir, "a-file");
  writeFileSync(file, "x");
  assert.throws(() => composePolicy(spec({ cwd: file })), /not a directory/);
});

test("composePolicy is deterministic: same input, identical argv", () => {
  assert.deepEqual(composePolicy(spec()).launch.args, composePolicy(spec()).launch.args);
});

test("describe renders a reviewable command string", () => {
  assert.equal(describe(composePolicy(spec())), `safehouse --workdir ${dir} -- pi --mode rpc`);
});
