#!/usr/bin/env node
/**
 * A shipped profile may name only what it can derive.
 *
 * The rule exists because the temptation is specific and reasonable-looking: a Homebrew
 * macOS machine cannot start the agent in an @box/pi box without granting
 * /opt/homebrew/etc/openssl@4/openssl.cnf next to node's formula, and the fix is one line.
 * Shipping that line would put four local facts -- a prefix, a formula version, a layout
 * choice, and one node build's compiled OPENSSLDIR -- into every installation, where they
 * rot silently on the next version bump.
 *
 * So the rule is asserted rather than written down. A profile may interpolate what Box
 * provides (home, root, workspace) and may name paths true on any POSIX machine. It may
 * not name a package manager's tree.
 *
 * Falsification for this check: add a deny on "/opt/homebrew/etc/openssl@4/openssl.cnf"
 * to the shipped set below and watch it fail. A check that only passes is decoration.
 *
 *   node scripts/check-profile-portability.mjs
 */

/**
 * The shipped profiles, as data.
 *
 * Until slice 9-11 lands the shipped deny set is still renderPolicyFragment()'s literals;
 * these are the paths it names, restated here so the rule is exercised against the real
 * set rather than an empty one. When the profile moves to data (9-11) this array becomes a
 * read of that data, and the check keeps working unchanged.
 */
const SHIPPED_DENY_PATHS = [
  "/.gitconfig",
  "/.config/git",
  "/.gitattributes",
  "/.config/gh",
  "/.ssh",
  "/.ssh/config",
  "/.ssh/known_hosts",
  "/.ssh/known_hosts.old",
  "/.ssh/allowed_signers",
  "/.ssh/config.d",
  "/.pi/agent/auth.json",
  "/Library/Keychains",
  "/Library/Preferences/com.apple.security.plist",
];

/** Prefixes that belong to one machine's package manager, never to a shipped profile. */
const PACKAGE_MANAGER_PREFIXES = [
  "/opt/homebrew",
  "/usr/local/Cellar",
  "/usr/local/opt",
  "/nix/store",
  "/home/linuxbrew",
  "/opt/local",
  "/snap",
  "/var/lib/flatpak",
];

/** Derivable, because Box interpolates them. */
const ALLOWED_TOKENS = ['${{ home }}', '${{ root }}', '${{ workspace }}'];

const problems = [];

for (const path of SHIPPED_DENY_PATHS) {
  const usesToken = ALLOWED_TOKENS.some((t) => path.startsWith(t));
  if (usesToken) continue;

  for (const prefix of PACKAGE_MANAGER_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + "/")) {
      problems.push(
        path +
          "\n    names the package-manager prefix " +
          prefix +
          ", which is one machine's furniture." +
          "\n    An installation overlay owns this, or upstream does. See docs/POLICY.md.",
      );
    }
  }

  if (!path.startsWith("/") && !usesToken) {
    problems.push(path + "\n    is neither absolute nor token-prefixed, so it resolves nowhere.");
  }
}

if (SHIPPED_DENY_PATHS.length === 0) {
  problems.push(
    "the shipped deny set is empty, so this check proves nothing." +
      "\n    A check that passes on an empty corpus is decoration -- see fragment.test.ts," +
      "\n    which asserts that a deliberately broken fragment DOES report a syntax error.",
  );
}

if (problems.length > 0) {
  console.error("check-profile-portability: " + problems.length + " problem(s)\n");
  for (const p of problems) console.error("  " + p + "\n");
  process.exit(1);
}

console.log(
  "check-profile-portability: OK — " +
    SHIPPED_DENY_PATHS.length +
    " shipped paths, none naming a package manager",
);
