/**
 * The session roster (issue #89).
 *
 * The maintainer's requirement: *"the app shall maintain the session roster and preserve it so it survives
 * crashes, updates or restarts of the orchestrator. It has nothing to do with the sessions activity."*
 *
 * So activity is a column, never a category — and the tests below are shaped around the two failures that
 * produced when it was treated as a category.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROSTER_MAX,
  addToRoster,
  parseRoster,
  removeFromRoster,
  rosterEntryFor,
  rosterRows,
  rowActivity,
  serializeRoster,
  type RosterEntry,
} from "../src/roster.ts";
import type { LiveSession } from "@pi-central/protocol";

/** A live session with only the fields these rules read. */
const live = (over: Partial<LiveSession> & { id: string }): LiveSession =>
  ({
    name: `session ${over.id}`,
    cwd: "/git/proj",
    state: "idle",
    mode: "sandboxed",
    isolation: "safehouse",
    command: "pi",
    scratch: false,
    dialogs: [],
    pending: 0,
    contextPercent: 0,
    cost: 0,
    ...over,
  }) as LiveSession;

// --- The roster is the list; activity is a column ------------------------------------------------

test("a session that is not running is STILL a row, marked stopped", () => {
  // The heart of it. A session in your roster does not disappear because the process is gone — you prompt it to
  // continue when you want to. `stopped` is already in `LiveState`, so this invents no vocabulary.
  const rows = rosterRows([{ path: "/s/a/s1.jsonl", name: "yesterday's task" }], []);
  assert.equal(rows.length, 1, "the row exists");
  assert.equal(rows[0]!.session, undefined, "…with no live session behind it");
  assert.equal(rowActivity(rows[0]!), "stopped");
});

test("every session appears exactly ONCE, whether running or not", () => {
  // The defect this replaces: an earlier design rendered a second "remembered" section, so a session that was
  // both persisted and running appeared twice, one section apart. Here the roster is the input and activity is
  // joined in, so duplication is not a thing that can happen.
  const entries: RosterEntry[] = [{ path: "/s/a/s1.jsonl" }, { path: "/s/b/s2.jsonl" }];
  const rows = rosterRows(entries, [live({ id: "s1", sessionFile: "/s/a/s1.jsonl" })]);

  assert.equal(rows.length, 2, "two roster entries → two rows, not three");
  const paths = rows.map((row) => row.entry.path);
  assert.deepEqual(paths, ["/s/a/s1.jsonl", "/s/b/s2.jsonl"], "in the reader's order");
  assert.equal(rows[0]!.session?.id, "s1", "the running one carries its session");
  assert.equal(rows[1]!.session, undefined, "the other is stopped");
});

test("the roster's ORDER is kept when a session starts running", () => {
  // #68 in miniature: a session must not jump position because its state changed. The roster is the one place
  // the order is entirely the reader's.
  const entries: RosterEntry[] = [{ path: "/a.jsonl" }, { path: "/b.jsonl" }, { path: "/c.jsonl" }];
  const rows = rosterRows(entries, [live({ id: "s9", sessionFile: "/c.jsonl", state: "streaming" })]);
  assert.deepEqual(rows.map((row) => row.entry.path), ["/a.jsonl", "/b.jsonl", "/c.jsonl"]);
});

test("a LIVE session not in the roster is appended, not hidden", () => {
  // It exists. Dropping a running process from the rail would be a worse lie than putting it at the end.
  const rows = rosterRows([{ path: "/a.jsonl" }], [live({ id: "s9", sessionFile: "/z.jsonl" })]);
  assert.deepEqual(rows.map((row) => row.entry.path), ["/a.jsonl", "/z.jsonl"]);
  assert.equal(rows[1]!.session?.id, "s9");
});

test("a live session with no file yet is shown, keyed by handle, and never persisted", () => {
  // Pi reports `sessionFile` after `get_state`. Until then the row must still render — and the handle must never
  // become a stored key, or the next restart would resolve it to a DIFFERENT session.
  const rows = rosterRows([], [live({ id: "s1" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.entry.path, "live:s1", "a render key, clearly not a path");

  const stored = addToRoster([], rows[0]!.entry);
  assert.deepEqual(stored, [], "addToRoster refuses it: it is not an absolute path");
});

// --- Durable identity ----------------------------------------------------------------------------

test("the durable KEY is the session file, never the handle", () => {
  assert.deepEqual(rosterEntryFor(live({ id: "s1", sessionFile: "/s/a/s1.jsonl", cwd: "/git/a" })), {
    path: "/s/a/s1.jsonl",
    cwd: "/git/a",
    name: "session s1",
  });
});

test("a session with no session file yields no entry", () => {
  assert.equal(rosterEntryFor(live({ id: "s1" })), undefined);
  assert.equal(rosterEntryFor(live({ id: "s1", sessionFile: "" })), undefined);
  assert.equal(rosterEntryFor(live({ id: "s1", sessionFile: "relative/x.jsonl" })), undefined);
});

// --- Adding and removing -------------------------------------------------------------------------

test("adding twice refreshes the hints instead of duplicating", () => {
  let list = addToRoster([], { path: "/a.jsonl", name: "first" });
  list = addToRoster(list, { path: "/a.jsonl", cwd: "/git/a" });
  assert.equal(list.length, 1, "no duplicate");
  assert.equal(list[0]!.name, "first", "a known name is not lost");
  assert.equal(list[0]!.cwd, "/git/a", "…and new hints are merged in");
});

test("adding a NEW session puts it first", () => {
  let list = addToRoster([], { path: "/a.jsonl" });
  list = addToRoster(list, { path: "/b.jsonl" });
  assert.deepEqual(list.map((e) => e.path), ["/b.jsonl", "/a.jsonl"]);
});

test("removing takes the row off and touches nothing else", () => {
  const list = [{ path: "/a.jsonl" }, { path: "/b.jsonl" }];
  assert.deepEqual(removeFromRoster(list, "/a.jsonl"), [{ path: "/b.jsonl" }]);
  assert.deepEqual(removeFromRoster(list, "/missing.jsonl"), list, "an absent path is a no-op");
});

// --- Storage is untrusted ------------------------------------------------------------------------

test("a corrupt store degrades to an empty roster, never a broken one", () => {
  // `localStorage` outlives upgrades and is shared with everything else on the origin — the reason `panel.ts`
  // and `reading.ts` both validate every field. A throw here would break the rail on boot.
  for (const bad of [null, "", "{", "[]x", "null", "42", '{"nope":1}', "[1,2,3]", '[{"path":null}]']) {
    assert.deepEqual(parseRoster(bad), [], JSON.stringify(bad));
  }
});

test("an entry needs a plausible absolute path, and a bad cwd drops the FIELD not the entry", () => {
  // `cwd` reaches a spawn decision, so it is validated as a path.
  const raw = JSON.stringify([
    { path: "relative.jsonl" },
    { path: "/ok/one.jsonl" },
    { path: "/bad\u0000nul.jsonl" },
    { path: "" },
    { path: "/ok/two.jsonl", cwd: "relative" },
    { path: 42 },
  ]);
  assert.deepEqual(parseRoster(raw), [{ path: "/ok/one.jsonl" }, { path: "/ok/two.jsonl" }]);
});

test("an unbounded store cannot build unbounded rows", () => {
  const huge = JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ path: `/s/${i}.jsonl` })));
  assert.equal(parseRoster(huge).length, ROSTER_MAX);
});

test("hint text is bounded, and wrong types are dropped", () => {
  const [entry] = parseRoster(JSON.stringify([{ path: "/a.jsonl", name: "x".repeat(1000), cwd: {}, sessionId: [] }]));
  assert.ok(entry!.name!.length <= 200);
  assert.equal(entry!.cwd, undefined);
  assert.equal(entry!.sessionId, undefined);
});

test("duplicate paths collapse to the first", () => {
  const raw = JSON.stringify([{ path: "/a.jsonl", name: "first" }, { path: "/a.jsonl", name: "second" }]);
  assert.deepEqual(parseRoster(raw), [{ path: "/a.jsonl", name: "first" }]);
});

test("a roster round-trips", () => {
  const entries: RosterEntry[] = [{ path: "/s/a/s1.jsonl", cwd: "/git/a", name: "task" }, { path: "/s/b/s2.jsonl" }];
  assert.deepEqual(parseRoster(serializeRoster(entries)), entries);
});
