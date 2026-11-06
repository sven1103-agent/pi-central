/**
 * The directory chooser's orchestrator half (issue #76, ADR-0012).
 *
 * ## What is being tested, and why it is the boundary rather than the listing
 *
 * This module deliberately reads directories that no session owns, which is a wider capability than the file
 * browser's. So the tests are about the LIMIT of that capability — that a path outside the places is refused, that
 * containment is by segment rather than by prefix, that only directories are offered — and about the refusals being
 * distinguishable, because "no such folder" and "I may not look" send the reader to different fixes (#196).
 *
 * Every refusal here is paired with a case that must still SUCCEED. A check that refuses too much passes a file full
 * of negative assertions, so the positive half is the one that catches the regression.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abbreviate, listPlace, nameOf, placesFor, resolveInPlaces } from "../src/places.ts";

/**
 * A fake `$HOME` with `git/` and `src/` under it, plus a sibling that LOOKS like a place.
 *
 * The sibling (`home-evil`) is the point: it is `home`'s name plus a suffix, so a prefix comparison would accept it.
 * ADR-0007 forbids exactly that comparison, and this repository has shipped that bug once already
 * (`own-installation.ts`, issue #25).
 */
const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-central-places-")));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

function makeHome(): string {
  const home = join(base, `home-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, "git", "alpha"), { recursive: true });
  mkdirSync(join(home, "git", "beta"), { recursive: true });
  mkdirSync(join(home, "git", ".hidden-thing"), { recursive: true });
  // A FILE inside a place: it must never appear in a directory chooser.
  writeFileSync(join(home, "git", "README.md"), "not a directory\n");
  mkdirSync(join(home, "src"), { recursive: true });
  mkdirSync(`${home}-evil`, { recursive: true });
  return home;
}

// --- The roots -----------------------------------------------------------------------------------

test("the places are derived from $HOME, and each says whether it is actually there", () => {
  const home = makeHome();
  const places = placesFor(home);
  const byId = new Map(places.map((place) => [place.id, place]));

  assert.equal(byId.get("home")?.path, home, "Home IS $HOME");
  assert.equal(byId.get("home")?.exists, true);
  assert.equal(byId.get("git")?.path, join(home, "git"));
  assert.equal(byId.get("git")?.exists, true, "the fixture has a git/ directory");

  // `Projects` does not exist in the fixture. It is still RETURNED, with `exists: false` — hiding it would read as
  // "Pi Central does not know where your code is", when the truth is that this machine has no such folder.
  assert.equal(byId.get("projects")?.exists, false, "absent roots are returned and marked, never omitted");
  assert.ok(places.every((place) => place.path.startsWith(home)), "every root is under $HOME");
  assert.ok(places.length >= 5, "a chooser with two roots is not a chooser");
});

test("a root's label is its own name, never a path", () => {
  // Two roots can share a basename with a project (`git` the folder, `git` a project). The label is what the reader
  // clicks, so it must be a word rather than a truncated path.
  for (const place of placesFor(makeHome())) {
    assert.ok(!place.label.includes("/"), `${place.label} must not be a path`);
    assert.ok(place.label.length > 0);
  }
});

// --- Containment ----------------------------------------------------------------------------------

test("a path outside every place is refused, and refused without touching the disk", () => {
  const home = makeHome();
  const places = placesFor(home);
  // A sibling named `home…-evil`: contains the root as a STRING prefix, is not inside it by SEGMENTS.
  assert.equal(resolveInPlaces(places, `${home}-evil`), undefined, "a prefix-named sibling is not inside the root");
  assert.equal(resolveInPlaces(places, "/etc"), undefined, "$HOME's places cannot reach /etc");
  assert.equal(resolveInPlaces(places, "/"), undefined, "the filesystem root is not a place");
  assert.equal(resolveInPlaces(places, "git/alpha"), undefined, "a relative path is not a place path");
  assert.equal(resolveInPlaces(places, "/tmp/x\0y"), undefined, "a NUL byte is not a path");
});

test("a path INSIDE a place resolves, and is returned RESOLVED", () => {
  const home = makeHome();
  const places = placesFor(home);
  const inside = resolveInPlaces(places, join(home, "git", "alpha"));
  assert.equal(inside, join(home, "git", "alpha"));
  // The root itself is inside itself — a strict `<` comparison would refuse listing `~/git`.
  assert.equal(resolveInPlaces(places, join(home, "git")), join(home, "git"));
});

test("containment resolves SYMLINKS before comparing, so a resolved root is not refused", () => {
  // macOS's `/tmp` is a symlink to `/private/tmp`, and this whole fixture lives under a realpath'd temp dir. If the
  // comparison ran on the un-resolved candidate, a path the module had just handed out would be refused on the way
  // back in — which is the shape of bug that makes a picker unusable rather than merely wrong.
  const home = makeHome();
  const link = join(home, "git", "linked");
  symlinkSync(join(home, "src"), link);
  const places = placesFor(home);
  assert.equal(resolveInPlaces(places, link), join(home, "src"), "the RESOLVED target is what comes back");
});

// --- Listing --------------------------------------------------------------------------------------

test("a listing offers DIRECTORIES ONLY, sorted, with hidden folders excluded by default", () => {
  const home = makeHome();
  const places = placesFor(home);
  const result = listPlace(places, join(home, "git"));
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const names = result.value.entries.map((entry) => entry.name);
  assert.deepEqual(names, ["alpha", "beta"], "a chooser offers folders: no README.md, no dotfile");
  assert.ok(
    result.value.entries.every((entry) => entry.path.startsWith(join(home, "git"))),
    "every entry carries an absolute path, so a click needs no re-derivation",
  );
});

test("hidden folders are offered when asked for, because they are sometimes the answer", () => {
  const home = makeHome();
  const places = placesFor(home);
  const result = listPlace(places, join(home, "git"), { includeHidden: true });
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.entries.map((entry) => entry.name),
    [".hidden-thing", "alpha", "beta"],
    "sorted with the dotfile included",
  );
});

test("an EMPTY directory is a successful listing with no entries, not a failure", () => {
  // The distinction `files.ts` exists to protect: "this folder has nothing in it" and "I could not read this folder"
  // are opposite facts, and only one of them means the folder is usable.
  const home = makeHome();
  const places = placesFor(home);
  mkdirSync(join(home, "git", "empty"));
  const result = listPlace(places, join(home, "git", "empty"));
  assert.ok(result.ok, "empty is not an error");
  assert.deepEqual(result.value.entries, []);
});

test("a directory that does not exist is not-found WITH ITS CODE, not an empty listing", () => {
  const home = makeHome();
  const places = placesFor(home);
  const result = listPlace(places, join(home, "git", "nope"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.reason, "not-found");
  assert.equal(result.error.code, "ENOENT");
});

test("a path outside the places is refused by the LISTING too, not only by the resolver", () => {
  // Belt and braces: `listPlace` is the public entry point, so the refusal must be reachable from it. A resolver that
  // refused while the caller skipped it would be a check nobody runs.
  const home = makeHome();
  const places = placesFor(home);
  const result = listPlace(places, "/etc");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error.message, /not inside one of the places/);
});

test("the listing says where UP leads, and says nothing at a root", () => {
  const home = makeHome();
  const places = placesFor(home);

  const deep = listPlace(places, join(home, "git", "alpha"));
  assert.ok(deep.ok);
  assert.equal(deep.value.parent, join(home, "git"), "one level up inside the place");

  const atRoot = listPlace(places, join(home, "git"));
  assert.ok(atRoot.ok);
  // `parent` is the root itself, which the reader should not be offered: "Up" from `~/git` would leave the places and
  // the next request would refuse it. `undefined` is the honest answer.
  assert.equal(atRoot.value.parent, undefined, "no ascend above a place");
});

test("the listing names the root it belongs to and the path under it", () => {
  const home = makeHome();
  const places = placesFor(home);
  const result = listPlace(places, join(home, "git", "alpha"));
  assert.ok(result.ok);
  assert.equal(result.value.root, join(home, "git"));
  assert.equal(result.value.relative, "alpha");
});

// --- Small helpers --------------------------------------------------------------------------------

test("a path under $HOME is abbreviated, and one that merely shares a prefix is not", () => {
  const home = "/Users/x";
  assert.equal(abbreviate("/Users/x/git/a", home), "~/git/a");
  assert.equal(abbreviate("/Users/x", home), "~");
  // The prefix case that `startsWith` alone gets wrong.
  assert.equal(abbreviate("/Users/xyz/git", home), "/Users/xyz/git");
});

test("a name is the last segment, and a root keeps its own name", () => {
  assert.equal(nameOf("/Users/x/git/project"), "project");
  assert.equal(nameOf("/Users/x"), "x");
});
