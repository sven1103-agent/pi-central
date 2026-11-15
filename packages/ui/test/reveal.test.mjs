/**
 * Show in Finder: the tree's control and its refusal (issue #255, ADR-0014).
 *
 * ## Why this is its own file
 *
 * The same reason `affordance.test.mjs` gives: `components.test.mjs` is ~1,800 lines and every UI slice
 * appends to its END, so two open pull requests conflict there — it cost four rebases before the separate
 * files existed. New UI assertions go in their own file.
 *
 * ## What is asserted, and the shape of each failure
 *
 * The control is one affordance and it can be wrong in three independent ways:
 *
 *   1. **Composition.** One row, TWO buttons, and the reveal control OUTSIDE the row's own `<button>`.
 *      Asserting only `.filetree-reveal`'s properties would pass with the button nested inside the row,
 *      which is the structurally valid-but-unreachable version — a keyboard cannot reach a control inside
 *      another control, and the markup is invalid HTML. That is the C20 test: a new child changes the
 *      composition, so the assertion is about the composition.
 *   2. **Labelling.** Forty rows reading "Reveal" are indistinguishable to a screen reader. The label has
 *      to name the entry.
 *   3. **The refusal.** It is stated in words under the row, through the existing `FileErrorNote`, so a
 *      new reason set cannot genuinely need a second renderer.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

let server;
let FileTree, FileErrorNote, initialFilesState;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ FileTree } = await server.ssrLoadModule("/src/components/FileTree.tsx"));
  ({ FileErrorNote } = await server.ssrLoadModule("/src/components/FileErrorNote.tsx"));
  ({ initialFilesState } = await server.ssrLoadModule("/src/files.ts"));
});

after(async () => {
  await server?.close();
});

/** A FilesState with one loaded root holding `entries`. */
function stateWith(entries) {
  const state = initialFilesState();
  state.directories["s1\u0000"] = { status: "loaded", entries, truncated: false };
  return state;
}

/** Render the tree with a reveal handler, the way `FilesPanel` does when the peer supports it. */
function renderTree(state, { reveal = true } = {}) {
  return renderToString(
    createElement(FileTree, {
      sessionId: "s1",
      state,
      cwd: "/work",
      onExpand() {},
      onCollapse() {},
      onToggleHidden() {},
      onOpenFile() {},
      // An EXPLICIT `undefined` is the "peer predates the control" case, so it is spread rather than
      // omitted — a destructuring default would silently turn it back into a handler and the gate test
      // would assert against a control that is always present.
      ...(reveal ? { onReveal: () => {} } : { onReveal: undefined }),
    }),
  );
}

/**
 * How many `<button` openings a row carries, counting the row's own.
 *
 * The slice runs from this row's `<li` to the next one, so the count is about ONE row rather than the whole
 * tree — a document-wide count would pass for a tree where one row had two buttons and another had none.
 */
function buttonsInRow(html, name) {
  const items = html.split('<li class="filetree-node');
  const row = items.find((chunk) => chunk.includes(`class="filetree-row" title="${name}"`));
  assert.ok(row !== undefined, `no row for ${name} in: ${html}`);
  return (row.match(/<button/g) ?? []).length;
}

test("one row is TWO buttons, and the reveal control is not inside the row's own button", () => {
  /*
   * The C20 assertion, and the one that fails if the reveal control is nested inside `.filetree-row`.
   *
   * Nesting is the tempting implementation — it puts the glyph on the row's line with no CSS work — and it
   * is invalid HTML whose practical effect is that the inner control cannot be reached by keyboard. So the
   * test asserts the count AND that the reveal button closes the row's button tag first.
   */
  const html = renderTree(stateWith([{ name: "src", kind: "directory", hidden: false, mtimeMs: 1 }]));
  assert.equal(buttonsInRow(html, "src"), 2, `one row must carry two buttons, got: ${html}`);

  // The row's own button is closed before the reveal button opens. A nested control would put
  // `filetree-reveal` BEFORE the first `</button>` after the row's opening tag.
  const rowStart = html.indexOf('class="filetree-row"');
  const rowEnd = html.indexOf("</button>", rowStart);
  const revealAt = html.indexOf('class="filetree-reveal"');
  assert.ok(rowStart >= 0 && rowEnd >= 0 && revealAt >= 0, "both controls must be present");
  assert.ok(revealAt > rowEnd, "the reveal control must be a SIBLING of the row button, not a child");
});

test("the reveal control is labelled with the entry's name, not the word 'Reveal'", () => {
  // Forty rows reading "Reveal" are indistinguishable in a screen reader's control list. The label names
  // what will be revealed; the visible glyph is `aria-hidden` so it is not announced as a character.
  const html = renderTree(stateWith([
    { name: "notes.md", kind: "file", hidden: false, size: 12, mtimeMs: 1 },
    { name: "a.pdf", kind: "file", hidden: false, size: 2048, mtimeMs: 1 },
  ]));
  assert.match(html, /aria-label="Reveal notes\.md in Finder"/);
  assert.match(html, /aria-label="Reveal a\.pdf in Finder"/);
  // The hover text agrees with the label, so a sighted reader is not guessing from a glyph either.
  assert.match(html, /title="Show in Finder"/);
});

test("the WORKSPACE can be shown in Finder, so an empty folder is not a dead end", () => {
  /*
   * Reported from a screenshot: a session whose workspace held only `.idea` — and an empty workspace, which
   * renders NO ROWS at all — had no way to open the folder it was browsing. The rows are the CHILDREN of the
   * workspace, so the workspace itself was the one directory in the panel with no reveal, and an empty
   * directory removed the only control that could have helped.
   *
   * The empty state is the fixture that matters: it is the case where nothing else is on screen, and the one
   * the per-row control can never cover however carefully it is styled.
   */
  const html = renderTree(stateWith([]));
  assert.match(html, /This directory is empty\./, "the empty state must still be stated");

  // The control is in the HEADER, named in words rather than as a glyph, because it is the panel's own
  // subject rather than one row among forty.
  const button = /<button[^>]*aria-label="Reveal the working directory in Finder"[^>]*>([^<]*)</.exec(html);
  assert.ok(button !== null, `the empty workspace must offer the reveal: ${html}`);
  assert.equal(button[1], "Show in Finder", "the visible label says what it does, not where it goes");
  // And the path, so a reader with two windows open knows which folder this button belongs to.
  assert.match(html, /title="Show \/work in Finder"/);
});

test("the workspace's reveal is a different control from a row's, not a duplicate of one", () => {
  /*
   * The header control is `.btn.btn-quiet` and the per-row one is `.filetree-reveal`, so a reader meets one
   * worded affordance for the folder and one glyph for each file. Asserted as a pair: collapsing them into a
   * single class would silently make the header button inherit `flex: none`/18px from a rule written for a
   * row glyph, which is C20 in the other direction — a rule correct for one child, applied to a second.
   */
  const html = renderTree(stateWith([{ name: "src", kind: "directory", hidden: false, mtimeMs: 1 }]));
  assert.match(html, /class="btn btn-quiet"[^>]*aria-label="Reveal the working directory in Finder"/);
  assert.match(html, /class="filetree-reveal"[^>]*aria-label="Reveal src in Finder"/);
});

test("no handler means NO control, so a peer that predates `reveal` is not offered it", () => {
  /*
   * The version gate, asserted at the render: a v9 orchestrator answers `bad control: unknown kind
   * 'reveal'`, which surfaces as a bug rather than as a version skew. Withholding the control is the
   * honest form — and the assertion has to be the ABSENCE of the class, not merely a different label.
   *
   * BOTH controls are checked. The header button is `.btn.btn-quiet` rather than `.filetree-reveal`, so a
   * check on the row class alone would have left the newer control ungated — the exact way this gate would
   * rot as more affordances are added.
   */
  const html = renderTree(stateWith([{ name: "src", kind: "directory", hidden: false, mtimeMs: 1 }]), {
    reveal: false,
  });
  assert.ok(!/filetree-reveal/.test(html), "no handler must mean no per-row control");
  assert.ok(!/in Finder/.test(html), `no handler must mean no header control either: ${html}`);
  // The row itself is untouched: withholding one affordance must not remove the tree.
  assert.match(html, /class="filetree-row"/);
});

test("a refusal is stated UNDER the row, in words, and named as the platform problem it is", () => {
  /*
   * The `unsupported-platform` case, which is the one reason this slice adds to `reasonLabel`. Falling
   * through to the `default` would print "Could not read" — a sentence about reading, for an action that
   * never tried to read anything.
   */
  const state = stateWith([{ name: "a.pdf", kind: "file", hidden: false, size: 2048, mtimeMs: 1 }]);
  state.revealNotes["s1\u0000a.pdf"] = {
    reason: "unsupported-platform",
    message: "showing a file in the file manager is a macOS feature, and this orchestrator is running on linux (C10)",
  };
  const html = renderTree(state);
  assert.match(html, /Cannot show in Finder here/, "the reason must be stated in words");
  assert.match(html, /running on linux/, "and the orchestrator's own sentence is shown verbatim");
  // The row's ordinary rendering is unchanged: a refusal is not a reason to hide the file.
  assert.match(html, /a\.pdf/);
});

test("a refusal that came from containment keeps the wording a READ uses", () => {
  // The reuse, visible in the UI: an escaping path says "Outside the working directory" for a reveal
  // because it says it for a read — one reason, one meaning, one sentence.
  const state = stateWith([{ name: "link", kind: "file", hidden: false, mtimeMs: 1 }]);
  state.revealNotes["s1\u0000link"] = {
    reason: "escapes-cwd",
    message: '"link" is a symlink whose target lies outside the session\'s working directory',
  };
  const html = renderTree(state);
  assert.match(html, /Outside the working directory/);
});

test("a path with no refusal carries no note, and its row is not dimmed", () => {
  // The other half of the distinction: absence of a note is the ordinary case, and it must not render as
  // an error frame or as a disabled row. (It is also not "it worked" — see the state module.)
  const html = renderTree(stateWith([{ name: "a.txt", kind: "file", hidden: false, size: 1, mtimeMs: 1 }]));
  assert.ok(!/filetree-error/.test(html), "a row that was never refused must not look refused");
});

test("a refusal is indented with its OWN row, not one step further in", () => {
  /*
   * C20 again, in its measured form: the note is a child of the `<li>` that already carries the row's
   * indentation, so any padding of its own is applied TWICE, and the refusal appears one level deeper
   * than the file it is about. This shipped in the first draft of the slice — row at 12px, note at 24px,
   * for a row at depth 1 — and no existing assertion could see it, because every one of them asked what
   * the note SAYS rather than where it sits.
   *
   * The nested-row fixture is what makes the defect visible at all: at depth 0 the doubled padding is 0px
   * and the bug is invisible, which is why the tests above (all on the root) stayed green.
   */
  const state = stateWith([{ name: "src", kind: "directory", hidden: false, mtimeMs: 1 }]);
  state.expanded["s1\u0000src"] = true;
  state.directories["s1\u0000src"] = {
    status: "loaded",
    truncated: false,
    entries: [{ name: "a.txt", kind: "file", hidden: false, size: 1, mtimeMs: 1 }],
  };
  state.revealNotes["s1\u0000src/a.txt"] = { reason: "not-found", message: "gone" };

  const html = renderTree(state);
  // The `<li>` carries the row's indentation; the note must add none of its own.
  const note = /<p class="filetree-note filetree-error"[^>]*style="padding-left:(\d+)px"/.exec(html);
  assert.ok(note !== null, `the note must be rendered: ${html}`);
  assert.equal(Number(note[1]), 0, "the note sits inside the row's own indentation and must not repeat it");
  // And the row it belongs to IS indented, so this is not asserting that nothing is ever indented.
  assert.match(html, /<li class="filetree-node" role="treeitem" style="padding-left:12px">/);
});

test("the platform refusal has its OWN label, so it does not read as a read failure", () => {
  /*
   * The one reason this slice adds to `reasonLabel`. Falling through to the `default` would print "Could
   * not read" — a sentence about reading, for an action that never tried to read anything, and the whole
   * point of `FileErrorNote` is that the fix differs per reason.
   *
   * The other arms are asserted too, because they are the REUSED ones: if a later change gave the reveal
   * its own note component, the containment wording would drift apart from the read's.
   */
  const labelled = {
    "escapes-cwd": "Outside the working directory",
    "absolute-path": "Not a relative path",
    "invalid-path": "Not a usable path",
    "not-found": "Not found",
    permission: "Permission denied",
    "unsupported-platform": "Cannot show in Finder here",
  };
  for (const [reason, label] of Object.entries(labelled)) {
    const html = renderToString(createElement(FileErrorNote, { path: "p", reason, message: "m" }));
    assert.match(html, new RegExp(`<strong>${label}</strong>`), `reason ${reason} must read as "${label}"`);
    assert.ok(!/Could not read/.test(html), `reason ${reason} must not fall through to the default`);
  }
});
