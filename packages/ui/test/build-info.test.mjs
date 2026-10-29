/**
 * The page knows which build it is (issue #114).
 *
 * The question this answers, asked four times in one session: *"is the UI I am looking at the code I just
 * built?"* The package version cannot answer it — every build of `0.3.0` reports `0.3.0`. Before this, the
 * only way was to `curl` the served HTML, grep the asset hash, and compare it to the file on disk.
 *
 * The stamp is **compiled in**, not queried: a value the page asks for could come back newer than the code
 * it is stamped onto, which is the failure mode in reverse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const source = stripComments(readFileSync(new URL("../src/build-info.ts", import.meta.url), "utf8"));
const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const settings = stripComments(
  readFileSync(new URL("../src/components/Settings.tsx", import.meta.url), "utf8"),
);

test("the build's identity is compiled in, not fetched at runtime", () => {
  // Compiled in means a stale page is exactly the page with an old stamp. A runtime lookup could answer
  // with something newer than the code displaying it.
  assert.match(vite, /define:\s*\{/, "Vite must inject the values");
  assert.match(vite, /VITE_PI_CENTRAL_COMMIT/, "the commit");
  assert.match(vite, /VITE_PI_CENTRAL_BUILT_AT/, "and the build time");
  assert.match(vite, /git rev-parse --short=7 HEAD/, "read from git at build time");
  assert.ok(!/fetch\(/.test(source), "the module must not make a request for its own identity");
});

test("a build with no commit says `dev` rather than inventing one", () => {
  // A local `npm run ui:build` outside a git checkout has no commit. Saying so is more useful than an
  // empty string, which reads as a broken value rather than an honest one.
  assert.match(vite, /commit \|\| "dev"/, "falls back at build time");
  assert.match(source, /\|\| "dev"/, "…and the reader defaults the same way");
  assert.match(source, /"unknown"/, "the time has an honest default too");
});

test("Settings shows the UI build, next to the package version and told apart from it", () => {
  // Two different facts: the package version is the same for every build of it, which is exactly why it
  // could not answer the question.
  assert.match(settings, /label="Version"/, "the package version is still there");
  assert.match(settings, /label="UI build"/, "and the build's own identity beside it");
  assert.match(settings, /buildLabel\(\)/, "rendered from the stamp");
});

test("the label is short enough to read at a glance", () => {
  // `a1b2c3d · 2026-10-29 08:41`. Seconds are noise; the date is what separates "yesterday's build" from
  // "the one I just made".
  const label = /export function buildLabel[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  assert.match(label, /slice\(0, 16\)/, "minutes, not seconds");
  assert.match(label, /replace\("T", " "\)/, "ISO's `T` replaced for reading");
});
