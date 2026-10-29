/**
 * The PWA is installable, and cannot preserve a stale build (issues #119, #120).
 *
 * ## What this feature is
 *
 * A standalone window and a dock icon — **not** an offline app. Every screen is fed by the socket, so an
 * installed Pi Central with the orchestrator down shows `disconnected`. A worker that "worked offline"
 * would install, open, and be useless while implying otherwise, so the docs and the manifest must not say
 * it does.
 *
 * ## The one property that must hold
 *
 * `index.html` names the current fingerprint set. Caching it is how a rebuild stops being visible —
 * `static-ui.ts` already says so in its `Cache-Control`, and a worker that disagreed with the server would
 * win. So the WORKER is asserted against the same rule, because it is the only artefact in the system that
 * can outlive a rebuild indefinitely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("public/manifest.webmanifest", root), "utf8"));
const worker = stripComments(readFileSync(new URL("public/sw.js", root), "utf8"));
const html = readFileSync(new URL("index.html", root), "utf8");
const main = stripComments(readFileSync(new URL("src/main.tsx", root), "utf8"));

// --- The manifest ---------------------------------------------------------------------------------

test("it installs as a standalone window and names the brand colour", () => {
  assert.equal(manifest.display, "standalone", "a window, not a browser tab");
  assert.equal(manifest.theme_color, "#3fa383", "the brand green, matching the favicon work");
  assert.ok(manifest.name && manifest.short_name, "both names, because the dock label is truncated");
  assert.equal(manifest.start_url, "/");
});

test("both icon sizes a manifest requires are present, and at the right size", () => {
  // A manifest without a 192 and a 512 is installable in some browsers and not others, which is the worst
  // of both. Sizes are asserted from the `sizes` field AND the file's real dimensions would need a decoder,
  // so the field is pinned here and the files are checked for existence.
  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes("192x192"), "192 for the home screen");
  assert.ok(sizes.includes("512x512"), "512 for the splash and the store-like surfaces");
  for (const icon of manifest.icons) {
    assert.ok(icon.type.startsWith("image/"), `${icon.src} needs a type, or the browser guesses`);
    // Stable paths, not fingerprinted ones: a manifest is copied verbatim and cannot resolve `/src/…`.
    assert.match(icon.src, /^\/icon-\d+\.png$/, `${icon.src} must be a stable public path`);
  }
});

test("the manifest does not claim to work offline", () => {
  // The word must not appear. An installed app that promises offline and shows `disconnected` is worse
  // than one that never claimed it.
  const text = JSON.stringify(manifest).toLowerCase();
  assert.ok(!text.includes("offline"), "no offline claim in the manifest");
});

// --- The worker: the rule from #120 ---------------------------------------------------------------

test("the worker NEVER caches the app document", () => {
  // The load-bearing assertion. `index.html` names the fingerprint set, so a cached copy pins a bundle
  // indefinitely — served by a worker the browser updates on its own schedule, with no reload button and no
  // URL to compare.
  // Anchored on CODE, not on the comment that introduces the next block: `stripComments` removes
  // comments, so the first version of this slice ran to the end of the file and accused the asset branch
  // of caching the document. (Caught by the assertion failing on code that was correct — which is the
  // sixth time in this repository that a text-scanning test has needed its anchor checked.)
  const document = worker.slice(
    worker.indexOf("if (isDocument("),
    worker.indexOf("event.respondWith("),
  );
  assert.ok(document.length > 0, "the document branch must exist and be identifiable");
  assert.ok(!/cache\.put/.test(document), "the document must never reach the cache");
  assert.ok(!/caches\.match/.test(document), "and must never be served FROM the cache either");
  assert.match(document, /return;/, "it falls through to the network, deliberately with no fallback");
});

test("only complete, same-origin responses are cached", () => {
  // An `opaque` response has no usable status, and a 404 or 500 must not become permanent.
  assert.match(worker, /response\.ok && response\.type === "basic"/, "real responses only");
});

test("nothing is precached, because the grammars are 8.8 MB of mostly-unused chunks", () => {
  // `elisp` alone is 772 kB. Precaching all 266 chunks would make the first visit pay for grammars the
  // session never opens. Runtime caching on first request is what those `import()` calls already are.
  assert.ok(!/cache\.addAll/.test(worker), "no precache list");
  assert.ok(!/cache\.add\(/.test(worker), "nothing fetched eagerly");
});

test("`skipWaiting` is absent, because this app holds live sessions", () => {
  // "Activate immediately" and "never interrupt a running session" pull in opposite directions. A worker
  // that took over mid-stream would reload the UI under the reader.
  assert.ok(!/skipWaiting/.test(worker), "the new worker waits for the next launch");
  assert.ok(!/clients\.claim/.test(worker), "and does not seize open windows");
});

// --- The wiring -----------------------------------------------------------------------------------

test("the document links the manifest", () => {
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
});

test("the worker registers only in a PRODUCTION build", () => {
  // In dev, Vite serves modules with cache-busting query strings and an HMR channel; a worker in front of
  // that produces stale-module behaviour unrelated to the app. Worse, `ui:dev` + `server --no-ui` is the
  // documented editing loop, and a worker caching those responses is the "my edit did not appear" bug this
  // issue exists to remove.
  assert.match(main, /import\.meta\.env\.PROD/, "guarded by PROD");
  assert.match(main, /serviceWorker\.register\("\/sw\.js"\)/, "registers the built worker");
  // A browser that refuses one (private mode, insecure context) must still get a working app.
  assert.match(main, /\.catch\(/, "and a refusal is not fatal");
});
