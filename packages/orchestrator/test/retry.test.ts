/**
 * Retrying a failed session (issue #11).
 *
 * The acceptance criteria are almost entirely about REFUSALS, which is the part that has to be right before
 * anything is spawned:
 *
 *   - a retry re-spawns with the same cwd and mode
 *   - it is explicit; there is no silent auto-restart, so a crash loop cannot hide
 *   - the previous failure stays visible
 *   - a directory that has since vanished is refused BEFORE spawning, with the reason
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryRefusal, refusalForCode, retryRefusal } from "../src/retry.ts";
import type { LiveSession } from "@pi-central/protocol";

const root = mkdtempSync(join(tmpdir(), "pi-central-retry-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const session = (over: Partial<LiveSession> = {}): Pick<LiveSession, "state" | "cwd"> => ({
  state: "failed",
  cwd: root,
  ...over,
});

test("a failed session in a live directory may be retried", () => {
  assert.equal(retryRefusal(session()), undefined, "no refusal");
});

test("a RUNNING session is refused — a silent restart would hide a crash loop", () => {
  // The whole point of "explicit": if retry could restart a running session, a failing session would be
  // restarted by whoever held the button, and the loop would look like normal operation.
  for (const state of ["starting", "streaming", "awaiting-approval"] as const) {
    assert.equal(retryRefusal(session({ state })), "This session is still running. Stop it before retrying.");
  }
});

test("a session that is not broken is refused rather than restarted", () => {
  // `idle`, `registered` and `stopped` are not failures. Restarting one would lose its conversation position
  // for no reason, and would tell the reader something was wrong when nothing was.
  for (const state of ["idle", "registered", "stopped"] as const) {
    const refusal = retryRefusal(session({ state }));
    assert.ok(refusal?.includes("Only a failed session can be retried"), `${state}: ${refusal}`);
  }
});

test("a directory that no longer exists is refused, and says so", () => {
  const gone = join(root, "vanished");
  const refusal = directoryRefusal(gone);
  assert.ok(refusal?.includes("no longer exists"), refusal);
  assert.ok(refusal?.includes(gone), "the path must be named, not implied");
});

test("an UNREADABLE directory is not reported as a missing one", () => {
  // The bug this mirrors: `checkResumable` used a bare `catch` and called every failure "no longer exists",
  // including an EACCES on an ancestor whose path was present and fine. That sends a reader off to restore
  // something that is already there.
  //
  // Asserted on the MAPPING rather than on a real chmod: permission checks are bypassed for uid 0, so an
  // EACCES cannot be produced reliably on every machine, and a test that silently does nothing on some
  // machines is worse than one that checks the decision directly.
  for (const code of ["EACCES", "EPERM"]) {
    const refusal = refusalForCode(code, "/some/dir");
    assert.ok(!refusal.includes("no longer exists"), `${code} must not claim it vanished: ${refusal}`);
    assert.ok(/not readable|permissions/i.test(refusal), refusal);
  }
  assert.ok(refusalForCode("ENOENT", "/some/dir").includes("no longer exists"));
  // An unrecognised code is still named, rather than swallowed into a vague message.
  assert.ok(refusalForCode("EMFILE", "/some/dir").includes("EMFILE"));
});

test("a path that is a FILE rather than a directory is refused", () => {
  const file = join(root, "not-a-dir");
  writeFileSync(file, "x");
  assert.ok(directoryRefusal(file)?.includes("no longer a directory"));
});
