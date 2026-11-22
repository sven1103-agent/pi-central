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

test("hovering the list control previews the roster, and the preview can be USED", () => {
  /*
   * The request: *"when i hover the \"Show list\" icon, i want to quickly see the roster"*. A press is a decision and a
   * glance at which sessions are running is not, so the control previews on hover.
   *
   * ## The first version was see-only, reported from use
   *
   * *"when i hover and i see a session where i want to take action, i cant because leaving the icon closes the roster
   * again, and clicking it closes it as well"* — two independent defects, both from treating "preview" as a boolean:
   *
   *   1. **Unreachable.** The pointer must travel from the bar to the list across a gutter. The preview closed on the
   *      first stray pixel, so it could be looked at and not touched. It was also `pointer-events: none`, which made the
   *      unreachability a rule rather than an accident.
   *   2. **A press dismissed it.** The control toggles on `railShown`, and a preview counted as shown — so clicking the
   *      preview took the HIDE branch and the list vanished under the click.
   *
   * So the preview is a THREE-state thing: hover follows the pointer across two zones, a press promotes it to pinned, and
   * only a pinned preview can be pressed away. These assertions state that, plus the one thing a preview must still never
   * do: dim the window, or persist.
   *
   * Falsified by any of: closing on the control's own leave (unreachable); a press that falls through to the hide branch;
   * `pointer-events: none` on the preview.
   */
  assert.match(
    app,
    /const \[railPeekMode, setRailPeekMode\] = useState<"none" \| "hover" \| "pinned">\("none"\)/,
    "three states: hover, pinned, none — a boolean cannot express 'shown but not committed'",
  );
  assert.match(app, /const railHovering = railPreviewable && railPeekMode === "hover"/);
  assert.match(app, /const railPinnedOpen = railPreviewable && railPeekMode === "pinned"/);

  /*
   * (1) REACHABILITY. One pair of handlers, attached to BOTH the control and the list, and the delay is on leave only so
   * crossing the gutter is one continuous hover.
   */
  assert.match(app, /const previewEnter = useCallback/, "one enter handler for both zones");
  assert.match(app, /const previewLeave = useCallback/, "and one leave handler");
  const leave = /const previewLeave = useCallback\(\(\) => \{([\s\S]*?)\}\);\n/.exec(app)?.[1] ?? "";
  assert.ok(leave.length > 0, "the leave handler must exist");
  assert.match(leave, /setTimeout\(/, "a delay rather than an immediate close");
  assert.match(leave, /\b220\b/, "long enough to cross the gutter to the list");
  assert.match(
    leave,
    /current === "hover" \? "none" : current/,
    "and it closes ONLY a hover: a pinned preview outlives the pointer",
  );
  assert.match(app, /onPointerEnter=\{previewEnter\}/, "the control enters the preview");
  assert.match(
    app,
    /onPeekPointerEnter=\{railHovering \? previewEnter : undefined\}/,
    "and so does the LIST, or moving toward a row ends the preview",
  );
  assert.match(app, /onPeekPointerLeave=\{railHovering \? previewLeave : undefined\}/);

  const rail = read("components/SessionRail.tsx");
  assert.match(rail, /onPointerEnter=\{onPeekPointerEnter\}/, "the rail really applies them, not just declares them");
  assert.match(rail, /onPointerLeave=\{onPeekPointerLeave\}/);

  const peek = rule(".panes.is-rail-peek .rail") ?? "";
  assert.ok(peek.length > 0, "the preview needs a rule of its own");
  assert.ok(
    !/pointer-events:\s*none/.test(peek),
    "the preview is interactive: a surface you cannot reach cannot be acted on, which is the reported defect",
  );
  assert.match(peek, /box-shadow:\s*none/, "and it is the list itself, not a floating panel to deal with");

  /*
   * (2) A PRESS PROMOTES. It returns before the ordinary toggle, so the hide branch cannot also run.
   */
  assert.match(app, /const togglePeekPinned = useCallback/, "a press has its own handler");
  assert.match(
    app,
    /if \(railPeeking\) \{\s*togglePeekPinned\(\);\s*return;/,
    "a press on the preview promotes it and RETURNS — the hide branch must not also run",
  );
  assert.match(
    app,
    /setRailPeekMode\(\(current\) => \(current === "pinned" \? "none" : "pinned"\)\)/,
    "hover becomes pinned, pinned becomes nothing",
  );

  /*
   * (3) AND THE TWO THINGS A PREVIEW STILL MUST NOT DO: dim the window, or remember itself.
   */
  const backdropAt = app.indexOf('className="rail-backdrop"');
  const gates = [...app.slice(0, backdropAt).matchAll(/\{([^{}]+?)\s*&&\s*\(/g)]
    .map((match) => match[1].trim())
    .filter((gate) => !/^\/\*/.test(gate));
  assert.equal(
    gates.at(-1),
    "railOverlay",
    `only a SUMMONED drawer may dim the window; a preview that dimmed it would make a glance cost a commitment`,
  );

  const hoverHandlers = /onPointerEnter=\{previewEnter\}[\s\S]*?onClick=\{/.exec(app)?.[0] ?? "";
  assert.ok(hoverHandlers.length > 0, "the handlers must be on the control");
  assert.ok(
    !/setRailPrefsAndPersist|setRailPrefs\b/.test(hoverHandlers),
    "hovering must never write the reader's persisted preference",
  );

  /*
   * Bounded to where it means something: the page with a list, the window that can afford one, and the list being away.
   */
  assert.match(
    app,
    /const railPreviewable = tab === "sessions" && !railIsDrawer && !railDocked/,
    "no preview on a page without a list, in the drawer's width, or beside a list already showing",
  );
});
