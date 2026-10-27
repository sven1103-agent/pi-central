#!/usr/bin/env node
/**
 * The one manual publish (issue #61).
 *
 * ## Why there is a manual publish at all
 *
 * `release.yml` publishes over OIDC, which requires a **trusted publisher** — and a trusted publisher
 * is configured from an existing package's settings page. `npm help trust` states it plainly:
 *
 *     Package must exist: The package you're configuring must already exist on the npm registry.
 *
 * So the tag-driven workflow cannot perform the FIRST publish: there is no package to configure the
 * trust on. This is a bootstrap, it happens once, and it is the only publish that is ever done by
 * hand. Everything after it goes through the workflow with a provenance attestation.
 *
 * ## What this refuses, and why refusing is the point
 *
 * The first publish is irreversible in two ways, and only the first is this script's business:
 *
 *   1. **It refuses a final version.** npm never allows republishing a version, so a hand-published
 *      `0.2.0` could never be published again — which means it could never carry a provenance
 *      attestation, and the first release would be permanently the one artifact nobody can verify.
 *      The rule lives in `version-policy.mjs#bootstrapRefusal` so it is unit-tested; a check that
 *      only exists as prose in a document is not a check.
 *   2. **It asks for `next` — and that is NOT a guarantee about `latest`.** The tag is hard-coded
 *      below, and the publish request carries only that tag. **Measured 2026-10-27** against a local
 *      registry stub, which received `"dist-tags":{"next":"…"}` and nothing else; a second probe
 *      showed the client does not send `latest` even when one already exists to preserve.
 *
 *      This block previously called the hard-coded tag a *structural* guarantee that the throwaway
 *      could never become the install target. **It was false**: on the first real publish the
 *      registry set `latest` to it, and a plain `npm install` resolved to an artifact with no
 *      attestation until the real release landed (issue #66). The client never asks for `latest`,
 *      so the registry is free to set it and no flag here can stop it. A guarantee the client cannot
 *      express is not a guarantee, so this script CHECKS the tags afterwards and says what to do —
 *      see `latestPointerProblem`.
 *
 * `--provenance` is not attempted, because it is impossible here: the attestation is built from the
 * CI provider's OIDC identity, so no local invocation can produce one however it is spelled.
 *
 * ## Authentication
 *
 * This cannot hold a credential, and should not. Run `npm login` first, with 2FA enabled — npm
 * requires it at the account level for configuring trust, and it is the same account either way.
 *
 * Usage:
 *   npm login                                  # once, 2FA enabled
 *   node scripts/bootstrap-publish.mjs --dry-run   # rehearsal: shows the tarball, publishes nothing
 *   node scripts/bootstrap-publish.mjs             # the real thing, under the `next` tag
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapRefusal, latestPointerProblem } from "./version-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRY_RUN = process.argv.includes("--dry-run");

/** The tag the bootstrap publishes under. NOT `latest` — see the note at the top. */
const TAG = "next";

function fail(message) {
  console.error(`bootstrap-publish: ${message}`);
  process.exit(1);
}

function run(command, args) {
  console.log(`bootstrap-publish: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    // `npm` is a shell script on some platforms, so it needs a shell to be found at all.
    shell: process.platform === "win32",
  });
  if (result.status !== 0) fail(`\`${command} ${args.join(" ")}\` exited ${String(result.status)}`);
}

/**
 * Run a command and capture its output.
 *
 * Separate from `run`, which inherits stdio because it is a gate whose output a human should watch.
 * This one is for a value the script has to read and judge.
 */
function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return { status: result.status, stdout: (result.stdout ?? "").trim() };
}

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const refusal = bootstrapRefusal(version);
if (refusal !== undefined) {
  fail(
    `${refusal}\n\n` +
      `A bootstrap publish is throwaway by design: it exists only to create the package on the\n` +
      `registry so a trusted publisher can be configured against it.`,
  );
}

console.log(
  `bootstrap-publish: ${version} is a pre-release, so it may be published by hand.\n` +
    `bootstrap-publish: it will go out under the \`${TAG}\` tag${DRY_RUN ? " (dry run)" : ""}.`,
);

// Every gate, because an npm publish cannot be taken back. `check:version` also enforces that this
// pre-release has a CHANGELOG section, so the throwaway is still documented.
run("npm", ["run", "verify"]);

// The artifact itself. `npm publish` would run `prepublishOnly`/`prepare` if this project had them;
// it does not, so the build is explicit rather than implied.
run("npm", ["run", "build:package"]);

run("npm", [
  "publish",
  "--tag",
  TAG,
  "--access",
  "public",
  ...(DRY_RUN ? ["--dry-run"] : []),
]);

if (DRY_RUN) {
  console.log("\nbootstrap-publish: dry run complete; nothing was published.");
  process.exit(0);
}

// --- What actually happened to `latest` -----------------------------------------------------------
//
// Checked, not assumed. The registry may set `latest` to this throwaway whatever tag we ask for, and
// a claim that it cannot is what stopped anyone looking before (issue #66). This runs after the one
// irreversible step there is, so it must never turn an offline `npm view` into a scary non-answer:
// unreadable output means "unknown", and says so.
const view = capture("npm", ["view", "pi-central", "dist-tags", "--json"]);
let distTags;
try {
  distTags = JSON.parse(view.stdout);
} catch {
  distTags = undefined;
}

if (view.status !== 0 || distTags === undefined) {
  console.log(
    [
      "",
      "bootstrap-publish: could not read the dist-tags, so whether `latest` points at this throwaway",
      "is UNKNOWN. Check before announcing anything:",
      "",
      "  npm view pi-central dist-tags",
      "",
    ].join("\n"),
  );
} else {
  const problem = latestPointerProblem(distTags, version);
  if (problem !== undefined) console.log(`\n${problem}\n`);
}

console.log(
  [
    "",
    "bootstrap-publish: published under the `next` tag. It has NO provenance attestation and cannot",
    "have one — that is built from CI's OIDC identity. It is a throwaway that exists so the real",
    "release can be verified.",
    "",
    "Next, configure the trusted publisher so every later release uses OIDC (npm >= 11.15; run",
    "`npm trust github --help` for the exact flags on your npm):",
    "",
    "  npm trust github pi-central --file release.yml --repo sven1103-agent/pi-central --allow-publish",
    "",
    "Verify it, then confirm the package exists:",
    "",
    "  npm trust list pi-central",
    "  npm view pi-central versions --json",
    "",
    "Finally, restore the real version and release it through the workflow, which does carry",
    "provenance and creates the GitHub Release:",
    "",
    "  npm version <x.y.z> --no-git-tag-version --workspaces --include-workspace-root",
    "  git commit -am 'release: <x.y.z>' && git tag v<x.y.z> && git push origin v<x.y.z>",
    "",
    "Whether `latest` moved is not something this script can decide — it is the registry's call, and",
    "the check above reports what it actually did. Confirm it after the real release:",
    "",
    "  npm view pi-central dist-tags",
    "",
  ].join("\n"),
);
