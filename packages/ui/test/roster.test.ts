/**
 * The rail remembers its composition across a restart (issue #89).
 *
 * The requirement: *"users see their roster state as they left off. Currently a Pi Central update, a computer
 * restart or a process kill would require users to select their roster composition again from scratch."*
 *
 * The hard constraint, and the reason this module exists rather than a stored array of ids: `Supervisor`
 * allocates `id` from a per-process counter (`s${++this.#created}`), so `s1` after a restart is a DIFFERENT
 * session. Persisting a handle would not fail loudly — it would point at the wrong conversation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROSTER_MAX,
  forgetSession,
  parseRoster,
  rememberSession,
  rosterEntryFor,
  serializeRoster,
} from "../src/roster.ts";

test("a roster round-trips through storage", () => {
  const entries = [
    { path: "/s/a/s1.jsonl", cwd: "/git/a", name: "first task" },
    { path: "/s/b/s2.jsonl", sessionId: "01a171ff" },
  ];
  assert.deepEqual(parseRoster(serializeRoster(entries)), entries);
});

test("the durable KEY is the session file, never the handle", () => {
  // The whole issue turns on this. `s1` is reused by the next process for a different session, so a roster
  // keyed by it would silently reopen the wrong conversation — worse than not restoring at all.
  const entry = rosterEntryFor({ sessionFile: "/s/a/s1.jsonl", cwd: "/git/a", name: "x" });
  assert.deepEqual(entry, { path: "/s/a/s1.jsonl", cwd: "/git/a", name: "x" });
  assert.ok(!JSON.stringify(entry).includes("s1.jsonl\"" + ",id"), "no handle field exists");
});

test("a session with no session file is NOT remembered", () => {
  // Pi reports `sessionFile` after `get_state`, so a session can exist without one. Remembering nothing is
  // correct: there is no durable identity yet, and inventing one from the handle is the bug above.
  assert.equal(rosterEntryFor({ cwd: "/git/a", name: "x" }), undefined);
  assert.equal(rosterEntryFor({ sessionFile: "", cwd: "/git/a" }), undefined);
  assert.equal(rosterEntryFor({ sessionFile: "relative/path.jsonl" }), undefined);
});

test("a corrupt store degrades to an empty roster, never to a broken one", () => {
  // `localStorage` outlives upgrades and is shared with everything else on the origin — the reason `panel.ts`
  // and `reading.ts` both validate every field. A roster that threw here would break the rail on boot.
  for (const bad of [null, "", "{", "[]x", "null", "42", '{"nope":1}', "[1,2,3]", '[{"path":null}]']) {
    assert.deepEqual(parseRoster(bad), [], JSON.stringify(bad));
  }
});

test("an entry without a plausible absolute path is dropped, not repaired", () => {
  // A `cwd` reaches a spawn decision, so a relative or NUL-bearing value must never survive parsing. Dropping
  // the whole entry is right: a row with no directory is a row nobody can resume.
  const raw = JSON.stringify([
    { path: "relative.jsonl" },
    { path: "/ok/one.jsonl" },
    { path: "/bad\u0000nul.jsonl" },
    { path: "" },
    { path: "/ok/two.jsonl", cwd: "relative" },
  ]);
  assert.deepEqual(
    parseRoster(raw),
    [{ path: "/ok/one.jsonl" }, { path: "/ok/two.jsonl" }],
    "only the plausible ones survive, and a bad cwd is dropped rather than failing the entry",
  );
});

test("an unbounded store cannot make the rail build unbounded rows", () => {
  const huge = JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ path: `/s/${i}.jsonl` })));
  assert.equal(parseRoster(huge).length, ROSTER_MAX, `capped at ${ROSTER_MAX}`);
});

test("the order is the reader's, and a remembered session moves to the front", () => {
  let list = rememberSession([], { path: "/a.jsonl" });
  list = rememberSession(list, { path: "/b.jsonl" });
  assert.deepEqual(list.map((e) => e.path), ["/b.jsonl", "/a.jsonl"], "newest first");

  // Re-remembering an existing session MOVES it rather than duplicating it.
  list = rememberSession(list, { path: "/a.jsonl" });
  assert.deepEqual(list.map((e) => e.path), ["/a.jsonl", "/b.jsonl"]);
  assert.equal(list.length, 2, "no duplicate");
});

test("forgetting removes exactly one entry", () => {
  const list = [{ path: "/a.jsonl" }, { path: "/b.jsonl" }];
  assert.deepEqual(forgetSession(list, "/a.jsonl"), [{ path: "/b.jsonl" }]);
  assert.deepEqual(forgetSession(list, "/missing.jsonl"), list, "forgetting an absent path is a no-op");
});

test("a name or cwd of the wrong type cannot reach a row", () => {
  const raw = JSON.stringify([{ path: "/a.jsonl", name: 42, cwd: {}, sessionId: [] }]);
  assert.deepEqual(parseRoster(raw), [{ path: "/a.jsonl" }]);
});

test("long hint text is bounded, so a stored value cannot blow up a row", () => {
  const raw = JSON.stringify([{ path: "/a.jsonl", name: "x".repeat(1000) }]);
  const [entry] = parseRoster(raw);
  assert.ok(entry!.name!.length <= 200, `name bounded, got ${entry!.name!.length}`);
});

test("duplicate paths in one stored value collapse to the first", () => {
  // A corrupt write, or two tabs racing. The first occurrence is where the reader put it.
  const raw = JSON.stringify([{ path: "/a.jsonl", name: "first" }, { path: "/a.jsonl", name: "second" }]);
  assert.deepEqual(parseRoster(raw), [{ path: "/a.jsonl", name: "first" }]);
});
