/**
 * Gone vs unreadable (issue #196).
 *
 * ## The defect
 *
 * History said `directory is gone` for 274 of 500 sessions, and said it for two different situations. `registry.ts`
 * collapsed every `statSync` failure into `false`, so a directory denied by `EPERM` looked identical to a deleted
 * one. `resume.ts` had already fixed exactly this and recorded why — *"an EACCES on an ancestor directory — the path
 * was present and fine — reported as a missing directory, which sends the reader off to restore something that is
 * already there"* — and the lesson had not reached discovery.
 *
 * The difference decides what the reader does next: grant access or remount (often possible now) versus restore a
 * deleted directory. That is why it is a type and not a boolean.
 *
 * ## Why the mapping is tested rather than a real refusal
 *
 * Arranging a genuine `EPERM` needs a directory owned by another user or a sandbox that refuses — environment
 * dependent, and therefore exactly the kind of test that passes where it was written and is skipped everywhere
 * else. `classifyStatFailure` is the whole decision, so it is pure and tested directly; `inspectDirectory` is
 * tested against paths the filesystem can refuse portably.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { classifyStatFailure, inspectDirectory } = await import("../src/resume.ts");

test("EPERM and EACCES are UNREADABLE, never 'gone'", () => {
  // The defect, exactly: neither of these means the directory was deleted.
  for (const code of ["EPERM", "EACCES"]) {
    const classified = classifyStatFailure(code);
    assert.equal(classified.reason, "unreadable", `${code} must not read as missing`);
    assert.equal(classified.code, code, "and the code reaches the reader, so the title can name it");
  }
});

test("ENOENT and friends are MISSING, and keep their code", () => {
  for (const code of ["ENOENT", "ENOTDIR", "EIO", "ENODEV"]) {
    const classified = classifyStatFailure(code);
    assert.equal(classified.reason, "missing", `${code} is 'I cannot see it', which is what missing means`);
    assert.equal(classified.code, code);
  }
});

test("an unrecognised code is MISSING with the code attached, not swallowed", () => {
  // A failure nobody has seen still reaches the reader instead of becoming a bare boolean.
  const classified = classifyStatFailure("EWEIRD");
  assert.equal(classified.reason, "missing");
  assert.equal(classified.code, "EWEIRD");
});

test("no code at all is MISSING without inventing one", () => {
  const classified = classifyStatFailure(undefined);
  assert.deepEqual(classified, { reason: "missing" }, "no fabricated `code`");
});

test("a real directory is present", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-central-dirstate-"));
  try {
    assert.deepEqual(inspectDirectory(root), { ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path that is not there is MISSING, from the real filesystem", () => {
  const state = inspectDirectory("/definitely/not/here");
  assert.equal(state.ok, false);
  if (state.ok) return;
  assert.equal(state.reason, "missing");
  assert.equal(state.code, "ENOENT");
});

test("a FILE where a directory is expected is not-a-directory — it exists, which is a different fact", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-central-dirstate-"));
  try {
    const file = join(root, "a.txt");
    writeFileSync(file, "x");
    const state = inspectDirectory(file);
    assert.equal(state.ok, false);
    if (!state.ok) assert.equal(state.reason, "not-a-directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty recorded cwd is missing rather than resolving to the process cwd", () => {
  // `statSync("")` throws ENOENT anyway, but the explicit branch states the intent: an unrecorded directory is
  // not a directory named "".
  const state = inspectDirectory("");
  assert.equal(state.ok, false);
  if (!state.ok) assert.equal(state.reason, "missing");
});
