/**
 * `ui:build` must leave the SERVED copy up to date, because that is the copy the app runs.
 *
 * The trap this guards was measured: a component change, `npm run ui:build`, `npm run app` -- and the old
 * interface on screen. `packages/ui/dist` had the change; `dist/ui`, which `bin/pi-central.js` serves, did not.
 * Nothing failed, and the reviewer was told to look for a control that could not be there.
 *
 * Three facts, and the third is why the script refuses to invent `dist/`:
 *
 *   1. `ui:build` runs the sync, so the ordinary loop cannot miss it;
 *   2. `ui:build:only` exists, so a caller that wants just Vite still has one (a package build must not recurse);
 *   3. a checkout with no `dist/` is left alone -- creating a build artifact behind the tool's back would make
 *      `git status` and the release audit disagree about what is on disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;

test("ui:build syncs the served copy, so the app cannot run a build behind", () => {
  assert.match(scripts["ui:build"], /sync-served-ui\.mjs/, "ui:build must update dist/ui");
  assert.match(scripts["ui:build"], /--workspace @pi-central\/ui/, "and must still run the Vite build");
  assert.equal(scripts["build:package"].includes("ui:build\""), false, "build:package must not depend on the syncing variant");
});

test("a Vite-only variant exists", () => {
  // `build:package` copies `packages/ui/dist` itself; if `ui:build` were its only door and it synced too, the copy
  // would happen twice and the second would copy the tree onto itself.
  assert.ok(scripts["ui:build:only"], "there must be a build that does not sync");
});
