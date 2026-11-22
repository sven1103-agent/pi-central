/**
 * The workspace grid, with the rail as a reader preference (issue #275).
 *
 * `layout.test.mjs` protects the reading lane; this file protects the TRACKS. The two are adjacent and different: the
 * lane lives inside the transcript column, the tracks decide how much column there is.
 *
 * Every assertion here is about a class the shell sets, so one test checks that the shell and the stylesheet agree about
 * the names at all — a modifier that is written and never styled is a layout bug that looks like a rendering bug, and
 * one that is styled and never written is dead CSS that reads as a supported state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const app = read("App.tsx");

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector) {
  const wanted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`^${wanted}\\s*\\{([^}]*)\\}`, "gm"))];
  return all.length > 0 ? all.at(-1)[1] : undefined;
}

test("the rail's track reads the reader's width, with the shipped value as the fallback", () => {
  /*
   * `var(--rail-width, 288px)` and not `var(--rail-width)`: the custom property is written by JavaScript, and a reader
   * whose first paint happens before that — or whose `localStorage` is disabled, so `railStyle` is never applied — must
   * still get the width the app has always had rather than a track that collapses.
   *
   * Falsified by removing the fallback: the assertion then reports a bare `var()`, and a real window renders the rail
   * as a sliver on first paint.
   */
  const panes = rule(".panes") ?? "";
  assert.match(panes, /grid-template-columns:\s*var\(--rail-width,\s*288px\)/, "the first track is the reader's width");
  assert.match(panes, /minmax\(0,\s*1fr\)/, "and the middle track can still shrink below its content");
  // The collapsed-panel variant too: it declares its own two tracks and would otherwise keep the literal.
  assert.match(rule(".panes.is-collapsed") ?? "", /grid-template-columns:\s*var\(--rail-width,\s*288px\)\s+1fr/);
});

test("a rail that is not docked leaves no track, in either panel state", () => {
  /*
   * The hole hazard `is-pageless` records, in its new form: an absent rail takes its track with it, and the
   * collapsed-panel case needs its own selector because it out-specifies a bare `.panes`.
   *
   * Falsified by deleting either rule — the modifier is applied by the shell, so the failure mode is an empty column
   * beside a full-width transcript, which reads as a layout that failed to finish.
   */
  assert.match(rule(".panes.is-rail-less") ?? "", /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--panel-width/);
  assert.match(rule(".panes.is-rail-less.is-collapsed") ?? "", /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
});

test("the summoned rail is an overlay at EVERY width, not only below the breakpoint", () => {
  /*
   * The defect this replaces: `display: none` plus `.rail.open` lived inside `@media (max-width: 1023px)`, so a reader
   * who hid the rail on a 2000px window got no drawer at all, and the control that was supposed to summon it appeared
   * to do nothing. The overlay rule is therefore OUTSIDE any media query; the query only supplies the no-track grid.
   *
   * Asserted with a brace count rather than by eye: the region between the query's opening brace and the overlay rule
   * must be balanced, which is what "outside the query" means in a flattened stylesheet.
   */
  const queryStart = css.indexOf("@media (max-width: 1023px)");
  assert.notEqual(queryStart, -1, "the breakpoint query exists");
  const overlayAt = css.indexOf(".panes.is-rail-overlay .rail");
  assert.ok(overlayAt > queryStart, "the overlay rule is declared after the query opens");
  const between = css.slice(queryStart, overlayAt);
  const opens = (between.match(/\{/g) ?? []).length;
  const closes = (between.match(/\}/g) ?? []).length;
  assert.equal(opens, closes, "the overlay rule is outside the media query, so it applies at every width");
  // And it takes the reader's width, capped so a wide rail still fits a narrow window.
  assert.match(css.slice(overlayAt, overlayAt + 400), /width:\s*min\(var\(--rail-width,\s*288px\),\s*86vw\)/);
});

test("the resize handle sits on the rail's trailing edge, over the gutter", () => {
  /*
   * The same shape as `.panel-resizer`, mirrored: 7px wide and offset by `-3px`, so it straddles the 1px gutter rather
   * than replacing it, and positioned from `--rail-width` so it follows the drag.
   *
   * Falsified by dropping the `- 3px`: the handle then starts at the gutter and its hit area reaches 6px into the
   * transcript, where a click aimed at the text would resize the column instead.
   */
  const resizer = rule(".rail-resizer") ?? "";
  assert.match(resizer, /position:\s*absolute/);
  assert.match(resizer, /left:\s*calc\(var\(--rail-width,\s*288px\)\s*-\s*3px\)/);
  assert.match(resizer, /width:\s*7px/);
  assert.match(resizer, /cursor:\s*col-resize/);
  // Invisible at rest: only the cursor and the hit area change, so the layout's visual weight is untouched.
  assert.match(resizer, /background:\s*transparent/);
});

test("every grid modifier the shell writes has a rule, and every rule has a writer", () => {
  /*
   * The two-way check. A modifier composed but never styled is a layout that silently does not happen; a rule with no
   * writer is dead CSS that reads as a supported state. Both directions, because either alone would pass on a rename.
   */
  const styled = new Set([...css.matchAll(/\.panes\.(is-[a-z-]+)/g)].map((m) => m[1]));
  assert.ok(styled.size >= 4, "the stylesheet declares the panes modifiers");
  for (const name of styled) {
    assert.ok(app.includes(`" ${name}"`), `${name} is styled, so the shell must set it`);
  }
  for (const name of ["is-collapsed", "is-pageless", "is-rail-less", "is-rail-overlay"]) {
    assert.ok(styled.has(name), `the shell writes ${name}, so the stylesheet must style it`);
  }
});

test("a hidden rail is display:none, and a summoned one still wins the cascade", () => {
  /*
   * The rail is MOUNTED while hidden (it owns `⌥↑`/`⌥↓`), so "off screen" has to be CSS. Both halves are asserted,
   * because either alone is a defect:
   *
   *   - no `display: none` rule → the "hidden" preference does nothing visible;
   *   - the summoned override missing or not more specific → the overlay never appears, and the control that hides the
   *     column cannot bring it back.
   *
   * Falsified by deleting the hide rule (the list stays on screen at every setting) or by lowering the overlay rule's
   * selector to `.rail` — the `:not()` clause would then beat it and the drawer would be permanently invisible.
   */
  assert.match(css, /\.panes\.is-rail-less:not\(\.is-rail-overlay\) \.rail \{\s*display:\s*none;/, "hidden means hidden");
  const overlay = rule(".panes.is-rail-overlay .rail") ?? "";
  assert.match(overlay, /display:\s*flex/, "and the summoned form is displayed regardless of the hide rule");
  // No `!important` anywhere: specificity is the mechanism, and `!important` here would make the next override a fight.
  assert.ok(!/display:\s*none\s*!important/.test(css), "the cascade is not forced");
});

test("the rail's keys keep working while it is hidden", () => {
  /*
   * `⌥↑`/`⌥↓` are registered by the RAIL, not the shell, because only the rail knows the order the rows are shown in.
   * That makes "is the component mounted" a behaviour question, not a rendering one: unmounting a hidden rail would
   * silently take the only keyboard way to walk sessions with it.
   *
   * Falsified by mounting the rail behind `railShown` in `App.tsx` — the assertion below reports that the guard is back.
   */
  assert.match(app, /\{tab === "sessions" && \(\s*\{?\/?\*?/, "the rail is mounted on the Sessions page, always");
  assert.ok(!/\{railShown && \(\s*<SessionRail/.test(app), "not gated on its own visibility");
});

test("no literal rail width survives outside the custom property's fallback", () => {
  /*
   * A single source of truth for one number. The 288px literal is allowed exactly where it is a FALLBACK
   * (`var(--rail-width, 288px)`) and nowhere else — a second bare `288px` track would not follow the drag, and that is
   * the class of drift this repository keeps writing tests for.
   *
   * Falsified by restoring the literal in `.panes.is-collapsed`: the count below becomes two.
   */
  const bares = [...css.matchAll(/(^|[^-\w])288px/g)].filter((m) => {
    // A FALLBACK is the second argument of a `var()`: everything before it opens with `var(--rail-width,` and ends in
    // the comma. Anything else is a pinned number.
    const before = css.slice(0, m.index + m[1].length);
    return !/var\(--rail-width,\s*$/.test(before);
  });
  assert.deepEqual(
    bares.map((m) => css.slice(Math.max(0, m.index - 40), m.index + 10).replace(/\s+/g, " ")),
    [],
    "no track, width or offset may pin the rail to a literal",
  );
});
