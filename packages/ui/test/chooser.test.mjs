/**
 * The directory chooser, rendered (issue #76, ADR-0012).
 *
 * A file of its own rather than an append to `components.test.mjs`, for the reason `affordance.test.mjs` records:
 * that file is where every UI slice appends, so two open pull requests conflict there and git's conflict region has
 * twice cut a test in half.
 *
 * ## What is asserted here, and what is deliberately not
 *
 * These run the REAL components through Vite's SSR transform, so they see the markup a reader is served. What they
 * cannot see is the effects (no socket, no click handlers), so the navigation behaviour — descending, ascending,
 * refetching — is covered by the pure reducer and completion tests instead, and the rendered assertions are about
 * what is ON the screen: that a place is a row, that a missing place is stated, that an empty folder says it is empty
 * rather than looking broken, and that a refusal states its reason.
 *
 * The one property that matters most is asserted last: with an orchestrator that cannot offer places, the pane is
 * ABSENT rather than empty.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

let server;
let OpenDirectorySheet, reducePlaces, initialPlacesState;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ OpenDirectorySheet } = await server.ssrLoadModule("/src/components/OpenDirectorySheet.tsx"));
  ({ reducePlaces, initialPlacesState } = await server.ssrLoadModule("/src/places.ts"));
});

after(async () => {
  await server?.close();
});

/** React's SSR output escapes and inserts comment separators; assertions are about what the markup SAYS. */
function text(html) {
  return html
    .replaceAll("<!-- -->", "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

const home = "/Users/x";

/** A places state with the roots answered and one listing loaded. */
function stateWith(over = {}) {
  const base = reducePlaces(initialPlacesState(), {
    kind: "placesLoaded",
    home,
    places: [
      { id: "home", label: "Home", path: home, exists: true },
      { id: "git", label: "git", path: `${home}/git`, exists: true },
      { id: "projects", label: "Projects", path: `${home}/Projects`, exists: false },
    ],
  });
  const loaded = reducePlaces(base, {
    kind: "listingLoaded",
    path: `${home}/git`,
    listing: {
      path: `${home}/git`,
      abbreviated: "~/git",
      name: "git",
      parent: undefined,
      entries: [
        { name: "alpha", path: `${home}/git/alpha` },
        { name: "beta", path: `${home}/git/beta` },
      ],
      truncated: false,
    },
  });
  if (over.listing) return reducePlaces(loaded, over.listing);
  return loaded;
}

function render(props) {
  return renderToString(
    createElement(OpenDirectorySheet, {
      installationRoot: undefined,
      home,
      recent: [],
      onClose() {},
      onOpen() {},
      ...props,
    }),
  );
}

test("the roots are one row each, labelled by name and abbreviated by path", () => {
  const html = render({ places: stateWith(), onListPlaces() {} });
  assert.match(text(html), /Places/, "the pane names itself");
  // A root's label is its own name, and the path beside it is abbreviated — the two facts a reader needs to tell
  // `~/git` from `~/src`.
  assert.match(text(html), /Home/);
  assert.match(text(html), /~\/git/);
});

test("a root that is not on this machine is STATED, never hidden", () => {
  // The same rule the recent list follows (#149): hiding it reads as "Pi Central does not know where your code is",
  // when the truth is that this machine has no such folder.
  const html = render({ places: stateWith(), onListPlaces() {} });
  assert.match(text(html), /Not on this machine/);
  assert.match(text(html), /~\/Projects/);
});

test("the chooser appears BETWEEN the recents and the input, so the exact-path route stays reachable", () => {
  // Order is a usability decision and not cosmetic: browsing above the input means a reader who knows the path is not
  // made to scroll past a folder tree to reach the field that takes it.
  const html = render({
    places: stateWith(),
    onListPlaces() {},
    recent: [{ cwd: `${home}/work`, sessions: 1, lastUsedMs: 1, cwdExists: true }],
  });
  const recents = html.indexOf("Used before");
  const chooser = html.indexOf("Places");
  const input = html.indexOf("absolute/path/to/project");
  assert.ok(recents >= 0 && chooser >= 0 && input >= 0, "all three sections are present");
  assert.ok(recents < chooser, "recents first — one click each");
  assert.ok(chooser < input, "and the chooser before the text field");
});

test("with no places at all, the pane says so and points at the two routes that still work", () => {
  // A machine whose projects live under `/Volumes` or a path that is none of the roots. This is a real state, and the
  // text input plus the recent list are both still there.
  const empty = reducePlaces(initialPlacesState(), {
    kind: "placesLoaded",
    home,
    places: [{ id: "home", label: "Home", path: home, exists: false }],
  });
  const html = render({ places: empty, onListPlaces() {} });
  assert.match(text(html), /None of the usual folders exist here/);
  assert.match(text(html), /Type a path below/);
});

test("an EMPTY folder is an answer: the pane says it is empty rather than looking broken", () => {
  const emptyDir = reducePlaces(stateWith(), {
    kind: "listingLoaded",
    path: `${home}/empty`,
    listing: {
      path: `${home}/empty`,
      abbreviated: "~/empty",
      name: "empty",
      parent: home,
      entries: [],
      truncated: false,
    },
  });
  // The listing is held by the reducer, keyed by path — the same four-valued state `files.ts` documents, so "empty"
  // and "could not read" cannot be rendered as one thing.
  const state = emptyDir.directories[`${home}/empty`];
  assert.equal(state.status, "loaded");
  assert.deepEqual(state.entries ?? state.listing.entries, []);
});

test("a refusal is kept as a FAILURE with its reason, never as an empty folder", () => {
  const failed = reducePlaces(stateWith(), {
    kind: "listingFailed",
    path: `${home}/gone`,
    reason: "not-found",
    code: "ENOENT",
    message: 'cannot list "/Users/x/gone": no such file or directory (ENOENT)',
  });
  const state = failed.directories[`${home}/gone`];
  assert.equal(state.status, "failed");
  assert.equal(state.reason, "not-found");
  assert.equal(state.code, "ENOENT", "the OS code survives, so the reader can tell a typo from a permissions problem");
});

test("a re-answer of the roots does not blank the pane it is refilling", () => {
  // A "loading" state that cleared the roots would render an empty machine for the duration of every refresh — a false
  // claim about the machine rather than about the request.
  const loaded = stateWith();
  const reloading = reducePlaces(loaded, { kind: "placesLoading" });
  assert.deepEqual(reloading.roots?.map((place) => place.id), loaded.roots.map((place) => place.id));
});

test("reopening the sheet drops listings cached by the previous open", () => {
  // The #189 shape, in a milder form: a folder created while the sheet was closed would otherwise be missing from a
  // listing the reader descends into, until the app was restarted. The roots survive — they are a fact about the
  // machine — so a reopen is not a blank pane.
  const loaded = stateWith();
  assert.ok(loaded.directories[`${home}/git`], "cached during the first open");
  const reopened = reducePlaces(loaded, { kind: "reload" });
  assert.deepEqual(reopened.directories, {}, "listings are re-read");
  assert.ok(reopened.roots !== undefined, "but the roots stay, so nothing flickers");
});

test("a cached listing under a root that no longer exists is dropped", () => {
  // Otherwise the pane offers a folder whose root is now `exists: false`, and the click is refused by the next
  // request — a row that looks available and is not, which is the failure the recent list's disabled state avoids.
  const loaded = stateWith();
  assert.ok(loaded.directories[`${home}/git`], "the listing is cached under its root");
  const shrunken = reducePlaces(loaded, {
    kind: "placesLoaded",
    home,
    places: [{ id: "home", label: "Home", path: `${home}/other`, exists: true }],
  });
  assert.equal(shrunken.directories[`${home}/git`], undefined, "a listing outside every current root is gone");
});

test("with an orchestrator that cannot offer places, the pane is ABSENT — not empty", () => {
  // The property this file exists for. An empty chooser would claim there are no folders on this machine, which is a
  // false statement about the machine; the honest answer is the sheet the reader already knows, and the control is
  // withheld until both halves speak the same protocol (`supportsPlaces`).
  const html = render({});
  assert.ok(!/Places/.test(html), `no chooser pane: ${html}`);
  assert.match(text(html), /Open in a directory/, "and the sheet is still the sheet");
  assert.match(html, /absolute\/path\/to\/project/, "with the text input it has always had");
});

// --- Completion, in the sheet's own markup --------------------------------------------------------

test("typing a prefix offers completions beside the input, showing what accepting would ADD", () => {
  const html = render({
    places: stateWith(),
    onListPlaces() {},
    initialPath: "~/git/al",
    recent: [{ cwd: `${home}/git/alpha`, sessions: 2, lastUsedMs: 1, cwdExists: true }],
  });
  // Asserted on the markup: the two spans ARE the affordance — the typed part quiet, the remainder bright — so the
  // split is what the reader is choosing between, not decoration.
  assert.match(html, /completion-typed">~\/git\/al</, "what was typed, unchanged");
  assert.match(html, /completion-rest">pha</, "and only the part accepting would add");
  assert.equal((html.match(/class="completion"/g) ?? []).length, 1, "one suggestion, not a duplicate from the recents");
});

test("a recent directory in a DIFFERENT folder is not offered as a completion of this one", () => {
  // The failure this prevents is a suggestion that REPLACES what was typed rather than extending it: `~/work/project`
  // shares no prefix with `~/git/pro`, so accepting it would discard the reader's text.
  const html = render({
    places: stateWith(),
    onListPlaces() {},
    initialPath: "~/git/al",
    recent: [{ cwd: `${home}/work/alpha`, sessions: 2, lastUsedMs: 1, cwdExists: true }],
  });
  // The RECENT list legitimately shows `~/work/alpha` — it is a directory used before. What must not happen is a
  // COMPLETION for it, because accepting that would replace `~/git/al` instead of extending it.
  const completions = html.slice(html.indexOf('<ul class="completions"'));
  assert.ok(!/work/.test(completions), `no completion from another folder: ${completions}`);
});

test("an expanded `~` is SHOWN before submission, so the directory used is the one written down", () => {
  // The reader typed `~/git/alpha` and the session will be started in `/Users/x/git/alpha`. Saying so is the same
  // honesty a rename or a delete owes: the action must not act on a string the reader never saw.
  const html = render({ places: stateWith(), onListPlaces() {}, initialPath: "~/git/alpha" });
  assert.match(text(html), /\/Users\/x\/git\/alpha/, "the expanded path is visible");
  assert.match(html, /expanded-path/);
});

// --- The pane survives a long path ----------------------------------------------------------------
//
// Not expressible in static markup (no CSS runs), so asserted against the stylesheet — the same approach
// `affordance.test.mjs` uses. A path that cannot truncate sets the modal's intrinsic width, and a 620px-max dialog
// that grows to 1200px because one folder name is long is a layout defect visible at rest, not on hover.

test("a long path in the chooser truncates instead of widening the dialog", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /\.chooser-path\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /text-overflow:\s*ellipsis/, "the path truncates");
  assert.match(rule, /min-width:\s*0/, "and is allowed to — a flex child cannot shrink below its content otherwise");
  assert.match(rule, /direction:\s*rtl/, "keeping the LAST segment visible, which is the part that identifies the folder");
  assert.match(/\.chooser\s*\{([^}]*)\}/.exec(css)?.[1] ?? "", /max-height/, "and the list scrolls rather than growing");
});
