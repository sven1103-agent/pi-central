#!/usr/bin/env node
/**
 * Print the CHANGELOG section for the current version (issue #53).
 *
 * The GitHub Release body has to be the same notes the CHANGELOG carries, or the two drift and the
 * release page becomes a second, worse changelog. Deriving the body from the file means there is one
 * text and one place it lives.
 *
 * Exits non-zero when the section is missing rather than publishing a release with an empty body: a
 * release whose notes are blank is worse than one whose body says nothing, because nobody notices.
 *
 * Usage: node scripts/release-notes.mjs [version]   # defaults to package.json's version
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { baseVersion, changelogReleases } from "./version-policy.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const declared = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const wanted = process.argv[2] ?? declared;

const releases = changelogReleases(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"));

// A pre-release is documented by its BASE release: `0.2.0-rc.1` is a candidate for `0.2.0`, so
// `## [0.2.0]` is where its notes live, and the preamble below says so on the Release page.
//
// Requiring a throwaway `## [0.2.0-rc.1]` section instead would mean hand-editing the changelog to
// publish something it will never mention again — friction that gets a documented process abandoned,
// in exchange for nothing.
//
// (The workflow also generates these notes BEFORE it publishes, so a missing section fails before the
// irreversible act. That is defence in depth and NOT the reason for this fallback: what documents a
// pre-release is a question about meaning, not about step ordering.)
const base = baseVersion(wanted);
const found =
  releases.find((release) => release.version === wanted) ??
  (base !== wanted ? releases.find((release) => release.version === base) : undefined);
const preamble =
  found && found.version !== wanted
    ? `Pre-release of ${found.version}. The notes below are for ${found.version}.\n\n`
    : "";

if (!found) {
  console.error(
    `release-notes: CHANGELOG.md has no \`## [${wanted}]\` section, so the release would have no ` +
      `notes. Promote \`## [Unreleased]\` into \`## [${wanted}] — <date>\` first.`,
  );
  process.exit(1);
}

const body = found.body.trim();
if (body.length === 0) {
  console.error(`release-notes: \`## [${wanted}]\` is empty, so the release would have no notes.`);
  process.exit(1);
}

process.stdout.write(`${preamble}${body}\n`);
