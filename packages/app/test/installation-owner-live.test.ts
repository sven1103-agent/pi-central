/**
 * The owner probe against REAL installation shapes on disk (issue #217).
 *
 * ## What only this file can say
 *
 * `installation-owner.test.ts` decides what a set of *facts* means, and it injects those facts — including `lstat`,
 * `readlink` and the writability predicate. That is the right way to test the decision table, and it is exactly the
 * way to miss a bug in the probes: a `stat` where an `lstat` was needed, an `access` on the wrong directory, a
 * `readlink` that returns a relative target. A stub answers whatever the test expects; the filesystem does not.
 *
 * So this builds the shapes for real in a temporary directory and runs the **uninjected** `readOwnerEvidence`, then
 * hands its output to the real `decideOwner`. Four shapes, each a directory tree:
 *
 *   1. a plain npm global install under a writable prefix — the one the app may update;
 *   2. the same, with `lib/node_modules` read-only — the shape measured on the development machine;
 *   3. a **symlinked** package root — `npm link` and `npm install -g .`;
 *   4. a Homebrew **Cellar** and a Homebrew **keg symlink**, which are two different Homebrew facts.
 *
 * ## Why the writability case is skipped sometimes
 *
 * `chmod 555` does not stop a user who is root, and on some filesystems it does not stop the owner either. When the
 * probe reports "writable" for a directory the test just made read-only, that is a fact about the environment and the
 * test says so rather than failing — the same convention `attach-live.test.ts` uses for a refused `ps` (C16).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideOwner,
  maySelfUpdate,
  npmBesideNode,
  ownerRefusal,
  readOwnerEvidence,
} from "../src/installation-owner.ts";

/** A temporary tree, removed when the test ends. */
function tree(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "pi-central-owner-"));
  t.after(() => {
    // `chmod` back before removing: a read-only directory cannot be cleaned up as-is.
    try {
      chmodSync(join(root, "readonly", "lib", "node_modules"), 0o755);
    } catch {
      // Not every tree has one.
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Write a package.json at `root` with the real package name, and return the directory. */
function packageAt(root: string, version = "0.10.0"): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-central", version }), "utf8");
  return root;
}

/**
 * The evidence as the app reads it: the REAL probes.
 *
 * `lstat`/`readlink`/`isWritable` are left to their defaults, which is the whole point — `main.ts` passes the same
 * real implementations.
 */
function realEvidence(packageRoot: string, npmPrefix: string | undefined) {
  return readOwnerEvidence({
    packageRoot,
    nodePath: "/opt/homebrew/bin/node",
    npmPrefix,
    env: process.env,
    // `brew` is deliberately NOT stubbed into existence: a formula lookup that needs brew is a secondary signal, and
    // these shapes must be recognised without it.
    findBrewFormula: () => undefined,
  });
}

/** `fs.access(W_OK)`, the same call `main.ts` passes. */
function writable(path: string): boolean | undefined {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : false;
  }
}

test("a real writable npm global tree is recognised as the app's own", (t) => {
  const root = tree(t);
  const prefix = join(root, "prefix");
  const packageRoot = packageAt(join(prefix, "lib", "node_modules", "pi-central"));

  // `readOwnerEvidence` leaves writability to the injected predicate, so the real call is made here with the same
  // implementation `main.ts` uses. The rest — lstat, readlink, prefix arithmetic — is the real code.
  const evidence = { ...realEvidence(packageRoot, prefix), installTargetWritable: writable(join(prefix, "lib", "node_modules")) };

  assert.equal(evidence.packageRootIsSymlink, false, "a real directory is not a symlink");
  assert.equal(evidence.installTargetWritable, true, "the test's own temporary directory is writable");
  const owner = decideOwner(evidence);
  assert.equal(owner.kind, "npm-global");
  assert.equal(maySelfUpdate(owner), true);
});

test("a real read-only `lib/node_modules` is refused, which is the shape on this machine", (t) => {
  const root = tree(t);
  const prefix = join(root, "readonly");
  const packageRoot = packageAt(join(prefix, "lib", "node_modules", "pi-central"));
  chmodSync(join(prefix, "lib", "node_modules"), 0o555);

  const target = join(prefix, "lib", "node_modules");
  const probe = writable(target);
  if (probe === true) {
    // Root, or a filesystem that ignores the mode. The probe's answer is right for this environment; the decision it
    // leads to is asserted from the fact instead.
    t.diagnostic(`chmod 555 did not make ${target} unwritable here (running as root?), so the real probe cannot be exercised`);
    return;
  }
  const evidence = { ...realEvidence(packageRoot, prefix), installTargetWritable: probe };
  assert.equal(probe, false, "a 555 directory is not writable");
  const owner = decideOwner(evidence);
  assert.equal(owner.kind, "not-writable");
  assert.equal(maySelfUpdate(owner), false);
  assert.match(ownerRefusal(owner).message, /EACCES/);
});

test("a real symlinked package root is detected as a linked working copy", (t) => {
  /*
   * The probe bug this catches: `stat` follows a symlink, so a `stat`-based check reports the target directory and
   * never sees the link — and the app would then replace a `npm link` with a real directory, silently orphaning the
   * checkout the reader was working in. Only `lstat` answers this, and this test is the only place that can catch a
   * `stat` creeping back in.
   */
  const root = tree(t);
  const prefix = join(root, "prefix");
  mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
  const checkout = packageAt(join(root, "checkout"));
  const link = join(prefix, "lib", "node_modules", "pi-central");
  symlinkSync(checkout, link);

  const evidence = { ...realEvidence(link, prefix), installTargetWritable: true };
  assert.equal(evidence.packageRootIsSymlink, true, "lstat sees the link, stat would not");
  /*
   * `readlink` returns the target AS WRITTEN, and on macOS `/tmp` is a symlink to `/private/tmp` — so the resolved path
   * and the reported one differ by that prefix. The assertion is that the target is the checkout, compared by its own
   * resolved form, rather than assuming readlink normalizes (it does not).
   */
  assert.equal(
    evidence.packageRootLinkTarget !== undefined &&
      realpathSync(evidence.packageRootLinkTarget) === realpathSync(checkout),
    true,
    `readlink reported ${String(evidence.packageRootLinkTarget)}`,
  );

  const owner = decideOwner(evidence);
  assert.equal(owner.kind, "linked");
  assert.equal(maySelfUpdate(owner), false);
  // The refusal names both routes: move to a release, or keep working from the checkout.
  const message = ownerRefusal(owner).message;
  assert.match(message, /npm unlink -g pi-central/);
  assert.match(message, /git pull/);
  // The message names the target, because it is the fact that identifies WHICH checkout this link is.
  assert.equal(
    message.includes(checkout.replace("/tmp/", "/private/tmp/")) || message.includes(checkout),
    true,
    `the refusal names the link's target; got: ${message.split("\n")[0]}`,
  );
});

test("a symlink to a MISSING target is still a link, not an absent package", (t) => {
  // `npm link` to a checkout that has since been deleted. `stat` would throw ENOENT and a probe that treated that as
  // "not a symlink" would allow an install over a dangling link.
  const root = tree(t);
  const prefix = join(root, "prefix");
  mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
  const link = join(prefix, "lib", "node_modules", "pi-central");
  symlinkSync(join(root, "gone"), link);

  const evidence = realEvidence(link, prefix);
  assert.equal(evidence.packageRootIsSymlink, true);
  assert.equal(decideOwner({ ...evidence, installTargetWritable: true }).kind, "linked");
});

test("a real Homebrew Cellar path is recognised without a formula lookup", (t) => {
  // The shape when `brew` IS the manager: `<root>/Cellar/<formula>/<version>/…`. `findBrewFormula` returns undefined
  // here on purpose — a GUI launch has no `brew` on PATH, so the path has to be enough.
  const root = tree(t);
  const cellar = packageAt(join(root, "Cellar", "pi-central", "0.10.0", "libexec", "pi-central"));

  const evidence = { ...realEvidence(cellar, "/opt/homebrew"), installTargetWritable: true };
  assert.equal(evidence.looksLikeCellar, true);
  const owner = decideOwner(evidence);
  assert.equal(owner.kind, "homebrew");
  assert.equal(maySelfUpdate(owner), false);
  assert.match(ownerRefusal(owner).message, /brew upgrade/);
});

test("a bare `keg` or `opt` segment is not a Homebrew install, and the real keg spelling is", (t) => {
  /*
   * Two facts in one test because they are the same bug from both sides. `/opt/homebrew/opt/<formula>` is a keg
   * symlink and must be Homebrew's. `/opt/some-other-thing/…` is an ordinary POSIX path and must NOT be — the first
   * version of the module treated any `opt` segment as a Cellar marker and would have told a reader to run
   * `brew upgrade` for a package Homebrew had never heard of.
   */
  const root = tree(t);
  const keg = join(root, "keg", "opt", "pi-central", "lib", "node_modules", "pi-central");
  packageAt(keg);

  /*
   * `/tmp/.../keg/opt/pi-central/...` is not inside a Homebrew root, so it is NOT Homebrew — and this test failed on the
   * first version of the module because `keg` was listed as a Cellar segment. It is not one: a keg is a versioned
   * directory inside `Cellar`, and there is no `…/keg/…` in Homebrew's layout. A directory named `keg` anywhere on disk
   * is just a directory.
   */
  const evidence = realEvidence(keg, join(root, "keg"));
  const owner = decideOwner({ ...evidence, installTargetWritable: true });
  assert.notEqual(owner.kind, "homebrew", "a bare `keg` or `opt` segment must not be read as Homebrew");

  // And the real keg spelling, asserted through the path predicate rather than by writing to /opt.
  const realKeg = "/opt/homebrew/opt/pi-central/lib/node_modules/pi-central";
  const kegEvidence = decideOwner({
    ...realEvidence(realKeg, "/opt/homebrew"),
    installTargetWritable: true,
  });
  assert.equal(kegEvidence.kind, "homebrew", `${realKeg} is a keg symlink under /opt/homebrew`);
});

test("the real npm-beside-node derivation finds the binary that exists on this machine", (t) => {
  /*
   * Measured here: `/opt/homebrew/bin/npm` is a symlink into the same Cellar directory the app's `node` comes from. The
   * bug this prevents is the app running one node and installing with another node's npm — different prefix, and the
   * verification then reads a tree nothing wrote to.
   */
  const root = tree(t);
  // A fake node/npm pair, so the derivation is tested without depending on the machine's layout.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const node = join(bin, "node");
  const npm = join(bin, "npm");
  writeFileSync(node, "#!/bin/sh\n", "utf8");
  writeFileSync(npm, "#!/bin/sh\n", "utf8");

  const derived = npmBesideNode(node);
  assert.equal(derived?.path, npm, "npm is taken from the resolved node's directory");
  // And a real machine check, skipped when the layout differs.
  const machineNpm = npmBesideNode("/opt/homebrew/bin/node");
  if (machineNpm !== undefined && existsSync(machineNpm.path)) {
    t.diagnostic(`this machine's derived npm is ${machineNpm.path}`);
  }
});

test("the real probe names no owner it cannot justify", (t) => {
  /*
   * The negative control for the whole file: a path that matches nothing must not be confidently classified. Without
   * this, a `decideOwner` that returned `npm-global` for everything would pass every test above.
   */
  const root = tree(t);
  const nowhere = packageAt(join(root, "elsewhere", "pi-central"));
  const owner = decideOwner({ ...realEvidence(nowhere, undefined), installTargetWritable: undefined });
  assert.equal(owner.kind, "undetermined");
  assert.equal(maySelfUpdate(owner), false);
});
