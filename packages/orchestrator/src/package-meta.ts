/**
 * What version of Pi Central is this, and where does the package live (issue #52).
 *
 * ## Why this reads `package.json` instead of carrying a constant
 *
 * `pi-central --version` must report **the version that was published**, and the published version
 * is by definition the one in the shipped `package.json`. A TypeScript constant would be a second
 * place to update on every release, and the failure mode of getting it wrong is the worst kind: the
 * tool would confidently report a version it is not, and every bug report that followed would begin
 * with a false premise. So the number is read from the artifact itself and never restated.
 *
 * (The `protocol` package solves the opposite problem with a constant plus a pinning test — see
 * `packages/protocol/test/wire-surface.test.ts`. That is right there because `PROTOCOL_VERSION` is a
 * *contract* someone must consciously decide. A release version is a *fact about the artifact*, so
 * it is read, not asserted.)
 *
 * ## Why it walks up looking for a NAME
 *
 * The two layouts are genuinely different and both must work:
 *
 *   - **From source** (`npm run server`): this module lives at
 *     `packages/orchestrator/src/package-meta.ts`, and the owning package is three levels up. But
 *     the first `package.json` on the way up is `packages/orchestrator/package.json`, whose name is
 *     `@pi-central/orchestrator` and whose version merely happens to match today.
 *   - **From the bundle** (`bin/pi-central.js`): the owning package is one level up.
 *
 * Matching on `name === "pi-central"` rather than taking the first `package.json` found is what
 * makes this correct in the first case instead of accidentally correct. "Take the nearest
 * package.json" would pick the wrong file and look right, which is the shape of bug this project
 * keeps finding.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

/** The name of the published package. The one an update check looks up (issue #55). */
export const PACKAGE_NAME = "pi-central";

export interface PackageMeta {
  /** Absolute path to the package's own `package.json`. */
  path: string;
  /** Absolute path to the package root — where `bin/`, `dist/` and `package.json` live. */
  root: string;
  name: string;
  version: string;
}

/**
 * Walk up from `from` until a `package.json` naming this package is found.
 *
 * Returns `undefined` rather than throwing when none is found, because the callers have different
 * right answers for that: `--version` should say it cannot tell, and the UI resolution should fall
 * back to a path candidate. A throw here would turn a missing file into a crash.
 */
export function findOwnPackage(from: string = import.meta.url): PackageMeta | undefined {
  let directory = dirname(fileURLToPath(from));
  // Bounded by the filesystem root, and `parse(dir).root === dir` is the portable stop condition —
  // comparing against "/" would miss the drive-letter root on Windows.
  for (;;) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      const parsed = readPackageJson(candidate);
      if (parsed?.name === PACKAGE_NAME && typeof parsed.version === "string") {
        return { path: candidate, root: directory, name: parsed.name, version: parsed.version };
      }
    }
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root) return undefined;
    directory = parent;
  }
}

/** Read a `package.json`, or `undefined` if it is missing or not readable as an object. */
export function readPackageJson(path: string): { name?: unknown; version?: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as { name?: unknown; version?: unknown };
  } catch {
    // A malformed package.json is a packaging error, and the reporting belongs to whoever needs the
    // value — not to a helper that would then have to invent an error type for it.
    return undefined;
  }
}
