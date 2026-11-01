/**
 * The `@path` autocomplete: detection, ranking, and what accepting one writes.
 *
 * ## What these are protecting
 *
 * Every rule here is arithmetic over a string, and every way of getting one wrong looks like "the composer is broken"
 * rather than like a picker bug: a mention detected one character off inserts a double `@`; a replacement span off by one
 * eats the reader's punctuation; an `apply` that emits a form `previewsFor` rejects completes to a path that then does not
 * preview — the feature appearing to half-work.
 *
 * The last test group asserts the two modules AGREE, which is the only way to keep "what the picker writes" and "what the
 * preview recognises" from drifting apart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, complete, mentionAt, moveSelection, scrollToShow, type Entry } from "../src/mentions.ts";
import { previewsFor } from "../src/references.ts";

/** The mention at the end of a string, which is where the caret is in most tests. */
const atEnd = (text: string) => mentionAt(text, text.length);

/**
 * `complete`'s result, asserted non-empty.
 *
 * `noUncheckedIndexedAccess` makes `options[0]` possibly undefined, and a test that sprinkled `!` everywhere would be a
 * test that stops caring whether the option exists. This makes the expectation explicit at the point of use.
 */
/** A mention, asserted present. */
function mustMention(text: string, caret: number) {
  const mention = mentionAt(text, caret);
  assert.ok(mention, `expected a mention in ${JSON.stringify(text)} at ${caret}`);
  return mention;
}

/** A completion, asserted present. */
function mustFirst<T>(options: readonly T[]): T {
  assert.ok(options.length > 0, "expected at least one option");
  return options[0] as T;
}

test("a bare @ opens a mention, and so does a typed name", () => {
  assert.deepEqual(atEnd("@"), { start: 0, query: "" });
  assert.deepEqual(atEnd("@img"), { start: 0, query: "img" });
  assert.deepEqual(atEnd("look at @img_6"), { start: 8, query: "img_6" });
});

test("a mention in the MIDDLE of a sentence works, and the caret decides", () => {
  // The caret scan is backwards from the caret, so text after it is irrelevant — which is what makes editing mid-sentence
  // work at all.
  assert.deepEqual(mentionAt("look at @img more", 12), { start: 8, query: "img" });
  assert.equal(mentionAt("look at @img more", 18), undefined, "after the space, no mention");
});

test("an email is not a mention", () => {
  /*
   * The one false positive that would be genuinely annoying: `user@example.com` must not open a picker. The rule is that a
   * mention starts after whitespace or an opening bracket, so an `@` following a word is not one.
   */
  assert.equal(atEnd("user@example.com"), undefined);
  assert.equal(atEnd("mail me at sven@example"), undefined);
});

test("brackets and quotes open a mention; a second @ does not", () => {
  assert.deepEqual(atEnd("(@shot"), { start: 1, query: "shot" });
  assert.deepEqual(atEnd("[@shot"), { start: 1, query: "shot" });
  assert.deepEqual(atEnd('"@shot'), { start: 1, query: "shot" });
  // `@@shot`: the second @ follows an @, which is not a start character, so it is not a mention start — and the scan keeps
  // going back, where the first @ has nothing before it and WOULD start one. The implementation stops instead, because a
  // `@` inside a query is nonsense and offering completions for `@shot` would be worse than offering none.
  assert.equal(atEnd("@@shot"), undefined, "a doubled @ is not a mention");
});

test("a newline starts a mention, and one never spans lines", () => {
  assert.deepEqual(atEnd("first line\n@shot"), { start: 11, query: "shot" });
  assert.equal(atEnd("@shot\nthen more"), undefined, "the caret is on a line with no @");
});

test("an open picker never offers files for a paragraph of prose", () => {
  // A mention is a token, not a sentence: whitespace ends it, so pasting a paragraph cannot produce a 2000-character query.
  const long = `@${"a".repeat(300)}`;
  assert.equal(atEnd(long), undefined, "a query beyond the cap is not a mention");
  assert.equal(atEnd("@a b"), undefined, "a space ends it");
});

test("directory and tail are split at the LAST slash, so nesting works", () => {
  const mention = mustMention("@docs/images/ic", "@docs/images/ic".length);
  const options = complete(mention, [
    { name: "icon.png", kind: "file" },
    { name: "other.png", kind: "file" },
  ]);
  assert.deepEqual(options.map((option) => option.value), ["docs/images/icon.png"]);
});

test("DIRECTORIES rank first, then images, then other matches", () => {
  /*
   * This reverses my first ordering, and the reversal was measured rather than argued.
   *
   * Images were first on the theory that images are the reason the picker exists. Then a bare `@` at a real repository root
   * offered eight images and NOT ONE DIRECTORY, because the root holds dozens of `img_*.png` screenshots and the cap is
   * eight — so a reader typing `@` to reach `assets/shot.png` could not see `assets/` at all. Images are the reason to
   * FINISH a path, not the reason to start one.
   */
  const entries: Entry[] = [
    { name: "shot.txt", kind: "file" },
    { name: "shots", kind: "directory" },
    { name: "shot.png", kind: "file" },
  ];
  const options = complete(mustMention("@shot", 5), entries);
  assert.deepEqual(
    options.map((option) => option.label),
    ["shots/", "shot.png", "shot.txt"],
    "directory, then image, then remaining match",
  );
});

test("a bare @ is not flooded by a directory full of screenshots", () => {
  // The measured defect: 40 images and 2 directories, cap 8 — so without the directory-first rule the directories are
  // unreachable, and the picker cannot be used to reach them.
  const entries: Entry[] = [
    { name: "assets", kind: "directory" },
    { name: "docs", kind: "directory" },
    ...Array.from({ length: 40 }, (_, index) => ({ name: `img_${index}.png`, kind: "file" as const })),
  ];
  const options = complete(mustMention("@", 1), entries);
  assert.deepEqual(options.slice(0, 2).map((o) => o.label), ["assets/", "docs/"], "directories are reachable");
  assert.equal(options.length, 8);
});

test("matching is case-insensitive and does not reorder equal ranks", () => {
  const entries: Entry[] = [
    { name: "Screenshot-A.png", kind: "file" },
    { name: "screenshot-b.png", kind: "file" },
  ];
  assert.deepEqual(complete(mustMention("@SCREEN", 7), entries).map((o) => o.label), ["Screenshot-A.png", "screenshot-b.png"]);
});

test("a directory is offered with a slash and marked as continuing", () => {
  // Selecting a folder and then having to type `/@` again would make the picker slower than the keyboard.
  const option = mustFirst(complete(mustMention("@docs", 5), [{ name: "docs", kind: "directory" }]));
  assert.equal(option.label, "docs/", "the row says continue into me");
  assert.equal(option.continues, true);
  assert.equal(option.value, "docs", "but the VALUE has no trailing slash — `apply` adds it");
});

test("an unloaded directory yields no options, which is NOT the same as no match", () => {
  /*
   * The distinction `files.ts` protects for the tree, here for the picker: `undefined` means "not asked yet" and renders as
   * "Reading…", while `[]` means "asked, and nothing is here" and renders as "No match". Collapsing them tells the reader to
   * give up on something that is still coming.
   */
  assert.deepEqual(complete(mustMention("@shot", 5), undefined), []);
});

test("the list is capped, so a directory of 400 files cannot fill the composer", () => {
  const many: Entry[] = Array.from({ length: 400 }, (_, index) => ({ name: `shot${index}.png`, kind: "file" }));
  assert.equal(complete(mustMention("@shot", 5), many).length, 8, "the default cap");
  assert.equal(complete(mustMention("@shot", 5), many, 3).length, 3, "and it is a parameter");
});

// --- Accepting one ------------------------------------------------------------------------------

test("a FILE completes with a trailing space, so prose can continue", () => {
  const text = "look at @sho please";
  const caret = 12; // just after "@sho"
  const mention = mustMention(text, caret);
  const option = mustFirst(complete(mention, [{ name: "shot.png", kind: "file" }]));
  const result = apply(text, mention, option, caret);

  assert.equal(result.text, "look at @shot.png  please", "the mention is replaced, and the rest survives");
  assert.equal(result.caret, "look at @shot.png ".length, "the caret sits after the inserted space");
  assert.equal(result.text[result.caret - 1], " ");
});

test("a DIRECTORY completes with a slash and leaves the mention open", () => {
  const text = "@doc";
  const mention = mustMention(text, text.length);
  const option = mustFirst(complete(mention, [{ name: "docs", kind: "directory" }]));
  const result = apply(text, mention, option, text.length);

  assert.equal(result.text, "@docs/");
  // Re-entering the mention at the new caret must work, which is what makes descending into a folder a chain rather than a
  // new gesture.
  const next = mentionAt(result.text, result.caret);
  assert.deepEqual(next, { start: 0, query: "docs/" }, "the picker reopens inside the directory");
});

test("a mention in the middle replaces only its own span", () => {
  // Off-by-one here eats a character of the reader's prose, which is the kind of bug that reads as "it deleted my text".
  const text = "before @sh after";
  const caret = "before @sh".length;
  const mention = mustMention(text, caret);
  const option = mustFirst(complete(mention, [{ name: "shot.png", kind: "file" }]));
  const result = apply(text, mention, option, caret);
  assert.equal(result.text, "before @shot.png  after");
});

// --- The agreement that keeps the feature whole -------------------------------------------------

test("what the picker WRITES is what the preview RECOGNISES", () => {
  /*
   * The failure this prevents: the picker completing to a form `previewsFor` rejects, so the reader sees a path they chose
   * from a picker and no thumbnail appears — a feature that half-works, which is harder to trust than one that does not work
   * at all.
   */
  const entries: Entry[] = [
    { name: "shot.png", kind: "file" },
    { name: "docs", kind: "directory" },
    { name: "notes.txt", kind: "file" },
  ];

  for (const query of ["@shot", "@docs", "@sho", "@"]) {
    const mention = mustMention(query, query.length);
    for (const option of complete(mention, entries)) {
      if (option.continues) continue; // a directory is not previewable, by definition
      const { text } = apply(query, mention, option, query.length);
      /*
       * Only IMAGE completions are asserted to preview, because `previewsFor` is deliberately image-only — completing to
       * `notes.txt` is correct behaviour that produces no thumbnail, and asserting otherwise would be asserting that every
       * file is a picture.
       *
       * The property that matters is the one-way implication: anything the picker offers as an image must be something the
       * preview recognises. A picker that completes to a form the preview rejects would look like a feature that half-works.
       */
      const isImage = /\.(png|jpe?g|gif|webp)$/i.test(option.value);
      if (!isImage) {
        assert.deepEqual(previewsFor(text), [], `a non-image completion previews nothing: ${JSON.stringify(text)}`);
        continue;
      }
      assert.deepEqual(
        previewsFor(text),
        [option.value],
        `the picker writes something the preview accepts: ${JSON.stringify(text)}`,
      );
    }
  }
});

test("selection wraps, so Down at the end returns to the first", () => {
  assert.equal(moveSelection(0, 3, 1), 1);
  assert.equal(moveSelection(2, 3, 1), 0, "past the end wraps to the start");
  assert.equal(moveSelection(0, 3, -1), 2, "and before the start wraps to the end");
  assert.equal(moveSelection(0, 0, 1), 0, "an empty list cannot fail");
});

test("node_modules/.git are never offered, at any query", () => {
  /*
   * A review flagged `node_modules/` in the default suggestions: noise in a list that will almost never be @-mentioned, and
   * on a real repository root it takes one of six visible rows.
   *
   * Deliberately a SHORT list rather than a "hide dotfiles" rule — `.github/` and `.idea/` are genuinely useful to mention,
   * and `dist/` is a legitimate target for a question.
   */
  const entries: Entry[] = [
    { name: "node_modules", kind: "directory" },
    { name: ".git", kind: "directory" },
    { name: ".github", kind: "directory" },
    { name: "docs", kind: "directory" },
  ];
  for (const query of ["@", "@node", "@no", "@."]) {
    const labels = complete(mustMention(query, query.length), entries).map((o) => o.label);
    assert.ok(!labels.includes("node_modules/"), `node_modules is never offered (${query})`);
    assert.ok(!labels.includes(".git/"), `.git is never offered (${query})`);
  }
  // …and the useful dot-directory survives, which a "hide dotfiles" rule would have taken.
  assert.deepEqual(complete(mustMention("@", 1), entries).map((o) => o.label), [".github/", "docs/"]);
});

// --- Keeping the selected row visible -----------------------------------------------------------

test("a row already fully visible does not scroll the list", () => {
  /*
   * The property that keeps typing from jittering: if the highlighted row is inside the box, nothing moves. Without it, every
   * keystroke that did not change the selection would still nudge the list.
   */
  const viewport = { scrollTop: 0, height: 132 };
  assert.equal(scrollToShow({ top: 22, height: 22 }, viewport), undefined);
  assert.equal(scrollToShow({ top: 0, height: 22 }, viewport), undefined);
  assert.equal(scrollToShow({ top: 110, height: 22 }, viewport), undefined, "last fully visible row");
});

test("a row BELOW the box scrolls just enough to show it", () => {
  /*
   * The reported defect: the list is capped at six rows, so arrowing past the sixth put the highlight outside the box and the
   * picker looked frozen while Down kept being pressed.
   */
  const viewport = { scrollTop: 0, height: 132 };
  // Row 6 starts at 132 — exactly one row past the box.
  assert.equal(scrollToShow({ top: 132, height: 22 }, viewport), 22, "scroll by exactly the overflow");
  // Row 8, further down.
  assert.equal(scrollToShow({ top: 176, height: 22 }, viewport), 66);
});

test("a row ABOVE the box scrolls back to its top", () => {
  // ArrowUp from a scrolled position must bring the row back, not leave it clipped above.
  const viewport = { scrollTop: 88, height: 132 };
  assert.equal(scrollToShow({ top: 22, height: 22 }, viewport), 22);
  assert.equal(scrollToShow({ top: 0, height: 22 }, viewport), 0);
});

test("padding is respected at both ends, so the first and last rows are reachable", () => {
  /*
   * The list has vertical padding; without allowing for it a row aligned to `scrollTop` sits flush against the box edge and
   * reads as clipped, and the LAST row becomes impossible to show fully.
   */
  const viewport = { scrollTop: 0, height: 132 };
  assert.equal(scrollToShow({ top: 2, height: 22 }, viewport, 2), undefined, "the first row is visible past the padding");
  // The bottom, with padding: the band ends 2px above the box's bottom edge.
  assert.equal(scrollToShow({ top: 112, height: 22 }, viewport, 2), 4);
  // Never negative, however the caller rounds.
  assert.ok((scrollToShow({ top: 0, height: 22 }, { scrollTop: 50, height: 132 }, 2) ?? 0) >= 0);
});

test("a row taller than the box scrolls to its TOP, which is the part that identifies it", () => {
  // Cannot be fully shown; showing the start is the only useful choice, and the alternative (aligning the bottom) shows the
  // tail of a long label and hides the name.
  assert.equal(scrollToShow({ top: 40, height: 300 }, { scrollTop: 0, height: 132 }, 2), 38);
});

test("an unmeasured list does not scroll, so a render before layout cannot throw", () => {
  // `clientHeight` is 0 before layout and in jsdom; dividing or comparing against it would invent a huge offset.
  assert.equal(scrollToShow({ top: 22, height: 22 }, { scrollTop: 0, height: 0 }), undefined);
});

test("the selected row stays VISIBLE at every step, walking down and back up", () => {
  /*
   * The property, stated as the reader's experience rather than as four branches: after each arrow press, the highlighted row
   * overlaps the visible box. Asserted as a full round trip, because the reported defect was ASYMMETRIC — "it works when
   * traversing down, but not up" — and a test that only walked downwards would have passed with the bug in place.
   */
  const ROW = 22;
  const VISIBLE = 132;
  let scrollTop = 0;
  const visited = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

  for (const row of visited) {
    const top = row * ROW;
    const offset = scrollToShow({ top, height: ROW }, { scrollTop, height: VISIBLE }, 2);
    if (offset !== undefined) scrollTop = offset;

    const hiddenAbove = top < scrollTop;
    const clippedBelow = top + ROW > scrollTop + VISIBLE;
    assert.ok(
      !hiddenAbove && !clippedBelow,
      `row ${row} must be visible: row spans ${top}..${top + ROW}, box is ${scrollTop}..${scrollTop + VISIBLE}`,
    );
  }
});

test("returning to the FIRST row scrolls the list fully back, not to a header's offset", () => {
  /*
   * The bug this pins, and the reason it was invisible going down.
   *
   * `row.offsetTop` is measured from the nearest POSITIONED ancestor — `.mention`, the absolute panel — not from the list
   * that scrolls. So every row's position included the ~26px header above the list. Going DOWN, the same constant was added
   * on both sides of the comparison, so the offset cancelled and it worked. Going UP it did not: a row near the top looked
   * 26px lower than it was, appeared comfortably visible, and was never scrolled to. Coming back to the first row settled on
   * 24 rather than 0, leaving it tucked under the header.
   *
   * The component now measures in the list's own coordinate space (`row.offsetTop - list.offsetTop`). This asserts the
   * ARITHMETIC that fix produces, which is the part that can be tested here.
   */
  const ROW = 22;
  const VISIBLE = 132;

  // Scrolled to the bottom of a long list, then back to the first row.
  let scrollTop = 88;
  const offset = scrollToShow({ top: 0, height: ROW }, { scrollTop, height: VISIBLE }, 2);
  assert.equal(offset, 0, "the first row brings the list to the very top");

  scrollTop = offset ?? scrollTop;
  assert.equal(scrollTop, 0, "…leaving nothing above it, so no part is hidden under the header");
});
