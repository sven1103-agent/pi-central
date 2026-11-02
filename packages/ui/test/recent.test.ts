/**
 * Directories used before (issue #149).
 *
 * ## Why these matter
 *
 * "Same project, new task" is the **primary** use case for this issue — one task per session, many sessions per
 * directory, `/new` in the Pi TUI being the established gesture — so the recent list is the affordance that makes
 * it cheap. Three ways it could be wrong, and each has a test:
 *
 *   - it could offer a scratch workspace, whose name is `s7` and which is never a project you return to;
 *   - it could hide a directory that no longer exists, which would read as "Pi Central forgot my project";
 *   - it could count or order wrongly, so "most recent first" is a lie about the list.
 *
 * The input is the real `HistoricalSession` shape, so a field rename breaks these tests rather than silently
 * producing an empty list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HistoricalSession } from "@pi-central/protocol";
import { abbreviateCwd, baseName, recentDirectories } from "../src/recent.ts";

/** A session header with only the fields the derivation reads. */
function session(over: Partial<HistoricalSession> = {}): HistoricalSession {
  return {
    path: "/sessions/a/1.jsonl",
    id: "1",
    cwd: "/Users/x/git/project",
    created: "2026-11-01T10:00:00.000Z",
    modifiedMs: 1_000,
    bytes: 100,
    messageCount: 2,
    firstMessage: "hi",
    cwdExists: true,
    scratch: false,
    ...over,
  };
}

test("one directory with many sessions is ONE row, counting them", () => {
  // The whole point of the issue: many sessions per directory is normal, and the list is of directories.
  const rows = recentDirectories([
    session({ path: "/a", modifiedMs: 300 }),
    session({ path: "/b", modifiedMs: 200 }),
    session({ path: "/c", modifiedMs: 100 }),
  ]);
  assert.equal(rows.length, 1, "three sessions in one project must not be three rows");
  assert.equal(rows[0]!.sessions, 3, "and the row says how many");
  assert.equal(rows[0]!.lastUsedMs, 300, "recent means the NEWEST session, not the oldest");
});

test("most recently used first, and the order is stable for equal timestamps", () => {
  const rows = recentDirectories([
    session({ cwd: "/old", modifiedMs: 100 }),
    session({ cwd: "/new", modifiedMs: 900 }),
    session({ cwd: "/mid", modifiedMs: 500 }),
  ]);
  assert.deepEqual(rows.map((r) => r.cwd), ["/new", "/mid", "/old"]);

  // Two directories touched in the same millisecond must not swap between renders: sorted by name as a tiebreak.
  const tied = recentDirectories([
    session({ cwd: "/b", modifiedMs: 5 }),
    session({ cwd: "/a", modifiedMs: 5 }),
  ]);
  assert.deepEqual(tied.map((r) => r.cwd), ["/a", "/b"], "deterministic, not whichever the Map iterated first");
});

test("scratch workspaces are never offered", () => {
  // They are app-owned, one per session, and named `s7` — a list of those is the "wall of meaningless rows"
  // the rail was cleared of in #77.
  const rows = recentDirectories([
    session({ cwd: "/Users/x/.local/share/pi-central/workspaces/s7", scratch: true, modifiedMs: 999 }),
    session({ cwd: "/Users/x/git/project", modifiedMs: 1 }),
  ]);
  assert.deepEqual(rows.map((r) => r.cwd), ["/Users/x/git/project"]);
});

test("a directory that no longer exists is KEPT and marked, not hidden", () => {
  // Hiding it would make an unmounted volume look like a forgotten project. It is kept so the reader can see
  // the project is still remembered; the sheet disables it, which is a different decision made elsewhere.
  const rows = recentDirectories([session({ cwd: "/mnt/gone", cwdExists: false })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.cwdExists, false, "the row carries the fact, so the sheet can refuse it");
});

test("one live session's directory being present marks the directory present", () => {
  const rows = recentDirectories([
    session({ cwd: "/p", cwdExists: false, modifiedMs: 9 }),
    session({ cwd: "/p", cwdExists: true, modifiedMs: 1 }),
  ]);
  assert.equal(rows[0]!.cwdExists, true, "a stale false must not override a later true");
});

test("a session with no recorded directory contributes no row", () => {
  // `resume.ts` refuses `unknown-cwd`, and an empty string here would offer a directory that is nowhere.
  assert.deepEqual(recentDirectories([session({ cwd: "" })]), []);
});

test("the limit bounds the ROWS, not the input", () => {
  // A fleet of forty sessions in one project must still yield that one project. Trimming the input first
  // would let forty sessions in one directory crowd out every other directory.
  const many = Array.from({ length: 40 }, (_, i) => session({ path: `/s/${i}`, modifiedMs: 100 + i }));
  const rows = recentDirectories(many, 6);
  assert.equal(rows.length, 1, "one directory, however many sessions");

  const distinct = Array.from({ length: 10 }, (_, i) => session({ cwd: `/p${i}`, modifiedMs: i }));
  assert.equal(recentDirectories(distinct, 6).length, 6, "and the cap applies to distinct directories");
});

test("a path is abbreviated with ~ only when home is a real prefix", () => {
  assert.equal(abbreviateCwd("/Users/x/git/project", "/Users/x"), "~/git/project");
  // `homer` is not inside `/home` — the naive `startsWith` without the separator would claim it was.
  assert.equal(abbreviateCwd("/homer/work", "/home"), "/homer/work");
  assert.equal(abbreviateCwd("/Users/x", "/Users/x"), "/Users/x", "home itself has no trailing segment to drop");
  assert.equal(abbreviateCwd("/a/b", undefined), "/a/b");
  assert.equal(abbreviateCwd("/a/b", ""), "/a/b");
});

test("the row's bold label is the last segment", () => {
  assert.equal(baseName("/Users/x/git/project"), "project");
  assert.equal(baseName("/Users/x/git/project/"), "project");
  assert.equal(baseName("/"), "/", "the root has no segment, and says so rather than becoming empty");
});

// --- Gone vs unreadable, aggregated (issue #196) ------------------------------------------------

test("one directory's reason survives aggregation, so the sheet can name it", () => {
  // The sheet disables the row either way; the reason decides whether it says "missing" or "unreadable", and those
  // need different actions from the reader.
  const rows = recentDirectories([
    session({ cwd: "/mnt/gone", cwdExists: false, cwdMissing: "missing" }),
    session({ cwd: "/mnt/gone", path: "/s/2", cwdExists: false, cwdMissing: "missing" }),
  ]);
  assert.equal(rows[0]!.cwdMissing, "missing");
});

test("DISAGREEING reasons are dropped rather than one of them being asserted", () => {
  // One session saw EPERM, another saw ENOENT: the state is genuinely unclear, and picking either would be the same
  // overconfidence the boolean had.
  const rows = recentDirectories([
    session({ cwd: "/x", cwdExists: false, cwdMissing: "unreadable" }),
    session({ cwd: "/x", path: "/s/2", cwdExists: false, cwdMissing: "missing" }),
  ]);
  assert.equal(rows[0]!.cwdMissing, undefined, "neither cause is claimed");
});

test("a PRESENT directory carries no reason at all", () => {
  const rows = recentDirectories([session({ cwd: "/ok", cwdExists: true })]);
  assert.equal(rows[0]!.cwdMissing, undefined, "no cause is invented for a directory that is there");
});

test("a directory seen ONLY through unreadable sessions keeps that reason", () => {
  // Exercises the second-occurrence branch, which a single-session directory never reaches: the first sets the
  // field, and every later one must AGREE before the reason stands.
  const rows = recentDirectories([
    session({ cwd: "/Users/x/Downloads", cwdExists: false, cwdMissing: "unreadable" }),
    session({ cwd: "/Users/x/Downloads", path: "/s/2", cwdExists: false, cwdMissing: "unreadable" }),
    session({ cwd: "/Users/x/Downloads", path: "/s/3", cwdExists: false, cwdMissing: "unreadable" }),
  ]);
  assert.equal(rows[0]!.cwdMissing, "unreadable", "three agreeing reports keep the reason");
  assert.equal(rows[0]!.sessions, 3);
});
