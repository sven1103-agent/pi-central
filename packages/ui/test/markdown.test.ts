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

const { looksLikeMarkdown, renderMarkdown, renderPlain, isNavigable } = await import("../src/markdown.ts");

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
