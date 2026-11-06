/**
 * Remembering where the picker was, and how it lists (issue #76).
 *
 * The reporter's requirement, verbatim: *"when users have been in a location before (previous directory picking), don't
 * let them start from the default again, pick up the last directory."*
 *
 * ## Why every case here is about a REFUSAL as much as a value
 *
 * `localStorage` outlives upgrades and is shared with anything else on this origin, so a stored path can name a
 * directory that was deleted, was on a volume that is now unmounted, or was never absolute. The rule this file pins is
 * the one `panel.ts` already follows: a corrupt or stale value degrades to the DEFAULT rather than to a broken state.
 * And it must degrade to "start at Places", not to "start at the nearest folder above" — silently opening a different
 * directory from the one remembered reads as the app forgetting you, which is precisely the complaint being fixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHOOSER_PREFS_KEY,
  defaultChooserPrefs,
  parseChooserPrefs,
  resumable,
  serializeChooserPrefs,
} from "../src/chooser-prefs.ts";

test("nothing stored means the default, not a crash", () => {
  assert.deepEqual(parseChooserPrefs(null), defaultChooserPrefs());
  assert.deepEqual(parseChooserPrefs(""), defaultChooserPrefs());
  // A half-written value from a crash mid-write.
  assert.deepEqual(parseChooserPrefs('{"lastDirectory":'), defaultChooserPrefs());
  assert.deepEqual(parseChooserPrefs("null"), defaultChooserPrefs());
  assert.deepEqual(parseChooserPrefs("[1,2]"), defaultChooserPrefs());
});

test("a remembered directory round-trips", () => {
  const prefs = { lastDirectory: "/Users/x/git/project", sort: "modified" as const, showHidden: true };
  assert.deepEqual(parseChooserPrefs(serializeChooserPrefs(prefs)), prefs);
});

test("a RELATIVE remembered path is DROPPED, not half-used", () => {
  // A relative path cannot be resumed and cannot be resolved against a place, so keeping it would put the chooser in a
  // state where `resumable` refuses it every time — the preference would look broken rather than absent.
  const parsed = parseChooserPrefs('{"lastDirectory":"git/project"}');
  assert.equal(parsed.lastDirectory, undefined);
});

test("an unrecognised sort degrades to name, and a truthy-but-wrong flag is not a flag", () => {
  const parsed = parseChooserPrefs('{"sort":"size","showHidden":"yes","lastDirectory":7}');
  assert.equal(parsed.sort, "name", "a mode that no longer exists cannot empty the list");
  assert.equal(parsed.showHidden, false, "only an explicit `true` shows dotfolders");
  assert.equal(parsed.lastDirectory, undefined, "a number is not a path");
});

test("the storage key is namespaced, like every other preference", () => {
  assert.match(CHOOSER_PREFS_KEY, /^pi-central\./);
});

// --- resumable: the stale-directory guard ---------------------------------------------------------

const places = [
  { path: "/Users/x", exists: true },
  { path: "/Users/x/git", exists: true },
  { path: "/Users/x/Projects", exists: false },
];

test("a remembered directory inside an EXISTING place is resumed", () => {
  assert.equal(resumable("/Users/x/git/project", places), "/Users/x/git/project");
  // The place itself is inside itself.
  assert.equal(resumable("/Users/x/git", places), "/Users/x/git");
});

test("a remembered directory under a place that is GONE is not resumed", () => {
  // An unmounted volume. Resuming into it would fail the first listing, so the chooser opens at Places instead —
  // "start again" rather than a listing that errors before the reader has done anything.
  assert.equal(resumable("/Volumes/ext/project", places), undefined);
});

test("a remembered directory that is GONE is not resumed, even though its PLACE is present", () => {
  // The bug this function had: `$HOME` exists on every machine, so checking only the place let a deleted
  // `~/Projects/notes` through — and the reader got `not-found` before touching anything. Found by asserting the one
  // case the first version could not see.
  assert.equal(resumable("/Users/x/Projects/notes", places, false), undefined);
  // Not checked is NOT missing: an unverified path is allowed through, because refusing on "unknown" would make every
  // first open start at Places and the feature would appear not to work.
  assert.equal(resumable("/Users/x/Projects/notes", places, undefined), "/Users/x/Projects/notes");
});

test("a remembered directory OUTSIDE every place is not resumed", () => {
  assert.equal(resumable("/etc", places), undefined);
  assert.equal(resumable("/Users/xyz/git", places), undefined, "a prefix-named sibling is not inside the place");
});

test("unknown places and no memory both mean 'start at Places'", () => {
  assert.equal(resumable("/Users/x/git/p", undefined), undefined);
  assert.equal(resumable(undefined, places), undefined);
});

// --- list ordering and ages ----------------------------------------------------------------------

test("an age is coarse, and covers the whole range without inventing a unit", async () => {
  const { ageOf } = await import("../src/age.ts");
  const now = Date.UTC(2026, 10, 6, 12, 0, 0);
  assert.equal(ageOf(now - 10_000, now), "now");
  assert.equal(ageOf(now - 5 * 60_000, now), "5m");
  assert.equal(ageOf(now - 3 * 3_600_000, now), "3h");
  assert.equal(ageOf(now - 2 * 86_400_000, now), "2d");
  assert.equal(ageOf(now - 21 * 86_400_000, now), "3w");
  assert.equal(ageOf(now - 90 * 86_400_000, now), "3mo");
  assert.equal(ageOf(now - 400 * 86_400_000, now), "1y");
});

test("a FUTURE mtime reads as 'now', never as a negative age", async () => {
  const { ageOf } = await import("../src/age.ts");
  // Two machines disagree about the clock, and `-2m ago` in a folder list reads as a bug rather than as skew.
  const now = Date.UTC(2026, 10, 6, 12, 0, 0);
  assert.equal(ageOf(now + 60_000, now), "now");
});
