/**
 * Every issue reference in the CHANGELOG is a LINK (issue #170 follow-up).
 *
 * ## The defect
 *
 * The compression rewrote each entry as one line plus an issue number, and the numbers were left as bare text:
 * `(#164)`. That reads fine and links nowhere — a reader looking for the discussion after "A renamed session keeps
 * its new name in History" had to copy the number into a URL.
 *
 * ## Reference-style, not inline
 *
 * Inline links made the file unreadable in the other direction: the longest entry reached **325 characters** and 50
 * of 83 were over 120, because each URL is ~60 characters. Reference-style keeps the prose at ~100 and puts the
 * URLs in one block at the end — so the changelog stays scannable, which is the whole point of the compression it
 * lives inside.
 *
 * ## A number can also be the WRONG KIND of link
 *
 * Ten of the references pointed at PRs while reading as issues (#47, #127, #133, #137, #139, #141, #143, #146,
 * #153, #157, #158). GitHub serves `/issues/N` for a PR too, so it "works" while naming the wrong thing — and a
 * changelog that says "issue #153" about a pull request is a small lie of exactly the kind this repository keeps
 * finding. So each definition's path is checked against what GitHub actually says it is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const KNOWN_KINDS = JSON.parse(readFileSync(new URL("./released-sections.json", import.meta.url), "utf8"));

/** The trailing reference block: `[#12]: https://…`. */
const definitions = new Map(
  [...changelog.matchAll(/^\[#(\d{1,4})\]:\s*(\S+)$/gm)].map((m) => [m[1], m[2]]),
);

test("no issue reference in an entry is bare text", () => {
  // Scoped to entries: a definition line legitimately starts with `[#`, and headings have no numbers.
  const entries = changelog.split("\n").filter((line) => line.startsWith("- "));
  const bare = entries.filter((line) => /(?<!\[)#\d{1,4}(?!\])/.test(line));
  assert.deepEqual(
    bare.map((line) => line.slice(0, 80)),
    [],
    "a bare #N is not a link — write [#N] and add a definition",
  );
});

test("every referenced number has a definition, and every definition is referenced", () => {
  const referenced = new Set([...changelog.matchAll(/\[#(\d{1,4})\]/g)].map((m) => m[1]));
  // The definition LABELS also match the regex above, so a number is "unreferenced" only if it appears solely in
  // its own definition line.
  const missing = [...referenced].filter((n) => !definitions.has(n));
  assert.deepEqual(missing, [], "referenced but undefined");

  const entryText = changelog.split("\n").filter((line) => line.startsWith("- ")).join("\n");
  const unused = [...definitions.keys()].filter((n) => !new RegExp(`\\[#${n}\\]`).test(entryText));
  assert.deepEqual(unused, [], "defined but never referenced — dead links in the file");
});

test("a definition points at the kind of object the number actually is", () => {
  // `/issues/N` resolves for a pull request too, so this cannot be caught by clicking. The baseline recorded in
  // `released-sections.json` is not for this, so the check is on the shape the maintainer curated: every entry
  // names the ISSUE it fixed, and where a PR is cited instead the path says `pull`.
  //
  // Recorded rather than fetched: a test that needs the network cannot run in CI, and a test that silently skips
  // is the failure mode this repository keeps writing tests about.
  // `_kinds` maps every cited number to what GitHub said it was when this was recorded. Without it this test
  // iterated an empty set and passed for the wrong reason — the same "a guard cannot fail" defect the changelog
  // compression itself had, twice.
  const pullReferences = new Set(
    Object.entries(KNOWN_KINDS._kinds ?? {}).filter(([, kind]) => kind === "pull").map(([n]) => n),
  );
  assert.ok(pullReferences.size > 0, "the recorded kinds must not be empty, or this test cannot fail");
  for (const [n, url] of definitions) {
    assert.match(url, /^https:\/\/github\.com\/sven1103-agent\/pi-central\/(issues|pull)\/\d+$/, `#${n}: ${url}`);
    if (pullReferences.has(n)) {
      assert.match(url, /\/pull\//, `#${n} is a pull request and must link to /pull/`);
    }
  }
});
