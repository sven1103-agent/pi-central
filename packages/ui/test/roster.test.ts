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
  sessionForPendingPrompt,
  type RosterEntry,
} from "../src/roster.ts";
import type { LiveSession } from "@pi-central/protocol";
import { nameLabel } from "../src/format.ts";

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
    // Recorded even when false: a session that is NOT scratch must not be mistaken for one after a restart,
    // because the LABEL depends on this flag.
    scratch: false,
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

// --- Resume-on-send: the parked prompt finds its session (issue #89) -----------------------------

test("a parked prompt finds the session with its FILE, not its old handle", () => {
  // Resuming reports a NEW handle, so matching by handle would never find it — and matching the OLD handle would
  // send the message to whatever session has been given that number since.
  const pending = { path: "/s/a/one.jsonl" };
  const found = sessionForPendingPrompt(pending, [
    live({ id: "s7", sessionFile: "/s/other.jsonl" }),
    live({ id: "s12", sessionFile: "/s/a/one.jsonl" }),
  ]);
  assert.equal(found?.id, "s12", "matched by file, and it is the NEW handle");
});

test("a parked prompt does not match a session that has no file yet", () => {
  // A session appears before `get_state` answers, so it briefly has no `sessionFile`. Sending the parked message
  // then would be sending it to a session we cannot prove is the right one.
  assert.equal(sessionForPendingPrompt({ path: "/s/a/one.jsonl" }, [live({ id: "s1" })]), undefined);
});

test("no pending prompt resolves to nothing", () => {
  assert.equal(sessionForPendingPrompt(undefined, [live({ id: "s1", sessionFile: "/s/a/one.jsonl" })]), undefined);
});

test("a pending prompt for a session that never comes back stays parked", () => {
  assert.equal(sessionForPendingPrompt({ path: "/s/a/gone.jsonl" }, [live({ id: "s1", sessionFile: "/s/b/x.jsonl" })]), undefined);
});

// --- The label after a restart (reported from use) -----------------------------------------------

test("a scratch session stored with its handle is still labelled 'Scratch session' after a restart", () => {
  // Reported: "when i create scratch sessions without a name, they are called Undefined in the roster. Now when i
  // restart, they carry the handle name."
  //
  // Two symptoms, one defect: the remembered row read `entry.name` RAW, so whatever had been stored was shown.
  // A scratch session's default name IS its handle, so a restart showed `s2` where the rail had said
  // `Scratch session`.
  const entry = rosterEntryFor(live({ id: "s2", name: "s2", scratch: true, sessionFile: "/s/a/s2.jsonl" }))!;
  const [row] = rosterRows([entry], []);
  assert.equal(nameLabel(row!.entry.name, row!.entry.scratch === true, row!.entry.path), "Scratch session");
});

test("a stored placeholder name never reaches the rail as a word", () => {
  // The other half of the same report: a value that arrived as `undefined` was stored and rendered as though a
  // person had typed it. A placeholder is not a name.
  for (const placeholder of ["undefined", "Undefined", "", "   ", null, undefined]) {
    assert.equal(
      nameLabel(placeholder ?? undefined, true, "s1"),
      "Scratch session",
      `scratch + ${JSON.stringify(placeholder)}`,
    );
    assert.equal(nameLabel(placeholder ?? undefined, false, "s1"), "s1", `named + ${JSON.stringify(placeholder)}`);
  }
});

test("a name a person chose survives a restart unchanged", () => {
  assert.equal(nameLabel("refactor auth", true, "s1"), "refactor auth");
  assert.equal(nameLabel("refactor auth", false, "s1"), "refactor auth");
});

test("scratch is persisted, so the label rule works after a restart", () => {
  // Without this flag a remembered row cannot know it was a scratch session, and falls back to its handle.
  const entry = rosterEntryFor(live({ id: "s3", name: "s3", scratch: true, sessionFile: "/s/a/s3.jsonl" }))!;
  const roundTripped = parseRoster(serializeRoster([entry]));
  assert.equal(roundTripped[0]!.scratch, true);
});

test("a non-scratch session is NOT labelled scratch after a restart", () => {
  // The flag is recorded even when false, so the rule cannot misfire in the other direction.
  const entry = rosterEntryFor(live({ id: "s4", name: "", scratch: false, sessionFile: "/s/a/s4.jsonl" }))!;
  assert.equal(entry.scratch, false);
  const [restored] = parseRoster(serializeRoster([entry]));
  // The label is computed BEFORE any assertion: `assert.equal` narrows the value it checks, and comparing a
  // narrowed literal to `true` is a compile error rather than a failing test.
  const label = nameLabel(restored!.name, restored!.scratch === true, restored!.path);
  assert.equal(label, restored!.path, "falls back to the path, and is not labelled scratch");
  assert.equal(restored!.scratch, false, "the flag survived the round trip as false, not undefined");
});
