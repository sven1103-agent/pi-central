#!/usr/bin/env node
/**
 * Documentation reference checker.
 *
 * This repository is docs-driven: decisions live in Markdown and the code is expected to match
 * them. That only holds if the references actually resolve, and they rot silently — a link to a
 * deleted file still *looks* authoritative. This was run by hand several times during
 * development and caught real breakage each time (a removed prototype, a renamed ADR, an anchor
 * that no longer existed), so it is a script now rather than a habit.
 *
 * Three checks:
 *
 *   1. **Relative links** resolve to a file that exists, and their `#anchor` — when present —
 *      matches a heading in the target. Anchors are the ones that rot most quietly.
 *   2. **Path references in backticks** that look like repository paths resolve too, allowing
 *      `{a,b}` alternatives and a trailing wildcard. This is what catches a doc still citing
 *      `prototype/public/app.js` months after the directory was deleted.
 *   3. **Generated output is reported, not failed.** A reference under `packages/ui/dist` names
 *      build output, which is legitimately absent in a fresh checkout — CI has no `dist` until it
 *      builds. Demanding it exist made an honest mention of where the UI is served from a
 *      guaranteed failure, which is how this gap was found (issue #24). The exemptions are listed
 *      in the output, so a reference that is not checked is visible rather than assumed.
 *
 * Deliberately NOT checked: prose. A sentence mentioning "the spike" is history and is allowed to
 * describe something that no longer exists. Only explicit references are held to account.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".vite", "coverage"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

/** GitHub's heading anchor algorithm: lowercase, strip punctuation, spaces to hyphens. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
}

function headings(file) {
  return [...readFileSync(file, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]));
}

/**
 * Directories that hold BUILD OUTPUT rather than source.
 *
 * A reference to something under one of these is a reference to a generated path, and a generated
 * path is legitimately absent in a fresh checkout — CI has no `packages/ui/dist` until it builds,
 * so demanding that it exist made every honest mention of "where the UI is served from" a failure
 * (found by CI on the first run of issue #24, which is the check doing its job on a gap in itself).
 *
 * This is deliberately a SUPERSET-free, explicit list, not "anything git-ignored": a broad rule
 * would silently exempt real typos. The exemptions are counted and printed, so a reference that is
 * never checked is visible rather than assumed.
 */
const GENERATED_DIRS = new Set(["dist", ".vite", "coverage"]);

/** Is this reference to build output rather than to a file in the source tree? */
function isGenerated(reference) {
  return reference.split("/").some((segment) => GENERATED_DIRS.has(segment));
}

/** Expand `{a,b}` alternatives and a trailing `*` into concrete paths to test. */
function candidates(reference) {
  const brace = /\{([^}]*)\}/.exec(reference);
  if (brace) {
    const [whole, options] = brace;
    return options
      .split(",")
      .flatMap((option) => candidates(reference.replace(whole, option.trim())));
  }
  if (reference.includes("*")) {
    // Expand a wildcard against the filesystem rather than guessing.
    const dir = dirname(reference);
    const pattern = reference.slice(dir.length + 1);
    const prefix = pattern.replace(/\*.*$/, "");
    const suffix = pattern.includes(".") ? pattern.slice(pattern.lastIndexOf(".")) : "";
    if (!existsSync(join(ROOT, dir))) return [];
    return readdirSync(join(ROOT, dir))
      .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
      .map((name) => join(dir, name));
  }
  return [reference];
}

const problems = [];
const generated = [];

for (const file of walk(ROOT)) {
  const text = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);

  // --- 1. Markdown links ---------------------------------------------------------------------
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const [pathPart, anchor] = target.split("#");
    if (!pathPart) continue;

    const resolved = resolve(dirname(file), pathPart);
    if (!existsSync(resolved)) {
      problems.push(`${rel}: link target does not exist: ${target}`);
      continue;
    }
    if (anchor && statSync(resolved).isFile() && resolved.endsWith(".md")) {
      const found = headings(resolved);
      if (!found.includes(anchor)) {
        problems.push(`${rel}: link anchor not found in target: ${target}`);
      }
    }
  }

  // --- 2. Backticked repository paths --------------------------------------------------------
  for (const match of text.matchAll(/`((?:docs|packages|scripts|spikes|prototype)\/[^`\s]+)`/g)) {
    const reference = match[1].replace(/[.,;:]$/, "");
    // Skip things that are clearly not paths: RPC routes, URLs, globs we cannot expand.
    if (reference.includes("://") || reference.startsWith("/")) continue;
    const expanded = candidates(reference);
    if (expanded.length === 0) {
      problems.push(`${rel}: path reference looks wrong (nothing matches): ${reference}`);
      continue;
    }
    for (const candidate of expanded) {
      if (existsSync(join(ROOT, candidate))) continue;
      // A generated path (build output) is expected to be absent in a source checkout. Recorded
      // and reported rather than failed — and rather than skipped silently, which would be the
      // same as not checking anything.
      if (isGenerated(candidate)) {
        generated.push(`${rel}: ${candidate}`);
        continue;
      }
      problems.push(`${rel}: path reference does not exist: ${candidate}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`check-docs: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("\nA reference that does not resolve is worse than no reference: it looks authoritative.");
  process.exit(1);
}

console.log(`check-docs: all references resolve (${walk(ROOT).length} Markdown files checked)`);

// Printed, not hidden. A reference to build output cannot be checked for existence in a source
// checkout, so the honest thing is to say which ones were not checked rather than to imply that
// every reference was.
if (generated.length > 0) {
  console.log(
    `  ${generated.length} reference${generated.length === 1 ? "" : "s"} to generated output not checked for existence (absent until built):`,
  );
  for (const entry of generated) console.log(`    ${entry}`);
}
