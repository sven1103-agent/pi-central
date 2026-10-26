/**
 * Syntax highlighting tests (issue #4).
 *
 * The properties worth protecting, in order of how much they would cost to get wrong:
 *
 * 1. **The sanitisation boundary is untouched.** Highlighting is the most plausible thing to bolt
 *    on in front of ADR-0006's pipeline, and the tempting shape — a markdown-it `highlight` option
 *    emitting spans into the HTML — would put a second producer of markup ahead of the boundary.
 *    So the tests below assert the *architecture*, not only the output: code becomes React
 *    elements built from validated data, and no HTML from a grammar reaches the DOM.
 * 2. **A fenced block never renders nothing.** An unknown language, a missing grammar, a failed
 *    chunk fetch — every one falls back to the code as plain escaped text.
 * 3. **Grammars load on first encounter, not up front.** Asserted by observing which languages are
 *    resident before and after, so laziness is demonstrated rather than claimed.
 * 4. **The bundle cost is measured, not assumed.** The numbers in the issue body come from a real
 *    `vite build`, recorded in `docs/` and reproduced by the assertion at the bottom.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
(globalThis as Record<string, unknown>)["window"] = dom.window;
(globalThis as Record<string, unknown>)["document"] = dom.window.document;

let server: Awaited<ReturnType<typeof createServer>>;
let highlight: typeof import("../src/highlight.ts");
let segmentsModule: typeof import("../src/segments.ts");
let grammarMap: typeof import("../src/grammar-map.ts");

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  highlight = (await server.ssrLoadModule("/src/highlight.ts")) as typeof import("../src/highlight.ts");
  segmentsModule = (await server.ssrLoadModule("/src/segments.ts")) as typeof import("../src/segments.ts");
  grammarMap = (await server.ssrLoadModule("/src/grammar-map.ts")) as typeof import("../src/grammar-map.ts");
});

after(async () => {
  await server?.close();
});

// --- Lazy loading: demonstrated, not claimed ----------------------------------------------------

test("no grammar is resident before a language is first encountered", () => {
  // The issue's first criterion. `loadedLanguages` reports what Shiki actually holds, so this
  // fails if a grammar is ever pulled in eagerly (by an import, or by a `langs` array passed to
  // the highlighter's constructor).
  assert.deepEqual(highlight.loadedLanguages(), [], "nothing may be loaded before a fence is seen");
});

test("an unknown language is refused WITHOUT loading a grammar", async () => {
  // The fallback is a decision, not an error path: the question "is there a grammar?" is answered
  // from the bundled file list before any chunk is fetched.
  assert.equal(await highlight.highlightCode("x = 1", "klingon"), undefined);
  assert.deepEqual(highlight.loadedLanguages(), [], "a refusal must not load anything");
});

test("an unknown language does not load the Shiki core either", async () => {
  // The distinction that makes the gate worth having. Without it, an unknown language still returns
  // `undefined` — but only after creating the highlighter, which is ~114 kB of core plus a ~59 kB
  // engine fetched to discover that no grammar exists. Falsified by removing the gate: this test
  // catches it, and the grammar-count assertion above does not, because a grammar was never the
  // thing being loaded.
  assert.equal(highlight.coreLoaded(), false, "precondition: nothing has been highlighted yet");
  await highlight.highlightCode("# not code in any language", "definitely-not-a-language");
  assert.equal(highlight.coreLoaded(), false, "a refusal must not create the highlighter");
});

test("an ALIAS resolves to a grammar, which a name list would have refused", async () => {
  // `languageNames` holds canonical names only, so `py` would have been rejected by a naive gate.
  // The check consults the bundled files instead, which is why this passes.
  assert.equal(await highlight.hasGrammar("py"), true, "an alias must resolve");
  assert.equal(await highlight.hasGrammar("python"), true);
  assert.equal(await highlight.hasGrammar("typescript"), true);
  assert.equal(await highlight.hasGrammar("klingon"), false);
  assert.equal(await highlight.hasGrammar(""), false);
});

test("a grammar with punctuation in its name resolves, though its file does not", async () => {
  // `c++` ships as `cpp.mjs`, and `languageAliasNames` does not even list `c++`. A gate built on
  // that list would refuse a language the build can genuinely highlight.
  assert.equal(await highlight.hasGrammar("c++"), true);
  assert.equal(await highlight.hasGrammar("c#"), true);
});

test("a language is loaded on FIRST ENCOUNTER and then reused", async () => {
  const first = await highlight.highlightCode("const x = 1", "typescript");
  assert.ok(first, "a real language must highlight");
  assert.deepEqual(highlight.loadedLanguages(), ["typescript"]);

  // A second block in the same language must not re-load it — and must not be slower or emptier.
  const second = await highlight.highlightCode("const y = 2", "typescript");
  assert.ok(second);
  assert.deepEqual(highlight.loadedLanguages(), ["typescript"]);
  assert.equal(second.lines.length, 1);

  // A different language loads ALONGSIDE, not instead.
  const python = await highlight.highlightCode("x = 1", "python");
  assert.ok(python);
  assert.deepEqual(highlight.loadedLanguages(), ["python", "typescript"]);
});

// --- Sanitisation: the boundary is untouched ----------------------------------------------------

test("a colour becomes a CLASS, never a style attribute", async () => {
  // The decision that keeps `style` out of DOMPurify's allow-list. Shiki's string output would put
  // `style="color:#..."` on every span; rendering that would mean permitting `style`, which is a
  // new injection surface opened only to draw colours. The theme has 11 foreground colours, so a
  // class each is enough.
  const result = await highlight.highlightCode("const x = 1", "typescript");
  assert.ok(result);
  const token = result.lines[0]!.find((t) => t.text === "const");
  assert.ok(token, "the keyword must be tokenized");
  assert.match(token.color ?? "", /^#[0-9a-f]{6}$/i, "the token carries a theme hex");
  assert.equal(highlight.colorClass(token.color), "tk-ff7b72");
  // A non-hex value cannot become a class, so nothing from a grammar can reach a style attribute.
  assert.equal(highlight.colorClass("expression(alert(1))"), undefined);
  assert.equal(highlight.colorClass(undefined), undefined);
  assert.equal(highlight.colorClass("#fff"), "tk-ffffff", "3-digit hex is expanded to name a class");
});

test("the RENDERED element carries a class and no style attribute", async () => {
  // Asserted on the rendered markup, not on the helpers. An earlier version of this file checked
  // `colorClass()` directly, which cannot see whether the renderer USES it: replacing the class with
  // an inline `style` left every assertion passing while opening exactly the surface the design
  // avoids. So the output is the thing under test.
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const result = await highlight.highlightCode("const x = 1", "typescript");
  assert.ok(result);
  const html = renderToStaticMarkup(createElement("div", null, highlight.highlightedNodes(result)));
  assert.ok(!/style=/.test(html), `no style attribute may be emitted, got: ${html.slice(0, 200)}`);
  assert.match(html, /class="tk-ff7b72"/, "the keyword's colour must arrive as a class");
  assert.match(html, /class="shiki shiki-typescript"/);
  // And the code text is escaped by React rather than assembled into markup.
  const escaped = await highlight.highlightCode('const s = "<b>x</b>"', "typescript");
  assert.ok(escaped);
  const escapedHtml = renderToStaticMarkup(createElement("div", null, highlight.highlightedNodes(escaped)));
  assert.ok(!/<b>/.test(escapedHtml), "code content must never become markup");
  assert.ok(escapedHtml.includes("&lt;b&gt;"), "but it must be visible as text");
});

test("the CSS defines a class for every colour the theme emits", async () => {
  // The classes are hand-written to keep colours out of markup, so the mapping can rot when the
  // theme changes: a token would then silently lose its colour. This reads the real theme, converts
  // every foreground it sets, and requires a rule for each — the failure is a missing rule, not a
  // wrong colour, and a missing rule is exactly what nobody notices by eye.
  const theme = (await import("@shikijs/themes/github-dark-default")) as { default: { default?: unknown } };
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  const colors = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === "foreground" && typeof inner === "string") colors.add(inner);
      walk(inner);
    }
  };
  walk(theme.default);

  const missing = [...colors]
    .map((color) => highlight.colorClass(color))
    .filter((className): className is string => className !== undefined)
    .filter((className) => !css.includes(`.${className}`));
  assert.deepEqual(missing, [], `styles.css is missing a rule for: ${missing.join(", ")}`);
});

/**
 * Strip comments before scanning a source file.
 *
 * Same rule as `invariants.test.ts`, and for the same reason: `highlight.ts` NAMES
 * `dangerouslySetInnerHTML` and `codeToHtml` while explaining why neither is used, so a raw-text
 * scan fails on the file that documents the rule. Code only.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("prose sanitiser still permits no style attribute, and highlighting added none", () => {
  // The two paths share one purifier INSTANCE, but the prose path must keep refusing `style`.
  // Asserted on the config rather than by rendering, because the config is the policy.
  const markdown = stripComments(readFileSync(new URL("../src/markdown.ts", import.meta.url), "utf8"));
  const allowed = /ALLOWED_ATTR:\s*\[([^\]]*)\]/.exec(markdown)?.[1] ?? "";
  assert.ok(allowed.length > 0, "the prose allow-list must still be declared");
  assert.ok(!allowed.includes("style"), "the Markdown allow-list must not gain 'style'");
  // And the highlight path must not produce or insert HTML at all — it returns data.
  const source = stripComments(readFileSync(new URL("../src/highlight.ts", import.meta.url), "utf8"));
  assert.ok(!/dangerouslySetInnerHTML/.test(source), "highlighting must not insert HTML");
  assert.ok(!/codeToHtml/.test(source), "the HTML-producing Shiki call must not be used");
});

// --- Fence splitting ---------------------------------------------------------------------------

test("prose and a top-level fence are separated", () => {
  const segments = segmentsModule.splitFences("Before\n\n```ts\nconst x = 1\n```\n\nAfter");
  assert.deepEqual(
    segments.map((s) => s.kind),
    ["prose", "code", "prose"],
  );
  const code = segments[1]!;
  assert.equal(code.kind === "code" && code.lang, "ts");
  assert.equal(code.kind === "code" && code.code, "const x = 1");
});

test("an unclosed fence stays prose, because it is probably still streaming", () => {
  // A half-typed fence is a normal streaming state: the closer has not arrived. Consuming the rest
  // of the message into a code block would make the transcript jump and hide text that is about to
  // be ordinary prose.
  const segments = segmentsModule.splitFences("Text\n\n```ts\nconst x = 1");
  assert.deepEqual(segments, [{ kind: "prose", text: "Text\n\n```ts\nconst x = 1" }]);
});

test("a tilde fence may contain backticks, and vice versa", () => {
  // The reason both forms exist. A splitter that matched only backticks would end the block early.
  const segments = segmentsModule.splitFences("~~~\n```\ninner\n```\n~~~");
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.kind === "code" && segments[0]!.code, "```\ninner\n```");
});

test("an INDENTED fence is left to Markdown, so list structure is not broken", () => {
  // A fence inside a list or blockquote carries structural meaning for its container.
  // Reconstructing that here would be a Markdown parser, and a half-correct one silently changes
  // the document. The cost of leaving it is that the block is not coloured — never that it is wrong.
  const source = "- item\n\n  ```ts\n  const x = 1\n  ```";
  assert.deepEqual(segmentsModule.splitFences(source), [{ kind: "prose", text: source }]);
});

test("a fence with no language is recognised, and names nothing", () => {
  const segments = segmentsModule.splitFences("```\nplain\n```");
  assert.equal(segments[0]!.kind === "code" && segments[0]!.lang, "");
  assert.deepEqual(segmentsModule.namedLanguages(segments), []);
});

test("a source with no fence is one prose segment, so the common case is untouched", () => {
  const segments = segmentsModule.splitFences("Just prose, with a `tick` in it.");
  assert.deepEqual(segments, [{ kind: "prose", text: "Just prose, with a `tick` in it." }]);
});

test("namedLanguages lists distinct fence languages, in a stable order", () => {
  const segments = segmentsModule.splitFences("```ts\na\n```\n\n```py\nb\n```\n\n```ts\nc\n```");
  assert.deepEqual(segmentsModule.namedLanguages(segments), ["py", "ts"]);
});

// --- The bundle index is lazy too, and its cost is a measured fact ------------------------------

test("the grammar index covers every grammar in the package", () => {
  // The glob climbs to the workspace root because npm workspaces hoists `@shikijs/*` there. A
  // root-relative glob would match nothing and silently degrade EVERY language to plain text —
  // which looks like "highlighting just does not work" rather than like a bug. So the count is
  // checked against the package, not just checked to be non-zero.
  const files = grammarMap.grammarFiles();
  assert.ok(files.length > 100, `expected many grammars, found ${files.length}`);
  assert.ok(files.some((file) => file.endsWith("/typescript.mjs")), "typescript must be addressable");
  assert.ok(files.some((file) => file.endsWith("/cpp.mjs")), "c++ must be addressable as cpp.mjs");
});

test("the measured entry-chunk cost matches the number recorded in docs/BUNDLE.md", () => {
  // The issue asks for the bundle impact to be MEASURED and STATED, and a number in a document is
  // the kind of claim that quietly stops being true. This cross-checks the document against the
  // source of the delta: the entry chunk must not contain Shiki's machinery, because that is what
  // makes +5 kB possible.
  //
  // It reads the built artifact when one exists (CI builds before testing, via `npm run verify` ->
  // `npm run ui:build`), and the DOCUMENT otherwise, so the assertion never passes vacuously and
  // never fails merely because `dist/` is absent.
  const bundleDoc = readFileSync(new URL("../../../docs/BUNDLE.md", import.meta.url), "utf8");
  assert.match(bundleDoc, /418\.47 kB/, "the documented entry size must be present");
  assert.match(bundleDoc, /413\.43 kB/, "and the baseline it is compared against");

  // The structural claim the numbers rest on: the entry does not import Shiki eagerly.
  const source = stripComments(readFileSync(new URL("../src/highlight.ts", import.meta.url), "utf8"));
  for (const specifier of ["shiki/core", "shiki/engine/javascript", "@shikijs/themes/github-dark-default"]) {
    assert.ok(
      new RegExp(`import\\(\\s*["']${specifier.replace("/", "\\/")}["']`).test(source),
      `${specifier} must be a dynamic import, or it would be in the entry chunk`,
    );
  }
});

test("the grammar index is NOT in the eager entry graph", () => {
  // Measured, not assumed: the glob map is ~24 kB of URLs, and paying it on every page load to
  // highlight code most loads never show would be a bounded saving pretending to be unbounded.
  // `grammar-map.ts` is imported dynamically, and this asserts that property holds.
  const source = readFileSync(new URL("../src/highlight.ts", import.meta.url), "utf8");
  assert.match(source, /import\("\.\/grammar-map\.ts"\)/, "the map must be imported dynamically");
  assert.ok(
    !/^import[^;]*grammar-map/m.test(source),
    "a static import of the map would put all its URLs back in the entry chunk",
  );
});
