import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkResumable } from "../src/resume.ts";

// Imported lazily by the test that needs it, like `supervisor-files.test.ts`: constructing a Supervisor spawns nothing
// until `start`/`resume` is called, and this file is otherwise pure.
const { Supervisor } = await import("../src/supervisor.ts");

const root = mkdtempSync(join(tmpdir(), "pi-central-resume-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

test("an existing readable directory is resumable", () => {
  const dir = join(root, "worktree");
  mkdirSync(dir, { recursive: true });
  const result = checkResumable({ cwd: dir, path: "/sessions/a.jsonl" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.cwd, dir);
});

test("a missing directory is refused with an actionable message (US-5)", () => {
  // The common real case: a finished worktree, an unmounted volume, a moved checkout.
  const result = checkResumable({ cwd: join(root, "gone-worktree"), path: "/sessions/b.jsonl" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "missing-directory");
    assert.match(result.message, /no longer exists/);
    // The message must state the remedy, since Pi Central never retargets (ADR-0008).
    assert.match(result.message, /does not move a session between directories/);
  }
});

test("a path that is a file, not a directory, is refused distinctly", () => {
  const file = join(root, "a-file");
  writeFileSync(file, "x");
  const result = checkResumable({ cwd: file, path: "/sessions/c.jsonl" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not-a-directory");
});

test("a session with no recorded cwd is refused as unknown-cwd", () => {
  // Old sessions can have an empty cwd. A sandbox cannot be composed for none, and guessing
  // would grant a policy over a directory the session never used.
  const result = checkResumable({ cwd: "", path: "/sessions/d.jsonl" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unknown-cwd");
    assert.match(result.message, /does not record the directory/);
  }
});

test("the returned cwd is resolved, so callers compose policy against a canonical path", () => {
  const dir = join(root, "nested", "..", "nested");
  mkdirSync(join(root, "nested"), { recursive: true });
  const result = checkResumable({ cwd: dir, path: "/sessions/e.jsonl" });
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(!result.cwd.includes(".."));
});

test("a permission failure is not reported as a missing directory", () => {
  // Observed in practice: an EACCES on an ancestor directory was reported as "no longer exists",
  // sending the reader off to restore a directory that was present and fine. The error CODE
  // decides the message, and `unreadable` existed as a blocker that no branch could produce.
  //
  // Built rather than borrowed: a directory with no permission bits, so entering it is refused and
  // `statSync` on its child fails with EACCES. A path like /root would make the test depend on how
  // the machine happens to be configured, and would silently assert nothing when it did not fail.
  const blocked = mkdtempSync(join(tmpdir(), "pi-central-blocked-"));
  const inner = join(blocked, "inner");
  mkdirSync(inner);
  chmodSync(inner, 0o000);
  try {
    const result = checkResumable({ cwd: join(inner, "child"), path: "/s.jsonl" });
    if (result.ok) return; // running as root, where permissions are not enforced — nothing to assert
    assert.equal(result.reason, "unreadable", `expected a permission failure, got ${result.reason}`);
    assert.match(result.message, /cannot be read/);
    assert.ok(!result.message.includes("no longer exists"), "a present directory must not be called missing");
  } finally {
    chmodSync(inner, 0o700);
    rmSync(blocked, { recursive: true, force: true });
  }
});

test("a genuinely absent directory still says so", () => {
  const missing = checkResumable({ cwd: "/definitely/not/here/at/all", path: "/s.jsonl" });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing-directory");
  assert.match(missing.message, /no longer exists/);
  assert.match(missing.message, /does not move a session between directories/);
});

/**
 * A session with no transcript is RESUMABLE, as a fresh start (reported from use).
 *
 * Pi reports `sessionFile` from `get_state` — the path it will write — and creates the file lazily, on the first
 * message. So a session stopped before it was ever prompted has a handle, a cwd and a path, and nothing on disk.
 *
 * Resuming it used to fail with `no such session: <path>`, which reads as data loss for a session the reader had just
 * deliberately stopped: *"when i want to resume a session i have just stoppend, i get an error"*. Nothing is lost by
 * starting fresh — there was never a transcript — and the alternative is a rail entry that can only be deleted.
 */
test("resuming an entry whose transcript was never written starts fresh instead of refusing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-central-no-transcript-"));
  try {
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    // A path inside the store that does not exist — exactly what Pi reports for an unprompted session.
    const missing = join(root, "sessions", "--work--", "2026-11-04T09-55-54-630Z_abc.jsonl");
    mkdirSync(join(root, "sessions"), { recursive: true });
    assert.equal(existsSync(missing), false, "the fixture is the point: no file");

    const supervisor = new Supervisor({
      workspaceRoot: join(root, "w"),
      stateRoot: join(root, "s"),
      sessionsRoot: join(root, "sessions"),
      safehouse: "safehouse-not-present",
      pi: "pi-not-present",
      agentRoot: join(root, "agent"),
      fragmentDir: join(root, "s", "policy"),
      agentRootManaged: true,
      providerAgentDir: join(root, "provider"),
      home: root,
      installationRoot: undefined,
    });
    supervisor.on("error", () => {});

    const result = supervisor.resume(
      { path: missing, cwd, id: "abc", created: "", modifiedMs: 0, bytes: 0, messageCount: 0, firstMessage: "", cwdExists: true, scratch: false },
      {},
    );
    assert.equal(result.ok, true, `must not refuse: ${result.ok ? "" : result.message}`);
    if (!result.ok) return;
    assert.equal(result.session.cwd, cwd, "started in the recorded directory (ADR-0008)");
    // Nothing exists at that path, so `--session` must be withheld — handing Pi a missing path is what its
    // exit-1-on-missing-session behaviour is for (C2).
    assert.notEqual(result.session.sessionFile, missing, "nothing to reopen, so no --session");
    /*
     * And nothing was written, which is what makes the remembering safe to defer.
     *
     * An end-to-end assertion cannot work in this fixture: the spawn fails (there is no `pi` binary here), so neither
     * the `spawned.ok` remember nor the `#refreshState` remember ever runs — and the test stayed green with the guard
     * removed. That is the "a test that cannot fail" shape this repository keeps writing tests about, caught by
     * falsifying it. What CAN be asserted is the fact the guard keys on: the transcript does not exist, so there is
     * nothing to reopen on the next launch either.
     */
    assert.equal(existsSync(missing), false, "no transcript, so nothing for a restart to reopen");
    await supervisor.stopAll({ forget: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
