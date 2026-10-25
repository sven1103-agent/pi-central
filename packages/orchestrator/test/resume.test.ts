import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkResumable } from "../src/resume.ts";

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
