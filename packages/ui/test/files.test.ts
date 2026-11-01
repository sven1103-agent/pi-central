/**
 * The file tree's state (issue #8).
 *
 * The assertions that matter most are the DISTINCTIONS, because each one is a way the UI could
 * assert something false:
 *
 *   - `unloaded` vs `loaded: []` — "not asked" is not "empty".
 *   - `error` vs `loaded: []` — "refused" is not "empty" either.
 *   - one session's tree vs another's, since the cache is shared and keyed by both.
 *   - a stale answer for another directory, which must not be rendered as this one's contents.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  childPath,
  directoryAt,
  fileAt,
  fileKey,
  initialFilesState,
  isBrokenLink,
  isEnterable,
  isExpanded,
  openFileFor,
  reduceFiles,
  showsHidden,
  showsWrapped,
  TREE_REREAD_MS,
  newestMtime,
  splitFileKey,
  staleDirectories,
} from "../src/files.ts";

test("a refused LISTING is an error directory, never an empty one", () => {
  // The central distinction of issue #8's UI half. `filesFailed` exists precisely so a refusal cannot
  // be reduced to `loaded: []` — which would tell the reader the directory is empty when the request
  // was refused. Asserted on BOTH the reason and the absence of entries, because either alone could
  // pass while the other regressed.
  const state = reduceFiles(initialFilesState(), {
    kind: "filesFailed",
    sessionId: "s1",
    path: "../secret",
    reason: "escapes-cwd",
    message: '"../secret" resolves outside the working directory',
  });
  const dir = directoryAt(state, "s1", "../secret");
  assert.equal(dir.status, "error");
  assert.equal(dir.status === "error" && dir.reason, "escapes-cwd");
  // Falsifier for the collapse: a `loaded` directory here would render as "empty" or "no files".
  assert.notEqual(dir.status, "loaded");
});

test("a failed listing and a successful empty listing are different states", () => {
  // Directly compares the two, so a refactor that made `filesFailed` write `loaded: []` fails here
  // even if each state is individually plausible.
  const failed = reduceFiles(initialFilesState(), {
    kind: "filesFailed",
    sessionId: "s1",
    path: "x",
    reason: "permission",
    code: "EACCES",
    message: "cannot list (EACCES)",
  });
  const empty = reduceFiles(initialFilesState(), {
    kind: "filesLoaded",
    sessionId: "s1",
    path: "x",
    entries: [],
    truncated: false,
  });
  assert.notDeepEqual(directoryAt(failed, "s1", "x"), directoryAt(empty, "s1", "x"));
  assert.equal(directoryAt(failed, "s1", "x").status, "error");
  assert.equal(directoryAt(empty, "s1", "x").status, "loaded");
});

test("a listed directory and a read file do not share an entry even at the same path", () => {
  // A path can be both listed (as a directory) and read (as a file) across a request boundary; the
  // two caches are separate so a refusal of one cannot overwrite the other's good answer. This is why
  // `fileError` carries `request` rather than one opaque error slot.
  let state = reduceFiles(initialFilesState(), {
    kind: "filesLoaded",
    sessionId: "s1",
    path: "p",
    entries: [{ name: "inner", kind: "file", hidden: false }],
    truncated: false,
  });
  state = reduceFiles(state, {
    kind: "fileFailed",
    sessionId: "s1",
    path: "p",
    reason: "is-directory",
    message: '"p" is a directory',
  });
  // The listing survived; only the file read failed.
  assert.equal(directoryAt(state, "s1", "p").status, "loaded");
  assert.equal(fileAt(state, "s1", "p").status, "error");
});

test("a symlink to a DIRECTORY is enterable, and a plain link to a file is not", () => {
  // The bug this guards: `kind === "directory"` alone makes every link a file, so clicking a
  // `docs -> ../docs` link issues a read for a directory and surfaces "That is a directory".
  assert.equal(isEnterable({ name: "d", kind: "directory", hidden: false }), true);
  assert.equal(isEnterable({ name: "l", kind: "symlink", linkTarget: "directory", hidden: false }), true);
  assert.equal(isEnterable({ name: "l", kind: "symlink", linkTarget: "file", hidden: false }), false);
  assert.equal(isEnterable({ name: "f", kind: "file", hidden: false }), false);
  // `linkTarget` absent means "not established" — an older orchestrator, or a non-link. Treated as
  // not enterable, which is the safe reading: a needless failed read beats expanding a file.
  assert.equal(isEnterable({ name: "l", kind: "symlink", hidden: false }), false);
});

test("a dangling symlink is not enterable and is reported as broken", () => {
  // Expanding it would request a listing of something that does not exist, and the refusal would read
  // as an app bug rather than as a broken link on disk — so it is stated instead.
  const dangling = { name: "gone", kind: "symlink" as const, linkTarget: "missing" as const, hidden: false };
  assert.equal(isEnterable(dangling), false);
  assert.equal(isBrokenLink(dangling), true);
  assert.equal(isBrokenLink({ name: "l", kind: "symlink", linkTarget: "directory", hidden: false }), false);
  assert.equal(isBrokenLink({ name: "f", kind: "file", hidden: false }), false);
});

test("a directory is `unloaded` until asked, which is NOT the same as empty", () => {
  // The distinction the module exists to protect. If this defaulted to `loaded: []`, the tree would
  // render an empty directory where the truth is that nothing had been requested — and a spinner
  // would be impossible to express.
  assert.deepEqual(directoryAt(initialFilesState(), "s1", ""), { status: "unloaded" });
});

test("an empty listing is a real answer, and says so", () => {
  // The falsifier for the case above: once the orchestrator answers with no entries, the state must
  // be `loaded` with an empty array — a fact about the directory, not an absence of one.
  const state = reduceFiles(initialFilesState(), {
    kind: "filesLoaded",
    sessionId: "s1",
    path: "",
    entries: [],
    truncated: false,
  });
  assert.deepEqual(directoryAt(state, "s1", ""), { status: "loaded", entries: [], truncated: false });
});

test("a refusal is `error`, never an empty directory", () => {
  // ADR-0007's guardrails surface here. An escape reported as `loaded: []` would tell the reader the
  // directory is empty when the request was refused, which is the failure `transcriptError` exists
  // to prevent elsewhere.
  const state = reduceFiles(initialFilesState(), {
    kind: "fileFailed",
    sessionId: "s1",
    path: "../secret",
    reason: "escapes-cwd",
    message: 'resolves outside the session working directory',
  });
  const file = fileAt(state, "s1", "../secret");
  assert.equal(file.status, "error");
  if (file.status === "error") {
    assert.equal(file.reason, "escapes-cwd");
  }
});

test("the OS code is preserved when there is one, and absent when there is not", () => {
  // A permission failure reported as a missing file is the bug the issue names. The code is the part
  // that distinguishes them, so it must survive the round trip rather than being flattened.
  const withCode = reduceFiles(initialFilesState(), {
    kind: "fileFailed",
    sessionId: "s1",
    path: "locked.txt",
    reason: "permission",
    code: "EACCES",
    message: "permission denied (EACCES)",
  });
  const got = fileAt(withCode, "s1", "locked.txt");
  assert.equal(got.status === "error" && got.code, "EACCES");

  const without = reduceFiles(initialFilesState(), {
    kind: "fileFailed",
    sessionId: "s1",
    path: "x",
    reason: "too-large",
    message: "too big",
  });
  const other = fileAt(without, "s1", "x");
  assert.equal(other.status === "error" && other.code, undefined);
});

test("two sessions with the same relative path do not share an entry", () => {
  // The cache is one object keyed by BOTH ids. A key of path alone would make two sessions' `src`
  // directories the same entry, so expanding one would show the other's contents.
  let state = reduceFiles(initialFilesState(), {
    kind: "filesLoaded",
    sessionId: "s1",
    path: "src",
    entries: [{ name: "a.ts", kind: "file", hidden: false }],
    truncated: false,
  });
  state = reduceFiles(state, {
    kind: "filesLoaded",
    sessionId: "s2",
    path: "src",
    entries: [{ name: "b.py", kind: "file", hidden: false }],
    truncated: false,
  });

  const a = directoryAt(state, "s1", "src");
  const b = directoryAt(state, "s2", "src");
  assert.equal(a.status === "loaded" && a.entries[0]?.name, "a.ts");
  assert.equal(b.status === "loaded" && b.entries[0]?.name, "b.py");
});

test("a path containing a separator does not collide with a nested path", () => {
  // Why the key uses NUL rather than `/`: with a `/` separator, session `s1` path `a/b` and a
  // hypothetical different pair could produce the same key. NUL cannot appear in a POSIX path.
  assert.notEqual(fileKey("s1", "a/b"), fileKey("s1/a", "b"));
  assert.deepEqual(splitFileKey(fileKey("s1", "a/b/c")), { sessionId: "s1", path: "a/b/c" });
  assert.deepEqual(splitFileKey(fileKey("s1", "")), { sessionId: "s1", path: "" });
});

test("truncation is carried through, so a capped listing cannot read as complete", () => {
  const state = reduceFiles(initialFilesState(), {
    kind: "filesLoaded",
    sessionId: "s1",
    path: "",
    entries: [{ name: "a", kind: "file", hidden: false }],
    truncated: true,
  });
  const dir = directoryAt(state, "s1", "");
  assert.equal(dir.status === "loaded" && dir.truncated, true);
});

test("the open file's path and contents are produced together", () => {
  // One lookup produces the pair, so a component cannot render one file's path above another file's
  // text — a real hazard when a slow read is overtaken by a second click.
  let state = reduceFiles(initialFilesState(), {
    kind: "fileLoaded",
    sessionId: "s1",
    path: "a.txt",
    bytes: 3,
    content: { kind: "text", text: "AAA" },
  });
  state = reduceFiles(state, { kind: "openFile", sessionId: "s1", path: "a.txt" });

  const open = openFileFor(state, "s1");
  assert.equal(open?.path, "a.txt");
  assert.equal(open?.state.status === "loaded" && open.state.content.kind === "text" && open.state.content.text, "AAA");
});

test("nothing open means no pane state, rather than an empty path", () => {
  assert.equal(openFileFor(initialFilesState(), "s1"), undefined);
  const closed = reduceFiles(
    reduceFiles(initialFilesState(), { kind: "openFile", sessionId: "s1", path: "a.txt" }),
    { kind: "closeFile", sessionId: "s1" },
  );
  assert.equal(openFileFor(closed, "s1"), undefined);
});

test("collapsing keeps the cached listing, so reopening does not refetch", () => {
  // Deliberate: the tree's open state and its cache are different things. Emptying the cache on
  // collapse would make every toggle a network round trip for data already known.
  let state = reduceFiles(initialFilesState(), {
    kind: "filesLoaded",
    sessionId: "s1",
    path: "src",
    entries: [{ name: "a.ts", kind: "file", hidden: false }],
    truncated: false,
  });
  state = reduceFiles(state, { kind: "toggleExpanded", sessionId: "s1", path: "src" });
  assert.equal(isExpanded(state, "s1", "src"), true);
  state = reduceFiles(state, { kind: "toggleExpanded", sessionId: "s1", path: "src" });
  assert.equal(isExpanded(state, "s1", "src"), false);
  assert.equal(directoryAt(state, "s1", "src").status, "loaded");
});

test("hidden files are per session, because it is a view preference", () => {
  const state = reduceFiles(initialFilesState(), { kind: "toggleHidden", sessionId: "s1" });
  assert.equal(showsHidden(state, "s1"), true);
  assert.equal(showsHidden(state, "s2"), false, "another session must not inherit the toggle");
  const off = reduceFiles(state, { kind: "toggleHidden", sessionId: "s1" });
  assert.equal(showsHidden(off, "s1"), false);
});

test("forgetting a session drops its tree but not its neighbours'", () => {
  let state = reduceFiles(initialFilesState(), {
    kind: "filesLoaded",
    sessionId: "s1",
    path: "",
    entries: [],
    truncated: false,
  });
  state = reduceFiles(state, {
    kind: "filesLoaded",
    sessionId: "s2",
    path: "",
    entries: [],
    truncated: false,
  });
  state = reduceFiles(state, { kind: "openFile", sessionId: "s1", path: "a.txt" });
  state = reduceFiles(state, { kind: "toggleHidden", sessionId: "s1" });

  state = reduceFiles(state, { kind: "forgetSession", sessionId: "s1" });

  assert.deepEqual(directoryAt(state, "s1", ""), { status: "unloaded" });
  assert.equal(state.openFile["s1"], undefined);
  assert.equal(showsHidden(state, "s1"), false);
  // s2 untouched.
  assert.equal(directoryAt(state, "s2", "").status, "loaded");
});

test("forgetting a session does not drop a session whose id PREFIXES it", () => {
  // `s1` and `s10` share a prefix. Filtering by `startsWith(sessionId)` without the NUL would drop
  // `s10`'s tree when `s1` stopped — invisible until two-digit ids appeared.
  let state = reduceFiles(initialFilesState(), {
    kind: "filesLoaded",
    sessionId: "s10",
    path: "",
    entries: [],
    truncated: false,
  });
  state = reduceFiles(state, { kind: "forgetSession", sessionId: "s1" });
  assert.equal(directoryAt(state, "s10", "").status, "loaded", "s10 must survive s1 being forgotten");
});

test("childPath joins without ever producing a leading slash", () => {
  // A leading slash would be an absolute path, which the orchestrator refuses by design — so this
  // join is a correctness property, not cosmetics.
  assert.equal(childPath("", "name"), "name");
  assert.equal(childPath("src", "name"), "src/name");
  assert.equal(childPath("src/", "name"), "src/name");
  assert.equal(childPath("a/b", "c"), "a/b/c");
  for (const parent of ["", "src", "a/b"]) {
    assert.ok(!childPath(parent, "n").startsWith("/"), `childPath(${parent}) must be relative`);
  }
});

// --- Line wrapping (issue #73) ---------------------------------------------------------------------

test("long lines are wrapped until the reader says otherwise", () => {
  // The default is the whole point: it is what changes the reported experience. `!== false` rather
  // than `=== true`, so an untouched session is wrapped.
  assert.equal(showsWrapped(initialFilesState(), "s1"), true);
  assert.equal(showsWrapped(reduceFiles(initialFilesState(), { kind: "toggleWrap", sessionId: "s1" }), "s1"), false);
});

test("the wrap toggle flips both ways, and is per session", () => {
  let state = reduceFiles(initialFilesState(), { kind: "toggleWrap", sessionId: "s1" });
  assert.equal(showsWrapped(state, "s1"), false);
  state = reduceFiles(state, { kind: "toggleWrap", sessionId: "s1" });
  assert.equal(showsWrapped(state, "s1"), true, "a second press restores the default");
  // Turning wrapping off in one project must not turn it off in another.
  assert.equal(showsWrapped(state, "s2"), true);
});

test("forgetting a session drops its wrap preference with its tree", () => {
  let state = reduceFiles(initialFilesState(), { kind: "toggleWrap", sessionId: "s1" });
  state = reduceFiles(state, { kind: "forgetSession", sessionId: "s1" });
  assert.equal(showsWrapped(state, "s1"), true);
});

// --- Freshness (issue #189) ------------------------------------------------------------------
//
// The reported defect: a file the agent created during a session never appeared, in the tree or in
// the composer's `@` picker — both read this cache — and the only cure was restarting the app. A
// listing had no expiry at all, so an answer from the first read was authoritative for the life of
// the page.
//
// Each test below is one way the fix could be wrong: no expiry, an expiry that discards an answer in
// flight, a re-read of something refused, a mtime that is believed when it is in the future, and a
// no-op tick that still re-renders.

/** A loaded listing, with the freshness a real response carries. */
function loaded(path: string, mtimes: number[], readAt: number) {
  const entries = mtimes.map((mtimeMs, index) => ({
    name: `f${index}.txt`,
    kind: "file" as const,
    size: 1,
    mtimeMs,
    hidden: false,
  }));
  return {
    kind: "filesLoaded" as const,
    sessionId: "s1",
    path,
    entries,
    truncated: false,
    readAt,
    ...(mtimes.length === 0 ? {} : { changedAt: Math.max(...mtimes) }),
  };
}

test("a listing older than the window is stale, and a fresh one is not", () => {
  const now = 1_000_000;
  let state = initialFilesState();
  state = reduceFiles(state, loaded("", [now - 60_000], now - 60_000));
  state = reduceFiles(state, loaded("src", [now - 60_000], now - 1_000));

  assert.deepEqual(staleDirectories(state, "s1", now), [""], "only the aged listing is stale");
});

test("a listing whose mtime watermark changed is the case age alone cannot see — and is covered by the bound", () => {
  // An earlier design used the newest mtime as proof that a directory "just moved", so a file the
  // agent had created would appear without waiting. It cannot work: a listing's newest mtime is
  // recent BY CONSTRUCTION at the moment it is read, so EVERY directory looks freshly changed for a
  // full window after every read and the loop re-requests on every tick. The watermark is used for
  // what it is actually good for — deciding that a re-read changed nothing, so the tree is not
  // re-rendered (see `filesLoaded`). What is asserted here is the honest contract: within the window.
  const now = 1_000_000;
  let state = initialFilesState();
  state = reduceFiles(state, loaded("", [now - 100], now - 100));

  // Fresh: under the window, so not yet re-read.
  assert.deepEqual(staleDirectories(state, "s1", now), [], "not stale before the window elapses");
  // The bound, which is what the user is promised: at the window it is re-read.
  assert.deepEqual(staleDirectories(state, "s1", now + TREE_REREAD_MS), [""]);
});

test("an identical re-read keeps the state object, so the timer cannot re-render forever", () => {
  // Twice a second, for every open directory, forever. Replacing the entries array each time would
  // rebuild the tree and every memoised turn that keys off the file cache.
  const now = 1_000_000;
  let state = initialFilesState();
  state = reduceFiles(state, loaded("", [now - 60_000], now - 60_000));

  const same = reduceFiles(state, loaded("", [now - 60_000], now));
  assert.equal(same, state, "an unchanged listing is not new state");

  // A moved directory IS new state, and that is the whole point of the comparison.
  const moved = reduceFiles(state, loaded("", [now - 1_000], now));
  assert.notEqual(moved, state);
  assert.equal(directoryAt(moved, "s1", "").status, "loaded");
});

test("a `loading` directory is never demoted, so an answer in flight is not discarded", () => {
  const now = 1_000_000;
  let state = initialFilesState();
  state = reduceFiles(state, loaded("", [now - 60_000], now - 60_000));
  state = reduceFiles(state, { kind: "filesLoading", sessionId: "s1", path: "" });

  assert.deepEqual(staleDirectories(state, "s1", now), [], "loading is not stale");
  // And the invalidation action agrees: it must not clobber the loading state either.
  const after = reduceFiles(state, { kind: "invalidateDirectories", sessionId: "s1", paths: [""] });
  assert.equal(directoryAt(after, "s1", "").status, "loading");
});

test("a refused listing is not re-asked on every tick", () => {
  // A reader staring at "permission denied" should not have the same question re-asked forever.
  const now = 1_000_000;
  let state = initialFilesState();
  state = reduceFiles(state, {
    kind: "filesFailed",
    sessionId: "s1",
    path: "",
    reason: "permission",
    message: "denied",
  });

  // Not stale, now or ever: an error is a settled answer, not an old one.
  assert.deepEqual(staleDirectories(state, "s1", now), []);
  assert.deepEqual(staleDirectories(state, "s1", now + 10 * TREE_REREAD_MS), []);
  // And the loop has nothing to ask it, because `staleDirectories` is what drives the requests.
  // `invalidateDirectories` cannot demote it either, by design: it is not an age problem.
  const after = reduceFiles(state, { kind: "invalidateDirectories", sessionId: "s1", paths: [""] });
  assert.equal(directoryAt(after, "s1", "").status, "error", "an error must never become unloaded");
});

test("an unloaded directory is not reported as stale — it is already going to be read", () => {
  assert.deepEqual(staleDirectories(initialFilesState(), "s1", 1_000_000), []);
});

test("a listing with NO recorded read time is re-read once, rather than trusted forever", () => {
  // A response from an orchestrator that predates `mtimeMs`, or one cached before this change. It has
  // to be refreshed — but only once, because the answer then carries the freshness fields.
  let state = initialFilesState();
  state = reduceFiles(state, {
    kind: "filesLoaded",
    sessionId: "s1",
    path: "",
    entries: [{ name: "a.txt", kind: "file", hidden: false }],
    truncated: false,
  });
  assert.deepEqual(staleDirectories(state, "s1", 1_000_000), [""]);
});

test("a READ TIME in the future is treated as fresh, not as permanently stale", () => {
  // A file server and a browser can disagree about the clock by seconds. Believing a future reading
  // as "infinitely old" would re-request that directory on every single tick, forever.
  const now = 1_000_000;
  let state = initialFilesState();
  state = reduceFiles(state, loaded("", [now], now + 120_000));

  assert.deepEqual(staleDirectories(state, "s1", now), [], "a future reading is not stale");
});

test("only the asked session's directories are considered", () => {
  const now = 1_000_000;
  let state = initialFilesState();
  state = reduceFiles(state, { ...loaded("", [now - 60_000], now - 60_000), sessionId: "s2" });
  assert.deepEqual(staleDirectories(state, "s1", now), [], "another session's tree is not ours");
});

test("a tick that finds nothing stale returns the SAME state object, so it cannot re-render", () => {
  // The loop runs twice a second. A fresh object per tick would re-render the tree and the transcript
  // forever, which is a worse defect than the staleness being fixed.
  const now = 1_000_000;
  let state = initialFilesState();
  state = reduceFiles(state, loaded("", [now - 60_000], now - 60_000));

  const fresh = reduceFiles(state, { kind: "invalidateDirectories", sessionId: "s1", paths: [] });
  assert.equal(fresh, state, "an empty invalidation is a no-op");

  // And invalidating something already unloaded is a no-op too.
  const again = reduceFiles(fresh, { kind: "invalidateDirectories", sessionId: "s1", paths: [""] });
  assert.notEqual(again, fresh, "the first demotion does change state");
  const third = reduceFiles(again, { kind: "invalidateDirectories", sessionId: "s1", paths: [""] });
  assert.equal(third, again, "a second demotion of the same path is a no-op");
});

test("the newest mtime in a listing is its watermark, and `undefined` is not zero", () => {
  // `undefined` must not become 0: a listing from an orchestrator that reports no mtimes would then
  // look like a directory from 1970 and be re-read on every tick, forever.
  assert.equal(newestMtime([{ name: "a", kind: "file", hidden: false, mtimeMs: 5 }]), 5);
  assert.equal(
    newestMtime([
      { name: "a", kind: "file", hidden: false, mtimeMs: 5 },
      { name: "b", kind: "directory", hidden: false, mtimeMs: 9 },
    ]),
    9,
  );
  assert.equal(newestMtime([{ name: "a", kind: "file", hidden: false }]), undefined);
  assert.equal(newestMtime([]), undefined);
});

test("invalidating a file's contents makes reopening it read the file again", () => {
  // The tree is not the only stale surface: a file already open in the pane kept the bytes it was
  // first read with, so a file the agent edited showed its OLD contents indefinitely.
  let state = initialFilesState();
  state = reduceFiles(state, {
    kind: "fileLoaded",
    sessionId: "s1",
    path: "a.txt",
    bytes: 3,
    content: { kind: "text", text: "old" },
  });
  assert.equal(fileAt(state, "s1", "a.txt").status, "loaded");

  state = reduceFiles(state, { kind: "invalidateFile", sessionId: "s1", path: "a.txt" });
  assert.equal(fileAt(state, "s1", "a.txt").status, "unloaded", "content is dropped, so it re-reads");

  // And the no-op case, for the same reason as the directory tick.
  const untouched = reduceFiles(state, { kind: "invalidateFile", sessionId: "s1", path: "a.txt" });
  assert.equal(untouched, state);
});
