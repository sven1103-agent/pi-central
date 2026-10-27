#!/usr/bin/env node
/**
 * One version, declared once (issue #53).
 *
 * ## The rot this exists to stop
 *
 * Before this script the shipped version was asserted in three unrelated places — `package.json`,
 * `README.md` ("Status: v0.1.0"), and `CHANGELOG.md` (its own `## [0.1.0]` section) — plus three
 * private workspace manifests. Six claims, no mechanism, and the failure is silent in the worst way:
 * every one of them reads as authoritative, so a disagreement produces *confident* documentation
 * rather than an error. `0.1.0` had in fact already been claimed twice, once as the package version
 * and once as the name of Increment 1.
 *
 * ## What is checked
 *
 *   1. **Every manifest agrees, and so does the lockfile.** The root `package.json` is the
 *      declaration; the three private workspace manifests must match it.
 *      `npm version <v> --workspaces --include-workspace-root` keeps them in step, which is why the
 *      failure message names that command rather than asking for three edits. `package-lock.json`
 *      records the same versions a fourth time and is checked too, because `npm ci` compares it with
 *      the manifests and fails when they differ — a gap that breaks the build on the NEXT machine
 *      and not the author's, since the author's `node_modules` is already installed.
 *   2. **No prose states the current version.** A version literal in Markdown cannot be kept in
 *      step with a manifest by any tool. Older versions are exempt: documents record what shipped
 *      when, and that is history rather than a claim about today.
 *   3. **No README states any version.** A stale number in a README is the most expensive kind,
 *      because READMEs are what strangers read first. Third-party versions count too — "verified
 *      against Pi 1.4.0" is wrong the moment Pi ships — so the honest phrasing points at the
 *      document that tracks it.
 *   4. **The newest CHANGELOG release matches the manifest.** A release whose notes are missing is a
 *      release nobody can read.
 *
 * ## `--release`, for tag time only
 *
 * `## [Unreleased]` is *supposed* to be full during development, so requiring it to be empty on
 * every commit would make the check ignorable. `--release` adds that requirement, and the release
 * workflow is the only thing that runs it, so "the section is empty at tag time" is enforced exactly
 * where it is true.
 *
 * ## What this cannot check
 *
 * Whether a version literal is CORRECT — only whether it is allowed to be there. A document claiming
 * `v9.9.9` in prose fails because prose may not claim the current version, not because 9.9.9 is the
 * wrong answer. That is the right trade: a check that must know the answer would itself have to
 * read the answer from somewhere, and then there would be two places again.
 *
 * Deliberately NOT checked: whether `PROTOCOL_VERSION` matches the package version. They are
 * different numbers with different jobs — the wire version changes when the wire changes and not
 * otherwise, which is why `packages/protocol/test/wire-surface.test.ts` pins it separately. Tying
 * them together would mean a patch release had to claim a wire change.
 *
 * The decisions are pure functions in `version-policy.mjs`; this file only reads the tree and exits.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  changelogReleases,
  currentVersionClaims,
  lockfileDisagreements,
  manifestDisagreements,
  releaseNotesRefusal,
  readmeVersionClaims,
  unreleasedBody,
  unreleasedEntries,
} from "./version-policy.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const RELEASE_MODE = process.argv.includes("--release");

/** Directories that hold no source of ours, and are expensive to walk. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".vite", "coverage", "bin"]);

function fail(lines) {
  console.error("check-version: FAILED\n");
  for (const line of lines) console.error(`  ${line}`);
  console.error("");
  process.exit(1);
}

/** Every file under `dir` whose basename matches, as `{path, text}` relative to ROOT. */
function readFiles(dir, matches) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readFiles(path, matches));
    } else if (matches(entry.name)) {
      out.push({ path: relative(ROOT, path), text: readFileSync(path, "utf8") });
    }
  }
  return out;
}

// --- The declaration ------------------------------------------------------------------------------

const rootManifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const declared = rootManifest.version;
if (typeof declared !== "string" || !/^\d+\.\d+\.\d+/.test(declared)) {
  fail([`package.json has no usable "version" (got ${JSON.stringify(declared)})`]);
}

// --- 1. Every manifest agrees ---------------------------------------------------------------------

const manifests = readFiles(ROOT, (name) => name === "package.json");
const disagreements = manifestDisagreements(manifests, declared);
if (disagreements.length > 0) {
  fail([
    `the version is declared as ${declared} in package.json but differs elsewhere:`,
    ...disagreements.map((d) => `  - ${d}`),
    "",
    "Bump all of them at once:  npm version <x.y.z> --workspaces --include-workspace-root",
  ]);
}

// The lockfile records the version too. It is checked separately because the fix is different: a
// manifest is edited by hand or by `npm version`, whereas the lockfile is regenerated.
const lockPath = join(ROOT, "package-lock.json");
const lockMismatches = existsSync(lockPath)
  ? lockfileDisagreements(readFileSync(lockPath, "utf8"), declared)
  : [];
if (lockMismatches.length > 0) {
  fail([
    `the version is declared as ${declared} in package.json but the lockfile disagrees:`,
    ...lockMismatches.map((d) => `  - ${d}`),
    "",
    "Regenerate the lockfile from the manifests:  npm install --package-lock-only --ignore-scripts",
    "(`npm ci` compares the two and fails when they differ, so this breaks CI on the next machine.)",
  ]);
}

// --- 2 and 3. Prose ---------------------------------------------------------------------------------

const markdown = readFiles(ROOT, (name) => name.endsWith(".md"));

const proseClaims = markdown.flatMap((file) => currentVersionClaims(file, declared));
const readmeClaims = markdown.flatMap(readmeVersionClaims);

const describe = (claim) => `${claim.path}:${claim.line} states ${claim.version}: ${claim.text}`;

if (proseClaims.length > 0) {
  fail([
    "a Markdown file states the CURRENT version:",
    ...proseClaims.map((c) => `  - ${describe(c)}`),
    "",
    `Only package.json (the declaration) and CHANGELOG.md (the release notes) may state ${declared}.`,
    "Remove the number, or point at `pi-central --version`, which reads the manifest.",
    "Older versions are allowed: documents may record what shipped when.",
  ]);
}

if (readmeClaims.length > 0) {
  fail([
    "a README states a version:",
    ...readmeClaims.map((c) => `  - ${describe(c)}`),
    "",
    "A README must not restate a version at all — not Pi Central's and not a third-party's.",
    "Point at the document that tracks it (docs/RELEASING.md for ours, docs/CONSTRAINTS.md for",
    "Pi and Safehouse), or at `pi-central --version`, which reads the manifest.",
  ]);
}

// --- 4. The newest CHANGELOG release matches -------------------------------------------------------

const changelogText = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
const releases = changelogReleases(changelogText);
const notesRefusal = releaseNotesRefusal(
  releases.map((release) => release.version),
  declared,
);
if (notesRefusal !== undefined) {
  fail([
    notesRefusal,
    "",
    "A release without notes is a release nobody can read. Promote `## [Unreleased]` into",
    `\`## [${declared}] — <date>\` as part of the same change that bumps the version.`,
    "",
    "A pre-release is the exception, and is documented by its BASE release: `0.2.0-rc.1` is a",
    "candidate for `0.2.0`, so `## [0.2.0]` is where its notes live.",
  ]);
}

// --- 5. Release mode: Unreleased must be empty -----------------------------------------------------

if (RELEASE_MODE) {
  const body = unreleasedBody(changelogText);
  if (body === undefined) {
    fail(["CHANGELOG.md has no `## [Unreleased]` section, so there is nowhere to record changes"]);
  }
  const entries = unreleasedEntries(body);
  if (entries.length > 0) {
    fail([
      "`## [Unreleased]` is not empty, so these changes would ship with no release notes:",
      ...entries.slice(0, 10).map((line) => `  - ${line.slice(0, 100)}`),
      entries.length > 10 ? `  … and ${entries.length - 10} more` : "",
      "",
      `Promote them into \`## [${declared}] — <date>\` before tagging.`,
    ].filter(Boolean));
  }
  console.log(`check-version: release mode OK — v${declared}, Unreleased empty, notes present`);
} else {
  console.log(
    `check-version: OK — ${manifests.length} manifests and the lockfile agree on ${declared}, ` +
      `no prose or README claims, newest CHANGELOG release matches`,
  );
}
