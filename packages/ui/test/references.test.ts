/**
 * Which image paths a reader's message names, and what the preview does with them.
 *
 * ## What these lock down
 *
 * Of the 5 912 user messages in this machine's store, 181 name an image file by path (`@img_6.png shows…`). Until this
 * existed, that path rendered as literal text and the picture appeared only if the agent happened to `read` it later,
 * inside a collapsed activity group — the reference and the referent in different places with a disclosure between.
 *
 * The detection rules are asserted with the REAL spellings found in the store, because a pattern tuned to tidy fixtures
 * is a pattern tuned to nothing: `@img_8.png captures the result. what do you think` has no space before the sentence
 * ends, and `@img_6.png,` would be a filename ending in a comma if the trim were missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PREVIEWS, previewsFor } from "../src/references.ts";

test("the real message shapes from the store are recognised", () => {
  // Verbatim openings from actual user messages on this machine.
  assert.deepEqual(
    previewsFor("@img_6.png shows the latest screenshot of the current user story implementation."),
    ["img_6.png"],
  );
  assert.deepEqual(previewsFor("@img_8.png captures the result. what do you think"), ["img_8.png"]);
  assert.deepEqual(
    previewsFor("use the ui-reviewer subagent to see and review the result: @img_7.png"),
    ["img_7.png"],
  );
  assert.deepEqual(previewsFor("@img.png shows a screenshot of the current settings refactor."), ["img.png"]);
});

test("trailing punctuation is not part of the filename", () => {
  /*
   * The failure this prevents is a request for a file that does not exist, followed by a refusal note the reader cannot
   * act on — for a file that IS there, one character off. `@img_6.png,` and `@img_6.png.` and `@img_6.png)` all occur in
   * prose, and all three end in punctuation rather than in `png`.
   */
  assert.deepEqual(previewsFor("@img_6.png, and then"), ["img_6.png"]);
  assert.deepEqual(previewsFor("@img_6.png."), ["img_6.png"]);
  assert.deepEqual(previewsFor("(see @img_6.png)"), ["img_6.png"]);
  assert.deepEqual(previewsFor('"@img_6.png"'), ["img_6.png"]);
  assert.deepEqual(previewsFor("@img_6.png)."), ["img_6.png"]);
});

test("paths, subdirectories, case, and every supported extension", () => {
  assert.deepEqual(previewsFor("look at docs/images/a.png"), ["docs/images/a.png"]);
  assert.deepEqual(previewsFor("./c.GIF"), ["./c.GIF"], "case-insensitive, and the original spelling is kept");
  assert.deepEqual(previewsFor("a.jpeg and b.webp and c.jpg"), ["a.jpeg", "b.webp", "c.jpg"]);
});

test("one file named twice is one picture", () => {
  // Two previews of one file would be two requests, two cache entries and two images in one turn.
  assert.deepEqual(previewsFor("@img_1.png and again @img_1.png"), ["img_1.png"]);
});

test("URLs, data URIs, absolute paths and escapes are refused", () => {
  /*
   * None of these can be a relative path inside the session's directory, so asking for one would produce a refusal the
   * reader cannot act on. `..` especially: the orchestrator's containment check would refuse it anyway, and requesting it
   * first would be theatre.
   */
  assert.deepEqual(previewsFor("see https://example.com/x.png"), []);
  assert.deepEqual(previewsFor("data:image/png;base64,AAA"), []);
  assert.deepEqual(previewsFor("/etc/passwd.png"), [], "absolute paths are not the UI's vocabulary");
  assert.deepEqual(previewsFor("~/Desktop/shot.png"), []);
  assert.deepEqual(previewsFor("@../outside.png"), []);
  assert.deepEqual(previewsFor("docs/../../outside.png"), []);
});

test("prose about a screenshot is not a request for one", () => {
  // The cost of a false positive is a failed read and a confusing note in the transcript; the cost of a false negative
  // is nothing. So a bare word that merely ends in an image extension is still treated as a path — a file named
  // `screenshot.png` at the session root is the common case — but text that is only PROSE about images is not scanned
  // into existence.
  assert.deepEqual(previewsFor("no images here"), []);
  assert.deepEqual(previewsFor("the screenshots look wrong"), []);
  assert.deepEqual(previewsFor(""), []);
});

test("a message that dumps many paths is capped", () => {
  // A directory listing pasted into the prompt must not queue a hundred reads. `MAX_PREVIEWS` bounds it, and the first
  // ones win because the reader's own order is the best guess at what matters.
  const many = Array.from({ length: 20 }, (_, index) => `shot${index}.png`).join(" ");
  assert.equal(previewsFor(many).length, MAX_PREVIEWS);
  assert.deepEqual(previewsFor(many)[0], "shot0.png");
});

test("a NUL byte or an absurdly long token is not a path", () => {
  assert.deepEqual(previewsFor("a\u0000b.png"), []);
  assert.deepEqual(previewsFor(`${"x".repeat(400)}.png`), []);
});
