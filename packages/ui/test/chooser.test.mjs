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
      recent: props.recent ?? [],
      onChooseRecent() {},
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

test("the rail holds BOTH groups: used-before directories and places", () => {
  // The change that made the dialog fit. Three stacked regions (recents, places, listing) each got a slice of one
  // column, and the loser was always the listing — four visible folders in a 900px dialog. One rail, two groups.
  const html = render({
    places: stateWith(),
    onListPlaces() {},
    recent: [{ cwd: "/Users/x/git/alpha", sessions: 12, lastUsedMs: 1, cwdExists: true }],
  });
  assert.match(html, /<nav class="chooser-places" aria-label="Places and recent directories">/, "one navigation landmark");
  assert.match(text(html), /Used before/, "the first group is named");
  assert.match(text(html), /Places/, "and the second");
  // The order is significant: a destination you have been to comes before a place you browse.
  assert.ok(text(html).indexOf("Used before") < text(html).indexOf("Home"), "recents above places");
  assert.match(html, /title="\/Users\/x\/git"/, "a place's full path is in the tooltip");
  assert.ok(!/git~\//.test(html), "and never the reversed form the old rtl rule produced");
});

test("a recent row is a DESTINATION: it shows a session count and commits", () => {
  // It is not a place to browse — clicking it starts a session there, which is why it carries a count rather than a
  // chevron, and why a reader can tell the two groups apart at a glance and not only by reading the labels.
  const html = render({
    places: stateWith(),
    onListPlaces() {},
    recent: [{ cwd: "/Users/x/git/alpha", sessions: 12, lastUsedMs: 1, cwdExists: true }],
  });
  assert.match(html, /chooser-place-badge/, "a count badge");
  assert.match(text(html), /12/, "the number of sessions that ran there");
  assert.match(html, /chooser-recent/, "marked as its own kind of row");
});

test("a recent directory that is GONE is disabled and says why", () => {
  const html = render({
    places: stateWith(),
    onListPlaces() {},
    recent: [{ cwd: "/mnt/unmounted", sessions: 2, lastUsedMs: 1, cwdExists: false, cwdMissing: "unreadable" }],
  });
  assert.match(html, /chooser-place chooser-recent" disabled/, "unclickable, not hidden");
  assert.match(text(html), /cannot be read/, "with the recoverable reason, not 'missing'");
});

test("a root that is not on this machine is STATED, never hidden", () => {
  // The same rule the recent list follows (#149): hiding it reads as "Pi Central does not know where your code is",
  // when the truth is that this machine has no such folder.
  const html = render({ places: stateWith(), onListPlaces() {} });
  assert.match(text(html), /Not on this machine/);
  assert.match(text(html), /~\/Projects/);
});

test("the dialog is ONE browser plus a path field, not a stack of three regions", () => {
  // The old shape had a recent strip, then the browser, then the input — so the listing was the third thing down and got
  // whatever height was left. The recents now live in the rail, and the ordering assertion below is what pins that.
  const html = render({
    places: stateWith(),
    onListPlaces() {},
    recent: [{ cwd: `${home}/work`, sessions: 1, lastUsedMs: 1, cwdExists: true }],
  });
  const rail = html.indexOf('class="chooser-places"');
  const input = html.indexOf("Or type an absolute path");
  assert.ok(rail >= 0 && input >= 0, "both are present");
  assert.ok(rail < input, "the browser comes before the exact-path field");
  assert.match(html, /Or type an absolute path/, "and the field is labelled as the ALTERNATIVE, not the primary route");
  // There is no separate recents REGION outside the rail any more.
  assert.ok(!/class="recent-dirs"/.test(html), "no second recents block above the browser");
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
  assert.match(html, /Or type an absolute path/, "with the text input it has always had");
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

test("the path that will be OPENED is stated, once, above the button", () => {
  // Two inputs name a directory — the field and the browser — and the reader should not have to work out which wins.
  // The dialog says so: typed text wins, the expansion is shown, and the line sits directly above the one Open button.
  // Before this, Enter in the autofocused field committed the empty field instead of the folder on screen.
  const html = render({ places: stateWith(), onListPlaces() {}, initialPath: "~/git/alpha" });
  assert.match(text(html), /\/Users\/x\/git\/alpha/, "the expanded path is visible");
  assert.match(html, /effective-path/);
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
  // `height` (a fixed measure, so the listing has a predictable size) STILL bounded by the viewport, which is the
  // property that matters: `calc(100dvh - …)` cannot exceed the window whatever the pixel value is.
  assert.match(body, /height:\s*min\(/, "a measured height, capped");
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
  assert.match(html, /class="chooser-meta"[^>]*>3 d</, "an age WITH its unit, so 'the one I made yesterday' is findable");
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
  assert.match(html, /chooser-crumb-here/, "and the folder you are in is named in the trail");
  assert.ok(!/<p class="chooser-crumb" tabindex="-1"><span class="chooser-crumb-root">Places<\/span><\/p>/.test(html), "NOT the bare 'Places' pane");
});

test("sorting is by COLUMN HEADER, so the option is discoverable", async () => {
  // The old control was a `Recent` / `A–Z` chip: it named only the order currently in force, so a reader looking for
  // "sort by name" had no way to learn that name-sorting existed. Column headers name every column, which is how a file
  // manager has always solved this.
  const html = renderChooserIn("/Users/x/git", { state: resumedInto("/Users/x/git") });
  assert.match(html, /class="chooser-head"/, "a header row");
  assert.match(text(html), /Name/, "the name column is labelled — and it is clickable");
  assert.match(text(html), /Modified/, "and the age column, which is why `4m` is no longer cryptic");
  assert.ok(!/A–Z|>Recent</.test(html), "no toggle that hides half the options");
  assert.match(html, /chooser-hidden/, "the dotfolder toggle stays");
  assert.match(html, /Filter folders/, "and the filter");
});

test("the header shows WHICH column is in force, and which way", async () => {
  const byName = renderChooserIn("/Users/x/git", {
    state: resumedInto("/Users/x/git"),
    sort: { column: "name", direction: "ascending" },
  });
  assert.match(byName, /chooser-head-cell chooser-head-name"[^>]*aria-pressed="true"/, "Name is marked active");
  assert.match(byName, /↑/, "ascending is an UP arrow");

  const byModified = renderChooserIn("/Users/x/git", {
    state: resumedInto("/Users/x/git"),
    sort: { column: "modified", direction: "descending" },
  });
  assert.match(byModified, /chooser-head-cell chooser-head-modified"[^>]*aria-pressed="true"/, "Modified marked active");
  assert.match(byModified, /↓/, "newest-first is a DOWN arrow");
});

test("both headers are present, so both sort options are discoverable", async () => {
  // The crop that prompted the direction request showed only NAME. That may have been the crop — the age column sits
  // further right — but the assertion is cheap and the defect (a grid column collapsing) is real and invisible to me
  // without a browser.
  const html = renderChooserIn("/Users/x/git", { state: resumedInto("/Users/x/git") });
  assert.match(html, /chooser-head-name/, "the Name header");
  assert.match(html, /chooser-head-modified/, "AND the Modified header");
  // Both sit in the same grid, and the date column is a SHARED width — otherwise each grid resolves `auto` against its
  // own contents and the headers drift out of line with the data.
  const css = await stylesheet();
  assert.match(css, /--chooser-meta-col:/, "one width for the meta column");
  const head = css.slice(css.indexOf(".chooser-head {"));
  assert.match(head.slice(0, head.indexOf("}")), /var\(--chooser-meta-col\)/, "the header uses it");
  const row = css.slice(css.indexOf(".chooser-row {"));
  assert.match(row.slice(0, row.indexOf("}")), /var\(--chooser-meta-col\)/, "and so does the row");
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

// --- ONE commit target (issue #76, reported from a screenshot) ------------------------------------
//
// Three defects came from having two commit paths — "Use «folder»" for the browser and "Open here" for the form. They
// were reported as one worry ("the manual path field and the selection compete; users get confused") and one layout
// complaint ("the choose button is ill placed; why not bottom-right, like Open"). Both are the same defect.

test("there is exactly ONE primary action, and it is at the END of the dialog", () => {
  // A filled control in the middle of the listing plus a bare one at the bottom meant neither read as the dialog's
  // outcome. Cancel-then-Open, at the bottom right, is what every file dialog does.
  const html = render({ places: stateWith(), onListPlaces() {}, initialPath: "/Users/x/git/alpha" });
  assert.equal((html.match(/btn-primary-sheet/g) ?? []).length, 1, "one primary, not two");
  assert.ok(!/chooser-use/.test(html), "and no second commit button inside the listing");
  const cancel = html.indexOf(">Cancel<");
  const open = html.indexOf("btn-primary-sheet");
  assert.ok(cancel >= 0 && open > cancel, "Cancel first, Open last — the conventional order");
  assert.match(text(html), />\s*Open\s*</, "and it says Open, not 'Open here'");
});

test("the button does NOT say 'here', because 'here' was ambiguous", () => {
  // "Open here" meant "the text field" while reading as "this folder", so a reader who had selected a folder and pressed
  // it was told to enter an absolute path. One word, one meaning now.
  const html = render({ places: stateWith(), onListPlaces() {} });
  assert.ok(!/Open here/.test(html), "no 'here' anywhere in the dialog");
});

test("with nothing typed, the BROWSED folder is what Open commits", () => {
  // The defect: the field is autofocused and inside the form, so Enter committed the empty field rather than the folder
  // on screen. With typed text empty, the browsed selection is the selection — and the dialog says which one it is.
  const state = resumedInto("/Users/x/git");
  const html = renderChooserIn("/Users/x/git", { state });
  assert.match(html, /chooser-crumb-here/, "the folder on screen is named");
  // The sheet holds it as its selection: `effectivePath` is `browsed` when the field is empty, and `problem` is
  // therefore NOT "choose a folder" — asserted through the sheet, which owns the rule.
  const sheet = render({ places: { ...state }, onListPlaces() {} });
  assert.match(sheet, /effective-path/, "the line that states what will be opened is rendered");
  assert.match(text(sheet), /Selected/, "labelled as a SELECTION, not as something to type");
});

test("typed text WINS over the browsed folder, and the dialog says so", () => {
  // The precedence rule, stated rather than inferred. Without it the two inputs really do compete: a reader cannot tell
  // whether their typing or their clicking counts.
  const state = resumedInto("/Users/x/git");
  const html = render({ places: state, onListPlaces() {}, initialPath: "~/git/alpha" });
  const line = html.slice(html.indexOf("effective-path"));
  assert.match(text(line), /Opening/, "typed text is the one being opened");
  assert.match(text(line), /\/Users\/x\/git\/alpha/, "expanded, so the reader sees the real path");
});

test("a Clear control exists, so the typed override can be undone", () => {
  // Without it there is no way back: a reader who typed and changed their mind would have to select and delete the text,
  // and clicking a folder would look broken because it no longer changed what Open would use.
  const html = render({ places: stateWith(), onListPlaces() {}, initialPath: "~/git/alpha" });
  assert.match(html, /path-clear/, "a clear control beside the field");
  const empty = render({ places: stateWith(), onListPlaces() {} });
  assert.ok(!/path-clear/.test(empty), "and nothing to clear when the field is empty");
});

test("Open is DISABLED until there is something to open", () => {
  // A disabled primary is the honest state of "nothing selected": it says the dialog is waiting for a decision rather
  // than offering a button whose only outcome is a refusal.
  const html = render({ places: stateWith(), onListPlaces() {} });
  assert.match(html, /btn-primary-sheet" disabled/, "disabled with no selection and no typed path");
  const withSelection = render({ places: resumedInto("/Users/x/git"), onListPlaces() {} });
  assert.ok(!/btn-primary-sheet" disabled/.test(withSelection), "enabled once a folder is selected");
});

// --- Focus on open (issue #76, reported from a screenshot) ----------------------------------------
//
// "The textfield shall only be active when the user actively clicked into it, not by default when the dialog opens."
// The autofocus was also the mechanism behind the Enter bug: an autofocused field inside a `<form>` means Enter commits
// it. SSR runs no effects, so these assert the SOURCE — there is no other way to see an effect from here, and the
// property is "this call does not exist", which is exactly what a source assertion can prove.

test("the path field does not take focus when the dialog opens", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/components/OpenDirectorySheet.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.ok(!/inputRef\.current\?\.focus\(\)/.test(source.split("const commit")[0]), "no focus call on mount");
  assert.ok(!/autoFocus/.test(source), "and no autoFocus attribute");
});

test("the DIALOG receives focus instead, so Escape works without clicking", async () => {
  // Removing the autofocus must not remove keyboard entry entirely: a reader who opens the sheet must be able to press
  // Escape, and a reader arriving by keyboard must land inside the dialog rather than at the top of the document.
  const html = render({ places: stateWith(), onListPlaces() {} });
  assert.match(html, /class="modal modal-sheet"[^>]*tabindex="-1"/, "the dialog is focusable but not in the Tab order");
});

test("the listing's filter does not steal focus either", async () => {
  // The same mistake in the second place: the filter took the caret at `Places`, saying "type here" about a surface whose
  // job is to be browsed. A filter is reached for when a folder is not on screen.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/components/DirectoryChooser.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.ok(!/filterRef/.test(source), "no ref that focuses the filter");
  assert.match(source, /headingRef\.current\?\.focus\(\)/, "focus goes to the heading, which is where the content changed");
});

test("the path field is labelled as the ALTERNATIVE route", async () => {
  // Placeholder text is the only thing that can say this without spending a sentence on it.
  const html = render({ places: stateWith(), onListPlaces() {} });
  assert.match(html, /placeholder="Or type an absolute path"/, "'Or' — it is the second way in, not the way in");
});

test("the dialog's focus anchor paints no ring", async () => {
  // Comments stripped: the CSS comment above the rule explains why a ring is unwanted, and a rule-scanning assertion
  // satisfied by prose would be the seventh time this repository has been bitten by that.
  // A blue outline around a whole dialog reads as "this element is selected", not "you are here" — and the anchor is only
  // ever focused programmatically, so there is no case where a ring would be wanted.
  const body = await rule(".modal-sheet:focus");
  assert.ok(body, "the rule must exist");
  assert.match(body, /outline:\s*none/, "no ring on the anchor");
});
