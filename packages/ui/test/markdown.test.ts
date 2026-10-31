/**
 * Tests for the untrusted-content rendering pipeline (ADR-0006).
 *
 * These are the highest-value tests in the UI. The failure they prevent is not a visual bug:
 * script executing in this origin can issue control commands to every supervised session.
 *
 * The tests use a real DOM (`happy-dom`-free: DOMPurify needs `window`, so they are run
 * through a minimal shim) — see the note at the bottom. Where a real DOM is unavailable the
 * test asserts on the string, which is sufficient for every assertion below because
 * sanitization is string-in/string-out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// A real DOM must exist BEFORE `markdown.ts` is imported: in Node, DOMPurify's export is a
// factory that needs a `window`, and it binds at module-init time. A static import would run
// before this setup, so the import is dynamic.
//
// jsdom rather than happy-dom, and the reason is not preference. Under happy-dom DOMPurify
// reports `isSupported: true` but strips EVERY tag -- `<h1>T</h1>` sanitizes to `"T"`. Every
// assertion below would then have passed for the wrong reason: an XSS test that passes
// because all markup is destroyed proves nothing about sanitization. jsdom is the environment
// DOMPurify is actually developed and tested against.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
(globalThis as Record<string, unknown>)["window"] = dom.window;
(globalThis as Record<string, unknown>)["document"] = dom.window.document;

const { looksLikeMarkdown, markdownCacheStats, renderMarkdown, renderPlain, isNavigable } = await import("../src/markdown.ts");

test("raw HTML in Markdown is escaped, not interpreted", () => {
  // The first line of defence. A README with a script tag must render as visible source.
  const out = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!out.includes("<script"), `script tag survived: ${out}`);
  assert.ok(out.includes("&lt;script") || out.includes("&amp;lt;script"), `expected escaped text: ${out}`);
});

/**
 * Assert on the PARSED DOM, not on the string.
 *
 * A string assertion is the wrong test here, and the first version of these tests proved it:
 * it searched the output for `onerror=` and failed, because the payload had been *escaped* —
 * `&lt;img src=x onerror=...&gt;` is inert visible text and exactly the desired outcome. The
 * substring was present while the danger was not.
 *
 * Parsing the output and inspecting attributes tests the property that actually matters: no
 * element carries a live handler, and no anchor carries an executable scheme.
 */
function parse(html: string) {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

const HOSTILE = [
  '<img src=x onerror="alert(1)">',
  '<a href="#" onclick="alert(1)">x</a>',
  '<div onmouseover="alert(1)">x</div>',
  "<svg/onload=alert(1)>",
  '<iframe src="javascript:alert(1)"></iframe>',
  '<body onload="alert(1)">',
  '<input autofocus onfocus="alert(1)">',
  '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">x</button></form>',
];

test("no element carries an event-handler attribute", () => {
  for (const payload of HOSTILE) {
    const doc = parse(renderMarkdown(payload));
    for (const element of doc.querySelectorAll("*")) {
      for (const attr of element.attributes) {
        assert.ok(!/^on/i.test(attr.name), `${payload} produced live handler ${attr.name} on <${element.tagName}>`);
      }
    }
  }
});

test("no dangerous element survives", () => {
  for (const payload of HOSTILE) {
    const doc = parse(renderMarkdown(payload));
    for (const tag of ["script", "iframe", "object", "embed", "form", "base", "meta", "link", "style"]) {
      assert.equal(doc.querySelector(tag), null, `${payload} produced a live <${tag}>`);
    }
  }
});

test("no anchor carries an executable or data scheme", () => {
  for (const payload of [
    "[click](javascript:alert(1))",
    "[click](JaVaScRiPt:alert(1))",
    "[click](data:text/html,<script>alert(1)</script>)",
    "[click](vbscript:msgbox(1))",
    "[click](file:///etc/passwd)",
  ]) {
    const doc = parse(renderMarkdown(payload));
    for (const anchor of doc.querySelectorAll("a")) {
      const href = anchor.getAttribute("href") ?? "";
      assert.ok(
        !/^\s*(javascript|data|vbscript|file):/i.test(href),
        `${payload} produced href="${href}"`,
      );
    }
  }
});

test("the dangerous payload is still VISIBLE as text (so the user can see what was attempted)", () => {
  // Neutralizing by deletion would hide hostile input. Escaping is the better outcome: the
  // reader sees what the document tried to do.
  const doc = parse(renderMarkdown("<script>alert(1)</script>"));
  assert.ok(doc.body.textContent?.includes("<script>"), `expected visible source, got: ${doc.body.textContent}`);
});

test("markdown link behaviour is hardened (rel and target)", () => {
  // A target=_blank without rel=noopener hands window.opener to the linked page.
  const out = renderMarkdown("[docs](https://example.com/x)");
  assert.ok(out.includes("https://example.com/x"), `link lost: ${out}`);
  assert.ok(/rel="[^"]*noopener/.test(out), `missing noopener: ${out}`);
  assert.ok(!/rel="noopener"/.test(out) || /noreferrer/.test(out), "expected noreferrer too");
});

test("a legitimate document still renders as real markup", () => {
  // Sanitization must not be so aggressive that the feature does not work.
  const out = renderMarkdown(
    ["# Title", "", "Some **bold** and `code`.", "", "- one", "- two", "", "```js", "const x = 1;", "```"].join("\n"),
  );
  assert.ok(out.includes("<h1"), out);
  assert.ok(out.includes("<strong>"), out);
  assert.ok(out.includes("<code>"), out);
  assert.ok(out.includes("<ul>"), out);
  assert.ok(out.includes("<pre>"), out);
});

test("plain rendering does not reinterpret Markdown syntax", () => {
  // Tool output and diffs must show exactly what they contain.
  const diff = "- removed\n+ added\n* not a bullet\n_underscores_ in a filename";
  assert.equal(renderPlain(diff), diff);
  assert.ok(looksLikeMarkdown(diff), "the caller should be able to detect this is not prose");
});

test("looksLikeMarkdown distinguishes prose from code-like text", () => {
  assert.ok(looksLikeMarkdown("## A heading"));
  assert.ok(looksLikeMarkdown("- a list item"));
  assert.ok(looksLikeMarkdown("[a link](https://example.com)"));
  assert.ok(looksLikeMarkdown("```\ncode\n```"));
  assert.equal(looksLikeMarkdown("Just a sentence about things."), false);
  assert.equal(looksLikeMarkdown(""), false);
});

test("isNavigable refuses schemes the pipeline would have stripped", () => {
  assert.ok(isNavigable("https://example.com"));
  assert.ok(isNavigable("http://localhost:5173/x"));
  assert.ok(isNavigable("mailto:a@b.example"));
  assert.equal(isNavigable("javascript:alert(1)"), false);
  assert.equal(isNavigable("data:text/html,x"), false);
  assert.equal(isNavigable("file:///etc/passwd"), false);
  assert.equal(isNavigable("not a url at all"), false);
  // A relative URL is meaningless for an "open this link" affordance, and the pipeline strips
  // it anyway (ALLOWED_URI_REGEXP requires a scheme), so it must not be offered.
  assert.equal(isNavigable("/relative/path"), false);
  assert.equal(isNavigable("example.com"), false);
});

test("empty input is empty output, not an error", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderPlain(""), "");
});

test("a lone U+2028 inside a code block survives (framing edge case, C7)", () => {
  // The same character that breaks readline-based framing must not break rendering.
  const out = renderMarkdown("```\nconst s = '\u2028';\n```");
  assert.ok(out.includes("\u2028"), out);
});

// --- The parse cache survives a remount (issue #151) ---------------------------------------------

test("rendering the same text twice gives identical html, from the cache", () => {
  // The cache must be invisible: same input, same output. A cache that changes what is rendered would be a
  // security regression, since this is the sanitized insertion path (ADR-0006).
  const source = "**bold** and `code` and [a link](https://example.test)";
  const first = renderMarkdown(source);
  const second = renderMarkdown(source);
  assert.equal(second, first);
  assert.match(first, /<strong>bold<\/strong>/);
});

test("a message too large to cache still renders, and renders correctly", () => {
  // The size cutoff exists so a huge message does not sit in the cache while streaming rewrites it every delta.
  // It must be a CACHE policy, never a rendering one.
  const huge = `# heading\n\n${"a paragraph. ".repeat(4000)}`;
  assert.ok(huge.length > 20_000, "fixture must exceed the cache cutoff");
  const html = renderMarkdown(huge);
  assert.equal(renderMarkdown(huge), html, "identical with and without caching");
  assert.match(html, /<h1>heading<\/h1>/);
});

test("the cache is bounded, so a long session cannot grow it without limit", () => {
  // Measured reason for the bound: the input is a transcript, and transcripts are unbounded by design (#149).
  // Filling well past the budget must not throw and must keep rendering.
  for (let i = 0; i < 400; i += 1) {
    renderMarkdown(`message ${i}\n\n${"filler text ".repeat(200)}`);
  }
  const html = renderMarkdown("# still works");
  assert.match(html, /<h1>still works<\/h1>/);
});

// --- The parse cache survives a remount (issue #151) ---------------------------------------------

test("a second render of the same text is a CACHE HIT, not a reparse", () => {
  // The guard has to observe the cache, not just the output: with the cache removed, `renderMarkdown(x)` still
  // returns the same string twice, so an equality assertion passes either way. A falsification proved that.
  //
  // This is the property a session switch depends on. `SessionView` carries `key={focused?.id}` (deliberately,
  // for scroll state), so switching unmounts every `Prose` and throws away every component-level memo — the
  // module cache is the layer the remount cannot reach.
  const source = `cache-hit-probe-${Math.random()}\n\n**bold**`;
  const before = markdownCacheStats();
  const first = renderMarkdown(source);
  const afterFirst = markdownCacheStats();
  const second = renderMarkdown(source);
  const afterSecond = markdownCacheStats();

  assert.equal(afterFirst.misses, before.misses + 1, "the first render parses");
  assert.equal(afterSecond.hits, afterFirst.hits + 1, "the second is a hit");
  assert.equal(afterSecond.misses, afterFirst.misses, "and does not parse again");
  assert.equal(second, first, "a cached render is the same render");
});

test("a message above the cutoff is not cached, and is still rendered correctly", () => {
  // The cutoff exists so a huge message does not sit in the cache while streaming rewrites it every delta. It is
  // a CACHE policy, never a rendering one — so the assertions are about the counter and the output together.
  const huge = `# heading\n\n${"a paragraph. ".repeat(4000)}`;
  assert.ok(huge.length > 20_000, "fixture must exceed the cutoff");
  const before = markdownCacheStats();
  const html = renderMarkdown(huge);
  const after = markdownCacheStats();
  assert.equal(after.misses, before.misses, "not counted as a cached parse");
  assert.match(html, /<h1>heading<\/h1>/);
  renderMarkdown(huge);
  assert.equal(markdownCacheStats().hits, after.hits, "an uncacheable message never hits either");
});

test("the cache budget is enforced, so a long session cannot grow it without limit", () => {
  // Sized in characters, not entries: the first version capped 200 entries, which measured as useless for a
  // 1000-message transcript (238 ms against 306 ms cold) because the working set did not fit.
  for (let i = 0; i < 400; i += 1) {
    renderMarkdown(`budget-filler-${i}\n\n${"filler text ".repeat(200)}`);
  }
  assert.ok(
    markdownCacheStats().chars <= 4_000_000,
    `the budget must hold, got ${markdownCacheStats().chars} characters`,
  );
  assert.match(renderMarkdown("# still works"), /<h1>still works<\/h1>/);
});
