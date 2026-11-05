/**
 * Path completion for the directory sheet (issue #76, ADR-0012).
 *
 * ## Why every rule gets its own test
 *
 * Completion is a small function with five independent decisions in it, and each one has a plausible wrong answer
 * that looks tidier than the right one: match against the whole path instead of the entry name; offer files as well
 * as directories; treat `~/git/` as asking to finish `git`; expand `~` for display but not for matching; ignore that
 * a recent directory in ANOTHER folder is not a completion of this one. Each of those produces a list that renders
 * and accepts, and is wrong — so the assertions are about what the list contains, not that it is non-empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { abbreviateHome, completeDirectory, completionBase, expandHome } from "../src/complete.ts";

const home = "/Users/x";

test("a typed path is expanded for matching and abbreviated for display", () => {
  assert.equal(expandHome("~/git", home), "/Users/x/git");
  assert.equal(expandHome("~", home), "/Users/x");
  assert.equal(expandHome("/abs", home), "/abs");
  // `~someone` is another user's home. Refusing to guess is the honest answer: guessing `/Users/someone` would be a
  // path this process has no way to check, and an empty base is what the caller then refuses.
  assert.equal(expandHome("~someone/x", home), "~someone/x");

  assert.equal(abbreviateHome("/Users/x/git/a", home), "~/git/a");
  assert.equal(abbreviateHome("/Users/x", home), "~");
  // The prefix case `startsWith` alone gets wrong, asserted here as it is in the rail and the recent list.
  assert.equal(abbreviateHome("/Users/xyz/a", home), "/Users/xyz/a");
});

test("the base is the directory being completed INSIDE, and the partial is the word being finished", () => {
  assert.deepEqual(completionBase("/Users/x/git/pro"), { dir: "/Users/x/git", partial: "pro" });
  // A trailing slash asks to look INSIDE, which is the distinction every shell makes.
  assert.deepEqual(completionBase("/Users/x/git/"), { dir: "/Users/x/git", partial: "" });
  // The leading slash must survive, or the base stops being an absolute path and every later request is refused.
  assert.deepEqual(completionBase("/Us"), { dir: "/", partial: "Us" });
  assert.deepEqual(completionBase("pro"), { dir: "", partial: "pro" });
});

test("typing a prefix completes to the directories with that prefix, matched on the NAME", () => {
  const completions = completeDirectory({
    typed: "~/git/pro",
    home,
    recent: [],
    // `portfolio` is NOT here: it starts with `por`, so it is not a completion of `pro` — a detail worth leaving in
    // the fixture, because prefix matching is exactly the rule this test exists to pin.
    siblings: ["/Users/x/git/project", "/Users/x/git/prototype", "/Users/x/git/other"],
  });
  // Matched on the entry name. A comparison against the whole path would never match — the path starts with
  // `/Users/x`, not with `pro` — and the list would be silently empty, which reads as "nothing here".
  assert.deepEqual(
    completions.map((entry) => entry.display),
    ["~/git/project", "~/git/prototype"],
    "both matches, abbreviated, in the order given",
  );
  assert.deepEqual(
    completions.map((entry) => entry.remainder),
    // `prototype` minus `pro` is `totype`, not `type`: the remainder is the rest of the NAME, so accepting it appends
    // exactly what is missing and cannot drop a letter that was already typed.
    ["ject", "totype"],
    "the remainder is what accepting would add",
  );
});

test("a recent directory in ANOTHER folder is not a completion of this one", () => {
  // The failure this prevents is subtle and ugly: `~/work/project` offered for `~/git/pro` shares a name and not a
  // path, so accepting it would REPLACE what was typed rather than extend it.
  const completions = completeDirectory({
    typed: "~/git/pro",
    home,
    recent: ["/Users/x/work/project"],
    siblings: [],
  });
  assert.deepEqual(completions, [], "a different parent is a different completion");
});

test("a recent directory in the SAME folder is offered, and only once", () => {
  // The recents and the siblings overlap on purpose: the same directory is both something used before and something
  // inside the folder being typed. Two rows that accept the same string is the duplicate that makes a list look broken.
  const completions = completeDirectory({
    typed: "~/git/pro",
    home,
    recent: ["/Users/x/git/project", "/Users/x/git/project"],
    siblings: ["/Users/x/git/project"],
  });
  assert.deepEqual(
    completions.map((entry) => entry.path),
    ["/Users/x/git/project"],
    "one row, not three",
  );
});

test("a trailing slash completes the folders INSIDE, not the word before it", () => {
  const completions = completeDirectory({
    typed: "~/git/",
    home,
    recent: [],
    siblings: ["/Users/x/git/alpha", "/Users/x/git/beta"],
  });
  assert.deepEqual(
    completions.map((entry) => entry.display),
    ["~/git/alpha", "~/git/beta"],
    "everything at that level, because the partial name is empty",
  );
});

test("matching is case-insensitive, and is a PREFIX match — not fuzzy", () => {
  const completions = completeDirectory({
    typed: "~/git/PRO",
    home,
    recent: [],
    siblings: ["/Users/x/git/project", "/Users/x/git/improv"],
  });
  assert.deepEqual(
    completions.map((entry) => entry.display),
    ["~/git/project"],
    // `improv` contains `pro` and does not start with it. Fuzzy matching would rank it — technically a match,
    // practically wrong for a filesystem path.
    "a substring match is not a prefix match",
  );
});

test("the list is capped, and the cap is applied to the RESULT", () => {
  const siblings = Array.from({ length: 20 }, (_, index) => `/Users/x/git/p${index}`);
  const completions = completeDirectory({ typed: "~/git/p", home, recent: [], siblings, limit: 4 });
  assert.equal(completions.length, 4, "a long list is trimmed to what the sheet can show");
  assert.deepEqual(
    completions.map((entry) => entry.path),
    siblings.slice(0, 4),
    "and it is the first four in the caller's order, because the caller knows what is recent",
  );
});

test("nothing typed means nothing suggested", () => {
  // A completion list that appears before anything is typed covers the recent list with duplicates of itself.
  assert.deepEqual(completeDirectory({ typed: "", home, recent: ["/Users/x/git/a"], siblings: [] }), []);
});

test("a relative or unexpanded home path is never suggested", () => {
  // The orchestrator's `start` requires an absolute path, so a suggestion that is not one can only produce a refusal.
  // This is the guard that keeps `~someone/x` out of the list: `expandHome` deliberately does not resolve it, and the
  // `startsWith("/")` check then drops it.
  const completions = completeDirectory({
    typed: "~someone/git/",
    home,
    recent: ["~someone/git/a"],
    siblings: ["~someone/git/b"],
  });
  assert.deepEqual(completions, []);
});
