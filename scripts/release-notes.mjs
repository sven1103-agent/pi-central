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
import { changelogReleases } from "./version-policy.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const declared = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const wanted = process.argv[2] ?? declared;

const releases = changelogReleases(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"));
const found = releases.find((release) => release.version === wanted);

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

process.stdout.write(`${body}\n`);
