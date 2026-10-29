/**
 * The README must not claim the package is unpublished (issue #127).
 *
 * It said *"Nothing is published yet"* for a while after `pi-central` was on npm, which is the kind of
 * false statement that costs a reader real time: they would go looking for a build-from-source path that
 * they do not need.
 *
 * The general lesson is the one this repository keeps re-learning: **a claim in prose is not checked by
 * anything.** So the invariant is asserted rather than remembered — the README must not contain the words
 * that say the artifact does not exist, and it must contain the command that installs it.
 *
 * Deliberately NOT asserted: the published version number. `check-version` forbids prose from stating it,
 * and pinning it here would be the same mistake in a test file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

test("the README does not claim the package is unpublished", () => {
  for (const phrase of [
    "Nothing is published yet",
    "Not yet published",
    "there is no released artifact",
    "no released artifact",
  ]) {
    assert.ok(!readme.includes(phrase), `README still says ${JSON.stringify(phrase)}`);
  }
});

test("the README tells a user how to install it", () => {
  // The other half: removing a false claim is not the same as making the true one. A user arriving at the
  // README needs the install command, and it has to be the *global* one — `npm install pi-central` inside a
  // project directory is a different (and surprising) thing.
  assert.match(readme, /npm install --global pi-central/, "the global install command");
  assert.match(readme, /npx pi-central/, "and the run-without-installing form");
});

test("the README carries an npm badge, so the published version is visible", () => {
  assert.match(readme, /img\.shields\.io\/npm\/v\/pi-central/, "an npm version badge");
  assert.match(readme, /npmjs\.com\/package\/pi-central/, "linking to the package page");
});
