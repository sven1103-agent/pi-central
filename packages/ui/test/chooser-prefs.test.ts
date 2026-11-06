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
  loadChooserPrefs,
  openingDirectory,
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

test("an age writes its UNIT, because the abbreviations were unreadable", async () => {
  // The first version returned `4m`, `2d`, `2w`. A reviewer said what a reader would say: "users will not understand the
  // sorting like presented here". `4m` is four minutes or four months, and `2w` needs a pause — compression is only worth
  // paying for when the reader already knows the unit.
  const { ageOf, dateOf } = await import("../src/age.ts");
  const now = Date.UTC(2026, 10, 6, 12, 0, 0);
  assert.equal(ageOf(now - 10_000, now), "now");
  assert.equal(ageOf(now - 5 * 60_000, now), "5 min");
  assert.equal(ageOf(now - 3 * 3_600_000, now), "3 h");
  assert.equal(ageOf(now + 0, now), "now");
  // A day gets a word: "yesterday" is what a person says, and `1 d` is the abbreviation this exists to remove.
  assert.equal(ageOf(now - 1 * 86_400_000, now), "yesterday");
  assert.equal(ageOf(now - 2 * 86_400_000, now), "2 d");

  // Past a month it is a DATE, which is what Finder and Explorer do: "11 months ago" is harder to place than "12 Oct".
  assert.equal(ageOf(now - 90 * 86_400_000, now), dateOf(now - 90 * 86_400_000, now));
  assert.match(ageOf(now - 400 * 86_400_000, now), /\d{4}$/, "an older year is named, so nothing is implied incorrectly");
});

test("a FUTURE mtime reads as 'now', never as a negative age", async () => {
  const { ageOf } = await import("../src/age.ts");
  // Two machines disagree about the clock, and `-2m ago` in a folder list reads as a bug rather than as skew.
  const now = Date.UTC(2026, 10, 6, 12, 0, 0);
  assert.equal(ageOf(now + 60_000, now), "now");
});

// --- What the picker opens on (issue #76, reported from a screenshot) ------------------------------
//
// "Please make the users home folder the default one. I don't know from where this project folder is coming from."
//
// Both halves were one bug: `lastDirectory` was written on every DESCENT, so merely looking inside a folder made it the
// place the picker reopened from, forever. Nothing about looking at a folder says "start here", which is why the value
// appeared from nowhere.

test("with no history, the picker opens at HOME", () => {
  // The default the reporter asked for, and the right one: `$HOME` exists on every machine and is never empty, so a
  // first run lands somewhere useful instead of on a menu of seven names.
  assert.equal(openingDirectory(defaultChooserPrefs(), places, "/Users/x"), "/Users/x");
});

test("once a session has been STARTED somewhere, that wins over home", () => {
  // The earlier requirement — "pick up the last directory" — and it does not contradict the new one: a fresh install has
  // no history, so it gets home; after a session is opened somewhere, that is a stronger signal than home is.
  const prefs = { ...defaultChooserPrefs(), lastDirectory: "/Users/x/git/project" };
  assert.equal(openingDirectory(prefs, places, "/Users/x"), "/Users/x/git/project");
});

test("a remembered directory that is gone falls back to HOME, not to Places", () => {
  // Degrading to home rather than to the place menu: the reader still gets somewhere they can work, and the fallback is
  // the same default a first run gets.
  const prefs = { ...defaultChooserPrefs(), lastDirectory: "/Volumes/unmounted/project" };
  assert.equal(openingDirectory(prefs, places, "/Users/x"), "/Users/x");
});

test("a HOME that is not inside any place falls through to Places, rather than failing to list", () => {
  // Not hypothetical in a container: if `$HOME` is `/root` and no place covers it, opening there would mean the first
  // listing is refused. `undefined` is honest — the reader gets the Places pane.
  assert.equal(openingDirectory(defaultChooserPrefs(), [{ path: "/Users/x/git", exists: true }], "/root"), undefined);
});

test("nothing is remembered when the reader merely LOOKS inside a folder", async () => {
  /*
   * The bug itself, tested at the seam that carried it.
   *
   * `onNavigated` used to persist on every row click, so browsing into `~/git/data-management` set the resume point. This
   * asserts the CALLBACK SHAPE: the sheet may pass navigation up (it needs it as the selection), but persistence is
   * `App#onOpenDirectory`'s job — it is called there and nowhere else.
   */
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // EXACTLY ONE INVOCATION — the definition and the dependency array are the other two mentions, and a second call site
  // is precisely the bug being prevented.
  const invocations = [...app.matchAll(/rememberOpenedDirectory\((?!cwd\b)/g)].length;
  assert.equal(invocations, 0, "no call without the opened directory — the only invocation passes the cwd");
  assert.equal([...app.matchAll(/rememberOpenedDirectory\(cwd\)/g)].length, 1, "exactly one: inside onOpenDirectory");
  assert.match(app, /const onOpenDirectory = useCallback\([\s\S]{0,400}?rememberOpenedDirectory\(cwd\)/, "called when a session starts");
  // And nothing routes navigation into it.
  assert.ok(!/onNavigated:\s*remember/.test(app), "navigation is not persistence");
});

// --- Migrating the value the buggy release left behind --------------------------------------------
//
// Fixing the writer is not enough. The bad `lastDirectory` is already in the reporter's `localStorage`, and it would go
// on opening the picker in that folder until something overwrote it — so they would refresh, open the picker, and see
// the same unexplained folder the fix was supposed to remove.

/** A store backed by a plain map, so a migration can be exercised without a browser. */
function store(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return (key: string) => map.get(key) ?? null;
}

test("a VERSIONLESS stored value drops the browsed directory but keeps the real preferences", () => {
  // Written by the release that persisted on every descent: `data-management` is a folder the reader only LOOKED at.
  const raw = JSON.stringify({ lastDirectory: "/Users/x/git/data-management", sort: "modified", showHidden: true });
  const prefs = loadChooserPrefs(store({ "pi-central.chooser": raw }));
  assert.equal(prefs.lastDirectory, undefined, "the unexplained folder is gone");
  assert.equal(prefs.sort, "modified", "but a preference that was never wrong survives");
  assert.equal(prefs.showHidden, true, "including this one — punishing it twice for one defect would be unfair");
});

test("a CURRENT value is read as written, so the migration does not eat a real choice", () => {
  // After the fix, `lastDirectory` means "a session was started here", which IS worth keeping.
  const raw = serializeChooserPrefs({ lastDirectory: "/Users/x/git/project", sort: "name", showHidden: false });
  const prefs = loadChooserPrefs(store({ "pi-central.chooser": raw }));
  assert.equal(prefs.lastDirectory, "/Users/x/git/project", "kept");
});

test("the migration leaves the picker opening at HOME, which is what was asked for", () => {
  // End to end: the stored value is the bad one, and the outcome is home rather than `data-management`.
  const raw = JSON.stringify({ lastDirectory: "/Users/x/git/data-management", sort: "name", showHidden: false });
  const prefs = loadChooserPrefs(store({ "pi-central.chooser": raw }));
  assert.equal(openingDirectory(prefs, places, "/Users/x"), "/Users/x");
});

test("nothing stored means defaults, and no crash", () => {
  assert.deepEqual(loadChooserPrefs(store()), defaultChooserPrefs());
  assert.deepEqual(loadChooserPrefs(store({ "pi-central.chooser": "not json" })), defaultChooserPrefs());
});
