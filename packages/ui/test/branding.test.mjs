/**
 * The brand assets are safe to ship, and there is only one of each (issue #115).
 *
 * ## Why an SVG needs an assertion at all
 *
 * An SVG served from this app's own origin is a document the browser will happily parse. The files in
 * `assets/` are Inkscape output, so they arrive with editor metadata and can in principle carry a
 * `<script>`, an `on*` handler, or an external reference — and a `href` to another origin from an SVG
 * loaded as an `<img>` is a request this app's CSP never intended to make.
 *
 * These are clean today. The point of the test is that they stay clean when the artwork is next updated
 * by whoever drew it, in whatever tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const assetsDir = new URL("../src/assets/", import.meta.url);
const assets = readdirSync(assetsDir);
const svgs = assets.filter((name) => name.endsWith(".svg"));

test("both marks are present: a favicon and the README lockup", () => {
  // Named, because a rename would otherwise leave the favicon silently 404ing — the browser shows a
  // blank tab icon and says nothing.
  assert.ok(assets.includes("logo-icon.svg"), "the mark used by the favicon and the topbar");
  assert.ok(assets.includes("logo-icon.png"), "the raster fallback");
  assert.ok(assets.includes("logo-dark-mode.svg"), "the README lockup, white text for a dark page");
});

for (const name of svgs) {
  test(`${name} carries nothing executable`, () => {
    const svg = readFileSync(new URL(name, assetsDir), "utf8");
    for (const [pattern, what] of [
      [/<script[\s>]/i, "a <script> element"],
      [/\son[a-z]+\s*=/i, "an inline event handler"],
      [/<foreignObject/i, "a foreignObject, which can carry HTML"],
      [/<iframe|<embed|<object/i, "an embedded document"],
    ]) {
      assert.ok(!pattern.test(svg), `${name} must not carry ${what}`);
    }
  });

  test(`${name} references nothing outside itself`, () => {
    const svg = readFileSync(new URL(name, assetsDir), "utf8");
    // A `href` to anywhere is a subresource request from an image. `data:` would be inert but is still
    // a second payload hiding in the drawing, so it is refused too — these marks are self-contained.
    const external = [...svg.matchAll(/(?:xlink:)?href\s*=\s*"([^"]*)"/g)]
      .map((m) => m[1])
      .filter((ref) => !ref.startsWith("#"));
    assert.deepEqual(external, [], `${name} must not reference anything: found ${external.join(", ")}`);
  });

  test(`${name} is stripped of editor metadata`, () => {
    // Inkscape and Sodipodi leave their own namespaced attributes in the file. Dead weight in a shipped
    // asset, and it is the part that is not the drawing.
    const svg = readFileSync(new URL(name, assetsDir), "utf8");
    assert.ok(!/sodipodi:|inkscape:|<metadata/.test(svg), `${name} still carries editor metadata`);
  });
}

test("the favicon is declared as a link, not left to the browser's default", () => {
  // Without this the tab shows a blank document icon and nothing anywhere reports a problem.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="icon" type="image\/svg\+xml"/, "an SVG icon for browsers that take one");
  assert.match(html, /<link rel="icon" type="image\/png"/, "a raster fallback");
  assert.match(html, /rel="apple-touch-icon"/, "…and the form a home-screen shortcut uses");
  assert.match(html, /name="theme-color" content="#3fa383"/, "the brand colour, so mobile chrome matches");
});

test("the topbar shows the same file the favicon does", () => {
  // One artefact, two places. If the topbar imported its own copy, the tab and the header could show
  // different marks after a redesign.
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /import logoIcon from "\.\/assets\/logo-icon\.svg"/, "the topbar imports the mark");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /logo-icon\.svg/, "…which is the file the favicon links to");
});

test("the brand green is its own token, not --ok", () => {
  // `--ok` means SUCCESS. Reusing it would make the logo read as a status, and every future green in the
  // UI ambiguous between "this is Pi Central" and "this went well".
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /--brand:\s*#3fa383/, "the brand colour is a token, and it is the artwork's own value");
  const ok = /--ok:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1];
  assert.notEqual(ok, "#3fa383", "--ok must not be the brand colour: the two mean different things");
});
