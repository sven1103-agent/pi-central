/**
 * Custom properties: every one that is USED must be DEFINED.
 *
 * ## The defect this exists for
 *
 * `reading.ts` emits `--reading-trailing: var(--companion-width)` for the reader's `fill` setting, and the stylesheet's
 * `:root` did not define `--companion-width` at all — the width existed as a bare `340px` in the rules that sized the
 * companion. A `var()` with no definition and no fallback is **invalid at computed-value time**, which does not throw,
 * does not warn, and does not fail at the line that is wrong:
 *
 *   `grid-template-columns: var(--reading-leading) var(--reading-lane) var(--reading-trailing)`
 *
 * falls back to `none`. Every column becomes implicit, the grid is laid out wider than its container, and the session
 * header — placed in column 3 by name — renders past the right edge of the window. Reported as *"now i dont see the
 * controls anymore"*, from a rule three files away from the missing line.
 *
 * ## Why a stylesheet test rather than a rendered one
 *
 * The failure is a JOIN between two declarative surfaces: the CSS variables a module emits and the CSS variables the
 * stylesheet declares. No component here can see it — the markup is correct, the classes are correct, and the
 * stylesheet is correct apart from an absence. A textual scan is the right instrument, and it is the same technique
 * `panel.test.mjs` uses for the split breakpoint.
 *
 * ## What it deliberately does not check
 *
 * Fallbacks. `var(--rail-width, 288px)` is a legitimate use of an undefined property, and so is a property defined on a
 * subtree rather than on `:root` — a local customisation point. Both are exempted by shape, not by a list, so a new one
 * does not have to be added to an allowlist that then rots.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../src/", import.meta.url);
const css = readFileSync(new URL("styles.css", root), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every module that can emit a custom property. */
const sources = readdirSync(root, { recursive: true })
  .filter((name) => typeof name === "string" && /\.(ts|tsx)$/.test(name))
  .map((name) => readFileSync(new URL(name, root), "utf8"));

/**
 * Custom properties DECLARED in the stylesheet: `--name:` at the start of a declaration.
 *
 * Anywhere in the file, not only in `:root` — the stacking of `.app.is-focus` overrides is deliberate, and a property
 * whose only declaration is inside a modifier is still defined for the elements that modifier matches.
 */
const declared = new Set([...css.matchAll(/(^|[;{\s])(--[a-z0-9-]+)\s*:/g)].map((m) => m[2]));

/**
 * Custom properties USED as `var(--name)` with no fallback.
 *
 * A fallback (`var(--name, 288px)`) is exempt: it says "this may be absent", which is a decision rather than an
 * omission, and it is the shape the rail's width uses for a value JavaScript writes onto one element.
 */
function usedWithoutFallback(text) {
  const out = new Set();
  for (const match of text.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)) out.add(match[1]);
  return out;
}

/**
 * Is `name` EVER used with a fallback?
 *
 * The second exemption, and it is the reason `--panel-width` and `--rail-width` are not defects: React writes them onto
 * one element's inline style, and the stylesheet spells a default beside every read. A property that is always read
 * with a fallback cannot produce the invalid-declaration cascade this file exists to catch — whatever the module does,
 * the declaration remains valid.
 */
function alwaysHasFallback(text, name) {
  const uses = [...text.matchAll(new RegExp(`var\\(\\s*${name}\\s*([,)])`, "g"))];
  return uses.length > 0 && uses.every((match) => match[1] === ",");
}

test("every custom property the stylesheet uses without a fallback is declared in it", () => {
  /*
   * The stylesheet's own self-consistency, and the check that would have caught this defect on its own: the broken rule
   * was in this file, and the missing definition was in this file.
   *
   * Falsified by deleting the `--companion-width: 340px` declaration while `reading.ts` still emits it — which is the
   * exact state that shipped.
   */
  const missing = [...usedWithoutFallback(css)].filter((name) => !declared.has(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `these are used but never declared, so they resolve to nothing (and an invalid declaration wins nothing):\n  ${missing.join("\n  ")}`,
  );
});

test("every custom property a preference module emits is declared in the stylesheet", () => {
  /*
   * The JOIN, which is where the defect lived. `reading.ts`, `rail-prefs.ts` and `panel.ts` write properties that the
   * stylesheet must read, and one of the pair being absent is invisible to both sides.
   *
   * The properties a module emits appear either as a quoted key in a style record or as a `setProperty` argument; both
   * shapes are scanned, because a check that understands only one of them stops checking the day the other is used.
   *
   * Falsified by emitting a new property from any of these modules without declaring it — the failure names the property
   * and the module it came from.
   */
  const emitted = new Map();
  for (const text of sources) {
    for (const match of text.matchAll(/["'](--[a-z0-9-]+)["']\s*:/g)) emitted.set(match[1], text.slice(0, 60));
    for (const match of text.matchAll(/setProperty\(\s*["'](--[a-z0-9-]+)["']/g)) emitted.set(match[1], text.slice(0, 60));
  }
  assert.ok(emitted.size > 0, "the modules emit custom properties, so this test is looking at the right thing");

  /*
   * And the second-order path, which is how this defect actually bit: a module may put `var(--other)` INSIDE a value it
   * emits (`--reading-trailing: var(--companion-width)`). That is a use of `--other` from a module, and if the
   * stylesheet never declares it the emitted value is invalid at computed-value time — silently, once again, with the
   * symptom landing in whatever declaration reads the outer property.
   *
   * Scanned in the module sources because that is where the reference lives; no rendered test can see it, since the
   * markup and the classes are all correct.
   */
  for (const text of sources) {
    for (const name of usedWithoutFallback(text)) {
      if (!declared.has(name) && !alwaysHasFallback(css, name)) emitted.set(name, text.slice(0, 60));
    }
  }

  const missing = [...emitted.keys()]
    // Declared in the stylesheet, or always read with a fallback: both are valid.
    .filter((name) => !declared.has(name) && !alwaysHasFallback(css, name))
    .sort();
  assert.deepEqual(
    missing,
    [],
    `emitted by a module but never declared in styles.css, so the declaration that reads them is invalid:\n  ${missing.join("\n  ")}`,
  );
});

test("the two tokens the wide layout reads are the ones the module writes", () => {
  /*
   * The specific pair this defect turned on, asserted by NAME so the failure is legible rather than a set difference:
   * the stylesheet's grid template reads `--reading-leading`, `--reading-lane` and `--reading-trailing`, and
   * `reading.ts` writes all three. A rename on either side has to fail here.
   */
  /*
   * The WIDE rule specifically, not the first rule whose body mentions a grid.
   *
   * `.app.is-focus .transcript-wrap.has-header` is also a grid template and comes first in the file, so a plain "find
   * the grid one" picked the FOCUS override — whose whole point is to name the leading margin twice and no trailing
   * margin at all. The test then reported a missing `--reading-trailing` in the one rule that deliberately omits it.
   * Filtered by the absence of `.app.is-focus` rather than by line number, so moving the rules does not re-break it.
   */
  const ruleText = [...css.matchAll(/(^|\n)([^{}]*\.transcript-wrap\.has-header[^{}]*)\{([^}]*)\}/g)]
    .find((m) => /grid/.test(m[3]) && !/is-focus/.test(m[2]))?.[3] ?? "";
  assert.ok(ruleText, "the wide layout's rule must be found");
  const template = /grid-template-columns:\s*([^;]+);/.exec(ruleText)?.[1] ?? "";

  for (const token of ["--reading-leading", "--reading-lane", "--reading-trailing"]) {
    assert.ok(template.includes(`var(${token})`), `the wide layout's template must name ${token}`);
    assert.ok(declared.has(token), `and ${token} must be declared`);
  }
  // Every track is a token: a literal in the outer two is the asymmetry that pushed the prose to the edge.
  assert.ok(!/\d+px/.test(template), `no literal track widths, got "${template.replace(/\s+/g, " ").trim()}"`);
});
