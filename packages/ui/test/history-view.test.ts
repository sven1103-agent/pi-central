/**
 * Sorting, paging and selection for History (requested alongside #150).
 *
 * ## The complaint these answer
 *
 * *"Nobody can scan 500 sessions."* The tab listed 200 rows in one column, in no order, with no way to act on more than
 * one. Three pure functions fix that, and each has a failure mode worth a test:
 *
 *   - a sort without a total tiebreak lets two equal rows SWAP under the pointer between renders;
 *   - a page that is not clamped renders an empty screen when a filter shrinks the list under a reader on page 7;
 *   - "select all" over the whole loaded set is how a reader bulk-deletes rows they never looked at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HistoricalSession } from "@pi-central/protocol";
import {
  allOnPageSelected,
  HISTORY_PAGE_SIZE,
  historyLabel,
  pageCount,
  pageOf,
  pruneSelection,
  sortHistory,
  togglePageSelected,
  toggleSelected,
} from "../src/history-view.ts";

function session(over: Partial<HistoricalSession> = {}): HistoricalSession {
  return {
    path: "/sessions/p/a.jsonl",
    id: "a",
    cwd: "/Users/x/git/project",
    created: "",
    modifiedMs: 1_000,
    bytes: 100,
    messageCount: 1,
    firstMessage: "hello",
    cwdExists: true,
    scratch: false,
    ...over,
  };
}

test("newest and oldest are exact mirrors", () => {
  const rows = [
    session({ path: "/1", modifiedMs: 100 }),
    session({ path: "/3", modifiedMs: 300 }),
    session({ path: "/2", modifiedMs: 200 }),
  ];
  assert.deepEqual(sortHistory(rows, "newest").map((r) => r.path), ["/3", "/2", "/1"]);
  assert.deepEqual(sortHistory(rows, "oldest").map((r) => r.path), ["/1", "/2", "/3"]);
});

test("largest sorts by bytes, and ties keep a defined order", () => {
  const rows = [
    session({ path: "/small", bytes: 1 }),
    session({ path: "/big", bytes: 900 }),
    session({ path: "/mid", bytes: 50 }),
  ];
  assert.deepEqual(sortHistory(rows, "largest").map((r) => r.path), ["/big", "/mid", "/small"]);

  // Two rows with the same size must not be free to swap: the newest-first tiebreak fixes their positions.
  const tied = [
    session({ path: "/old", bytes: 10, modifiedMs: 1 }),
    session({ path: "/new", bytes: 10, modifiedMs: 9 }),
  ];
  assert.deepEqual(sortHistory(tied, "largest").map((r) => r.path), ["/new", "/old"], "total order, not a partial one");
});

test("name sorts case-insensitively on the label the row SHOWS", () => {
  // Sorting by a value the row does not display makes a list look randomly ordered.
  const rows = [
    session({ path: "/b", name: "beta" }),
    session({ path: "/a", name: "Alpha" }),
    session({ path: "/c", name: undefined, firstMessage: "Charlie's question" }),
  ];
  assert.deepEqual(sortHistory(rows, "name").map((r) => r.path), ["/a", "/b", "/c"]);
  // The unnamed one sorted by its PROMPT, not as an empty string at the front.
  assert.equal(historyLabel(rows[2]!), "Charlie's question");
});

test("a handle is not a name for sorting, and a chosen name is", () => {
  assert.equal(historyLabel(session({ name: "Heavy Lifting" })), "Heavy Lifting");
  assert.equal(historyLabel(session({ name: "s7", firstMessage: "real question" })), "real question");
  assert.equal(historyLabel(session({ name: "s7", firstMessage: "", scratch: true })), "Scratch session");
  assert.equal(historyLabel(session({ name: undefined, firstMessage: "", id: "s9" })), "s9", "last resort is the id");
});

test("sorting does not mutate the input", () => {
  // The store's array is React state; sorting it in place would be a silent mutation of state.
  const rows = [session({ path: "/1", modifiedMs: 1 }), session({ path: "/2", modifiedMs: 2 })];
  const before = rows.map((r) => r.path);
  sortHistory(rows, "newest");
  assert.deepEqual(rows.map((r) => r.path), before);
});

test("pages divide the rows, and an empty list still has page 1", () => {
  assert.equal(pageCount(0), 1, "there is always a page to be on");
  assert.equal(pageCount(1), 1);
  assert.equal(pageCount(HISTORY_PAGE_SIZE), 1);
  assert.equal(pageCount(HISTORY_PAGE_SIZE + 1), 2);

  const rows = Array.from({ length: 30 }, (_, i) => session({ path: `/${i}` }));
  const first = pageOf(rows, 1);
  assert.equal(first.rows.length, HISTORY_PAGE_SIZE);
  assert.deepEqual([first.page, first.pages, first.total], [1, 2, 30]);
  const second = pageOf(rows, 2);
  assert.equal(second.rows.length, 30 - HISTORY_PAGE_SIZE);
  assert.equal(second.rows[0]!.path, `/${HISTORY_PAGE_SIZE}`);
});

test("a page past the end is CLAMPED, so a shrinking filter cannot blank the screen", () => {
  // A reader on page 7 who types a filter that leaves 3 rows must land on the last page, not on "page 7 of 1".
  const rows = Array.from({ length: 3 }, (_, i) => session({ path: `/${i}` }));
  const view = pageOf(rows, 7);
  assert.equal(view.page, 1, "clamped to the last page");
  assert.equal(view.rows.length, 3, "and it shows them");

  const none = pageOf([], 4);
  assert.deepEqual([none.page, none.pages, none.rows.length], [1, 1, 0]);
  assert.equal(pageOf(rows, 0).page, 1, "page 0 and negatives clamp to 1");
});

test("selection toggles by PATH, so a re-sort cannot retarget it", () => {
  // The reason selection is a Set of paths rather than of indices or objects: every keystroke in the filter re-sorts,
  // and a selection that silently moved to a different session is the worst possible bug in a bulk delete.
  let selected = new Set<string>();
  selected = toggleSelected(selected, "/a");
  assert.deepEqual([...selected], ["/a"]);
  selected = toggleSelected(selected, "/b");
  assert.deepEqual([...selected].sort(), ["/a", "/b"]);
  selected = toggleSelected(selected, "/a");
  assert.deepEqual([...selected], ["/b"], "toggling off removes exactly one");
});

test("toggling returns a NEW set, because a mutated one would not re-render", () => {
  const original = new Set(["/a"]);
  const next = toggleSelected(original, "/b");
  assert.notEqual(next, original, "identity must change");
  assert.deepEqual([...original], ["/a"], "and the input is untouched");
});

test("'select this page' touches only the page — the safety property, not a limitation", () => {
  // Select-all over 500 loaded sessions followed by a bulk delete is how a reader deletes rows they never looked at.
  const page1 = Array.from({ length: 3 }, (_, i) => session({ path: `/p1-${i}` }));
  const page2 = Array.from({ length: 3 }, (_, i) => session({ path: `/p2-${i}` }));

  let selected = togglePageSelected(new Set(), page1);
  assert.equal(selected.size, 3, "exactly the page");
  assert.ok(![...selected].some((p) => p.startsWith("/p2")), "nothing off the page");

  // The header checkbox reflects the page, so page 2 shows unchecked.
  assert.equal(allOnPageSelected(selected, page1), true);
  assert.equal(allOnPageSelected(selected, page2), false);

  // Toggling again CLEARS the page rather than adding the other one.
  selected = togglePageSelected(selected, page1);
  assert.equal(selected.size, 0);
});

test("an empty page is not 'all selected'", () => {
  // `every` on an empty array is true, which would render the header checkbox checked over nothing.
  assert.equal(allOnPageSelected(new Set(), []), false);
});

test("a selection cannot outlive the rows it names", () => {
  // The count in the toolbar must not survive a delete, or the reader presses "Delete 7" and watches three go.
  const selected = new Set(["/a", "/b", "/c"]);
  const remaining = [session({ path: "/a" }), session({ path: "/c" })];
  assert.deepEqual([...pruneSelection(selected, remaining)].sort(), ["/a", "/c"]);
  assert.deepEqual([...pruneSelection(selected, [])], [], "everything gone means nothing selected");
});
