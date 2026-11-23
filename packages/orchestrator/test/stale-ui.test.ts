import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { staleBuiltUi } from "../src/static-ui.ts";

/**
 * A stale UI build must say so, because its symptom is indistinguishable from a code bug.
 *
 * Measured: the session picker's browser toggle was absent from the running app while present in the source and in
 * the freshly built `packages/ui/dist`. `npm run app` spawns the orchestrator from `bin/pi-central.js`, which serves
 * `dist/ui` -- a COPY made by `build:package`. Nothing on screen distinguished "this feature is broken" from "this
 * window is one build behind".
 */

const root = mkdtempSync(join(process.env["PI_CENTRAL_TEST_PRIVATE_ROOT"] ?? "/tmp", "stale-ui-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

/** A built-UI shape: an index.html naming one entry bundle. `when` sets both files' mtime. */
function builtUi(name: string, entry: string, when: number): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<script type="module" src="/assets/${entry}"></script>`);
  writeFileSync(join(dir, `assets-${entry}`), "// bundle");
  // servedUiIdentity reads the ENTRY bundle's mtime, so the bundle has to exist under its real name too.
  mkdirSync(join(dir, "assets"), { recursive: true });
  const bundle = join(dir, "assets", entry);
  writeFileSync(bundle, "// bundle");
  utimesSync(join(dir, "index.html"), when / 1000, when / 1000);
  utimesSync(bundle, when / 1000, when / 1000);
  return dir;
}

test("a served build older than its sibling is reported, naming the fix", () => {
  const older = builtUi("served", "index-aaaa.js", 1_000_000);
  const newer = builtUi("other", "index-bbbb.js", 2_000_000);
  const warning = staleBuiltUi(older, newer);
  assert.ok(warning !== undefined, "an older served build must be reported");
  assert.match(warning, /npm run build:package/, "and must name the command that fixes it");
  assert.match(warning, new RegExp(newer.replace(/\//g, "\\/")), "and must name the newer directory");
});

test("nothing is said when the copies agree, when the sibling is older, or when it is absent", () => {
  // Each of these is a state where a warning would be WRONG, and a warning that fires when nothing is wrong is how
  // people learn to ignore startup output.
  const current = builtUi("same", "index-cccc.js", 3_000_000);
  assert.equal(staleBuiltUi(current, current), undefined, "the same directory is not a sibling");

  const fresh = builtUi("fresh", "index-dddd.js", 4_000_000);
  const staleOther = builtUi("stale", "index-eeee.js", 3_500_000);
  assert.equal(staleBuiltUi(fresh, staleOther), undefined, "a sibling that is OLDER is the normal state after a build");

  // Same entry bundle means the same build, whatever the timestamps say (a copy preserves mtimes unevenly).
  const copyA = builtUi("copy-a", "index-ffff.js", 5_000_000);
  const copyB = builtUi("copy-b", "index-ffff.js", 6_000_000);
  assert.equal(staleBuiltUi(copyA, copyB), undefined, "the same entry bundle is the same build");

  assert.equal(staleBuiltUi(fresh, join(root, "does-not-exist")), undefined, "an absent sibling says nothing");
});

test("the shipped UI carries the sidecar control, not just the source", () => {
  /*
   * The defect this holds, measured twice: `packages/ui/src` had the session-browser control while the served bundle did
   * not, because `bin/pi-central.js` serves `dist/ui` — a COPY made by `build:package`. The first time it was a stale copy
   * (`scripts/sync-served-ui.mjs` exists for that). The second time it was the same class one layer out: the package under
   * test was the GLOBAL install, which predates the feature entirely.
   *
   * Both looked identical from inside the app — a switch that is simply not there — so the check has to compare artifacts
   * rather than trust either. Skipped unless a built tree exists, because `verify` runs before any build in CI.
   */
  const built = join(import.meta.dirname, "..", "..", "..", "dist", "ui", "assets");
  if (!existsSync(built)) return console.log("# skip: no dist/ui, so there is nothing served to check");
  const bundles = readdirSync(built).filter((f) => /^index-.*\.js$/.test(f));
  assert.ok(bundles.length > 0, "a built UI has an entry bundle");
  const text = bundles.map((f) => readFileSync(join(built, f), "utf8")).join("\n");
  // The string literals the control is built from, which survive minification even though the identifiers do not.
  for (const marker of ["Preview its work in a browser", "pi-central:session-browser"]) {
    assert.ok(text.includes(marker), `the served bundle must contain ${JSON.stringify(marker)}`);
  }
});
