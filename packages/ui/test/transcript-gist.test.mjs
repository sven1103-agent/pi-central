/**
 * The gist on a collapsed thinking block (issue #143).
 *
 * A screenshot review of a real transcript found SIX thinking blocks rendered as the same bar with the
 * same single word. Nothing differed, so the feed's most common element carried no information: the eye
 * could not tell one block from the next, nor which was worth opening.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingGist } from "../src/transcript.ts";

test("the gist is the block's own first words", () => {
  assert.equal(thinkingGist("The user wants to know why the tests fail."), "The user wants to know why the tests fail.");
});

test("a gist is ONE line, because a wrapped preview is not a preview", () => {
  // Markdown prose arrives with newlines in it. A gist carrying a line break would grow the summary bar
  // and turn the collapsed block into a paragraph again — the exact thing collapsing is for.
  assert.equal(thinkingGist("First line.\n\nSecond line."), "First line. Second line.");
  assert.equal(thinkingGist("spaces    and\t tabs"), "spaces and tabs");
});

test("long thinking is elided at a word boundary, and says so", () => {
  const long = "word ".repeat(40).trim();
  const gist = thinkingGist(long, 40);
  assert.ok(gist.endsWith("\u2026"), `must announce the elision: ${gist}`);
  assert.ok(gist.length <= 41, `must respect the cap: ${gist.length}`);
  // Not mid-word: the character before the ellipsis starts a word, not ends one.
  const beforeEllipsis = gist.slice(0, -1);
  assert.ok(!/[a-z]$/.test(beforeEllipsis) || beforeEllipsis.endsWith("word"), gist);
});

test("trailing punctuation is not stranded before the ellipsis", () => {
  // "…the code, …" reads like a typo: the comma belongs to a clause that is no longer there.
  //
  // The input has to make the cut land EXACTLY after the punctuation. A first version did not, so the
  // comma was never adjacent to the ellipsis and the test passed with the fix removed — a guard that could
  // not fail. 8 padding words puts "clause," flush against the 50-character cut.
  const gist = thinkingGist(`${"word ".repeat(8)}clause, and more words after it`, 50);
  assert.ok(gist.endsWith("clause\u2026"), `the comma must be dropped, not stranded: ${gist}`);
  assert.ok(!/[,;:.\u2014-]\u2026$/.test(gist), `punctuation must not precede the ellipsis: ${gist}`);
});

test("leading markdown emphasis is dropped, since it costs characters and says nothing", () => {
  assert.equal(thinkingGist("**Important** thing."), "Important** thing.");
  assert.equal(thinkingGist("## Heading first"), "Heading first");
});

test("a block with no words has no gist, rather than an empty one", () => {
  // The label alone is what a genuinely empty block should render — not "Thinking" plus nothing.
  for (const empty of ["", "   ", "\n\n", "*", "- "]) {
    assert.equal(thinkingGist(empty), "", JSON.stringify(empty));
  }
});

test("two different thoughts produce two different gists", () => {
  // This is the property that matters: the defect was that every bar looked identical. It is NOT the same
  // claim as "the signature word always survives" — with the boilerplate lead-in spent, "…for reading PNG
  // bytes" can lose "PNG" to the cap. `title` carries the untruncated text for exactly that case, and the
  // doc comment states the limit instead of hiding it behind a bigger number.
  const a = thinkingGist("Let me check the failing test in files.test.ts, since the symlink case is suspicious.");
  const b = thinkingGist("Let me check whether this repository already has a helper for reading PNG bytes.");
  assert.notEqual(a, b, "two different thoughts must not produce the same gist");
  assert.match(a, /files\.test\.ts/, "an early signature word survives");
});

test("a late word is lost at the default cap, and the cap can be lifted by a caller", () => {
  // The limit is stated rather than hidden: at 72 characters a lead-in can spend the whole budget and lose
  // the word that identifies the block. The remedy is to OPEN the block, not to reveal it on hover — see the
  // doc comment for why `title` was tried and removed.
  const long = "Let me check whether this repository already has a helper for reading PNG bytes.";
  assert.ok(!thinkingGist(long).includes("PNG"), "at the default cap the late word is lost");
  assert.ok(thinkingGist(long, Infinity).includes("PNG"), "…and reachable untruncated, for callers that want it");
});
