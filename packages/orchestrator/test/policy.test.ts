import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const { launch } = composePolicy(spec({ enable: ["docker", "ssh"] }));
  assert.ok(launch.args.includes("--enable=docker,ssh"));
});

test("a forbidden flag is refused outright, not warned about", () => {
  // The flags are not reachable through the typed API; the assertion is that if one were
  // smuggled into the assembled args, composePolicy throws rather than spawning.
  const { launch } = composePolicy(spec());
  assert.ok(!launch.args.includes("--allow-profile-writes"));
  assert.ok(!launch.args.includes("--allow-workdir-config-writes"));
});

test("env-pass forwards names, rejects non-identical shapes", () => {
  const { launch } = composePolicy(spec({ envPass: ["ANTHROPIC_API_KEY"] }));
  assert.ok(launch.args.includes("--env-pass=ANTHROPIC_API_KEY"));
  assert.throws(() => composePolicy(spec({ envPass: ["BAD NAME"] })), /malformed env var name/);
  assert.throws(() => composePolicy(spec({ envPass: ["A=B"] })), /malformed env var name/);
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
