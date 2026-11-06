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
let OpenDirectorySheet, DirectoryChooser, reducePlaces, initialPlacesState;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ OpenDirectorySheet } = await server.ssrLoadModule("/src/components/OpenDirectorySheet.tsx"));
  ({ DirectoryChooser } = await server.ssrLoadModule("/src/components/DirectoryChooser.tsx"));
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

/**
 * Render the CHOOSER directly, inside a directory.
 *
 * SSR runs no effects, so the resume-once-on-mount cannot happen: the only way to assert what a resumed picker looks
 * like is to render it at that location. `DirectoryChooser` takes `at` from local state, so a test would otherwise only
 * ever see the "Places" pane — which is exactly what four assertions caught on the first attempt.
 *
 * The component is handed a state whose `resumeAt` is the folder, and `initialAt` is not exposed because that would be
 * a test seam in the product. Instead the component is rendered with the state as a RESUMED one and the assertions read
 * what is on screen — see the note in each test.
 */
function renderChooserIn(dir, props = {}) {
  return renderToString(
    createElement(DirectoryChooser, {
      state: props.state ?? stateWith(),
      sort: props.sort ?? "name",
      showHidden: props.showHidden ?? false,
      onSort() {},
      onToggleHidden() {},
      onList() {},
      onChoose() {},
      onNavigated() {},
      ...props,
      // The starting location is the component's own; a test that needs to be inside a folder passes a state whose
      // listing is loaded for it and asserts through the resumed render below.
    }),
  );
}

/** A state that has been told to resume into `dir`, with that directory's listing loaded. */
function resumedInto(dir, entries = []) {
  const loaded = reducePlaces(stateWith(), {
    kind: "listingLoaded",
    path: dir,
    listing: {
      path: dir,
      abbreviated: dir.replace("/Users/x", "~"),
      name: dir.slice(dir.lastIndexOf("/") + 1),
      parent: dir.slice(0, dir.lastIndexOf("/")),
      entries,
      truncated: false,
    },
  });
  return { ...loaded, resumeAt: dir };
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

test("the roots are one row each in a PLACES RAIL, labelled by name", () => {
  // Restructured after the screenshot review: the three roots were a static menu under the recent list, which the
  // review called out as the thing that makes navigation impossible. They are a rail now — the shape a file dialog
  // uses — and the label is the root's own NAME (`git`, `Projects`) with the full path in the tooltip, because a
  // `direction: rtl` path hint was rendering as `git~/`.
  const html = render({ places: stateWith(), onListPlaces() {} });
  assert.match(html, /<nav class="chooser-places" aria-label="Places">/, "a labelled navigation landmark");
  assert.match(text(html), /Home/);
  assert.match(text(html), /git/);
  assert.match(html, /title="\/Users\/x\/git"/, "the path is in the tooltip, not mangled in the row");
  assert.ok(!/git~\//.test(html), "and never the reversed form the rtl rule produced");
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
  // Bounded at the list's own end: a slice "from here to the document" grew to include the footnote when the footnote
  // moved below the actions, and the word `work` in prose then failed an assertion about completions.
  const start = html.indexOf('<ul class="completions"');
  const completions = html.slice(start, html.indexOf("</ul>", start));
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

test("a long FOLDER NAME truncates, and the dialog does not widen", async () => {
  // The `direction: rtl` trick this used to require is gone, and its removal is the bug fix: it reversed the line's run
  // order and rendered `git~/`. The name column truncates instead, which is what a file manager does.
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const name = /\.chooser-name\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(name, /text-overflow:\s*ellipsis/, "the name truncates");
  assert.match(name, /min-width:\s*0/, "and is allowed to — a grid child cannot shrink below its content otherwise");
  assert.ok(!/direction:\s*rtl/.test(css), "no rtl anywhere: it REVERSES the text and rendered as git~/");
  // The dialog is a fixed measure now, not "as wide as its longest child".
  const sheetRule = css.slice(css.indexOf(".modal-sheet {"));
  assert.match(sheetRule.slice(0, sheetRule.indexOf("}")), /width:\s*min\(/, "a bounded width");
});

// --- The layout the screenshot exposed (issue #76, found by looking at it) -------------------------
//
// Every test above passed while the dialog was unusable: six recents plus an uncapped browser meant the browse surface
// was 4.5 visible rows, the trail's first segment looked like a button and was not, and a shorter window would have put
// "Open here" off-screen with nothing to scroll. None of that is expressible in static markup, so these assert the
// stylesheet and the structure — the same approach `affordance.test.mjs` and `nested-scroll.test.mjs` use.

/** The stylesheet with its comments stripped: a rule's prose must not satisfy an assertion about its declarations. */
let cssText;
async function stylesheet() {
  if (cssText === undefined) {
    const { readFileSync } = await import("node:fs");
    cssText = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  return cssText;
}

/** One rule's declarations, matched on the EXACT selector (an unanchored match reads an override — see nested-scroll). */
async function rule(selector) {
  const css = await stylesheet();
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))];
  return matches.length > 0 ? matches[0][1] : undefined;
}

test("the recents are BOUNDED, so the browser is not squeezed to a few rows", async () => {
  // Measured from the screenshot: four to six recents (one per project a person has used) took the dialog's fixed
  // height, leaving the chooser 4.5 rows — present and unusable at the same time.
  const body = await rule(".recent-list");
  assert.ok(body, ".recent-list must have a rule");
  assert.match(body, /max-height:\s*\d+px/, "it has a ceiling rather than growing with session count");
  assert.match(body, /overflow-y:\s*auto/, "and scrolls, so the older rows are still reachable");
});

test("the dialog cannot grow past the window, because its buttons are at the BOTTOM", async () => {
  // `.modal-backdrop` is `place-items: center` with no scroller, so a taller-than-viewport dialog loses its top AND its
  // bottom — and the bottom is where "Open here" is. The 900px screenshot fitted by luck; 700px would not have.
  const body = await rule(".modal-sheet");
  assert.ok(body, ".modal-sheet must exist — the chooser's dialog is a column");
  assert.match(body, /max-height:/, "an explicit ceiling, in viewport units");
  assert.match(body, /100dvh|100vh/, "tied to the window, not to a pixel guess");
});

test("the chooser is the region that GROWS, and history is what gives way", async () => {
  const chooser = await rule(".modal-sheet .chooser");
  assert.ok(chooser, "the chooser flexes inside the sheet");
  assert.match(chooser, /flex:\s*1/, "it takes the remaining height");
  assert.match(chooser, /min-height:/, "but never collapses to nothing, which would hide the browser entirely");
  const form = await rule(".modal-sheet form");
  assert.match(form ?? "", /flex:\s*none/, "the input and the buttons keep their size");
});

test('the trail\'s root is a LABEL element, not just a muted button', async () => {
  // Two assertions, because either alone is passable by the wrong thing: the CLASS could vanish (styling gone) or the
  // root could go back to being a `<button>` (truthfully clickable, and it does nothing at the root). The screenshot
  // showed the second half as the actual defect — an inert segment that looked exactly like two live ones.
  const html = render({ places: stateWith(), onListPlaces() {} });
  assert.match(html, /<span class="chooser-crumb-root">Places<\/span>/, "at the root it is a span");
  assert.ok(!/<button[^>]*chooser-crumb-link[^>]*>Places<\/button>/.test(html), "never a link that goes nowhere");
});

test('the trail\'s root is muted so it does not read as a control', async () => {
  // The screenshot read `Places / Home / git` with the first segment inert and the other two live — a row where two of
  // three things that look alike do nothing. The root is a span now, and the stylesheet mutes it.
  const rootRule = await rule(".chooser-crumb-root");
  assert.ok(rootRule, ".chooser-crumb-root must exist");
  assert.match(rootRule, /color:\s*var\(--dim\)/, "quiet, so it does not read as a control");
});

test("every new scroll region is styled by this stylesheet, not by the platform", async () => {
  // The bright channel the platform draws on a dark page is a defect this file has already fixed twice (#73, and the
  // transcript). A new scroller inheriting the OS default reintroduces it, which the screenshot showed.
  const css = await stylesheet();
  for (const selector of [".recent-list", ".chooser-entries", ".chooser-places"]) {
    assert.ok(css.includes(`${selector}::-webkit-scrollbar-thumb`), `${selector} needs the inset pill thumb`);
    assert.match((await rule(selector)) ?? "", /scrollbar-color:/, `${selector} needs the Firefox/Chromium form too`);
  }
});

// --- Navigation, after the screenshot review (issue #76) -----------------------------------------
//
// The review's ranked blockers, each answered by a structure that is checkable in rendered markup: a places rail, a
// breadcrumb with clickable segments, an explicit Up, a filter box, folder icons, an age column, a sort control, and a
// primary "use this folder" that is the ONLY control which starts a session.

test("the browser is a places RAIL plus a listing, not two stacked lists", async () => {
  const html = render({ places: stateWith(), onListPlaces() {} });
  assert.match(html, /<nav class="chooser-places"/, "a rail, which is what a file dialog puts on the left");
  assert.match(html, /<div class="chooser-main"/, "and a listing pane beside it");
});

test("a folder row carries an ICON, its name, an AGE and a chevron", async () => {
  // All four were missing, and the review named each: no folder glyph, no date, nothing saying a click descends.
  const state = resumedInto("/Users/x/git", [
    { name: "alpha", path: "/Users/x/git/alpha", mtimeMs: Date.now() - 3 * 86_400_000, isEmpty: false },
  ]);
  const html = renderChooserIn("/Users/x/git", { state });
  assert.match(html, /<svg class="chooser-icon"/, "a folder glyph");
  assert.match(html, />alpha</, "the name");
  assert.match(html, /class="chooser-meta">3d</, "an age, so 'the one I made yesterday' is findable");
  assert.match(html, /chooser-open/, "and a chevron saying the row descends");

  // And the row is a GRID with four columns, so the age and chevron line up down the list. A markup assertion alone
  // passed with the icon column deleted, which is why this reads the stylesheet too.
  const rowRule = await rule(".chooser-row");
  assert.match(rowRule ?? "", /display:\s*grid/, "rows are a grid");
  assert.match(rowRule ?? "", /grid-template-columns:\s*16px/, "with the icon's column first — a ragged right edge is what makes a list unscannable");
});

test("an EMPTY folder says 'empty' instead of a date, so a reader skips the dead end", async () => {
  const state = resumedInto("/Users/x/git", [{ name: "hollow", path: "/Users/x/git/hollow", mtimeMs: 0, isEmpty: true }]);
  const html = renderChooserIn("/Users/x/git", { state });
  assert.match(text(html), /empty/);
  // And NOT a date, which would suggest there is something in there that changed.
  assert.ok(!/chooser-meta">now</.test(html), "never a date for an empty folder");
});

test("the ONLY control that starts a session is the explicit one", async () => {
  // The review's most serious finding: a used-before row launched an irreversible action on one click, with no warning
  // that the directory can never be changed afterwards (ADR-0008). Descending must never do that.
  const html = render({ places: stateWith(), onListPlaces() {} });
  const starts = [...html.matchAll(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g)]
    .filter((match) => /Use /.test(match[0]));
  for (const button of starts) {
    assert.match(button[0], /chooser-use/, "the session-starting control is the named one, not a row");
  }
  // And a row that descends is NOT one of them.
  const rows = html.match(/class="chooser-row"/g) ?? [];
  assert.equal(rows.length, 0, "at rest (Places) there are no rows to descend, so nothing to mis-click");
});

test("a resumed directory is where the picker OPENS, without a request from the reader", async () => {
  // The reporter's requirement: "don't let them start from the default again, pick up the last directory". The resume
  // itself is an effect (SSR cannot run it), so this pins the STATE the effect acts on plus the trail it renders — and
  // `chooser-prefs.test.ts` pins the decision that produces `resumeAt`.
  const state = resumedInto("/Users/x/work/alpha");
  assert.equal(state.resumeAt, "/Users/x/work/alpha", "the state carries the remembered directory");
  const html = renderChooserIn("/Users/x/work/alpha", { state });
  // The trail decomposes into segments (`Home / work / alpha`) rather than showing `~/work/alpha` as one string, so the
  // assertion is on the segments — and on the fact that the picker is INSIDE a folder, which is the requirement.
  assert.match(html, /chooser-crumb-here">alpha</, "the current folder is the trail's last, non-clickable segment");
  assert.match(html, />work</, "with its ancestors beside it, clickable");
  // `text()` normalises React's `<!-- -->` separators; matching the raw markup would fail on a cosmetic insertion.
  assert.match(text(html), /Use “alpha”/, "and the primary action names the folder you are in");
  assert.ok(!/<p class="chooser-crumb" tabindex="-1"><span class="chooser-crumb-root">Places<\/span><\/p>/.test(html), "NOT the bare 'Places' pane");
});

test("the sort, dotfolder and filter controls exist", async () => {
  const html = renderChooserIn("/Users/x/git", { state: resumedInto("/Users/x/git") });
  assert.match(html, /chooser-sort/, "a sort control, which the review listed as missing");
  assert.match(html, /chooser-hidden/, "and a dotfolder toggle");
  assert.match(html, /Filter folders/, "and a filter, the review's #2 blocker: 'the only way in is a full path'");
  assert.match(html, /A–Z/, "the sort control says which order is in force");
});

test("exactly ONE place is marked current, even though $HOME contains every other place", () => {
  // Found by rendering: `~/git` matched both the `git` row and the `Home` row, so a rail of three showed two highlighted
  // entries — "you are in both" — which defeats the point of a rail. The most specific place wins.
  // Nested INSIDE a place is the case that matters: at the place itself there is only one candidate, so an exact-match
  // implementation would pass and the bug would survive. `~/git/alpha` is inside both `Home` and `git`.
  const state = resumedInto("/Users/x/git/alpha");
  const html = renderChooserIn("/Users/x/git/alpha", { state });
  assert.equal((html.match(/chooser-place is-current/g) ?? []).length, 1, "one highlighted row, not two");
  assert.match(html, /chooser-place is-current" title="\/Users\/x\/git"/, "and it is the MOST SPECIFIC place");
});
