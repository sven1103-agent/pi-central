/**
 * The CSP must permit every scheme the UI actually loads (issue #111).
 *
 * ## The bug this exists to stop
 *
 * The file viewer builds its images from a `Blob` and shows them via a **blob URL**. A blob URL has an
 * **opaque origin**, so `img-src 'self'` does not match it — the browser blocked every image, the
 * `<img>` fired `error`, and the viewer reported *"could not decode this image"* about a file that was
 * a perfectly valid PNG.
 *
 * Alongside it, a comment asserted that *"a blob URL counts as `'self'`"*. It does not. That claim is
 * the same failure shape as the `latest` dist-tag guarantee (#66): a statement of fact in a comment is
 * what stops anyone checking, so a false one is worse than none.
 *
 * ## Why this reads both files
 *
 * A scheme can be added to the policy and then a component can start using another scheme, and nothing
 * connects the two. So the check is: **every non-http scheme appearing in a UI source file must be
 * allowed by `img-src`** — which is the direction that catches the omission rather than the one that
 * merely restates the config.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const uiRoot = new URL("../src/", import.meta.url);
const sources = readdirSync(uiRoot, { recursive: true })
  .filter((name) => typeof name === "string" && (name.endsWith(".ts") || name.endsWith(".tsx")))
  .map((name) => ({ name, text: stripComments(readFileSync(new URL(name, uiRoot), "utf8")) }));

function imgSrcOf(html) {
  const match = /img-src([^;]*)/.exec(html);
  assert.ok(match, "every policy must declare `img-src`: without it, `default-src 'none'` blocks images");
  return match[1];
}

const headerCsp = stripComments(
  readFileSync(new URL("../../orchestrator/src/static-ui.ts", import.meta.url), "utf8"),
);
// An HTML comment is a comment; `index.html` has one exactly where the policy is documented.
const metaCsp = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/<!--[\s\S]*?-->/g, "");

test("both policies permit `blob:`, which is how the file viewer shows an image", () => {
  // `'self'` covers same-origin URLs; a blob URL's origin is opaque, so it needs its own scheme. This
  // is the assertion that would have failed the moment the viewer was written.
  for (const [where, text] of [["header", headerCsp], ["meta", metaCsp]]) {
    assert.match(imgSrcOf(text), /blob:/, `${where} CSP must allow blob: for the file viewer's images`);
  }
});

test("no UI source loads an image scheme the policy does not allow", () => {
  // The general direction: find the schemes the components actually use, and require the policy to
  // cover them. A future format served from a new scheme (`filesystem:`?) fails here rather than in a
  // user's browser.
  const used = new Set();
  for (const { text } of sources) {
    // Literal schemes, plus the APIs that PRODUCE one — `URL.createObjectURL` yields a `blob:` URL and
    // appears as no literal at all, which is why the first version of this scan found nothing.
    for (const [, scheme] of text.matchAll(/["'`](blob|data|filesystem|mediastream):/g)) used.add(scheme);
    if (/URL\.createObjectURL/.test(text)) used.add("blob");
    if (/toDataURL|["'`]data:/.test(text)) used.add("data");
  }
  assert.ok(used.size > 0, "the scan must find at least one scheme, or it is not checking anything");
  assert.ok(used.has("blob"), "the file viewer's blob URLs must be among what this checks");

  const allowed = imgSrcOf(headerCsp);
  for (const scheme of used) {
    assert.match(allowed, new RegExp(`\\b${scheme}:`), `UI code uses ${scheme}: but img-src does not allow it`);
  }
});

test("`object-src` stays absent while `default-src` is 'none'", () => {
  // A blob URL in an <object> or <embed> would be a much larger hole than one in an <img>, and
  // `default-src 'none'` already covers it. Pinned so nobody "completes" the policy by adding it.
  assert.ok(!/object-src/.test(headerCsp), "object-src must stay absent: default-src 'none' covers it");
});
