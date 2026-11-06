#!/usr/bin/env node
/**
 * Build a CycloneDX SBOM of what Pi Central actually SHIPS, for the vulnerability scan
 * (`.github/workflows/dependency-vulnerability-scan.yml`).
 *
 * ## Why this exists instead of `npm sbom --omit=dev`
 *
 * The scan must report on the RELEASE PACKAGE, not on the development toolchain. Pi and TypeScript
 * are devDependencies here (ADR-0005), and they are also where every finding on this repository
 * came from — so a scan over the whole install reports real CVEs in code that is never shipped and
 * buries the ones that matter.
 *
 * `npm sbom --omit=dev` looks like the answer and is not. **Measured** on this repository:
 * it omits `ws`, which is the package's *only* runtime dependency, declaring 60 components with no
 * `ws` among them. The cause is that `ws` is also required transitively by a dev-only package
 * (`@google/genai`), and the omission pass removes the entry wholesale rather than deciding it by
 * reachability from the root's `dependencies`. A scanner fed that SBOM would be blind to the one
 * library the published artifact loads, and would say so in a report that looks complete.
 *
 * ## What it uses instead
 *
 * `package-lock.json` is the ground truth for what `npm ci` installs, and it records a `dev` flag
 * per package. A package with `dev: true` is only reachable from devDependencies; anything else is
 * part of the production tree. That set is derived here directly, so it cannot inherit npm's
 * omission bug.
 *
 * It covers both halves of the shipped surface, which are different:
 *
 *   - **the orchestrator bundle's one external dependency**, `ws` — everything else is bundled and
 *     therefore audited as source, not as a package;
 *   - **the UI's vendored libraries** (`react`, `shiki`, `markdown-it`, `dompurify`), which Vite
 *     bundles INTO `dist/ui` and which therefore ship, and which matter most: `dompurify` is the
 *     whole mitigation in ADR-0006 for rendering untrusted markdown.
 *
 * ## What it deliberately does not do
 *
 * It does not claim to audit the bundled code itself. A scanner reading a package inventory cannot
 * see a CVE in code that has been flattened into `dist/ui/assets/index-*.js`; that is a source-level
 * scan (CodeQL), and the workflow says so rather than implying this covers it.
 *
 * Usage: node scripts/production-sbom.mjs [--out FILE]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const LOCKFILE = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));

const outFlag = process.argv.indexOf("--out");
const OUT = outFlag === -1 ? join(ROOT, "pi-central-sbom.json") : process.argv[outFlag + 1];

/**
 * The name of a lockfile entry, from its path.
 *
 * Nested paths look like `node_modules/a/node_modules/b`, so the segment after the LAST
 * `node_modules/` is the package's own directory. Scoped names are two segments (`@scope/name`).
 */
function nameFromPath(path) {
  const marker = "node_modules/";
  const tail = path.slice(path.lastIndexOf(marker) + marker.length);
  const parts = tail.split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Every installed package that is not dev-only, as SBOM components. */
function shippedComponents() {
  const components = [];
  for (const [path, entry] of Object.entries(LOCKFILE.packages)) {
    if (!path.startsWith("node_modules/")) continue;
    // `dev: true` means reachable only from a devDependency. Everything else ships.
    if (entry.dev === true) continue;
    if (typeof entry.version !== "string") continue;

    // A link entry is a workspace symlink; its siblings are recorded as real packages.
    if (entry.link === true) continue;

    const name = entry.name ?? nameFromPath(path);
    components.push({
      type: "library",
      name,
      version: entry.version,
      // `purl` is what Grype matches advisories against. Publishing one without a scheme makes
      // Grype log `purl scheme is not "pkg"` and silently skip the artifact, so it is built here.
      //
      // The scope keeps its `/` and only the `@` is encoded, which is npm's own form
      // (`pkg:npm/%40babel/traverse@7.0.0`). Grype resolves both that and the fully-encoded
      // variant today, so this is not working around a bug: the reason to match npm is that the
      // SBOM outlives this script, and a purl that differs from the ecosystem's canonical one
      // reads to a future consumer as a different package.
      purl: `pkg:npm/${name.replace("@", "%40")}@${entry.version}`,
      ...(entry.license === undefined ? {} : { licenses: [{ license: { id: entry.license } }] }),
    });
  }
  return components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const components = shippedComponents();

if (components.length === 0) {
  // Failing loudly is the point: an empty SBOM scans clean, and a clean scan of nothing is the
  // most misleading possible result.
  console.error("production-sbom: no shipped components found — the lockfile shape has changed?");
  process.exit(1);
}

const bom = {
  $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: "pi-central", name: "production-sbom.mjs", version: MANIFEST.version }],
    component: {
      type: "application",
      name: MANIFEST.name,
      version: MANIFEST.version,
      purl: `pkg:npm/${MANIFEST.name}@${MANIFEST.version}`,
    },
  },
  components,
};

writeFileSync(OUT, `${JSON.stringify(bom, null, 2)}\n`);

// Printed every run, because the number is the evidence that this saw the shipped tree and not the
// development one: the whole tree is ~284 components, and this is a small fraction of that.
const devOnly = Object.values(LOCKFILE.packages).filter((entry) => entry.dev === true).length;
console.log(
  `production-sbom: ${components.length} shipped components ` +
    `(${devOnly} dev-only packages excluded) -> ${OUT}`,
);
