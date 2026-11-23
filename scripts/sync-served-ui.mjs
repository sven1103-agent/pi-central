#!/usr/bin/env node
/**
 * Keep the SERVED UI copy in step with the one `ui:build` just wrote.
 *
 * ## The trap this closes, measured
 *
 * A checkout holds two builds of the same UI: `packages/ui/dist` (where Vite writes) and `dist/ui` (the copy the
 * packaged app serves, made by `build:package`). `npm run app` spawns the orchestrator from `bin/pi-central.js`,
 * which serves `dist/ui`.
 *
 * So a developer's loop was: change a component, `npm run ui:build`, `npm run app` -- and see the OLD interface.
 * The code was right, the new build existed, and the window was one step behind. Diagnosed only after telling a
 * reader to look for a control that could not possibly be on screen.
 *
 * ## Why copying rather than a flag
 *
 * The alternative is to make `npm run app` point `PI_CENTRAL_UI_DIST` at `packages/ui/dist`. That fixes the dev
 * loop and leaves the trap for anyone running `serve:package` or the installed app, where the copy is what exists.
 * Syncing means there is one build to look at, whichever way it is launched.
 *
 * It is copied ONLY when `dist/ui` already exists. A fresh checkout that has never packaged should not have a
 * `dist/` created behind its back -- that directory is a build artifact, and inventing it would make `git status`
 * and the release audit disagree about what is on disk.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages", "ui", "dist");
const target = join(root, "dist", "ui");

if (!existsSync(source)) {
  console.error("sync-served-ui: no build at " + source + "; nothing to copy");
  process.exit(1);
}
if (!existsSync(join(root, "dist"))) {
  console.log("sync-served-ui: no dist/ in this checkout, so there is no served copy to update");
  process.exit(0);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log("sync-served-ui: copied the fresh build into dist/ui (what the app serves)");
