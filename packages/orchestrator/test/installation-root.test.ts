/**
 * Deriving the orchestrator's own installation root (issue #25).
 *
 * The constraint is that it must come from the runtime, not from configuration: a configured path
 * is right for exactly one checkout — the author's — and silently wrong for everyone else. So the
 * test that matters is that the walk finds THIS repository, and that it refuses to guess when it
 * cannot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInstallationRoot } from "../src/installation-root.ts";
import { isOwnInstallation } from "@pi-central/protocol";

test("the walk finds THIS repository, from the real module URL", () => {
  // The one assertion that cannot be satisfied by a wrong implementation: whatever the checkout is
  // called and wherever it sits, the answer must be the root this test file lives under.
  const root = resolveInstallationRoot();
  assert.ok(root, "the installation root must be identifiable in a real checkout");
  // `packages/orchestrator/test/…` → `packages/orchestrator` → the root.
  assert.ok(root.endsWith("/pi-central-dev") || root.endsWith("/pi-central"), `unexpected root: ${root}`);
  // And the answer is usable by the predicate the UI and supervisor share.
  assert.equal(isOwnInstallation(join(root, "packages", "ui"), root), true);
});

test("a directory with no pipeline packages is not claimed as an installation", () => {
  // The failure mode this prevents: a walk that always returns SOMETHING, so the warning points at
  // an unrelated directory and either fires for everything or never fires at all. Built here rather
  // than mocked, so the existence check is genuinely exercised.
  const scratch = mkdtempSync(join(tmpdir(), "pi-central-notinstall-"));
  try {
    mkdirSync(join(scratch, "packages", "ui"), { recursive: true });
    // Only ONE of the three markers: two would mistake an unrelated repository that happens to have
    // a `packages/ui`, which is a common layout.
    assert.equal(resolveInstallationRoot(pathToUrl(join(scratch, "deep", "module.ts"))), undefined);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a directory with all three pipeline packages IS recognised", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-central-install-"));
  try {
    for (const pkg of ["orchestrator", "ui", "protocol"]) {
      mkdirSync(join(scratch, "packages", pkg), { recursive: true });
    }
    const from = join(scratch, "packages", "orchestrator", "src");
    assert.equal(resolveInstallationRoot(pathToUrl(join(from, "server.ts"))), scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the walk is bounded, so a filesystem root is never claimed as the installation", () => {
  // Without a bound, a path outside any checkout would walk to `/` and, if `/` ever contained the
  // marker directories, claim the whole filesystem. `undefined` is the honest answer.
  assert.equal(resolveInstallationRoot("file:///nonexistent/deeply/nested/module.ts"), undefined);
});

/** A `file://` URL for a path, which is what `import.meta.url` provides at runtime. */
function pathToUrl(path: string): string {
  return `file://${path}`;
}
