/**
 * Pi Central's reload extension, and the one thing provisioning it must not do (issue #274, ADR-0015).
 *
 * ## Why the artifact is tested rather than the deploy
 *
 * "The reload button works" depends on a file this process writes at spawn time. If that file stops registering the
 * command, or stops calling `ctx.reload()`, every test in `reload.test.ts` still passes — they use a stand-in Pi that
 * plays the command — and the product is broken. So the source itself is asserted: one command, the namespaced name,
 * and a handler whose only effect is `ctx.reload()`.
 *
 * ## What each test would catch
 *
 *   - the content test fails if the handler drops `ctx.reload()` (a command that does nothing, which the UI would
 *     report as a successful reload);
 *   - the naming test fails if the command is called `reload`, which would SHADOW a reader's own extension command
 *     of that name — Pi keeps the first registration, so theirs would win and the reload would silently not happen;
 *   - the permission test fails if the file is written group- or world-readable, which is a file executed inside
 *     every session;
 *   - the escape test fails if the path is built from anything other than the agent directory, because this is the
 *     one place Pi Central writes a file that gets executed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RELOAD_COMMAND,
  provisionReloadExtension,
  reloadExtensionRelPath,
  reloadExtensionSource,
} from "../src/reload-extension.ts";

test("the provisioned extension registers exactly one command, and it calls ctx.reload()", () => {
  const source = reloadExtensionSource();
  // One `registerCommand`, so nothing else rides along in a file that runs in every session.
  assert.equal(source.match(/registerCommand\(/g)?.length, 1);
  // The namespaced name, not "reload": Pi keeps the FIRST registration of a name, so a plain \`reload\` would give
  // precedence to a reader's own command and this one would never run.
  assert.equal(source.match(/registerCommand\("([^"]+)"/)?.[1], "pi-central:reload");
  assert.equal(RELOAD_COMMAND, "pi-central:reload");
  // The ONE call that is the whole feature. Without it the command exists, answers success, and changes nothing.
  assert.match(source, /await ctx\.reload\(\);/);
  // Terminal by construction: Pi documents that code after the await still runs from the pre-reload version.
  assert.match(source, /await ctx\.reload\(\);\s*return;/);
});

test("the extension has no imports, so nothing has to be installed beside it", () => {
  const source = reloadExtensionSource();
  // It is written next to no `node_modules`. A single `import` would make the file fail to load inside the
  // session, and Pi reports a load failure as a startup notice rather than as a missing reload control.
  assert.ok(!/^\s*import\s/m.test(source), `the extension must not import anything:\n${source}`);
  assert.ok(!/require\(/.test(source), "and it must not require anything either");
});

test("provisioning writes the source at 0600, inside the agent directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-central-ext-"));
  try {
    const file = provisionReloadExtension(root);
    assert.ok(file !== undefined, "provisioning into a writable directory must succeed");
    assert.equal(file, join(root, reloadExtensionRelPath()));
    assert.equal(readFileSync(file, "utf8"), reloadExtensionSource(), "the file IS the constant, not a copy of something else");
    // Executed inside every session, so the mode is a control rather than hygiene.
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // And the directory it lives in, which is the other half: a writable directory would let anything replace it.
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the file is REWRITTEN on every launch, so an upgrade cannot leave an older copy behind", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-central-ext-"));
  try {
    const file = provisionReloadExtension(root);
    assert.ok(file !== undefined);
    writeFileSync(file, "// stale copy from an earlier version\n");
    provisionReloadExtension(root);
    assert.equal(readFileSync(file, "utf8"), reloadExtensionSource());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent directory that cannot be written yields undefined rather than throwing", () => {
  // An `external` agent tree the reader owns is not Pi Central's to write into (ADR-0010 §5). The cost is the reload
  // control, which reports that Pi Central's command is not loaded — not a session that refuses to start.
  const root = mkdtempSync(join(tmpdir(), "pi-central-ext-"));
  try {
    const readOnly = join(root, "readonly");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    try {
      const file = provisionReloadExtension(readOnly);
      // Root can write anything; if this ran as root the case cannot be exercised, and saying so is honest.
      if (file !== undefined) assert.equal(process.getuid?.() === 0, true, "an unwritable directory must not report success");
    } finally {
      chmodSync(readOnly, 0o700);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});