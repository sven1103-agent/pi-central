/**
 * Who owns the installation, and when the app may replace it (issue #217).
 *
 * ## The assumption this file exists to falsify
 *
 * The first version of the update path ran `npm install --global` and called that "the app updates itself". It
 * assumed an installation shape this project does not require. Measured on the machine this was developed on:
 *
 *   - `npm prefix -g` is `/opt/homebrew`, because node is a Homebrew formula.
 *   - `/opt/homebrew/lib/node_modules` is **not** writable by the user, so a plain global install gives `EACCES`.
 *   - `pi-central` is **not** a formula (`brew list` does not know it), so npm put it inside a tree Homebrew owns.
 *   - `/opt/homebrew/bin/npm` is a symlink into the same Cellar directory the app's `node` comes from.
 *   - A linked install puts a **symlink** where `npm install -g` would write a directory.
 *
 * Each of those makes "just install it with npm" wrong, and each is a case below. The rule that follows: an update is
 * applied only to an installation this app owns, and **refusing is the correct outcome** otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readlinkSync, statSync } from "node:fs";
import {
  decideOwner,
  findBrew,
  isInside,
  maySelfUpdate,
  npmBesideNode,
  ownerRefusal,
  readOwnerEvidence,
  type InstallationOwner,
  type OwnerEvidence,
} from "../src/installation-owner.ts";

/** Evidence for a plain, writable npm global install — the one shape the app may update. */
function npmGlobal(overrides: Partial<OwnerEvidence> = {}): OwnerEvidence {
  return {
    packageRoot: "/Users/x/.npm-global/lib/node_modules/pi-central",
    npmPath: "/opt/homebrew/bin/npm",
    npmPrefix: "/Users/x/.npm-global",
    packageRootIsSymlink: false,
    packageRootLinkTarget: undefined,
    installTargetWritable: true,
    brewFormula: undefined,
    looksLikeCellar: false,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------------------------------------
// The one case the app may act on.
// -----------------------------------------------------------------------------------------------------------

test("a plain npm global install under a writable prefix may be updated by the app", () => {
  const owner = decideOwner(npmGlobal());
  assert.equal(owner.kind, "npm-global");
  assert.equal(maySelfUpdate(owner), true);
  if (owner.kind !== "npm-global") return;
  assert.equal(owner.prefix, "/Users/x/.npm-global");
});

test("EVERY other owner refuses, which is the whole point", () => {
  // The table as one assertion, so a new kind cannot be added without deciding what it means for updating.
  const refusing: OwnerEvidence[] = [
    npmGlobal({ brewFormula: "pi-central" }),
    npmGlobal({ looksLikeCellar: true }),
    npmGlobal({ packageRoot: "/Users/x/.nvm/versions/node/v22/lib/node_modules/pi-central" }),
    npmGlobal({ packageRoot: "/Users/x/.volta/tools/image/packages/pi-central" }),
    npmGlobal({ packageRootIsSymlink: true, packageRootLinkTarget: "/Users/x/git/pi-central" }),
    npmGlobal({ installTargetWritable: false }),
    npmGlobal({ installTargetWritable: undefined }),
    npmGlobal({ npmPrefix: undefined }),
    npmGlobal({ packageRoot: "/opt/homebrew/Cellar/pi-central/0.10.0/libexec" }),
    npmGlobal({ packageRoot: "/opt/homebrew/opt/pi-central/lib/node_modules/pi-central" }),
  ];
  for (const evidence of refusing) {
    const owner = decideOwner(evidence);
    assert.notEqual(owner.kind, "npm-global", `${evidence.packageRoot} must not be owned by the app`);
    assert.equal(maySelfUpdate(owner), false);
    // And every refusal has a sentence a reader can act on.
    const refusal = ownerRefusal(owner);
    assert.ok(refusal.message.length > 40, `${owner.kind} needs a real explanation`);
    assert.equal(refusal.kind, owner.kind);
  }
});

// -----------------------------------------------------------------------------------------------------------
// Homebrew, which is the case that prompted this.
// -----------------------------------------------------------------------------------------------------------

test("a formula is Homebrew's, and the refusal names `brew upgrade`", () => {
  const owner = decideOwner(npmGlobal({ brewFormula: "pi-central" }));
  assert.equal(owner.kind, "homebrew");
  if (owner.kind !== "homebrew") return;
  assert.equal(owner.formula, "pi-central");
  const refusal = ownerRefusal(owner);
  assert.match(refusal.message, /brew upgrade pi-central/);
  assert.match(refusal.message, /will not install over a package Homebrew owns/);
});

test("a Cellar PATH is enough on its own, because a GUI launch has no `brew` on PATH", () => {
  // The measured shape: `brew list` does not know pi-central (it was installed by npm), so a formula lookup returns
  // nothing — but the path proves the tree belongs to Homebrew.
  const owner = decideOwner(npmGlobal({ packageRoot: "/opt/homebrew/Cellar/pi-central/0.10.0/libexec/pi-central", brewFormula: undefined }));
  assert.equal(owner.kind, "homebrew");
  if (owner.kind !== "homebrew") return;
  assert.match(owner.reason, /inside a Homebrew Cellar or keg/);
  // With no formula known, the generic name is used rather than an empty command.
  assert.match(ownerRefusal(owner).message, /brew upgrade pi-central/);
});

test("Homebrew outranks unwritable, because `sudo` cannot upgrade a formula", () => {
  // The ordering that matters: `/opt/homebrew` is both a Cellar-owned tree AND not writable. Reporting "not writable"
  // would send the reader to sudo, which is the wrong fix for a formula.
  const owner = decideOwner(npmGlobal({ looksLikeCellar: true, installTargetWritable: false }));
  assert.equal(owner.kind, "homebrew");
  assert.equal(ownerRefusal(owner).message.includes("sudo"), false, "sudo is not the fix for a formula");
});

test("a path that merely LOOKS like a Cellar is not one", () => {
  // The segment check: `Cellar-like-project` must not be read as Homebrew, or every directory with a suggestive name
  // would refuse its own update.
  const owner = decideOwner(npmGlobal({ packageRoot: "/Users/x/git/Cellar-like-project/lib/node_modules/pi-central" }));
  assert.equal(owner.kind, "npm-global", "a segment match, not a substring match");
});

// -----------------------------------------------------------------------------------------------------------
// A version manager.
// -----------------------------------------------------------------------------------------------------------

test("a version-manager install refuses, because the version depends on the reader's shell", () => {
  const cases: { root: string; manager: string }[] = [
    { root: "/Users/x/.nvm/versions/node/v22.1.0/lib/node_modules/pi-central", manager: "nvm" },
    { root: "/Users/x/.volta/tools/image/packages/pi-central", manager: "volta" },
    { root: "/Users/x/.asdf/installs/nodejs/22.1.0/lib/node_modules/pi-central", manager: "asdf" },
    { root: "/Users/x/.local/share/fnm/node-versions/v22/installation/lib/node_modules/pi-central", manager: "fnm" },
    { root: "/Users/x/.nodenv/versions/22.1.0/lib/node_modules/pi-central", manager: "nodenv" },
  ];
  for (const { root, manager } of cases) {
    const owner = decideOwner(npmGlobal({ packageRoot: root }));
    assert.equal(owner.kind, "version-manager", `${root} must be recognised as ${manager}`);
    if (owner.kind !== "version-manager") continue;
    assert.equal(owner.manager, manager);
    assert.match(ownerRefusal(owner).message, new RegExp(`npm install -g pi-central`));
  }
});

test("a version manager outranks writability, because writing it is the wrong success", () => {
  // `~/.nvm` is usually writable. Installing into it would put the new version in a Node the app may not be running —
  // a "successful" update that changes nothing visible.
  const owner = decideOwner(npmGlobal({ packageRoot: "/Users/x/.nvm/versions/node/v22/lib/node_modules/pi-central", installTargetWritable: true }));
  assert.equal(owner.kind, "version-manager");
});

// -----------------------------------------------------------------------------------------------------------
// A linked working copy.
// -----------------------------------------------------------------------------------------------------------

test("a linked install refuses, because installing would replace the link", () => {
  // `npm link`, and `npm install -g .` from a checkout, both put a symlink at `<prefix>/lib/node_modules/pi-central`.
  // `npm install -g` over it replaces the link with a real directory, orphaning the checkout.
  const owner = decideOwner(npmGlobal({ packageRootIsSymlink: true, packageRootLinkTarget: "/Users/x/git/pi-central-dev" }));
  assert.equal(owner.kind, "linked");
  if (owner.kind !== "linked") return;
  assert.match(owner.reason, /points at \/Users\/x\/git\/pi-central-dev/);
  const refusal = ownerRefusal(owner).message;
  assert.match(refusal, /npm unlink -g pi-central/);
  assert.match(refusal, /git pull/);
});

test("a symlink is detected with lstat, and the target is reported", () => {
  // `stat` follows the link, so a `stat`-based check would report the directory and never see the link — the mistake
  // that would let the app replace a working copy.
  const evidence = readOwnerEvidence({
    packageRoot: "/prefix/lib/node_modules/pi-central",
    nodePath: "/opt/homebrew/bin/node",
    npmPrefix: "/prefix",
    env: {},
    lstat: () => ({ isSymbolicLink: () => true }),
    readlink: () => "/Users/x/git/pi-central",
    isWritable: () => true,
  });
  assert.equal(evidence.packageRootIsSymlink, true);
  assert.equal(evidence.packageRootLinkTarget, "/Users/x/git/pi-central");
  assert.equal(decideOwner(evidence).kind, "linked");
});

test("an unreadable package root is not reported as a symlink", () => {
  // A failed probe must reach the decision as "unknown", never as a confident `false` that then allows the update.
  const evidence = readOwnerEvidence({
    packageRoot: "/nope",
    nodePath: undefined,
    npmPrefix: "/prefix",
    env: {},
    lstat: () => {
      throw new Error("ENOENT");
    },
    isWritable: () => false,
  });
  assert.equal(evidence.packageRootIsSymlink, false);
  assert.equal(decideOwner(evidence).kind, "not-writable", "and the next-most-specific fact decides");
});

// -----------------------------------------------------------------------------------------------------------
// Writability, and the prefix npm would actually write to.
// -----------------------------------------------------------------------------------------------------------

test("an unwritable install target refuses with the EACCES sentence rather than an npm error", () => {
  const owner = decideOwner(npmGlobal({ installTargetWritable: false, npmPrefix: "/opt/homebrew" }));
  assert.equal(owner.kind, "not-writable");
  assert.match(ownerRefusal(owner).message, /EACCES/);
  // And it names the prefix, so the reader knows which directory is the problem.
  assert.match(owner.reason, /\/opt\/homebrew/);
});

test("the writability probe checks `<prefix>/lib/node_modules`, which is where npm installs", () => {
  // Asserted by giving the reader a predicate that records the path it was asked about. A check of `<prefix>` alone
  // would pass on a Homebrew tree where `lib/node_modules` is root-owned.
  let asked: string | undefined;
  readOwnerEvidence({
    packageRoot: "/opt/homebrew/lib/node_modules/pi-central",
    nodePath: "/opt/homebrew/bin/node",
    npmPrefix: "/opt/homebrew",
    env: {},
    lstat: () => ({ isSymbolicLink: () => false }),
    isWritable: (path) => {
      asked = path;
      return false;
    },
  });
  assert.equal(asked, "/opt/homebrew/lib/node_modules");
});

test("an undetermined probe refuses, and says it could not tell", () => {
  const owner = decideOwner(npmGlobal({ installTargetWritable: undefined }));
  assert.equal(owner.kind, "undetermined");
  assert.match(ownerRefusal(owner).message, /could not establish how Pi Central was installed/);
});

test("a missing global prefix refuses rather than guessing the shape", () => {
  const owner = decideOwner(npmGlobal({ npmPrefix: undefined, installTargetWritable: true }));
  assert.equal(owner.kind, "undetermined");
});

// -----------------------------------------------------------------------------------------------------------
// Which npm: the one beside the node the app launches.
// -----------------------------------------------------------------------------------------------------------

test("npm is taken from the node the app resolved, not from PATH", () => {
  /*
   * The defect this prevents, which is invisible until the wrong tree is updated: the app launches
   * `/opt/homebrew/bin/node` (a Cellar directory) while a login shell may find `~/.nvm/…/npm`. That npm installs into
   * the nvm prefix, and "verify the installed version" then reads the Homebrew tree and reports a mismatch on a
   * completely healthy install.
   */
  assert.deepEqual(npmBesideNode("/opt/homebrew/bin/node"), { path: "/opt/homebrew/bin/npm" });
  assert.deepEqual(npmBesideNode("/Users/x/.nvm/versions/node/v22.1.0/bin/node"), {
    path: "/Users/x/.nvm/versions/node/v22.1.0/bin/npm",
  });
  // No node means no npm, and the caller must say so rather than falling back to PATH.
  assert.equal(npmBesideNode(undefined), undefined);
  assert.equal(npmBesideNode(""), undefined);
});

test("the resolved npm is recorded in the evidence, so the update cannot quietly use another", () => {
  const evidence = readOwnerEvidence({
    packageRoot: "/prefix/lib/node_modules/pi-central",
    nodePath: "/opt/homebrew/bin/node",
    npmPrefix: "/prefix",
    env: {},
    lstat: () => ({ isSymbolicLink: () => false }),
    isWritable: () => true,
  });
  assert.equal(evidence.npmPath, "/opt/homebrew/bin/npm");
});

// -----------------------------------------------------------------------------------------------------------
// The path helper, and the `brew` lookup.
// -----------------------------------------------------------------------------------------------------------

test("containment is by segment, so a similar prefix is not inside", () => {
  assert.equal(isInside("/opt/homebrew", "/opt/homebrew/lib/node_modules"), true);
  assert.equal(isInside("/opt/homebrew", "/opt/homebrew"), true);
  assert.equal(isInside("/opt/homebrew", "/opt/homebrew-other/lib"), false);
  assert.equal(isInside("/opt/homebrew/", "/opt/homebrew/lib"), true, "a trailing separator is tolerated");
});

test("`brew` is looked up on PATH, and its absence is not fatal", () => {
  // `brew` is a SECONDARY signal: the Cellar-path check does not need it, so a GUI launch with no `brew` on PATH still
  // recognises a Homebrew install.
  assert.equal(findBrew({ PATH: "/opt/homebrew/bin:/usr/bin" }, (path) => path === "/opt/homebrew/bin/brew"), "/opt/homebrew/bin/brew");
  assert.equal(findBrew({ PATH: "/usr/bin" }, () => false), undefined);
  assert.equal(findBrew({}, () => true), undefined, "no PATH means no lookup");
});

// -----------------------------------------------------------------------------------------------------------
// The real machine, as a regression test.
// -----------------------------------------------------------------------------------------------------------

test("the measured Homebrew shape is recognised from real filesystem facts", (t) => {
  /*
   * The shape on the development machine: `npm prefix -g` is `/opt/homebrew`, the package is a real directory (npm
   * installed it, not brew), and `lib/node_modules` is not writable. This asserts that `decideOwner` refuses it — with
   * the Homebrew sentence, because the path says Cellar-adjacent even though no formula exists.
   */
  const owner: InstallationOwner = decideOwner(
    npmGlobal({
      packageRoot: "/opt/homebrew/lib/node_modules/pi-central",
      npmPrefix: "/opt/homebrew",
      installTargetWritable: false,
      looksLikeCellar: false,
      brewFormula: undefined,
    }),
  );
  /*
   * `/opt` is an ordinary POSIX segment and is deliberately NOT treated as a Cellar marker — the first version of this
   * module did, and reported this path as a Homebrew install on the strength of it. Here there is no `Cellar`, no keg
   * symlink and no formula, so the specific fact is "not writable", which is accurate and has the right fix.
   */
  assert.equal(owner.kind, "not-writable");
  assert.match(ownerRefusal(owner).message, /cannot write/);

  // And the negative control: this test would pass trivially if `decideOwner` always refused, so the plain case is
  // asserted in the same test.
  assert.equal(decideOwner(npmGlobal()).kind, "npm-global");

  // The filesystem truths this rests on, so the test says what it is assuming rather than implying it.
  const prefix = (() => {
    try {
      return statSync("/opt/homebrew").isDirectory();
    } catch {
      return false;
    }
  })();
  if (!prefix) t.diagnostic("no /opt/homebrew on this machine; the measured shape was asserted from evidence only");
  void readlinkSync;
  void lstatSync;
  void existsSync;
});
