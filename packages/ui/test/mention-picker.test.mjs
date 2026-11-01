/**
 * The picker's rendered markup and the Escape ladder it joins.
 *
 * The matching and replacement rules live in `mentions.test.ts`; this checks the two things only a render can show: that
 * the listbox is wired for a keyboard, and that Escape closes the picker BEFORE it considers stopping a run.
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

let server, MentionPicker, escalation;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ MentionPicker } = await server.ssrLoadModule("/src/components/MentionPicker.tsx"));
  ({ escalation } = await server.ssrLoadModule("/src/queue.ts"));
});

after(async () => {
  await server?.close();
});

const options = [
  { value: "img_1.png", label: "img_1.png", continues: false },
  { value: "shots", label: "shots/", continues: true },
  { value: "img_2.png", label: "img_2.png", continues: false },
];

/**
 * Render the picker, with SSR's comment markers removed.
 *
 * React separates adjacent expressions with `<!-- -->` — `in <span>{dir}</span>` becomes `in <!-- -->docs` — so a regex
 * written against the source text matches nothing. Stripping them once here keeps every assertion about the MARKUP rather
 * than about React's serialisation.
 */
function render(overrides = {}) {
  return renderToString(
    createElement(MentionPicker, {
      directory: "docs",
      completions: options,
      loading: false,
      selected: 0,
      onChoose: () => {},
      ...overrides,
    }),
  ).replace(/<!-- -->/g, "");
}

test("the list is a listbox with one option marked current", () => {
  /*
   * A real menu would move focus out of the field and take the caret with it. `role="listbox"` with `aria-activedescendant`
   * on the input is the shape that says "focus stays in the input, one option is current".
   */
  const html = render({ selected: 1 });
  assert.match(html, /role="listbox"/);
  assert.match(html, /aria-label="Files to mention"/, "the list names itself");
  assert.equal([...html.matchAll(/role="option"/g)].length, 3);
  assert.match(html, /aria-selected="true"[^>]*class="mention-option is-selected/, "the current one is marked twice");
  // Exactly one selected, or the highlight is meaningless.
  assert.equal([...html.matchAll(/aria-selected="true"/g)].length, 1);
});

test("a directory is distinguishable from a file by its name AND its class", () => {
  // Colour alone is not a state a reader can see: the slash carries it, and the class is what a test can check.
  const html = render();
  assert.match(html, /class="mention-name mono">shots\/</, "the trailing slash says continue into me");
  assert.match(html, /mention-option is-dir/, "and the row is marked as a directory");
});

test("the selected row is marked by a LEFT RULE as well as a tint, so forced-colors cannot hide it", () => {
  const css = readFileSyncCss();
  const selected = /\.mention-option\.is-selected\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(selected, /background:/, "a tint");
  assert.match(selected, /border-left-color:/, "…and a rule, which survives a palette that drops the tint");
});

test("an unloaded directory says Reading…, and an empty one says No match", () => {
  /*
   * Different facts. Collapsing them tells the reader to give up on a listing that is still coming — the same distinction
   * `files.ts` protects for the directory tree.
   */
  const loading = render({ completions: [], loading: true });
  assert.match(loading, /Reading…/);
  assert.ok(!/No match/.test(loading));

  const empty = render({ completions: [], loading: false });
  assert.match(empty, /No match/);
  assert.ok(!/Reading…/.test(empty));
});

test("the header names the directory being completed, and only the keys worth stating", () => {
  /*
   * Trimmed after a review called the first header overloaded: it carried a bare `.` (which reads as a rendering fault)
   * and four hints at ~10px grey-on-dark, competing with the results they describe. What survives is the directory,
   * labelled; the match count; and the two keys that are not guessable.
   */
  const html = render();
  assert.match(html, /mention-dir mono">in docs</, "the directory, LABELLED, so the reader knows where options come from");
  assert.match(html, /Tab/, "the accept key is stated");
  assert.match(html, /Esc/, "…and the dismiss key");
  assert.ok(!/Tab<\/kbd> or <kbd>Enter/.test(html), "but 'Tab or Enter' was two words for one affordance");
});

test("the header states how many matched, which the first version left out", () => {
  // The fact a reader of a filtered list wants, and the middle of the row had room for it.
  assert.match(render(), /mention-count">3 matches</);
  assert.match(render({ completions: options.slice(0, 1) }), /1 match</, "singular");
  assert.ok(!/mention-count/.test(render({ completions: [] })), "and nothing when nothing matched");
});

test("the session root is LABELLED as '.', not shown as a bare period", () => {
  // A lone `.` in a header reads as a rendering bug rather than as "the session root".
  assert.match(render({ directory: "" }), /mention-dir mono">in \.</);
});

test("Escape closes the PICKER before it considers stopping a run", () => {
  /*
   * The ladder in `queue.ts`, extended rather than re-implemented — a ladder written in two places drifts, and the drift is
   * invisible until someone presses Escape twice in the wrong order. Closing a picker must never abort a run.
   */
  assert.equal(escalation({ sheetOpen: false, pickerOpen: true, streaming: true }), "close-picker");
  assert.equal(escalation({ sheetOpen: false, pickerOpen: true, streaming: false }), "close-picker");
  // And with the picker closed, the older steps are unchanged.
  assert.equal(escalation({ sheetOpen: true, pickerOpen: false, streaming: true }), "close-sheet");
  assert.equal(escalation({ sheetOpen: false, pickerOpen: false, streaming: true }), "clear-and-stop");
  assert.equal(escalation({ sheetOpen: false, pickerOpen: false, streaming: false }), "noop");
});

function readFileSyncCss() {
  return readFileSyncUrl(new URL("../src/styles.css", import.meta.url))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ");
}

function readFileSyncUrl(url) {
  // Local helper so this file needs no second import line for one call.
  return globalThis.process.getBuiltinModule("node:fs").readFileSync(url, "utf8");
}
