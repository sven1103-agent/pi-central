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
  splitFileKey,
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
    text: "AAA",
    bytes: 3,
  });
  state = reduceFiles(state, { kind: "openFile", sessionId: "s1", path: "a.txt" });

  const open = openFileFor(state, "s1");
  assert.equal(open?.path, "a.txt");
  assert.equal(open?.state.status === "loaded" && open.state.text, "AAA");
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
